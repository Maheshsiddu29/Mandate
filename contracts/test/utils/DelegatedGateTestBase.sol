// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

import {MandateDelegatedExecutionGate} from "../../src/MandateDelegatedExecutionGate.sol";
import {
    Amount,
    CanonicalAsset,
    Candidate,
    ExecutionTerms,
    HALT_FORBID_WHEN_HALTED,
    MARKET_FIXTURE,
    Mandate,
    MarketConfig,
    Price,
    SIDE_BUY,
    SYNTHETIC_FORBIDDEN
} from "../../src/MandateTypes.sol";
import {FixtureVenue} from "../../src/fixture/FixtureVenue.sol";
import {FixtureVenueAdapter} from "../../src/fixture/FixtureVenueAdapter.sol";
import {MockERC20} from "../mocks/MockTokens.sol";
import {ScriptedAdapter} from "../mocks/ScriptedAdapter.sol";
import {CodecHarness} from "./CodecHarness.sol";

/// @notice Coherent V3 delegated-gate world. Keys mirror GateTestBase plus a
/// distinct Mandate execution delegate that is never the agent.
abstract contract DelegatedGateTestBase is Test {
    uint256 internal constant CHAIN = 46_630;
    string internal constant CHAIN_ID_STRING = "eip155:46630";
    uint256 internal constant T0 = 1_800_000_000;

    uint256 internal constant PRINCIPAL_KEY = 0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318;
    uint256 internal constant AGENT_KEY = 0x8da4ef21b864d2cc526dbdb2a120bd2874c36c9d0a1fb7f8c63d7f7a8b41de8f;
    /// @dev Distinct from agent and principal. Secures nothing; test only.
    uint256 internal constant DELEGATE_KEY = 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;
    uint256 internal constant STRANGER_KEY = 0xa11ce;

    uint256 internal constant AAPL_PRICE = 200e6;
    uint16 internal constant FEE_BPS = 30;
    /// @dev Exact venue debit for the default BUY of 10 tokens: 2000 + 30 bps = 2006.
    uint256 internal constant EXACT_DEBIT = 2_006e6;

    address internal principal;
    address internal agent;
    address internal delegate;
    address internal stranger;

    CodecHarness internal harness;
    MandateDelegatedExecutionGate internal dgate;

    MockERC20 internal funding;
    MockERC20 internal aapl;
    MockERC20 internal nvda;
    MockERC20 internal scriptedToken;

    FixtureVenue internal aaplVenue;
    FixtureVenueAdapter internal aaplAdapter;
    ScriptedAdapter internal scripted;

    function setUp() public virtual {
        vm.chainId(CHAIN);
        vm.warp(T0);
        principal = vm.addr(PRINCIPAL_KEY);
        agent = vm.addr(AGENT_KEY);
        delegate = vm.addr(DELEGATE_KEY);
        stranger = vm.addr(STRANGER_KEY);
        harness = new CodecHarness();

        funding = new MockERC20("Fixture USD Coin", "fUSDC", 6);
        aapl = new MockERC20("Fixture Apple Stock Token", "fAAPL", 18);
        nvda = new MockERC20("Fixture NVIDIA Stock Token", "fNVDA", 18);
        scriptedToken = new MockERC20("Fixture Scripted Apple", "xAAPL", 18);

        dgate = new MandateDelegatedExecutionGate(_marketConfigs());
        aaplVenue = _venueOf(address(aapl));
        aaplAdapter = _adapterOf(address(aapl));
        scripted = _scriptAdapter(address(scriptedToken));

        aapl.mint(address(aaplVenue), 1_000_000e18);
        funding.mint(address(aaplVenue), 1_000_000_000e6);
        scriptedToken.mint(address(scripted), 1_000_000e18);
        funding.mint(address(scripted), 1_000_000_000e6);

        funding.mint(principal, 1_000_000e6);
        aapl.mint(principal, 1_000e18);
        scriptedToken.mint(principal, 1_000e18);

        vm.startPrank(principal);
        funding.approve(address(dgate), type(uint256).max);
        aapl.approve(address(dgate), type(uint256).max);
        scriptedToken.approve(address(dgate), type(uint256).max);
        vm.stopPrank();

        assertTrue(delegate != agent);
        assertTrue(delegate != principal);
    }

    function _aaplAsset() internal pure returns (CanonicalAsset memory) {
        return CanonicalAsset({assetClass: "equity", idScheme: "isin", value: "US0378331005"});
    }

    function _market(address token, string memory issuer, string memory venue, bool synthetic_)
        internal
        view
        returns (MarketConfig memory)
    {
        return MarketConfig({
            representation: token,
            fundingToken: address(funding),
            canonicalAsset: _aaplAsset(),
            issuer: issuer,
            venue: venue,
            quantityUnit: "TOKEN",
            settlementUnit: "USD",
            synthetic: synthetic_,
            classification: MARKET_FIXTURE,
            fixturePrice: Price({numeratorUnit: "USD", denominatorUnit: "TOKEN", decimals: 6, atoms: AAPL_PRICE}),
            fixtureFeeBps: FEE_BPS
        });
    }

    function _marketConfigs() internal view returns (MarketConfig[] memory markets) {
        markets = new MarketConfig[](2);
        markets[0] = _market(address(aapl), "issuer.alpha", "venue.fixture", false);
        markets[1] = _market(address(scriptedToken), "issuer.alpha", "venue.scripted", false);
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

    function _candidateFor(address token) internal view returns (Candidate memory c) {
        c.version = 3;
        c.representationId = harness.representationId(CHAIN, token);
        c.canonicalAsset = _aaplAsset();
        c.issuer = "issuer.alpha";
        c.chain = CHAIN_ID_STRING;
        c.venue = "venue.fixture";
        c.side = SIDE_BUY;
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
        return _candidateFor(address(aapl));
    }

    function _terms() internal view returns (ExecutionTerms memory) {
        return ExecutionTerms({
            recipient: principal, fundingLimit: EXACT_DEBIT, deadline: uint64(T0 + 300), executionData: ""
        });
    }

    function _delegation(uint256 cumulativeDebitLimit)
        internal
        view
        returns (MandateDelegatedExecutionGate.Delegation memory d)
    {
        d.portfolioMandateDigest = bytes32(uint256(0xb01));
        d.initialAllocationDigest = bytes32(uint256(0xa11));
        d.sessionDigest = bytes32(uint256(0x5e5));
        d.principal = principal;
        d.delegate = delegate;
        d.agent = agent;
        d.representationIdHash = keccak256(bytes(harness.representationId(CHAIN, address(aapl))));
        d.fundingToken = address(funding);
        d.cumulativeDebitLimit = cumulativeDebitLimit;
        d.validAfter = uint64(T0 - 60);
        d.validUntil = uint64(T0 + 3_600);
        d.generation = 1;
    }

    function _delegation() internal view returns (MandateDelegatedExecutionGate.Delegation memory) {
        return _delegation(10_000e6);
    }

    function _eip712(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", dgate.domainSeparator(), structHash));
    }

    function _sign(uint256 key, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash);
        return abi.encodePacked(r, s, v);
    }

    function _signDelegation(MandateDelegatedExecutionGate.Delegation memory d) internal view returns (bytes memory) {
        return _sign(PRINCIPAL_KEY, _eip712(dgate.delegationDigest(d)));
    }

    function _commitment(Mandate memory m, Candidate memory c, ExecutionTerms memory t)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                dgate.EXECUTION_AUTHORIZATION_TYPEHASH(),
                harness.mandateDigest(m),
                harness.candidateDigest(c),
                t.recipient,
                t.fundingLimit,
                t.deadline,
                keccak256(t.executionData)
            )
        );
    }

    function _signAgent(Mandate memory m, Candidate memory c, ExecutionTerms memory t)
        internal
        view
        returns (bytes memory)
    {
        return _sign(AGENT_KEY, _eip712(_commitment(m, c, t)));
    }

    function _approvalHash(
        MandateDelegatedExecutionGate.Delegation memory d,
        Mandate memory m,
        Candidate memory c,
        ExecutionTerms memory t,
        uint64 nonce
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                dgate.DELEGATED_EXECUTION_APPROVAL_TYPEHASH(),
                dgate.delegationDigest(d),
                harness.mandateDigest(m),
                harness.candidateDigest(c),
                t.recipient,
                t.fundingLimit,
                t.deadline,
                keccak256(t.executionData),
                nonce
            )
        );
    }

    function _signDelegate(
        MandateDelegatedExecutionGate.Delegation memory d,
        Mandate memory m,
        Candidate memory c,
        ExecutionTerms memory t,
        uint64 nonce
    ) internal view returns (bytes memory) {
        return _sign(DELEGATE_KEY, _eip712(_approvalHash(d, m, c, t, nonce)));
    }

    function _execute(
        MandateDelegatedExecutionGate.Delegation memory d,
        Mandate memory m,
        Candidate memory c,
        ExecutionTerms memory t,
        uint64 nonce
    ) internal returns (bytes32, uint256, uint256) {
        return dgate.execute(
            d, _signDelegation(d), m, c, t, _signAgent(m, c, t), nonce, _signDelegate(d, m, c, t, nonce)
        );
    }

    function _expectRevert(
        MandateDelegatedExecutionGate.Delegation memory d,
        Mandate memory m,
        Candidate memory c,
        ExecutionTerms memory t,
        uint64 nonce,
        bytes memory revertData
    ) internal {
        bytes memory ps = _signDelegation(d);
        bytes memory as_ = _signAgent(m, c, t);
        bytes memory ds = _signDelegate(d, m, c, t, nonce);
        vm.expectRevert(revertData);
        dgate.execute(d, ps, m, c, t, as_, nonce, ds);
    }

    function _err(bytes4 selector) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(selector);
    }

    function _keyOf(address token) internal view returns (bytes32) {
        return keccak256(bytes(harness.representationId(CHAIN, token)));
    }

    function _adapterOf(address token) internal view returns (FixtureVenueAdapter) {
        return FixtureVenueAdapter(dgate.marketOf(_keyOf(token)).adapter);
    }

    function _venueOf(address token) internal view returns (FixtureVenue) {
        return FixtureVenue(dgate.fixtureVenueOf(_keyOf(token)));
    }

    function _scriptAdapter(address token) internal returns (ScriptedAdapter a) {
        a = ScriptedAdapter(address(_adapterOf(token)));
        vm.etch(address(a), address(new ScriptedAdapter()).code);
    }
}
