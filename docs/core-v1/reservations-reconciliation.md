# Mandate Core v1 — Reservations and reconciliation

> **Status: Phase 7A specification, DRAFT pending review. Not implemented.**
> This generalizes the kernel's replay state machine
> ([replay-semantics.md](../replay-semantics.md)) from one single-use,
> atomically settled mandate to arbitrary quantities, partial execution and
> asynchronous venues. It reuses the Phase 6R.1a/6R.1b semantics — attempt
> ceilings, quarantine, evidence-only resolution and reservation generations —
> rather than inventing incompatible ones. §11 maps one onto the other.

## Contents

1. [Terms](#1-terms)
2. [Execution is not atomic](#2-execution-is-not-atomic)
3. [Intent replay identity](#3-intent-replay-identity)
4. [Reservation state machine](#4-reservation-state-machine)
5. [Observations](#5-observations)
6. [Consumption arithmetic](#6-consumption-arithmetic)
7. [Lifecycle, event by event](#7-lifecycle-event-by-event)
8. [Late, conflicting and duplicate observations](#8-late-conflicting-and-duplicate-observations)
9. [Worked timeline: a partial fill and a cancel](#9-worked-timeline-a-partial-fill-and-a-cancel)
10. [Attempt ceilings, timeouts and quarantine](#10-attempt-ceilings-timeouts-and-quarantine)
    - [10a. Issue-time state admission and revalidation](#10a-issue-time-state-admission-and-revalidation)
11. [Correspondence with the Phase 6 replay machine](#11-correspondence-with-the-phase-6-replay-machine)
12. [Risk-reducing exceptions](#12-risk-reducing-exceptions)

---

## 1. Terms

| Term | Meaning |
| --- | --- |
| **Authorization** | Core's PASS decision for one `ActionIntent` at one ledger version, and the `ExecutionAuthorization` it produces |
| **Reservation** | The ledger's hold of the intent's worst-case contributions, at one **generation** |
| **Generation** | A per-intent counter: 0 before the first reservation, +1 on every `RESERVE`, never reset, never wrapped |
| **Attempt** | One enforcement artifact issued under a reservation (a signed transaction, a signed order) |
| **Observation** | A typed, provenance-carrying fact about what an attempt did |
| **Reconciliation** | Applying an observation to a reservation: consume, overrun, release, close |

## 2. Execution is not atomic

The kernel could assume atomic settlement ([design §14.2](../mandate-design.md#142-mvp-settlement-model));
Core cannot. A limit order can rest, fill in pieces, be cancelled with part
filled, or be in an unknown state after a network partition. Every attempt's
status is one of:

| Status | Final? | Meaning | Ledger effect when applied |
| --- | --- | --- | --- |
| `AUTHORIZED` | no | artifact issued; not known to be submitted | none |
| `SUBMITTED` | no | the enforcement point has it (transaction broadcast, order acknowledged) | none |
| `PARTIALLY_EXECUTED` | no | some quantity executed; more may | `CONSUME` the new fills |
| `EXECUTED` | yes | fully executed | `CONSUME` final fills; `CLOSE` releases any price improvement |
| `FAILED` | yes | proven not executed and unable to execute | `CLOSE`, releasing everything not consumed |
| `CANCELLED` | yes, only at the adapter's finality level | cancelled, with its executed quantity final | `CONSUME` final fills; `CLOSE` releases the rest |
| `EXPIRED` | yes, only at the adapter's finality level | the attempt's own expiry passed, with its executed quantity final | as `CANCELLED` |
| `UNKNOWN` | **never** | cannot be established | none — and never a release |

"Final" is a property of **evidence**, not of a status name. A cancel the venue
has acknowledged but not confirmed as terminal is not `CANCELLED`; it is still
`SUBMITTED` or `PARTIALLY_EXECUTED`, and its remaining quantity stays reserved.
Each adapter declares its finality ladder and the level at which each final
status may be applied ([enforcement-adapters.md §2](enforcement-adapters.md#2-the-adapter-contract)).
`UNKNOWN` is a value that rejects (INV-5); there is no path by which it becomes
a release.

## 3. Intent replay identity

The replay key is the `ActionDigest`, as the MCE v2 mandate digest is the
kernel's. The intent's record:

```text
IntentRecord {
  actionDigest
  status        UNUSED | RESERVED | SPENT
  generation    uint64       0 initially; +1 on every RESERVE; never reset; RESERVE refused at the maximum
  current       ReservationId | NONE
}
```

```text
             RESERVE (generation g+1)
   UNUSED ────────────────────────────▶ RESERVED(g+1)
     ▲                                     │
     │  CLOSE, final, consumed = 0         │  CLOSE, final, consumed > 0
     └─────────────────────────────────────┤
                                           ▼
                                         SPENT   (terminal)
```

- **Retry** is the same intent at a new generation, and is allowed only after
  the previous generation closed on a **final** observation with **nothing
  consumed** — the kernel's `RECONCILE(FAILED) → UNUSED`. A final observation
  proves every attempt of the old generation is dead, so the retry cannot
  double-execute.
- **A partial execution spends the intent.** An intent closed with anything
  consumed is `SPENT`; the remainder is proposed as a new intent with a new
  digest. Re-reserving a partly executed intent would require a residual-intent
  semantics — how much of the original is left, at which prices, still within
  the principal's intent — that v1 deliberately does not define
  ([replay-semantics.md §7](../replay-semantics.md#7-partial-execution) left the
  same question open).
- An intent cannot be reserved outside `[validFrom, expiresAt)`. Its record is
  not deleted when it expires; a `SPENT` record is kept forever (REPLAY-1).

## 4. Reservation state machine

```text
Reservation {
  reservationId   H("mandate-core/v1/reservation", actionDigest, generation)
  actionDigest, generation
  lineage         AuthorityIds, leaf to root; then the PolicyId in force at commit
  module          ModuleRef and ImplementationDigest            fixed for the lifecycle (DOM-2)
  adapter         AdapterRef                                    fixed for the lifecycle
  stateBindings   list<StateBinding>                            replaced only by REVALIDATE
  legs            per (node, dimension) on the charging path: reserved, consumed, overrun, released
  committedAt     ledger version; reservedAt: UnixSeconds
  attemptCeiling  UnixSeconds       ≤ intent.expiresAt, ≤ every lineage node's expiresAt
  attempts        bounded list of { attemptId, bindingDigest, validUntil ≤ attemptCeiling }
  applied         set of (sourceId, eventId) and of fill ids
  watermarks      per (sourceId, attemptId): highest status sequence
  state           ACTIVE | QUARANTINED | CLOSED
  final           { status, executed quantity, basis, observation } | NONE
  flags           OVERRUN, CONFLICT
}
```

```text
                RESERVE
   (none) ─────────────────▶ ACTIVE ──── ADMIT_ATTEMPT (t < ceiling) ───┐
                              │  ▲                                    │
                              │  └────────────────────────────────────┘
                              │   APPLY(non-final)  — consume fills, stay
                              │
         QUARANTINE           │                 APPLY(final)
  (reconciled at t > ceiling, ├──────────────────────────────────────▶ CLOSED
   outcome unestablished)     │                                          ▲
                              ▼                                          │
                         QUARANTINED ── APPLY(non-final): consume ──┐    │
                              │  ▲                                  │    │
                              │  └──────────────────────────────────┘    │
                              └───────────── APPLY(final) ───────────────┘
```

| Transition | From | Requires | Effect |
| --- | --- | --- | --- |
| `RESERVE` | intent `UNUSED` | a PASS decision committed at the version it read | new reservation `ACTIVE`; legs reserved; intent `RESERVED(g+1)` |
| `REVALIDATE` | `ACTIVE` | fresh state admitted and every invariant `HOLDS` over it, committed by CAS at the current version (§10a) | `stateBindings` replaced |
| `ADMIT_ATTEMPT` | `ACTIVE` | `t < attemptCeiling`; lineage still valid at `t` (not revoked, not expired); every state binding admissible at `t` (§10a); artifact `validUntil ≤ attemptCeiling` and ≤ every `BOUNDED_BY_FRESHNESS` expiry; attempt count below its bound | attempt recorded; adapter may issue it |
| `CLOSE` never issued | `ACTIVE` | revalidation failed, or the lineage became invalid, and **no attempt was ever admitted** under this generation | `CLOSED`, status `FAILED`, basis `NEVER_ISSUED`; everything released; intent `UNUSED` |
| `APPLY` non-final | `ACTIVE`, `QUARANTINED` | a valid observation of this generation (§5) | new fills consumed; state unchanged |
| `APPLY` final | `ACTIVE`, `QUARANTINED` | a valid final observation at the adapter's finality level, with its complete fill set | fills consumed; remainder released; `CLOSED`; intent `SPENT` or `UNUSED` |
| `QUARANTINE` | `ACTIVE` | reconciliation instant past `attemptCeiling` with no final observation | `QUARANTINED`; **nothing released** |

`NEVER_ISSUED` is the one final outcome whose evidence is the ledger itself:
`ADMIT_ATTEMPT` is committed before any artifact exists, so a generation with
no `ADMIT_ATTEMPT` in the log provably has no artifact, and once it is `CLOSED`
none can be admitted.

There is no transition that releases on time, on command, or on revocation.
**The passage of time marks a reservation as needing attention; it never
decides what happened** (TIME-1, [ADR 0015](../adr/0015-replay-quarantine-and-reconciliation.md)).

## 5. Observations

```text
Observation {
  reservationId, generation          which reservation; generation must match exactly
  attemptId                          which attempt
  sourceId, eventId                  idempotency key; eventId unique per source
  sequence                           the source's ordering for this attempt
  observedAt                         UnixSeconds
  finality                           a level on the adapter's declared ladder
  status                             ExecutionStatus
  executed                           cumulative executed quantity, native units
  fills                              bounded list of { fillId, quantity, price, fee }
  evidence                           digest references: tx hash + log index; venue order id + event ids; attestation
}
ObservationId = H("mandate-core/v1/observation", observation)
```

An observation is derived by the adapter's **pure observation rule** from
evidence its reader fetched — for the EVM adapter, the existing
`observationFromGateEvidence` ([execution-gate.md §9](../execution-gate.md#9-replay-events-and-reconciliation)).
It is a validated assertion, not a proof; whatever reads the chain or the venue
is a trust boundary, and a caller-supplied "final" proves nothing on its own.

`APPLY` validates in this order and stops at the first failure, leaving the
reservation untouched:

1. **Parse whole.** Unknown fields, unknown statuses, out-of-range values:
   `OBSERVATION_INVALID`. Status is matched exactly against the vocabulary, as
   the kernel matches `SETTLED`/`FAILED`.
2. **Generation.** `generation ≠ reservation.generation`:
   `STALE_RESERVATION_OBSERVATION` (RECON-2). Checked before anything else about
   the observation's content, as in Phase 6R.1b.
3. **Closed.** Reservation `CLOSED`: go to §8.
4. **Idempotency.** `(sourceId, eventId)` already applied with identical
   content: no-op, reported as `DUPLICATE`. With different content: `CONFLICT`
   (§8).
5. **Timeline.** `reservedAt ≤ observedAt ≤` the reconciliation instant:
   otherwise `OBSERVATION_INVALID`.
6. **Consistency.** `executed` equals the sum of the quantities of every fill
   known after this observation, and never exceeds the order's own size:
   otherwise `OBSERVATION_INCONSISTENT` — the adapter emits a final observation
   only once it holds the complete fill set.
7. **Finality.** A final status below the adapter's final level is applied as
   its non-final counterpart.
8. **Apply fills** by `fillId`, each at most once, regardless of sequence: fills
   commute.
9. **Apply status** only if `sequence` exceeds the attempt's status watermark;
   a lower sequence's status is ignored (`STALE_SEQUENCE`), its new fills are
   not.

## 6. Consumption arithmetic

At authorization the domain module's `contributions(action, S)` gives the
worst case, and that is what each leg reserves. At every `APPLY` the module's
`settle(action, fills, S)` gives the actual contribution of every fill known so
far, from actual quantities, prices and fees. `settle` must be monotone in the
fill set: adding a fill never lowers any contribution (SETTLE-MONO).

For each leg, with `actual = settle(…)` projected onto the leg's dimension:

```text
newConsumed   = min(actual, leg.reserved)
CONSUME         newConsumed − leg.consumed                (≥ 0 by SETTLE-MONO)
OVERRUN         max(0, actual − leg.reserved) − leg.overrun
at CLOSE:
RELEASE         leg.reserved − leg.consumed               (≥ 0; RECON-1)
```

- **Price improvement** is released at close: a buy reserved at its limit price
  and filled lower consumes less than it reserved.
- **Overrun** — a fee above the worst case, a venue over-fill, a fill after a
  cancel believed final — is recorded, never refused, and blocks further
  increases on the dimension
  ([authority-ledger.md §10](authority-ledger.md#10-overrun)).
- **Decreasing contributions** from a settled risk-reducing action produce
  `RESTORE` on `CAPACITY` dimensions at close, not before: a reduction frees
  capacity only once it is final. What is restored is fixed by each
  dimension's restoration rule — the amount originally charged for the closed
  units (`AS_CHARGED`: capital at cost basis), or the units (`UNITS`) — and it
  goes to the legs the closed position lots were charged to, never to the
  closing actor's path. Proceeds and profit restore nothing
  ([authority-ledger.md §4](authority-ledger.md#4-authority-vocabulary-granted-reserved-consumed-restored-available)).
- **Release can never exceed what remains reserved** (RECON-1), because
  consumption beyond the reservation is booked as overrun, not subtracted from
  the release.

## 7. Lifecycle, event by event

| Event | Reservation | Ledger | Notes |
| --- | --- | --- | --- |
| Authorize | created `ACTIVE` at generation g | worst case `RESERVED` on every leg | decision and reservation in one commit at version v |
| Reject | none | nothing | receipt only |
| Issue-time admission passes | attempt recorded (`ADMIT_ATTEMPT`) | none | bindings still admissible at `t_i`, or replaced by a passing `REVALIDATE` |
| Issue-time revalidation fails, no attempt yet admitted | `CLOSED`, `FAILED` (`NEVER_ISSUED`) | `RELEASE` all | intent `UNUSED`; a later decision may try again on fresh state |
| Issue-time revalidation fails, earlier attempts exist | unchanged | unchanged | the new attempt is refused; earlier attempts reconcile normally |
| Bind / issue | artifact created | none | artifact valid until ≤ `attemptCeiling` and ≤ any `BOUNDED_BY_FRESHNESS` expiry |
| Submit | status `SUBMITTED` | none | submission is not settlement ([design §14.1](../mandate-design.md#141-submission-is-not-settlement)) |
| Partial fill | `ACTIVE`, fills applied | `CONSUME` the fill's actual contribution | remaining stays reserved |
| Full fill (final) | `CLOSED`, `EXECUTED` | `CONSUME` rest; `RELEASE` price improvement | intent `SPENT` |
| Fail (final) | `CLOSED`, `FAILED` | `RELEASE` all | intent `UNUSED`; retry permitted while intent valid |
| Cancel requested | unchanged | unchanged | a request is not an outcome |
| Cancel acknowledged, not final | unchanged | unchanged | remaining **stays reserved** |
| Cancel final | `CLOSED`, `CANCELLED` | `CONSUME` final fills; `RELEASE` the rest | intent `SPENT` if anything filled, else `UNUSED` |
| Expire (attempt's own expiry, final) | `CLOSED`, `EXPIRED` | as cancel final | |
| Timeout (ceiling passes, outcome unknown) | `QUARANTINED` | unchanged — still `RESERVED` | operator alert on quarantine depth |
| Late final after quarantine | `CLOSED` | as the final status | the normal way out of quarantine |
| Retry | new reservation at g+1 | new worst case reserved | only after a zero-consumption final close |
| Reconcile the same observation twice | unchanged | unchanged | `DUPLICATE` |
| Observation of generation g−1 | unchanged | unchanged | `STALE_RESERVATION_OBSERVATION` |
| Revocation of a lineage node | unchanged | unchanged | new reservations and new attempts blocked; issued attempts reconcile normally; a generation with no admitted attempt closes `NEVER_ISSUED` |
| Decreasing action closes (final) | `CLOSED`, `EXECUTED` | `RESTORE` on the closed lots' legs, by each dimension's restoration rule | never at proceeds |
| Module upgraded while open | unchanged | unchanged | reconciliation keeps the reservation's `ModuleRef` (DOM-2) |

## 8. Late, conflicting and duplicate observations

| Situation | Outcome |
| --- | --- |
| Duplicate event (same source, event id, content) — before or after close | no-op, `DUPLICATE` |
| Same event id, different content | `CONFLICT`: reservation flagged; adapter frozen for increases |
| Out-of-order status (lower sequence) | status ignored; any new fill ids applied |
| Observation from an earlier generation | `STALE_RESERVATION_OBSERVATION`; nothing moves |
| After `CLOSED`: a fill not in the final fill set | the finality rule was wrong. The fill is booked as `OVERRUN` on the closed reservation — its remaining authority was already released and may be reserved by others, so it cannot be "re-held". `CONFLICT` is raised; the adapter is frozen for increases until reviewed |
| After `CLOSED`: a status contradicting the final one (EXECUTED after FAILED) | `CONFLICT`, same freeze; any implied fills booked as `OVERRUN` |
| Two reconcilers apply the same observation concurrently | the ledger's compare-and-swap serializes them; the second sees `DUPLICATE` |
| Reconciler crashes after commit, before acknowledging | re-application is `DUPLICATE` |

A late fill after "final" is the one failure the ledger cannot prevent, only
record. Its cause is always an adapter whose finality rule does not match its
venue's real semantics, which is why each adapter must state that rule and its
evidence explicitly, and why a contradiction freezes the adapter instead of
being smoothed over ([design §15.3](../mandate-design.md#153-reconciliation):
a discrepancy is surfaced, never smoothed).

## 9. Worked timeline: a partial fill and a cancel

Authority: a `CAPACITY` dimension `btc-notional`, `NOTIONAL` in USD at 2
decimals, scope canonical BTC, limit **5,000.00 USD**, nothing occupied.
Order: buy 0.04 BTC-PERP at limit 100,000.00 USD/BTC. Worst case at limit:
**4,000.00 USD**.

| t | Event | Reservation | reserved | consumed | released | available |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| t0 | authorize at version v | `ACTIVE`, g=1 | 4,000.00 | 0 | 0 | 1,000.00 |
| t1 | order acknowledged (`SUBMITTED`, seq 1) | `ACTIVE` | 4,000.00 | 0 | 0 | 1,000.00 |
| t2 | fill f1: 0.015 BTC at 100,000.00 (`PARTIALLY_EXECUTED`, seq 2) | `ACTIVE` | 4,000.00 | 1,500.00 | 0 | 1,000.00 |
| t3 | cancel requested | `ACTIVE` | 4,000.00 | 1,500.00 | 0 | 1,000.00 |
| t4 | cancel acknowledged, not final (seq 3) | `ACTIVE` | 4,000.00 | 1,500.00 | 0 | 1,000.00 |
| t5 | `CANCELLED` at final level, executed 0.015, fills {f1} (seq 4) | `CLOSED` | — | 1,500.00 | 2,500.00 | 3,500.00 |
| t6 | f1 re-delivered | `CLOSED` | — | 1,500.00 | 2,500.00 | 3,500.00 (`DUPLICATE`) |
| t7 | seq 3 re-delivered late | `CLOSED` | — | 1,500.00 | 2,500.00 | 3,500.00 (`DUPLICATE`) |

`available = 5,000.00 − consumed(occupancy) − reserved-remaining`: at t2 it is
`5,000 − 1,500 − 2,500 = 1,000` — the fill moved 1,500 from reserved to consumed,
which does not change availability. Only the final cancel at t5 releases.
The intent is `SPENT`; buying the remaining 0.025 BTC is a new intent.

Had f1 filled at 99,800.00, `settle` would consume 1,497.00 and the close would
release 2,503.00. Had the venue reported a further fill f2 after t5, it would be
an `OVERRUN` of its notional plus a `CONFLICT` (§8).

## 10. Attempt ceilings, timeouts and quarantine

- **Every reservation has an attempt ceiling**, chosen at reservation and no
  later than the intent's `expiresAt` or any lineage node's `expiresAt`. Every
  artifact issued under it is valid only until a time at or before the ceiling
  (EXEC-3). This is Phase 6R.1a's rule — the reservation's expiry bounds every
  attempt signed under it — made mandatory for every adapter.
- **Every adapter must define a non-execution rule**: the evidence that, once
  the ceiling has passed, proves no attempt under the reservation can still
  execute. For the EVM adapter it exists: a final block past the ceiling with
  the mandate digest unconsumed (`ATTEMPTS_EXPIRED`, or `MANDATE_EXPIRED`). For
  a venue it requires the venue to support order expiry or nonce invalidation
  with observable finality; "order not found" in an API response is not such
  evidence. **An adapter with no non-execution rule cannot produce `FAILED`,
  and every reservation it leaves unresolved stays quarantined.** That is the
  correct failure: liveness, not safety.
- **Quarantine is not release.** A quarantined reservation still holds its
  authority, still accepts fills and final observations, and is closed only by
  one.
- **Reservation length is a liveness choice**, as in the kernel: a short
  ceiling flags unresolved attempts sooner and lets a failed attempt be retried
  sooner; it never makes anything less safe.

### 10a. Issue-time state admission and revalidation

The decision's state was admitted at `t`; the artifact is created later, at
`t_i`, and the world may have moved in between. The ledger's CAS does not see
that (CORE-CONC-1). So before issuing any artifact, the adapter runs the
issue-time admission rule — pure, Core-defined — over the reservation's
`stateBindings`:

1. **Lineage.** The lineage and the principal policy in force are still valid
   at `t_i` at the current ledger version (not revoked, not expired). If not,
   nothing is issued.
2. **Re-admission.** Each binding whose requirement says `atIssue =
   WITHIN_POLICY` is re-admitted at `t_i`: still fresh under its freshness
   mode, `t_i < validUntil`, finality still sufficient, and not superseded by a
   newer sequence of the same subject that the ledger has already applied.
3. **Revalidation.** If any binding fails step 2, or any says `atIssue =
   RECHECK`, the adapter fetches fresh snapshots, and Core re-runs admission,
   projection and every lineage and principal-global invariant over
   `S_fresh ⊕ Pending(L@v')`. The pending set already contains this
   reservation's own worst case, which is not added again. Coverage and
   availability are not re-run: the reservation already holds its authority.
   The result commits as `REVALIDATE` by CAS at `v'`, because invariants read the
   pending set.
4. **Outcome.** Pass: `ADMIT_ATTEMPT` with the new bindings, then issue, with
   `validUntil` no later than the attempt ceiling and any
   `BOUNDED_BY_FRESHNESS` expiry. Fail: nothing is issued. If no attempt was
   ever admitted under this generation, the reservation closes `FAILED` with
   basis `NEVER_ISSUED` and releases everything. Otherwise only the new attempt
   is refused.

After issue, Core has no further opportunity to check external state. What
holds between issue and execution is exactly what the requirement's
`atExecution` mode says: the enforcement point's own checks, the artifact's
expiry, or nothing beyond the pre-trade decision
([action-state-model.md §5.5](action-state-model.md#55-state-bindings-freshness-modes-and-execution-dependence),
[examples.md §F](examples.md#f-external-state-changes-after-the-ledger-cas)).

## 11. Correspondence with the Phase 6 replay machine

| Kernel replay state machine (Phase 6, frozen) | Core v1 |
| --- | --- |
| replay key: MCE v2 mandate digest | replay key: `ActionDigest` |
| `UNUSED` | `IntentRecord.UNUSED` |
| `RESERVE`, generation + 1, no wrap | `RESERVE`, generation + 1, no wrap |
| `RESERVED` | reservation `ACTIVE` |
| `admitAttemptUnderReservation` (deadline ≤ reservation expiry) | `ADMIT_ATTEMPT` (validity ≤ attempt ceiling) |
| `QUARANTINE` once the reservation expires | `QUARANTINE` once the attempt ceiling passes |
| `RECONCILE(SETTLED, evidence)` → `CONSUMED` | final `EXECUTED` → `CLOSED`, intent `SPENT` |
| `RECONCILE(FAILED, evidence)` → `UNUSED` | final `FAILED` → `CLOSED`, intent `UNUSED` |
| `STALE_RESERVATION_OBSERVATION` | `STALE_RESERVATION_OBSERVATION` |
| `ATTEMPTS_EXPIRED` / `MANDATE_EXPIRED` bases | the EVM adapter's non-execution rule |
| no partial outcome is representable | `PARTIALLY_EXECUTED`, `CANCELLED`, `EXPIRED`, `OVERRUN`, `CONFLICT` |

Under the EVM adapter, Core generation `g` of an intent corresponds to a
**fresh** MCE v2 mandate `M_g` (a new nonce, `expiresAt ≤` the Core attempt
ceiling), whose own kernel record goes `UNUSED → RESERVED (kernel generation 1)
→ CONSUMED` or `→ UNUSED` and is never re-reserved. A Core retry is a new MCE v2
mandate, not a re-reservation of the old one; the old one is dead because its
own `expiresAt` has passed at a final block. Nothing in the kernel's machine
changes; Core drives it from outside.

The gate is `FILL_OR_KILL`, so through the EVM adapter only `EXECUTED` and
`FAILED` are ever observed.

## 12. Risk-reducing exceptions

Default for v1: **fail closed** for every risk-increasing action on any
uncertainty — unavailable or stale state, unknown execution status, quarantine,
drift, conflict, breach. Risk-reducing actions pass through the same checks.

Room is left, not used: a grant term `degradedStatePolicy` exists in the
vocabulary with exactly one v1 value, `NONE`. A later version may add a
narrowly specified value — for example, a reduce-only close permitted on stale
state when the enforcement point itself enforces reduce-only and the domain
module proves the action cannot flip or increase the position — with its own
ADR, tests and adapter requirement. Adding it will not widen any grant signed
with `NONE`.
