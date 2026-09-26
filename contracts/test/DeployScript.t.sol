// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

import {MandateExecutionGate} from "../src/MandateExecutionGate.sol";
import {Market} from "../src/MandateTypes.sol";
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
