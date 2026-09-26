# The onchain execution gate

> **Status: Phase 6R, implemented and tested locally. Not deployed.** The contract
> is `contracts/src/MandateExecutionGate.sol`; the offchain half is
> `packages/execution-gate`; the decision is
> [ADR 0019](adr/0019-onchain-execution-gate.md). The only supported execution
> path runs against a **labelled settlement fixture**, not a venue (§5). Nothing
> has been deployed to any network and no transaction has been sent.

**Mandate does not choose investments for users. It enforces the authority users
grant to agents.**

The property this phase delivers:

> For the fixture-supported path, no execution materially different from the
> principal's signed mandate and the agent's bound execution authorization can
> settle through the gate. Authentication of the agent is never treated as
> principal authorization.

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
- the candidate notional is the exact quantity × immutable fixture price result
  at the precision the candidate declares; the *true* quantity × fixture price,
  rendered at the principal's signed precision, does not exceed signed
  `maxNotional` whatever precision the agent chose (Phase 6R.1, M-1); and
  declared fees stay inside the signed side-appropriate economic limit;
- exact candidate quantity settles, and the principal's measured cash flow is
  inside the signed economic bound.

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
     synthetic, units, quantity), immutable fixture price, quantity×price notional,
     maxNotional, declared all-in economics, recipient == principal, signed bound
 10  executionCommitmentOf[mandateDigest] := commitment               ← effects
 11  transferFrom(principal → adapter, input); adapter.execute(order) ← interactions
 12  exact representation quantity and measured funding bound         DebitNotExact / CreditNotExact / economic errors
 13  emit MandateExecuted(...)
════════════════════════════════════════════════════════════════════════════════
OFFCHAIN
  read executionCommitmentOf + MandateExecuted at the required confirmation level
  admitAttemptUnderReservation before signing (deadline ≤ reservation expiry)
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
| `GateArithmetic` | `contracts/src/libraries/GateArithmetic.sol` | Exact 512-bit-aware decimal comparisons and kernel-equivalent notional bounds |
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
| quantity, notional, spend/proceeds | exact candidate quantity; exact quantity × immutable fixture price; that true product, at the principal's precision, and the declared notional both ≤ signed `maxNotional`; agent's `fundingLimit` inside the signed side-specific bound |
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
| BUY | gross `maxNotional`; `MAX_TOTAL_DEBIT` | true quantity × fixture price ≤ `maxNotional` at its signed precision, and declared notional ≤ `maxNotional`; declared notional + fee ≤ debit limit; `fundingLimit ≤ floor(limit → funding atoms)`; measured debit ≤ `fundingLimit`; measured representation credit **equals** quantity |
| SELL | gross `maxNotional`; `MIN_TOTAL_CREDIT` | true quantity × fixture price ≤ `maxNotional` at its signed precision, and declared notional ≤ `maxNotional`; declared notional − fee ≥ credit floor; `fundingLimit ≥ ceil(limit → funding atoms)`; measured funding credit ≥ `fundingLimit`; measured representation debit **equals** quantity |

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
- **Notional.** The gate independently reproduces the kernel's exact rational
  floor/ceil band for `quantity × executionPrice`, compares decimal scales with
  512-bit intermediates, and refuses overflow. It never trusts the declared
  notional merely because the agent signed it.
- **`maxNotional` bounds the true product (Phase 6R.1, M-1).** The declared
  notional's precision is the agent's choice and the band above admits either
  adjacent value at it, so at `decimals: 0` a 1.99 USD trade may declare 1 and a
  0.40 USD trade 0. Before 6R.1 the gate compared only that declared value with
  `maxNotional`, so a correctly signing agent could exceed the principal's
  bound by almost one whole unit. The gate now renders `quantity ×` the pinned
  fixture price at `maxNotional.decimals`, rounded up, and refuses
  `MaxNotionalExceeded` when that exceeds the signed atoms — which holds exactly
  when the true product exceeds the bound, because the bound is an integer at
  its own scale. A product beyond `uint256` at that scale is the same refusal.
  The declared comparison still runs first, and the kernel applies the identical
  rule (`checkMaxNotional`, verifier invariant V-16a).
