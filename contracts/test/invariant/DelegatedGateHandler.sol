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
    Mandate,
    Price,
    SIDE_BUY,
    SYNTHETIC_FORBIDDEN
} from "../../src/MandateTypes.sol";
import {CodecHarness} from "../utils/CodecHarness.sol";

/// @notice Drives V3 delegated executions for invariant checks.
contract DelegatedGateHandler is Test {
    uint256 internal constant CHAIN = 46_630;
    string internal constant CHAIN_ID_STRING = "eip155:46630";
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant PRINCIPAL_KEY = 0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318;
    uint256 internal constant AGENT_KEY = 0x8da4ef21b864d2cc526dbdb2a120bd2874c36c9d0a1fb7f8c63d7f7a8b41de8f;
    uint256 internal constant DELEGATE_KEY = 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;
    uint256 internal constant STRANGER_KEY = 0xa11ce;
    uint256 internal constant EXACT_DEBIT = 2_006e6;

    MandateDelegatedExecutionGate public immutable dgate;
    CodecHarness public immutable harness;
    address public immutable principal;
    address public immutable agent;
    address public immutable delegate;
    address public immutable stranger;
    address public immutable funding;
    address public immutable aapl;

    MandateDelegatedExecutionGate.Delegation public del;
    bytes public principalSig;
    bytes32 public delDigest;

    uint256 public ghostUsed;
    uint256 public ghostSettled;
    uint256 public ghostReplaySuccesses;
    uint256 public ghostUnauthorizedRecipient;
    uint256 public ghostWrongDelegate;
    uint256 public ghostRevokedSuccesses;
    uint256 public nextNonce = 1;
    bool public revoked;
    uint64[] public settledNonces;

    constructor(
        MandateDelegatedExecutionGate dgate_,
        CodecHarness harness_,
        address principal_,
        address agent_,
        address delegate_,
        address stranger_,
        address funding_,
        address aapl_
    ) {
        dgate = dgate_;
        harness = harness_;
        principal = principal_;
        agent = agent_;
        delegate = delegate_;
        stranger = stranger_;
        funding = funding_;
        aapl = aapl_;

        del = MandateDelegatedExecutionGate.Delegation({
            portfolioMandateDigest: bytes32(uint256(0xb01)),
            initialAllocationDigest: bytes32(uint256(0xa11)),
            sessionDigest: bytes32(uint256(0x5e5)),
            principal: principal_,
            delegate: delegate_,
            agent: agent_,
            representationIdHash: keccak256(bytes(harness_.representationId(CHAIN, aapl_))),
            fundingToken: funding_,
            cumulativeDebitLimit: EXACT_DEBIT * 20,
            validAfter: uint64(T0 - 60),
            validUntil: uint64(T0 + 3_600),
            generation: 1
        });
        delDigest = dgate_.delegationDigest(del);
        principalSig = _sign(PRINCIPAL_KEY, _eip712(delDigest));
    }

    function selectors() external pure returns (bytes4[] memory out) {
        out = new bytes4[](5);
        out[0] = this.honestExecute.selector;
        out[1] = this.replayNonce.selector;
        out[2] = this.badRecipient.selector;
        out[3] = this.badDelegate.selector;
        out[4] = this.revokeThenExecute.selector;
    }

    function honestExecute() external {
        if (ghostUsed + EXACT_DEBIT > del.cumulativeDebitLimit) return;
        uint64 nonce = uint64(nextNonce++);
        Mandate memory m = _mandate(nonce);
        Candidate memory c = _candidate(nonce);
        ExecutionTerms memory t = _terms();
        try dgate.execute(del, principalSig, m, c, t, _signAgent(m, c, t), nonce, _signDelegate(m, c, t, nonce))
        returns (bytes32, uint256 debit, uint256) {
            ghostUsed += debit;
            ghostSettled += 1;
            settledNonces.push(nonce);
        } catch {}
    }

    function replayNonce(uint64 which) external {
        if (settledNonces.length == 0) return;
        uint64 nonce = settledNonces[bound(which, 0, settledNonces.length - 1)];
        Mandate memory m = _mandate(nonce);
        Candidate memory c = _candidate(nonce);
        ExecutionTerms memory t = _terms();
        try dgate.execute(del, principalSig, m, c, t, _signAgent(m, c, t), nonce, _signDelegate(m, c, t, nonce)) {
            ghostReplaySuccesses += 1;
        } catch {}
    }

    function badRecipient() external {
        uint64 nonce = uint64(nextNonce++);
        Mandate memory m = _mandate(nonce);
        Candidate memory c = _candidate(nonce);
        ExecutionTerms memory t = _terms();
        t.recipient = stranger;
        try dgate.execute(del, principalSig, m, c, t, _signAgent(m, c, t), nonce, _signDelegate(m, c, t, nonce)) {
            ghostUnauthorizedRecipient += 1;
        } catch {}
    }

    function badDelegate() external {
        uint64 nonce = uint64(nextNonce++);
        Mandate memory m = _mandate(nonce);
        Candidate memory c = _candidate(nonce);
        ExecutionTerms memory t = _terms();
        bytes memory bad = _sign(STRANGER_KEY, _eip712(_approvalHash(m, c, t, nonce)));
        try dgate.execute(del, principalSig, m, c, t, _signAgent(m, c, t), nonce, bad) {
            ghostWrongDelegate += 1;
        } catch {}
    }

    function revokeThenExecute() external {
        if (!revoked) {
            vm.prank(principal);
            dgate.revokeDelegation(del);
            revoked = true;
        }
        uint64 nonce = uint64(nextNonce++);
        Mandate memory m = _mandate(nonce);
        Candidate memory c = _candidate(nonce);
        ExecutionTerms memory t = _terms();
        try dgate.execute(del, principalSig, m, c, t, _signAgent(m, c, t), nonce, _signDelegate(m, c, t, nonce)) {
            ghostRevokedSuccesses += 1;
        } catch {}
    }

    function _mandate(uint64 nonce) internal view returns (Mandate memory m) {
        m.version = 2;
        m.mandateId = bytes32(uint256(nonce));
        m.nonce = nonce;
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

    function _candidate(uint64 nonce) internal view returns (Candidate memory c) {
        c.version = 3;
        c.representationId = harness.representationId(CHAIN, aapl);
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
        c.evaluationStateDigest = bytes32(uint256(nonce));
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

    function _eip712(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", dgate.domainSeparator(), structHash));
    }

    function _sign(uint256 key, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash);
        return abi.encodePacked(r, s, v);
    }

    function _signAgent(Mandate memory m, Candidate memory c, ExecutionTerms memory t)
        internal
        view
        returns (bytes memory)
    {
        bytes32 commitment = keccak256(
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
        return _sign(AGENT_KEY, _eip712(commitment));
    }

    function _approvalHash(Mandate memory m, Candidate memory c, ExecutionTerms memory t, uint64 nonce)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                dgate.DELEGATED_EXECUTION_APPROVAL_TYPEHASH(),
                delDigest,
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

    function _signDelegate(Mandate memory m, Candidate memory c, ExecutionTerms memory t, uint64 nonce)
        internal
        view
        returns (bytes memory)
    {
        return _sign(DELEGATE_KEY, _eip712(_approvalHash(m, c, t, nonce)));
    }
}
