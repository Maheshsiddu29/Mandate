# ADR 0007: Registry snapshot encoding, digest and versioning

- **Status:** Accepted
- **Date:** 2026-09-24
- **Relates to:** [ADR 0002](0002-canonical-mandate-encoding.md)

## Context

A registry decision is only auditable if the registry state it was made against
can be named and reproduced. The question Phase 2 has to answer for Phase 8's
audit surface and Phase 6's differential testing is: *what did Mandate know at
time X, and can we prove this decision followed from it?*

That requires a deterministic digest over registry state. The open question was
whether to express registry state inside the kernel's canonical encoding
(MCE v1, [ADR 0002](0002-canonical-mandate-encoding.md)) or to give the registry
its own.

MCE v1 exists to make the *signed mandate* canonical, and its object set —
mandate, candidate, trusted state, authorization envelope, receipt — is frozen
because those digests are what principals sign and what replay protection is
keyed on. A registry snapshot is none of those things: it is not signed, it is
far larger, it is versioned on its own schedule, and it will grow fields every
time a metadata dimension is added.

## Decision

**Reuse MCE's primitives and domain-separation discipline; do not add registry
objects to MCE's frozen object set.**

Concretely:

- the registry encodes with the kernel's exported `ByteWriter` primitives —
  big-endian fixed-width integers, `u16`-length-prefixed strings, sets sorted by
  encoded bytes — so there is one set of encoding *principles* in the project and
  no JSON numeric ambiguity anywhere in a digest path;
- the registry defines its **own domain tags** in its own package:

  | Object | Tag |
  | --- | --- |
  | Snapshot | `MANDATE.REGISTRY.SNAPSHOT.V1` |
  | Canonical asset record | `MANDATE.REGISTRY.ASSET.V1` |
  | Canonical asset identity only | `MANDATE.REGISTRY.ASSETID.V1` |
  | Representation record | `MANDATE.REGISTRY.REPRESENTATION.V1` |
  | Representation decision | `MANDATE.REGISTRY.DECISION.V1` |

  Tags are unterminated, so a tag that is a prefix of another would break domain
  separation. A test asserts that no registry tag equals or prefixes any kernel
  tag and vice versa;
- the registry carries its **own schema version** (`registrySchemaVersion`),
  independent of the mandate schema version. Adding a metadata dimension bumps
  the registry version and invalidates registry vectors. It does not touch the
  mandate encoding, and it cannot change a single mandate digest — which is the
  whole point of keeping them apart. A mandate signed today stays valid when the
  registry learns a new field tomorrow;
- the digest is `keccak256` over the encoding, for consistency with the rest of
  the project and because the execution gate is EVM.

### Two digests, deliberately

| Digest | Covers | Purpose |
| --- | --- | --- |
| `snapshotDigest` | The whole snapshot: every asset, every representation, every claim and its provenance, the declared source versions | Naming the state a decision was made against |
| `identityDigest` (per asset) | The canonical asset id alone | Proving that display metadata changes did not change financial identity |

The second exists because "changing a ticker must not change canonical identity"
is a claim worth being able to *demonstrate* rather than assert. It is what the
corresponding property test compares.

### Ordering and determinism

Assets and representations are sorted by their encoded identifier bytes; claim
sets are sorted by `(trust class, source id, observation time, encoded value)`;
alias and listing collections are sorted the same way. Duplicate entries reject
rather than being collapsed, following ADR 0002's reasoning: a caller that
submitted a duplicate did not build the object it believed it built.

The result is that snapshot construction order, adapter emission order and
object key order cannot reach the digest — and therefore cannot reach a decision.

### What is not built

**No database.** A snapshot is a value. A caller that wants durability
serializes it; the registry neither reads nor writes storage
([ADR 0004](0004-registry-package-boundary.md)). Phase 2 has no persistence
requirement, and [AGENTS.md §4.1](../../AGENTS.md#41-scope-discipline) forbids
introducing one before a real requirement appears.

**No time-travel query interface.** The snapshot model makes "what did Mandate
know at X" answerable by holding the snapshot from X and re-running. A versioned
query API over a history of snapshots is a Phase 8 audit concern, not a Phase 2
one.

## Consequences

**Accepted costs.**

- Two encodings in the project, so a reimplementer has two specifications to
  follow. They share every primitive, and the registry's is much the simpler of
  the two.
- Adding a metadata dimension invalidates every committed registry vector and
  requires regenerating them. Intended: a silent field addition that preserved
  digests would mean a decision was not actually covered by the digest it claims
  to follow from.
- A snapshot digest covers *claims including advisory ones*, so adding an
  advisory claim changes the snapshot digest while changing no decision. That is
  correct — the digest names the state, not the decision — and the property that
  adding such a claim changes no decision is tested separately.

**Gained.**

- A registry decision can be replayed years later from a recorded snapshot.
- A future receipt can reference a registry snapshot digest and make the whole
  resolution path auditable, which is what
  [INV-11](../mandate-design.md#16-major-invariants) requires of the pipeline as
  a whole rather than only of the verifier.
- Registry schema evolution is decoupled from mandate compatibility.
