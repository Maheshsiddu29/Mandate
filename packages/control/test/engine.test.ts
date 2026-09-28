/**
 * The engine's lifecycle: authorization identity and lifetime, revalidation,
 * NEVER_ISSUED closure, generations, bounded retry, and byte-identical
 * determinism (brief §27–§35, §46, §52; examples.md §F; STATE-5; RECON-2).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAuthorizationRecord, type AuthorizationRecord, type CloseOutcome } from '../src/index.ts';
import {
  AGENT_A,
  AGENT_B,
  ONCE,
  PRICE,
  RETRY,
  T,
  T0,
  account,
  action,
  authorized,
  capitalDim,
  child,
  context,
  createSyntheticModule,
  markState,
  marketStates,
  maxExposure,
  PERP_CFG,
  policy,
  positionState,
  instrumentsState,
  refused,
  request,
  root,
  setup,
  sizeFor,
  syntheticRef,
  ticks,
  usd,
  world,
  type SyntheticModule,
  type World,
} from './support/world.ts';
import type { AuthorityGrant, ResourceIdInput } from '@mandate/core';

interface Fixture {
  readonly w: World;
  readonly m: SyntheticModule;
  readonly acct: ResourceIdInput;
  readonly r0: AuthorityGrant;
  readonly agent: AuthorityGrant;
}

async function fixture(o: { limit?: number; agentExpiresAt?: bigint; w?: World; policySequence?: bigint } = {}): Promise<Fixture> {
  const w = o.w ?? world();
  const m = w.modules[0] as SyntheticModule;
  const acct = account(m);
  const r0 = root({ mods: [m], delegate: 1, terms: [capitalDim('capital', 1_000_000), maxExposure(m, acct, o.limit ?? 20_000)] });
  const agent = child(r0, { mods: [m], holder: AGENT_A, terms: [maxExposure(m, acct, o.limit ?? 20_000)], ...(o.agentExpiresAt === undefined ? {} : { expiresAt: o.agentExpiresAt }) });
  await setup(w, policy([], o.policySequence ?? 1n), [r0, agent]);
  return { w, m, acct, r0, agent };
}

function ctxAt(f: Fixture, at: bigint) {
  return context([f.m], { at, accounts: [{ module: f.m, account: f.acct }] });
}

/** Example F's state: 0.15 held, a mark observed at `observedAt`. */
function exampleF(f: Fixture, mark: bigint, observedAt: bigint) {
  return [markState(f.m, 'x:BTC-PERP', mark, { observedAt }), instrumentsState(f.m), positionState(f.m, f.acct, [{ localId: 'x:BTC-PERP', size: 1_500n }])];
}

function closed(o: CloseOutcome) {
  if (o.status !== 'CLOSED') assert.fail(`expected CLOSED, got ${o.status}${o.status === 'REFUSED' || o.status === 'CONFLICT' ? ` ${o.refusal.code}/${o.refusal.reason}` : ''}`);
  return o;
}

describe('module resolution at decision time (brief §5)', () => {
  it('an action naming another digest is refused before anything else is evaluated; nothing falls back to "latest"', async () => {
    const w = world();
    const m = w.modules[0] as SyntheticModule;
    const acct = account(m);
    const r0 = root({ mods: [m], holder: AGENT_A, terms: [capitalDim('capital', 100_000)] });
    await setup(w, policy(), [r0]);
    const patched = { ...syntheticRef(PERP_CFG), moduleDigest: `0x${'ab'.repeat(32)}` };
    const r = refused(await w.engine.authorizeAndReserve(request(action(m, { authority: r0, size: sizeFor(100), module: patched }), marketStates(m, [{ account: acct }]), context([m], { accounts: [{ module: m, account: acct }] })), ONCE));
    assert.deepEqual([r.code, r.reason], ['MODULE_NOT_FOUND', 'MODULE_DIGEST_MISMATCH']);
  });

});

