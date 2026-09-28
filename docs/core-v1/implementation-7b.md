# Mandate Core v1 — Phase 7B implementation: types and the generic action/state model

> **Status: Phase 7B architecture accepted; the Phase 7B.1 representation
> hardening ([§12](#12-phase-7b1-representation-hardening)) is implemented
> locally and awaiting review.** This document
> describes code in `packages/core`. It does not change the frozen Phase 7A
> specification in this directory, which remains normative. Where the
> specification could not be followed literally, or two parts of it disagree,
> the choice made is listed in [§9](#9-specification-gaps-and-conflicts) for
> review. No ledger, reservation engine, admission, projection, invariant
> evaluation, signature, adapter or I/O exists yet.

Phase 7B answers one question: can the Phase 7A model be written down in code
exactly, without collapsing into untyped maps, bare amounts, interchangeable
identifiers or market-specific fields? It can, with the qualifications in §9.

## Contents

1. [What was built](#1-what-was-built)
2. [Identifiers](#2-identifiers)
3. [Economic quantities](#3-economic-quantities)
4. [Authority: terms, grants and the principal policy](#4-authority-terms-grants-and-the-principal-policy)
5. [Actions and state](#5-actions-and-state)
6. [Reservation, execution and receipt references](#6-reservation-execution-and-receipt-references)
7. [Canonical encoding and validation](#7-canonical-encoding-and-validation)
8. [Tests, vectors and benchmarks](#8-tests-vectors-and-benchmarks)
9. [Specification gaps and conflicts](#9-specification-gaps-and-conflicts)
10. [Invariants: what now has representation support](#10-invariants-what-now-has-representation-support)
11. [Known limitations and what is next](#11-known-limitations-and-what-is-next)

## 1. What was built

`packages/core` (`@mandate/core`), depending only on `@mandate/kernel` and
`@noble/hashes` ([ADR 0020](../adr/0020-mandate-core-package-and-encoding.md)).

| Module | Contents |
| --- | --- |
| `brand.ts` | the compile-time brand used by every identifier and validated object |
| `errors.ts` | structured `{code, path}` errors; the codes are provisional (open question 9) |
| `primitives.ts` | integer, identifier, digest and closed-world object parsing |
| `encoding.ts` | tags, the tagged writer and reader, canonical sets, keccak-256 |
| `limits.ts` | collection bounds and `MAX_DELEGATION_DEPTH` |
| `identifiers.ts` | names, content digests, role-typed parties, resources |
| `quantity.ts` | quantity kinds, units, `EconomicQuantity`, `QuantityBound`, `Ratio`, valuation, exact arithmetic |
| `module.ts` | `ModuleRef`, `AdapterRef` |
| `state.ts` | finality, freshness, `StateRequirement`, `StateEnvelope`, `StateBinding` |
| `terms.ts` | the seven authority term kinds |
| `authority.ts` | `AuthorityGrant`, `PrincipalPolicy` |
| `action.ts` | `ActionEnvelope`, the module-bound payload digest |
| `execution.ts` | `ReservationGeneration`, `ReservationId`, `ReservationRef`, `ExecutionAuthorization`, `ExecutionBindingRef` |
| `receipt.ts` | `ReceiptHeader`, `ReceiptReferences` |

Every canonical object has the same five functions: `validateX(input)` (the
only way to obtain an `X`), `encodeX`, `decodeX` (which re-runs `validateX`),
a digest function where the object has an identity, and `xInputOf` (the
object's own input form).

## 2. Identifiers

Three families, none convertible into another without an explicit call:

| Family | Types | Form |
| --- | --- | --- |
| Names | `DomainId`, `ModuleId`, `AdapterId`, `StateSourceId`, `StateKind`, `ActionType`, `BoundId`, `DimensionId`, `InvariantId`, `FinalityLadderId`, `FinalityLevel`, `ArtifactField` | the kernel's identifier charset (ADR 0002), each a distinct brand |
| Content digests | `AuthorityId` ⊃ `MandateId`, `DelegationId`; `PrincipalPolicyId`; `ActionId`; `PayloadDigest`; `StateId`; `StateBindingId`; `ReservationId`; `ExecutionAuthorizationId`; `ExecutionBindingId`; `ReceiptId`; `ObservationId`; `ModuleDigest`; `ImplementationDigest`; `AdapterDigest`; … | `0x` + 64 lowercase hex; uppercase and mixed case are refused, never folded |
| Parties and resources | `PartyId`, `PrincipalId`, `AgentId`; `ResourceId<K>`, `MarketId`, `CanonicalAssetRef`, `RepresentationAssetRef`, `AssetId`, `AccountId`, `VenueId`, `RecipientId` | the kernel's `PartyId`; `(domain, kind, localId)` |

- A `MandateId` or `DelegationId` is produced only by `grantIdentity(grant)`,
  so a digest cannot be promoted to a root's identity without the grant.
- `PrincipalId` and `AgentId` are roles over one `PartyId`. A principal that
  holds its own root (examples §D) becomes a holder through `principalAsAgent`,
  the one sanctioned conversion.
- `ReservationGeneration`, `LedgerVersion`, `Nonce` and `PolicySequence` are
  distinct `bigint` brands. A bare `1n` is none of them.
- `ActionId`, `StateId` and every other content identity is computed, never
  accepted in place of its object.

## 3. Economic quantities

```text
EconomicQuantity<K> { kind: K, unit, decimals 0..38, atoms: bigint, asset: AssetId | null, valuation: ValuationRef | null }
QuantityBound<K>    { kind: K, unit, decimals, atoms ≥ 0 }        a limit: no asset, no price (§9 item 4)
Ratio               { numerator ≥ 0, scale 0..38 }                3x = {3, 0}; 50 bps = {50, 4}; not a quantity
ValuationRef        { price, basis: EXECUTION | LIMIT | MARK, source: STATE | OBSERVATION | ACTION, observedAt }
```

The kinds are the specification's eleven (action-state-model.md §3.2). The
brief's names map onto them as follows:

| Brief | Core kind | Signed | Asset | Valuation | Ledger-trackable |
| --- | --- | --- | --- | --- | --- |
| TokenAmount | `TOKEN_AMOUNT` | no | a representation | none | yes |
| Capital | `CAPITAL` | no | the funding asset (either form) | none | yes |
| PositionSize | `POSITION_SIZE` | yes | a canonical exposure asset | none | yes |
| CommittedNotional | `NOTIONAL` | no | a canonical exposure asset | `EXECUTION` or `LIMIT`, required | yes |
| MarkedExposure | `GROSS_EXPOSURE`, `NET_EXPOSURE` | no / yes | canonical (optional for gross) | `MARK`, required | **no** |
| Margin | `MARGIN` | no | the collateral asset | none | yes |
| Collateral | `COLLATERAL` | no | the collateral asset | none | yes |
| Debt | `DEBT` | no | the borrowed asset | none | yes |
| PnL | `PNL` | yes | none | none (realized) or `MARK` (unrealized) | realized only |
| — | `COUNT` | no | none | none; unit must be `COUNT` | yes |

Rules, each with a failure-mode test:

- **The kind is a type parameter.** `Capital`, `Margin`, `PositionSize`,
  `CommittedNotional`, `MarkedExposure` are distinct types. `addQuantities`,
  `subtractQuantities` and `compareQuantities` pin the kind to the first
  argument (`NoInfer`), so `addQuantities(capital, margin)` does not compile,
  and at run time is `QUANTITY_KIND_MISMATCH`.
- **UNIT-1 at run time.** Arithmetic requires equal kind, unit, asset,
  decimals and valuation. `quantityMismatches(a, b)` lists every difference:
  `KIND`, `UNIT`, `ASSET`, `DECIMALS`, `VALUATION`.
- **No implicit rescale, no rounding.** Different decimals are refused until
  `rescaleQuantity` is called, which is exact or refuses (`INEXACT_RESCALE`).
- **UNIT-5.** An unsigned result below zero is refused; a sum past the
  kind's `uint256` or `int256` range is refused.
- **No floating point.** Atoms are `bigint` or a canonical decimal string. A
  JavaScript `number` — including `NaN`, `Infinity` and unsafe integers — is
  refused. `parseFixedDecimal("1234.56", 2)` accepts only the canonical text at
  exactly the stated decimals.
- **Units** are canonical uppercase codes of any value (`USD`, `USDG`, `XAU`,
  `CONTRACT`, …). Core hardcodes none except `COUNT`, and refuses `usd`.
- **Basis and source agree.** An `EXECUTION` price comes only from a fill
  observation, a `LIMIT` price only from the action, a `MARK` only from an
  admitted state snapshot (`VALUATION_SOURCE_INVALID` otherwise). So a mark
  cannot be relabelled as an execution price, and committed notional is only
  ever valued at a price actually paid or, while pending, at the order's limit
  (Phase 7B.1 ruling 2).
- **No conversions.** There is no function from one kind or unit to another
  (UNIT-2, UNIT-3).

## 4. Authority: terms, grants and the principal policy

### 4.1 The seven term kinds

A closed discriminated union, `AuthorityTerm`:

| Kind | Type | Unique by | Notes |
| --- | --- | --- | --- |
| `SET` | `SetConstraintTerm` | vocabulary | vocabularies `MODULES` (exact `ModuleRef`s), `ADAPTERS` (exact `AdapterRef`s), `MARKETS`, `ASSETS`, `VENUES`, `RECIPIENTS`, `ACTION_TYPES`; members typed per vocabulary; closed world |
| `RIGHT` | `RightTerm` | right | `OPEN_RISK`, `REDUCE_RISK`, `TRANSFER_OUT`, `DELEGATE(maxDepth 1..7)` |
| `BOUND` | `PerActionBoundTerm` | `(boundId, polarity)` | `MAX` or `MIN`; value a `QuantityBound` or a `Ratio` |
| `TIME_WINDOW` | `TimeWindowTerm` | domain | an absolute per-domain window; the grant's own validity is a field |
| `LEDGER_DIMENSION` | `LedgerDimensionTerm` | `dimensionId` | the specification's `DimensionGrant` |
| `STATE_INVARIANT` | `StateInvariantTerm` | `(invariantId, version, scope)` | an `InvariantRef`; parameters are opaque module-owned bytes |
| `STATE_POLICY` | `StatePolicyTerm` | `(domain, stateKind)` | admitted sources and a `StateRequirement` |

A second term with the same key is `DUPLICATE_TERM`, because a meet or a
"no weaker" comparison is only defined when each constrained thing has one
term. Terms are stored in canonical order, so caller order never changes a
digest.

`LedgerDimensionTerm` records `accounting` (`BUDGET` | `CAPACITY`),
`restoration` (`NONE` | `EPOCH` | `AS_CHARGED` | `UNITS`, paired with its
family), `epoch` (`{anchor, lengthSeconds > 0}`, present iff `EPOCH`), `sign`
(`NET` only for signed kinds) and `scope` (`asset`, `market`, `domain`,
`account`, each typed or `null`). Marked-exposure kinds are refused as
dimensions (decision 10). No restoration accounting is implemented.

### 4.2 Grants

```text
AuthorityGrant {
  lineage     ROOT { issuer: PrincipalId } | DELEGATION { parent: AuthorityId, issuer: AgentId }
  principal   PrincipalId
  holder      AgentId
  notBefore, expiresAt        notBefore < expiresAt, required
  terms       AuthorityTerm[] ≤ 128, canonical order
  nonce       u64
}
```

Checked structurally: a root's issuer is its principal; the window is
satisfiable; terms are valid and unique. Not checked, because it needs other
grants: that a delegation's issuer is its parent's holder, and that it is a
subset of its parent (7C). Module restrictions are a `SET MODULES` term.
Signature verification is not implemented; `authorityId(grant)` is the
signable digest.

### 4.3 The principal policy

```text
PrincipalPolicy { principal, sequence u64, terms: (LEDGER_DIMENSION | STATE_INVARIANT | STATE_POLICY)[], nonce }
```

- It grants nothing. `SET` and `RIGHT` terms are refused as
  `PRINCIPAL_POLICY_GRANTS_AUTHORITY`, checked before the term's body so a
  malformed right is still named as a grant; `BOUND` and `TIME_WINDOW` are
  `PRINCIPAL_POLICY_TERM_NOT_PERMITTED`. This holds three ways: the input type
  does not admit a right (compile error), the validator refuses one, and the
  decoder refuses one smuggled in as bytes.
- The three permitted kinds stay three mechanisms: `policyDimensions` (legs on
  every charging path, 7C), `policyInvariants` (evaluated, 7D),
  `policyStatePolicy` (admission requirements, 7D).
- It may be explicitly empty, and the empty policy has its own
  `PrincipalPolicyId`. It has its own tag, so its bytes never decode as a
  grant and its digest can never be confused with an `AuthorityId`.

## 5. Actions and state

### 5.1 ActionEnvelope

```text
ActionEnvelope {
  principal: PrincipalId   authority: AuthorityId   actor: AgentId
  module: ModuleRef        actionType: ActionType   adapter: AdapterRef
  target: ResourceId       resources: set<ResourceId> ≤ 64, excluding target
  payloadDigest            validFrom < expiresAt    nonce u64
}
ActionId      = H("mandate-core/v1/action", envelope)
payloadDigest = H("mandate-core/v1/payload/" ‖ moduleDigest, payload)
```

The envelope is identical in every domain. A perp order and a spot buy differ
only in `module`, `actionType`, resources and payload digest; a field such as
`side`, `leverage` or `stateRefs` is `UNKNOWN_FIELD`. Because the module digest
is inside the payload hash, a payload cannot be lifted from one module's action
into another's.

### 5.2 StateEnvelope and StateBinding

```text
StateEnvelope { module: ModuleRef, stateKind, subject, sourceId, trustClass, observedAt,
                sequence: NONE | BLOCK | VENUE_SEQUENCE | VERSION(u64),
                validUntil | null (> observedAt), finality: FinalityRef, payloadDigest }
StateId = H("mandate-core/v1/state", envelope)

StateBinding  { stateKind, subject, sourceId, trustClass (AUTHORITATIVE | VERIFIED),
                sequence, observedAt, validUntil, finality, stateDigest: StateId,
                requirement: StateRequirement }
StateBindingId = H("mandate-core/v1/state-binding", binding)
```

The envelope is a *normalized* observation, interpreted under one exact
semantic module: it carries the full `ModuleRef`, digest included (Phase 7B.1
ruling). A raw external observation may later be module-independent evidence,
but the same observation normalized under two modules — even two versions, or
two digests of one version, in one domain — is two states with two `StateId`s,
and so two bindings. The envelope records any trust class;
admission (7D) refuses advisory state. The binding records that an
authorization relied on exactly that observation under a stated requirement.
It can hold only an admissible trust class, and no provenance field may be
omitted. `bindState(envelope, requirement)` copies every field from the
envelope and computes its digest.

### 5.3 Freshness and finality

```text
FreshnessPolicy     AGE(maxAgeSeconds u32) | BLOCKS(maxBlocksBehind u64) | SEQUENCE | VERSION(pinnedDigest, maxAgeSeconds)
StateRequirement    { freshness, minTrust: AUTHORITATIVE | VERIFIED, minFinality: FinalityRef,
                      atIssue: WITHIN_POLICY | RECHECK,
                      atExecution: NOT_REQUIRED | ENFORCED_BY_ARTIFACT(field) | BOUNDED_BY_FRESHNESS }
FinalityRef         { ladder: FinalityLadderId, level: FinalityLevel }
```

The four modes do not share a representation. `AGE` is a duration in seconds
(`u32`); `BLOCKS` is a block count (`u64`); `SEQUENCE` carries no number at all,
because its bound is the ledger's reconciliation watermark for the subject;
`VERSION` is a pinned version identity (a 32-byte digest) together with an age
bound on how long the pinned version may be relied on. Each mode has exactly
its own fields, so a duration offered to `BLOCKS` or `SEQUENCE`, a block count
offered to `AGE` or `SEQUENCE`, or a number offered as a pinned version is
refused at compile time and at run time.

There is no global interval. `BOUNDED_BY_FRESHNESS` with `BLOCKS` or `SEQUENCE`
is refused (`EXECUTION_DEPENDENCE_INCOMPATIBLE`), because block and sequence
distance have no fixed time for an artifact to expire at. Finality is a named
level on a declared ladder, so observed, acknowledged, venue-final, chain-final
and module-defined levels are all expressible (`{evm.block, FINALIZED}`,
`{venue-l.order, ACKNOWLEDGED}`, …). Core implies no order between ladders; the
ladder's order is its declarer's. Nothing is evaluated.

## 6. Reservation, execution and receipt references

```text
ReservationGeneration   u64 ≥ 1                     (0 is an intent before any reservation: GENERATION_ZERO)
ReservationId           H("mandate-core/v1/reservation", actionId, generation)
ReservationRef          { action, generation, principal, lineage: AuthorityId[1..8] leaf→root,
                          policy: PrincipalPolicyId, module: ModuleRef, implementation: ImplementationDigest,
                          adapter: AdapterRef, ledgerVersion }
ExecutionAuthorization  { reservation: ReservationRef, stateBindings: set<StateBinding>, attemptCeiling }
ExecutionBindingRef     { authorization: ExecutionAuthorizationId, action, generation, module, adapter,
                          stateBindings: set<StateBindingId>, parameters: ExecutionParametersDigest }
ReceiptHeader           { kind, coreVersion, principal, ledgerBefore, ledgerAfter | null (version advances),
                          previousReceipt | null, evaluatedAt }
ReceiptReferences       { lineage, policy, action, module, implementation, adapter, stateBindings,
                          reservation: {reservationId, generation} | null, executionBinding | null, observation | null }
```

- The generation is explicit everywhere a reservation is named, part of the
  `ReservationId`, and never defaulted. `checkBindingMatchesAuthorization`
  refuses a binding whose generation, action, module, adapter or authorization
  digest differs from the authorization's. A receipt's reservation pointer must
  equal `H(action, generation)`.
- State bindings are not compared between a binding and its authorization. A
  committed `REVALIDATE` legitimately replaces them (examples §F), and which
  set is current is a ledger fact (7D).
- The receipt objects are structural components for 7H. They have encodings
  so they round-trip and are pinned, but no identity: neither is a receipt.

## 7. Canonical encoding and validation

Specified in [ADR 0020](../adr/0020-mandate-core-package-and-encoding.md). In
brief: `str(tag) ‖ u16(1) ‖ body`, with length-prefixed per-type tags carrying
`mandate-core/v1/…`; big-endian fixed-width integers; `i256` for signed atoms;
`u8` presence flags; sets sorted by encoded bytes and strictly ascending on
decode; explicit enum wire codes; keccak-256 over the tagged encoding.

Validation:

- **Closed world.** Every input object must have exactly its fields;
  `UNKNOWN_FIELD` and `MISSING_FIELD` name the field. Optional fields are
  explicit `null`.
- **v1 decoding refuses unknown fields,** in the only form they can take in a
  binary encoding: trailing bytes, unknown wire codes, unknown versions.
  There is no extension map.
- **One path.** `decodeX` reads an input and hands it to `validateX`.
- **Structured errors.** `{code, path}`, with stable, provisional codes (see
  `CORE_ERROR_CODES`).

## 8. Tests, vectors and benchmarks

`packages/core/test`, 326 tests, all offline:

| File | Covers |
| --- | --- |
| `identifiers.test.ts` | digests, identifiers, integers (NaN, Infinity, unsafe, non-canonical), closed-world shapes, party roles, resource kinds |
| `module.test.ts` | `ModuleRef`/`AdapterRef`: no shorthand, mandatory non-zero digest, digest-only difference is a different module |
| `quantity.test.ts` | per-kind asset and valuation rules, signedness, units, UNIT-1 compatibility and arithmetic, exact rescale, bounds, ratios, fixed-point text |
| `state.test.ts` | envelopes, freshness modes, requirement rules, bindings |
| `authority.test.ts` | the seven term kinds, dimension rules, duplicate terms, grants, the principal policy's refusals |
| `action.test.ts` | the domain-independent envelope, refusals of domain fields, payload digests |
| `execution.test.ts` | generations, reservation refs, authorization/binding consistency, receipt components |
| `roundtrip.test.ts` | for all 13 object types: validate → encode → decode → validate → encode is byte-identical; the object's own input form and its JSON form give the same bytes; truncation at every length, trailing bytes, wrong version and every single-byte corruption refused or canonical; wrong tag, non-canonical order, bad flag, unknown code; order-independence of construction |
| `mutation.test.ts` | 12 suites over 11 object types: every input field mutated at least once (enforced), every mutant valid, every digest distinct |
| `types.test.ts` | compile-fail checks, run by the typecheck: `PrincipalId`≠`AgentId`, `ActionId`≠`StateId`, `AuthorityId`⊅`MandateId`, `Capital`≠`Margin`, `PositionSize`≠`MarkedExposure`, `ModuleRef`≠`AdapterRef`, generation≠version≠nonce, no literal `ModuleRef` or quantity, no right in a policy input, no domain field in an action input |
| `examples.test.ts` | examples A–J of the Phase 7A specification, represented (§8.1) |
| `corpus.test.ts` | the committed corpus equals the generator's output and reproduces |
| `structure.test.ts` | dependencies, imports, no I/O, clock or randomness, no `any`/`unknown`/`Record`, no float parsing, no venue names, no Phase 6 dependency |

### 8.1 Phase 7A examples represented

| Example | Represented | Not represented in 7B |
| --- | --- | --- |
| A cross-domain capital | the root's three dimensions; capital 800 + 600 = 1,400 exactly; capital ≠ margin ≠ notional; the leverage table; USD vs USDG incomparable | the availability check (7C) |
| B cross-venue pending exposure | two markets, one canonical exposure asset; worst case at `LIMIT` from the action; fills at `EXECUTION` from observations; resubmission is the same `ActionId`; a notional without exposure asset is unrepresentable (SCOPE-1) | reservation state and release (7C/7D) |
| C two agents | sibling ceilings summing past the parent's; lineages through the shared parent; the committed ledger version | CAS (7C) |
| D delegation | R0, D1, D2 bad and D2 good as valid objects carrying every attempted widening, typed; depth 0 as the absence of `DELEGATE`; the principal holding R0 | refusal of widening, the meet (7C); revocation objects |
| E retry (included beyond the brief) | two generations, two reservations and authorizations; a generation-1 binding refused against a generation-2 authorization | observations (7D) |
| F state after CAS | per-kind requirements (`RECHECK` mark, `SEQUENCE` account); bindings; the authorization at v58; a revalidated binding set naming the same authorization | issue-time admission and revalidation (7D) |
| G multiple roots | two roots, one policy with a global dimension, its `PolicyId` on the reservation; the empty policy distinct | charging-path availability (7C) |
| H profit | every restoration mode; cost basis, proceeds and profit as three kinds, profit not addable to capital; a larger limit is a different grant | restoration accounting (7C) |
| I module binding | one order under v1 and v2 is two actions and two payload digests; a v1-only module set excludes v2 and a patched v2; implementation digest in the reservation's identity | registry, conformance (7C) |
| J drift | the evidence snapshot and binding; the signed native discrepancy either way; marked-exposure drift as a `MARK`-valued `NET_EXPOSURE` for invariant evaluation; committed-notional drift only as `NOTIONAL` at `EXECUTION` from a fill observation, with a mark (or a snapshot relabelled as a fill) refused (§9 item 7, ruled) | `DRIFT_*` events (7C) |

### 8.2 Vectors

`corpus/core-v1/vectors.json` ([README](../../corpus/core-v1/README.md)): 31
object vectors across all 13 types (readable input, canonical bytes, digest),
4 derivations (`ReservationId`, module-bound payload digest), and 13 negative
vectors with the refusal code a decoder must produce. Generated by
`npm run core-corpus:generate` and included in `npm run generated:check`.

### 8.3 Benchmarks

`npm run core:benchmark`: already-validated objects, median of 7 rounds ×
2,000 iterations, Node v22.21.0 on the development machine. Machine-dependent;
reported, not asserted.

| Object | Encoded bytes | Encode (µs) | keccak-256 (µs) |
| --- | ---: | ---: | ---: |
| ActionEnvelope | 434 | 9.4 | 16.4 |
| StateBinding | 222 | 5.1 | 8.4 |
| AuthorityGrant (11 terms) | 889 | 21.1 | 28.7 |
| PrincipalPolicy (3 terms) | 363 | 8.4 | 12.4 |
| ExecutionAuthorization (1 binding) | 609 | 13.1 | 20.4 |

Nothing is pathological: sizes are linear in content, and hashing, not
encoding, dominates. No optimization was attempted.

## 9. Specification gaps and conflicts

Each item is a place where the frozen specification, or the Phase 7B brief,
could not be followed literally. None required an untyped escape hatch. Each
choice is minimal and needs owner review.

| # | Where | Issue | Choice made |
| --- | --- | --- | --- |
| 1 | brief §16 vs action-state-model §4.1 | The brief asks the action envelope to carry "action identity", "creation time" and "required state references/bindings". The specification makes `ActionId` the envelope's digest, has `validFrom`/`expiresAt` and no creation time, and excludes state references on purpose (ADR 0017's lesson) | Followed the specification. State provenance is bound where the specification puts it: on `ExecutionAuthorization`, `ExecutionBindingRef` and `ReceiptReferences` |
| 2 | brief §17; action-state-model §2 vs §5.1 | The brief asks for a `ModuleRef` in the state envelope, and §2 says a snapshot "naming" a module is checked. §5.1's field list has `domain: DomainId` | **Ruled (7B.1):** the normalized `StateEnvelope` carries the complete `ModuleRef`, which is part of its identity. Raw external evidence may later be module-independent; a `StateEnvelope` is not |
| 3 | action-state-model §5.1 vs §5.5 | `StateSnapshot` has no finality field, but `StateBinding.finality` is "the level the snapshot was observed at" | Added `finality: FinalityRef` to `StateEnvelope`, since the binding cannot be derived without it |
| 4 | authority-ledger §3 vs action-state-model §3.2 | `DimensionGrant.limit` is an "`EconomicQuantity`, same kind and unit", but a `NOTIONAL` quantity must carry exactly one valuation, and a limit on notional committed at many prices has none | Limits and quantity bounds are `QuantityBound` (kind, unit, decimals, atoms, no asset, no valuation). Asset scoping is the dimension's `scope`. The dimension's kind and unit are its limit's, written once |
| 5 | action-state-model §3.1 | `ValuationRef.source` is `StateDigest \| ObservationId`, but a worst case at `LIMIT` takes its price from the action | Added a third source kind, `ACTION` (the `ActionId`) |
| 6 | action-state-model §2 | One `asset` resource kind, but canonical assets and representations must be distinct types (INV-6) | Two resource kinds, `CANONICAL_ASSET` and `REPRESENTATION_ASSET`. Exposure kinds require the canonical form; `TOKEN_AMOUNT` requires a representation |
| 7 | examples §J vs action-state-model §3.2 | The adverse-drift charge "+0.01 BTC valued at the admitted mark → +1,000.00" is charged to a `NOTIONAL` dimension, but `NOTIONAL` admits only `EXECUTION` or `LIMIT` valuation | **Ruled (7B.1):** the refusal stands; quantity compatibility is not weakened. Marked-exposure drift is a `MARK`-valued `GROSS_EXPOSURE`/`NET_EXPOSURE` from the admitted snapshot and changes state and invariant evaluation only. Committed-notional drift requires execution evidence: a `NOTIONAL` at `EXECUTION` from a fill observation. The frozen examples.md §J text is unchanged; this ruling supersedes its "valued at the admitted mark" charge |
| 8 | action-state-model §4.1 vs decision 26 | The intent's `adapter` is an `EnforcementAdapterId` (identifier + version), but decision 26 binds adapters by `AdapterRef` with digest | `AdapterRef` everywhere, including grants' `ADAPTERS` sets |
| 9 | brief §8, §10, §19, §27 | The brief's kind names, "basis points" and "ratio" as units, freshness names (`BLOCK_DISTANCE`, `SEQUENCE_DISTANCE`, `PINNED_VERSION`, milliseconds) and "reject zero precision" differ from the specification | Followed the specification: its eleven kinds (mapped in §3), `Ratio` as a separate type, the specification's four freshness modes — `AGE` a duration in seconds, `BLOCKS` a block count, `SEQUENCE` bounded by the ledger watermark with no distance, `VERSION` a pinned digest with an age bound (§5.3) — and decimals 0..38 (0 is valid, as in the kernel's `Amount`) |
| 10 | roadmap 7B vs this brief | The roadmap lists "the authority meet", "the domain module interface" and AUTH-2 property tests under 7B. This brief forbids subset logic and later-phase business logic | Not built. **Assigned (7B.1):** the authority meet, effective-lineage computation and AUTH-2 to 7C (Authority Graph + Global Authority Ledger); the executable `DomainModule` interface to 7D (Invariant + Reservation Engine) |
| 11 | action-state-model §5.1 | `StateSnapshot.attestation` (a source signature) sits inside the digested envelope | Not in `StateEnvelope`: a signature is carried beside the digest it signs, never inside it. Attestations are Phase 10 |
| 12 | reservations-reconciliation §4 | The brief's `ReservationRef` list omits the adapter and implementation digest; the specification's reservation fixes both for the lifecycle | Included both |
| 13 | quantity asset rule | `CAPITAL` carries its funding asset, so capital in two different funding representations cannot be added as quantities (UNIT-1) | Consistent with UNIT-1. The ledger sums a dimension by measure and scope (7C); the example fixtures use one funding asset |

Not represented, and out of the brief's scope: `Revocation` (tag reserved),
`Observation` (tag reserved), `ModuleManifest` (tag reserved), per-kind receipt
bodies, `Contribution`, `InvariantResult`, `degradedStatePolicy` (its only v1
value, `NONE`, is implicit).

## 10. Invariants: what now has representation support

Representation support means the types and encodings make the invariant
expressible, or its violation unrepresentable, at this layer. It does **not**
mean the invariant is established. Enforcement comes with the mechanism in a
later phase.

| Invariant | Status after 7B |
| --- | --- |
| UNIT-1 | **Established for Core arithmetic**: type error where the kind is static, `QUANTITY_*_MISMATCH` at run time. Module rules that label the wrong kind remain per-module |
| UNIT-2, UNIT-3 | Structural: no kind or unit converter exists in Core |
| UNIT-5 | **Established for Core arithmetic** |
| UNIT-4 | Not yet: no rounding exists; rescale is exact-or-refuse |
| DOM-2 | Representation: `ModuleRef` and `AdapterRef` require their digest, which is in every action, grant set, reservation, binding and receipt reference; implementation digest on the reservation. Registry and conformance enforcement: 7C |
| STATE-4 | Representation: a `StateBinding` cannot omit a provenance field or its requirement; authorizations and bindings commit to their binding sets |
| STATE-5 | Representation: `atIssue` and `atExecution` are recorded, and `BOUNDED_BY_FRESHNESS` is restricted to time-based freshness. Enforcement: 7D and the adapters |
| REPLAY-1 foundations | `ActionId` is content and covers the nonce; generation ≥ 1 is part of `ReservationId` |
| RECON-2 foundations | the generation is explicit in every reservation reference, binding and receipt pointer; a mismatched binding is refused |
| AUTH-GLOBAL-1 representation | a separate, separately tagged `PrincipalPolicy` that cannot hold a granting term |
| LEDGER-GRANT-1 representation | `GRANTED` is a signed `QuantityBound` inside a digest; no Core function writes it |
| SCOPE-1 representation | exposure-kind quantities cannot exist without a canonical exposure asset |
| RECEIPT-1 foundations | `ReceiptReferences` names every lifecycle object by digest |
| PHASE6-1 | Holds: no Phase 6 file changed; `generated:check` reproduces every Phase 6 artifact byte for byte |
| AUTH-1…5, AUTH-2, LEDGER-1…6, LEDGER-RESTORE-1, CONC-1, CORE-CONC-1, STATE-1…3, FAIL-1, EXEC-1…6, CRED-1, RECON-1/3/4/5, TIME-1, DRIFT-1…3, RECEIPT-2/3, DOM-1, CORE-1, PROJ-1, SETTLE-MONO | **Not established.** Their mechanisms are later phases |

## 11. Known limitations and what is next

- **No semantics beyond structure.** Nothing decides, admits, projects,
  evaluates, reserves or reconciles. A widening delegation is a valid object.
- **No signatures.** Digests are signable; nothing signs or verifies.
- **Provisional error codes** (open question 9).
- **Opaque invariant parameters.** Core cannot compare two invariants'
  parameters; `noWeaker` is each definition's, when modules exist.
- **Brands are compile-time.** Every rule is also enforced at run time, as in
  the kernel (ADR 0003).
- **Next (on approval):** Phase 7C, Authority Graph + Global Authority Ledger.

## 12. Phase 7B.1 representation hardening

Four owner rulings, implemented without starting 7C:

1. **`StateEnvelope` is bound to an exact `ModuleRef`** (§5.2, §9 item 2). The
   complete `{domainId, moduleId, moduleVersion, moduleDigest}` replaces the
   bare `DomainId` in the envelope, its encoding and its `StateId`.
2. **Mark-priced values never satisfy committed notional** (§3, §9 item 7). The
   `NOTIONAL` basis rule is unchanged, and each valuation basis now requires its
   own source kind, so a mark cannot be relabelled as an execution price.
   Example J represents marked drift as invariant input and committed-notional
   drift as fill-evidenced notional.
3. **Roadmap** (§9 item 10). 7C is now Authority Graph + Global Authority Ledger
   and owns the meet, effective lineage and AUTH-2; 7D is now Invariant +
   Reservation Engine and owns the executable `DomainModule` interface. None
   is implemented.
4. **Freshness representations** (§5.3). The implementation already kept the
   four modes distinct; only this document's wording (§9 item 9, "in seconds")
   was wrong and is corrected. Tests now pin the distinctions at compile time
   and at run time.

**Import-boundary audit.** Core imports exactly nine kernel symbols: `ok`,
`err`, `Result`, `ByteReader`, `ByteWriter`, `parseIdentifier`, `Identifier`,
`parsePartyId` and `TrustClass`. None carries MCE, candidate, spot, verifier or
Phase 6 semantics, and `structure.test.ts` now fails if any other symbol is
imported. Two facts are recorded rather than changed: `parsePartyId` is defined
in the kernel's `mandate.ts` (its body is only the `PartyId` shape check the
specification says to reuse), and importing the kernel's package entry point
loads the whole kernel module graph at run time without using any of it.
