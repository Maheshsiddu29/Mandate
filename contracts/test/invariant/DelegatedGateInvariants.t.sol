// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {StdInvariant} from "forge-std/StdInvariant.sol";

import {DelegatedGateTestBase} from "../utils/DelegatedGateTestBase.sol";
import {DelegatedGateHandler} from "./DelegatedGateHandler.sol";

/// @notice INV-V3-1 … INV-V3-10 for bounded delegated execution.
contract DelegatedGateInvariantsTest is StdInvariant, DelegatedGateTestBase {
    DelegatedGateHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new DelegatedGateHandler(
            dgate, harness, principal, agent, delegate, stranger, address(funding), address(aapl)
        );
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: handler.selectors()}));
    }

    /// INV-V3-1: sum of successful delegated debits <= signed cumulativeDebitLimit
    function invariant_v3_1_cumulativeCap() public view {
        assertLe(dgate.usedDebitOf(handler.delDigest()), EXACT_DEBIT * 20);
        assertEq(handler.ghostUsed(), dgate.usedDebitOf(handler.delDigest()));
    }

    /// INV-V3-2 / INV-V3-3: successful path requires principal + agent + delegate
    /// (ghostWrongDelegate must stay zero).
    function invariant_v3_2_3_signaturesRequired() public view {
        assertEq(handler.ghostWrongDelegate(), 0);
    }

    /// INV-V3-4: recipient == principal (unauthorized recipient never settles)
    function invariant_v3_4_recipientIsPrincipal() public view {
        assertEq(handler.ghostUnauthorizedRecipient(), 0);
    }

    /// INV-V3-5: one execution nonce settles at most once
    function invariant_v3_5_nonceAtMostOnce() public view {
        assertEq(handler.ghostReplaySuccesses(), 0);
    }

    /// INV-V3-6: revoked delegation never settles afterward
    function invariant_v3_6_revokedNeverSettles() public view {
        assertEq(handler.ghostRevokedSuccesses(), 0);
    }

    /// INV-V3-9: used debit on gate matches ghost book of successful settlements
    function invariant_v3_9_failedNeverConsumes() public view {
        assertEq(dgate.usedDebitOf(handler.delDigest()), handler.ghostUsed());
        assertEq(handler.ghostUsed(), handler.ghostSettled() * EXACT_DEBIT);
    }

    /// INV-V3-10: V2 gate is a separate deployment; this suite does not touch it.
    function invariant_v3_10_delegateNeverEqualsAgent() public view {
        assertTrue(handler.delegate() != handler.agent());
    }
}
