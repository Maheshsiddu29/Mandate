/**
 * C1.5: a held settlement attempt is restored from the durable journal —
 * after a reload (another session read) and after a lab restart (a fresh
 * LiveLab and SpineUi over the same state directory) — and is never shown
 * as executable until reconciliation resolves it.
 *
 * Real LiveLab, real settleSpine and reconcileAttempts, durable SQLite
 * session, journal and ledgers. The chain is the Phase 6 reference model
 * (ModelRpc): no network, nothing reaches Robinhood Chain.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionDir, type LiveEvent } from '@mandate/live-agents';
import { addressOfKey } from '@mandate/portfolio/demo';
import { LiveLab } from '../../live-agents/src/server/app.ts';
import { ManualClock } from '../../live-agents/src/runtime/clock.ts';
import type { GateExecutionRequest } from '../src/gate-authority.ts';
import { SettlementJournal } from '../src/journal.ts';
import { reconcileAttempts } from '../src/reconcile.ts';
import type { DurableSettlement } from '../src/settlement-state.ts';
import { settleSpine } from '../src/spine-settlement.ts';
import { SpineUi } from '../src/ui-settle.ts';
import { GATE, KEYS, MDUSD, PRINCIPAL_KEY, ModelRpc, testDeployment } from './support/world.ts';
import { OTHER_KEY, SPINE_TIMEOUTS, signGate, v2Session } from './support/spine-session.ts';

type Body = { readonly [k: string]: unknown };

/** One `agents:lab` process: its lab, its settlement routes, and nothing that survives it but the state directory. */
function labProcess(dir: string, rpc: ModelRpc) {
  const lab = new LiveLab({ live: null, clock: new ManualClock(), ...SPINE_TIMEOUTS, allowChaos: false, stateDir: dir, idleMs: -1 });
  const ui = new SpineUi({
    openSession: (id) => lab.openSession(id),
    taskOf: (id) => lab.taskOf(id),
    settle: (input) => settleSpine(input),
    reconcile: (deps) => reconcileAttempts(deps),
    deployment: testDeployment(),
    rpc,
    keys: KEYS,
    journalFor: (s) => SettlementJournal.open(join(sessionDir(dir, s.id), 'settlement.db')),
    scratch: () => ({ path: join(dir, 'unused-scratch.db'), cleanup: () => undefined }),
    ledgerPath: (s) => join(sessionDir(dir, s.id), 'domain-ledger.db'),
    schedule: () => () => undefined,
    signatureWaitMs: 1_000,
  });
  const path = (id: string) => `/api/live/sessions/${id}`;
  return {
    /** What a reloaded page fetches. */
    read: async (id: string): Promise<{ readonly view: Body; readonly settlement: DurableSettlement }> => {
      const r = await ui.handle('GET', path(id), null, () => lab.handle({ method: 'GET', path: path(id), query: new URLSearchParams(), body: null }));
      assert.equal(r?.status, 200);
      const view = (r as NonNullable<typeof r>).body as Body;
      return { view, settlement: view['settlement'] as unknown as DurableSettlement };
    },
    settle: async (id: string, b: Body): Promise<{ readonly status: number; readonly body: Body }> => {
      const r = await ui.handle('POST', `${path(id)}/settle`, b);
      assert.ok(r);
      return { status: r.status, body: r.body as Body };
    },
    events: async (id: string): Promise<readonly LiveEvent[]> => (await lab.openSession(id))?.events.events ?? [],
    /** The process exits: every session leaves memory. */
    stop: () => lab.sweep(),
  };
}

const EXECUTE = { mode: 'SEND', intent: 'EXECUTE_ROBINHOOD_TESTNET' } as const;
const RECONCILE = { mode: 'RECONCILE' } as const;
/** What a run does; a reload, a restart or a settlement must not do any of it again. */
const RUN_KINDS = /^(AGENT_REQUEST_STARTED|AGENT_DECISION_COMPLETED|PROPOSAL_SIGNED|ROOM_OPENED|ROOM_GENERATION_STARTED|PORTFOLIO_AUTHORIZED|MANDATE_VERSION_AUTHORIZED)$/;
const count = (events: readonly LiveEvent[], kind: RegExp) => events.filter((e) => kind.test(e.kind)).length;

