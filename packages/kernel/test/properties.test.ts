/**
 * Property and adversarial tests.
 *
 * The aim is a small number of invariants that hold over many generated worlds,
 * not a large number of cases. Each property below is one sentence a reviewer
 * can check against the design, and each is the kind of statement a single
 * hand-written example cannot establish.
 *
 * Generation is seeded, so a failure is reproducible from the reported seed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHECKS,
  Decision,
  decodeMandate,
  encodeMandate,
  mandateDigest,
  parseMandate,
  verify,
  type VerificationReceipt,
} from '../src/index.ts';
import {
  AMD,
  EPOCH,
  ISSUER,
  NOW,
  OTHER_CHAIN,
  OTHER_VENUE,
  UNAPPROVED_ISSUER,
  mandateInput,
  representationInput,
} from './support/fixtures.ts';
import { buildWorld, type WorldOverrides } from './support/world.ts';

/** Deterministic PRNG, so a failing case is reproducible from its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const ITERATIONS = 120;

/** A spread of worlds: some valid, most with one or more things wrong. */
function randomWorld(next: () => number): WorldOverrides {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
  const o: Record<string, unknown> = {};
  const candidate: Record<string, unknown> = {};
  const state: Record<string, unknown> = {};

  if (next() < 0.3) candidate['venue'] = pick([OTHER_VENUE, 'venue.alpha']);
  if (next() < 0.3) candidate['side'] = pick(['BUY', 'SELL']);
  if (next() < 0.25) candidate['corporateActionEpoch'] = EPOCH + BigInt(Math.floor(next() * 3));
  if (next() < 0.25) {
    const shares = BigInt(1 + Math.floor(next() * 20)) * 100n;
    candidate['quantity'] = { unit: 'SHARE', decimals: 2, atoms: shares };
    candidate['notional'] = { unit: 'USD', decimals: 2, atoms: shares * 100n };
  }
  if (next() < 0.25) state['market'] = { provenance: { observedAtUnixSeconds: NOW - BigInt(Math.floor(next() * 200)) } };
  if (next() < 0.2) state['market'] = { value: { haltStatus: pick(['TRADING', 'HALTED']) } };
  if (next() < 0.15) o['now'] = NOW + BigInt(Math.floor(next() * 1400) - 700);

  if (Object.keys(candidate).length > 0) o['candidate'] = candidate;
  if (Object.keys(state).length > 0) o['state'] = state;
  return o as WorldOverrides;
}

function decide(o: WorldOverrides): VerificationReceipt {
  return verify(buildWorld(o));
}

function merge(base: WorldOverrides, patch: Record<string, unknown>): WorldOverrides {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    const existing = out[k];
    out[k] =
      v !== null && typeof v === 'object' && !Array.isArray(v) &&
      existing !== null && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>), ...(v as Record<string, unknown>) }
        : v;
  }
  return out as WorldOverrides;
}

/**
 * Worsening mutations: each strictly reduces how acceptable a candidate is, so
 * none of them may ever turn a REJECT into a PASS, and each must reject on its
 * own from any starting point.
 */
const WORSENINGS: readonly { readonly name: string; readonly expect: string; readonly apply: (w: WorldOverrides) => WorldOverrides }[] = [
  {
    name: 'notional raised far beyond the authorized maximum',
    expect: 'MAX_NOTIONAL_EXCEEDED',
    apply: (w) => merge(w, {
      candidate: { quantity: { unit: 'SHARE', decimals: 2, atoms: 500_000n }, notional: { unit: 'USD', decimals: 2, atoms: 50_000_000n } },
    }),
  },
  {
    name: 'price observation aged past the freshness bound',
    expect: 'PRICE_STATE_STALE',
    apply: (w) => merge(w, { state: { market: { provenance: { observedAtUnixSeconds: NOW - 100_000n } } }, now: NOW }),
  },
  {
    name: 'canonical asset changed',
    expect: 'CANONICAL_ASSET_MISMATCH',
    apply: (w) => merge(w, { candidate: { canonicalAsset: { ...AMD } } }),
  },
  {
    name: 'corporate-action epoch advanced past the authorization',
    expect: 'CORPORATE_ACTION_STATE_CHANGED',
    apply: (w) => merge(w, {
      state: { corporateAction: { value: { epoch: EPOCH + 1n } } },
      candidate: { corporateActionEpoch: EPOCH + 1n },
    }),
  },
  {
    name: 'approved issuer replaced with an unapproved one',
    expect: 'ISSUER_NOT_ALLOWED',
    apply: (w) => merge(w, {
      candidate: { issuer: UNAPPROVED_ISSUER },
      representations: [representationInput({ value: { issuer: UNAPPROVED_ISSUER } })],
    }),
  },
  {
    name: 'chain replaced with one outside the allowlist',
    expect: 'CHAIN_NOT_ALLOWED',
    apply: (w) => merge(w, {
      candidate: { chain: OTHER_CHAIN },
      representations: [representationInput({ value: { chain: OTHER_CHAIN } })],
    }),
  },
];

