/**
 * AUTH-2: delegation cannot widen parent authority — refused at
 * registration, and never effective even if registered.
 *
 * Both halves are tested separately, as security-invariants.md asks:
 *
 * - **Registration half.** Random parents; children built by construction to
 *   be narrowings (must be accepted) or narrowings with exactly one widening
 *   mutation (must be refused with that mutation's code). The expected verdict
 *   comes from how the child was built, never from the code under test.
 * - **Meet half.** Random lineages in which widening nodes are injected
 *   straight into the ledger state, bypassing registration. The effective
 *   authority of every node is then checked, by an independent oracle written
 *   in this file, to be no wider than each ancestor's grant — and the oracle is
 *   shown to reject the injected nodes' own terms, so the property is not
 *   vacuous: without the meet it would fail.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorityId,
  compareRatios,
  principalPolicyId,
  termKey,
  validateAuthorityGrant,
  type AuthorityGrant,
  type AuthorityTermInput,
  type LedgerVersion,
  type ModuleRefInput,
  type PerActionBoundTerm,
  type ResourceIdInput,
  type SetConstraintTerm,
} from '@mandate/core';
import {
  checkDelegationSubset,
  effectiveAuthority,
  emptyLedgerState,
  resolveLineage,
  type DelegationViolationCode,
  type EffectiveAuthority,
  type LedgerState,
} from '../src/index.ts';
import { AGENT_A, P, PERP_V1, PRINCIPAL, SPOT_V1, T0, T_END, address, dim, int, must, policy, prng } from './support/grants.ts';
import { MKTS, grantOf, narrow, randomSpec, termsOf, widen, type Spec } from './support/specs.ts';

// --- Unit rules ---------------------------------------------------------------------

describe('AUTH-2 subset rules, one kind at a time', () => {
  const base: Spec = {
    modules: [PERP_V1, SPOT_V1],
    markets: [MKTS[0] as ResourceIdInput, MKTS[1] as ResourceIdInput],
    rights: ['OPEN_RISK', 'REDUCE_RISK'],
    depth: 2,
    maxNotional: 100_000n,
    maxLeverage: 50n,
    minCredit: 100n,
    window: { nb: T0 + 10n, ea: T0 + 5_000n },
    notBefore: T0,
    expiresAt: T_END,
    capital: 10_000n,
    invariant: '0x04',
    statePolicy: { sources: ['src-1', 'src-2'], maxAge: 10n, trust: 'AUTHORITATIVE', atIssue: 'RECHECK' },
  };
  const parent = grantOf(base, null);
  const check = (c: Spec): readonly string[] => checkDelegationSubset(parent, grantOf(c, parent), base.depth).map((v) => v.code);

  it('accepts exact restatement and every narrowing, and an added restriction', () => {
    assert.deepEqual(check({ ...base, depth: 1 }), []);
    assert.deepEqual(check({ ...base, depth: 0, modules: [PERP_V1], markets: null, rights: [], maxNotional: 1n, maxLeverage: 10n, minCredit: 1_000n, capital: 0n, window: null }), []);
    // A dimension the parent does not grant is an added constraint at the child's own node.
    const added = grantOf({ ...base, depth: 1 }, parent);
    const withExtra = must(validateAuthorityGrant({ ...grantInput(added), terms: [...termsOf({ ...base, depth: 1 }), dim('fees', 5n)] }));
    assert.deepEqual(checkDelegationSubset(parent, withExtra, 2), []);
  });

  it('uses the bound\'s own ordering: MAX may only fall, MIN may only rise, compared exactly across scales', () => {
    assert.deepEqual(check({ ...base, depth: 1, maxNotional: 100_001n }), ['DELEGATION_WIDENS_BOUND']);
    assert.deepEqual(check({ ...base, depth: 1, minCredit: 99n }), ['DELEGATION_WIDENS_BOUND']);
    assert.deepEqual(check({ ...base, depth: 1, maxLeverage: 51n }), ['DELEGATION_WIDENS_BOUND']);
    // A bound the child omits reads as "no such limit": refused, although the meet would still apply it.
    assert.deepEqual(check({ ...base, depth: 1, maxNotional: null }), ['DELEGATION_DROPS_BOUND']);
    // 5.0x at scale 1 restated as 5x at scale 0 is equal, not wider.
    const p5 = grantOf({ ...base, maxLeverage: 50n }, null, AGENT_A, 9n);
    const c5 = must(
      validateAuthorityGrant({
        ...grantInput(grantOf({ ...base, depth: 1, maxLeverage: null }, p5)),
        terms: [...termsOf({ ...base, depth: 1, maxLeverage: null }), { kind: 'BOUND', boundId: 'order-leverage', polarity: 'MAX', value: { type: 'RATIO', ratio: { numerator: 5n, scale: 0 } } }],
      }),
    );
    assert.deepEqual(checkDelegationSubset(p5, c5, 2), []);
  });

  it('refuses an incomparable restatement rather than converting it', () => {
    const c = must(
      validateAuthorityGrant({
        ...grantInput(grantOf({ ...base, depth: 1 }, parent)),
        terms: termsOf({ ...base, depth: 1, capital: null }).concat([{ ...dim('capital', 1n), limit: { kind: 'CAPITAL', unit: 'USD', decimals: 2, atoms: 1n } }]),
      }),
    );
    assert.deepEqual(checkDelegationSubset(parent, c, 2).map((v) => v.code), ['DELEGATION_TERM_INCOMPARABLE']);
    const ratioForQuantity = must(
      validateAuthorityGrant({
        ...grantInput(grantOf({ ...base, depth: 1 }, parent)),
        terms: termsOf({ ...base, depth: 1, maxNotional: null }).concat([{ kind: 'BOUND', boundId: 'order-notional', polarity: 'MAX', value: { type: 'RATIO', ratio: { numerator: 1n, scale: 0 } } }]),
      }),
    );
    assert.deepEqual(checkDelegationSubset(parent, ratioForQuantity, 2).map((v) => v.code), ['DELEGATION_TERM_INCOMPARABLE']);
  });

  it('never treats different invariant bytes as stricter: only exact restatement passes', () => {
    assert.deepEqual(check({ ...base, depth: 1, invariant: '0x03' }), ['DELEGATION_NARROWING_UNPROVEN']);
    assert.deepEqual(check({ ...base, depth: 1, invariant: '0x04' }), []);
    assert.deepEqual(check({ ...base, depth: 1, invariant: null }), ['DELEGATION_DROPS_INVARIANT']);
  });

  it('compares state policy field by field, and refuses an ordering Core does not know', () => {
    const sp = base.statePolicy as NonNullable<Spec['statePolicy']>;
    assert.deepEqual(check({ ...base, depth: 1, statePolicy: { ...sp, maxAge: 11n } }), ['DELEGATION_WEAKENS_STATE_POLICY']);
    assert.deepEqual(check({ ...base, depth: 1, statePolicy: { ...sp, sources: ['src-1', 'src-3'] } }), ['DELEGATION_WEAKENS_STATE_POLICY']);
    assert.deepEqual(check({ ...base, depth: 1, statePolicy: { ...sp, trust: 'VERIFIED' } }), ['DELEGATION_WEAKENS_STATE_POLICY']);
    assert.deepEqual(check({ ...base, depth: 1, statePolicy: { ...sp, atIssue: 'WITHIN_POLICY' } }), ['DELEGATION_WEAKENS_STATE_POLICY']);
    assert.deepEqual(check({ ...base, depth: 1, statePolicy: null }), ['DELEGATION_DROPS_STATE_POLICY']);
    const withFinality = (level: string, freshness: object, atExecution: object) =>
      must(
        validateAuthorityGrant({
          ...grantInput(grantOf({ ...base, depth: 1 }, parent)),
          terms: termsOf({ ...base, depth: 1, statePolicy: null }).concat([
            {
              kind: 'STATE_POLICY',
              domain: 'perp',
              stateKind: 'perp.markPrice',
              admittedSources: ['src-1'],
              requirement: { freshness: freshness as never, minTrust: 'AUTHORITATIVE', minFinality: { ladder: 'venue-l.market-data', level }, atIssue: 'RECHECK', atExecution: atExecution as never },
            },
          ]),
        }),
      );
    const codes = (g: AuthorityGrant) => checkDelegationSubset(parent, g, 2).map((v) => v.code);
    assert.deepEqual(codes(withFinality('FINAL', { kind: 'AGE', maxAgeSeconds: 5n }, { kind: 'NOT_REQUIRED' })), ['DELEGATION_NARROWING_UNPROVEN']);
    assert.deepEqual(codes(withFinality('PUBLISHED', { kind: 'BLOCKS', maxBlocksBehind: 1n }, { kind: 'NOT_REQUIRED' })), ['DELEGATION_TERM_INCOMPARABLE']);
    // Requiring something at execution where the parent required nothing is stricter.
    assert.deepEqual(codes(withFinality('PUBLISHED', { kind: 'AGE', maxAgeSeconds: 5n }, { kind: 'ENFORCED_BY_ARTIFACT', field: 'limitPrice' })), []);
  });

  it('closed world for sets and rights: a vocabulary or right the parent lacks cannot appear in the child', () => {
    const noMarkets = grantOf({ ...base, markets: null }, null, AGENT_A, 3n);
    assert.deepEqual(checkDelegationSubset(noMarkets, grantOf({ ...base, depth: 1 }, noMarkets), 2).map((v) => v.code), ['DELEGATION_WIDENS_SET']);
    assert.deepEqual(check({ ...base, depth: 1, rights: ['OPEN_RISK', 'TRANSFER_OUT'] }), ['DELEGATION_WIDENS_RIGHT']);
    assert.deepEqual(check({ ...base, depth: 1, markets: [MKTS[0] as ResourceIdInput, MKTS[3] as ResourceIdInput] }), ['DELEGATION_WIDENS_SET']);
  });

  it('time: the child\'s validity and a restated window must lie inside the parent\'s', () => {
    assert.deepEqual(check({ ...base, depth: 1, expiresAt: T_END + 1n }), ['DELEGATION_WIDENS_WINDOW']);
    assert.deepEqual(check({ ...base, depth: 1, notBefore: T0 - 1n }), ['DELEGATION_WIDENS_WINDOW']);
    assert.deepEqual(check({ ...base, depth: 1, window: { nb: T0 + 9n, ea: T0 + 5_000n } }), ['DELEGATION_WIDENS_WINDOW']);
    assert.deepEqual(check({ ...base, depth: 1, window: null }), []); // still intersected at action time
  });
});

function grantInput(g: AuthorityGrant) {
  return {
    lineage: g.lineage.kind === 'ROOT' ? { kind: 'ROOT' as const, issuer: { kind: g.lineage.issuer.kind, value: g.lineage.issuer.value } } : { kind: 'DELEGATION' as const, parent: g.lineage.parent, issuer: { kind: g.lineage.issuer.kind, value: g.lineage.issuer.value } },
    principal: { kind: g.principal.kind, value: g.principal.value },
    holder: { kind: g.holder.kind, value: g.holder.value },
    notBefore: g.notBefore,
    expiresAt: g.expiresAt,
    nonce: g.nonce,
  };
}

// --- Registration half: property ----------------------------------------------------

describe('AUTH-2, registration half (property over random parents and children)', () => {
  it('accepts every narrowing and refuses every single widening with its own code', () => {
    let accepted = 0;
    let refusedCount = 0;
    const codes = new Set<string>();
    for (let seed = 1; seed <= 400; seed += 1) {
      const rand = prng(seed);
      const p = randomSpec(rand);
      const parent = grantOf(p, null);
      const c = narrow(rand, p);
      assert.deepEqual(checkDelegationSubset(parent, grantOf(c, parent), p.depth), [], `seed ${seed}: narrowing refused`);
      accepted += 1;
      const w = widen(rand, p, c);
      const got = checkDelegationSubset(parent, grantOf(w.spec, parent), p.depth).map((v) => v.code);
      assert.deepEqual(got, [w.code], `seed ${seed}: expected [${w.code}], got [${got.join(', ')}]`);
      refusedCount += 1;
      codes.add(w.code);
    }
    assert.equal(accepted, 400);
    assert.equal(refusedCount, 400);
    // Every mutation family was exercised.
    assert.equal(codes.size, 11);
  });
});

// --- Meet half: property with registration bypassed -----------------------------------

function memberKeys(t: SetConstraintTerm): string[] {
  return (t.members as readonly object[]).map((m) => JSON.stringify(m, Object.keys(m).sort()));
}

/** An independent oracle: `e` is no wider than `ancestor`'s own grant, at distance `k` below it. */
function noWiderThan(e: Pick<EffectiveAuthority, 'sets' | 'rights' | 'delegateDepth' | 'validity' | 'bounds' | 'invariants' | 'timeWindows'>, ancestor: AuthorityGrant, k: number): string | null {
  for (const s of e.sets) {
    const a = ancestor.terms.find((t): t is SetConstraintTerm => t.kind === 'SET' && t.vocabulary === s.vocabulary);
    if (a === undefined) return `set ${s.vocabulary} not granted by ancestor`;
    const allowed = new Set(memberKeys(a));
    if (!memberKeys(s).every((m) => allowed.has(m))) return `set ${s.vocabulary} wider`;
  }
  for (const r of e.rights) if (!ancestor.terms.some((t) => t.kind === 'RIGHT' && t.right === r)) return `right ${r}`;
  const ancestorDepth = ancestor.terms.find((t) => t.kind === 'RIGHT' && t.right === 'DELEGATE');
  const depthAllowed = (ancestorDepth !== undefined && ancestorDepth.kind === 'RIGHT' && ancestorDepth.right === 'DELEGATE' ? ancestorDepth.maxDepth : 0) - k;
  if (e.delegateDepth > (depthAllowed < 0 ? 0 : depthAllowed)) return 'depth';
  if (e.validity.notBefore < ancestor.notBefore || e.validity.expiresAt > ancestor.expiresAt) return 'validity';
  for (const t of ancestor.terms) {
    if (t.kind === 'BOUND') {
      const mine = e.bounds.find((b) => termKey(b) === termKey(t));
      if (mine === undefined) return `bound ${t.boundId} missing`;
      const cmp = boundCmp(mine, t);
      if ((t.polarity === 'MAX' && cmp > 0) || (t.polarity === 'MIN' && cmp < 0)) return `bound ${t.boundId} wider`;
    }
    if (t.kind === 'STATE_INVARIANT' && !e.invariants.some((i) => termKey(i.term) === termKey(t) && i.term.params === t.params)) return 'invariant dropped';
    if (t.kind === 'TIME_WINDOW') {
      const w = e.timeWindows.find((x) => x.domain === t.domain);
      if (w === undefined || (!w.empty && (w.notBefore < t.notBefore || w.expiresAt > t.expiresAt))) return 'window';
    }
  }
  return null;
}

