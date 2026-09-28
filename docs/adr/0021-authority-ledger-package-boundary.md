# ADR 0021: Authority ledger package boundary

- **Status:** Accepted (Phase 7C, frozen)
- **Date:** 2026-09-27
- **Relates to:** [ADR 0020](0020-mandate-core-package-and-encoding.md) (Core
  package and encoding), [authority-ledger.md](../core-v1/authority-ledger.md),
  [authority-model.md](../core-v1/authority-model.md)

## Context

Phase 7C implements the first runtime state machine of Mandate Core: the
authority graph (registration, lineage, revocation, the delegation meet) and
the principal-wide global authority ledger. Phase 7A (the specification) and
Phase 7B (`packages/core`, the representation layer) are frozen. The ledger
needs Core's objects and canonical encoding, and must not change either.

The ledger will sit on the hot path of every authorization and is in the
trusted computing base
([authority-ledger.md §13](../core-v1/authority-ledger.md#13-storage-and-trust)).
Later phases put domain modules (7D) above it, never below it.

## Decision

A new workspace package, `packages/ledger` (`@mandate/ledger`).

- **Runtime dependencies are exactly `@mandate/core` and `@mandate/kernel`.**
  From the kernel it takes only `ok`, `err`, `Result` and `ByteWriter`; every
  Core type, validator and encoder it uses comes from `@mandate/core`. It has
  no third-party dependency: keccak-256 is Core's `keccakDigest`.
- **Direction:** `ledger → core → kernel`, and `ledger → kernel` for byte and
  result plumbing. Nothing depends on the ledger yet.
- **Pure:** no I/O, no clock, no randomness, no environment, no network, chain
  or model client. Time is a parameter of every operation. The store is an
  interface; the only implementation in the package is in-memory.
- **Domain-ignorant:** the ledger sees typed quantities, dimensions and
  scopes. It names no venue, implements no domain module, and has no field for
  domain concepts (side, strike, route, leverage, health factor, outcome).
- **Core stays frozen:** `packages/core` is not modified. The ledger's own
  canonical objects (the revocation, events, batches) follow ADR 0020's
  encoding discipline with new tags in the `mandate-core/v1/` namespace; the
  one tag Phase 7B reserved for this phase, `mandate-core/v1/revocation`, is
  used for exactly the object it was reserved for.

`packages/ledger/test/structure.test.ts` enforces the dependency list, the
import and kernel-symbol allowlists, the absence of I/O, clock, randomness,
untyped escape hatches, floating-point parsing, venue names and domain-module
functions, and that no other package depends on the ledger.

### Why not inside `packages/core`

Core is the frozen representation layer: objects, encodings and validators
with no semantics beyond structure. The ledger adds behaviour — registration,
the meet, charging, CAS — whose correctness depends on ledger state. Keeping it
separate keeps Core's boundary and corpus unchanged, and lets the ledger's
dependency surface be checked on its own.

## Consequences

**Gained.** Core and its vectors are untouched (PHASE6-1 and the 7B corpus
unaffected); the ledger's purity and domain-independence are structural test
properties, not conventions; the 7D engine can depend on the ledger without
the ledger depending on anything domain-specific.

**Accepted costs.**

- Error codes are the ledger's own and provisional (open question 9), beside
  Core's structural codes, which a ledger refusal wraps as `MALFORMED`.
- A second package now encodes Core objects (inside events). It uses Core's
  encoders for every Core object, so there is still one encoding per object.
