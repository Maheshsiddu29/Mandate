# ADR 0002: Canonical mandate encoding and digest

- **Status:** Accepted
- **Date:** 2026-09-24
- **Resolves:** [design §7.5](../mandate-design.md#75-resolved-questions), second open question

## Context

The mandate digest is the object a principal signs, the key replay protection
is scoped to, and the identifier an audit record is anchored on. It must
therefore be **canonical**: one semantic mandate must produce exactly one byte
string, on every implementation, forever.

JSON canonicalization (JCS / RFC 8785) was the alternative. It was rejected
for three reasons specific to this system:

1. **Number handling.** JCS serializes numbers through IEEE-754 double
   formatting. A notional of `2^53 + 1` atoms does not round-trip. Mandate
   forbids floating point in safety-critical paths
   ([INV-16](../mandate-design.md#16-major-invariants)) and a canonicalization
   that reaches for a double at all is the wrong foundation.
2. **Solidity reproducibility.** The execution gate
   ([design §14.3](../mandate-design.md#143-the-execution-gate)) must be able to
   recompute or verify this digest on-chain. Parsing and re-serializing JSON in
   Solidity is absurd; concatenating fixed-width fields is one `abi.encodePacked`.
3. **Unicode.** JSON strings admit equivalent forms that differ in bytes
   (normalization, escapes, surrogates). Each is a place where two
   implementations can disagree about whether two mandates are the same.

## Decision

A flat, versioned, length-explicit binary encoding: **MCE v1** (Mandate
Canonical Encoding, version 1), digested with **keccak-256**.

### Primitives

| Primitive | Encoding |
| --- | --- |
| `u8`, `u16`, `u32`, `u64`, `u256` | Unsigned, **big-endian**, fixed width. Out-of-range values reject |
| `i64` | Signed two's complement, big-endian, 8 bytes. Used only for Unix-second timestamps |
| `bytes32` | 32 raw bytes |
| `str` | `u16` byte length, then UTF-8 bytes. Max 1024 bytes |
| `bytes` | `u16` byte length, then raw bytes |
| `set<T>` | `u16` count, then each element's encoding, **sorted ascending by encoded bytes**, duplicates rejected |

Big-endian is chosen because it is what the EVM uses natively; a Solidity
reimplementation needs no byte reversal.

### String rules

Every string in a mandate is an identifier, never prose
([design §7.4](../mandate-design.md#74-design-rules-for-the-mandate-schema),
rule 3). Identifier strings are restricted to:

```
A-Z a-z 0-9 . _ - : /
```

length 1..128, no leading or trailing separator. The charset is pure ASCII, so
Unicode normalization cannot produce two byte strings for one identifier — the
ambiguity is removed rather than resolved. A string outside the charset is
`MALFORMED_IDENTIFIER`; it is never sanitized, trimmed, or case-folded, because
auto-correcting a security-relevant identifier is exactly the silent
normalization this ADR exists to prevent.

### Collection rules

Sets (`allowedIssuers`, `allowedChains`, `allowedVenues`) are sorted by their
encoded bytes and must contain no duplicates. Sorting makes authoring order
irrelevant to the digest. Duplicates **reject** rather than being collapsed:
a caller that submitted a duplicate did not build the object it thought it
did, and silently fixing it hides that.

An empty allowlist is permitted and means *nothing is allowed*, consistent with
allowlist semantics
([design §7.4](../mandate-design.md#74-design-rules-for-the-mandate-schema),
rule 2). It is not read as "unconstrained".

### Domain separation

Every encoded object begins with a fixed ASCII domain tag, unterminated and
unprefixed, followed by a `u16` version:

| Object | Tag |
| --- | --- |
| Mandate | `MANDATE.MANDATE.V1` |
| Execution candidate | `MANDATE.CANDIDATE.V1` |
| Trusted state | `MANDATE.STATE.V1` |
| Authorization envelope | `MANDATE.AUTHZ.V1` |
| Verification receipt | `MANDATE.RECEIPT.V1` |

Distinct tags mean a digest computed over one object type can never collide
with, or be replayed as, another — the same reasoning that gives EIP-712 its
domain separator. Tags are frozen: `V1` never changes meaning, and a future
encoding is `V2` with its own tag.

### Versioning

The `u16` version immediately after the tag is the **schema** version. A
decoder that does not recognize it returns `UNSUPPORTED_MANDATE_VERSION`. It
never attempts a best-effort parse, and it never ignores trailing bytes: a
buffer with content left over after a complete decode is `MALFORMED_MANDATE`.

### Digest

```
mandateDigest = keccak256( MCE(mandate) )
```

keccak-256 rather than SHA-256 because the execution gate is EVM: keccak is a
single opcode there and SHA-256 is a precompile call with different cost and
padding semantics. The digest is 32 bytes and is used directly as the EIP-712
message body (ADR 0001) and as the replay key.

### Round-trip obligation

Encoding is paired with a strict decoder, and the test suite asserts
`decode(encode(x)) == x` and `encode(decode(b)) == b` for every corpus vector.
The second direction is what proves canonicality: if two byte strings decoded
to the same value, re-encoding would reveal it.

## Consequences

**Accepted costs.**

- Binary encoding is not human-readable. Debugging needs tooling, and the
  decision-vector corpus carries hex alongside structured JSON for exactly this
  reason.
- Adding a mandate field is a breaking encoding change requiring a new version
  and new corpus vectors. This is intended: a field addition that silently
  preserved old digests would let a new field widen the authority of a mandate
  signed before the field existed
  ([design §7.4](../mandate-design.md#74-design-rules-for-the-mandate-schema),
  rule 2).

**Gained.**

- No floating point anywhere in the digest path.
- A Solidity reimplementation is concatenation plus `keccak256`, with no
  parser.
- Two encodings of one semantic mandate are impossible by construction rather
  than by convention: sets are sorted, duplicates reject, strings are ASCII,
  integers are fixed-width, and trailing bytes reject.
