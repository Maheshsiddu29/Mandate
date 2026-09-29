/**
 * Property tests of the derivation laws (portfolio-mandate.md §7), over a
 * seeded PRNG — deterministic, thousands of cases:
 *
 * 1. childAuthority ≤ parentAuthority: a child drawn inside its parent always
 *    checks clean, and any single widening is always caught;
 * 2. subset soundness: whatever a valid child permits, its parent permits;
 * 3. monotonic tightening: adding any restriction never makes a previously
 *    refused action permitted — the refusals only grow;
 * 4. resource limits: a child limit passes iff it is declared and ≤ the
 *    parent's limit of the same resource.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RightKind } from '@mandate/registry';
import {
  ACTION_KINDS,
  checkChildLimits,
  checkChildScope,
  permits,
  validateAuthorityScope,
  validateResourceVector,
  type AuthorityScope,
  type AuthorityScopeInput,
  type ResolvedAction,
} from '../src/index.ts';
import { Rng } from './support/random.ts';
import { must } from './support/mandate.ts';

const POOL = {
  domains: ['d-a', 'd-b', 'd-c', 'd-d'],
  chains: ['c:1', 'c:2', 'c:3'],
  venues: ['v:1', 'v:2', 'v:3', 'v:4', 'v:5'],
  assets: [
    { assetClass: 'equity', idScheme: 'figi', value: 'A1' },
    { assetClass: 'equity', idScheme: 'figi', value: 'A2' },
    { assetClass: 'crypto', idScheme: 'fixture', value: 'A3' },
  ],
  representations: ['r:1', 'r:2', 'r:3', 'r:4', 'r:5'],
  issuers: ['i:1', 'i:2', 'i:3'],
  recipients: ['x:1', 'x:2', 'x:3'],
  rights: Object.values(RightKind),
} as const;
const NOW = 1_800_000_000n;
const CASES = 3_000;

type Bound = { numerator: bigint; scale: number } | null;

function input(s: AuthorityScope): AuthorityScopeInput {
  return {
    domains: [...s.domains],
    actions: [...s.actions],
    chains: [...s.chains],
    venues: [...s.venues],
    assets: s.assets.map((a) => ({ ...a })),
    representations: [...s.representations],
    issuers: [...s.issuers],
    recipients: [...s.recipients],
    syntheticPolicy: s.syntheticPolicy,
    requiredRights: [...s.requiredRights],
    maxLeverage: s.maxLeverage === null ? null : { numerator: s.maxLeverage.numerator, scale: s.maxLeverage.scale },
    maxSlippageBps: s.maxSlippageBps,
    maxQuoteAgeSeconds: s.maxQuoteAgeSeconds,
  };
}

const make = (i: AuthorityScopeInput) => must(validateAuthorityScope(i, 's'));

function randomScope(r: Rng): AuthorityScope {
  return make({
    domains: r.subset(POOL.domains, 0.6),
    actions: r.subset(ACTION_KINDS, 0.6),
    chains: r.subset(POOL.chains, 0.6),
    venues: r.subset(POOL.venues, 0.6),
    assets: r.subset(POOL.assets, 0.6),
    representations: r.subset(POOL.representations, 0.6),
    issuers: r.subset(POOL.issuers, 0.6),
    recipients: r.subset(POOL.recipients, 0.6),
    syntheticPolicy: r.bool() ? 'FORBIDDEN' : 'ALLOWED',
    requiredRights: r.subset(POOL.rights, 0.2),
    maxLeverage: r.bool(0.7) ? { numerator: BigInt(1 + r.int(50)), scale: r.int(2) } : null,
    maxSlippageBps: r.bool(0.7) ? r.int(300) : null,
    maxQuoteAgeSeconds: r.bool(0.7) ? BigInt(r.int(300)) : null,
  });
}

function lowerRatio(r: Rng, b: Bound): Bound {
  if (b === null) return null;
  return { numerator: BigInt(r.int(Number(b.numerator) + 1)), scale: b.scale };
}

/** A scope drawn inside `p`: subsets, one-way synthetic, more rights, bounds no higher. */
function inside(r: Rng, p: AuthorityScope): AuthorityScope {
  const i = input(p);
  return make({
    domains: r.subset(i.domains),
    actions: r.subset(i.actions),
    chains: r.subset(i.chains),
    venues: r.subset(i.venues),
    assets: r.subset(i.assets),
    representations: r.subset(i.representations),
    issuers: r.subset(i.issuers),
    recipients: r.subset(i.recipients),
    syntheticPolicy: p.syntheticPolicy === 'FORBIDDEN' || r.bool() ? 'FORBIDDEN' : 'ALLOWED',
    requiredRights: [...new Set([...i.requiredRights, ...r.subset(POOL.rights, 0.2)])],
    maxLeverage: r.bool(0.3) ? null : lowerRatio(r, p.maxLeverage),
    maxSlippageBps: i.maxSlippageBps === null || r.bool(0.3) ? null : r.int(i.maxSlippageBps + 1),
    maxQuoteAgeSeconds: i.maxQuoteAgeSeconds === null || r.bool(0.3) ? null : BigInt(r.int(Number(i.maxQuoteAgeSeconds) + 1)),
  });
}

