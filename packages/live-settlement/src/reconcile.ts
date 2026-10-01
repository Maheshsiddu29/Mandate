/**
 * Restart reconciliation (docs/demo/wallet-settlement-boundaries.md §5.4).
 *
 * On start, every non-terminal settlement attempt is judged from chain
 * evidence — deterministically: no model, no Room, no browser. The driver
 * holds a `ChainReader` only, so it cannot send anything: there is no
 * resend, ever.
 *
 * ```text
 * receipt status 1                        → CONFIRMED_SUCCESS → postconditions → SETTLED → portfolio CONSUME → CONSUMED
 * receipt status 0                        → CONFIRMED_REVERT  → (every artifact dead, no commitment) → RELEASED
 * no receipt, the node knows the hash     → STILL_PENDING     (nothing changes; "checking settlement status")
 * no receipt, hash unknown or never sent:
 *   a commitment recorded for an artifact → AMBIGUOUS: EXECUTED_OUTSIDE_ATTEMPT (quarantined for review)
 *   every artifact past its gate deadline → NEVER_SUBMITTED   → RELEASED (the gate refuses a dead artifact forever)
 *   otherwise                             → AMBIGUOUS: AWAITING_DEADLINE (held; never released, never resent)
 * anything unreadable                     → AMBIGUOUS (nothing changes)
 * ```
 *
 * **Possible economic execution ⇒ no release and no fresh send until
 * reconciled.** An RPC timeout is not a failure; a hash is not settlement;
 * only a mined receipt with status 1 and verified postconditions settles,
 * and only proof that no artifact can ever execute releases.
 */

import { ByteWriter } from '@mandate/kernel';
import { keccakDigest, type Digest32 } from '@mandate/core';
import type { Receipt } from '@mandate/evm-robinhood';
import type { LiveSession } from '@mandate/live-agents';
import { selectStockExecution } from './authorized-execution.ts';
import { explorerTxUrl, type TestnetDeployment } from './deployment.ts';
import { ASSET_QUALIFICATION } from './evidence.ts';
import { mapToFixture } from './fixture-mapping.ts';
import { isTerminal, type ArtifactRecord, type AttemptRecord, type AttemptState, type SettlementJournal } from './journal.ts';
import { consumeReservation, releaseReservation, reservationStatus } from './portfolio-ledger.ts';
import type { ChainReader } from './rpc.ts';
import { checkPostconditions, lifecycleDedupe, digestReceipt, type FaultPoint } from './settlement.ts';

export const RECONCILE_OUTCOMES = ['NEVER_SUBMITTED', 'STILL_PENDING', 'CONFIRMED_SUCCESS', 'CONFIRMED_REVERT', 'AMBIGUOUS'] as const;
export type ReconcileOutcome = (typeof RECONCILE_OUTCOMES)[number];

const ZERO32 = `0x${'00'.repeat(32)}`;

/** What one reconciliation pass read from the chain. `UNREADABLE` is never read as an answer. */
export interface ChainEvidence {
  readonly chainTime: bigint | 'UNREADABLE';
  readonly receipt: Receipt | null | 'UNREADABLE';
  readonly txKnown: boolean | 'UNREADABLE';
  /** Per artifact mandate digest: the commitment the gate records (zero: none). */
  readonly commitments: ReadonlyMap<string, string | 'UNREADABLE'>;
}

export interface Judgement {
  readonly outcome: ReconcileOutcome;
  readonly reason: string;
}

/** The latest chain time at which any artifact of the attempt could still execute. */
export function deadOnlyAfter(a: AttemptRecord, artifacts: readonly ArtifactRecord[]): bigint | null {
  const bounds = [...artifacts.map((x) => BigInt(x.deadline)), ...(a.artifactDeadAfter === null ? [] : [BigInt(a.artifactDeadAfter)])];
  return bounds.length === 0 ? null : bounds.reduce((m, b) => (b > m ? b : m));
}

