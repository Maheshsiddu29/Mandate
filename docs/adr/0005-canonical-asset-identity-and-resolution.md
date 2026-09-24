# ADR 0005: Canonical asset identifier schemes and deterministic reference resolution

- **Status:** Accepted
- **Date:** 2026-09-24
- **Implements:** [design §5.2](../mandate-design.md#52-canonical-asset-identity)

## Context

[design §5.2](../mandate-design.md#52-canonical-asset-identity) settled the
*shape* of canonical asset identity — chain-independent, contract-independent,
ticker-independent, with a `<scheme>` segment recording which external authority
establishes identity — and left the identifier vocabulary and the resolution
behaviour as **DRAFT**. Phase 1 implemented the type
(`CanonicalAssetId { assetClass, idScheme, value }`) and deliberately kept
`value` opaque to the kernel: the kernel compares identifiers, it does not
interpret them.

Phase 2 has to answer the questions the kernel left open, because Phase 2 is
where a human-supplied string first becomes a financial identity:

- which identifier schemes are admissible, and is a scheme value checked or
  merely stored;
- what a user-facing reference like `NVDA` is allowed to resolve to;
- what happens when it could mean more than one thing.

The threat this ADR exists to address is enumerated as
[design §17.2](../mandate-design.md#172-identity-and-representation):
ticker collision, and counterfeit tokens carrying a trusted-looking symbol.

## Decision

### 1. Three schemes, and their values are validated

`idScheme` is drawn from a closed vocabulary:

| Scheme | Shape | Check |
| --- | --- | --- |
| `figi` | 12 characters | Positions 1–2 a non-reserved prefix, position 3 `G`, remaining positions consonants or digits, modulus-10 double-add-double check digit |
| `isin` | 12 characters | ISO 6166: 2-letter country code, 9 alphanumeric, Luhn check digit over the letter-expanded body |
| `cusip` | 9 characters | Modulus-10 double-add-double check digit over the 8-character body |

An unrecognized scheme is rejected. A value whose check digit does not verify is
rejected as `ASSET_IDENTIFIER_INVALID`.

**Validating the check digit is the decision worth recording.** The cheaper
option — store whatever string the curator supplied — is what makes a
single-character typo silently become a *different canonical asset* that
resolves to nothing, or worse, resolves to something. A check digit is the one
piece of self-verification these identifier systems give us for free, and
declining to use it in a system whose entire premise is that financial identity
must be exact would be indefensible. The cost is that a scheme value Mandate
cannot verify cannot be registered, which is the fail-closed direction.

FIGI is preferred where available because it is issued per security per venue
and is not reassigned; ISIN and CUSIP are accepted because they are the
authorities for instruments and asset classes FIGI coverage does not reach.
`assetClass` remains a separate segment so the scheme extends beyond equities
without a redesign ([design §23](../mandate-design.md#23-expansion-beyond-equities)).

### 2. A ticker is never identity

`displayTicker`, `primaryMarketIdentifier` and every listing and alias are
**discovery inputs and display metadata**. They are not identity, and changing
one does not change identity. This is enforced structurally rather than by
comment: the canonical asset record separates an `identity` group from a
`display` group, an identity digest covers only the former, and a property test
asserts that mutating display metadata or aliases leaves both the canonical
asset id and the identity digest unchanged.

Market identifiers are **ISO 10383 MICs** (`XNAS`, `XNYS`), not exchange names.
[design §5.2](../mandate-design.md#52-canonical-asset-identity) writes its
example as `NASDAQ:NVDA`; `NASDAQ` is an exchange *name* and `XNAS` is the MIC.
Phase 2 uses the MIC as the structured market identifier, and an exchange-name
form such as `NASDAQ:NVDA` resolves only if a curator registered it explicitly
as an alias. The design document has been corrected to say so rather than left
to imply that an exchange name is a market identifier.

### 3. Resolution is deterministic, and ambiguity is an outcome

Resolution is a total function from a reference string to one of four outcomes:

```
RESOLVED    exactly one canonical asset matched
AMBIGUOUS   more than one matched — the candidates are returned, none is chosen
UNKNOWN     nothing matched
INVALID     the reference itself is not a well-formed reference
```

Four outcomes rather than a nullable result, because `null` conflates "I do not
know this" with "I know several" with "you gave me nonsense", and those require
different responses from a caller. A single-result API with a tie-break rule was
rejected outright: a tie-break is a guess about financial identity, and a guess
that is right 99% of the time is a system that buys the wrong security 1% of the
time.

**Matching is exact, over a normalized lookup key. There is no fuzzy matching,
no edit distance, and no model.** Reference normalization is confined to:
trimming surrounding ASCII whitespace, collapsing internal ASCII whitespace
runs to one space, and ASCII case-folding for comparison only. A non-ASCII
reference is `INVALID` rather than transliterated — Phase 2 does not attempt
Unicode folding, because two Unicode strings that fold together are exactly the
ambiguity [ADR 0002](0002-canonical-mandate-encoding.md) removed from
identifiers rather than resolved.

Normalization applies to the **lookup key only**. Nothing stored is rewritten,
and a resolved canonical asset id is returned exactly as the registry holds it.

### 4. Ambiguity is a property of the data, not an error in it

A registry may legitimately contain:

- one ticker used by different securities on different venues;
- one company name shared by unrelated issuers;
- an alias a curator deliberately pointed at two assets.

None of these is corrupt registry state, so none of them fails snapshot
construction. They resolve `AMBIGUOUS`, with every candidate reported, and the
caller either qualifies the reference or asks a human. The
demonstration-relevant consequence is the one
[design §9.4](../mandate-design.md#94-resolution-failure-is-a-normal-outcome)
asks for: "no route found" is a useless answer, and Mandate does not give it.

## Consequences

**Accepted costs.**

- A scheme value Mandate cannot check-digit-verify cannot be registered, even if
  it is genuine. Adding a scheme is a code change plus tests, deliberately.
- `NVDA` alone may not resolve in a registry that lists two NVDAs, and a caller
  must handle `AMBIGUOUS`. This is the intended behaviour and is the reason the
  outcome is a named case in the result type rather than an exception.
- Exchange-name references work only where curated. A user typing `NASDAQ:NVDA`
  against a registry with no such alias gets `UNKNOWN`, not a best guess.

**Gained.**

- A typo'd identifier is rejected at registration rather than becoming a
  phantom asset.
- Ticker collision cannot produce a wrong resolution, only a refusal —
  [design §17.2](../mandate-design.md#172-identity-and-representation)'s first
  row, closed by construction rather than by vigilance.
- Resolution is reproducible: same snapshot, same reference, same outcome,
  forever, which is what makes it expressible as a decision vector.