describe('authorization identity (brief §28)', () => {
  it('changes with every material input and is reproduced exactly from the same inputs', async () => {
    const base = async (tweak: { nonce?: bigint; size?: bigint; mark?: bigint; limit?: number; agent?: 'B'; prior?: boolean; policySequence?: bigint; module?: SyntheticModule; registerExtra?: boolean } = {}): Promise<AuthorizationRecord> => {
      const w = tweak.module === undefined ? world() : world({ modules: [tweak.module] });
      const f = await fixture({ w, ...(tweak.limit === undefined ? {} : { limit: tweak.limit }), ...(tweak.policySequence === undefined ? {} : { policySequence: tweak.policySequence }) });
      let authority = f.agent;
      if (tweak.agent === 'B') {
        authority = child(f.r0, { mods: [f.m], holder: AGENT_B, nonce: 1n, terms: [maxExposure(f.m, f.acct, tweak.limit ?? 20_000)] });
        assert.equal((await f.w.engine.registerDelegation(authority, T0, ONCE)).status, 'REGISTERED');
      }
      if (tweak.registerExtra === true) {
        assert.equal((await f.w.engine.registerDelegation(child(f.r0, { mods: [f.m], holder: AGENT_B, nonce: 5n, terms: [maxExposure(f.m, f.acct, 20_000)] }), T0, ONCE)).status, 'REGISTERED');
      }
      const states = marketStates(f.m, [{ account: f.acct }], tweak.mark ?? PRICE);
      if (tweak.prior === true) authorized(await f.w.engine.authorizeAndReserve(request(action(f.m, { authority: f.r0, size: sizeFor(100), nonce: 77n }), states, ctxAt(f, T)), ONCE));
      return authorized(await f.w.engine.authorizeAndReserve(request(action(f.m, { authority, size: tweak.size ?? sizeFor(1_000), nonce: tweak.nonce ?? 0n }), states, ctxAt(f, T)), ONCE));
    };
    const reference = await base();
    const again = await base();
    assert.equal(again.id, reference.id);
    assert.deepEqual(encodeAuthorizationRecord(again), encodeAuthorizationRecord(reference));

    const variants: [string, AuthorizationRecord][] = [
      ['action nonce', await base({ nonce: 1n })],
      ['module digest', await base({ module: createSyntheticModule({ ...PERP_CFG, variant: 'PENDING_HALF' }) })],
      ['lineage', await base({ agent: 'B' })],
      ['principal policy', await base({ policySequence: 2n })],
      ['a state binding', await base({ mark: PRICE + 1n })],
      ['the pending set (projection)', await base({ prior: true })],
      ['invariant results', await base({ limit: 30_000 })],
      ['charge plan', await base({ size: sizeFor(1_100) })],
      ['ledger version', await base({ registerExtra: true })],
    ];
    const ids = new Set([reference.id, ...variants.map(([, r]) => r.id)]);
    assert.equal(ids.size, variants.length + 1, 'every material input changes the identity');
    const byMark = variants.find(([n]) => n === 'a state binding')?.[1] as AuthorizationRecord;
    assert.notEqual(byMark.projectionDigest, reference.projectionDigest);
    const byPending = variants.find(([n]) => n === 'the pending set (projection)')?.[1] as AuthorizationRecord;
    assert.notEqual(byPending.projectionDigest, reference.projectionDigest);
  });

  it('binds action, module, lineage, policy, bindings, adapter and the committed ledger version into Core\'s ExecutionAuthorization', async () => {
    const f = await fixture();
    const rec = authorized(await f.w.engine.authorizeAndReserve(request(action(f.m, { authority: f.agent, size: sizeFor(1_000) }), marketStates(f.m, [{ account: f.acct }]), ctxAt(f, T)), ONCE));
    const ref = rec.execution.reservation;
    assert.equal(ref.action, rec.actionId);
    assert.deepEqual(ref.module, f.m.ref);
    assert.equal(ref.implementation, f.m.implementation);
    assert.deepEqual(ref.lineage, rec.lineage);
    assert.equal(ref.policy, rec.policy);
    assert.equal(ref.ledgerVersion, rec.ledgerVersionCommitted);
    assert.equal(ref.generation, 1n);
    assert.deepEqual(ref.adapter, rec.action.adapter);
    assert.equal(rec.execution.stateBindings.length, 3);
    assert.equal(rec.execution.attemptCeiling, rec.validUntil);
    // The mark is RECHECK; position and instruments are re-admitted within policy.
    assert.equal(rec.recheck.length, 1);
    assert.equal(rec.bindingModules.length, 3);
  });
});

