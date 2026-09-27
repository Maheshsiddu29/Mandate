// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {MandateExecutionGate} from "../src/MandateExecutionGate.sol";
import {CanonicalAsset, Candidate, ExecutionTerms, Mandate, SIDE_BUY, SIDE_SELL} from "../src/MandateTypes.sol";
import {FixtureVenueAdapter} from "../src/fixture/FixtureVenueAdapter.sol";

import {GasBench} from "./utils/GasBench.sol";

/// @notice The canonical Phase 6R.2A gas profiles (docs/phase-6r2a-gas-profile.md §B–C),
/// with Phase 6R.2B regression ceilings (docs/phase-6r2b-report.md).
///
/// | profile                | identifiers                         | sets (issuer/chain/venue) | route | adapter              |
/// | ---------------------- | ----------------------------------- | ------------------------- | ----- | -------------------- |
/// | MINIMAL                | 1 byte (chain and representation id are derived) | 1 / 1 / 1    | 0     | FixtureVenueAdapter  |
/// | NORMAL_BUY/NORMAL_SELL | the `GateTestBase` world (5-market gate)         | 1 / 1 / 2    | 0     | FixtureVenueAdapter  |
/// | DEMO / DEMO_SELL       | recorded Robinhood mainnet identifiers           | 1 / 1 / 1    | 0     | FixtureVenueAdapter  |
/// | LARGE                  | 23–44-byte issuer, venue, state identifiers      | 4 / 4 / 4    | 0     | FixtureVenueAdapter  |
/// | MAX_EXECUTABLE_FIXTURE | every choosable identifier 128 bytes             | 16 / 16 / 16 | 0     | FixtureVenueAdapter  |
/// | MAX_SERIALIZABLE       | as above                                         | 16 / 16 / 16 | 4,096 | LeanAdapter (etched) |
///
/// `MAX_SERIALIZABLE` is exactly `Profile.t.sol`'s worst case (same calldata
/// size), measured on a `setUp`-deployed gate. The supported fixture adapter
/// refuses any route data, so the largest attempt that settles on the fixture
/// path is `MAX_EXECUTABLE_FIXTURE`; 4,096 route bytes are serializable and
/// accepted by the gate but only settle through a lean adapter etched at the
/// gate's adapter address. The two are never conflated.
contract GasProfilesTest is GasBench {
    // ------------------------------------------------------------------
    // Regression guards (Phase 6R.2B)
    // ------------------------------------------------------------------
    //
    // Ceilings on execution gas, not expected values. Each sits roughly 20%
    // above the Phase 6R.2B measurement (NORMAL_BUY 246,963, LARGE 270,738,
    // MAX_EXECUTABLE_FIXTURE 425,922, MAX_SERIALIZABLE 386,555 at via-IR, 200
    // runs), which absorbs compiler and toolchain drift — the whole 6R.2A
    // compiler matrix moved a normal execution by at most ~2% — while failing
    // on the regressions that matter. Reintroducing byte-at-a-time identifier
    // validation costs 6.7M on MAX and ~400k on NORMAL; even the intermediate
    // plain-Solidity word validator costs 1.33M on MAX and 351k on LARGE.
    // MAX_ONE_MILLION is the guard that matters most: validation cost is
    // linear in identifier bytes, so MAX is where a slower validator shows first.

    uint256 internal constant NORMAL_CEILING = 300_000;
    uint256 internal constant LARGE_CEILING = 330_000;
    uint256 internal constant MAX_ONE_MILLION = 1_000_000;

    Bench internal minimal;
    Bench internal demo;
    Bench internal demoSell;
    Bench internal large;
    Bench internal maxFixture;
    Bench internal maxSerializable;

    function setUp() public virtual override {
        super.setUp();
        minimal = _deployBench(_minimalShape());
        demo = _deployBench(_demoShape());
        demoSell = _deployBench(_demoShape());
        large = _deployBench(_largeShape());
        maxFixture = _deployBench(_maxShape(0));
        maxSerializable = _deployBench(_maxShape(4_096));
    }

    // ------------------------------------------------------------------
    // Shapes
    // ------------------------------------------------------------------

    function _minimalShape() internal pure returns (Shape memory s) {
        s.asset = CanonicalAsset({assetClass: "e", idScheme: "i", value: "a"});
        s.issuer = "i";
        s.venue = "v";
        s.quantityUnit = "T";
        s.settlementUnit = "U";
        s.issuers = _list(s.issuer);
        s.chains = _list(CHAIN_ID_STRING);
        s.venues = _list(s.venue);
        s.evaluationStateId = "s";
    }

    /// @dev The Agent Marketplace demo as expected: a Robinhood Stock Token
    /// representation of AAPL against the labelled settlement fixture, with the
    /// issuer and evaluation-state identifiers the recorded mainnet corpus uses
    /// (corpus/mainnet-routing-v1). Nothing pathological.
    function _demoShape() internal pure returns (Shape memory s) {
        s.asset = CanonicalAsset({assetClass: "equity", idScheme: "isin", value: "US0378331005"});
        s.issuer = "robinhood-assets-jersey-limited";
        s.venue = "venue.fixture";
        s.quantityUnit = "TOKEN";
        s.settlementUnit = "USD";
        s.issuers = _list(s.issuer);
        s.chains = _list(CHAIN_ID_STRING);
        s.venues = _list(s.venue);
        s.evaluationStateId = "mainnet-aapl-pass.state";
    }

    /// @dev A large but plausible policy: four issuers, four chains, four
    /// venues, long descriptive identifiers, the market's own entries mid-set.
    /// Route data stays empty because the fixture refuses it; the route sweep
    /// prices route bytes separately.
    function _largeShape() internal pure returns (Shape memory s) {
        s.asset = CanonicalAsset({assetClass: "equity", idScheme: "isin", value: "US0378331005"});
        s.issuer = "robinhood-assets-jersey-limited";
        s.venue = "venue.robinhood-chain.fixture.v1";
        s.quantityUnit = "TOKEN";
        s.settlementUnit = "USD";
        s.issuers = new string[](4);
        s.issuers[0] = "issuer.alpha.securities";
        s.issuers[1] = s.issuer;
        s.issuers[2] = "issuer.tokenized-equities.eu.gmbh";
        s.issuers[3] = "issuer.digital-asset-custody.jersey";
        s.issuers = _sorted(s.issuers);
        s.chains = new string[](4);
        s.chains[0] = "eip155:1";
        s.chains[1] = "eip155:4663";
        s.chains[2] = "eip155:42161";
        s.chains[3] = CHAIN_ID_STRING;
        s.chains = _sorted(s.chains);
        s.venues = new string[](4);
        s.venues[0] = "venue.uniswap.v4.arbitrum-one";
        s.venues[1] = s.venue;
        s.venues[2] = "venue.cow-protocol.batch-auction";
        s.venues[3] = "venue.oneinch.aggregation-router.v6";
        s.venues = _sorted(s.venues);
        s.evaluationStateId = "mainnet-aapl-pass.state.2026-09-26T12:00:00Z";
    }

    /// @dev `Profile.t.sol`'s worst case: a 128-byte identifier wherever a
    /// deployment or mandate can choose one, 16-entry sets whose first entry is
    /// the market's own value, every free numeric field at its maximum.
    function _maxShape(uint256 routeBytes) internal pure returns (Shape memory s) {
        s.asset = CanonicalAsset({
            assetClass: _ident("class.", 128, 0), idScheme: _ident("scheme.", 128, 0), value: _ident("value.", 128, 0)
        });
        s.issuer = _ident("issuer.", 128, 0);
        s.venue = _ident("venue.", 128, 0);
        s.quantityUnit = _ident("qunit.", 128, 0);
        s.settlementUnit = _ident("sunit.", 128, 0);
        s.issuers = _identSet("issuer.", 128, 16);
        s.venues = _identSet("venue.", 128, 16);
        s.chains = new string[](16);
        s.chains[0] = CHAIN_ID_STRING;
        for (uint256 i = 1; i < 16; ++i) {
            s.chains[i] = _ident("chain.", 128, i - 1);
        }
        s.evaluationStateId = _ident("state.", 128, 0);
        s.routeBytes = routeBytes;
        s.maximalNumerics = true;
    }

    // ------------------------------------------------------------------
    // Profiles
    // ------------------------------------------------------------------

    function _settledBuy(Bench memory b) internal view {
        assertEq(b.representation.balanceOf(principal), 1_000e18 + QUANTITY, "BUY must deliver exactly");
    }

    function test_gasProfile_MINIMAL() public {
        Measurement memory r = _measureShape(_minimalShape(), minimal, SIDE_BUY);
        _settledBuy(minimal);
        _log("profile", "MINIMAL", r);
        assertEq(r.calldataBytes, 4_132);
        assertLt(r.executionGas, NORMAL_CEILING, "MINIMAL execution gas regressed");
    }

    function test_gasProfile_NORMAL_BUY() public {
        Measurement memory r = _measure(gate, _mandate(), _candidate(), _terms());
        assertEq(aapl.balanceOf(principal), 1_000e18 + QUANTITY);
        _log("profile", "NORMAL_BUY", r);
        assertEq(r.calldataBytes, 4_228);
        assertLt(r.executionGas, NORMAL_CEILING, "NORMAL_BUY execution gas regressed");
    }

    function test_gasProfile_NORMAL_SELL() public {
        Measurement memory r = _measure(gate, _sellMandate(), _candidateFor(address(aapl), SIDE_SELL), _sellTerms());
        assertEq(aapl.balanceOf(principal), 1_000e18 - QUANTITY);
        _log("profile", "NORMAL_SELL", r);
        assertEq(r.calldataBytes, 4_228);
        assertLt(r.executionGas, NORMAL_CEILING, "NORMAL_SELL execution gas regressed");
    }

    function test_gasProfile_DEMO() public {
        Measurement memory r = _measureShape(_demoShape(), demo, SIDE_BUY);
        _settledBuy(demo);
        _log("profile", "DEMO", r);
        assertEq(r.calldataBytes, 4_132);
        assertLt(r.executionGas, NORMAL_CEILING, "DEMO execution gas regressed");
    }

    function test_gasProfile_DEMO_SELL() public {
        Measurement memory r = _measureShape(_demoShape(), demoSell, SIDE_SELL);
        assertEq(demoSell.representation.balanceOf(principal), 1_000e18 - QUANTITY);
        _log("profile", "DEMO_SELL", r);
        assertEq(r.calldataBytes, 4_132);
        assertLt(r.executionGas, NORMAL_CEILING, "DEMO_SELL execution gas regressed");
    }

    function test_gasProfile_LARGE() public {
        Measurement memory r = _measureShape(_largeShape(), large, SIDE_BUY);
        _settledBuy(large);
        _log("profile", "LARGE", r);
        assertEq(r.calldataBytes, 5_124);
        assertLt(r.executionGas, LARGE_CEILING, "LARGE execution gas regressed");
    }

    function test_gasProfile_MAX_EXECUTABLE_FIXTURE() public {
        Measurement memory r = _measureShape(_maxShape(0), maxFixture, SIDE_BUY);
        _settledBuy(maxFixture);
        _log("profile", "MAX_EXECUTABLE_FIXTURE", r);
        assertEq(r.calldataBytes, 14_500);
        assertLt(r.executionGas, MAX_ONE_MILLION, "MAX_EXECUTABLE_FIXTURE execution gas regressed");
    }

    function test_gasProfile_MAX_SERIALIZABLE() public {
        Measurement memory r = _measureShape(_maxShape(4_096), maxSerializable, SIDE_BUY);
        _settledBuy(maxSerializable);
        _log("profile", "MAX_SERIALIZABLE", r);
        // Profile.t.sol's WORST_CASE_CALLDATA_BYTES: the same attempt.
        assertEq(r.calldataBytes, 18_596);
        assertLt(r.executionGas, MAX_ONE_MILLION, "MAX_SERIALIZABLE execution gas regressed");
    }

    /// @notice The supported fixture path settles no route data at all: one
    /// byte is refused by `FixtureVenueAdapter` and the whole attempt reverts.
    function test_gasProfile_fixturePathRefusesAnyRouteData() public {
        Shape memory s = _maxShape(0);
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = _attempt(s, maxFixture, SIDE_BUY);
        t.executionData = hex"ff";
        bytes memory data = _calldataFor(maxFixture.gate, m, c, t);
        vm.expectRevert(FixtureVenueAdapter.UnsupportedRouteData.selector);
        (bool ok,) = address(maxFixture.gate).call(data);
        ok;
    }

    /// @notice How Phase 6R.1b's execution baseline was produced, reproduced so
    /// the difference from the canonical method is on record: the BUY window
    /// wrapped a direct `gate.execute(...)` call, so it included the test's own
    /// ABI encoding of the arguments, and the SELL figure was a second execution
    /// in one transaction, against slots the first had already warmed.
    function test_gasProfile_phase6r1bMethod() public {
        Mandate memory m = _mandate();
        Candidate memory c = _candidate();
        ExecutionTerms memory t = _terms();
        bytes memory ps = _signMandate(m);
        bytes memory as_ = _signExecution(m, c, t);
        uint256 before = gasleft();
        gate.execute(m, ps, c, t, as_);
        _logValue("legacy", "BUY direct call incl. caller encoding", before - gasleft());

        Mandate memory sell = _sellMandate();
        sell.nonce = 2;
        Candidate memory sc = _candidateFor(address(aapl), SIDE_SELL);
        ExecutionTerms memory st = _sellTerms();
        ps = _signMandate(sell);
        as_ = _signExecution(sell, sc, st);
        before = gasleft();
        gate.execute(sell, ps, sc, st, as_);
        _logValue("legacy", "SELL second call, warm, incl. caller encoding", before - gasleft());
    }
}
