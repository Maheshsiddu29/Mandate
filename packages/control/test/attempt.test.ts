/**
 * The issuance boundary (7E.1): `admitAttempt` and what it forbids.
 *
 * - An attempt is admitted only after revalidation passes and every
 *   pre-execution requirement is `PASS`; it names the exact artifact and slot.
 * - Before any attempt, a failed revalidation lets `NEVER_ISSUED` close the
 *   reservation. After one, `NEVER_ISSUED` is forbidden — whatever happens.
 * - One reservation generation never yields a second attempt: a repeated or
 *   concurrent request refers to the existing one.
 * - Control-evaluated verdicts cannot be supplied, and reserved requirement
 *   kinds without an evaluator refuse.
 * - A disabled module or adapter admits nothing new; a retiring one carries an
 *   existing authorization to issuance; disabled definitions are `UNKNOWN`;
 *   history still replays.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateAdapterRef, validateResourceId, type AccountId, type AuthorityGrant, type Digest32, type ResourceIdInput } from '@mandate/core';
import type { Identifier } from '@mandate/kernel';
import { encodeLedgerState, replayEncoded, type AdapterStatus, type ModuleStatus } from '@mandate/ledger';
import { controlRules, type AttemptOutcome, type AttemptRequest, type AuthorizationRecord, type PreExecutionResult } from '../src/index.ts';
import {
  ADAPTER,
  AGENT_A,
  ONCE,
  PRICE,
  RETRY,
  SPOT_CFG,
  PERP_CFG,
  T,
  account,
  action,
  authorized,
  capitalDim,
  child,
  context,
  createSyntheticModule,
  digestOf,
  instrumentsState,
  jitter,
  markState,
  maxExposure,
  must,
  policy,
  positionState,
  refused,
  request,
  root,
  setup,
  world,
  type SyntheticModule,
  type World,
} from './support/attempt-world.ts';

interface Fixture {
  readonly w: World;
  readonly m: SyntheticModule;
  readonly acct: ResourceIdInput;
  readonly agent: AuthorityGrant;
}

async function fixture(w: World = world()): Promise<Fixture> {
  const m = w.modules[0] as SyntheticModule;
  const acct = account(m);
  const r0 = root({ mods: [m], delegate: 1, terms: [capitalDim('capital', 1_000_000), maxExposure(m, acct, 20_000)] });
  const agent = child(r0, { mods: [m], holder: AGENT_A, terms: [maxExposure(m, acct, 20_000)] });
  await setup(w, policy(), [r0, agent]);
  return { w, m, acct, agent };
}

const ctxAt = (f: Fixture, at: bigint) => context([f.m], { at, accounts: [{ module: f.m, account: f.acct }] });
const states = (f: Fixture, mark: bigint, at: bigint) => [markState(f.m, 'x:BTC-PERP', mark, { observedAt: at }), instrumentsState(f.m), positionState(f.m, f.acct, [{ localId: 'x:BTC-PERP', size: 1_500n }])];

async function reserved(f: Fixture): Promise<{ rec: AuthorizationRecord; buy: ReturnType<typeof action> }> {
  const buy = action(f.m, { authority: f.agent, size: 400n, limitPrice: 10_100_000n });
  const rec = authorized(await f.w.engine.authorizeAndReserve(request(buy, states(f, PRICE, T), ctxAt(f, T)), ONCE));
  return { rec, buy };
}

const pass = (kind: 'CREDENTIAL_SCOPE' | 'NONCE_SLOT', outcome: PreExecutionResult['outcome'] = 'PASS'): PreExecutionResult => ({
  kind,
  subject: 'synthetic:acct-1',
  outcome,
  reason: outcome === 'PASS' ? 'OK' : 'KEY_FOREIGN',
  evidence: digestOf(`evidence:${kind}`) as Digest32,
});

function attemptRequest(f: Fixture, buy: ReturnType<typeof action>, o: { mark?: bigint; at?: bigint; label?: string; nonce?: bigint; validUntil?: bigint; results?: PreExecutionResult[]; requirements?: AttemptRequest['requirements']; adapter?: AttemptRequest['adapter'] } = {}): AttemptRequest {
  const at = o.at ?? T + 3n;
  return {
    revalidation: { payload: buy.payload, states: states(f, o.mark ?? PRICE, at), context: ctxAt(f, at) },
    adapter: o.adapter ?? must(validateAdapterRef(ADAPTER)),
    venueAccount: must(validateResourceId(f.acct, ['ACCOUNT'] as const, 'a')) as AccountId,
    artifact: { kind: 'synthetic.tx-hash' as Identifier, id: new TextEncoder().encode(`tx:${o.label ?? 'a'}`) },
    slot: { scope: 'synthetic:acct-1:key-2' as Identifier, sequence: o.nonce ?? 7n },
    validUntil: o.validUntil ?? T + 20n,
    requirements: o.requirements ?? [
      { kind: 'CREDENTIAL_SCOPE', subject: 'synthetic:acct-1' },
      { kind: 'NONCE_SLOT', subject: 'synthetic:acct-1' },
    ],
    results: o.results ?? [pass('CREDENTIAL_SCOPE'), pass('NONCE_SLOT')],
  };
}

function admitted(o: AttemptOutcome) {
  if (o.status !== 'ADMITTED') assert.fail(`expected ADMITTED, got ${o.status}${o.status === 'REFUSED' || o.status === 'CONFLICT' ? ` ${o.refusal.code}/${o.refusal.reason} at ${o.refusal.path}` : ''}`);
  return o;
}

function refusedAttempt(o: AttemptOutcome) {
  if (o.status !== 'REFUSED') assert.fail(`expected REFUSED, got ${o.status}`);
  return o;
}

/** The same ledger seen through a registry where the modules or the adapter have another status. */
function rewire(f: Fixture, o: { module?: ModuleStatus; adapter?: AdapterStatus }): World {
  return world({ modules: f.w.modules, store: f.w.store, ...(o.module === undefined ? {} : { status: () => o.module as ModuleStatus }), ...(o.adapter === undefined ? {} : { adapterStatus: o.adapter }) });
}