/** Pure: what the evidence proves about one attempt's transaction and artifacts. */
export function judge(a: AttemptRecord, artifacts: readonly ArtifactRecord[], ev: ChainEvidence): Judgement {
  if (a.tx !== null) {
    if (ev.receipt === 'UNREADABLE') return { outcome: 'AMBIGUOUS', reason: 'RECEIPT_UNREADABLE' };
    if (ev.receipt !== null) return ev.receipt.status === 'SUCCESS' ? { outcome: 'CONFIRMED_SUCCESS', reason: `receipt status 1 in block ${ev.receipt.blockNumber}` } : { outcome: 'CONFIRMED_REVERT', reason: `receipt status 0 in block ${ev.receipt.blockNumber}` };
    if (ev.txKnown === 'UNREADABLE') return { outcome: 'AMBIGUOUS', reason: 'TRANSACTION_UNREADABLE' };
    if (ev.txKnown) return { outcome: 'STILL_PENDING', reason: 'the node knows the hash; no receipt yet' };
  }
  for (const x of artifacts) {
    const c = ev.commitments.get(x.mandateDigest);
    if (c === undefined || c === 'UNREADABLE') return { outcome: 'AMBIGUOUS', reason: 'COMMITMENT_UNREADABLE' };
    if (c !== ZERO32) return { outcome: 'AMBIGUOUS', reason: 'EXECUTED_OUTSIDE_ATTEMPT' };
  }
  const dead = deadOnlyAfter(a, artifacts);
  if (dead === null) return { outcome: 'NEVER_SUBMITTED', reason: 'no gate artifact ever left the process' };
  if (ev.chainTime === 'UNREADABLE') return { outcome: 'AMBIGUOUS', reason: 'CHAIN_TIME_UNREADABLE' };
  if (ev.chainTime > dead) return { outcome: 'NEVER_SUBMITTED', reason: `every artifact is past its gate deadline (${dead}) with no commitment recorded` };
  return { outcome: 'AMBIGUOUS', reason: 'AWAITING_DEADLINE' };
}

/** Read the evidence `judge` needs, one bounded read each. */
export async function gatherEvidence(reader: ChainReader, a: AttemptRecord, artifacts: readonly ArtifactRecord[]): Promise<ChainEvidence> {
  const latest = await reader.latest();
  const chainTime = latest.ok ? latest.value.timestamp : 'UNREADABLE';
  let receipt: ChainEvidence['receipt'] = null;
  let txKnown: ChainEvidence['txKnown'] = false;
  if (a.tx !== null) {
    const r = await reader.receiptOnce(a.tx.hash);
    receipt = r.ok ? r.value : 'UNREADABLE';
    if (receipt === null) {
      const t = await reader.transaction(a.tx.hash);
      txKnown = t.ok ? t.value !== null : 'UNREADABLE';
    }
  }
  const commitments = new Map<string, string | 'UNREADABLE'>();
  for (const x of artifacts) {
    // Read at the block whose time decides deadness: a later commitment cannot exist for a dead artifact.
    const c = await reader.executionCommitmentOf(a.gate, x.mandateDigest, latest.ok ? latest.value.number : undefined);
    commitments.set(x.mandateDigest, c.ok ? c.value.toLowerCase() : 'UNREADABLE');
  }
  return { chainTime, receipt, txKnown, commitments };
}

export interface ReconcileDeps {
  readonly journal: SettlementJournal;
  /** Reads only: reconciliation can never send. */
  readonly reader: ChainReader;
  /** The durable session, restored. */
  readonly session: LiveSession;
  readonly deployment: TestnetDeployment;
  readonly fault?: (p: FaultPoint) => void;
}

export interface ReconcileReport {
  readonly reservation: string;
  readonly from: AttemptState;
  readonly to: AttemptState;
  readonly outcome: ReconcileOutcome | 'NOTHING_TO_DO' | 'EVIDENCE_MISSING';
  readonly detail: string;
}

