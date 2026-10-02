/**
 * Durable sessions (B.5.3, docs/demo/wallet-settlement-boundaries.md §4).
 *
 * A session written under a state directory survives its process: the
 * restored session has the same versions (and how each was authorized),
 * the same reserved executions, the same events in the same order, and the
 * same portfolio ledger — and it is evidence only. Corrupt records fail
 * closed; where the session's records and the ledger disagree, the ledger
 * wins and nothing is re-activated.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { addressOfKey, signPrehash } from '@mandate/portfolio/demo';
import { presetDraft, withField } from '../src/authoring/draft-types.ts';
import { revokeRoot } from '../src/mandate/portfolio-adapter.ts';
import { SessionStore, SessionStoreCorruption, sessionDir } from '../src/persistence/session-store.ts';
import { ManualClock } from '../src/runtime/clock.ts';
import { CountingEntropy } from '../src/runtime/entropy.ts';
import { StubProvider } from '../src/runtime/stub-provider.ts';
import { LiveLab } from '../src/server/app.ts';
import { LiveSession } from '../src/session.ts';
import { approvalHash, type ApprovalMessage } from '../src/wallet/approval.ts';
import { ScriptedProvider } from './support/providers.ts';
import { propose, abstain } from './support/session.ts';

const WALLET_KEY = '0x' + '33'.repeat(32);
const WALLET = addressOfKey(WALLET_KEY);
const TIMEOUTS = { agentTimeoutMs: 1_000, roomRoundTimeoutMs: 1_000 } as const;

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), 'mandate-live-durable-'));
}

function provider(stock = 300): ScriptedProvider {
  return new ScriptedProvider({ decide: (r) => (r.role === 'stock' ? { text: propose('nvda-note-a', stock) } : { text: abstain }), negotiate: () => ({ text: abstain }) });
}

function messageOf(typed: { readonly [k: string]: unknown }): ApprovalMessage {
  const m = (typed as { message: { [k: string]: string } }).message;
  return { statement: m['statement'] as string, environment: m['environment'] as string, mandateDigest: m['mandateDigest'] as string, mandateVersion: BigInt(m['mandateVersion'] as string), principal: m['principal'] as string, protocolSigner: m['protocolSigner'] as string, validAfter: BigInt(m['validAfter'] as string), validUntil: BigInt(m['validUntil'] as string), sessionDigest: m['sessionDigest'] as string, challenge: m['challenge'] as string };
}

/** A durable session, wallet-authorized and run once: the Stock agent reserves. */
async function durableRun(dir: string, clock = new ManualClock()): Promise<LiveSession> {
  const s = new LiveSession({ provider: provider(), clock, sessionId: 'lab-durable', stateDir: dir, entropy: new CountingEntropy(), ...TIMEOUTS });
  const draft = presetDraft('balanced');
  const c = s.walletChallenge(draft, WALLET);
  assert.ok(c.ok);
  const a = await s.authorizeWithWallet(draft, c.challenge, signPrehash(approvalHash(messageOf(c.typedData)), WALLET_KEY));
  assert.ok(a.ok);
  const run = await s.run();
  assert.equal(run.status, 'AUTHORIZED');
  return s;
}

