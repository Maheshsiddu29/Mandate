# Registry decision-vector corpus, v1

A cross-implementation compatibility contract for Mandate's canonical asset and
representation registry: reference resolution, and mandate-constrained
representation admissibility.

> **Status: Phase 2.** Generated from `@mandate/registry`. `vectors.json` is
> committed and `packages/registry/test/corpus.test.ts` fails if it drifts from
> what the generator produces.

> **All data in this corpus is synthetic.** Every snapshot declares
> `dataClass: "SYNTHETIC_FIXTURE"`. Canonical asset *identifiers* of real
> securities are genuine public identifiers; every issuer, contract address, token
> symbol and metadata claim is fictional. Nothing here is real Robinhood, xStocks
> or Ondo data, and nothing here is real market data. See
> [What is real](#what-is-real-and-what-is-not).

## What this is for

Resolution and admissibility will eventually exist in more than one place — this
package, a simulation harness, alternate SDKs, real-data replay, and
policy checks adjacent to the on-chain gate. Divergence between two
implementations of a safety-relevant decision is a vulnerability, not a bug
([design §10.5](../../docs/mandate-design.md#105-differential-verification)).

This corpus is how they are kept in step. **Any implementation claiming to
implement Mandate registry v1 must reproduce every field of `expected` for every
vector.**

It is the registry counterpart to [`corpus/v2`](../v2/README.md), which pins the
verifier's decisions. The two are separate because they version independently: the
registry schema changes when a metadata dimension is added, and that must not
invalidate a single mandate digest
([ADR 0007](../../docs/adr/0007-registry-snapshot-encoding-and-digest.md)).

## Format

```jsonc
{
  "corpusVersion": 1,
  "registryVersion": "mandate-registry/1",
  "registrySchemaVersion": 1,
  "encoding": "Registry encoding v1, keccak-256",
  "vectorCount": 27,
  "vectors": [
    {
      "id": "registry-001",
      "family": "ONE_BACKED",
      "description": "One canonical asset, one fully-backed representation …",
      "input": {
        "snapshot": { /* a complete RegistrySnapshot */ },
        "mandate": { /* a complete CanonicalMandate */ },
        "additionalRequirements": { /* institutional policy, or null */ },
        "references": [ /* human references to resolve */ ],
        "probeRepresentationIds": [ /* identifiers to evaluate beyond those listed */ ]
      },
      "expected": {
        "snapshotDigest": "0x…",
        "resolutions": [
          { "reference": "NVDA", "status": "RESOLVED", "matchedBy": "PLAIN",
            "canonicalAssetIds": [ { "assetClass": "equity", "idScheme": "figi", "value": "…" } ] }
        ],
        "admissibleRepresentationIds": [ "eip155:42161/erc20:0x…" ],
        "decisions": [
          { "representationId": "eip155:42161/erc20:0x…", "status": "EXCLUDED",
            "reasonCodes": ["SYNTHETIC_NOT_ALLOWED"],
            "exclusions": [ { "code": "SYNTHETIC_NOT_ALLOWED", "detail": { "observed": "SYNTHETIC" } } ],
            "decisionDigest": "0x…" }
        ]
      }
    }
  ]
}
```

### Rules

- **Integers are decimal strings.** JSON has no integer type wide enough, and a
  JSON number would reintroduce IEEE-754 into a digest path
  ([ADR 0002](../../docs/adr/0002-canonical-mandate-encoding.md)). Every parser
  accepts a decimal string or a native big integer, and nothing else.
- **Vectors are self-contained.** Each `input` carries a complete snapshot, a
  complete mandate and the policy to layer on. Nothing is inherited from another
  vector or from a fixture file, so a reimplementer needs this file and the
  specification — not this repository.
- **`reasonCodes` is sorted** and deduplicated. An `ADMISSIBLE` decision has an
  empty array.
- **`exclusions` is in canonical order** — by reason-code id, then by detail — so
  it does not depend on the order checks ran in.
- **`canonicalAssetIds` carries every candidate** for an `AMBIGUOUS` resolution.
  An implementation that picked one would fail this field, which is why it is
  recorded rather than summarized.
- **Object keys are sorted** throughout, so the file has a stable diff.

### Reproducing `expected`

1. Parse `snapshot` with your implementation's strict snapshot parser and open it.
2. Compute `snapshotDigest` per
   [ADR 0007](../../docs/adr/0007-registry-snapshot-encoding-and-digest.md).
3. Parse `mandate`, derive requirements from it, and narrow by
   `additionalRequirements` if present. Use `1800000000` as the evaluation instant
   (every fixture world is built around it), and no claim-age bound unless
   `additionalRequirements` sets one.
4. Resolve each entry of `references` and compare status, `matchedBy` and
   candidates.
5. Evaluate every representation the snapshot lists under the mandate's canonical
   asset, plus every `probeRepresentationIds` entry, and compare decisions.

A mismatch in `decisionDigest` alone, with matching status and reason codes, means
the exclusion encoding differs — usually detail keys or their ordering. That still
counts as a failure: the digest is what an audit record would anchor to.

## Coverage

27 vectors, one per synthetic world, each resolving 23 references (the world's own
plus a universal set of failure modes) and evaluating every listed representation
plus any probes.

**Resolution outcomes:** all four — `RESOLVED`, `AMBIGUOUS`, `UNKNOWN`, `INVALID`.
The universal reference set is applied to every world, because a malformed
reference must be malformed against every snapshot: it covers the canonical-id
string form, the structured form, case and whitespace variation, an unknown
symbol, a near-miss name, empty and excess exchange-qualified segments, an
incomplete canonical id, a failing check digit, a lower-cased scheme value, an
unsupported scheme, non-ASCII, empty, a number and null.

**Exclusion causes:** 20 distinct reason codes. Every registry reason code is
produced by some vector except `SNAPSHOT_MALFORMED`, which is a construction-time
refusal — a malformed snapshot never becomes a vector, because a vector's input
must open. A test asserts exactly that, so the corpus doubles as a coverage map.

| Vector | Family | Admissible / evaluated |
| --- | --- | --- |
| `registry-001` | `ONE_BACKED` | 1 / 1 |
| `registry-002` | `BACKED_AND_SYNTHETIC` | 1 / 2 |
| `registry-003` | `MULTIPLE_VALID` | 2 / 2 |
| `registry-004` | `TICKER_COLLISION` | 1 / 1 |
| `registry-005` | `DUPLICATE_NAMES` | 1 / 1 |
| `registry-006` | `ALIAS_COLLISION` | 1 / 1 |
| `registry-007` | `WRONG_ISSUER` | 0 / 1 |
| `registry-008` | `WRONG_CHAIN` | 0 / 1 |
| `registry-009` | `WRONG_UNDERLYING` | 0 / 1 |
| `registry-010` | `UNKNOWN_BACKING` | 0 / 1 |
| `registry-011` | `ADVISORY_ONLY_BACKING` | 0 / 1 |
| `registry-012` | `CONFLICTING_PROVENANCE` | 0 / 1 |
| `registry-013` | `STALE_METADATA` | 0 / 1 |
| `registry-014` | `INACTIVE_REPRESENTATION` | 0 / 1 |
| `registry-015` | `DELISTED_ASSET` | 0 / 1 |
| `registry-016` | `UNREGISTERED_FAKE` | 1 / 3 |
| `registry-017` | `CORPORATE_ACTION_MISMATCH` | 0 / 1 |
| `registry-018` | `INJECTED_UNTRUSTED_CLAIM` | 1 / 1 |
| `registry-019` | `MISSING_RIGHTS` | 0 / 1 |
| `registry-020` | `RIGHTS_WRONG_STATE` | 0 / 1 |
| `registry-021` | `JURISDICTION_RESTRICTED` | 0 / 1 |
| `registry-022` | `PARTIAL_BACKING_REJECTED` | 0 / 1 |
| `registry-023` | `INSTRUMENT_TYPE_REJECTED` | 0 / 1 |
| `registry-024` | `REDEMPTION_REJECTED` | 0 / 1 |
| `registry-025` | `SETTLEMENT_REJECTED` | 0 / 1 |
| `registry-026` | `ASSET_NOT_REGISTERED` | 0 / 1 |
| `registry-027` | `MULTIPLE_EXCLUSIONS` | 0 / 1 |

## What is real and what is not

**Real:** the canonical asset identifiers of real securities — NVIDIA
(`BBG000BBJQV0`) and AMD (`BBG000BBQCY0`). A FIGI that identifies NVIDIA
identifies NVIDIA, and inventing a different one would model the problem wrongly.

**Fictional:** everything else. Every issuer (`issuer.fixture.*`), contract
address, token symbol, token name, backing claim, redemption model, rights
profile, corporate-action model, settlement model, eligibility profile and data
source is invented for exercising semantics. The two fictional canonical assets
used for collision cases (`ZZG000TSTFX6`, `QQG000QQQQ17`) are constructed to pass
check-digit validation while being visibly not Bloomberg-issued; they are not
claimed to identify any real security.

No claim in this corpus was observed from any live source. Real market data begins
in Phase 3 ([roadmap](../../docs/roadmap.md)).

## Extending it

Add a `WorldKind` to `packages/registry/src/testing/worlds.ts` and run
`npm run registry-corpus:generate`. Vector ids are permanent: a vector may be
added, and may be removed with a note, but an id is never reassigned to a
different case.

World builders deliberately carry no expected outcomes — expectations are computed
by running the implementation. A builder that encoded the answer would make every
vector derived from it vacuous.

## What this corpus does not cover

- Anything needing network or chain access. The registry has none
  ([ADR 0004](../../docs/adr/0004-registry-package-boundary.md)).
- The verifier's own decisions. Those are [`corpus/v2`](../v2/README.md).
  Cross-layer agreement is tested separately, in
  `packages/registry/test/bridge.test.ts`.
- Routing, ranking or candidate construction. Phase 4.
- Whether registry metadata is *true*. The registry checks provenance, trust,
  agreement and freshness, not accuracy
  ([design §17.6](../../docs/mandate-design.md#176-honest-statement-of-limits)).
- Performance. These are correctness vectors only.
