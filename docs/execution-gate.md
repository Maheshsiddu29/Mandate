# The onchain execution gate

> **Status: Phase 6, implemented and tested locally. Not deployed.** The contract
> is `contracts/src/MandateExecutionGate.sol`; the offchain half is
> `packages/execution-gate`; the decision is
> [ADR 0019](adr/0019-onchain-execution-gate.md). The only supported execution
> path runs against a **labelled settlement fixture**, not a venue (§5). Nothing
> has been deployed to any network and no transaction has been sent.

**Mandate does not choose investments for users. It enforces the authority users
grant to agents.**

The property this phase delivers:

> A transaction that materially differs from what Mandate authorized and verified
> offchain cannot settle through the Mandate execution path.

## Contents

1. [Scope](#1-scope)
2. [Architecture](#2-architecture)
3. [Commitment hierarchy](#3-commitment-hierarchy)
4. [Authorization binding](#4-authorization-binding)
5. [The supported execution path](#5-the-supported-execution-path)
6. [Economic enforcement](#6-economic-enforcement)
7. [Settlement-delta verification](#7-settlement-delta-verification)
8. [Approvals](#8-approvals)
9. [Replay, events and reconciliation](#9-replay-events-and-reconciliation)
10. [Tests and invariants](#10-tests-and-invariants)
11. [Differential testing and the onchain/offchain split](#11-differential-testing-and-the-onchainoffchain-split)
12. [Chain time, reorgs and confirmation](#12-chain-time-reorgs-and-confirmation)
13. [Deployment policy](#13-deployment-policy)
14. [Slither findings](#14-slither-findings)
15. [Threat model](#15-threat-model)
16. [Residual risks](#16-residual-risks)
17. [One gate for every kind of trader](#17-one-gate-for-every-kind-of-trader)
18. [Deferred](#18-deferred)

## 1. Scope

The gate enforces the smallest safety-critical subset of a Mandate authorization
the chain can observe, atomically with the action:

- the principal signed this exact mandate, for this chain and this gate;
- the agent the mandate names signed this exact execution;
- chain time is inside the mandate's validity window and the agent's deadline;
- this authorization has not settled before;
- the candidate, the mandate and the gate's pinned market facts agree on who,
  what, where, which side and which units;
- the principal's measured cash flow is inside the signed economic bound.

It does **not** resolve assets, interpret Robinhood metadata, discover routes,
consult a model or re-run the kernel verifier. Those stay offchain (§11).

There is one entry point, no owner, no admin, no setter, no upgrade path, no
`delegatecall`, no `tx.origin`, no native-token path, and no arbitrary call: the
gate calls exactly one adapter per market with exactly one call shape.

## 2. Architecture

```text
OFFCHAIN (Phases 1–5R.3, unchanged)
  principal signs MandateAuthorization(mandateDigest)      ← same signature the kernel verifies
  registry resolution → kernel verification → routing → fresh handoff verification
  RESERVE (replay state machine)
  agent signs ExecutionAuthorization(mandateDigest, candidateDigest, recipient,
                                     fundingLimit, deadline, executionData)
════════════════════════════════════════ ONCHAIN BOUNDARY ════════════════════════
MandateExecutionGate.execute(mandate, principalSig, candidate, terms, agentSig)
  1  block.chainid == deployment chain                               WrongChain
  2  re-encode mandate (MCE v2), validate as the kernel decoder       UnsupportedMandateVersion / MalformedMandate
  3  principal signature over mandateDigest under {Mandate,1,chain,gate}   PrincipalSignatureInvalid
  4  re-encode candidate (Candidate V3), validate                     MalformedCandidate
  5  market ← keccak(candidate.representationId)                      UnsupportedRepresentation
  6  agent signature over the execution commitment                    AgentSignatureInvalid
  7  notBefore ≤ block.timestamp < expiresAt, block.timestamp ≤ deadline
  8  executionCommitmentOf[mandateDigest] == 0                        MandateAlreadyConsumed
  9  candidate/mandate/market binding (agent, side, asset, chain, venue, issuer,
     synthetic, units, quantity), recipient == principal, signed bound
 10  executionCommitmentOf[mandateDigest] := commitment               ← effects
 11  transferFrom(principal → adapter, input); adapter.execute(order) ← interactions
 12  measured debit ≤ limit, measured credit ≥ minimum                DebitExceedsLimit / CreditBelowMinimum
 13  emit MandateExecuted(...)
════════════════════════════════════════════════════════════════════════════════
OFFCHAIN
  read executionCommitmentOf + MandateExecuted at the required confirmation level
  observationFromGateEvidence → RECONCILE(SETTLED | FAILED)           (packages/execution-gate)
```

The check order is part of the interface: the reference model reproduces it and
the differential corpus compares revert data byte for byte. The gate reverts on
the first failure; unlike the kernel verifier it does not collect every
violation — a revert carries one reason.

The gate *performs* the action rather than asserting beside it. Design §14.3's
DRAFT described a read-only assertion; the EVM cannot introspect the other calls
in a transaction, so an assertion beside the action would bind nothing
([ADR 0019](adr/0019-onchain-execution-gate.md) §1). Because the gate is the
action, "the gate's position relative to the action" is structural.

### Components

| Component | Where | Role |
| --- | --- | --- |
| `MandateExecutionGate` | `contracts/src/MandateExecutionGate.sol` | The gate. Immutable. |
| `MandateCodec` | `contracts/src/libraries/MandateCodec.sol` | MCE v2 / Candidate V3 re-encoding and kernel-decoder validation |
| `MandateTypes` | `contracts/src/MandateTypes.sol` | Wire structs and frozen enum codes |
| `IMandateExecutionAdapter` | `contracts/src/interfaces/` | The one call shape the gate makes |
| `FixtureVenue`, `FixtureVenueAdapter` | `contracts/src/fixture/` | **Labelled settlement fixture** and its adapter (§5) |
| `DeployMandateGate` | `contracts/script/` | Deterministic deployment, manual only (§13) |
| `@mandate/execution-gate` | `packages/execution-gate` | Wire form, commitment, reference model, reconciliation rule |

## 3. Commitment hierarchy

```text
EIP-712 domain {name: "Mandate", version: "1", chainId, verifyingContract: gate}   ← chain, contract
│
├─ MandateAuthorization(mandateDigest)                          signed by the PRINCIPAL
│    mandateDigest = keccak256(MCE v2 mandate)
│      principal, agent, canonical asset, side, maxNotional, economicLimit (unit,
│      decimals, atoms), maxDeviationBps, synthetic policy, issuer/chain/venue
│      allowlists, epoch requirement, freshness bounds, halt policy, validity
│      window, nonce, mandateId, schema version 2
│
└─ ExecutionAuthorization(...) = executionCommitment            signed by the AGENT
     mandateDigest            (above)
     candidateDigest = keccak256(Candidate V3)
       representationId ──► gate market table (immutable) ──► token, adapter,
       │                                                        funding token, asset,
       │                                                        issuer, venue, units
       canonical asset, issuer, chain, venue, side, agent, quantity, execution
       price, notional, fee total, evaluation state id+digest, registry snapshot
       digest, corporate-action epoch, schema version 3
     recipient                 must equal the principal
     fundingLimit              BUY max debit / SELL min credit, funding-token atoms
     deadline                  chain-time deadline, inclusive
     executionData             venue route data, by keccak256
```

Nothing committed transitively is restated. Token, adapter and funding asset are
functions of `candidateDigest` and the gate address; side and quantity are in
`candidateDigest`; principal, agent and bounds are in `mandateDigest`. Restating
them would make a second encoding of one fact that could disagree with the first
— the failure ADR 0001 rejected mirroring mandate fields into typed data for.

**Any material mutation changes a checked commitment.** A mandate field changes
the mandate digest (principal signature fails); a candidate field or any
execution term changes the execution commitment (agent signature fails); a
different gate or chain changes the domain (both fail). Fields the agent chose
and signed but that are inconsistent with the mandate are then refused by the
binding checks. This is tested field by field in `bind-*` vectors, in
`testFuzz_binding_anyPostSignatureMutationRefuses`, and in the `executeTampered`
invariant action.

## 4. Authorization binding

| Required binding | How the gate establishes it |
| --- | --- |
| owner / signer | ECDSA recovery of the principal signature equals `mandate.principal` |
| agent / session | ECDSA recovery of the agent signature equals `mandate.agent`; `candidate.agent` must equal it too |
| mandate digest | recomputed from the struct, never supplied |
| policy / schema version | mandate v2 (else `UnsupportedMandateVersion`), candidate v3 |
| chain ID | `block.chainid == CHAIN_ID` (immutable), domain `chainId`, and the CAIP-2 chain in `allowedChains` and `candidate.chain` |
| verifying contract | domain `verifyingContract` is the gate's own address |
| nonce / replay key | the mandate digest (covers the nonce) keys `executionCommitmentOf` |
| validity window | `notBefore ≤ block.timestamp < expiresAt` |
| execution commitment | the agent's signed struct |
| representation / token | derived from `candidate.representationId` through the immutable market table |
| target / adapter | the market's adapter; never caller-supplied |
| recipient | agent-signed and required to be the principal |
| side | `candidate.side == mandate.side` |
| quantity or spend/proceeds | candidate quantity in token atoms; agent's `fundingLimit` inside the signed bound |
| funding asset | the market's funding token; its settlement unit must be the mandate's economic-limit unit |

Signature acceptance is the kernel's: exactly 65 bytes, `v ∈ {27, 28}`, low `s`
(EIP-2), recovered signer equal to the named party. OpenZeppelin 5.6
`ECDSA.tryRecover` implements that rule; the differential corpus shows it accepts
exactly the principal signatures the kernel's `verifyAuthorization` accepts,
including high-`s` twins, `v = 0/1`, truncated and empty signatures. The principal
and agent structs have different type hashes, so neither signature can stand in
for the other (`sig-012`, `sig-013`). ERC-1271 contract signatures are not
supported, matching the kernel's single `eip712-secp256k1` scheme.

**Cross-chain replay** fails at three independent points: `WrongChain`, the
domain's `chainId`, and the CAIP-2 chain allowlist. **Cross-contract replay**
fails on the domain's `verifyingContract` (`sig-002`, `sig-009`,
`test_refuses_crossContractReplayOfBothSignatures`).

## 5. The supported execution path

**What the repository's evidence supports.** Phase 3 recorded Robinhood Chain
mainnet 4663 and testnet 46630, Stock Token contracts, ERC-8056 multiplier views
and Chainlink feeds. It recorded *no* executable venue: "venue quote and route
interfaces, liquidity usable for execution, testnet transaction behavior" are
listed as unknown in [robinhood-integration.md](robinhood-integration.md), and
Phase 4 routes use labelled synthetic economics. No authoritative source in the
repository identifies a venue contract and interface to integrate against.

**So Phase 6 does not invent one.** The supported path is:

- `FixtureVenue` — **SETTLEMENT FIXTURE, NOT A MARKET.** Trades one
  representation against one funding token at a price and fee fixed at
  deployment, out of whatever inventory it is given. BUY cost and fees round up,
  SELL proceeds round down.
- `FixtureVenueAdapter` — the supported adapter, written as a real venue adapter
  must be: only its gate may call it; it refuses tokens that are not its venue's
  pair and any route data; it approves the venue for exactly the order's input
  and resets the approval to zero; it refunds unspent input and holds nothing.

Nothing built on this may be described as a live trade, live liquidity or a
Robinhood venue integration. What the fixture demonstrates is the gate's security
boundary: authorization, binding, replay, time, and settlement on measured
balances. Adding a real venue is an additional adapter and a new gate deployment
(markets are immutable); it requires evidence of the venue's contracts and
interface first.

## 6. Economic enforcement

Phases 1–5 economics are preserved: the principal signs `economicLimit`, read by
side (ADR 0014).

| Side | Signed bound | Onchain rule |
| --- | --- | --- |
| BUY | `MAX_TOTAL_DEBIT` | `fundingLimit ≤ floor(bound → funding atoms)`; measured debit ≤ `fundingLimit`; measured credit ≥ quantity |
| SELL | `MIN_TOTAL_CREDIT` | `fundingLimit ≥ ceil(bound → funding atoms)`; measured credit ≥ `fundingLimit`; measured debit ≤ quantity |

- **Units.** The candidate's quantity must be in the market's quantity unit
  (`TOKEN`) at the token's decimals — a `SHARE` is not a `TOKEN` under an
  ERC-8056 multiplier (`bind-114`). The mandate's economic-limit unit must be the
  market's settlement unit (`bind-117`).
- **Funding assumption.** A market declares that its funding token settles its
  settlement unit (e.g. a USD stablecoin settling `USD`). That is a stated,
  per-deployment funding assumption, not a claim that the token *is* the
  currency. Stablecoin funding and conversion belong to Phase 7.
- **Decimals and rounding.** The signed bound is converted exactly, by powers of
  ten, and never in the agent's favour: a maximum rounds down, a minimum rounds
  up (`econ-002`, `econ-004`). A maximum beyond `uint256` saturates, which is
  exact because no debit can reach it; a minimum beyond `uint256` refuses,
  because no credit can reach it (`econ-005`, `econ-006`). Token decimals above
  the kernel's 38 are refused at construction. Decimals are pinned at
  construction and re-read at execution; a change is `TokenDecimalsChanged`.
- **Fees.** Fees are inside the measured debit (BUY) or outside the measured
  credit (SELL), so the signed all-in bound covers them without the gate knowing
  any fee schedule. `testFuzz_fixtureVenue_feesAreInsideTheSignedDebitBound`
  fuzzes price and fee.
- **`maxNotional` and deviation** are gross-exposure and price constraints the
  chain cannot observe separately from fees; they remain offchain (§11).
- **Fee-on-transfer and other non-standard tokens** are excluded by the curated
  market table. If one were listed anyway: on the input side the principal is
  still debited at most the transferred amount (`feeOnTransferInput…`); on the
  output side the principal receives less than required and the execution
  refuses (`feeOnTransferOutputFailsClosed`). Rebasing tokens are unsupported.
- **Native ETH** is not supported: `execute` is not payable.
- **Refunds** of unspent input go to the principal and simply reduce the measured
  debit.

## 7. Settlement-delta verification

```text
inputBefore  = input.balanceOf(principal)
outputBefore = output.balanceOf(recipient)          // recipient == principal
transferFrom(principal → adapter, inputAmount)
adapter.execute(order)
actualDebit  = max(inputBefore − input.balanceOf(principal), 0)
actualCredit = max(output.balanceOf(recipient) − outputBefore, 0)
require actualDebit ≤ inputAmount and actualCredit ≥ minOutput
```

The adapter returns nothing and the gate reads nothing it could report. An
adapter that claims an enormous fill while delivering nothing is refused
(`test_adapterClaimingAHugeFillWhileDeliveringNothingRefuses`); one that delivers
to someone else is refused (`settle-003`); one that pulls extra through a stray
allowance is refused (`settle-005`); one that under-delivers by one atom is
refused (`settle-001`). Deltas are net across the whole interaction, which is the
point: whatever happened in between, the principal ends inside the bound.
Balances going the favourable way count as zero debit, never as a negative one.

## 8. Approvals

- **Principal → gate.** The only allowance in the design. The gate can use it
  only with a principal-signed mandate and an agent-signed execution, only up to
  the signed bound, and only once per mandate. The recommended pattern is an
  exact per-mandate allowance (`settle-009` shows it is sufficient and ends at
  zero); a standing allowance is possible but widens what a compromised
  *principal* key or a gate bug could reach, not what an agent can.
  **Revoking the allowance is the Phase 6 revocation mechanism**: it stops every
  signed execution immediately (`test_revokingTheAllowanceStopsEverySignedExecution`).
- **Gate → anyone.** None. The gate pushes the exact input to the adapter with
  `transferFrom(principal → adapter)`; it never approves, and never holds funds
  (INV-ONCHAIN-9).
- **Adapter → venue.** `FixtureVenueAdapter` uses `forceApprove` for exactly the
  order's input (handling tokens that require a reset to zero) and resets to zero
  in the same call. No standing allowance survives an execution
  (`test_gateNeverHoldsFundsOrGrantsAllowances`).
- A principal allowance granted *directly* to an adapter or venue is outside the
  gate's control. The gate still bounds the principal's net debit within its own
  execution (`settle-005`), but cannot protect an allowance used elsewhere.

## 9. Replay, events and reconciliation

### Nonce lifecycle

| Situation | Onchain result |
| --- | --- |
| Duplicate submission | Second is `MandateAlreadyConsumed` (`replay-001`) |
| Simultaneous submission | Transactions are serialized; exactly one settles, the others revert. There is no window: the consumption write and the check are in the same call |
| Revert during the venue call | The whole transaction reverts, consumption included; the authorization stays available (`replay-003`, INV-ONCHAIN-6) |
| Failed settlement check | Same: reverted, unconsumed (`replay-004`) |
| Retry after revert | Permitted while the mandate and deadline are live |
| Replay after success | `MandateAlreadyConsumed`, whatever the new terms (`replay-002`) |
| Retry after expiry | `MandateExpired`: time never extends an authorization (`replay-006`) |
| Out-of-gas in the adapter | The transaction reverts; nothing is consumed (`test_adapterBurningAllGasRevertsAtomically`) |

Consumption is written before any external call (checks-effects-interactions)
and the gate is `nonReentrant`, so a callback — from the adapter, the venue or a
hook token — cannot observe the authorization unconsumed or start a second
execution (`test_reentry…`, `test_callbackTokenCannotReenterDuringTheTransfer`).

**Relation to the offchain state machine.** The kernel's reservation and
quarantine model ([replay-semantics.md](replay-semantics.md)) was built to stop
two concurrent offchain attempts from both executing. For the gate path, the
chain now makes that impossible regardless: one mandate digest, one settlement.
The offchain model remains the *coordination* layer — it keeps an orchestrator
from signing duplicate attempts and holds an authorization whose outcome is
unknown — but its failure modes become liveness costs, not double executions.

### Events

`MandateExecuted(mandateDigest, executionCommitment, principal, candidateDigest,
agent, adapter, inputToken, outputToken, side, actualDebit, actualCredit)` —
the first three indexed. Together with the transaction hash and log index, it
proves *this authorization → this execution → this settlement*. It contains no
data that is not already public in the transaction's calldata.
`MarketSupported` is emitted once per market at construction.

### Chain facts for reconciliation

| Question | Authoritative chain fact |
| --- | --- |
| Did it settle? | `executionCommitmentOf(mandateDigest) != 0` at a block at the required confirmation level |
| Which execution? | The stored commitment, and the `MandateExecuted` log that carries it |
| Actual delivered amounts | `actualDebit`, `actualCredit` in the log |
| Transaction identity | The log's transaction hash |
| Did it revert? | Not consumed at a final block **past the attempt's deadline** |

`observationFromGateEvidence` (`packages/execution-gate/src/reconciliation.ts`)
turns a reading into the kernel's `ExecutionObservation`, or refuses:
`NOT_FINAL` below the required level; `EVIDENCE_MISMATCH` for another chain,
gate or mandate; `EVIDENCE_INCONSISTENT` for a consumption without its log or
vice versa; `OUTCOME_UNESTABLISHED` for an unconsumed mandate while the deadline
has not passed, because a reverted receipt does not exclude a byte-identical copy
being included; `EVIDENCE_MALFORMED` for any malformed input. A `SETTLED` from a
different signed attempt is still `SETTLED` — the authorization is consumed — and
the settling commitment is returned so the discrepancy is surfaced. A test drives
the result through the kernel's own `applyTransition(RECONCILE)`.

This closes V-59 for the gate path: the observation is derived from chain state,
not merely validated. Reading the chain is the caller's job; the rule is pure.

## 10. Tests and invariants

Run: `npm run contracts:test` (regenerates the corpus ABI, then `forge test`).

| Suite | Tests | What it covers |
| --- | --- | --- |
| `MandateExecutionGate.t.sol` | 48 | Construction, both sides on the fixture venue, every refusal, exact time boundaries, replay, conversion |
| `Adversarial.t.sol` | 24 | Lying, under-delivering, redirecting, over-pulling, reverting, gas-burning and re-entering adapters; callback and fee-on-transfer tokens; allowance failure and revocation; fixture adapter restrictions |
| `MandateCodec.t.sol` | 12 | Identifier and set rules, validity rules, domain tags, injectivity, commitment of every numeric field |
| `Fuzz.t.sol` | 13 × 1,024 runs | Amounts, quantities, refunds, fees and prices, bound conversion at every scale, time windows, nonces, post-signature mutation of every committed field, random signature bytes, recipients, tokens, chains |
| `invariant/GateInvariants.t.sol` | 8 invariants × 256 runs × depth 64, plus a deterministic non-vacuity test | Below |
| `Differential.t.sol` | 3 | §11 |
| `DeployScript.t.sol` | 3 | §13 |

Invariants, each checked after every call of every run:

| ID | Invariant |
| --- | --- |
| INV-ONCHAIN-1 | A consumed authorization never settles again (including byte-identical replays) |
| INV-ONCHAIN-2 | Settlements per single-use authorization ≤ 1 |
| INV-ONCHAIN-3 | Every settlement's recorded commitment is the one the agent signed; tampered payloads never settle |
| INV-ONCHAIN-4 | No BUY debits more than its signed `MAX_TOTAL_DEBIT`; no SELL spends more than its quantity |
| INV-ONCHAIN-5 | No SELL credits less than its signed `MIN_TOTAL_CREDIT` |
| INV-ONCHAIN-6 | An authorization is consumed if and only if an execution of it settled |
| INV-ONCHAIN-7 | Unsupported token, adapter or venue combinations never settle |
| INV-ONCHAIN-8 *(added)* | The principal's balances move by exactly the reported measured amounts, and nothing else |
| INV-ONCHAIN-9 *(added)* | The gate never holds funds or grants an allowance |

INV-ONCHAIN-6 holds without qualification here: every external action on the
supported path is inside the reverting transaction. The handler exercises honest,
under-delivering, over-refunding, redirecting, reverting, garbage-returning and
over-pulling adapter behaviour, tampered payloads, unsupported markets, exact
replays and random chain time.

**The suites are discriminating, not only green.** During development each was
run against deliberately broken gates: inclusive expiry, reordered checks,
agent-favouring rounding, accepted 39-decimal amounts, accepted duplicate
allowlist entries, and dropped credit checks were each caught by the differential
corpus; dropped consumption, dropped debit checks and dropped credit checks were
each caught by the invariants. The first invariant campaign also exposed a
vacuous handler (the runner resets the chain ID between calls), fixed in the
handler; a deterministic test now asserts the handler reaches settlement.

## 11. Differential testing and the onchain/offchain split

`corpus/gate-v1` is generated by `packages/execution-gate/test/support/
generate-gate-corpus.ts` from the kernel and the reference model; nothing is
typed twice. `Differential.t.sol` deploys the same world at the same addresses and
replays every entry.

- **222 execution attempts in 215 vectors** — every hand-written refusal family,
  boundary and multi-attempt sequence, plus 120 seeded mutations. For each, the
  two implementations agree on settlement, execution commitment, mandate and
  candidate digests (checked through storage and the event), debit and credit —
  or on the exact revert data, including OpenZeppelin token errors surfacing
  through the gate.
- **139 mandate and 188 candidate encodings** — every parseable input in
  `corpus/v2` and `corpus/mainnet-v1` (recorded Robinhood mainnet state), with
  digests from the *kernel's* encoder, plus 240 seeded structural mutations whose
  validity comes from the kernel's *decoder*.
- **Principal signature acceptance** in the model is the kernel's
  `verifyAuthorization` itself, so agreement is with the kernel's rule, not a copy.
- A TypeScript test asserts every runtime refusal the gate can make appears in the
  corpus, and that the committed corpus equals what the generator produces.

The readable corpus is committed; its ABI form is written by the same generator
run to `contracts/generated/` (not committed — it is megabytes of ABI padding) and
read by the harness.

### What is enforced where

| Constraint | Offchain (kernel/router) | Onchain (gate) |
| --- | --- | --- |
| Principal signature, domain | ✅ | ✅ same rule, differentially tested |
| Mandate/candidate structure and digests | ✅ | ✅ differentially tested |
| Agent identity | ✅ candidate agent | ✅ agent signature + candidate agent |
| Validity window | ✅ caller clock | ✅ `block.timestamp` — the authority |
| Execution deadline | — | ✅ |
| Replay | ✅ reservation/quarantine | ✅ final authority |
| Canonical asset, issuer, chain, venue, side | ✅ against trusted state | ✅ against pinned market facts and the signed mandate |
| Synthetic policy | ✅ registry tri-state | ✅ pinned market flag |
| Token address | ✅ via registry | ✅ derived from `representationId` |
| Economic limit (all-in) | ✅ declared notional + fees | ✅ **measured** balance deltas |
| `maxNotional` | ✅ | ❌ not observable separately from fees |
| Notional consistency (qty × price) | ✅ | ❌ |
| Price deviation, price freshness | ✅ at handoff | ❌ not re-asserted |
| Halt status, operational state | ✅ at handoff | ❌ not re-asserted |
| Corporate-action epoch and freshness | ✅ at handoff | ❌ committed in `candidateDigest`, not re-asserted |
| Registry snapshot binding | ✅ | ❌ committed in `candidateDigest`, not compared (no onchain registry root) |
| Recipient | — | ✅ must be the principal |

## 12. Chain time, reorgs and confirmation

**Time.** `block.timestamp` is the only clock for safety decisions, which closes
F-9 for the gate path by construction. Boundaries match the kernel exactly:
live *at* `notBefore`, expired *at* `expiresAt`; the deadline is inclusive. Each
boundary is tested on both sides of the instant, fuzzed, and differentially
compared. A sequencer can skew timestamps only within the chain's own rules; on
Arbitrum-family chains that is bounded but not zero, and the validity window
should be chosen with that in mind.

**Reorgs.** A contract cannot resolve reorgs, and does not try. A reorged-out
execution takes its consumption with it, which is correct: the chain state is
the truth. What must not happen is offchain state treating an observed
transaction as final. Confirmation levels are defined in
`packages/execution-gate/src/reconciliation.ts`:

| Level | Arbitrum-family meaning |
| --- | --- |
| `SUBMITTED` | Broadcast |
| `MINED` | Receipt in a sequencer block (soft confirmation) |
| `CONFIRMED` | At or below the node's `safe` block (batch posted to the parent chain) |
| `FINALIZED` | At or below `finalized` (parent chain finalized the batch) |

The documented default is `FINALIZED`. Reconciling at a lower level risks an
offchain record that disagrees with the chain after a reorg; because the gate is
the replay authority, such a disagreement costs availability or accounting, never
a second settlement. Mapping levels to a specific chain's RPC tags is caller
policy and never lives in the gate.

## 13. Deployment policy

- **No deployment was performed in Phase 6.** No transaction was sent to any
  network, test or main. CI never deploys.
- `contracts/script/DeployMandateGate.s.sol` deploys fixture venues, their
  adapters and the gate from a reviewed JSON config, predicting the gate's
  address from the deployer nonce and asserting it. It refuses a chain that does
  not match its config and refuses Ethereum, Arbitrum One, Arbitrum Nova and
  Robinhood Chain mainnet outright. It is exercised only by `DeployScript.t.sol`.
- `contracts/deploy/local-fixture.json` targets a local development chain only.
  **No Robinhood Chain testnet config is committed**: the repository holds no
  verified testnet Stock Token or funding-token addresses, and a testnet
  deployment needs separate authorization and that evidence first.
- Target facts: Robinhood Chain testnet is chain 46630 and mainnet 4663
  ([robinhood-integration.md](robinhood-integration.md)). The contracts compile
  for the `cancun` EVM target (OpenZeppelin 5.6 uses `MCOPY`); confirming the
  target chain's ArbOS supports Cancun opcodes is a deployment precondition.
- The gate is immutable. A changed market fact, adapter or fix means a new
  deployment at a new address, and therefore a new EIP-712 domain: signatures for
  the old gate cannot be replayed on the new one.

## 14. Slither findings

Slither 0.11.6, `slither .` with `slither.config.json` (tests, scripts and
dependencies filtered; `fail_on: low`). The first run reported **21 results in 8
detector classes**, all in `contracts/src`. Disposition:

| ID | Detector | Where | Disposition |
| --- | --- | --- | --- |
| S-1 | `arbitrary-send-erc20` (High) | `_settle`: `safeTransferFrom(principal, …)` | **False positive, suppressed with reason.** `principal` is not arbitrary: `_authorize`, which always precedes `_settle` and reverts on failure, has verified the principal's EIP-712 signature over this mandate digest under this gate's domain, and bounded the amount by the signed mandate. Tested by every signature and bound test |
| S-2 | `reentrancy-balance` ×2 | `_settle` before/after balances | **By design, suppressed with reason.** Pre-call balances are meant to be pre-call: settlement is the net delta across the interaction. Gate re-entry is blocked by `nonReentrant` (tested) and consumption precedes the call |
| S-3 | `unused-return` ×2 | `FixtureVenueAdapter`: venue `buy`/`sell` | **Intentional, suppressed with reason.** The adapter measures its own balance rather than trusting the venue's report |
| S-4 | `unused-return` | `_signedBy`: `ECDSA.tryRecover` third value | **Intentional, suppressed with reason.** It only describes why recovery failed; the error enum decides |
| S-5 | `missing-zero-check` | `FixtureVenueAdapter` constructor | **Fixed.** Zero gate or venue now reverts `InvalidConfig` |
| S-6 | `timestamp` | `_checkTime` | **Intended, suppressed with reason.** Chain time is the Phase 6 authority (INV-10); see §12 |
| S-7 | `calls-loop` ×2 | constructor `decimals()` per market | **Accepted, suppressed with reason.** Constructor only, over a deployer-chosen list; a reverting token correctly fails deployment |
| S-8 | `cyclomatic-complexity` | `_checkBinding` | **Accepted, suppressed with reason.** A flat list of independent checks in interface order |
| S-9 | `naming-convention` ×10 | immutables in `UPPER_CASE` | **Style disagreement, detector excluded.** forge-lint requires `SCREAMING_SNAKE_CASE` immutables; the two tools conflict and the Solidity style guide sides with forge-lint |

After remediation: **0 results.** `fail_on: low` then makes any *new* Low, Medium
or High finding fail CI; this was verified by adding a deliberately unsafe
contract, which failed the run, and removing it. Every suppression is an inline
`slither-disable-next-line` beside a comment giving the reason, so the reasoning
travels with the code. forge-lint reports nothing in `contracts/src`; test doubles
are excluded from linting because they deliberately do what lints forbid.

## 15. Threat model

| Threat | Control | Evidence |
| --- | --- | --- |
| Malicious agent | Every agent choice is signed, then bounded by the principal's mandate and the pinned market | `bind-1xx`, fuzz, INV-3/4/5 |
| Compromised agent key | Same bounds: the key can execute only what the principal's mandate permits, once, on supported markets | as above; revocation via allowance (§8) |
| Replay | Mandate digest consumed atomically | INV-1/2/6, `replay-*` |
| Cross-chain replay | `WrongChain`, domain `chainId`, CAIP-2 allowlist | `chain-001`, `sig-003`, `sig-010`, fuzz |
| Cross-contract replay | Domain `verifyingContract` | `sig-002`, `sig-009` |
| Malicious adapter | Measured deltas; bounded input; no allowance; `nonReentrant` | `Adversarial.t.sol`, INV-8 |
| Malicious venue | Behind the adapter; the same deltas | `settle-*`, fixture tests |
| Malicious ERC-20 | Curated markets; re-entry blocked; decimals re-checked; FoT fails closed on output | `test_callbackToken…`, `test_feeOnTransfer…`, `settle-010/011` |
| Reentrancy | CEI + `nonReentrant` | reentry tests |
| Calldata substitution | Execution commitment signed by the agent | `bind-0xx`, fuzz |
| Recipient substitution | Recipient must be the principal; delivery measured at the principal | `bind-118`, `settle-003` |
| Token substitution | Token derived from signed `representationId` via immutable market; asset pinned | `bind-104/105/106` |
| Approval theft | The gate grants none; adapter resets its venue approval | INV-9, `test_gateNeverHolds…` |
| Signature malleability | Low-`s`, `v ∈ {27,28}`, exact length | `sig-004/005/006/011` |
| Front-running | A copied signed execution has an identical, bounded outcome; the original then reverts `MandateAlreadyConsumed` | `test_anyoneMaySubmit…` |
| Nonce racing | One settlement per digest, serialized by the chain | INV-1/2 |
| Deadline manipulation | Chain time; deadline signed; expiry not extended by it | `time-*`, `replay-006` |
| Denial of service | Anyone can burn their own gas; no griefing path can consume an authorization without settling it within bound. A reverting venue blocks only its own executions | `replay-003` |
| Integer / decimal errors | Checked arithmetic; exact power-of-ten conversion; kernel decimal range | `econ-*`, conversion fuzz |
| MEV / sandwiching | **Partial.** Bounded by the signed all-in limit and the agent's `fundingLimit`; not otherwise addressed | — |

## 16. Residual risks

No CRITICAL or HIGH finding is open. What remains, stated plainly:

1. **Dynamic state is not re-asserted at execution.** Price deviation, freshness,
   halt, corporate-action epoch, operational state and registry snapshot are
   decided offchain at handoff. Between handoff and inclusion only the agent's
   deadline and the mandate's expiry bound the window. The principal's cash flow
   stays inside the signed bound regardless; the *instrument's* state does not.
   A pending ERC-8056 multiplier change crossing during flight is the concrete
   case (design §13.5). Re-asserting it onchain means interpreting Robinhood
   metadata in Solidity, which this phase deliberately does not do.
2. **Pinned market facts can go stale.** Issuer, venue or synthetic status
   changes need a new gate.
3. **The funding-unit assumption** (§6) is declared, not verified.
4. **Principal key compromise** is out of scope, as before. A compromised
   principal key can sign any mandate.
5. **Standing allowances** the principal grants elsewhere are outside the gate.
6. **The fixture is not a market.** No liquidity, price discovery or venue
   failure mode beyond revert has been exercised.
7. **Reorgs before finality** can make offchain records disagree with the chain
   if reconciled early; never a second settlement (§12).
8. **Sequencer timestamp skew** within the chain's bounds.
9. **Two encoder implementations** exist; the differential corpus is the control,
   and it covers what it covers.

## 17. One gate for every kind of trader

There is no beginner mode, advanced mode or institutional mode in the contract.
Every trader, and every autonomous agent, reaches the same `execute` with the
same checks. Interfaces differ only in how a signed mandate is *authored*:

| Front end | What the person expresses | What is signed and enforced |
| --- | --- | --- |
| Beginner | "Buy up to $500 of Apple exposure" | A mandate: canonical asset AAPL, BUY, `MAX_TOTAL_DEBIT` 500 USD, issuer/chain/venue allowlists, synthetic policy, validity window — all explicit before signing |
| Advanced | "max debit 500 USD, max deviation 25 bps, representation policy …" | The same mandate fields, set directly |
| Institutional | Issuer allowlist, venue allowlist, delegated agent, policy version | The same fields; the delegated agent is `mandate.agent` |
| Autonomous agent | Nothing — it operates under a mandate | Signs `ExecutionAuthorization` inside that mandate's bounds |

**Simple UX must never mean implicit onchain authority.** A friendlier front end
changes how the mandate is written, never what the gate permits: by the time
anything reaches the chain, all authority is explicit, machine-readable and signed.

## 18. Deferred

Recorded so they are decided on purpose later:

- a real venue adapter, once a venue's contracts and interface are evidenced;
- any testnet deployment, which needs explicit authorization;
- onchain re-assertion of price, epoch or registry snapshot (residual risk 1);
- recipients other than the principal;
- ERC-1271 contract principals; per-mandate onchain revocation beyond allowance
  revocation;
- stablecoin funding and conversion (Phase 7);
- a persistent replay store and reconciliation service (only the pure rule and
  the chain facts are built);
- partial fills beyond what the measured bounds already permit.
