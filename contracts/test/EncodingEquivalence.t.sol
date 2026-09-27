// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

import {Amount, CanonicalAsset, Candidate, Mandate, Price} from "../src/MandateTypes.sol";
import {EncodingHarness} from "./utils/EncodingHarness.sol";

/// @notice Byte-for-byte equivalence of the production single-buffer encoder
/// with the pre-optimization concatenating encoder (Phase 6R.2B).
///
/// The property is `reference(x) == production(x)` as bytes; digest equality
/// is asserted too, but only as a consequence. The shared kernel corpus is
/// compared byte for byte in `Differential.t.sol`; this suite covers what the
/// corpus does not: every address nibble in every position, randomized
/// structures at every size the gate accepts (and past the identifier limit,
/// since the encoders never validate), negative signed fields, full-width
/// numerics, and memory hygiene around the single buffer.
contract EncodingEquivalenceTest is Test {
    EncodingHarness internal h;

    bytes internal constant CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-:/";

    function setUp() public {
        h = new EncodingHarness();
    }

    // ------------------------------------------------------------------
    // Addresses
    // ------------------------------------------------------------------

    function _party(address a) internal view {
        (bytes memory ref, bytes memory prod) = h.party(a);
        if (keccak256(ref) != keccak256(prod) || ref.length != prod.length) {
            revert(string.concat("party encoding differs for ", vm.toString(a)));
        }
    }

    /// Fixed points: zero, all ones, leading zeros of every length, trailing
    /// zeros, alternating nibbles, and the letter/digit edges 9|a and f|0.
    function test_party_fixedAddresses() public view {
        _party(address(0));
        _party(address(type(uint160).max));
        for (uint256 k = 0; k < 160; k += 4) {
            _party(address(uint160(1) << uint160(k)));
            _party(address(type(uint160).max >> k));
            _party(address(type(uint160).max << k));
        }
        _party(address(0x0123456789abcDEF0123456789abCDef01234567));
        _party(address(0xfEdcBA9876543210FedCBa9876543210fEdCBa98));
        _party(address(0x9A9A9A9a9A9A9A9a9A9a9a9A9A9a9A9a9A9A9a9a));
        _party(address(0xF0F0F0f0f0F0F0f0f0F0f0f0f0f0F0F0f0f0f0F0));
        _party(address(0x0000000000000000000000000000000000000001));
        _party(address(0x8000000000000000000000000000000000000000));
        _party(address(0x00000000000000000000000000000000FFFFfFFF));
        _party(address(0xffFFfFFf00000000000000000000000000000000));
    }

    /// Every byte value — so every high nibble 0-f and every low nibble 0-f —
    /// at every one of the 20 byte positions, over a zero, a ones and a mixed
    /// background (5,120 × 3 addresses). Positions 16..19 are the low word the
    /// encoder converts separately.
    function test_party_everyByteValueAtEveryPosition() public {
        vm.pauseGasMetering(); // a correctness sweep, far past the per-test gas cap
        uint160[3] memory backgrounds =
            [uint160(0), type(uint160).max, uint160(0x5a5A5a5a5A5a5a5a5a5A5a5A5A5a5a5A5A5A5A5A)];
        for (uint256 b = 0; b < backgrounds.length; ++b) {
            for (uint256 pos = 0; pos < 20; ++pos) {
                uint256 shift = 8 * (19 - pos);
                uint160 cleared = backgrounds[b] & ~(uint160(0xff) << uint160(shift));
                for (uint256 v = 0; v < 256; ++v) {
                    _party(address(cleared | (uint160(v) << uint160(shift))));
                }
            }
        }
    }

    /// The exact bytes, not only agreement: head, lowercase digits, length 60.
    function test_party_exactSpelling() public view {
        (, bytes memory prod) = h.party(address(0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9));
        assertEq(
            prod, bytes.concat(hex"000e", "eip155-address", hex"002a", "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9")
        );
        (, prod) = h.party(address(0));
        assertEq(
            prod, bytes.concat(hex"000e", "eip155-address", hex"002a", "0x0000000000000000000000000000000000000000")
        );
    }

    function testFuzz_party(address a) public view {
        _party(a);
    }

    // ------------------------------------------------------------------
    // Strings and sets
    // ------------------------------------------------------------------

    /// Every string length 0..300 — inside and past the identifier limit, since
    /// the encoders frame without validating — with arbitrary bytes.
    function test_string_everyLength() public {
        vm.pauseGasMetering(); // a correctness sweep, far past the per-test gas cap
        for (uint256 len = 0; len <= 300; ++len) {
            bytes memory s = _bytes(len, len);
            (bytes memory ref, bytes memory prod) = h.str(string(s));
            assertEq(prod, ref, "string framing");
        }
    }

    /// Past 65,535 bytes both encoders keep only the length's low 16 bits: an
    /// input no validated identifier can reach, pinned so the two stay alike.
    function test_string_lengthPrefixWrapsIdentically() public {
        vm.pauseGasMetering(); // a correctness sweep, far past the per-test gas cap
        bytes memory s = _bytes(65_537, 1);
        (bytes memory ref, bytes memory prod) = h.str(string(s));
        assertEq(keccak256(prod), keccak256(ref), "wrapped prefix");
        assertEq(uint8(prod[0]), 0);
        assertEq(uint8(prod[1]), 1);
    }

    function testFuzz_set(uint256 seed) public view {
        string[] memory values = _set(seed, seed % 17, 128);
        (bytes memory ref, bytes memory prod) = h.set(values);
        assertEq(prod, ref, "set encoding");
    }

    // ------------------------------------------------------------------
    // Whole mandates and candidates
    // ------------------------------------------------------------------

    function _agreeMandate(Mandate memory m) internal view {
        (bytes memory ref, bytes memory prod) = h.mandate(m);
        assertEq(prod, ref, "MCE v2 bytes");
    }

    function _agreeCandidate(Candidate memory c) internal view {
        (bytes memory ref, bytes memory prod) = h.candidate(c);
        assertEq(prod, ref, "Candidate V3 bytes");
    }

    /// Random mandates and candidates: identifiers of 1..128 bytes, sets of
    /// 0..16 ascending entries, every numeric field full-width random
    /// (negative times included), random parties.
    function testFuzz_mandateAndCandidate(uint256 seed) public view {
        Mandate memory m = _randomMandate(seed, 128);
        Candidate memory c = _randomCandidate(seed >> 1, 128);
        _agreeMandate(m);
        _agreeCandidate(c);
        (bytes32 rm, bytes32 pm, bytes32 rc, bytes32 pc) = h.digests(m, c);
        assertEq(pm, rm, "mandate digest");
        assertEq(pc, rc, "candidate digest");
        (bytes32 ra, bytes32 pa) = h.assetHashes(m.canonicalAsset);
        assertEq(pa, ra, "asset hash");
    }

    /// The same with strings past the identifier limit and larger sets: the
    /// encoders are total, and must stay identical outside the validated domain.
    function testFuzz_mandateAndCandidate_pastTheLimits(uint256 seed) public view {
        _agreeMandate(_randomMandate(seed, 400));
        _agreeCandidate(_randomCandidate(seed, 400));
    }

    /// The largest executable shape: every identifier 128 bytes, 16-entry sets,
    /// every numeric field at its maximum, and the minimal shape beside it.
    function test_extremeShapes() public view {
        for (uint256 k = 0; k < 2; ++k) {
            uint256 len = k == 0 ? 128 : 1;
            Mandate memory m = _randomMandate(k, len);
            m.allowedIssuers = _set(k + 10, k == 0 ? 16 : 0, len);
            m.allowedChains = _set(k + 11, k == 0 ? 16 : 0, len);
            m.allowedVenues = _set(k + 12, k == 0 ? 16 : 0, len);
            if (k == 0) {
                m.mandateId = bytes32(type(uint256).max);
                m.nonce = type(uint64).max;
                m.maxNotional.atoms = type(uint256).max;
                m.economicLimit.atoms = type(uint256).max;
                m.createdAtUnixSeconds = type(int64).min;
                m.notBeforeUnixSeconds = -1;
                m.expiresAtUnixSeconds = type(int64).max;
            }
            _agreeMandate(m);
            _agreeCandidate(_randomCandidate(k, len));
        }
    }

    /// Two encodings and an unrelated allocation in one frame: nothing is
    /// clobbered, both buffers end in zero padding, the free-memory pointer
    /// stays word-aligned past them.
    function testFuzz_encodingLeavesOtherMemoryIntact(uint256 seed) public view {
        Mandate memory m = _randomMandate(seed, 128);
        Candidate memory c = _randomCandidate(seed, 128);
        (bytes memory em, bytes memory filler, bytes memory ec, bool clean) = h.interleaved(m, c);
        (bytes memory rm,) = h.mandate(m);
        (bytes memory rc,) = h.candidate(c);
        assertEq(em, rm, "mandate after interleaving");
        assertEq(ec, rc, "candidate after interleaving");
        assertEq(filler.length, 77);
        for (uint256 i = 0; i < filler.length; ++i) {
            assertEq(uint8(filler[i]), 0xa5, "filler clobbered");
        }
        assertTrue(clean, "unclean tail or free-memory pointer");
    }

    // ------------------------------------------------------------------
    // Builders
    // ------------------------------------------------------------------

    function _r(uint256 seed, uint256 salt) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, salt)));
    }

    function _bytes(uint256 len, uint256 seed) internal pure returns (bytes memory s) {
        s = new bytes(len);
        for (uint256 i = 0; i < len; ++i) {
            s[i] = bytes1(uint8(_r(seed, i)));
        }
    }

    /// @dev Charset bytes; `maxLen` 128 keeps it a valid-length identifier.
    function _ident(uint256 seed, uint256 maxLen) internal pure returns (string memory) {
        uint256 len = 1 + _r(seed, 0) % maxLen;
        bytes memory s = new bytes(len);
        for (uint256 i = 0; i < len; ++i) {
            s[i] = CHARSET[_r(seed, i + 1) % CHARSET.length];
        }
        return string(s);
    }

    /// @dev Up to `count` distinct identifiers, ascending by (length, bytes).
    function _set(uint256 seed, uint256 count, uint256 maxLen) internal pure returns (string[] memory out) {
        out = new string[](count);
        uint256 n;
        for (uint256 i = 0; i < count; ++i) {
            string memory v = _ident(_r(seed, 1000 + i), maxLen);
            uint256 j = n;
            bool duplicate;
            while (j > 0) {
                int256 c = _cmp(bytes(out[j - 1]), bytes(v));
                if (c == 0) duplicate = true;
                if (c <= 0) break;
                out[j] = out[j - 1];
                --j;
            }
            if (duplicate) {
                // Undo the shift and drop the duplicate.
                for (uint256 k = j; k < n; ++k) {
                    out[k] = out[k + 1];
                }
                continue;
            }
            out[j] = v;
            ++n;
        }
        assembly ("memory-safe") {
            mstore(out, n)
        }
    }

    function _cmp(bytes memory a, bytes memory b) internal pure returns (int256) {
        if (a.length != b.length) return a.length < b.length ? int256(-1) : int256(1);
        for (uint256 i = 0; i < a.length; ++i) {
            if (a[i] != b[i]) return uint8(a[i]) < uint8(b[i]) ? int256(-1) : int256(1);
        }
        return 0;
    }

    function _asset(uint256 seed, uint256 maxLen) internal pure returns (CanonicalAsset memory) {
        return CanonicalAsset({
            assetClass: _ident(_r(seed, 1), maxLen),
            idScheme: _ident(_r(seed, 2), maxLen),
            value: _ident(_r(seed, 3), maxLen)
        });
    }

    function _amount(uint256 seed, uint256 maxLen) internal pure returns (Amount memory) {
        return Amount({unit: _ident(seed, maxLen), decimals: uint8(_r(seed, 1)), atoms: _r(seed, 2)});
    }

    function _randomMandate(uint256 seed, uint256 maxLen) internal pure returns (Mandate memory m) {
        m.version = uint16(_r(seed, 10));
        m.mandateId = bytes32(_r(seed, 11));
        m.nonce = uint64(_r(seed, 12));
        m.principal = address(uint160(_r(seed, 13)));
        m.agent = address(uint160(_r(seed, 14)));
        m.canonicalAsset = _asset(_r(seed, 15), maxLen);
        m.side = uint8(_r(seed, 16));
        m.maxNotional = _amount(_r(seed, 17), maxLen);
        m.economicLimit = _amount(_r(seed, 18), maxLen);
        m.maxDeviationBps = uint16(_r(seed, 19));
        m.syntheticPolicy = uint8(_r(seed, 20));
        m.allowedIssuers = _set(_r(seed, 21), _r(seed, 22) % 17, maxLen);
        m.allowedChains = _set(_r(seed, 23), _r(seed, 24) % 17, maxLen);
        m.allowedVenues = _set(_r(seed, 25), _r(seed, 26) % 17, maxLen);
        m.requiredCorporateActionEpoch = uint64(_r(seed, 27));
        m.maxPriceAgeSeconds = uint32(_r(seed, 28));
        m.maxCorporateActionAgeSeconds = uint32(_r(seed, 29));
        m.haltPolicy = uint8(_r(seed, 30));
        m.createdAtUnixSeconds = int64(uint64(_r(seed, 31)));
        m.notBeforeUnixSeconds = int64(uint64(_r(seed, 32)));
        m.expiresAtUnixSeconds = int64(uint64(_r(seed, 33)));
    }

    function _randomCandidate(uint256 seed, uint256 maxLen) internal pure returns (Candidate memory c) {
        c.version = uint16(_r(seed, 40));
        c.representationId = _ident(_r(seed, 41), maxLen);
        c.canonicalAsset = _asset(_r(seed, 42), maxLen);
        c.issuer = _ident(_r(seed, 43), maxLen);
        c.chain = _ident(_r(seed, 44), maxLen);
        c.venue = _ident(_r(seed, 45), maxLen);
        c.side = uint8(_r(seed, 46));
        c.agent = address(uint160(_r(seed, 47)));
        c.quantity = _amount(_r(seed, 48), maxLen);
        c.executionPrice = Price({
            numeratorUnit: _ident(_r(seed, 49), maxLen),
            denominatorUnit: _ident(_r(seed, 50), maxLen),
            decimals: uint8(_r(seed, 51)),
            atoms: _r(seed, 52)
        });
        c.notional = _amount(_r(seed, 53), maxLen);
        c.feeTotal = _amount(_r(seed, 54), maxLen);
        c.evaluationStateId = _ident(_r(seed, 55), maxLen);
        c.evaluationStateDigest = bytes32(_r(seed, 56));
        c.registrySnapshotDigest = bytes32(_r(seed, 57));
        c.corporateActionEpoch = uint64(_r(seed, 58));
    }
}
