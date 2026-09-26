// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

/// @notice What the gate hands an adapter: already-bound values, never raw authority.
///
/// Before the gate calls `execute`, it has transferred exactly `inputAmount` of
/// `inputToken` from the principal to the adapter. That transfer is the only
/// value the adapter ever controls. It holds no allowance from the principal and
/// no role on the gate, so an adapter bug is bounded by one execution's input.
///
/// Every field is advisory to the adapter and authoritative nowhere else: the
/// gate reads *nothing* back from the adapter. It settles on the principal's
/// measured balance deltas, so an adapter that reports a favourable fill while
/// delivering something else simply fails the gate's settlement check and
/// reverts the whole transaction.
struct ExecutionOrder {
    /// @dev `SIDE_BUY` or `SIDE_SELL` wire code.
    uint8 side;
    address inputToken;
    address outputToken;
    /// @dev Exactly what the gate transferred to the adapter for this order.
    uint256 inputAmount;
    /// @dev The least `outputToken` the recipient must receive.
    uint256 minOutput;
    /// @dev Where output must be delivered. Always the principal in Phase 6.
    address recipient;
    /// @dev Where unspent input must be returned. Always the principal.
    address refundTo;
    /// @dev The agent-committed venue route data.
    bytes executionData;
    /// @dev The gate's execution commitment, for venue-side correlation.
    bytes32 executionCommitment;
}

/// @title IMandateExecutionAdapter
/// @notice The single call shape the gate makes to a supported adapter.
/// @dev Adapters are fixed per market at gate construction. There is no
/// arbitrary target and no arbitrary calldata: the gate only ever calls
/// `execute` on the adapter its immutable market table names.
interface IMandateExecutionAdapter {
    /// @notice Perform the venue action for one gate-bound order, atomically.
    /// @dev Must revert rather than partially fill. Must deliver output to
    /// `order.recipient` and unspent input to `order.refundTo`. Returns nothing
    /// because the gate trusts nothing an adapter says.
    function execute(ExecutionOrder calldata order) external;
}