describe('authorization lifetime (brief §33)', () => {
  it('is the earliest of action expiry, lineage expiry, the module\'s cap and every freshness-bounded state', async () => {
    const cases: { name: string; expect: bigint; setup: { expiresAt?: bigint; agentExpiresAt?: bigint; markValidUntil?: bigint; validFrom?: bigint } }[] = [
      { name: 'mark freshness (observedAt + 30 s)', expect: T + 30n, setup: {} },
      { name: 'action expiry', expect: T + 10n, setup: { expiresAt: T + 10n } },
      { name: 'lineage expiry', expect: T + 20n, setup: { agentExpiresAt: T + 20n } },
      { name: 'source validUntil', expect: T + 5n, setup: { markValidUntil: T + 5n } },
      { name: 'module cap (validFrom + 3,600 s)', expect: T + 7n, setup: { validFrom: T + 7n - 3_600n } },
    ];
    for (const c of cases) {
      const f = await fixture(c.setup.agentExpiresAt === undefined ? {} : { agentExpiresAt: c.setup.agentExpiresAt });
      const states = [markState(f.m, 'x:BTC-PERP', PRICE, c.setup.markValidUntil === undefined ? {} : { validUntil: c.setup.markValidUntil }), instrumentsState(f.m), positionState(f.m, f.acct)];
      const a = action(f.m, { authority: f.agent, size: sizeFor(1_000), ...(c.setup.expiresAt === undefined ? {} : { expiresAt: c.setup.expiresAt }), ...(c.setup.validFrom === undefined ? {} : { validFrom: c.setup.validFrom }) });
      const rec = authorized(await f.w.engine.authorizeAndReserve(request(a, states, ctxAt(f, T)), ONCE));
      assert.equal(rec.validUntil, c.expect, c.name);
    }
  });

  it('refuses when the dependencies leave no lifetime at all', async () => {
    const f = await fixture();
    const states = [markState(f.m, 'x:BTC-PERP', PRICE, { observedAt: T - 30n }), instrumentsState(f.m), positionState(f.m, f.acct)];
    const r = refused(await f.w.engine.authorizeAndReserve(request(action(f.m, { authority: f.agent, size: sizeFor(1_000) }), states, ctxAt(f, T)), ONCE));
    assert.equal(r.code, 'AUTHORIZATION_EXPIRED');
    assert.equal(r.reason, 'LIFETIME_EMPTY');
  });
});

