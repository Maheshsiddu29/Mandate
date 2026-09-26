// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";

import {MandateExecutionGate} from "../src/MandateExecutionGate.sol";
import {CanonicalAsset, MarketConfig, Price, MARKET_FIXTURE} from "../src/MandateTypes.sol";
import {FixtureVenue} from "../src/fixture/FixtureVenue.sol";
import {FixtureVenueAdapter} from "../src/fixture/FixtureVenueAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title DeployMandateGate — deterministic deployment of the gate and its fixture markets
/// @notice MANUAL ONLY. Never run by CI with `--broadcast`, and Phase 6 authorizes
/// no deployment at all (docs/execution-gate.md §13). This script exists so that
/// when a deployment *is* separately authorized, what gets deployed is fully
/// determined by a reviewed config file and the deployer's nonce.
///
/// For every market in the config it deploys one `FixtureVenue` (a labelled
/// settlement fixture, not a market) and its `FixtureVenueAdapter`, then the gate.
/// Adapters name the gate and the gate names the adapters, so the gate's address
/// is predicted from the deployer nonce and asserted after deployment.
///
/// Each market's price is written once, typed (`fixturePrice` atoms at
/// `fixturePriceDecimals`), and is both the gate's pinned price and — converted
/// exactly to the funding token's atoms — the venue's. The gate's constructor
/// independently refuses a venue at any other economic price, so this
/// conversion is a convenience, not the enforcement.
///
/// Refuses: a config whose `chainId` is not the connected chain, any known
/// mainnet — Ethereum, Arbitrum One, Arbitrum Nova and Robinhood Chain mainnet —
/// and a fixture price finer than its funding token can express.
///
/// Usage (simulation only unless `--broadcast` is added by a human):
///   MANDATE_GATE_CONFIG=contracts/deploy/local-fixture.json \
///     forge script contracts/script/DeployMandateGate.s.sol --rpc-url <local>
contract DeployMandateGate is Script {
    error ConfiguredForAnotherChain(uint256 configured, uint256 connected);
    error MainnetRefused(uint256 chainId);
    error GateAddressMispredicted(address predicted, address deployed);
    error FixtureClassificationRequired();
    error FixturePriceNotRepresentable(uint256 market);

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
        d.venues = new FixtureVenue[](count);
        d.adapters = new FixtureVenueAdapter[](count);

        vm.startBroadcast(deployer);
        for (uint256 i = 0; i < count; ++i) {
            string memory p = string.concat(".markets[", vm.toString(i), "]");
            d.venues[i] = new FixtureVenue(
                IERC20(vm.parseJsonAddress(json, string.concat(p, ".representation"))),
                IERC20(vm.parseJsonAddress(json, string.concat(p, ".fundingToken"))),
                venuePrice(json, i),
                uint16(vm.parseJsonUint(json, string.concat(p, ".fixtureFeeBps")))
            );
        }
        // Next come `count` adapters, then the gate.
        address predictedGate = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + count);
        for (uint256 i = 0; i < count; ++i) {
            d.adapters[i] = new FixtureVenueAdapter(predictedGate, d.venues[i]);
            markets[i] = _market(json, i, address(d.adapters[i]));
        }
        d.gate = new MandateExecutionGate(markets);
        vm.stopBroadcast();

        if (address(d.gate) != predictedGate) revert GateAddressMispredicted(predictedGate, address(d.gate));
        console2.log("MandateExecutionGate", address(d.gate));
        console2.log("chainId", block.chainid);
        for (uint256 i = 0; i < count; ++i) {
            console2.log("  market", i);
            console2.log("    fixture venue   ", address(d.venues[i]));
            console2.log("    fixture adapter ", address(d.adapters[i]));
        }
    }

    /// @notice The typed fixture price in funding-token atoms per whole token,
    /// exactly. A price with more precision than the funding token refuses.
    function venuePrice(string memory json, uint256 i) public view returns (uint256) {
        string memory p = string.concat(".markets[", vm.toString(i), "]");
        uint256 atoms = vm.parseJsonUint(json, string.concat(p, ".fixturePrice"));
        uint256 priceDecimals = vm.parseJsonUint(json, string.concat(p, ".fixturePriceDecimals"));
        uint256 fundingDecimals =
            IERC20Metadata(vm.parseJsonAddress(json, string.concat(p, ".fundingToken"))).decimals();
        if (fundingDecimals >= priceDecimals) return atoms * 10 ** (fundingDecimals - priceDecimals);
        uint256 divisor = 10 ** (priceDecimals - fundingDecimals);
        if (atoms % divisor != 0) revert FixturePriceNotRepresentable(i);
        return atoms / divisor;
    }

    function _marketCount(string memory json) internal view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(".markets[", vm.toString(n), "]"))) ++n;
    }

    function _market(string memory json, uint256 i, address adapter) internal pure returns (MarketConfig memory) {
        string memory p = string.concat(".markets[", vm.toString(i), "]");
        if (keccak256(bytes(vm.parseJsonString(json, string.concat(p, ".classification")))) != keccak256("FIXTURE")) {
            revert FixtureClassificationRequired();
        }
        return MarketConfig({
            representation: vm.parseJsonAddress(json, string.concat(p, ".representation")),
            fundingToken: vm.parseJsonAddress(json, string.concat(p, ".fundingToken")),
            adapter: adapter,
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
            })
        });
    }
}
