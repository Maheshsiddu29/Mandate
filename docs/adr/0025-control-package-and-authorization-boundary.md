# ADR 0025: The control package and the authorization orchestration boundary

- **Status:** Accepted (Phase 7D, frozen)
- **Date:** 2026-09-28
- **Relates to:** [ADR 0021](0021-authority-ledger-package-boundary.md),
  [ADR 0023](0023-ledger-store-contract.md),
  [ADR 0024](0024-version-bound-domain-module-interface.md),
  [implementation-7d.md](../core-v1/implementation-7d.md)

## Context

Authorization needs domain semantics (modules), trusted state (admission)
and atomic accounting (the ledger). The ledger must stay domain-ignorant
(ADR 0021), Core's representation is frozen, and the decision must stay a
pure function of explicit inputs so it can be replayed.

## Decision

A new workspace package, `packages/control` (`@mandate/control`).

- **Dependencies:** exactly `@mandate/ledger`, `@mandate/core` and
  `@mandate/kernel` (from the kernel only `ok`, `err`, `Result`,
  `ByteWriter` and the `Identifier` type). Direction: domain modules →
  control → ledger → core → kernel. Nothing below depends on it.
- **Pure decision.** `decide(snapshot, request)` is a pure function of one
  ledger snapshot and one request — action, payload, explicit generation,
  supplied state, and an explicit evaluation context (time, configured
  sources, block heads, watermarks). No clock, environment or network.
- **One atomic point.** The engine commits the decision's `RESERVE` by the
  7C compare-and-swap at the snapshot's version. On a lost race it
  recomputes the *whole* decision — projection included — from the new
  snapshot, with the caller's bounded retry; exhaustion is a structured
  concurrency result.
- **No raw accounting exposed.** The package exports no consume, release
  or restore. Its only release is `NEVER_ISSUED` closure, taken only after
  the engine itself finds revalidation failing and no consumption recorded.
- **One ledger extension.** The ledger reducer gains an optional,
  configured `InvariantOrdering` (`ReducerRules`), supplied by the catalog,
  so a delegation whose restated invariant the owning module proves no
  weaker can register. No event or call carries a verdict; the reducer asks
  the configured ordering at commit and at replay, and without it behaves
  exactly as in 7C.

## Consequences

- Market-specific meaning never enters the ledger or Core.
- Replaying a history that relied on a semantic proof requires the same
  ordering (the same owning modules, retired ones included); without it
  replay refuses rather than accepts.
- Revalidation is a pure check. Committing `REVALIDATE` and
  `ADMIT_ATTEMPT`, and every venue-driven transition, belong to the
  enforcement and reconciliation phases.
- The store must be constructed with `controlRules(catalog)`; a store
  configured otherwise refuses proven narrowings at commit (fail closed).
