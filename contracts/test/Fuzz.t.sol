// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {MandateExecutionGate} from "../src/MandateExecutionGate.sol";
import {Candidate, ExecutionTerms, Mandate, MarketConfig, SIDE_BUY, SIDE_SELL} from "../src/MandateTypes.sol";
import {FixtureVenue} from "../src/fixture/FixtureVenue.sol";
import {GateTestBase} from "./utils/GateTestBase.sol";

/// @notice Property tests. Each asserts the gate's outcome equals an independent
/// prediction from the signed bounds and the measured balances, over fuzzed
/// amounts, fees, quantities, times, nonces, signatures, recipients and tokens.
contract FuzzTest is GateTestBase {
    uint256 internal constant PRINCIPAL_FUNDING = 1_000_000e6;
    uint256 internal constant PRINCIPAL_TOKENS = 1_000e18;

    function testFuzz_notionalArithmetic_matchesExactRationalBounds(
        uint256 quantity,
        uint256 price,
        uint8 quantityDecimals,
        uint8 priceDecimals,
        uint8 targetDecimals
    ) public view {
        quantity = bound(quantity, 0, 1e18);
        price = bound(price, 0, 1e18);
        quantityDecimals = uint8(bound(quantityDecimals, 0, 18));
        priceDecimals = uint8(bound(priceDecimals, 0, 18));
        targetDecimals = uint8(bound(targetDecimals, 0, 18));
        uint256 numerator = quantity * price * 10 ** uint256(targetDecimals);
        uint256 denominator = 10 ** uint256(uint16(quantityDecimals) + uint16(priceDecimals));
        uint256 expectedFloor = numerator / denominator;
        uint256 expectedCeil = expectedFloor + (numerator % denominator == 0 ? 0 : 1);
        (bool representable, uint256 floorAtoms, uint256 ceilAtoms) =
            harness.notionalBounds(quantity, quantityDecimals, price, priceDecimals, targetDecimals);
        assertTrue(representable);
        assertEq(floorAtoms, expectedFloor);
        assertEq(ceilAtoms, expectedCeil);
    }

    function testFuzz_amountComparison_matchesExactCrossMultiplication(
        uint256 a,
        uint256 b,
        uint8 aDecimals,
        uint8 bDecimals
    ) public view {
        a = bound(a, 0, 1e30);
        b = bound(b, 0, 1e30);
        aDecimals = uint8(bound(aDecimals, 0, 38));
        bDecimals = uint8(bound(bDecimals, 0, 38));
        uint256 left = a * 10 ** uint256(bDecimals);
        uint256 right = b * 10 ** uint256(aDecimals);
        int8 expected = left < right ? int8(-1) : left > right ? int8(1) : int8(0);
        assertEq(harness.compareAmounts(a, aDecimals, b, bDecimals), expected);
    }

    /// @dev Signs and submits; returns (ok, revertData, debit, credit).
    function _try(Mandate memory m, Candidate memory c, ExecutionTerms memory t)
        internal
        returns (bool ok, bytes memory reason, uint256 debit, uint256 credit)
    {
        bytes memory ps = _signMandate(m);
        bytes memory as_ = _signExecution(m, c, t);
        try gate.execute(m, ps, c, t, as_) returns (bytes32, uint256 d, uint256 k) {
            return (true, "", d, k);
        } catch (bytes memory r) {
            return (false, r, 0, 0);
        }
    }

    function _consumed(Mandate memory m) internal view returns (bool) {
        return gate.executionCommitmentOf(harness.mandateDigest(m)) != bytes32(0);
    }

    // ------------------------------------------------------------------
    // Economic bounds on measured deltas
    // ------------------------------------------------------------------

    function testFuzz_buy_settlesExactlyWhenMeasuredDeltasSatisfyTheSignedBound(
        uint256 limitAtoms,
        uint256 fundingLimit,
        uint256 quantity,
        uint256 deliver,
        uint256 refund
    ) public {
        limitAtoms = bound(limitAtoms, 0, 1e24);
        fundingLimit = bound(fundingLimit, 0, PRINCIPAL_FUNDING);
        quantity = bound(quantity, 1, 1e21);
        deliver = bound(deliver, 0, 1e21);
        refund = bound(refund, 0, 2 * PRINCIPAL_FUNDING);

        Mandate memory m = _mandate();
        m.maxNotional.atoms = limitAtoms;
        m.economicLimit.atoms = limitAtoms;
        Candidate memory c = _scriptedCandidate(SIDE_BUY);
        c.quantity.atoms = quantity;
        c.executionPrice.atoms = 200e18;
        c.notional.atoms = quantity * 200;
        c.feeTotal.atoms = 0;
        ExecutionTerms memory t = _terms();
        t.fundingLimit = fundingLimit;
        _scriptHonest(deliver, refund);

        uint256 signedBound = limitAtoms / 1e12; // 18 -> 6 decimals, rounded down
        (bool ok, bytes memory reason, uint256 debit, uint256 credit) = _try(m, c, t);

        if (c.notional.atoms > limitAtoms) {
            assertEq(reason, _err(MandateExecutionGate.MaxNotionalExceeded.selector));
        } else if (fundingLimit > signedBound) {
            assertEq(
                reason,
                abi.encodeWithSelector(
                    MandateExecutionGate.FundingLimitExceedsMandate.selector, fundingLimit, signedBound
                )
            );
        } else if (deliver != quantity) {
            assertEq(reason, abi.encodeWithSelector(MandateExecutionGate.CreditNotExact.selector, deliver, quantity));
        } else {
            assertTrue(ok);
            assertEq(debit, refund >= fundingLimit ? 0 : fundingLimit - refund);
            assertEq(credit, deliver);
            assertLe(debit, signedBound, "BUY debited more than the signed MAX_TOTAL_DEBIT");
        }
        assertEq(_consumed(m), ok);
    }

    function testFuzz_sell_settlesExactlyWhenMeasuredCreditMeetsTheSignedFloor(
        uint256 limitAtoms,
        uint256 fundingLimit,
        uint256 quantity,
        uint256 deliver,
        uint256 refund
    ) public {
        limitAtoms = bound(limitAtoms, 0, 1e21);
        // The scripted adapter holds 1e15 funding atoms; stay inside its inventory.
        fundingLimit = bound(fundingLimit, 0, 1e14);
        quantity = bound(quantity, 1, PRINCIPAL_TOKENS);
        deliver = bound(deliver, 0, 1e14);
        refund = bound(refund, 0, quantity);

        Mandate memory m = _sellMandate();
        m.maxNotional.atoms = type(uint128).max;
        m.economicLimit.atoms = limitAtoms;
        Candidate memory c = _scriptedCandidate(SIDE_SELL);
        c.quantity.atoms = quantity;
        c.executionPrice.atoms = 200e18;
        c.notional.atoms = quantity * 200;
        c.feeTotal.atoms = 0;
        ExecutionTerms memory t = _sellTerms();
        t.fundingLimit = fundingLimit;
        _scriptHonest(deliver, refund);

        uint256 signedFloor = limitAtoms / 1e12 + (limitAtoms % 1e12 == 0 ? 0 : 1); // rounded up
        (bool ok, bytes memory reason, uint256 debit, uint256 credit) = _try(m, c, t);

        if (c.notional.atoms < limitAtoms) {
            assertEq(reason, _err(MandateExecutionGate.DeclaredTotalCreditBelowMinimum.selector));
        } else if (fundingLimit < signedFloor) {
            assertEq(
                reason,
                abi.encodeWithSelector(
                    MandateExecutionGate.FundingLimitBelowMandate.selector, fundingLimit, signedFloor
                )
            );
        } else if (refund != 0) {
            assertEq(
                reason, abi.encodeWithSelector(MandateExecutionGate.DebitNotExact.selector, quantity - refund, quantity)
            );
        } else if (deliver < fundingLimit) {
            assertEq(
                reason, abi.encodeWithSelector(MandateExecutionGate.CreditBelowMinimum.selector, deliver, fundingLimit)
            );
        } else {
            assertTrue(ok);
            assertEq(debit, quantity);
            assertGe(credit, signedFloor, "SELL credited less than the signed MIN_TOTAL_CREDIT");
        }
        assertEq(_consumed(m), ok);
    }

    /// @notice Real fixture venue with fuzzed price and fee: the debit is exactly
    /// the venue's fee-inclusive cost and never exceeds the signed bound.
    function testFuzz_fixtureVenue_feesAreInsideTheSignedDebitBound(
        uint256 price,
        uint16 feeBps,
        uint256 quantity,
        uint256 limitUsd
    ) public {
        price = bound(price, 1, 10_000e6);
        feeBps = uint16(bound(feeBps, 0, 1_000));
        quantity = bound(quantity, 1, 100e18);
        limitUsd = bound(limitUsd, 0, 2_000_000);

        MarketConfig[] memory markets = new MarketConfig[](1);
        markets[0] = _market(address(aapl), _aaplAsset(), "issuer.alpha", "venue.fixture", false);
        markets[0].fixturePrice.decimals = 6;
        markets[0].fixturePrice.atoms = price;
        markets[0].fixtureFeeBps = feeBps;
        gate = new MandateExecutionGate(markets);
        FixtureVenue venue = _venueOf(gate, address(aapl));
        assertEq(venue.PRICE(), price);
        assertEq(venue.FEE_BPS(), feeBps);
        aapl.mint(address(venue), quantity);
        vm.prank(principal);
        funding.approve(address(gate), type(uint256).max);

        Mandate memory m = _mandate();
        m.maxNotional.atoms = limitUsd * 1e18;
        m.economicLimit.atoms = limitUsd * 1e18;
        Candidate memory c = _candidate();
        c.quantity.atoms = quantity;
        c.executionPrice.decimals = 6;
        c.executionPrice.atoms = price;
        uint256 gross = (quantity * price + 1e18 - 1) / 1e18;
        c.notional.decimals = 6;
        c.notional.atoms = gross;
        c.feeTotal.decimals = 6;
        ExecutionTerms memory t = _terms();
        t.fundingLimit = limitUsd * 1e6; // the agent spends up to the whole bound

        uint256 cost = venue.quoteBuy(quantity);
        c.feeTotal.atoms = cost - gross;
        (bool ok, bytes memory reason, uint256 debit, uint256 credit) = _try(m, c, t);
        if (t.fundingLimit > PRINCIPAL_FUNDING) {
            assertFalse(ok);
        } else if (gross > t.fundingLimit) {
            assertEq(reason, _err(MandateExecutionGate.MaxNotionalExceeded.selector));
        } else if (cost > t.fundingLimit) {
            assertEq(reason, _err(MandateExecutionGate.DeclaredTotalDebitExceeded.selector));
        } else {
            assertTrue(ok);
            assertEq(debit, cost);
            assertEq(credit, quantity);
            assertLe(debit, limitUsd * 1e6);
            // The fee is inside the debit, and every rounding went against the trader.
            assertGe(debit * 1e18, quantity * price);
        }
    }

    function testFuzz_boundConversion_neverFavoursTheAgent(uint256 atoms, uint8 fromDecimals, uint256 fundingLimit)
        public
    {
        fromDecimals = uint8(bound(fromDecimals, 0, 38));
        atoms = bound(atoms, 0, type(uint128).max);
        Mandate memory m = _mandate();
        m.maxNotional = _usd(type(uint128).max);
        m.maxNotional.decimals = fromDecimals;
        m.economicLimit.decimals = fromDecimals;
        m.economicLimit.atoms = atoms;
        // Funding is 6 decimals in this world.
        uint256 signedBound = gate.floorToScale(atoms, fromDecimals, 6);
        fundingLimit = bound(fundingLimit, 0, PRINCIPAL_FUNDING);
        ExecutionTerms memory t = _terms();
        t.fundingLimit = fundingLimit;
        Candidate memory c = _scriptedCandidate(SIDE_BUY);
        c.quantity.atoms = 1;
        c.executionPrice.atoms = 200e18;
        c.notional.decimals = 0;
        c.notional.atoms = 0;
        c.feeTotal.decimals = 0;
        c.feeTotal.atoms = 0;
        _scriptHonest(1, 0);
        (bool ok, bytes memory reason,,) = _try(m, c, t);
        if (fundingLimit > signedBound) {
            assertEq(
                reason,
                abi.encodeWithSelector(
                    MandateExecutionGate.FundingLimitExceedsMandate.selector, fundingLimit, signedBound
                )
            );
        } else {
            assertTrue(ok);
        }
        // Exactness: bound/10^6 <= atoms/10^from, compared without division.
        assertLe(uint256(signedBound) * 10 ** uint256(fromDecimals), atoms * 1e6);
    }

    // ------------------------------------------------------------------
    // Time and replay
    // ------------------------------------------------------------------

    function testFuzz_time_executesExactlyInsideTheWindowAndDeadline(
        uint64 timestamp,
        int32 notBeforeOffset,
        uint32 validity,
        uint64 deadline
    ) public {
        timestamp = uint64(bound(timestamp, T0 - 10_000, T0 + 10_000));
        validity = uint32(bound(validity, 1, 20_000));
        int64 notBefore = int64(int256(T0)) + int64(notBeforeOffset % 10_000);
        int64 expiresAt = notBefore + int64(uint64(validity));
        deadline = uint64(bound(deadline, T0 - 10_000, T0 + 30_000));

        Mandate memory m = _mandate();
        m.notBeforeUnixSeconds = notBefore;
        m.expiresAtUnixSeconds = expiresAt;
        m.createdAtUnixSeconds = notBefore;
        ExecutionTerms memory t = _terms();
        t.deadline = deadline;
        Candidate memory c = _scriptedCandidate(SIDE_BUY);
        _scriptHonest(c.quantity.atoms, 0);
        vm.warp(timestamp);

        (bool ok, bytes memory reason,,) = _try(m, c, t);
        int256 now_ = int256(uint256(timestamp));
        if (now_ < notBefore) assertEq(reason, _err(MandateExecutionGate.MandateNotYetActive.selector));
        else if (now_ >= expiresAt) assertEq(reason, _err(MandateExecutionGate.MandateExpired.selector));
        else if (timestamp > deadline) assertEq(reason, _err(MandateExecutionGate.ExecutionDeadlinePassed.selector));
        else assertTrue(ok);
    }

    function testFuzz_replay_oneSettlementPerMandateDigest(uint64 nonceA, uint64 nonceB) public {
        Candidate memory c = _scriptedCandidate(SIDE_BUY);
        _scriptHonest(c.quantity.atoms, 0);
        Mandate memory a = _mandate();
        a.nonce = nonceA;
        Mandate memory b = _mandate();
        b.nonce = nonceB;
        (bool first,,,) = _try(a, c, _terms());
        (bool second, bytes memory reason,,) = _try(b, c, _terms());
        assertTrue(first);
        if (nonceA == nonceB) assertEq(reason, _err(MandateExecutionGate.MandateAlreadyConsumed.selector));
        else assertTrue(second);
    }

    // ------------------------------------------------------------------
    // Transaction binding: mutation after signing
    // ------------------------------------------------------------------

    /// @notice Any committed field changed after both parties signed: the gate
    /// refuses, and refuses on a signature, before any state or token moves.
    function testFuzz_binding_anyPostSignatureMutationRefuses(uint8 field, uint256 value) public {
        Mandate memory m = _mandate();
        Candidate memory c = _scriptedCandidate(SIDE_BUY);
        ExecutionTerms memory t = _terms();
        _scriptHonest(c.quantity.atoms, 0);
        bytes memory ps = _signMandate(m);
        bytes memory as_ = _signExecution(m, c, t);

        field = uint8(bound(field, 0, 13));
        bytes4 expected = field < 6
            ? MandateExecutionGate.PrincipalSignatureInvalid.selector
            : MandateExecutionGate.AgentSignatureInvalid.selector;
        if (field == 0) m.nonce = uint64(bound(value, 2, type(uint64).max));
        else if (field == 1) m.economicLimit.atoms = bound(value, 2_010e18 + 1, type(uint256).max);
        else if (field == 2) m.expiresAtUnixSeconds = int64(int256(bound(value, T0 + 3_601, T0 + 1e9)));
        else if (field == 3) m.agent = address(uint160(bound(value, 1, type(uint160).max)));
        else if (field == 4) m.maxNotional.atoms = bound(value, 2_000e18 + 1, type(uint256).max);
        else if (field == 5) m.principal = address(uint160(bound(value, 1, type(uint160).max)));
        else if (field == 6) c.quantity.atoms = bound(value, 10e18 + 1, type(uint256).max);
        else if (field == 7) c.representationId = harness.representationId(CHAIN, address(aapl));
        else if (field == 8) c.evaluationStateDigest = bytes32(bound(value, 0xe2, type(uint256).max));
        else if (field == 9) t.recipient = address(uint160(bound(value, 1, type(uint160).max)));
        else if (field == 10) t.fundingLimit = bound(value, 0, 2_010e6 - 1);
        else if (field == 11) t.deadline = uint64(bound(value, T0 + 301, type(uint64).max));
        else if (field == 12) t.executionData = abi.encode(value);
        else c.feeTotal.atoms = bound(value, 6e18 + 1, type(uint256).max);
        if (field == 5 && m.principal == principal) return;
        if (field == 3 && m.agent == agent) return;
        if (field == 9 && t.recipient == principal) return;

        uint256 fundingBefore = funding.balanceOf(principal);
        vm.expectRevert(expected);
        gate.execute(m, ps, c, t, as_);
        assertEq(funding.balanceOf(principal), fundingBefore);
        assertFalse(_consumed(_mandate()));
    }

    function testFuzz_signature_randomPrincipalSignatureBytesRefuse(bytes memory signature) public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = (_mandate(), _candidate(), _terms());
        bytes memory as_ = _signExecution(m, c, t);
        vm.expectRevert(MandateExecutionGate.PrincipalSignatureInvalid.selector);
        gate.execute(m, signature, c, t, as_);
    }

    function testFuzz_signature_randomAgentSignatureBytesRefuse(bytes32 r, bytes32 s, uint8 v) public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = (_mandate(), _candidate(), _terms());
        bytes memory ps = _signMandate(m);
        vm.expectRevert(MandateExecutionGate.AgentSignatureInvalid.selector);
        gate.execute(m, ps, c, t, abi.encodePacked(r, s, v));
    }

    function testFuzz_signature_wrongSignerKeyRefuses(uint256 key) public {
        key = bound(key, 1, 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140);
        vm.assume(key != AGENT_KEY);
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = (_mandate(), _candidate(), _terms());
        bytes memory ps = _signMandate(m);
        bytes memory as_ = _sign(key, _eip712(_commitment(m, c, t)));
        vm.expectRevert(MandateExecutionGate.AgentSignatureInvalid.selector);
        gate.execute(m, ps, c, t, as_);
    }

    // ------------------------------------------------------------------
    // Recipient, target and token substitution, fully signed
    // ------------------------------------------------------------------

    function testFuzz_recipient_onlyThePrincipalMayReceive(address recipient) public {
        ExecutionTerms memory t = _terms();
        t.recipient = recipient;
        Candidate memory c = _scriptedCandidate(SIDE_BUY);
        _scriptHonest(c.quantity.atoms, 0);
        (bool ok, bytes memory reason,,) = _try(_mandate(), c, t);
        if (recipient == principal) assertTrue(ok);
        else assertEq(reason, _err(MandateExecutionGate.RecipientNotPrincipal.selector));
    }

    function testFuzz_token_onlySupportedRepresentationsExecute(address token) public {
        vm.assume(
            token != address(aapl) && token != address(nvda) && token != address(synth)
                && token != address(scriptedToken)
        );
        Candidate memory c = _candidate();
        c.representationId = harness.representationId(CHAIN, token);
        (bool ok, bytes memory reason,,) = _try(_mandate(), c, _terms());
        assertFalse(ok);
        assertEq(reason, _err(MandateExecutionGate.UnsupportedRepresentation.selector));
    }

    function testFuzz_chain_signaturesDoNotCrossChains(uint64 chainId) public {
        vm.assume(chainId != CHAIN);
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = (_mandate(), _candidate(), _terms());
        bytes memory ps = _signMandate(m);
        bytes memory as_ = _signExecution(m, c, t);
        vm.chainId(chainId);
        vm.expectRevert(MandateExecutionGate.WrongChain.selector);
        gate.execute(m, ps, c, t, as_);
    }
}