function withDir(f: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mandate-held-restore-'));
  return f(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('C1.5 held settlement attempts survive reload and restart', () => {
  it('a signed attempt held on a failed chain read is restored HELD after a reload and after a restart, offers no execute, and ends RELEASED from evidence only', async () => {
    await withDir(async (dir) => {
      const id = 'lab-held-restore';
      await v2Session(dir, OTHER_KEY, id);
      const wallet = addressOfKey(OTHER_KEY);
      const rpc = new ModelRpc();
      rpc.chain.fund(MDUSD, wallet, 700_000_000n);
      rpc.chain.approve(MDUSD, wallet, GATE, 200_000_000n);

      const a = labProcess(dir, rpc);
      // READY: nothing attempted, the reservation open — Execute may be offered, exactly as before.
      const ready = await a.read(id);
      assert.equal(ready.settlement.settlementStatus, 'NO_ATTEMPT');
      assert.equal(ready.settlement.reservationState, 'RESERVED');
      assert.equal(ready.settlement.executable, true);
      assert.equal(ready.settlement.held, false);
      assert.equal(ready.settlement.transactions, 0);
      const reservations = (ready.view['reservations'] as readonly Body[]).length;
      const runEvents = count(await a.events(id), RUN_KINDS);

      // The post-signature gate-market read meets a node behind the pinned block.
      const original = rpc.gateMarkets.bind(rpc);
      let reads = 0;
      rpc.gateMarkets = async (policy) => ((reads += 1) === 2 ? { status: 'UNKNOWN', reason: 'MARKET.BLOCK_AHEAD_OF_NODE.RPC_-32000:unsupported block number 128270281' } : original(policy));
      const parked = await a.settle(id, EXECUTE);
      assert.equal(parked.body['status'], 'GATE_SIGNATURE_REQUIRED');
      const waiting = await a.read(id);
      assert.equal(waiting.settlement.settlementStatus, 'SIGNATURE_REQUIRED');
      assert.equal(waiting.settlement.pending, 'AWAITING_SIGNATURE');
      assert.equal(waiting.settlement.executable, false);
      const request = parked.body['gateExecution'] as unknown as GateExecutionRequest;
      const refused = await a.settle(id, { mode: 'SEND', gateSignature: signGate(request, OTHER_KEY) });
      rpc.gateMarkets = original;

      // 1–2. The signed attempt is held, and the refusal says so.
      assert.equal(refused.status, 409);
      assert.equal(refused.body['held'], true);
      assert.equal(refused.body['attemptState'], 'PREPARED');
      assert.equal(refused.body['transactions'], 0);
      assert.equal(refused.body['txHash'], null);
      const heldUntil = refused.body['heldUntil'];
      assert.match(String(heldUntil), /^\d+$/);

      // 3, 5. A reload reads the same hold back from the journal: no Execute.
      const before = (await a.events(id)).length;
      const reloaded = await a.read(id);
      assert.equal((await a.events(id)).length, before, 'a read appends nothing');
      assert.deepEqual(
        { status: reloaded.settlement.settlementStatus, held: reloaded.settlement.held, heldUntil: reloaded.settlement.heldUntil, attempt: reloaded.settlement.attemptState, tx: reloaded.settlement.txHash, transactions: reloaded.settlement.transactions, executable: reloaded.settlement.executable, pending: reloaded.settlement.pending },
        { status: 'HELD', held: true, heldUntil, attempt: 'PREPARED', tx: null, transactions: 0, executable: false, pending: null },
      );
      assert.equal(reloaded.settlement.reservationState, 'ADMITTED');

      // 4, 6. A restart: a fresh lab and settlement routes over the same directory restore the same hold.
      a.stop();
      const b = labProcess(dir, rpc);
      const restarted = await b.read(id);
      assert.equal(restarted.settlement.settlementStatus, 'HELD');
      assert.equal(restarted.settlement.held, true);
      assert.equal(restarted.settlement.heldUntil, heldUntil);
      assert.equal(restarted.settlement.executable, false);
      assert.equal(restarted.settlement.txHash, null);
      assert.equal(restarted.settlement.transactions, 0);
      assert.equal(restarted.view['restored'], true);

      // A stale client that still posts Execute is reconciled only: no signature request, nothing sent.
      const stale = await b.settle(id, EXECUTE);
      assert.equal(stale.status, 200);
      assert.equal(stale.body['status'], 'RECONCILED_ONLY');
      const quarantined = await b.read(id);
      assert.equal(quarantined.settlement.settlementStatus, 'HELD');
      assert.equal(quarantined.settlement.attemptState, 'RECONCILIATION_REQUIRED');
      assert.equal(quarantined.settlement.quarantine, 'AWAITING_DEADLINE');
      assert.equal(quarantined.settlement.heldUntil, heldUntil);

      // Before every artifact is dead, reconciliation keeps it held.
      const early = await b.settle(id, RECONCILE);
      assert.equal(early.status, 200);
      assert.equal((early.body['settlement'] as unknown as DurableSettlement).settlementStatus, 'HELD');

      // 12. Past the deadline (chain time, not wall-clock): released by evidence, and still not executable.
      rpc.chain.time += 2_000n;
      const released = await b.settle(id, RECONCILE);
      const r = released.body['settlement'] as unknown as DurableSettlement;
      assert.deepEqual(
        { status: r.settlementStatus, attempt: r.attemptState, reservation: r.reservationState, held: r.held, heldUntil: r.heldUntil, executable: r.executable, transactions: r.transactions },
        { status: 'RELEASED', attempt: 'RELEASED', reservation: 'RELEASED', held: false, heldUntil: null, executable: false, transactions: 0 },
      );
      assert.equal(count(await b.events(id), /^RESERVATION_RELEASED$/), 1);

      b.stop();
      const c = labProcess(dir, rpc);
      assert.equal((await c.read(id)).settlement.settlementStatus, 'RELEASED');
      const after = await c.settle(id, EXECUTE);
      assert.equal(after.body['status'], 'RECONCILED_ONLY');

      // 7–11. One gate signature request in total; no model, Room or reservation again; nothing broadcast.
      const events = await c.events(id);
      assert.equal(count(events, /^GATE_EXECUTION_SIGNATURE_REQUIRED$/), 1);
      assert.equal(count(events, RUN_KINDS), runEvents);
      assert.equal(((await c.read(id)).view['reservations'] as readonly Body[]).length, reservations);
      assert.equal(rpc.prepared, 0);
      assert.equal(rpc.broadcasts, 0);
      assert.equal(rpc.chain.txs.length, 0);
      c.stop();
    });
  });

  it('a submitted transaction restores SUBMITTED with its hash after a restart, and once confirmed restores SETTLED and consumed — never executable', async () => {
    await withDir(async (dir) => {
      const id = 'lab-submitted-restore';
      await v2Session(dir, PRINCIPAL_KEY, id);
      const rpc = new ModelRpc();
      rpc.withholdReceipts = true;
      const a = labProcess(dir, rpc);
      const sent = await a.settle(id, EXECUTE);
      assert.equal(sent.status, 200);
      assert.equal(sent.body['outcome'], 'SUBMITTED_UNCONFIRMED');
      const hash = sent.body['txHash'];

      // 14. SUBMITTED, with the journaled hash, after a reload and after a restart.
      const submitted = (await a.read(id)).settlement;
      assert.deepEqual(
        { status: submitted.settlementStatus, tx: submitted.txHash, transactions: submitted.transactions, held: submitted.held, executable: submitted.executable },
        { status: 'SUBMITTED', tx: hash, transactions: 1, held: true, executable: false },
      );
      a.stop();
      const b = labProcess(dir, rpc);
      const restored = (await b.read(id)).settlement;
      assert.equal(restored.settlementStatus, 'SUBMITTED');
      assert.equal(restored.txHash, hash);
      assert.equal(restored.executable, false);
      assert.equal((await b.settle(id, EXECUTE)).body['status'], 'RECONCILED_ONLY');
      assert.equal(rpc.broadcasts, 1);

      // 13. The receipt arrives: reconciliation settles and consumes; a restart restores SETTLED.
      rpc.withholdReceipts = false;
      const settled = (await b.settle(id, RECONCILE)).body['settlement'] as unknown as DurableSettlement;
      assert.equal(settled.settlementStatus, 'SETTLED');
      assert.equal(settled.attemptState, 'CONSUMED');
      assert.equal(settled.reservationState, 'CONSUMED');
      b.stop();
      const c = labProcess(dir, rpc);
      const final = (await c.read(id)).settlement;
      assert.deepEqual(
        { status: final.settlementStatus, attempt: final.attemptState, reservation: final.reservationState, tx: final.txHash, transactions: final.transactions, held: final.held, executable: final.executable, receipt: final.receiptStatus },
        { status: 'SETTLED', attempt: 'CONSUMED', reservation: 'CONSUMED', tx: hash, transactions: 1, held: false, executable: false, receipt: 'SUCCESS' },
      );
      assert.equal((await c.settle(id, EXECUTE)).body['status'], 'RECONCILED_ONLY');
      assert.equal(rpc.broadcasts, 1);
      assert.equal(count(await c.events(id), /^GATE_EXECUTION_SIGNATURE_REQUIRED$/), 0);
      c.stop();
    });
  });
});
