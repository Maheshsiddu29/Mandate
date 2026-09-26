// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Exact reference comparisons for test oracles, for every uint256
/// operand and every decimal scale the kernel admits (0..38).
///
/// Tests compare the gate against these instead of plain `a * b * 10**d`
/// arithmetic, which overflows for valid inputs and turns an oracle into a
/// panic (Phase 6R.1a). Each comparison reduces both sides by their common power
/// of ten and compares 512-bit products, so nothing rounds and the answer is the
/// mathematical one. It shares no code path with `GateArithmetic` beyond
/// OpenZeppelin's 512-bit multiply: no division, no remainder.
library ExactMath {
    uint8 internal constant MAX_DECIMALS = 38;

    /// @return The sign of a / 10^ad - b / 10^bd.
    function compareScaled(uint256 a, uint8 ad, uint256 b, uint8 bd) internal pure returns (int8) {
        _checkDecimals(ad);
        _checkDecimals(bd);
        (uint256 aHigh, uint256 aLow) = Math.mul512(a, bd > ad ? 10 ** uint256(bd - ad) : 1);
        (uint256 bHigh, uint256 bLow) = Math.mul512(b, ad > bd ? 10 ** uint256(ad - bd) : 1);
        return _compare(aHigh, aLow, bHigh, bLow);
    }

    /// @return a / 10^ad > b / 10^bd, exactly.
    function gtScaled(uint256 a, uint8 ad, uint256 b, uint8 bd) internal pure returns (bool) {
        return compareScaled(a, ad, b, bd) > 0;
    }

    /// @return The sign of (q / 10^qd) * (p / 10^pd) - m / 10^md.
    function compareProduct(uint256 q, uint8 qd, uint256 p, uint8 pd, uint256 m, uint8 md)
        internal
        pure
        returns (int8)
    {
        _checkDecimals(qd);
        _checkDecimals(pd);
        _checkDecimals(md);
        (uint256 xHigh, uint256 xLow) = Math.mul512(q, p); // q*p at scale s = qd + pd
        uint256 s = uint256(qd) + pd;
        if (md >= s) {
            // q*p * 10^(md-s) against m. A product at or past 2^256 exceeds any m.
            if (xHigh != 0) return 1;
            (uint256 high, uint256 low) = Math.mul512(xLow, 10 ** (md - s));
            return _compare(high, low, 0, m);
        }
        // q*p against m * 10^(s-md); s-md <= 76, so the right side is below 2^509.
        (uint256 mHigh, uint256 mLow) = Math.mul512(m, 10 ** (s - md));
        return _compare(xHigh, xLow, mHigh, mLow);
    }

    /// @return The true gross exceeds the signed bound, exactly.
    function productExceeds(uint256 q, uint8 qd, uint256 p, uint8 pd, uint256 m, uint8 md)
        internal
        pure
        returns (bool)
    {
        return compareProduct(q, qd, p, pd, m, md) > 0;
    }

    /// @return representable Whether the product rendered at `td` is at most
    /// uint256 max (so both neighbours below fit); and its floor and ceiling at
    /// `td`, found by binary search on the exact comparison, not by division.
    function productAt(uint256 q, uint8 qd, uint256 p, uint8 pd, uint8 td)
        internal
        pure
        returns (bool representable, uint256 floorAtoms, uint256 ceilAtoms)
    {
        if (compareProduct(q, qd, p, pd, type(uint256).max, td) > 0) return (false, 0, 0);
        uint256 lo = 0;
        uint256 hi = type(uint256).max;
        while (lo < hi) {
            uint256 mid = lo + (hi - lo) / 2 + 1;
            if (compareProduct(q, qd, p, pd, mid, td) >= 0) lo = mid;
            else hi = mid - 1;
        }
        floorAtoms = lo;
        ceilAtoms = compareProduct(q, qd, p, pd, lo, td) == 0 ? lo : lo + 1;
        representable = true;
    }

    function _compare(uint256 aHigh, uint256 aLow, uint256 bHigh, uint256 bLow) private pure returns (int8) {
        if (aHigh != bHigh) return aHigh < bHigh ? int8(-1) : int8(1);
        return aLow < bLow ? int8(-1) : aLow > bLow ? int8(1) : int8(0);
    }

    function _checkDecimals(uint8 d) private pure {
        require(d <= MAX_DECIMALS, "ExactMath: decimals beyond the kernel range");
    }
}
