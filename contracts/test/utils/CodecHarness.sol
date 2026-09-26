// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Candidate, Mandate} from "../../src/MandateTypes.sol";
import {MandateCodec} from "../../src/libraries/MandateCodec.sol";

/// @notice Exposes the codec's calldata functions to tests that build structs in memory.
contract CodecHarness {
    function validateMandate(Mandate calldata m) external pure returns (MandateCodec.Validity) {
        return MandateCodec.validateMandate(m);
    }

    function isValidCandidate(Candidate calldata c) external pure returns (bool) {
        return MandateCodec.isValidCandidate(c);
    }

    function encodeMandate(Mandate calldata m) external pure returns (bytes memory) {
        return MandateCodec.encodeMandate(m);
    }

    function encodeCandidate(Candidate calldata c) external pure returns (bytes memory) {
        return MandateCodec.encodeCandidate(c);
    }

    function mandateDigest(Mandate calldata m) external pure returns (bytes32) {
        return MandateCodec.mandateDigest(m);
    }

    function candidateDigest(Candidate calldata c) external pure returns (bytes32) {
        return MandateCodec.candidateDigest(c);
    }

    function isIdentifier(string calldata s) external pure returns (bool) {
        return MandateCodec.isIdentifier(s);
    }

    function isIdentifierSet(string[] calldata values) external pure returns (bool) {
        return MandateCodec.isIdentifierSet(values);
    }

    function representationId(uint256 chainId, address token) external pure returns (string memory) {
        return MandateCodec.representationId(chainId, token);
    }
}
