// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

import {MandateExecutionGate} from "../../src/MandateExecutionGate.sol";
import {
    Amount,
    CanonicalAsset,
    Candidate,
    ExecutionTerms,
    HALT_FORBID_WHEN_HALTED,
    Mandate,
    MarketConfig,
    Price,
    SIDE_BUY,
    SIDE_SELL,
    SYNTHETIC_FORBIDDEN
} from "../../src/MandateTypes.sol";
import {FixtureVenue} from "../../src/fixture/FixtureVenue.sol";
import {FixtureVenueAdapter} from "../../src/fixture/FixtureVenueAdapter.sol";
import {MockERC20} from "../mocks/MockTokens.sol";
import {ScriptedAdapter} from "../mocks/ScriptedAdapter.sol";
import {CodecHarness} from "./CodecHarness.sol";

/// @notice One coherent valid world plus signing helpers. Every negative test is
/// this world with one thing changed, mirroring the kernel's test fixtures.
///
/// Markets (chain 46630, the Robinhood Chain testnet ID; every token and venue is
/// a labelled fixture, not a deployed Robinhood contract):
///
/// | market   | token  | adapter              | asset | issuer            | venue          | synthetic |
/// | -------- | ------ | -------------------- | ----- | ----------------- | -------------- | --------- |
/// | AAPL     | fAAPL  | FixtureVenueAdapter  | AAPL  | issuer.alpha      | venue.fixture  | no        |
/// | NVDA     | fNVDA  | FixtureVenueAdapter  | NVDA  | issuer.alpha      | venue.fixture  | no        |
/// | SYNTH    | sAAPL  | FixtureVenueAdapter  | AAPL  | issuer.synthetic  | venue.fixture  | yes       |
/// | SCRIPTED | xAAPL  | ScriptedAdapter      | AAPL  | issuer.alpha      | venue.scripted | no        |
abstract contract GateTestBase is Test {
    uint256 internal constant CHAIN = 46_630;
    string internal constant CHAIN_ID_STRING = "eip155:46630";
    uint256 internal constant T0 = 1_800_000_000;

    /// @dev The kernel's published test keys (packages/kernel/test/support/signing.ts). They secure nothing.
    uint256 internal constant PRINCIPAL_KEY = 0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318;
    uint256 internal constant AGENT_KEY = 0x8da4ef21b864d2cc526dbdb2a120bd2874c36c9d0a1fb7f8c63d7f7a8b41de8f;
    uint256 internal constant STRANGER_KEY = 0xa11ce;

    /// @dev 200.000000 fUSDC per whole token, 30 bps fee.
    uint256 internal constant AAPL_PRICE = 200e6;
    uint256 internal constant NVDA_PRICE = 100e6;
    uint16 internal constant FEE_BPS = 30;

    address internal principal;
    address internal agent;
    address internal stranger;

    CodecHarness internal harness;
    MandateExecutionGate internal gate;

    MockERC20 internal funding;
    MockERC20 internal aapl;
    MockERC20 internal nvda;
    MockERC20 internal synth;
    MockERC20 internal scriptedToken;

    FixtureVenue internal aaplVenue;
    FixtureVenue internal nvdaVenue;
    FixtureVenue internal synthVenue;
    FixtureVenueAdapter internal aaplAdapter;
    FixtureVenueAdapter internal nvdaAdapter;
    FixtureVenueAdapter internal synthAdapter;
    ScriptedAdapter internal scripted;

    function setUp() public virtual {
        vm.chainId(CHAIN);
        vm.warp(T0);
        principal = vm.addr(PRINCIPAL_KEY);
        agent = vm.addr(AGENT_KEY);
        stranger = vm.addr(STRANGER_KEY);
        harness = new CodecHarness();

        funding = new MockERC20("Fixture USD Coin", "fUSDC", 6);
        aapl = new MockERC20("Fixture Apple Stock Token", "fAAPL", 18);
        nvda = new MockERC20("Fixture NVIDIA Stock Token", "fNVDA", 18);
        synth = new MockERC20("Fixture Synthetic Apple", "sAAPL", 18);
        scriptedToken = new MockERC20("Fixture Scripted Apple", "xAAPL", 18);

        aaplVenue = new FixtureVenue(aapl, funding, AAPL_PRICE, FEE_BPS);
        nvdaVenue = new FixtureVenue(nvda, funding, NVDA_PRICE, FEE_BPS);
        synthVenue = new FixtureVenue(synth, funding, AAPL_PRICE, FEE_BPS);
        scripted = new ScriptedAdapter();

        // Adapters name their gate, and the gate names its adapters: predict the
        // gate's CREATE address, which follows the three adapter deployments.
        address predictedGate = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 3);
        aaplAdapter = new FixtureVenueAdapter(predictedGate, aaplVenue);
        nvdaAdapter = new FixtureVenueAdapter(predictedGate, nvdaVenue);
        synthAdapter = new FixtureVenueAdapter(predictedGate, synthVenue);
        gate = new MandateExecutionGate(_marketConfigs());
        assertEq(address(gate), predictedGate, "gate address prediction");

        _stock(address(aaplVenue), aapl);
        _stock(address(nvdaVenue), nvda);
        _stock(address(synthVenue), synth);
        _stock(address(scripted), scriptedToken);

        funding.mint(principal, 1_000_000e6);
        aapl.mint(principal, 1_000e18);
        nvda.mint(principal, 1_000e18);
        synth.mint(principal, 1_000e18);
        scriptedToken.mint(principal, 1_000e18);

        vm.startPrank(principal);
        funding.approve(address(gate), type(uint256).max);
        aapl.approve(address(gate), type(uint256).max);
        nvda.approve(address(gate), type(uint256).max);
        synth.approve(address(gate), type(uint256).max);
        scriptedToken.approve(address(gate), type(uint256).max);
        vm.stopPrank();
    }

    function _stock(address holder, MockERC20 token) internal {
        token.mint(holder, 1_000_000e18);
        funding.mint(holder, 1_000_000_000e6);
    }

    // ------------------------------------------------------------------
    // World
    // ------------------------------------------------------------------

    function _aaplAsset() internal pure returns (CanonicalAsset memory) {
        return CanonicalAsset({assetClass: "equity", idScheme: "isin", value: "US0378331005"});
    }

    function _nvdaAsset() internal pure returns (CanonicalAsset memory) {
        return CanonicalAsset({assetClass: "equity", idScheme: "isin", value: "US67066G1040"});
    }

    function _market(
        address token,
        address adapter,
        CanonicalAsset memory asset,
        string memory issuer,
        string memory venue,
        bool synthetic_
    ) internal view returns (MarketConfig memory) {
        return MarketConfig({
            representation: token,
            fundingToken: address(funding),
            adapter: adapter,
            canonicalAsset: asset,
            issuer: issuer,
            venue: venue,
            quantityUnit: "TOKEN",
            settlementUnit: "USD",
            synthetic: synthetic_
        });
    }

    function _marketConfigs() internal view returns (MarketConfig[] memory markets) {
        markets = new MarketConfig[](4);
        markets[0] = _market(address(aapl), address(aaplAdapter), _aaplAsset(), "issuer.alpha", "venue.fixture", false);
        markets[1] = _market(address(nvda), address(nvdaAdapter), _nvdaAsset(), "issuer.alpha", "venue.fixture", false);
        markets[2] =
            _market(address(synth), address(synthAdapter), _aaplAsset(), "issuer.synthetic", "venue.fixture", true);
        markets[3] =
            _market(address(scriptedToken), address(scripted), _aaplAsset(), "issuer.alpha", "venue.scripted", false);
    }

    function _usd(uint256 atoms) internal pure returns (Amount memory) {
        return Amount({unit: "USD", decimals: 18, atoms: atoms});
    }

    function _one(string memory a) internal pure returns (string[] memory out) {
        out = new string[](1);
        out[0] = a;
    }

    function _two(string memory a, string memory b) internal pure returns (string[] memory out) {
        out = new string[](2);
        out[0] = a;
        out[1] = b;
    }

    /// @notice BUY 10 fAAPL with at most 2010.00 USD debited, valid T0-60 .. T0+3600.
    function _mandate() internal view returns (Mandate memory m) {
        m.version = 2;
        m.mandateId = bytes32(uint256(0x11));
        m.nonce = 1;
        m.principal = principal;
        m.agent = agent;
        m.canonicalAsset = _aaplAsset();
        m.side = SIDE_BUY;
        m.maxNotional = _usd(2_000e18);
        m.economicLimit = _usd(2_010e18);
        m.maxDeviationBps = 40;
        m.syntheticPolicy = SYNTHETIC_FORBIDDEN;
        m.allowedIssuers = _one("issuer.alpha");
        m.allowedChains = _one(CHAIN_ID_STRING);
        m.allowedVenues = _two("venue.fixture", "venue.scripted");
        m.requiredCorporateActionEpoch = 1;
        m.maxPriceAgeSeconds = 60;
        m.maxCorporateActionAgeSeconds = 3_600;
        m.haltPolicy = HALT_FORBID_WHEN_HALTED;
        m.createdAtUnixSeconds = int64(int256(T0) - 100);
        m.notBeforeUnixSeconds = int64(int256(T0) - 60);
        m.expiresAtUnixSeconds = int64(int256(T0) + 3_600);
    }

    function _sellMandate() internal view returns (Mandate memory m) {
        m = _mandate();
        m.side = SIDE_SELL;
        // Sell 10 fAAPL for at least 1990.00 USD net.
        m.economicLimit = _usd(1_990e18);
    }

    function _candidateFor(address token, uint8 side) internal view returns (Candidate memory c) {
        c.version = 3;
        c.representationId = harness.representationId(CHAIN, token);
        c.canonicalAsset = _aaplAsset();
        c.issuer = "issuer.alpha";
        c.chain = CHAIN_ID_STRING;
        c.venue = "venue.fixture";
        c.side = side;
        c.agent = agent;
        c.quantity = Amount({unit: "TOKEN", decimals: 18, atoms: 10e18});
        c.executionPrice = Price({numeratorUnit: "USD", denominatorUnit: "TOKEN", decimals: 18, atoms: 200e18});
        c.notional = _usd(2_000e18);
        c.feeTotal = _usd(6e18);
        c.evaluationStateId = "state.fixture.0001";
        c.evaluationStateDigest = bytes32(uint256(0xe1));
        c.registrySnapshotDigest = bytes32(uint256(0xa5));
        c.corporateActionEpoch = 1;
    }

    function _candidate() internal view returns (Candidate memory) {
        return _candidateFor(address(aapl), SIDE_BUY);
    }

    function _scriptedCandidate(uint8 side) internal view returns (Candidate memory c) {
        c = _candidateFor(address(scriptedToken), side);
        c.venue = "venue.scripted";
    }

    function _terms() internal view returns (ExecutionTerms memory) {
        return
            ExecutionTerms({recipient: principal, fundingLimit: 2_010e6, deadline: uint64(T0 + 300), executionData: ""});
    }

    function _sellTerms() internal view returns (ExecutionTerms memory t) {
        t = _terms();
        t.fundingLimit = 1_990e6;
    }

    // ------------------------------------------------------------------
    // Signing
    // ------------------------------------------------------------------

    function _eip712(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", gate.domainSeparator(), structHash));
    }

    function _sign(uint256 key, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash);
        return abi.encodePacked(r, s, v);
    }

    function _mandateHash(Mandate memory m) internal view returns (bytes32) {
        return _eip712(keccak256(abi.encode(gate.MANDATE_AUTHORIZATION_TYPEHASH(), harness.mandateDigest(m))));
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

    function _signMandate(Mandate memory m) internal view returns (bytes memory) {
        return _sign(PRINCIPAL_KEY, _mandateHash(m));
    }

    function _signExecution(Mandate memory m, Candidate memory c, ExecutionTerms memory t)
        internal
        view
        returns (bytes memory)
    {
        return _sign(AGENT_KEY, _eip712(_commitment(m, c, t)));
    }

    /// @notice Sign everything honestly and execute.
    function _execute(Mandate memory m, Candidate memory c, ExecutionTerms memory t)
        internal
        returns (bytes32, uint256, uint256)
    {
        return gate.execute(m, _signMandate(m), c, t, _signExecution(m, c, t));
    }

    /// @notice Sign everything honestly and expect `revertData`.
    function _expectRevert(Mandate memory m, Candidate memory c, ExecutionTerms memory t, bytes memory revertData)
        internal
    {
        bytes memory ps = _signMandate(m);
        bytes memory as_ = _signExecution(m, c, t);
        vm.expectRevert(revertData);
        gate.execute(m, ps, c, t, as_);
    }

    function _err(bytes4 selector) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(selector);
    }

    function _scriptHonest(uint256 deliver, uint256 refund) internal {
        scripted.setScript(
            ScriptedAdapter.Script({
                mode: ScriptedAdapter.Mode.SCRIPTED,
                deliver: deliver,
                refund: refund,
                deliverTo: address(0),
                reentryTarget: address(0),
                reentryPayload: "",
                bubbleReentry: false,
                extraPull: 0
            })
        );
    }
}
