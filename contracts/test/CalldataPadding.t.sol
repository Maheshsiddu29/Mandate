// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Vm} from "forge-std/Vm.sol";

import {MandateExecutionGate} from "../src/MandateExecutionGate.sol";
import {Candidate, ExecutionTerms, Mandate, SIDE_SELL} from "../src/MandateTypes.sol";
import {GateTestBase} from "./utils/GateTestBase.sol";

/// @notice Dirty ABI padding at the gate's real entry point (Phase 6R.2B).
///
/// The optimized codec reads each identifier's last calldata word whole. The
/// ABI decoder never checks the padding after a `string`, so in a real
/// transaction those bytes are whatever the submitter chose. These tests take a
/// signed `execute` call, overwrite the padding after every identifier with
/// garbage and require the outcome — success or the exact revert, the logs,
/// the replay record — to be the outcome of the clean call. In particular an
/// identifier whose last byte is outside the charset stays refused whatever
/// follows it: the Phase 6R.2A prototype bug (trailing bytes carrying into the
/// last byte) would turn exactly these calls into accepted mandates.
contract CalldataPaddingTest is GateTestBase {
    struct Outcome {
        bool ok;
        bytes data;
        bytes32 logs;
        bytes32 replay;
    }

    /// @dev Bytes on either side of every charset class boundary that are
    /// outside the charset, plus the extremes.
    bytes internal constant INVALID_FINAL_BYTES = hex"00202c3b405b5e607b7f80adff";

    // ------------------------------------------------------------------
    // Honest attempts
    // ------------------------------------------------------------------

    function test_dirtyPadding_honestBuyAndSellSettleIdentically() public {
        bytes32[4] memory fills =
            [bytes32(type(uint256).max), keccak256("garbage"), bytes32(uint256(1)), ~bytes32(uint256(0x7f))];
        for (uint256 side = 0; side < 2; ++side) {
            (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = (_mandate(), _candidate(), _terms());
            if (side == 1) (m, c, t) = (_sellMandate(), _candidateFor(address(aapl), SIDE_SELL), _sellTerms());
            for (uint256 f = 0; f < fills.length; ++f) {
                (Outcome memory clean, Outcome memory dirty, uint256 dirtied) = _cleanAndDirty(m, c, t, fills[f]);
                assertTrue(clean.ok, "the honest attempt settles");
                _assertSame(clean, dirty);
                assertGe(dirtied, 18, "padding after every identifier was dirtied");
            }
        }
    }

    // ------------------------------------------------------------------
    // Malformed final bytes behind dirty padding
    // ------------------------------------------------------------------

    /// For identifiers of the mandate and of the candidate, of lengths on both
    /// sides of the 32-byte boundary: an invalid final byte, signed honestly,
    /// is refused as malformed with clean padding and with every fill.
    function test_dirtyPadding_invalidFinalByteIsStillRefused() public {
        vm.pauseGasMetering(); // a correctness sweep, far past the per-test gas cap
        bytes32[3] memory fills = [
            bytes32(type(uint256).max),
            bytes32(uint256(0x8080808080808080808080808080808080808080808080808080808080808080)),
            keccak256("tail")
        ];
        uint256[4] memory lengths = [uint256(12), 31, 33, 63];
        for (uint256 field = 0; field < 4; ++field) {
            for (uint256 l = 0; l < lengths.length; ++l) {
                for (uint256 b = 0; b < INVALID_FINAL_BYTES.length; ++b) {
                    (Mandate memory m, Candidate memory c, ExecutionTerms memory t) =
                        (_mandate(), _candidate(), _terms());
                    bytes memory id = _identifierOfLength(lengths[l]);
                    id[id.length - 1] = INVALID_FINAL_BYTES[b];
                    bytes4 expected = _plant(m, c, field, string(id));
                    for (uint256 f = 0; f < fills.length; ++f) {
                        (Outcome memory clean, Outcome memory dirty,) = _cleanAndDirty(m, c, t, fills[f]);
                        assertFalse(clean.ok, "an invalid identifier settled");
                        assertEq(bytes4(clean.data), expected, "refused as malformed");
                        _assertSame(clean, dirty);
                    }
                }
            }
        }
    }

    /// Any final byte, any garbage, any of the four fields: dirty equals clean.
    function testFuzz_dirtyPadding_outcomeIsTheCleanOutcome(uint8 last, uint8 lengthSeed, uint8 field, bytes32 garbage)
        public
    {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = (_mandate(), _candidate(), _terms());
        bytes memory id = _identifierOfLength(3 + uint256(lengthSeed) % 126);
        id[id.length - 1] = bytes1(last);
        _plant(m, c, uint256(field) % 4, string(id));
        (Outcome memory clean, Outcome memory dirty,) = _cleanAndDirty(m, c, t, garbage);
        _assertSame(clean, dirty);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev `len` >= 3 bytes starting `zq`: no address, count or small number
    /// word starts that way, so `_dirtyIdentifierPadding` finds only the string.
    function _identifierOfLength(uint256 len) internal pure returns (bytes memory id) {
        id = new bytes(len);
        for (uint256 i = 0; i < len; ++i) {
            id[i] = i == 0 ? bytes1("z") : i == 1 ? bytes1("q") : bytes1(uint8(0x61 + i % 26));
        }
    }

    /// @dev Puts `id` into one identifier field and returns the refusal an
    /// invalid identifier there produces.
    function _plant(Mandate memory m, Candidate memory c, uint256 field, string memory id)
        internal
        pure
        returns (bytes4)
    {
        if (field == 0) {
            m.canonicalAsset.value = id;
            return MandateExecutionGate.MalformedMandate.selector;
        }
        if (field == 1) {
            m.allowedIssuers[0] = id;
            return MandateExecutionGate.MalformedMandate.selector;
        }
        if (field == 2) {
            c.evaluationStateId = id;
            return MandateExecutionGate.MalformedCandidate.selector;
        }
        c.issuer = id;
        return MandateExecutionGate.MalformedCandidate.selector;
    }

    /// @dev The same honestly signed call, run clean and with the padding after
    /// every identifier set to `garbage`, from the same state.
    function _cleanAndDirty(Mandate memory m, Candidate memory c, ExecutionTerms memory t, bytes32 garbage)
        internal
        returns (Outcome memory clean, Outcome memory dirty, uint256 dirtied)
    {
        bytes memory data =
            abi.encodeCall(MandateExecutionGate.execute, (m, _signMandate(m), c, t, _signExecution(m, c, t)));
        bytes memory dirtyData = bytes.concat(data);
        dirtied = _dirtyIdentifierPadding(dirtyData, _identifiers(m, c), garbage);

        uint256 snapshot = vm.snapshotState();
        clean = _call(data, harness.mandateDigest(m));
        vm.revertToState(snapshot);
        dirty = _call(dirtyData, harness.mandateDigest(m));
        vm.revertToState(snapshot);
    }

    function _call(bytes memory data, bytes32 mandateDigest) internal returns (Outcome memory o) {
        vm.recordLogs();
        (o.ok, o.data) = address(gate).call(data);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        o.logs = keccak256(abi.encode(logs));
        o.replay = gate.executionCommitmentOf(mandateDigest);
    }

    function _assertSame(Outcome memory x, Outcome memory y) internal pure {
        assertEq(x.ok, y.ok, "success");
        assertEq(x.data, y.data, "return or revert data");
        assertEq(x.logs, y.logs, "logs");
        assertEq(x.replay, y.replay, "replay record");
    }

    function _identifiers(Mandate memory m, Candidate memory c) internal pure returns (string[] memory out) {
        out = new string[](19);
        out[0] = m.canonicalAsset.assetClass;
        out[1] = m.canonicalAsset.idScheme;
        out[2] = m.canonicalAsset.value;
        out[3] = m.maxNotional.unit;
        out[4] = m.allowedIssuers[0];
        out[5] = m.allowedChains[0];
        out[6] = m.allowedVenues[0];
        out[7] = m.allowedVenues.length > 1 ? m.allowedVenues[1] : m.allowedVenues[0];
        out[8] = c.representationId;
        out[9] = c.canonicalAsset.assetClass;
        out[10] = c.canonicalAsset.idScheme;
        out[11] = c.canonicalAsset.value;
        out[12] = c.issuer;
        out[13] = c.chain;
        out[14] = c.venue;
        out[15] = c.quantity.unit;
        out[16] = c.executionPrice.numeratorUnit;
        out[17] = c.evaluationStateId;
        out[18] = c.feeTotal.unit;
    }

    /// @dev For every ABI string in `data` (a word-aligned run of bytes directly
    /// preceded by its own length word) equal to one of `needles` — each at
    /// least three bytes and not starting with a zero byte, so no address,
    /// count or amount word can pass for one — overwrites
    /// the padding between its end and the next word boundary. Returns how many
    /// strings were dirtied.
    function _dirtyIdentifierPadding(bytes memory data, string[] memory needles, bytes32 garbage)
        internal
        pure
        returns (uint256 dirtied)
    {
        for (uint256 at = 4 + 32; at < data.length; at += 32) {
            uint256 len = uint256(_word(data, at - 32));
            if (len == 0 || len % 32 == 0 || len > data.length - at) continue;
            for (uint256 n = 0; n < needles.length; ++n) {
                if (bytes(needles[n]).length != len || !_matches(data, at, bytes(needles[n]))) continue;
                uint256 end = at + ((len + 31) / 32) * 32;
                for (uint256 k = at + len; k < end && k < data.length; ++k) {
                    data[k] = garbage[k % 32];
                }
                ++dirtied;
                break;
            }
        }
    }

    function _matches(bytes memory data, uint256 at, bytes memory needle) internal pure returns (bool) {
        for (uint256 i = 0; i < needle.length; ++i) {
            if (data[at + i] != needle[i]) return false;
        }
        return true;
    }

    function _word(bytes memory data, uint256 offset) internal pure returns (bytes32 w) {
        assembly ("memory-safe") {
            w := mload(add(add(data, 32), offset))
        }
    }
}
