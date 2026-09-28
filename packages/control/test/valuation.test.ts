/**
 * One valuation context per canonical asset in a principal-global aggregate
 * (7D.1 ruling; aggregate.ts). Two marked facts valued at different admitted
 * observations are not parts of one number, however well their sum fits the
 * limit: the aggregate is UNKNOWN and the action refuses. The same facts
 * under one shared observation of the asset's price are summed exactly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ResourceLocalId, StateEnvelope, StateSourceId } from '@mandate/core';
import { aggregateSpecOf, checkValuationContexts, type ParticipantView } from '../src/aggregate.ts';
import type { InvariantResult, SuppliedState } from '../src/index.ts';
import {
  AGENT_A,
  AGENT_B,
  MARK,
  RETRY,
  T,
  PERP_CFG,
  account,
  action,
  aggregate,
  assetValuedModules,
  authorized,
  capitalDim,
  context,
  createSyntheticModule,
  marketStates,
  maxExposure,
  policy,
  refused,
  request,
  root,
  setup,
  usd,
  world,
  type SyntheticModule,
} from './support/world.ts';

/** 0.08 BTC: 4,000.00 at 50,000. */
const SIZE_A = 800n;
/** 0.0577 BTC: 3,000.40 at 52,000 (the nearest 4-decimal size to 3,000), 2,885.00 at 50,000. */
const SIZE_B = 577n;
const BTC_50K = 5_000_000n;
const BTC_52K = 5_200_000n;

function policyResult(results: readonly InvariantResult[]): InvariantResult {
  const r = results.find((x) => x.origin === 'POLICY');
  assert.ok(r !== undefined);
  return r;
}

/** Module A (perp-like) and module B (spot-like), each holding BTC, under a principal-global BTC marked exposure ≤ 10,000. */
async function twoModules(modules: readonly SyntheticModule[] = assetValuedModules()) {
  const w = world({ modules });
  const a = w.modules[0] as SyntheticModule;
  const b = w.modules[1] as SyntheticModule;
  const acctA = account(a);
  const acctB = account(b);
  const rootA = root({ mods: [a], holder: AGENT_A, terms: [capitalDim('capital', 100_000)] });
  const rootB = root({ mods: [b], holder: AGENT_B, nonce: 1n, terms: [capitalDim('capital', 100_000)] });
  await setup(w, policy([aggregate({ whole: 10_000, contributors: [a, b], accounts: [acctA, acctB] })]), [rootA, rootB]);
  const states = (priceA: bigint, priceB: bigint, o: { observedAtB?: bigint; sourceB?: string } = {}): SuppliedState[] => [
    ...marketStates(a, [{ account: acctA, positions: [{ localId: 'x:BTC-PERP', size: SIZE_A }] }], priceA),
    ...marketStates(b, [{ account: acctB, positions: [{ localId: 'x:BTC-SPOT', size: SIZE_B }] }], priceB, {
      ...(o.observedAtB === undefined ? {} : { observedAt: o.observedAtB }),
      ...(o.sourceB === undefined ? {} : { sourceId: o.sourceB }),
    }),
  ];
  const ctx = context([a, b], { accounts: [{ module: a, account: acctA }, { module: b, account: acctB }] });
  // A small order by A: 0.002 BTC, 100.00 at 50,000.
  const req = (s: readonly SuppliedState[], c = ctx) => request(action(a, { authority: rootA, size: 20n }), s, c);
  return { w, a, b, acctA, acctB, rootA, rootB, states, ctx, req };
}

