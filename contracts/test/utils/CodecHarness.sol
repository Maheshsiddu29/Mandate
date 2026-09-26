// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Candidate, Mandate} from "../../src/MandateTypes.sol";
import {MandateCodec} from "../../src/libraries/MandateCodec.sol";
import {GateArithmetic} from "../../src/libraries/GateArithmetic.sol";

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

    function notionalBounds(uint256 q, uint8 qd, uint256 p, uint8 pd, uint8 td)
        external
        pure
        returns (bool, uint256, uint256)
    {
        return GateArithmetic.notionalBounds(q, qd, p, pd, td);
    }

    function compareAmounts(uint256 a, uint8 ad, uint256 b, uint8 bd) external pure returns (int8) {
        return GateArithmetic.compare(a, ad, b, bd);
    }
}
