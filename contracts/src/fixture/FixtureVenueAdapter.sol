// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {SIDE_BUY, SIDE_SELL} from "../MandateTypes.sol";
import {ExecutionOrder, IMandateExecutionAdapter} from "../interfaces/IMandateExecutionAdapter.sol";
import {FixtureVenue} from "./FixtureVenue.sol";

/// @title FixtureVenueAdapter — adapter for the SETTLEMENT FIXTURE
/// @notice The supported Phase 6 adapter. Its venue is `FixtureVenue`, which is a
/// labelled test counterparty, not a market (see that contract). Since Phase
/// 6R.1a the gate's constructor creates both, wired to each other and to the gate;
/// nothing asks this contract what it or its venue will do.
///
/// The adapter is written the way a real venue adapter must be, because that is
/// the part a later phase reuses:
///
/// - it accepts calls only from its one gate;
/// - it refuses any order whose tokens are not its venue's pair;
/// - it grants the venue an allowance of exactly the order's input and resets
///   it to zero in the same call, so no standing allowance survives an
///   execution (docs/execution-gate.md §8);
/// - it returns unspent input to `refundTo` and holds nothing afterwards.
///
/// None of this is what makes execution safe — the gate's settlement check is.
/// It is what keeps an adapter defect from becoming anyone's standing authority.
contract FixtureVenueAdapter is IMandateExecutionAdapter {
    using SafeERC20 for IERC20;

    address public immutable GATE;
    FixtureVenue public immutable VENUE;

    error InvalidConfig();
    error OnlyGate();
    error UnsupportedOrder();
    error UnsupportedRouteData();

    constructor(address gate, FixtureVenue venue) {
        if (gate == address(0) || address(venue) == address(0)) revert InvalidConfig();
        GATE = gate;
        VENUE = venue;
    }

    /// @inheritdoc IMandateExecutionAdapter
    function execute(ExecutionOrder calldata order) external {
        if (msg.sender != GATE) revert OnlyGate();
        // The fixture has exactly one route, so any route data is a request for
        // something this adapter cannot do.
        if (order.executionData.length != 0) revert UnsupportedRouteData();

        address representation = address(VENUE.REPRESENTATION());
        address funding = address(VENUE.FUNDING());
        bool isBuy = order.side == SIDE_BUY && order.inputToken == funding && order.outputToken == representation;
        bool isSell = order.side == SIDE_SELL && order.inputToken == representation && order.outputToken == funding;
        if (!isBuy && !isSell) revert UnsupportedOrder();

        IERC20 input = IERC20(order.inputToken);
        uint256 heldBefore = input.balanceOf(address(this));

        input.forceApprove(address(VENUE), order.inputAmount);
        // The venue's returned cost or proceeds are deliberately unused: this
        // adapter measures what left its balance, and the gate measures the
        // principal's. Neither trusts a counterparty's report (docs §14, S-3).
        if (isBuy) {
            // slither-disable-next-line unused-return
            VENUE.buy(order.minOutput, order.inputAmount, order.recipient);
        } else {
            // slither-disable-next-line unused-return
            VENUE.sell(order.inputAmount, order.minOutput, order.recipient);
        }
        input.forceApprove(address(VENUE), 0);

        // The venue can spend at most the approved input, so this cannot underflow.
        uint256 spent = heldBefore - input.balanceOf(address(this));
        uint256 unspent = order.inputAmount - spent;
        if (unspent != 0) input.safeTransfer(order.refundTo, unspent);
    }
}