function boundCmp(a: PerActionBoundTerm, b: PerActionBoundTerm): number {
  if (a.value.type === 'RATIO' && b.value.type === 'RATIO') return compareRatios(a.value.ratio, b.value.ratio);
  if (a.value.type === 'QUANTITY' && b.value.type === 'QUANTITY') {
    const l = a.value.quantity.atoms * 10n ** BigInt(b.value.quantity.decimals);
    const r = b.value.quantity.atoms * 10n ** BigInt(a.value.quantity.decimals);
    return l < r ? -1 : l > r ? 1 : 0;
  }
  return Number.NaN;
}

/** The leaf's own terms read as if they were its effective authority — what a ledger without the meet would use. */
function ownTermsAsEffective(g: AuthorityGrant): Pick<EffectiveAuthority, 'sets' | 'rights' | 'delegateDepth' | 'validity' | 'bounds' | 'invariants' | 'timeWindows'> {
  const depth = g.terms.find((t) => t.kind === 'RIGHT' && t.right === 'DELEGATE');
  return {
    sets: g.terms.filter((t): t is SetConstraintTerm => t.kind === 'SET'),
    rights: g.terms.flatMap((t) => (t.kind === 'RIGHT' && t.right !== 'DELEGATE' ? [t.right] : [])),
    delegateDepth: depth !== undefined && depth.kind === 'RIGHT' && depth.right === 'DELEGATE' ? depth.maxDepth : 0,
    validity: { notBefore: g.notBefore, expiresAt: g.expiresAt, empty: false },
    bounds: g.terms.filter((t): t is PerActionBoundTerm => t.kind === 'BOUND'),
    invariants: g.terms.filter((t) => t.kind === 'STATE_INVARIANT').map((term) => ({ term, binding: null })),
    timeWindows: g.terms.flatMap((t) => (t.kind === 'TIME_WINDOW' ? [{ domain: t.domain, notBefore: t.notBefore, expiresAt: t.expiresAt, empty: false }] : [])),
  };
}