describe('admitAttempt — the issuance boundary', () => {
  it('admits one exact attempt after revalidation and every requirement passes; nothing is released or consumed', async () => {
    const f = await fixture();
    const { rec, buy } = await reserved(f);
    const before = await f.w.store.read(rec.principal);
    const a = admitted(await f.w.engine.admitAttempt(rec, attemptRequest(f, buy), ONCE));
    assert.equal(a.attempt.reservation, rec.reservation);
    assert.equal(a.attempt.generation, rec.generation);
    assert.equal(a.attempt.authorization, rec.executionId);
    assert.equal(a.attempt.revalidation, a.revalidation.id);
    assert.deepEqual(a.preExecution.map((r) => r.kind), ['STATE_REVALIDATION', 'MODULE_TRUST', 'ADAPTER_TRUST', 'CREDENTIAL_SCOPE', 'NONCE_SLOT']);
    assert.equal(a.snapshot.version, before.version + 1n);
    assert.deepEqual([...a.snapshot.state.targets.entries()], [...before.state.targets.entries()]);
    const last = (await f.w.store.history(rec.principal)).at(-1);
    assert.equal(last?.events[0]?.kind, 'ADMIT_ATTEMPT');
  });

  it('after ADMIT_ATTEMPT, NEVER_ISSUED is forbidden even when revalidation now fails (a signer crash changes nothing)', async () => {
    const f = await fixture();
    const { rec, buy } = await reserved(f);
    admitted(await f.w.engine.admitAttempt(rec, attemptRequest(f, buy), ONCE));
    // The mark moves: 0.19 × 106,000 > 20,000. Revalidation fails — but an artifact may exist.
    const moved = { payload: buy.payload, states: states(f, 10_600_000n, T + 5n), context: ctxAt(f, T + 5n) };
    const reval = await f.w.engine.revalidate(rec, moved);
    assert.ok(reval.ok && reval.value.status === 'FAILED');
    const c = await f.w.engine.closeNeverIssued(rec, moved, ONCE);
    assert.equal(c.status, 'REFUSED');
    if (c.status === 'REFUSED') assert.deepEqual([c.refusal.code, c.refusal.reason], ['NEVER_ISSUED_FORBIDDEN', 'ATTEMPT_ADMITTED']);
    // Days later: time never releases it.
    const later = { payload: buy.payload, states: states(f, PRICE, T + 3_000n), context: ctxAt(f, T + 3_000n) };
    const again = await f.w.engine.closeNeverIssued(rec, later, ONCE);
    assert.ok(again.status === 'REFUSED' && again.refusal.code === 'NEVER_ISSUED_FORBIDDEN');
    const r = (await f.w.store.read(rec.principal)).state.reservations.get(rec.reservation);
    assert.equal(r?.status, 'ACTIVE');
    assert.ok(r?.demands.every((d) => d.released === 0n));
  });

  it('before any attempt, a failed revalidation refuses admission and NEVER_ISSUED may then close — the two crash cases differ', async () => {
    const f = await fixture();
    const { rec, buy } = await reserved(f);
    const out = refusedAttempt(await f.w.engine.admitAttempt(rec, attemptRequest(f, buy, { mark: 10_600_000n }), ONCE));
    assert.equal(out.refusal.code, 'REVALIDATION_FAILED');
    assert.equal(out.revalidation?.status, 'FAILED');
    assert.equal((await f.w.store.read(rec.principal)).state.attempts.size, 0);
    const moved = { payload: buy.payload, states: states(f, 10_600_000n, T + 3n), context: ctxAt(f, T + 3n) };
    const c = await f.w.engine.closeNeverIssued(rec, moved, ONCE);
    assert.equal(c.status, 'CLOSED');
  });

  it('a second request for the same generation refers to the existing attempt and admits nothing — whatever artifact it names', async () => {
    const f = await fixture();
    const { rec, buy } = await reserved(f);
    const first = admitted(await f.w.engine.admitAttempt(rec, attemptRequest(f, buy), ONCE));
    const head = (await f.w.store.read(rec.principal)).head;
    for (const o of [{}, { label: 'b', nonce: 8n }, { label: 'c', nonce: 9n, at: T + 10n }]) {
      const again = await f.w.engine.admitAttempt(rec, attemptRequest(f, buy, o), ONCE);
      assert.equal(again.status, 'EXISTING');
      if (again.status === 'EXISTING') assert.equal(again.attempt.attempt, first.attempt.attempt);
    }
    assert.equal((await f.w.store.read(rec.principal)).head, head);
  });

  it('100 concurrent issuance requests for one generation: exactly one attempt, every other call refers to it or loses a race', async () => {
    const w = world({ hooks: jitter(7) });
    const f = await fixture(w);
    const { rec, buy } = await reserved(f);
    const outs = await Promise.all(Array.from({ length: 100 }, (_, i) => f.w.engine.admitAttempt(rec, attemptRequest(f, buy, { label: `c${i}`, nonce: BigInt(100 + i) }), RETRY)));
    const admittedOnes = outs.filter((o) => o.status === 'ADMITTED');
    assert.equal(admittedOnes.length, 1);
    const id = (admittedOnes[0] as Extract<AttemptOutcome, { status: 'ADMITTED' }>).attempt.attempt;
    for (const o of outs) {
      assert.ok(o.status === 'ADMITTED' || o.status === 'EXISTING' || o.status === 'CONFLICT', o.status);
      if (o.status === 'EXISTING') assert.equal(o.attempt.attempt, id);
    }
    assert.equal((await f.w.store.read(rec.principal)).state.attempts.size, 1);
  });

  it('the ledger refuses a venue slot or artifact another reservation already bound (REPLAY-1, execution half)', async () => {
    const f = await fixture();
    const { rec, buy } = await reserved(f);
    admitted(await f.w.engine.admitAttempt(rec, attemptRequest(f, buy), ONCE));
    const buy2 = action(f.m, { authority: f.agent, size: 10n, limitPrice: 10_100_000n, nonce: 2n });
    const rec2 = authorized(await f.w.engine.authorizeAndReserve(request(buy2, states(f, PRICE, T + 4n), ctxAt(f, T + 4n)), ONCE));
    const slot = refusedAttempt(await f.w.engine.admitAttempt(rec2, attemptRequest(f, buy2, { label: 'fresh', at: T + 5n }), ONCE));
    assert.deepEqual([slot.refusal.code, slot.refusal.reason], ['ATTEMPT_REFUSED', 'VENUE_SLOT_REUSED']);
    const artifact = refusedAttempt(await f.w.engine.admitAttempt(rec2, attemptRequest(f, buy2, { nonce: 8n, at: T + 5n }), ONCE));
    assert.deepEqual([artifact.refusal.code, artifact.refusal.reason], ['ATTEMPT_REFUSED', 'ARTIFACT_REUSED']);
    admitted(await f.w.engine.admitAttempt(rec2, attemptRequest(f, buy2, { label: 'fresh', nonce: 8n, at: T + 5n }), ONCE));
  });

  it('refuses an artifact that would outlive the revalidated authorization, or is already expired', async () => {
    const f = await fixture();
    const { rec, buy } = await reserved(f);
    const long = refusedAttempt(await f.w.engine.admitAttempt(rec, attemptRequest(f, buy, { validUntil: rec.validUntil + 1n }), ONCE));
    assert.deepEqual([long.refusal.code, long.refusal.reason], ['REQUEST_INVALID', 'ARTIFACT_OUTLIVES_AUTHORIZATION']);
    const dead = refusedAttempt(await f.w.engine.admitAttempt(rec, attemptRequest(f, buy, { validUntil: T + 3n }), ONCE));
    assert.deepEqual([dead.refusal.code, dead.refusal.reason], ['REQUEST_INVALID', 'ARTIFACT_ALREADY_EXPIRED']);
  });
});

