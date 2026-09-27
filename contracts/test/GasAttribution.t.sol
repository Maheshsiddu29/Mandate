// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {MandateExecutionGate} from "../src/MandateExecutionGate.sol";
import {Candidate, CanonicalAsset, ExecutionTerms, Mandate, MarketConfig, SIDE_BUY} from "../src/MandateTypes.sol";
import {FixtureVenue} from "../src/fixture/FixtureVenue.sol";
import {FixtureVenueAdapter} from "../src/fixture/FixtureVenueAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MockERC20} from "./mocks/MockTokens.sol";
import {CodecBenchHarness} from "./utils/CodecBenchHarness.sol";
import {GasBench} from "./utils/GasBench.sol";

/// @notice Isolated codec operations (docs/phase-6r2a-gas-profile.md §G–J):
/// the gas of one operation is its harness frame minus the frame of a no-op
/// with the same calldata. Identifiers follow the sweep pattern (a head, `x`
/// filler, a two-digit index), so a comparison of two equal-length entries
/// scans to their last bytes, as in the worst-case profile.
contract CodecOperationBench is Test {
    CodecBenchHarness internal h;
    uint256[6] internal LENGTHS = [uint256(8), 16, 32, 64, 96, 128];
    uint256[5] internal COUNTS = [uint256(1), 2, 4, 8, 16];

    function setUp() public {
        h = new CodecBenchHarness();
    }

    function _ident(uint256 len, uint256 index) internal pure returns (string memory) {
        bytes memory out = new bytes(len);
        out[0] = "i";
        for (uint256 i = 1; i < len - 2; ++i) {
            out[i] = "x";
        }
        out[len - 2] = bytes1(uint8(48 + index / 10));
        out[len - 1] = bytes1(uint8(48 + index % 10));
        return string(out);
    }

    function _set(uint256 len, uint256 count) internal pure returns (string[] memory out) {
        out = new string[](count);
        for (uint256 i = 0; i < count; ++i) {
            out[i] = _ident(len, i);
        }
    }

    function _frame(bytes memory data) internal returns (uint256) {
        (bool ok,) = address(h).call(data);
        require(ok, "bench: harness call failed");
        return vm.lastCallGas().gasTotalUsed;
    }

    /// @dev Operation frame minus no-op frame.
    function _op(bytes memory data, bytes memory baseline) internal returns (uint256) {
        return _frame(data) - _frame(baseline);
    }

    function _log(string memory op, string memory point, uint256 gas_) internal {
        emit log(string.concat("BENCH|codec.", op, "|", point, "|", vm.toString(gas_)));
    }

    function test_codec_perIdentifierOperations() public {
        for (uint256 i = 0; i < LENGTHS.length; ++i) {
            string memory s = _ident(LENGTHS[i], 0);
            string memory t = _ident(LENGTHS[i], 1);
            bytes memory noop = abi.encodeCall(h.noopString, (s));
            string memory len = vm.toString(LENGTHS[i]);
            _log("isIdentifier", len, _op(abi.encodeCall(h.isIdentifier, (s)), noop));
            _log("copyCalldataToMemory", len, _op(abi.encodeCall(h.copyString, (s)), noop));
            _log("keccak", len, _op(abi.encodeCall(h.hashString, (s)), noop));
            _log("encodeString", len, _op(abi.encodeCall(h.encodeString, (s)), noop));
            _log(
                "compareEqualLength",
                len,
                _op(abi.encodeCall(h.compareStrings, (s, t)), abi.encodeCall(h.noopPair, (s, t)))
            );
        }
    }

    function test_codec_setOperations() public {
        uint256[2] memory lens = [uint256(16), 128];
        for (uint256 l = 0; l < lens.length; ++l) {
            for (uint256 i = 0; i < COUNTS.length; ++i) {
                string[] memory values = _set(lens[l], COUNTS[i]);
                bytes memory noop = abi.encodeCall(h.noopSet, (values));
                string memory point = string.concat(vm.toString(COUNTS[i]), "x", vm.toString(lens[l]));
                _log("setValidate", point, _op(abi.encodeCall(h.isIdentifierSet, (values)), noop));
                _log("setEncode", point, _op(abi.encodeCall(h.encodeIdentifierSet, (values)), noop));
                _log("setEncodeAndHash", point, _op(abi.encodeCall(h.hashEncodedSet, (values)), noop));
                _log("setSearchLast", point, _op(abi.encodeCall(h.containsLast, (values)), noop));
            }
        }
    }

    /// @notice Validation cost depends on which characters an identifier holds,
    /// not only on its length: the character test short-circuits, and digits
    /// are tested first. Hex addresses inside representation identifiers make
    /// the same attempt cost a few hundred gas more or less per token address.
    function test_codec_validationCostDependsOnCharacterClass() public {
        bytes1[5] memory fill = [bytes1("0"), bytes1("A"), bytes1("a"), bytes1("x"), bytes1("f")];
        string[5] memory names = ["digits", "upper", "lower-a", "lower-x", "hex-f"];
        for (uint256 k = 0; k < fill.length; ++k) {
            bytes memory b = new bytes(64);
            for (uint256 i = 0; i < 64; ++i) {
                b[i] = fill[k];
            }
            string memory s = string(b);
            _log(
                "isIdentifier64", names[k], _op(abi.encodeCall(h.isIdentifier, (s)), abi.encodeCall(h.noopString, (s)))
            );
        }
    }

    function test_codec_fixedSizeOperations() public {
        address party = address(0x2c7536E3605D9C16a7a3D7b1898e529396a65c23);
        _log(
            "encodeParty",
            "address",
            _op(abi.encodeCall(h.encodeParty, (party)), abi.encodeCall(h.noopAddress, (party)))
        );
        CanonicalAsset memory asset = CanonicalAsset({assetClass: "equity", idScheme: "isin", value: "US0378331005"});
        _log("assetHash", "AAPL", _op(abi.encodeCall(h.assetHash, (asset)), abi.encodeCall(h.noopAsset, (asset))));
    }
}