describe('AUTH-2, meet half (property over random lineages with registration bypassed)', () => {
  it('no node\'s effective authority is ever wider than any ancestor\'s grant, even when widening nodes are injected', () => {
    let injected = 0;
    let caughtWithoutMeet = 0;
    for (let seed = 1; seed <= 150; seed += 1) {
      const rand = prng(5000 + seed);
      const pol = policy();
      let state: LedgerState = { ...emptyLedgerState(PRINCIPAL), policy: { id: principalPolicyId(pol), policy: pol, bindings: [], registeredAt: 1n as LedgerVersion } };
      const specs: Spec[] = [];
      const grants: AuthorityGrant[] = [];
      const depth = int(rand, 2, 5);
      let spec = randomSpec(rand);
      spec = { ...spec, depth: depth + 1 };
      for (let level = 0; level < depth; level += 1) {
        const parent = grants[level - 1] ?? null;
        let widened = false;
        if (level > 0) {
          const next = narrow(rand, specs[level - 1] as Spec);
          if (rand() < 0.5) {
            spec = widen(rand, specs[level - 1] as Spec, next).spec;
            widened = true;
          } else spec = next;
        }
        const g = grantOf(spec, parent, address((60 + level).toString(16).padStart(2, '0')), BigInt(seed));
        // Inject directly: the registration check is bypassed on purpose.
        state = { ...state, nodes: state.nodes.set(authorityId(g), { id: authorityId(g), grant: g, depth: level, bindings: [], registeredAt: 1n as LedgerVersion, revokedAt: null, revocation: null }) };
        specs.push(spec);
        grants.push(g);
        if (widened) injected += 1;
      }
      for (let i = 0; i < grants.length; i += 1) {
        const g = grants[i] as AuthorityGrant;
        const lineage = must(resolveLineage(state, authorityId(g)));
        const e = effectiveAuthority(lineage, (state.policy as NonNullable<LedgerState['policy']>).policy);
        if (!e.ok) {
          // An incomparable injected term makes the meet unformable: refused, which is fail-closed.
          assert.equal(e.error.code, 'LINEAGE_TERMS_INCOMPARABLE');
          continue;
        }
        for (let j = i; j >= 0; j -= 1) {
          const why = noWiderThan(e.value, grants[j] as AuthorityGrant, i - j);
          assert.equal(why, null, `seed ${seed}: node ${i} wider than ancestor ${j}: ${why}`);
        }
        // Non-vacuity: read without the meet, an injected widening node would be wider than an ancestor.
        if (i > 0 && grants.slice(0, i).some((a, j) => noWiderThan(ownTermsAsEffective(g), a, i - j) !== null)) caughtWithoutMeet += 1;
      }
    }
    assert.ok(injected > 100, `only ${injected} widening nodes injected`);
    assert.ok(caughtWithoutMeet > 50, `the oracle rejected only ${caughtWithoutMeet} nodes read without the meet`);
  });
});

