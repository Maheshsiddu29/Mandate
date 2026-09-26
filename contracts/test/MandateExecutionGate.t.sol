// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Vm} from "forge-std/Test.sol";

import {MandateExecutionGate} from "../src/MandateExecutionGate.sol";
import {
    Amount,
    Candidate,
    ExecutionTerms,
    Mandate,
    Market,
    MarketConfig,
    MARKET_REAL,
    Price,
    SIDE_BUY,
    SIDE_SELL,
    SYNTHETIC_ALLOWED
} from "../src/MandateTypes.sol";
import {FixtureVenue} from "../src/fixture/FixtureVenue.sol";
import {FixtureVenueAdapter} from "../src/fixture/FixtureVenueAdapter.sol";
import {MockERC20} from "./mocks/MockTokens.sol";
import {GateTestBase} from "./utils/GateTestBase.sol";

/// @notice Unit tests: one test per refusal, each on the realistic fixture path,
/// plus the positive paths, time boundaries, replay and reconciliation views.
contract MandateExecutionGateTest is GateTestBase {
    // ------------------------------------------------------------------
    // Construction
    // ------------------------------------------------------------------

    function test_construction_pinsChainDomainAndMarkets() public view {
        assertEq(gate.CHAIN_ID(), CHAIN);
        bytes32 expectedDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Mandate"),
                keccak256("1"),
                CHAIN,
                address(gate)
            )
        );
        assertEq(gate.domainSeparator(), expectedDomain);

        Market memory m = gate.marketOf(keccak256(bytes(harness.representationId(CHAIN, address(aapl)))));
        assertEq(m.representation, address(aapl));
        assertEq(m.fundingToken, address(funding));
        assertEq(m.adapter, address(aaplAdapter));
        assertEq(m.representationDecimals, 18);
        assertEq(m.fundingDecimals, 6);
        assertEq(m.fixturePriceDecimals, 6);
        assertEq(m.fixturePriceAtoms, AAPL_PRICE);
        assertFalse(m.synthetic);
    }

    function test_construction_emitsOneMarketSupportedPerMarket() public {
        vm.recordLogs();
        MarketConfig[] memory markets = new MarketConfig[](1);
        markets[0] = _market(address(aapl), address(aaplAdapter), _aaplAsset(), "issuer.alpha", "venue.fixture", false);
        MandateExecutionGate g = new MandateExecutionGate(markets);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(g));
        assertEq(logs[0].topics[0], keccak256("MarketSupported(bytes32,address,address,address,string)"));
        string memory representationId = harness.representationId(CHAIN, address(aapl));
        assertEq(logs[0].topics[1], keccak256(bytes(representationId)));
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(address(aapl)))));
        assertEq(logs[0].topics[3], bytes32(uint256(uint160(address(funding)))));
        (address adapter_, string memory emittedId) = abi.decode(logs[0].data, (address, string));
        assertEq(adapter_, address(aaplAdapter));
        assertEq(emittedId, representationId);
    }

    function _one(MarketConfig memory m) internal pure returns (MarketConfig[] memory markets) {
        markets = new MarketConfig[](1);
        markets[0] = m;
    }

    function test_construction_refusesAnEmptyMarketSet() public {
        vm.expectRevert(MandateExecutionGate.InvalidMarket.selector);
        new MandateExecutionGate(new MarketConfig[](0));
    }

    function test_construction_refusesMalformedMarkets() public {
        MarketConfig memory ok =
            _market(address(aapl), address(aaplAdapter), _aaplAsset(), "issuer.alpha", "venue.fixture", false);
        MarketConfig[8] memory bad;
        for (uint256 i = 0; i < bad.length; ++i) {
            bad[i] = ok;
        }
        bad[0].representation = address(0);
        bad[1].fundingToken = address(0);
        bad[2].fundingToken = address(aapl); // representation == funding
        bad[3].adapter = address(0xdead); // no code
        bad[4].issuer = "issuer alpha"; // not an identifier
        bad[5].settlementUnit = "";
        bad[6].canonicalAsset.value = "US0378331005.";
        bad[7].venue = "venue.fixture/";
        for (uint256 i = 0; i < bad.length; ++i) {
            vm.expectRevert(MandateExecutionGate.InvalidMarket.selector);
            new MandateExecutionGate(_one(bad[i]));
        }
    }

    function test_construction_refusesMalformedFixturePrice() public {
        MarketConfig memory market =
            _market(address(aapl), address(aaplAdapter), _aaplAsset(), "issuer.alpha", "venue.fixture", false);
        market.fixturePrice.atoms = 0;
        vm.expectRevert(MandateExecutionGate.InvalidMarket.selector);
        new MandateExecutionGate(_one(market));
        market.fixturePrice.atoms = AAPL_PRICE;
        market.fixturePrice.numeratorUnit = "EUR";
        vm.expectRevert(MandateExecutionGate.InvalidMarket.selector);
        new MandateExecutionGate(_one(market));
    }

    // ------------------------------------------------------------------
    // Construction: fixture venue price == gate fixture price (6R.1)
    // ------------------------------------------------------------------

    function _aaplConfig() internal view returns (MarketConfig memory) {
        return _market(address(aapl), address(aaplAdapter), _aaplAsset(), "issuer.alpha", "venue.fixture", false);
    }

    /// @notice The venue settles at 200e6 fUSDC atoms per token. Any typed price
    /// equal to 200 USD is the same economic price, at any scale.
    function test_construction_fixtureSettlement_acceptsTheSamePriceAtAnyScale() public {
        uint8[4] memory scales = [6, 7, 18, 38];
        for (uint256 i = 0; i < scales.length; ++i) {
            MarketConfig memory market = _aaplConfig();
            market.fixturePrice.decimals = scales[i];
            market.fixturePrice.atoms = 200 * 10 ** uint256(scales[i]);
            new MandateExecutionGate(_one(market));
        }
    }

    function test_construction_fixtureSettlement_refusesAVenueAtAnotherPrice() public {
        uint256[4] memory wrong = [uint256(200e6 + 1), 200e6 - 1, 200e18, 200];
        for (uint256 i = 0; i < wrong.length; ++i) {
            MarketConfig memory market = _aaplConfig();
            market.fixturePrice.atoms = wrong[i];
            vm.expectRevert(MandateExecutionGate.FixtureSettlementInconsistent.selector);
            new MandateExecutionGate(_one(market));
        }
        // The same raw atoms at the wrong scale are a different price.
        MarketConfig memory scaled = _aaplConfig();
        scaled.fixturePrice.decimals = 18;
        vm.expectRevert(MandateExecutionGate.FixtureSettlementInconsistent.selector);
        new MandateExecutionGate(_one(scaled));
    }

    /// @notice A price finer than the 6-decimal funding token has no equal venue
    /// price: 200.0000005 USD is refused against a venue at 200.000000 or 200.000001.
    function test_construction_fixtureSettlement_refusesPriceDecimalsTheFundingTokenCannotExpress() public {
        uint256[2] memory venuePrices = [uint256(200e6), 200e6 + 1];
        for (uint256 i = 0; i < venuePrices.length; ++i) {
            FixtureVenue venue = new FixtureVenue(aapl, funding, venuePrices[i], FEE_BPS);
            FixtureVenueAdapter adapter = new FixtureVenueAdapter(address(0xa7e), venue);
            MarketConfig memory market = _aaplConfig();
            market.adapter = address(adapter);
            market.fixturePrice.decimals = 7;
            market.fixturePrice.atoms = 2_000_000_005;
            vm.expectRevert(MandateExecutionGate.FixtureSettlementInconsistent.selector);
            new MandateExecutionGate(_one(market));
        }
    }

    function test_construction_fixtureSettlement_refusesAVenueSettlingAnotherFundingToken() public {
        MarketConfig memory market = _aaplConfig();
        market.fundingToken = address(new MockERC20("Other USD", "oUSD", 6));
        vm.expectRevert(MandateExecutionGate.FixtureSettlementInconsistent.selector);
        new MandateExecutionGate(_one(market));
    }

    function test_construction_fixtureSettlement_refusesAnAdapterForAnotherRepresentation() public {
        MarketConfig memory market = _aaplConfig();
        market.adapter = address(nvdaAdapter);
        vm.expectRevert(FixtureVenueAdapter.UnsupportedOrder.selector);
        new MandateExecutionGate(_one(market));
    }

    function test_construction_fixtureSettlement_refusesAnAdapterThatDeclaresNoSettlement() public {
        MarketConfig memory market = _aaplConfig();
        market.adapter = address(funding); // has code, has no fixtureSettlement
        vm.expectRevert();
        new MandateExecutionGate(_one(market));
    }

    function test_profile_marketCountExactAndAboveBoundary() public {
        uint256 maximum = gate.MAX_MARKETS();
        MarketConfig[] memory markets = new MarketConfig[](maximum);
        for (uint256 i = 0; i < maximum; ++i) {
            MockERC20 token = new MockERC20("Fixture", "FX", 18);
            scripted.setFixtureSettlement(address(token), address(funding), AAPL_PRICE);
            markets[i] =
                _market(address(token), address(scripted), _aaplAsset(), "issuer.alpha", "venue.scripted", false);
        }
        MandateExecutionGate maximumGate = new MandateExecutionGate(markets);
        assertTrue(address(maximumGate) != address(0));
        vm.expectRevert(MandateExecutionGate.InvalidMarket.selector);
        new MandateExecutionGate(new MarketConfig[](maximum + 1));
    }

    function test_construction_refusesDuplicateRepresentations() public {
        MarketConfig[] memory markets = new MarketConfig[](2);
        markets[0] = _market(address(aapl), address(aaplAdapter), _aaplAsset(), "issuer.alpha", "venue.fixture", false);
        markets[1] = _market(address(aapl), address(nvdaAdapter), _aaplAsset(), "issuer.alpha", "venue.fixture", false);
        vm.expectRevert(MandateExecutionGate.InvalidMarket.selector);
        new MandateExecutionGate(markets);
    }

    function test_construction_refusesTokensBeyondKernelDecimals() public {
        MockERC20 wide = new MockERC20("Wide", "W", 39);
        vm.expectRevert(MandateExecutionGate.InvalidMarket.selector);
        new MandateExecutionGate(
            _one(_market(address(wide), address(aaplAdapter), _aaplAsset(), "issuer.alpha", "venue.fixture", false))
        );
    }

    function test_construction_refusesRealMarketWithoutAuthenticatedStateSource() public {
        MarketConfig memory market =
            _market(address(aapl), address(aaplAdapter), _aaplAsset(), "issuer.alpha", "venue.fixture", false);
        market.classification = MARKET_REAL;
        vm.expectRevert(MandateExecutionGate.RealMarketStateSourceRequired.selector);
        new MandateExecutionGate(_one(market));
    }

    function test_construction_refusesTokenAddressesWithoutCode() public {
        MarketConfig memory market =
            _market(address(0x1111), address(aaplAdapter), _aaplAsset(), "issuer.alpha", "venue.fixture", false);
        vm.expectRevert(MandateExecutionGate.InvalidMarket.selector);
        new MandateExecutionGate(_one(market));
        market = _market(address(aapl), address(aaplAdapter), _aaplAsset(), "issuer.alpha", "venue.fixture", false);
        market.fundingToken = address(0x2222);
        vm.expectRevert(MandateExecutionGate.InvalidMarket.selector);
        new MandateExecutionGate(_one(market));
    }

    // ------------------------------------------------------------------
    // Positive paths
    // ------------------------------------------------------------------

    function test_buy_settlesAgainstTheFixtureVenueWithinTheSignedBound() public {
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        uint256 fundingBefore = funding.balanceOf(principal);
        uint256 tokensBefore = aapl.balanceOf(principal);

        vm.expectEmit(true, true, true, true, address(gate));
        emit MandateExecutionGate.MandateExecuted(
            harness.mandateDigest(m),
            _commitment(m, c, t),
            principal,
            harness.candidateDigest(c),
            agent,
            address(aaplAdapter),
            address(funding),
            address(aapl),
            1,
            2_006e6,
            10e18
        );
        (bytes32 commitment, uint256 debit, uint256 credit) = _execute(m, c, t);

        assertEq(commitment, _commitment(m, c, t));
        assertEq(debit, aaplVenue.quoteBuy(10e18));
        assertEq(debit, 2_006e6);
        assertEq(credit, 10e18);
        assertEq(fundingBefore - funding.balanceOf(principal), debit);
        assertEq(aapl.balanceOf(principal) - tokensBefore, credit);
        assertEq(gate.executionCommitmentOf(harness.mandateDigest(m)), commitment);
    }

    function test_sell_settlesAgainstTheFixtureVenueAboveTheSignedFloor() public {
        Mandate memory m = _sellMandate();
        Candidate memory c = _candidateFor(address(aapl), SIDE_SELL);
        ExecutionTerms memory t = _sellTerms();
        (, uint256 debit, uint256 credit) = _execute(m, c, t);
        assertEq(debit, 10e18);
        assertEq(credit, aaplVenue.quoteSell(10e18));
        assertEq(credit, 1_994e6);
        assertGe(credit, t.fundingLimit);
    }

    function test_gateNeverHoldsFundsOrGrantsAllowances() public {
        _execute(_mandate(), _candidate(), _terms());
        assertEq(funding.balanceOf(address(gate)), 0);
        assertEq(aapl.balanceOf(address(gate)), 0);
        assertEq(funding.allowance(address(gate), address(aaplAdapter)), 0);
        assertEq(funding.allowance(address(gate), address(aaplVenue)), 0);
        // The adapter reset its exact venue approval and kept nothing.
        assertEq(funding.allowance(address(aaplAdapter), address(aaplVenue)), 0);
        assertEq(funding.balanceOf(address(aaplAdapter)), 0);
        assertEq(aapl.balanceOf(address(aaplAdapter)), 0);
    }

    function test_unrelatedDirectDonationDoesNotBecomeExecutionDerivedFunds() public {
        funding.mint(address(gate), 1);
        uint256 donated = funding.balanceOf(address(gate));
        _execute(_mandate(), _candidate(), _terms());
        assertEq(funding.balanceOf(address(gate)), donated);
        assertEq(aapl.balanceOf(address(gate)), 0);
    }

    function test_anyoneMaySubmitAFullySignedExecution_theOutcomeIsFixed() public {
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        bytes memory ps = _signMandate(m);
        bytes memory as_ = _signExecution(m, c, t);
        vm.prank(stranger);
        (, uint256 debit, uint256 credit) = gate.execute(m, ps, c, t, as_);
        assertEq(debit, 2_006e6);
        assertEq(credit, 10e18);
        assertEq(aapl.balanceOf(stranger), 0);
    }

    function test_syntheticRepresentation_executesOnlyWhenTheMandateAllowsIt() public {
        Mandate memory m = _mandate();
        m.allowedIssuers = _two("issuer.alpha", "issuer.synthetic");
        Candidate memory c = _candidateFor(address(synth), 1);
        c.issuer = "issuer.synthetic";
        _expectRevert(m, c, _terms(), _err(MandateExecutionGate.SyntheticNotAllowed.selector));

        m.syntheticPolicy = SYNTHETIC_ALLOWED;
        (,, uint256 credit) = _execute(m, c, _terms());
        assertEq(credit, 10e18);
    }

    // ------------------------------------------------------------------
    // Chain, domain and signatures
    // ------------------------------------------------------------------

    function test_refuses_wrongChain() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = (_mandate(), _candidate(), _terms());
        bytes memory ps = _signMandate(m);
        bytes memory as_ = _signExecution(m, c, t);
        vm.chainId(1);
        vm.expectRevert(MandateExecutionGate.WrongChain.selector);
        gate.execute(m, ps, c, t, as_);
    }

    function test_refuses_principalSignatureFromSomeoneElse() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = (_mandate(), _candidate(), _terms());
        bytes memory ps = _sign(STRANGER_KEY, _mandateHash(m));
        bytes memory as_ = _signExecution(m, c, t);
        vm.expectRevert(MandateExecutionGate.PrincipalSignatureInvalid.selector);
        gate.execute(m, ps, c, t, as_);
    }

    function test_refuses_crossContractReplayOfBothSignatures() public {
        // A second, identically configured gate at a different address.
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        MandateExecutionGate other = new MandateExecutionGate(_marketConfigs());
        assertEq(address(other), predicted);
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = (_mandate(), _candidate(), _terms());
        bytes memory ps = _signMandate(m); // signed for `gate`
        bytes memory as_ = _signExecution(m, c, t);
        vm.expectRevert(MandateExecutionGate.PrincipalSignatureInvalid.selector);
        other.execute(m, ps, c, t, as_);
    }

    function test_refuses_highSPrincipalSignature() public {
        Mandate memory m = _mandate();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PRINCIPAL_KEY, _mandateHash(m));
        uint256 n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        bytes memory twin = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        (Candidate memory c, ExecutionTerms memory t) = (_candidate(), _terms());
        bytes memory as_ = _signExecution(m, c, t);
        vm.expectRevert(MandateExecutionGate.PrincipalSignatureInvalid.selector);
        gate.execute(m, twin, c, t, as_);
    }

    function test_refuses_malformedPrincipalSignatures() public {
        Mandate memory m = _mandate();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PRINCIPAL_KEY, _mandateHash(m));
        bytes[4] memory malformed =
            [abi.encodePacked(r, s, v - 27), abi.encodePacked(r, s), bytes(""), abi.encodePacked(r, s, v, uint8(0))];
        (Candidate memory c, ExecutionTerms memory t) = (_candidate(), _terms());
        bytes memory as_ = _signExecution(m, c, t);
        for (uint256 i = 0; i < malformed.length; ++i) {
            vm.expectRevert(MandateExecutionGate.PrincipalSignatureInvalid.selector);
            gate.execute(m, malformed[i], c, t, as_);
        }
    }

    function test_refuses_agentSignatureFromSomeoneElse() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = (_mandate(), _candidate(), _terms());
        bytes memory as_ = _sign(STRANGER_KEY, _eip712(_commitment(m, c, t)));
        bytes memory ps = _signMandate(m);
        vm.expectRevert(MandateExecutionGate.AgentSignatureInvalid.selector);
        gate.execute(m, ps, c, t, as_);
    }

    function test_refuses_principalSignaturePresentedAsAgentSignature() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = (_mandate(), _candidate(), _terms());
        bytes memory ps = _signMandate(m);
        vm.expectRevert(MandateExecutionGate.AgentSignatureInvalid.selector);
        gate.execute(m, ps, c, t, ps);
    }

    function test_refuses_agentSignaturePresentedAsPrincipalSignature() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = (_mandate(), _candidate(), _terms());
        bytes memory agentAuthorization = _signExecution(m, c, t);
        vm.expectRevert(MandateExecutionGate.PrincipalSignatureInvalid.selector);
        gate.execute(m, agentAuthorization, c, t, agentAuthorization);
    }

    function test_sameAddressAsPrincipalAndAgentStillRequiresDistinctTypedSignatures() public {
        Mandate memory m = _mandate();
        m.agent = principal;
        Candidate memory c = _candidate();
        c.agent = principal;
        ExecutionTerms memory t = _terms();
        bytes memory principalAuthorization = _signMandate(m);
        vm.expectRevert(MandateExecutionGate.AgentSignatureInvalid.selector);
        gate.execute(m, principalAuthorization, c, t, principalAuthorization);
    }

    function test_oldExecutionAuthorizationCannotBindANewMandate() public {
        Mandate memory oldMandate = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        bytes memory oldAuthorization = _signExecution(oldMandate, c, t);
        Mandate memory newMandate = _mandate();
        newMandate.nonce = 2;
        bytes memory newPrincipalAuthorization = _signMandate(newMandate);
        vm.expectRevert(MandateExecutionGate.AgentSignatureInvalid.selector);
        gate.execute(newMandate, newPrincipalAuthorization, c, t, oldAuthorization);
    }

    // ------------------------------------------------------------------
    // Chain time: exact boundaries
    // ------------------------------------------------------------------

    function test_time_notBeforeIsInclusive() public {
        vm.warp(T0 - 60);
        _execute(_mandate(), _candidate(), _terms());
    }

    function test_time_oneSecondBeforeNotBeforeRefuses() public {
        vm.warp(T0 - 61);
        _expectRevert(_mandate(), _candidate(), _terms(), _err(MandateExecutionGate.MandateNotYetActive.selector));
    }

    function test_time_expiresAtIsExclusive() public {
        ExecutionTerms memory t = _terms();
        t.deadline = uint64(T0 + 3_600);
        vm.warp(T0 + 3_599);
        uint256 snapshot = vm.snapshotState();
        _execute(_mandate(), _candidate(), t);
        vm.revertToState(snapshot);
        vm.warp(T0 + 3_600);
        _expectRevert(_mandate(), _candidate(), t, _err(MandateExecutionGate.MandateExpired.selector));
    }

    function test_time_deadlineIsInclusive() public {
        vm.warp(T0 + 300);
        uint256 snapshot = vm.snapshotState();
        _execute(_mandate(), _candidate(), _terms());
        vm.revertToState(snapshot);
        vm.warp(T0 + 301);
        _expectRevert(_mandate(), _candidate(), _terms(), _err(MandateExecutionGate.ExecutionDeadlinePassed.selector));
    }

    function test_time_deadlineBeforeNotBeforeCanNeverExecute() public {
        Mandate memory m = _mandate();
        m.notBeforeUnixSeconds = int64(int256(T0 + 10));
        ExecutionTerms memory t = _terms();
        t.deadline = uint64(T0 + 9);
        _expectRevert(m, _candidate(), t, _err(MandateExecutionGate.MandateNotYetActive.selector));
        vm.warp(T0 + 10);
        _expectRevert(m, _candidate(), t, _err(MandateExecutionGate.ExecutionDeadlinePassed.selector));
    }

    function test_time_agentDeadlineLaterThanMandateExpiryCannotExtendMandate() public {
        ExecutionTerms memory t = _terms();
        t.deadline = uint64(T0 + 10_000);
        vm.warp(T0 + 3_600);
        _expectRevert(_mandate(), _candidate(), t, _err(MandateExecutionGate.MandateExpired.selector));
    }

    // ------------------------------------------------------------------
    // Replay
    // ------------------------------------------------------------------

    function test_replay_secondExecutionOfTheSameAttemptRefuses() public {
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        bytes memory ps = _signMandate(m);
        bytes memory as_ = _signExecution(m, c, t);
        gate.execute(m, ps, c, t, as_);
        vm.expectRevert(MandateExecutionGate.MandateAlreadyConsumed.selector);
        gate.execute(m, ps, c, t, as_);
    }

    function test_permissionlessRelay_copySettlesFirstAndIntendedRelayRevertsSafely() public {
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        bytes memory ps = _signMandate(m);
        bytes memory as_ = _signExecution(m, c, t);
        vm.prank(stranger);
        gate.execute(m, ps, c, t, as_);
        vm.prank(agent);
        vm.expectRevert(MandateExecutionGate.MandateAlreadyConsumed.selector);
        gate.execute(m, ps, c, t, as_);
        assertEq(aapl.balanceOf(stranger), 0);
    }

    function test_replay_aDifferentlySignedExecutionOfAConsumedMandateRefuses() public {
        _execute(_mandate(), _candidate(), _terms());
        ExecutionTerms memory t = _terms();
        t.fundingLimit = 2_009e6;
        _expectRevert(_mandate(), _candidate(), t, _err(MandateExecutionGate.MandateAlreadyConsumed.selector));
    }

    function test_replay_revertedAttemptConsumesNothingAndMayBeRetried() public {
        ExecutionTerms memory t = _terms();
        t.fundingLimit = 2_000e6; // below the venue's 2006 cost: the venue reverts
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        bytes memory ps = _signMandate(m);
        bytes memory as_ = _signExecution(m, c, t);
        vm.expectRevert();
        gate.execute(m, ps, c, t, as_);
        assertEq(gate.executionCommitmentOf(harness.mandateDigest(m)), bytes32(0));
        _execute(m, c, _terms());
        assertEq(gate.executionCommitmentOf(harness.mandateDigest(m)), _commitment(m, c, _terms()));
    }

    function test_replay_nonceMakesTwoOtherwiseIdenticalMandatesIndependent() public {
        Mandate memory a = _mandate();
        Mandate memory b = _mandate();
        b.nonce = 2;
        _execute(a, _candidate(), _terms());
        _execute(b, _candidate(), _terms());
        assertTrue(harness.mandateDigest(a) != harness.mandateDigest(b));
    }

    function test_replay_reorgRemovesConsumptionAndTheCanonicalExecutionCanSettle() public {
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        uint256 beforeBlock = vm.snapshotState();
        _execute(m, c, t);
        assertTrue(gate.executionCommitmentOf(harness.mandateDigest(m)) != bytes32(0));
        assertTrue(vm.revertToState(beforeBlock));
        assertEq(gate.executionCommitmentOf(harness.mandateDigest(m)), bytes32(0));
        _execute(m, c, t);
    }

    // ------------------------------------------------------------------
    // Binding: every field signed, and still refused
    // ------------------------------------------------------------------

    function test_refuses_unsupportedMandateVersion() public {
        Mandate memory m = _mandate();
        m.version = 1;
        _expectRevert(m, _candidate(), _terms(), _err(MandateExecutionGate.UnsupportedMandateVersion.selector));
    }

    function test_refuses_malformedMandate() public {
        Mandate memory m = _mandate();
        m.allowedVenues = _two("venue.scripted", "venue.fixture"); // not canonical order
        _expectRevert(m, _candidate(), _terms(), _err(MandateExecutionGate.MalformedMandate.selector));
    }

    function test_refuses_malformedCandidate() public {
        Candidate memory c = _candidate();
        c.version = 2;
        _expectRevert(_mandate(), c, _terms(), _err(MandateExecutionGate.MalformedCandidate.selector));
    }

    function test_refuses_unsupportedRepresentation() public {
        Candidate memory c = _candidate();
        c.representationId = harness.representationId(CHAIN, address(0xbad0));
        _expectRevert(_mandate(), c, _terms(), _err(MandateExecutionGate.UnsupportedRepresentation.selector));
    }

    function test_refuses_candidateAgentMismatch() public {
        Candidate memory c = _candidate();
        c.agent = stranger;
        _expectRevert(_mandate(), c, _terms(), _err(MandateExecutionGate.AgentMismatch.selector));
    }

    function test_refuses_sideMismatch() public {
        Candidate memory c = _candidate();
        c.side = SIDE_SELL;
        _expectRevert(_mandate(), c, _terms(), _err(MandateExecutionGate.SideMismatch.selector));
    }

    function test_refuses_candidateAssetMismatch() public {
        Candidate memory c = _candidate();
        c.canonicalAsset = _nvdaAsset();
        _expectRevert(_mandate(), c, _terms(), _err(MandateExecutionGate.CanonicalAssetMismatch.selector));
    }

    function test_refuses_tokenSubstitutionAcrossAssets() public {
        // Every candidate field claims AAPL; the token is fNVDA. The pinned market refuses.
        Candidate memory c = _candidateFor(address(nvda), 1);
        _expectRevert(_mandate(), c, _terms(), _err(MandateExecutionGate.RepresentationAssetMismatch.selector));
    }

    function test_refuses_chainMismatch() public {
        Candidate memory c = _candidate();
        c.chain = "eip155:1";
        _expectRevert(_mandate(), c, _terms(), _err(MandateExecutionGate.ChainMismatch.selector));
    }

    function test_refuses_chainNotAllowed() public {
        Mandate memory m = _mandate();
        m.allowedChains = _one("eip155:1");
        _expectRevert(m, _candidate(), _terms(), _err(MandateExecutionGate.ChainNotAllowed.selector));
    }

    function test_refuses_venueMismatch() public {
        Candidate memory c = _candidate();
        c.venue = "venue.scripted";
        _expectRevert(_mandate(), c, _terms(), _err(MandateExecutionGate.VenueMismatch.selector));
    }

    function test_refuses_venueNotAllowed() public {
        Mandate memory m = _mandate();
        m.allowedVenues = _one("venue.scripted");
        _expectRevert(m, _candidate(), _terms(), _err(MandateExecutionGate.VenueNotAllowed.selector));
    }

    function test_refuses_issuerMismatch() public {
        Candidate memory c = _candidate();
        c.issuer = "issuer.omega";
        _expectRevert(_mandate(), c, _terms(), _err(MandateExecutionGate.IssuerMismatch.selector));
    }

    function test_refuses_issuerNotAllowed() public {
        Mandate memory m = _mandate();
        m.allowedIssuers = _one("issuer.omega");
        _expectRevert(m, _candidate(), _terms(), _err(MandateExecutionGate.IssuerNotAllowed.selector));
    }

    function test_refuses_quantityUnitMismatch() public {
        Candidate memory c = _candidate();
        c.quantity.unit = "SHARE";
        _expectRevert(_mandate(), c, _terms(), _err(MandateExecutionGate.QuantityUnitMismatch.selector));
        c = _candidate();
        c.quantity.decimals = 6;
        _expectRevert(_mandate(), c, _terms(), _err(MandateExecutionGate.QuantityUnitMismatch.selector));
    }

    function test_refuses_zeroQuantity() public {
        Candidate memory c = _candidate();
        c.quantity.atoms = 0;
        _expectRevert(_mandate(), c, _terms(), _err(MandateExecutionGate.ZeroQuantity.selector));
    }

    function test_refuses_settlementUnitMismatch() public {
        Mandate memory m = _mandate();
        m.maxNotional.unit = "EUR";
        m.economicLimit.unit = "EUR";
        _expectRevert(m, _candidate(), _terms(), _err(MandateExecutionGate.SettlementUnitMismatch.selector));
    }

    function test_authority_maxNotional_belowAndExactSettle() public {
        Mandate memory belowMandate = _mandate();
        Candidate memory below = _scriptedCandidate(SIDE_BUY);
        below.quantity.atoms = 5e18;
        below.notional.atoms = 1_000e18;
        below.feeTotal.atoms = 3e18;
        ExecutionTerms memory belowTerms = _terms();
        _scriptHonest(5e18, belowTerms.fundingLimit - 1_003e6);
        _execute(belowMandate, below, belowTerms);

        Mandate memory exactMandate = _mandate();
        exactMandate.nonce = 2;
        _scriptHonest(10e18, _terms().fundingLimit - 2_006e6);
        _execute(exactMandate, _scriptedCandidate(SIDE_BUY), _terms());
    }

    function test_authority_validMaliciousAgentCannotExceedMaxNotional_buyOrSell() public {
        for (uint8 side = SIDE_BUY; side <= SIDE_SELL; ++side) {
            Mandate memory m = side == SIDE_BUY ? _mandate() : _sellMandate();
            Candidate memory c = _scriptedCandidate(side);
            m.maxNotional.atoms = c.notional.atoms - 1;
            ExecutionTerms memory t = side == SIDE_BUY ? _terms() : _sellTerms();
            _expectRevert(m, c, t, _err(MandateExecutionGate.MaxNotionalExceeded.selector));
        }
    }

    function test_authority_maxNotionalComparesDifferentScalesExactly() public {
        Mandate memory m = _mandate();
        m.maxNotional = Amount({unit: "USD", decimals: 2, atoms: 200_000});
        m.economicLimit = Amount({unit: "USD", decimals: 2, atoms: 201_000});
        Candidate memory c = _scriptedCandidate(SIDE_BUY);
        _scriptHonest(c.quantity.atoms, 4e6);
        _execute(m, c, _terms());

        m.nonce = 2;
        m.maxNotional.atoms = 199_999;
        _expectRevert(m, c, _terms(), _err(MandateExecutionGate.MaxNotionalExceeded.selector));
    }

    function test_authority_notionalAlternateScaleAndOneAtomMismatch() public {
        Candidate memory c = _scriptedCandidate(SIDE_BUY);
        c.notional = Amount({unit: "USD", decimals: 6, atoms: 2_000e6});
        c.feeTotal = Amount({unit: "USD", decimals: 6, atoms: 6e6});
        _scriptHonest(c.quantity.atoms, 4e6);
        _execute(_mandate(), c, _terms());

        Mandate memory m = _mandate();
        m.nonce = 2;
        c.notional.atoms += 1;
        _expectRevert(
            m,
            c,
            _terms(),
            abi.encodeWithSelector(MandateExecutionGate.NotionalInconsistent.selector, 2_000e6 + 1, 2_000e6, 2_000e6)
        );
    }

    function test_authority_notionalArithmeticRejectsOverflow() public {
        Candidate memory c = _scriptedCandidate(SIDE_BUY);
        c.quantity.atoms = type(uint256).max;
        c.executionPrice.decimals = 18;
        c.executionPrice.atoms = 200e18;
        c.notional.decimals = 18;
        c.notional.atoms = type(uint256).max;
        _expectRevert(_mandate(), c, _terms(), _err(MandateExecutionGate.NotionalOutOfRange.selector));
    }

    function test_authority_wrongEconomicUnitsRefuse() public {
        Candidate memory c = _scriptedCandidate(SIDE_BUY);
        c.notional.unit = "EUR";
        c.feeTotal.unit = "EUR";
        c.executionPrice.numeratorUnit = "EUR";
        _expectRevert(_mandate(), c, _terms(), _err(MandateExecutionGate.EconomicUnitMismatch.selector));
    }

    function test_authority_fixturePriceIsImmutableAcrossEquivalentScales() public {
        Candidate memory c = _scriptedCandidate(SIDE_BUY);
        c.executionPrice = Price({numeratorUnit: "USD", denominatorUnit: "TOKEN", decimals: 6, atoms: 200e6});
        _scriptHonest(c.quantity.atoms, 4e6);
        _execute(_mandate(), c, _terms());

        Mandate memory m = _mandate();
        m.nonce = 2;
        c.executionPrice.atoms = 199e6;
        c.notional.atoms = 1_990e18;
        _expectRevert(m, c, _terms(), _err(MandateExecutionGate.FixturePriceMismatch.selector));
    }

    function test_authority_zeroAgentPriceCannotEvadeMaxNotional() public {
        Candidate memory c = _scriptedCandidate(SIDE_BUY);
        c.quantity.atoms = type(uint128).max;
        c.executionPrice.atoms = 0;
        c.notional.atoms = 0;
        c.feeTotal.atoms = 0;
        _expectRevert(_mandate(), c, _terms(), _err(MandateExecutionGate.FixturePriceMismatch.selector));
    }

    function test_calldataTrailingBytesDoNotChangeTheDecodedAuthorizedAction() public {
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        bytes memory callData = abi.encodeCall(gate.execute, (m, _signMandate(m), c, t, _signExecution(m, c, t)));
        callData = bytes.concat(callData, hex"deadbeef");
        (bool ok, bytes memory returned) = address(gate).call(callData);
        assertTrue(ok);
        (, uint256 debit, uint256 credit) = abi.decode(returned, (bytes32, uint256, uint256));
        assertEq(debit, 2_006e6);
        assertEq(credit, 10e18);
    }

    function test_calldataTruncationAndMalformedTopLevelOffsetFailBeforeConsumption() public {
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        bytes memory callData = abi.encodeCall(gate.execute, (m, _signMandate(m), c, t, _signExecution(m, c, t)));
        // Remove padding plus one signature byte; removing padding alone is a
        // semantically equivalent ABI representation and remains acceptable.
        bytes memory truncated = new bytes(callData.length - 32);
        for (uint256 i = 0; i < truncated.length; ++i) {
            truncated[i] = callData[i];
        }
        (bool ok,) = address(gate).call(truncated);
        assertFalse(ok);
        assertEq(gate.executionCommitmentOf(harness.mandateDigest(m)), bytes32(0));

        assembly ("memory-safe") {
            mstore(add(callData, 0x24), not(0))
        }
        (ok,) = address(gate).call(callData);
        assertFalse(ok);
        assertEq(gate.executionCommitmentOf(harness.mandateDigest(m)), bytes32(0));
    }

    function test_authority_declaredBuyDebitAndSellCreditAreIndependentlyBounded() public {
        Candidate memory buy = _scriptedCandidate(SIDE_BUY);
        buy.feeTotal.atoms = 10e18 + 1;
        _expectRevert(_mandate(), buy, _terms(), _err(MandateExecutionGate.DeclaredTotalDebitExceeded.selector));

        Candidate memory sell = _scriptedCandidate(SIDE_SELL);
        sell.feeTotal.atoms = 10e18 + 1;
        _expectRevert(
            _sellMandate(), sell, _sellTerms(), _err(MandateExecutionGate.DeclaredTotalCreditBelowMinimum.selector)
        );

        sell.feeTotal.atoms = sell.notional.atoms;
        _expectRevert(
            _sellMandate(), sell, _sellTerms(), _err(MandateExecutionGate.DeclaredFeesExceedNotional.selector)
        );
    }

    function test_profile_routeDataBelowAndAtLimitExecute_aboveRefuses() public {
        for (uint256 size = gate.MAX_EXECUTION_DATA_BYTES() - 1; size <= gate.MAX_EXECUTION_DATA_BYTES(); ++size) {
            Mandate memory m = _mandate();
            m.nonce = uint64(size);
            Candidate memory c = _scriptedCandidate(SIDE_BUY);
            ExecutionTerms memory t = _terms();
            t.executionData = new bytes(size);
            _scriptHonest(c.quantity.atoms, 4e6);
            _execute(m, c, t);
        }

        ExecutionTerms memory tooLarge = _terms();
        tooLarge.executionData = new bytes(gate.MAX_EXECUTION_DATA_BYTES() + 1);
        _expectRevert(
            _mandate(),
            _scriptedCandidate(SIDE_BUY),
            tooLarge,
            _err(MandateExecutionGate.ExecutionProfileExceeded.selector)
        );
    }

    function test_profile_setAboveLimitRefuses() public {
        Mandate memory m = _mandate();
        m.allowedIssuers = new string[](gate.MAX_PROFILE_SET_SIZE() + 1);
        for (uint256 i = 0; i < m.allowedIssuers.length; ++i) {
            bytes memory value = new bytes(i + 1);
            for (uint256 j = 0; j < value.length; ++j) {
                value[j] = "A";
            }
            m.allowedIssuers[i] = string(value);
        }
        _expectRevert(m, _candidate(), _terms(), _err(MandateExecutionGate.ExecutionProfileExceeded.selector));
    }

    function test_profile_maximumExecutableInputSettlesAndMeasuresGas() public {
        Mandate memory m = _mandate();
        string[] memory values = new string[](gate.MAX_PROFILE_SET_SIZE());
        values[0] = "issuer.alpha";
        for (uint256 i = 1; i < values.length; ++i) {
            values[i] = string.concat("issuer.extra", i < 10 ? "0" : "", vm.toString(i));
        }
        m.allowedIssuers = values;

        values = new string[](gate.MAX_PROFILE_SET_SIZE());
        values[0] = CHAIN_ID_STRING;
        for (uint256 i = 1; i < values.length; ++i) {
            values[i] = string.concat("eip155:500", i < 10 ? "0" : "", vm.toString(i));
        }
        m.allowedChains = values;

        values = new string[](gate.MAX_PROFILE_SET_SIZE());
        values[0] = "venue.fixture";
        values[1] = "venue.scripted";
        for (uint256 i = 2; i < values.length; ++i) {
            values[i] = string.concat("venue.zzextra", i < 10 ? "0" : "", vm.toString(i));
        }
        m.allowedVenues = values;

        ExecutionTerms memory t = _terms();
        t.executionData = new bytes(gate.MAX_EXECUTION_DATA_BYTES());
        Candidate memory c = _scriptedCandidate(SIDE_BUY);
        _scriptHonest(c.quantity.atoms, 4e6);
        uint256 beforeGas = gasleft();
        _execute(m, c, t);
        emit log_named_uint("max-profile execute gas", beforeGas - gasleft());
    }

    function test_refuses_recipientOtherThanThePrincipal() public {
        ExecutionTerms memory t = _terms();
        t.recipient = stranger;
        _expectRevert(_mandate(), _candidate(), t, _err(MandateExecutionGate.RecipientNotPrincipal.selector));
    }

    function test_refuses_spendOneAtomAboveTheSignedDebitBound() public {
        ExecutionTerms memory t = _terms();
        t.fundingLimit = 2_010e6 + 1;
        _expectRevert(
            _mandate(),
            _candidate(),
            t,
            abi.encodeWithSelector(MandateExecutionGate.FundingLimitExceedsMandate.selector, 2_010e6 + 1, 2_010e6)
        );
    }

    function test_refuses_proceedsOneAtomBelowTheSignedCreditBound() public {
        ExecutionTerms memory t = _sellTerms();
        t.fundingLimit = 1_990e6 - 1;
        _expectRevert(
            _sellMandate(),
            _candidateFor(address(aapl), SIDE_SELL),
            t,
            abi.encodeWithSelector(MandateExecutionGate.FundingLimitBelowMandate.selector, 1_990e6 - 1, 1_990e6)
        );
    }

    function test_refuses_tokenWhoseDecimalsMovedAfterDeployment() public {
        funding.setDecimals(18);
        _expectRevert(
            _mandate(),
            _candidate(),
            _terms(),
            abi.encodeWithSelector(MandateExecutionGate.TokenDecimalsChanged.selector, address(funding))
        );
    }

    // ------------------------------------------------------------------
    // Exact conversion
    // ------------------------------------------------------------------

    function test_conversion_roundsAgainstTheAgent() public view {
        assertEq(gate.floorToScale(2_010e18 + 9e11, 18, 6), 2_010e6);
        (bool ok, uint256 up) = gate.ceilToScale(2_010e18 + 9e11, 18, 6);
        assertTrue(ok);
        assertEq(up, 2_010e6 + 1);
        assertEq(gate.floorToScale(type(uint256).max, 0, 6), type(uint256).max);
        (ok,) = gate.ceilToScale(type(uint256).max, 0, 6);
        assertFalse(ok);
    }
}
