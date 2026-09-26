// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {MandateExecutionGate} from "../src/MandateExecutionGate.sol";
import {Amount, Candidate, ExecutionTerms, Mandate, MarketConfig, SIDE_BUY, SIDE_SELL} from "../src/MandateTypes.sol";
import {FixtureVenue} from "../src/fixture/FixtureVenue.sol";
import {GateArithmetic} from "../src/libraries/GateArithmetic.sol";
import {ExactMath} from "./utils/ExactMath.sol";
import {GateTestBase} from "./utils/GateTestBase.sol";

/// @notice Phase 6R.1, M-1: the candidate's notional precision cannot widen the
/// principal's signed maxNotional.
///
/// Every attempt here is signed by the correct principal and the correct agent,
/// and settles through the real `FixtureVenue` / `FixtureVenueAdapter` path. The
/// malicious authorized agent changes nothing but the precision it declares the
/// notional at — the one field the consistency check lets it round. The oracle
/// is `ExactMath`: exact 512-bit comparison of quantity × the venue's own price
/// with the signed bound, which cannot overflow for any valid input (6R.1a; the
/// 6R.1 oracle multiplied plainly and panicked for some valid precisions).
contract MaxNotionalTest is GateTestBase {
    uint256 internal nonce = 1_000;

    function _usdAt(uint256 atoms, uint8 decimals) internal pure returns (Amount memory) {
        return Amount({unit: "USD", decimals: decimals, atoms: atoms});
    }

    /// @dev `quantity` fAAPL on `side` against the AAPL fixture venue, with the
    /// notional declared as `declared` and every other bound out of the way.
    function _attempt(uint8 side, uint256 quantity, Amount memory declared, Amount memory maxNotional)
        internal
        returns (Mandate memory m, Candidate memory c, ExecutionTerms memory t)
    {
        m = side == SIDE_BUY ? _mandate() : _sellMandate();
        m.nonce = uint64(++nonce);
        m.maxNotional = maxNotional;
        m.economicLimit = side == SIDE_BUY ? _usdAt(1e12, 0) : _usdAt(0, 0);
        c = _candidateFor(address(aapl), side);
        c.quantity.atoms = quantity;
        c.notional = declared;
        c.feeTotal = _usdAt(0, 0);
        t = side == SIDE_BUY ? _terms() : _sellTerms();
        t.fundingLimit = side == SIDE_BUY ? aaplVenue.quoteBuy(quantity) : aaplVenue.quoteSell(quantity);
    }

    function _try(Mandate memory m, Candidate memory c, ExecutionTerms memory t)
        internal
        returns (bool ok, bytes memory reason)
    {
        bytes memory ps = _signMandate(m);
        bytes memory as_ = _signExecution(m, c, t);
        try gate.execute(m, ps, c, t, as_) {
            return (true, "");
        } catch (bytes memory r) {
            return (false, r);
        }
    }

    function _assertMaxNotionalRefused(Mandate memory m, Candidate memory c, ExecutionTerms memory t) internal {
        (bool ok, bytes memory reason) = _try(m, c, t);
        assertFalse(ok, "settled above the principal's maxNotional");
        assertEq(reason, _err(MandateExecutionGate.MaxNotionalExceeded.selector));
        assertEq(gate.executionCommitmentOf(harness.mandateDigest(m)), bytes32(0));
    }

    /// @dev `quantity * 200 USD` at `decimals`, floor and ceil, by plain arithmetic.
    function _product(uint256 quantity, uint8 decimals) internal pure returns (uint256 floorAtoms, uint256 ceilAtoms) {
        uint256 numerator = quantity * AAPL_PRICE * 10 ** uint256(decimals);
        uint256 denominator = 1e24; // 10^(18 quantity + 6 price)
        floorAtoms = numerator / denominator;
        ceilAtoms = numerator % denominator == 0 ? floorAtoms : floorAtoms + 1;
    }

    // ------------------------------------------------------------------
    // The audit proofs of concept, permanently regressed
    // ------------------------------------------------------------------

    /// @notice BUY 0.00995 fAAPL = 1.99 USD under a 1 USD maxNotional, declared at 0 decimals as 1.
    function test_m1_poc_buyOf1_99UnderA1UsdMaximumRejects() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) =
            _attempt(SIDE_BUY, 9_950e12, _usdAt(1, 0), _usdAt(1e18, 18));
        _assertMaxNotionalRefused(m, c, t);

        // Control: the identical candidate under an honest 1.99 USD bound settles.
        (m, c, t) = _attempt(SIDE_BUY, 9_950e12, _usdAt(1, 0), _usdAt(199, 2));
        (bool ok,) = _try(m, c, t);
        assertTrue(ok);
    }

    /// @notice SELL 0.50495 fAAPL = 100.99 USD under a 100 USD maxNotional, declared at 0 decimals as 100.
    function test_m1_poc_sellOf100_99UnderA100UsdMaximumRejects() public {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) =
            _attempt(SIDE_SELL, 504_950e12, _usdAt(100, 0), _usdAt(100, 0));
        _assertMaxNotionalRefused(m, c, t);

        (m, c, t) = _attempt(SIDE_SELL, 504_950e12, _usdAt(100, 0), _usdAt(10_099, 2));
        (bool ok,) = _try(m, c, t);
        assertTrue(ok);
    }

    /// @notice A positive BUY under maxNotional = 0, at every principal precision.
    function test_m1_poc_positiveBuyUnderAZeroMaximumRejects() public {
        for (uint8 decimals = 0; decimals <= 38; ++decimals) {
            (Mandate memory m, Candidate memory c, ExecutionTerms memory t) =
                _attempt(SIDE_BUY, 2e15, _usdAt(0, 0), _usdAt(0, decimals));
            _assertMaxNotionalRefused(m, c, t);
        }
    }

    // ------------------------------------------------------------------
    // Malicious authorized agent: only the notional precision moves
    // ------------------------------------------------------------------

    /// @notice 1.99 USD true gross; the bound one 18-decimal atom below it. The
    /// agent tries every precision 0..38, rounding down: none settles.
    function test_m1_everyDeclaredPrecisionIsRefusedAboveTheBound() public {
        for (uint8 side = SIDE_BUY; side <= SIDE_SELL; ++side) {
            for (uint8 d = 0; d <= 38; ++d) {
                (uint256 floorAtoms,) = _product(9_950e12, d);
                (Mandate memory m, Candidate memory c, ExecutionTerms memory t) =
                    _attempt(side, 9_950e12, _usdAt(floorAtoms, d), _usdAt(1.99e18 - 1, 18));
                _assertMaxNotionalRefused(m, c, t);
            }
        }
    }

    /// @notice At exactly the true gross, every precision whose declared value
    /// is itself within the bound settles; precision changes nothing else.
    function test_m1_precisionDoesNotChangeTheVerdictAtTheBound() public {
        for (uint8 side = SIDE_BUY; side <= SIDE_SELL; ++side) {
            for (uint8 d = 0; d <= 38; ++d) {
                (uint256 floorAtoms, uint256 ceilAtoms) = _product(9_950e12, d);
                (Mandate memory m, Candidate memory c, ExecutionTerms memory t) =
                    _attempt(side, 9_950e12, _usdAt(floorAtoms, d), _usdAt(199, 2));
                (bool ok,) = _try(m, c, t);
                // SELL with a declared 0 notional is a separate refusal (fees >= notional).
                assertEq(ok, side == SIDE_BUY || floorAtoms != 0, "floor at the bound");
                // Rounding up at a coarse precision declares more than the
                // bound; the declared comparison refuses it, conservatively.
                (m, c, t) = _attempt(side, 9_950e12, _usdAt(ceilAtoms, d), _usdAt(199, 2));
                (ok,) = _try(m, c, t);
                assertEq(ok, d >= 2, "ceil at the bound");
            }
        }
    }

    /// @notice One atom below, equal to and above the true gross, at the principal's precision.
    function test_m1_oneAtomEitherSideAtThePrincipalPrecision() public {
        // 1.2345 fAAPL = 246.9 USD; exact at 1 decimal and above.
        for (uint8 side = SIDE_BUY; side <= SIDE_SELL; ++side) {
            for (uint8 md = 1; md <= 38; md += 37) {
                (uint256 exact,) = _product(1.2345e18, md);
                (Mandate memory m, Candidate memory c, ExecutionTerms memory t) =
                    _attempt(side, 1.2345e18, _usdAt(246, 0), _usdAt(exact - 1, md));
                _assertMaxNotionalRefused(m, c, t);
                (m, c, t) = _attempt(side, 1.2345e18, _usdAt(246, 0), _usdAt(exact, md));
                (bool ok,) = _try(m, c, t);
                assertTrue(ok, "equal");
                (m, c, t) = _attempt(side, 1.2345e18, _usdAt(246, 0), _usdAt(exact + 1, md));
                (ok,) = _try(m, c, t);
                assertTrue(ok, "above");
            }
        }
    }

    /// @notice Decimal conversion boundary: one quantity atom is 2e-16 USD, exact
    /// at 16 decimals. Below that precision the bound is the rounded-up product.
    function test_m1_decimalConversionBoundaries() public {
        for (uint8 md = 0; md <= 38; ++md) {
            (, uint256 ceilAtoms) = _product(1, md);
            (Mandate memory m, Candidate memory c, ExecutionTerms memory t) =
                _attempt(SIDE_BUY, 1, _usdAt(0, 0), _usdAt(ceilAtoms, md));
            (bool ok,) = _try(m, c, t);
            assertTrue(ok, "ceil of the product admits");
            (m, c, t) = _attempt(SIDE_BUY, 1, _usdAt(0, 0), _usdAt(ceilAtoms - 1, md));
            _assertMaxNotionalRefused(m, c, t);
        }
    }

    // ------------------------------------------------------------------
    // Magnitudes and 512-bit intermediates
    // ------------------------------------------------------------------

    /// @dev A one-market gate over `aapl` whose fixture venue settles at
    /// `fundingAtomsPerToken` (6-decimal fUSDC), with that price pinned.
    function _gateAt(uint256 fundingAtomsPerToken) internal returns (FixtureVenue venue) {
        MarketConfig[] memory markets = new MarketConfig[](1);
        markets[0] = _market(address(aapl), _aaplAsset(), "issuer.alpha", "venue.fixture", false);
        markets[0].fixturePrice.atoms = fundingAtomsPerToken;
        gate = new MandateExecutionGate(markets);
        venue = _venueOf(gate, address(aapl));
        aapl.mint(address(venue), 1e40);
        funding.mint(address(venue), 1e30);
        vm.startPrank(principal);
        funding.approve(address(gate), type(uint256).max);
        aapl.approve(address(gate), type(uint256).max);
        vm.stopPrank();
    }

    function _extreme(FixtureVenue venue, uint256 quantity, uint256 priceAtoms, Amount memory maxNotional)
        internal
        returns (bool ok, bytes memory reason)
    {
        Mandate memory m = _mandate();
        m.nonce = uint64(++nonce);
        m.maxNotional = maxNotional;
        m.economicLimit = _usdAt(1e12, 0);
        Candidate memory c = _candidateFor(address(aapl), SIDE_BUY);
        c.quantity.atoms = quantity;
        c.executionPrice.decimals = 6;
        c.executionPrice.atoms = priceAtoms;
        c.notional = _usdAt(1, 0);
        c.feeTotal = _usdAt(0, 0);
        ExecutionTerms memory t = _terms();
        t.fundingLimit = venue.quoteBuy(quantity);
        return _try(m, c, t);
    }

    /// @notice 1,000,000.5 fAAPL at 0.000001 USD = 1.0000005 USD, and
    /// 0.000000001000000001 fAAPL at 1e9 USD = 1.000000001 USD. Both declare 1 at
    /// 0 decimals; only the true product sees the excess.
    function test_m1_hugeQuantityTinyPriceAndTinyQuantityHugePrice() public {
        FixtureVenue tiny = _gateAt(1);
        (bool ok, bytes memory reason) = _extreme(tiny, 1_000_000.5e18, 1, _usdAt(1, 0));
        assertEq(reason, _err(MandateExecutionGate.MaxNotionalExceeded.selector));
        (ok,) = _extreme(tiny, 1_000_000.5e18, 1, _usdAt(10_000_005, 7));
        assertTrue(ok, "tiny price at its exact bound");

        FixtureVenue huge = _gateAt(1e15);
        (ok, reason) = _extreme(huge, 1_000_000_001, 1e15, _usdAt(1, 0));
        assertEq(reason, _err(MandateExecutionGate.MaxNotionalExceeded.selector));
        (ok,) = _extreme(huge, 1_000_000_001, 1e15, _usdAt(1_000_000_001, 9));
        assertTrue(ok, "huge price at its exact bound");
    }

    /// @notice quantity x price overflows 256 bits; the product at the principal's
    /// precision does not. The 512-bit path decides exactly at the boundary, and a
    /// product that no uint256 bound can hold is refused, not wrapped.
    function test_m1_512BitIntermediateBoundaries() public {
        uint256 quantity = type(uint256).max / 100; // q * 200e6 needs ~290 bits
        uint256 numeratorHigh;
        {
            // floor/ceil of q * 200e6 / 1e24 without the gate's library: q*200e6/1e24 = q/5e15.
            numeratorHigh = quantity / 5e15;
        }
        uint256 exactCeil = quantity % 5e15 == 0 ? numeratorHigh : numeratorHigh + 1;

        Mandate memory m = _mandate();
        m.maxNotional = _usdAt(exactCeil - 1, 0);
        m.economicLimit = _usdAt(type(uint256).max, 0);
        Candidate memory c = _candidate();
        c.quantity.atoms = quantity;
        c.notional = _usdAt(numeratorHigh, 0);
        c.feeTotal = _usdAt(0, 0);
        _expectRevert(m, c, _terms(), _err(MandateExecutionGate.MaxNotionalExceeded.selector));

        // At the exact ceiling the maxNotional check passes, and the attempt goes
        // on to fail at the venue, which cannot fill a 5e58-token order for 2010 USDC.
        m.maxNotional.atoms = exactCeil;
        (bool ok, bytes memory reason) = _try(m, c, _terms());
        assertFalse(ok);
        assertTrue(bytes4(reason) != MandateExecutionGate.MaxNotionalExceeded.selector);

        // At 38 decimals the same product needs ~318 bits: no uint256 bound holds it.
        m.maxNotional = _usdAt(type(uint256).max, 38);
        m.nonce = 2;
        _expectRevert(m, c, _terms(), _err(MandateExecutionGate.MaxNotionalExceeded.selector));
    }

    // ------------------------------------------------------------------
    // Randomized precision combinations
    // ------------------------------------------------------------------

    /// @notice Any quantity, any declared precision rounded either way, any
    /// principal precision, a bound on either side of the true product: the gate
    /// refuses on maxNotional exactly when the true product or the declared
    /// notional exceeds the bound, and otherwise a BUY settles.
    function testFuzz_m1_trueProductBoundsEveryPrecisionCombination(
        uint256 quantity,
        uint8 notionalDecimals,
        uint8 maxDecimals,
        uint8 shape,
        bool roundUp,
        bool sell
    ) public {
        quantity = bound(quantity, 1, 100e18);
        uint8 nd = uint8(bound(notionalDecimals, 0, 38));
        uint8 md = uint8(bound(maxDecimals, 0, 38));
        (uint256 declaredFloor, uint256 declaredCeil) = _product(quantity, nd);
        uint256 declared = roundUp ? declaredCeil : declaredFloor;
        (uint256 exactFloor, uint256 exactCeil) = _product(quantity, md);
        uint256 maxAtoms;
        uint256 s = shape % 4;
        if (s == 0 && nd <= md) maxAtoms = declared * 10 ** uint256(md - nd); // the M-1 shape
        else if (s == 1) maxAtoms = exactCeil;
        else if (s == 2) maxAtoms = exactFloor;
        else maxAtoms = exactCeil + 1;

        uint8 side = sell ? SIDE_SELL : SIDE_BUY;
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) =
            _attempt(side, quantity, _usdAt(declared, nd), _usdAt(maxAtoms, md));
        (bool ok, bytes memory reason) = _try(m, c, t);

        bool trueExceeds = ExactMath.productExceeds(quantity, 18, AAPL_PRICE, 6, maxAtoms, md);
        bool declaredExceeds = ExactMath.gtScaled(declared, nd, maxAtoms, md);
        if (trueExceeds || declaredExceeds) {
            assertEq(reason, _err(MandateExecutionGate.MaxNotionalExceeded.selector));
        } else if (!sell) {
            assertTrue(ok, "honest BUY within the bound");
        } else if (!ok) {
            // The only other SELL refusal a zero-fee candidate can reach.
            assertEq(reason, _err(MandateExecutionGate.DeclaredFeesExceedNotional.selector));
            assertEq(declared, 0);
        }
    }

    /// @notice Inputs on which the 6R.1 oracle's own plain multiplication
    /// overflowed (`declared * 10**md`) after the gate had settled correctly: the
    /// independent review's counterexample and one the fuzzer reached once the
    /// gate's bytecode changed. The oracle must now decide them, not panic.
    function test_m1_fuzzInputsThatOverflowedThePreviousOracle() public {
        this.testFuzz_m1_trueProductBoundsEveryPrecisionCombination(1e30, 37, 233, 254, false, true);
        this.testFuzz_m1_trueProductBoundsEveryPrecisionCombination(
            34_390_819_888_240_390_953_029_010_971_248_455_142_986_221_947_941_601_700_148_038_000_926_730_363_672,
            193,
            37,
            39,
            false,
            false
        );
    }

    // ------------------------------------------------------------------
    // Every precision pair, deterministically (6R.1a)
    // ------------------------------------------------------------------

    /// @dev Every declared precision 0..38 against every principal precision 0..38
    /// on one side, through the real venue: 1,521 correctly signed attempts. The
    /// bound cycles through the four positions around the true product at the
    /// principal's precision (one atom below its floor, floor, ceiling, one
    /// above); the declared notional is the floor at the agent's precision, which
    /// is always within a bound the true gross is within. A refusal is exactly
    /// `MaxNotionalExceeded`, and happens exactly when the exact oracle says the
    /// true gross exceeds the bound.
    function _everyPrecisionPair(uint8 side) internal {
        uint256 refused;
        uint256 settled;
        for (uint8 nd = 0; nd <= 38; ++nd) {
            for (uint8 md = 0; md <= 38; ++md) {
                // An external call per pair, so each attempt gets fresh memory.
                uint8 verdict = this.precisionPair(side, nd, md);
                if (verdict == REFUSED) refused += 1;
                else if (verdict == SETTLED) settled += 1;
            }
        }
        // Non-vacuity: both verdicts occur in quantity.
        assertGt(refused, 500);
        assertGt(settled, 500);
    }

    uint8 internal constant REFUSED = 1;
    uint8 internal constant SETTLED = 2;
    uint8 internal constant UNRELATED = 3;

    /// @dev One (declared precision, principal precision) pair; asserts, then
    /// reports which verdict it reached. Not a test: forge runs only `test*`.
    function precisionPair(uint8 side, uint8 nd, uint8 md) external returns (uint8) {
        uint256 quantity = 9_950e12 + 1; // 1.990000000000000200 USD: inexact below 24 decimals
        (uint256 declared,) = _product(quantity, nd);
        (uint256 exactFloor, uint256 exactCeil) = _product(quantity, md);
        uint256 k = (uint256(nd) + md) % 4;
        uint256 maxAtoms = k == 0 ? exactFloor - 1 : k == 1 ? exactFloor : k == 2 ? exactCeil : exactCeil + 1;
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) =
            _attempt(side, quantity, _usdAt(declared, nd), _usdAt(maxAtoms, md));
        (bool ok, bytes memory reason) = _try(m, c, t);
        if (ExactMath.productExceeds(quantity, 18, AAPL_PRICE, 6, maxAtoms, md)) {
            assertFalse(ok, "settled above the bound");
            assertEq(reason, _err(MandateExecutionGate.MaxNotionalExceeded.selector));
            return REFUSED;
        }
        if (side == SIDE_SELL && declared == 0) {
            // Zero declared proceeds is the separate fees-exceed-notional refusal.
            assertEq(reason, _err(MandateExecutionGate.DeclaredFeesExceedNotional.selector));
            return UNRELATED;
        }
        assertTrue(ok, "honest attempt within the bound refused");
        return SETTLED;
    }

    function test_m1_everyNotionalAndPrincipalPrecisionPair_buy() public {
        _everyPrecisionPair(SIDE_BUY);
    }

    function test_m1_everyNotionalAndPrincipalPrecisionPair_sell() public {
        _everyPrecisionPair(SIDE_SELL);
    }

    // ------------------------------------------------------------------
    // The rule at full operand width (6R.1a)
    // ------------------------------------------------------------------

    /// @dev `_checkMaxNotional`'s product rule, as the library computes it:
    /// refuse when the product at the principal's precision is unrepresentable or
    /// its ceiling exceeds the signed atoms.
    function _gateRuleRefuses(uint256 q, uint8 qd, uint256 p, uint8 pd, uint256 m, uint8 md)
        internal
        pure
        returns (bool)
    {
        (bool representable,, uint256 ceilAtoms) = GateArithmetic.notionalBounds(q, qd, p, pd, md);
        return !representable || ceilAtoms > m;
    }

    /// @dev An operand shape: full width, a random width, near the top, a power
    /// of ten or its neighbour, or small.
    function _shape(uint256 x, uint256 selector) internal pure returns (uint256) {
        uint256 s = selector % 6;
        if (s == 0) return x;
        if (s == 1) return x >> (x % 256);
        if (s == 2) return type(uint256).max - (x % 1_000);
        if (s == 3) return 10 ** (x % 78);
        if (s == 4) return 10 ** (x % 77) - 1 + (x % 3);
        return 1 + (x % 1e6);
    }

    /// @notice Full-width quantity, price and bound at every decimal scale, with
    /// the bound placed on and around the true product when it is representable:
    /// the rule refuses exactly when the true product exceeds the bound.
    function testFuzz_m1_ruleIsExactAtFullWidth(
        uint256 q,
        uint256 p,
        uint256 m,
        uint8 qd,
        uint8 pd,
        uint8 md,
        uint256 selector
    ) public pure {
        q = _shape(q, selector);
        p = _shape(p, selector >> 8);
        qd = uint8(bound(qd, 0, 38));
        pd = uint8(bound(pd, 0, 38));
        md = uint8(bound(md, 0, 38));
        (bool representable, uint256 f, uint256 c) = ExactMath.productAt(q, qd, p, pd, md);
        uint256 k = (selector >> 16) % 5;
        if (representable && k == 0) m = f;
        else if (representable && k == 1) m = c;
        else if (representable && k == 2) m = f == 0 ? 0 : f - 1;
        else if (representable && k == 3) m = c == type(uint256).max ? c : c + 1;
        else m = _shape(m, selector >> 24);
        assertEq(_gateRuleRefuses(q, qd, p, pd, m, md), ExactMath.productExceeds(q, qd, p, pd, m, md));
    }

    /// @notice Every (quantity, price, principal) decimal triple, 39^3 of them,
    /// each with seeded full-width operands and the bound at the product's floor
    /// or ceiling when representable, else at the uint256 maximum.
    function test_m1_ruleIsExactAtEveryDecimalTriple() public pure {
        uint256 checked;
        for (uint8 qd = 0; qd <= 38; ++qd) {
            for (uint8 pd = 0; pd <= 38; ++pd) {
                for (uint8 md = 0; md <= 38; ++md) {
                    uint256 seed = uint256(keccak256(abi.encode(qd, pd, md)));
                    uint256 q = _shape(seed, seed >> 200);
                    uint256 p = _shape(uint256(keccak256(abi.encode(seed))), seed >> 208);
                    (bool gateRepresentable, uint256 f, uint256 c) = GateArithmetic.notionalBounds(q, qd, p, pd, md);
                    uint256 m = !gateRepresentable ? type(uint256).max : seed % 2 == 0 ? f : c;
                    assertEq(_gateRuleRefuses(q, qd, p, pd, m, md), ExactMath.productExceeds(q, qd, p, pd, m, md));
                    checked += 1;
                }
            }
        }
        assertEq(checked, 39 * 39 * 39);
    }
}
