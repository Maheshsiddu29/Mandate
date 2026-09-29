// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MandateDemoToken — LABELLED TESTNET DEMO FIXTURE
/// @notice NOT a Robinhood Stock Token, NOT a stablecoin, NOT redeemable for
/// anything. It exists so the Phase 7E.3 Robinhood Chain testnet demonstration
/// has an asset and a funding token that satisfy the Phase 6 vetted-token policy
/// (docs/execution-gate.md §13): a standard boolean-return ERC-20 with no owner,
/// no mint after construction, no burn, no pause, no fee, no rebase and no proxy.
///
/// The Robinhood testnet tokens that do exist were rejected for this role: the
/// testnet Stock Token lookalikes and Paxos's testnet USDG are upgradeable
/// proxies, which the frozen gate's deployment policy prohibits
/// (docs/phase-7e/robinhood-deployment.md §4).
///
/// The whole supply is minted once, to `holder`, in the constructor.
contract MandateDemoToken is ERC20 {
    uint8 private immutable DECIMALS;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address holder, uint256 supply)
        ERC20(name_, symbol_)
    {
        DECIMALS = decimals_;
        _mint(holder, supply);
    }

    function decimals() public view override returns (uint8) {
        return DECIMALS;
    }
}