describe('the meet refuses to form over incomparable terms', () => {
  it('a lineage whose nodes bound one parameter in different measures has no effective authority', () => {
    const quantityBound = { kind: 'BOUND', boundId: 'order-size', polarity: 'MAX', value: { type: 'QUANTITY', quantity: { kind: 'CAPITAL', unit: 'USDG', decimals: 2, atoms: 100n } } } as const;
    const ratioBound = { kind: 'BOUND', boundId: 'order-size', polarity: 'MAX', value: { type: 'RATIO', ratio: { numerator: 3n, scale: 0 } } } as const;
    const parent = must(validateAuthorityGrant({ lineage: { kind: 'ROOT', issuer: P }, principal: P, holder: AGENT_A, notBefore: T0, expiresAt: T_END, terms: [quantityBound, { kind: 'RIGHT', right: 'DELEGATE', maxDepth: 1 }], nonce: 0n }));
    const forged = must(validateAuthorityGrant({ lineage: { kind: 'DELEGATION', parent: authorityId(parent), issuer: AGENT_A }, principal: P, holder: address('77'), notBefore: T0, expiresAt: T_END, terms: [ratioBound], nonce: 0n }));
    // Registration would refuse it…
    assert.deepEqual(checkDelegationSubset(parent, forged, 1).map((v) => v.code), ['DELEGATION_TERM_INCOMPARABLE']);
    // …and if it were in the state anyway, no effective authority can be formed for it.
    const pol = policy();
    let state: LedgerState = { ...emptyLedgerState(PRINCIPAL), policy: { id: principalPolicyId(pol), policy: pol, bindings: [], registeredAt: 1n as LedgerVersion } };
    for (const [g, depth] of [[parent, 0], [forged, 1]] as const) {
      state = { ...state, nodes: state.nodes.set(authorityId(g), { id: authorityId(g), grant: g, depth, bindings: [], registeredAt: 1n as LedgerVersion, revokedAt: null, revocation: null }) };
    }
    const e = effectiveAuthority(must(resolveLineage(state, authorityId(forged))), pol);
    assert.ok(!e.ok && e.error.code === 'LINEAGE_TERMS_INCOMPARABLE');
  });
});
