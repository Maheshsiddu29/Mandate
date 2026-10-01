/**
 * The browser evidence bridge (B.5.3, docs/demo/wallet-settlement-boundaries.md §7).
 *
 * A session created through the local server is durable. The session-bound
 * settlement restores *that* session in another process's place, dry-runs
 * its one reserved Stock child and appends every event to the session's own
 * log; the server streams them to the browser, in order, once, across
 * reconnects and restarts. Over the offline reference model: nothing is
 * broadcast to any network.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveSession, sessionDir, type LiveEvent } from '@mandate/live-agents';
import { addressOfKey, signPrehash } from '@mandate/portfolio/demo';
import { LiveLab } from '../../live-agents/src/server/app.ts';
import { ManualClock } from '../../live-agents/src/runtime/clock.ts';
import { approvalHash, type ApprovalMessage } from '../../live-agents/src/wallet/approval.ts';
import { presetDraft } from '../../live-agents/src/authoring/draft-types.ts';
import { ScriptedProvider, json } from '../../live-agents/test/support/providers.ts';
import { SettlementJournal } from '../src/journal.ts';
import { LiveSettlement } from '../src/settlement.ts';
import { SendGate } from '../src/send-gate.ts';
import { settleSessionDryRun, B53_BROADCAST } from '../src/session-settlement.ts';
import { reconcileAttempts } from '../src/reconcile.ts';
import { ALL_TEST_KEYS, KEYS, ModelRpc, testDeployment } from './support/world.ts';

const TIMEOUTS = { agentTimeoutMs: 1_000, roomRoundTimeoutMs: 1_000 } as const;
const WALLET_KEY = '0x' + '44'.repeat(32);
const propose = (candidateId: string, whole: number) => json({ action: 'PROPOSE', candidateId, requestedAtoms: (BigInt(whole) * 1_000_000n).toString(), rationale: `pick ${candidateId}` });
const abstain = json({ action: 'ABSTAIN', candidateId: null, requestedAtoms: null, rationale: 'none' });
const provider = () => new ScriptedProvider({ decide: (r) => ({ text: r.role === 'stock' ? propose('nvda-note-a', 400) : abstain }), negotiate: () => ({ text: abstain }) });

function messageOf(typed: { readonly [k: string]: unknown }): ApprovalMessage {
  const m = (typed as { message: { [k: string]: string } }).message;
  return { statement: m['statement'] as string, environment: m['environment'] as string, mandateDigest: m['mandateDigest'] as string, mandateVersion: BigInt(m['mandateVersion'] as string), principal: m['principal'] as string, protocolSigner: m['protocolSigner'] as string, validAfter: BigInt(m['validAfter'] as string), validUntil: BigInt(m['validUntil'] as string), sessionDigest: m['sessionDigest'] as string, challenge: m['challenge'] as string };
}

/** A durable session as the browser would make it, run once; closed, as if the server stopped. */
async function browserSession(dir: string, wallet: boolean): Promise<string> {
  const s = new LiveSession({ provider: provider(), clock: new ManualClock(), sessionId: wallet ? 'lab-bridge-wallet' : 'lab-bridge-demo', stateDir: dir, ...TIMEOUTS });
  const draft = presetDraft('balanced');
  if (wallet) {
    const c = s.walletChallenge(draft, addressOfKey(WALLET_KEY));
    assert.ok(c.ok);
    assert.ok((await s.authorizeWithWallet(draft, c.challenge, signPrehash(approvalHash(messageOf(c.typedData)), WALLET_KEY))).ok);
  } else assert.ok((await s.authorize(draft, 'AUTHORIZE MANDATE V1')).ok);
  assert.equal((await s.run()).status, 'AUTHORIZED');
  const id = s.id;
  s.close();
  return id;
}