- **Fixture price.** Every `FIXTURE` market pins a typed, non-zero price at
  construction. Candidate prices may use another decimal scale only when the
  rational value is exactly equal. This closes the zero-price/max-notional
  bypass without pretending to solve real-market price freshness.
- **Fixture price and venue price are one price (Phase 6R.1).** The pinned
  typed price and the integer the fixture venue settles at are written by
  different code from different inputs. The constructor asks each market's
  adapter for its venue's settlement terms (`IFixtureSettlement`) and refuses
  `FixtureSettlementInconsistent` unless the venue settles against the
  configured funding token at exactly `fixturePrice.atoms / 10^decimals`
  settlement units per whole token, expressed in funding atoms. A typed price
  finer than the funding token can express has no equal integer venue price and
  is refused by the same comparison. This is enforced by the constructor itself,
  so a direct deployment cannot bypass it; the deployment script additionally
  converts the typed price exactly and refuses one it cannot represent.
- **Fees.** Candidate notional plus BUY fees or minus SELL fees is checked
  against the principal-signed limit before settlement. Measured balance deltas
  then enforce the realized result independently.
- **Fee-on-transfer and other non-standard tokens** are excluded by the curated
  market table. If one were listed anyway: on the input side the principal is
  still debited at most the transferred amount (`feeOnTransferInput…`). On the
  output side the rule depends on the leg. A fee-on-transfer *representation*
  cannot deliver the exact quantity FILL_OR_KILL requires, so it refuses
  (`feeOnTransferOutputFailsClosed`). A fee-on-transfer *funding token* paid
  out on a SELL is measured after the fee: if the principal's actual credit
  still meets the agent's `fundingLimit` — and so the signed
  `MIN_TOTAL_CREDIT` — settlement is safe and proceeds; if the fee pushes it
  below, the execution refuses `CreditBelowMinimum`
  (`feeOnTransferSellProceeds…`). Rebasing tokens are unsupported.
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
BUY:  require actualDebit ≤ inputAmount and actualCredit == candidate quantity
SELL: require actualDebit == candidate quantity and actualCredit ≥ minOutput
```

The adapter returns nothing and the gate reads nothing it could report. An
adapter that claims an enormous fill while delivering nothing is refused
(`test_adapterClaimingAHugeFillWhileDeliveringNothingRefuses`); one that delivers
to someone else is refused (`settle-003`); one that pulls extra through a stray
allowance is refused (`settle-005`); one that under-delivers by one atom is
refused (`settle-001`). Deltas are net across the whole interaction, which is the
point: whatever happened in between, the principal ends inside the bound.
Balances going the favourable way count as zero debit, never as a negative one.
Strict equality implements ADR 0011 FILL_OR_KILL. An unsolicited balance change
during the call can cause denial of service by making the delta too large, but
cannot make a materially different quantity settle. Balance deltas prove the
principal's result, not that the named venue supplied it; a test deliberately
settles from unrelated scripted-adapter inventory to preserve that distinction.

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
  `transferFrom(principal → adapter)` and never approves. "The gate holds no
  funds" means the supported execution path intentionally retains none; anyone
  can still donate tokens directly to any address, and the gate does not sweep
  such unrelated donations.
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
| Did the attempts fail? | Not consumed at a final block whose timestamp is **past the reservation's expiry**, which bounds the deadline of every attempt signed under it |
| Did the mandate expire? | Not consumed at a final block whose timestamp has reached the mandate's `expiresAt` — a separate fact |

The gate's replay key is the mandate digest, so an agent may sign several
execution attempts of one mandate, each with its own chain-time deadline, and
whichever lands first consumes it. Reconciliation keeps two facts apart
(Phase 6R.1a):

- **the attempts failed** — every attempt that could still settle under the
  current reservation is past its deadline and nothing consumed the mandate.
  `RECONCILE(FAILED)` returns the record to `UNUSED`, and the mandate may be
  reserved and tried again while it is valid;
- **the mandate expired** — the gate refuses every attempt from `expiresAt` on,
  whoever signed it.

Phase 6R.1 reported `FAILED` only at mandate expiry, which made a retry after any
reverted attempt impossible for the mandate's whole life: the kernel refuses a
candidate while the record is `RESERVED` or `QUARANTINED`, and by the time
`FAILED` restored it, `verify` refused it as `MANDATE_EXPIRED`.

**Attempt deadlines are bounded by the reservation.** `admitAttemptUnderReservation`
is the pre-signing rule. It admits an attempt only while the kernel replay record
for the mandate's digest is `RESERVED` and live on the pipeline's clock, and only
with a deadline at or before that reservation's expiry; it returns the execution
commitment to sign and the record to store, with the attempt appended (at most
`MAX_ATTEMPTS_PER_RESERVATION` = 8; a rebroadcast of an admitted attempt is not a
new one). The reservation expiry is therefore one ceiling on every deadline signed
under it, however many attempts are live at once. A pipeline that wants a retry
soon after a failure reserves for about as long as its attempt's deadline.

`observationFromGateEvidence(record, evidence, policy)` takes that record — the
chain and gate, the mandate as the MCE v2 bytes the principal signed, the kernel
replay record, and the signed attempts each with its commitment — and a reading:

| Reading (at the required confirmation level) | Result |
| --- | --- |
| Consumed, with the matching `MandateExecuted` log | `SETTLED`, referenced by transaction hash, with `settledCommitment` and whether a recorded attempt signed it |
| Not consumed, block timestamp ≥ mandate `expiresAt` | `FAILED`, basis `MANDATE_EXPIRED` |
| Not consumed, block timestamp > reservation expiry | `FAILED`, basis `ATTEMPTS_EXPIRED`, referenced by the last attempt signed (or the mandate digest if none was) |
| Not consumed, block timestamp ≤ reservation expiry | `OUTCOME_UNESTABLISHED`: an attempt admitted with a deadline up to the reservation's expiry could still land |

The gate refuses `block.timestamp > deadline` and chain timestamps never
decrease, so once a final block is past the ceiling no attempt under the
reservation can land. Attempts under an earlier reservation were already past
*that* ceiling when it was reconciled `FAILED`. Nothing is taken on trust: the
mandate digest and expiry are derived from the signed bytes (a record whose bytes
hash to another digest is `EVIDENCE_MISMATCH`); every recorded attempt's
commitment must re-derive from its fields, so its deadline is the one the gate
enforces (`EVIDENCE_INCONSISTENT` otherwise); and the reservation must be the
kernel's `RESERVED` or `QUARANTINED` record for that digest (`RESERVATION_MISMATCH`,
`NOT_RESOLVABLE`). Other refusals: `NOT_FINAL` below the required level;
`EVIDENCE_MISMATCH` for another chain, gate or mandate; `EVIDENCE_INCONSISTENT`
for a consumption without its log or vice versa; `EVIDENCE_MALFORMED` for any
malformed input.

**The assumption is signing discipline**: attempts are signed only through
`admitAttemptUnderReservation`. An attempt signed outside it is not bounded by
the reservation. It still cannot settle twice — the gate consumes the digest at
most once — and if it settles, reconciliation reports `SETTLED` with
`settledByRecordedAttempt: false`. A record that itself carries an attempt past
its reservation proves the discipline was broken, so it is refused
(`ATTEMPT_OUTSIDE_RESERVATION`) until the mandate expires. Tests drive every
result through the kernel's own `applyTransition(RECONCILE)`, including a full
fail → `UNUSED` → re-reserve → settle → `CONSUMED` cycle on a 30-day mandate.

This closes V-59 for the gate path: the observation is derived from chain state,
not merely validated. Reading the chain is the caller's job; the rule is pure.
The `confirmation` value passed to that rule is not cryptographic proof. The
chain reader is a trust boundary and must establish canonical block status from
the configured RPC/finality policy, bind transaction hash and log index, and
only then construct evidence. A caller-supplied string `FINALIZED` alone proves
nothing.

## 10. Tests and invariants

Run: `npm run contracts:test` (regenerates the corpus ABI, then `forge test`).

| Suite | Tests | What it covers |
| --- | --- | --- |
| `MandateExecutionGate.t.sol` | reported by the final Phase 6R validation | Construction, principal authority, both sides, exact time boundaries, replay/reorg model, calldata canonicality, executable profile |
| `Adversarial.t.sol` | reported by the final Phase 6R validation | Lying, exact-fill violations, redirecting, over-pulling, large return/revert data, gas burn, re-entry, token return variants, approval cleanup and provenance limits |
| `MandateCodec.t.sol` | 12 | Identifier and set rules, validity rules, domain tags, injectivity, commitment of every numeric field |
| `Fuzz.t.sol` | 15 × 1,024 runs | Principal/agent economics, exact rational arithmetic, quantities, prices, decimal scales, exact fill, time, replay, post-signature mutations, signatures, recipient, representation and chain |
| `invariant/GateInvariants.t.sol` | 12 invariants × 256 runs × depth 64, plus a deterministic non-vacuity test | Below |
| `Differential.t.sol` | 4 | §11 |
| `MaxNotional.t.sol` | 13 + 2 fuzz × 1,024 runs | Phase 6R.1 M-1 on the real fixture path: the audit PoCs, declared precision 0–38 with every signature valid, one atom either side at the principal's precision, decimal-conversion boundaries, huge-quantity/tiny-price and tiny-quantity/huge-price, 512-bit intermediates, randomized precision combinations on both sides. Since 6R.1a: every declared × principal precision pair (39 × 39) on each side through the real venue; the product rule against the exact oracle at full operand width and at every one of the 39³ decimal triples; and replays of the inputs that overflowed the 6R.1 oracle |
| `ExactMath.t.sol` | 1 + 2 fuzz × 1,024 runs | The exact 512-bit test oracle (`utils/ExactMath.sol`) against plain arithmetic where it cannot overflow, hand-computed extremes, and the defining property of the floor and ceiling it reports |
| `Profile.t.sol` | 1 | The worst-case executable attempt — maximal identifiers, full sets, 4,096 non-zero route bytes — settles; calldata size pinned jointly with `corpus.test.ts`; intrinsic and execution gas logged (§13) |
| `DeployScript.t.sol` | 6 | §13, including exact typed-price conversion and the constructor's refusal of a mismatched venue |

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
| INV-ONCHAIN-AUTH-1 | Every settlement's *true* gross — quantity × the venue's settlement price, compared with the signed bound at its signed precision by the handler's own cross-multiplication — satisfies signed `maxNotional`, whatever precision the agent declared |
| INV-ONCHAIN-AUTH-2 | Every settlement satisfies exact quantity |
| INV-ONCHAIN-AUTH-3/4 | Every BUY/SELL satisfies its measured signed economic bound |
| INV-ONCHAIN-AUTH-5 | A correctly signing malicious agent cannot settle a generated static principal-policy violation |

INV-ONCHAIN-6 holds without qualification here: every external action on the
supported path is inside the reverting transaction. The handler exercises honest,
under-delivering, over-refunding, redirecting, reverting, garbage-returning and
over-pulling adapter behaviour, tampered payloads, unsupported markets, exact
replays and random chain time on the scripted adapter, and — since 6R.1 — the
real `FixtureVenue` / `FixtureVenueAdapter` market on both sides, with the agent
choosing quantity, declared notional precision and rounding while the
principal's bound is placed at the agent's coarse declared value (the M-1 shape)
or one side of the true product. The deterministic non-vacuity test asserts the
three audit PoC shapes are attempted and refused on the real path and that BUY
and SELL settle there.

**The suites are discriminating, not only green.** During development each was
run against deliberately broken gates: inclusive expiry, reordered checks,
agent-favouring rounding, accepted 39-decimal amounts, accepted duplicate
allowlist entries, and dropped credit checks were each caught by the differential
corpus; dropped consumption, dropped debit checks and dropped credit checks were
each caught by the invariants. The first invariant campaign also exposed a
vacuous handler (the runner resets the chain ID between calls), fixed in the
handler; a deterministic test now asserts the handler reaches settlement.

Phase 6R.1 repeated this for M-1: with only the gate's true-product comparison
removed, `INV-ONCHAIN-AUTH-1` failed on its own (the fuzzer shrank the sequence
to a single `executeFixturePrecision` call), the non-vacuity test failed, both
differential tests failed at `authority-017`, and nine of the ten
`MaxNotional.t.sol` tests failed (the tenth is a positive control). The
Phase 6R handler could not have caught it: it compared only declared notional
atoms, which is exactly the value the agent controls.

## 11. Differential testing and the onchain/offchain split

`corpus/gate-v1` is generated by `packages/execution-gate/test/support/
generate-gate-corpus.ts` from the kernel and the reference model; nothing is
typed twice. `Differential.t.sol` deploys the same world at the same addresses and
replays every entry.

- **308 execution attempts in 301 vectors** — every hand-written refusal family,
  boundary and multi-attempt sequence, 120 seeded mutations, and 64 seeded
  `maxNotional` precision combinations (below). For each, the
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
- A separate authority layer sends **20 actual-kernel REJECT** cases with valid
  principal and authorized-agent signatures to Solidity; none settles. These
  cover economics, arithmetic, immutable fixture price, identity, side, asset,
  issuer, chain, venue, synthetic policy, representation mapping and quantity
  unit, and — `authority-017`…`020` — the three M-1 audit PoCs and a 6-decimal
  declaration that rounds an 18-decimal excess away.
- **Seeded precision agreement.** 64 vectors vary the execution-price,
  declared-notional and `maxNotional` precisions on both markets and sides; two
  thirds place the bound exactly at the agent's coarse declared value. The
  generator asks the actual kernel about every one and refuses to write the
  corpus if the kernel's `MAX_NOTIONAL_EXCEEDED` and the gate's
  `MaxNotionalExceeded` ever disagree; the corpus records the tally
  (`precisionAgreement`), including how many were the declared-within,
  true-above shape.

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
| Economic limit (all-in) | ✅ declared notional + fees | ✅ declared economics and **measured** balance deltas |
| `maxNotional` | ✅ true quantity × price at the signed precision, and declared notional | ✅ the same rule against the pinned fixture price |
| Notional consistency (qty × price) | ✅ | ✅ kernel-equivalent floor/ceil arithmetic |
| Fixture price | trusted fixture state | ✅ immutable exact scaled value |
| Real-market price deviation, price freshness | ✅ at handoff | ❌ not re-asserted; real markets prohibited |
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
  Robinhood Chain mainnet outright. It writes each market's price once, typed,
  and gives the venue that price converted exactly to funding-token atoms,
  refusing `FixturePriceNotRepresentable` when it cannot. It is exercised only by
  `DeployScript.t.sol`. The gate constructor independently refuses a venue at any
  other economic price (§6), so a hand-rolled deployment is held to the same rule.
- `contracts/deploy/local-fixture.json` targets a local development chain only.
  **No Robinhood Chain testnet config is committed**: the repository holds no
  verified testnet Stock Token or funding-token addresses, and a testnet
  deployment needs separate authorization and that evidence first.
- Every market is explicitly classified. Phase 6R accepts `FIXTURE` only;
  `REAL_MARKET` construction reverts `RealMarketStateSourceRequired` until an
  authenticated inclusion-time state source exists.
- The executable profile is at most 16 issuers, 16 chains, 16 venues, 4,096
  route bytes and 32 constructor markets. The worst case is measured, settled and
  reproduced independently (Phase 6R.1): every string a deployment or mandate
  can choose is a maximal 128-byte identifier (canonical asset, issuer, venue,
  both units, all 15 optional entries of each set, the evaluation-state
  identifier), route data is 4,096 **non-zero** bytes, and every free numeric
  field is at its maximum. `Profile.t.sol` settles that attempt and
  `corpus.test.ts` rebuilds it with the TypeScript ABI encoder; both pin
  **18,596 calldata bytes** (5,669 zero, 12,927 non-zero). Intrinsic calldata gas
  is **250,508** under EIP-2028 pricing, at most 318,536 if every byte were
  non-zero, and at most 764,840 under an EIP-7623-style 40-gas floor; Arbitrum
  additionally charges for L1 data, which is not modelled here. The settled
  `execute` call used **6,646,656 gas** through an adapter that only fills, so
  the figure is the gate's. Gas grows linearly with identifier length
  (≈1.13M at 16-byte identifiers, ≈3.49M at 64) because the gate validates and
  re-encodes every identifier byte to re-derive the digests. The Nitro node
  default is 95,000 transaction-data bytes, so calldata keeps more than 80%
  headroom. The Phase 6R figures (17,156 bytes, 172,784 intrinsic gas,
  1,673,113 execution gas) were understated: they used ~14-byte identifiers,
  all-zero route data, and a gas window that included test-side signing.
- Fixture deployments require non-upgradeable representation tokens, funding
  tokens, adapters and venue targets. A deployment review must record address,
  chain, runtime codehash, proxy status and implementation/codehash. The
  constructor rejects code-less dependencies but does not mistake an immutable
  address for immutable code; upgradeable dependencies are deployment-prohibited.
- Target facts: Robinhood documents chain IDs 46630/4663 and describes the
  chain as Arbitrum Nitro ([network](https://docs.robinhood.com/chain/connecting/),
  [node](https://docs.robinhood.com/chain/run-a-full-node/)). The same node guide
  currently reports ArbOS 61; Nitro's own MCOPY upgrade test establishes MCOPY
  support in post-ArbOS-11 versions. The contracts compile for `cancun` because
  OpenZeppelin 5.6 uses `MCOPY`. Reconfirming the target chain's current ArbOS
  version remains a deployment-time check, not an assumption frozen in source.
- The gate is immutable. A changed market fact, adapter or fix means a new
  deployment at a new address, and therefore a new EIP-712 domain: signatures for
  the old gate cannot be replayed on the new one.

### Vetted-token policy

| Behaviour | Classification | Reason |
| --- | --- | --- |
| Standard boolean-return ERC-20 | **SUPPORTED** | SafeERC20 and balance-delta tests cover it |
| Empty-return legacy ERC-20 | **SUPPORTED, review required** | SafeERC20 accepts empty success data; explicitly tested |
| Malformed return data | **FAILS CLOSED** | SafeERC20 reverts; consumption and transfers roll back |
| Fee-on-transfer input | **SUPPORTED only when deployment review accepts its economics** | Net principal debit remains bounded; adapter may receive less |
| Fee-on-transfer representation (BUY output, SELL input) | **FAILS CLOSED** | The representation leg must move by exactly the candidate quantity; a transfer fee breaks that (`feeOnTransferOutputFailsClosed`) |
| Fee-on-transfer funding token as SELL output | **SAFE when the measured credit meets the signed minimum; otherwise FAILS CLOSED** | The gate measures what the principal actually received, after the fee, against the agent's `fundingLimit`, itself at least the principal's signed `MIN_TOTAL_CREDIT`. A credit that still meets it is within authority; one the fee pushes below it reverts `CreditBelowMinimum` (`feeOnTransferSellProceeds…`). Still subject to deployment review, since the venue's quoted proceeds are not what the principal receives |
| Callback token | **FAILS CLOSED against gate re-entry** | `nonReentrant`; callback test settles only the outer authorization |
| Rebasing token | **UNSUPPORTED / DEPLOYMENT-PROHIBITED** | In-call/exogenous balance movement makes deltas ambiguous |
| Token lying about `balanceOf` | **UNSUPPORTED / DEPLOYMENT-PROHIBITED** | Delta verification cannot establish truth from a dishonest oracle |
| Mint/burn during execution | **UNSUPPORTED / DEPLOYMENT-PROHIBITED** unless semantics are exhaustively reviewed | Can manufacture or erase apparent deltas; strict equality may only provide DoS, but provenance is not proven |
| Upgradeable token | **UNSUPPORTED / DEPLOYMENT-PROHIBITED** | Immutable address does not pin behavior |
| Representation == funding token | **DEPLOYMENT-PROHIBITED** | Constructor rejects it; two balance legs would be ambiguous |

All token, adapter and venue code is trusted deployment surface. Balance deltas
prove only the balances reported by those token contracts. They do not prove
legal/economic equivalence or venue provenance.

## 14. Slither findings

Slither 0.11.6, `slither .` with `slither.config.json` (tests, scripts and
dependencies filtered; `fail_on: low`). The first run reported **21 results in 8
detector classes**, all in `contracts/src`. Disposition:

| ID | Detector | Where | Disposition |
| --- | --- | --- | --- |
| S-1 | `arbitrary-send-erc20` (High) | `_settle`: `safeTransferFrom(principal, adapter, inputAmount)` | **False positive; re-reviewed against the code in Phase 6R.1.** *From:* `principal` is `mandate.principal`, and `_authorize` has recovered the principal's EIP-712 signature over that mandate's MCE v2 digest under this gate's domain (chain ID and address) and checked the digest unconsumed. *To:* the adapter pinned for the market at construction, never caller-supplied. *Token:* the market's pinned funding token (BUY) or representation (SELL). *Amount:* on **BUY** it is the agent's `fundingLimit`, required `≤ floor(signed MAX_TOTAL_DEBIT → funding atoms)`; `maxNotional` does not bound this transfer, the signed economic limit does, and the measured debit is re-checked after the adapter refunds. On **SELL** it is the candidate quantity at the pinned token decimals, whose true product with the immutable fixture price must be `≤` signed `maxNotional` at the principal's precision (`_checkMaxNotional`) and which must be debited exactly. Before 6R.1 that SELL bound compared only the agent's declared notional, so the amount pulled could exceed `maxNotional / price` by up to one unit of the agent's chosen precision (M-1); the Phase 6R wording overstated what was enforced |
| S-2 | `reentrancy-balance` ×2 | `_settle` before/after balances | **By design, suppressed with reason.** Pre-call balances are meant to be pre-call: settlement is the net delta across the interaction. Gate re-entry is blocked by `nonReentrant` (tested) and consumption precedes the call |
| S-3 | `unused-return` ×2 | `FixtureVenueAdapter`: venue `buy`/`sell` | **Intentional, suppressed with reason.** The adapter measures its own balance rather than trusting the venue's report |
| S-4 | `unused-return` | `_signedBy`: `ECDSA.tryRecover` third value | **Intentional, suppressed with reason.** It only describes why recovery failed; the error enum decides |
| S-5 | `missing-zero-check` | `FixtureVenueAdapter` constructor | **Fixed.** Zero gate or venue now reverts `InvalidConfig` |
| S-6 | `timestamp` | `_checkTime` | **Intended, suppressed with reason.** Chain time is the Phase 6 authority (INV-10); see §12 |
| S-7 | `calls-loop` ×3 | constructor `decimals()` ×2 and `fixtureSettlement` per market | **Accepted, suppressed with reason.** Constructor only, over a deployer-chosen list; a reverting token or adapter correctly fails deployment. The third call (6R.1) is the fixture venue price check (§6) |
| S-8 | `cyclomatic-complexity` | `_checkBinding` | **Accepted, suppressed with reason.** A flat list of independent checks in interface order |
| S-9 | `naming-convention` ×10 | immutables in `UPPER_CASE` | **Style disagreement, detector excluded.** forge-lint requires `SCREAMING_SNAKE_CASE` immutables; the two tools conflict and the Solidity style guide sides with forge-lint |
| S-10 | `unused-return` | `GateArithmetic.notionalBounds`: low limb of `Math.mul512` | **Intentional, suppressed with reason.** Only the high limb determines whether the quotient fits `uint256`; the following `mulDiv` and `mulmod` independently consume the full product for quotient and remainder |
| S-11 | `unused-return` | `_checkMaxNotional`: floor of `notionalBounds` | **Intentional, suppressed with reason (6R.1).** The rounded-up product alone is the exact criterion against an integer bound; the floor carries no further information |
| S-12 | `cyclomatic-complexity` | `_checkEconomics` (12) | **Fixed (6R.1).** The M-1 check first pushed it over the threshold; the `maxNotional` rule now lives in `_checkMaxNotional`, which also keeps it reviewable on its own |

The fresh Phase 6R run initially found two `uninitialized-local` diagnostics for
Solidity-zeroed memory structs and S-10. The structs are now explicitly
initialized and S-10 is narrowly documented at the ignored return. The final
normal run analyzed **20 contracts with 101 detectors and reported 0 results**.
An independent `--show-ignored-findings` run reported **11 reviewed results**:
S-1 (1), S-2 (2), S-3/S-4/S-10 (4), S-6 (1), S-7 (2), and S-8 (1).
`fail_on: low` makes any *new* Low, Medium or High finding fail CI; this was
verified by adding a deliberately unsafe contract, which failed the run, and
removing it.

**Phase 6R.1 run.** The M-1 fix first produced two new results, S-11 and S-12,
dispositioned above. The final normal run analyzed **21 contracts with 101
detectors and reported 0 results** (exit 0). `--show-ignored-findings` reports
**13 reviewed results**: S-1 (1), S-2 (2), S-3/S-4/S-10/S-11 (5), S-6 (1),
S-7 (3) and S-8 (1). Removing the S-11 suppression makes the normal run fail
(exit 255), so the gate still fails closed on a new finding. Every suppression is an inline `slither-disable-next-line` beside a
comment giving the reason, so the reasoning travels with the code. forge-lint
reports nothing in `contracts/src`; test doubles are excluded from linting
because they deliberately do what lints forbid.

## 15. Threat model

| Threat | Control | Evidence |
| --- | --- | --- |
| Malicious agent | Authentication is not authority: every static candidate choice in scope is independently bounded by the principal mandate and immutable fixture market | `authority-*` actual-kernel vectors, fuzz, INV-ONCHAIN-AUTH-1..5 |
| Compromised agent key | Same bounds: the key can execute only what the principal's mandate permits, once, on supported markets | as above; revocation via allowance (§8) |
| Replay | Mandate digest consumed atomically | INV-1/2/6, `replay-*` |
| Cross-chain replay | `WrongChain`, domain `chainId`, CAIP-2 allowlist | `chain-001`, `sig-003`, `sig-010`, fuzz |
| Cross-contract replay | Domain `verifyingContract` | `sig-002`, `sig-009` |
| Malicious adapter | Measured deltas; bounded input; no allowance; `nonReentrant` | `Adversarial.t.sol`, INV-8 |
| Malicious venue | Behind the adapter; the same deltas | `settle-*`, fixture tests |
| Malicious ERC-20 | Deployment allowlist; code and decimals checked; re-entry blocked; output FoT fails closed; malformed return fails closed; lying balances/rebasing/upgradeable tokens prohibited | adversarial token tests, `settle-010/011` |
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

1. **Dynamic state is not re-asserted at execution.** The fixture price is now
   immutable, but real-market reference price/freshness, halt, operational state,
   corporate-action epoch, multiplier and registry currentness remain handoff
   facts. A price move, halt, corporate action or multiplier change after fresh
   verification but before inclusion can invalidate a real-market decision.
   Severity is **HIGH for any real-market path**, therefore `REAL_MARKET` is
   structurally rejected. It is **not a fixture-path High** because the labelled
   fixture has no live market state and makes no such guarantee.
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
- partial fills (strict FILL_OR_KILL is the only supported semantics).
