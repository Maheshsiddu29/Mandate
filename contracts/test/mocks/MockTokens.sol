// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Plain test ERC-20 with configurable decimals and open minting.
contract MockERC20 is ERC20 {
    uint8 private _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Models an upgradeable token whose decimals move after the gate pinned them.
    function setDecimals(uint8 decimals_) external {
        _decimals = decimals_;
    }
}

/// @notice Burns `feeBps` of every transfer that is not a mint or burn.
/// Unsupported behaviour: the gate must fail closed or stay within bound.
contract FeeOnTransferToken is MockERC20 {
    uint256 public immutable FEE_BPS;

    constructor(uint8 decimals_, uint256 feeBps) MockERC20("Fee Token", "FEE", decimals_) {
        FEE_BPS = feeBps;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) return super._update(from, to, value);
        uint256 fee = value * FEE_BPS / 10_000;
        super._update(from, address(0), fee);
        super._update(from, to, value - fee);
    }
}

/// @notice Calls an arbitrary hook on every transfer: a callback-token model for
/// reentrancy tests.
contract HookToken is MockERC20 {
    address public hookTarget;
    bytes public hookPayload;
    bool public hookSucceeded;
    bytes public hookResult;
    bool private _inHook;

    constructor(uint8 decimals_) MockERC20("Hook Token", "HOOK", decimals_) {}

    function setHook(address target, bytes calldata payload) external {
        hookTarget = target;
        hookPayload = payload;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (hookTarget != address(0) && !_inHook && from != address(0)) {
            _inHook = true;
            (hookSucceeded, hookResult) = hookTarget.call(hookPayload);
            _inHook = false;
        }
    }
}
