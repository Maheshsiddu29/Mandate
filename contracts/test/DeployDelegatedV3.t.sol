// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

import {DeployDelegatedV3} from "../script/DeployDelegatedV3.s.sol";
import {MARKET_FIXTURE, MarketConfig} from "../src/MandateTypes.sol";

/// @notice Safety guards for the C2.3 V3 Robinhood testnet deployment script.
/// Does not broadcast. Does not require live RPC.
contract DeployDelegatedV3Test is Test {
    DeployDelegatedV3 internal script;

    function setUp() public {
        script = new DeployDelegatedV3();
    }

    function test_refusesMainnets() public view {
        assertTrue(script.isRefusedMainnet(1));
        assertTrue(script.isRefusedMainnet(42_161));
        assertTrue(script.isRefusedMainnet(42_170));
        assertTrue(script.isRefusedMainnet(4_663));
        assertFalse(script.isRefusedMainnet(46_630));
        assertFalse(script.isRefusedMainnet(31_337));
    }

    function test_requireRobinhoodTestnet_accepts46630() public {
        vm.chainId(46_630);
        script.requireRobinhoodTestnet();
    }

    function test_requireRobinhoodTestnet_refusesUnknownChain() public {
        vm.chainId(31_337);
        vm.expectRevert(abi.encodeWithSelector(DeployDelegatedV3.WrongChain.selector, uint256(31_337)));
        script.requireRobinhoodTestnet();
    }

    function test_requireRobinhoodTestnet_refusesEthereumMainnet() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(DeployDelegatedV3.MainnetRefused.selector, uint256(1)));
        script.requireRobinhoodTestnet();
    }

    function test_requireRobinhoodTestnet_refusesArbitrumOne() public {
        vm.chainId(42_161);
        vm.expectRevert(abi.encodeWithSelector(DeployDelegatedV3.MainnetRefused.selector, uint256(42_161)));
        script.requireRobinhoodTestnet();
    }

    function test_requireRobinhoodTestnet_refusesRobinhoodMainnet() public {
        vm.chainId(4_663);
        vm.expectRevert(abi.encodeWithSelector(DeployDelegatedV3.MainnetRefused.selector, uint256(4_663)));
        script.requireRobinhoodTestnet();
    }

    function test_fixtureMarket_isImmutableMdemoMdusd() public view {
        MarketConfig memory m = script.fixtureMarket();
        assertEq(m.representation, 0x5D4c3618F996777baf0e0468884bB7A440f189E1);
        assertEq(m.fundingToken, 0x53b640B9A573E33C541De5a4917Bc4d28d956Abf);
        assertEq(m.canonicalAsset.assetClass, "fixture");
        assertEq(m.canonicalAsset.idScheme, "mandate-demo");
        assertEq(m.canonicalAsset.value, "MDEMO");
        assertEq(m.issuer, "issuer.mandate-demo");
        assertEq(m.venue, "venue.mandate-fixture");
        assertEq(m.quantityUnit, "TOKEN");
        assertEq(m.settlementUnit, "MDUSD");
        assertFalse(m.synthetic);
        assertEq(m.classification, MARKET_FIXTURE);
        assertEq(m.fixturePrice.numeratorUnit, "MDUSD");
        assertEq(m.fixturePrice.denominatorUnit, "TOKEN");
        assertEq(m.fixturePrice.decimals, 6);
        assertEq(m.fixturePrice.atoms, 10_000_000);
        assertEq(m.fixtureFeeBps, 0);
    }
}
