/**
 * A structured description of a grant's terms that is easy to narrow and to
 * widen, for AUTH-2 property tests. The verdict a generated child must get
 * follows from how it was built — a narrowing, or a narrowing plus exactly one
 * widening — never from the code under test.
 */

import { authorityId, validateAuthorityGrant, type AuthorityGrant, type AuthorityTermInput, type ModuleRefInput, type ResourceIdInput } from '@mandate/core';
import type { DelegationViolationCode } from '../../src/errors.ts';
import { AGENT_A, P, PERP_V1, PERP_V1_OTHER_DIGEST, PERP_V2, SPOT_V1, T0, T_END, dim, int, must, pick } from './grants.ts';

export const MODS: readonly ModuleRefInput[] = [SPOT_V1, PERP_V1, PERP_V2, PERP_V1_OTHER_DIGEST];
export const MKTS: readonly ResourceIdInput[] = ['a', 'b', 'c', 'd'].map((l) => ({ domain: 'perp', kind: 'MARKET' as const, localId: `venue-l:${l}` }));
export const RIGHTS = ['OPEN_RISK', 'REDUCE_RISK', 'TRANSFER_OUT'] as const;
export type RightName = (typeof RIGHTS)[number];
export const SOURCES = ['src-1', 'src-2', 'src-3'];

export interface Spec {
  modules: ModuleRefInput[] | null;
  markets: ResourceIdInput[] | null;
  rights: RightName[];
  depth: number;
  maxNotional: bigint | null;
  maxLeverage: bigint | null; // numerator at scale 1: 35 = 3.5x
  minCredit: bigint | null;
  window: { nb: bigint; ea: bigint } | null;
  notBefore: bigint;
  expiresAt: bigint;
  capital: bigint | null;
  invariant: string | null;
  statePolicy: { sources: string[]; maxAge: bigint; trust: 'VERIFIED' | 'AUTHORITATIVE'; atIssue: 'WITHIN_POLICY' | 'RECHECK' } | null;
}

export function termsOf(s: Spec): AuthorityTermInput[] {
  const t: AuthorityTermInput[] = [];
  if (s.modules !== null) t.push({ kind: 'SET', vocabulary: 'MODULES', members: s.modules });
  if (s.markets !== null) t.push({ kind: 'SET', vocabulary: 'MARKETS', members: s.markets });
  for (const r of s.rights) t.push({ kind: 'RIGHT', right: r });
  if (s.depth > 0) t.push({ kind: 'RIGHT', right: 'DELEGATE', maxDepth: s.depth });
  if (s.maxNotional !== null) t.push({ kind: 'BOUND', boundId: 'order-notional', polarity: 'MAX', value: { type: 'QUANTITY', quantity: { kind: 'NOTIONAL', unit: 'USD', decimals: 2, atoms: s.maxNotional } } });
  if (s.maxLeverage !== null) t.push({ kind: 'BOUND', boundId: 'order-leverage', polarity: 'MAX', value: { type: 'RATIO', ratio: { numerator: s.maxLeverage, scale: 1 } } });
  if (s.minCredit !== null) t.push({ kind: 'BOUND', boundId: 'min-credit', polarity: 'MIN', value: { type: 'QUANTITY', quantity: { kind: 'CAPITAL', unit: 'USDG', decimals: 2, atoms: s.minCredit } } });
  if (s.window !== null) t.push({ kind: 'TIME_WINDOW', domain: 'perp', notBefore: s.window.nb, expiresAt: s.window.ea });
  if (s.capital !== null) t.push(dim('capital', s.capital));
  if (s.invariant !== null) t.push({ kind: 'STATE_INVARIANT', invariantId: 'perp-policy.accountLeverage', version: 1, scope: [], params: s.invariant });
  if (s.statePolicy !== null) {
    t.push({
      kind: 'STATE_POLICY',
      domain: 'perp',
      stateKind: 'perp.markPrice',
      admittedSources: s.statePolicy.sources,
      requirement: {
        freshness: { kind: 'AGE', maxAgeSeconds: s.statePolicy.maxAge },
        minTrust: s.statePolicy.trust,
        minFinality: { ladder: 'venue-l.market-data', level: 'PUBLISHED' },
        atIssue: s.statePolicy.atIssue,
        atExecution: { kind: 'NOT_REQUIRED' },
      },
    });
  }
  return t;
}