describe('state changes after the reservation (examples.md §F; brief §34–§35)', () => {
  it('T0 passes, T1 reserves, T2 the mark moves, T3 revalidation fails, T4 nothing issued, T5 NEVER_ISSUED releases everything', async () => {
    const f = await fixture();
    const buy = action(f.m, { authority: f.agent, size: 400n, limitPrice: 10_100_000n });
    // T0/T1: (0.15 + 0.04) × 100,000 = 19,000 ≤ 20,000.
    const rec = authorized(await f.w.engine.authorizeAndReserve(request(buy, exampleF(f, PRICE, T), ctxAt(f, T)), ONCE));
    const reserved = await f.w.store.read(rec.principal);
    assert.equal(reserved.state.reservations.get(rec.reservation)?.status, 'ACTIVE');

    // T2/T3: the mark is 106,000 at T + 3. 0.19 × 106,000 = 20,140 > 20,000.
    const moved = { payload: buy.payload, states: exampleF(f, 10_600_000n, T + 3n), context: ctxAt(f, T + 3n) };
    const reval = await f.w.engine.revalidate(rec, moved);
    assert.ok(reval.ok);
    if (!reval.ok) return;
    assert.equal(reval.value.status, 'FAILED');
    if (reval.value.status === 'FAILED') {
      assert.equal(reval.value.refusal.code, 'REVALIDATION_FAILED');
      assert.equal(reval.value.refusal.reason, 'INVARIANT_FAILED.EXPOSURE_LIMIT_EXCEEDED');
      const observed = reval.value.invariants.find((x) => x.outcome === 'VIOLATED')?.observed;
      assert.deepEqual(observed, { type: 'TOTAL', kind: 'GROSS_EXPOSURE', unit: 'USD', decimals: 2, atoms: usd(20_140) });
      // The reservation's own worst case was counted once, as pending — not again as proposed.
      assert.ok(reval.value.invariants.every((x) => x.reservations.includes(rec.reservation)));
    }
    // Revalidation changed nothing.
    assert.equal((await f.w.store.read(rec.principal)).head, reserved.head);

    // T4/T5: no attempt was ever admitted (7D issues nothing), so the reservation closes NEVER_ISSUED.
    const c = closed(await f.w.engine.closeNeverIssued(rec, moved, ONCE));
    const after = c.snapshot.state;
    const r = after.reservations.get(rec.reservation);
    assert.equal(r?.status, 'CLOSED');
    assert.ok(r?.demands.every((d) => d.consumed === 0n && d.released === d.reserved));
    for (const t of after.targets.values()) assert.equal(t.reserved, 0n, 'every leg released');
    // Provenance is reconstructable: the CLOSE names the NEVER_ISSUED evidence built from the authorization and the failed revalidation.
    const last = (await f.w.store.history(rec.principal)).at(-1);
    const ev = last?.events[0];
    assert.equal(ev?.kind, 'CLOSE');
    if (ev?.kind === 'CLOSE') assert.equal(ev.evidence, c.evidence);

    // Idempotent: closing again writes nothing.
    const again = await f.w.engine.closeNeverIssued(rec, moved, ONCE);
    assert.equal(again.status, 'ALREADY_CLOSED');
    assert.equal((await f.w.store.read(rec.principal)).head, c.snapshot.head);
    // A closed reservation cannot be revalidated.
    const gone = await f.w.engine.revalidate(rec, moved);
    assert.ok(!gone.ok && gone.error.code === 'RESERVATION_NOT_ACTIVE');
  });

  it('had the mark moved only to 104,000, revalidation passes on fresh bindings and the reservation cannot be closed NEVER_ISSUED', async () => {
    const f = await fixture();
    const buy = action(f.m, { authority: f.agent, size: 400n, limitPrice: 10_100_000n });
    const rec = authorized(await f.w.engine.authorizeAndReserve(request(buy, exampleF(f, PRICE, T), ctxAt(f, T)), ONCE));
    const fresh = { payload: buy.payload, states: exampleF(f, 10_400_000n, T + 3n), context: ctxAt(f, T + 3n) };
    const reval = await f.w.engine.revalidate(rec, fresh);
    assert.ok(reval.ok && reval.value.status === 'PASSED');
    if (reval.ok && reval.value.status === 'PASSED') {
      assert.equal(reval.value.refreshed, true);
      assert.notDeepEqual(reval.value.bindings, rec.stateBindings);
      // The fresh mark bounds the artifact: observed at T + 3, valid 30 s, never beyond the authorization's own end.
      assert.equal(reval.value.validUntil, rec.validUntil);
    }
    const c = await f.w.engine.closeNeverIssued(rec, fresh, ONCE);
    assert.equal(c.status, 'REFUSED');
    if (c.status === 'REFUSED') assert.equal(c.refusal.code, 'REVALIDATION_PASSED');
  });

  it('revalidation fails, never extends, once the authorization\'s own lifetime has passed', async () => {
    const f = await fixture();
    const buy = action(f.m, { authority: f.agent, size: 400n });
    const rec = authorized(await f.w.engine.authorizeAndReserve(request(buy, exampleF(f, PRICE, T), ctxAt(f, T)), ONCE));
    const late = await f.w.engine.revalidate(rec, { payload: buy.payload, states: exampleF(f, PRICE, rec.validUntil), context: ctxAt(f, rec.validUntil) });
    assert.ok(late.ok && late.value.status === 'FAILED' && late.value.refusal.reason === 'AUTHORIZATION_EXPIRED');
  });

  it('revocation of an ancestor fails revalidation; the unissued reservation may then close NEVER_ISSUED', async () => {
    const f = await fixture();
    const buy = action(f.m, { authority: f.agent, size: 400n });
    const rec = authorized(await f.w.engine.authorizeAndReserve(request(buy, exampleF(f, PRICE, T), ctxAt(f, T)), ONCE));
    const { validateRevocation } = await import('@mandate/ledger');
    const { authorityId } = await import('@mandate/core');
    const rev = validateRevocation({ target: authorityId(f.r0), issuer: { kind: f.r0.principal.kind, value: f.r0.principal.value }, effectiveAt: T + 1n, nonce: 0n });
    assert.ok(rev.ok);
    if (!rev.ok) return;
    assert.equal((await f.w.ledger.revoke(rec.principal, rev.value, T + 1n, ONCE)).status, 'COMMITTED');
    const req = { payload: buy.payload, states: exampleF(f, PRICE, T + 2n), context: ctxAt(f, T + 2n) };
    const reval = await f.w.engine.revalidate(rec, req);
    assert.ok(reval.ok && reval.value.status === 'FAILED' && reval.value.refusal.reason === 'AUTHORITY_REVOKED');
    closed(await f.w.engine.closeNeverIssued(rec, req, ONCE));
  });

  it('NEVER_ISSUED is refused once anything was consumed: execution evidence exists', async () => {
    const f = await fixture();
    const buy = action(f.m, { authority: f.agent, size: 400n });
    const rec = authorized(await f.w.engine.authorizeAndReserve(request(buy, exampleF(f, PRICE, T), ctxAt(f, T)), ONCE));
    const r = (await f.w.store.read(rec.principal)).state.reservations.get(rec.reservation);
    assert.ok(r !== undefined);
    const { evidenceFor } = await import('./support/world.ts');
    const consume = await f.w.ledger.settle(rec.principal, [{ kind: 'CONSUME', reservation: rec.reservation, generation: rec.generation, evidence: evidenceFor('fill'), amounts: r.demands.map((d, i) => (i === 3 ? 1n : 0n)) }], T + 1n, ONCE);
    assert.equal(consume.status, 'COMMITTED');
    const c = await f.w.engine.closeNeverIssued(rec, { payload: buy.payload, states: exampleF(f, 10_600_000n, T + 3n), context: ctxAt(f, T + 3n) }, ONCE);
    assert.equal(c.status, 'REFUSED');
    if (c.status === 'REFUSED') assert.equal(c.refusal.code, 'EXECUTION_EVIDENCE_EXISTS');
  });
});

