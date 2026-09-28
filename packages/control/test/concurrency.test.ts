/**
 * Projected-state safety under concurrency (CONC-1 extended to projections;
 * brief §26, §42, §43). The ledger's CAS serializes reservations; the engine
 * recomputes the whole projection on every attempt, so a concurrent
 * reservation changes what the loser's invariants see, not only its capacity.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthorityGrant } from '@mandate/core';
import type { InMemoryStoreHooks, ReservationRecord } from '@mandate/ledger';
import type { AuthorizationOutcome } from '../src/index.ts';
import {
  AGENT_A,
  AGENT_B,
  PRICE,
  RETRY,
  T0,
  account,
  action,
  address,
  aggregate,
  capitalDim,
  child,
  context,
  int,
  marketStates,
  policy,
  prng,
  request,
  root,
  setup,
  sizeFor,
  ticks,
  usd,
  valueOf,
  assetValuedModules,
  world,
  type SyntheticModule,
} from './support/world.ts';

/** Once armed, the first `n` readers wait for each other: the decisions start from one snapshot. */
function barrier(n: number): InMemoryStoreHooks & { arm: () => void } {
  let armed = false;
  let waiting = 0;
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return {
    delay: async (point) => {
      if (point !== 'READ' || !armed || waiting >= n) return;
      waiting += 1;
      if (waiting === n) open();
      await gate;
    },
    arm: () => {
      armed = true;
    },
  };
}

async function twoAgents(hooks: InMemoryStoreHooks) {
  const w = world({ hooks, modules: assetValuedModules() });
  const perp = w.modules[0] as SyntheticModule;
  const spot = w.modules[1] as SyntheticModule;
  const acctS = account(spot);
  const acctP = account(perp);
  // Ledger budgets are generous: only the projected state can refuse.
  const r0 = root({ mods: [perp, spot], delegate: 1, terms: [capitalDim('capital', 1_000_000)] });
  const a = child(r0, { mods: [spot], holder: AGENT_A, terms: [capitalDim('capital', 100_000)] });
  const b = child(r0, { mods: [perp], holder: AGENT_B, terms: [capitalDim('capital', 100_000)] });
  await setup(w, policy([aggregate({ whole: 5_000, contributors: [spot, perp], accounts: [acctS, acctP] })]), [r0, a, b]);
  const states = [...marketStates(spot, [{ account: acctS, positions: [{ localId: 'x:BTC-SPOT', size: sizeFor(1_000) }] }]), ...marketStates(perp, [{ account: acctP }])];
  const ctx = context([perp, spot], { accounts: [{ module: spot, account: acctS }, { module: perp, account: acctP }] });
  return { w, perp, spot, a, b, states, ctx };
}

describe('concurrent projection (brief §42)', () => {
  it('two decisions from one snapshot, each valid alone, together over the limit: one reserves, the loser re-projects with the winner\'s pending and refuses', async () => {
    const hooks = barrier(2);
    const t = await twoAgents(hooks);
    hooks.arm();
    // Held 1,000; each proposes 2,500: alone 3,500 ≤ 5,000; together 6,000.
    const [x, y] = await Promise.all([
      t.w.engine.authorizeAndReserve(request(action(t.spot, { authority: t.a, size: sizeFor(2_500) }), t.states, t.ctx), RETRY),
      t.w.engine.authorizeAndReserve(request(action(t.perp, { authority: t.b, size: sizeFor(2_500) }), t.states, t.ctx), RETRY),
    ]);
    const outcomes = [x, y];
    const winners = outcomes.filter((o) => o.status === 'AUTHORIZED');
    const losers = outcomes.filter((o) => o.status === 'REFUSED');
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    const winner = winners[0] as Extract<AuthorizationOutcome, { status: 'AUTHORIZED' }>;
    const loser = losers[0] as Extract<AuthorizationOutcome, { status: 'REFUSED' }>;
    // The loser read the same snapshot, lost the CAS, recomputed, and was refused by the projection — not by the ledger.
    assert.equal(loser.conflicts.length, 1);
    assert.equal(loser.attempts, 2);
    assert.equal(loser.refusal.code, 'INVARIANT_FAILED');
    if (loser.refusal.detail.kind === 'INVARIANTS') {
      const g = loser.refusal.detail.results.find((r) => r.origin === 'POLICY');
      assert.deepEqual(g?.reservations, [winner.authorization.reservation]);
      assert.equal(g?.ledgerVersion, winner.authorization.ledgerVersionCommitted);
    }
    assert.equal(winner.decision.ledgerVersion, winner.authorization.ledgerVersionCommitted - 1n);
  });

  it('over randomized interleavings, never both, and both orders occur', async () => {
    const winnersSeen = new Set<string>();
    let conflicts = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const rand = prng(seed);
      const t = await twoAgents({ delay: () => ticks(int(rand, 0, 3)) });
      const out = await Promise.all([
        t.w.engine.authorizeAndReserve(request(action(t.spot, { authority: t.a, size: sizeFor(2_500) }), t.states, t.ctx), RETRY),
        t.w.engine.authorizeAndReserve(request(action(t.perp, { authority: t.b, size: sizeFor(2_500) }), t.states, t.ctx), RETRY),
      ]);
      const authorizedCount = out.filter((o) => o.status === 'AUTHORIZED').length;
      assert.equal(authorizedCount, 1, `seed ${seed}`);
      for (const o of out) if (o.status === 'REFUSED') assert.equal(o.refusal.code, 'INVARIANT_FAILED');
      winnersSeen.add(out[0]?.status === 'AUTHORIZED' ? 'spot' : 'perp');
      conflicts += out.reduce((n, o) => n + (o.status === 'CONFLICT' ? 0 : o.conflicts.length), 0);
    }
    assert.deepEqual([...winnersSeen].sort(), ['perp', 'spot']);
    assert.ok(conflicts > 0, 'CAS conflicts occurred');
  });
});

