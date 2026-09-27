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
} from "../MandateTypes.sol";

/// @title MandateCodec
/// @notice Solidity re-encoding of MCE v2 mandates and Candidate V3 candidates.
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
library MandateCodec {
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

    /// @dev Bit `c` is set iff byte `c` is a separator `. _ - : /`, which may
    /// not open or close an identifier.
    uint256 private constant IDENTIFIER_SEPARATORS = 0x800000000400e00000000000;

    /// @dev SWAR constants: a byte repeated in each of a word's 32 lanes.
    uint256 private constant LANES = type(uint256).max / 0xff; // 0x0101…01
    uint256 private constant LANE_HIGH_BITS = 0x80 * LANES;
    uint256 private constant LANE_LOW_BITS = 0x7f * LANES;

    /// @notice Kernel `parseIdentifier`: 1..128 bytes of `A-Z a-z 0-9 . _ - : /`,
    /// neither end a separator.
    /// @dev Classifies 32 bytes per step (`_outsideCharset`). The identifier's
    /// last word is read whole, so its lanes past the logical end hold whatever
    /// follows in calldata — ABI padding the decoder never checks, the next
    /// argument, or zeros past the end of calldata. Those lanes are discarded
    /// by `_leadingLanes` *after* classification; lanes never carry into one
    /// another, so they cannot affect the kept lanes either.
    function isIdentifier(string calldata s) internal pure returns (bool) {
        uint256 n = bytes(s).length;
        if (n == 0 || n > IDENTIFIER_MAX_LENGTH) return false;
        uint256 start;
        uint256 first;
        uint256 last;
        uint256 outside;
        assembly ("memory-safe") {
            // Reads only: `start` is the calldata offset the ABI decoder
            // bounds-checked for `n` bytes; every load below starts inside
            // [start, start + n). A load's bytes past calldatasize read as zero.
            start := s.offset
            first := byte(0, calldataload(start))
            last := byte(0, calldataload(add(start, sub(n, 1))))
        }
        if (_isSeparator(first) || _isSeparator(last)) return false;
        unchecked {
            // n <= 128: at most four words, and no index below can overflow.
            for (uint256 i = 0; i < n; i += 32) {
                uint256 word;
                assembly ("memory-safe") {
                    word := calldataload(add(start, i))
                }
                outside |= _outsideCharset(word) & _leadingLanes(n - i);
            }
        }
        return outside == 0;
    }

    /// @notice `isIdentifier` for a string already in memory (constructor input).
    /// @dev The same word classification over `mload`. The last load may cover
    /// up to 31 bytes past `b`'s data — other allocations or unallocated memory,
    /// never assumed zero — which `_leadingLanes` discards.
    function isIdentifierBytes(bytes memory b) internal pure returns (bool) {
        uint256 n = b.length;
        if (n == 0 || n > IDENTIFIER_MAX_LENGTH) return false;
        if (_isSeparator(uint8(b[0])) || _isSeparator(uint8(b[n - 1]))) return false;
        uint256 outside;
        unchecked {
            for (uint256 i = 0; i < n; i += 32) {
                uint256 word;
                assembly ("memory-safe") {
                    // Read only; `b + 32 + i` is inside `b`'s data because i < n.
                    word := mload(add(add(b, 32), i))
                }
                outside |= _outsideCharset(word) & _leadingLanes(n - i);
            }
        }
        return outside == 0;
    }

    /// @dev Bit 7 of each byte lane of the result is set iff that byte of `word`
    /// is outside the identifier charset; every other bit is zero.
    ///
    /// Each lane is tested on its low 7 bits `v` (0..0x7f) against the charset's
    /// four ranges `[0x2d,0x3a]` (`- . / 0-9 :`), `[0x41,0x5a]`, `[0x5f,0x5f]` and
    /// `[0x61,0x7a]`: `v + (0x80 - lo)` has bit 7 set iff `v >= lo`, and
    /// `v + (0x7f - hi)` has bit 7 set iff `v > hi`. Every addend is at most
    /// 0x53, so no lane sum exceeds 0xd2: nothing carries into the next lane or
    /// out of the word, and each lane's verdict depends on that byte alone. A
    /// set high bit (a byte >= 0x80) is outside the charset whatever `v` is.
    function _outsideCharset(uint256 word) private pure returns (uint256) {
        unchecked {
            uint256 v = word & LANE_LOW_BITS;
            uint256 inRange = ((v + 0x53 * LANES) & ~(v + 0x45 * LANES)) // [0x2d, 0x3a]
                | ((v + 0x3f * LANES) & ~(v + 0x25 * LANES)) // [0x41, 0x5a]
                | ((v + 0x21 * LANES) & ~(v + 0x20 * LANES)) // [0x5f, 0x5f]
                | ((v + 0x1f * LANES) & ~(v + 0x05 * LANES)); // [0x61, 0x7a]
            return ~(inRange & ~word) & LANE_HIGH_BITS;
        }
    }

    /// @dev A mask of the first `count` byte lanes (big-endian), all 32 when
    /// `count >= 32`: `max >> 8 * count` is zero once the shift reaches 256.
    function _leadingLanes(uint256 count) private pure returns (uint256) {
        unchecked {
            return ~(type(uint256).max >> (8 * count));
        }
    }

    function _isSeparator(uint256 ch) private pure returns (bool) {
        return (IDENTIFIER_SEPARATORS >> ch) & 1 != 0;
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
    /// @dev Equal-length operands are compared a 32-byte word at a time as
    /// big-endian integers, which orders them exactly as their first differing
    /// byte does. Both words of a pair cover the same byte range; lanes past the
    /// operands' common length hold whatever follows each in calldata and are
    /// cleared from both before comparing.
    /// @return -1, 0 or 1.
    function compareEncoded(bytes calldata a, bytes calldata b) internal pure returns (int256) {
        uint256 n = a.length;
        if (n != b.length) return n < b.length ? int256(-1) : int256(1);
        unchecked {
            // i < n <= calldata size, so no index below can overflow.
            for (uint256 i = 0; i < n; i += 32) {
                uint256 x;
                uint256 y;
                assembly ("memory-safe") {
                    // Reads only, each starting inside its decoder-checked operand.
                    x := calldataload(add(a.offset, i))
                    y := calldataload(add(b.offset, i))
                }
                uint256 keep = _leadingLanes(n - i);
                x &= keep;
                y &= keep;
                if (x != y) return x < y ? int256(-1) : int256(1);
            }
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
