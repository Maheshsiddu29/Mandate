# Phase 7E.3 — Robinhood Chain testnet deployment and real EVM enforcement

> **Status: implemented locally and run on Robinhood Chain testnet, awaiting
> review.** The frozen gate is deployed at
> `0xb03c1e072192a82ba68604841a0e42f32609aa3e` and executed a valueless BUY
> under real Mandate authorization (tx `0x7144f09f…f344`). Testnet (46630) only; valueless labelled fixtures; no mainnet, no real funds, no
> production credential. Phases 7A–7D stay frozen and Phase 6 is unchanged:
> 7E.3 adds a package, a demo token and tests, and changes no frozen package,
> contract, schema or canonical corpus. Reconciliation is 7F and not built.
> Deployment facts: [robinhood-deployment.md](robinhood-deployment.md); the
> live run: [robinhood-demo.md](robinhood-demo.md).

## Contents

1. [What was built](#1-what-was-built)
2. [The enforcement path](#2-the-enforcement-path)
3. [GateSpotPolicy v1](#3-gatespotpolicy-v1)
4. [The adapter and its identity](#4-the-adapter-and-its-identity)
5. [From a Core authorization to an exact gate artifact](#5-from-a-core-authorization-to-an-exact-gate-artifact)
6. [Issuance](#6-issuance)
7. [Custody](#7-custody)
8. [Cross-domain authority](#8-cross-domain-authority)
9. [Tests](#9-tests)
10. [Validation](#10-validation)
11. [Changes by package](#11-changes-by-package)
12. [Limits and open questions](#12-limits-and-open-questions)
13. [Explicit answers](#13-explicit-answers)

---

## 1. What was built

| Path | What |
| --- | --- |
| `packages/evm-robinhood/src/vocabulary.ts` | domain `robinhood-evm`, action `evm.gate-buy`, state `evm.gate-market`, resources and codecs |
| `…/market.ts` | the reviewed-market record, the venue's exact quote, the snapshot the chain must reproduce |
| `…/policy.ts` | **GateSpotPolicy v1**, a `DomainModule` over one deployed gate (§3) |
| `…/adapter.ts` | the `robinhood-gate-signer` adapter descriptor and `AdapterRef` (§4) |
| `…/gate.ts` | the exact gate mandate, candidate and terms for a Core authorization (§5) |
| `…/issuance.ts`, `signer.ts` | the staged issuance boundary and `GateSigner` (§6) |
| `…/custody.ts` | principal custody that verifies the committed `ADMIT_ATTEMPT` before signing; the agent signer (§7) |
| `…/abi.ts`, `transaction.ts` | ABI encoding of `execute`; EIP-1559 signing for one fixed chain |
| `…/chain.ts`, `live.ts`, `state-reader.ts` | the only network access (testnet RPC only), the live `GateChain`, the gate-market reader |
| `packages/evm-robinhood/scripts/` | `deploy.ts`, `demo.ts`, `verify.ts`: the explicit testnet commands |
| `contracts/src/demo/MandateDemoToken.sol` | the labelled fixture ERC-20 (MDEMO, MDUSD) |
| `contracts/test/RobinhoodDemo.t.sol` | the demo market on the real frozen gate, via the reviewed deploy script |
| `contracts/deploy/robinhood-testnet.json` | the deployed market configuration (written by `deploy`) |
| `docs/phase-7e/deployment-manifest.json`, `robinhood-demo-receipt.json` | sanitized deployment manifest and demo receipt (written by the commands) |

## 2. The enforcement path

```text
Agent ── evm.gate-buy {account, market, quantity} ──► Mandate Control
                                                       │ GateSpotPolicy: validate, state needs, projection, demands
                                                       │ state admission: evm.gate-market read from the gate, pinned to the review
                                                       │ ledger: CAPITAL (required) + NOTIONAL + COUNT, atomic reservation
                                                       ▼
                                           AuthorizationRecord (reservation, generation, adapter, ceiling)
                                                       │
                                  GateSigner (robinhood-gate-signer v1)
                                                       │ resolve → evidence (chain time, gate code + domain, allowance, balance)
                                                       │ construct the exact gate artifact (gate.ts); slot = next gate nonce
                                                       │ NONCE_SLOT: the gate has never consumed this mandate digest
                                                       │ Control.admitAttempt → ADMIT_ATTEMPT(commitment, slot) — durable
                                                       │ custody verifies the committed attempt, signs the mandate; agent signs the commitment
                                                       │ journal → eth_call preflight → submit
                                                       ▼
                               MandateExecutionGate.execute (frozen Phase 6, onchain)
                                                       │ signatures, chain time, replay key, market binding, exact economics
                                                       ▼
                                    FixtureVenueAdapter → FixtureVenue → principal   (Robinhood Chain testnet)
```

**No alternate authorized path for the demo account.** The principal's MDUSD
can leave its address in two ways: a transfer signed by the principal key, or
`transferFrom` by a spender it approved. The principal key is held only by
Mandate custody (§7); the only approved spender is the gate, for exactly the
capital authority (500 MDUSD); and the gate moves funds only for a
principal-signed mandate. The agent holds its own key and nothing else: it
has no allowance, and a mandate it signs itself is `PrincipalSignatureInvalid`
(tested offline and in Foundry; on testnet, the agent's own
`transferFrom` of the principal's MDUSD is refused for want of an allowance). This is a property
of this deployment's key placement, not of the chain — an EOA principal's key
can always move its tokens directly (§12).

## 3. GateSpotPolicy v1

`gate-spot` v1, domain `robinhood-evm`. BUY only, of a reviewed FIXTURE
market, for the principal's own account.

| Quantity | Kind | Unit, decimals | Asset | Demand |
| --- | --- | --- | --- | --- |
| capital spent | `CAPITAL` | the market's settlement unit, funding decimals | the funding token | **required** |
| committed notional | `NOTIONAL` (`LIMIT` basis) | settlement unit, funding decimals | the canonical asset | if a dimension matches |
| actions | `COUNT` | `COUNT` | — | if a dimension matches |

- **Capital** is exactly `FixtureVenue.quoteBuy(quantity)` — quantity × the
  immutable venue price, rounded up, plus the fee, rounded up. It is the only
  amount the gate can pull: the signed `MAX_TOTAL_DEBIT` and the agent's
  `fundingLimit` are set to it. It is **required**: a lineage with no capital
  dimension in that unit refuses (`UNBOUNDED_CONTRIBUTION`) instead of running
  unbudgeted; a USDC capital limit does not bound an MDUSD spend.
- **Notional** is valued on the `LIMIT` basis: before execution the fixture
  price is a committed worst case, and Core reserves `EXECUTION` for an
  observed fill (`VALUATION_SOURCE_INVALID` otherwise — found while building).
- **State**: one `evm.gate-market` snapshot per market — the gate's
  `marketOf` entry, its `fixtureVenueOf` venue and that venue's `FEE_BPS`, all
  read at one block — pinned by digest (`VERSION` freshness) to the reviewed
  record; age ≤ 60 s by default; minimum finality `LATEST` (the table is
  written once, by the constructor); `atIssue: RECHECK`; `atExecution:
  ENFORCED_BY_ARTIFACT` (the gate derives token, adapter, price and units from
  the candidate's representation id itself). A snapshot reporting another
  price, fee, adapter or funding token is refused at admission.
- **Pending** reservations are projected in full; nothing is credited back
  until reconciliation (7F) says what the gate settled.
- It owns no state invariant in v1; its authority is the ledger's dimensions.
- The module digest content-addresses the chain id, gate address, every
  reviewed market's snapshot, the source, freshness and lifetime, the
  assumptions and the action type (DOM-2).

## 4. The adapter and its identity

`robinhood-gate-signer` v1. Its `adapterDigest` covers: the chain id, the gate
address, **the gate's runtime code hash and domain separator**, the frozen
Phase 6 source and compiler settings, every reviewed market, the `execute`
selector (`0x783f1d00`, checked against `forge inspect`), the artifact kind
(`evm.gate-execution-commitment`), the slot rule, `recipient:principal-only`,
`execution-data:empty`, the pre-execution requirements, the finality ladder
and release level (`FINALIZED`; nothing is released in 7E.3), and the
submission policy (`signer-owned`, `preflight:eth_call`, `resubmission:none`).

**A future adapter version cannot reinterpret an issued authorization**, at
three independent points:

1. Control: `admitAttempt` refuses an adapter other than the authorization's
   (`ADAPTER_MISMATCH`); the signer refuses it first (`ADAPTER_NOT_THIS_SIGNER`).
2. Custody: signs only for the `ModuleRef` and `AdapterRef` it serves
   (`ADAPTER_NOT_SERVED`) and whose durable lifecycle row is `ACTIVE`/`RETIRING`.
3. Chain: the gate mandate's `mandateId` — which the principal signs — is
   derived from the adapter digest (§5). A mandate issued under this adapter
   names it, and a different gate is a different EIP-712 domain.

## 5. From a Core authorization to an exact gate artifact

`gate.ts` derives every field; nothing is taken from the agent beyond the
payload the authorization already binds.

| Core fact | Gate field it is bound into | Signed by |
| --- | --- | --- |
| execution authorization id, reservation, generation, adapter digest | `mandate.mandateId = keccak("mandate/evm-robinhood/gate-mandate-id" ‖ v1 ‖ …)` | principal |
| the gate slot (ledger-unique per gate and principal) | `mandate.nonce` | principal |
| decision time / attempt ceiling `validUntil` | `mandate.notBefore`, `createdAt` / `mandate.expiresAt` (the gate refuses **at** it) | principal |
| worst-case debit (the reserved capital) | `mandate.economicLimit` (`MAX_TOTAL_DEBIT`), `terms.fundingLimit` | principal / agent |
| gross notional | `mandate.maxNotional`, `candidate.notional` | principal / agent |
| authorization record id | `candidate.evaluationStateDigest` | agent |
| reviewed market snapshot digest | `candidate.registrySnapshotDigest` | agent |
| quantity, price, fee, representation, agent | candidate fields (the gate re-derives them against its market table) | agent |
| recipient | `terms.recipient` = the principal (the gate requires it) | agent |
| deadline | `min(now + 90 s, validUntil − 1)`, inclusive | agent |
| chain, gate | the EIP-712 domain of both signatures | both |

The gate mandate is **per reservation generation**: its digest is the gate's
replay key, so a generation settles at most once onchain, and a generation-`n`
mandate cannot be read as `n + 1` (a new generation is a new mandate id and
nonce, needing a new principal signature — tested in Foundry).
`checkGateArtifact` re-derives the whole artifact and compares it field by
field; it runs before admission and again inside custody.

## 6. Issuance

The Lighter signer's shape, for an EVM artifact:

| Stage | What | Refusal leaves |
| --- | --- | --- |
| resolve | module, adapter, principal, payload digest, action type, account = principal, market on this gate | `NEVER_ISSUED` available |
| evidence | chain time (latest block); gate code hash and domain separator; the principal's allowance to the gate and balance, against the capital → `CREDENTIAL_SCOPE` | same |
| construct | the exact artifact; nonce = one past the highest slot the ledger ever admitted | same |
| slot | `executionCommitmentOf(mandateDigest) == 0` → `NONCE_SLOT` | same |
| admit | `Control.admitAttempt`: revalidation on a fresh chain read at chain time, module/adapter trust, both adapter results, `ADMIT_ATTEMPT(artifact = commitment, slot, validUntil = deadline + 1)` | same |
| sign | custody verifies and signs the mandate; the agent signs the commitment; both recovered under the gate's own rule | attempt admitted, reservation held |
| journal, preflight | `ARTIFACT_ISSUED` with the calldata; `eth_call` of exactly that calldata | a revert → `OUTCOME_UNKNOWN`, nothing broadcast, reservation held |
| submit | `SUBMISSION_SENT` → mined `SUCCESS` (`SUBMISSION_ACKNOWLEDGED`) / mined `REVERTED` (`SUBMISSION_REJECTED`) / `OUTCOME_UNKNOWN` | nothing released |

A second request for a generation that has an attempt gets that attempt
(`EXISTING`); 100 concurrent requests produce one `ADMIT_ATTEMPT`, one
signature and one transaction. The agent receives the attempt id, mandate
digest, commitment, transaction hash and issuance state — never a signature
or the calldata. The submitter pays gas and holds no authority.

## 7. Custody

`LocalGateCustody.signMandate(artifact, terms, claim)` — no hash is accepted.
Before the principal key is used, custody itself checks, against the
committed ledger: the attempt exists; module and adapter are the served ones;
reservation, generation and action are the claimed ones; the venue account is
the principal's; the artifact re-derives exactly from the attempt's own
identity (`checkGateArtifact`, with the mandate id from the attempt's
authorization, reservation, generation and adapter); the committed artifact id
is the artifact's commitment; the slot is this gate's and principal's with the
mandate's nonce; chain time is before the attempt's `validUntil` and the
deadline is inside it; the reservation is active; the attempt has no issuance
record; the durable lifecycle rows are served and live. Then it signs, and
checks the signature recovers to the principal.

**What it still trusts**, as in 7E.2: the ledger writer (a committed batch is
attributable, not impossible), its clock (chain time from the signer's read;
the gate enforces time independently), and the host — 7E.3 custody runs in
the signer's process (reference separation, like 7E.1), not in a separate
process with a read-only handle like the Lighter custody of 7E.2.

## 8. Cross-domain authority

`test/cross-domain.test.ts` runs Lighter PerpPolicy v1 and GateSpotPolicy v1
in **one** control engine, reserving into **one** principal-wide ledger under
one principal policy.

**The shared quantity is committed notional: kind `NOTIONAL`, unit `USDC`, 6
decimals** — quantity × the price the action commits to, before fees. Both
modules already demand it (PerpPolicy at the signed limit price, in Lighter's
USDC; GateSpotPolicy at the gate's fixture price, in the market's settlement
unit). One `CAPACITY` dimension of that kind and unit with an empty scope
(`global-committed-notional`, 10,000 USDC) is charged by both.

| Step | Result |
| --- | --- |
| Robinhood gate BUY, 6,000 USDC notional | AUTHORIZED, reserved |
| Lighter BUY 0.05 BTC at 100,000 = 5,000 USDC notional | **REFUSED** `AUTHORITY_UNAVAILABLE/LEDGER_LIMIT_EXCEEDED` (11,000 > 10,000) |
| Lighter BUY 0.04 BTC = 4,000 USDC | AUTHORIZED — exactly 10,000 |
| the same from the other side (Lighter first) | the Robinhood 6,000 is refused, 5,000 fits |
| control: no shared dimension | both fit — it is the shared dimension that refuses |

What is **not** added: perp margin (`MARGIN`) and spot capital (`CAPITAL`)
stay separate dimensions; no kind is converted into another; notional is not
called exposure. **Engineered:** the gate market in this scenario is declared
to settle `USDC`. The live testnet market settles `MDUSD`, a fixture unit, and
so deliberately does not share a USDC dimension; a live shared limit needs a
funding token that genuinely settles the same unit (USDG is the candidate,
deferred to 7E.4 — [robinhood-deployment.md §5](robinhood-deployment.md#5-usdg)).

## 9. Tests

| Suite | Tests | What |
| --- | ---: | --- |
| `evm-robinhood/test/policy.test.ts` | 16 | exact demands and rounding; the 500-unit scenario (300 fits, 250 refused `LEDGER_LIMIT_EXCEEDED`, exactly 200 fits); an executed reservation still counts; capital required; action validation; adapter coverage; state pinned (price, fee, adapter, funding token, age, absence); module and adapter identity |
| `…/enforcement.test.ts` | 25 | through the real engine, SQLite ledger and custody, over the Phase 6 reference model: exact execution; `ADMIT_ATTEMPT` before the key; replay (`EXISTING`, 100 concurrent, rebroadcast → `MandateAlreadyConsumed`); amount, recipient, target mutation with original and agent-re-signed signatures; adapter mismatch at signer, Control and custody; expiry (ceiling, deadline, mandate); wrong principal; wrong generation; the agent key alone; pre-execution failures; preflight revert; nothing released after execution; recovery |
| `…/cross-domain.test.ts` | 4 | §8 |
| `…/encoding.test.ts` | 6 | `execute` calldata = the differential corpus encoder's bytes; static-tuple layout; the artifact decodes under the kernel's MCE v2 / Candidate V3 decoders; EIP-1559 signatures recover; RLP edge cases; CREATE addresses |
| `…/structure.test.ts` | 6 | dependencies; pure modules; network only in `chain.ts`, testnet only; no key or environment reads; no generic signing export; nothing below depends on the package |
| `contracts/test/RobinhoodDemo.t.sol` | 11 | the demo market on the real gate through the reviewed deploy script at chain id 46630: exact settlement; replay; amount, recipient, target mutation; expiry by deadline and mandate; wrong principal; another generation; the agent's direct path; the allowance mirroring the capital authority |

Offline tests use the Phase 6 **reference model** as the chain: its decisions
are proven equal to the Solidity gate's by the frozen differential corpus
(301 vectors, byte-equal revert data), and `RobinhoodDemo.t.sol` checks the
same scenarios on the Solidity gate itself. The live run checks them on
testnet.

## 10. Validation

Run on 2026-09-28 at the 7E.3 commits:

| Command | Result |
| --- | --- |
| `npm run check` | **pass** — 1,576 TypeScript tests (all packages), fixtures, replays, cross-surface, credential scan (590 tracked files, the 3 disposable keys checked by value), junk check |
| `npm run generated:check` | **pass** — no drift in any corpus or generated document, frozen 7D `control-v1` included |
| `npm run contracts:test` (`forge test`) | **pass** — 272 tests in 34 suites: unit, 1,024-run fuzz, differential, the 12 invariants at 256 runs × depth 64, and the 11 new demo tests |
| `npm run contracts:fmt`, `contracts:lint` | pass |
| `npm run contracts:slither` | **0 results** — 26 contracts, 101 detectors (was 20: the demo token and the OpenZeppelin ERC-20 it inherits) |
| `npm run robinhood:testnet:deploy -- --dry-run` | pass on an anvil fork of the testnet (verify PASS, runtime matches artifact) |
| `npm run robinhood:testnet:demo -- --dry-run` | pass on an anvil fork (every step of [robinhood-demo.md](robinhood-demo.md)) |
| `npm run robinhood:testnet:deploy` | **pass** on testnet: 5 contracts, `verify` PASS, runtime matches artifact, setup, manifest |
| `npm run robinhood:testnet:demo` | **pass** on testnet: every step of [robinhood-demo.md §2](robinhood-demo.md#2-the-run) |
| `npm run robinhood:testnet:verify` | explorer source verification **unavailable** (solc 0.8.37 not offered by the testnet Blockscout) |
| credential check after deployment | pass: no disposable key in the manifest, receipt or config; `credentials:scan` checks all tracked files for them by value |

## 11. Changes by package

| Package / area | Change |
| --- | --- |
| `packages/evm-robinhood` | **new** |
| `contracts/src/demo/MandateDemoToken.sol` | **new** (additive; no frozen contract changed) |
| `contracts/test/RobinhoodDemo.t.sol` | **new** |
| `scripts/scan-credentials.ts` | forbids `.robinhood-testnet/`; searches tracked files for the disposable keys' values |
| root `package.json` | workspace; `robinhood:testnet:deploy`, `:demo`, `:verify` |
| `.gitignore` | `.robinhood-testnet/` |
| kernel, core, ledger, control, ledger-sqlite, execution-gate, perp-lighter | **unchanged** |
| Phase 6 contracts, script, corpus | **unchanged** |

## 12. Limits and open questions

- **Fixtures, not a market or a Stock Token.** Upgradeable real tokens are
  deployment-prohibited by the frozen token policy; admitting USDG is 7E.4.
- **The principal is an EOA.** Its key can move its tokens outside the gate;
  7E.3's no-bypass property rests on custody holding that key. A smart-account
  principal whose only spender is the gate would make it chain-enforced.
- **Custody is in-process** (reference separation), unlike 7E.2's Lighter
  custody process.
- **No reconciliation.** An executed reservation stays `ACTIVE`; nothing is
  consumed or released; `FINALIZED` is the declared release level but no
  release exists. `observationFromGateEvidence` (Phase 6) is the rule 7F would
  use.
- **Chain time from the public RPC** is trusted as that endpoint's answer for
  pre-execution evidence; the gate enforces time itself.
- **The final deployment-provenance gate** of execution-gate.md §13 is still
  not built; `verify` plus the runtime comparison cover part of it.
- **One lane.** Slot allocation assumes one signer per principal and gate.
- **Open:** Q-8 (stablecoin vs USD budget) remains open; a live cross-domain
  limit needs a shared, genuinely equal unit.

## 13. Explicit answers

| Question | Answer |
| --- | --- |
| Are Mandate contracts deployed on an Arbitrum chain? | **Yes** — gate `0xb03c1e07…aa3e` |
| Which chain? | Robinhood Chain **testnet** (46630), an Arbitrum Nitro chain |
| Did a real valueless testnet action execute through Mandate? | **Yes** — tx `0x7144f09fc4e8a5c4b74b77b4c9d0fc748501e404ab3249151f576ba6e9dff344` |
| Can the same execution authorization be replayed? | **No** — `EXISTING` offchain; `MandateAlreadyConsumed` onchain |
| Can the authorized amount/recipient/target be changed? | **No** — `AgentSignatureInvalid` with the original signatures; `MaxNotionalExceeded` / `FundingLimitExceedsMandate` / `RecipientNotPrincipal` / `UnsupportedRepresentation` / `PrincipalSignatureInvalid` (another gate) if re-signed by a compromised agent key |
| Was a production/mainnet wallet used? | **No** — three disposable keys generated for this phase |
| Were real funds used? | **No** — testnet ETH from the faucet; valueless fixtures |
| Is Lighter funded execution required for this milestone? | **No** |
| Is full reconciliation implemented? | **No** (7F) |
