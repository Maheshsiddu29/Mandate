/**
 * @mandate/live-settlement — the Live AI Lab's one explicit Robinhood Chain
 * testnet settlement path (docs/demo/live-testnet-settlement.md).
 *
 * - `authorized-execution`, `eligibility`, `fixture-mapping`, `send-gate`,
 *   `evidence`, `deployment` are pure: which reserved child may settle, the
 *   declared fixture it settles as, the send gate, the evidence rule.
 * - `rpc` is the only network access and the only transaction-signing key
 *   (the 7E.3 gas payer), to Robinhood Chain testnet only.
 * - `domain-leg` is the only place the 7E.3 principal and agent keys are
 *   handed to the existing custody and agent signer.
 *
 * Nothing in `@mandate/live-agents`, the web app or the frozen protocol
 * depends on this package.
 */

export { selectStockExecution, type AuthorizedExecution } from './authorized-execution.ts';
export { checkEligibility, type Eligibility, type LiveAuthorityView } from './eligibility.ts';
export { parseDeployment, explorerTxUrl, ROBINHOOD_TESTNET, type TestnetDeployment } from './deployment.ts';
export { mapToFixture, TESTNET_SETTLEMENT_FIXTURE, FIXTURE_MAX_DEBIT_ATOMS, type FixtureSettlement } from './fixture-mapping.ts';
export { SendGate, SEND_AUTHORIZATION_PHRASE, type SendGateState } from './send-gate.ts';
export { settlementEvidence, ASSET_QUALIFICATION, SETTLEMENT_EVIDENCE, type SettlementEvidence } from './evidence.ts';
