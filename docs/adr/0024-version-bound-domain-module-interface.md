# ADR 0024: A pure, version-bound DomainModule interface

- **Status:** Proposed (Phase 7D, awaiting review)
- **Date:** 2026-09-28
- **Relates to:** [action-state-model.md §8](../core-v1/action-state-model.md#8-the-domain-module-interface),
  [ADR 0025](0025-control-package-and-authorization-boundary.md),
  [implementation-7d.md](../core-v1/implementation-7d.md)

## Context

Mandate Core must reason about economic meaning — what a perp order does to
exposure, what a lending action does to a health factor — without Core
learning any market. The frozen specification gives every domain a module
behind one interface, bound by an exact `ModuleRef` for the whole
lifecycle (DOM-2), pure and total, unable to authorize (DOM-1). Phase 7D
makes that interface executable.

## Decision

`@mandate/control` defines `DomainModule`:

```text
validateAction(action)                   → target, resources, risk direction, rights exercised, per-action bound values, lifetime cap
stateRequirements(scope)                 → exactly the (stateKind, subject) it will read, sources and default requirement
validateStatePayload(state)              → the payload parses under its schema
project(scope, admitted state)           → typed facts: HELD, PENDING (worst case), PROPOSED; module-owned invariant facts
evaluateInvariant(invariant, projection) → HOLDS | VIOLATED | UNKNOWN, for invariants it owns
deriveLedgerDemands(action, projection)  → typed quantities; never a target
noWeaker(parent, child)                  → NO_WEAKER | WEAKER | UNPROVABLE, for invariants it owns
```

- **Explicit inputs only.** A module receives the action (envelope, id and
  the payload its digest commits to), the snapshots admitted for its own
  requirements, and the unresolved reservations under its exact `ModuleRef`.
  It is given no clock, network, keys, randomness, database or ledger, and
  never another module's state.
- **Bound to one identity.** Every implementation declares one `ModuleRef`
  and one `ImplementationDigest`. A catalog admits it only if both are
  registered exactly and it passes its conformance corpus, deterministically,
  on frozen inputs. Resolution is by exact `ModuleRef`; there is no latest.
- **Cannot authorize, cannot choose targets.** Outputs are facts,
  comparisons and demands. The control engine decides; the ledger derives
  every charged target.
- **Untrusted output.** Every output is rebuilt through Core's validators
  and checked for provenance; a throw, a malformed value or a fact citing
  state the module was not given is a refusal naming the module.
- **Module-owned invariants.** An invariant definition has exactly one
  owning module; its parameters are the owner's bytes, evaluated and ordered
  only by the owner. Core owns the `core.*` namespace and one invariant of
  its own, `core.aggregate-max`, which sums standardized facts across modules.

## Consequences

- Semantics are a function of the exact `ModuleRef`: the same action and
  state under another digest is another projection and another
  authorization identity.
- A module bug that understates a worst case is still a bug in authority
  (action-state-model.md §8); the corpus and the re-validation narrow what it
  can do, never to zero. The corpus proves only what its vectors exercise.
- A module sees reservations only under its own ref, so reservations in its
  domain under another version make its own invariants `UNKNOWN` until
  `lotCompatibility` exists (fail closed).
- No production module exists; the only implementation is a test-only
  synthetic exposure market.
