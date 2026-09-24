# ADR 0008: Robinhood external-data authority and normalization boundary

- **Status:** Accepted
- **Date:** 2026-09-24
- **Implements:** [design §18](../mandate-design.md#18-robinhood-chain-and-arbitrum-initial-integration)

## Context

Phase 3 is the first point at which Mandate consumes mutable external state. A
network response is not registry state merely because it came from an official
host, and an ERC-20 is not a Robinhood Stock Token merely because its symbol
matches one. The integration needs an explicit authority order and a boundary
at which untrusted JSON-RPC and HTTP values become typed Mandate records.

The official interfaces were inspected on 2026-09-24 and direct read-only
observations were made against the public mainnet API and RPC. The findings and
exact sources are recorded in [Robinhood integration](../robinhood-integration.md).

## Decision

### 1. The adapter is the only network-aware package

Robinhood HTTP and JSON-RPC data is parsed by a dedicated adapter package. Its
dependency direction is:

```
Robinhood adapter -> registry -> kernel
```

The registry and kernel remain pure and perform no I/O. The adapter emits
normalized values and provenance-carrying registry claims; external JSON never
crosses into either decision engine.

### 2. Authority is field-specific

The following sources may establish the named facts:

| Fact | Establishing source |
| --- | --- |
| Stock Token UID, deployment, status, multiplier, token decimals, ISIN | Robinhood `/rhj/assets`, cross-checked onchain where a corresponding view exists |
| Contract code, ERC-20 metadata, UID, multiplier and oracle-pause state | Robinhood Chain mainnet at a named block |
| Canonical Stock Token contract identity | Robinhood deployment address plus matching chain ID, code, UID and metadata; symbol alone never establishes it |
| Underlying bid/ask and trading halt | Robinhood `/rhj/prices/{symbol}`, observed at `generatedAt` |
| Corporate-action records | Robinhood `/rhj/corporate-actions` |
| Feed proxy address and heartbeat | Chainlink's Robinhood feed catalog |
| Token-equivalent onchain price and its observation time | Chainlink feed proxy `latestRoundData()` |
| Legal and economic semantics | RHJ issuer disclosures and official Robinhood Stock Token documentation |

Robinhood's live `isin` field is accepted as a direct authoritative observation
only after the registry's ISIN check-digit validation succeeds. A missing or
invalid ISIN is not replaced by the ticker. A separately reviewed curated
mapping may be supplied in the future, but it remains labelled `CURATED_MAPPING`
and cannot masquerade as issuer state.

### 3. Every normalized field records how it was obtained

Adapter evidence uses the closed classification:

```
DIRECT_AUTHORITATIVE_OBSERVATION
VERIFIED_DETERMINISTIC_DERIVATION
CURATED_MAPPING
ADVISORY_INFERENCE
UNKNOWN
```

The classification supplements, rather than replaces, the kernel provenance
record. Derived values identify their inputs. Unknown or advisory values do not
satisfy an execution requirement.

### 4. Recorded mainnet data is the default test surface

Committed fixtures retain the security-relevant response bodies and identify
endpoint, chain, capture time, source observation time where present, fixed
block, and SHA-256 digest. Offline tests parse those bodies with the same code
used by the live client. Live checks are opt-in and never required by `npm test`.

Capture is explicit and refuses to overwrite an existing directory. A network
failure, partial response, malformed security-critical field, chain mismatch,
rate limit, absent code, or cross-surface conflict produces an adapter error or
unknown state; none is translated into permissive trusted state.

## Consequences

The adapter can evolve with Robinhood's external schemas without adding issuer
branches to the kernel or registry. A same-symbol counterfeit remains
unregistered. Direct ISIN observations avoid a Phase 3 curated mapping for the
recorded sample, while the mapping boundary remains explicit for assets whose
identity cannot be established. The accepted cost is that schema drift or an
unavailable authoritative field stops normalization until reviewed.

