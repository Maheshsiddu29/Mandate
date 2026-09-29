# Phase 7F — Portfolio Mandate and multi-agent coordination

> **Status: opened by the repository owner on 2026-09-29; implemented
> locally in `packages/portfolio`, offline, awaiting review.** No deployment,
> no transaction, no key beyond publicly derivable demonstration keys. Nothing
> frozen is modified — not MCE v2, Candidate V3, the Phase 6 gate, Core, the
> ledger, the control engine, the Phase 7E.3 deployment or any canonical
> corpus.
>
> **Phase 7F.1 hardening is implemented locally and awaiting review.** See
> [security-fixes-7f1.md](security-fixes-7f1.md). It adds value-based
> verify→reserve→admit→sign binding, mandatory Portfolio custody construction,
> ordered transcript replay and `PORTFOLIO_RECEIPT.V2`; the Portfolio Mandate
> remains v1.
>
> **Phase 7F.2 replay hardening is implemented locally and awaiting review.**
> See [security-fixes-7f2.md](security-fixes-7f2.md): one signed proposal has
> one child authorization and one Core action whenever it is verified, so the
> existing ledger refuses its replay; quote freshness is a predicate, never an
> identity. No version changes.

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
| [demo.md](demo.md) | the five-agent demonstration round by round, its evidence classes, and what is real and what is not |
| [implementation-7f.md](implementation-7f.md) | what was built, how it maps onto existing components, decisions needing approval, tests, validation, performance, residual risks |
| [security-fixes-7f1.md](security-fixes-7f1.md) | the independently reproduced findings, exact boundary invariant, Receipt V2, transcript rules and residual cross-run replay risk |
| [security-fixes-7f2.md](security-fixes-7f2.md) | F7F1-01: stable proposal, child and Core action identity; time-invariant quote authorization; replay by ledger state; retry and sequence semantics |

Run it: `npm run portfolio:demo` (offline). Its receipt, UI view and
screening vectors are committed in
[corpus/portfolio-demo-v1](../../corpus/portfolio-demo-v1/README.md).

Relationship to the roadmap: the roadmap previously planned 7F as
cross-domain reconciliation. The owner opened 7F as this phase instead;
reconciliation is deferred and unscheduled (roadmap.md). Authority across
principals remains Phase 9.
