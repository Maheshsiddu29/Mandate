/**
 * The allocation book: three modes, releases that become lots, lots
 * reassigned exactly once, double operations refused, and the conservation
 * invariant (Σ allocated + Σ lot remaining = portfolio limit) after every
 * operation — including over seeded random sequences.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAllocation,
  checkBookInvariant,
  entryOf,
  initialBook,
  lotId,
  obtainable,
  planClaims,
  replayAllocation,
  validateResourceVector,
  type AllocationBook,
  type AllocationOp,
  type PortfolioMandate,
} from '../src/index.ts';
import { PERPS, STOCK, SWAP, USDC6, must, sampleMandate } from './support/mandate.ts';
import { Rng } from './support/random.ts';

const N = 'portfolio-notional';
const v = (atoms: bigint, resource = N) => must(validateResourceVector([{ resource, atoms }], 'v'));
const agentOf = (p: { kind: string; value: string }) => p as never;
const step = (m: PortfolioMandate, b: AllocationBook, op: AllocationOp) => must(applyAllocation(m, b, op));
const refusal = (m: PortfolioMandate, b: AllocationBook, op: AllocationOp) => {
  const r = applyAllocation(m, b, op);
  return r.ok ? 'applied' : r.error.code;
};
const release = (agent: object, id: string, atoms: bigint): AllocationOp => ({ kind: 'RELEASE', agent: agentOf(agent as never), id: id as never, amounts: v(atoms) });
const claim = (agent: object, id: string, lot: string, amount: bigint): AllocationOp => ({ kind: 'CLAIM', agent: agentOf(agent as never), id: id as never, lot: lot as never, amount });
const commit = (agent: object, id: string, atoms: bigint): AllocationOp => ({ kind: 'COMMIT', agent: agentOf(agent as never), id: id as never, amounts: v(atoms) });

describe('initial books', () => {
  it('HYBRID: each agent holds its preferred allocation; the remainder of every limit is one claimable lot', () => {
    const m = sampleMandate();
    const b = initialBook(m);
    assert.equal(entryOf(b, agentOf(STOCK), N)?.allocated, USDC6(500n));
    assert.equal(entryOf(b, agentOf(PERPS), 'derivative-notional')?.allocated, 0n);
    assert.deepEqual(b.lots.map((l) => [l.id, l.remaining]), [
      [lotId('unallocated', 'portfolio', 'perp-margin'), USDC6(300n)],
      [lotId('unallocated', 'portfolio', 'spot-capital'), USDC6(800n)],
      [lotId('unallocated', 'portfolio', N), USDC6(750n)],
      [lotId('unallocated', 'portfolio', 'derivative-notional'), USDC6(400n)],
    ]);
    assert.deepEqual(checkBookInvariant(m, b), []);
  });

  it('DYNAMIC: nobody holds anything; the whole limit is the pool', () => {
    const m = sampleMandate({ allocationMode: 'DYNAMIC', agents: sampleMandate().agents.map((a) => ({ ...(a as object), preferred: [] })) as never });
    const b = initialBook(m);
    assert.equal(entryOf(b, agentOf(STOCK), N)?.allocated, 0n);
    assert.equal(b.lots.find((l) => l.resource === N)?.remaining, USDC6(2_000n));
    assert.equal(obtainable(m, b, agentOf(STOCK), N), USDC6(800n), 'bounded by the hard maximum, not the pool');
  });

  it('PREALLOCATED: allocations are fixed; nothing may be claimed', () => {
    const m = sampleMandate({ allocationMode: 'PREALLOCATED' });
    const b = initialBook(m);
    assert.equal(obtainable(m, b, agentOf(STOCK), N), USDC6(500n));
    assert.equal(refusal(m, b, claim(STOCK, 'c1', lotId('unallocated', 'portfolio', N), 1n)), 'CLAIM_NOT_PERMITTED_IN_MODE');
  });
});

describe('release, claim and commit', () => {
  const m = sampleMandate();

  it('released allocation becomes a lot that other agents claim up to its amount — exactly once', () => {
    let b = step(m, initialBook(m), release(SWAP, 'swap-release', USDC6(250n)));
    const lot = lotId('release', 'swap-release', N);
    assert.equal(b.lots.find((l) => l.id === lot)?.remaining, USDC6(250n));
    assert.equal(entryOf(b, agentOf(SWAP), N)?.allocated, 0n);
    b = step(m, b, claim(STOCK, 'stock-claim', lot, USDC6(100n)));
    b = step(m, b, claim(PERPS, 'perps-claim', lot, USDC6(100n)));
    // 250 released = 100 + 100 + 50 left; a claim of 51 exceeds what is left.
    assert.equal(refusal(m, b, claim(SWAP, 'swap-claim', lot, USDC6(51n))), 'LOT_EXHAUSTED');
    b = step(m, b, claim(SWAP, 'swap-claim', lot, USDC6(50n)));
    assert.equal(b.lots.find((l) => l.id === lot)?.remaining, 0n);
    assert.equal(refusal(m, b, claim(STOCK, 'late', lot, 1n)), 'LOT_EXHAUSTED');
    assert.equal(refusal(m, b, claim(STOCK, 'zero', lot, 0n)), 'LOT_EXHAUSTED');
    assert.deepEqual(checkBookInvariant(m, b), []);
  });

  it('double release, double claim and double commit are refused', () => {
    let b = step(m, initialBook(m), release(SWAP, 'r1', USDC6(100n)));
    assert.equal(refusal(m, b, release(SWAP, 'r1', USDC6(100n))), 'RELEASE_ALREADY_APPLIED');
    b = step(m, b, claim(STOCK, 'c1', lotId('release', 'r1', N), USDC6(10n)));
    assert.equal(refusal(m, b, claim(STOCK, 'c1', lotId('release', 'r1', N), USDC6(10n))), 'CLAIM_ALREADY_APPLIED');
    b = step(m, b, commit(STOCK, 'proposal-1', USDC6(10n)));
    assert.equal(refusal(m, b, commit(STOCK, 'proposal-1', USDC6(10n))), 'COMMIT_ALREADY_APPLIED');
  });

  it('release only what is unused; commit only what is allocated; claim only up to the hard maximum', () => {
    let b = step(m, initialBook(m), commit(SWAP, 'p', USDC6(200n)));
    assert.equal(refusal(m, b, release(SWAP, 'too-much', USDC6(51n))), 'RELEASE_EXCEEDS_UNUSED');
    assert.equal(refusal(m, b, commit(SWAP, 'p2', USDC6(51n))), 'COMMIT_EXCEEDS_ALLOCATION');
    // Stock holds 500 of a hard maximum of 800: a 301 claim would exceed it.
    assert.equal(refusal(m, b, claim(STOCK, 'c', lotId('unallocated', 'portfolio', N), USDC6(301n))), 'AGENT_LIMIT_EXCEEDED');
    b = step(m, b, claim(STOCK, 'c', lotId('unallocated', 'portfolio', N), USDC6(300n)));
    assert.equal(entryOf(b, agentOf(STOCK), N)?.allocated, USDC6(800n));
  });

  it('unknown agents, lots and resources are refused', () => {
    const b = initialBook(m);
    const stranger = { kind: 'eip155-address', value: `0x${'77'.repeat(20)}` };
    assert.equal(refusal(m, b, release(stranger, 'x', 1n)), 'AGENT_UNKNOWN');
    assert.equal(refusal(m, b, claim(STOCK, 'x', 'lot/none', 1n)), 'LOT_UNKNOWN');
    assert.equal(refusal(m, b, { kind: 'COMMIT', agent: agentOf(STOCK), id: 'x' as never, amounts: v(1n, 'unlisted') }), 'RESOURCE_UNDECLARED');
  });

  it('planClaims draws lots in creation order and never more than they hold', () => {
    let b = step(m, initialBook(m), release(SWAP, 'r', USDC6(250n)));
    const plan = planClaims(b, agentOf(STOCK), N, USDC6(800n), 'plan');
    assert.deepEqual(plan?.map((o) => (o.kind === 'CLAIM' ? [o.lot, o.amount] : null)), [
      [lotId('unallocated', 'portfolio', N), USDC6(750n)],
      [lotId('release', 'r', N), USDC6(50n)],
    ]);
    assert.equal(planClaims(b, agentOf(STOCK), N, USDC6(1_001n), 'plan'), null);
    b = step(m, b, claim(STOCK, 'c', lotId('unallocated', 'portfolio', N), USDC6(300n)));
    assert.deepEqual(checkBookInvariant(m, b), []);
  });
});

describe('the book under random operation sequences (seeded)', () => {
  it('every reachable book conserves each limit, keeps committed ≤ allocated ≤ cap, never over-claims a lot, and replays exactly', () => {
    const m = sampleMandate();
    const r = new Rng(11);
    const agents = [STOCK, SWAP, PERPS];
    const resources = [N, 'derivative-notional', 'spot-capital', 'perp-margin'];
    for (let run = 0; run < 200; run += 1) {
      let b = initialBook(m);
      for (let i = 0; i < 40; i += 1) {
        const agent = r.pick(agents);
        const resource = r.pick(resources);
        const amount = BigInt(r.int(400)) * 1_000_000n;
        const kind = r.int(3);
        const op: AllocationOp =
          kind === 0
            ? { kind: 'COMMIT', agent: agentOf(agent), id: `c${r.int(30)}` as never, amounts: v(amount, resource) }
            : kind === 1
              ? { kind: 'RELEASE', agent: agentOf(agent), id: `r${r.int(30)}` as never, amounts: v(amount, resource) }
              : { kind: 'CLAIM', agent: agentOf(agent), id: `k${r.int(30)}` as never, lot: (b.lots.length > 0 ? r.pick(b.lots).id : 'lot/none') as never, amount };
        const next = applyAllocation(m, b, op);
        if (next.ok) b = next.value;
        assert.deepEqual(checkBookInvariant(m, b), [], `run ${run} step ${i}`);
      }
      for (const lot of b.lots) {
        const claimed = b.log.reduce((s, op) => s + (op.kind === 'CLAIM' && op.lot === lot.id ? op.amount : 0n), 0n);
        assert.ok(claimed <= lot.amount, `run ${run}: lot ${lot.id} over-claimed`);
        assert.equal(lot.amount - claimed, lot.remaining);
      }
      const replayed = must(replayAllocation(m, b.log));
      assert.deepEqual(replayed, b);
    }
  });

  it('a replayed log refuses at the first operation the rules forbid, naming it', () => {
    const m = sampleMandate();
    const log: AllocationOp[] = [release(SWAP, 'r', USDC6(100n)), release(SWAP, 'r', USDC6(10n))];
    const r = replayAllocation(m, log);
    assert.deepEqual(r.ok ? null : r.error, { index: 1, reason: { code: 'RELEASE_ALREADY_APPLIED', subject: 'r' } });
  });
});
