// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

import {ExactMath} from "./utils/ExactMath.sol";

/// @notice The test oracle is itself tested: against plain arithmetic wherever
/// plain arithmetic cannot overflow, against hand-computed extremes, and for the
/// defining property of the floor and ceiling it reports.
contract ExactMathTest is Test {
    function testFuzz_agreesWithPlainArithmeticWhereItFits(uint64 q, uint64 p, uint128 m, uint8 qd, uint8 pd, uint8 md)
        public
        pure
    {
        qd = uint8(bound(qd, 0, 19));
        pd = uint8(bound(pd, 0, 19));
        md = uint8(bound(md, 0, 38));
        // q*p < 2^128, 10^38 < 2^127, m * 10^38 < 2^255: none of these overflow.
        uint256 left = uint256(q) * p * 10 ** uint256(md);
        uint256 right = uint256(m) * 10 ** (uint256(qd) + pd);
        int8 expected = left < right ? int8(-1) : left > right ? int8(1) : int8(0);
        assertEq(ExactMath.compareProduct(q, qd, p, pd, m, md), expected);
        assertEq(ExactMath.compareScaled(m, md, q, qd), _plainCompareScaled(m, md, q, qd));
    }

    function _plainCompareScaled(uint256 a, uint8 ad, uint256 b, uint8 bd) internal pure returns (int8) {
        uint256 left = a * 10 ** uint256(bd);
        uint256 right = b * 10 ** uint256(ad);
        return left < right ? int8(-1) : left > right ? int8(1) : int8(0);
    }

    function test_handComputedExtremes() public pure {
        uint256 max = type(uint256).max;
        // (2^256-1) * (2^256-1) at 76 decimals against max at 0: the product is ~1.34e77, max ~1.16e77.
        assertEq(ExactMath.compareProduct(max, 38, max, 38, max, 0), 1);
        // 1e-38 * 1e-38 = 1e-76 against 0 and against 1e-38.
        assertEq(ExactMath.compareProduct(1, 38, 1, 38, 0, 38), 1);
        assertEq(ExactMath.compareProduct(1, 38, 1, 38, 1, 38), -1);
        // 2 * 5 = 10 exactly, at scales that must cancel.
        assertEq(ExactMath.compareProduct(2e38, 38, 5e20, 20, 10, 0), 0);
        // max at 38 decimals vs max at 0 decimals.
        assertEq(ExactMath.compareScaled(max, 38, max, 0), -1);
        assertEq(ExactMath.compareScaled(max, 0, max, 38), 1);
        // A product past 2^256 at the target scale is not representable.
        (bool representable,,) = ExactMath.productAt(max, 0, 10, 0, 0);
        assertFalse(representable);
        (bool exact, uint256 f, uint256 c) = ExactMath.productAt(199, 4, 10_000, 2, 0); // 1.99
        assertTrue(exact);
        assertEq(f, 1);
        assertEq(c, 2);
    }

    /// @notice The largest floor with a remainder (6R.1b): 52 q = 10 (2^256 - 1) + 6,
    /// so q at 38 decimals times 52 at 0 decimals is max + 0.6 at 37 decimals. The
    /// ceiling is 2^256, and the oracle must call it unrepresentable, not max.
    function test_floorAtMaxWithARemainderIsUnrepresentable() public pure {
        uint256 q =
            22_267_709_468_714_652_966_071_343_270_901_520_741_013_458_589_546_262_315_280_304_616_906_371_084_603;
        uint256 max = type(uint256).max;
        assertEq(ExactMath.compareProduct(q, 38, 52, 0, max, 37), 1, "above max");
        assertEq(ExactMath.compareProduct(q - 1, 38, 52, 0, max, 37), -1, "one atom less is below max");
        (bool representable, uint256 f, uint256 c) = ExactMath.productAt(q, 38, 52, 0, 37);
        assertFalse(representable);
        assertEq(f, 0);
        assertEq(c, 0);
        // A remainder-free product exactly at max is representable, with floor = ceil = max.
        (representable, f, c) = ExactMath.productAt(max, 0, 1, 0, 0);
        assertTrue(representable);
        assertEq(f, max);
        assertEq(c, max);
    }

    /// @notice floor <= product < floor + 1 and ceil is floor or floor + 1,
    /// exactly as the definition requires, at full width.
    function testFuzz_productAtIsTheExactFloorAndCeiling(uint256 q, uint256 p, uint8 qd, uint8 pd, uint8 td)
        public
        pure
    {
        qd = uint8(bound(qd, 0, 38));
        pd = uint8(bound(pd, 0, 38));
        td = uint8(bound(td, 0, 38));
        q = q >> (q % 256);
        p = p >> (p % 256);
        (bool representable, uint256 f, uint256 c) = ExactMath.productAt(q, qd, p, pd, td);
        if (!representable) {
            assertEq(ExactMath.compareProduct(q, qd, p, pd, type(uint256).max, td), 1);
            return;
        }
        assertGe(ExactMath.compareProduct(q, qd, p, pd, f, td), 0);
        if (f < type(uint256).max) assertEq(ExactMath.compareProduct(q, qd, p, pd, f + 1, td), -1);
        assertEq(c, ExactMath.compareProduct(q, qd, p, pd, f, td) == 0 ? f : f + 1);
    }
}
