// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {CanonicalAsset} from "../../src/MandateTypes.sol";
import {MandateCodec} from "../../src/libraries/MandateCodec.sol";

/// @notice Isolates single codec operations for gas attribution (Phase 6R.2A).
/// Every operation has a `noop` twin with the same calldata shape, so the
/// difference of the two frames is the operation alone, without dispatch and
/// ABI head decoding. The library code is inlined into this harness rather than
/// into the gate, so figures here attribute cost between operations; the
/// in-gate sweeps (`GasSweeps.t.sol`) are the authority on absolute cost.
contract CodecBenchHarness {
    function noopString(string calldata s) external pure returns (uint256) {
        return bytes(s).length;
    }

    function isIdentifier(string calldata s) external pure returns (uint256) {
        return MandateCodec.isIdentifier(s) ? 1 : 0;
    }

    function hashString(string calldata s) external pure returns (uint256) {
        return uint256(keccak256(bytes(s)));
    }

    function encodeString(string calldata s) external pure returns (uint256) {
        return MandateCodec.encodeString(s).length;
    }

    function copyString(string calldata s) external pure returns (uint256) {
        bytes memory b = bytes(s);
        return b.length;
    }

    function compareStrings(string calldata a, string calldata b) external pure returns (uint256) {
        return uint256(MandateCodec.compareEncoded(bytes(a), bytes(b)) + 1);
    }

    function noopPair(string calldata a, string calldata b) external pure returns (uint256) {
        return bytes(a).length + bytes(b).length;
    }

    function noopSet(string[] calldata values) external pure returns (uint256) {
        return values.length;
    }

    function isIdentifierSet(string[] calldata values) external pure returns (uint256) {
        return MandateCodec.isIdentifierSet(values) ? 1 : 0;
    }

    function encodeIdentifierSet(string[] calldata values) external pure returns (uint256) {
        return MandateCodec.encodeIdentifierSet(values).length;
    }

    function hashEncodedSet(string[] calldata values) external pure returns (uint256) {
        return uint256(keccak256(MandateCodec.encodeIdentifierSet(values)));
    }

    /// @dev Searches for the last entry: the most a search can do.
    function containsLast(string[] calldata values) external pure returns (uint256) {
        bytes32 target = keccak256(bytes(values[values.length - 1]));
        return MandateCodec.contains(values, target) ? 1 : 0;
    }

    function noopAsset(CanonicalAsset calldata a) external pure returns (uint256) {
        return bytes(a.value).length;
    }

    function assetHash(CanonicalAsset calldata a) external pure returns (uint256) {
        return uint256(MandateCodec.assetHash(a));
    }

    function noopAddress(address party) external pure returns (uint256) {
        return uint160(party);
    }

    function encodeParty(address party) external pure returns (uint256) {
        return MandateCodec.encodeParty(party).length;
    }
}
