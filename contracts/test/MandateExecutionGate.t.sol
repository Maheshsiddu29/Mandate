// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Vm} from "forge-std/Test.sol";

import {MandateExecutionGate} from "../src/MandateExecutionGate.sol";
import {
    Candidate,
    ExecutionTerms,
    Mandate,
    Market,
    MarketConfig,
    SIDE_SELL,
    SYNTHETIC_ALLOWED
} from "../src/MandateTypes.sol";
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
