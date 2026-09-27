// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test, Vm} from "forge-std/Test.sol";

import {MandateExecutionGate} from "../src/MandateExecutionGate.sol";
import {
    CanonicalAsset,
    Candidate,
    ExecutionTerms,
    Mandate,
    MarketConfig,
    MARKET_FIXTURE,
    Price
} from "../src/MandateTypes.sol";
import {MandateCodec} from "../src/libraries/MandateCodec.sol";
import {MockERC20} from "./mocks/MockTokens.sol";
import {ScriptedAdapter} from "./mocks/ScriptedAdapter.sol";
import {CodecHarness} from "./utils/CodecHarness.sol";
import {EncodingHarness} from "./utils/EncodingHarness.sol";

/// @notice TypeScript ↔ Solidity differential test over `corpus/gate-v1`.
///
/// Every expected value was computed by the TypeScript side: the kernel's
/// encoder, decoder and signature rule, and the reference model in
/// `packages/execution-gate/src/model.ts`. This harness deploys the same world at
/// the same addresses and asserts the Solidity gate agrees on every digest,
/// every execution commitment, every settled amount and the exact revert data of
/// every refusal — including OpenZeppelin token errors and adapter errors that
/// surface through the gate.
///
/// The ABI form is written by `npm run gate-corpus:generate` in the same run that
/// writes the committed readable corpus; `corpus.test.ts` and
/// `npm run generated:check` pin that corpus to its generator.
contract DifferentialTest is Test {
    struct TokenSetup {
        address token;
        uint256 principalBalance;
        uint256 gateAllowance;
        uint256 adapterAllowance;
        uint8 decimals;
    }

    struct Script {
        uint8 mode;
        uint256 deliver;
        uint256 refund;
        bool deliverElsewhere;
        uint256 extraPull;
    }

    struct Expected {
        bool settled;
        bytes revertData;
        bytes32 mandateDigest;
        bytes32 candidateDigest;
        bytes32 executionCommitment;
        uint256 debit;
        uint256 credit;
    }

    struct Attempt {
        uint256 chainId;
        uint256 timestamp;
        Mandate mandate;
        bytes principalSignature;
        Candidate candidate;
        ExecutionTerms terms;
        bytes agentSignature;
        Script script;
        Expected expected;
    }

    struct GateVector {
        string id;
        TokenSetup[] setup;
        Attempt[] attempts;
    }

    struct MandateEncoding {
        string id;
        Mandate mandate;
        uint8 validity;
        bytes32 digest;
    }

    struct CandidateEncoding {
        string id;
        Candidate candidate;
        bool valid;
        bytes32 digest;
    }

    string internal constant ABI_PATH = "contracts/generated/gate-v1.abi.json";
    uint256 internal constant CHAIN = 46_630;

    // Addresses fixed by packages/execution-gate/test/support/world.ts.
    address internal constant GATE = address(0xa7e0);
    /// @dev The adapters the gate creates for markets 0..3, as `world.ts` computes
    /// them (`marketAdapter`): the gate's CREATEs 2, 4, 6 and 8.
    address internal constant ADAPTER_AAPL = 0xe3Fe4b532e6608f851C52d0F1E4fB3707Ee4474E;
    address internal constant ADAPTER_NVDA = 0x4503e80954976c37929ad5324490dC65bdAAf312;
    address internal constant ADAPTER_SYNTH = 0xCa70C389B15D4B0Ab15cA5e5B6262dB0114886cb;
    address internal constant ADAPTER_EIGHT = 0xF87aF03Cd93664E8f91F5F1e59d9056dA760B142;
    address internal constant FUNDING6 = address(0xf006);
    address internal constant FUNDING18 = address(0xf018);
    address internal constant AAPL = address(0xaa01);
    address internal constant NVDA = address(0xaa02);
    address internal constant SYNTH = address(0xaa03);
    address internal constant EIGHT = address(0xaa08);
    address internal constant SINK = address(0xdead);
    uint256 internal constant PRINCIPAL_KEY = 0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318;

    bytes32 internal constant EXECUTED_TOPIC = keccak256(
        "MandateExecuted(bytes32,bytes32,address,bytes32,address,address,address,address,uint8,uint256,uint256)"
    );

    address internal principal;
    MandateExecutionGate internal gate;
    address[4] internal adapters;
    CodecHarness internal harness;
    /// @dev Phase 6R.2B: every corpus mandate and candidate is also encoded by
    /// the pre-optimization encoder, and the bytes must be identical.
    EncodingHarness internal encodings;

    function setUp() public {
        vm.chainId(CHAIN);
        principal = vm.addr(PRINCIPAL_KEY);
        harness = new CodecHarness();
        encodings = new EncodingHarness();

        _token(FUNDING6, "Fixture USD Coin", "fUSDC", 6);
        _token(FUNDING18, "Fixture USD 18", "fUSD18", 18);
        _token(AAPL, "Fixture Apple Stock Token", "fAAPL", 18);
        _token(NVDA, "Fixture NVIDIA Stock Token", "fNVDA", 18);
        _token(SYNTH, "Fixture Synthetic Apple", "sAAPL", 18);
        _token(EIGHT, "Fixture Apple 8dp", "fAAPL8", 8);
        MarketConfig[] memory markets = new MarketConfig[](4);
        markets[0] = _market(AAPL, FUNDING6, _asset("US0378331005"), "issuer.alpha", "venue.fixture", false);
        markets[1] = _market(NVDA, FUNDING6, _asset("US67066G1040"), "issuer.alpha", "venue.fixture", false);
        markets[2] = _market(SYNTH, FUNDING6, _asset("US0378331005"), "issuer.synthetic", "venue.fixture", true);
        markets[3] = _market(EIGHT, FUNDING18, _asset("US0378331005"), "issuer.alpha", "venue.other", false);
        _deployGateAt(abi.encode(markets));
        gate = MandateExecutionGate(GATE);

        // The gate created each market's adapter; both sides must name the same one.
        adapters = [ADAPTER_AAPL, ADAPTER_NVDA, ADAPTER_SYNTH, ADAPTER_EIGHT];
        address[4] memory representations = [AAPL, NVDA, SYNTH, EIGHT];
        address[6] memory tokens = [FUNDING6, FUNDING18, AAPL, NVDA, SYNTH, EIGHT];
        address scriptedCode = address(new ScriptedAdapter());
        for (uint256 i = 0; i < adapters.length; ++i) {
            assertEq(vm.computeCreateAddress(GATE, 2 * i + 2), adapters[i], "world.ts adapter derivation");
            assertEq(
                gate.marketOf(keccak256(bytes(MandateCodec.representationId(CHAIN, representations[i])))).adapter,
                adapters[i],
                "gate-created adapter address"
            );
            // Test cheat: the scripted double replaces the fixture adapter's code, so
            // this world can exercise every adapter behaviour the gate must survive.
            vm.etch(adapters[i], scriptedCode.code);
            for (uint256 j = 0; j < tokens.length; ++j) {
                MockERC20(tokens[j]).mint(adapters[i], 1e40);
            }
        }
    }

    /// @dev `deployCodeTo`, but with the account nonce a CREATE would give the new
    /// contract (1, EIP-161), so the gate's own CREATEs land where `world.ts` expects.
    function _deployGateAt(bytes memory args) internal {
        vm.etch(GATE, abi.encodePacked(vm.getCode("MandateExecutionGate.sol:MandateExecutionGate"), args));
        vm.setNonce(GATE, 1);
        (bool ok, bytes memory runtime) = GATE.call("");
        require(ok, "gate construction failed");
        vm.etch(GATE, runtime);
    }

    /// @dev Read per test, never stored: the ABI corpus is megabytes.
    function _section(string memory key) internal view returns (bytes[] memory) {
        if (!vm.exists(ABI_PATH)) revert("corpus ABI missing: run `npm run gate-corpus:generate` first");
        return vm.parseJsonBytesArray(vm.readFile(ABI_PATH), key);
    }

    function _token(address where, string memory name, string memory symbol, uint8 decimals) internal {
        deployCodeTo("MockTokens.sol:MockERC20", abi.encode(name, symbol, decimals), where);
    }

    function _asset(string memory value) internal pure returns (CanonicalAsset memory) {
        return CanonicalAsset({assetClass: "equity", idScheme: "isin", value: value});
    }

    function _market(
        address token,
        address funding,
        CanonicalAsset memory asset,
        string memory issuer,
        string memory venue,
        bool synthetic
    ) internal pure returns (MarketConfig memory) {
        uint256 fixturePrice = token == NVDA ? 100e18 : 200e18;
        return MarketConfig({
            representation: token,
            fundingToken: funding,
            canonicalAsset: asset,
            issuer: issuer,
            venue: venue,
            quantityUnit: "TOKEN",
            settlementUnit: "USD",
            synthetic: synthetic,
            classification: MARKET_FIXTURE,
            fixturePrice: Price({numeratorUnit: "USD", denominatorUnit: "TOKEN", decimals: 18, atoms: fixturePrice}),
            fixtureFeeBps: 30
        });
    }

    // ------------------------------------------------------------------
    // Execution vectors
    // ------------------------------------------------------------------

    function test_differential_executionVectors() public {
        bytes[] memory blobs = _section(".vectors");
        assertGt(blobs.length, 0, "empty corpus");
        uint256 settled;
        uint256 reverted;
        for (uint256 i = 0; i < blobs.length; ++i) {
            GateVector memory v = abi.decode(blobs[i], (GateVector));
            uint256 snapshot = vm.snapshotState();
            (uint256 s, uint256 r) = _replay(v);
            settled += s;
            reverted += r;
            vm.revertToState(snapshot);
        }
        emit log_named_uint("vectors", blobs.length);
        emit log_named_uint("settled attempts agreed", settled);
        emit log_named_uint("reverted attempts agreed", reverted);
    }

    function test_differential_actualKernelRejectAuthorityVectors() public {
        bytes[] memory blobs = _section(".authorityVectors");
        assertGt(blobs.length, 0, "empty authority corpus");
        uint256 reverted;
        for (uint256 i = 0; i < blobs.length; ++i) {
            GateVector memory v = abi.decode(blobs[i], (GateVector));
            uint256 snapshot = vm.snapshotState();
            (uint256 settled, uint256 refused) = _replay(v);
            assertEq(settled, 0, string.concat(v.id, ": kernel REJECT settled"));
            reverted += refused;
            vm.revertToState(snapshot);
        }
        emit log_named_uint("malicious-agent/kernel-reject attempts", reverted);
    }

    function _replay(GateVector memory v) internal returns (uint256 settled, uint256 reverted) {
        for (uint256 i = 0; i < v.setup.length; ++i) {
            TokenSetup memory t = v.setup[i];
            MockERC20(t.token).mint(principal, t.principalBalance);
            vm.startPrank(principal);
            MockERC20(t.token).approve(GATE, t.gateAllowance);
            for (uint256 k = 0; k < adapters.length; ++k) {
                MockERC20(t.token).approve(adapters[k], t.adapterAllowance);
            }
            vm.stopPrank();
            MockERC20(t.token).setDecimals(t.decimals);
        }
        for (uint256 j = 0; j < v.attempts.length; ++j) {
            if (_attempt(v.id, j, v.attempts[j])) settled += 1;
            else reverted += 1;
        }
    }

    function _attempt(string memory id, uint256 index, Attempt memory a) internal returns (bool) {
        string memory label = string.concat(id, "#", vm.toString(index));
        _assertEncodingsAgree(label, a.mandate, a.candidate);
        vm.chainId(a.chainId);
        vm.warp(a.timestamp);
        // The script applies to the adapter of the market the candidate names; an
        // unsupported representation reaches no adapter at all.
        address marketAdapter = gate.marketOf(keccak256(bytes(a.candidate.representationId))).adapter;
        if (marketAdapter == address(0)) marketAdapter = adapters[0];
        ScriptedAdapter(marketAdapter)
            .setScript(
                ScriptedAdapter.Script({
                mode: ScriptedAdapter.Mode(a.script.mode),
                deliver: a.script.deliver,
                refund: a.script.refund,
                deliverTo: a.script.deliverElsewhere ? SINK : address(0),
                reentryTarget: address(0),
                reentryPayload: "",
                bubbleReentry: false,
                extraPull: a.script.extraPull
            })
            );

        vm.recordLogs();
        bool settled;
        try gate.execute(a.mandate, a.principalSignature, a.candidate, a.terms, a.agentSignature) returns (
            bytes32 commitment, uint256 debit, uint256 credit
        ) {
            settled = true;
            assertTrue(a.expected.settled, string.concat(label, ": Solidity settled, TypeScript reverted"));
            assertEq(commitment, a.expected.executionCommitment, string.concat(label, ": execution commitment"));
            assertEq(debit, a.expected.debit, string.concat(label, ": debit"));
            assertEq(credit, a.expected.credit, string.concat(label, ": credit"));
            assertEq(
                gate.executionCommitmentOf(a.expected.mandateDigest),
                commitment,
                string.concat(label, ": mandate digest keys the consumed commitment")
            );
            _assertEvent(label, a.expected);
        } catch (bytes memory reason) {
            assertFalse(a.expected.settled, string.concat(label, ": Solidity reverted, TypeScript settled"));
            assertEq(reason, a.expected.revertData, string.concat(label, ": revert data"));
        }
        vm.chainId(CHAIN);
        return settled;
    }

    function _assertEvent(string memory label, Expected memory e) internal view {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 found;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != GATE || logs[i].topics[0] != EXECUTED_TOPIC) continue;
            found += 1;
            assertEq(logs[i].topics[1], e.mandateDigest, string.concat(label, ": event mandate digest"));
            assertEq(logs[i].topics[2], e.executionCommitment, string.concat(label, ": event commitment"));
            (bytes32 candidateDigest,,,,,, uint256 debit, uint256 credit) =
                abi.decode(logs[i].data, (bytes32, address, address, address, address, uint8, uint256, uint256));
            assertEq(candidateDigest, e.candidateDigest, string.concat(label, ": event candidate digest"));
            assertEq(debit, e.debit, string.concat(label, ": event debit"));
            assertEq(credit, e.credit, string.concat(label, ": event credit"));
        }
        assertEq(found, 1, string.concat(label, ": exactly one MandateExecuted"));
    }

    // ------------------------------------------------------------------
    // Encoding and structural-validation vectors
    // ------------------------------------------------------------------

    /// @dev Production and pre-optimization encoders produce the same bytes —
    /// not just the same digest — for this mandate and candidate, valid or not.
    function _assertEncodingsAgree(string memory label, Mandate memory m, Candidate memory c) internal view {
        (bytes memory referenceMandate, bytes memory mandateBytes) = encodings.mandate(m);
        assertEq(mandateBytes, referenceMandate, string.concat(label, ": MCE v2 bytes"));
        (bytes memory referenceCandidate, bytes memory candidateBytes) = encodings.candidate(c);
        assertEq(candidateBytes, referenceCandidate, string.concat(label, ": Candidate V3 bytes"));
    }

    function test_differential_mandateEncodings() public view {
        bytes[] memory blobs = _section(".mandateEncodings");
        assertGt(blobs.length, 0, "empty mandate encodings");
        for (uint256 i = 0; i < blobs.length; ++i) {
            MandateEncoding memory e = abi.decode(blobs[i], (MandateEncoding));
            (bytes memory referenceBytes, bytes memory encoded) = encodings.mandate(e.mandate);
            assertEq(encoded, referenceBytes, string.concat(e.id, ": MCE v2 bytes"));
            MandateCodec.Validity validity = harness.validateMandate(e.mandate);
            assertEq(uint8(validity), e.validity, string.concat(e.id, ": validity"));
            if (validity == MandateCodec.Validity.VALID) {
                assertEq(harness.mandateDigest(e.mandate), e.digest, string.concat(e.id, ": digest"));
                assertEq(keccak256(referenceBytes), e.digest, string.concat(e.id, ": reference digest"));
            }
        }
    }

    function test_differential_candidateEncodings() public view {
        bytes[] memory blobs = _section(".candidateEncodings");
        assertGt(blobs.length, 0, "empty candidate encodings");
        for (uint256 i = 0; i < blobs.length; ++i) {
            CandidateEncoding memory e = abi.decode(blobs[i], (CandidateEncoding));
            (bytes memory referenceBytes, bytes memory encoded) = encodings.candidate(e.candidate);
            assertEq(encoded, referenceBytes, string.concat(e.id, ": Candidate V3 bytes"));
            bool valid = harness.isValidCandidate(e.candidate);
            assertEq(valid, e.valid, string.concat(e.id, ": validity"));
            if (valid) {
                assertEq(harness.candidateDigest(e.candidate), e.digest, string.concat(e.id, ": digest"));
                assertEq(keccak256(referenceBytes), e.digest, string.concat(e.id, ": reference digest"));
            }
        }
    }
}
