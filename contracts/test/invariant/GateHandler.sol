// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {MandateExecutionGate} from "../../src/MandateExecutionGate.sol";
import {Amount, Candidate, ExecutionTerms, Mandate, SIDE_BUY, SIDE_SELL} from "../../src/MandateTypes.sol";
import {FixtureVenue} from "../../src/fixture/FixtureVenue.sol";
import {FixtureVenueAdapter} from "../../src/fixture/FixtureVenueAdapter.sol";
import {MockERC20} from "../mocks/MockTokens.sol";
import {ScriptedAdapter} from "../mocks/ScriptedAdapter.sol";
import {CodecHarness} from "../utils/CodecHarness.sol";
import {ExactMath} from "../utils/ExactMath.sol";
import {GateTestBase} from "../utils/GateTestBase.sol";

/// @notice Drives the gate through honest and hostile sequences over a fixed pool
/// of single-use authorizations, and keeps ghost books the invariants check.
///
/// Inherits the world builders from `GateTestBase` and is pointed at the test's
/// deployment; only the functions named in `selectors()` are fuzzed.
///
/// Two execution paths: the scripted adapter, which can misbehave in every way
/// an adapter can, and the real `FixtureVenue` / `FixtureVenueAdapter` market,
/// where the agent varies only the precisions and the principal's bound.
/// `maxNotionalViolations` is defined on the *true* gross — quantity times the
/// venue's own settlement price, compared with the signed bound at its signed
/// precision by `ExactMath`'s exact 512-bit comparison — never on the candidate's
/// declared notional, whose precision is the agent's choice (Phase 6R.1, M-1).
///
/// A third path (Phase 6R.1a) trades on the WIDE market at quantities near 10^40
/// tokens, where quantity × price at the principal's 10..38-decimal bound
/// exceeds 2^256: the gate's unrepresentable-product refusal is then the only
/// thing standing between the agent and a settlement above the bound.
contract GateHandler is GateTestBase {
    uint256 public constant POOL = 24;
    uint256 public constant BUY_BOUND = 2_010e6; // floor of the signed 2010 USD MAX_TOTAL_DEBIT
    uint256 public constant SELL_FLOOR = 1_990e6; // ceil of the signed 1990 USD MIN_TOTAL_CREDIT

    // Ghost books.
    mapping(bytes32 digest => uint256) public successes;
    mapping(bytes32 digest => bytes32) public signedCommitmentOf;
    bytes32[] public digests;
    uint256 public buyDebits;
    uint256 public buyCredits;
    uint256 public sellDebits;
    uint256 public sellCredits;
    uint256 public buyBoundViolations;
    uint256 public sellFloorViolations;
    uint256 public sellDebitViolations;
    uint256 public tamperedSuccesses;
    uint256 public unsupportedSuccesses;
    uint256 public replaySuccesses;
    uint256 public maliciousAgentSuccesses;
    uint256 public maxNotionalViolations;
    uint256 public fixtureBuySettled;
    uint256 public fixtureSellSettled;
    uint256 public fixtureTokenCredits;
    uint256 public fixtureTokenDebits;
    /// @dev Attempts whose declared notional is within the bound while the true gross is not.
    uint256 public coarsePrecisionAttempts;
    uint256 public coarsePrecisionRefusals;
    /// @dev WIDE market: attempts whose product cannot be represented at the bound's precision.
    uint256 public wideOverflowAttempts;
    uint256 public wideOverflowRefusals;
    uint256 public wideControlSettled;
    uint256 public wideFundingDebits;
    uint256 public wideFundingCredits;
    uint256 public wideTokenCredits;
    uint256 public wideTokenDebits;
    uint256 internal wideNonce;
    uint256 internal fixtureNonce;
    uint256 public exactFillViolations;
    uint256 public calls;
    uint256 public settled;

    bytes internal _lastPayload;

    constructor(
        MandateExecutionGate gate_,
        CodecHarness harness_,
        ScriptedAdapter scripted_,
        MockERC20 funding_,
        MockERC20 token_,
        MockERC20 fixtureToken_,
        FixtureVenue fixtureVenue_,
        FixtureVenueAdapter fixtureAdapter_,
        MockERC20 wide_,
        MockERC20 funding0_,
        address principal_,
        address agent_
    ) {
        aapl = fixtureToken_;
        aaplVenue = fixtureVenue_;
        aaplAdapter = fixtureAdapter_;
        gate = gate_;
        harness = harness_;
        scripted = scripted_;
        funding = funding_;
        scriptedToken = token_;
        principal = principal_;
        agent = agent_;
        wide = wide_;
        funding0 = funding0_;
        wideVenue = _venueOf(gate_, address(wide_));
        wideAdapter = _adapterOf(gate_, address(wide_));
        for (uint256 i = 0; i < POOL; ++i) {
            digests.push(harness.mandateDigest(_poolMandate(i)));
        }
    }

    function selectors() external pure returns (bytes4[] memory s) {
        s = new bytes4[](7);
        s[0] = this.execute.selector;
        s[1] = this.executeTampered.selector;
        s[2] = this.executeUnsupported.selector;
        s[3] = this.replayLast.selector;
        s[4] = this.executeMalicious.selector;
        s[5] = this.executeFixturePrecision.selector;
        s[6] = this.executeWideOverflow.selector;
    }

    function digestCount() external view returns (uint256) {
        return digests.length;
    }

    function _poolMandate(uint256 i) internal view returns (Mandate memory m) {
        m = i % 2 == 0 ? _mandate() : _sellMandate();
        m.nonce = uint64(i + 1);
    }

    function _poolTerms(uint256 i, uint256 amountSeed) internal view returns (ExecutionTerms memory t) {
        t = _terms();
        // Straddle the signed bound on both sides so both refusals and settlements occur.
        t.fundingLimit = i % 2 == 0
            ? bound(amountSeed, BUY_BOUND - 10e6, BUY_BOUND + 5)
            : bound(amountSeed, SELL_FLOOR - 5, SELL_FLOOR + 10e6);
        t.deadline = uint64(T0 + 3_000);
    }

    function _script(uint256 behavior, uint256 i, ExecutionTerms memory t, uint256 quantity) internal {
        ScriptedAdapter.Mode mode = ScriptedAdapter.Mode.SCRIPTED;
        bool isBuy = i % 2 == 0;
        uint256 minOut = isBuy ? quantity : t.fundingLimit;
        uint256 deliver = minOut;
        uint256 refund = isBuy ? t.fundingLimit / 1_000 : 0;
        address deliverTo = address(0);
        uint256 extraPull = 0;
        uint256 b = behavior % 7;
        if (b == 1) {
            deliver = minOut - 1; // under-deliver
        } else if (b == 2) {
            refund = isBuy ? t.fundingLimit : quantity / 2; // over-refund / partial fill
        } else if (b == 3) {
            deliverTo = address(0xdead); // redirect
        } else if (b == 4) {
            mode = ScriptedAdapter.Mode.REVERT;
        } else if (b == 5) {
            mode = ScriptedAdapter.Mode.RETURN_GARBAGE;
        } else if (b == 6) {
            // Over-pull through an allowance the principal granted the adapter
            // directly — a principal mistake the gate must still bound.
            mode = ScriptedAdapter.Mode.PULL_FROM_PRINCIPAL;
            refund = 0;
            extraPull = 1 + behavior % (isBuy ? 20e6 : 1e18);
        }
        scripted.setScript(ScriptedAdapter.Script(mode, deliver, refund, deliverTo, address(0), "", false, extraPull));
    }

    function _submit(Mandate memory m, bytes memory ps, Candidate memory c, ExecutionTerms memory t, bytes memory as_)
        internal
        returns (bool ok, uint256 debit, uint256 credit)
    {
        calls += 1;
        // The invariant runner resets the block environment between calls; the
        // deployment chain is part of the world, not something the fuzzer varies.
        vm.chainId(CHAIN);
        try gate.execute(m, ps, c, t, as_) returns (bytes32, uint256 d, uint256 k) {
            return (true, d, k);
        } catch {
            return (false, 0, 0);
        }
    }

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------

    function execute(uint256 index, uint256 behavior, uint256 amountSeed, uint256 timeSeed) external {
        uint256 i = index % POOL;
        vm.warp(bound(timeSeed, T0 - 100, T0 + 4_000));
        Mandate memory m = _poolMandate(i);
        Candidate memory c = _scriptedCandidate(i % 2 == 0 ? SIDE_BUY : SIDE_SELL);
        ExecutionTerms memory t = _poolTerms(i, amountSeed);
        _script(behavior, i, t, c.quantity.atoms);
        bytes memory ps = _signMandate(m);
        bytes memory as_ = _signExecution(m, c, t);

        (bool ok, uint256 debit, uint256 credit) = _submit(m, ps, c, t, as_);
        if (!ok) return;
        bytes32 digest = harness.mandateDigest(m);
        successes[digest] += 1;
        signedCommitmentOf[digest] = _commitment(m, c, t);
        settled += 1;
        _lastPayload = abi.encodeCall(gate.execute, (m, ps, c, t, as_));
        if (i % 2 == 0) {
            buyDebits += debit;
            buyCredits += credit;
            if (debit > BUY_BOUND) buyBoundViolations += 1;
            if (credit != c.quantity.atoms) exactFillViolations += 1;
        } else {
            sellDebits += debit;
            sellCredits += credit;
            if (credit < SELL_FLOOR) sellFloorViolations += 1;
            if (debit > c.quantity.atoms) sellDebitViolations += 1;
            if (debit != c.quantity.atoms) exactFillViolations += 1;
        }
        if (_trueGrossExceeds(c.quantity.atoms, AAPL_PRICE, m.maxNotional)) maxNotionalViolations += 1;
    }

    /// @dev True gross notional of an 18-decimal quantity at a 6-decimal funding
    /// price against the signed bound, exactly, independently of the gate's
    /// arithmetic, for any operands.
    function _trueGrossExceeds(uint256 quantity, uint256 fundingAtomsPerToken, Amount memory maxNotional)
        internal
        pure
        returns (bool)
    {
        return ExactMath.productExceeds(quantity, 18, fundingAtomsPerToken, 6, maxNotional.atoms, maxNotional.decimals);
    }

    /// @dev `quantity * price` at `decimals`, floor and ceil, by the same plain arithmetic.
    function _product(uint256 quantity, uint256 price, uint8 decimals) internal pure returns (uint256 f, uint256 c) {
        uint256 numerator = quantity * price * 10 ** uint256(decimals);
        f = numerator / 1e24;
        c = numerator % 1e24 == 0 ? f : f + 1;
    }

    /// Real fixture market. Correctly signed by principal and agent; the agent
    /// picks the quantity, the precision it declares the notional at and which
    /// way it rounds; the principal's bound is placed around the true product —
    /// half the time exactly at the agent's coarse declared value (the M-1 shape).
    function executeFixturePrecision(
        uint256 quantitySeed,
        uint8 notionalDecimals,
        uint8 maxDecimals,
        uint8 shape,
        bool roundUp,
        bool sell
    ) external {
        vm.warp(T0);
        uint256 quantity = bound(quantitySeed, 1e12, 100e18);
        uint8 nd = uint8(bound(notionalDecimals, 0, 38));
        uint8 md = uint8(bound(maxDecimals, 0, 38));
        uint256 price = aaplVenue.PRICE();
        (uint256 declaredFloor, uint256 declaredCeil) = _product(quantity, price, nd);
        uint256 declared = roundUp ? declaredCeil : declaredFloor;
        (uint256 exactFloor, uint256 exactCeil) = _product(quantity, price, md);
        uint256 s = shape % 4;
        uint256 maxAtoms = s < 2 && nd <= md ? declared * 10 ** uint256(md - nd) : s == 2 ? exactCeil : exactFloor;

        uint8 side = sell ? SIDE_SELL : SIDE_BUY;
        Mandate memory m = sell ? _sellMandate() : _mandate();
        m.nonce = uint64(1_000_000 + ++fixtureNonce);
        m.maxNotional = Amount({unit: "USD", decimals: md, atoms: maxAtoms});
        m.economicLimit = Amount({unit: "USD", decimals: 0, atoms: sell ? 0 : 1e12});
        Candidate memory c = _candidateFor(address(aapl), side);
        c.quantity.atoms = quantity;
        c.notional = Amount({unit: "USD", decimals: nd, atoms: declared});
        c.feeTotal = Amount({unit: "USD", decimals: 0, atoms: 0});
        ExecutionTerms memory t = _terms();
        t.fundingLimit = sell ? aaplVenue.quoteSell(quantity) : aaplVenue.quoteBuy(quantity);

        // Declared within the bound, compared at the finer of the two scales.
        bool declaredWithin =
            nd <= md ? declared * 10 ** uint256(md - nd) <= maxAtoms : declared <= maxAtoms * 10 ** uint256(nd - md);
        bool coarse = declaredWithin && _trueGrossExceeds(quantity, price, m.maxNotional);
        if (coarse) coarsePrecisionAttempts += 1;

        bytes32 digest = harness.mandateDigest(m);
        digests.push(digest);
        (bool ok, uint256 debit, uint256 credit) = _submit(m, _signMandate(m), c, t, _signExecution(m, c, t));
        if (!ok) {
            if (coarse) coarsePrecisionRefusals += 1;
            return;
        }
        successes[digest] += 1;
        signedCommitmentOf[digest] = _commitment(m, c, t);
        settled += 1;
        if (sell) {
            fixtureSellSettled += 1;
            sellCredits += credit;
            fixtureTokenDebits += debit;
            if (credit < t.fundingLimit) sellFloorViolations += 1;
            if (debit != quantity) exactFillViolations += 1;
        } else {
            fixtureBuySettled += 1;
            buyDebits += debit;
            fixtureTokenCredits += credit;
            if (debit > t.fundingLimit) buyBoundViolations += 1;
            if (credit != quantity) exactFillViolations += 1;
        }
        if (_trueGrossExceeds(quantity, price, m.maxNotional)) maxNotionalViolations += 1;
    }

    /// WIDE market, real venue, correctly signed. The principal's bound is uint256
    /// max at `md` decimals, V = max / 10^md USD. The agent buys or sells V's
    /// integer part plus one tenth of a token more than V's fraction allows, so
    /// the true gross exceeds V and, at `md` decimals, 2^256: only the gate's
    /// unrepresentable-product refusal stops it. Its declared notional, the floor
    /// at 0 decimals, is within the bound. `control` instead trades exactly V's
    /// integer part and representable tenths, which must settle.
    function executeWideOverflow(uint256 seed, bool sell, bool control) external {
        vm.warp(T0);
        uint8 md = uint8(bound(seed, 10, 38));
        uint256 unit = 10 ** uint256(md);
        uint256 whole = type(uint256).max / unit;
        uint256 tenths = (type(uint256).max % unit) / (unit / 10);
        // When V's fraction is already .9 or more, no quantity at 1 decimal lands between V and its ceiling.
        if (tenths >= 9) control = true;
        uint256 quantity = whole * 10 + (control ? tenths : tenths + 1);

        uint8 side = sell ? SIDE_SELL : SIDE_BUY;
        Mandate memory m = sell ? _sellMandate() : _mandate();
        m.nonce = uint64(2_000_000 + ++wideNonce);
        m.maxNotional = Amount({unit: "USD", decimals: md, atoms: type(uint256).max});
        m.economicLimit = Amount({unit: "USD", decimals: 0, atoms: sell ? 0 : type(uint256).max});
        Candidate memory c = _candidateFor(address(wide), side);
        c.quantity = Amount({unit: "TOKEN", decimals: 1, atoms: quantity});
        c.executionPrice.decimals = 0;
        c.executionPrice.atoms = 1;
        c.notional = Amount({unit: "USD", decimals: 0, atoms: quantity / 10});
        c.feeTotal = Amount({unit: "USD", decimals: 0, atoms: 0});
        ExecutionTerms memory t = _terms();
        t.fundingLimit = sell ? wideVenue.quoteSell(quantity) : wideVenue.quoteBuy(quantity);

        // The venue's own price: 1 funding atom (0 decimals) per whole token.
        bool over = ExactMath.productExceeds(quantity, 1, wideVenue.PRICE(), 0, type(uint256).max, md);
        if (over) wideOverflowAttempts += 1;

        bytes32 digest = harness.mandateDigest(m);
        digests.push(digest);
        (bool ok, uint256 debit, uint256 credit) = _submit(m, _signMandate(m), c, t, _signExecution(m, c, t));
        if (!ok) {
            if (over) wideOverflowRefusals += 1;
            return;
        }
        successes[digest] += 1;
        signedCommitmentOf[digest] = _commitment(m, c, t);
        settled += 1;
        if (!over) wideControlSettled += 1;
        if (sell) {
            wideTokenDebits += debit;
            wideFundingCredits += credit;
            if (credit < t.fundingLimit) sellFloorViolations += 1;
            if (debit != quantity) exactFillViolations += 1;
        } else {
            wideFundingDebits += debit;
            wideTokenCredits += credit;
            if (debit > t.fundingLimit) buyBoundViolations += 1;
            if (credit != quantity) exactFillViolations += 1;
        }
        if (over) maxNotionalViolations += 1;
    }

    /// Signs honestly, then changes one committed field. Must never settle.
    function executeTampered(uint256 index, uint256 field, uint256 value) external {
        uint256 i = index % POOL;
        Mandate memory m = _poolMandate(i);
        Candidate memory c = _scriptedCandidate(i % 2 == 0 ? SIDE_BUY : SIDE_SELL);
        ExecutionTerms memory t = _poolTerms(i, value);
        _script(0, i, t, c.quantity.atoms);
        bytes memory ps = _signMandate(m);
        bytes memory as_ = _signExecution(m, c, t);
        uint256 f = field % 6;
        if (f == 0) m.economicLimit.atoms += 1 + value % 1e24;
        else if (f == 1) m.side = m.side == SIDE_BUY ? SIDE_SELL : SIDE_BUY;
        else if (f == 2) c.quantity.atoms += 1 + value % 1e24;
        else if (f == 3) t.recipient = address(uint160(uint256(keccak256(abi.encode(value)))));
        else if (f == 4) t.fundingLimit = i % 2 == 0 ? t.fundingLimit + 1 : t.fundingLimit - 1;
        else t.executionData = abi.encode(value);
        (bool ok,,) = _submit(m, ps, c, t, as_);
        if (ok) tamperedSuccesses += 1;
    }

    /// Fully signed, but for a token that is not a supported market or with the
    /// scripted token under the wrong venue. Must never settle.
    function executeUnsupported(uint256 index, address token, bool wrongVenue) external {
        uint256 i = index % POOL;
        Mandate memory m = _poolMandate(i);
        Candidate memory c = _scriptedCandidate(i % 2 == 0 ? SIDE_BUY : SIDE_SELL);
        if (wrongVenue) {
            c.venue = "venue.fixture";
        } else {
            if (token == address(scriptedToken)) token = address(0xbad);
            c.representationId = harness.representationId(CHAIN, token);
        }
        ExecutionTerms memory t = _poolTerms(i, 0);
        _script(0, i, t, c.quantity.atoms);
        (bool ok,,) = _submit(m, _signMandate(m), c, t, _signExecution(m, c, t));
        if (ok) unsupportedSuccesses += 1;
    }

    /// Fully and correctly re-signed by the authorized agent after constructing
    /// a kernel-invalid static policy violation. None may settle.
    function executeMalicious(uint256 index, uint256 attack) external {
        uint256 i = index % POOL;
        Mandate memory m = _poolMandate(i);
        Candidate memory c = _scriptedCandidate(i % 2 == 0 ? SIDE_BUY : SIDE_SELL);
        ExecutionTerms memory t = _poolTerms(i, i % 2 == 0 ? 0 : type(uint256).max);
        uint256 kind = attack % 9;
        if (kind == 0) {
            c.quantity.atoms *= 2;
            c.notional.atoms *= 2;
        } else if (kind == 1) {
            c.notional.atoms += 1;
        } else if (kind == 2) {
            c.issuer = "issuer.omega";
        } else if (kind == 3) {
            c.feeTotal.atoms = i % 2 == 0 ? 11e18 : c.notional.atoms;
        } else if (kind == 4) {
            c.side = c.side == SIDE_BUY ? SIDE_SELL : SIDE_BUY;
        } else if (kind == 5) {
            c.venue = "venue.fixture";
        } else if (kind == 6) {
            t.recipient = address(0xdead);
        } else if (kind == 7) {
            c.executionPrice.atoms = 100e18;
            c.notional.atoms = 1_000e18;
            c.feeTotal.atoms = 3e18;
        } else {
            // M-1: 10.001 tokens is 2000.2 USD, over the 2000 USD bound; declared
            // at 0 decimals it rounds down to exactly the bound.
            c.quantity.atoms = 10.001e18;
            c.notional = Amount({unit: "USD", decimals: 0, atoms: 2_000});
        }
        _script(0, i, t, c.quantity.atoms);
        (bool ok,,) = _submit(m, _signMandate(m), c, t, _signExecution(m, c, t));
        if (ok) maliciousAgentSuccesses += 1;
    }

    /// Byte-identical resubmission of the last settled execution.
    function replayLast() external {
        if (_lastPayload.length == 0) return;
        calls += 1;
        vm.chainId(CHAIN);
        (bool ok,) = address(gate).call(_lastPayload);
        if (ok) replaySuccesses += 1;
    }
}