export function subsetOf<T>(rand: () => number, xs: readonly T[], min = 0): T[] {
  const out = xs.filter(() => rand() < 0.6);
  while (out.length < min && out.length < xs.length) {
    const x = pick(rand, xs);
    if (!out.includes(x)) out.push(x);
  }
  return out;
}

export function randomSpec(rand: () => number): Spec {
  const nb = T0 + BigInt(int(rand, 0, 100));
  return {
    modules: rand() < 0.9 ? subsetOf(rand, MODS, 1) : null,
    markets: rand() < 0.7 ? subsetOf(rand, MKTS, 1) : null,
    rights: subsetOf(rand, RIGHTS),
    depth: int(rand, 1, 4),
    maxNotional: rand() < 0.7 ? BigInt(int(rand, 1_000, 900_000)) : null,
    maxLeverage: rand() < 0.6 ? BigInt(int(rand, 10, 100)) : null,
    minCredit: rand() < 0.4 ? BigInt(int(rand, 10, 500)) : null,
    window: rand() < 0.5 ? { nb: nb + 10n, ea: nb + 10_000n } : null,
    notBefore: nb,
    expiresAt: T_END - BigInt(int(rand, 0, 1000)),
    capital: rand() < 0.8 ? BigInt(int(rand, 100, 1_000_000)) : null,
    invariant: rand() < 0.5 ? pick(rand, ['0x03', '0x04', '0x0500']) : null,
    statePolicy:
      rand() < 0.5 ? { sources: subsetOf(rand, SOURCES, 1), maxAge: BigInt(int(rand, 2, 30)), trust: pick(rand, ['VERIFIED', 'AUTHORITATIVE'] as const), atIssue: pick(rand, ['WITHIN_POLICY', 'RECHECK'] as const) } : null,
  };
}

export function lessOrEqual(rand: () => number, x: bigint, floor = 0n): bigint {
  return x <= floor ? x : x - BigInt(int(rand, 0, Number(x - floor > 1000n ? 1000n : x - floor)));
}

/** A child that is ⊆ parent by construction. */
export function narrow(rand: () => number, p: Spec): Spec {
  const nb = p.notBefore + BigInt(int(rand, 0, 5));
  return {
    modules: p.modules === null ? null : rand() < 0.1 ? null : subsetOf(rand, p.modules),
    markets: p.markets === null ? null : rand() < 0.2 ? null : subsetOf(rand, p.markets),
    rights: subsetOf(rand, p.rights),
    depth: p.depth - 1 > 0 ? int(rand, 0, p.depth - 1) : 0,
    maxNotional: p.maxNotional === null ? (rand() < 0.2 ? 5_000n : null) : lessOrEqual(rand, p.maxNotional, 1n),
    maxLeverage: p.maxLeverage === null ? null : lessOrEqual(rand, p.maxLeverage, 1n),
    minCredit: p.minCredit === null ? null : p.minCredit + BigInt(int(rand, 0, 50)),
    window: p.window === null ? (rand() < 0.2 ? { nb: nb + 20n, ea: nb + 500n } : null) : rand() < 0.3 ? null : { nb: p.window.nb + 1n, ea: p.window.ea - 1n },
    notBefore: nb,
    expiresAt: p.expiresAt - BigInt(int(rand, 0, 100)),
    capital: p.capital === null ? (rand() < 0.3 ? 777n : null) : rand() < 0.2 ? null : lessOrEqual(rand, p.capital),
    invariant: p.invariant,
    statePolicy:
      p.statePolicy === null
        ? null
        : {
            sources: subsetOf(rand, p.statePolicy.sources),
            maxAge: lessOrEqual(rand, p.statePolicy.maxAge, 0n),
            trust: p.statePolicy.trust === 'AUTHORITATIVE' ? 'AUTHORITATIVE' : pick(rand, ['VERIFIED', 'AUTHORITATIVE'] as const),
            atIssue: p.statePolicy.atIssue === 'RECHECK' ? 'RECHECK' : pick(rand, ['WITHIN_POLICY', 'RECHECK'] as const),
          },
  };
}

