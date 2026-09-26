// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Exact integer arithmetic shared by the execution gate's authority checks.
/// @dev These functions reproduce `packages/kernel/src/units.ts` without floating
/// point. Decimal differences are at most 38 and quantity plus price decimals at
/// most 76, so every intermediate used for comparisons fits in 512 bits.
library GateArithmetic {
    struct Wide {
        uint256 high;
        uint256 low;
    }

    function compare(uint256 a, uint8 aDecimals, uint256 b, uint8 bDecimals) internal pure returns (int8) {
        if (aDecimals == bDecimals) return a < b ? int8(-1) : a > b ? int8(1) : int8(0);
        Wide memory left = Wide({high: 0, low: 0});
        Wide memory right = Wide({high: 0, low: 0});
        if (aDecimals < bDecimals) {
            left = _scale(a, bDecimals - aDecimals);
            right.low = b;
        } else {
            left.low = a;
            right = _scale(b, aDecimals - bDecimals);
        }
        return _compare(left, right);
    }

    /// @return representable False when the adjacent kernel bounds exceed uint256.
    function notionalBounds(
        uint256 quantity,
        uint8 quantityDecimals,
        uint256 price,
        uint8 priceDecimals,
        uint8 targetDecimals
    ) internal pure returns (bool representable, uint256 floorAtoms, uint256 ceilAtoms) {
        uint16 sourceDecimals = uint16(quantityDecimals) + uint16(priceDecimals);
        if (targetDecimals >= sourceDecimals) {
            uint256 factor = _pow10(uint16(targetDecimals) - sourceDecimals);
            (bool productOk, uint256 product) = Math.tryMul(quantity, price);
            if (!productOk) return (false, 0, 0);
            (bool scaledOk, uint256 scaled) = Math.tryMul(product, factor);
            if (!scaledOk) return (false, 0, 0);
            return (true, scaled, scaled);
        }

        uint256 denominator = _pow10(sourceDecimals - uint16(targetDecimals));
        // Only the high limb determines whether the quotient can fit uint256;
        // `mulDiv` and `mulmod` below independently consume the full product.
        // slither-disable-next-line unused-return
        (uint256 high,) = Math.mul512(quantity, price);
        if (high >= denominator) return (false, 0, 0);
        floorAtoms = Math.mulDiv(quantity, price, denominator);
        if (mulmod(quantity, price, denominator) == 0) return (true, floorAtoms, floorAtoms);
        if (floorAtoms == type(uint256).max) return (false, 0, 0);
        return (true, floorAtoms, floorAtoms + 1);
    }

    /// @notice Kernel `addAmounts(a,b) <= limit`.
    /// @return representable False when the kernel's uint256 sum would overflow.
    function sumWithinLimit(uint256 a, uint8 aDecimals, uint256 b, uint8 bDecimals, uint256 limit, uint8 limitDecimals)
        internal
        pure
        returns (bool representable, bool within)
    {
        uint8 sumDecimals = aDecimals > bDecimals ? aDecimals : bDecimals;
        Wide memory sum = _add(_scale(a, sumDecimals - aDecimals), _scale(b, sumDecimals - bDecimals));
        if (sum.high != 0) return (false, false);
        return (true, compare(sum.low, sumDecimals, limit, limitDecimals) <= 0);
    }

    /// @notice Kernel `notional - fee >= limit`, after separately proving fee < notional.
    function differenceMeetsLimit(
        uint256 notional,
        uint8 notionalDecimals,
        uint256 fee,
        uint8 feeDecimals,
        uint256 limit,
        uint8 limitDecimals
    ) internal pure returns (bool) {
        uint8 decimals = notionalDecimals > feeDecimals ? notionalDecimals : feeDecimals;
        if (limitDecimals > decimals) decimals = limitDecimals;
        Wide memory left = _scale(notional, decimals - notionalDecimals);
        Wide memory right = _add(_scale(fee, decimals - feeDecimals), _scale(limit, decimals - limitDecimals));
        return _compare(left, right) >= 0;
    }

    function _scale(uint256 atoms, uint8 decimalDifference) private pure returns (Wide memory out) {
        (out.high, out.low) = Math.mul512(atoms, _pow10(decimalDifference));
    }

    function _add(Wide memory a, Wide memory b) private pure returns (Wide memory out) {
        unchecked {
            out.low = a.low + b.low;
            out.high = a.high + b.high + (out.low < a.low ? 1 : 0);
        }
    }

    function _compare(Wide memory a, Wide memory b) private pure returns (int8) {
        if (a.high != b.high) return a.high < b.high ? int8(-1) : int8(1);
        return a.low < b.low ? int8(-1) : a.low > b.low ? int8(1) : int8(0);
    }

    function _pow10(uint16 exponent) private pure returns (uint256) {
        return 10 ** uint256(exponent);
    }
}