test('a worsening mutation never turns a rejection into a pass', () => {
  const next = rng(0xa11ce);
  let sawPass = 0;
  for (let i = 0; i < ITERATIONS; i += 1) {
    const base = randomWorld(next);
    const before = decide(base);
    if (before.decision === Decision.PASS) sawPass += 1;

    for (const w of WORSENINGS) {
      const after = decide(w.apply(base));
      assert.equal(after.decision, Decision.REJECT, `iteration ${i}: ${w.name} produced a PASS`);
      assert.ok(
        after.reasonCodes.includes(w.expect as never),
        `iteration ${i}: ${w.name} did not report ${w.expect}; got [${after.reasonCodes.join(', ')}]`,
      );
    }
  }
  // The generator must actually produce permitted worlds, or the property above
  // is vacuous.
  assert.ok(sawPass > 0, 'the generator produced no passing worlds; the property would be vacuous');
});

test('adding an independent violation preserves every existing one', () => {
  // The superset property, stated over a violation that touches a field the
  // generator never randomizes. A verifier that stopped at the first failure,
  // or that let one check mask another, fails this.
  const next = rng(0xbeef);
  let sawNonEmpty = 0;
  for (let i = 0; i < ITERATIONS; i += 1) {
    const base = randomWorld(next);
    // Pin the venue so the base can never produce a venue violation of its own.
    const pinned = merge(base, { candidate: { venue: 'venue.alpha' } });
    const before = new Set(decide(pinned).reasonCodes);
    if (before.size > 0) sawNonEmpty += 1;

    const after = new Set(decide(merge(pinned, { candidate: { venue: OTHER_VENUE } })).reasonCodes);
    assert.ok(after.has('VENUE_NOT_ALLOWED' as never), `iteration ${i}: the added violation was not reported`);
    for (const code of before) {
      assert.ok(after.has(code), `iteration ${i}: ${code} was masked by the added violation`);
    }
  }
  assert.ok(sawNonEmpty > 0, 'no base world had violations; the property would be vacuous');
});

test('making state older is monotone: eligibility is never restored by age', () => {
  const next = rng(0xc0ffee);
  for (let i = 0; i < 40; i += 1) {
    const base = randomWorld(next);
    let previouslyRejected = false;
    for (const age of [0n, 30n, 59n, 60n, 61n, 120n, 3600n]) {
      const receipt = decide(merge(base, {
        now: NOW,
        state: { market: { provenance: { observedAtUnixSeconds: NOW - age } } },
      }));
      const rejected = receipt.decision === Decision.REJECT;
      if (previouslyRejected) {
        assert.equal(rejected, true, `iteration ${i}: age ${age} restored eligibility`);
      }
      previouslyRejected = previouslyRejected || rejected;
    }
  }
});

test('increasing notional is monotone against the mandate maximum', () => {
  // Reference price is 100.00, so quantity n hundredths of a share costs n dollars.
  let previouslyRejected = false;
  for (const shares of [1n, 500n, 900n, 999n, 1_000n, 1_001n, 2_000n, 10_000n]) {
    const receipt = decide({
      candidate: {
        quantity: { unit: 'SHARE', decimals: 2, atoms: shares },
        notional: { unit: 'USD', decimals: 2, atoms: shares * 100n },
      },
    });
    const rejected = receipt.decision === Decision.REJECT;
    if (previouslyRejected) assert.equal(rejected, true, `notional for ${shares} became acceptable again`);
    previouslyRejected = previouslyRejected || rejected;
  }
  assert.equal(previouslyRejected, true, 'some notional must be refused, or the property is vacuous');
});

test('the canonical encoding is injective over generated mandates', () => {
  // Distinct semantic mandates must not share a digest, and one semantic
  // mandate must not have two encodings. Both directions, over generated input.
  const next = rng(0xd15ea5e);
  const digests = new Map<string, string>();
  for (let i = 0; i < 300; i += 1) {
    const overrides = {
      nonce: BigInt(Math.floor(next() * 1_000_000)),
      maxDeviationBps: BigInt(Math.floor(next() * 65_536)),
      requiredCorporateActionEpoch: BigInt(Math.floor(next() * 1000)),
      maxNotional: { unit: 'USD', decimals: 2, atoms: BigInt(Math.floor(next() * 10_000_000)) },
      allowedIssuers: next() < 0.5 ? [ISSUER] : [ISSUER, 'issuer.beta'],
      side: next() < 0.5 ? 'BUY' : 'SELL',
      syntheticPolicy: next() < 0.5 ? 'FORBIDDEN' : 'ALLOWED',
    };
    const parsed = parseMandate(mandateInput(overrides));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) continue;

    const bytes = encodeMandate(parsed.value);
    const digest = mandateDigest(parsed.value);
    const key = JSON.stringify(overrides, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

    const existing = digests.get(digest);
    if (existing !== undefined) {
      assert.equal(existing, key, `two distinct mandates share digest ${digest}`);
    }
    digests.set(digest, key);

    // Round-trip: one semantic value, one byte string.
    const decoded = decodeMandate(bytes);
    assert.equal(decoded.ok, true);
    if (decoded.ok) assert.deepEqual(encodeMandate(decoded.value), bytes);
  }
  assert.ok(digests.size > 200, 'the generator must produce many distinct mandates');
});

