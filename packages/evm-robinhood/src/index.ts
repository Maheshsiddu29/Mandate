/**
 * @mandate/evm-robinhood — Mandate's Robinhood Chain EVM execution domain
 * (Phase 7E.3).
 *
 * - `vocabulary`, `market`, `policy`, `adapter`, `gate`, `abi` are pure:
 *   GateSpotPolicy v1 (a domain module over the frozen Phase 6
 *   `MandateExecutionGate`), reviewed markets, the adapter descriptor, the
 *   exact gate artifact for a Core authorization, and ABI encoding.
 * - `custody` holds the principal and agent keys and signs only admitted gate
 *   artifacts; `transaction` signs typed transactions for one chain.
 * - `chain` is the only network access, to Robinhood Chain testnet only;
 *   `live` and `state-reader` use it.
 *
 * Core, the ledger and the control engine stay venue-independent: everything
 * Robinhood- and EVM-specific lives here.
 */

export * from './vocabulary.ts';
export * from './market.ts';
export { ASSUMPTIONS, BLOCK_LADDER, ORDER_DEBIT_BOUND, createGateSpotPolicy, gateSpotImplementation, gateSpotManifest, gateSpotModuleRef, type GateSpotConfig, type GateSpotPolicy } from './policy.ts';
export * from './adapter.ts';
export { EVALUATION_STATE_ID, buildGateArtifact, checkGateArtifact, gateMandateId, reviewedMarketDigest, slotScope, type ArtifactSource, type ArtifactTerms, type GateArtifact } from './gate.ts';
export { EXECUTE_SIGNATURE, executeCalldata, calldata, encodeArguments, type AbiType, type AbiValue } from './abi.ts';
export { LocalAgentSigner, LocalGateCustody, keyAddress, verifyAdmitted, type AgentSigner, type CustodyBinding, type CustodyResult, type CustodyView, type GateClaim, type GateKeyCustody } from './custody.ts';
export { TxSender, createAddress, type Eip1559Tx } from './transaction.ts';
export { ChainClient, JsonRpcClient, REFUSED_CHAIN_IDS, ROBINHOOD_TESTNET_CHAIN_ID, RpcHostRefused, TESTNET_RPC_HOSTS, isQuickNodeHost, type RpcEndpointKind, type RpcOptions, type BlockRef, type Read, type Receipt, type Simulation, type Submission } from './chain.ts';
export { LiveGateChain } from './live.ts';
export { gateMarketState, readGateMarkets, type GateStateRead } from './state-reader.ts';
export { GateSigner, type GateCall, type GateChain, type GateSignerConfig, type GateSignerDeps, type IssueOutcome, type IssueRequest, type IssueStage, type RecoveryReport } from './signer.ts';