/** The observation a release names: the evidence that no artifact of the attempt can ever execute. */
export function noExecutionObservation(a: AttemptRecord, artifacts: readonly ArtifactRecord[], chainTime: bigint): Digest32 {
  const w = new ByteWriter().str('mandate/live-settlement/no-execution').u16(1).str(a.reservation).u64(chainTime).u16(artifacts.length);
  for (const x of artifacts) w.str(x.mandateDigest).str(x.deadline);
  return keccakDigest<Digest32>(w.finish());
}

/**
 * Reconcile every attempt in the journal: drive non-terminal ones as far as
 * evidence allows, and make sure every outcome a browser must see has been
 * emitted to the session (exactly once: lifecycle events carry dedupe keys).
 */
export async function reconcileAttempts(deps: ReconcileDeps): Promise<readonly ReconcileReport[]> {
  const { journal, reader, session } = deps;
  const attempts = journal.all();
  const emit = (kind: Parameters<typeof session.events.emit>[0], data: { readonly [k: string]: unknown }, dedupe?: string) =>
    session.events.emit(kind, { agent: 'stock', data: { ...data, rpcProvider: reader.provenance(), qualification: ASSET_QUALIFICATION }, ...(dedupe === undefined ? {} : { dedupe }) });
  emit('SETTLEMENT_RECONCILIATION_STARTED', { attempts: attempts.filter((a) => !isTerminal(a)).length, sessionId: session.id, by: 'deterministic reconciliation: chain evidence only; no model, no Room, nothing sent' });
  const reports: ReconcileReport[] = [];
  for (const first of attempts) reports.push(await reconcileOne(deps, first, emit));
  return reports;
}

type Emit = (kind: Parameters<LiveSession['events']['emit']>[0], data: { readonly [k: string]: unknown }, dedupe?: string) => unknown;