describe('generations (RECON-2; brief §52)', () => {
  it('a generation-1 authorization can neither see, revalidate nor close generation 2', async () => {
    const f = await fixture({ limit: 1_000_000 });
    const buy = action(f.m, { authority: f.agent, size: 400n });
    const gen1 = authorized(await f.w.engine.authorizeAndReserve(request(buy, exampleF(f, PRICE, T), ctxAt(f, T)), ONCE));
    // Revalidation fails for want of fresh state: the mark it must recheck was not supplied.
    const failing = { payload: buy.payload, states: [], context: ctxAt(f, T + 3n) };
    closed(await f.w.engine.closeNeverIssued(gen1, failing, ONCE));
    // The same intent, retried at generation 2 on fresh state.
    const gen2 = authorized(await f.w.engine.authorizeAndReserve(request(buy, exampleF(f, PRICE, T + 4n), ctxAt(f, T + 4n), 2n), ONCE));
    assert.equal(gen2.actionId, gen1.actionId);
    assert.notEqual(gen2.reservation, gen1.reservation);
    assert.equal((await f.w.engine.closeNeverIssued(gen1, failing, ONCE)).status, 'ALREADY_CLOSED');
    const s = await f.w.store.read(gen2.principal);
    assert.equal(s.state.reservations.get(gen2.reservation)?.status, 'ACTIVE');
    // A generation cannot be reused, skipped or defaulted.
    const reuse = refused(await f.w.engine.authorizeAndReserve(request(buy, exampleF(f, PRICE, T + 4n), ctxAt(f, T + 4n), 2n), ONCE));
    assert.equal(reuse.reason, 'RESERVATION_EXISTS');
    const zero = refused(await f.w.engine.authorizeAndReserve(request(buy, exampleF(f, PRICE, T + 4n), ctxAt(f, T + 4n), 0n), ONCE));
    assert.equal(zero.code, 'REQUEST_INVALID');
  });
});

