// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";

import {MandateExecutionGate} from "../src/MandateExecutionGate.sol";
import {CanonicalAsset, Market, MarketConfig, Price, MARKET_FIXTURE} from "../src/MandateTypes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FixtureVenue} from "../src/fixture/FixtureVenue.sol";
import {FixtureVenueAdapter} from "../src/fixture/FixtureVenueAdapter.sol";
import {MandateCodec} from "../src/libraries/MandateCodec.sol";

/// @title DeployMandateGate — deterministic deployment of the gate and its fixture markets
/// @notice MANUAL ONLY. Never run by CI with `--broadcast`, and Phase 6 authorizes
/// no deployment at all (docs/execution-gate.md §13). This script exists so that
/// when a deployment *is* separately authorized, what gets deployed is fully
/// determined by a reviewed config file and the deployer's nonce.
///
/// It deploys exactly one contract, the gate. The gate's constructor creates each
/// market's `FixtureVenue` (a labelled settlement fixture, not a market) and
/// `FixtureVenueAdapter` itself, at the price the config types once
/// (`fixturePrice` atoms at `fixturePriceDecimals`), converted exactly to the
/// funding token's atoms (Phase 6R.1a). The script therefore has no adapter or
/// venue to choose, and no address to predict; it logs what the gate created.
/// Stocking a venue with inventory is a separate, manual step.
///
/// Refuses: a config whose `chainId` is not the connected chain and any known
/// mainnet — Ethereum, Arbitrum One, Arbitrum Nova and Robinhood Chain mainnet.
/// The gate itself refuses a fixture price finer than its funding token can
/// express (`FixturePriceNotRepresentable`).
///
/// `verify(gate, json)` is the deployment-manifest check, and `deploy` runs it on
/// what it just deployed. For every market in the config it reads the gate's
/// market table and compares the runtime code at the market's adapter and venue
/// with a reference `FixtureVenueAdapter(gate, venue)` and
/// `FixtureVenue(representation, funding, price, fee)` instantiated in the
/// script's own (never broadcast) execution. Immutables are part of runtime
/// code, so equal code is equal implementation *and* equal wiring. It needs no
/// trust in how the gate was deployed: a gate whose runtime code is right but
/// whose markets were written by other initcode fails it. Run it read-only
/// against any deployment:
///   forge script contracts/script/DeployMandateGate.s.sol --sig "verify(address,string)" <gate> "$(cat <config>)" --rpc-url <rpc>
///
/// Usage (simulation only unless `--broadcast` is added by a human):
///   MANDATE_GATE_CONFIG=contracts/deploy/local-fixture.json \
///     forge script contracts/script/DeployMandateGate.s.sol --rpc-url <local>
contract DeployMandateGate is Script {
    error ConfiguredForAnotherChain(uint256 configured, uint256 connected);
    error MainnetRefused(uint256 chainId);
    error FixtureClassificationRequired();
    error MarketNotAsConfigured(uint256 market);
    error FixtureVenueNotReviewedCode(uint256 market);
    error FixtureAdapterNotReviewedCode(uint256 market);

    struct Deployment {
        MandateExecutionGate gate;
        FixtureVenue[] venues;
        FixtureVenueAdapter[] adapters;
    }

    string internal constant DEFAULT_CONFIG = "contracts/deploy/local-fixture.json";

    function run() external returns (Deployment memory) {
        string memory path = vm.envOr("MANDATE_GATE_CONFIG", DEFAULT_CONFIG);
        return deploy(vm.readFile(path), msg.sender);
    }

    /// @notice Mainnets this phase never deploys to.
    function isRefusedMainnet(uint256 chainId) public pure returns (bool) {
        return chainId == 1 || chainId == 42_161 || chainId == 42_170 || chainId == 4_663;
    }

    function deploy(string memory json, address deployer) public returns (Deployment memory d) {
        uint256 configured = vm.parseJsonUint(json, ".chainId");
        if (isRefusedMainnet(block.chainid)) revert MainnetRefused(block.chainid);
        if (configured != block.chainid) revert ConfiguredForAnotherChain(configured, block.chainid);

        uint256 count = _marketCount(json);
        MarketConfig[] memory markets = new MarketConfig[](count);
        for (uint256 i = 0; i < count; ++i) {
            markets[i] = _market(json, i);
        }

        vm.startBroadcast(deployer);
        d.gate = new MandateExecutionGate(markets);
        vm.stopBroadcast();
        verify(d.gate, json);

        d.venues = new FixtureVenue[](count);
        d.adapters = new FixtureVenueAdapter[](count);
        console2.log("MandateExecutionGate", address(d.gate));
        console2.log("chainId", block.chainid);
        for (uint256 i = 0; i < count; ++i) {
            bytes32 key = keccak256(bytes(MandateCodec.representationId(block.chainid, markets[i].representation)));
            d.venues[i] = FixtureVenue(d.gate.fixtureVenueOf(key));
            d.adapters[i] = FixtureVenueAdapter(d.gate.marketOf(key).adapter);
            console2.log("  market", i);
            console2.log("    fixture venue   ", address(d.venues[i]));
            console2.log("    fixture adapter ", address(d.adapters[i]));
        }
    }

    /// @notice Refuses unless every configured market's adapter and venue are the
    /// reviewed fixture contracts, wired to that market's tokens, its exact price,
    /// its fee and this gate. Read-only: the reference instances it creates exist
    /// only in the script's local execution.
    function verify(MandateExecutionGate gate, string memory json) public returns (bool) {
        uint256 count = _marketCount(json);
        for (uint256 i = 0; i < count; ++i) {
            MarketConfig memory config = _market(json, i);
            bytes32 key = keccak256(bytes(MandateCodec.representationId(block.chainid, config.representation)));
            Market memory m = gate.marketOf(key);
            address venue = gate.fixtureVenueOf(key);
            if (
                m.representation != config.representation || m.fundingToken != config.fundingToken
                    || m.fixturePriceAtoms != config.fixturePrice.atoms
                    || m.fixturePriceDecimals != config.fixturePrice.decimals || venue == address(0)
            ) revert MarketNotAsConfigured(i);

            uint256 price = _fundingAtomsPerToken(config.fixturePrice, m.fundingDecimals, i);
            FixtureVenue referenceVenue = new FixtureVenue(
                IERC20(config.representation),
                IERC20(config.fundingToken),
                m.representationDecimals,
                m.fundingDecimals,
                price,
                config.fixtureFeeBps
            );
            if (venue.codehash != address(referenceVenue).codehash) revert FixtureVenueNotReviewedCode(i);
            FixtureVenueAdapter referenceAdapter = new FixtureVenueAdapter(address(gate), FixtureVenue(venue));
            if (m.adapter.codehash != address(referenceAdapter).codehash) revert FixtureAdapterNotReviewedCode(i);
        }
        return true;
    }

    /// @dev The venue price the gate derives from a typed price; unrepresentable
    /// means the gate could not have been built from this config.
    function _fundingAtomsPerToken(Price memory price, uint8 fundingDecimals, uint256 market)
        internal
        pure
        returns (uint256)
    {
        if (fundingDecimals >= price.decimals) {
            uint256 factor = 10 ** uint256(fundingDecimals - price.decimals);
            if (price.atoms > type(uint256).max / factor) revert MarketNotAsConfigured(market);
            return price.atoms * factor;
        }
        uint256 divisor = 10 ** uint256(price.decimals - fundingDecimals);
        if (price.atoms % divisor != 0) revert MarketNotAsConfigured(market);
        return price.atoms / divisor;
    }

    function _marketCount(string memory json) internal view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(".markets[", vm.toString(n), "]"))) ++n;
    }

    function _market(string memory json, uint256 i) internal pure returns (MarketConfig memory) {
        string memory p = string.concat(".markets[", vm.toString(i), "]");
        if (keccak256(bytes(vm.parseJsonString(json, string.concat(p, ".classification")))) != keccak256("FIXTURE")) {
            revert FixtureClassificationRequired();
        }
        return MarketConfig({
            representation: vm.parseJsonAddress(json, string.concat(p, ".representation")),
            fundingToken: vm.parseJsonAddress(json, string.concat(p, ".fundingToken")),
            canonicalAsset: CanonicalAsset({
                assetClass: vm.parseJsonString(json, string.concat(p, ".canonicalAsset.assetClass")),
                idScheme: vm.parseJsonString(json, string.concat(p, ".canonicalAsset.idScheme")),
                value: vm.parseJsonString(json, string.concat(p, ".canonicalAsset.value"))
            }),
            issuer: vm.parseJsonString(json, string.concat(p, ".issuer")),
            venue: vm.parseJsonString(json, string.concat(p, ".venue")),
            quantityUnit: vm.parseJsonString(json, string.concat(p, ".quantityUnit")),
            settlementUnit: vm.parseJsonString(json, string.concat(p, ".settlementUnit")),
            synthetic: vm.parseJsonBool(json, string.concat(p, ".synthetic")),
            classification: MARKET_FIXTURE,
            fixturePrice: Price({
                numeratorUnit: vm.parseJsonString(json, string.concat(p, ".settlementUnit")),
                denominatorUnit: vm.parseJsonString(json, string.concat(p, ".quantityUnit")),
                decimals: uint8(vm.parseJsonUint(json, string.concat(p, ".fixturePriceDecimals"))),
                atoms: vm.parseJsonUint(json, string.concat(p, ".fixturePrice"))
            }),
            fixtureFeeBps: uint16(vm.parseJsonUint(json, string.concat(p, ".fixtureFeeBps")))
        });
    }
}
