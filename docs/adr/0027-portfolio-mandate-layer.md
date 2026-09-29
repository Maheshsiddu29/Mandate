# ADR 0027: A Portfolio Mandate layer above Core, compiled into Core

- **Status:** Proposed (Phase 7F)
- **Date:** 2026-09-29
- **Relates to:** [ADR 0020](0020-mandate-core-package-and-encoding.md),
  [ADR 0021](0021-authority-ledger-package-boundary.md),
  [ADR 0025](0025-control-package-and-authorization-boundary.md),
  [portfolio-mandate.md](../phase-7f/portfolio-mandate.md),
  [security-model.md](../phase-7f/security-model.md)

Phase 7F.1 hardening is recorded in
[security-fixes-7f1.md](../phase-7f/security-fixes-7f1.md). It does not change
this package boundary or the Portfolio Mandate v1 schema. It requires a
complete signed verification transcript at reservation and signing, makes the
Portfolio custody factory mandatory, and introduces the separately versioned
`PORTFOLIO_RECEIPT.V2` encoding.

## Context

Phase 7F adds one principal coordinating several specialized agents across
several markets. It needs per-agent authority of different shapes, shared
resources declared in explicit units, allocation that agents negotiate, and
atomic reservation across agents. Core already has delegation, the lineage
meet, path charging and a compare-and-swap ledger; MCE v2, Candidate V3, the
Phase 6 gate and Phases 7A–7D are frozen, and 7E.3 is deployed.

## Decision

A new workspace package, `packages/portfolio` (`@mandate/portfolio`), **above**
the existing stack, that compiles into it rather than extending it.

- **Its own versioned object.** `PORTFOLIO_MANDATE.V1`, a canonical encoding
  under the repository's rules, is not MCE v3 and not a Core object. It is the
  principal's statement from which Core objects are derived.
- **Compiled, not trusted.** A verified mandate becomes one Core root grant
  (portfolio-wide limits as ledger dimensions) and one delegation per agent
  (hard maxima as ledger dimensions), registered through the unchanged
  `ControlEngine`, whose ledger re-checks child ⊆ parent. Reservation is
  `authorizeAndReserve`; issuance is each domain's existing `ADMIT_ATTEMPT`
  path. No second ledger, replay system or accounting path is built.
- **Offchain coordination has no authority.** The Mandate Room is a pure
  function whose output is re-derived by a pure Portfolio Verifier; both are
  bounded again by Core.
- **Identity through the existing registry.** The stock agent's
  representation is resolved by `@mandate/registry`; the fixture domains
  resolve exact identifiers against reviewed tables that are part of their
  module digests.
- **Dependencies:** `@mandate/kernel`, `@mandate/core`, `@mandate/registry`,
  `@mandate/ledger`, `@mandate/control`, `@mandate/evm-robinhood`,
  `@mandate/perp-lighter`, and the kernel's pinned `@noble/curves` and
  `@noble/hashes`. Nothing depends on it. The domain-agnostic modules
  (`src/*.ts` other than the bindings) import no domain package; the
  demonstration world lives under `src/demo/` and is labelled.

## Consequences

- Hard limits are enforced twice (verifier, ledger) and set membership three
  times (verifier, Core coverage, domain module). A verifier bug can only
  refuse, or mis-distribute inside the principal's limits.
- Allocation is not ledger state. Preferred allocations and lot reassignment
  are offchain coordination, replayed by the verifier; the ledger enforces
  only what a principal's hard limits say. Making allocation itself durable
  would need allocation-specific ledger events — a Core change this phase
  does not make.
- Settlement reconciliation is still not built: an executed reservation stays
  `ACTIVE`, exactly as in 7E.3.
- A new domain joins a portfolio by supplying a `DomainBinding`; no Core,
  gate or portfolio-layer change is needed.
