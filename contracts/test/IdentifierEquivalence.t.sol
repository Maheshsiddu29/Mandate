// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

import {IdentifierHarness} from "./utils/IdentifierHarness.sol";

/// @notice Differential equivalence of every identifier validator, comparator and
/// set checker against the byte-at-a-time reference (Phase 6R.2B).
///
/// The optimized readers load identifiers a 32-byte word at a time, so the
/// security-sensitive cases are the ones a byte loop never had: the final
/// partial word (every `length mod 32`), bytes on either side of a word
/// boundary, and — above all — whatever lies *after* an identifier inside its
/// last word. ABI padding is not checked by the decoder, so those bytes are
/// attacker-chosen in real calldata; `_dirtyCall` writes them here. Malformed
/// input dominates every loop: validity is the rare case.
///
/// `test_campaign_seeded` is the high-volume run. It is deterministic, reports
/// the distribution it covered, and takes its size from
/// `IDENTIFIER_CAMPAIGN_CASES` (default below) so a heavy local run needs no
/// code change: `IDENTIFIER_CAMPAIGN_CASES=200000 forge test --mt test_campaign_seeded -vv`.
/// The exhaustive sweeps pause gas metering: they are correctness checks whose
/// loops far exceed the per-test gas cap, and nothing here measures gas.
contract IdentifierEquivalenceTest is Test {
    IdentifierHarness internal h;

    /// @dev Kernel identifier charset, and its alphanumeric subset (legal at both ends).
    bytes internal constant CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-:/";
    uint256 internal constant ALNUM_COUNT = 62;
    /// @dev The bytes on either side of every class boundary of the charset,
    /// plus the extremes and the high-bit edge.
    bytes internal constant BOUNDARY_BYTES = hex"00012c2d2e2f30393a3b40415a5b5e5f60617a7b7e7f8081adfeff";
    /// @dev Tail fills for dirty-padding tests: zero, all-ones, high bit, a
    /// separator, a legal letter, and small values that would borrow.
    bytes internal constant TAIL_FILLS = hex"00ff802d6101";
    uint256 internal constant DEFAULT_CAMPAIGN_CASES = 12_000;

    function setUp() public {
        h = new IdentifierHarness();
    }

    // ------------------------------------------------------------------
    // Builders
    // ------------------------------------------------------------------

    /// @dev A valid identifier of `len` bytes (1..128), deterministic in `seed`.
    function _valid(uint256 len, uint256 seed) internal pure returns (bytes memory s) {
        s = new bytes(len);
        for (uint256 i = 0; i < len; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            bool end = i == 0 || i == len - 1;
            s[i] = CHARSET[r % (end ? ALNUM_COUNT : CHARSET.length)];
        }
    }

    function _filled(uint256 len, bytes1 b) internal pure returns (bytes memory s) {
        s = new bytes(len);
        for (uint256 i = 0; i < len; ++i) {
            s[i] = b;
        }
    }

    /// @dev First, middle and last position, and every word-boundary position below `len`.
    function _positions(uint256 len) internal pure returns (uint256[] memory out) {
        uint256[10] memory edges = [uint256(31), 32, 33, 63, 64, 65, 95, 96, 97, 127];
        out = new uint256[](13);
        uint256 n;
        if (len == 0) {
            assembly ("memory-safe") {
                mstore(out, 0)
            }
            return out;
        }
        out[n++] = 0;
        if (len / 2 != 0) out[n++] = len / 2;
        if (len - 1 != 0 && len - 1 != len / 2) out[n++] = len - 1;
        for (uint256 k = 0; k < edges.length; ++k) {
            uint256 p = edges[k];
            if (p < len && p != 0 && p != len / 2 && p != len - 1) out[n++] = p;
        }
        assembly ("memory-safe") {
            mstore(out, n)
        }
    }

    // ------------------------------------------------------------------
    // Agreement checks
    // ------------------------------------------------------------------

    /// @dev Every validator agrees with the reference on `s`; returns the verdict.
    /// Memory allocated by the call is released, so long loops stay flat.
    function _agree(bytes memory s) internal view returns (bool verdict) {
        uint256 fmp;
        assembly ("memory-safe") {
            fmp := mload(0x40)
        }
        bool[] memory out = h.validators(s);
        verdict = out[0];
        for (uint256 i = 1; i < out.length; ++i) {
            if (out[i] != verdict) _mismatch("validator", i, s, "");
        }
        assembly ("memory-safe") {
            mstore(0x40, fmp)
        }
    }

    /// @dev `validators(s)` with every ABI padding byte after `s` set from
    /// `garbage`, `extraWords` more garbage words appended, and — when
    /// `truncate` — the calldata cut at the last byte of `s` instead.
    function _dirtyCall(bytes memory s, bytes32 garbage, uint256 extraWords, bool truncate)
        internal
        view
        returns (bool[] memory out)
    {
        bytes memory data = abi.encodeCall(IdentifierHarness.validators, (s));
        _dirtyOperand(data, 0, garbage);
        if (truncate) {
            uint256 cut = 4 + 64 + s.length;
            assembly ("memory-safe") {
                mstore(data, cut)
            }
        }
        for (uint256 k = 0; k < extraWords; ++k) {
            data = bytes.concat(data, garbage);
        }
        (bool ok, bytes memory ret) = address(h).staticcall(data);
        require(ok, "dirty call reverted");
        out = abi.decode(ret, (bool[]));
    }

    /// @dev Overwrites the padding after the `index`-th top-level dynamic operand
    /// of ABI-encoded call `data` with bytes of `garbage`.
    function _dirtyOperand(bytes memory data, uint256 index, bytes32 garbage) internal pure {
        uint256 offset = uint256(_word(data, 4 + 32 * index));
        uint256 lengthAt = 4 + offset;
        uint256 len = uint256(_word(data, lengthAt));
        uint256 from = lengthAt + 32 + len;
        uint256 to = lengthAt + 32 + ((len + 31) / 32) * 32;
        for (uint256 k = from; k < to; ++k) {
            data[k] = garbage[k % 32];
        }
    }

    function _word(bytes memory data, uint256 offset) internal pure returns (bytes32 w) {
        assembly ("memory-safe") {
            w := mload(add(add(data, 32), offset))
        }
    }

    /// @dev Clean, dirty-padded, dirty-padded-with-trailing-words, truncated and
    /// dirty-memory evaluations of `s` all equal the reference on clean input.
    function _agreeDirty(bytes memory s, bytes32 garbage) internal view returns (bool verdict) {
        uint256 fmp;
        assembly ("memory-safe") {
            fmp := mload(0x40)
        }
        verdict = _agree(s);
        bool[] memory a = _dirtyCall(s, garbage, 0, false);
        bool[] memory b = _dirtyCall(s, garbage, 2, false);
        bool[] memory c = _dirtyCall(s, garbage, 0, true);
        for (uint256 i = 0; i < a.length; ++i) {
            if (a[i] != verdict) _mismatch("dirty padding", i, s, abi.encode(garbage));
            if (b[i] != verdict) _mismatch("dirty padding + trailing words", i, s, abi.encode(garbage));
            if (c[i] != verdict) _mismatch("truncated calldata", i, s, "");
        }
        bytes memory physical = bytes.concat(s, garbage, garbage);
        if (h.memoryValidatorWithTail(physical, s.length) != verdict) {
            _mismatch("dirty memory tail", 2, s, abi.encode(garbage));
        }
        assembly ("memory-safe") {
            mstore(0x40, fmp)
        }
    }

    function _agreeCompare(bytes memory a, bytes memory b) internal view returns (int256 verdict) {
        uint256 fmp;
        assembly ("memory-safe") {
            fmp := mload(0x40)
        }
        int256[] memory out = h.comparators(a, b);
        verdict = out[0];
        for (uint256 i = 1; i < out.length; ++i) {
            if (out[i] != verdict) _mismatch("comparator", i, a, b);
        }
        // Dirty both operands' padding; order must not move.
        bytes memory data = abi.encodeCall(IdentifierHarness.comparators, (a, b));
        _dirtyOperand(data, 0, keccak256(a));
        _dirtyOperand(data, 1, ~keccak256(b));
        (bool ok, bytes memory ret) = address(h).staticcall(data);
        require(ok, "dirty compare reverted");
        out = abi.decode(ret, (int256[]));
        for (uint256 i = 0; i < out.length; ++i) {
            if (out[i] != verdict) _mismatch("comparator, dirty padding", i, a, b);
        }
        assembly ("memory-safe") {
            mstore(0x40, fmp)
        }
    }

    /// @dev `impl` indexes `validatorNames()` / `comparatorNames()`.
    function _mismatch(string memory what, uint256 impl, bytes memory a, bytes memory b) internal pure {
        revert(
            string.concat(
                what, " mismatch: implementation #", vm.toString(impl), " on ", vm.toString(a), " / ", vm.toString(b)
            )
        );
    }

    // ------------------------------------------------------------------
    // Validator: lengths
    // ------------------------------------------------------------------

    /// Every logical length 0..140 (so every `length mod 32`, four times over,
    /// and both protocol limits), with several fillers, plus lengths far past the limit.
    function test_validator_everyLength() public {
        vm.pauseGasMetering(); // a correctness sweep, far past the per-test gas cap
        bytes1[6] memory fills = [bytes1("a"), "Z", "0", "9", ".", 0x00];
        for (uint256 len = 0; len <= 140; ++len) {
            for (uint256 seed = 0; seed < 4; ++seed) {
                bool v = _agree(len == 0 ? bytes("") : _valid(len > 128 ? 128 : len, seed));
                if (len >= 1 && len <= 128) assertTrue(v, "valid identifier refused");
            }
            if (len > 128) {
                bytes memory tooLong = bytes.concat(_valid(128, len), _valid(len - 128, len + 1));
                assertFalse(_agree(tooLong), "over-long identifier accepted");
            }
            for (uint256 f = 0; f < fills.length; ++f) {
                bool v = _agree(_filled(len, fills[f]));
                bool alnum = fills[f] != "." && fills[f] != 0x00;
                assertEq(v, alnum && len >= 1 && len <= 128, "uniform fill verdict");
            }
        }
        uint256[4] memory huge = [uint256(255), 256, 257, 1_000];
        for (uint256 k = 0; k < huge.length; ++k) {
            assertFalse(_agree(_filled(huge[k], "a")), "over-long identifier accepted");
        }
    }

    // ------------------------------------------------------------------
    // Validator: every byte value at every boundary position
    // ------------------------------------------------------------------

    /// Every one of the 256 byte values, at the first, middle and last position
    /// and at every word-boundary position, in identifiers whose lengths sit on
    /// either side of each word boundary.
    function test_validator_everyByteValueAtWordBoundaries() public {
        vm.pauseGasMetering(); // a correctness sweep, far past the per-test gas cap
        uint256[15] memory lens = [uint256(1), 2, 3, 31, 32, 33, 63, 64, 65, 95, 96, 97, 127, 128, 129];
        for (uint256 k = 0; k < lens.length; ++k) {
            _everyByteValue(lens[k]);
        }
    }

    function _everyByteValue(uint256 len) internal view {
        bytes memory s = _valid(len > 128 ? 128 : len, len);
        if (len > 128) s = bytes.concat(s, _valid(len - 128, 7));
        uint256[] memory ps = _positions(len);
        uint256 accepted;
        for (uint256 i = 0; i < ps.length; ++i) {
            bytes1 original = s[ps[i]];
            for (uint256 v = 0; v < 256; ++v) {
                s[ps[i]] = bytes1(uint8(v));
                if (_agree(s)) ++accepted;
            }
            s[ps[i]] = original;
        }
        // Non-vacuity: inside the limit some substitutions are legal, and at
        // most 67 values per position can be.
        if (len <= 128) assertGt(accepted, 0, "no substitution accepted");
        else assertEq(accepted, 0, "over-long identifier accepted");
        assertLe(accepted, 67 * ps.length, "more than the charset accepted");
    }

    /// The class-boundary bytes at the boundary positions of every length
    /// 1..130: every final-word remainder, every position class.
    function test_validator_classBoundaryBytesAtEveryLength() public {
        vm.pauseGasMetering(); // a correctness sweep, far past the per-test gas cap
        for (uint256 len = 1; len <= 130; ++len) {
            bytes memory s = _valid(len > 128 ? 128 : len, len);
            if (len > 128) s = bytes.concat(s, _valid(len - 128, 3));
            uint256[] memory ps = _positions(len);
            for (uint256 i = 0; i < ps.length; ++i) {
                bytes1 original = s[ps[i]];
                for (uint256 v = 0; v < BOUNDARY_BYTES.length; ++v) {
                    s[ps[i]] = BOUNDARY_BYTES[v];
                    _agree(s);
                }
                s[ps[i]] = original;
            }
        }
    }

    // ------------------------------------------------------------------
    // Validator: dirty trailing bytes (the 6R.2A prototype bug)
    // ------------------------------------------------------------------

    /// The regression for the bug caught in the Phase 6R.2A prototype: bytes
    /// after an identifier's logical end, inside its last word, influenced the
    /// verdict on its final byte. For every partial final word (1..31 useful
    /// bytes, in each of the four words) and every class-boundary final byte,
    /// under every tail fill, the verdict must equal the reference's on the
    /// clean logical string — in calldata (dirty padding, extra trailing
    /// words, truncated calldata) and in memory.
    function test_validator_dirtyTailIgnored_everyRemainder() public {
        vm.pauseGasMetering(); // a correctness sweep, far past the per-test gas cap
        for (uint256 len = 1; len <= 129; ++len) {
            if (len % 32 == 0) continue;
            bytes memory s = _valid(len > 128 ? 128 : len, len + 11);
            if (len > 128) s = bytes.concat(s, "a");
            for (uint256 v = 0; v < BOUNDARY_BYTES.length; ++v) {
                s[len - 1] = BOUNDARY_BYTES[v];
                for (uint256 f = 0; f < TAIL_FILLS.length; ++f) {
                    _agreeDirty(s, _fill(TAIL_FILLS[f]));
                }
            }
        }
    }

    /// Every one of the 256 final-byte values, and every uniform string, at
    /// one remainder on each side of each word boundary, under every tail
    /// fill. A uniform string lets a carry or borrow run across every lane.
    function test_validator_dirtyTailIgnored_everyFinalByte() public {
        vm.pauseGasMetering(); // a correctness sweep, far past the per-test gas cap
        uint256[8] memory lens = [uint256(1), 31, 33, 63, 65, 95, 97, 127];
        for (uint256 k = 0; k < lens.length; ++k) {
            bytes memory s = _valid(lens[k], k);
            for (uint256 v = 0; v < 256; ++v) {
                s[lens[k] - 1] = bytes1(uint8(v));
                bytes memory uniform = _filled(lens[k], bytes1(uint8(v)));
                for (uint256 f = 0; f < TAIL_FILLS.length; ++f) {
                    bytes32 g = _fill(TAIL_FILLS[f]);
                    _agreeDirty(s, g);
                    _agreeDirty(uniform, g);
                }
            }
        }
    }

    function testFuzz_validator_dirtyTailIgnored(uint256 seed, uint8 lengthSeed, uint8 last, bytes32 garbage)
        public
        view
    {
        uint256 len = 1 + (uint256(lengthSeed) % 129);
        bytes memory s = _valid(len > 128 ? 128 : len, seed);
        if (len > 128) s = bytes.concat(s, "a");
        s[len - 1] = bytes1(last);
        _agreeDirty(s, garbage);
        if (seed % 2 == 0) {
            // A second corruption inside the string, so both lanes vary.
            s[uint256(keccak256(abi.encode(seed))) % len] = bytes1(uint8(seed >> 8));
            _agreeDirty(s, garbage);
        }
    }

    function _fill(bytes1 b) internal pure returns (bytes32 w) {
        w = bytes32(uint256(uint8(b)) * (type(uint256).max / 0xff));
    }

    // ------------------------------------------------------------------
    // Validator: fuzz
    // ------------------------------------------------------------------

    /// Arbitrary byte strings, mostly malformed.
    function testFuzz_validator_arbitraryBytes(bytes memory raw) public view {
        vm.assume(raw.length <= 300);
        _agree(raw);
    }

    /// A valid identifier, then zero to three corruptions at random or
    /// word-boundary positions; sixteen variants per run.
    function testFuzz_validator_mutatedIdentifiers(uint256 seed) public view {
        for (uint256 k = 0; k < 16; ++k) {
            _agree(_mutated(uint256(keccak256(abi.encode(seed, k)))));
        }
    }

    function _mutated(uint256 r) internal pure returns (bytes memory s) {
        uint256 len = _length(r);
        s = _valid(len == 0 ? 0 : (len > 128 ? 128 : len), r >> 8);
        if (len > 128) s = bytes.concat(s, _valid(len - 128, r >> 16));
        if (len == 0) return s;
        uint256 corruptions = (r >> 24) % 4;
        for (uint256 c = 0; c < corruptions; ++c) {
            uint256 q = uint256(keccak256(abi.encode(r, c)));
            uint256 pos = q % 3 == 0 ? _boundaryPosition(q >> 8, len) : (q >> 8) % len;
            s[pos] = bytes1(uint8(q >> 64));
        }
    }

    /// @dev Lengths: mostly uniform over 0..130, often exactly on a boundary,
    /// sometimes far past the limit.
    function _length(uint256 r) internal pure returns (uint256) {
        uint256 kind = r % 10;
        if (kind < 6) return (r >> 128) % 131;
        if (kind < 9) {
            uint256[14] memory b = [uint256(0), 1, 31, 32, 33, 63, 64, 65, 95, 96, 97, 127, 128, 129];
            return b[(r >> 128) % b.length];
        }
        return 129 + (r >> 128) % 200;
    }

    function _boundaryPosition(uint256 r, uint256 len) internal pure returns (uint256) {
        uint256[12] memory p = [uint256(0), len - 1, 31, 32, 33, 63, 64, 65, 95, 96, 97, 127];
        uint256 pos = p[r % p.length];
        return pos < len ? pos : len - 1;
    }

    // ------------------------------------------------------------------
    // Comparator
    // ------------------------------------------------------------------

    /// Equal strings compare equal at every length, and a shorter string always
    /// sorts first whatever its bytes, including every prefix pair across a
    /// word boundary.
    function test_comparator_equalAndPrefixOrdering() public {
        vm.pauseGasMetering(); // a correctness sweep, far past the per-test gas cap
        for (uint256 len = 0; len <= 130; ++len) {
            bytes memory s = _valid(len == 0 ? 1 : (len > 128 ? 128 : len), len);
            if (len == 0) s = "";
            if (len > 128) s = bytes.concat(s, _valid(len - 128, 5));
            assertEq(_agreeCompare(s, s), 0, "equal strings");
            assertEq(_agreeCompare(s, bytes.concat(s)), 0, "equal copies");
        }
        assertEq(_agreeCompare("ABC", "ABCD"), -1, "ABC < ABCD");
        assertEq(_agreeCompare("ABCD", "ABC"), 1, "ABCD > ABC");
        uint256[2][7] memory pairs = [
            [uint256(0), 1],
            [uint256(1), 2],
            [uint256(31), 32],
            [uint256(32), 33],
            [uint256(63), 64],
            [uint256(64), 65],
            [uint256(127), 128]
        ];
        for (uint256 k = 0; k < pairs.length; ++k) {
            bytes memory longer = _valid(pairs[k][1], k);
            bytes memory prefix = new bytes(pairs[k][0]);
            for (uint256 i = 0; i < prefix.length; ++i) {
                prefix[i] = longer[i];
            }
            assertEq(_agreeCompare(prefix, longer), -1, "prefix sorts first");
            assertEq(_agreeCompare(longer, prefix), 1, "extension sorts last");
            // Length decides even when the shorter string's bytes are larger.
            assertEq(_agreeCompare(_filled(pairs[k][0], 0xff), _filled(pairs[k][1], 0x00)), -1, "length first");
        }
    }

    /// A single differing byte at the first, middle and last position and at
    /// every word boundary, with pairs of values across every edge that
    /// signedness or a stray carry could flip, in both orders.
    function test_comparator_singleDifferenceAtEveryBoundary() public {
        vm.pauseGasMetering(); // a correctness sweep, far past the per-test gas cap
        bytes2[7] memory values = [bytes2(0x0001), 0x7f80, 0xfeff, 0x00ff, 0x6162, 0x5a61, 0x2d2e];
        uint256[16] memory lens = [uint256(1), 2, 31, 32, 33, 63, 64, 65, 95, 96, 97, 127, 128, 129, 130, 200];
        for (uint256 k = 0; k < lens.length; ++k) {
            uint256 len = lens[k];
            bytes memory a = _valid(len > 128 ? 128 : len, k);
            if (len > 128) a = bytes.concat(a, _valid(len - 128, k + 1));
            uint256[] memory ps = _positions(len);
            for (uint256 i = 0; i < ps.length; ++i) {
                for (uint256 v = 0; v < values.length; ++v) {
                    bytes memory lo = bytes.concat(a);
                    bytes memory hi = bytes.concat(a);
                    lo[ps[i]] = values[v][0];
                    hi[ps[i]] = values[v][1];
                    assertEq(_agreeCompare(lo, hi), -1, "lower byte sorts first");
                    assertEq(_agreeCompare(hi, lo), 1, "higher byte sorts last");
                }
            }
        }
    }

    /// Two differences: the earlier one decides, even across a word boundary.
    function test_comparator_earliestDifferenceDecides() public view {
        uint256[2][6] memory diffs = [
            [uint256(0), 1],
            [uint256(30), 31],
            [uint256(31), 32],
            [uint256(32), 63],
            [uint256(63), 64],
            [uint256(95), 127]
        ];
        for (uint256 k = 0; k < diffs.length; ++k) {
            bytes memory a = _filled(128, "m");
            bytes memory b = _filled(128, "m");
            a[diffs[k][0]] = "a"; // a is lower first ...
            a[diffs[k][1]] = "z"; // ... and higher later
            b[diffs[k][1]] = "a";
            assertEq(_agreeCompare(a, b), -1, "earliest difference decides");
            assertEq(_agreeCompare(b, a), 1, "earliest difference decides");
        }
    }

    function testFuzz_comparator_arbitrary(bytes memory a, bytes memory b) public view {
        vm.assume(a.length <= 300 && b.length <= 300);
        _agreeCompare(a, b);
        _agreeCompare(a, a);
    }

    /// Related pairs, which random pairs almost never are: equal, one byte
    /// changed at a random or word-boundary position, truncated, extended.
    function testFuzz_comparator_relatedPairs(uint256 seed) public view {
        for (uint256 k = 0; k < 8; ++k) {
            (bytes memory a, bytes memory b) = _relatedPair(uint256(keccak256(abi.encode(seed, k))));
            _agreeCompare(a, b);
        }
    }

    function _relatedPair(uint256 r) internal pure returns (bytes memory a, bytes memory b) {
        uint256 len = 1 + (r >> 128) % 160;
        a = new bytes(len);
        for (uint256 i = 0; i < len; ++i) {
            a[i] = bytes1(uint8(uint256(keccak256(abi.encode(r, i)))));
        }
        b = bytes.concat(a);
        uint256 kind = r % 4;
        if (kind == 1) {
            uint256 pos = r % 3 == 0 ? _boundaryPosition(r >> 8, len) : (r >> 8) % len;
            b[pos] = bytes1(uint8(r >> 64));
        } else if (kind == 2) {
            assembly ("memory-safe") {
                mstore(b, sub(mload(b), 1))
            }
        } else if (kind == 3) {
            b = bytes.concat(b, bytes1(uint8(r >> 72)));
        }
    }

    // ------------------------------------------------------------------
    // Sets
    // ------------------------------------------------------------------

    /// Random small sets over a pool chosen to collide: equal lengths, shared
    /// prefixes, duplicates, a separator-ended entry, entries around 32 bytes.
    function testFuzz_sets_agree(uint256 seed) public view {
        string[10] memory pool = [
            "a",
            "b",
            "aa",
            "ab",
            "ba",
            "a.",
            "abcdefghijklmnopqrstuvwxyz012345",
            "abcdefghijklmnopqrstuvwxyz012346",
            "abcdefghijklmnopqrstuvwxyz0123456",
            "abcdefghijklmnopqrstuvwxyz012345a"
        ];
        uint256 n = seed % 6;
        string[] memory values = new string[](n);
        for (uint256 i = 0; i < n; ++i) {
            values[i] = pool[uint256(keccak256(abi.encode(seed, i))) % pool.length];
        }
        bool[] memory out = h.sets(values);
        for (uint256 i = 1; i < out.length; ++i) {
            assertEq(out[i], out[0], "set verdict mismatch");
        }
    }

    // ------------------------------------------------------------------
    // High-volume seeded campaign
    // ------------------------------------------------------------------

    struct Stats {
        uint256 cases;
        uint256 valid;
        uint256 invalid;
        uint256 overLimit;
        uint256 boundaryLength;
        uint256 dirty;
        uint256 comparisons;
        uint256 comparisonsEqual;
        uint256[32] byRemainder;
    }

    /// Deterministic PRNG campaign: every case is checked clean and with dirty
    /// padding (random garbage), and paired with a related string for the
    /// comparator. Logs the distribution actually covered.
    function test_campaign_seeded() public {
        vm.pauseGasMetering(); // a correctness sweep, far past the per-test gas cap
        uint256 cases = vm.envOr("IDENTIFIER_CAMPAIGN_CASES", DEFAULT_CAMPAIGN_CASES);
        uint256 seed = vm.envOr("IDENTIFIER_CAMPAIGN_SEED", uint256(0x6d616e64617465));
        Stats memory st;
        for (uint256 i = 0; i < cases; ++i) {
            uint256 fmp;
            assembly ("memory-safe") {
                fmp := mload(0x40)
            }
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            bytes memory s = _mutated(r);
            bool verdict = _agreeDirty(s, keccak256(abi.encode(r, "tail")));
            st.cases += 1;
            st.dirty += 1;
            if (verdict) st.valid += 1;
            else st.invalid += 1;
            if (s.length > 128) st.overLimit += 1;
            if (s.length % 32 <= 1 || s.length % 32 == 31) st.boundaryLength += 1;
            st.byRemainder[s.length % 32] += 1;
            (bytes memory a, bytes memory b) = _relatedPair(r >> 1);
            if (_agreeCompare(a, b) == 0) st.comparisonsEqual += 1;
            st.comparisons += 1;
            assembly ("memory-safe") {
                mstore(0x40, fmp)
            }
        }
        emit log_named_uint("CAMPAIGN cases (each: clean + 3 dirty calldata + dirty memory)", st.cases);
        emit log_named_uint("CAMPAIGN valid (reference)", st.valid);
        emit log_named_uint("CAMPAIGN invalid (reference)", st.invalid);
        emit log_named_uint("CAMPAIGN over the 128-byte limit", st.overLimit);
        emit log_named_uint("CAMPAIGN length mod 32 in {31, 0, 1}", st.boundaryLength);
        emit log_named_uint("CAMPAIGN comparisons (each also dirty)", st.comparisons);
        emit log_named_uint("CAMPAIGN comparisons equal", st.comparisonsEqual);
        uint256 minBucket = type(uint256).max;
        for (uint256 m = 0; m < 32; ++m) {
            if (st.byRemainder[m] < minBucket) minBucket = st.byRemainder[m];
        }
        emit log_named_uint("CAMPAIGN fewest cases in any length-mod-32 bucket", minBucket);
        if (cases >= 1_000) {
            assertGt(minBucket, 0, "a length remainder was never exercised");
            assertGt(st.valid, cases / 20, "campaign is nearly all invalid");
            assertGt(st.invalid, cases / 20, "campaign is nearly all valid");
        }
    }
}
