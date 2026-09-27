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
    bytes18 internal constant MANDATE_TAG = "MANDATE.MANDATE.V2";
    bytes20 internal constant CANDIDATE_TAG = "MANDATE.CANDIDATE.V3";

    /// @dev The first 20 bytes of every encoded party, the only party scheme the
    /// gate can express: `u16 14 ‖ "eip155-address" ‖ u16 42 ‖ "0x"`. The 40
    /// lowercase hex digits of the address follow (`_putParty`).
    bytes20 private constant PARTY_HEAD = hex"000e6569703135352d61646472657373002a3078";

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

    // Each encoder computes its exact output length, allocates one buffer and
    // writes every field into it in order. Every `_put*` takes the write
    // pointer and returns it advanced past what it wrote; `_seal` requires the
    // final pointer to be exactly the buffer's end, so a length computation and
    // a writer that ever disagreed would revert rather than hash other bytes.
    // Field order, widths and string framing are MCE v2 / Candidate V3 as the
    // kernel writes them (`codec.ts`); `ReferenceMandateCodec` in the tests is
    // the previous, concatenating implementation, and the two are compared
    // byte for byte.

    /// @dev MCE v2 bytes outside the asset, the unit strings and the sets
    /// (sized by `_assetBytes`, their lengths and `_setBytes`): tag 18, version
    /// 2, id 32, nonce 8, two parties 120, side 1, two amounts (unit prefix 2,
    /// decimals 1, atoms 32) 70, deviation 2, synthetic policy 1, tail
    /// 8 + 4 + 4 + 1 + 3 × 8 = 41.
    uint256 private constant MANDATE_FIXED_BYTES = 295;
    /// @dev Candidate V3 bytes outside the asset (`_assetBytes`) and the
    /// identifier strings' own bytes: tag 20, version 2, length prefixes of the
    /// representation, issuer, chain, venue and evaluation-state identifiers
    /// 10, side 1, party 60, quantity (prefix, decimals, atoms) 35, price (two
    /// prefixes, decimals, atoms) 37, notional 35, fee 35, two digests 64,
    /// epoch 8.
    uint256 private constant CANDIDATE_FIXED_BYTES = 307;
    /// @dev An encoded party: `PARTY_HEAD` and 40 hex digits.
    uint256 private constant PARTY_BYTES = 60;

    /// @notice MCE v2 bytes of `m`. Callers must validate first.
    function encodeMandate(Mandate calldata m) internal pure returns (bytes memory out) {
        uint256 p;
        (out, p) = _alloc(
            MANDATE_FIXED_BYTES + _assetBytes(m.canonicalAsset) + bytes(m.maxNotional.unit).length
                + bytes(m.economicLimit.unit).length + _setBytes(m.allowedIssuers) + _setBytes(m.allowedChains)
                + _setBytes(m.allowedVenues)
        );
        p = _putUint(p, uint144(MANDATE_TAG), 18);
        p = _putUint(p, m.version, 2);
        p = _putUint(p, uint256(m.mandateId), 32);
        p = _putUint(p, m.nonce, 8);
        p = _putParty(p, m.principal);
        p = _putParty(p, m.agent);
        p = _putAsset(p, m.canonicalAsset);
        p = _putUint(p, m.side, 1);
        p = _putAmount(p, m.maxNotional);
        p = _putAmount(p, m.economicLimit);
        p = _putUint(p, m.maxDeviationBps, 2);
        p = _putUint(p, m.syntheticPolicy, 1);
        p = _putSet(p, m.allowedIssuers);
        p = _putSet(p, m.allowedChains);
        p = _putSet(p, m.allowedVenues);
        p = _putUint(p, m.requiredCorporateActionEpoch, 8);
        p = _putUint(p, m.maxPriceAgeSeconds, 4);
        p = _putUint(p, m.maxCorporateActionAgeSeconds, 4);
        p = _putUint(p, m.haltPolicy, 1);
        // Signed fields: big-endian two's complement, as `abi.encodePacked(int64)`.
        p = _putUint(p, uint64(m.createdAtUnixSeconds), 8);
        p = _putUint(p, uint64(m.notBeforeUnixSeconds), 8);
        p = _putUint(p, uint64(m.expiresAtUnixSeconds), 8);
        _seal(out, p);
    }

    /// @notice Candidate V3 bytes of `c`. Callers must validate first.
    function encodeCandidate(Candidate calldata c) internal pure returns (bytes memory out) {
        uint256 p;
        (out, p) = _alloc(
            CANDIDATE_FIXED_BYTES + bytes(c.representationId).length + _assetBytes(c.canonicalAsset)
                + bytes(c.issuer).length + bytes(c.chain).length + bytes(c.venue).length + bytes(c.quantity.unit).length
                + bytes(c.executionPrice.numeratorUnit).length + bytes(c.executionPrice.denominatorUnit).length
                + bytes(c.notional.unit).length + bytes(c.feeTotal.unit).length + bytes(c.evaluationStateId).length
        );
        p = _putUint(p, uint160(CANDIDATE_TAG), 20);
        p = _putUint(p, c.version, 2);
        p = _putString(p, c.representationId);
        p = _putAsset(p, c.canonicalAsset);
        p = _putString(p, c.issuer);
        p = _putString(p, c.chain);
        p = _putString(p, c.venue);
        p = _putUint(p, c.side, 1);
        p = _putParty(p, c.agent);
        p = _putAmount(p, c.quantity);
        p = _putString(p, c.executionPrice.numeratorUnit);
        p = _putString(p, c.executionPrice.denominatorUnit);
        p = _putUint(p, c.executionPrice.decimals, 1);
        p = _putUint(p, c.executionPrice.atoms, 32);
        p = _putAmount(p, c.notional);
        p = _putAmount(p, c.feeTotal);
        p = _putString(p, c.evaluationStateId);
        p = _putUint(p, uint256(c.evaluationStateDigest), 32);
        p = _putUint(p, uint256(c.registrySnapshotDigest), 32);
        p = _putUint(p, c.corporateActionEpoch, 8);
        _seal(out, p);
    }

    function mandateDigest(Mandate calldata m) internal pure returns (bytes32) {
        return keccak256(encodeMandate(m));
    }

    function candidateDigest(Candidate calldata c) internal pure returns (bytes32) {
        return keccak256(encodeCandidate(c));
    }

    /// @dev `u16` byte length, then the bytes. Callers have bounded the length.
    function encodeString(string calldata s) internal pure returns (bytes memory out) {
        uint256 p;
        (out, p) = _alloc(2 + bytes(s).length);
        _seal(out, _putString(p, s));
    }

    function encodeStringMemory(string memory s) internal pure returns (bytes memory) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return abi.encodePacked(uint16(bytes(s).length), s);
    }

    /// @dev `{kind: "eip155-address", value: lowercase 0x-hex}` as two strings.
    function encodeParty(address party) internal pure returns (bytes memory out) {
        uint256 p;
        (out, p) = _alloc(PARTY_BYTES);
        _seal(out, _putParty(p, party));
    }

    function encodeAssetMemory(CanonicalAsset memory a) internal pure returns (bytes memory) {
        return
            bytes.concat(encodeStringMemory(a.assetClass), encodeStringMemory(a.idScheme), encodeStringMemory(a.value));
    }

    /// @dev `u16` count, then each element, in the order given (already
    /// validated as strictly ascending).
    function encodeIdentifierSet(string[] calldata values) internal pure returns (bytes memory out) {
        uint256 p;
        (out, p) = _alloc(_setBytes(values));
        _seal(out, _putSet(p, values));
    }

    // ------------------------------------------------------------------
    // Single-buffer writer
    // ------------------------------------------------------------------

    /// @dev A `bytes` of length `len` and the pointer to its first data byte.
    ///
    /// Memory layout: `[out, out + 32)` holds `len`; `[p, p + len)` is the data.
    /// The reservation also covers the word after the data: writers store whole
    /// 32-byte words at pointers below the data's end, so they write up to 31
    /// bytes past it, and every such byte is inside this allocation. The data
    /// bytes are all written before `_seal`; nothing is assumed zero.
    function _alloc(uint256 len) private pure returns (bytes memory out, uint256 p) {
        assembly ("memory-safe") {
            out := mload(0x40)
            mstore(out, len)
            p := add(out, 0x20)
            // Data plus one spare word, rounded up to a whole word.
            mstore(0x40, and(add(add(p, len), 0x3f), not(0x1f)))
        }
    }

    /// @dev Requires the writers to have filled `out` exactly, then clears the
    /// spare word after the data, so the buffer ends in zero padding like any
    /// other Solidity `bytes`. Never fails on any input: a failure means the
    /// length computation and the writers disagree, which is a bug.
    function _seal(bytes memory out, uint256 p) private pure {
        uint256 end;
        assembly ("memory-safe") {
            end := add(add(out, 0x20), mload(out))
            // Inside the reservation made by `_alloc` (the spare word).
            mstore(end, 0)
        }
        assert(p == end);
    }

    /// @dev The low `size` bytes of `value`, big-endian (1 <= size <= 32). Higher
    /// bytes are dropped, as `abi.encodePacked(uintN(value))` would drop them.
    function _putUint(uint256 p, uint256 value, uint256 size) private pure returns (uint256) {
        assembly ("memory-safe") {
            // One word store: `size` bytes of value, then 32 - size zero bytes
            // that the next writer overwrites (or `_seal` clears). `p + size`
            // is at most the data's end, so the store stays in the reservation.
            mstore(p, shl(sub(256, shl(3, size)), value))
        }
        return p + size;
    }

    /// @dev `u16` length (its low 16 bits, as the `uint16` cast of the previous
    /// encoder), then the string's bytes copied straight from calldata.
    function _putString(uint256 p, string calldata s) private pure returns (uint256) {
        uint256 len = bytes(s).length;
        assembly ("memory-safe") {
            mstore(p, shl(240, len))
            // Exactly `len` bytes from the decoder-checked calldata range of `s`
            // into `[p + 2, p + 2 + len)`, inside the data.
            calldatacopy(add(p, 2), s.offset, len)
        }
        return p + 2 + len;
    }

    /// @dev `PARTY_HEAD`, then the address as 40 lowercase hex digits.
    function _putParty(uint256 p, address party) private pure returns (uint256) {
        uint256 a = uint160(party);
        // Digits of the high 16 address bytes fill one word; digits of the low
        // 4 bytes are the low 8 lanes of the other, moved to its top.
        uint256 high = _hexDigits(a >> 32);
        uint256 low = _hexDigits(a & 0xffffffff) << 192;
        bytes20 head = PARTY_HEAD;
        assembly ("memory-safe") {
            // Three stores in increasing address order; each overwrites the
            // previous one's zero tail. The last ends 24 bytes past `p + 60`,
            // inside the reservation, and those bytes are overwritten next.
            mstore(p, head)
            mstore(add(p, 20), high)
            mstore(add(p, 52), low)
        }
        return p + PARTY_BYTES;
    }

    function _putAsset(uint256 p, CanonicalAsset calldata a) private pure returns (uint256) {
        p = _putString(p, a.assetClass);
        p = _putString(p, a.idScheme);
        return _putString(p, a.value);
    }

    function _putAmount(uint256 p, Amount calldata a) private pure returns (uint256) {
        p = _putString(p, a.unit);
        p = _putUint(p, a.decimals, 1);
        return _putUint(p, a.atoms, 32);
    }

    function _putSet(uint256 p, string[] calldata values) private pure returns (uint256) {
        p = _putUint(p, values.length, 2);
        for (uint256 i = 0; i < values.length; ++i) {
            p = _putString(p, values[i]);
        }
        return p;
    }

    /// @dev Encoded size of a canonical asset: three prefixed strings.
    function _assetBytes(CanonicalAsset calldata a) private pure returns (uint256) {
        return 6 + bytes(a.assetClass).length + bytes(a.idScheme).length + bytes(a.value).length;
    }

    /// @dev Encoded size of an identifier set: its count and prefixed entries.
    function _setBytes(string[] calldata values) private pure returns (uint256 size) {
        size = 2 + 2 * values.length;
        for (uint256 i = 0; i < values.length; ++i) {
            size += bytes(values[i]).length;
        }
    }

    /// @dev The low 16 bytes of `value` as 32 lowercase hex digits, one per
    /// byte, most significant first (`Strings.toHexString`'s digits).
    ///
    /// Spreading: each step moves the upper half of every lane into the next
    /// lane up and masks, doubling the lane width, until each 4-bit nibble sits
    /// alone in the low half of its own byte, in the original order. Digits:
    /// a nibble `n` becomes `n + 0x30` ('0'..'9'), plus 0x27 more when `n > 9`
    /// ('a'..'f'); `(n + 6) >> 4` is exactly that `n > 9` bit. Lanes hold at most
    /// 0x66, so nothing carries between them.
    function _hexDigits(uint256 value) private pure returns (uint256 digits) {
        unchecked {
            uint256 x = value & type(uint128).max;
            x = (x | (x << 64)) & 0x0000000000000000ffffffffffffffff0000000000000000ffffffffffffffff;
            x = (x | (x << 32)) & 0x00000000ffffffff00000000ffffffff00000000ffffffff00000000ffffffff;
            x = (x | (x << 16)) & 0x0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff;
            x = (x | (x << 8)) & 0x00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff;
            x = (x | (x << 4)) & 0x0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f;
            digits = x + 0x30 * LANES + (((x + 0x06 * LANES) >> 4) & LANES) * 0x27;
        }
    }

    // ------------------------------------------------------------------
    // Identity helpers
    // ------------------------------------------------------------------

    /// @notice Hash of an asset's MCE encoding. Length prefixes make it
    /// unambiguous, so equal hashes mean equal `(assetClass, idScheme, value)`.
    function assetHash(CanonicalAsset calldata a) internal pure returns (bytes32) {
        (bytes memory out, uint256 p) = _alloc(_assetBytes(a));
        _seal(out, _putAsset(p, a));
        return keccak256(out);
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
