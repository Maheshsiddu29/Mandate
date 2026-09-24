# Registry semantics

Canonical asset identity, representation metadata, trust, resolution and
admissibility — what the Phase 2 registry means and what it refuses to mean.

> **Status: Phase 2, specified.** The canonical product specification remains
> [mandate-design.md](mandate-design.md) §5 and §6; this document is the
> implementation-level semantics for `packages/registry`, in the same
> relationship to the design document as
> [verifier-invariants.md](verifier-invariants.md) is for the kernel.

## 1. The distinction the whole layer exists to preserve

```
Canonical financial asset   !=   Token representation   !=   Economic equivalence
```

Registry membership asserts exactly one thing:

> this representation has sufficiently verified provenance tying it to this
> canonical underlying.

Membership does **not** mean the representation is economically equivalent to
the underlying, automatically admissible, interchangeable with another
representation of the same underlying, or identical in shareholder rights,
backing, redemption rights, jurisdiction, corporate-action treatment,
settlement model or risk.

Admissibility is decided against a mandate, never stored. See §6.

### How the distinction is expressed structurally

Prose in a design document does not stop anyone writing
`representation.equivalentTo`. These do:

| Mechanism | What it prevents |
| --- | --- |
| No record type has an equivalence, substitutability or admissibility field | Storing a conclusion that depends on a mandate |
| No function has the shape `(record) -> Admissibility` | Deriving admissibility without requirements |
| `evaluateRepresentation` takes a representation **id**, never a record, and looks it up in the snapshot | An off-registry record being evaluated into admissibility |
| `RepresentationRequirements` can only be constructed from a mandate, and combinators only narrow | Requirements that widen authority |
| A structural test greps registry sources for banned field names | The next person adding one |
| Separate `identity` and `display` groups, with separate digests | Display metadata reaching financial identity |

## 2. Canonical asset identity

`CanonicalAssetId { assetClass, idScheme, value }` — the Phase 1 kernel type,
unchanged. Chain-independent, contract-independent, ticker-independent,
representation-independent.

Schemes are a closed vocabulary and their values are **check-digit validated**:
`figi`, `isin`, `cusip`. An unrecognized scheme or a failing check digit is
`ASSET_IDENTIFIER_INVALID`. Rationale, including why validation rather than
storage, is in [ADR 0005](adr/0005-canonical-asset-identity-and-resolution.md).

### Identity versus display

| Identity — changing it is a different asset | Display — changing it changes nothing financial |
| --- | --- |
| `assetClass`, `idScheme`, `value` | `primaryName`, `displayTicker`, `primaryMarketIdentifier`, `listings[]`, `aliases[]` |

`CanonicalAssetRecord` keeps these in separate groups, and
`canonicalAssetIdentityDigest` covers only the identity group. The property
"changing a display name or ticker does not change canonical financial identity"
is therefore demonstrable: the record digest changes, the identity digest does
not, and resolution by canonical id is unaffected.

`status` is `ACTIVE | DELISTED | SUPERSEDED | UNKNOWN`. It is asset *state*, not
identity, and a non-`ACTIVE` asset resolves but yields no admissible
representation.

## 3. Human-reference resolution

```
human reference  ──▶  resolution candidates  ──▶  canonical asset
```

A human reference is **not** authoritative identity. It is a lookup input, and
the step that turns it into an identity is explicit, auditable and allowed to
fail.

### Accepted reference forms

| Form | Example | Notes |
| --- | --- | --- |
| Structured canonical id | `{ assetClass, idScheme, value }` | Exact |
| Scheme-qualified value | `figi:BBG000BBJQV0` | Exact, check-digit validated |
| Full canonical id string | `mandate:asset:equity:figi:BBG000BBJQV0` | Exact |
| MIC-qualified ticker | `XNAS:NVDA` | Matches a registered listing |
| Bare ticker | `NVDA` | Ambiguous whenever two assets list it |
| Registered name or alias | `NVIDIA Corporation` | Exact match on the normalized key |

