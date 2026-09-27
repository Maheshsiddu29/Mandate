// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {CanonicalAsset, Candidate, Mandate} from "../../src/MandateTypes.sol";
import {MandateCodec} from "../../src/libraries/MandateCodec.sol";
import {ReferenceMandateCodec} from "../reference/ReferenceMandateCodec.sol";

/// @notice The pre-optimization encoder (`ReferenceMandateCodec`) and the
/// production single-buffer encoder (`MandateCodec`) side by side, each pair
/// returning `(reference, production)` bytes from the same calldata (Phase 6R.2B).
contract EncodingHarness {
    function mandate(Mandate calldata m) external pure returns (bytes memory, bytes memory) {
        return (ReferenceMandateCodec.encodeMandate(m), MandateCodec.encodeMandate(m));
    }

    function candidate(Candidate calldata c) external pure returns (bytes memory, bytes memory) {
        return (ReferenceMandateCodec.encodeCandidate(c), MandateCodec.encodeCandidate(c));
    }

    function party(address a) external pure returns (bytes memory, bytes memory) {
        return (ReferenceMandateCodec.encodeParty(a), MandateCodec.encodeParty(a));
    }

    function str(string calldata s) external pure returns (bytes memory, bytes memory) {
        return (ReferenceMandateCodec.encodeString(s), MandateCodec.encodeString(s));
    }

    function set(string[] calldata values) external pure returns (bytes memory, bytes memory) {
        return (ReferenceMandateCodec.encodeIdentifierSet(values), MandateCodec.encodeIdentifierSet(values));
    }

    function assetHashes(CanonicalAsset calldata a) external pure returns (bytes32, bytes32) {
        return (ReferenceMandateCodec.assetHash(a), MandateCodec.assetHash(a));
    }

    function digests(Mandate calldata m, Candidate calldata c)
        external
        pure
        returns (bytes32 referenceMandate, bytes32 mandate_, bytes32 referenceCandidate, bytes32 candidate_)
    {
        return (
            ReferenceMandateCodec.mandateDigest(m),
            MandateCodec.mandateDigest(m),
            ReferenceMandateCodec.candidateDigest(c),
            MandateCodec.candidateDigest(c)
        );
    }

    /// @notice Encodes the mandate, allocates and fills an unrelated buffer,
    /// encodes the candidate, then returns all three: neither encoding may
    /// have written into memory another allocation owns, and each must end in
    /// zeroed padding and leave the free-memory pointer word-aligned past it.
    function interleaved(Mandate calldata m, Candidate calldata c)
        external
        pure
        returns (bytes memory encodedMandate, bytes memory filler, bytes memory encodedCandidate, bool clean)
    {
        encodedMandate = MandateCodec.encodeMandate(m);
        clean = _cleanTail(encodedMandate);
        filler = new bytes(77);
        for (uint256 i = 0; i < filler.length; ++i) {
            filler[i] = 0xa5;
        }
        encodedCandidate = MandateCodec.encodeCandidate(c);
        clean = clean && _cleanTail(encodedCandidate);
    }

    /// @dev The word after the data is zero, and the free-memory pointer is
    /// word-aligned and at or past it.
    function _cleanTail(bytes memory b) private pure returns (bool ok) {
        assembly ("memory-safe") {
            let end := add(add(b, 0x20), mload(b))
            let fmp := mload(0x40)
            ok := and(iszero(mload(end)), and(iszero(and(fmp, 0x1f)), iszero(lt(fmp, add(end, 0x20)))))
        }
    }
}