test('allowlist authoring order never affects any verdict', () => {
  const next = rng(0x5eed);
  const issuers = [ISSUER, 'issuer.beta', 'issuer.gamma', 'issuer.delta'];
  const baseline = decide({ mandate: { allowedIssuers: [...issuers] } });
  for (let i = 0; i < 30; i += 1) {
    const shuffled = [...issuers];
    for (let j = shuffled.length - 1; j > 0; j -= 1) {
      const k = Math.floor(next() * (j + 1));
      [shuffled[j], shuffled[k]] = [shuffled[k] as string, shuffled[j] as string];
    }
    const receipt = decide({ mandate: { allowedIssuers: shuffled } });
    assert.equal(receipt.decision, baseline.decision);
    assert.equal(receipt.mandateDigest, baseline.mandateDigest, 'digest must not depend on order');
    assert.equal(receipt.receiptDigest, baseline.receiptDigest);
  }
});

test('check order never affects a verdict, over generated worlds', () => {
  const next = rng(0x0111);
  for (let i = 0; i < 40; i += 1) {
    const world = buildWorld(randomWorld(next));
    const baseline = verify(world);
    const shuffled = [...CHECKS];
    for (let j = shuffled.length - 1; j > 0; j -= 1) {
      const k = Math.floor(next() * (j + 1));
      [shuffled[j], shuffled[k]] = [shuffled[k] as never, shuffled[j] as never];
    }
    const receipt = verify({ ...world, checks: shuffled });
    assert.equal(receipt.receiptDigest, baseline.receiptDigest, `iteration ${i}`);
  }
});

test('arbitrary structured junk never produces a pass and never throws', () => {
  const next = rng(0xfa11);
  const atoms: unknown[] = [
    null, undefined, 0, 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '', '0x', 'BUY',
    true, false, [], {}, 0n, -1n, 2n ** 300n, '00', '-0', '1e3', ' 1', '1 ',
  ];
  const grow = (depth: number): unknown => {
    if (depth <= 0) return atoms[Math.floor(next() * atoms.length)];
    const r = next();
    if (r < 0.35) return Array.from({ length: Math.floor(next() * 3) }, () => grow(depth - 1));
    if (r < 0.8) {
      const keys = ['version', 'unit', 'atoms', 'decimals', 'value', 'kind', 'status', 'provenance', 'epoch', 'side'];
      const out: Record<string, unknown> = {};
      for (let i = 0; i < 1 + Math.floor(next() * 4); i += 1) {
        out[keys[Math.floor(next() * keys.length)] as string] = grow(depth - 1);
      }
      return out;
    }
    return atoms[Math.floor(next() * atoms.length)];
  };

  for (let i = 0; i < 400; i += 1) {
    const receipt = verify({
      mandate: grow(3),
      authorization: grow(3),
      candidate: grow(3),
      trustedState: grow(3),
      clock: grow(2),
      expectedDomain: grow(2),
    });
    assert.equal(receipt.decision, Decision.REJECT, `iteration ${i} produced a PASS`);
    assert.ok(receipt.reasonCodes.length > 0);
    assert.match(receipt.receiptDigest, /^0x[0-9a-f]{64}$/);
  }
});

test('partially valid input still never passes', () => {
  // A well-formed mandate with junk elsewhere is the realistic hostile shape:
  // everything looks right except the part an attacker controls.
  const next = rng(0x9a9a);
  const valid = buildWorld();
  const slots = ['mandate', 'authorization', 'candidate', 'trustedState', 'clock', 'expectedDomain'] as const;
  const junk: unknown[] = [null, {}, [], 'x', 0, { version: 1 }, { version: 99 }];

  for (let i = 0; i < 200; i += 1) {
    const slot = slots[Math.floor(next() * slots.length)] as (typeof slots)[number];
    const receipt = verify({ ...valid, [slot]: junk[Math.floor(next() * junk.length)] });
    assert.equal(receipt.decision, Decision.REJECT, `corrupting ${slot} produced a PASS`);
  }
});
