/**
 * Principal `maxNotional` against the candidate's chosen notional precision
 * (Phase 6R.1, M-1).
 *
 * A candidate declares its notional at a precision it chooses, and the
 * consistency check accepts either adjacent value at that precision. Before
 * 6R.1 `maxNotional` compared only that declared value, so a coarse precision
 * let the true gross `quantity * executionPrice` exceed the principal's bound by
 * almost one whole unit. Every case here is the valid world with the economics
 * replaced; the oracle is independent integer cross-multiplication.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Decision, verify, type ReasonCodeName } from '../src/index.ts';
import { buildWorld, type WorldOverrides } from './support/world.ts';

type Json = Record<string, unknown>;

const pow10 = (n: number): bigint => 10n ** BigInt(n);

interface Economics {
  readonly side?: 'BUY' | 'SELL';
  readonly quantity: { readonly decimals: number; readonly atoms: bigint };
  readonly price: { readonly decimals: number; readonly atoms: bigint };
  readonly notional: { readonly decimals: number; readonly atoms: bigint };
  readonly max: { readonly decimals: number; readonly atoms: bigint };
  readonly fee?: bigint;
}

/** The world with its economics replaced. The reference price follows the execution price, so deviation stays zero. */
function world(e: Economics): WorldOverrides {
  const side = e.side ?? 'BUY';
  const price = { numeratorUnit: 'USD', denominatorUnit: 'SHARE', ...e.price };
  return {
    mandate: {
      side,
      maxNotional: { unit: 'USD', ...e.max },
      // BUY: a debit bound nothing here reaches. SELL: no credit floor. Only maxNotional is under test.
      economicLimit: side === 'BUY' ? { unit: 'USD', decimals: 0, atoms: 10n ** 60n } : { unit: 'USD', decimals: 0, atoms: 0n },
    },
    candidate: {
      side,
      quantity: { unit: 'SHARE', ...e.quantity },
      executionPrice: price,
      notional: { unit: 'USD', ...e.notional },
      feeTotal: { unit: 'USD', decimals: 0, atoms: e.fee ?? 0n },
    },
    state: { market: { value: { referencePrice: price } } as Json },
  };
}

function codes(e: Economics): readonly ReasonCodeName[] {
  return verify(buildWorld(world(e))).reasonCodes;
}

/** Exact `q * p` at `decimals`, rounded down and up. */
function product(e: Pick<Economics, 'quantity' | 'price'>, decimals: number): { floor: bigint; ceil: bigint } {
  const num = e.quantity.atoms * e.price.atoms * pow10(decimals);
  const den = pow10(e.quantity.decimals + e.price.decimals);
  const floor = num / den;
  return { floor, ceil: num % den === 0n ? floor : floor + 1n };
}

/** Independent oracle: the true gross exceeds the signed bound. */
function trulyExceeds(e: Economics): boolean {
  return e.quantity.atoms * e.price.atoms * pow10(e.max.decimals) > e.max.atoms * pow10(e.quantity.decimals + e.price.decimals);
}

function declaredExceeds(e: Economics): boolean {
  return e.notional.atoms * pow10(e.max.decimals) > e.max.atoms * pow10(e.notional.decimals);
}

// 100.00 USD per share.
const PRICE = { decimals: 2, atoms: 10_000n };

test('audit PoC: BUY of true gross 1.99 USD under a 1 USD maxNotional, declared at 0 decimals as 1, rejects', () => {
  const e: Economics = {
    quantity: { decimals: 4, atoms: 199n }, // 0.0199 shares
    price: PRICE,
    notional: { decimals: 0, atoms: 1n }, // floor(1.99)
    max: { decimals: 2, atoms: 100n },
  };
  assert.equal(declaredExceeds(e), false, 'the declared notional alone passes, which was the bypass');
  assert.ok(codes(e).includes('MAX_NOTIONAL_EXCEEDED'));
  // Non-vacuity: the same candidate under an honest 2 USD bound passes.
  assert.equal(verify(buildWorld(world({ ...e, max: { decimals: 2, atoms: 199n } }))).decision, Decision.PASS);
});

test('audit PoC: SELL of true gross 100.99 USD under a 100 USD maxNotional, declared at 0 decimals as 100, rejects', () => {
  const e: Economics = {
    side: 'SELL',
    quantity: { decimals: 4, atoms: 10_099n }, // 1.0099 shares
    price: PRICE,
    notional: { decimals: 0, atoms: 100n },
    max: { decimals: 0, atoms: 100n },
  };
  assert.equal(declaredExceeds(e), false);
  assert.ok(codes(e).includes('MAX_NOTIONAL_EXCEEDED'));
  assert.equal(verify(buildWorld(world({ ...e, max: { decimals: 2, atoms: 10_099n } }))).decision, Decision.PASS);
});

test('audit PoC: a positive BUY under maxNotional = 0 rejects, whatever it declares', () => {
  for (const decimals of [0, 1, 2, 6, 18, 38]) {
    const e: Economics = {
      quantity: { decimals: 3, atoms: 4n }, // 0.004 shares = 0.40 USD
      price: PRICE,
      notional: { decimals: 0, atoms: 0n },
      max: { decimals, atoms: 0n },
    };
    assert.ok(codes(e).includes('MAX_NOTIONAL_EXCEEDED'), `max = 0 at ${decimals} decimals`);
  }
});

