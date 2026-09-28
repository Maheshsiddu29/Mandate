/**
 * Worst-case projection over `S ⊕ Pending(L)` (PROJ-1; action-state-model.md
 * §6; brief §11–§13, §24, §53).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthorityId, DimensionId, StateInvariantInput } from '@mandate/core';
import { nodeTargetKey, type TargetBalance } from '@mandate/ledger';
import { encodeProjectionRecord, projectionDigest, type ProjectionRecord } from '../src/index.ts';
import {
  AGENT_A,
  AGENT_B,
  PRICE,
  RETRY,
  T,
  account,
  action,
  authorized,
  capitalDim,
  child,
  context,
  createSyntheticModule,
  marketStates,
  maxExposure,
  notionalDim,
  PERP_CFG,
  policy,
  refused,
  request,
  root,
  setup,
  sizeFor,
  usd,
  world,
  type SyntheticModule,
  type World,
} from './support/world.ts';

async function singleModule(invariant: (m: SyntheticModule, acct: ReturnType<typeof account>) => StateInvariantInput, extra: { notional?: number } = {}) {
  const w = world();
  const m = w.modules[0] as SyntheticModule;
  const acct = account(m);
  const dims = [capitalDim('capital', 1_000_000), ...(extra.notional === undefined ? [] : [notionalDim('btc-notional', extra.notional)])];
  const r0 = root({ mods: [m], delegate: 1, terms: [...dims, invariant(m, acct)] });
  const a = child(r0, { mods: [m], holder: AGENT_A, terms: [invariant(m, acct)] });
  const b = child(r0, { mods: [m], holder: AGENT_B, nonce: 1n, terms: [invariant(m, acct)] });
  await setup(w, policy(), [r0, a, b]);
  return { w, m, acct, a, b };
}

function ctxFor(m: SyntheticModule, acct: ReturnType<typeof account>, at = T) {
  return context([m], { at, accounts: [{ module: m, account: acct }] });
}

describe('pending reservations are projected in full (PROJ-1)', () => {
  it('filled 2,000 + pending 2,000 + new 2,000 = 6,000 > 5,000 refuses, though filled alone would pass (brief §12)', async () => {
    const { w, m, acct, a, b } = await singleModule((mod, x) => maxExposure(mod, x, 5_000));
    const held = marketStates(m, [{ account: acct, positions: [{ localId: 'x:BTC-PERP', size: sizeFor(2_000) }] }]);

    // Without any pending reservation, filled 2,000 + new 2,000 = 4,000: the same request would pass.
    const preview = await w.engine.decide(request(action(m, { authority: b, size: sizeFor(2_000), nonce: 9n }), held, ctxFor(m, acct)));
    assert.ok(preview.ok);

    authorized(await w.engine.authorizeAndReserve(request(action(m, { authority: a, size: sizeFor(2_000) }), held, ctxFor(m, acct)), RETRY));
    const r = refused(await w.engine.authorizeAndReserve(request(action(m, { authority: b, size: sizeFor(2_000), nonce: 1n }), held, ctxFor(m, acct)), RETRY));
    assert.equal(r.code, 'INVARIANT_FAILED');
    assert.equal(r.reason, 'EXPOSURE_LIMIT_EXCEEDED');
    assert.equal(r.detail.kind, 'INVARIANTS');
    if (r.detail.kind === 'INVARIANTS') {
      const violated = r.detail.results.filter((x) => x.outcome === 'VIOLATED');
      assert.ok(violated.length > 0);
      for (const v of violated) {
        assert.deepEqual(v.observed, { type: 'TOTAL', kind: 'GROSS_EXPOSURE', unit: 'USD', decimals: 2, atoms: usd(6_000) });
        assert.deepEqual(v.bound, { type: 'TOTAL', kind: 'GROSS_EXPOSURE', unit: 'USD', decimals: 2, atoms: usd(5_000) });
        // The evidence names the pending reservation it counted.
        assert.equal(v.reservations.length, 1);
      }
    }
    // 1,000 still fits: 2,000 + 2,000 + 1,000 = 5,000.
    authorized(await w.engine.authorizeAndReserve(request(action(m, { authority: b, size: sizeFor(1_000), nonce: 2n }), held, ctxFor(m, acct)), RETRY));
  });

  it('a pending reduction is not credited: an open close order leaves exposure unchanged', async () => {
    const { w, m, acct, a, b } = await singleModule((mod, x) => maxExposure(mod, x, 5_000));
    const held = marketStates(m, [{ account: acct, positions: [{ localId: 'x:BTC-PERP', size: sizeFor(4_000) }] }]);
    authorized(await w.engine.authorizeAndReserve(request(action(m, { authority: a, size: sizeFor(4_000), side: 'CLOSE' }), held, ctxFor(m, acct)), RETRY));
    const r = refused(await w.engine.authorizeAndReserve(request(action(m, { authority: b, size: sizeFor(2_000), nonce: 1n }), held, ctxFor(m, acct)), RETRY));
    assert.equal(r.code, 'INVARIANT_FAILED');
  });

  it('a projection names exactly the state and reservations it was given, and is canonically digested', async () => {
    const { w, m, acct, a, b } = await singleModule((mod, x) => maxExposure(mod, x, 50_000));
    const held = marketStates(m, [{ account: acct }]);
    const first = authorized(await w.engine.authorizeAndReserve(request(action(m, { authority: a, size: sizeFor(1_000) }), held, ctxFor(m, acct)), RETRY));
    const d = await w.engine.decide(request(action(m, { authority: b, size: sizeFor(1_000), nonce: 1n }), held, ctxFor(m, acct)));
    assert.ok(d.ok);
    if (!d.ok) return;
    const part = d.value.projection.participants[0];
    assert.ok(part !== undefined);
    assert.deepEqual(part.reservations, [first.reservation]);
    assert.equal(part.states.length, 3);
    assert.ok(part.projection.facts.some((f) => f.component === 'PENDING' && f.reservations.includes(first.reservation)));
    assert.ok(part.projection.facts.some((f) => f.component === 'PROPOSED'));
    // Canonical: reordering facts inside the record does not change the digest.
    const shuffled: ProjectionRecord = {
      ...d.value.projection,
      participants: d.value.projection.participants.map((p) => ({ ...p, projection: { ...p.projection, facts: [...p.projection.facts].reverse(), resources: [...p.projection.resources].reverse() } })),
    };
    assert.equal(projectionDigest(shuffled), d.value.projectionDigest);
    assert.deepEqual(encodeProjectionRecord(shuffled), encodeProjectionRecord(d.value.projection));
  });

  it('a pending reservation under another ModuleRef of the same domain makes the module-owned invariant UNKNOWN, never optimistic', async () => {
    const v1 = createSyntheticModule(PERP_CFG);
    const v2 = createSyntheticModule({ ...PERP_CFG, moduleVersion: 2 });
    const w = world({ modules: [v1, v2] });
    const acct = account(v1);
    const r0 = root({ mods: [v1, v2], delegate: 1, terms: [capitalDim('capital', 1_000_000), maxExposure(v2, acct, 50_000)] });
    const a = child(r0, { mods: [v1, v2], holder: AGENT_A, terms: [maxExposure(v2, acct, 50_000)] });
    await setup(w, policy(), [r0, a]);
    const both = [...marketStates(v1, [{ account: acct }]), ...marketStates(v2, [{ account: acct }])];
    const ctx = context([v1, v2], { accounts: [{ module: v1, account: acct }] });
    // A v1 order is pending; a v2 decision cannot account for it.
    authorized(await w.engine.authorizeAndReserve(request(action(v1, { authority: a, size: sizeFor(1_000) }), both, ctx), RETRY));
    const r = refused(await w.engine.authorizeAndReserve(request(action(v2, { authority: a, size: sizeFor(1_000), nonce: 1n }), both, ctx), RETRY));
    assert.equal(r.code, 'INVARIANT_UNKNOWN');
    assert.equal(r.reason, 'PENDING_UNDER_OTHER_MODULE');
  });
});

describe('marked exposure is an invariant, committed notional a ledger counter (Phase 7B.1 ruling 2; brief §24)', () => {
  async function reserveNotional(w: World, m: SyntheticModule, authority: Parameters<typeof action>[1]['authority'], acct: ReturnType<typeof account>, mark: bigint, limit: bigint, nonce: bigint) {
    return w.engine.authorizeAndReserve(request(action(m, { authority, size: sizeFor(2_000), limitPrice: limit, nonce }), marketStates(m, [{ account: acct }], mark), ctxFor(m, acct)), RETRY);
  }

  it('committed notional is reserved at the order\'s limit, never at the mark, and a moved mark changes no counter', async () => {
    const { w, m, acct, a } = await singleModule((mod, x) => maxExposure(mod, x, 1_000_000), { notional: 1_000_000 });
    // Limit 101,000.00; mark 100,000.00. Notional = 0.02 × 101,000 = 2,020.00; marked exposure = 2,000.00.
    const rec = authorized(await reserveNotional(w, m, a, acct, PRICE, 10_100_000n, 0n));
    const s1 = await w.store.read(rec.principal);
    const key = nodeTargetKey(rec.lineage[rec.lineage.length - 1] as AuthorityId, 'btc-notional' as DimensionId);
    assert.equal((s1.state.targets.get(key) as TargetBalance).reserved, usd(2_020));
    const reservation = s1.state.reservations.get(rec.reservation);
    const notional = reservation?.demands.find((d) => d.contribution.quantity.kind === 'NOTIONAL');
    assert.equal(notional?.contribution.quantity.valuation?.basis, 'LIMIT');
    assert.equal(notional?.contribution.quantity.valuation?.source.kind, 'ACTION');

    // The mark moves to 106,000.00. Evaluating again changes the invariant's projection, never the ledger.
    const before = s1.head;
    const d = await w.engine.decide(request(action(m, { authority: a, size: 1n, nonce: 5n }), marketStates(m, [{ account: acct }], 10_600_000n), ctxFor(m, acct)));
    assert.ok(d.ok);
    const s2 = await w.store.read(rec.principal);
    assert.equal(s2.head, before);
    assert.equal((s2.state.targets.get(key) as TargetBalance).reserved, usd(2_020));
    if (d.ok) {
      const gross = d.value.invariants[0]?.observed;
      // Pending 0.02 and proposed 0.0001 at the new mark: 2,120.00 + 10.60.
      assert.deepEqual(gross, { type: 'TOTAL', kind: 'GROSS_EXPOSURE', unit: 'USD', decimals: 2, atoms: usd(2_120) + 1_060n });
    }
  });
});