describe('principal-global marked aggregate: one admitted valuation per canonical asset', () => {
  it('A 4,000 at BTC 50,000 + B 3,000 at BTC 52,000 under ≤ 10,000: numerically within, but UNKNOWN — refused', async () => {
    const s = await twoModules();
    const d = await s.w.engine.decide(s.req(s.states(BTC_50K, BTC_52K)));
    assert.ok(!d.ok);
    if (!d.ok) {
      assert.equal(d.error.code, 'INVARIANT_UNKNOWN');
      assert.equal(d.error.reason, 'VALUATION_CONTEXT_MISMATCH');
      assert.ok(d.error.detail.kind === 'INVARIANTS');
      if (d.error.detail.kind === 'INVARIANTS') {
        const g = policyResult(d.error.detail.results);
        assert.deepEqual(g.evaluator, { kind: 'CORE' });
        // No number is reported: there is none that means anything.
        assert.equal(g.observed, null);
      }
    }
    const r = refused(await s.w.engine.authorizeAndReserve(s.req(s.states(BTC_50K, BTC_52K)), RETRY));
    assert.equal(r.reason, 'VALUATION_CONTEXT_MISMATCH');
    assert.equal((await s.w.store.read(s.rootA.principal)).state.reservations.size, 0);
  });

  it('the same facts under one shared admitted BTC valuation are summed exactly and evaluated', async () => {
    const s = await twoModules();
    const d = await s.w.engine.decide(s.req(s.states(BTC_50K, BTC_50K)));
    assert.ok(d.ok, d.ok ? '' : `${d.error.code}/${d.error.reason}`);
    if (d.ok) {
      const g = policyResult(d.value.invariants);
      assert.equal(g.outcome, 'HOLDS');
      // 4,000.00 + 2,885.00 + 100.00 proposed.
      assert.deepEqual(g.observed, { type: 'TOTAL', kind: 'GROSS_EXPOSURE', unit: 'USD', decimals: 2, atoms: usd(6_985) });
      // Evidence: both modules' own snapshots of the one observation.
      const markIds = d.value.admissions.filter((x) => x.state.envelope.stateKind === MARK && x.state.envelope.subject.localId === 'crypto:btc').map((x) => x.state.stateId);
      assert.equal(markIds.length, 2);
      for (const id of markIds) assert.ok(g.states.includes(id));
    }
    authorized(await s.w.engine.authorizeAndReserve(s.req(s.states(BTC_50K, BTC_50K)), RETRY));
  });

  it('economically identical-looking facts under different bindings still do not aggregate: another observation time', async () => {
    const s = await twoModules();
    // Same price, observed one second apart.
    const later = refused(await s.w.engine.authorizeAndReserve(s.req(s.states(BTC_50K, BTC_50K, { observedAtB: T - 1n })), RETRY));
    assert.equal(later.reason, 'VALUATION_CONTEXT_MISMATCH');
    // A feed the module does not admit is refused at admission — never a silent substitute.
    const r = refused(await s.w.engine.authorizeAndReserve(s.req(s.states(BTC_50K, BTC_50K, { sourceB: 'synth.feed-b' })), RETRY));
    assert.equal(r.code, 'STATE_UNTRUSTED');
  });

  it('the valuation identity is the whole observation: source, sequence, time and exact price, from the admitted envelope', async () => {
    const s = await twoModules();
    const d = await s.w.engine.decide(s.req(s.states(BTC_50K, BTC_50K)));
    assert.ok(d.ok);
    if (!d.ok) return;
    const spec = aggregateSpecOf(policyResult(d.value.invariants).term);
    assert.ok(spec.ok);
    if (!spec.ok) return;
    const views = (edit: (e: StateEnvelope) => StateEnvelope = (e) => e): ParticipantView[] =>
      d.value.projection.participants.map((p) => ({
        module: p.module,
        projection: p.projection,
        admitted: new Map(
          d.value.admissions
            .filter((x) => x.need.module.ref.moduleDigest === p.module.moduleDigest)
            // Only module B's copy of the observation is altered.
            .map((x) => [x.state.stateId, p.module.moduleDigest === s.b.ref.moduleDigest && x.state.envelope.stateKind === MARK ? edit(x.state.envelope) : x.state.envelope] as const),
        ),
      }));
    assert.equal(checkValuationContexts(spec.value, views()), null);
    assert.equal(checkValuationContexts(spec.value, views((e) => ({ ...e, sourceId: 'synth.feed-b' as StateSourceId }))), 'VALUATION_CONTEXT_MISMATCH');
    assert.equal(checkValuationContexts(spec.value, views((e) => ({ ...e, sequence: { kind: 'VERSION', value: 2n } }))), 'VALUATION_CONTEXT_MISMATCH');
    // The envelope and the valuation it backs must agree on when the price was observed.
    assert.equal(checkValuationContexts(spec.value, views((e) => ({ ...e, observedAt: e.observedAt - 1n }))), 'VALUATION_PROVENANCE_MISMATCH');
    // A mark of anything but the scoped canonical asset is not its valuation.
    assert.equal(checkValuationContexts(spec.value, views((e) => ({ ...e, subject: { ...e.subject, localId: 'crypto:wbtc' as ResourceLocalId } }))), 'VALUATION_NOT_OF_AGGREGATE_ASSET');
    // A valuation whose snapshot cannot be found is never assumed.
    const unresolved = views().map((v) => (v.module.moduleDigest === s.b.ref.moduleDigest ? { ...v, admitted: new Map() } : v));
    assert.equal(checkValuationContexts(spec.value, unresolved), 'VALUATION_STATE_UNRESOLVED');
  });

  it('a domain-local (market) mark serves the module\'s own invariant but does not join a principal-global aggregate', async () => {
    const w = world({ modules: [createSyntheticModule(PERP_CFG)] });
    const m = w.modules[0] as SyntheticModule;
    const acct = account(m);
    const r0 = root({ mods: [m], holder: AGENT_A, terms: [capitalDim('capital', 100_000), maxExposure(m, acct, 1_000_000)] });
    await setup(w, policy([aggregate({ whole: 1_000_000, contributors: [m], accounts: [acct] })]), [r0]);
    const d = await w.engine.decide(request(action(m, { authority: r0, size: 20n }), marketStates(m, [{ account: acct }]), context([m], { accounts: [{ module: m, account: acct }] })));
    assert.ok(!d.ok);
    if (!d.ok && d.error.detail.kind === 'INVARIANTS') {
      const byOrigin = new Map(d.error.detail.results.map((x) => [x.origin, x]));
      assert.equal(byOrigin.get('LINEAGE')?.outcome, 'HOLDS');
      assert.equal(byOrigin.get('POLICY')?.outcome, 'UNKNOWN');
      assert.equal(byOrigin.get('POLICY')?.reason, 'VALUATION_NOT_OF_AGGREGATE_ASSET');
    } else assert.fail('expected an invariant refusal');
  });

  it('never picks the newest mark, one module\'s mark or an average: every ordering of the same inputs is UNKNOWN', async () => {
    for (const [pa, pb] of [
      [BTC_50K, BTC_52K],
      [BTC_52K, BTC_50K],
      [BTC_50K, BTC_50K + 1n],
    ] as const) {
      const s = await twoModules();
      const r = refused(await s.w.engine.authorizeAndReserve(s.req(s.states(pa, pb)), RETRY));
      assert.equal(r.reason, 'VALUATION_CONTEXT_MISMATCH');
    }
  });
});
