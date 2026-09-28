# Phase 7E.1 — PerpPolicy v1, durable Venue Signer, attempt boundary

> **Status: implemented locally, awaiting review.** Lighter testnet only; no
> mainnet, no real funds, no production credentials. Full fill/cancel
> reconciliation is **not** implemented (Phase 7F). Phases 7A–7D stay frozen;
> the additive extensions to frozen packages that 7E.0 listed (F-1 … F-4) were
> approved for this phase and are itemized in §12.

## Contents

1. [What was built](#1-what-was-built)
2. [Durable store (F-3)](#2-durable-store-f-3)
3. [`ADMIT_ATTEMPT` (F-1)](#3-admit_attempt-f-1)
4. [Attempt lifecycle](#4-attempt-lifecycle)
5. [Module and adapter lifecycle (F-2)](#5-module-and-adapter-lifecycle-f-2)
6. [Pre-execution requirements (F-4)](#6-pre-execution-requirements-f-4)
7. [PerpPolicy v1](#7-perppolicy-v1)
8. [The Venue Signer](#8-the-venue-signer)
9. [Replay, unknown submissions and crashes](#9-replay-unknown-submissions-and-crashes)
10. [Tests, mutants, benchmarks](#10-tests-mutants-benchmarks)
11. [Security properties](#11-security-properties)
12. [Changes to frozen packages](#12-changes-to-frozen-packages)
13. [Risks and open questions](#13-risks-and-open-questions)
14. [Explicit answers](#14-explicit-answers)

---

## 1. What was built

| Package / path | What | I/O |
| --- | --- | --- |
| `packages/ledger` (extended) | `ADMIT_ATTEMPT` event, attempt state, `DISABLED` module status, adapter registry | none |
| `packages/ledger-sqlite` (new) | **REFERENCE / SINGLE-NODE TESTNET STORE**: the ledger store contract on SQLite, plus the issuance journal in the same database | `node:sqlite` only |
| `packages/control` (extended) | `admitAttempt`, pre-execution requirements, `NEVER_ISSUED` precondition, `DISABLED` handling | none |
| `packages/perp-lighter` (new) | PerpPolicy v1, market claims, adapter descriptor, transaction construction, pre-execution rules, the Venue Signer, normalization, custody and venue clients | network in `venue.ts` (testnet only); process spawn in `custody.ts` |
| `packages/perp-lighter/custody` (new, Go) | the key-custody process over the official lighter-go SDK v1.0.10 (`9d38261d…`), pinned in `go.sum` | reads its key file; appends its slot journal |

Dependency directions: `ledger-sqlite → ledger → core`; `perp-lighter →
control, ledger-sqlite, ledger, core, kernel`. Core, the ledger, control and
the store name no venue (structural tests).

Identities of this build:

| Object | Value |
| --- | --- |
| PerpPolicy `ModuleRef` | `lighter-perp / perp / 1 / 0x61ee4bd289c87ab31b5ef0beb08079392691f638413e23d2572c73c736594273` |
| implementation digest | `0xb853ae059df67fcab197a97e6f2828f194063ee922e8e5e76caf2e30c8c76206` |
| Lighter adapter `AdapterRef` | `lighter-venue-signer / 1 / 0xb6cd4cd3754457f0f8fda49fd7823bfd9710310d60164f8daa8ce35ed1185ec4` |
| testnet claims (static-metadata digests) | BTC 4096 `0x58a5…3697`, ETH 4095 `0xaa2a…552a`, SOL 4097 `0xc320…2e65` |

The implementation digest is a label over the module digest, not a
reproducible-build digest (open question 16 of Core v1, unchanged).

## 2. Durable store (F-3)

`SqliteLedgerStore` implements the unchanged `LedgerStore` contract:

- **Schema.** `ledger_heads(principal, version, head)`,
  `ledger_batches(principal, version, previous_head, head, encoded)`,
  `store_meta(schema)`. WAL, `synchronous = FULL`, `busy_timeout`.
- **Commit.** One `BEGIN IMMEDIATE` transaction: fold any batches committed
  since the cache last looked (another process's included), compare version
  and head, apply the pure reducer to the whole batch, insert the batch and
  advance the head, `COMMIT`. Any other outcome is `ROLLBACK`.
- **The log is authoritative.** Each process re-derives state from the stored
  canonical encodings, checking every batch extends the previous head, carries
  the next version and re-encodes byte for byte; otherwise
  `LedgerStoreCorruption` — it never serves a history it cannot re-derive.
- **One consistency boundary.** `ADMIT_ATTEMPT` is a ledger event in this
  store. The issuance journal is a table in the same database whose rows can
  only be created for an attempt the committed ledger holds (checked inside its
  own write transaction without yielding). There is no independent attempt
  database.

Labelled everywhere as a reference, single-node testnet store. No Postgres.

## 3. `ADMIT_ATTEMPT` (F-1)

Ledger event wire code 12; nothing earlier changes encoding.

```text
AttemptAdmission {
  attempt        H("mandate-core/v1/attempt", reservation, generation, action, ModuleRef, AdapterRef, authorization, ordinal)
  ordinal        1 for the first attempt of a reservation
  reservation, generation, action
  authorization  Core's ExecutionAuthorizationId
  module         ModuleRef            = the reservation's
  adapter        AdapterRef
  venueAccount   ResourceId (ACCOUNT)
  artifact       { kind: "lighter.l2-tx-hash", id: the venue's 40-byte transaction hash }
  slot           { scope: "lighter:300:account:<i>:key:<k>", sequence: nonce }
  validUntil     the artifact's own end (ExpiredAt, or a GTT order's expiry)
  requirements   digest of the ordered pre-execution results
  revalidation   the RevalidationId it was admitted on
}
```

Principal, ledger version and head are those of the batch it commits in. The
reducer re-derives the attempt id and refuses: an unknown, closed or
mismatched reservation (generation, action, module), a live attempt for the
reservation (`ATTEMPT_UNRESOLVED` — in 7E every admitted attempt stays live),
an artifact or slot bound by any earlier attempt (`ARTIFACT_REUSED`,
`VENUE_SLOT_REUSED`), an already-expired artifact, a revoked or expired
lineage, and malformed identifiers. Balances are untouched. The state encoding
gains an attempts section only when an attempt exists, so every earlier state,
head and corpus is byte-identical.

## 4. Attempt lifecycle

```text
RESERVED (reservation ACTIVE)
  │ resolve · evidence · construct · hash      — nothing written; a failure here leaves NEVER_ISSUED available
  ▼
READY_TO_ISSUE                                 (computed, not stored)
  │ Control.admitAttempt → ADMIT_ATTEMPT       — durable ledger commit
  ▼
ADMIT_ATTEMPT ──── custody signs the committed hash ──▶ ARTIFACT_ISSUED (journal, bytes kept in the signer)
                                                            │ SUBMISSION_SENT
                                                            ├──▶ SUBMISSION_ACKNOWLEDGED   API accepted syntax only
                                                            ├──▶ SUBMISSION_REJECTED
                                                            └──▶ OUTCOME_UNKNOWN          timeout, lost reply, crash, hash mismatch
```

Journal transitions are closed and monotone; `OUTCOME_UNKNOWN`,
`SUBMISSION_REJECTED` and `SUBMISSION_ACKNOWLEDGED` are terminal in 7E. HTTP
200 is `SUBMISSION_ACKNOWLEDGED`, never an economic outcome. There is no
transition back to sending — not even with the same bytes — and no
reconciliation (7F).

After `ADMIT_ATTEMPT`, `closeNeverIssued` refuses `NEVER_ISSUED_FORBIDDEN`,
whatever revalidation says and however much time has passed.

## 5. Module and adapter lifecycle (F-2)

| Status | New decision | New binding | Revalidation | Issuance attempt | Existing terms bound to it | Replay |
| --- | --- | --- | --- | --- | --- | --- |
| `ACTIVE` | yes | yes | yes | yes | evaluated | yes |
| `RETIRING` (7D, unchanged) | refused | refused | yes | **yes** for existing reservations | evaluated | yes |
| `DISABLED` (new) | refused | refused | refused | refused | **`UNKNOWN`** — refuses increases | yes, by exact digest |

Adapters get the same three statuses in a `ReferenceAdapterRegistry`, exact by
`adapterDigest`: `RETIRING` authorizes nothing new but may issue under an
existing authorization; `DISABLED` issues nothing. With an adapter registry
configured, the engine refuses a new authorization through an unusable adapter
*after* the decision, so every 7D refusal keeps its precedence and the 7D
corpus is unchanged. Status changes are seeded by infrastructure; no
governance is built.

## 6. Pre-execution requirements (F-4)

| Kind | Evaluated by | 7E.1 |
| --- | --- | --- |
| `STATE_REVALIDATION`, `MODULE_TRUST`, `ADAPTER_TRUST` | Control, always; never accepted from a caller | enforced |
| `CREDENTIAL_SCOPE` | adapter: exactly one registered key, the signer's, with custody's public key | enforced |
| `NONCE_SLOT` | adapter: one serialized lane per key (`LANE_BUSY`, `NONCE_AHEAD_OF_LEDGER`) | enforced |
| `RUNTIME_PROVENANCE`, `RUNTIME_CERTIFICATION`, `HARNESS_ATTESTATION` | reserved; no evaluator | requiring one refuses every issuance; supplying a verdict for one is refused |

Every required requirement needs exactly one `PASS`; `FAIL` and `UNKNOWN`
refuse; an unrequired result is refused. The ordered results are digested into
the attempt. Adding runtime provenance later is an evaluator, not a new signer
API.

## 7. PerpPolicy v1

**Actions.** `perp.create-order` (market IOC with a signed worst price; limit
IOC, GTT or post-only) and `perp.cancel-order` (the live order of a pending
Mandate reservation). Reduce-only is carried and venue-enforced.

**Quantities.**

| Quantity | Kind | Unit, decimals | Where |
| --- | --- | --- | --- |
| position size | `POSITION_SIZE` | `UNIT`, market size decimals; canonical underlying | ledger demand + facts |
| committed notional | `NOTIONAL` | `USDC`, 6, `LIMIT` at the signed price | ledger demand |
| margin commitment | `MARGIN` | `USDC`, 6; the venue's collateral; the account | ledger demand |
| marked gross exposure | `GROSS_EXPOSURE` | `USD`, 2, at an admitted canonical-asset price | facts, invariant, Core aggregate |
| marked net exposure | — | not produced in v1 | — |

**Margin and leverage.** Margin = `ceil(notional × IMF / 10,000) +
ceil(notional × feeHeadroom / 1,000,000)`; leverage = `10,000 / IMF`, rounded
up against the actor. IMF is the market's admitted setting on the account, in
Lighter's 1/10,000 ticks (testnet default 500 = 5 %). The fee term exists
because isolated positions may pay fees from cross (L-MAR-6) and because the
venue's published fee is not the charged rate (T-7); headroom is 0.1 %.

**Isolated only — a module rule.** A create-order is refused on a cross
market, beside any cross position or cross open order, and where the market's
setting is unknown. Not grantable, not optional.

**Worst case.** Every create-order reserves its full worst case — reduce-only
included. A cancel reserves a count and releases nothing. Pending reservations
are projected in full (PROJ-1). An open order that no pending reservation
accounts for (matched by the client order index derived from each reservation)
makes every invariant `UNKNOWN`.

**State requirements.**

| Kind | Subject | Freshness | Trust / finality | At issue | At execution |
| --- | --- | --- | --- | --- | --- |
| `perp.market` | market | `VERSION` pinned to the claim's static metadata, ≤ 1 day | VERIFIED, `lighter.state/SEQUENCED` | `WITHIN_POLICY` | `ENFORCED_BY_ARTIFACT(market)` |
| `perp.asset-price` | canonical asset | `AGE` 30 s default | VERIFIED, `perp.price/PUBLISHED` | `RECHECK` | `NOT_REQUIRED` (a GTT lives ≥ 5 min) |
| `perp.account` | account | `AGE` 15 s default (no venue sequence exists) | VERIFIED, `lighter.state/SEQUENCED` | `RECHECK` | `NOT_REQUIRED` |

Defaults are the module's; grants and the principal policy may tighten them.
`SEQUENCED` is the only state finality testnet offers (T-5).

**Invariants.**

| Invariant | Mechanism | Prevents | noWeaker | Refusal |
| --- | --- | --- | --- | --- |
| allowed markets | Core coverage (`MARKETS`) | trading an unapproved instrument | Core set subset | `ACTION_NOT_COVERED` |
| max position size | ledger `POSITION_SIZE` dimension | size accumulating across agents | Core limit | `AUTHORITY_UNAVAILABLE` |
| max order notional | bound `perp.order-notional` | one oversized order | Core bound | `ACTION_NOT_COVERED` |
| max committed notional | ledger `NOTIONAL` dimension | pending + filled dollars over budget (cancel/replace race) | Core limit | `AUTHORITY_UNAVAILABLE` |
| max margin commitment | ledger `MARGIN` dimension | agents sharing a funded sub-account over their share | Core limit | `AUTHORITY_UNAVAILABLE` |
| max marked exposure | `perp.max-marked-exposure`; `core.aggregate-max` across domains | held + pending + proposed over a USD budget | child ≤ parent | `MARKED_EXPOSURE_EXCEEDED` / `AGGREGATE_LIMIT_EXCEEDED` |
| max leverage | `perp.max-leverage` over the admitted IMF | running at the venue's maximum | child ≤ parent | `LEVERAGE_EXCEEDED` |
| allowed direction | `perp.allowed-direction` | a hedger flipping long | `BOTH` weakest; else equal | `DIRECTION_NOT_ALLOWED` |
| isolated only | module rule | cross-margin coupling | — | `CROSS_MARGIN_UNSUPPORTED` / `_IN_USE` |

**Market identity.** A Lighter market is exposure to the canonical asset its
reviewed `LighterMarketClaim` names — never to its symbol (a claim saying
`BTC` with an ETH underlying is ETH exposure; tested). v1 accepts only claims
with multiplier 1 and size + price decimals = 6; the testnet claims equal the
captured metadata field by field (tested against the pinned fixture).

**Cross-domain facts.** Position size and gross exposure per canonical asset,
valued at an admitted canonical-asset price shared with other modules (7D.1
valuation context). The perp-policy-v1.md §10 scenario runs as a test: an
unresolved Lighter buy — and an authorized cancel of it — still block a 4,000
USD spot buy under a 5,000 USD principal-global limit (the aggregate observes
8,000.00), while exactly the remaining 1,000 fits.

## 8. The Venue Signer

**Surface.** `issueAuthorizedPerpOrder(authorization, request)`,
`issueAuthorizedCancel(authorization, request)`, `recover()`. The caller gets
`{ attempt, txHash, issuance, detail }` — never the signed transaction.

**Order of operations.** resolve (module, adapter, principal, operation,
account; payload digest equals the action's; GTT expiry within the ceiling
and ≥ the venue minimum) → evidence (`CREDENTIAL_SCOPE`, `NONCE_SLOT`) →
construct (allowlist; every field re-derived and compared) → hash (custody,
keyless) → `admitAttempt` → sign (custody, committed hash only) → journal →
submit. The signer's own clock sets the issue time.

**Transaction allowlist.** `CREATE_ORDER` (limit or market; no trigger, no
integrator; self-trade = expire taker, signed explicitly), `CANCEL_ORDER`.
Refused at the signer *and* in custody: withdraw, transfer (any), public-pool
and staking operations, sub-account and pool creation, API-key change,
leverage and margin updates, account configuration, modify, grouped and
triggered orders.

**Custody.** The Go process computes the venue's hash with the SDK's own
Poseidon2 code (no Mandate cryptography), signs with the SDK's Schnorr signer,
refuses any hash other than the committed one, and keeps a fsynced per-slot
journal so a nonce is signed for at most one hash across restarts. See
[security-boundary.md](security-boundary.md) for what it does not protect.

## 9. Replay, unknown submissions and crashes

**REPLAY-1 (execution half).** One generation yields at most one attempt
(ledger: `ATTEMPT_UNRESOLVED`; signer: `EXISTING` before anything is read);
an artifact identity and a venue slot are bound at most once, ever; custody
never signs two hashes for one slot; a `SPENT` or closed reservation admits
nothing. Retrying *submission* of the same bytes would be safe by the venue's
nonce rule, but is not done: E-4 is unevidenced.

**Unknown submission.** `OUTCOME_UNKNOWN`; the reservation stays held; a later
request gets `EXISTING`; no timeout release, no "probably failed", no fresh
attempt, no resubmission.

**Crashes (real SIGKILL, child process on a SQLite file).**

| Killed | After restart |
| --- | --- |
| after `ADMIT_ATTEMPT` and signing, before any record | attempt present; reservation `ACTIVE`, nothing released; `NEVER_ISSUED` refused even with revalidation failing and a day later; a new request gets `EXISTING`, no signature; `recover()` marks it `OUTCOME_UNKNOWN` (idempotent) |
| after submission, before the reply was recorded | the same; `recover()` moves `SUBMISSION_SENT` → `OUTCOME_UNKNOWN` |
| before `ADMIT_ATTEMPT` | no attempt exists; with revalidation failing, `NEVER_ISSUED` closes and releases everything |

Store-level crashes (SIGKILL after insert, before commit, after commit, for a
reservation and for an admission) always reopen to one whole committed
version.

## 10. Tests, mutants, benchmarks

| Suite | Tests |
| --- | --- |
| `ledger/test/attempt.test.ts` | admission rules, uniqueness, codec and replay, byte-identical pre-7E encoding, `DISABLED`, adapter registry |
| `ledger-sqlite/test/*` | store contract parity with the in-memory store, restarts, faults at every commit point, 5 SIGKILL crash cases, stale CAS across two stores, 4 writer processes, tamper detection, journal rules; structure |
| `control/test/attempt.test.ts` | admission, `NEVER_ISSUED` before vs after, `EXISTING`, 100 concurrent admissions (one attempt), slot/artifact reuse, lifetime bounds, pre-execution rules, lifecycle, disabled definitions and replay |
| `perp-lighter/test/policy.test.ts` | quantities, exact margin, isolated only, identity, pinned metadata, pending and cancel, foreign orders, leverage, direction, narrowing, cross-domain scenario, account-index bound |
| `perp-lighter/test/signer.test.ts` | happy path and returned fields, `EXISTING`, 100 concurrent issuances (one ADMIT, one signature), mutated payloads and transactions refused before key use, forbidden types, submission outcomes, cancel, credential and nonce lanes, GTT bounds, `DISABLED`, surface |
| `perp-lighter/test/crash.test.ts` | §9 crash cases |
| `perp-lighter/test/mutation.test.ts` | 11 mutants, all killed (below) |
| `perp-lighter/test/fixtures.test.ts` | pinned testnet fixtures, claims = captured metadata, normalization, probe results |
| `npm run lighter:custody:check` (Go) | 4 of 4 real testnet hashes reproduced; custody refusals incl. slot reuse across restart; one full issuance through the real custody |

**Mutants** (built from production's internal stages; probe that kills each):
sign before `ADMIT_ATTEMPT` (key use not bound); `NEVER_ISSUED` after
admission (authority released after admission); two attempts per generation
(unbound signature); quantity and market mutated after authorization (signed ≠
authorized); withdraw and transfer permitted (allowlist); transaction hash
reused for another reservation (two signatures for one generation); disabled
module and disabled adapter bypassed (signature under disabled); unknown
retried as a fresh order (unbound signature). Production violates no probe.

**Benchmarks** (`npm run lighter:benchmark`, node v22.21.0, darwin/arm64,
n = 200 each; not optimized):

| Stage | p50 | p95 | Ledger size during the stage |
| --- | --- | --- | --- |
| PerpPolicy decide + reserve (SQLite CAS) | 9.1 ms | 15.6 ms | 0 → 200 unresolved reservations |
| issue-time revalidation (fresh state) | 7.6 ms | 13.3 ms | same |
| `ADMIT_ATTEMPT` incl. revalidation, SQLite commit | 35.6 ms | 43.5 ms | 400 → 600 unresolved |
| signing, Go custody process | 4.9 ms | 5.6 ms | — |
| full local issue path (Go custody, fake venue) | 28.3 ms | 34.3 ms | 200 → 400 unresolved |

Every stage re-projects every unresolved reservation of the module, and with
no reconciliation none ever resolves in 7E — so cost grows with history, which
is why admission measured later costs more than the whole path measured
earlier. 7F's reconciliation bounds the pending set.

## 11. Security properties

| Property | 7E.1 status |
| --- | --- |
| CRED-1 (deployment model) | established for the deployment in security-boundary.md §2; checked per issue by `CREDENTIAL_SCOPE`. A stolen broad key is outside it |
| EXEC-1 exact binding | established: the venue hash covers every field; the signer re-derives every field; custody signs only the committed hash |
| EXEC-2 agent cannot alter parameters | established: the agent signs nothing Lighter accepts; the payload digest is checked |
| EXEC-3 artifact expiry by the ceiling | established: `ExpiredAt` and GTT expiry ≤ the authorization's end |
| EXEC-4 attempts within the worst case | established by one live attempt per generation |
| EXEC-5 issuance conditional on the ledger | established: `ADMIT_ATTEMPT` before key use (mutant killed) |
| REPLAY-1, execution half | established (§9) |
| TIME-1 attempt-lifecycle foundations | established: no time-based release; after admission only evidence can close |
| DOM-2 module and adapter identity | established: exact `ModuleRef` and `AdapterRef` bound into authorization and attempt; `DISABLED` added |
| STATE-5 issue-time revalidation | established: revalidation inside `admitAttempt`; a failure before admission lets `NEVER_ISSUED` close; the authorization is never edited |
| RECON-1 … 5, cancel release, fill reconciliation | **not established** — 7F |
| AUTH-GLOBAL-2 | **not established** (unchanged) |

## 12. Changes to frozen packages

All additive; no frozen semantics changed; no Core type changed; every 7D
corpus and head is byte-identical (`npm run generated:check`).

| Package | Change |
| --- | --- |
| `ledger` | `attempt.ts`; event wire code 12; state maps `attempts`, `attemptArtifacts`, `attemptSlots`, `reservationAttempts` (encoded only when non-empty); `ModuleStatus` gains `DISABLED`; `ReferenceAdapterRegistry`, `checkAdapterUsable`, `checkModuleIssuable`; refusal codes for attempts, adapters and `MODULE_DISABLED`; the structure test allows the kernel's `Identifier` type |
| `control` | `ControlEngine.admitAttempt`; `closeNeverIssued` refuses after any admitted attempt; optional adapter registry (checked after the decision); catalog refuses `DISABLED` for decisions and lifecycle; `definitionDisabled` makes such terms `UNKNOWN`; `preexecution.ts`; control codes `NEVER_ISSUED_FORBIDDEN`, `ADAPTER_NOT_USABLE`, `PRE_EXECUTION_FAILED`, `ATTEMPT_REFUSED`; the structure test's method list gains `admitAttempt` |
| repository | workspaces `ledger-sqlite`, `perp-lighter`; scripts `lighter:custody:build`, `lighter:custody:check`, `lighter:testnet:evidence`, `lighter:benchmark`; credential and junk scans cover Lighter keys and `.lighter-testnet/` |

## 13. Risks and open questions

- **No funded testnet account** (testnet-evidence.md §2): E-3 … E-8 and E-10
  are unevidenced; the implementation fails closed on each.
- **`VERIFIED` never occurs on testnet** (T-5): nothing could be released on
  testnet even once 7F exists; mainnet timing is unknown.
- **Custody does not read the ledger itself** (security-boundary.md §5).
- **Every issuance costs more as unresolved history grows** until 7F.
- **Account-state normalization** (`perp.account`) follows the documented REST
  schema but was not exercised against a live account; the reader that fills
  it is a 7E.1 gap — tests supply typed snapshots.
- Carried: Q-1 (release level), Q-2 (nonce-advance transaction), Q-4 (review
  of releases under a disabled module), Q-5 (maker-only), Q-6 (principal-wide
  key sweep), Q-7 (custody-held settings in Core's vocabulary), Q-8 (USDC vs
  USD), Q-10 (Robinhood Chain deployment).
- New: should custody verify `ADMIT_ATTEMPT` against the store before signing?
  Should `perp.setMarketMargin` be added so isolated mode can be established
  through Mandate rather than as a deployment step?

## 14. Explicit answers

| Question | Answer |
| --- | --- |
| Can the agent obtain the Lighter private key? | **No** |
| Can the agent ask the signer to sign arbitrary bytes? | **No** |
| Can signing occur before `ADMIT_ATTEMPT` commits? | **No** |
| Can `NEVER_ISSUED` release authority after `ADMIT_ATTEMPT`? | **No** |
| Can one reservation generation produce two independent executable orders? | **No** |
| Can a cancel request alone release the original order reservation? | **No** |
| Can an open order be omitted from projected exposure? | **No** |
| Can the signer issue a withdrawal? | **No** through the Mandate signer API |
| Does possession of the raw broad Lighter key remain a residual risk? | **Yes** |
| Is that blast radius bounded by the dedicated sub-account funding model? | **Yes**, subject to Lighter's sub-account semantics, which could not be verified on testnet (E-5) |
| Does v1 support cross margin? | **No** |
| Did this phase use mainnet or real funds? | **No** |
| Are RECON-1 … 5 established? | **No** |
