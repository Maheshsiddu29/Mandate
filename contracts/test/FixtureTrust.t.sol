// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {MandateExecutionGate} from "../src/MandateExecutionGate.sol";
import {Amount, Candidate, ExecutionTerms, Mandate, MarketConfig, SIDE_BUY, SIDE_SELL} from "../src/MandateTypes.sol";
import {FixtureVenue} from "../src/fixture/FixtureVenue.sol";
import {FixtureVenueAdapter} from "../src/fixture/FixtureVenueAdapter.sol";
import {LookAlikeVenue, LyingAdapter} from "./mocks/LookAlikeFixture.sol";
import {GateTestBase} from "./utils/GateTestBase.sol";

/// @notice Phase 6R.1a: the fixture's price is a property of code the gate itself
/// deploys, not of anything a deployed contract says about itself.
///
/// The Phase 6R.1 review settled a BUY under a 100 USD `maxNotional` for 500 USD
/// through an adapter that declared the compliant price, and for 1,000 USD
/// through the genuine adapter wired to a look-alike venue, both on a directly
/// constructed gate. Here the same contracts exist, fully stocked, and the same
/// direct construction has no parameter that could name them.
contract FixtureTrustTest is GateTestBase {
    LyingAdapter internal lying;
    LookAlikeVenue internal lookAlike;
    MandateExecutionGate internal direct;

    function setUp() public override {
        super.setUp();
        lying = new LyingAdapter(address(aapl), address(funding), AAPL_PRICE, 5);
        lookAlike = new LookAlikeVenue(aapl, funding, AAPL_PRICE);
        aapl.mint(address(lying), 1_000e18);
        aapl.mint(address(lookAlike), 1_000e18);
        funding.mint(address(lookAlike), 1_000_000e6);

        // Direct constructor use, exactly as an attacker-deployer would: the whole
        // configuration surface is tokens, identifiers, a typed price and a fee.
        MarketConfig[] memory markets = new MarketConfig[](1);
        markets[0] = _market(address(aapl), _aaplAsset(), "issuer.alpha", "venue.fixture", false);
        direct = new MandateExecutionGate(markets);
        _stock(address(_venueOf(direct, address(aapl))), aapl);
        vm.startPrank(principal);
        funding.approve(address(direct), type(uint256).max);
        aapl.approve(address(direct), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev Signed BUY/SELL of `quantity` fAAPL on the direct gate: `maxNotional`
    /// 100 USD, economic limit 1,000 USD (BUY) or 0 (SELL), funding limit as given.
    function _execute(uint8 side, uint256 quantity, uint256 fundingLimit)
        internal
        returns (uint256 debit, uint256 credit)
    {
        gate = direct;
        Mandate memory m = side == SIDE_BUY ? _mandate() : _sellMandate();
        m.maxNotional = Amount({unit: "USD", decimals: 0, atoms: 100});
        m.economicLimit = Amount({unit: "USD", decimals: 0, atoms: side == SIDE_BUY ? 1_000 : 0});
        Candidate memory c = _candidateFor(address(aapl), side);
        c.quantity.atoms = quantity;
        c.notional = Amount({unit: "USD", decimals: 18, atoms: quantity * 200});
        c.feeTotal = Amount({unit: "USD", decimals: 0, atoms: 0});
        ExecutionTerms memory t = _terms();
        t.fundingLimit = fundingLimit;
        (, debit, credit) = direct.execute(m, _signMandate(m), c, t, _signExecution(m, c, t));
    }

    function test_directConstructionCannotReachALyingAdapterOrALookAlikeVenue() public view {
        FixtureVenueAdapter adapter = _adapterOf(direct, address(aapl));
        FixtureVenue venue = _venueOf(direct, address(aapl));
        assertTrue(address(adapter) != address(lying));
        assertTrue(address(adapter.VENUE()) != address(lookAlike));
        assertEq(address(adapter.VENUE()), address(venue));
        assertEq(adapter.GATE(), address(direct));
        assertEq(venue.PRICE(), AAPL_PRICE);
        // What they would have claimed is irrelevant: nothing reads it.
        (, uint256 claimed) = lying.fixtureSettlement(address(aapl));
        assertEq(claimed, AAPL_PRICE);
    }

    /// @notice The review's malicious-adapter and look-alike-venue shape: BUY 0.5
    /// fAAPL (100 USD at the fixture price) with 1,000 fUSDC made available. Before
    /// 6R.1a it settled with a 500 or 1,000 fUSDC debit. Now the principal pays the
    /// fixture price plus the fixture fee, and the rest is refunded.
    function test_buyUnderMaxNotionalSettlesAtExactlyTheFixturePrice() public {
        FixtureVenue venue = _venueOf(direct, address(aapl));
        uint256 fundingBefore = funding.balanceOf(principal);
        (uint256 debit, uint256 credit) = _execute(SIDE_BUY, 0.5e18, 1_000e6);
        assertEq(credit, 0.5e18);
        assertEq(debit, venue.quoteBuy(0.5e18));
        assertEq(debit, 100.3e6); // 100 USD gross + 30 bps
        assertEq(funding.balanceOf(principal), fundingBefore - 100.3e6);
        assertEq(funding.balanceOf(address(lying)), 0);
        assertEq(funding.balanceOf(address(lookAlike)), 1_000_000e6);
    }

    function test_sellUnderMaxNotionalSettlesAtExactlyTheFixturePrice() public {
        FixtureVenue venue = _venueOf(direct, address(aapl));
        (uint256 debit, uint256 credit) = _execute(SIDE_SELL, 0.5e18, 0);
        assertEq(debit, 0.5e18);
        assertEq(credit, venue.quoteSell(0.5e18));
        assertEq(credit, 99.7e6); // 100 USD gross - 30 bps
    }

    /// @notice A look-alike's price can change after any check; the gate's venue
    /// has no function that changes it, and its price is in its runtime code.
    function test_theGatesVenuePriceCannotChange() public {
        lookAlike.setPrice(2_000e6);
        assertEq(lookAlike.PRICE(), 2_000e6);
        FixtureVenue venue = _venueOf(direct, address(aapl));
        (bool ok,) = address(venue).call(abi.encodeWithSignature("setPrice(uint256)", 2_000e6));
        assertFalse(ok);
        assertEq(venue.PRICE(), AAPL_PRICE);
    }
}
