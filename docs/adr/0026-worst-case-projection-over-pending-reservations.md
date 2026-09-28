# ADR 0026: Worst-case projection over every unresolved reservation

- **Status:** Proposed (Phase 7D, awaiting review)
- **Date:** 2026-09-28
- **Relates to:** [action-state-model.md §6](../core-v1/action-state-model.md#6-projection)
  (PROJ-1), [architecture.md §6](../core-v1/architecture.md#6-the-linearization-point),
  [implementation-7d.md](../core-v1/implementation-7d.md)

## Context

A ledger dimension bounds what was committed; an evaluated invariant bounds
what the principal's position *would be*. Evaluating "exposure ≤ 5,000"
against filled positions alone lets two agents each add 2,000 on top of
2,000 held, because neither sees the other's pending order. Invariants are
safe under concurrency only if every decision sees every pending
reservation at the version it commits at.

## Decision

- **Pending set.** Every decision projects `S ⊕ Pending(L@v)`: all `ACTIVE`
  reservations of the principal — every agent, every root, every domain — at
  the snapshot version `v` the decision will commit at.
- **Worst case.** Each reservation counts at its whole reserved
  contribution; recorded consumption is not subtracted (a consumed part the
  admitted snapshot does not yet reflect must still count). No pending
  reduction is credited.
- **Normalized facts, not the ledger.** Modules receive immutable
  `ReservationFact`s — id, generation, module, lineage, reserved effects —
  and only those under their exact `ModuleRef`.
- **Re-projection on conflict.** A lost compare-and-swap discards the whole
  decision; the retry reads the winner's reservation into its pending set.
- **Projection is hypothetical.** It can cause only its own `RESERVE`; it
  never consumes, releases or restores authority.

## Consequences

- The concurrency property extends from counters to projected state: of two
  actions each valid alone and invalid together, at most one reserves
  (tested with barriers, randomized interleavings and a 100-agent run).
- Worst case over-counts a fill already reflected in state until
  reconciliation exists (7F); this is conservative, never optimistic.
- Cost is linear in open reservations; the number considered is bounded
  (`MAX_RESERVATION_FACTS`), above which new authority is refused —
  liveness, never safety.
- It does not make market state atomic (CORE-CONC-1): state is bound by
  provenance and freshness, and rechecked before issue.
