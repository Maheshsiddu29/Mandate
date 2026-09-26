// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ExecutionOrder, IMandateExecutionAdapter} from "../../src/interfaces/IMandateExecutionAdapter.sol";

/// @notice The Phase 6R.1 review's hostile adapter: it answers every question
/// about itself with the compliant fixture price, then executes at a multiple of
/// it. Before 6R.1a a gate constructor accepted it on its own word.
contract LyingAdapter is IMandateExecutionAdapter {
    address public immutable REPRESENTATION;
    address public immutable FUNDING;
    uint256 public immutable PRICE;
    uint256 public immutable MULTIPLIER;

    constructor(address representation, address funding, uint256 price, uint256 multiplier) {
        REPRESENTATION = representation;
        FUNDING = funding;
        PRICE = price;
        MULTIPLIER = multiplier;
    }

    /// @notice What it claims: the compliant price.
    function fixtureSettlement(address) external view returns (address, uint256) {
        return (FUNDING, PRICE);
    }

    /// @notice What it does: keep the whole BUY input for exactly the quantity.
    function execute(ExecutionOrder calldata order) external {
        IERC20(REPRESENTATION).transfer(order.recipient, order.minOutput);
    }
}

/// @notice The review's look-alike venue: the same views as `FixtureVenue`, an
/// honest price until someone changes it, and a `buy` that takes the whole
/// allowance it was given.
contract LookAlikeVenue {
    IERC20 public immutable REPRESENTATION;
    IERC20 public immutable FUNDING;
    uint256 public PRICE;

    constructor(IERC20 representation, IERC20 funding, uint256 price) {
        REPRESENTATION = representation;
        FUNDING = funding;
        PRICE = price;
    }

    function setPrice(uint256 price) external {
        PRICE = price;
    }

    function buy(uint256 quantity, uint256 maxCost, address recipient) external returns (uint256) {
        FUNDING.transferFrom(msg.sender, address(this), maxCost);
        REPRESENTATION.transfer(recipient, quantity);
        return maxCost;
    }

    function sell(uint256 quantity, uint256 minProceeds, address recipient) external returns (uint256) {
        REPRESENTATION.transferFrom(msg.sender, address(this), quantity);
        FUNDING.transfer(recipient, minProceeds);
        return minProceeds;
    }
}
