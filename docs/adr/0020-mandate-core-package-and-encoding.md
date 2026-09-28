# ADR 0020: Mandate Core package boundary and canonical encoding

- **Status:** Accepted (Phase 7B, frozen)
- **Date:** 2026-09-27
- **Resolves:** [core-v1 open question 10](../core-v1/README.md#open-questions)
  (exact canonical encodings, domain tags and collection bounds, and whether
  Core imports the kernel's types); the Core constant for delegation depth
  ([authority-model.md §5](../core-v1/authority-model.md#5-lineage-validity) rule 7)

## Context

Phase 7A froze the Mandate Core v1 specification and left the concrete package
boundary and encoding to 7B. Core is the representation every later phase
(ledger, invariant engine, adapters, receipts) builds on, so its encodings are
signed and hashed on every agent action and must be fixed before 7C. The
kernel already has a canonical encoding discipline (ADR 0002) and types the
specification says to reuse unchanged: `PartyId`, `TrustClass`, the
identifier charset, `Amount` and `Price`.

## Decision

### Package

A new workspace package, `packages/core` (`@mandate/core`). Runtime
dependencies are exactly `@mandate/kernel` and `@noble/hashes` at the kernel's
pinned version. The direction is `core → kernel`; nothing depends on Core yet,
and the execution gate does not (the EVM adapter will depend on both, 7F). Core
performs no I/O, reads no clock, holds no model, chain or HTTP client, and names
no venue. `packages/core/test/structure.test.ts` enforces all of this, and that
Core's sources declare no `any`, `unknown` or `Record<…>` type.

### What Core reuses from the kernel, unchanged

- the identifier parser and charset (ADR 0002);
- `PartyId` and its validation, including the `eip155-address` shape;
- `TrustClass` and its wire codes;
- `ByteWriter`, `ByteReader` and the `Result` type.

### What Core defines itself, and why

- **Quantities and prices.** The kernel's `Amount` is unsigned and its
  `UnitCode` is any identifier, so `usd` and `USD` are two units. Core's
  `EconomicQuantity` needs signed kinds (`POSITION_SIZE`, `NET_EXPOSURE`,
  `PNL`), a kind, an asset and a valuation. It keeps the kernel's
  `(unit, decimals, atoms)` layout and range (0–38 decimals, `uint256`), and
  narrows units to canonical uppercase codes (`^[A-Z0-9]([A-Z0-9._-]{0,30}[A-Z0-9])?$`)
  so case variants are refused rather than folded. The kernel is not changed.
- **Role-typed parties.** `PrincipalId` and `AgentId` are brands over the
  kernel's `PartyId`. A principal acting as holder of its own node goes through
  `principalAsAgent`, the only role conversion.
- **Asset forms.** The specification's `asset` resource kind is written as two
  kinds, `CANONICAL_ASSET` and `REPRESENTATION_ASSET`, because it also requires
  canonical assets and token representations to be distinct types (INV-6).

### Encoding

ADR 0002's primitives (big-endian fixed width, `u16`-prefixed ASCII strings,
32-byte digests, `u16` counts), plus:

| Rule | Encoding |
| --- | --- |
| Top-level object | `str(tag) ‖ u16(schemaVersion = 1) ‖ body` |
| Domain tag | ASCII, **length-prefixed**, one per object type, containing the Core version (`mandate-core/v1/action`, …). Length-prefixing makes the tag space prefix-free |
| Embedded component | body only, no tag |
| Signed atoms | `i256`, two's complement, 32 bytes; unsigned atoms `u256` |
| Nullable field | `u8` flag, 0 absent or 1 present, then the value; any other flag is malformed |
| Set | `u16` count, elements ascending by encoded bytes, duplicates refused on input and non-ascending order refused on decode |
| Ordered list (lineage) | `u16` count, in order |
| Enum | `u8` wire code, written out explicitly per enum |
| Timestamp | `i64` Unix seconds |
| Digest | `keccak-256(top-level encoding)` |

Tags in use:

| Tag | Object | Identity |
| --- | --- | --- |
| `mandate-core/v1/authority` | `AuthorityGrant` | `AuthorityId` (`MandateId` / `DelegationId`) |
| `mandate-core/v1/principal-policy` | `PrincipalPolicy` | `PrincipalPolicyId` |
| `mandate-core/v1/action` | `ActionEnvelope` | `ActionId` (the `ActionDigest`) |
| `mandate-core/v1/payload/` | action payload, with the module digest inside the hash | `PayloadDigest` |
| `mandate-core/v1/state` | `StateEnvelope` | `StateId` (the `StateDigest`) |
| `mandate-core/v1/state-binding` | `StateBinding` | `StateBindingId` |
| `mandate-core/v1/module-ref` | `ModuleRef` | `ModuleRefDigest` |
| `mandate-core/v1/adapter-ref` | `AdapterRef` | `AdapterRefDigest` |
| `mandate-core/v1/quantity` | `EconomicQuantity` | `QuantityDigest` |
| `mandate-core/v1/reservation` | `(actionId, generation)` | `ReservationId` |
| `mandate-core/v1/reservation-ref` | `ReservationRef` | `ReservationRefDigest` |
| `mandate-core/v1/authorization` | `ExecutionAuthorization` | `ExecutionAuthorizationId` |
| `mandate-core/v1/execution-binding` | `ExecutionBindingRef` | `ExecutionBindingId` |
| `mandate-core/v1/receipt-header` | `ReceiptHeader` | none (a receipt component) |
| `mandate-core/v1/receipt-references` | `ReceiptReferences` | none (a receipt component) |

Reserved for later phases and unused: `mandate-core/v1/module` (the module
manifest, whose digest is `moduleDigest`), `mandate-core/v1/revocation`,
`mandate-core/v1/observation`, `mandate-core/v1/receipt/<kind>`.

### Closed-world input

Every validator takes a typed input object, checks that it has exactly its
specified fields, and refuses an unknown field (`UNKNOWN_FIELD`). Optional
fields are written as explicit `null`, never omitted, so absence has one
spelling. The v1 decoder refuses unknown versions, unknown wire codes and
trailing bytes; there is no forward-compatible extension map. A future field is
a new schema version with a new vector set. Decoding re-runs the same validator
as direct construction, so there is no weaker path.

Integers of 64 bits or more, and every economic value, are `bigint` or a
canonical decimal string (no leading zeros, no `-0`, no exponent). A
JavaScript `number` is refused for them whatever its magnitude. Small
fixed-width fields (decimals, versions, depth) are `number` and are refused
unless finite, integral, safe and in range.

### Bounds

Every list has a declared bound enforced at parse, at or below the `u16` count
the encoder writes:

| Constant | Value |
| --- | ---: |
| `MAX_DELEGATION_DEPTH` (the Core depth constant) | 7 |
| `MAX_LINEAGE_LENGTH` | 8 |
| `MAX_GRANT_TERMS`, `MAX_POLICY_TERMS` | 128 |
| `MAX_SET_MEMBERS` | 256 |
| `MAX_INVARIANT_SCOPE` | 16 |
| `MAX_INVARIANT_PARAMS_BYTES` | 1,024 |
| `MAX_ADMITTED_SOURCES` | 32 |
| `MAX_ACTION_RESOURCES` | 64 |
| `MAX_STATE_BINDINGS` | 64 |
| `MAX_ACTION_PAYLOAD_BYTES` (hashed, never parsed) | 1,048,576 |

### Signing

Not implemented in 7B. The digests above are the signable values; a signature
over one tag's digest cannot stand in for another's.

## Consequences

**Gained.** One canonical byte string per object; no cross-type digest
collision by construction; a corpus (`corpus/core-v1`) that pins every
encoding and refusal for a second implementation; the kernel untouched.

**Accepted costs.**

- Core has its own quantity and unit types beside the kernel's. The EVM adapter
  (7F) must map between them explicitly, in both directions. That is intended:
  it is where a Core `CAPITAL` in `USDG` becomes an MCE v2 `economicLimit`.
- The encoding is not ABI. A Solidity reader of Core objects would need its own
  decoder. None is planned: the frozen gate reads MCE v2, not Core.
- Every bound is a schema constant. Raising one is a new schema version.
- Error codes are provisional until the Core reason-code registry is final
  (open question 9).