async function reconcileOne(deps: ReconcileDeps, first: AttemptRecord, emit: Emit): Promise<ReconcileReport> {
  const { journal, reader, session, deployment: d } = deps;
  const from = first.state;
  let a = first;
  let outcome: ReconcileReport['outcome'] = 'NOTHING_TO_DO';
  let detail = '';
  const moved = (to: AttemptState, extra: Parameters<SettlementJournal['transition']>[2], why: string) => {
    a = journal.transition(a.reservation, to, extra, why);
    detail = why;
    emit('SETTLEMENT_RECONCILED', { reservation: a.reservation, from, state: a.state, quarantine: a.quarantine, outcome, detail: why, txHash: a.tx?.hash ?? null, sessionId: session.id }, lifecycleDedupe(a.reservation, `RECONCILED:${a.state}:${a.quarantine ?? ''}`));
  };

  const x = selectStockExecution(session.reservedExecutions.filter((r) => r.record.reservation === a.reservation));
  const core = session.versions.coreOf(a.version)?.core;
  if (!x.ok || core === undefined) return { reservation: a.reservation, from, to: a.state, outcome: 'EVIDENCE_MISSING', detail: 'the reserved execution or its version is not in the restored session; nothing is changed' };
  const authorization = session.versions.records.find((r) => r.version === a.version)?.authorization;
  // A V2 wallet that is not the manifest principal is the fixture recipient. Every other path still debits the deployment principal.
  const walletRecipient = authorization?.method === 'WALLET_PRINCIPAL_V2' && authorization.principal.toLowerCase() !== d.principal.toLowerCase() ? authorization.principal.toLowerCase() : undefined;
  const m = walletRecipient === undefined ? mapToFixture(x.execution, d) : mapToFixture(x.execution, d, walletRecipient);
  if (!m.ok || m.value.bindingDigest !== a.binding) return { reservation: a.reservation, from, to: a.state, outcome: 'EVIDENCE_MISSING', detail: 'the journal binding is not this execution’s; nothing is changed' };
  const s = m.value;
  const artifacts = journal.artifacts(a.reservation);

  // 1. Where did the transaction (or its artifacts) end up?
  if (a.state === 'SUBMISSION_STARTED' || a.state === 'SUBMITTED' || (a.state === 'RECONCILIATION_REQUIRED' && !isTerminal(a)) || (a.state === 'PREPARED' && a.domainOpenedAt !== null)) {
    const ev = await gatherEvidence(reader, a, artifacts);
    const j = judge(a, artifacts, ev);
    outcome = j.outcome;
    if (j.outcome === 'CONFIRMED_SUCCESS' || j.outcome === 'CONFIRMED_REVERT') {
      const r = ev.receipt as Receipt;
      const observation = a.tx !== null && a.sendArtifact !== null ? digestReceipt(d, a.tx.hash, r, a.sendArtifact.mandateDigest, a.sendArtifact.commitment, s.bindingDigest) : null;
      moved(j.outcome, { receipt: { status: r.status, blockNumber: r.blockNumber.toString(), blockHash: r.blockHash, gasUsed: r.gasUsed.toString(), effectiveGasPrice: r.effectiveGasPrice.toString() }, observation }, j.reason);
    } else if (j.outcome === 'STILL_PENDING') {
      if (a.state === 'SUBMISSION_STARTED' || a.state === 'RECONCILIATION_REQUIRED') moved('SUBMITTED', {}, j.reason);
      else detail = j.reason;
    } else if (j.outcome === 'NEVER_SUBMITTED') {
      const chainTime = ev.chainTime === 'UNREADABLE' ? 0n : ev.chainTime;
      const released = await releaseReservation(core, a.reservation, noExecutionObservation(a, artifacts, chainTime), session.protocolNow());
      if (released.ok) {
        moved('RELEASED', {}, `${j.reason}; portfolio reservation released`);
        emit('RESERVATION_RELEASED', { reservation: a.reservation, ledgerVersion: released.ledgerVersion, reason: j.reason, sessionId: session.id }, lifecycleDedupe(a.reservation, 'RESERVATION_RELEASED'));
      } else detail = `release refused: ${released.reason}`;
    } else if (j.reason === 'EXECUTED_OUTSIDE_ATTEMPT') {
      moved('RECONCILIATION_REQUIRED', { quarantine: 'EXECUTED_OUTSIDE_ATTEMPT' }, 'a gate commitment exists for an artifact of this attempt but no receipt for its transaction: quarantined for review; nothing released, nothing resent');
    } else if (a.state !== 'RECONCILIATION_REQUIRED') {
      moved('RECONCILIATION_REQUIRED', { quarantine: j.reason === 'AWAITING_DEADLINE' ? 'AWAITING_DEADLINE' : 'AMBIGUOUS_BROADCAST' }, `${j.reason}: held; nothing released, nothing resent`);
    } else if (a.quarantine !== 'AWAITING_DEADLINE' && j.reason === 'AWAITING_DEADLINE') {
      a = journal.requarantine(a.reservation, 'AWAITING_DEADLINE', j.reason);
      detail = j.reason;
    } else detail = j.reason;
  }

  // 2. A confirmed success settles only with verified postconditions.
  if (a.state === 'CONFIRMED_SUCCESS') {
    const r = a.receipt;
    if (r === null || a.sendArtifact === null) detail = 'confirmed without receipt facts: left for review';
    else {
      const receipt: Receipt = { status: 'SUCCESS', blockNumber: BigInt(r.blockNumber), blockHash: r.blockHash, gasUsed: BigInt(r.gasUsed), effectiveGasPrice: BigInt(r.effectiveGasPrice), contractAddress: null, logs: 0 };
      const before = a.before === null ? null : { block: BigInt(a.before.block), tokenIn: BigInt(a.before.tokenIn), tokenOut: BigInt(a.before.tokenOut), agentTokenOut: BigInt(a.before.agentTokenOut) };
      const post = await checkPostconditions(reader, s, receipt, a.sendArtifact.mandateDigest, a.sendArtifact.commitment, before);
      if (post.ok) moved('SETTLED', { postconditions: { ok: true, failures: [] } }, 'postconditions verified at the receipt block');
      else moved('RECONCILIATION_REQUIRED', { quarantine: 'POSTCONDITION_ANOMALY', postconditions: { ok: false, failures: post.failures } }, `postconditions failed: ${post.failures.join(',')}; quarantined, never released`);
    }
  }
  if (a.state === 'SETTLED') deps.fault?.('AFTER_SETTLED');

  // 3. Settled ⇒ consumed, durably; consumed ⇒ the browser hears it, once.
  if (a.state === 'SETTLED') {
    const consumed = await consumeReservation(core, a.reservation, (a.observation ?? ZERO32) as Digest32, session.protocolNow());
    if (consumed.ok) moved('CONSUMED', {}, `portfolio reservation consumed${consumed.already ? ' (already, in the ledger)' : ''}`);
    else detail = `consumption refused: ${consumed.reason}; retried on the next reconciliation, never released`;
  }
  if (a.state === 'CONSUMED') {
    const ledger = (await core.engine.read(core.compiled.mandate.principal)).state;
    emit('DOMAIN_EXECUTION_SETTLED', { reservation: a.reservation, txHash: a.tx?.hash ?? null, block: a.receipt?.blockNumber ?? null, status: 'SUCCESS', evidence: a.evidenceClass === 'ROBINHOOD_TESTNET_RPC' ? 'LIVE_TESTNET' : 'REFERENCE_MODEL', receiptDigest: a.observation, explorerUrl: a.tx === null ? null : explorerTxUrl(d, a.tx.hash), recoveredBy: 'reconciliation', sessionId: session.id }, lifecycleDedupe(a.reservation, 'DOMAIN_EXECUTION_SETTLED'));
    emit('RESERVATION_CONSUMED', { reservation: a.reservation, txHash: a.tx?.hash ?? null, receiptDigest: a.observation, ledgerStatus: reservationStatus(ledger, a.reservation), sessionId: session.id, effect: 'The portfolio reservation is consumed and closed in the durable ledger: it can never authorize another execution.' }, lifecycleDedupe(a.reservation, 'RESERVATION_CONSUMED'));
  }

  // 4. A confirmed revert releases only once nothing can execute any more.
  if (a.state === 'CONFIRMED_REVERT') {
    const ev = await gatherEvidence(reader, { ...a, tx: null }, artifacts);
    const j = judge({ ...a, tx: null }, artifacts, ev);
    if (j.outcome === 'NEVER_SUBMITTED') {
      const chainTime = ev.chainTime === 'UNREADABLE' ? 0n : ev.chainTime;
      const released = await releaseReservation(core, a.reservation, noExecutionObservation(a, artifacts, chainTime), session.protocolNow());
      if (released.ok) {
        moved('RELEASED', {}, `reverted, and ${j.reason}; portfolio reservation released`);
        emit('RESERVATION_RELEASED', { reservation: a.reservation, ledgerVersion: released.ledgerVersion, reason: j.reason, sessionId: session.id }, lifecycleDedupe(a.reservation, 'RESERVATION_RELEASED'));
      }
    } else detail = `reverted; held until ${j.reason === 'AWAITING_DEADLINE' ? 'every artifact is past its deadline' : j.reason}`;
  }
  if (isTerminal(a) && a.state === 'RECONCILIATION_REQUIRED') {
    emit('SETTLEMENT_RECONCILED', { reservation: a.reservation, from, state: a.state, quarantine: a.quarantine, outcome: 'AMBIGUOUS', detail: 'Settlement needs review. No retry was sent.', txHash: a.tx?.hash ?? null, sessionId: session.id }, lifecycleDedupe(a.reservation, `RECONCILED:${a.state}:${a.quarantine ?? ''}`));
  }
  return { reservation: a.reservation, from, to: a.state, outcome, detail };
}
