# Public trust boundaries

> **Status: Phase 5R.3, implemented.** This inventory covers the exported
> plain-value construction and decision entrypoints in the kernel, registry,
> router and Jev packages. The executable inventory is
> `packages/jev/test/public-boundaries.test.ts`.

## Policy

Every relevant exported function is one of two kinds.

**A. External/plain-value boundary.** The function accepts ordinary runtime
values and follows one path:

```text
unknown/plain value -> strict parse -> validated internal value -> core logic
```

Wrong runtime shapes produce the function's typed refusal and do not throw.
For decision functions that means a rejecting receipt, `Result` error,
`INVALID_INPUT`, or `false` for the deliberately boolean `isAvailable`
predicate. Parser helpers return `Result` errors, `undefined`, `false`, or the
neutral `UNKNOWN` advisory context declared by their public type. Refusal does
not mutate caller-owned values.

**B. Validated internal API.** The function accepts a parsed, branded or
otherwise narrow internal type. It does not repeat the external parse and may
throw if a caller defeats its TypeScript contract. Canonical encoders are the
clearest example: a writer assertion indicates that a parser was bypassed, not
a financial rejection. The router's `RoutingEvaluation` and `RoutingContext`
carry private module brands backed by module-owned `WeakSet`s; serialized,
copied or hand-built lookalikes cannot enter the internal selection core.

The totality guarantee covers ordinary parsed/plain values: JSON values,
adapter translations, deserialized records and normal JavaScript objects. It
does not cover hostile `Proxy` traps or throwing getters. Such values already
execute code inside the host process; defending against them would require a
separate isolation boundary.

## A: external decision boundaries

The shared regression matrix covers all ten:

- kernel: `verify`, `applyTransition`, `isAvailable`;
- registry: `openRegistry`;
- router: `collectProviderRoutes`, `evaluateRoutes`, `route`,
  `selectEvaluated`, `resolveHandoff`;
- Jev: `selectWithJev`.

`selectEvaluated` validates that its evaluation was produced by
`evaluateRoutes` before destructuring it. `resolveHandoff` validates the same
module-owned context identity before reading evaluation time, registry state or
digests. `selectWithJev` validates its top-level object and its policy,
transport, advisory map, circuit, clock callback and verifier seams before
reading or using them. A malformed advisory request is `INVALID_INPUT`; it
cannot create a candidate, select a route or bypass handoff verification.

## A: external construction boundaries

The same test inventory covers these 43 exported parsers and neutralizers:

- kernel: `parseIdentifier`, `isIdentifier`, `parseCanonicalAssetId`,
  `parsePartyId`, `parseMandate`, `parseCandidate`,
  `parseRepresentationState`, `parseMarketState`,
  `parseCorporateActionState`, `parseReplayState`, `parseTrustedState`,
  `parseAmount`, `parsePrice`, `parseProvenance`, `parseBytes32`,
  `parseUnixSeconds`, `parseDurationSeconds`, `parseBigInt`, `parseClock`,
  `parseEip712Domain`, `parseAuthorizationEnvelope`,
  `parseReplayTransition`, `parseReconciledOutcome`,
  `parseExecutionObservation`, `parseReplayRecord`;
- registry: `validateCanonicalAssetId`, `parseDisplayText`, `parseMic`,
  `parseTicker`, `parseCanonicalAssetRecord`, `parseReference`,
  `parseContractAddress`, `parseRepresentationId`,
  `parseRepresentationRecord`, `parseRegistrySnapshot`,
  `parseAdditionalRequirements`, `parseJurisdiction`;
- router: `parseProviderRouteQuote`, `parseProviderRouteSet`,
  `parseTrustedRouteCosts`;
- Jev: `parseJevChoiceResponse`, `parseJevModels`,
  `parseAdvisoryContext`.

Generic combinators that require a caller-supplied parser or key function, such
as `parseObserved`, `parseClaimSet` and `parseEnumFromVocabulary`, are B APIs:
their plain-value sub-input is parsed, but the complete function also depends on
a validated internal callback.

## B: validated internal APIs

The remaining decision-relevant exports are grouped here; convenience formatters
and reason-code metadata accessors follow the same typed-internal rule.

- kernel: arithmetic and equality helpers; verifier checks;
  `verifyAuthorization`; replay constructors and keys; canonical binary
  decoders (which require an actual `Uint8Array`), encoders, digests and receipt
  explanation;
- registry: index construction and lookup; reference resolution over an
  `AssetIndex`; requirements derivation/narrowing; claim resolution;
  representation evaluation/filtering and kernel bridging; canonical encoders
  and digests;
- router: candidate construction and router encoders/digests. The private
  `selectValidatedEvaluation` and `resolveValidatedHandoff` functions are the
  internal cores behind their A wrappers;
- Jev: closed-set construction and lookup, candidate projection, question and
  request construction, advisory receipt encoders/digests, explanation,
  bounded response reading, client/configuration objects and circuit state.

These APIs accept types produced by the A boundaries or by package-owned core
logic. They are not alternate, weaker routes from deserialized input.

## Parser/encoder domain agreement

Phase 5R.3 mechanically reviewed every fixed-width writer reached by the four
canonical parsed objects requested by the audit:

- mandate: schema version constants, enum codes and decimal scales fit `u8` or
  `u16`; identifier sets are bounded; nonce and corporate-action epoch are
  `u64`; freshness durations are `u32`; quantities are `u256`; timestamps are
  signed `i64`;
- candidate: schema and enum codes are fixed, amount fields are bounded
  `u8`/`u256`, and the corporate-action epoch is bounded `u64`;
- trusted state: representation count is bounded `u16`, enum/presence fields
  are fixed `u8`, amount fields are bounded `u8`/`u256`, provenance timestamps
  are signed `i64`, and the optional epoch is bounded `u64`;
- registry: all encoded collections are bounded at `u16`, including eligibility
  jurisdiction lists added in this phase; enum codes are fixed `u8`; claim
  observation times and snapshot creation time are signed `i64`.

`createdAtUnixSeconds` now accepts exactly `[-2^63, 2^63 - 1]`, as `bigint` or
canonical decimal text, and refuses numbers, other primitive types and values
outside that interval before hashing. Other registry timestamps enter through
the kernel's already-bounded `parseProvenance` path.

The resulting invariant is: **every successfully parsed mandate, execution
candidate, trusted state and registry snapshot is encodable without a
fixed-width range exception.**

## Regression and inventory guard

The cross-package suite executes 110 hostile decision-boundary cases (ten
boundaries times eleven shared values) and 384 construction-boundary cases.
Each case asserts no exception, fail-closed output and no input mutation. The
explicit exported-name inventory is intentional: a contributor adding a public
decision or construction entrypoint must classify it beside its peers and add
it to the matrix, making totality review part of the exported API change.
