// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";

import {MandateDelegatedExecutionGate} from "../src/MandateDelegatedExecutionGate.sol";
import {CanonicalAsset, Market, MarketConfig, Price, MARKET_FIXTURE} from "../src/MandateTypes.sol";
import {MandateCodec} from "../src/libraries/MandateCodec.sol";

/// @title DeployDelegatedV3 — Robinhood Chain testnet deploy of MandateDelegatedExecutionGate
/// @notice MANUAL / OPERATOR ONLY. Never run by CI with `--broadcast`. The fixture
/// market is immutable in this script: MDEMO / MDUSD at 10 MDUSD per MDEMO on
/// chain 46630. No CLI market arguments. No private key. No mainnet path.
///
/// The Node wrapper (`npm run robinhood:v3:testnet:deploy`) is the canonical
/// operator entry point. Prefer Foundry's external signer modes
/// (`--interactive` or `--account <keystore>`); this script never reads
/// `PRIVATE_KEY` from the environment.
///
/// Dry-run (simulation against the live testnet RPC, no broadcast):
///   forge script contracts/script/DeployDelegatedV3.s.sol:DeployDelegatedV3 \
///     --rpc-url <rpc>
///
/// Live broadcast (human only, after Node double-confirm):
///   forge script contracts/script/DeployDelegatedV3.s.sol:DeployDelegatedV3 \
///     --rpc-url <rpc> --broadcast --interactive
///
/// Post-deploy read-only check (archive / local nodes only):
///   forge script contracts/script/DeployDelegatedV3.s.sol:DeployDelegatedV3 \
///     --sig "verify(address)" <gate> --rpc-url <rpc>
/// Do not pass `--fork-block-number`. Foundry still forks at a numeric height,
/// so this Solidity verify path fails on Robinhood's non-archive public RPC.
/// Canonical public-RPC verification is the Node wrapper at `"latest"`:
///   npm run robinhood:v3:testnet:verify -- --gate <addr>
contract DeployDelegatedV3 is Script {
    uint256 internal constant ROBINHOOD_TESTNET_CHAIN_ID = 46_630;

    address internal constant MDEMO = 0x5D4c3618F996777baf0e0468884bB7A440f189E1;
    address internal constant MDUSD = 0x53b640B9A573E33C541De5a4917Bc4d28d956Abf;

    error WrongChain(uint256 got);
    error MainnetRefused(uint256 chainId);
    error GateNotAsConfigured();

    /// @notice Mainnets this deploy path never targets.
    function isRefusedMainnet(uint256 chainId) public pure returns (bool) {
        return chainId == 1 || chainId == 42_161 || chainId == 42_170 || chainId == 4_663;
    }

    /// @notice Independent chain guard: must be Robinhood Chain testnet (46630).
    function requireRobinhoodTestnet() public view {
        if (isRefusedMainnet(block.chainid)) revert MainnetRefused(block.chainid);
        if (block.chainid != ROBINHOOD_TESTNET_CHAIN_ID) revert WrongChain(block.chainid);
    }

    /// @notice The single immutable FIXTURE market this script will deploy.
    function fixtureMarket() public pure returns (MarketConfig memory) {
        return MarketConfig({
            representation: MDEMO,
            fundingToken: MDUSD,
            canonicalAsset: CanonicalAsset({assetClass: "fixture", idScheme: "mandate-demo", value: "MDEMO"}),
            issuer: "issuer.mandate-demo",
            venue: "venue.mandate-fixture",
            quantityUnit: "TOKEN",
            settlementUnit: "MDUSD",
            synthetic: false,
            classification: MARKET_FIXTURE,
            fixturePrice: Price({numeratorUnit: "MDUSD", denominatorUnit: "TOKEN", decimals: 6, atoms: 10_000_000}),
            fixtureFeeBps: 0
        });
    }

    function run() external returns (MandateDelegatedExecutionGate gate) {
        requireRobinhoodTestnet();

        MarketConfig[] memory markets = new MarketConfig[](1);
        markets[0] = fixtureMarket();

        // Signer is supplied by Foundry externally (--interactive / --account).
        // Do not read PRIVATE_KEY here.
        vm.startBroadcast();
        gate = new MandateDelegatedExecutionGate(markets);
        vm.stopBroadcast();

        verify(gate);

        console2.log("DRY_RUN_OR_BROADCAST_RESULT");
        console2.log("MandateDelegatedExecutionGate", address(gate));
        console2.log("chainId", block.chainid);
        console2.log("MDEMO", MDEMO);
        console2.log("MDUSD", MDUSD);
        console2.log("fixturePriceAtoms", uint256(10_000_000));
        console2.log("fixturePriceDecimals", uint256(6));
        console2.logBytes32(gate.domainSeparator());
    }

    /// @notice Read-only check that `gate` was built from this script's fixture.
    function verify(MandateDelegatedExecutionGate gate) public view returns (bool) {
        requireRobinhoodTestnet();
        if (address(gate).code.length == 0) revert GateNotAsConfigured();
        if (gate.CHAIN_ID() != ROBINHOOD_TESTNET_CHAIN_ID) revert GateNotAsConfigured();
        if (gate.domainSeparator() == bytes32(0)) revert GateNotAsConfigured();

        MarketConfig memory config = fixtureMarket();
        bytes32 key = keccak256(bytes(MandateCodec.representationId(block.chainid, config.representation)));
        Market memory m = gate.marketOf(key);
        if (
            m.representation != config.representation || m.fundingToken != config.fundingToken
                || m.classification != MARKET_FIXTURE || m.synthetic != false
                || m.fixturePriceDecimals != config.fixturePrice.decimals
                || m.fixturePriceAtoms != config.fixturePrice.atoms
                || m.canonicalAssetHash != MandateCodec.assetHashMemory(config.canonicalAsset)
                || m.issuerHash != keccak256(bytes(config.issuer)) || m.venueHash != keccak256(bytes(config.venue))
                || m.quantityUnitHash != keccak256(bytes(config.quantityUnit))
                || m.settlementUnitHash != keccak256(bytes(config.settlementUnit))
                || gate.fixtureVenueOf(key) == address(0)
        ) revert GateNotAsConfigured();
        return true;
    }
}
