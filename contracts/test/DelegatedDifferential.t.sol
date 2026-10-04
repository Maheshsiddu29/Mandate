// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

import {MandateDelegatedExecutionGate} from "../src/MandateDelegatedExecutionGate.sol";
import {MandateExecutionGate} from "../src/MandateExecutionGate.sol";
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
} from "../src/MandateTypes.sol";
import {FixtureVenue} from "../src/fixture/FixtureVenue.sol";
import {MockERC20} from "./mocks/MockTokens.sol";
import {CodecHarness} from "./utils/CodecHarness.sol";

/// @notice One equivalent valid BUY: V2 and V3 produce the same economic outcome.
contract DelegatedDifferentialTest is Test {
    uint256 internal constant CHAIN = 46_630;
    string internal constant CHAIN_ID_STRING = "eip155:46630";
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant PRINCIPAL_KEY = 0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318;
    uint256 internal constant AGENT_KEY = 0x8da4ef21b864d2cc526dbdb2a120bd2874c36c9d0a1fb7f8c63d7f7a8b41de8f;
    uint256 internal constant DELEGATE_KEY = 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;
    uint256 internal constant EXACT_DEBIT = 2_006e6;

    address internal principal;
    address internal agent;
    address internal delegate;
    CodecHarness internal harness;
    MockERC20 internal funding;
    MockERC20 internal aapl;
    MandateExecutionGate internal v2;
    MandateDelegatedExecutionGate internal v3;

    function setUp() public {
        vm.chainId(CHAIN);
        vm.warp(T0);
        principal = vm.addr(PRINCIPAL_KEY);
        agent = vm.addr(AGENT_KEY);
        delegate = vm.addr(DELEGATE_KEY);
        harness = new CodecHarness();
        funding = new MockERC20("fUSDC", "fUSDC", 6);
        aapl = new MockERC20("fAAPL", "fAAPL", 18);

        MarketConfig[] memory markets = new MarketConfig[](1);
        markets[0] = MarketConfig({
            representation: address(aapl),
            fundingToken: address(funding),
            canonicalAsset: CanonicalAsset({assetClass: "equity", idScheme: "isin", value: "US0378331005"}),
            issuer: "issuer.alpha",
            venue: "venue.fixture",
            quantityUnit: "TOKEN",
            settlementUnit: "USD",
            synthetic: false,
            classification: MARKET_FIXTURE,
            fixturePrice: Price({numeratorUnit: "USD", denominatorUnit: "TOKEN", decimals: 6, atoms: 200e6}),
            fixtureFeeBps: 30
        });
        v2 = new MandateExecutionGate(markets);
        v3 = new MandateDelegatedExecutionGate(markets);

        address v2Venue = v2.fixtureVenueOf(keccak256(bytes(harness.representationId(CHAIN, address(aapl)))));
        address v3Venue = v3.fixtureVenueOf(keccak256(bytes(harness.representationId(CHAIN, address(aapl)))));
        aapl.mint(v2Venue, 1_000_000e18);
        aapl.mint(v3Venue, 1_000_000e18);
        funding.mint(v2Venue, 1_000_000_000e6);
        funding.mint(v3Venue, 1_000_000_000e6);
        funding.mint(principal, 1_000_000e6);
        aapl.mint(principal, 1_000e18);

        vm.startPrank(principal);
        funding.approve(address(v2), type(uint256).max);
        funding.approve(address(v3), type(uint256).max);
        aapl.approve(address(v2), type(uint256).max);
        aapl.approve(address(v3), type(uint256).max);
        vm.stopPrank();
    }

    function _mandate() internal view returns (Mandate memory m) {
        m.version = 2;
        m.mandateId = bytes32(uint256(0x11));
        m.nonce = 1;
        m.principal = principal;
        m.agent = agent;
        m.canonicalAsset = CanonicalAsset({assetClass: "equity", idScheme: "isin", value: "US0378331005"});
        m.side = SIDE_BUY;
        m.maxNotional = Amount({unit: "USD", decimals: 18, atoms: 2_000e18});
        m.economicLimit = Amount({unit: "USD", decimals: 18, atoms: 2_010e18});
        m.maxDeviationBps = 40;
        m.syntheticPolicy = SYNTHETIC_FORBIDDEN;
        m.allowedIssuers = _one("issuer.alpha");
        m.allowedChains = _one(CHAIN_ID_STRING);
        m.allowedVenues = _one("venue.fixture");
        m.requiredCorporateActionEpoch = 1;
        m.maxPriceAgeSeconds = 60;
        m.maxCorporateActionAgeSeconds = 3_600;
        m.haltPolicy = HALT_FORBID_WHEN_HALTED;
        m.createdAtUnixSeconds = int64(int256(T0) - 100);
        m.notBeforeUnixSeconds = int64(int256(T0) - 60);
        m.expiresAtUnixSeconds = int64(int256(T0) + 3_600);
    }

    function _candidate() internal view returns (Candidate memory c) {
        c.version = 3;
        c.representationId = harness.representationId(CHAIN, address(aapl));
        c.canonicalAsset = CanonicalAsset({assetClass: "equity", idScheme: "isin", value: "US0378331005"});
        c.issuer = "issuer.alpha";
        c.chain = CHAIN_ID_STRING;
        c.venue = "venue.fixture";
        c.side = SIDE_BUY;
        c.agent = agent;
        c.quantity = Amount({unit: "TOKEN", decimals: 18, atoms: 10e18});
        c.executionPrice = Price({numeratorUnit: "USD", denominatorUnit: "TOKEN", decimals: 18, atoms: 200e18});
        c.notional = Amount({unit: "USD", decimals: 18, atoms: 2_000e18});
        c.feeTotal = Amount({unit: "USD", decimals: 18, atoms: 6e18});
        c.evaluationStateId = "state.fixture.0001";
        c.evaluationStateDigest = bytes32(uint256(0xe1));
        c.registrySnapshotDigest = bytes32(uint256(0xa5));
        c.corporateActionEpoch = 1;
    }

    function _terms() internal view returns (ExecutionTerms memory) {
        return ExecutionTerms({
            recipient: principal, fundingLimit: EXACT_DEBIT, deadline: uint64(T0 + 300), executionData: ""
        });
    }

    function _one(string memory a) internal pure returns (string[] memory out) {
        out = new string[](1);
        out[0] = a;
    }

    function _sign(uint256 key, bytes32 domain, bytes32 structHash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, keccak256(abi.encodePacked(hex"1901", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function test_differential_v2AndV3SameEconomicOutcome() public {
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();

        uint256 fundingBefore = funding.balanceOf(principal);
        uint256 aaplBefore = aapl.balanceOf(principal);

        // --- V2 ---
        bytes32 mAuth = keccak256(abi.encode(v2.MANDATE_AUTHORIZATION_TYPEHASH(), harness.mandateDigest(m)));
        bytes32 commitment = keccak256(
            abi.encode(
                v2.EXECUTION_AUTHORIZATION_TYPEHASH(),
                harness.mandateDigest(m),
                harness.candidateDigest(c),
                t.recipient,
                t.fundingLimit,
                t.deadline,
                keccak256(t.executionData)
            )
        );
        (bytes32 v2Commitment, uint256 v2Debit, uint256 v2Credit) = v2.execute(
            m,
            _sign(PRINCIPAL_KEY, v2.domainSeparator(), mAuth),
            c,
            t,
            _sign(AGENT_KEY, v2.domainSeparator(), commitment)
        );

        assertEq(v2Debit, EXACT_DEBIT);
        assertEq(v2Credit, 10e18);
        assertEq(funding.balanceOf(principal), fundingBefore - EXACT_DEBIT);
        assertEq(aapl.balanceOf(principal), aaplBefore + 10e18);
        assertTrue(v2.executionCommitmentOf(harness.mandateDigest(m)) == v2Commitment);
        // V2: mandate consumed.
        bytes memory v2Principal = _sign(PRINCIPAL_KEY, v2.domainSeparator(), mAuth);
        bytes memory v2Agent = _sign(AGENT_KEY, v2.domainSeparator(), commitment);
        vm.expectRevert(MandateExecutionGate.MandateAlreadyConsumed.selector);
        v2.execute(m, v2Principal, c, t, v2Agent);

        // Reset principal balances for a clean V3 comparison of deltas.
        // (V2 already moved funds; mint the debit back and burn the credit.)
        funding.mint(principal, EXACT_DEBIT);
        vm.prank(principal);
        aapl.transfer(address(0xdead), 10e18);

        uint256 fundingBeforeV3 = funding.balanceOf(principal);
        uint256 aaplBeforeV3 = aapl.balanceOf(principal);

        MandateDelegatedExecutionGate.Delegation memory d = MandateDelegatedExecutionGate.Delegation({
            portfolioMandateDigest: bytes32(uint256(0xb01)),
            initialAllocationDigest: bytes32(uint256(0xa11)),
            sessionDigest: bytes32(uint256(0x5e5)),
            principal: principal,
            delegate: delegate,
            agent: agent,
            representationIdHash: keccak256(bytes(harness.representationId(CHAIN, address(aapl)))),
            fundingToken: address(funding),
            cumulativeDebitLimit: 100_000e6,
            validAfter: uint64(T0 - 60),
            validUntil: uint64(T0 + 3_600),
            generation: 1
        });

        // Fresh per-execution mandate id so digests differ; economics identical.
        Mandate memory m3 = m;
        m3.mandateId = bytes32(uint256(0x33));
        Candidate memory c3 = c;
        c3.evaluationStateDigest = bytes32(uint256(0xe3));

        bytes32 delDigest = v3.delegationDigest(d);
        bytes32 agentCommitment = keccak256(
            abi.encode(
                v3.EXECUTION_AUTHORIZATION_TYPEHASH(),
                harness.mandateDigest(m3),
                harness.candidateDigest(c3),
                t.recipient,
                t.fundingLimit,
                t.deadline,
                keccak256(t.executionData)
            )
        );
        bytes32 approval = keccak256(
            abi.encode(
                v3.DELEGATED_EXECUTION_APPROVAL_TYPEHASH(),
                delDigest,
                harness.mandateDigest(m3),
                harness.candidateDigest(c3),
                t.recipient,
                t.fundingLimit,
                t.deadline,
                keccak256(t.executionData),
                uint64(1)
            )
        );

        (, uint256 v3Debit, uint256 v3Credit) = v3.execute(
            d,
            _sign(PRINCIPAL_KEY, v3.domainSeparator(), delDigest),
            m3,
            c3,
            t,
            _sign(AGENT_KEY, v3.domainSeparator(), agentCommitment),
            1,
            _sign(DELEGATE_KEY, v3.domainSeparator(), approval)
        );

        assertEq(v3Debit, v2Debit);
        assertEq(v3Credit, v2Credit);
        assertEq(v3Debit, EXACT_DEBIT);
        assertEq(v3Credit, 10e18);
        assertEq(funding.balanceOf(principal), fundingBeforeV3 - EXACT_DEBIT);
        assertEq(aapl.balanceOf(principal), aaplBeforeV3 + 10e18);

        // V3: principal signature reusable; nonce consumed; capacity reduced.
        assertTrue(v3.nonceUsed(delDigest, 1));
        assertEq(v3.usedDebitOf(delDigest), EXACT_DEBIT);
        assertFalse(v3.isRevoked(delDigest));

        // Second nonce under same principal delegation succeeds.
        Mandate memory m4 = m3;
        m4.nonce = 2;
        m4.mandateId = bytes32(uint256(0x44));
        Candidate memory c4 = c3;
        c4.evaluationStateDigest = bytes32(uint256(0xe4));
        bytes32 agentCommitment2 = keccak256(
            abi.encode(
                v3.EXECUTION_AUTHORIZATION_TYPEHASH(),
                harness.mandateDigest(m4),
                harness.candidateDigest(c4),
                t.recipient,
                t.fundingLimit,
                t.deadline,
                keccak256(t.executionData)
            )
        );
        bytes32 approval2 = keccak256(
            abi.encode(
                v3.DELEGATED_EXECUTION_APPROVAL_TYPEHASH(),
                delDigest,
                harness.mandateDigest(m4),
                harness.candidateDigest(c4),
                t.recipient,
                t.fundingLimit,
                t.deadline,
                keccak256(t.executionData),
                uint64(2)
            )
        );
        (, uint256 v3Debit2,) = v3.execute(
            d,
            _sign(PRINCIPAL_KEY, v3.domainSeparator(), delDigest),
            m4,
            c4,
            t,
            _sign(AGENT_KEY, v3.domainSeparator(), agentCommitment2),
            2,
            _sign(DELEGATE_KEY, v3.domainSeparator(), approval2)
        );
        assertEq(v3Debit2, EXACT_DEBIT);
        assertEq(v3.usedDebitOf(delDigest), EXACT_DEBIT * 2);
    }

    function test_v2DomainRemainsVersion1() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Mandate"),
                keccak256("1"),
                CHAIN,
                address(v2)
            )
        );
        assertEq(v2.domainSeparator(), expected);
    }
}