describe('bounded retry and concurrency results (brief §27)', () => {
  it('a CAS lost on every attempt is a structured CONFLICT, not an authority failure, and nothing is written', async () => {
    let interfere: (() => Promise<void>) | null = null;
    const w = world({ hooks: { delay: async (point) => (point === 'COMMIT' && interfere !== null ? interfere() : undefined) } });
    const f = await fixture({ w });
    let n = 0;
    interfere = async () => {
      n += 1;
      const extra = child(f.r0, { mods: [f.m], holder: AGENT_B, nonce: BigInt(100 + n), terms: [maxExposure(f.m, f.acct, 20_000)] });
      const saved = interfere;
      interfere = null;
      await f.w.ledger.registerGrant(extra, T0, ONCE);
      interfere = saved;
    };
    const out = await f.w.engine.authorizeAndReserve(request(action(f.m, { authority: f.agent, size: sizeFor(1_000) }), marketStates(f.m, [{ account: f.acct }]), ctxAt(f, T)), { maxAttempts: 3 });
    interfere = null;
    assert.equal(out.status, 'CONFLICT');
    if (out.status === 'CONFLICT') {
      assert.equal(out.refusal.code, 'RETRY_EXHAUSTED');
      assert.equal(out.attempts, 3);
      assert.equal(out.conflicts.length, 3);
    }
    assert.equal((await f.w.store.read(f.r0.principal)).state.reservations.size, 0);
  });

  it('refuses a retry policy outside 1..32', async () => {
    const f = await fixture();
    for (const maxAttempts of [0, 33, 1.5]) {
      const r = refused(await f.w.engine.authorizeAndReserve(request(action(f.m, { authority: f.agent, size: 1n }), [], ctxAt(f, T)), { maxAttempts }));
      assert.equal(r.reason, 'RETRY_POLICY_INVALID');
    }
    void ticks;
  });

  it('a refusal writes nothing', async () => {
    const f = await fixture({ limit: 1_000 });
    const before = await f.w.store.read(f.r0.principal);
    refused(await f.w.engine.authorizeAndReserve(request(action(f.m, { authority: f.agent, size: sizeFor(2_000) }), marketStates(f.m, [{ account: f.acct }]), ctxAt(f, T)), RETRY));
    const after = await f.w.store.read(f.r0.principal);
    assert.equal(after.head, before.head);
    assert.equal(after.version, before.version);
  });
});
