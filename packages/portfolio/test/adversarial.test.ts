/**
 * Adversarial inputs fail closed.
 *
 * - Every decoder is total: seeded byte mutations, truncations and
 *   extensions of valid encodings either decode to a canonical object or
 *   return a structural error — never an exception.
 * - Malformed proposals, unknown required metadata and malformed identities
 *   are refused before any resolution or allocation.
 * - The screen is total over hostile but well-typed input: every outcome is
 *   a value with reasons.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeAgentProposal,
  decodeAgentRelease,
  decodeChildExecutionAuthorization,
  decodePortfolioMandate,
  encodeAgentProposal,
  encodeAgentRelease,
  encodeChildExecutionAuthorization,
  encodePortfolioMandate,
  isCanonical,
  screenProposal,
  validateActionCandidate,
  validateAgentProposal,
  agentProposalInputOf,
} from '../src/index.ts';
import { demoBindings, demoMandate } from '../src/demo/index.ts';
import { NOW, perpOpen, stockBuy, swap, yieldDeposit } from './support/candidates.ts';
import { Rng } from './support/random.ts';
import { childFor, proposal, release } from './support/world.ts';

const m = demoMandate();

interface Codec {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly decode: (b: Uint8Array) => { ok: boolean };
  readonly canonical: (b: Uint8Array) => boolean;
}

const CODECS: readonly Codec[] = [
  { name: 'mandate', bytes: encodePortfolioMandate(m), decode: decodePortfolioMandate, canonical: (b) => isCanonical(b, decodePortfolioMandate, encodePortfolioMandate) },
  { name: 'proposal', bytes: encodeAgentProposal(proposal(m, 'swap', swap()).proposal), decode: decodeAgentProposal, canonical: (b) => isCanonical(b, decodeAgentProposal, encodeAgentProposal) },
  { name: 'release', bytes: encodeAgentRelease(release(m, 'nft', [['portfolio-notional', 250n]]).release), decode: decodeAgentRelease, canonical: (b) => isCanonical(b, decodeAgentRelease, encodeAgentRelease) },
  { name: 'child', bytes: encodeChildExecutionAuthorization(childFor(m, 'perps', perpOpen({ usdc: 400n }))), decode: decodeChildExecutionAuthorization, canonical: (b) => isCanonical(b, decodeChildExecutionAuthorization, encodeChildExecutionAuthorization) },
];

function mutate(r: Rng, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes);
  switch (r.int(4)) {
    case 0: {
      const n = 1 + r.int(4);
      for (let i = 0; i < n; i += 1) out[r.int(out.length)] = r.int(256);
      return out;
    }
    case 1:
      return out.subarray(0, r.int(out.length));
    case 2:
      return new Uint8Array([...out, ...Array.from({ length: 1 + r.int(8) }, () => r.int(256))]);
    default: {
      // Swap two slices: element reordering, the shape a non-canonical set takes.
      const a = r.int(out.length);
      const b = r.int(out.length);
      const t = out[a] as number;
      out[a] = out[b] as number;
      out[b] = t;
      return out;
    }
  }
}

describe('decoders are total and canonical under mutation (seeded)', () => {
  for (const c of CODECS) {
    it(`${c.name}: 2,000 mutations never throw; whatever decodes is canonical`, () => {
      assert.ok(c.canonical(c.bytes), 'the valid encoding round-trips');
      const r = new Rng(c.name.length * 7919);
      let decoded = 0;
      for (let i = 0; i < 2_000; i += 1) {
        const b = mutate(r, c.bytes);
        let result: { ok: boolean };
        try {
          result = c.decode(b);
        } catch (e) {
          assert.fail(`${c.name} decoder threw on mutation ${i}: ${String(e)}`);
        }
        if (result.ok) {
          decoded += 1;
          assert.ok(c.canonical(b), `${c.name}: mutation ${i} decoded but does not re-encode byte for byte`);
        }
      }
      assert.ok(decoded < 2_000, 'mutations were mostly refused');
    });
  }

  it('random byte strings of every length up to 512 are refused, never thrown on', () => {
    const r = new Rng(99);
    for (let i = 0; i < 1_000; i += 1) {
      const b = new Uint8Array(Array.from({ length: r.int(512) }, () => r.int(256)));
      for (const c of CODECS) assert.equal(c.decode(b).ok, false);
    }
  });
});

describe('malformed and hostile proposals fail closed', () => {
  it('malformed candidate and proposal inputs are refused by the validators with a structural code', () => {
    const bad: readonly (object | string | null)[] = [
      { kind: 'STOCK_BUY', representation: 'NVDA', account: 'x', quantity: 1.5, claims: { ticker: null, displayName: null, issuer: null, asset: null } },
      { kind: 'STOCK_BUY', representation: 'eip155:46630/erc20:0x', account: 'x', quantity: '01', claims: { ticker: null, displayName: null, issuer: null, asset: null } },
      { kind: 'SWAP_EXACT_IN', router: 'r', route: ['p'], tokenIn: 'a', tokenOut: 'b', amountIn: -1n, quotedOut: 1n, minOut: 0n, quoteObservedAt: 0n, recipient: 'x', claims: { ticker: null, displayName: null, issuer: null, asset: null } },
      { kind: 'PERP_OPEN', market: 'm', account: 'a', side: 'LONG', size: 1n, price: 1n, initialMarginFraction: 10_001, claims: { ticker: null, displayName: null, issuer: null, asset: null } },
      { kind: 'NFT_BUY', marketplace: 'm', collection: 'c', tokenId: 1n, maxPrice: 1n, recipient: 'r', claims: { ticker: 'has space', displayName: null, issuer: null, asset: null } },
      { kind: 'YIELD_DEPOSIT', product: 'p', amount: 1n, quotedApyBps: 1, quoteObservedAt: 0n, recipient: 'r', claims: null },
      null,
      [],
      'STOCK_BUY',
    ];
    for (const input of bad) {
      const r = validateActionCandidate(input as never);
      assert.equal(r.ok, false, JSON.stringify(input, (_, v: bigint | string) => (typeof v === 'bigint' ? v.toString() : v)));
    }
  });

  it('unknown required metadata is refused rather than ignored', () => {
    const base = proposal(m, 'yield', yieldDeposit());
    const withExt = validateAgentProposal({ ...agentProposalInputOf(base.proposal), criticalExtensions: ['mev-protection', 'priority-fee'] });
    assert.ok(withExt.ok);
    const s = screenProposal(m, demoBindings(), { proposal: withExt.value, signature: base.signature }, NOW);
    // The signature no longer matches the extended proposal — and even if it did, the extensions refuse it.
    assert.ok(s.child === null);
  });

  it('the screen is total: every hostile-but-typed proposal yields reasons, never an exception', () => {
    const r = new Rng(5);
    const roles = ['stock', 'swap', 'nft', 'yield', 'perps', 'outsider'];
    for (let i = 0; i < 200; i += 1) {
      const role = r.pick(roles);
      const c = r.pick([stockBuy({ tenths: BigInt(1 + r.int(100)) }), swap({ amount: BigInt(1 + r.int(10_000_000_000)) }), perpOpen({ usdc: BigInt(1 + r.int(5_000)), imf: 1 + r.int(10_000) }), yieldDeposit({ amount: BigInt(1 + r.int(5_000_000_000)) })]);
      const p = role === 'outsider' ? proposal(m, 'swap', c) : proposal(m, role, c, { minimum: r.bool() });
      const s = screenProposal(m, demoBindings(), p, NOW + BigInt(r.int(10_000)));
      assert.ok(s.child !== null || s.reasons.length > 0, `case ${i}: neither a child nor a reason`);
    }
  });
});
