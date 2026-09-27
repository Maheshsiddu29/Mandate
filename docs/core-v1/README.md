# Mandate Core v1

> **Status: Phase 7A specification, DRAFT pending review. Nothing here is
> implemented.** Phase 6 is frozen as of `dc98df5` and is not modified by
> anything in this directory. No code accompanies this specification.

Mandate Core v1 is the domain-independent economic control layer that Spot,
Perp, Options, Prediction, Lending, Liquidity, Payment, Treasury and Governance
modules will build on. It represents delegated economic authority, proposed
autonomous actions, the economic state they depend on, the authority they
consume and hold while in flight, where they are enforced, how their actual
outcome is reconciled, and the evidence left behind.

```
agent autonomy  ⊆  principal-delegated economic authority
```

## Reading order

| Document | What it specifies |
| --- | --- |
| [architecture.md](architecture.md) | The core equation, the four layers, what is deterministic Core and what belongs to domain modules and adapters, the linearization point, the relationship to frozen Phase 6, and the concept catalogue |
| [authority-model.md](authority-model.md) | Parties, grants, the seven kinds of authority term, the meet that keeps child ⊆ parent, lineage and delegation validity, revocation and expiry |
| [action-state-model.md](action-state-model.md) | Identifiers, typed economic quantities and the rules that stop units and kinds mixing, the action envelope, the state envelope with source trust and freshness, conservative projection, typed invariants, and the domain module interface |
| [authority-ledger.md](authority-ledger.md) | Which constraints are counters and which are not, dimensions with BUDGET and CAPACITY accounting, events and statuses, path charging, balance equations, the availability check, linearizability, and overrun, drift and adjustment |
| [reservations-reconciliation.md](reservations-reconciliation.md) | Non-atomic execution statuses, intent replay identity and generations, the reservation state machine, observations and their validation order, consumption arithmetic, late and conflicting events, a partial-fill timeline, and the mapping onto the Phase 6 replay machine |
