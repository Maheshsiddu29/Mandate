// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

/// @notice Onchain shapes of the frozen offchain objects the execution gate re-encodes.
///
/// These structs are not a second schema. Each one is the *wire form* of an
/// existing kernel object — MCE v2 for the mandate, Candidate V3 for the
/// execution candidate (ADR 0002, ADR 0014, ADR 0017) — written with Solidity
/// types whose widths are exactly the widths the kernel encoder writes. The gate
/// re-encodes them byte-for-byte and hashes the result, so a signature over the
/// kernel's digest authenticates every field the gate reads.
///
/// Two deliberate narrowings, both fail-closed:
///
/// - a party is an `address`, and is encoded as the kernel's
///   `{kind: "eip155-address", value: <lowercase hex>}`. A mandate naming any
///   other party scheme cannot be expressed here and so cannot execute through
///   the gate;
/// - enums are carried as their frozen wire codes (`codec.ts`), and an
///   unassigned code is malformed rather than defaulted.

/// @dev `Side` wire codes, frozen in `packages/kernel/src/encoding/codec.ts`.
uint8 constant SIDE_BUY = 1;
uint8 constant SIDE_SELL = 2;

/// @dev `SyntheticPolicy` wire codes.
uint8 constant SYNTHETIC_FORBIDDEN = 1;
uint8 constant SYNTHETIC_ALLOWED = 2;

/// @dev `HaltPolicy` wire codes.
uint8 constant HALT_FORBID_WHEN_HALTED = 1;
uint8 constant HALT_ALLOW_WHEN_HALTED = 2;

/// @dev Phase 6R deploys only labelled fixtures. A real market requires an
/// authenticated inclusion-time state source and is rejected by this gate.
uint8 constant MARKET_FIXTURE = 1;
uint8 constant MARKET_REAL = 2;

struct CanonicalAsset {
    string assetClass;
    string idScheme;
    string value;
}

/// @dev An amount of one unit: `atoms` scaled by `10^decimals` (INV-18).
struct Amount {
    string unit;
    uint8 decimals;
    uint256 atoms;
}

/// @dev `numeratorUnit` per `denominatorUnit`, scaled by `10^decimals`.
struct Price {
    string numeratorUnit;
    string denominatorUnit;
    uint8 decimals;
    uint256 atoms;
}

/// @notice MCE v2 `CanonicalMandate`, in encoder field order.
struct Mandate {
    uint16 version;
    bytes32 mandateId;
    uint64 nonce;
    address principal;
    address agent;
    CanonicalAsset canonicalAsset;
    uint8 side;
    Amount maxNotional;
    Amount economicLimit;
    uint16 maxDeviationBps;
    uint8 syntheticPolicy;
    string[] allowedIssuers;
    string[] allowedChains;
    string[] allowedVenues;
    uint64 requiredCorporateActionEpoch;
    uint32 maxPriceAgeSeconds;
    uint32 maxCorporateActionAgeSeconds;
    uint8 haltPolicy;
    int64 createdAtUnixSeconds;
    int64 notBeforeUnixSeconds;
    int64 expiresAtUnixSeconds;
}

/// @notice Candidate V3 `ExecutionCandidate`, in encoder field order.
struct Candidate {
    uint16 version;
    string representationId;
    CanonicalAsset canonicalAsset;
    string issuer;
    string chain;
    string venue;
    uint8 side;
    address agent;
    Amount quantity;
    Price executionPrice;
    Amount notional;
    Amount feeTotal;
    string evaluationStateId;
    bytes32 evaluationStateDigest;
    bytes32 registrySnapshotDigest;
    uint64 corporateActionEpoch;
}

/// @notice The execution-specific choices the agent makes after offchain handoff
/// verification. Everything else the gate executes is derived from the signed
/// mandate, the candidate and the gate's immutable market table.
struct ExecutionTerms {
    /// @dev Must be the mandate's principal in Phase 6 (self-custody only).
    address recipient;
    /// @dev Funding-token atoms. BUY: the most the principal may be debited.
    /// SELL: the least the principal must be credited. Checked against the
    /// signed mandate bound, then enforced against measured balance deltas.
    uint256 fundingLimit;
    /// @dev Unix seconds; execution requires `block.timestamp <= deadline`.
    uint64 deadline;
    /// @dev Opaque venue route data for the adapter, committed by hash.
    bytes executionData;
}

/// @notice Deployment-time description of one supported market. Validated and
/// reduced to `Market` by the gate's constructor; never mutable afterwards.
struct MarketConfig {
    /// @dev The tokenized representation (for example a Robinhood Stock Token).
    address representation;
    /// @dev The ERC-20 the principal pays with on BUY and is paid in on SELL.
    address fundingToken;
    CanonicalAsset canonicalAsset;
    string issuer;
    string venue;
    /// @dev Unit code the candidate's quantity must carry, e.g. `TOKEN`.
    string quantityUnit;
    /// @dev Unit code of the mandate's economic limit that `fundingToken`
    /// settles, e.g. `USD`. This is a declared funding assumption, not an
    /// equivalence claim; see docs/execution-gate.md §6.
    string settlementUnit;
    /// @dev Registry synthetic status, pinned. Must be established, never unknown.
    bool synthetic;
    /// @dev Must be `MARKET_FIXTURE` in Phase 6R.
    uint8 classification;
    /// @dev Immutable price of the engineered fixture. Real markets require an
    /// authenticated inclusion-time state source and cannot use this field.
    Price fixturePrice;
    /// @dev The fixture venue's fee, in basis points (< 10,000). The venue and
    /// its adapter are created by the gate's constructor, never supplied.
    uint16 fixtureFeeBps;
}

/// @notice The reduced, immutable market record the gate checks against.
struct Market {
    address representation;
    address fundingToken;
    /// @dev The `FixtureVenueAdapter` the gate's constructor created for this market.
    address adapter;
    uint8 representationDecimals;
    uint8 fundingDecimals;
    bool synthetic;
    uint8 classification;
    bytes32 canonicalAssetHash;
    bytes32 issuerHash;
    bytes32 venueHash;
    bytes32 quantityUnitHash;
    bytes32 settlementUnitHash;
    uint8 fixturePriceDecimals;
    uint256 fixturePriceAtoms;
}
