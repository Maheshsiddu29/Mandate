/**
 * The principal policy on the ledger (authority-model.md §8): registered
 * before any root, granting nothing, the last leg of every charging path — and,
 * in 7C, replaceable only where the new policy's quantitative baseline is
 * provable.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reservationIdFor } from '@mandate/core';
import { encodeLedgerState } from '../src/index.ts';
import { AGENT_A, AGENT_B, ALL_MODULES, BTC, T0, capital, contribution, dim, plan, policy, root, units } from './support/grants.ts';
import { available, bootstrap, closeEvent, consumeEvent, genesis, policyBalance, reservationOf, reserve, reserveRefused, step, stepRefused } from './support/steps.ts';

const global = dim('global-capital', units(1_000));
const a = root({ holder: AGENT_A, terms: [ALL_MODULES, dim('capital', units(5_000))] });
const b = root({ holder: AGENT_B, nonce: 1n, terms: [ALL_MODULES, dim('capital', units(5_000))] });
const spend = (g: typeof a, label: string, atoms: bigint) => plan({ authority: g, action: label, contributions: [contribution(capital(atoms))] });

describe('registration', () => {
  it('may be explicitly empty, and an empty policy is still required before any root', () => {
    const s = step(genesis(), [{ kind: 'REGISTER_POLICY', at: T0, policy: policy([]) }]);
    assert.equal(s.policy?.policy.terms.length, 0);
    assert.equal(stepRefused(genesis(), [{ kind: 'REGISTER_GRANT', at: T0, grant: a }]).code, 'PRINCIPAL_POLICY_MISSING');
  });

  it('carries invariants and state policy as data: registering them evaluates nothing and charges nothing', () => {
    const p = policy([
      global,
      { kind: 'STATE_INVARIANT', invariantId: 'core.markedExposure', version: 1, scope: [BTC], params: '0x2710' },
      {
        kind: 'STATE_POLICY',
        domain: 'perp',
        stateKind: 'perp.markPrice',
        admittedSources: ['venue-l.ws'],
        requirement: { freshness: { kind: 'AGE', maxAgeSeconds: 5n }, minTrust: 'VERIFIED', minFinality: { ladder: 'venue-l.market-data', level: 'PUBLISHED' }, atIssue: 'RECHECK', atExecution: { kind: 'NOT_REQUIRED' } },
      },
    ]);
    const s = bootstrap(p, [a]);
    // Only the ledger dimension became a charge target.
    assert.equal([...s.targets.values()].filter((t) => t.source === 'POLICY').length, 1);
  });
});

describe('the policy constrains every root and grants none', () => {
  it('two roots cannot jointly exceed a principal-global dimension, and each is still bounded by its own grant', () => {
    let s = bootstrap(policy([global]), [a, b]);
    s = reserve(s, spend(a, 'a', units(600)));
    assert.equal(reserveRefused(s, spend(b, 'b', units(600))).code, 'LEDGER_LIMIT_EXCEEDED');
    s = reserve(s, spend(b, 'b', units(400)));
    assert.equal(available(policyBalance(s, global)), 0n);
  });

  it('a policy dimension does not stand in for a grant: a root with no capital dimension reserves no capital', () => {
    const bare = root({ holder: AGENT_A, nonce: 7n, terms: [ALL_MODULES] });
    const s = bootstrap(policy([global]), [bare]);
    assert.equal(reserveRefused(s, spend(bare, 'x', units(1))).code, 'UNBOUNDED_CONTRIBUTION');
  });
});

describe('replacement (7C: only where the baseline is provable)', () => {
  const next = (terms: Parameters<typeof policy>[0], sequence: bigint) => ({ kind: 'REGISTER_POLICY' as const, at: T0, policy: policy(terms, sequence) });

  it('requires a strictly higher sequence', () => {
    const s = bootstrap(policy([global], 5n), [a]);
    assert.equal(stepRefused(s, [next([global], 5n)]).code, 'POLICY_SEQUENCE_NOT_INCREASING');
    assert.equal(stepRefused(s, [next([global], 4n)]).code, 'POLICY_SEQUENCE_NOT_INCREASING');
    step(s, [next([global], 6n)]);
  });

  it('may introduce a dimension while nothing has ever been reserved: the empty baseline is provable', () => {
    const s = step(bootstrap(policy([], 1n), [a]), [next([global], 2n)]);
    assert.equal(policyBalance(s, global).reserved, 0n);
    const s2 = reserve(s, spend(a, 'a', units(1_000)));
    assert.equal(reserveRefused(s2, spend(a, 'b', units(1))).code, 'LEDGER_LIMIT_EXCEEDED');
  });

  it('refuses to introduce a dimension once anything was reserved: no zero baseline is fabricated', () => {
    const s = reserve(bootstrap(policy([], 1n), [a]), spend(a, 'a', units(600)));
    const r = stepRefused(s, [next([global], 2n)]);
    assert.equal(r.code, 'POLICY_UPDATE_REQUIRES_BASELINE');
    // Changing a kept dimension's scope makes it a different dimension: also refused.
    const s2 = reserve(bootstrap(policy([global], 1n), [a]), spend(a, 'a', units(1)));
    assert.equal(stepRefused(s2, [next([dim('global-capital', units(1_000), { scope: { domain: 'perp' } })], 2n)]).code, 'POLICY_UPDATE_REQUIRES_BASELINE');
    // Even a closed, fully released reservation counts: its consumption is history the new dimension cannot see.
    const p0 = spend(a, 'z', units(5));
    let s3 = reserve(bootstrap(policy([], 1n), [a]), p0);
    const r0 = reservationOf(s3, reservationIdFor(p0.action, p0.generation));
    s3 = step(s3, [closeEvent(r0)]);
    assert.equal(stepRefused(s3, [next([global], 2n)]).code, 'POLICY_UPDATE_REQUIRES_BASELINE');
  });

  it('a kept dimension keeps its whole history; only its ceiling follows the new policy', () => {
    let s = reserve(bootstrap(policy([global], 1n), [a]), spend(a, 'a', units(600)));
    const pa = spend(a, 'a', units(600));
    const rec = reservationOf(s, reservationIdFor(pa.action, pa.generation));
    s = step(s, [consumeEvent(rec, [units(600)])]);
    // Loosen: the 600 consumed is kept, and the new ceiling applies.
    s = step(s, [next([dim('global-capital', units(2_000))], 2n)]);
    assert.equal(policyBalance(s, dim('global-capital', units(2_000))).consumed, units(600));
    assert.equal(available(policyBalance(s, dim('global-capital', units(2_000)))), units(1_400));
    // Tighten below occupancy: nothing is released, and no increase fits until authority comes back.
    s = step(s, [next([dim('global-capital', units(500))], 3n)]);
    assert.equal(available(policyBalance(s, dim('global-capital', units(500)))), -units(100));
    assert.equal(reserveRefused(s, spend(a, 'b', units(1))).code, 'LEDGER_LIMIT_EXCEEDED');
    // The old reservation still reconciles against the carried-over target.
    s = step(s, [closeEvent(reservationOf(s, rec.id))]);
    assert.equal(policyBalance(s, dim('global-capital', units(500))).reserved, 0n);
  });

  it('a removed dimension stops being charged; re-adding it later is an introduction and is refused', () => {
    let s = reserve(bootstrap(policy([global], 1n), [a]), spend(a, 'a', units(600)));
    s = step(s, [next([], 2n)]);
    const beforeB = encodeLedgerState(s);
    s = reserve(s, spend(a, 'b', units(900)));
    assert.equal(policyBalance(s, global).reserved, units(600)); // only the reservation made under policy 1
    assert.equal(policyBalance(s, global).current, false);
    assert.notDeepEqual(encodeLedgerState(s), beforeB);
    assert.equal(stepRefused(s, [next([global], 3n)]).code, 'POLICY_UPDATE_REQUIRES_BASELINE');
  });

  it('may replace invariants and state policy freely: they are not quantitative baselines', () => {
    const s = reserve(bootstrap(policy([global], 1n), [a]), spend(a, 'a', units(1)));
    step(s, [next([global, { kind: 'STATE_INVARIANT', invariantId: 'core.markedExposure', version: 1, scope: [BTC], params: '0x01' }], 2n)]);
  });
});
