// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MandateExecutionGate} from "../src/MandateExecutionGate.sol";
import {CanonicalAsset, Market, MarketConfig, MARKET_FIXTURE, Price} from "../src/MandateTypes.sol";
import {FixtureVenue} from "../src/fixture/FixtureVenue.sol";
import {FixtureVenueAdapter} from "../src/fixture/FixtureVenueAdapter.sol";
import {DeployMandateGate} from "../script/DeployMandateGate.s.sol";
import {CodecHarness} from "./utils/CodecHarness.sol";

/// @notice The deployment script is exercised locally, never broadcast: it is
/// deterministic, it wires markets to their own adapters, and it refuses a
/// mismatched chain and every known mainnet.
contract DeployScriptTest is Test {
    address internal constant REPRESENTATION = 0x5FbDB2315678afecb367f032d93F642f64180aa3;
    address internal constant FUNDING = 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512;
    address internal constant DEPLOYER = address(0xde91);

    string internal config;
    DeployMandateGate internal script;

    function setUp() public {
        config = vm.readFile("contracts/deploy/local-fixture.json");
        script = new DeployMandateGate();
        deployCodeTo(
            "MockTokens.sol:MockERC20", abi.encode("Fixture Apple Stock Token", "fAAPL", uint8(18)), REPRESENTATION
        );
        deployCodeTo("MockTokens.sol:MockERC20", abi.encode("Fixture USD Coin", "fUSDC", uint8(6)), FUNDING);
    }

    function test_deploysTheConfiguredMarketsAtPredictableAddresses() public {
        vm.chainId(31_337);
        uint256 nonce = vm.getNonce(DEPLOYER);
        DeployMandateGate.Deployment memory d = script.deploy(config, DEPLOYER);

        assertEq(address(d.venues[0]), vm.computeCreateAddress(DEPLOYER, nonce));
        assertEq(address(d.adapters[0]), vm.computeCreateAddress(DEPLOYER, nonce + 1));
        assertEq(address(d.gate), vm.computeCreateAddress(DEPLOYER, nonce + 2));
        assertEq(d.adapters[0].GATE(), address(d.gate));
        assertEq(address(d.adapters[0].VENUE()), address(d.venues[0]));

        CodecHarness harness = new CodecHarness();
        Market memory m = d.gate.marketOf(keccak256(bytes(harness.representationId(31_337, REPRESENTATION))));
        assertEq(m.representation, REPRESENTATION);
        assertEq(m.fundingToken, FUNDING);
        assertEq(m.adapter, address(d.adapters[0]));
        assertEq(m.fundingDecimals, 6);
        assertEq(d.venues[0].PRICE(), 200e6);
        assertEq(d.venues[0].FEE_BPS(), 30);
    }

    /// @dev The committed config with its typed fixture price replaced.
    function _configPricedAt(string memory decimals, string memory atoms) internal pure returns (string memory) {
        return string.concat(
            '{"chainId":31337,"markets":[{"representation":"0x5FbDB2315678afecb367f032d93F642f64180aa3",',
            '"fundingToken":"0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",',
            '"canonicalAsset":{"assetClass":"equity","idScheme":"isin","value":"US0378331005"},',
            '"issuer":"issuer.fixture","venue":"venue.fixture","quantityUnit":"TOKEN","settlementUnit":"USD",',
            '"synthetic":false,"classification":"FIXTURE","fixturePriceDecimals":',
            decimals,
            ',"fixturePrice":"',
            atoms,
            '","fixtureFeeBps":30}]}'
        );
    }

    /// @notice A typed price at 18 decimals is the same 200 USD per token: the
    /// venue gets 200e6 fUSDC atoms and the gate pins 200e18 at 18 decimals.
    /// Before 6R.1 the script handed the venue the raw 200e18.
    function test_convertsATypedPriceAtAnotherScaleToTheSameVenuePrice() public {
        vm.chainId(31_337);
        DeployMandateGate.Deployment memory d = script.deploy(_configPricedAt("18", "200000000000000000000"), DEPLOYER);
        assertEq(d.venues[0].PRICE(), 200e6);
        CodecHarness harness = new CodecHarness();
        Market memory m = d.gate.marketOf(keccak256(bytes(harness.representationId(31_337, REPRESENTATION))));
        assertEq(m.fixturePriceAtoms, 200e18);
        assertEq(m.fixturePriceDecimals, 18);
    }

    /// @notice 200.0000005 USD cannot be paid in 6-decimal fUSDC: no venue price
    /// equals it, so the script refuses before deploying anything.
    function test_refusesAFixturePriceFinerThanTheFundingToken() public {
        vm.chainId(31_337);
        vm.expectRevert(abi.encodeWithSelector(DeployMandateGate.FixturePriceNotRepresentable.selector, 0));
        script.deploy(_configPricedAt("7", "2000000005"), DEPLOYER);
    }

    /// @notice The pairing the previous script produced for an 18-decimal price —
    /// venue at raw 200e18 fUSDC atoms, gate at 200 USD — is refused by the gate's
    /// own constructor, so no deployment path depends on the script being right.
    function test_gateConstructorRefusesTheRawAtomPairingDirectly() public {
        vm.chainId(31_337);
        FixtureVenue venue = new FixtureVenue(IERC20(REPRESENTATION), IERC20(FUNDING), 200e18, 30);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        FixtureVenueAdapter adapter = new FixtureVenueAdapter(predicted, venue);
        MarketConfig[] memory markets = new MarketConfig[](1);
        markets[0] = MarketConfig({
            representation: REPRESENTATION,
            fundingToken: FUNDING,
            adapter: address(adapter),
            canonicalAsset: CanonicalAsset({assetClass: "equity", idScheme: "isin", value: "US0378331005"}),
            issuer: "issuer.fixture",
            venue: "venue.fixture",
            quantityUnit: "TOKEN",
            settlementUnit: "USD",
            synthetic: false,
            classification: MARKET_FIXTURE,
            fixturePrice: Price({numeratorUnit: "USD", denominatorUnit: "TOKEN", decimals: 18, atoms: 200e18})
        });
        vm.expectRevert(MandateExecutionGate.FixtureSettlementInconsistent.selector);
        new MandateExecutionGate(markets);
    }

    function test_refusesAChainOtherThanTheConfiguredOne() public {
        vm.chainId(46_630);
        vm.expectRevert(abi.encodeWithSelector(DeployMandateGate.ConfiguredForAnotherChain.selector, 31_337, 46_630));
        script.deploy(config, DEPLOYER);
    }

    function test_refusesEveryKnownMainnet() public {
        uint256[4] memory mainnets = [uint256(1), 42_161, 42_170, 4_663];
        for (uint256 i = 0; i < mainnets.length; ++i) {
            vm.chainId(mainnets[i]);
            vm.expectRevert(abi.encodeWithSelector(DeployMandateGate.MainnetRefused.selector, mainnets[i]));
            script.deploy(config, DEPLOYER);
        }
    }
}
