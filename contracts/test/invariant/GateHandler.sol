// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {MandateExecutionGate} from "../../src/MandateExecutionGate.sol";
import {Candidate, ExecutionTerms, Mandate, SIDE_BUY, SIDE_SELL} from "../../src/MandateTypes.sol";
import {MockERC20} from "../mocks/MockTokens.sol";
import {ScriptedAdapter} from "../mocks/ScriptedAdapter.sol";
import {CodecHarness} from "../utils/CodecHarness.sol";
import {GateTestBase} from "../utils/GateTestBase.sol";

/// @notice Drives the gate through honest and hostile sequences over a fixed pool
/// of single-use authorizations, and keeps ghost books the invariants check.
///
/// Inherits the world builders from `GateTestBase` and is pointed at the test's
/// deployment; only the functions named in `selectors()` are fuzzed.
contract GateHandler is GateTestBase {
    uint256 public constant POOL = 24;
    uint256 public constant BUY_BOUND = 2_010e6; // floor of the signed 2010 USD MAX_TOTAL_DEBIT
    uint256 public constant SELL_FLOOR = 1_990e6; // ceil of the signed 1990 USD MIN_TOTAL_CREDIT

    // Ghost books.
    mapping(bytes32 digest => uint256) public successes;
    mapping(bytes32 digest => bytes32) public signedCommitmentOf;
    bytes32[] public digests;
    uint256 public buyDebits;
    uint256 public buyCredits;
    uint256 public sellDebits;
    uint256 public sellCredits;
    uint256 public buyBoundViolations;
    uint256 public sellFloorViolations;
    uint256 public sellDebitViolations;
    uint256 public tamperedSuccesses;
    uint256 public unsupportedSuccesses;
    uint256 public replaySuccesses;
    uint256 public calls;
    uint256 public settled;

    bytes internal _lastPayload;

    constructor(
        MandateExecutionGate gate_,
        CodecHarness harness_,
        ScriptedAdapter scripted_,
        MockERC20 funding_,
        MockERC20 token_,
        address principal_,
        address agent_
    ) {
        gate = gate_;
        harness = harness_;
        scripted = scripted_;
        funding = funding_;
        scriptedToken = token_;
        principal = principal_;
        agent = agent_;
        for (uint256 i = 0; i < POOL; ++i) {
            digests.push(harness.mandateDigest(_poolMandate(i)));
        }
    }

    function selectors() external pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = this.execute.selector;
        s[1] = this.executeTampered.selector;
        s[2] = this.executeUnsupported.selector;
        s[3] = this.replayLast.selector;
    }

    function digestCount() external view returns (uint256) {
        return digests.length;
    }

    function _poolMandate(uint256 i) internal view returns (Mandate memory m) {
        m = i % 2 == 0 ? _mandate() : _sellMandate();
        m.nonce = uint64(i + 1);
    }

    function _poolTerms(uint256 i, uint256 amountSeed) internal view returns (ExecutionTerms memory t) {
        t = _terms();
        // Straddle the signed bound on both sides so both refusals and settlements occur.
        t.fundingLimit = i % 2 == 0
            ? bound(amountSeed, BUY_BOUND - 10e6, BUY_BOUND + 5)
            : bound(amountSeed, SELL_FLOOR - 5, SELL_FLOOR + 10e6);
        t.deadline = uint64(T0 + 3_000);
    }

    function _script(uint256 behavior, uint256 i, ExecutionTerms memory t, uint256 quantity) internal {
        ScriptedAdapter.Mode mode = ScriptedAdapter.Mode.SCRIPTED;
        bool isBuy = i % 2 == 0;
        uint256 minOut = isBuy ? quantity : t.fundingLimit;
        uint256 deliver = minOut;
        uint256 refund = isBuy ? t.fundingLimit / 1_000 : 0;
        address deliverTo = address(0);
        uint256 extraPull = 0;
        uint256 b = behavior % 7;
        if (b == 1) {
            deliver = minOut - 1; // under-deliver
        } else if (b == 2) {
            refund = isBuy ? t.fundingLimit : quantity / 2; // over-refund / partial fill
        } else if (b == 3) {
            deliverTo = address(0xdead); // redirect
        } else if (b == 4) {
            mode = ScriptedAdapter.Mode.REVERT;
        } else if (b == 5) {
            mode = ScriptedAdapter.Mode.RETURN_GARBAGE;
        } else if (b == 6) {
            // Over-pull through an allowance the principal granted the adapter
            // directly — a principal mistake the gate must still bound.
            mode = ScriptedAdapter.Mode.PULL_FROM_PRINCIPAL;
            refund = 0;
            extraPull = 1 + behavior % (isBuy ? 20e6 : 1e18);
        }
        scripted.setScript(ScriptedAdapter.Script(mode, deliver, refund, deliverTo, address(0), "", false, extraPull));
    }

    function _submit(Mandate memory m, bytes memory ps, Candidate memory c, ExecutionTerms memory t, bytes memory as_)
        internal
        returns (bool ok, uint256 debit, uint256 credit)
    {
        calls += 1;
        // The invariant runner resets the block environment between calls; the
        // deployment chain is part of the world, not something the fuzzer varies.
        vm.chainId(CHAIN);
        try gate.execute(m, ps, c, t, as_) returns (bytes32, uint256 d, uint256 k) {
            return (true, d, k);
        } catch {
            return (false, 0, 0);
        }
    }

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------

    function execute(uint256 index, uint256 behavior, uint256 amountSeed, uint256 timeSeed) external {
        uint256 i = index % POOL;
        vm.warp(bound(timeSeed, T0 - 100, T0 + 4_000));
        Mandate memory m = _poolMandate(i);
        Candidate memory c = _scriptedCandidate(i % 2 == 0 ? SIDE_BUY : SIDE_SELL);
        ExecutionTerms memory t = _poolTerms(i, amountSeed);
        _script(behavior, i, t, c.quantity.atoms);
        bytes memory ps = _signMandate(m);
        bytes memory as_ = _signExecution(m, c, t);

        (bool ok, uint256 debit, uint256 credit) = _submit(m, ps, c, t, as_);
        if (!ok) return;
        bytes32 digest = harness.mandateDigest(m);
        successes[digest] += 1;
        signedCommitmentOf[digest] = _commitment(m, c, t);
        settled += 1;
        _lastPayload = abi.encodeCall(gate.execute, (m, ps, c, t, as_));
        if (i % 2 == 0) {
            buyDebits += debit;
            buyCredits += credit;
            if (debit > BUY_BOUND) buyBoundViolations += 1;
        } else {
            sellDebits += debit;
            sellCredits += credit;
            if (credit < SELL_FLOOR) sellFloorViolations += 1;
            if (debit > c.quantity.atoms) sellDebitViolations += 1;
        }
    }

    /// Signs honestly, then changes one committed field. Must never settle.
    function executeTampered(uint256 index, uint256 field, uint256 value) external {
        uint256 i = index % POOL;
        Mandate memory m = _poolMandate(i);
        Candidate memory c = _scriptedCandidate(i % 2 == 0 ? SIDE_BUY : SIDE_SELL);
        ExecutionTerms memory t = _poolTerms(i, value);
        _script(0, i, t, c.quantity.atoms);
        bytes memory ps = _signMandate(m);
        bytes memory as_ = _signExecution(m, c, t);
        uint256 f = field % 6;
        if (f == 0) m.economicLimit.atoms += 1 + value % 1e24;
        else if (f == 1) m.side = m.side == SIDE_BUY ? SIDE_SELL : SIDE_BUY;
        else if (f == 2) c.quantity.atoms += 1 + value % 1e24;
        else if (f == 3) t.recipient = address(uint160(uint256(keccak256(abi.encode(value)))));
        else if (f == 4) t.fundingLimit = i % 2 == 0 ? t.fundingLimit + 1 : t.fundingLimit - 1;
        else t.executionData = abi.encode(value);
        (bool ok,,) = _submit(m, ps, c, t, as_);
        if (ok) tamperedSuccesses += 1;
    }

    /// Fully signed, but for a token that is not a supported market or with the
    /// scripted token under the wrong venue. Must never settle.
    function executeUnsupported(uint256 index, address token, bool wrongVenue) external {
        uint256 i = index % POOL;
        Mandate memory m = _poolMandate(i);
        Candidate memory c = _scriptedCandidate(i % 2 == 0 ? SIDE_BUY : SIDE_SELL);
        if (wrongVenue) {
            c.venue = "venue.fixture";
        } else {
            if (token == address(scriptedToken)) token = address(0xbad);
            c.representationId = harness.representationId(CHAIN, token);
        }
        ExecutionTerms memory t = _poolTerms(i, 0);
        _script(0, i, t, c.quantity.atoms);
        (bool ok,,) = _submit(m, _signMandate(m), c, t, _signExecution(m, c, t));
        if (ok) unsupportedSuccesses += 1;
    }

    /// Byte-identical resubmission of the last settled execution.
    function replayLast() external {
        if (_lastPayload.length == 0) return;
        calls += 1;
        vm.chainId(CHAIN);
        (bool ok,) = address(gate).call(_lastPayload);
        if (ok) replaySuccesses += 1;
    }
}
