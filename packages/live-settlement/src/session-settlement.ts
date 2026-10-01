/**
 * The session-bound settlement (B.5.3, docs/demo/wallet-settlement-boundaries.md §7):
 * what `npm run agents:settle:testnet -- --session <id>` does, given the
 * durable session it restored.
 *
 * ```text
 * restored session (exact versions, reservation, events) ─▶ reconcile every journaled attempt first
 *   ─▶ verify the principal authorization of the reserved version (a wallet approval re-verified from its evidence)
 *   ─▶ select the one reserved Stock child — the persisted object, never a new model run or a rebuilt proposal
 *   ─▶ an attempt already past PREPARED: reconcile only
 *   ─▶ dry run with the journal: eligibility, portfolio ADMIT_ATTEMPT, preflight, domain leg, eth_call, estimateGas
 *   ─▶ TESTNET_READY_FOR_SEND — and stop: B.5.3 never broadcasts
 * ```
 *
 * Every event lands in the session's own durable event log, so the browser
 * that created the session sees it.
 */

import type { LiveSession } from '@mandate/live-agents';
import type { TestnetDeployment } from './deployment.ts';
import type { DomainKeys } from './domain-leg.ts';
import { ASSET_QUALIFICATION } from './evidence.ts';
import type { AttemptRecord, SettlementJournal } from './journal.ts';
import { reconcileAttempts, type ReconcileReport } from './reconcile.ts';
import type { TestnetRpc } from './rpc.ts';
import { SendGate } from './send-gate.ts';
import { LiveSettlement, principalBinding, type PrincipalBinding, type SettlementOutcome } from './settlement.ts';

/** B.5.3 proves durability and linkage without spending a transaction. */
export const B53_BROADCAST = 'DISABLED_IN_B.5.3';

export type SessionSettlementResult =
  | { readonly status: 'RECONCILED_ONLY'; readonly reports: readonly ReconcileReport[]; readonly attempt: AttemptRecord }
  | { readonly status: 'INELIGIBLE'; readonly stage: string; readonly reason: string; readonly reports: readonly ReconcileReport[] }
  | { readonly status: 'NOT_READY'; readonly outcome: SettlementOutcome; readonly reports: readonly ReconcileReport[] }
  | { readonly status: 'READY_FOR_TESTNET_SEND'; readonly outcome: Extract<SettlementOutcome, { status: 'READY' }>; readonly principals: PrincipalBinding; readonly broadcast: typeof B53_BROADCAST; readonly reports: readonly ReconcileReport[] };

export interface SessionSettlementInput {
  /** The durable session, restored from disk. */
  readonly session: LiveSession;
  readonly journal: SettlementJournal;
  readonly deployment: TestnetDeployment;
  readonly rpc: TestnetRpc;
  readonly keys: DomainKeys;
  /** The dry run's scratch domain ledger. */
  readonly scratchLedgerPath: string;
}

export async function settleSessionDryRun(i: SessionSettlementInput): Promise<SessionSettlementResult> {
  const { session, journal, deployment: d, rpc } = i;
  const reports = await reconcileAttempts({ journal, reader: rpc, session, deployment: d });
  const refuse = (stage: string, reason: string): SessionSettlementResult => {
    session.events.emit('DOMAIN_EXECUTION_INELIGIBLE', { agent: 'stock', data: { stage, reason, sessionId: session.id, transactions: 0, qualification: ASSET_QUALIFICATION } });
    return { status: 'INELIGIBLE', stage, reason, reports };
  };
  const stock = session.reservedExecutions.filter((r) => r.role === 'stock');
  if (stock.length !== 1) return refuse('SELECT', stock.length === 0 ? 'NO_STOCK_RESERVATION' : 'STOCK_RESERVATION_AMBIGUOUS');
  const version = (stock[0] as (typeof stock)[number]).version;
  const record = session.versions.records.find((r) => r.version === version);
  if (record === undefined) return refuse('PRINCIPAL', 'VERSION_UNKNOWN');
  if (record.authorization.method === 'WALLET_EIP712') {
    const v = session.verifyWalletApproval(version);
    if (!v.ok) return refuse('PRINCIPAL', `WALLET_APPROVAL_UNVERIFIABLE.${v.reason}`);
  }
  // Past PREPARED, an attempt is only ever reconciled — even once the ledger has consumed or released it.
  const existing = journal.get((stock[0] as (typeof stock)[number]).record.reservation);
  if (existing !== null && existing.state !== 'PREPARED') return { status: 'RECONCILED_ONLY', reports, attempt: existing };
  const settlement = new LiveSettlement({ session, deployment: d, rpc, keys: i.keys });
  const p = await settlement.prepare();
  if ('ineligible' in p) return { status: 'INELIGIBLE', stage: p.stage, reason: p.ineligible, reports };
  const dry = await settlement.run(p, { mode: 'DRY_RUN', gate: new SendGate(), ledgerPath: i.scratchLedgerPath, journal });
  if (dry.status !== 'READY') return { status: 'NOT_READY', outcome: dry, reports };
  const principals = principalBinding(record.authorization, d);
  session.events.emit('TESTNET_READY_FOR_SEND', {
    agent: 'stock',
    data: {
      sessionId: session.id,
      reservation: p.execution.reservation,
      proposal: p.execution.proposal,
      bindingDigest: p.settlement.bindingDigest,
      wouldSend: dry.wouldSend,
      principals,
      broadcast: B53_BROADCAST,
      sendable: record.authorization.method === 'DEMO_PRINCIPAL_KEY' ? 'ONLY_WITH_AN_EXPLICIT_OPERATOR_AUTHORIZATION_IN_A_LATER_MILESTONE' : 'NEVER: A WALLET APPROVAL IS NOT DOMAIN DELEGATION',
      rpcProvider: rpc.provenance(),
      transactions: 0,
      qualification: ASSET_QUALIFICATION,
    },
  });
  return { status: 'READY_FOR_TESTNET_SEND', outcome: dry, principals, broadcast: B53_BROADCAST, reports };
}
