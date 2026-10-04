// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;
import {Test, console2} from "forge-std/Test.sol";
import {MandateDelegatedExecutionGate} from "../src/MandateDelegatedExecutionGate.sol";
import {MARKET_FIXTURE, MarketConfig, CanonicalAsset, Price} from "../src/MandateTypes.sol";
import {MockERC20} from "./mocks/MockTokens.sol";

contract DelegatedVectorTest is Test {
    function test_vectorDigest() public {
        vm.chainId(46630);
        bytes32 typehash = keccak256(
            "DelegatedPortfolioAuthorizationV3(bytes32 portfolioMandateDigest,bytes32 initialAllocationDigest,bytes32 sessionDigest,address principal,address delegate,address agent,bytes32 representationIdHash,address fundingToken,uint256 cumulativeDebitLimit,uint64 validAfter,uint64 validUntil,uint64 generation)"
        );
        bytes32 digest = keccak256(
            abi.encode(
                typehash,
                bytes32(uint256(0xb01)),
                bytes32(uint256(0xa11)),
                bytes32(uint256(0x5e5)),
                address(0x2c7536E3605D9C16a7a3D7b1898e529396a65c23),
                address(0x88f9B82462f6C4bf4a0Fb15e5c3971559a316e7f),
                address(0x63FaC9201494f0bd17B9892B9fae4d52fe3BD377),
                bytes32(uint256(0xce0c192a14407b7fe100bc6b7d17452737f621c5113ff0d6ee9c57350d908623)),
                address(0x2e234DAe75C793f67A35089C9d99245E1C58470b),
                uint256(10_000_000_000),
                uint64(1_799_999_940),
                uint64(1_800_003_600),
                uint64(1)
            )
        );
        assertEq(typehash, bytes32(0xa54b57fbba9f253cdee6e6c3595165744ff1af29341f40facc1cb5d068b35030));
        // Cross-checked with packages/execution-gate DELEGATED_VECTORS.sample.delegationStructHash.
        assertEq(digest, bytes32(0x5094f1e292418a4e60a29999e163875008398a3ea38bf3e0324a0ebc8b2a692b));
    }
}
