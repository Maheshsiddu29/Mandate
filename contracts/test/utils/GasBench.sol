// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Vm} from "forge-std/Vm.sol";

import {MandateExecutionGate} from "../../src/MandateExecutionGate.sol";
import {
    Amount,
    CanonicalAsset,
    Candidate,
    ExecutionTerms,
    Mandate,
    MARKET_FIXTURE,
    MarketConfig,
    Price,
    SIDE_BUY
} from "../../src/MandateTypes.sol";
import {LeanAdapter} from "../mocks/LeanAdapter.sol";
import {MockERC20} from "../mocks/MockTokens.sol";
import {GateTestBase} from "./GateTestBase.sol";

/// @notice Gas benchmark harness (Phase 6R.2A). Measurement only: nothing here
/// changes what the gate accepts, and every measured attempt must settle.
///
/// Method, so a number means the same thing in every benchmark:
///
/// - **Every benchmark gate is deployed in `setUp` with tokens of its own.**
///   Foundry runs each test function as a fresh transaction after `setUp`, so
///   the measured call starts with every account and slot cold and with the
///   SSTORE "original" values a real transaction would see. Because no two
///   gates share a token, measuring several gates in one test function never
///   warms another measurement's state. Deploying inside the test function
///   instead (as `Profile.t.sol` does) makes the gate's own writes and the
///   token mints "dirty" and understates settlement costs.
/// - **Execution gas is the gate's call frame** (`vm.lastCallGas`, identical to
///   the frame figure in a `-vvvv` trace): what a transaction spends after its
///   intrinsic cost, before refunds. Calldata is pre-encoded, so none of the
///   caller's ABI encoding is inside the window.
/// - **Intrinsic gas** is EIP-2028 (21,000 + 16 per non-zero + 4 per zero
///   calldata byte); the EIP-7623 floor (21,000 + 10 per token, a non-zero
///   byte being 4 tokens) is reported beside it but the gate targets Cancun.
/// - **Transaction gas** is intrinsic + execution − refund, the refund capped
///   at a fifth of the total (EIP-3529). Arbitrum's L1 data charge is not
///   modelled.
///
/// Every line a benchmark logs starts with `BENCH|` so the Phase 6R.2A report
/// tables can be regenerated from `forge test -vv` output.
abstract contract GasBench is GateTestBase {
    /// @dev A benchmark world: one gate with one market, with its own tokens.
    struct Bench {
        MandateExecutionGate gate;
        MockERC20 representation;
        MockERC20 fundingToken;
        address adapter;
    }

    /// @dev Everything a profile chooses. Sets must be strictly ascending by
    /// (length, bytes) and contain the market's own value (`_sorted` helps).
    struct Shape {
        CanonicalAsset asset;
        string issuer;
        string venue;
        string quantityUnit;
        string settlementUnit;
        string[] issuers;
        string[] chains;
        string[] venues;
        string evaluationStateId;
        /// @dev Non-zero route data can only settle through `LeanAdapter`
        /// etched at the gate's adapter: `FixtureVenueAdapter` refuses it.
        uint256 routeBytes;
        /// @dev Every free numeric field at its maximum, as `Profile.t.sol`.
        bool maximalNumerics;
    }

    struct Measurement {
        uint256 calldataBytes;
        uint256 zeroBytes;
        uint256 nonZeroBytes;
        uint256 intrinsicGas;
        uint256 floor7623Gas;
        uint256 executionGas;
        uint256 refund;
        uint256 transactionGas;
    }

    uint256 internal constant QUANTITY = 10e18;

    // ------------------------------------------------------------------
    // Identifiers
    // ------------------------------------------------------------------

    /// @dev A `len`-byte identifier: `head`, `x` filler, then a two-digit
    /// `index`, so equal-length identifiers from one head sort by index and
    /// differ only in their last bytes — the most a comparison can scan.
    function _ident(string memory head, uint256 len, uint256 index) internal pure returns (string memory) {
        bytes memory h = bytes(head);
        require(len >= h.length + 2 && len <= 128 && index < 100, "bench: identifier shape");
        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; ++i) {
            out[i] = i < h.length ? h[i] : bytes1("x");
        }
        out[len - 2] = bytes1(uint8(48 + index / 10));
        out[len - 1] = bytes1(uint8(48 + index % 10));
        return string(out);
    }

    /// @dev `count` identifiers of `len` bytes from `head`, ascending.
    function _identSet(string memory head, uint256 len, uint256 count) internal pure returns (string[] memory out) {
        out = new string[](count);
        for (uint256 i = 0; i < count; ++i) {
            out[i] = _ident(head, len, i);
        }
    }

    /// @dev Kernel set order: length, then bytes.
    function _less(string memory a, string memory b) internal pure returns (bool) {
        bytes memory x = bytes(a);
        bytes memory y = bytes(b);
        if (x.length != y.length) return x.length < y.length;
        for (uint256 i = 0; i < x.length; ++i) {
            if (x[i] != y[i]) return uint8(x[i]) < uint8(y[i]);
        }
        return false;
    }

    function _sorted(string[] memory values) internal pure returns (string[] memory) {
        for (uint256 i = 1; i < values.length; ++i) {
            string memory v = values[i];
            uint256 j = i;
            while (j > 0 && _less(v, values[j - 1])) {
                values[j] = values[j - 1];
                --j;
            }
            values[j] = v;
        }
        return values;
    }

    function _list(string memory a) internal pure returns (string[] memory out) {
        out = new string[](1);
        out[0] = a;
    }

    /// @dev Short identifiers of `len` bytes everywhere, one-entry sets: the
    /// sweep baseline every one-variable experiment starts from.
    function _uniformShape(uint256 len) internal pure returns (Shape memory s) {
        s.asset = CanonicalAsset({
            assetClass: _ident("cls", len, 0), idScheme: _ident("sch", len, 0), value: _ident("val", len, 0)
        });
        s.issuer = _ident("iss", len, 0);
        s.venue = _ident("ven", len, 0);
        s.quantityUnit = _ident("qun", len, 0);
        s.settlementUnit = _ident("sun", len, 0);
        s.issuers = _list(s.issuer);
        s.chains = _list(CHAIN_ID_STRING);
        s.venues = _list(s.venue);
        s.evaluationStateId = _ident("sta", len, 0);
    }

    // ------------------------------------------------------------------
    // Worlds
    // ------------------------------------------------------------------

    function _marketFor(Shape memory s, address representation, address fundingToken)
        internal
        pure
        returns (MarketConfig memory)
    {
        return MarketConfig({
            representation: representation,
            fundingToken: fundingToken,
            canonicalAsset: s.asset,
            issuer: s.issuer,
            venue: s.venue,
            quantityUnit: s.quantityUnit,
            settlementUnit: s.settlementUnit,
            synthetic: false,
            classification: MARKET_FIXTURE,
            fixturePrice: Price({
                numeratorUnit: s.settlementUnit, denominatorUnit: s.quantityUnit, decimals: 6, atoms: AAPL_PRICE
            }),
            fixtureFeeBps: FEE_BPS
        });
    }

    /// @dev Call from `setUp` only (see the contract notes).
    function _deployBench(Shape memory s) internal returns (Bench memory b) {
        MarketConfig[] memory markets = new MarketConfig[](1);
        b.representation = new MockERC20("Bench Stock Token", "bSTK", 18);
        b.fundingToken = new MockERC20("Bench USD", "bUSD", 6);
        markets[0] = _marketFor(s, address(b.representation), address(b.fundingToken));
        b.gate = new MandateExecutionGate(markets);
        _stockBench(b, s.routeBytes != 0);
    }

    /// @dev Inventory for the gate-created venue (or, for route data, a lean
    /// adapter etched at the gate-created adapter), and a funded, approving principal.
    function _stockBench(Bench memory b, bool lean) internal {
        b.adapter = b.gate.marketOf(_keyOf(address(b.representation))).adapter;
        if (lean) {
            vm.etch(b.adapter, address(new LeanAdapter(4e6)).code);
            b.representation.mint(b.adapter, 1_000e18);
        } else {
            address venue = b.gate.fixtureVenueOf(_keyOf(address(b.representation)));
            b.representation.mint(venue, 1_000_000e18);
            b.fundingToken.mint(venue, 1_000_000_000e6);
        }
        b.representation.mint(principal, 1_000e18);
        b.fundingToken.mint(principal, 1_000_000e6);
        vm.startPrank(principal);
        b.representation.approve(address(b.gate), type(uint256).max);
        b.fundingToken.approve(address(b.gate), type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Attempts
    // ------------------------------------------------------------------

    /// @dev BUY or SELL 10 tokens at 200 USD, 30 bps fee, as `GateTestBase`,
    /// but spelled in the shape's identifiers.
    function _attempt(Shape memory s, Bench memory b, uint8 side)
        internal
        view
        returns (Mandate memory m, Candidate memory c, ExecutionTerms memory t)
    {
        bool buy = side == SIDE_BUY;
        m = buy ? _mandate() : _sellMandate();
        m.canonicalAsset = s.asset;
        m.maxNotional.unit = s.settlementUnit;
        m.economicLimit.unit = s.settlementUnit;
        m.allowedIssuers = s.issuers;
        m.allowedChains = s.chains;
        m.allowedVenues = s.venues;

        c = _candidateFor(address(b.representation), side);
        c.canonicalAsset = s.asset;
        c.issuer = s.issuer;
        c.venue = s.venue;
        c.quantity.unit = s.quantityUnit;
        c.executionPrice.numeratorUnit = s.settlementUnit;
        c.executionPrice.denominatorUnit = s.quantityUnit;
        c.notional.unit = s.settlementUnit;
        c.feeTotal.unit = s.settlementUnit;
        c.evaluationStateId = s.evaluationStateId;

        t = buy ? _terms() : _sellTerms();
        if (s.routeBytes != 0) {
            t.executionData = new bytes(s.routeBytes);
            for (uint256 i = 0; i < s.routeBytes; ++i) {
                t.executionData[i] = 0xff;
            }
        }
        if (s.maximalNumerics) {
            require(buy, "bench: maximal numerics are a BUY profile");
            m.mandateId = bytes32(type(uint256).max);
            m.nonce = type(uint64).max;
            m.maxNotional = Amount({unit: s.settlementUnit, decimals: 0, atoms: type(uint256).max});
            m.economicLimit = Amount({unit: s.settlementUnit, decimals: 0, atoms: type(uint256).max});
            m.requiredCorporateActionEpoch = type(uint64).max;
            m.maxPriceAgeSeconds = type(uint32).max;
            m.maxCorporateActionAgeSeconds = type(uint32).max;
            c.evaluationStateDigest = bytes32(type(uint256).max);
            c.registrySnapshotDigest = bytes32(type(uint256).max);
            c.corporateActionEpoch = type(uint64).max;
            t.deadline = type(uint64).max;
        }
    }

    function _calldataFor(MandateExecutionGate g, Mandate memory m, Candidate memory c, ExecutionTerms memory t)
        internal
        view
        returns (bytes memory)
    {
        bytes32 domain = g.domainSeparator();
        bytes32 mandateStruct = keccak256(abi.encode(g.MANDATE_AUTHORIZATION_TYPEHASH(), harness.mandateDigest(m)));
        bytes memory ps = _sign(PRINCIPAL_KEY, keccak256(abi.encodePacked(hex"1901", domain, mandateStruct)));
        bytes32 commitment = keccak256(
            abi.encode(
                g.EXECUTION_AUTHORIZATION_TYPEHASH(),
                harness.mandateDigest(m),
                harness.candidateDigest(c),
                t.recipient,
                t.fundingLimit,
                t.deadline,
                keccak256(t.executionData)
            )
        );
        bytes memory as_ = _sign(AGENT_KEY, keccak256(abi.encodePacked(hex"1901", domain, commitment)));
        return abi.encodeCall(MandateExecutionGate.execute, (m, ps, c, t, as_));
    }

    /// @notice Sign honestly, execute once, require settlement, measure.
    function _measure(MandateExecutionGate g, Mandate memory m, Candidate memory c, ExecutionTerms memory t)
        internal
        returns (Measurement memory r)
    {
        bytes memory data = _calldataFor(g, m, c, t);
        r = _calldataCost(data);
        (bool ok, bytes memory ret) = address(g).call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        Vm.Gas memory used = vm.lastCallGas();
        r.executionGas = used.gasTotalUsed;
        r.refund = used.gasRefunded > 0 ? uint256(int256(used.gasRefunded)) : 0;
        uint256 gross = r.intrinsicGas + r.executionGas;
        uint256 refund = r.refund < gross / 5 ? r.refund : gross / 5;
        r.transactionGas = gross - refund;
    }

    function _calldataCost(bytes memory data) internal pure returns (Measurement memory r) {
        r.calldataBytes = data.length;
        for (uint256 i = 0; i < data.length; ++i) {
            if (data[i] == 0) ++r.zeroBytes;
        }
        r.nonZeroBytes = data.length - r.zeroBytes;
        r.intrinsicGas = 21_000 + 16 * r.nonZeroBytes + 4 * r.zeroBytes;
        r.floor7623Gas = 21_000 + 10 * (r.zeroBytes + 4 * r.nonZeroBytes);
    }

    function _measureShape(Shape memory s, Bench memory b, uint8 side) internal returns (Measurement memory) {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = _attempt(s, b, side);
        return _measure(b.gate, m, c, t);
    }

    // ------------------------------------------------------------------
    // Reporting
    // ------------------------------------------------------------------

    /// @dev `BENCH|<experiment>|<point>|calldata|zero|nonzero|intrinsic|floor7623|execution|refund|transaction`
    function _log(string memory experiment, string memory point, Measurement memory r) internal {
        // Built a field pair at a time: one nested concat of every field is
        // too deep for the via-IR stack in some compilation units.
        string memory line = string.concat("BENCH|", experiment, "|", point);
        line = string.concat(line, "|", vm.toString(r.calldataBytes), "|", vm.toString(r.zeroBytes));
        line = string.concat(line, "|", vm.toString(r.nonZeroBytes), "|", vm.toString(r.intrinsicGas));
        line = string.concat(line, "|", vm.toString(r.floor7623Gas), "|", vm.toString(r.executionGas));
        line = string.concat(line, "|", vm.toString(r.refund), "|", vm.toString(r.transactionGas));
        emit log(line);
    }

    function _logValue(string memory experiment, string memory point, uint256 value) internal {
        emit log(string.concat("BENCH|", experiment, "|", point, "|", vm.toString(value)));
    }
}