describe('durable Live AI sessions', () => {
  it('persists proposals and user edits before signing, restores them exactly, and expires stale unsigned evidence', async () => {
    const dir = stateDir();
    const clock = new ManualClock();
    try {
      const s = new LiveSession({ provider: new StubProvider(0), clock, sessionId: 'lab-planning', stateDir: dir, ...TIMEOUTS });
      const draft = presetDraft('balanced');
      const planned = await s.plan(draft);
      assert.ok(planned.ok);
      if (!planned.ok) return;
      assert.equal(s.planningRecords.at(-1)?.status, 'PROPOSED');
      s.close();

      const proposed = await LiveSession.restore(dir, 'lab-planning', { ...TIMEOUTS, by: 'test', clock });
      assert.deepEqual(proposed.currentPlan, planned.plan);
      assert.equal(proposed.planningRecords.at(-1)?.status, 'PROPOSED');
      proposed.close();

      const editable = await LiveSession.restore(dir, 'lab-planning', { ...TIMEOUTS, by: 'test', clock });
      const edited = editable.applyPlan(draft, planned.plan.roomId, { stock: '500', yield: '600' });
      assert.ok(edited.ok);
      if (!edited.ok) return;
      editable.rememberDraft(edited.draft);
      assert.equal(editable.planningRecords.at(-1)?.status, 'ACCEPTED');
      assert.notEqual(editable.planningRecords.at(-1)?.userEditedAllocation, null);
      editable.close();

      const accepted = await LiveSession.restore(dir, 'lab-planning', { ...TIMEOUTS, by: 'test', clock });
      assert.deepEqual(accepted.planningRecords.at(-1)?.acceptedAllocation, editable.planningRecords.at(-1)?.acceptedAllocation);
      accepted.close();

      await clock.advance(10 * 60_000);
      const stale = await LiveSession.restore(dir, 'lab-planning', { ...TIMEOUTS, by: 'test', clock });
      // Accepted allocation is durable evidence and is not retroactively made stale.
      assert.equal(stale.planningRecords.at(-1)?.status, 'ACCEPTED');
      stale.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks an expired unsigned proposal PLAN_STALE and fails closed on a changed signed allocation digest', async () => {
    const unsignedDir = stateDir();
    const clock = new ManualClock();
    try {
      const s = new LiveSession({ provider: new StubProvider(0), clock, sessionId: 'lab-stale-plan', stateDir: unsignedDir, ...TIMEOUTS });
      assert.ok((await s.plan(presetDraft('balanced'))).ok);
      s.close();
      await clock.advance(10 * 60_000);
      const stale = await LiveSession.restore(unsignedDir, 'lab-stale-plan', { ...TIMEOUTS, by: 'test', clock });
      assert.equal(stale.planningRecords.at(-1)?.status, 'PLAN_STALE');
      stale.close();
    } finally {
      rmSync(unsignedDir, { recursive: true, force: true });
    }

    const signedDir = stateDir();
    try {
      const s = new LiveSession({ provider: new StubProvider(0), clock: new ManualClock(), sessionId: 'lab-corrupt-plan', stateDir: signedDir, ...TIMEOUTS });
      assert.ok((await s.authorize(presetDraft('balanced'), 'AUTHORIZE MANDATE V1')).ok);
      const digest = s.planningRecords.at(-1)?.initialAllocationDigest;
      assert.ok(digest !== null && digest !== undefined);
      s.close();
      const db = new DatabaseSync(join(sessionDir(signedDir, 'lab-corrupt-plan'), 'session.db'));
      db.prepare('UPDATE planning SET json = replace(json, ?, ?)').run(digest, `0x${'00'.repeat(32)}`);
      db.close();
      await assert.rejects(() => LiveSession.restore(signedDir, 'lab-corrupt-plan', { ...TIMEOUTS, by: 'test' }), /allocation digest mismatch/);
    } finally {
      rmSync(signedDir, { recursive: true, force: true });
    }
  });

  it('survive their process: versions, authorization, reserved executions, events and the ledger', async () => {
    const dir = stateDir();
    try {
      const s = await durableRun(dir);
      const before = { records: s.versions.records, reserved: s.reservedExecutions.map((x) => x.record.reservation), events: s.events.events, ledger: await s.versions.active?.core.engine.read(s.versions.active.mandate.principal) };
      assert.equal(before.reserved.length, 1);
      s.close();

      const r = await LiveSession.restore(dir, 'lab-durable', { ...TIMEOUTS, by: 'test', clock: new ManualClock() });
      assert.equal(r.restored, true);
      assert.deepEqual(r.versions.records, before.records);
      assert.equal(r.versions.records[0]?.authorization.method, 'WALLET_EIP712');
      assert.equal(r.versions.records[0]?.authorization.principal, WALLET);
      assert.deepEqual(r.reservedExecutions.map((x) => x.record.reservation), before.reserved);
      assert.equal(r.reservedExecutions[0]?.signed.signature, s.reservedExecutions[0]?.signed.signature);
      assert.deepEqual(r.events.events.slice(0, before.events.length), before.events);
      const restoredEvent = r.events.events[before.events.length];
      assert.equal(restoredEvent?.kind, 'SESSION_RESTORED');
      assert.equal(restoredEvent?.sequence, before.events.length);
      const ledger = await r.versions.active?.core.engine.read(r.versions.active.mandate.principal);
      assert.equal(ledger?.version, before.ledger?.version);
      assert.equal(ledger?.head, before.ledger?.head);
      assert.equal(r.versions.reserved, true);
      assert.ok(r.protocolNow() >= BigInt(before.events[before.events.length - 1]?.protocolTime ?? '0'));
      assert.equal(r.walletApproval(1)?.message.principal, WALLET);
      // Evidence only: no agent run, no new authorization; pause still works, through the ledger.
      await assert.rejects(() => r.run(), /restored session runs no agents/);
      const refused = await r.authorize(withField(presetDraft('balanced'), 'agents.nft.enabled', false, 'USER'), 'AUTHORIZE MANDATE V2');
      assert.equal(!refused.ok && refused.code, 'SESSION_RESTORED');
      assert.equal(r.walletChallenge(presetDraft('balanced'), WALLET).ok, false);
      assert.ok(await r.pause('PAUSE MANDATE'));
      r.close();
      const again = await LiveSession.restore(dir, 'lab-durable', { ...TIMEOUTS, by: 'test' });
      assert.equal(again.versions.paused, true);
      assert.equal(again.versions.records[0]?.status, 'REVOKED');
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps every directory 0700 and every file 0600', async () => {
    const dir = stateDir();
    try {
      const s = await durableRun(dir);
      const d = sessionDir(dir, 'lab-durable');
      assert.equal(statSync(join(dir, 'sessions')).mode & 0o777, 0o700);
      assert.equal(statSync(d).mode & 0o777, 0o700);
      for (const f of ['session.db', 'portfolio-ledger.db']) assert.equal(statSync(join(d, f)).mode & 0o777, 0o600, f);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a superseded version stays superseded, and a version the ledger revoked is never restored active', async () => {
    const dir = stateDir();
    try {
      const s = new LiveSession({ provider: provider(), clock: new ManualClock(), sessionId: 'lab-amend', stateDir: dir, ...TIMEOUTS });
      assert.ok((await s.authorize(presetDraft('balanced'), 'AUTHORIZE MANDATE V1')).ok);
      assert.ok((await s.authorize(withField(presetDraft('balanced'), 'agents.nft.enabled', false, 'USER'), 'AUTHORIZE MANDATE V2')).ok);
      // The ledger revokes V2 behind the session's back: a crash between a revocation and its record.
      const v2 = s.versions.active;
      assert.ok(v2 !== null);
      assert.ok((await revokeRoot(v2.core, s.protocolNow(), 99n)).ok);
      s.close();
      const r = await LiveSession.restore(dir, 'lab-amend', { ...TIMEOUTS, by: 'test' });
      assert.deepEqual(r.versions.records.map((x) => [x.version, x.status]), [[1, 'SUPERSEDED'], [2, 'REVOKED']]);
      assert.equal(r.versions.active, null);
      assert.equal(r.versions.paused, true);
      r.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a ledger reservation with no recorded execution as an orphan, never as settleable', async () => {
    const dir = stateDir();
    try {
      const s = await durableRun(dir);
      const reservation = s.reservedExecutions[0]?.record.reservation;
      s.close();
      // A crash between the reservation and its record.
      const db = new DatabaseSync(join(sessionDir(dir, 'lab-durable'), 'session.db'));
      db.prepare('DELETE FROM reserved').run();
      db.close();
      const r = await LiveSession.restore(dir, 'lab-durable', { ...TIMEOUTS, by: 'test' });
      assert.deepEqual(r.orphans, [reservation]);
      assert.equal(r.reservedExecutions.length, 0);
      assert.equal(r.versions.reserved, true);
      r.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on an unknown schema, a corrupt record, a broken event sequence or a missing ledger', async () => {
    const corrupt = async (mutate: (db: DatabaseSync, d: string) => void, pattern: RegExp) => {
      const dir = stateDir();
      try {
        (await durableRun(dir)).close();
        const d = sessionDir(dir, 'lab-durable');
        const db = new DatabaseSync(join(d, 'session.db'));
        mutate(db, d);
        db.close();
        await assert.rejects(() => LiveSession.restore(dir, 'lab-durable', { ...TIMEOUTS, by: 'test' }), (e: unknown) => e instanceof Error && (e instanceof SessionStoreCorruption || e.name === 'LedgerStoreCorruption') && pattern.test(e.message));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    await corrupt((db) => db.prepare("UPDATE meta SET value = 'mandate-live-session/v999' WHERE key = 'schema'").run(), /unknown session schema/);
    await corrupt((db) => db.prepare("UPDATE versions SET record = '{\"$evil\":1}'").run(), /record undecodable/);
    await corrupt((db) => db.prepare("UPDATE versions SET signature = '0x' || substr(signature, 3, 128) || '1c'").run(), /signature invalid|digest/);
    await corrupt((db) => db.prepare('DELETE FROM events WHERE seq = 1').run(), /event sequence broken/);
    await corrupt((db) => db.prepare("UPDATE reserved SET json = 'not json'").run(), /undecodable/);
    await corrupt((_db, d) => {
      rmSync(join(d, 'portfolio-ledger.db'));
      for (const x of ['-wal', '-shm']) rmSync(join(d, `portfolio-ledger.db${x}`), { force: true });
    }, /root not in the ledger/);
    assert.throws(() => SessionStore.open(stateDir(), '../escape'), SessionStoreCorruption);
  });

  it('shares one event sequence across processes, and appends a deduplicated event at most once', async () => {
    const dir = stateDir();
    try {
      const s = await durableRun(dir);
      const n = s.events.events.length;
      // A second handle on the same session: what a settlement command holds.
      const other = SessionStore.open(dir, 'lab-durable');
      const base = { schema: 'MANDATE_LIVE_AI.V1' as const, sessionId: 'lab-durable', kind: 'TESTNET_PREFLIGHT_STARTED' as const, at: 'x', elapsedMs: 0, protocolTime: s.protocolNow().toString(), mandateVersion: 1, agent: 'stock' as const, roomId: null, generation: null, data: {} };
      assert.deepEqual(other.appendEvent(base, 'settle:1'), { sequence: n, inserted: true });
      assert.deepEqual(other.appendEvent(base, 'settle:1'), { sequence: n, inserted: false });
      const own = s.events.emit('TESTNET_PREFLIGHT_PASSED', { agent: 'stock' });
      assert.equal(own.sequence, n + 1);
      assert.deepEqual(s.events.events.slice(n).map((e) => [e.sequence, e.kind]), [[n, 'TESTNET_PREFLIGHT_STARTED'], [n + 1, 'TESTNET_PREFLIGHT_PASSED']]);
      other.close();
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the local server restores a session after a restart and replays its events from any sequence', async () => {
    const dir = stateDir();
    try {
      const lab = new LiveLab({ live: null, clock: new ManualClock(), stateDir: dir, entropy: new CountingEntropy(), allowChaos: false, ...TIMEOUTS });
      const created = await lab.handle({ method: 'POST', path: '/api/live/sessions', query: new URLSearchParams(), body: { provider: 'stub' } });
      const id = (created.body as { sessionId: string }).sessionId;
      await lab.handle({ method: 'POST', path: `/api/live/sessions/${id}/draft`, query: new URLSearchParams(), body: { preset: 'balanced' } });
      const auth = await lab.handle({ method: 'POST', path: `/api/live/sessions/${id}/authorize`, query: new URLSearchParams(), body: { confirmation: 'AUTHORIZE MANDATE V1' } });
      assert.equal(auth.status, 200);
      const seen: number[] = [];
      lab.subscribe(id, -1, (e) => seen.push(e.sequence))?.();

      const restarted = new LiveLab({ live: null, clock: new ManualClock(), stateDir: dir, allowChaos: false, ...TIMEOUTS });
      const view = await restarted.handle({ method: 'GET', path: `/api/live/sessions/${id}`, query: new URLSearchParams(), body: null });
      assert.equal(view.status, 200);
      const v = view.body as { restored: boolean; activeVersion: number; draft: unknown; versions: { authorization: { method: string } }[] };
      assert.equal(v.restored, true);
      assert.equal(v.activeVersion, 1);
      assert.notEqual(v.draft, null);
      assert.equal(v.versions[0]?.authorization.method, 'DEMO_PRINCIPAL_KEY');
      const replay: number[] = [];
      restarted.subscribe(id, seen.length - 2, (e) => replay.push(e.sequence))?.();
      assert.deepEqual(replay, [seen.length - 1, seen.length]);
      const run = await restarted.handle({ method: 'POST', path: `/api/live/sessions/${id}/run`, query: new URLSearchParams(), body: {} });
      assert.equal(run.status, 409);
      assert.equal((run.body as { error: string }).error, 'SESSION_RESTORED');
      const unknown = await restarted.handle({ method: 'GET', path: '/api/live/sessions/lab-00000000000000000000000000000000', query: new URLSearchParams(), body: null });
      assert.equal(unknown.status, 404);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
