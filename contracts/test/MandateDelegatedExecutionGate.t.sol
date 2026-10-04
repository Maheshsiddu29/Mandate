// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {MandateDelegatedExecutionGate} from "../src/MandateDelegatedExecutionGate.sol";
import {
    Candidate,
    ExecutionTerms,
    Mandate,
    SIDE_SELL
} from "../src/MandateTypes.sol";
import {ScriptedAdapter} from "./mocks/ScriptedAdapter.sol";
import {DelegatedGateTestBase} from "./utils/DelegatedGateTestBase.sol";

/// @notice Unit and adversarial coverage for C2.3 delegated execution.
contract MandateDelegatedExecutionGateTest is DelegatedGateTestBase {
    function test_domain_isMandateVersion3() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Mandate"),
                keccak256("3"),
                CHAIN,
                address(dgate)
            )
        );
        assertEq(dgate.domainSeparator(), expected);
        assertTrue(delegate != agent);
    }

    function test_1_validDelegatedExecutionSucceeds() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();

        uint256 fundingBefore = funding.balanceOf(principal);
        uint256 aaplBefore = aapl.balanceOf(principal);

        (bytes32 commitment, uint256 debit, uint256 credit) = _execute(d, m, c, t, 1);

        assertEq(debit, EXACT_DEBIT);
        assertEq(credit, 10e18);
        assertEq(funding.balanceOf(principal), fundingBefore - EXACT_DEBIT);
        assertEq(aapl.balanceOf(principal), aaplBefore + 10e18);
        assertTrue(commitment != bytes32(0));
        assertEq(dgate.usedDebitOf(dgate.delegationDigest(d)), EXACT_DEBIT);
        assertTrue(dgate.nonceUsed(dgate.delegationDigest(d), 1));
    }

    function test_2_samePrincipalSignatureSecondNonceSucceeds() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        bytes memory principalSig = _signDelegation(d);

        Mandate memory m1 = _mandate();
        Candidate memory c1 = _candidate();
        ExecutionTerms memory t1 = _terms();
        dgate.execute(d, principalSig, m1, c1, t1, _signAgent(m1, c1, t1), 1, _signDelegate(d, m1, c1, t1, 1));

        Mandate memory m2 = _mandate();
        m2.mandateId = bytes32(uint256(0x22));
        m2.nonce = 2;
        Candidate memory c2 = _candidate();
        c2.evaluationStateDigest = bytes32(uint256(0xe2));
        ExecutionTerms memory t2 = _terms();

        // Same principal signature reused; new nonce + new delegate/agent sigs.
        (, uint256 debit,) =
            dgate.execute(d, principalSig, m2, c2, t2, _signAgent(m2, c2, t2), 2, _signDelegate(d, m2, c2, t2, 2));
        assertEq(debit, EXACT_DEBIT);
        assertEq(dgate.usedDebitOf(dgate.delegationDigest(d)), EXACT_DEBIT * 2);
    }

    function test_3_sameExecutionNonceReplayReverts() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        _execute(d, m, c, t, 1);
        _expectRevert(d, m, c, t, 1, _err(MandateDelegatedExecutionGate.ExecutionNonceAlreadyUsed.selector));
    }

    function test_4_sameNonceModifiedCandidateReverts() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        bytes memory ps = _signDelegation(d);
        bytes memory as_ = _signAgent(m, c, t);
        bytes memory ds = _signDelegate(d, m, c, t, 1);
        dgate.execute(d, ps, m, c, t, as_, 1, ds);

        Candidate memory c2 = c;
        c2.evaluationStateDigest = bytes32(uint256(0xdead));
        bytes memory as2 = _signAgent(m, c2, t);
        // Old delegate signature over the original candidate cannot authorize c2.
        vm.expectRevert(MandateDelegatedExecutionGate.DelegateSignatureInvalid.selector);
        dgate.execute(d, ps, m, c2, t, as2, 1, ds);
    }

    function test_5_wrongDelegateSignatureReverts() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        bytes memory ps = _signDelegation(d);
        bytes memory as_ = _signAgent(m, c, t);
        bytes memory bad = _sign(STRANGER_KEY, _eip712(_approvalHash(d, m, c, t, 1)));
        vm.expectRevert(MandateDelegatedExecutionGate.DelegateSignatureInvalid.selector);
        dgate.execute(d, ps, m, c, t, as_, 1, bad);
    }

    function test_6_agentTriesToSignAsDelegateReverts() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        bytes memory ps = _signDelegation(d);
        bytes memory as_ = _signAgent(m, c, t);
        bytes memory agentAsDelegate = _sign(AGENT_KEY, _eip712(_approvalHash(d, m, c, t, 1)));
        vm.expectRevert(MandateDelegatedExecutionGate.DelegateSignatureInvalid.selector);
        dgate.execute(d, ps, m, c, t, as_, 1, agentAsDelegate);
    }

    function test_7_wrongAgentReverts() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        Mandate memory m = _mandate();
        m.agent = stranger;
        Candidate memory c = _candidate();
        c.agent = stranger;
        ExecutionTerms memory t = _terms();
        _expectRevert(d, m, c, t, 1, _err(MandateDelegatedExecutionGate.DelegationScopeMismatch.selector));
    }

    function test_8_wrongPrincipalReverts() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        d.principal = stranger;
        Mandate memory m = _mandate();
        m.principal = stranger;
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        t.recipient = stranger;
        // Principal sig is still from PRINCIPAL_KEY, not stranger.
        bytes memory ps = _signDelegation(d);
        bytes memory as_ = _signAgent(m, c, t);
        bytes memory ds = _signDelegate(d, m, c, t, 1);
        vm.expectRevert(MandateDelegatedExecutionGate.PrincipalSignatureInvalid.selector);
        dgate.execute(d, ps, m, c, t, as_, 1, ds);
    }

    function test_9_wrongChainReverts() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        bytes memory ps = _signDelegation(d);
        bytes memory as_ = _signAgent(m, c, t);
        bytes memory ds = _signDelegate(d, m, c, t, 1);
        vm.chainId(1);
        vm.expectRevert(MandateDelegatedExecutionGate.WrongChain.selector);
        dgate.execute(d, ps, m, c, t, as_, 1, ds);
    }

    function test_10_wrongGateDomainReverts() public {
        // Signature under a different verifyingContract cannot recover.
        MandateDelegatedExecutionGate other = new MandateDelegatedExecutionGate(_marketConfigs());
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        bytes32 structHash = other.delegationDigest(d);
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", other.domainSeparator(), structHash));
        bytes memory ps = _sign(PRINCIPAL_KEY, digest);
        bytes memory as_ = _signAgent(m, c, t);
        bytes memory ds = _signDelegate(d, m, c, t, 1);
        vm.expectRevert(MandateDelegatedExecutionGate.PrincipalSignatureInvalid.selector);
        dgate.execute(d, ps, m, c, t, as_, 1, ds);
    }

    function test_11_expiredDelegationReverts() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        d.validUntil = uint64(T0);
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        vm.warp(T0);
        _expectRevert(d, m, c, t, 1, _err(MandateDelegatedExecutionGate.DelegationExpired.selector));
    }

    function test_12_notYetValidDelegationReverts() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        d.validAfter = uint64(T0 + 100);
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        _expectRevert(d, m, c, t, 1, _err(MandateDelegatedExecutionGate.DelegationNotYetValid.selector));
    }

    function test_13_revokedDelegationReverts() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        vm.prank(principal);
        dgate.revokeDelegation(d);
        assertTrue(dgate.isRevoked(dgate.delegationDigest(d)));
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        _expectRevert(d, m, c, t, 1, _err(MandateDelegatedExecutionGate.DelegationRevokedError.selector));
    }

    function test_14_nonPrincipalRevokeReverts() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        vm.prank(stranger);
        vm.expectRevert(MandateDelegatedExecutionGate.NotDelegationPrincipal.selector);
        dgate.revokeDelegation(d);
    }

    function test_15_wrongRepresentationReverts() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        Mandate memory m = _mandate();
        Candidate memory c = _candidateFor(address(scriptedToken));
        c.venue = "venue.scripted";
        ExecutionTerms memory t = _terms();
        _expectRevert(d, m, c, t, 1, _err(MandateDelegatedExecutionGate.DelegationScopeMismatch.selector));
    }

    function test_16_wrongVenueReverts() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        c.venue = "venue.scripted";
        ExecutionTerms memory t = _terms();
        _expectRevert(d, m, c, t, 1, _err(MandateDelegatedExecutionGate.VenueMismatch.selector));
    }

    function test_17_wrongFundingTokenReverts() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        d.fundingToken = address(aapl);
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        _expectRevert(d, m, c, t, 1, _err(MandateDelegatedExecutionGate.DelegationScopeMismatch.selector));
    }

    function test_18_wrongRecipientReverts() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        t.recipient = stranger;
        _expectRevert(d, m, c, t, 1, _err(MandateDelegatedExecutionGate.RecipientNotPrincipal.selector));
    }

    function test_19_arbitraryExecutionDataReverts() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        t.executionData = hex"deadbeef";
        bytes memory ps = _signDelegation(d);
        bytes memory as_ = _signAgent(m, c, t);
        bytes memory ds = _signDelegate(d, m, c, t, 1);
        // Adapter refuses route data; signatures are valid so we reach the adapter.
        vm.expectRevert();
        dgate.execute(d, ps, m, c, t, as_, 1, ds);
    }

    function test_20_perExecutionDebitAboveRemainingCapacityReverts() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation(EXACT_DEBIT);
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        _execute(d, m, c, t, 1);

        Mandate memory m2 = _mandate();
        m2.nonce = 2;
        m2.mandateId = bytes32(uint256(0x22));
        Candidate memory c2 = _candidate();
        c2.evaluationStateDigest = bytes32(uint256(0xe2));
        ExecutionTerms memory t2 = _terms();
        _expectRevert(
            d,
            m2,
            c2,
            t2,
            2,
            abi.encodeWithSelector(
                MandateDelegatedExecutionGate.CumulativeDebitExceeded.selector, EXACT_DEBIT, EXACT_DEBIT, EXACT_DEBIT
            )
        );
    }

    function test_21_cumulativeMultiTradeOverCapReverts() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation(EXACT_DEBIT + EXACT_DEBIT - 1);
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        _execute(d, m, c, t, 1);

        Mandate memory m2 = _mandate();
        m2.nonce = 2;
        m2.mandateId = bytes32(uint256(0x22));
        Candidate memory c2 = _candidate();
        c2.evaluationStateDigest = bytes32(uint256(0xe2));
        ExecutionTerms memory t2 = _terms();
        _expectRevert(
            d,
            m2,
            c2,
            t2,
            2,
            abi.encodeWithSelector(
                MandateDelegatedExecutionGate.CumulativeDebitExceeded.selector,
                EXACT_DEBIT,
                EXACT_DEBIT,
                EXACT_DEBIT + EXACT_DEBIT - 1
            )
        );
    }

    function test_22_exactCapBoundarySucceeds() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation(EXACT_DEBIT);
        (, uint256 debit,) = _execute(d, _mandate(), _candidate(), _terms(), 1);
        assertEq(debit, EXACT_DEBIT);
        assertEq(dgate.usedDebitOf(dgate.delegationDigest(d)), EXACT_DEBIT);
    }

    function test_23_balanceDeltaMismatchReverts() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        d.representationIdHash = _keyOf(address(scriptedToken));
        Mandate memory m = _mandate();
        Candidate memory c = _candidateFor(address(scriptedToken));
        c.venue = "venue.scripted";
        ExecutionTerms memory t = _terms();

        scripted.setScript(
            ScriptedAdapter.Script({
                mode: ScriptedAdapter.Mode.SCRIPTED,
                deliver: 9e18, // short credit
                refund: 0,
                deliverTo: address(0),
                reentryTarget: address(0),
                reentryPayload: "",
                bubbleReentry: false,
                extraPull: 0
            })
        );
        _expectRevert(
            d,
            m,
            c,
            t,
            1,
            abi.encodeWithSelector(MandateDelegatedExecutionGate.CreditNotExact.selector, uint256(9e18), uint256(10e18))
        );
        assertFalse(dgate.nonceUsed(dgate.delegationDigest(d), 1));
        assertEq(dgate.usedDebitOf(dgate.delegationDigest(d)), 0);
    }

    function test_24_tokenDecimalMismatchReverts() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        aapl.setDecimals(8);
        _expectRevert(d, m, c, t, 1, abi.encodeWithSelector(MandateDelegatedExecutionGate.TokenDecimalsChanged.selector, address(aapl)));
    }

    function test_25_reentrancyAttemptFails() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        d.representationIdHash = _keyOf(address(scriptedToken));
        Mandate memory m = _mandate();
        Candidate memory c = _candidateFor(address(scriptedToken));
        c.venue = "venue.scripted";
        ExecutionTerms memory t = _terms();

        bytes memory payload = abi.encodeCall(
            dgate.execute,
            (d, _signDelegation(d), m, c, t, _signAgent(m, c, t), uint64(2), _signDelegate(d, m, c, t, 2))
        );
        scripted.setScript(
            ScriptedAdapter.Script({
                mode: ScriptedAdapter.Mode.REENTER,
                deliver: 10e18,
                refund: 0,
                deliverTo: address(0),
                reentryTarget: address(dgate),
                reentryPayload: payload,
                bubbleReentry: false,
                extraPull: 0
            })
        );
        _execute(d, m, c, t, 1);
        assertFalse(scripted.reentrySucceeded());
        assertEq(scripted.reentryResult(), _err(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
    }

    function test_26_failedExternalInteractionRollsBackNonceAndCap() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        d.representationIdHash = _keyOf(address(scriptedToken));
        Mandate memory m = _mandate();
        Candidate memory c = _candidateFor(address(scriptedToken));
        c.venue = "venue.scripted";
        ExecutionTerms memory t = _terms();

        scripted.setScript(
            ScriptedAdapter.Script({
                mode: ScriptedAdapter.Mode.SCRIPTED,
                deliver: 0,
                refund: 0,
                deliverTo: address(0),
                reentryTarget: address(0),
                reentryPayload: "",
                bubbleReentry: false,
                extraPull: 0
            })
        );
        _expectRevert(
            d,
            m,
            c,
            t,
            7,
            abi.encodeWithSelector(MandateDelegatedExecutionGate.CreditNotExact.selector, uint256(0), uint256(10e18))
        );
        assertFalse(dgate.nonceUsed(dgate.delegationDigest(d), 7));
        assertEq(dgate.usedDebitOf(dgate.delegationDigest(d)), 0);
    }

    function test_27_modifiedDelegationFieldInvalidatesPrincipalSignature() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        bytes memory ps = _signDelegation(d);
        d.cumulativeDebitLimit = d.cumulativeDebitLimit - 1;
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        bytes memory as_ = _signAgent(m, c, t);
        bytes memory ds = _signDelegate(d, m, c, t, 1);
        vm.expectRevert(MandateDelegatedExecutionGate.PrincipalSignatureInvalid.selector);
        dgate.execute(d, ps, m, c, t, as_, 1, ds);
    }

    function test_28_modifiedExecutionFieldInvalidatesDelegateSignature() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        bytes memory ds = _signDelegate(d, m, c, t, 1);
        t.fundingLimit = EXACT_DEBIT + 1;
        // Mandate economic limit still allows +1; agent sig must be rebuilt but
        // delegate sig is stale.
        m.economicLimit = _usd(2_011e18);
        bytes memory ps = _signDelegation(d);
        bytes memory as_ = _signAgent(m, c, t);
        vm.expectRevert(MandateDelegatedExecutionGate.DelegateSignatureInvalid.selector);
        dgate.execute(d, ps, m, c, t, as_, 1, ds);
    }

    function test_sellSideRefused() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        Mandate memory m = _mandate();
        m.side = SIDE_SELL;
        m.economicLimit = _usd(1_990e18);
        Candidate memory c = _candidate();
        c.side = SIDE_SELL;
        ExecutionTerms memory t = _terms();
        t.fundingLimit = 1_990e6;
        _expectRevert(d, m, c, t, 1, _err(MandateDelegatedExecutionGate.SideNotSupported.selector));
    }

    function test_revokeEmitsEvent() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        vm.expectEmit(true, true, false, true);
        emit MandateDelegatedExecutionGate.DelegationRevoked(dgate.delegationDigest(d), principal, 1);
        vm.prank(principal);
        dgate.revokeDelegation(d);
    }

    function test_zeroCumulativeLimitRejected() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation(0);
        _expectRevert(
            d, _mandate(), _candidate(), _terms(), 1, _err(MandateDelegatedExecutionGate.InvalidDelegationParties.selector)
        );
    }

    function test_delegateEqualsAgentRejected() public {
        MandateDelegatedExecutionGate.Delegation memory d = _delegation();
        d.delegate = agent;
        _expectRevert(
            d, _mandate(), _candidate(), _terms(), 1, _err(MandateDelegatedExecutionGate.InvalidDelegationParties.selector)
        );
    }
}
