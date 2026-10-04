// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {MandateDelegatedExecutionGate} from "../src/MandateDelegatedExecutionGate.sol";
import {Candidate, ExecutionTerms, Mandate} from "../src/MandateTypes.sol";
import {DelegatedGateTestBase} from "./utils/DelegatedGateTestBase.sol";

/// @notice Property / fuzz coverage for V3 delegated execution.
contract DelegatedFuzzTest is DelegatedGateTestBase {
    function testFuzz_cumulativeSpendNeverExceedsCap(uint8 trades, uint256 capRaw) public {
        uint8 n = uint8(bound(trades, 1, 8));
        uint256 cap = bound(capRaw, EXACT_DEBIT, EXACT_DEBIT * 8);
        MandateDelegatedExecutionGate.Delegation memory d = _delegation(cap);
        bytes memory ps = _signDelegation(d);

        uint256 succeeded;
        for (uint64 i = 1; i <= n; ++i) {
            Mandate memory m = _mandate();
            m.nonce = i;
            m.mandateId = bytes32(uint256(i));
            Candidate memory c = _candidate();
            c.evaluationStateDigest = bytes32(uint256(0xe0) + i);
            ExecutionTerms memory t = _terms();
            bytes memory as_ = _signAgent(m, c, t);
            bytes memory ds = _signDelegate(d, m, c, t, i);
            uint256 usedBefore = dgate.usedDebitOf(dgate.delegationDigest(d));
            if (usedBefore + EXACT_DEBIT > cap) {
                vm.expectRevert();
                dgate.execute(d, ps, m, c, t, as_, i, ds);
                break;
            }
            (, uint256 debit,) = dgate.execute(d, ps, m, c, t, as_, i, ds);
            assertEq(debit, EXACT_DEBIT);
            succeeded += 1;
            assertLe(dgate.usedDebitOf(dgate.delegationDigest(d)), cap);
        }
        assertLe(dgate.usedDebitOf(dgate.delegationDigest(d)), cap);
        assertEq(dgate.usedDebitOf(dgate.delegationDigest(d)), succeeded * EXACT_DEBIT);
    }

    function testFuzz_unauthorizedRecipientNeverSucceeds(address recipient) public {
        vm.assume(recipient != principal);
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        t.recipient = recipient;
        _expectRevert(d, m, c, t, 1, _err(MandateDelegatedExecutionGate.RecipientNotPrincipal.selector));
    }

    function testFuzz_unsignedDelegateNeverSucceeds(uint256 badKey) public {
        badKey = bound(badKey, 1, type(uint128).max);
        vm.assume(badKey != DELEGATE_KEY);
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        bytes memory ps = _signDelegation(d);
        bytes memory as_ = _signAgent(m, c, t);
        bytes memory bad = _sign(badKey, _eip712(_approvalHash(d, m, c, t, 1)));
        vm.expectRevert(MandateDelegatedExecutionGate.DelegateSignatureInvalid.selector);
        dgate.execute(d, ps, m, c, t, as_, 1, bad);
    }

    function testFuzz_replayedNonceNeverSucceeds(uint64 nonce) public {
        nonce = uint64(bound(nonce, 1, type(uint32).max));
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        _execute(d, m, c, t, nonce);
        _expectRevert(d, m, c, t, nonce, _err(MandateDelegatedExecutionGate.ExecutionNonceAlreadyUsed.selector));
    }

    function testFuzz_executionMutationInvalidatesDelegateSignature(uint256 fundingBump) public {
        fundingBump = bound(fundingBump, 1, 100e6);
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        Mandate memory m = _mandate();
        m.economicLimit = _usd(2_010e18 + fundingBump * 1e12);
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        bytes memory ds = _signDelegate(d, m, c, t, 1);
        t.fundingLimit = EXACT_DEBIT + fundingBump;
        bytes memory ps = _signDelegation(d);
        bytes memory as_ = _signAgent(m, c, t);
        vm.expectRevert(MandateDelegatedExecutionGate.DelegateSignatureInvalid.selector);
        dgate.execute(d, ps, m, c, t, as_, 1, ds);
    }

    function testFuzz_delegationMutationInvalidatesPrincipalSignature(uint256 newCap) public {
        newCap = bound(newCap, 1, 1_000_000e6);
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        bytes memory ps = _signDelegation(d);
        vm.assume(newCap != d.cumulativeDebitLimit);
        d.cumulativeDebitLimit = newCap;
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        bytes memory as_ = _signAgent(m, c, t);
        bytes memory ds = _signDelegate(d, m, c, t, 1);
        vm.expectRevert(MandateDelegatedExecutionGate.PrincipalSignatureInvalid.selector);
        dgate.execute(d, ps, m, c, t, as_, 1, ds);
    }

    function testFuzz_successfulDebitAlwaysAccounted(uint64 nonce) public {
        nonce = uint64(bound(nonce, 1, type(uint32).max));
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        (, uint256 debit,) = _execute(d, _mandate(), _candidate(), _terms(), nonce);
        assertEq(dgate.usedDebitOf(dgate.delegationDigest(d)), debit);
        assertTrue(dgate.nonceUsed(dgate.delegationDigest(d), nonce));
    }

    function testFuzz_expiryBoundaryExactness(uint64 offset) public {
        offset = uint64(bound(offset, 0, 1_000));
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        d.validAfter = uint64(T0);
        d.validUntil = uint64(T0 + 100);
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();

        vm.warp(T0 + offset);
        if (offset < 100) {
            _execute(d, m, c, t, 1);
        } else {
            _expectRevert(d, m, c, t, 1, _err(MandateDelegatedExecutionGate.DelegationExpired.selector));
        }
    }

    function testFuzz_randomValidInvalidSequencePreservesInvariant(uint256 seed) public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation(EXACT_DEBIT * 5);
        bytes memory ps = _signDelegation(d);
        uint256 used;
        for (uint64 i = 1; i <= 10; ++i) {
            uint256 roll = uint256(keccak256(abi.encode(seed, i))) % 4;
            Mandate memory m = _mandate();
            m.nonce = i;
            m.mandateId = bytes32(uint256(i));
            Candidate memory c = _candidate();
            c.evaluationStateDigest = bytes32(uint256(i));
            ExecutionTerms memory t = _terms();
            if (roll == 0 && used + EXACT_DEBIT <= d.cumulativeDebitLimit) {
                bytes memory as_ = _signAgent(m, c, t);
                bytes memory ds = _signDelegate(d, m, c, t, i);
                (, uint256 debit,) = dgate.execute(d, ps, m, c, t, as_, i, ds);
                used += debit;
            } else if (roll == 1) {
                t.recipient = stranger;
                bytes memory as_ = _signAgent(m, c, t);
                bytes memory ds = _signDelegate(d, m, c, t, i);
                vm.expectRevert();
                dgate.execute(d, ps, m, c, t, as_, i, ds);
            } else if (roll == 2) {
                bytes memory as_ = _signAgent(m, c, t);
                bytes memory bad = _sign(STRANGER_KEY, _eip712(_approvalHash(d, m, c, t, i)));
                vm.expectRevert();
                dgate.execute(d, ps, m, c, t, as_, i, bad);
            } else if (used + EXACT_DEBIT > d.cumulativeDebitLimit) {
                bytes memory as_ = _signAgent(m, c, t);
                bytes memory ds = _signDelegate(d, m, c, t, i);
                vm.expectRevert();
                dgate.execute(d, ps, m, c, t, as_, i, ds);
            }
            assertEq(dgate.usedDebitOf(dgate.delegationDigest(d)), used);
            assertLe(used, d.cumulativeDebitLimit);
        }
    }
}