/// @notice Execution against gates configured with 1–16 markets, always the
/// same target market spelled like the `GateTestBase` AAPL market (§K).
contract MarketCountExecutionBench is GasBench {
    uint256[5] internal COUNTS = [uint256(1), 2, 4, 8, 16];
    Bench[5] internal benches;

    function _normalShape() internal pure returns (Shape memory s) {
        s.asset = _aaplAsset();
        s.issuer = "issuer.alpha";
        s.venue = "venue.fixture";
        s.quantityUnit = "TOKEN";
        s.settlementUnit = "USD";
        s.issuers = _list(s.issuer);
        s.chains = _list(CHAIN_ID_STRING);
        s.venues = new string[](2);
        s.venues[0] = "venue.fixture";
        s.venues[1] = "venue.scripted";
        s.evaluationStateId = "state.fixture.0001";
    }

    function setUp() public override {
        super.setUp();
        Shape memory s = _normalShape();
        for (uint256 i = 0; i < COUNTS.length; ++i) {
            Bench memory b;
            b.representation = new MockERC20("Bench Stock Token", "bSTK", 18);
            b.fundingToken = new MockERC20("Bench USD", "bUSD", 6);
            MarketConfig[] memory markets = new MarketConfig[](COUNTS[i]);
            markets[0] = _marketFor(s, address(b.representation), address(b.fundingToken));
            for (uint256 m = 1; m < COUNTS[i]; ++m) {
                markets[m] = _marketFor(s, address(new MockERC20("Filler", "FIL", 18)), address(b.fundingToken));
            }
            b.gate = new MandateExecutionGate(markets);
            _stockBench(b, false);
            benches[i] = b;
        }
    }

    function test_marketCountDoesNotChangeExecutionGas() public {
        Shape memory s = _normalShape();
        uint256 first;
        for (uint256 i = 0; i < COUNTS.length; ++i) {
            Measurement memory r = _measureShape(s, benches[i], SIDE_BUY);
            _log("marketCount", vm.toString(COUNTS[i]), r);
            if (i == 0) first = r.executionGas;
            // Lookup is one mapping read: the market count must not matter. The
            // residue is the representation identifier's hex characters, which
            // differ per token address (test_codec_validationCostDependsOnCharacterClass).
            assertApproxEqAbs(r.executionGas, first, 1_500, "execution gas must not depend on the market count");
        }
    }

    /// @notice Which storage an execution touches: the gate's market record,
    /// replay slot and reentrancy flag, and the tokens' balance/allowance slots.
    function test_storageAccessesOfOneExecution() public {
        Shape memory s = _normalShape();
        Bench memory b = benches[0];
        address venue = b.gate.fixtureVenueOf(_keyOf(address(b.representation)));
        (bytes memory data) = _attemptCalldata(s, b);
        vm.record();
        (bool ok,) = address(b.gate).call(data);
        assertTrue(ok);
        (bytes32[] memory gateReads, bytes32[] memory gateWrites) = vm.accesses(address(b.gate));
        (bytes32[] memory fundReads, bytes32[] memory fundWrites) = vm.accesses(address(b.fundingToken));
        (bytes32[] memory repReads, bytes32[] memory repWrites) = vm.accesses(address(b.representation));
        (bytes32[] memory venueReads,) = vm.accesses(venue);
        (bytes32[] memory adapterReads,) = vm.accesses(b.adapter);
        _logValue("storage", "gate reads", gateReads.length);
        _logValue("storage", "gate writes", gateWrites.length);
        _logValue("storage", "gate distinct slots read", _distinct(gateReads));
        _logValue("storage", "funding token reads", fundReads.length);
        _logValue("storage", "funding token writes", fundWrites.length);
        _logValue("storage", "funding token distinct slots", _distinct(fundReads));
        _logValue("storage", "representation reads", repReads.length);
        _logValue("storage", "representation writes", repWrites.length);
        _logValue("storage", "representation distinct slots", _distinct(repReads));
        _logValue("storage", "venue reads", venueReads.length);
        _logValue("storage", "adapter reads", adapterReads.length);
        // At HEAD: the 10-slot market record, the replay key and the reentrancy
        // flag are read; the replay key is written once and the flag twice.
        assertGt(gateWrites.length, 0, "a settlement must write its replay record");
    }

    function _attemptCalldata(Shape memory s, Bench memory b) internal view returns (bytes memory) {
        (Mandate memory m, Candidate memory c, ExecutionTerms memory t) = _attempt(s, b, SIDE_BUY);
        return _calldataFor(b.gate, m, c, t);
    }

    function _distinct(bytes32[] memory slots) internal pure returns (uint256 n) {
        for (uint256 i = 0; i < slots.length; ++i) {
            bool seen;
            for (uint256 j = 0; j < i; ++j) {
                if (slots[j] == slots[i]) seen = true;
            }
            if (!seen) ++n;
        }
    }
}

