# ADR 0006: Representation claims, trust floors and conflict policy

- **Status:** Accepted
- **Date:** 2026-09-24
- **Implements:** [design §6.4](../mandate-design.md#64-metadata-sourcing-and-trust)

## Context

The registry is the most security-critical component Mandate has after the
verifier, for a reason that is easy to miss: **the verifier is only as correct as
the metadata it is handed.**
[design §17.6](../mandate-design.md#176-honest-statement-of-limits) states it
plainly — "a registry that misclassifies a synthetic instrument as backed will
pass a mandate that forbids synthetics, and no amount of verification logic
fixes that."

So the question Phase 2 must answer is not "what are the fields" but "under what
evidence is a field allowed to influence an execution".

[design §6.4](../mandate-design.md#64-metadata-sourcing-and-trust) specified the
requirements and left the mechanism as DRAFT: every field carries provenance and
an as-of time; a conflict between sources is recorded as a conflict and fails
closed; absent metadata is `UNKNOWN` and `UNKNOWN` on a constrained field
rejects. Phase 1 built the trust vocabulary
(`AUTHORITATIVE` / `VERIFIED` / `ADVISORY` / `UNTRUSTED`) and `Observed<T>`,
but `Observed<T>` carries *one* value from *one* source and its parser refuses
advisory and untrusted provenance outright. A registry needs to hold several
claims about one property, including claims it will refuse to act on.

## Decision

### 1. A security-relevant property is a set of claims, not a value

Every property of a representation that can influence admissibility is a
`ClaimSet<T>`: zero or more `Claim<T>`, each carrying the kernel's `Provenance`
(trust class, source id, observation time).

```
backing: ClaimSet<BackingModel>
  ├── Claim { FULLY_BACKED, VERIFIED,  issuer-attestation, t0 }
  └── Claim { SYNTHETIC,    ADVISORY,  third-party-feed,   t1 }
```

Identity is *not* a claim set. `representationId`, its chain and its contract
address are the representation's identity — they are what the record *is*, not
an assertion about it. Everything semantic is a claim set, including the binding
to the canonical underlying, because "this token is issued against that
underlying" is precisely the assertion that can be wrong or forged.

### 2. Establishment requires meeting a trust floor

Resolving a claim set yields one of three states:

```
ESTABLISHED   one value, agreed by every claim at or above the floor
UNKNOWN       no claim at or above the floor
CONFLICT      two or more claims at or above the floor disagree
```

The floor for anything that gates execution is `VERIFIED`, matching the kernel's
`isTrustedForAuthorization`. `UNKNOWN` and `CONFLICT` both fail closed, and
`REPRESENTATION_METADATA_UNKNOWN` and `REPRESENTATION_METADATA_CONFLICT` are
distinct reason codes because they call for different remedies: one needs data,
the other needs a curator to adjudicate.

### 3. Sub-floor claims are ignored entirely — they never degrade a decision

This is the subtle decision, and getting it backwards would introduce a
vulnerability.

A claim below the trust floor (`ADVISORY`, `UNTRUSTED`) **cannot establish a
value, and cannot create a conflict.** It is retained in the record for audit
and is invisible to every decision.

The alternative — letting a low-trust claim that disagrees with a high-trust one
raise `CONFLICT` — sounds more cautious and is worse. It would mean anyone able
to get an advisory claim into the registry could flip any representation to
inadmissible: a denial-of-service against the honest path, achieved with
precisely the class of input the trust model exists to neutralize. The
architecture's rule is that an untrusted source "may influence nothing"
([architecture §3](../architecture.md#3-trust-levels)), and *nothing* has to
include the refusal, not only the permission.

The converse is enforced too, and is the more obvious half: a low-trust claim
can never *improve* admissibility. Replacing an authoritative claim with an
untrusted one turns an `ESTABLISHED` property into `UNKNOWN`, which rejects.
Both directions are stated as properties and tested over generated registries.

### 4. A conflict fails closed unconditionally — no source precedence

When two claims at or above the floor disagree, the property is `CONFLICT`, and
that is the end of it. Specifically rejected:

- **most recent wins.** A compromised or malfunctioning source would only have
  to be *fast* to override a curated entry.
- **`AUTHORITATIVE` beats `VERIFIED`.** Superficially principled, and it means a
  single mis-tagged source silently overrides the curated registry. The trust
  class describes what a source is *permitted to influence*, and using it as a
  precedence order quietly converts it into a priority ranking it was never
  validated as.
- **majority wins.** Source count is not evidence; two feeds reselling one
  upstream are not two observations.

A conflict is information a human curator must act on, and Phase 2's job is to
surface it rather than to launder it. The cost is that one bad source can make a
representation untradeable through Mandate until the conflict is resolved. That
is the correct direction of failure, and it is visible rather than silent.

### 5. Freshness is the caller's bound, not a registry constant

Each claim carries its observation time. The registry does not embed a freshness
policy, because metadata staleness and state staleness are different problems
with different tolerances
([design §6.5](../mandate-design.md#65-representation-state-vs-representation-metadata)):
issuer and backing model change over months; operational status changes in
seconds. A caller supplies a maximum claim age alongside its other requirements,
and a claim older than that bound is treated exactly as a claim below the floor —
it cannot establish and cannot conflict.

## Consequences

**Accepted costs.**

- Every semantic property is a collection, which makes records more verbose to
  author than a flat object would be. The fixtures and world builders exist
  partly to make that ergonomic.
- A registry with one sloppy high-trust source becomes unable to admit the
  representations that source touches. Loud, and fixable by a curator.
- `UNKNOWN` is common in a small registry, so a new representation is
  inadmissible until its metadata is actually established. That is the property
  that lets the registry start small without being unsafe
  ([design §6.4](../mandate-design.md#64-metadata-sourcing-and-trust)).

**Gained.**

- "A representation property used to satisfy a mandate cannot be promoted from
  advisory or untrusted data" is a structural property with a test, not a rule
  someone has to remember while adding a source.
- Adding an adversarial claim to a registry cannot change any other
  representation's semantics, and cannot change its own except toward refusal.
- A conflict is a first-class, reportable state, so the demo can show a refusal
  whose cause is *disagreement between data sources* — a failure mode no
  slippage check has ever detected.