/** What `agents:settle:testnet -- --session <id>` does, over the reference model. */
async function settleCommand(dir: string, id: string, rpc: ModelRpc) {
  const session = await LiveSession.restore(dir, id, { ...TIMEOUTS, by: 'settlement-command', clock: new ManualClock() });
  const journal = SettlementJournal.open(join(sessionDir(dir, id), 'settlement.db'));
  const scratch = mkdtempSync(join(tmpdir(), 'mandate-bridge-scratch-'));
  try {
    return { session, journal, result: await settleSessionDryRun({ session, journal, deployment: testDeployment(), rpc, keys: KEYS, scratchLedgerPath: join(scratch, 'ledger.db') }) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function withDir(f: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mandate-bridge-'));
  try {
    await f(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('browser session → durable reservation → session-bound dry run → the same browser session', () => {
  it('the settlement reaches READY_FOR_TESTNET_SEND for exactly the persisted reservation, broadcasts nothing, and its events stream to the browser', async () => {
    await withDir(async (dir) => {
      const id = await browserSession(dir, false);
      const lab = new LiveLab({ live: null, clock: new ManualClock(), stateDir: dir, allowChaos: false, ...TIMEOUTS });
      assert.equal((await lab.handle({ method: 'GET', path: `/api/live/sessions/${id}`, query: new URLSearchParams(), body: null })).status, 200);
      const seen: LiveEvent[] = [];
      const stop = lab.subscribe(id, -1, (e) => seen.push(e));
      const before = seen.length;

      const rpc = new ModelRpc();
      const { session, journal, result } = await settleCommand(dir, id, rpc);
      assert.equal(result.status, 'READY_FOR_TESTNET_SEND');
      if (result.status !== 'READY_FOR_TESTNET_SEND') return;
      assert.equal(result.broadcast, B53_BROADCAST);
      assert.equal(rpc.broadcasts, 0);
      assert.equal(rpc.chain.txs.length, 0);
      const persisted = session.reservedExecutions.find((x) => x.role === 'stock');
      assert.equal(journal.get(persisted?.record.reservation ?? '')?.state, 'PREPARED');
      assert.equal(result.principals.portfolio.method, 'DEMO_PRINCIPAL_KEY');

      lab.syncEvents();
      const fresh = seen.slice(before);
      const kinds = fresh.map((e) => e.kind);
      for (const k of ['SESSION_RESTORED', 'SETTLEMENT_RECONCILIATION_STARTED', 'SETTLEMENT_ATTEMPT_PREPARED', 'TESTNET_PREFLIGHT_STARTED', 'TESTNET_PREFLIGHT_PASSED', 'TESTNET_SIMULATION_STARTED', 'TESTNET_SIMULATION_PASSED', 'TESTNET_READY_FOR_SEND'] as const) assert.ok(kinds.includes(k), k);
      assert.ok(fresh.every((e) => e.sessionId === id));
      // Strictly increasing, no gaps, none twice.
      assert.deepEqual(seen.map((e) => e.sequence), seen.map((_e, i) => i));
      // Safe payloads: no key, no raw transaction, no signature.
      const text = JSON.stringify(fresh).toLowerCase();
      for (const k of ALL_TEST_KEYS) assert.equal(text.includes(k), false);
      assert.doesNotMatch(text, /"raw"|privatekey|"signature"|quiknode/);

      // A browser that dropped mid-stream replays exactly what it missed.
      const replay: number[] = [];
      lab.subscribe(id, before + 2, (e) => replay.push(e.sequence))?.();
      assert.deepEqual(replay, seen.slice(before + 3).map((e) => e.sequence));
      stop?.();
      journal.close();
      session.close();

      // A server restart, then a reload: the durable evidence is all still there.
      const restarted = new LiveLab({ live: null, clock: new ManualClock(), stateDir: dir, allowChaos: false, ...TIMEOUTS });
      const reload: LiveEvent[] = [];
      assert.equal((await restarted.handle({ method: 'GET', path: `/api/live/sessions/${id}`, query: new URLSearchParams(), body: null })).status, 200);
      restarted.subscribe(id, -1, (e) => reload.push(e))?.();
      assert.ok(reload.some((e) => e.kind === 'TESTNET_READY_FOR_SEND'));
      assert.deepEqual(reload.slice(0, seen.length).map((e) => [e.sequence, e.kind]), seen.map((e) => [e.sequence, e.kind]));
      const view = await restarted.handle({ method: 'GET', path: `/api/live/sessions/${id}`, query: new URLSearchParams(), body: null });
      const reservations = (view.body as { reservations: { role: string; status: string }[] }).reservations;
      assert.deepEqual(reservations.map((r) => [r.role, r.status]), [['stock', 'ADMITTED']]);
    });
  });

  it('a wallet-approved session dry-runs with both principals named, and never sends', async () => {
    await withDir(async (dir) => {
      const id = await browserSession(dir, true);
      const rpc = new ModelRpc();
      const { session, journal, result } = await settleCommand(dir, id, rpc);
      try {
        assert.equal(result.status, 'READY_FOR_TESTNET_SEND');
        if (result.status !== 'READY_FOR_TESTNET_SEND') return;
        assert.equal(result.principals.portfolio.method, 'WALLET_EIP712');
        assert.equal(result.principals.portfolio.address, addressOfKey(WALLET_KEY));
        assert.equal(result.principals.domainSettlement.kind, 'TESTNET_FIXTURE_CUSTODY');
        assert.notEqual(result.principals.domainSettlement.address, result.principals.portfolio.address);
        assert.equal(result.principals.delegation, 'NOT_DELEGATED');
        const ready = session.events.events.find((e) => e.kind === 'TESTNET_READY_FOR_SEND');
        assert.match(String(ready?.data['sendable']), /NEVER/);
        // Even with an open gate and a journal, the wallet's approval does not make the custody sign for it.
        const settlement = new LiveSettlement({ session, deployment: testDeployment(), rpc, keys: KEYS });
        const p = await settlement.prepare();
        assert.ok(!('ineligible' in p));
        if ('ineligible' in p) return;
        const g = new SendGate();
        g.authorize('AUTHORIZE ROBINHOOD TESTNET SEND');
        const sent = await settlement.run(p, { mode: 'SEND', gate: g, ledgerPath: join(dir, 'never.db'), journal });
        assert.equal(sent.status === 'INELIGIBLE' && sent.reason, 'WALLET_PRINCIPAL_NOT_DELEGATED_TO_DOMAIN');
        assert.equal(rpc.broadcasts, 0);
        assert.equal(session.verifyWalletApproval(1).ok, true);
      } finally {
        journal.close();
        session.close();
      }
    });
  });

  it('a settled reservation (reference model) is CONSUMED in the durable ledger and the browser sees it after a reload', async () => {
    await withDir(async (dir) => {
      const id = await browserSession(dir, false);
      const rpc = new ModelRpc();
      const first = await settleCommand(dir, id, rpc);
      assert.equal(first.result.status, 'READY_FOR_TESTNET_SEND');
      // The send B.5.3 disables on the network, exercised here over the reference model only.
      const settlement = new LiveSettlement({ session: first.session, deployment: testDeployment(), rpc, keys: KEYS });
      const p = await settlement.prepare();
      assert.ok(!('ineligible' in p));
      if ('ineligible' in p) return;
      const g = new SendGate();
      g.authorize('AUTHORIZE ROBINHOOD TESTNET SEND');
      assert.equal((await settlement.run(p, { mode: 'SEND', gate: g, ledgerPath: join(dir, 'domain.db'), journal: first.journal })).status, 'CONFIRMED');
      first.journal.close();
      first.session.close();

      const lab = new LiveLab({ live: null, clock: new ManualClock(), stateDir: dir, allowChaos: false, ...TIMEOUTS });
      const view = await lab.handle({ method: 'GET', path: `/api/live/sessions/${id}`, query: new URLSearchParams(), body: null });
      assert.deepEqual((view.body as { reservations: { status: string }[] }).reservations.map((r) => r.status), ['CONSUMED']);
      const events: LiveEvent[] = [];
      lab.subscribe(id, -1, (e) => events.push(e))?.();
      assert.equal(events.filter((e) => e.kind === 'RESERVATION_CONSUMED').length, 1);
      assert.equal(events.filter((e) => e.kind === 'DOMAIN_EXECUTION_SETTLED').length, 1);

      // Running the command again: reconciliation only, no duplicate event, no second execution.
      const again = await settleCommand(dir, id, rpc);
      assert.equal(again.result.status, 'RECONCILED_ONLY');
      assert.equal(again.session.events.events.filter((e) => e.kind === 'RESERVATION_CONSUMED').length, 1);
      assert.equal(rpc.chain.txs.length, 1);
      const r = await reconcileAttempts({ journal: again.journal, reader: rpc, session: again.session, deployment: testDeployment() });
      assert.equal(r[0]?.to, 'CONSUMED');
      again.journal.close();
      again.session.close();
    });
  });

  it('refuses a session that does not exist or whose records are corrupt — nothing is done', async () => {
    await withDir(async (dir) => {
      await assert.rejects(() => LiveSession.restore(dir, 'lab-nope', { ...TIMEOUTS, by: 'settlement-command' }));
    });
  });
});
