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

/// @notice Legacy ERC-20 shape whose mutating methods return no value. SafeERC20
/// must accept it, while all balance and allowance observations remain standard.
contract NoReturnERC20 {
    uint8 public immutable decimals;
    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function approve(address spender, uint256 value) external {
        allowance[msg.sender][spender] = value;
    }

    function transfer(address to, uint256 value) external virtual {
        require(balanceOf[msg.sender] >= value, "balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
    }

    function transferFrom(address from, address to, uint256 value) external virtual {
        require(balanceOf[from] >= value, "balance");
        require(allowance[from][msg.sender] >= value, "allowance");
        allowance[from][msg.sender] -= value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }
}

/// @notice Returns one byte from transferFrom, which is neither an accepted
/// boolean nor the explicitly supported empty-return legacy shape.
contract MalformedReturnERC20 is NoReturnERC20 {
    constructor(uint8 decimals_) NoReturnERC20(decimals_) {}

    function transferFrom(address, address, uint256) external pure override {
        assembly ("memory-safe") {
            mstore(0, 1)
            return(0x1f, 1)
        }
    }
}

/// @notice Standard token except that an explicit approval reset to zero
/// reverts, exercising the fixture adapter's atomic cleanup failure path.
contract FailZeroApproveToken is MockERC20 {
    error ZeroApprovalRefused();

    constructor(uint8 decimals_) MockERC20("Fail Zero Approval", "FZA", decimals_) {}

    function approve(address spender, uint256 value) public override returns (bool) {
        if (value == 0) revert ZeroApprovalRefused();
        return super.approve(spender, value);
    }
}

/// @notice Answers `decimals()` with one value to a chosen caller and another to
/// everyone else. Unsupported behaviour. The independent 6R.1a review used such a
/// token to tell the gate 18 decimals and the venue the gate created 6, while
/// construction still succeeded (Phase 6R.1b).
contract CallerDependentDecimalsToken is ERC20 {
    address public favoured;
    uint8 public immutable TO_FAVOURED;
    uint8 public immutable TO_OTHERS;

    constructor(uint8 toFavoured, uint8 toOthers) ERC20("Caller-Dependent Decimals", "CDD") {
        TO_FAVOURED = toFavoured;
        TO_OTHERS = toOthers;
    }

    function favour(address caller) external {
        favoured = caller;
    }

    function decimals() public view override returns (uint8) {
        return msg.sender == favoured ? TO_FAVOURED : TO_OTHERS;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