describe('100 agents, one principal, several roots, shared invariant and budget (brief §43)', () => {
  it('ends with every global constraint satisfied, no reservation lost, and no decision on a pre-conflict projection', async () => {
    const rand = prng(4242);
    const w = world({ hooks: { delay: () => ticks(int(rand, 0, 4)) }, modules: assetValuedModules() });
    const perp = w.modules[0] as SyntheticModule;
    const spot = w.modules[1] as SyntheticModule;
    const acctS = account(spot);
    const acctP = account(perp);
    const LIMIT = 40_000;
    const GLOBAL_CAPITAL = 45_000;
    const roots = [
      root({ mods: [spot], holder: address('41'), delegate: 1, terms: [capitalDim('capital', 30_000)] }),
      root({ mods: [perp], holder: address('42'), delegate: 1, nonce: 1n, terms: [capitalDim('capital', 30_000)] }),
      root({ mods: [perp, spot], holder: address('43'), delegate: 1, nonce: 2n, terms: [capitalDim('capital', 30_000)] }),
    ];
    const agents: { grant: AuthorityGrant; module: SyntheticModule }[] = [];
    for (let i = 0; i < 100; i += 1) {
      // Root 0 is spot-only, root 1 perp-only, root 2 both: its children alternate between the two domains.
      const parent = roots[i % 3] as AuthorityGrant;
      const usable = i % 3 === 0 ? spot : i % 3 === 1 ? perp : i % 2 === 0 ? spot : perp;
      const holder = address((0x50 + i).toString(16).padStart(2, '0').slice(-2));
      agents.push({ grant: child(parent, { mods: [usable], holder, nonce: BigInt(i), terms: [capitalDim('capital', 5_000)] }), module: usable });
    }
    const policyTerms = [aggregate({ whole: LIMIT, contributors: [spot, perp], accounts: [acctS, acctP] }), { ...capitalDim('global-capital', GLOBAL_CAPITAL) }];
    await setup(w, policy(policyTerms), [...roots, ...agents.map((a) => a.grant)], T0);
    const states = [...marketStates(spot, [{ account: acctS }]), ...marketStates(perp, [{ account: acctP }])];
    const ctx = context([perp, spot], { accounts: [{ module: spot, account: acctS }, { module: perp, account: acctP }] });

    const outcomes = await Promise.all(
      agents.map((a, i) => w.engine.authorizeAndReserve(request(action(a.module, { authority: a.grant, size: sizeFor(int(rand, 3, 20) * 100), nonce: BigInt(i) }), states, ctx), RETRY)),
    );
    const final = await w.store.read(roots[0]?.principal as AuthorityGrant['principal']);
    const active = [...final.state.reservations.values()].filter((r: ReservationRecord) => r.status === 'ACTIVE');
    const authorizedOutcomes = outcomes.filter((o): o is Extract<AuthorizationOutcome, { status: 'AUTHORIZED' }> => o.status === 'AUTHORIZED');

    // No reservation disappeared, and none exists without its authorization.
    assert.equal(active.length, authorizedOutcomes.length);
    assert.deepEqual(active.map((r) => r.id).sort(), authorizedOutcomes.map((o) => o.authorization.reservation).sort());
    assert.ok(authorizedOutcomes.length > 5 && authorizedOutcomes.length < 100, `a contested but non-trivial run (${authorizedOutcomes.length})`);

    // The global marked-exposure invariant holds on the final pending set.
    let exposure = 0n;
    for (const r of active) for (const d of r.demands) if (d.contribution.quantity.kind === 'POSITION_SIZE') exposure += valueOf(d.contribution.quantity.atoms, PRICE);
    assert.ok(exposure <= usd(LIMIT), `exposure ${exposure}`);
    // Every quantitative ledger constraint holds on every target.
    for (const t of final.state.targets.values()) assert.ok(t.reserved + t.consumed <= t.dimension.limit.atoms + t.restored, `${t.ref.dimensionId}`);

    // No decision relied on a stale projection: each was decided at the version immediately before its commit,
    // and projected exactly the reservations that were active at that version.
    const byVersion = new Map(active.map((r) => [r.id, r.committedAt]));
    for (const o of authorizedOutcomes) {
      const d = o.decision;
      assert.equal(d.ledgerVersion + 1n, o.authorization.ledgerVersionCommitted);
      const seen = new Set(d.projection.participants.flatMap((p) => p.reservations));
      const expected = active.filter((r) => (byVersion.get(r.id) as bigint) <= d.ledgerVersion).map((r) => r.id);
      assert.deepEqual([...seen].sort(), expected.sort());
    }
    // Refusals are refusals of projection or capacity, or a structured concurrency result — never anything else.
    for (const o of outcomes) {
      if (o.status === 'REFUSED') assert.ok(['INVARIANT_FAILED', 'AUTHORITY_UNAVAILABLE'].includes(o.refusal.code), o.refusal.code);
      if (o.status === 'CONFLICT') assert.equal(o.refusal.code, 'RETRY_EXHAUSTED');
    }
  });
});
