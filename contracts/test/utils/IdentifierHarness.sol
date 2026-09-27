// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {MandateCodec} from "../../src/libraries/MandateCodec.sol";
import {ReferenceMandateCodec} from "../reference/ReferenceMandateCodec.sol";

/// @notice Every identifier validator, comparator and set checker the repository
/// holds, side by side, so one call answers "do they all agree?" (Phase 6R.2B).
///
/// Index 0 is always the byte-at-a-time reference (`ReferenceMandateCodec`); the
/// others are the implementations under test. Each takes calldata exactly as the
/// gate does, so a caller that dirties the ABI padding after an operand dirties
/// the bytes the optimized readers see.
contract IdentifierHarness {
    function validatorNames() external pure returns (string[] memory names) {
        names = new string[](3);
        names[0] = "reference";
        names[1] = "production calldata";
        names[2] = "production memory";
    }

    function validators(bytes calldata s) external pure returns (bool[] memory out) {
        out = new bool[](3);
        out[0] = ReferenceMandateCodec.isIdentifierBytes(s);
        out[1] = MandateCodec.isIdentifier(string(s));
        out[2] = MandateCodec.isIdentifierBytes(s);
    }

    /// @notice The memory validator over the first `logicalLength` bytes of
    /// `physical`, with the rest of `physical` left in memory directly after
    /// them: the dirty-tail shape for memory input.
    function memoryValidatorWithTail(bytes calldata physical, uint256 logicalLength) external pure returns (bool) {
        require(logicalLength <= physical.length, "harness: logical length");
        bytes memory b = physical;
        assembly ("memory-safe") {
            mstore(b, logicalLength)
        }
        return MandateCodec.isIdentifierBytes(b);
    }

    function comparatorNames() external pure returns (string[] memory names) {
        names = new string[](2);
        names[0] = "reference";
        names[1] = "production";
    }

    function comparators(bytes calldata a, bytes calldata b) external pure returns (int256[] memory out) {
        out = new int256[](2);
        out[0] = ReferenceMandateCodec.compareEncoded(a, b);
        out[1] = MandateCodec.compareEncoded(a, b);
    }

    function sets(string[] calldata values) external pure returns (bool[] memory out) {
        out = new bool[](2);
        out[0] = ReferenceMandateCodec.isIdentifierSet(values);
        out[1] = MandateCodec.isIdentifierSet(values);
    }
}
