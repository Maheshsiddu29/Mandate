# Phase 7E.0 — `ADMIT_ATTEMPT` and the issuance lifecycle

> **Status: Phase 7E.0 design. Not implemented.** This specifies the
> issuance boundary frozen as a precondition in 7D.1
> ([implementation-7d.md §22.6](../core-v1/implementation-7d.md#226-never_issued-and-the-frozen-7e-issuance-precondition-r5)),
> instantiated for the Lighter Venue Signer
> ([signer-architecture.md](signer-architecture.md)). It changes nothing in the
> frozen reservation state machine
> ([reservations-reconciliation.md §4](../core-v1/reservations-reconciliation.md#4-reservation-state-machine)):
> `ADMIT_ATTEMPT` is the transition that machine already names; 7E makes it
> real.

## Contents

1. [Four things that are not the same](#1-four-things-that-are-not-the-same)
2. [States](#2-states)
3. [The issuance protocol](#3-the-issuance-protocol)
4. [Failure and crash matrix](#4-failure-and-crash-matrix)
5. [Resolving an unknown attempt](#5-resolving-an-unknown-attempt)
6. [REPLAY-1 for execution](#6-replay-1-for-execution)
7. [Exactly-once versus at-most-once](#7-exactly-once-versus-at-most-once)
8. [Validity windows](#8-validity-windows)
9. [Nonce allocation and ordering](#9-nonce-allocation-and-ordering)
10. [What the ledger must add](#10-what-the-ledger-must-add)

---

## 1. Four things that are not the same

| Thing | Identity | Created by | Cardinality |
| --- | --- | --- | --- |
| **Authorization** | `ExecutionAuthorizationId`, reservation `(actionDigest, generation)` | Control, at `RESERVE` | one per generation |
| **Attempt** | `AttemptId` (§6) | the signer's `ADMIT_ATTEMPT` commit | bounded list per reservation; **at most one live** |
| **Artifact** | `txHash` + venue slot `(chainId, accountIndex, apiKeyIndex, nonce)` | key custody, after `ADMIT_ATTEMPT` | exactly one per attempt |
| **Venue order** | Lighter `order_index`; our `client_order_index` | the sequencer, if the artifact executes | zero or one per create-order artifact |

A timeout, a crash or a missing response is a fact about the **submission**
of an artifact. It is never evidence about the **order**.

## 2. States

```text
reservation ACTIVE (generation g)
   │
   │  pre-execution requirements (signer-architecture §7) — volatile, nothing written
   ▼
READY_TO_ISSUE ─────── any requirement FAIL/UNKNOWN ──▶ no attempt; if none was ever admitted
   │                                                     under g, the reservation may close
   │  ledger CAS commit: ADMIT_ATTEMPT                   NEVER_ISSUED (7D rule, unchanged)
   │  {attemptId, txHash, slot, validUntil, bindingDigest, preExecution digest}
   ▼
ADMITTED ────────────────────────────────────────────────────────────────┐
   │  key custody signs exactly txHash; journal persists signed bytes       │ crash / sign failure:
   ▼                                                                       │ no bytes may exist, but
ARTIFACT_ISSUED                                                            │ the ledger cannot know
   │  submitter: sendTx(stored bytes)                                      │
   ├──────────────▶ SUBMITTED            code = 200 (L-TX-8)               │
   ├──────────────▶ SUBMISSION_REJECTED  API error, code ≠ 200             │
   └──────────────▶ SUBMISSION_UNKNOWN   timeout, connection loss, crash ◀─┘
                          │
                          ▼
            resolved only by venue evidence (reconciliation-evidence §4):
            EXECUTED · PARTIALLY_EXECUTED → CANCELLED/EXPIRED · FAILED (zero fills)
            — or QUARANTINED at the attempt ceiling, holding everything
```

- `READY_TO_ISSUE` is computed, not stored. Nothing about it survives a
  crash, and nothing needs to: no artifact can exist yet.
- `ADMITTED`, `ARTIFACT_ISSUED` and the submission states are **issuance
  states**. Only `ADMITTED` is a ledger fact; the rest live in the signer's
  journal. None of them moves authority.
- `SUBMISSION_REJECTED` is not `FAILED`. A rejected submission means the API
  did not queue *that request*; the signed artifact still exists and is valid
  until its `ExpiredAt`, and the nonce slot is still open (L-TX-6). It is
  resolved like `SUBMISSION_UNKNOWN`.

**The rule 7D.1 froze, restated for Lighter:** once `ADMIT_ATTEMPT` exists
for generation g, `NEVER_ISSUED` cannot close g — not because the signer
crashed, not because signing failed, not because `sendTx` timed out or
returned an error, not because the attempt ceiling passed. The reservation
stays `ACTIVE`, then `QUARANTINED`, holding its full worst case, until
venue evidence establishes that the artifact did not and cannot execute
(§5), or what it did execute.

## 3. The issuance protocol

For reservation `R` at generation `g`, attempt ordinal `k`:

1. **Re-read.** The signer reads `R` from the ledger at the current version.
   It must be `ACTIVE` at `g`, with no live attempt (§6), under a module and
   adapter that are `ACTIVE` or `RETIRING` — never `DISABLED`.
2. **Pre-execution requirements.** `STATE_REVALIDATION`,
   `CREDENTIAL_SCOPE`, `NONCE_SLOT`, `MODULE_TRUST`
   ([signer-architecture.md §7](signer-architecture.md#7-pre-execution-requirements)).
   Any `FAIL` or `UNKNOWN`: stop; nothing is written.
3. **Allocate the slot.** Next nonce `N` for the signer key from the
   signer's allocator, which step 2 just checked against the venue.
4. **Build the unsigned transaction** from the `ExecutionBinding` and the
   admitted metadata: every field in
   [signer-architecture.md §5](signer-architecture.md#5-the-enforcement-artifact),
   `ExpiredAt` and `OrderExpiry` per §8, `ClientOrderIndex` derived from
   `AttemptId`.
5. **Hash it.** `txHash = LighterHash(tx)` — the venue's own message hash,
   computable before any signature (L-TX-3).
6. **Commit `ADMIT_ATTEMPT`** by ledger CAS:
   `{reservationId, generation, attemptId, bindingDigest, txHash, slot, validUntil, preExecutionDigest}`.
   The ledger refuses if `R` is no longer `ACTIVE` at `g`, if another attempt
   is live, if the slot or `txHash` was ever bound before, or if the attempt
   bound is reached. The commit is durable before step 7
   ([signer-architecture.md §11](signer-architecture.md#11-durability-is-now-a-real-requirement)).
7. **Sign.** Key custody re-reads the committed attempt and signs **only**
   if the hash it is asked to sign equals the committed `txHash`.
8. **Journal.** The signed bytes are persisted against `attemptId`.
   → `ARTIFACT_ISSUED`.
9. **Submit** the stored bytes. → `SUBMITTED` / `SUBMISSION_REJECTED` /
   `SUBMISSION_UNKNOWN`.

The artifact cannot escape the trusted boundary before step 6 because it does
not exist before step 7. Committing the hash rather than "an attempt" means
the ledger knows **which** artifact it authorized: a signature over any other
hash is not one of its artifacts, and a venue record for another hash in the
same slot proves this one dead (§5).

## 4. Failure and crash matrix

| Failure point | Ledger | Can an executable artifact exist? | Resolution |
| --- | --- | --- | --- |
| before step 6 (any crash, any requirement failure) | no attempt | **no** | nothing to resolve; the reservation may later close `NEVER_ISSUED` if no attempt was ever admitted and revalidation fails |
| step 6 CAS conflict or refusal | no attempt | no | re-run from step 1 |
| after 6, before 7 (crash, custody unavailable) | `ADMITTED` | no — but the ledger cannot tell | §5: resolve by slot supersession |
| during 7 or after 7 before 8 (bytes signed but not journaled) | `ADMITTED` | **yes, in memory** — lost with the process unless submitted | §5 |
| after 8, before 9 | `ADMITTED`; journal `ARTIFACT_ISSUED` | yes, stored | resubmit the stored bytes (idempotent, §7) until `ExpiredAt`, or resolve by §5 |
| `sendTx` timeout / connection loss / crash mid-request | `ADMITTED` | yes, possibly queued | `SUBMISSION_UNKNOWN`: look up `txHash` (L-OBS-5); resubmit the same bytes; else §5 |
| `sendTx` returns an API error (`code ≠ 200`) | `ADMITTED` | yes, not queued by that request | `SUBMISSION_REJECTED`: never re-sign the slot with different content; resubmit the same bytes if the error was transient, else §5 |
| `code = 200`, sequencer rejects (margin, price band, reduce-only …) | `ADMITTED` | consumed its slot, created nothing executable | tx record executed with `AppError`, or order `canceled-*` with zero fills → `FAILED`, zero consumption, at the release finality level |
| `code = 200`, order rests and fills | `ADMITTED` | the order | normal reconciliation (7F) |
| attempt ceiling passes with none of the above established | `QUARANTINED` | unknown | nothing released; late evidence closes it (TIME-1) |

## 5. Resolving an unknown attempt

An attempt in `ADMITTED` or any submission state with no venue record for its
`txHash` is resolved **only** by proving its slot can no longer execute it:

1. Wait until the artifact's `ExpiredAt` has passed by more than a declared
   clock-skew margin, measured against a venue-reported time (a tx or height
   timestamp), not the signer's clock.
2. Check whether `txHash` executed (`tx` lookup). If it did, it is resolved
   by its own evidence.
3. Otherwise sign a **nonce-advance** transaction in the **same slot** `N`
   (a new attempt of the signer's own, itself `ADMIT_ATTEMPT`-ed so it too is
   accounted for) and submit it.
4. When the nonce-advance executes at slot `N` at the release finality level,
   the original `txHash` provably never executed and never can: a slot
   executes at most one transaction (L-TX-4). The original attempt closes
   `FAILED`, basis `NONCE_SUPERSEDED`, with zero fills.
5. If instead the original executes first (it was queued after all), the
   nonce-advance is refused by the venue and the original is observed
   normally. Either way the slot resolves exactly one way.

Why not "the nonce moved past N, so N is dead" alone: without `SkipNonce`,
the next nonce is `N` until *something* executes at `N`. What proves the
original dead is a **different known transaction** executing **at `N`**.

**Dependency.** This rule rests on L-TX-4, L-TX-6 and the documented edge case
that an unexecuted-by-`ExpiredAt` transaction does not consume its nonce. It
must be confirmed by recorded testnet evidence (E-4) before any attempt is
issued on mainnet, and the harmless transaction type used for nonce advance
must be chosen from that evidence (a cancel of a known-inactive Mandate order,
or an abort of a scheduled cancel-all, are candidates; neither is assumed).
Until then the adapter has **no** non-execution rule for unknown submissions,
and such attempts stay quarantined — liveness lost, safety kept
([reservations-reconciliation.md §10](../core-v1/reservations-reconciliation.md#10-attempt-ceilings-timeouts-and-quarantine)).

## 6. REPLAY-1 for execution

7D.1 assigned REPLAY-1's execution-authorization and artifact half to 7E
([implementation-7d.md §22.7](../core-v1/implementation-7d.md#227-roadmap-ownership-corrected-not-implemented-early)).
For the Lighter signer it is:

**REPLAY-1 (execution).** One `ExecutionAuthorization` cannot be used to
obtain more than one independently executable artifact at a time, no two
attempts ever share a venue slot or transaction hash, and a spent intent
never yields another artifact.

Identity:

```text
AttemptId = H("mandate-core/v1/attempt",
              reservationId, generation, actionDigest,
              ModuleRef, AdapterRef, ExecutionAuthorizationId, attemptOrdinal)

VenueArtifactId = (lighterChainId, accountIndex, apiKeyIndex, nonce, txHash)
```

Rules, each enforced by the ledger at `ADMIT_ATTEMPT` unless noted:

| # | Rule | Refusal |
| --- | --- | --- |
| R1 | the reservation is `ACTIVE` at exactly the authorization's generation, module and adapter | `RESERVATION_NOT_ACTIVE` |
| R2 | **at most one live attempt per reservation.** A new ordinal is admitted only after the previous attempt is resolved `FAILED` with zero fills at the release finality level | `ATTEMPT_UNRESOLVED` |
| R3 | a slot `(chain, account, key, nonce)` is bound to at most one `AttemptId`, ever | `VENUE_SLOT_REUSED` |
| R4 | a `txHash` is bound to at most one `AttemptId`, ever | `ARTIFACT_REUSED` |
| R5 | the attempt count per reservation is bounded (Core's bounded attempt list) | `ATTEMPT_LIMIT` |
| R6 | a request to issue again for an authorization whose live attempt is `ARTIFACT_ISSUED` and within `ExpiredAt` returns **that same attempt** — the signer resubmits the stored bytes; nothing new is signed (signer rule) | — |
| R7 | a request after the live attempt's `ExpiredAt` without resolution is refused until §5 resolves it | `ATTEMPT_UNRESOLVED` |
| R8 | an intent that is `SPENT`, or a reservation `CLOSED`, admits nothing | `RESERVATION_NOT_ACTIVE` |
| R9 | key custody never signs a slot twice with different content (signer rule; §5's nonce-advance is a different attempt with its own `ADMIT_ATTEMPT`) | — |

R2 is Core's EXEC-4 option "one live attempt at a time with the previous
attempt's non-execution proven before the next is issued"
([enforcement-adapters.md §5](../core-v1/enforcement-adapters.md#5-binding-rules)).
Lighter's `client_order_index` is *not* used for deduplication: its
uniqueness scope is undocumented (L-ORD-9, E-6).

## 7. Exactly-once versus at-most-once

| Layer | Guarantee | Mechanism |
| --- | --- | --- |
| Authorization consumption | **exactly once** per generation | ledger CAS: `RESERVE` once, `CLOSE` once |
| Attempt admission | exactly once per `AttemptId`; at most one live per reservation | ledger CAS + R1–R5 |
| Artifact per attempt | exactly one `txHash` per attempt | R3, R4, R9 |
| Submission of an artifact | **at least once, safely** — retries resend identical bytes | the venue executes a slot at most once (L-TX-4); a duplicate is refused by nonce |
| Execution of an artifact | **at most once** — possibly never | nonce slot; `ExpiredAt` |
| Execution of the intent | **not exactly-once, and Mandate does not claim it** | an order may never execute, may partially fill, or be cancelled; a new generation is a new artifact only after the old one is proven dead |

What Mandate therefore models rather than hand-waves:

- **Duplicate submission of the same artifact** is safe by the venue's nonce
  rule; the signer retries freely.
- **Duplicate artifacts** (two different signed transactions for one
  intent) are prevented by R2–R4 and R9, not by the venue. A signer bug that
  broke R9 would leave two transactions competing for one slot; at most one
  could execute, but which one is not ours to choose. R3/R4 make the ledger
  refuse to record the second.
- **Another signer of the same key** (a key that leaked, or a front-end key
  registered by mistake) would consume nonces Mandate did not allocate.
  `NONCE_SLOT` and `CREDENTIAL_SCOPE` detect it before the next issue; any
  resulting fills or orders are drift.

## 8. Validity windows

All Lighter times are milliseconds; Core times are seconds. Conversions
round **against** the actor: a Lighter deadline is at most
`1000 × coreDeadline`.

| Window | Rule | Source |
| --- | --- | --- |
| `ExpiredAt` (tx deadline) | `≤ min(attemptCeiling, every BOUNDED_BY_FRESHNESS expiry)` and set explicitly — never the SDK default | L-TX-7; EXEC-3, EXEC-6 |
| `OrderExpiry` (GTT, post-only) | `≤ attemptCeiling`; the order dies at `OrderExpiry` (`canceled-expired`) | L-ORD-4, L-ORD-5; EXEC-3 |
| attempt ceiling for resting orders | `≥ issue time + 5 min`, because Lighter refuses an order expiry under 5 minutes (L-ORD-4). An authorization whose lifetime is shorter cannot issue a GTT order — the module's lifetime cap refuses it at decision time (`AUTHORIZATION_EXPIRED / LIFETIME_EMPTY`), not at the signer | L-ORD-4 |
| IOC and market orders | no `OrderExpiry`; they never rest (L-ORD-3). Only `ExpiredAt` bounds them | L-ORD-3 |

A GTT order thus lives no longer than the attempt ceiling, so the frozen
rule "every artifact expires by the attempt ceiling" holds for the order it
creates as well as for the transaction.

## 9. Nonce allocation and ordering

- **One signer key, one serialized lane in v1.** The signer admits a new
  attempt on the key only when the previous transaction on it has been
  observed `SEQUENCED` or resolved by §5. Nonces are consecutive; `SkipNonce`
  is used only where §5 requires it after E-4. This is slow by HFT standards
  and adequate for v1: Standard accounts allow 40 transactions of the default
  type per minute and 60 REST requests per minute in total (L-RL-1, L-RL-3).
- **Ordering between dependent transactions.** A `setMarketMargin`
  followed by an order must not rely on nonce order alone: a transaction the
  sequencer rejects still consumes its nonce (L-TX-6), so the order would
  execute under the old setting. The order's attempt is admitted only after
  the margin transaction's success is observed and re-admitted as state.
- **More throughput later** means more lanes — additional signer keys on the
  same sub-account, each with its own nonce sequence (L-TX-4; S1 suggests
  this) — and `CREDENTIAL_SCOPE` would then check the exact set of signer
  keys. Not in v1.

## 10. What the ledger must add

The frozen reservation machine already names `ADMIT_ATTEMPT`; the frozen
ledger does not implement it (`packages/ledger` has no attempt event and
`ReservationStatus` is `'ACTIVE' | 'CLOSED'`). 7E.1 must add, as an
extension approved by the owner:

1. an `ADMIT_ATTEMPT` event carrying the fields in §3 step 6, reduced by CAS;
2. per-reservation attempt records and the global slot and hash uniqueness
   of R3/R4;
3. the `closeNeverIssued` precondition "**no** `ADMIT_ATTEMPT` under this
   generation", which 7D.1 froze as 7E's to add
   ([implementation-7d.md §13](../core-v1/implementation-7d.md#13-revalidation-and-never_issued));
4. durable storage for all of it
   ([signer-architecture.md §11](signer-architecture.md#11-durability-is-now-a-real-requirement)).

`QUARANTINE` and the application of observations remain 7F's.