type Change = (r: Rng, s: AuthorityScopeInput) => AuthorityScopeInput | null;

const SET_NAMES = ['domains', 'actions', 'chains', 'venues', 'assets', 'representations', 'issuers', 'recipients'] as const;
const poolFor = (set: (typeof SET_NAMES)[number]): readonly (string | { assetClass: string; idScheme: string; value: string })[] => (set === 'actions' ? ACTION_KINDS : POOL[set]);

/** One restriction of `s`, or `null` if the chosen kind cannot tighten it. */
const TIGHTEN: readonly Change[] = [
  (r, s) => {
    const set = r.pick(SET_NAMES);
    const members = s[set] as readonly unknown[];
    if (members.length === 0) return null;
    const drop = r.int(members.length);
    return { ...s, [set]: members.filter((_, k) => k !== drop) };
  },
  (_r, s) => (s.syntheticPolicy === 'ALLOWED' ? { ...s, syntheticPolicy: 'FORBIDDEN' } : null),
  (r, s) => {
    const extra = r.pick(POOL.rights);
    return s.requiredRights.includes(extra) ? null : { ...s, requiredRights: [...s.requiredRights, extra] };
  },
  (r, s) => (s.maxLeverage === null ? null : { ...s, maxLeverage: r.bool() ? null : lowerRatio(r, s.maxLeverage as Bound) }),
  (r, s) => (s.maxSlippageBps === null ? null : { ...s, maxSlippageBps: r.bool() ? null : r.int(s.maxSlippageBps + 1) }),
  (r, s) => (s.maxQuoteAgeSeconds === null ? null : { ...s, maxQuoteAgeSeconds: r.bool() ? null : BigInt(r.int(Number(s.maxQuoteAgeSeconds) + 1)) }),
];

/** One widening of `s`, or `null` if the chosen kind cannot widen it. */
const WIDEN: readonly Change[] = [
  (r, s) => {
    const set = r.pick(SET_NAMES);
    const have = new Set((s[set] as readonly unknown[]).map((m) => JSON.stringify(m)));
    const missing = poolFor(set).filter((m) => !have.has(JSON.stringify(m)));
    if (missing.length === 0) return null;
    return { ...s, [set]: [...(s[set] as readonly unknown[]), r.pick(missing)] };
  },
  (_r, s) => (s.syntheticPolicy === 'FORBIDDEN' ? { ...s, syntheticPolicy: 'ALLOWED' } : null),
  (r, s) => {
    if (s.requiredRights.length === 0) return null;
    const drop = r.int(s.requiredRights.length);
    return { ...s, requiredRights: s.requiredRights.filter((_, k) => k !== drop) };
  },
  (r, s) => ({ ...s, maxLeverage: s.maxLeverage === null ? { numerator: BigInt(1 + r.int(9)), scale: 0 } : { numerator: BigInt(s.maxLeverage.numerator) * 10n + 1n, scale: s.maxLeverage.scale + 1 } }),
  (r, s) => (s.maxSlippageBps === null ? { ...s, maxSlippageBps: r.int(100) } : s.maxSlippageBps < 10_000 ? { ...s, maxSlippageBps: s.maxSlippageBps + 1 } : null),
  (r, s) => ({ ...s, maxQuoteAgeSeconds: s.maxQuoteAgeSeconds === null ? BigInt(r.int(100)) : BigInt(s.maxQuoteAgeSeconds) + 1n }),
];

function apply(r: Rng, s: AuthorityScope, changes: readonly Change[]): AuthorityScope {
  for (;;) {
    const next = r.pick(changes)(r, input(s));
    if (next !== null) return make(next);
  }
}

/** An action drawn mostly from inside `s`, so permission is common and the soundness property is exercised. */
function actionWithin(r: Rng, s: AuthorityScope): ResolvedAction {
  const a = randomAction(r);
  const from = <T,>(xs: readonly T[], fallback: T): T => (xs.length > 0 && r.bool(0.95) ? r.pick(xs) : fallback);
  return {
    ...a,
    kind: from(s.actions, a.kind),
    domain: from(s.domains, a.domain),
    chain: from(s.chains, a.chain),
    venue: from(s.venues, a.venue),
    route: r.bool(0.8) ? r.subset(s.venues, 0.3) : a.route,
    asset: from(s.assets, a.asset),
    representation: from(s.representations, a.representation),
    issuer: s.issuers.length > 0 && r.bool(0.9) ? r.pick(s.issuers) : null,
    recipient: from(s.recipients, a.recipient),
    synthetic: s.syntheticPolicy === 'ALLOWED' && r.bool(0.3),
    rights: [...new Set([...s.requiredRights, ...r.subset(POOL.rights, 0.3)])],
    leverage: s.maxLeverage !== null && r.bool(0.5) ? ({ numerator: BigInt(r.int(Number(s.maxLeverage.numerator) + 1)), scale: s.maxLeverage.scale } as never) : null,
    slippageBps: s.maxSlippageBps !== null && r.bool(0.5) ? r.int(s.maxSlippageBps + 1) : null,
    quoteObservedAt: s.maxQuoteAgeSeconds !== null && r.bool(0.5) ? NOW - BigInt(r.int(Number(s.maxQuoteAgeSeconds) + 1)) : null,
  };
}