describe('pre-execution requirements', () => {
  it('a FAIL or a missing result refuses; nothing is written', async () => {
    const f = await fixture();
    const { rec, buy } = await reserved(f);
    const failed = refusedAttempt(await f.w.engine.admitAttempt(rec, attemptRequest(f, buy, { results: [pass('CREDENTIAL_SCOPE', 'FAIL'), pass('NONCE_SLOT')] }), ONCE));
    assert.deepEqual([failed.refusal.code, failed.refusal.reason], ['PRE_EXECUTION_FAILED', 'CREDENTIAL_SCOPE.FAIL.KEY_FOREIGN']);
    const unknown = refusedAttempt(await f.w.engine.admitAttempt(rec, attemptRequest(f, buy, { results: [pass('CREDENTIAL_SCOPE'), pass('NONCE_SLOT', 'UNKNOWN')] }), ONCE));
    assert.equal(unknown.refusal.code, 'PRE_EXECUTION_FAILED');
    const missing = refusedAttempt(await f.w.engine.admitAttempt(rec, attemptRequest(f, buy, { results: [pass('CREDENTIAL_SCOPE')] }), ONCE));
    assert.deepEqual([missing.refusal.code, missing.refusal.reason], ['PRE_EXECUTION_FAILED', 'NONCE_SLOT.UNKNOWN.RESULT_MISSING']);
    assert.equal((await f.w.store.read(rec.principal)).state.attempts.size, 0);
  });

  it('a caller cannot supply the engine\'s own verdicts, a verdict for a reserved kind, or an unrequired result', async () => {
    const f = await fixture();
    const { rec, buy } = await reserved(f);
    const own = { kind: 'STATE_REVALIDATION' as const, subject: rec.reservation, outcome: 'PASS' as const, reason: 'FORGED', evidence: digestOf('x') as Digest32 };
    const a = refusedAttempt(await f.w.engine.admitAttempt(rec, attemptRequest(f, buy, { results: [pass('CREDENTIAL_SCOPE'), pass('NONCE_SLOT'), own] }), ONCE));
    assert.deepEqual([a.refusal.code, a.refusal.reason], ['REQUEST_INVALID', 'PRE_EXECUTION_CONTROL_RESULT_SUPPLIED']);
    const claimed = { ...own, kind: 'RUNTIME_PROVENANCE' as const, subject: 'agent-runtime' };
    const b = refusedAttempt(await f.w.engine.admitAttempt(rec, attemptRequest(f, buy, { results: [pass('CREDENTIAL_SCOPE'), pass('NONCE_SLOT'), claimed] }), ONCE));
    assert.deepEqual([b.refusal.code, b.refusal.reason], ['REQUEST_INVALID', 'PRE_EXECUTION_NO_EVALUATOR']);
    const extra = { ...pass('NONCE_SLOT'), subject: 'synthetic:other' };
    const c = refusedAttempt(await f.w.engine.admitAttempt(rec, attemptRequest(f, buy, { results: [pass('CREDENTIAL_SCOPE'), pass('NONCE_SLOT'), extra] }), ONCE));
    assert.deepEqual([c.refusal.code, c.refusal.reason], ['REQUEST_INVALID', 'PRE_EXECUTION_RESULT_UNREQUIRED']);
  });

  it('requiring a reserved kind (runtime provenance) refuses every issuance until an evaluator exists', async () => {
    const f = await fixture();
    const { rec, buy } = await reserved(f);
    const requirements = [{ kind: 'CREDENTIAL_SCOPE' as const, subject: 'synthetic:acct-1' }, { kind: 'NONCE_SLOT' as const, subject: 'synthetic:acct-1' }, { kind: 'RUNTIME_PROVENANCE' as const, subject: 'agent-runtime' }];
    const out = refusedAttempt(await f.w.engine.admitAttempt(rec, attemptRequest(f, buy, { requirements }), ONCE));
    assert.deepEqual([out.refusal.code, out.refusal.reason], ['PRE_EXECUTION_FAILED', 'RUNTIME_PROVENANCE.UNKNOWN.NO_EVALUATOR']);
  });
});