### Outcomes

```
RESOLVED    exactly one candidate
AMBIGUOUS   two or more candidates — all returned, none chosen
UNKNOWN     no candidate
INVALID     the reference is not a well-formed reference
```

Four named outcomes rather than a nullable result, because `null` conflates
"unknown", "several" and "nonsense", and a caller must respond differently to
each.

**Matching is exact over a normalized key. There is no fuzzy matching, no edit
distance and no model anywhere in resolution.** Normalization is confined to
trimming surrounding ASCII whitespace, collapsing internal ASCII whitespace runs,
and case-folding for comparison. Non-ASCII input is `INVALID`. Nothing stored is
ever rewritten.

### Ambiguity is data, not corruption

A ticker shared across venues, a company name shared by unrelated issuers, and
an alias a curator pointed at two assets are all legitimate registry contents.
They do not fail snapshot construction; they resolve `AMBIGUOUS` with every
candidate named. Per
[design §9.4](mandate-design.md#94-resolution-failure-is-a-normal-outcome),
"no route found" is a useless answer and Mandate does not give one.

**Symbol equality can never satisfy canonical asset equality.** A token whose
ERC-20 symbol is `NVDA` establishes nothing: symbols live on representations,
resolution reads the registry's curated listings and aliases, and an
unregistered contract is `UNKNOWN` no matter what its metadata says (§5).

## 4. Representation identity

A representation is one concrete tokenized instrument, identified as
CAIP-19-shaped chain plus contract:

```
eip155:42161/erc20:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

- **`ticker + chain` is not identity** and is not accepted as one.
- Chain identity is the kernel's chain vocabulary (`eip155:<chainId>`), never an
  RPC URL, hostname or network name.
- Contract addresses are validated and normalized to lowercase. A mixed-case
  address is accepted **only if its EIP-55 checksum verifies**; an all-lowercase
  address is accepted as already canonical; anything else is rejected. A broken
  checksum is a rejection, never a repair.
- Changing a contract address is a **different representation**, and a property
  test asserts the identity changes with it.
- A representation belongs to exactly one canonical asset. A token claiming two
  underlyings is not modelled.

## 5. Unregistered contracts

```
unregistered contract  !=  valid representation
```

An unknown representation id is `REPRESENTATION_UNKNOWN` and is never
admissible. It does not become admissible because a ticker matches, a symbol
matches, token metadata says `NVDA`, or an agent or tool asserts it does.

This is structural, not a check that could be forgotten:
`evaluateRepresentation` accepts an **id** and resolves it through the snapshot.
There is no signature by which a caller can hand the registry a record it
invented and receive an admissibility verdict for it.

## 6. Representation semantics and claims

Every security-relevant property is a `ClaimSet<T>` — zero or more claims, each
carrying the kernel's `Provenance` (trust class, source id, observation time).
Identity is not a claim set; everything semantic is, including the binding to the
canonical underlying, because that binding is exactly what can be forged.

| Property | Vocabulary |
| --- | --- |
| `underlying` | A `CanonicalAssetId` |
| `issuer` | An issuer identifier |
| `instrumentType` | `BACKED_NOTE`, `DEPOSITARY_RECEIPT`, `FUND_SHARE`, `SYNTHETIC_EXPOSURE`, `DEBT_INSTRUMENT` |
| `backing` | `FULLY_BACKED`, `PARTIALLY_BACKED`, `COLLATERALIZED`, `DEBT_LINKED`, `SYNTHETIC`, `UNBACKED` |
| `redemption` | `NONE`, `QUALIFIED_HOLDERS_ONLY`, `OPEN_REDEMPTION`, `ISSUER_DISCRETION` |
| `rights` | Per right: `economicExposure`, `dividendTreatment`, `votingRights`, `redemptionRights`, `beneficialOwnership`, `transferability` |
| `corporateActionHandling` | `SUPPLY_REBASE`, `ON_CHAIN_MULTIPLIER`, `ISSUER_ACCOUNTING_ADJUSTMENT`, `CASH_DISTRIBUTION`, `NOT_APPLIED` |
| `settlement` | `ATOMIC_ON_CHAIN`, `DEFERRED`, `ISSUER_CONFIRMED` |
| `operationalStatus` | `ACTIVE`, `PAUSED`, `TRANSITION`, `DEPRECATED` |
| `eligibility` | Permitted and prohibited jurisdictions |

Two rules about this vocabulary:

- **There is no `isRealStock` boolean.** Rights are explicit per-right claims
  with their own provenance, because the nuance is the reason Mandate exists.
  A representation may pass dividends and carry no votes; that is two different
  facts and it is recorded as two.
- **Synthetic status is derived from `backing`, not stored beside it.** Storing
  both invites them to disagree. `SYNTHETIC` and `UNBACKED` are synthetic;
  `FULLY_BACKED` is not; `PARTIALLY_BACKED`, `COLLATERALIZED` and `DEBT_LINKED`
  are not *synthetic* but do not satisfy a full-backing requirement, which is
  why backing and synthetic status are separate constraints.
- **Nothing is inferred from a ticker.** A representation is not equity because
  its symbol looks like an equity symbol.

### Claim resolution

```
ESTABLISHED   one value, agreed by every claim at or above the trust floor
UNKNOWN       no claim at or above the floor  (including "claims exist, all advisory")
CONFLICT      two or more claims at or above the floor disagree
```

- The floor for anything gating execution is `VERIFIED`.
- **A claim below the floor cannot establish a value and cannot create a
  conflict.** It is retained for audit and is invisible to decisions. Letting an
  advisory claim raise a conflict would let anyone who can inject one make any
  representation inadmissible — denial of service achieved with exactly the
  input the trust model exists to neutralize.
- **A conflict fails closed unconditionally.** No most-recent-wins, no
  authoritative-beats-verified, no majority. Reasoning in
  [ADR 0006](adr/0006-representation-claims-and-conflict-policy.md).
- A claim older than the caller's maximum claim age is treated exactly as a
  sub-floor claim: it cannot establish and cannot conflict.

`UNKNOWN` and `CONFLICT` are distinct reason codes because they need different
remedies — one needs data, the other needs a curator.

## 7. Admissibility

```
admissibility = f(mandate, representation semantics, trusted registry state)
```

Never stored. Two representations may both track NVDA; under a mandate that
allows synthetics both may be admissible, and under a mandate that requires full
backing only one is. Same registry, same representations, different answer —
which is why the answer cannot live in the registry.

```
evaluateRepresentation(requirements, representationId, registry)
    -> ADMISSIBLE
     | EXCLUDED, reasonCodes[]
```

**Every exclusion explains itself, and all independent reasons are collected.**
Evaluation does not stop at the first failure, for the same reason the verifier
does not
([design §10.1](mandate-design.md#101-the-contract), property 6): "excluded" is
not an actionable answer and "excluded: wrong issuer, wrong chain, synthetic"
is.

### Requirements, and why they can only narrow

The Phase 1 mandate schema is frozen — it carries issuer, chain, synthetic
policy and canonical asset, but not backing, rights or jurisdiction constraints,
which [design §7.3](mandate-design.md#73-mvp-mandate-versus-long-term-mandate)
marks long-term. Phase 2 therefore separates:

```
deriveRequirements(mandate)            exactly the signed mandate's constraints
narrow(requirements, additional)        institutional policy, can only tighten
```

`narrow` intersects allowlists and moves policy fields toward restriction only.
An additional requirement is **not an authorization** and cannot create
admissibility — a property test asserts that adding any requirement never turns
an `EXCLUDED` representation `ADMISSIBLE`. The signed mandate is always the
floor.

### Exclusion reasons

Kernel codes are reused where the meaning is identical — `REPRESENTATION_UNKNOWN`,
`REPRESENTATION_ASSET_MISMATCH`, `ISSUER_NOT_ALLOWED`, `CHAIN_NOT_ALLOWED`,
`SYNTHETIC_NOT_ALLOWED`, `REPRESENTATION_INACTIVE`,
`REPRESENTATION_METADATA_UNKNOWN` — so integrators handle one vocabulary.
Registry-specific causes get their own namespace (`MND-REF-*`, `MND-REG-*`):
see [registry-reason-codes.md](registry-reason-codes.md). A test asserts the two
registries share no id and no name, so the vocabulary is one vocabulary and not
two overlapping ones.

## 8. The kernel bridge

The registry's output feeds the verifier; it never replaces it.

```
RepresentationRecord  ──▶  Observed<RepresentationState>  ──▶  verify(...)
```

`toRepresentationState` emits kernel trusted state **only** when `underlying`,
`issuer`, chain and backing are `ESTABLISHED` at or above the floor and
operational status is established. If any is `UNKNOWN` or `CONFLICT` it returns
an error and emits nothing. It never substitutes a permissive default — emitting
`synthetic: NO` for a representation whose backing could not be established
would convert a registry gap into an execution, which is the exact failure the
layer exists to prevent.

Registry exclusion and verifier rejection are consistent by test: for every
constraint both layers know about, a registry-excluded representation also
produces the corresponding kernel rejection.

## 9. Snapshots and reproducibility

A `RegistrySnapshot` is an immutable value: declared schema version, snapshot id,
creation time, declared source versions, canonical assets, representations, and a
`dataClass` of `SYNTHETIC_FIXTURE` or `OBSERVED`.

- **No decision reads `dataClass`.** It exists so a snapshot cannot be presented
  as live when it is not ([AGENTS.md §5](../AGENTS.md#5-honesty-requirements)),
  and a structural test asserts no decision path reads it. There is one decision
  engine, not a real one and a simulated one.
- `openRegistry(snapshot)` builds immutable indexes and returns a `Registry`
  view. No decision depends on mutable global process state.
- `snapshotDigest` is deterministic over sorted state; ordering of assets,
  representations, claims, listings and aliases cannot reach a digest or a
  decision. Encoding and versioning are
  [ADR 0007](adr/0007-registry-snapshot-encoding-and-digest.md).
- Registry schema version is independent of mandate schema version. Adding a
  metadata dimension cannot change a mandate digest.

## 10. Corporate-action metadata is not corporate-action state

Two different concerns, deliberately separated:

| | Describes | Whose job |
| --- | --- | --- |
| `corporateActionHandling` on a representation | *How* this representation applies a split or dividend | Registry metadata, Phase 2 |
| The kernel's corporate-action **epoch** | Whether the world changed since the authorization | Verifier, at execution time |

Phase 2 ingests no live corporate actions. The epoch remains the execution-time
safety mechanism; representation metadata only describes semantics. A mandate may
refuse a representation whose handling model it does not accept, and that is a
different check from the epoch check.

## 11. What Phase 2 does not do

Named so nothing downstream assumes it.

| Not done | Whose job |
| --- | --- |
| Any live data access, any API call, any database | Phase 3 adapters |
| Routing, candidate construction, ranking | Phase 4 |
| Jev or any model involvement — resolution is deterministic | Phase 5, and never in resolution |
| Execution, bridging, stablecoin funding | Phases 6–7 |
| Deciding whether registry metadata is *true* | Curation and adapters; the registry checks provenance, trust, agreement and freshness, not accuracy ([design §17.6](mandate-design.md#176-honest-statement-of-limits)) |
| Real market data | Phase 3. Every Phase 2 fixture is `SYNTHETIC_FIXTURE` |
