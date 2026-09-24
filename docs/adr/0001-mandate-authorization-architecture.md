# ADR 0001: Mandate authorization architecture

- **Status:** Accepted
- **Date:** 2026-09-24
- **Resolves:** [design §7.5](../mandate-design.md#75-resolved-questions), first open question

## Context

A mandate is a bounded financial authorization
([design §7](../mandate-design.md#7-financial-mandates)). It must be signed, and
the signature must be verifiable by the deterministic verifier without network
access.

EIP-712 is the obvious scheme for an EVM-first system: wallets render typed
data legibly, so a principal signing a mandate can see what they are
authorizing rather than approving an opaque hash. That legibility matters here
more than usual, because the entire product thesis is that the human's
authorization is the thing being enforced.

But EIP-712 carries an `EIP712Domain` containing `chainId` and
`verifyingContract`. Those are properties of *where a signature is accepted*,
not properties of the financial instruction. Folding them into the mandate
itself would mean:

- the same financial intent expressed for two chains would be two different
  mandates with two different digests, for no financial reason;
- `permittedChains` — a real mandate constraint — would be shadowed by a second,
  implicit chain constraint arriving through the signature domain;
- a non-EVM signature scheme could not express a mandate at all without
  inventing a fake `chainId`;
- the audit record's mandate digest would not be stable across the ecosystems a
  future Mandate Network is meant to span
  ([design §22.1](../mandate-design.md#221-mandate-network)).

Phase 0 recorded the alternative — "a chain-agnostic envelope with
per-ecosystem signature adapters" — without deciding between them.

## Decision

Separate the canonical financial payload from the authorization that binds a
signer to it.

```
CanonicalMandate                     chain-agnostic financial intent
        │
        │ canonical encoding (ADR 0002)
        ▼
mandateDigest : bytes32              stable, ecosystem-independent
        │
        ▼
AuthorizationEnvelope                how a signer committed to that digest
        ├── scheme      "eip712-secp256k1"
        ├── signer      scheme-specific identity
        ├── signature   scheme-specific bytes
        └── domain      scheme-specific binding (EIP-712: name, version,
                        chainId, verifyingContract)
```

**Rules:**

1. `mandateDigest` is computed over the canonical mandate alone. No field of
   any authorization envelope enters it. The digest is identical whether the
   mandate is authorized by EIP-712, by a future scheme, or not yet at all.
2. The EIP-712 typed-data struct signed is
   `MandateAuthorization(bytes32 mandateDigest)`, under the domain
   `{ name: "Mandate", version: "1", chainId, verifyingContract }`. The struct
   restates nothing from the mandate: the digest is the whole commitment.
3. Envelope domain fields are **not** a chain constraint. Which chain an
   execution may use is decided only by the mandate's `allowedChains`. The
   verifier checks both, independently, and a mismatch between them is not
   silently reconciled.
4. The verifier resolves an envelope through a scheme registry. An unrecognized
   scheme is `AUTHORIZATION_SCHEME_UNSUPPORTED` — a rejection, never a skipped
   check.
5. **One scheme is implemented in Phase 1.** `eip712-secp256k1`, production
   quality. The registry exists so a second scheme is an addition; no second
   scheme is built speculatively.

**Identity binding.** The recovered signer must equal the envelope's declared
`signer`, and that signer must equal the mandate's `principal`. Recovering *a*
valid signature is not authorization — it must be the principal's. The agent is
a separate field checked separately, because
[design §8.1](../mandate-design.md#81-the-core-separation) requires
authentication and authorization to be distinct checks.

## Consequences

**Accepted costs.**

- A wallet rendering `MandateAuthorization(bytes32 mandateDigest)` shows a hash,
  not the mandate's fields. The legibility argument for EIP-712 is therefore
  only partly realized in Phase 1. The signing surface must render the mandate
  in financial terms itself, and that is a Phase 8 obligation recorded here, not
  a solved problem. An alternative — mirroring every mandate field into the
  typed-data struct — was rejected because it creates two encodings of the same
  object that can disagree, which is precisely the divergence risk
  [design §10.5](../mandate-design.md#105-differential-verification) exists to
  prevent.
- A mandate digest signed for one `verifyingContract` is, by construction,
  replayable against a different `verifyingContract` only if a verifier accepts
  that domain. Domain acceptance is therefore a deployment configuration, and
  the verifier requires the caller to state the expected domain rather than
  accepting whatever the envelope claims.

**Gained.**

- The mandate digest is stable across ecosystems, which the audit trail
  ([design §15](../mandate-design.md#15-audit-and-reconciliation)) and future
  attestations depend on.
- Chain policy lives in exactly one place: `allowedChains`.
- Adding a signature scheme does not touch the mandate, the encoding, the
  digest, or the verifier's other check families.
