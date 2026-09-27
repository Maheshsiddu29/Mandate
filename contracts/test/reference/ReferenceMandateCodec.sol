// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {
    Amount,
    CanonicalAsset,
    Candidate,
    HALT_ALLOW_WHEN_HALTED,
    HALT_FORBID_WHEN_HALTED,
    Mandate,
    Price,
    SIDE_BUY,
    SIDE_SELL,
    SYNTHETIC_ALLOWED,
    SYNTHETIC_FORBIDDEN
} from "../../src/MandateTypes.sol";

/// @title ReferenceMandateCodec
/// @notice The pre-optimization `MandateCodec` (commit `b2295b0`), kept verbatim
/// apart from its name and import path as the executable reference the
/// optimized production codec is differentially tested against (Phase 6R.2B).
/// It is test code: nothing deployable imports it. Do not optimize it — its
/// value is that it is the simple, byte-at-a-time implementation every earlier
/// phase reviewed and the kernel corpus pinned.
///
/// Original notice follows.
///
/// Solidity re-encoding of MCE v2 mandates and Candidate V3 candidates.
///
/// The kernel's encoder (`packages/kernel/src/encoding/codec.ts`) is the
/// specification; this library is a second implementation of it, and the
/// shared corpus in `corpus/gate-v1` asserts the two produce identical bytes.
///
/// Validation mirrors the kernel *decoder*, not its parser: the gate hashes the
/// bytes it is handed, so it must refuse exactly the byte strings the kernel's
/// decoder refuses. In particular identifier sets must already be strictly
/// ascending in encoded order — the gate never sorts, because sorting would let
/// two different calldata orderings share one digest and one signature.
///
/// Every string the gate encodes is an identifier (1..128 bytes of
/// `A-Z a-z 0-9 . _ - : /`, no leading or trailing separator), which also keeps
/// every `u16` length prefix far inside its width, so the encoding is injective.
library ReferenceMandateCodec {
    /// @dev Kernel `IDENTIFIER_MAX_LENGTH`.
    uint256 internal constant IDENTIFIER_MAX_LENGTH = 128;
    /// @dev Kernel `MAX_SET_SIZE`.
    uint256 internal constant MAX_SET_SIZE = 1024;
    /// @dev Kernel `MAX_DECIMALS`.
    uint8 internal constant MAX_DECIMALS = 38;

    uint16 internal constant MANDATE_SCHEMA_VERSION = 2;
    uint16 internal constant CANDIDATE_SCHEMA_VERSION = 3;

    /// @dev `DomainTag` values from the kernel codec. ASCII, no length prefix.
    bytes internal constant MANDATE_TAG = "MANDATE.MANDATE.V2";
    bytes internal constant CANDIDATE_TAG = "MANDATE.CANDIDATE.V3";

    /// @dev The only party scheme the gate can express.
    bytes internal constant PARTY_KIND_EIP155_ADDRESS = "eip155-address";

    enum Validity {
        VALID,
        UNSUPPORTED_VERSION,
        MALFORMED
    }

    // ------------------------------------------------------------------
    // Validation
    // ------------------------------------------------------------------

    /// @notice Whether `m` is a byte string the kernel's `decodeMandate` accepts.
    /// @dev The version is checked first because the kernel decoder reports an
    /// unknown version as unsupported before reading anything else.
    function validateMandate(Mandate calldata m) internal pure returns (Validity) {
        if (m.version != MANDATE_SCHEMA_VERSION) return Validity.UNSUPPORTED_VERSION;
        if (!isCanonicalAsset(m.canonicalAsset)) return Validity.MALFORMED;
        if (m.side != SIDE_BUY && m.side != SIDE_SELL) return Validity.MALFORMED;
        if (!isAmount(m.maxNotional) || !isAmount(m.economicLimit)) return Validity.MALFORMED;
        if (m.syntheticPolicy != SYNTHETIC_FORBIDDEN && m.syntheticPolicy != SYNTHETIC_ALLOWED) {
            return Validity.MALFORMED;
        }
        if (!isIdentifierSet(m.allowedIssuers)) return Validity.MALFORMED;
        if (!isIdentifierSet(m.allowedChains)) return Validity.MALFORMED;
        if (!isIdentifierSet(m.allowedVenues)) return Validity.MALFORMED;
        if (m.haltPolicy != HALT_FORBID_WHEN_HALTED && m.haltPolicy != HALT_ALLOW_WHEN_HALTED) {
            return Validity.MALFORMED;
        }
        // Kernel `parseMandate`: an empty or inverted validity window is malformed.
        if (m.notBeforeUnixSeconds >= m.expiresAtUnixSeconds) return Validity.MALFORMED;
        // Kernel `parseMandate`: both economic bounds must name one currency.
        if (!equal(m.maxNotional.unit, m.economicLimit.unit)) return Validity.MALFORMED;
        return Validity.VALID;
    }

    /// @notice Whether `c` is a byte string the kernel's `decodeCandidate` accepts.
    function isValidCandidate(Candidate calldata c) internal pure returns (bool) {
        if (c.version != CANDIDATE_SCHEMA_VERSION) return false;
        if (!isIdentifier(c.representationId)) return false;
        if (!isCanonicalAsset(c.canonicalAsset)) return false;
        if (!isIdentifier(c.issuer) || !isIdentifier(c.chain) || !isIdentifier(c.venue)) return false;
        if (c.side != SIDE_BUY && c.side != SIDE_SELL) return false;
        if (!isAmount(c.quantity) || !isPrice(c.executionPrice)) return false;
        if (!isAmount(c.notional) || !isAmount(c.feeTotal)) return false;
        if (!isIdentifier(c.evaluationStateId)) return false;
        return true;
    }

    /// @notice Kernel `parseIdentifier`, byte for byte.
    function isIdentifier(string calldata s) internal pure returns (bool) {
        return isIdentifierBytes(bytes(s));
    }

    function isIdentifierBytes(bytes memory b) internal pure returns (bool) {
        uint256 n = b.length;
        if (n == 0 || n > IDENTIFIER_MAX_LENGTH) return false;
        for (uint256 i = 0; i < n; ++i) {
            uint8 ch = uint8(b[i]);
            bool alnum = (ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a);
            // . _ - : /
            bool separator = ch == 0x2e || ch == 0x5f || ch == 0x2d || ch == 0x3a || ch == 0x2f;
            if (!alnum && !separator) return false;
            if (separator && (i == 0 || i == n - 1)) return false;
        }
        return true;
    }

    function isCanonicalAsset(CanonicalAsset calldata a) internal pure returns (bool) {
        return isIdentifier(a.assetClass) && isIdentifier(a.idScheme) && isIdentifier(a.value);
    }

    function isAmount(Amount calldata a) internal pure returns (bool) {
        return isIdentifier(a.unit) && a.decimals <= MAX_DECIMALS;
    }

    function isPrice(Price calldata p) internal pure returns (bool) {
        return isIdentifier(p.numeratorUnit) && isIdentifier(p.denominatorUnit) && p.decimals <= MAX_DECIMALS;
    }

    /// @notice Kernel decoder `readIdentifierSet`: bounded, every element an
    /// identifier, strictly ascending by (length, bytes). Strictness also
    /// excludes duplicates.
    function isIdentifierSet(string[] calldata values) internal pure returns (bool) {
        uint256 n = values.length;
        if (n > MAX_SET_SIZE) return false;
        for (uint256 i = 0; i < n; ++i) {
            if (!isIdentifier(values[i])) return false;
            if (i > 0 && compareEncoded(bytes(values[i - 1]), bytes(values[i])) >= 0) return false;
        }
        return true;
    }

    /// @notice Kernel `compareIdentifierBytes`: length first, then bytes.
    /// @return -1, 0 or 1.
    function compareEncoded(bytes memory a, bytes memory b) internal pure returns (int256) {
        if (a.length != b.length) return a.length < b.length ? int256(-1) : int256(1);
        for (uint256 i = 0; i < a.length; ++i) {
            if (a[i] != b[i]) return uint8(a[i]) < uint8(b[i]) ? int256(-1) : int256(1);
        }
        return 0;
    }

    // ------------------------------------------------------------------
    // Encoding
    // ------------------------------------------------------------------

    /// @notice MCE v2 bytes of `m`. Callers must validate first.
    function encodeMandate(Mandate calldata m) internal pure returns (bytes memory) {
        bytes memory head = abi.encodePacked(MANDATE_TAG, m.version, m.mandateId, m.nonce);
        bytes memory parties = bytes.concat(encodeParty(m.principal), encodeParty(m.agent));
        bytes memory economics = abi.encodePacked(
            m.side, encodeAmount(m.maxNotional), encodeAmount(m.economicLimit), m.maxDeviationBps, m.syntheticPolicy
        );
        bytes memory sets = bytes.concat(
            encodeIdentifierSet(m.allowedIssuers),
            encodeIdentifierSet(m.allowedChains),
            encodeIdentifierSet(m.allowedVenues)
        );
        bytes memory tail = abi.encodePacked(
            m.requiredCorporateActionEpoch,
            m.maxPriceAgeSeconds,
            m.maxCorporateActionAgeSeconds,
            m.haltPolicy,
            m.createdAtUnixSeconds,
            m.notBeforeUnixSeconds,
            m.expiresAtUnixSeconds
        );
        return bytes.concat(head, parties, encodeAsset(m.canonicalAsset), economics, sets, tail);
    }

    /// @notice Candidate V3 bytes of `c`. Callers must validate first.
    function encodeCandidate(Candidate calldata c) internal pure returns (bytes memory) {
        bytes memory head = bytes.concat(
            abi.encodePacked(CANDIDATE_TAG, c.version),
            encodeString(c.representationId),
            encodeAsset(c.canonicalAsset),
            encodeString(c.issuer),
            encodeString(c.chain),
            encodeString(c.venue)
        );
        bytes memory economics = bytes.concat(
            abi.encodePacked(c.side),
            encodeParty(c.agent),
            encodeAmount(c.quantity),
            encodePrice(c.executionPrice),
            encodeAmount(c.notional),
            encodeAmount(c.feeTotal)
        );
        bytes memory provenance = bytes.concat(
            encodeString(c.evaluationStateId),
            abi.encodePacked(c.evaluationStateDigest, c.registrySnapshotDigest, c.corporateActionEpoch)
        );
        return bytes.concat(head, economics, provenance);
    }

    function mandateDigest(Mandate calldata m) internal pure returns (bytes32) {
        return keccak256(encodeMandate(m));
    }

    function candidateDigest(Candidate calldata c) internal pure returns (bytes32) {
        return keccak256(encodeCandidate(c));
    }

    /// @dev `u16` byte length, then the bytes. Callers have bounded the length.
    function encodeString(string calldata s) internal pure returns (bytes memory) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return abi.encodePacked(uint16(bytes(s).length), s);
    }

    function encodeStringMemory(string memory s) internal pure returns (bytes memory) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return abi.encodePacked(uint16(bytes(s).length), s);
    }

    /// @dev `{kind: "eip155-address", value: lowercase 0x-hex}` as two strings.
    function encodeParty(address party) internal pure returns (bytes memory) {
        return bytes.concat(
            encodeStringMemory(string(PARTY_KIND_EIP155_ADDRESS)), encodeStringMemory(Strings.toHexString(party))
        );
    }

    function encodeAsset(CanonicalAsset calldata a) internal pure returns (bytes memory) {
        return bytes.concat(encodeString(a.assetClass), encodeString(a.idScheme), encodeString(a.value));
    }

    function encodeAssetMemory(CanonicalAsset memory a) internal pure returns (bytes memory) {
        return
            bytes.concat(encodeStringMemory(a.assetClass), encodeStringMemory(a.idScheme), encodeStringMemory(a.value));
    }

    function encodeAmount(Amount calldata a) internal pure returns (bytes memory) {
        return bytes.concat(encodeString(a.unit), abi.encodePacked(a.decimals, a.atoms));
    }

    function encodePrice(Price calldata p) internal pure returns (bytes memory) {
        return bytes.concat(
            encodeString(p.numeratorUnit), encodeString(p.denominatorUnit), abi.encodePacked(p.decimals, p.atoms)
        );
    }

    /// @dev `u16` count, then each element, in the order given (already
    /// validated as strictly ascending).
    function encodeIdentifierSet(string[] calldata values) internal pure returns (bytes memory out) {
        // forge-lint: disable-next-line(unsafe-typecast)
        out = abi.encodePacked(uint16(values.length));
        for (uint256 i = 0; i < values.length; ++i) {
            out = bytes.concat(out, encodeString(values[i]));
        }
    }

    // ------------------------------------------------------------------
    // Identity helpers
    // ------------------------------------------------------------------

    /// @notice Hash of an asset's MCE encoding. Length prefixes make it
    /// unambiguous, so equal hashes mean equal `(assetClass, idScheme, value)`.
    function assetHash(CanonicalAsset calldata a) internal pure returns (bytes32) {
        return keccak256(encodeAsset(a));
    }

    function assetHashMemory(CanonicalAsset memory a) internal pure returns (bytes32) {
        return keccak256(encodeAssetMemory(a));
    }

    function equal(string calldata a, string calldata b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    /// @notice Whether `hash` is the keccak of some member of `values`.
    function contains(string[] calldata values, bytes32 hash) internal pure returns (bool) {
        for (uint256 i = 0; i < values.length; ++i) {
            if (keccak256(bytes(values[i])) == hash) return true;
        }
        return false;
    }

    /// @notice CAIP-2 chain identifier of `chainId`, as the kernel's
    /// `allowedChains` and candidate `chain` spell it: `eip155:<decimal>`.
    function caip2(uint256 chainId) internal pure returns (string memory) {
        return string.concat("eip155:", Strings.toString(chainId));
    }

    /// @notice CAIP-19-shaped representation identifier of an ERC-20, as the
    /// registry emits it: `eip155:<decimal>/erc20:<lowercase 0x-hex>`.
    function representationId(uint256 chainId, address token) internal pure returns (string memory) {
        return string.concat(caip2(chainId), "/erc20:", Strings.toHexString(token));
    }
}