test('declared precision 0 through 38 cannot move the verdict: true gross one atom above, at, and below the bound', () => {
  // 1.2345 shares at 100.00 = 123.45 USD, bound at 2 decimals.
  const base = { quantity: { decimals: 4, atoms: 12_345n }, price: PRICE };
  for (const [maxAtoms, exceeds] of [[12_344n, true], [12_345n, false], [12_346n, false]] as const) {
    for (let d = 0; d <= 38; d += 1) {
      const { floor, ceil } = product(base, d);
      for (const declared of floor === ceil ? [floor] : [floor, ceil]) {
        const e: Economics = { ...base, notional: { decimals: d, atoms: declared }, max: { decimals: 2, atoms: maxAtoms } };
        const rejected = codes(e).includes('MAX_NOTIONAL_EXCEEDED');
        assert.equal(rejected, exceeds || declaredExceeds(e), `max=${maxAtoms} declared=${declared}@${d}`);
        if (exceeds) assert.ok(rejected, `true gross above the bound must reject at declared precision ${d}`);
      }
    }
  }
});

test('the bound is exact at every principal precision', () => {
  // 0.0000001 shares at 100.00 = 0.00001 USD: needs 5 decimals to be exact.
  const base = { quantity: { decimals: 7, atoms: 1n }, price: PRICE, notional: { decimals: 0, atoms: 0n } };
  for (let md = 0; md <= 38; md += 1) {
    const exact = product(base, md);
    const atBound: Economics = { ...base, max: { decimals: md, atoms: exact.ceil } };
    assert.equal(codes(atBound).includes('MAX_NOTIONAL_EXCEEDED'), false, `ceil at ${md} decimals admits`);
    if (exact.ceil > 0n) {
      const below: Economics = { ...base, max: { decimals: md, atoms: exact.ceil - 1n } };
      assert.equal(codes(below).includes('MAX_NOTIONAL_EXCEEDED'), true, `one atom under the product rejects at ${md}`);
    }
  }
});

test('extreme magnitudes: huge quantity at a tiny price and tiny quantity at a huge price', () => {
  // Both products are 1 + 10^-30 USD. Declared at 0 decimals each is exactly 1,
  // the coarse-precision shape: only the exact product sees the 10^-30 excess.
  const hugeQ = { quantity: { decimals: 0, atoms: 10n ** 30n + 1n }, price: { decimals: 30, atoms: 1n } };
  const hugeP = { quantity: { decimals: 30, atoms: 1n }, price: { decimals: 0, atoms: 10n ** 30n + 1n } };
  for (const base of [hugeQ, hugeP]) {
    const coarse = { ...base, notional: { decimals: 0, atoms: 1n } };
    for (const md of [0, 2, 18, 29, 30]) {
      const oneUsd: Economics = { ...coarse, max: { decimals: md, atoms: pow10(md) } };
      assert.equal(declaredExceeds(oneUsd), false);
      assert.ok(codes(oneUsd).includes('MAX_NOTIONAL_EXCEEDED'), `1 USD bound at ${md} decimals`);
    }
    const exact = product(base, 38);
    assert.equal(exact.ceil, 10n ** 38n + 10n ** 8n);
    assert.equal(codes({ ...coarse, max: { decimals: 38, atoms: exact.ceil } }).includes('MAX_NOTIONAL_EXCEEDED'), false);
    assert.ok(codes({ ...coarse, max: { decimals: 38, atoms: exact.ceil - 1n } }).includes('MAX_NOTIONAL_EXCEEDED'));
  }
  // A product that cannot be rendered in uint256 at the principal's precision
  // is a bound violation, not an arithmetic error that skips the bound.
  const beyond: Economics = {
    quantity: { decimals: 0, atoms: 2n ** 200n },
    price: { decimals: 0, atoms: 2n ** 55n },
    notional: { decimals: 0, atoms: 2n ** 255n },
    max: { decimals: 38, atoms: 2n ** 256n - 1n },
  };
  assert.ok(codes(beyond).includes('MAX_NOTIONAL_EXCEEDED'));
});

/** Deterministic xorshift64*, so the randomized sweep is reproducible and needs no environment. */
function rng(seed: bigint): () => bigint {
  let s = seed;
  return () => {
    s ^= s >> 12n;
    s ^= (s << 25n) & 0xffff_ffff_ffff_ffffn;
    s ^= s >> 27n;
    return (s * 0x2545f4914f6cdd1dn) & 0xffff_ffff_ffff_ffffn;
  };
}

test('randomized precision combinations agree with the exact oracle on both sides', () => {
  const next = rng(0x6d61_6e64_6174_6531n);
  const pick = (n: number): number => Number(next() % BigInt(n));
  let bypassShapes = 0;
  for (let i = 0; i < 1_500; i += 1) {
    const qd = pick(19);
    const pd = pick(19);
    const quantity = { decimals: qd, atoms: 1n + (next() % pow10(qd + 3)) };
    const price = { decimals: pd, atoms: 1n + (next() % pow10(pd + 4)) };
    const nd = pick(39);
    const md = pick(39);
    const declared = product({ quantity, price }, nd);
    const exact = product({ quantity, price }, md);
    const jitter = [exact.floor, exact.ceil, exact.ceil + 1n, exact.floor > 0n ? exact.floor - 1n : 0n][pick(4)] as bigint;
    const e: Economics = {
      side: pick(2) === 0 ? 'BUY' : 'SELL',
      quantity,
      price,
      notional: { decimals: nd, atoms: pick(2) === 0 ? declared.floor : declared.ceil },
      max: { decimals: md, atoms: jitter },
    };
    if (trulyExceeds(e) && !declaredExceeds(e)) bypassShapes += 1;
    const rejected = codes(e).includes('MAX_NOTIONAL_EXCEEDED');
    assert.equal(rejected, trulyExceeds(e) || declaredExceeds(e), JSON.stringify(e, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
  }
  // The sweep must actually contain the M-1 shape, or it proves nothing about it.
  assert.ok(bypassShapes >= 50, `only ${bypassShapes} coarse-precision bypass shapes generated`);
});
