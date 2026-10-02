/**
 * The V2 session-bound settlement (docs/demo/authority-spine-v2.md):
 * what `npm run agents:settle:v2 -- --session <id>` does.
 *
 * ```text
 * restored session ─▶ reconcile every journaled attempt first
 *   ─▶ one reserved Stock child
 *   ─▶ reverify the EIP-712 V2 signature (no demonstration-key fallback)
 *   ─▶ an attempt already past PREPARED: reconcile only
 *   ─▶ DRY_RUN or, with an already-open send gate, one SEND
 * ```
 *
 * This path does not emit `TESTNET_READY_FOR_SEND`. That event is the B.5.3
 * dry run, whose client copy says broadcast is disabled.
 */

import type { LiveSession } from '@mandate/live-agents';
import type { TestnetDeployment } from './deployment.ts';
import type { DomainKeys } from './domain-leg.ts';
import { ASSET_QUALIFICATION } from './evidence.ts';
import type { AttemptRecord, SettlementJournal } from './journal.ts';
import { reconcileAttempts, type ReconcileReport } from './reconcile.ts';
import type { TestnetRpc } from './rpc.ts';
import type { SendGate } from './send-gate.ts';
import type { GateExecutionRequest } from './gate-authority.ts';
import { LiveSettlement, principalBinding, type PrincipalBinding, type SettlementOutcome } from './settlement.ts';
import { reverifySpine } from './spine.ts';

export type SpineSettlementResult =
  | { readonly status: 'RECONCILED_ONLY'; readonly reports: readonly ReconcileReport[]; readonly attempt: AttemptRecord }
  | { readonly status: 'INELIGIBLE'; readonly stage: string; readonly reason: string; readonly reports: readonly ReconcileReport[] }
  | { readonly status: 'NOT_READY'; readonly outcome: SettlementOutcome; readonly reports: readonly ReconcileReport[] }
  | { readonly status: 'READY'; readonly outcome: Extract<SettlementOutcome, { status: 'READY' }>; readonly principals: PrincipalBinding; readonly reports: readonly ReconcileReport[] }
  | { readonly status: 'SENT'; readonly outcome: SettlementOutcome; readonly principals: PrincipalBinding; readonly reports: readonly ReconcileReport[] };

export interface SpineSettlementInput {
  readonly session: LiveSession;
  readonly journal: SettlementJournal;
  readonly deployment: TestnetDeployment;
  readonly rpc: TestnetRpc;
  readonly keys: DomainKeys;
  readonly mode: 'DRY_RUN' | 'SEND';
  /** Already open when `mode` is SEND. A dry run never reads it. */
  readonly gate: SendGate;
  /** Domain-ledger file for this run. A dry run's file is scratch; a send's is kept. */
  readonly ledgerPath: string;
  /**
   * When the wallet is not the manifest principal, called with the gate
   * typed data. Return that wallet's `MandateAuthorization` signature, or
   * null to stop with nothing signed for broadcast. Ignored when the wallet
   * is the manifest principal.
   */
  readonly resolveGateExecution?: (request: GateExecutionRequest) => Promise<string | null> | string | null;
}

export async function settleSpine(i: SpineSettlementInput): Promise<SpineSettlementResult> {
  const { session, journal, deployment: d, rpc } = i;
  const reports = await reconcileAttempts({ journal, reader: rpc, session, deployment: d });
  const refuse = (stage: string, reason: string): SpineSettlementResult => {
    session.events.emit('DOMAIN_EXECUTION_INELIGIBLE', { agent: 'stock', data: { stage, reason, sessionId: session.id, transactions: 0, qualification: ASSET_QUALIFICATION } });
    return { status: 'INELIGIBLE', stage, reason, reports };
  };
  const stock = session.reservedExecutions.filter((r) => r.role === 'stock');
  if (stock.length !== 1) return refuse('SELECT', stock.length === 0 ? 'NO_STOCK_RESERVATION' : 'STOCK_RESERVATION_AMBIGUOUS');
  const reserved = stock[0] as (typeof stock)[number];
  const record = session.versions.records.find((r) => r.version === reserved.version);
  const held = session.versions.coreOf(reserved.version);
  if (record === undefined || held === null) return refuse('PRINCIPAL', 'VERSION_UNKNOWN');
  const check = reverifySpine({
    mandate: held.mandate,
    signature: held.signature,
    authorization: record.authorization,
    sessionId: session.id,
    chainId: d.chainId,
    now: session.protocolNow(),
  });
  session.events.emit('MANDATE_REVERIFY_STARTED', {
    agent: 'stock',
    data: { phase: 'SETTLEMENT', scheme: record.authorization.method === 'WALLET_PRINCIPAL_V2_PLAN' ? 'V2_PLAN_EIP712' : 'V2_EIP712', ok: check.ok, reason: check.ok ? null : check.reason, sessionId: session.id, path: 'EIP-712 portfolio mandate authorization re-verified, then settlement', transactions: 0 },
  });
  if (!check.ok) return refuse('PRINCIPAL', check.reason);
  const presented = check.principal.toLowerCase() !== d.principal.toLowerCase();
  const existing = journal.get(reserved.record.reservation);
  if (existing !== null && existing.state !== 'PREPARED') return { status: 'RECONCILED_ONLY', reports, attempt: existing };
  const settlement = new LiveSettlement({ session, deployment: d, rpc, keys: i.keys });
  const p = await settlement.prepare(presented ? check.principal : undefined);
  if ('ineligible' in p) return { status: 'INELIGIBLE', stage: p.stage, reason: p.ineligible, reports };
  const outcome = await settlement.run(p, {
    mode: i.mode,
    gate: i.gate,
    ledgerPath: i.ledgerPath,
    journal,
    ...(presented ? { gateExecution: 'WALLET_EIP712' as const, resolveGateExecution: i.resolveGateExecution ?? (() => null) } : {}),
  });
  const principals = principalBinding(record.authorization, d, presented && outcome.status !== 'INELIGIBLE' && outcome.status !== 'PREFLIGHT_FAILED' ? 'WALLET_EIP712' : undefined);
  if (outcome.status === 'INELIGIBLE') return { status: 'INELIGIBLE', stage: outcome.stage, reason: outcome.reason, reports };
  if (i.mode === 'DRY_RUN') {
    if (outcome.status !== 'READY') return { status: 'NOT_READY', outcome, reports };
    return { status: 'READY', outcome, principals, reports };
  }
  return { status: 'SENT', outcome, principals, reports };
}
