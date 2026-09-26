// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

/// @title IFixtureSettlement
/// @notice What a labelled-fixture adapter reports about the fixed price its venue
/// settles at, so the gate's constructor can prove it is the price the gate
/// authorizes against.
///
/// @dev A fixture market has two prices: the typed `MarketConfig.fixturePrice`
/// the gate checks candidates against, and the integer the venue actually
/// charges or pays. They are written by different code from different inputs, so
/// nothing but a check makes them the same. The gate reads this once, at
/// construction, and never during execution: settlement is still decided on
/// measured balances alone.
interface IFixtureSettlement {
    /// @param representation The market's representation token.
    /// @return fundingToken The token the venue settles `representation` against.
    /// @return fundingAtomsPerWholeToken Funding-token atoms per one whole
    /// representation token (`10 ** decimals` atoms), before any fee.
    function fixtureSettlement(address representation)
        external
        view
        returns (address fundingToken, uint256 fundingAtomsPerWholeToken);
}
