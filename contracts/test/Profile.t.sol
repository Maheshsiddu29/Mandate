// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {MandateExecutionGate} from "../src/MandateExecutionGate.sol";
import {
    Amount,
    CanonicalAsset,
    Candidate,
    ExecutionTerms,
    Mandate,
    MarketConfig,
    Price,
    SIDE_BUY
} from "../src/MandateTypes.sol";

import {LeanAdapter} from "./mocks/LeanAdapter.sol";
import {GateTestBase} from "./utils/GateTestBase.sol";

/// @notice The worst-case executable profile, settled and measured (Phase 6R.1).
///
/// Every string a deployment or a mandate can choose is a maximal 128-byte
/// identifier: the market's canonical asset, issuer, venue and both units, every
/// allowlist entry after the one the market requires, and the candidate's
/// evaluation-state identifier. Every set is at the 16-entry profile maximum,
/// route data is 4,096 non-zero bytes, and every free numeric field is at its
/// maximum. The attempt is correctly signed and settles through `LeanAdapter`
/// (etched at the gate's adapter address, because the supported fixture adapter
/// refuses route data), so the gas figure is the gate's rather than a test
/// double's bookkeeping, for the largest calldata the gate accepts. The chain identifier
/// and representation identifier are derived by the gate and cannot be longer.
///
/// `packages/execution-gate/test/corpus.test.ts` rebuilds the same shape with
/// the TypeScript ABI encoder and must arrive at the same calldata size.
contract ProfileTest is GateTestBase {
    /// @dev Pinned by both implementations; a change to either the shape or the
    /// ABI is a disagreement.
    uint256 internal constant WORST_CASE_CALLDATA_BYTES = 18_596;

    /// @dev A 128-byte identifier: `head`, filler, then a two-digit index, so
    /// equal-length entries sort by index.
    function _id(string memory head, uint256 index) internal pure returns (string memory) {
        bytes memory out = new bytes(128);
        bytes memory h = bytes(head);
        for (uint256 i = 0; i < 128; ++i) {
            out[i] = i < h.length ? h[i] : bytes1("x");
        }
        out[126] = bytes1(uint8(48 + index / 10));
        out[127] = bytes1(uint8(48 + index % 10));
        return string(out);
    }

    function _set(string memory head, string memory required) internal pure returns (string[] memory values) {
        values = new string[](16);
        bool requiredIsMaximal = bytes(required).length == 128;
        values[0] = required;
        for (uint256 i = 1; i < 16; ++i) {
            values[i] = _id(head, requiredIsMaximal ? i : i - 1);
        }
    }

    function _worstCase()
        internal
        returns (MandateExecutionGate g, Mandate memory m, Candidate memory c, ExecutionTerms memory t)
    {
        CanonicalAsset memory asset = CanonicalAsset({
            assetClass: _id("class.", 0), idScheme: _id("scheme.", 0), value: _id("value.", 0)
        });
        string memory issuer = _id("issuer.", 0);
        string memory venue = _id("venue.", 0);
        string memory quantityUnit = _id("qunit.", 0);
        string memory settlementUnit = _id("sunit.", 0);

        MarketConfig[] memory markets = new MarketConfig[](1);
        markets[0] = _market(address(scriptedToken), asset, issuer, venue, false);
        markets[0].quantityUnit = quantityUnit;
        markets[0].settlementUnit = settlementUnit;
        markets[0].fixturePrice =
            Price({numeratorUnit: settlementUnit, denominatorUnit: quantityUnit, decimals: 6, atoms: AAPL_PRICE});
        g = new MandateExecutionGate(markets);
        // The gate's own FixtureVenueAdapter refuses route data, so the maximal
        // 4,096-byte route is measured through a lean adapter etched at the gate's
        // adapter address: the gate's cost for the largest calldata it accepts.
        address adapter = address(_adapterOf(g, address(scriptedToken)));
        vm.etch(adapter, address(new LeanAdapter(4e6)).code);
        scriptedToken.mint(adapter, 10e18);
        vm.prank(principal);
        funding.approve(address(g), type(uint256).max);

        m = _mandate();
        m.mandateId = bytes32(type(uint256).max);
        m.nonce = type(uint64).max;
        m.canonicalAsset = asset;
        m.maxNotional = Amount({unit: settlementUnit, decimals: 0, atoms: type(uint256).max});
        m.economicLimit = Amount({unit: settlementUnit, decimals: 0, atoms: type(uint256).max});
        m.allowedIssuers = _set("issuer.", issuer);
        m.allowedChains = _set("chain.", CHAIN_ID_STRING);
        m.allowedVenues = _set("venue.", venue);
        m.requiredCorporateActionEpoch = type(uint64).max;
        m.maxPriceAgeSeconds = type(uint32).max;
        m.maxCorporateActionAgeSeconds = type(uint32).max;

        c = _candidateFor(address(scriptedToken), SIDE_BUY);
        c.canonicalAsset = asset;
        c.issuer = issuer;
        c.venue = venue;
        c.quantity.unit = quantityUnit;
        c.executionPrice.numeratorUnit = settlementUnit;
        c.executionPrice.denominatorUnit = quantityUnit;
        c.notional.unit = settlementUnit;
        c.feeTotal.unit = settlementUnit;
        c.evaluationStateId = _id("state.", 0);
        c.evaluationStateDigest = bytes32(type(uint256).max);
        c.registrySnapshotDigest = bytes32(type(uint256).max);
        c.corporateActionEpoch = type(uint64).max;

        t = _terms();
        t.deadline = type(uint64).max;
        t.executionData = new bytes(g.MAX_EXECUTION_DATA_BYTES());
        for (uint256 i = 0; i < t.executionData.length; ++i) {
            t.executionData[i] = 0xff;
        }
    }

    function test_profile_worstCaseExecutableCalldataSettlesAndIsMeasured() public {
        (MandateExecutionGate g, Mandate memory m, Candidate memory c, ExecutionTerms memory t) = _worstCase();
        bytes32 domain = g.domainSeparator();
        bytes memory ps = _sign(
            PRINCIPAL_KEY,
            keccak256(
                abi.encodePacked(
                    hex"1901",
                    domain,
                    keccak256(abi.encode(g.MANDATE_AUTHORIZATION_TYPEHASH(), harness.mandateDigest(m)))
                )
            )
        );
        bytes memory as_ = _sign(AGENT_KEY, keccak256(abi.encodePacked(hex"1901", domain, _commitment(m, c, t))));
        bytes memory data = abi.encodeCall(MandateExecutionGate.execute, (m, ps, c, t, as_));

        uint256 zeros;
        for (uint256 i = 0; i < data.length; ++i) {
            if (data[i] == 0) ++zeros;
        }
        uint256 nonZeros = data.length - zeros;

        // Only the gate call itself is inside the measured window.
        uint256 before = gasleft();
        (bool ok,) = address(g).call(data);
        uint256 executionGas = before - gasleft();
        assertTrue(ok, "worst-case executable attempt must settle");
        assertEq(scriptedToken.balanceOf(principal), 1_000e18 + 10e18);

        emit log_named_uint("worst-case calldata bytes", data.length);
        emit log_named_uint("  zero bytes", zeros);
        emit log_named_uint("  non-zero bytes", nonZeros);
        emit log_named_uint(
            "intrinsic gas, EIP-2028 (21000 + 16/non-zero + 4/zero)", 21_000 + 16 * nonZeros + 4 * zeros
        );
        emit log_named_uint("intrinsic gas ceiling, every byte non-zero", 21_000 + 16 * data.length);
        emit log_named_uint("EIP-7623 floor ceiling, every byte non-zero (21000 + 40/byte)", 21_000 + 40 * data.length);
        emit log_named_uint("execute call gas (settled)", executionGas);

        assertEq(data.length, WORST_CASE_CALLDATA_BYTES, "TypeScript and Solidity disagree on the worst case");
        // Nitro's default max-tx-data-size is 95,000 bytes: keep at least 50% headroom.
        assertLt(data.length, 47_500);
    }
}