function randomAction(r: Rng): ResolvedAction {
  const kind = r.pick(ACTION_KINDS);
  return {
    kind,
    domain: r.pick(POOL.domains) as never,
    chain: r.pick(POOL.chains) as never,
    venue: r.pick(POOL.venues) as never,
    route: r.bool(0.3) ? (r.subset(POOL.venues, 0.3) as never[]) : [],
    asset: r.pick(POOL.assets) as never,
    representation: r.pick(POOL.representations) as never,
    issuer: r.bool(0.8) ? (r.pick(POOL.issuers) as never) : null,
    recipient: r.pick(POOL.recipients) as never,
    synthetic: r.bool(0.2),
    rights: r.subset(POOL.rights, 0.7),
    leverage: r.bool(0.4) ? ({ numerator: BigInt(1 + r.int(60)), scale: r.int(2) } as never) : null,
    slippageBps: r.bool(0.4) ? r.int(400) : null,
    quoteObservedAt: r.bool(0.4) ? NOW - BigInt(r.int(400)) : null,
    demand: [],
  };
}

/** A refusal's identity: a quote refusal is one refusal whether the bound is absent (`QUOTE_NOT_ALLOWED`) or exceeded (`QUOTE_STALE`). */
const keyed = (rs: readonly { code: string; subject: string }[]) => new Set(rs.map((x) => `${x.code === 'QUOTE_NOT_ALLOWED' ? 'QUOTE_STALE' : x.code} ${x.subject}`));

describe('derivation laws (seeded, deterministic)', () => {
  it('childAuthority ≤ parentAuthority: a child drawn inside its parent always checks clean', () => {
    const r = new Rng(1);
    for (let i = 0; i < CASES; i += 1) {
      const p = randomScope(r);
      assert.deepEqual(checkChildScope(p, inside(r, p)), [], `case ${i}`);
    }
  });

  it('any single widening of a scope is always caught', () => {
    const r = new Rng(2);
    for (let i = 0; i < CASES; i += 1) {
      const p = randomScope(r);
      const w = apply(r, p, WIDEN);
      assert.notDeepEqual(checkChildScope(p, w), [], `case ${i}`);
    }
  });

  it('subset soundness: whatever a valid child permits, its parent permits', () => {
    const r = new Rng(3);
    let permittedByChild = 0;
    for (let i = 0; i < CASES; i += 1) {
      const p = randomScope(r);
      const c = inside(r, p);
      for (let k = 0; k < 20; k += 1) {
        const a = r.bool(0.8) ? actionWithin(r, c) : randomAction(r);
        if (permits(c, a, NOW).length === 0) {
          permittedByChild += 1;
          assert.deepEqual(permits(p, a, NOW), [], `case ${i}.${k}`);
        }
      }
    }
    // The property must not be vacuous.
    assert.ok(permittedByChild > CASES, `only ${permittedByChild} permitted actions exercised`);
  });

  it('monotonic tightening: a restriction never turns a refusal into a permission — the refusals only grow', () => {
    const r = new Rng(4);
    for (let i = 0; i < CASES; i += 1) {
      const s = randomScope(r);
      const t = apply(r, s, TIGHTEN);
      assert.deepEqual(checkChildScope(s, t), [], `case ${i}: a tightening is a valid child`);
      for (let k = 0; k < 10; k += 1) {
        const a = r.bool(0.7) ? actionWithin(r, s) : randomAction(r);
        const refusedBefore = permits(s, a, NOW).length > 0;
        if (refusedBefore) assert.ok(permits(t, a, NOW).length > 0, `case ${i}.${k}: a refusal became a permission`);
        const before = keyed(permits(s, a, NOW));
        const after = keyed(permits(t, a, NOW));
        for (const x of before) assert.ok(after.has(x), `case ${i}.${k}: ${x} vanished after tightening`);
      }
    }
  });

  it('resource limits: a child limit passes iff declared and ≤ the parent’s limit of the same resource', () => {
    const r = new Rng(5);
    const ids = ['a', 'b', 'c', 'd'];
    for (let i = 0; i < CASES; i += 1) {
      const declared = new Set(r.subset(ids, 0.8));
      const parent = must(validateResourceVector(r.subset([...declared]).map((id) => ({ resource: id, atoms: BigInt(r.int(1_000)) })), 'p'));
      const child = must(validateResourceVector(r.subset(ids).map((id) => ({ resource: id, atoms: BigInt(r.int(1_200)) })), 'c'));
      const ok = child.every((c) => declared.has(c.resource) && c.atoms <= (parent.find((p) => p.resource === c.resource)?.atoms ?? 0n));
      assert.equal(checkChildLimits(parent, child, declared).length === 0, ok, `case ${i}`);
    }
  });
});
