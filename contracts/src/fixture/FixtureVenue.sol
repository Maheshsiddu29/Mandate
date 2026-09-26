// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title FixtureVenue — SETTLEMENT FIXTURE, NOT A MARKET
/// @notice A purpose-built counterparty that exercises the Mandate execution
/// boundary. It is **not** a venue integration and carries **no** real
/// liquidity: it trades one representation against one funding token at a
/// price and fee fixed at deployment, out of whatever inventory it was given.
///
/// It exists because the repository's Robinhood Chain evidence establishes no
/// executable venue interface, liquidity or testnet trading behaviour
/// (docs/robinhood-integration.md, "Limits"). Nothing built on it may be
/// described as a live trade. See docs/execution-gate.md §5.
///
/// Arithmetic is exact and rounds against the trader: BUY cost and every fee
/// round up; SELL proceeds round down.
contract FixtureVenue {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;

    IERC20 public immutable REPRESENTATION;
    IERC20 public immutable FUNDING;
    /// @notice The representation's decimals, as the gate pinned them.
    uint8 public immutable REPRESENTATION_DECIMALS;
    /// @notice The funding token's decimals, as the gate pinned them: the scale of `PRICE`.
    uint8 public immutable FUNDING_DECIMALS;
    /// @notice Funding-token atoms per one whole representation token.
    uint256 public immutable PRICE;
    /// @notice `10 ** REPRESENTATION_DECIMALS`.
    uint256 public immutable REPRESENTATION_UNIT;
    uint16 public immutable FEE_BPS;

    error FixtureInvalidConfig();
    error FixtureCostExceedsMaximum(uint256 cost, uint256 maximum);
    error FixtureProceedsBelowMinimum(uint256 proceeds, uint256 minimum);

    /// @dev The decimals are the ones the gate read and pinned, passed in rather
    /// than read again: a token can answer `decimals()` differently to different
    /// callers, and the venue's units must be the gate's (Phase 6R.1b).
    constructor(
        IERC20 representation,
        IERC20 funding,
        uint8 representationDecimals,
        uint8 fundingDecimals,
        uint256 price,
        uint16 feeBps
    ) {
        if (address(representation) == address(0) || address(funding) == address(0) || price == 0 || feeBps >= BPS) {
            revert FixtureInvalidConfig();
        }
        REPRESENTATION = representation;
        FUNDING = funding;
        REPRESENTATION_DECIMALS = representationDecimals;
        FUNDING_DECIMALS = fundingDecimals;
        PRICE = price;
        REPRESENTATION_UNIT = 10 ** uint256(representationDecimals);
        FEE_BPS = feeBps;
    }

    /// @notice Total funding debit to buy `quantity`, fee included, rounded up.
    function quoteBuy(uint256 quantity) public view returns (uint256 cost) {
        uint256 gross = Math.mulDiv(quantity, PRICE, REPRESENTATION_UNIT, Math.Rounding.Ceil);
        return gross + Math.mulDiv(gross, FEE_BPS, BPS, Math.Rounding.Ceil);
    }

    /// @notice Net funding credit for selling `quantity`, after fee, rounded down.
    function quoteSell(uint256 quantity) public view returns (uint256 proceeds) {
        uint256 gross = Math.mulDiv(quantity, PRICE, REPRESENTATION_UNIT, Math.Rounding.Floor);
        uint256 fee = Math.mulDiv(gross, FEE_BPS, BPS, Math.Rounding.Ceil);
        return gross > fee ? gross - fee : 0;
    }

    /// @notice Deliver exactly `quantity` to `recipient`, pulling the cost from the caller.
    function buy(uint256 quantity, uint256 maxCost, address recipient) external returns (uint256 cost) {
        cost = quoteBuy(quantity);
        if (cost > maxCost) revert FixtureCostExceedsMaximum(cost, maxCost);
        FUNDING.safeTransferFrom(msg.sender, address(this), cost);
        REPRESENTATION.safeTransfer(recipient, quantity);
    }

    /// @notice Take exactly `quantity` from the caller, paying the proceeds to `recipient`.
    function sell(uint256 quantity, uint256 minProceeds, address recipient) external returns (uint256 proceeds) {
        proceeds = quoteSell(quantity);
        if (proceeds < minProceeds) revert FixtureProceedsBelowMinimum(proceeds, minProceeds);
        REPRESENTATION.safeTransferFrom(msg.sender, address(this), quantity);
        FUNDING.safeTransfer(recipient, proceeds);
    }
}
