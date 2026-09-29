# Phase 7F — Portfolio Mandate and multi-agent coordination

> **Status: opened by the repository owner on 2026-09-29; specification
> written, implementation in progress.** Offline only: no deployment, no
> transaction, no key beyond publicly derivable demonstration keys. Nothing
> frozen is modified — not MCE v2, Candidate V3, the Phase 6 gate, Core, the
> ledger, the control engine, the Phase 7E.3 deployment or any canonical
> corpus.

**One authority layer. Many agents. Multiple markets.** Five specialized
agents — stock, swap, NFT, yield, perps — act for one principal. Discovery,
negotiation, ranking and allocation are offchain; only final, authorized
actions reach an enforcement point, and a refused proposal costs zero
transactions.

| Document | What it establishes |
| --- | --- |
| [portfolio-mandate.md](portfolio-mandate.md) | the Portfolio Mandate v1 object and encoding, resources, allocation modes, parent → child derivation, candidates and identity resolution, proposals, the Mandate Room, the verifier, compilation to Core and reservation, receipts, the UI contract, evidence classes, reason codes |
| [security-model.md](security-model.md) | authentication vs authorization, what an agent may and may not do, the threat table and the layer that stops each, coalitions, trust boundaries |
| [ADR 0027](../adr/0027-portfolio-mandate-layer.md) | why a separate package that compiles into Core rather than a Core change |

Relationship to the roadmap: the roadmap previously planned 7F as
cross-domain reconciliation. The owner opened 7F as this phase instead;
reconciliation is deferred and unscheduled (roadmap.md). Authority across
principals remains Phase 9.