/// @notice Deployment gas by market count, and its per-market parts (§R).
///
/// The model is Phase 6R.1b's: the CREATE frame measured here (CREATE's 32,000,
/// the EIP-3860 initcode word charge, constructor execution and code deposit)
/// plus 21,000 and EIP-2028 calldata gas for initcode and constructor arguments.
/// The initcode is assembled before the measured window, so none of the test's
/// own ABI encoding is inside it, and every token is cooled first so its
/// `decimals()` read is priced as a real deployment's cold read.
contract DeploymentBench is GasBench {
    uint256[10] internal COUNTS = [uint256(1), 2, 4, 8, 12, 16, 24, 25, 26, 32];

    function _configs(uint256 n) internal returns (MarketConfig[] memory markets) {
        markets = new MarketConfig[](n);
        for (uint256 i = 0; i < n; ++i) {
            MockERC20 token = new MockERC20("Fixture", "FX", 18);
            markets[i] = _market(address(token), _aaplAsset(), "issuer.alpha", "venue.fixture", false);
            vm.cool(address(token));
        }
        vm.cool(address(funding));
    }

    function _create(bytes memory initcode) internal returns (address deployed, uint256 used) {
        uint256 before = gasleft();
        assembly ("memory-safe") {
            deployed := create(0, add(initcode, 0x20), mload(initcode))
        }
        used = before - gasleft();
        require(deployed != address(0), "bench: create failed");
    }

    function _intrinsic(bytes memory data) internal pure returns (uint256) {
        return _calldataCost(data).intrinsicGas;
    }

    function test_deploymentGasByMarketCount() public {
        uint256 previous;
        for (uint256 i = 0; i < COUNTS.length; ++i) {
            bytes memory initcode =
                abi.encodePacked(type(MandateExecutionGate).creationCode, abi.encode(_configs(COUNTS[i])));
            (, uint256 createGas) = _create(initcode);
            uint256 total = createGas + _intrinsic(initcode);
            string memory n = vm.toString(COUNTS[i]);
            _logValue("deploy.initcodeBytes", n, initcode.length);
            _logValue("deploy.createFrame", n, createGas);
            _logValue("deploy.intrinsic", n, _intrinsic(initcode));
            _logValue("deploy.total", n, total);
            if (i > 0) {
                _logValue("deploy.perMarket", n, (total - previous) / (COUNTS[i] - COUNTS[i - 1]));
            }
            previous = total;
        }
    }

    /// @notice The contracts a market adds, created on their own: what each
    /// costs to create (CREATE, execution and code deposit) and its code size.
    function test_deploymentPartsOfOneMarket() public {
        MockERC20 token = new MockERC20("Fixture", "FX", 18);
        (address venue, uint256 venueGas) = _create(
            abi.encodePacked(
                type(FixtureVenue).creationCode,
                abi.encode(IERC20(address(token)), IERC20(address(funding)), uint8(18), uint8(6), 200e6, FEE_BPS)
            )
        );
        (address adapter, uint256 adapterGas) =
            _create(abi.encodePacked(type(FixtureVenueAdapter).creationCode, abi.encode(address(this), venue)));
        _logValue("deploy.part", "FixtureVenue create", venueGas);
        _logValue("deploy.part", "FixtureVenue runtime bytes", venue.code.length);
        _logValue("deploy.part", "FixtureVenueAdapter create", adapterGas);
        _logValue("deploy.part", "FixtureVenueAdapter runtime bytes", adapter.code.length);
        _logValue("deploy.part", "gate runtime bytes", address(gate).code.length);
        _logValue("deploy.part", "gate initcode bytes", type(MandateExecutionGate).creationCode.length);

        // Storage the constructor writes for one market.
        MarketConfig[] memory one = _configs(1);
        vm.record();
        MandateExecutionGate g = new MandateExecutionGate(one);
        (, bytes32[] memory writes) = vm.accesses(address(g));
        _logValue("deploy.part", "gate SSTOREs, one-market constructor", writes.length);
        uint256 distinct;
        for (uint256 i = 0; i < writes.length; ++i) {
            bool seen;
            for (uint256 j = 0; j < i; ++j) {
                if (writes[j] == writes[i]) seen = true;
            }
            if (!seen) ++distinct;
        }
        _logValue("deploy.part", "gate distinct slots written, one-market constructor", distinct);
    }
}
