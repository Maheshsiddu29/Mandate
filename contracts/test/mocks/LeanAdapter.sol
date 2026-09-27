// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ExecutionOrder, IMandateExecutionAdapter} from "../../src/interfaces/IMandateExecutionAdapter.sol";

/// @notice An honest BUY adapter that does nothing but fill: it delivers
/// `minOutput` from inventory and refunds a fixed amount. Unlike the scripted
/// test double it records nothing, so the measured gas is the gate's plus the
/// least an adapter must spend, not the double's bookkeeping of 4 KiB of route
/// data.
contract LeanAdapter is IMandateExecutionAdapter {
    uint256 internal immutable REFUND;

    constructor(uint256 refund) {
        REFUND = refund;
    }

    function execute(ExecutionOrder calldata order) external {
        require(IERC20(order.outputToken).transfer(order.recipient, order.minOutput));
        require(IERC20(order.inputToken).transfer(order.refundTo, REFUND));
    }
}
