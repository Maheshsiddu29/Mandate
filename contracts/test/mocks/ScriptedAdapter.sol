// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ExecutionOrder, IMandateExecutionAdapter} from "../../src/interfaces/IMandateExecutionAdapter.sol";

/// @notice An adapter that does exactly what its script says, whatever the order
/// asks. It models every adapter or venue the gate must not trust: one that
/// under-delivers, over-refunds, delivers elsewhere, reverts, lies in its return
/// data, burns gas, or re-enters the gate.
///
/// It holds its own inventory of both tokens, so a script can deliver more or
/// less than a real venue would.
///
/// Tests etch it over a gate-created fixture adapter (`GateTestBase._scriptAdapter`):
/// a test cheat modelling the code at that address misbehaving, which is the
/// untrusted-adapter case the gate's measured settlement exists for.
contract ScriptedAdapter is IMandateExecutionAdapter {
    enum Mode {
        SCRIPTED,
        REVERT,
        RETURN_GARBAGE,
        REENTER,
        BURN_GAS,
        PULL_FROM_PRINCIPAL,
        LARGE_RETURN,
        LARGE_REVERT
    }

    struct Script {
        Mode mode;
        /// @dev Output-token atoms to deliver.
        uint256 deliver;
        /// @dev Input-token atoms to send back to `refundTo`.
        uint256 refund;
        /// @dev Zero means `order.recipient`.
        address deliverTo;
        /// @dev REENTER: the call to make; PULL_FROM_PRINCIPAL: unused.
        address reentryTarget;
        bytes reentryPayload;
        /// @dev REENTER: revert with the inner failure instead of swallowing it.
        bool bubbleReentry;
        /// @dev PULL_FROM_PRINCIPAL: extra input to pull via an allowance the
        /// principal (mis)granted this adapter directly.
        uint256 extraPull;
    }

    error ScriptedRevert();

    Script private _script;
    bool public reentrySucceeded;
    bytes public reentryResult;
    uint256 public calls;
    ExecutionOrder private _lastOrder;

    function setScript(Script calldata script) external {
        _script = script;
    }

    function lastOrder() external view returns (ExecutionOrder memory) {
        return _lastOrder;
    }

    function execute(ExecutionOrder calldata order) external {
        calls += 1;
        _lastOrder = order;
        Script memory s = _script;

        if (s.mode == Mode.REVERT) revert ScriptedRevert();
        if (s.mode == Mode.BURN_GAS) {
            while (true) {
                calls += 1;
            }
        }
        if (s.mode == Mode.REENTER) {
            (reentrySucceeded, reentryResult) = s.reentryTarget.call(s.reentryPayload);
            if (!reentrySucceeded && s.bubbleReentry) {
                bytes memory reason = reentryResult;
                assembly ("memory-safe") {
                    revert(add(reason, 0x20), mload(reason))
                }
            }
        }
        if (s.mode == Mode.PULL_FROM_PRINCIPAL) {
            IERC20(order.inputToken).transferFrom(order.refundTo, address(this), s.extraPull);
        }

        if (s.deliver != 0) {
            IERC20(order.outputToken).transfer(s.deliverTo == address(0) ? order.recipient : s.deliverTo, s.deliver);
        }
        if (s.refund != 0) IERC20(order.inputToken).transfer(order.refundTo, s.refund);

        if (s.mode == Mode.LARGE_REVERT) {
            bytes memory data = new bytes(65_536);
            assembly ("memory-safe") {
                revert(add(data, 0x20), mload(data))
            }
        }

        if (s.mode == Mode.LARGE_RETURN) {
            bytes memory data = new bytes(65_536);
            assembly ("memory-safe") {
                return(add(data, 0x20), mload(data))
            }
        }

        if (s.mode == Mode.RETURN_GARBAGE) {
            // Claims a gigantic fill in return data the gate never reads.
            assembly ("memory-safe") {
                mstore(0x00, not(0))
                mstore(0x20, not(0))
                return(0x00, 0x40)
            }
        }
    }
}