describe('module and adapter lifecycle at issuance', () => {
  it('a DISABLED module refuses a new authorization; a DISABLED adapter refuses one too', async () => {
    const f = await fixture();
    const disabled = rewire(f, { module: 'DISABLED' });
    const buy = action(f.m, { authority: f.agent, size: 400n, limitPrice: 10_100_000n, nonce: 5n });
    const r = refused(await disabled.engine.authorizeAndReserve(request(buy, states(f, PRICE, T), ctxAt(f, T)), ONCE));
    assert.deepEqual([r.code, r.reason], ['MODULE_NOT_FOUND', 'MODULE_DISABLED']);
    for (const status of ['DISABLED', 'RETIRING'] as const) {
      const w = rewire(f, { adapter: status });
      const x = refused(await w.engine.authorizeAndReserve(request(buy, states(f, PRICE, T), ctxAt(f, T)), ONCE));
      assert.deepEqual([x.code, x.reason], ['ADAPTER_NOT_USABLE', status === 'DISABLED' ? 'ADAPTER_DISABLED' : 'ADAPTER_RETIRING']);
    }
  });

  it('a module or adapter DISABLED after the reservation refuses the attempt; RETIRING carries it to issuance', async () => {
    const f = await fixture();
    const { rec, buy } = await reserved(f);
    const m = refusedAttempt(await rewire(f, { module: 'DISABLED' }).engine.admitAttempt(rec, attemptRequest(f, buy), ONCE));
    assert.deepEqual([m.refusal.code, m.refusal.reason], ['MODULE_NOT_CONFORMING', 'MODULE_DISABLED']);
    const a = refusedAttempt(await rewire(f, { adapter: 'DISABLED' }).engine.admitAttempt(rec, attemptRequest(f, buy), ONCE));
    assert.deepEqual([a.refusal.code, a.refusal.reason], ['ADAPTER_NOT_USABLE', 'ADAPTER_DISABLED']);
    const other = must(validateAdapterRef({ ...ADAPTER, adapterDigest: digestOf('adapter:synthetic-signer:1:patched') }));
    const x = refusedAttempt(await f.w.engine.admitAttempt(rec, attemptRequest(f, buy, { adapter: other }), ONCE));
    assert.deepEqual([x.refusal.code, x.refusal.reason], ['ADAPTER_NOT_USABLE', 'ADAPTER_MISMATCH']);
    admitted(await rewire(f, { module: 'RETIRING', adapter: 'RETIRING' }).engine.admitAttempt(rec, attemptRequest(f, buy), ONCE));
  });

  it('a term bound to a DISABLED definition is UNKNOWN for new decisions, while committed history still replays under it', async () => {
    const perp = createSyntheticModule(PERP_CFG);
    const spot = createSyntheticModule(SPOT_CFG);
    const w = world({ modules: [perp, spot] });
    const acct = account(spot);
    const perpAcct = account(perp);
    const r0 = root({ mods: [perp, spot], delegate: 1, terms: [capitalDim('capital', 1_000_000), maxExposure(perp, perpAcct, 20_000)] });
    await setup(w, policy(), [r0]);
    const buy = action(spot, { authority: r0, size: 100n, market: 'x:BTC-SPOT', account: acct });
    const ctx = context([spot, perp], { at: T, accounts: [{ module: spot, account: acct }, { module: perp, account: perpAcct }] });
    const all = [markState(spot, 'x:BTC-SPOT', PRICE), markState(spot, 'x:ETH-SPOT', PRICE), instrumentsState(spot), positionState(spot, acct), markState(perp, 'x:BTC-PERP', PRICE), instrumentsState(perp), positionState(perp, perpAcct)];
    const disabled = world({ modules: [perp, spot], store: w.store, status: (m) => (m === perp ? 'DISABLED' : 'ACTIVE') });
    const r = refused(await disabled.engine.authorizeAndReserve(request(buy, all, ctx), ONCE));
    assert.equal(r.code, 'INVARIANT_UNKNOWN');
    // The committed registrations — bound to the now-disabled definition — replay byte for byte.
    const history = (await w.store.history(r0.principal)).map((b) => b.encoded);
    const replayed = must(replayEncoded(r0.principal, history, controlRules(disabled.catalog)));
    assert.deepEqual(encodeLedgerState(replayed), encodeLedgerState((await w.store.read(r0.principal)).state));
  });
});
