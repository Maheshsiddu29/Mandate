// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

import {MandateExecutionGate} from "../src/MandateExecutionGate.sol";
import {Market} from "../src/MandateTypes.sol";
import {DeployMandateGate} from "../script/DeployMandateGate.s.sol";
import {LookAlikeVenue, LyingAdapter} from "./mocks/LookAlikeFixture.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FixtureVenue} from "../src/fixture/FixtureVenue.sol";
import {CodecHarness} from "./utils/CodecHarness.sol";

/// @notice The deployment script is exercised locally, never broadcast: it is
/// deterministic, it deploys only the gate (which creates each market's fixture
/// venue and adapter itself), and it refuses a mismatched chain and every known
/// mainnet.
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

    function test_deploysOnlyTheGateWhichCreatesItsFixtureAtPredictableAddresses() public {
        vm.chainId(31_337);
        uint256 nonce = vm.getNonce(DEPLOYER);
        DeployMandateGate.Deployment memory d = script.deploy(config, DEPLOYER);

        // One contract from the deployer; the venue and adapter are the gate's own
        // first two CREATEs (a new contract's nonce starts at 1, EIP-161).
        assertEq(vm.getNonce(DEPLOYER), nonce + 1);
        assertEq(address(d.gate), vm.computeCreateAddress(DEPLOYER, nonce));
        assertEq(address(d.venues[0]), vm.computeCreateAddress(address(d.gate), 1));
        assertEq(address(d.adapters[0]), vm.computeCreateAddress(address(d.gate), 2));
        assertEq(d.adapters[0].GATE(), address(d.gate));
        assertEq(address(d.adapters[0].VENUE()), address(d.venues[0]));

        CodecHarness harness = new CodecHarness();
        Market memory m = d.gate.marketOf(keccak256(bytes(harness.representationId(31_337, REPRESENTATION))));
        assertEq(m.representation, REPRESENTATION);
        assertEq(m.fundingToken, FUNDING);
        assertEq(m.adapter, address(d.adapters[0]));
        assertEq(m.fundingDecimals, 6);
        assertEq(address(d.venues[0].REPRESENTATION()), REPRESENTATION);
        assertEq(address(d.venues[0].FUNDING()), FUNDING);
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
    /// gate creates its venue at 200e6 fUSDC atoms and pins 200e18 at 18 decimals.
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
    /// equals it, so the gate's constructor refuses and nothing is deployed.
    function test_refusesAFixturePriceFinerThanTheFundingToken() public {
        vm.chainId(31_337);
        uint256 nonce = vm.getNonce(DEPLOYER);
        vm.expectRevert(MandateExecutionGate.FixturePriceNotRepresentable.selector);
        script.deploy(_configPricedAt("7", "2000000005"), DEPLOYER);
        assertEq(vm.getNonce(DEPLOYER), nonce);
    }

    // ------------------------------------------------------------------
    // Deployment-manifest verification (6R.1a)
    // ------------------------------------------------------------------

    function test_verifyAcceptsWhatTheScriptDeployed() public {
        vm.chainId(31_337);
        DeployMandateGate.Deployment memory d = script.deploy(config, DEPLOYER);
        assertTrue(script.verify(d.gate, config));
    }

    /// @notice Whatever put it there, code at the market's adapter that is not the
    /// reviewed adapter wired to this gate and venue is refused.
    function test_verifyRefusesAdapterCodeThatIsNotTheReviewedAdapter() public {
        vm.chainId(31_337);
        DeployMandateGate.Deployment memory d = script.deploy(config, DEPLOYER);
        vm.etch(address(d.adapters[0]), address(new LyingAdapter(REPRESENTATION, FUNDING, 200e6, 5)).code);
        vm.expectRevert(abi.encodeWithSelector(DeployMandateGate.FixtureAdapterNotReviewedCode.selector, 0));
        script.verify(d.gate, config);
    }

    function test_verifyRefusesVenueCodeThatIsNotTheReviewedVenue() public {
        vm.chainId(31_337);
        DeployMandateGate.Deployment memory d = script.deploy(config, DEPLOYER);
        vm.etch(address(d.venues[0]), address(new LookAlikeVenue(IERC20(REPRESENTATION), IERC20(FUNDING), 200e6)).code);
        vm.expectRevert(abi.encodeWithSelector(DeployMandateGate.FixtureVenueNotReviewedCode.selector, 0));
        script.verify(d.gate, config);
    }

    /// @notice The reviewed venue code with any other units — here a 6-decimal
    /// representation, where the gate pinned 18 — is not the venue this market has.
    function test_verifyRefusesAVenueWithOtherUnits() public {
        vm.chainId(31_337);
        DeployMandateGate.Deployment memory d = script.deploy(config, DEPLOYER);
        assertEq(d.venues[0].REPRESENTATION_DECIMALS(), 18);
        assertEq(d.venues[0].FUNDING_DECIMALS(), 6);
        vm.etch(
            address(d.venues[0]),
            address(new FixtureVenue(IERC20(REPRESENTATION), IERC20(FUNDING), 6, 6, 200e6, 30)).code
        );
        vm.expectRevert(abi.encodeWithSelector(DeployMandateGate.FixtureVenueNotReviewedCode.selector, 0));
        script.verify(d.gate, config);
    }

    /// @notice A gate checked against a config it was not built from — here, the
    /// same market at another price — is refused before any code is compared.
    function test_verifyRefusesAGateBuiltFromAnotherConfig() public {
        vm.chainId(31_337);
        DeployMandateGate.Deployment memory d = script.deploy(config, DEPLOYER);
        vm.expectRevert(abi.encodeWithSelector(DeployMandateGate.MarketNotAsConfigured.selector, 0));
        script.verify(d.gate, _configPricedAt("6", "300000000"));
    }

    /// @notice The gate's runtime code alone proves nothing about its markets: the
    /// same code without the constructor's market table is refused.
    function test_verifyRefusesTheGatesRuntimeCodeWithoutItsMarkets() public {
        vm.chainId(31_337);
        DeployMandateGate.Deployment memory d = script.deploy(config, DEPLOYER);
        address bare = address(0xb0b);
        vm.etch(bare, address(d.gate).code);
        vm.expectRevert(abi.encodeWithSelector(DeployMandateGate.MarketNotAsConfigured.selector, 0));
        script.verify(MandateExecutionGate(bare), config);
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
