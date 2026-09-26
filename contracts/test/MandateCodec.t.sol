// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Candidate, Mandate} from "../src/MandateTypes.sol";
import {MandateCodec} from "../src/libraries/MandateCodec.sol";
import {GateTestBase} from "./utils/GateTestBase.sol";

/// @notice Unit and property tests of the Solidity MCE codec. Byte-level
/// agreement with the kernel is established by `Differential.t.sol`; these pin
/// the rules locally so a failure names the rule.
contract MandateCodecTest is GateTestBase {
    function test_identifier_acceptsTheKernelCharset() public view {
        string[6] memory ok = ["a", "A.b", "eip155:46630/erc20:0xabc", "issuer.alpha", "a_b-c", "Z9"];
        for (uint256 i = 0; i < ok.length; ++i) {
            assertTrue(harness.isIdentifier(ok[i]), ok[i]);
        }
        assertTrue(harness.isIdentifier(string(_repeat("x", 128))));
    }

    function test_identifier_refusesEverythingElse() public view {
        string[9] memory bad = ["", ".a", "a.", "/a", "a:", "a b", unicode"é", "a\x00", "a\n"];
        for (uint256 i = 0; i < bad.length; ++i) {
            assertFalse(harness.isIdentifier(bad[i]), bad[i]);
        }
        assertFalse(harness.isIdentifier(string(_repeat("x", 129))));
    }

    function _repeat(bytes1 b, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i = 0; i < n; ++i) {
            out[i] = b;
        }
    }

    function testFuzz_identifier_acceptanceImpliesTheKernelShape(bytes memory raw) public view {
        vm.assume(raw.length <= 200);
        if (!harness.isIdentifier(string(raw))) return;
        assertGt(raw.length, 0);
        assertLe(raw.length, 128);
        for (uint256 i = 0; i < raw.length; ++i) {
            uint8 c = uint8(raw[i]);
            bool alnum = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
            bool sep = c == 0x2e || c == 0x5f || c == 0x2d || c == 0x3a || c == 0x2f;
            assertTrue(alnum || (sep && i != 0 && i != raw.length - 1));
        }
    }

    function test_sets_mustBeStrictlyAscendingByLengthThenBytes() public view {
        string[] memory empty = new string[](0);
        assertTrue(harness.isIdentifierSet(empty));
        assertTrue(harness.isIdentifierSet(_two("b", "aa"))); // shorter first, not lexicographic
        assertFalse(harness.isIdentifierSet(_two("aa", "b")));
        assertTrue(harness.isIdentifierSet(_two("aa", "ab")));
        assertFalse(harness.isIdentifierSet(_two("ab", "aa")));
        assertFalse(harness.isIdentifierSet(_two("a", "a")));
        assertFalse(harness.isIdentifierSet(_two("a", "")));
    }

    function test_sets_areBoundedAtTheKernelMaximum() public view {
        string[] memory big = new string[](1025);
        for (uint256 i = 0; i < big.length; ++i) {
            big[i] = string(abi.encodePacked("i", _pad4(i)));
        }
        assertFalse(harness.isIdentifierSet(big));
        string[] memory max = new string[](1024);
        for (uint256 i = 0; i < max.length; ++i) {
            max[i] = big[i];
        }
        assertTrue(harness.isIdentifierSet(max));
    }

    function _pad4(uint256 i) internal pure returns (bytes memory) {
        bytes memory d = bytes(vm.toString(i));
        return bytes.concat(_repeat("0", 4 - d.length), d);
    }

    function test_mandate_validityRules() public view {
        Mandate memory m = _mandate();
        assertEq(uint8(harness.validateMandate(m)), uint8(MandateCodec.Validity.VALID));

        m.version = 3;
        assertEq(uint8(harness.validateMandate(m)), uint8(MandateCodec.Validity.UNSUPPORTED_VERSION));

        m = _mandate();
        m.notBeforeUnixSeconds = m.expiresAtUnixSeconds;
        assertEq(uint8(harness.validateMandate(m)), uint8(MandateCodec.Validity.MALFORMED));

        m = _mandate();
        m.economicLimit.unit = "EUR";
        assertEq(uint8(harness.validateMandate(m)), uint8(MandateCodec.Validity.MALFORMED));

        m = _mandate();
        m.economicLimit.decimals = 39;
        assertEq(uint8(harness.validateMandate(m)), uint8(MandateCodec.Validity.MALFORMED));

        m = _mandate();
        m.haltPolicy = 0;
        assertEq(uint8(harness.validateMandate(m)), uint8(MandateCodec.Validity.MALFORMED));
    }

    function test_mandate_encodingStartsWithTheDomainTagAndVersion() public view {
        bytes memory e = harness.encodeMandate(_mandate());
        bytes memory head = bytes("MANDATE.MANDATE.V2");
        for (uint256 i = 0; i < head.length; ++i) {
            assertEq(e[i], head[i]);
        }
        assertEq(uint8(e[head.length]), 0);
        assertEq(uint8(e[head.length + 1]), 2);
    }

    function test_candidate_encodingStartsWithItsOwnDomainTag() public view {
        bytes memory e = harness.encodeCandidate(_candidate());
        bytes memory head = bytes("MANDATE.CANDIDATE.V3");
        for (uint256 i = 0; i < head.length; ++i) {
            assertEq(e[i], head[i]);
        }
    }

    /// Length prefixes make the encoding injective: moving bytes between two
    /// adjacent strings changes the digest even though the concatenation is equal.
    function test_mandate_encodingIsInjectiveAcrossAdjacentStrings() public view {
        Mandate memory a = _mandate();
        Mandate memory b = _mandate();
        a.canonicalAsset.assetClass = "equityi";
        a.canonicalAsset.idScheme = "sin";
        b.canonicalAsset.assetClass = "equity";
        b.canonicalAsset.idScheme = "isin";
        assertTrue(harness.mandateDigest(a) != harness.mandateDigest(b));
    }

    function testFuzz_mandate_everyNumericFieldIsCommitted(uint64 nonce, uint256 limitAtoms, int64 expiry, uint16 bps)
        public
        view
    {
        Mandate memory base = _mandate();
        bytes32 baseline = harness.mandateDigest(base);
        Mandate memory m = _mandate();
        m.nonce = nonce;
        m.economicLimit.atoms = limitAtoms;
        m.expiresAtUnixSeconds = expiry;
        m.maxDeviationBps = bps;
        bool same = nonce == base.nonce && limitAtoms == base.economicLimit.atoms && expiry == base.expiresAtUnixSeconds
            && bps == base.maxDeviationBps;
        assertEq(harness.mandateDigest(m) == baseline, same);
    }

    function testFuzz_candidate_quantityAndProvenanceAreCommitted(uint256 atoms, bytes32 stateDigest) public view {
        Candidate memory base = _candidate();
        Candidate memory c = _candidate();
        c.quantity.atoms = atoms;
        c.evaluationStateDigest = stateDigest;
        bool same = atoms == base.quantity.atoms && stateDigest == base.evaluationStateDigest;
        assertEq(harness.candidateDigest(c) == harness.candidateDigest(base), same);
    }

    function test_representationId_matchesTheRegistrySpelling() public view {
        assertEq(
            harness.representationId(4663, 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9),
            "eip155:4663/erc20:0xaf3d76f1834a1d425780943c99ea8a608f8a93f9"
        );
    }
}
