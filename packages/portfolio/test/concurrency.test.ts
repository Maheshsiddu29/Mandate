/**
 * Concurrency: five agents do not each see the same 2,000 as available.
 *
 * Reservations race through the ledger's compare-and-swap with the in-memory
 * store's `delay` hook forcing reads and commits of different agents to
 * interleave (seeded, deterministic). Whatever the interleaving, every leg —
 * each agent's own and the root's portfolio-wide one — holds:
 *
 *   consumed + reserved ≤ limit        (consumed is 0: reconciliation is not built)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authorityId } from '@mandate/core';
import { availableOf, nodeTargetKey, type InMemoryStoreHooks, type LedgerState } from '@mandate/ledger';
import { amountOf, availabilityFrom, initialBook, applyAllocation, planClaims, reserveChild, type ActionCandidate, type ReserveOutcome } from '../src/index.ts';
import { USDC, demoParty } from '../src/demo/index.ts';
import { NOW, nftBuy, perpOpen, stockBuy, swap, yieldDeposit } from './support/candidates.ts';
import { Rng } from './support/random.ts';
import { authorizationFor, world, type World } from './support/world.ts';

const reserve = (w: World, role: string, candidate: ActionCandidate) => {
  const authorization = authorizationFor(w.m, role, candidate);
  return reserveChild(w.core, authorization.transcript, authorization.verified.digest, NOW, { maxAttempts: 32 });
};

/** A delay hook that yields a seeded number of macrotask turns at every read and commit, so agents interleave. */
function shuffling(seed: number): InMemoryStoreHooks & { turns: number } {
  const r = new Rng(seed);
  const hooks = {
    turns: 0,
    delay: async () => {
      const n = r.int(4);
      hooks.turns += n;
      for (let i = 0; i < n; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
  return hooks;
}

/** Every leg of every dimension the compiled portfolio grants: reserved + consumed ≤ limit, at `NOW`. */
function legsHold(w: World, state: LedgerState): void {
  const grants = [w.compiled.root, ...w.compiled.delegations.values()];
  for (const g of grants) {
    for (const t of g.terms) {
      if (t.kind !== 'LEDGER_DIMENSION') continue;
      const b = state.targets.get(nodeTargetKey(authorityId(g), t.dimensionId));
      if (b === undefined) continue;
      assert.ok(b.reserved + b.consumed <= t.limit.atoms, `${t.dimensionId}: reserved ${b.reserved} + consumed ${b.consumed} > ${t.limit.atoms}`);
      assert.ok(availableOf(b, NOW) >= 0n);
    }
  }
}

const AT_MAXIMA: readonly (readonly [string, ActionCandidate])[] = [
  ['stock', stockBuy({ tenths: 64n })], // 800
  ['swap', swap({ amount: USDC(500n) })],
  ['nft', nftBuy({ price: USDC(400n) })],
  ['yield', yieldDeposit({ amount: USDC(800n) })],
  ['perps', perpOpen({ usdc: 400n })],
];

describe('five agents racing for one pool', () => {
  it('all five at their hard maxima (2,900 against 2,000), interleaved: the ledger never oversubscribes a leg', async () => {
    const hooks = shuffling(7);
    const w = await world({ hooks });
    const outs = await Promise.all(AT_MAXIMA.map(([role, c]) => reserve(w, role, c)));
    const snap = await w.core.engine.read(w.m.principal);
    legsHold(w, snap.state);
    const reserved = amountOf(availabilityFrom(w.compiled, snap, NOW).reserved, 'portfolio-notional');
    assert.ok(reserved <= USDC(2_000n), `reserved ${reserved}`);
    const refused = outs.filter((o): o is Extract<ReserveOutcome, { status: 'REFUSED' }> => o.status === 'REFUSED');
    assert.ok(refused.length >= 1, 'somebody was refused');
    for (const o of refused) assert.deepEqual(o.reasons.map((r) => r.code), ['LEDGER:AUTHORITY_UNAVAILABLE/LEDGER_LIMIT_EXCEEDED']);
    assert.ok(hooks.turns > 0, 'the reads and commits actually interleaved');
  });

  it('seeded interleavings of random requests: reserved + consumed ≤ limit on every leg, every time', async () => {
    const sizes = (r: Rng): [string, ActionCandidate][] => [
      ['stock', stockBuy({ tenths: BigInt(1 + r.int(64)) })],
      ['swap', swap({ amount: USDC(BigInt(1 + r.int(500))) })],
      ['nft', nftBuy({ price: USDC(BigInt(1 + r.int(400))) })],
      ['yield', yieldDeposit({ amount: USDC(BigInt(1 + r.int(800))) })],
      // Lighter's minimum order is 20 base atoms: below it PerpPolicy refuses, which is a module rule, not a race.
      ['perps', perpOpen({ usdc: BigInt(20 + r.int(380)) })],
      ['swap', swap({ amount: USDC(BigInt(1 + r.int(300))) })],
      ['yield', yieldDeposit({ amount: USDC(BigInt(1 + r.int(300))) })],
    ];
    for (let seed = 1; seed <= 12; seed += 1) {
      const r = new Rng(seed * 101);
      const w = await world({ hooks: shuffling(seed) });
      const batch = sizes(r);
      const outs = await Promise.all(batch.map(([role, c]) => reserve(w, role, c)));
      const snap = await w.core.engine.read(w.m.principal);
      legsHold(w, snap.state);
      // Every refusal is the ledger's limit, never a lost race: the engine retried.
      for (const o of outs) if (o.status === 'REFUSED') assert.deepEqual(o.reasons.map((x) => x.code), ['LEDGER:AUTHORITY_UNAVAILABLE/LEDGER_LIMIT_EXCEEDED'], `seed ${seed}`);
      // What was reserved is exactly the sum of what was authorized.
      const authorized = outs.filter((o) => o.status === 'RESERVED').length;
      assert.equal([...snap.state.reservations.values()].filter((x) => x.status === 'ACTIVE').length, authorized);
    }
  });

  it('one child reserved ten times at once: exactly one reservation, nine refusals', async () => {
    const w = await world({ hooks: shuffling(3) });
    const c = swap({ amount: USDC(200n) });
    const authorization = authorizationFor(w.m, 'swap', c);
    const outs = await Promise.all(Array.from({ length: 10 }, () => reserveChild(w.core, authorization.transcript, authorization.verified.digest, NOW, { maxAttempts: 32 })));
    assert.equal(outs.filter((o) => o.status === 'RESERVED').length, 1);
    for (const o of outs) if (o.status === 'REFUSED') assert.ok(o.reasons.every((x) => x.code.startsWith('LEDGER:') && x.code.includes('RESERVATION_EXISTS')), JSON.stringify(o.reasons));
    const snap = await w.core.engine.read(w.m.principal);
    assert.equal(snap.state.reservations.size, 1);
  });

  it('two claims planned against the same released lot: the book applies one, and refuses the other LOT_EXHAUSTED', async () => {
    const w = await world();
    const released = applyAllocation(w.m, initialBook(w.m), { kind: 'RELEASE', agent: demoParty('nft') as never, id: 'release/nft' as never, amounts: [{ resource: 'portfolio-notional', atoms: USDC(250n) }] as never });
    assert.ok(released.ok);
    const book = released.value;
    const a = planClaims(book, demoParty('stock') as never, 'portfolio-notional', USDC(250n), 'stock');
    const b = planClaims(book, demoParty('yield') as never, 'portfolio-notional', USDC(250n), 'yield');
    assert.ok(a !== null && b !== null, 'each plan alone is feasible');
    let after = book;
    for (const op of a) {
      const r = applyAllocation(w.m, after, op);
      assert.ok(r.ok);
      after = r.value;
    }
    const second = applyAllocation(w.m, after, b[0] as never);
    assert.deepEqual(second.ok ? null : second.error.code, 'LOT_EXHAUSTED');
  });
});