/** Exactly one widening, applicable to this parent and child, and the code it must produce. */
export function widen(rand: () => number, p: Spec, c: Spec): { spec: Spec; code: DelegationViolationCode } {
  const options: (() => { spec: Spec; code: DelegationViolationCode })[] = [];
  const outsideModule = MODS.find((m) => p.modules === null || !p.modules.includes(m));
  if (outsideModule !== undefined) options.push(() => ({ spec: { ...c, modules: [...(c.modules ?? []), outsideModule] }, code: 'DELEGATION_WIDENS_SET' }));
  const outsideMarket = MKTS.find((m) => p.markets === null || !p.markets.includes(m));
  if (outsideMarket !== undefined) options.push(() => ({ spec: { ...c, markets: [...(c.markets ?? []), outsideMarket] }, code: 'DELEGATION_WIDENS_SET' }));
  const outsideRight = RIGHTS.find((r) => !p.rights.includes(r));
  if (outsideRight !== undefined) options.push(() => ({ spec: { ...c, rights: [...c.rights, outsideRight] }, code: 'DELEGATION_WIDENS_RIGHT' }));
  options.push(() => ({ spec: { ...c, depth: p.depth }, code: 'DELEGATION_DEPTH_EXCEEDED' }));
  options.push(() => ({ spec: { ...c, expiresAt: p.expiresAt + 1n }, code: 'DELEGATION_WIDENS_WINDOW' }));
  options.push(() => ({ spec: { ...c, notBefore: p.notBefore - 1n }, code: 'DELEGATION_WIDENS_WINDOW' }));
  if (p.maxNotional !== null) {
    const pn = p.maxNotional;
    options.push(() => ({ spec: { ...c, maxNotional: pn + 1n }, code: 'DELEGATION_WIDENS_BOUND' }));
    options.push(() => ({ spec: { ...c, maxNotional: null }, code: 'DELEGATION_DROPS_BOUND' }));
  }
  if (p.maxLeverage !== null) {
    const pl = p.maxLeverage;
    options.push(() => ({ spec: { ...c, maxLeverage: pl + 1n }, code: 'DELEGATION_WIDENS_BOUND' }));
  }
  if (p.minCredit !== null && p.minCredit > 0n) {
    const pm = p.minCredit;
    options.push(() => ({ spec: { ...c, minCredit: pm - 1n }, code: 'DELEGATION_WIDENS_BOUND' }));
  }
  if (p.window !== null) {
    const pw = p.window;
    options.push(() => ({ spec: { ...c, window: { nb: pw.nb, ea: pw.ea + 1n } }, code: 'DELEGATION_WIDENS_WINDOW' }));
  }
  if (p.capital !== null) {
    const pc = p.capital;
    options.push(() => ({ spec: { ...c, capital: pc + 1n }, code: 'DELEGATION_WIDENS_LIMIT' }));
  }
  if (p.invariant !== null) {
    options.push(() => ({ spec: { ...c, invariant: null }, code: 'DELEGATION_DROPS_INVARIANT' }));
    options.push(() => ({ spec: { ...c, invariant: `${p.invariant}ff` }, code: 'DELEGATION_NARROWING_UNPROVEN' }));
  }
  if (p.statePolicy !== null && c.statePolicy !== null) {
    const ps = p.statePolicy;
    const cs = c.statePolicy;
    options.push(() => ({ spec: { ...c, statePolicy: null }, code: 'DELEGATION_DROPS_STATE_POLICY' }));
    options.push(() => ({ spec: { ...c, statePolicy: { ...cs, maxAge: ps.maxAge + 1n } }, code: 'DELEGATION_WEAKENS_STATE_POLICY' }));
    const extra = SOURCES.find((s) => !ps.sources.includes(s));
    if (extra !== undefined) options.push(() => ({ spec: { ...c, statePolicy: { ...cs, sources: [...cs.sources, extra] } }, code: 'DELEGATION_WEAKENS_STATE_POLICY' }));
    if (ps.trust === 'AUTHORITATIVE') options.push(() => ({ spec: { ...c, statePolicy: { ...cs, trust: 'VERIFIED' } }, code: 'DELEGATION_WEAKENS_STATE_POLICY' }));
  }
  return pick(rand, options)();
}

export function grantOf(s: Spec, parent: AuthorityGrant | null, holder = AGENT_A, nonce = 0n): AuthorityGrant {
  return must(
    validateAuthorityGrant({
      lineage: parent === null ? { kind: 'ROOT', issuer: P } : { kind: 'DELEGATION', parent: authorityId(parent), issuer: { kind: parent.holder.kind, value: parent.holder.value } },
      principal: P,
      holder,
      notBefore: s.notBefore,
      expiresAt: s.expiresAt,
      terms: termsOf(s),
      nonce,
    }),
  );
}

