# ADR 0022: Principal event log, hash chain and derived ledger state

- **Status:** Accepted (Phase 7C, frozen)
- **Date:** 2026-09-27
- **Relates to:** [authority-ledger.md §5, §9, §13](../core-v1/authority-ledger.md),
  [ADR 0020](0020-mandate-core-package-and-encoding.md),
  [ADR 0021](0021-authority-ledger-package-boundary.md)

## Context

The frozen specification fixes what the ledger must be — one linearizable log
per principal, a principal-wide version, atomic batches, hash-chained events,
state derivable by folding the log, and pure transition rules — and leaves how
to 7C. Three choices here are architectural: they constrain every later store,
replayer and receipt, and a second implementation must reproduce them exactly.

## Decision

### 1. A closed event vocabulary, applied by one pure reducer

The ledger's only inputs are events from a closed union, one variant per event
of the specification 7C folds: `REGISTER_POLICY`, `REGISTER_GRANT`, `REVOKE`,
`RESERVE`, `CONSUME`, `CLOSE`, `RESTORE`. Each carries its evaluation time and
its own typed fields; there is no generic payload and no adjustment event.
`CONSUME`, `CLOSE` and `RESTORE` name the `ObservationId` they are the effect
of, because the specification admits them only as effects of applied
observations; 7C folds their arithmetic and does not validate observations.

State is `reduce(state, batch)`: a pure, total fold with no clock and no I/O.
The *same function* runs when a store commits a batch and when a log is
replayed, so there is one rule set, not a "live" path and a "replay" path. A
`RESERVE` event records its lineage, policy and every leg; the reducer
re-derives all three from the state and refuses the event if they differ, so a
recorded charge path is evidence and never input.

Every event's time must be at or after the latest committed one. With this,
the log's times are monotone, an `EPOCH` budget's open reservations are exactly
those of the current or an earlier window, and a skewed evaluator cannot
authorize against an already-passed expiry by backdating.

### 2. Batches, versions and the head

```text
batch  = str("mandate-core/v1/ledger-batch") ‖ u16(1) ‖ principal ‖ u64(version)
         ‖ bytes32(previousHead) ‖ u16(n) ‖ event₁ … eventₙ
head   = keccak-256(batch)
head₀  = keccak-256(str("mandate-core/v1/ledger-genesis") ‖ u16(1) ‖ principal)
```

A batch is the unit of atomicity and of versioning: it is applied entirely or
not at all, and advances the version by exactly one. Embedded Core objects
(grants, policies, revocations) are their own tagged canonical encodings
behind a `u32` length, so each decodes with its own validator and commits to
its exact identity preimage. The ledger state of a principal is identified by
`(principal, version, head)`.

### 3. Derived state is persistent and has a canonical encoding

The folded state is immutable and structurally shared (a hash array mapped
trie), so a snapshot read at version `v` stays `v`, and a commit costs
O(entries touched) rather than O(history). Authorization reads this state; it
never replays the log. `encodeLedgerState` gives any state one canonical byte
string (every map in ascending key order), used to prove that incremental
application and full replay agree (LEDGER-6). It is a comparison form, not a
wire format; the log is authoritative.

### New tags

`mandate-core/v1/ledger-batch`, `…/ledger-genesis`, `…/ledger-event` (a single
event as a standalone object, for receipts), `…/ledger-state` and
`…/policy-dimension` (the identity of a principal-global dimension, everything
but its limit). None reuses a Core tag. A charge plan has no tag of its own: it
exists only embedded in a `RESERVE` event.

## Consequences

**Gained.** Replay from bytes reproduces the head and the state byte for byte;
reordering, altering, inserting or removing any event changes every later
head; the cost of a decision does not grow with history; a durable store needs
to persist only batch bytes.

**Accepted costs.**

- The reducer re-derives every `RESERVE`'s path at commit, which the engine
  also derived when planning: twice the path work per reservation, bounded by
  lineage depth × dimensions.
- Monotone time can refuse a decision evaluated at an earlier instant than a
  concurrent commit (`EVALUATION_TIME_REGRESSED`); the caller re-evaluates at a
  fresh time. That is a liveness cost, never a safety one.
- The state encoding is a 7C comparison form. If receipts (7H) need to commit
  to state, they will reference `(principal, version, head)`, not this
  encoding.
