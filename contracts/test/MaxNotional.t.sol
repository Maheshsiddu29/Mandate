// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {MandateExecutionGate} from "../src/MandateExecutionGate.sol";
import {Amount, Candidate, ExecutionTerms, Mandate, MarketConfig, SIDE_BUY, SIDE_SELL} from "../src/MandateTypes.sol";
import {FixtureVenue} from "../src/fixture/FixtureVenue.sol";
import {FixtureVenueAdapter} from "../src/fixture/FixtureVenueAdapter.sol";
import {GateTestBase} from "./utils/GateTestBase.sol";

/// @notice Phase 6R.1, M-1: the candidate's notional precision cannot widen the
/// principal's signed maxNotional.
///
/// Every attempt here is signed by the correct principal and the correct agent,
/// and settles through the real `FixtureVenue` / `FixtureVenueAdapter` path. The
/// malicious authorized agent changes nothing but the precision it declares the
/// notional at — the one field the consistency check lets it round. The oracle
/// is independent cross-multiplication of quantity and the venue's own price.
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
        venue = new FixtureVenue(aapl, funding, fundingAtomsPerToken, FEE_BPS);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        FixtureVenueAdapter adapter = new FixtureVenueAdapter(predicted, venue);
        MarketConfig[] memory markets = new MarketConfig[](1);
        markets[0] = _market(address(aapl), address(adapter), _aaplAsset(), "issuer.alpha", "venue.fixture", false);
        markets[0].fixturePrice.atoms = fundingAtomsPerToken;
        gate = new MandateExecutionGate(markets);
        assertEq(address(gate), predicted);
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

        bool trueExceeds = quantity * AAPL_PRICE * 10 ** uint256(md) > maxAtoms * 1e24;
        bool declaredExceeds = declared * 10 ** uint256(md) > maxAtoms * 10 ** uint256(nd);
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
}
