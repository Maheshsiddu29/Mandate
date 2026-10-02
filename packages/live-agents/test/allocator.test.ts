/**
 * The deterministic allocator and advisory scoring
 * (docs/v2/mandate-room-v2.md §6–§7). Dollars come from arithmetic over
 * validated cards; a model's number or Jev's score never becomes a budget
 * directly, and nothing is forced into a weak opportunity.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allocate, coherent, modelUtility, MIN_UTILITY, type AllocationEntry } from '../src/allocation/allocator.ts';
import type { OpportunityCard } from '../src/allocation/card.ts';
import { NoScorer, scoreBps, validateScore } from '../src/jev/scorer.ts';
import type { Role } from '../src/types.ts';

const U = (whole: number): bigint => BigInt(whole) * 1_000_000n;

function card(role: Role, o: { readonly action?: 'PROPOSE' | 'ABSTAIN'; readonly min?: number; readonly max?: number; readonly q?: number; readonly risk?: number; readonly conf?: number; readonly observedAt?: bigint; readonly fresh?: bigint } = {}): OpportunityCard {
  const action = o.action ?? 'PROPOSE';
  return {
    role,
    candidateId: action === 'PROPOSE' ? `${role}-c` : null,
    candidateTitle: null,
    action,
    requestedAtoms: action === 'PROPOSE' ? U(o.max ?? 500) : 0n,
    minimumUsefulAtoms: action === 'PROPOSE' ? U(o.min ?? 100) : 0n,
    maximumUsefulAtoms: action === 'PROPOSE' ? U(o.max ?? 500) : 0n,
    metrics: { opportunityQuality: o.q ?? 3, liquidity: 3, executionQuality: 3, downsideRisk: o.risk ?? 1, dataConfidence: o.conf ?? 2 },
    marketRegime: 'NEUTRAL',
    rationale: 'test',
    observedAt: o.observedAt ?? 1_000n,
    freshUntil: (o.observedAt ?? 1_000n) + (o.fresh ?? 300n),
    evidence: [],
    modelEvidence: 'SCRIPTED',
    marketEvidence: 'FIXTURE',
    runtime: 'RESPONDED',
  };
}
const entry = (c: OpportunityCard, hardCap = 10_000, jevBps: number | null = null): AllocationEntry => ({ card: c, jevBps, hardCapAtoms: U(hardCap) });
const ok = (r: ReturnType<typeof allocate>) => {
  if (!r.ok) throw new Error(r.reason);
  return r;
};
const atoms = (r: ReturnType<typeof ok>) => Object.fromEntries(r.allocations.map((a) => [a.role, a.atoms]));

const FOUR = [entry(card('stock', { q: 4, max: 900 })), entry(card('swap', { q: 2, max: 600 })), entry(card('yield', { q: 4, max: 900 })), entry(card('perps', { q: 2, risk: 3, max: 400 }), 400)];

describe('deterministic allocator', () => {
  it('16. identical inputs give identical output', () => {
    assert.deepEqual(ok(allocate(U(2000), FOUR)), ok(allocate(U(2000), FOUR)));
  });

  it('17. input order cannot change the output', () => {
    const a = ok(allocate(U(2000), FOUR));
    const b = ok(allocate(U(2000), [...FOUR].reverse()));
    const c = ok(allocate(U(2000), [FOUR[2], FOUR[0], FOUR[3], FOUR[1]] as AllocationEntry[]));
    assert.deepEqual(a, b);
    assert.deepEqual(a, c);
    // Stronger evidence-weighted utility receives more.
    assert.ok((atoms(a)['stock'] as bigint) > (atoms(a)['swap'] as bigint));
  });

  it('18. an abstaining agent receives zero, and so does one without data confidence or utility', () => {
    const r = ok(allocate(U(2000), [entry(card('stock')), entry(card('yield', { action: 'ABSTAIN' })), entry(card('swap', { conf: 0 })), entry(card('perps', { q: 0, risk: 4, conf: 1 }))]));
    const by = Object.fromEntries(r.allocations.map((a) => [a.role, a]));
    assert.equal(by['yield']?.atoms, 0n);
    assert.equal(by['yield']?.zero, 'ABSTAINED');
    assert.equal(by['swap']?.zero, 'NO_DATA_CONFIDENCE');
    assert.ok(modelUtility(card('perps', { q: 0, risk: 4, conf: 1 })) < MIN_UTILITY);
    assert.equal(by['perps']?.zero, 'BELOW_UTILITY_THRESHOLD');
    assert.ok((by['stock']?.atoms as bigint) > 0n);
  });

  it('19. maximumUseful and the hard cap are respected', () => {
    const r = ok(allocate(U(2000), [entry(card('stock', { max: 300 })), entry(card('yield', { max: 900 }), 250)]));
    assert.equal(atoms(r)['stock'], U(300));
    assert.equal(atoms(r)['yield'], U(250));
  });

  it('20. minimumUseful is respected: an agent whose share cannot reach it is dropped, and the rest is shared again', () => {
    // Pool 500: three equal agents would get 166 each, below perps' minimum of 200.
    const r = ok(allocate(U(500), [entry(card('stock', { min: 100 })), entry(card('swap', { min: 100 })), entry(card('perps', { min: 200, max: 400 }))]));
    const by = Object.fromEntries(r.allocations.map((a) => [a.role, a]));
    for (const a of r.allocations) assert.ok(a.atoms === 0n || a.atoms >= U(a.role === 'perps' ? 200 : 100), a.role);
    assert.ok(r.allocations.some((a) => a.zero === 'BELOW_MINIMUM_USEFUL'));
    assert.equal((by['stock']?.atoms as bigint) + (by['swap']?.atoms as bigint) + (by['perps']?.atoms as bigint), r.allocatedAtoms);
  });

  it('21. leftover capital stays unallocated: nothing is forced into an agent past what it can use', () => {
    const r = ok(allocate(U(2000), [entry(card('stock', { max: 700 })), entry(card('swap', { max: 350 })), entry(card('perps', { max: 400 }))]));
    assert.equal(r.allocatedAtoms, U(1450));
    assert.equal(r.unallocatedAtoms, U(550));
    const none = ok(allocate(U(2000), [entry(card('stock', { action: 'ABSTAIN' })), entry(card('yield', { action: 'ABSTAIN' }))]));
    assert.equal(none.allocatedAtoms, 0n);
    assert.equal(none.unallocatedAtoms, U(2000));
  });

  it('budgets are whole USDC and never exceed the pool', () => {
    const r = ok(allocate(U(1001), FOUR));
    for (const a of r.allocations) assert.equal(a.atoms % 1_000_000n, 0n);
    assert.ok(r.allocatedAtoms <= U(1001));
  });

  it('stale and fresh observations are never compared', () => {
    const stale = card('stock', { observedAt: 1_000n, fresh: 60n });
    const fresh = card('perps', { observedAt: 2_000n });
    assert.equal(coherent([stale, fresh]), false);
    assert.deepEqual(allocate(U(1000), [entry(stale), entry(fresh)]), { ok: false, reason: 'PLAN_OBSERVATIONS_INCOHERENT' });
  });
});

describe('Jev scoring is advisory only', () => {
  const raw = (score: unknown, extra: object = {}) => ({ score, confidence: 0.8, probabilities: { '0': 0, '1': 0, '2': 0.2, '3': 0.6, '4': 0.2 }, model: 'jev-1', ...extra });

  it('30. a score cannot authorize anything: it only scales weight inside caps, and cannot revive an abstainer', () => {
    const top = ok(allocate(U(2000), [entry(card('stock', { max: 600 }), 600, 10_000), entry(card('yield', { action: 'ABSTAIN' }), 10_000, 10_000)]));
    assert.equal(atoms(top)['stock'], U(600));
    assert.equal(atoms(top)['yield'], 0n);
  });

  it('31. a malformed answer is UNAVAILABLE, never repaired', () => {
    for (const bad of [raw(4.5), raw(-1), raw(Number.NaN), raw('3'), raw(2, { confidence: 2 }), raw(2, { probabilities: { '0': 1 } }), raw(2, { model: '' })]) {
      const s = validateScore(bad, 5);
      assert.equal(s.status, 'UNAVAILABLE', JSON.stringify(bad));
      assert.equal(scoreBps(s), null);
    }
  });

  it('32. an unavailable scorer fabricates no score', async () => {
    const s = await new NoScorer().score();
    assert.deepEqual(s, { status: 'UNAVAILABLE', reason: 'JEV_NOT_CONFIGURED', latencyMs: 0 });
    assert.equal(scoreBps(s), null);
  });

  it('33. the allocator accepts only validated integer scores', () => {
    const s = validateScore(raw(3), 5);
    assert.equal(s.status, 'SCORED');
    assert.equal(scoreBps(s), 7500);
    assert.deepEqual(allocate(U(1000), [entry(card('stock'), 1000, 0.5)]), { ok: false, reason: 'INVALID_SCORE' });
    assert.deepEqual(allocate(U(1000), [entry(card('stock'), 1000, 10_001)]), { ok: false, reason: 'INVALID_SCORE' });
  });

  it('34. changing a Jev score cannot bypass a hard constraint', () => {
    for (const bps of [0, 5000, 10_000]) {
      const r = ok(allocate(U(2000), [entry(card('perps', { max: 900 }), 400, bps), entry(card('stock', { max: 900 }), 800, 0)]));
      assert.ok((atoms(r)['perps'] as bigint) <= U(400));
      assert.ok((atoms(r)['stock'] as bigint) <= U(800));
      assert.ok(r.allocatedAtoms <= U(2000));
    }
  });
});
