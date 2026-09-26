// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {MandateExecutionGate} from "../src/MandateExecutionGate.sol";
import {Candidate, ExecutionTerms, Mandate, MarketConfig, SIDE_BUY, SIDE_SELL} from "../src/MandateTypes.sol";
import {ExecutionOrder} from "../src/interfaces/IMandateExecutionAdapter.sol";
import {FixtureVenue} from "../src/fixture/FixtureVenue.sol";
import {FixtureVenueAdapter} from "../src/fixture/FixtureVenueAdapter.sol";
import {
    FailZeroApproveToken,
    FeeOnTransferToken,
    HookToken,
    MalformedReturnERC20,
    NoReturnERC20
} from "./mocks/MockTokens.sol";
import {ScriptedAdapter} from "./mocks/ScriptedAdapter.sol";
import {GateTestBase} from "./utils/GateTestBase.sol";

/// @notice The gate against adapters, venues and tokens that lie, under-deliver,
/// redirect, over-pull, revert, burn gas or re-enter. Settlement is decided on
/// measured balances, so none of them can make a violating execution settle, and
/// none of them can leave an authorization consumed by a transaction that reverted.
contract AdversarialTest is GateTestBase {
    uint256 internal constant QTY = 10e18;

    function _scripted(ScriptedAdapter.Mode mode, uint256 deliver, uint256 refund, address deliverTo, uint256 extraPull)
        internal
    {
        scripted.setScript(
            ScriptedAdapter.Script({
                mode: mode,
                deliver: deliver,
                refund: refund,
                deliverTo: deliverTo,
                reentryTarget: address(0),
                reentryPayload: "",
                bubbleReentry: false,
                extraPull: extraPull
            })
        );
    }

    function _buy() internal view returns (Mandate memory, Candidate memory, ExecutionTerms memory) {
        return (_mandate(), _scriptedCandidate(SIDE_BUY), _terms());
    }

    function _assertUnconsumed(Mandate memory m) internal view {
        assertEq(gate.executionCommitmentOf(harness.mandateDigest(m)), bytes32(0), "authorization consumed by a revert");
    }

    // ------------------------------------------------------------------
    // Lying and misdelivering adapters
    // ------------------------------------------------------------------

    function test_scripted_honestAdapterSettles() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = _buy();
        _scriptHonest(QTY, 4e6);
        (, uint256 debit, uint256 credit) = _execute(m, c, t);
        assertEq(debit, 2_006e6);
        assertEq(credit, QTY);
    }

    function test_unrelatedAdapterInventoryCanSatisfyDeltas_butDoesNotProveVenueProvenance() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = _buy();
        // The scripted adapter's inventory was minted directly to it, not
        // obtained from a venue. Settlement proves the principal's outcome,
        // deliberately not the provenance of the inventory.
        _scriptHonest(QTY, 4e6);
        (,, uint256 credit) = _execute(m, c, t);
        assertEq(credit, QTY);
    }

    function test_underDeliveryByOneAtomRefuses() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = _buy();
        _scriptHonest(QTY - 1, 0);
        _expectRevert(m, c, t, abi.encodeWithSelector(MandateExecutionGate.CreditNotExact.selector, QTY - 1, QTY));
        _assertUnconsumed(m);
    }

    function test_buyOverDeliveryRefusesExactFill() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = _buy();
        _scriptHonest(QTY + 1, 0);
        _expectRevert(m, c, t, abi.encodeWithSelector(MandateExecutionGate.CreditNotExact.selector, QTY + 1, QTY));
        _assertUnconsumed(m);
    }

    function test_adapterClaimingAHugeFillWhileDeliveringNothingRefuses() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = _buy();
        _scripted(ScriptedAdapter.Mode.RETURN_GARBAGE, 0, 0, address(0), 0);
        _expectRevert(m, c, t, abi.encodeWithSelector(MandateExecutionGate.CreditNotExact.selector, 0, QTY));
        _assertUnconsumed(m);
    }

    function test_adapterReturnDataIsIgnoredWhenDeliveryIsCorrect() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = _buy();
        _scripted(ScriptedAdapter.Mode.RETURN_GARBAGE, QTY, 0, address(0), 0);
        (,, uint256 credit) = _execute(m, c, t);
        assertEq(credit, QTY);
    }

    function test_recipientSubstitutionByTheAdapterRefuses() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = _buy();
        _scripted(ScriptedAdapter.Mode.SCRIPTED, QTY, 0, stranger, 0);
        _expectRevert(m, c, t, abi.encodeWithSelector(MandateExecutionGate.CreditNotExact.selector, 0, QTY));
        assertEq(scriptedToken.balanceOf(stranger), 0);
        _assertUnconsumed(m);
    }

    function test_adapterCannotSpendMoreThanTheGateTransferred_evenWithAStrayAllowance() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = _buy();
        // A principal mistake the gate does not control: a direct allowance to the adapter.
        vm.prank(principal);
        funding.approve(address(scripted), 1);
        _scripted(ScriptedAdapter.Mode.PULL_FROM_PRINCIPAL, QTY, 0, address(0), 1);
        _expectRevert(
            m, c, t, abi.encodeWithSelector(MandateExecutionGate.DebitExceedsLimit.selector, 2_010e6 + 1, 2_010e6)
        );
        _assertUnconsumed(m);
    }

    function test_adapterHasNoAuthorityOverThePrincipalWithoutAnAllowance() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = _buy();
        _scripted(ScriptedAdapter.Mode.PULL_FROM_PRINCIPAL, QTY, 0, address(0), 1);
        _expectRevert(
            m, c, t, abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(scripted), 0, 1)
        );
    }

    function test_sellUnderProceedsRefuses() public {
        Mandate memory m = _sellMandate();
        Candidate memory c = _scriptedCandidate(SIDE_SELL);
        ExecutionTerms memory t = _sellTerms();
        _scriptHonest(1_990e6 - 1, 0);
        _expectRevert(
            m, c, t, abi.encodeWithSelector(MandateExecutionGate.CreditBelowMinimum.selector, 1_990e6 - 1, 1_990e6)
        );
    }

    function test_sellPartialFillWithAdequateProceedsRefusesExactFill() public {
        Mandate memory m = _sellMandate();
        Candidate memory c = _scriptedCandidate(SIDE_SELL);
        ExecutionTerms memory t = _sellTerms();
        _scriptHonest(1_990e6, 1e18); // refunds 1 token: sells 9 for the full floor
        _expectRevert(m, c, t, abi.encodeWithSelector(MandateExecutionGate.DebitNotExact.selector, QTY - 1e18, QTY));
        _assertUnconsumed(m);
    }

    function test_sellOverDebitRefusesExactFill() public {
        Mandate memory m = _sellMandate();
        Candidate memory c = _scriptedCandidate(SIDE_SELL);
        ExecutionTerms memory t = _sellTerms();
        vm.prank(principal);
        scriptedToken.approve(address(scripted), 1);
        _scripted(ScriptedAdapter.Mode.PULL_FROM_PRINCIPAL, 1_990e6, 0, address(0), 1);
        _expectRevert(m, c, t, abi.encodeWithSelector(MandateExecutionGate.DebitNotExact.selector, QTY + 1, QTY));
        _assertUnconsumed(m);
    }

    // ------------------------------------------------------------------
    // External failure
    // ------------------------------------------------------------------

    function test_adapterRevertBubblesAndConsumesNothing() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = _buy();
        _scripted(ScriptedAdapter.Mode.REVERT, 0, 0, address(0), 0);
        _expectRevert(m, c, t, _err(ScriptedAdapter.ScriptedRevert.selector));
        _assertUnconsumed(m);
        uint256 fundingBefore = funding.balanceOf(principal);
        _scriptHonest(QTY, 0);
        _execute(m, c, t);
        assertEq(fundingBefore - funding.balanceOf(principal), 2_010e6);
    }

    function test_largeAdapterReturnDataIsIgnoredAfterExactSettlement() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = _buy();
        _scripted(ScriptedAdapter.Mode.LARGE_RETURN, QTY, 0, address(0), 0);
        (,, uint256 credit) = _execute(m, c, t);
        assertEq(credit, QTY);
    }

    function test_largeAdapterRevertDataRevertsAtomically() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = _buy();
        uint256 fundingBefore = funding.balanceOf(principal);
        uint256 representationBefore = scriptedToken.balanceOf(principal);
        _scripted(ScriptedAdapter.Mode.LARGE_REVERT, QTY, 0, address(0), 0);
        bytes memory ps = _signMandate(m);
        bytes memory as_ = _signExecution(m, c, t);
        (bool ok,) = address(gate).call{gas: 10_000_000}(abi.encodeCall(gate.execute, (m, ps, c, t, as_)));
        assertFalse(ok);
        assertEq(funding.balanceOf(principal), fundingBefore);
        assertEq(scriptedToken.balanceOf(principal), representationBefore);
        _assertUnconsumed(m);
    }

    function test_adapterBurningAllGasRevertsAtomically() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = _buy();
        _scripted(ScriptedAdapter.Mode.BURN_GAS, 0, 0, address(0), 0);
        bytes memory ps = _signMandate(m);
        bytes memory as_ = _signExecution(m, c, t);
        (bool ok,) = address(gate).call{gas: 2_000_000}(abi.encodeCall(gate.execute, (m, ps, c, t, as_)));
        assertFalse(ok);
        _assertUnconsumed(m);
    }

    function test_insufficientAllowanceSurfacesTheTokenErrorAndConsumesNothing() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = _buy();
        vm.prank(principal);
        funding.approve(address(gate), 2_010e6 - 1);
        _expectRevert(
            m,
            c,
            t,
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(gate), 2_010e6 - 1, 2_010e6
            )
        );
        _assertUnconsumed(m);
    }

    function test_exactPerMandateAllowanceIsSufficientAndLeftAtZero() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = _buy();
        vm.prank(principal);
        funding.approve(address(gate), 2_010e6);
        _scriptHonest(QTY, 0);
        _execute(m, c, t);
        assertEq(funding.allowance(principal, address(gate)), 0);
    }

    function test_revokingTheAllowanceStopsEverySignedExecution() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = _buy();
        vm.prank(principal);
        funding.approve(address(gate), 0);
        _expectRevert(
            m, c, t, abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(gate), 0, 2_010e6)
        );
    }

    // ------------------------------------------------------------------
    // Reentrancy
    // ------------------------------------------------------------------

    function _reenter(bytes memory payload, bool bubble) internal {
        scripted.setScript(
            ScriptedAdapter.Script({
                mode: ScriptedAdapter.Mode.REENTER,
                deliver: QTY,
                refund: 0,
                deliverTo: address(0),
                reentryTarget: address(gate),
                reentryPayload: payload,
                bubbleReentry: bubble,
                extraPull: 0
            })
        );
    }

    function test_reentryWithTheSameAuthorizationIsBlocked_andOnlyOneSettles() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = _buy();
        bytes memory payload = abi.encodeCall(gate.execute, (m, _signMandate(m), c, t, _signExecution(m, c, t)));
        _reenter(payload, false);
        (bool ok,) = address(gate).call(payload);
        assertTrue(ok, "outer execution");
        assertFalse(scripted.reentrySucceeded());
        assertEq(scripted.reentryResult(), _err(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        assertEq(gate.executionCommitmentOf(harness.mandateDigest(m)), _commitment(m, c, t));
        assertEq(scriptedToken.balanceOf(principal), 1_000e18 + QTY);
    }

    function test_reentryWithADifferentAuthorizationIsBlocked() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = _buy();
        Mandate memory other = _mandate();
        other.nonce = 99;
        bytes memory inner =
            abi.encodeCall(gate.execute, (other, _signMandate(other), c, t, _signExecution(other, c, t)));
        _reenter(inner, true);
        _expectRevert(m, c, t, _err(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        _assertUnconsumed(m);
        _assertUnconsumed(other);
    }

    function test_callbackTokenCannotReenterDuringTheTransfer() public {
        HookToken hookFunding = new HookToken(6);
        ScriptedAdapter adapter = new ScriptedAdapter();
        MarketConfig[] memory markets = new MarketConfig[](1);
        markets[0] =
            _market(address(scriptedToken), address(adapter), _aaplAsset(), "issuer.alpha", "venue.scripted", false);
        markets[0].fundingToken = address(hookFunding);
        MandateExecutionGate hooked = new MandateExecutionGate(markets);

        hookFunding.mint(principal, 10_000e6);
        scriptedToken.mint(address(adapter), QTY);
        vm.prank(principal);
        hookFunding.approve(address(hooked), type(uint256).max);
        adapter.setScript(
            ScriptedAdapter.Script({
                mode: ScriptedAdapter.Mode.SCRIPTED,
                deliver: QTY,
                refund: 0,
                deliverTo: address(0),
                reentryTarget: address(0),
                reentryPayload: "",
                bubbleReentry: false,
                extraPull: 0
            })
        );

        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = _buy();
        bytes32 domain = hooked.domainSeparator();
        bytes memory ps = _sign(
            PRINCIPAL_KEY,
            keccak256(
                abi.encodePacked(
                    hex"1901",
                    domain,
                    keccak256(abi.encode(hooked.MANDATE_AUTHORIZATION_TYPEHASH(), harness.mandateDigest(m)))
                )
            )
        );
        bytes memory as_ = _sign(AGENT_KEY, keccak256(abi.encodePacked(hex"1901", domain, _commitment(m, c, t))));
        // The token calls back into the gate with the very same authorization mid-transfer.
        hookFunding.setHook(address(hooked), abi.encodeCall(hooked.execute, (m, ps, c, t, as_)));

        hooked.execute(m, ps, c, t, as_);
        assertFalse(hookFunding.hookSucceeded());
        assertEq(hookFunding.hookResult(), _err(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        assertEq(scriptedToken.balanceOf(principal), 1_000e18 + QTY);
    }

    // ------------------------------------------------------------------
    // Unsupported token behaviour
    // ------------------------------------------------------------------

    function _gateFor(address representation, address fundingToken, address adapter)
        internal
        returns (MandateExecutionGate g)
    {
        MarketConfig[] memory markets = new MarketConfig[](1);
        markets[0] = _market(representation, adapter, _aaplAsset(), "issuer.alpha", "venue.scripted", false);
        markets[0].fundingToken = fundingToken;
        g = new MandateExecutionGate(markets);
    }

    function _signFor(MandateExecutionGate g, Mandate memory m, Candidate memory c, ExecutionTerms memory t)
        internal
        view
        returns (bytes memory ps, bytes memory as_)
    {
        bytes32 domain = g.domainSeparator();
        ps = _sign(
            PRINCIPAL_KEY,
            keccak256(
                abi.encodePacked(
                    hex"1901",
                    domain,
                    keccak256(abi.encode(g.MANDATE_AUTHORIZATION_TYPEHASH(), harness.mandateDigest(m)))
                )
            )
        );
        as_ = _sign(AGENT_KEY, keccak256(abi.encodePacked(hex"1901", domain, _commitment(m, c, t))));
    }

    function test_feeOnTransferOutputFailsClosed() public {
        FeeOnTransferToken taxed = new FeeOnTransferToken(18, 100); // 1%
        ScriptedAdapter adapter = new ScriptedAdapter();
        MandateExecutionGate g = _gateFor(address(taxed), address(funding), address(adapter));
        taxed.mint(address(adapter), 100e18);
        vm.prank(principal);
        funding.approve(address(g), type(uint256).max);
        adapter.setScript(
            ScriptedAdapter.Script(ScriptedAdapter.Mode.SCRIPTED, QTY, 0, address(0), address(0), "", false, 0)
        );

        Mandate memory m = _mandate();
        Candidate memory c = _candidateFor(address(taxed), SIDE_BUY);
        c.venue = "venue.scripted";
        ExecutionTerms memory t = _terms();
        (bytes memory ps, bytes memory as_) = _signFor(g, m, c, t);
        vm.expectRevert(abi.encodeWithSelector(MandateExecutionGate.CreditNotExact.selector, 9.9e18, QTY));
        g.execute(m, ps, c, t, as_);
    }

    function test_feeOnTransferInputCannotRaiseTheDebitAboveTheTransferredAmount() public {
        FeeOnTransferToken taxedFunding = new FeeOnTransferToken(6, 100); // 1%
        ScriptedAdapter adapter = new ScriptedAdapter();
        MandateExecutionGate g = _gateFor(address(scriptedToken), address(taxedFunding), address(adapter));
        taxedFunding.mint(principal, 10_000e6);
        scriptedToken.mint(address(adapter), QTY);
        vm.prank(principal);
        taxedFunding.approve(address(g), type(uint256).max);
        // The adapter even "refunds" part of what it received; the refund is taxed too.
        adapter.setScript(
            ScriptedAdapter.Script(ScriptedAdapter.Mode.SCRIPTED, QTY, 100e6, address(0), address(0), "", false, 0)
        );

        Mandate memory m = _mandate();
        Candidate memory c = _candidateFor(address(scriptedToken), SIDE_BUY);
        c.venue = "venue.scripted";
        ExecutionTerms memory t = _terms();
        (bytes memory ps, bytes memory as_) = _signFor(g, m, c, t);
        (, uint256 debit,) = g.execute(m, ps, c, t, as_);
        // 2010 out, 99 back after the refund's 1% tax.
        assertEq(debit, 2_010e6 - 99e6);
        assertLe(debit, t.fundingLimit);
    }

    function test_noReturnFundingTokenIsExplicitlySupported() public {
        NoReturnERC20 legacy = new NoReturnERC20(6);
        ScriptedAdapter adapter = new ScriptedAdapter();
        MandateExecutionGate g = _gateFor(address(scriptedToken), address(legacy), address(adapter));
        legacy.mint(principal, 10_000e6);
        scriptedToken.mint(address(adapter), QTY);
        vm.prank(principal);
        (bool approved,) =
            address(legacy).call(abi.encodeWithSignature("approve(address,uint256)", address(g), type(uint256).max));
        assertTrue(approved);
        adapter.setScript(
            ScriptedAdapter.Script(ScriptedAdapter.Mode.SCRIPTED, QTY, 0, address(0), address(0), "", false, 0)
        );
        Mandate memory m = _mandate();
        Candidate memory c = _scriptedCandidate(SIDE_BUY);
        ExecutionTerms memory t = _terms();
        (bytes memory ps, bytes memory as_) = _signFor(g, m, c, t);
        (,, uint256 credit) = g.execute(m, ps, c, t, as_);
        assertEq(credit, QTY);
    }

    function test_malformedTokenReturnDataFailsClosedAndConsumesNothing() public {
        MalformedReturnERC20 malformed = new MalformedReturnERC20(6);
        ScriptedAdapter adapter = new ScriptedAdapter();
        MandateExecutionGate g = _gateFor(address(scriptedToken), address(malformed), address(adapter));
        malformed.mint(principal, 10_000e6);
        vm.prank(principal);
        (bool approved,) =
            address(malformed).call(abi.encodeWithSignature("approve(address,uint256)", address(g), type(uint256).max));
        assertTrue(approved);
        Mandate memory m = _mandate();
        Candidate memory c = _scriptedCandidate(SIDE_BUY);
        ExecutionTerms memory t = _terms();
        (bytes memory ps, bytes memory as_) = _signFor(g, m, c, t);
        (bool ok,) = address(g).call(abi.encodeCall(g.execute, (m, ps, c, t, as_)));
        assertFalse(ok);
        assertEq(g.executionCommitmentOf(harness.mandateDigest(m)), bytes32(0));
        assertEq(malformed.balanceOf(principal), 10_000e6);
    }

    function test_failedFixtureApprovalResetRevertsEverythingAtomically() public {
        FailZeroApproveToken resetFailing = new FailZeroApproveToken(6);
        FixtureVenue venue = new FixtureVenue(scriptedToken, resetFailing, AAPL_PRICE, FEE_BPS);
        address predictedGate = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        FixtureVenueAdapter adapter = new FixtureVenueAdapter(predictedGate, venue);
        MarketConfig[] memory markets = new MarketConfig[](1);
        markets[0] =
            _market(address(scriptedToken), address(adapter), _aaplAsset(), "issuer.alpha", "venue.fixture", false);
        markets[0].fundingToken = address(resetFailing);
        MandateExecutionGate g = new MandateExecutionGate(markets);
        assertEq(address(g), predictedGate);

        resetFailing.mint(principal, 10_000e6);
        resetFailing.mint(address(venue), 10_000e6);
        scriptedToken.mint(address(venue), QTY);
        vm.prank(principal);
        resetFailing.approve(address(g), type(uint256).max);

        Mandate memory m = _mandate();
        Candidate memory c = _candidateFor(address(scriptedToken), SIDE_BUY);
        ExecutionTerms memory t = _terms();
        (bytes memory ps, bytes memory as_) = _signFor(g, m, c, t);
        uint256 fundingBefore = resetFailing.balanceOf(principal);
        uint256 tokensBefore = scriptedToken.balanceOf(principal);
        vm.expectRevert(FailZeroApproveToken.ZeroApprovalRefused.selector);
        g.execute(m, ps, c, t, as_);
        assertEq(resetFailing.balanceOf(principal), fundingBefore);
        assertEq(scriptedToken.balanceOf(principal), tokensBefore);
        assertEq(resetFailing.balanceOf(address(adapter)), 0);
        assertEq(resetFailing.allowance(address(adapter), address(venue)), 0);
        assertEq(g.executionCommitmentOf(harness.mandateDigest(m)), bytes32(0));
    }

    // ------------------------------------------------------------------
    // Fixture adapter restrictions
    // ------------------------------------------------------------------

    function _order(uint8 side, address input, address output) internal view returns (ExecutionOrder memory) {
        return ExecutionOrder({
            side: side,
            inputToken: input,
            outputToken: output,
            inputAmount: 1,
            minOutput: 1,
            recipient: principal,
            refundTo: principal,
            executionData: "",
            executionCommitment: bytes32(0)
        });
    }

    function test_fixtureAdapter_acceptsCallsOnlyFromItsGate() public {
        ExecutionOrder memory o = _order(SIDE_BUY, address(funding), address(aapl));
        vm.expectRevert(FixtureVenueAdapter.OnlyGate.selector);
        aaplAdapter.execute(o);
        vm.prank(stranger);
        vm.expectRevert(FixtureVenueAdapter.OnlyGate.selector);
        aaplAdapter.execute(o);
    }

    function test_fixtureAdapter_refusesTokensThatAreNotItsVenuePair() public {
        ExecutionOrder[4] memory bad = [
            _order(SIDE_BUY, address(funding), address(nvda)),
            _order(SIDE_BUY, address(aapl), address(funding)),
            _order(SIDE_SELL, address(funding), address(aapl)),
            _order(3, address(funding), address(aapl))
        ];
        for (uint256 i = 0; i < bad.length; ++i) {
            vm.prank(address(gate));
            vm.expectRevert(FixtureVenueAdapter.UnsupportedOrder.selector);
            aaplAdapter.execute(bad[i]);
        }
    }

    function test_fixtureAdapter_refusesRouteData() public {
        ExecutionTerms memory t = _terms();
        t.executionData = hex"01";
        _expectRevert(_mandate(), _candidate(), t, _err(FixtureVenueAdapter.UnsupportedRouteData.selector));
    }

    function test_fixtureVenue_refusesASpendLimitBelowItsCost() public {
        ExecutionTerms memory t = _terms();
        t.fundingLimit = 2_005e6;
        _expectRevert(
            _mandate(),
            _candidate(),
            t,
            abi.encodeWithSelector(FixtureVenue.FixtureCostExceedsMaximum.selector, 2_006e6, 2_005e6)
        );
        _assertUnconsumed(_mandate());
    }

    function test_fixtureVenue_refusesInvalidConfiguration() public {
        vm.expectRevert(FixtureVenue.FixtureInvalidConfig.selector);
        new FixtureVenue(aapl, funding, 0, 30);
        vm.expectRevert(FixtureVenue.FixtureInvalidConfig.selector);
        new FixtureVenue(aapl, funding, 1, 10_000);
    }
}
