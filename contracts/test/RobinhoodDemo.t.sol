// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

import {MandateExecutionGate} from "../src/MandateExecutionGate.sol";
import {
    Amount,
    Candidate,
    CanonicalAsset,
    ExecutionTerms,
    Mandate,
    Price,
    SIDE_BUY,
    SYNTHETIC_FORBIDDEN,
    HALT_FORBID_WHEN_HALTED
} from "../src/MandateTypes.sol";
import {MandateDemoToken} from "../src/demo/MandateDemoToken.sol";
import {FixtureVenue} from "../src/fixture/FixtureVenue.sol";
import {DeployMandateGate} from "../script/DeployMandateGate.s.sol";
import {CodecHarness} from "./utils/CodecHarness.sol";

/// @notice Phase 7E.3: the Robinhood Chain testnet demonstration market, on the
/// real frozen gate and the real labelled demo tokens, deployed through the
/// reviewed deployment script at chain id 46630. The mandate, candidate and
/// terms are shaped exactly as `packages/evm-robinhood/src/gate.ts` derives
/// them from a Core authorization: a per-reservation mandate whose bounds are
/// the reserved capital exactly, recipient the principal, empty route data.
///
/// BUY 30 MDEMO at the fixture price 10 MDUSD, no fee: 300 MDUSD.
contract RobinhoodDemoTest is Test {
    uint256 internal constant CHAIN = 46_630;
    string internal constant CHAIN_ID = "eip155:46630";
    uint256 internal constant PRINCIPAL_KEY = 0xA11CE;
    uint256 internal constant AGENT_KEY = 0xB0B;
    uint256 internal constant T0 = 1_790_813_800;

    address internal deployer = address(0xde91);
    address internal principal;
    address internal agent;
    MandateDemoToken internal mdemo;
    MandateDemoToken internal mdusd;
    MandateExecutionGate internal gate;
    FixtureVenue internal venue;
    CodecHarness internal harness;

    function setUp() public {
        vm.chainId(CHAIN);
        vm.warp(T0);
        principal = vm.addr(PRINCIPAL_KEY);
        agent = vm.addr(AGENT_KEY);
        harness = new CodecHarness();
        vm.startPrank(deployer);
        mdemo = new MandateDemoToken("Mandate Demo Asset (TESTNET FIXTURE)", "MDEMO", 18, deployer, 1_000_000e18);
        mdusd = new MandateDemoToken("Mandate Demo Dollar (TESTNET FIXTURE)", "MDUSD", 6, deployer, 1_000_000e6);
        vm.stopPrank();

        DeployMandateGate script = new DeployMandateGate();
        DeployMandateGate.Deployment memory d = script.deploy(_config(), deployer);
        gate = d.gate;
        venue = d.venues[0];

        vm.startPrank(deployer);
        mdemo.transfer(address(venue), 1_000e18);
        mdusd.transfer(principal, 1_000e6);
        vm.stopPrank();
        // The onchain allowance equals the Mandate capital authority: 500 MDUSD.
        vm.prank(principal);
        mdusd.approve(address(gate), 500e6);
    }

    function _config() internal view returns (string memory) {
        return string.concat(
            '{"chainId":46630,"markets":[{"representation":"',
            vm.toString(address(mdemo)),
            '","fundingToken":"',
            vm.toString(address(mdusd)),
            '","canonicalAsset":{"assetClass":"fixture","idScheme":"mandate-demo","value":"MDEMO"},',
            '"issuer":"issuer.mandate-demo","venue":"venue.mandate-fixture","quantityUnit":"TOKEN",',
            '"settlementUnit":"MDUSD","synthetic":false,"classification":"FIXTURE",',
            '"fixturePriceDecimals":6,"fixturePrice":"10000000","fixtureFeeBps":0}]}'
        );
    }

    function _one(string memory s) internal pure returns (string[] memory out) {
        out = new string[](1);
        out[0] = s;
    }

    function _mdusd(uint256 atoms) internal pure returns (Amount memory) {
        return Amount({unit: "MDUSD", decimals: 6, atoms: atoms});
    }

    function _asset() internal pure returns (CanonicalAsset memory) {
        return CanonicalAsset({assetClass: "fixture", idScheme: "mandate-demo", value: "MDEMO"});
    }

    /// @dev As gate.ts: bounds are the reserved capital exactly; nonce is the gate slot.
    function _mandate(uint256 debit, uint64 nonce) internal view returns (Mandate memory m) {
        m.version = 2;
        m.mandateId = keccak256(abi.encode("reservation", nonce));
        m.nonce = nonce;
        m.principal = principal;
        m.agent = agent;
        m.canonicalAsset = _asset();
        m.side = SIDE_BUY;
        m.maxNotional = _mdusd(debit);
        m.economicLimit = _mdusd(debit);
        m.maxDeviationBps = 0;
        m.syntheticPolicy = SYNTHETIC_FORBIDDEN;
        m.allowedIssuers = _one("issuer.mandate-demo");
        m.allowedChains = _one(CHAIN_ID);
        m.allowedVenues = _one("venue.mandate-fixture");
        m.requiredCorporateActionEpoch = 1;
        m.maxPriceAgeSeconds = 60;
        m.maxCorporateActionAgeSeconds = 3_600;
        m.haltPolicy = HALT_FORBID_WHEN_HALTED;
        m.createdAtUnixSeconds = int64(int256(T0));
        m.notBeforeUnixSeconds = int64(int256(T0));
        m.expiresAtUnixSeconds = int64(int256(T0 + 3_600));
    }

    function _candidate(address token, uint256 quantity, uint256 notional) internal view returns (Candidate memory c) {
        c.version = 3;
        c.representationId = harness.representationId(CHAIN, token);
        c.canonicalAsset = _asset();
        c.issuer = "issuer.mandate-demo";
        c.chain = CHAIN_ID;
        c.venue = "venue.mandate-fixture";
        c.side = SIDE_BUY;
        c.agent = agent;
        c.quantity = Amount({unit: "TOKEN", decimals: 18, atoms: quantity});
        c.executionPrice = Price({numeratorUnit: "MDUSD", denominatorUnit: "TOKEN", decimals: 6, atoms: 10e6});
        c.notional = _mdusd(notional);
        c.feeTotal = _mdusd(0);
        c.evaluationStateId = "mandate-core.authorization-record";
        c.evaluationStateDigest = keccak256("authorization-record");
        c.registrySnapshotDigest = keccak256("reviewed-market");
        c.corporateActionEpoch = 1;
    }

    function _terms(uint256 debit) internal view returns (ExecutionTerms memory) {
        return
            ExecutionTerms({recipient: principal, fundingLimit: debit, deadline: uint64(T0 + 120), executionData: ""});
    }

    function _eip712(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", gate.domainSeparator(), structHash));
    }

    function _sign(uint256 key, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash);
        return abi.encodePacked(r, s, v);
    }

    function _principalSig(Mandate memory m) internal view returns (bytes memory) {
        return _sign(
            PRINCIPAL_KEY,
            _eip712(keccak256(abi.encode(gate.MANDATE_AUTHORIZATION_TYPEHASH(), harness.mandateDigest(m))))
        );
    }

    function _commitment(Mandate memory m, Candidate memory c, ExecutionTerms memory t)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                gate.EXECUTION_AUTHORIZATION_TYPEHASH(),
                harness.mandateDigest(m),
                harness.candidateDigest(c),
                t.recipient,
                t.fundingLimit,
                t.deadline,
                keccak256(t.executionData)
            )
        );
    }

    function _agentSig(Mandate memory m, Candidate memory c, ExecutionTerms memory t)
        internal
        view
        returns (bytes memory)
    {
        return _sign(AGENT_KEY, _eip712(_commitment(m, c, t)));
    }

    struct Signed {
        Mandate m;
        bytes ps;
        Candidate c;
        ExecutionTerms t;
        bytes as_;
    }

    function _authorized300() internal view returns (Signed memory s) {
        s.m = _mandate(300e6, 1);
        s.c = _candidate(address(mdemo), 30e18, 300e6);
        s.t = _terms(300e6);
        s.ps = _principalSig(s.m);
        s.as_ = _agentSig(s.m, s.c, s.t);
    }

    function _expect(Signed memory s, bytes memory revertData) internal {
        vm.expectRevert(revertData);
        gate.execute(s.m, s.ps, s.c, s.t, s.as_);
    }

    function test_demoMarketIsTheReviewedOne() public view {
        assertEq(venue.PRICE(), 10e6);
        assertEq(venue.FEE_BPS(), 0);
        assertEq(address(venue.REPRESENTATION()), address(mdemo));
        assertEq(address(venue.FUNDING()), address(mdusd));
        assertEq(mdemo.decimals(), 18);
        assertEq(mdusd.decimals(), 6);
        assertEq(venue.quoteBuy(30e18), 300e6);
    }

    function test_authorizedBuySettlesExactly() public {
        Signed memory s = _authorized300();
        uint256 gasBefore = gasleft();
        (bytes32 commitment, uint256 debit, uint256 credit) = gate.execute(s.m, s.ps, s.c, s.t, s.as_);
        emit log_named_uint("execute gas (warm, in-test)", gasBefore - gasleft());
        assertEq(commitment, _commitment(s.m, s.c, s.t));
        assertEq(debit, 300e6);
        assertEq(credit, 30e18);
        assertEq(mdusd.balanceOf(principal), 700e6);
        assertEq(mdemo.balanceOf(principal), 30e18);
        assertEq(gate.executionCommitmentOf(harness.mandateDigest(s.m)), commitment);
        assertEq(mdusd.allowance(principal, address(gate)), 200e6);
        assertEq(mdusd.balanceOf(address(gate)), 0);
        assertEq(mdemo.balanceOf(address(gate)), 0);
    }

    function test_replayOfTheSameAuthorizationReverts() public {
        Signed memory s = _authorized300();
        gate.execute(s.m, s.ps, s.c, s.t, s.as_);
        _expect(s, abi.encodeWithSelector(MandateExecutionGate.MandateAlreadyConsumed.selector));
        assertEq(mdemo.balanceOf(principal), 30e18);
    }

    function test_amountMutationReverts() public {
        Signed memory s = _authorized300();
        s.c.quantity.atoms = 31e18;
        _expect(s, abi.encodeWithSelector(MandateExecutionGate.AgentSignatureInvalid.selector));
        // Re-signed by a compromised agent key: the principal's bound still refuses it.
        s.c.notional.atoms = 310e6;
        s.as_ = _agentSig(s.m, s.c, s.t);
        _expect(s, abi.encodeWithSelector(MandateExecutionGate.MaxNotionalExceeded.selector));
    }

    function test_recipientMutationReverts() public {
        Signed memory s = _authorized300();
        s.t.recipient = address(0xbeef);
        _expect(s, abi.encodeWithSelector(MandateExecutionGate.AgentSignatureInvalid.selector));
        s.as_ = _agentSig(s.m, s.c, s.t);
        _expect(s, abi.encodeWithSelector(MandateExecutionGate.RecipientNotPrincipal.selector));
    }

    function test_targetMutationReverts() public {
        Signed memory s = _authorized300();
        s.c = _candidate(address(mdusd), 30e18, 300e6);
        s.as_ = _agentSig(s.m, s.c, s.t);
        _expect(s, abi.encodeWithSelector(MandateExecutionGate.UnsupportedRepresentation.selector));
    }

    function test_expiredAuthorizationReverts() public {
        Signed memory s = _authorized300();
        vm.warp(T0 + 121);
        _expect(s, abi.encodeWithSelector(MandateExecutionGate.ExecutionDeadlinePassed.selector));
        vm.warp(T0 + 3_600);
        _expect(s, abi.encodeWithSelector(MandateExecutionGate.MandateExpired.selector));
    }

    function test_wrongPrincipalReverts() public {
        Signed memory s = _authorized300();
        s.ps = _sign(
            AGENT_KEY, _eip712(keccak256(abi.encode(gate.MANDATE_AUTHORIZATION_TYPEHASH(), harness.mandateDigest(s.m))))
        );
        _expect(s, abi.encodeWithSelector(MandateExecutionGate.PrincipalSignatureInvalid.selector));
    }

    function test_anotherGenerationIsAnotherMandate() public {
        Signed memory s = _authorized300();
        gate.execute(s.m, s.ps, s.c, s.t, s.as_);
        // Generation 2 is a new mandate id and nonce: it needs its own principal signature.
        Signed memory g2 = _authorized300();
        g2.m.mandateId = keccak256(abi.encode("reservation", uint64(2)));
        g2.m.nonce = 2;
        g2.as_ = _agentSig(g2.m, g2.c, g2.t);
        _expect(g2, abi.encodeWithSelector(MandateExecutionGate.PrincipalSignatureInvalid.selector));
    }

    /// @notice The agent has no alternate path to the principal's funds: it holds no allowance,
    /// and the only allowance (principal -> gate) moves nothing without a principal signature.
    function test_agentHasNoDirectPath() public {
        vm.prank(agent);
        vm.expectRevert();
        mdusd.transferFrom(principal, agent, 1);
        vm.prank(agent);
        vm.expectRevert();
        venue.buy(1e18, 10e6, agent);
        assertEq(mdusd.allowance(principal, agent), 0);
    }

    /// @notice Two BUYs within the 500 MDUSD allowance settle; a third that would pass it cannot pull more than was approved.
    function test_allowanceMirrorsTheCapitalAuthority() public {
        Signed memory s = _authorized300();
        gate.execute(s.m, s.ps, s.c, s.t, s.as_);
        Signed memory t2;
        t2.m = _mandate(250e6, 2);
        t2.c = _candidate(address(mdemo), 25e18, 250e6);
        t2.t = _terms(250e6);
        t2.ps = _principalSig(t2.m);
        t2.as_ = _agentSig(t2.m, t2.c, t2.t);
        vm.expectRevert();
        gate.execute(t2.m, t2.ps, t2.c, t2.t, t2.as_);
        assertEq(mdusd.balanceOf(principal), 700e6);
    }
}
