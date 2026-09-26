// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {StdInvariant} from "forge-std/StdInvariant.sol";

import {GateTestBase} from "../utils/GateTestBase.sol";
import {GateHandler} from "./GateHandler.sol";

/// @notice Stateful invariants of the execution gate (docs/execution-gate.md §10).
contract GateInvariantsTest is StdInvariant, GateTestBase {
    GateHandler internal handler;
    uint256 internal fundingAtStart;
    uint256 internal tokensAtStart;

    function setUp() public override {
        super.setUp();
        handler = new GateHandler(gate, harness, scripted, funding, scriptedToken, principal, agent);
        // The principal's mistake the over-pull behaviour exploits: a direct,
        // standing allowance to an adapter. The gate's debit bound must still hold.
        vm.startPrank(principal);
        funding.approve(address(scripted), type(uint256).max);
        scriptedToken.approve(address(scripted), type(uint256).max);
        vm.stopPrank();
        fundingAtStart = funding.balanceOf(principal);
        tokensAtStart = scriptedToken.balanceOf(principal);
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: handler.selectors()}));
    }

    /// INV-ONCHAIN-1 and -2: a consumed authorization never settles again, so no
    /// single-use authorization settles more than once — including byte-identical replays.
    function invariant_onchain1_2_atMostOneSettlementPerAuthorization() public view {
        for (uint256 i = 0; i < handler.digestCount(); ++i) {
            assertLe(handler.successes(handler.digests(i)), 1);
        }
        assertEq(handler.replaySuccesses(), 0);
    }

    /// INV-ONCHAIN-3: every settlement corresponds to the execution commitment the
    /// agent signed, and that commitment is what the gate recorded.
    function invariant_onchain3_settlementsCarryTheirSignedCommitment() public view {
        for (uint256 i = 0; i < handler.digestCount(); ++i) {
            bytes32 digest = handler.digests(i);
            if (handler.successes(digest) == 1) {
                assertEq(gate.executionCommitmentOf(digest), handler.signedCommitmentOf(digest));
            }
        }
        assertEq(handler.tamperedSuccesses(), 0);
    }

    /// INV-ONCHAIN-4: no BUY ever debits more than its signed MAX_TOTAL_DEBIT —
    /// and, the same bound on the other side, no SELL spends more than its quantity.
    function invariant_onchain4_buyDebitWithinSignedBound() public view {
        assertEq(handler.buyBoundViolations(), 0);
        assertEq(handler.sellDebitViolations(), 0);
    }

    /// INV-ONCHAIN-5: no SELL ever credits less than its signed MIN_TOTAL_CREDIT.
    function invariant_onchain5_sellCreditAboveSignedFloor() public view {
        assertEq(handler.sellFloorViolations(), 0);
    }

    /// INV-ONCHAIN-6: an authorization is recorded as consumed if and only if an
    /// execution of it settled. Every reverted attempt left it unconsumed.
    function invariant_onchain6_revertsNeverConsume() public view {
        for (uint256 i = 0; i < handler.digestCount(); ++i) {
            bytes32 digest = handler.digests(i);
            assertEq(gate.executionCommitmentOf(digest) != bytes32(0), handler.successes(digest) == 1);
        }
    }

    /// INV-ONCHAIN-7: unsupported token, target or venue combinations never settle.
    function invariant_onchain7_unsupportedNeverExecutes() public view {
        assertEq(handler.unsupportedSuccesses(), 0);
    }

    /// INV-ONCHAIN-8 (added): the principal's balances move by exactly the
    /// measured amounts the gate reported, and by nothing else.
    function invariant_onchain8_principalLedgerConserved() public view {
        assertEq(funding.balanceOf(principal), fundingAtStart - handler.buyDebits() + handler.sellCredits());
        assertEq(scriptedToken.balanceOf(principal), tokensAtStart + handler.buyCredits() - handler.sellDebits());
    }

    /// INV-ONCHAIN-9 (added): the gate never holds funds or grants an allowance.
    function invariant_onchain9_gateHoldsNothing() public view {
        assertEq(funding.balanceOf(address(gate)), 0);
        assertEq(scriptedToken.balanceOf(address(gate)), 0);
        assertEq(funding.allowance(address(gate), address(scripted)), 0);
        assertEq(scriptedToken.allowance(address(gate), address(scripted)), 0);
    }

    /// Non-vacuity, deterministically: the handler reaches settlement on both
    /// sides, and every hostile action it has is refused, with every invariant
    /// holding afterwards. A per-run guard would be flaky — a random 64-call run
    /// can legitimately settle nothing — so this is asserted once, exactly.
    function test_handlerReachesSettlementAndEveryInvariantHolds() public {
        for (uint256 i = 0; i < handler.POOL(); ++i) {
            handler.execute(i, 0, i % 2 == 0 ? 0 : type(uint256).max, T0);
        }
        assertEq(handler.settled(), handler.POOL());
        assertGt(handler.buyDebits(), 0);
        assertGt(handler.sellCredits(), 0);
        handler.replayLast();
        for (uint256 f = 0; f < 6; ++f) {
            handler.executeTampered(f, f, 7);
        }
        handler.executeUnsupported(0, address(0xbad), false);
        handler.executeUnsupported(1, address(0), true);
        // A second round finds every authorization consumed.
        for (uint256 i = 0; i < handler.POOL(); ++i) {
            handler.execute(i, 0, 0, T0);
        }
        assertEq(handler.settled(), handler.POOL());

        invariant_onchain1_2_atMostOneSettlementPerAuthorization();
        invariant_onchain3_settlementsCarryTheirSignedCommitment();
        invariant_onchain4_buyDebitWithinSignedBound();
        invariant_onchain5_sellCreditAboveSignedFloor();
        invariant_onchain6_revertsNeverConsume();
        invariant_onchain7_unsupportedNeverExecutes();
        invariant_onchain8_principalLedgerConserved();
        invariant_onchain9_gateHoldsNothing();
    }
}
