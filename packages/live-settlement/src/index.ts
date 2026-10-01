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
 * - `journal` is the durable settlement lifecycle (no authority);
 *   `portfolio-ledger` is the settlement's admit / consume / release in the
 *   portfolio ledger (B.5.3); `reconcile` drives non-terminal attempts from
 *   chain evidence after a restart, with a reader only — it cannot send.
 *
 * Nothing in `@mandate/live-agents`, the web app or the frozen protocol
 * depends on this package.
 */

export { selectStockExecution, type AuthorizedExecution } from './authorized-execution.ts';
export { checkEligibility, type Eligibility, type LiveAuthorityView } from './eligibility.ts';
export { parseDeployment, explorerTxUrl, ROBINHOOD_TESTNET, type TestnetDeployment } from './deployment.ts';
export { mapToFixture, TESTNET_SETTLEMENT_FIXTURE, FIXTURE_MAX_DEBIT_ATOMS, type FixtureSettlement } from './fixture-mapping.ts';
export { SendGate, SEND_AUTHORIZATION_PHRASE, isSendAuthorization, type SendGateState } from './send-gate.ts';
export { settlementEvidence, ASSET_QUALIFICATION, SETTLEMENT_EVIDENCE, type SettlementEvidence } from './evidence.ts';
export { RobinhoodTestnetRpc, RobinhoodTestnetReader, PUBLIC_TESTNET_RPC, PUBLIC_ONLY, isTransportFailure, type TestnetRpc, type ChainReader, type TransactionBroadcaster, type RpcEndpoints, type RpcProvenance, type Endpoint, type TxLookup } from './rpc.ts';
export { preflight, MIN_SUBMITTER_WEI, type PreflightReport } from './preflight.ts';
export { LiveSettlement, safeReason, checkPostconditions, principalBinding, lifecycleDedupe, FAULT_POINTS, type SettlementOutcome, type SettlementRecord, type WouldSend, type Prepared, type RunOptions, type FaultPoint, type PrincipalBinding } from './settlement.ts';
export { SettlementJournal, JournalRefusal, ATTEMPT_STATES, QUARANTINES, JOURNAL_SCHEMA, isTerminal, type AttemptRecord, type AttemptState, type AttemptBinding, type ArtifactRecord, type Quarantine } from './journal.ts';
export { reservationStatus, SETTLEMENT_ARTIFACT_KIND, type ReservationStatus } from './portfolio-ledger.ts';
export { reconcileAttempts, judge, gatherEvidence, RECONCILE_OUTCOMES, type ReconcileOutcome, type ReconcileReport, type ChainEvidence } from './reconcile.ts';
export type { DomainKeys } from './domain-leg.ts';
