/**
 * Ledger semantics, tested on the pure reducer: charging paths, the
 * principal-global leg, atomic multi-dimension charging, arithmetic
 * boundaries, charge attribution and restoration, generations, expiry and
 * epochs (authority-ledger.md §3–§8, §12).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UINT256_MAX, authorityId, reservationIdFor, type AuthorityGrant, type ActionId, type LedgerVersion, type ReservationGeneration } from '@mandate/core';
import { encodeLedgerState, validateChargePlan, chargePlanInputOf, type LedgerEvent, type LedgerRefusal, type LedgerState } from '../src/index.ts';
import {
  AGENT_A,
  AGENT_B,
  ALL_MODULES,
  BTC,
  BTC_PERP,
  DAY,
  DELEGATE,
  ETH,
  ETH_PERP,
  OUTSIDER,
  P2,
  PERP_V1,
  SPOT_V1,
  SUB_ACCOUNT,
  T0,
  USDG_PERP,
  capital,
  child,
  contribution,
  count,
  digestOf,
  dim,
  modules,
  notional,
  plan,
  policy,
  root,
  units,
} from './support/grants.ts';
import {
  available,
  bootstrap,
  closeEvent,
  consumeEvent,
  figures,
  nodeBalance,
  policyBalance,
  reservationOf,
  reserve,
  reserveEvent,
  reserveRefused,
  restoreEvent,
  step,
  stepRefused,
} from './support/steps.ts';

function limitFailures(r: LedgerRefusal): { target: string; requested: bigint; available: bigint }[] {
  assert.equal(r.code, 'LEDGER_LIMIT_EXCEEDED', `expected LEDGER_LIMIT_EXCEEDED, got ${r.code} at ${r.path}`);
  if (r.code !== 'LEDGER_LIMIT_EXCEEDED') return [];
  return r.failures.map((f) => ({ target: f.target.kind === 'NODE' ? `${f.target.authority}:${f.target.dimensionId}` : `policy:${f.target.dimensionId}`, requested: f.requested, available: f.available }));
}

function node(g: AuthorityGrant, d: string): string {
  return `${authorityId(g)}:${d}`;
}

const idOf = (p: ReturnType<typeof plan>) => reservationIdFor(p.action, p.generation);

describe('charging paths', () => {
  it('a child\'s limit is a ceiling, not a carve-out: the reservation is charged at every matching node', () => {
    const r = root({ terms: [ALL_MODULES, DELEGATE(1), dim('capital', units(100_000))] });
    const c = child(r, { terms: [ALL_MODULES, dim('capital', units(60_000))] });
    let s = bootstrap(policy(), [r, c]);
    s = reserve(s, plan({ authority: c, contributions: [contribution(capital(units(40_000)))] }));
    assert.deepEqual(figures(nodeBalance(s, r, 'capital')), [units(40_000), 0n, 0n, units(60_000)]);
    assert.deepEqual(figures(nodeBalance(s, c, 'capital')), [units(40_000), 0n, 0n, units(20_000)]);
  });

  it('the principal-global dimension is the last leg of every path, whichever root the action uses', () => {
    const global = dim('btc-notional-global', units(10_000), { kind: 'NOTIONAL', unit: 'USD', scope: { asset: BTC } });
    const a = root({ holder: AGENT_A, terms: [ALL_MODULES, dim('btc-notional', units(7_000), { kind: 'NOTIONAL', unit: 'USD', scope: { asset: BTC } })] });
    const b = root({ holder: AGENT_B, nonce: 1n, terms: [ALL_MODULES, dim('btc-notional', units(5_000), { kind: 'NOTIONAL', unit: 'USD', scope: { asset: BTC } })] });
    let s = bootstrap(policy([global]), [a, b]);
    const spot = plan({ authority: a, module: SPOT_V1, action: 'spot', contributions: [contribution(notional(units(6_000), digestOf('action:spot')))] });
    s = reserve(s, spot);
    assert.equal(available(policyBalance(s, global)), units(4_000));
    const perp = plan({ authority: b, module: PERP_V1, action: 'perp', contributions: [contribution(notional(units(5_000), digestOf('action:perp')))] });
    // Root B's own limit passes; only the principal-global leg fails, and it is named.
    assert.deepEqual(limitFailures(reserveRefused(s, perp)), [{ target: 'policy:btc-notional-global', requested: units(5_000), available: units(4_000) }]);
    const smaller = plan({ authority: b, module: PERP_V1, action: 'perp-small', contributions: [contribution(notional(units(4_000), digestOf('action:perp-small')))] });
    s = reserve(s, smaller);
    assert.equal(available(policyBalance(s, global)), 0n);
    assert.equal(available(nodeBalance(s, b, 'btc-notional')), units(1_000));
  });

  it('dimensions are not keyed by domain unless the principal scoped them so', () => {
    const shared = dim('capital-global', units(1_000));
    const perpOnly = dim('perp-capital', units(300), { scope: { domain: 'perp' } });
    const r = root({ terms: [ALL_MODULES, dim('capital', units(10_000))] });
    let s = bootstrap(policy([shared, perpOnly]), [r]);
    s = reserve(s, plan({ authority: r, module: SPOT_V1, action: 's', contributions: [contribution(capital(units(500)))] }));
    assert.equal(policyBalance(s, shared).reserved, units(500));
    assert.equal(policyBalance(s, perpOnly).reserved, 0n);
    s = reserve(s, plan({ authority: r, module: PERP_V1, action: 'p', contributions: [contribution(capital(units(300), USDG_PERP))] }));
    // Spot and perp capital charge the same principal-global dimension, in two different funding representations.
    assert.equal(policyBalance(s, shared).reserved, units(800));
    assert.equal(policyBalance(s, perpOnly).reserved, units(300));
  });

  it('matches by kind, unit and every scope attribute the dimension names', () => {
    const r = root({
      terms: [
        ALL_MODULES,
        dim('capital', units(10_000)),
        dim('btc-perp-capital', units(100), { scope: { market: BTC_PERP } }),
        dim('sub-capital', units(50), { scope: { account: SUB_ACCOUNT } }),
        dim('eth-notional', units(1_000), { kind: 'NOTIONAL', unit: 'USD', scope: { asset: ETH } }),
      ],
    });
    const s = bootstrap(policy(), [r]);
    const on = (market: typeof BTC_PERP | null, account: typeof SUB_ACCOUNT | null) =>
      reserve(s, plan({ authority: r, contributions: [contribution(capital(units(40)), { market, account })] }));
    assert.equal(nodeBalance(on(BTC_PERP, null), r, 'btc-perp-capital').reserved, units(40));
    assert.equal(nodeBalance(on(ETH_PERP, null), r, 'btc-perp-capital').reserved, 0n);
    assert.equal(nodeBalance(on(null, null), r, 'btc-perp-capital').reserved, 0n);
    assert.equal(nodeBalance(on(null, SUB_ACCOUNT), r, 'sub-capital').reserved, units(40));
    // BTC notional does not match an ETH-scoped dimension, and is then unbounded.
    const btcNotional = plan({ authority: r, action: 'n', contributions: [contribution(notional(units(1), digestOf('action:n'), BTC))] });
    assert.equal(reserveRefused(s, btcNotional).code, 'UNBOUNDED_CONTRIBUTION');
    // Capital in another unit is a different measure: no dimension matches.
    const usd = plan({ authority: r, action: 'u', contributions: [contribution({ ...capital(units(1)), unit: 'USD' })] });
    assert.equal(reserveRefused(s, usd).code, 'UNBOUNDED_CONTRIBUTION');
  });

  it('LEDGER-5: a required contribution needs a lineage dimension; the policy grants none', () => {
    const r = root({ terms: [ALL_MODULES] }); // grants no capital at all
    const s = bootstrap(policy([dim('global-capital', units(10_000)), dim('global-actions', 100n, { kind: 'COUNT', unit: 'COUNT', decimals: 0, restoration: 'NONE' })]), [r]);
    const required = plan({ authority: r, contributions: [contribution(capital(units(1)))] });
    const refusal = reserveRefused(s, required);
    assert.equal(refusal.code, 'UNBOUNDED_CONTRIBUTION');
    // An optional contribution is charged wherever a dimension matches — here, only at the policy.
    const optional = plan({ authority: r, action: 'c', contributions: [contribution(count(1n), { required: false })] });
    const s2 = reserve(s, optional);
    assert.equal(policyBalance(s2, dim('global-actions', 100n, { kind: 'COUNT', unit: 'COUNT', decimals: 0, restoration: 'NONE' })).reserved, 1n);
  });

  it('an empty policy infers no aggregate limit, and no root can bypass its own grant', () => {
    const a = root({ holder: AGENT_A, terms: [ALL_MODULES, dim('capital', units(5_000))] });
    const b = root({ holder: AGENT_B, nonce: 1n, terms: [ALL_MODULES, dim('capital', units(5_000))] });
    let s = bootstrap(policy([]), [a, b]);
    s = reserve(s, plan({ authority: a, action: 'a', contributions: [contribution(capital(units(5_000)))] }));
    s = reserve(s, plan({ authority: b, action: 'b', contributions: [contribution(capital(units(5_000)))] }));
    assert.equal(s.policy?.policy.terms.length, 0);
    const over = plan({ authority: a, action: 'a2', contributions: [contribution(capital(units(1)))] });
    assert.deepEqual(limitFailures(reserveRefused(s, over)).map((f) => f.target), [node(a, 'capital')]);
  });

  it('never trusts a recorded charge path: omitting an ancestor, the policy leg or an amount is refused', () => {
    const global = dim('global-capital', units(10_000));
    const r = root({ terms: [ALL_MODULES, DELEGATE(1), dim('capital', units(8_000))] });
    const c = child(r, { terms: [ALL_MODULES, dim('capital', units(6_000))] });
    const s = bootstrap(policy([global]), [r, c]);
    const e = reserveEvent(s, plan({ authority: c, contributions: [contribution(capital(units(100)))] }));
    assert.ok(e.kind === 'RESERVE');
    const legs = e.legs[0] ?? [];
    assert.deepEqual(legs.map((l) => l.target.kind), ['NODE', 'NODE', 'POLICY']);
    const tamper = (x: Partial<Extract<LedgerEvent, { kind: 'RESERVE' }>>): LedgerRefusal => stepRefused(s, [{ ...e, ...x }]);
    assert.equal(tamper({ legs: [legs.filter((l) => !(l.target.kind === 'NODE' && l.target.authority === authorityId(r)))] }).code, 'CHARGE_PATH_MISMATCH');
    assert.equal(tamper({ legs: [legs.filter((l) => l.target.kind !== 'POLICY')] }).code, 'CHARGE_PATH_MISMATCH');
    assert.equal(tamper({ legs: [legs.map((l) => ({ ...l, amount: l.amount - 1n }))] }).code, 'CHARGE_PATH_MISMATCH');
    assert.equal(tamper({ lineage: [authorityId(c)] }).code, 'CHARGE_PATH_MISMATCH');
    assert.equal(tamper({ policy: digestOf('another policy') as never }).code, 'CHARGE_PATH_MISMATCH');
    // And a plan has no field in which to name targets at all.
    const withTargets = validateChargePlan({ ...chargePlanInputOf(e.plan), targets: [] } as never);
    assert.ok(!withTargets.ok && withTargets.error.code === 'MALFORMED' && withTargets.error.core.code === 'UNKNOWN_FIELD');
  });
});

describe('atomic multi-dimension charging', () => {
  const r = root({
    terms: [
      ALL_MODULES,
      dim('capital', units(100)),
      dim('btc-notional', units(100), { kind: 'NOTIONAL', unit: 'USD', scope: { asset: BTC } }),
      dim('actions', 1n, { kind: 'COUNT', unit: 'COUNT', decimals: 0, restoration: 'NONE' }),
    ],
  });
  const all = (n: bigint, label: string) =>
    plan({ authority: r, action: label, contributions: [contribution(capital(units(40))), contribution(notional(units(70), digestOf(`action:${label}`))), contribution(count(n))] });

  it('capital and notional fit, the action count does not: nothing at all is reserved', () => {
    const small = plan({ authority: r, action: 'first', contributions: [contribution(capital(units(10))), contribution(notional(units(10), digestOf('action:first'))), contribution(count(1n))] });
    const s = reserve(bootstrap(policy(), [r]), small);
    const before = encodeLedgerState(s);
    // Capital 40 ≤ 90 and notional 70 ≤ 90 have room; the action count has none.
    const refusal = reserveRefused(s, all(1n, 'second'));
    assert.deepEqual(limitFailures(refusal), [{ target: node(r, 'actions'), requested: 1n, available: 0n }]);
    assert.deepEqual(encodeLedgerState(s), before);
    assert.equal(nodeBalance(s, r, 'capital').reserved, units(10));
    assert.equal(nodeBalance(s, r, 'btc-notional').reserved, units(10));
  });

  it('names every failing leg when several fail', () => {
    const s = reserve(bootstrap(policy(), [r]), all(1n, 'first'));
    assert.deepEqual(limitFailures(reserveRefused(s, all(1n, 'second'))).map((f) => f.target), [node(r, 'btc-notional'), node(r, 'actions')]);
  });

  it('refuses when only one of several dimensions fails, and charges none', () => {
    const s = bootstrap(policy(), [r]);
    const refusal = reserveRefused(s, all(2n, 'too-many'));
    assert.deepEqual(limitFailures(refusal).map((f) => f.target), [node(r, 'actions')]);
    assert.equal(nodeBalance(s, r, 'capital').reserved, 0n);
    assert.equal(nodeBalance(s, r, 'btc-notional').reserved, 0n);
  });

  it('aggregates contributions that reach the same target', () => {
    const s = bootstrap(policy(), [r]);
    const two = plan({ authority: r, contributions: [contribution(capital(units(60))), contribution(capital(units(50)))] });
    assert.deepEqual(limitFailures(reserveRefused(s, two)), [{ target: node(r, 'capital'), requested: units(110), available: units(100) }]);
  });
});

describe('arithmetic boundaries', () => {
  const r = root({ terms: [ALL_MODULES, dim('capital', units(100))] });
  const base = bootstrap(policy(), [r]);
  const cap = (atoms: bigint, label = 'x', decimals = 2) => plan({ authority: r, action: label, contributions: [contribution(capital(atoms, undefined, decimals))] });

  it('exactly fills the remaining capacity; one atom more is refused with the exact figures', () => {
    const s = reserve(reserve(base, cap(units(60), 'a')), cap(units(40), 'b'));
    assert.equal(available(nodeBalance(s, r, 'capital')), 0n);
    assert.deepEqual(limitFailures(reserveRefused(reserve(base, cap(units(60), 'a')), cap(units(40) + 1n, 'b'))), [{ target: node(r, 'capital'), requested: units(40) + 1n, available: units(40) }]);
  });

  it('refuses a zero, negative-signed, marked or unrealized-PnL contribution as a demand', () => {
    const bad = (quantity: object) => validateChargePlan({ ...chargePlanInputOf(cap(1n)), contributions: [{ quantity: quantity as never, market: null, account: null, required: true }] });
    for (const q of [
      capital(0n),
      { kind: 'POSITION_SIZE', unit: 'BTC', decimals: 8, atoms: -1n, asset: BTC, valuation: null },
      { kind: 'GROSS_EXPOSURE', unit: 'USD', decimals: 2, atoms: 1n, asset: BTC, valuation: { price: { numeratorUnit: 'USD', denominatorUnit: 'BTC', decimals: 2, atoms: 1n }, basis: 'MARK', source: { kind: 'STATE', stateId: digestOf('s') }, observedAt: T0 } },
      { kind: 'PNL', unit: 'USD', decimals: 2, atoms: 1n, asset: null, valuation: { price: { numeratorUnit: 'USD', denominatorUnit: 'BTC', decimals: 2, atoms: 1n }, basis: 'MARK', source: { kind: 'STATE', stateId: digestOf('s') }, observedAt: T0 } },
    ]) {
      const v = bad(q);
      assert.ok(!v.ok && v.error.code === 'CONTRIBUTION_INVALID', JSON.stringify(q, (_, x: bigint | string) => (typeof x === 'bigint' ? x.toString() : x)));
    }
  });

  it('reaches the maximum supported integer exactly, and refuses an overflowing demand rather than wrapping', () => {
    const big = root({ terms: [ALL_MODULES, dim('capital', UINT256_MAX)], nonce: 9n });
    const s0 = bootstrap(policy(), [big]);
    const s1 = reserve(s0, plan({ authority: big, contributions: [contribution(capital(UINT256_MAX))] }));
    assert.equal(nodeBalance(s1, big, 'capital').reserved, UINT256_MAX);
    // A 0-decimal contribution of 2²⁵⁶−1 rescales past uint256 at the dimension's 2 decimals.
    const over = plan({ authority: big, action: 'o', contributions: [contribution(capital(UINT256_MAX, undefined, 0))] });
    assert.equal(reserveRefused(s0, over).code, 'AMOUNT_OVERFLOW');
    // Beyond uint256 a quantity is not even representable.
    const tooBig = validateChargePlan({ ...chargePlanInputOf(over), contributions: [{ quantity: capital(UINT256_MAX + 1n), market: null, account: null, required: true }] });
    assert.ok(!tooBig.ok && tooBig.error.code === 'MALFORMED');
  });

  it('rescales exactly to each dimension\'s decimals, or refuses', () => {
    assert.equal(nodeBalance(reserve(base, cap(1_230_000n, 'six', 6)), r, 'capital').reserved, 123n);
    assert.equal(nodeBalance(reserve(base, cap(5n, 'zero', 0)), r, 'capital').reserved, 500n);
    assert.equal(reserveRefused(base, cap(1_230_001n, 'inexact', 6)).code, 'INEXACT_RESCALE');
  });

  it('refuses a NET dimension it cannot yet account for, rather than skipping it', () => {
    const net = root({ nonce: 3n, terms: [ALL_MODULES, dim('btc-position', 1_000_000n, { kind: 'POSITION_SIZE', unit: 'BTC', decimals: 8, sign: 'NET', restoration: 'UNITS' })] });
    const s = bootstrap(policy(), [net]);
    const p = plan({ authority: net, contributions: [contribution({ kind: 'POSITION_SIZE', unit: 'BTC', decimals: 8, atoms: 1n, asset: BTC, valuation: null })] });
    assert.equal(reserveRefused(s, p).code, 'NET_DIMENSION_UNSUPPORTED');
  });

  it('consume, release and restore are bounded by what the reservation holds', () => {
    const s1 = reserve(base, cap(units(50)));
    const res = reservationOf(s1, idOf(cap(units(50))));
    assert.equal(stepRefused(s1, [consumeEvent(res, [units(50) + 1n])]).code, 'CONSUME_EXCEEDS_RESERVED');
    const s2 = step(s1, [consumeEvent(res, [units(30)])]);
    const res2 = reservationOf(s2, res.id);
    assert.equal(stepRefused(s2, [consumeEvent(res2, [units(20) + 1n])]).code, 'CONSUME_EXCEEDS_RESERVED');
    // Release is exactly what remains: never more, never less.
    assert.equal(stepRefused(s2, [{ ...closeEvent(res2), amounts: [units(20) + 1n] } as LedgerEvent]).code, 'RELEASE_MISMATCH');
    assert.equal(stepRefused(s2, [{ ...closeEvent(res2), amounts: [units(19)] } as LedgerEvent]).code, 'RELEASE_MISMATCH');
    const s3 = step(s2, [closeEvent(res2)]);
    assert.deepEqual(figures(nodeBalance(s3, r, 'capital')), [0n, units(30), 0n, units(70)]);
    const res3 = reservationOf(s3, res.id);
    assert.equal(stepRefused(s3, [restoreEvent(res3, [units(30) + 1n])]).code, 'RESTORE_EXCEEDS_CONSUMED');
    const s4 = step(s3, [restoreEvent(res3, [units(10)])]);
    assert.equal(stepRefused(s4, [restoreEvent(reservationOf(s4, res.id), [units(20) + 1n])]).code, 'RESTORE_EXCEEDS_CONSUMED');
    const s5 = step(s4, [restoreEvent(reservationOf(s4, res.id), [units(20)])]);
    // Restoration returns what was consumed, never more: available is back to the grant, not above it.
    assert.deepEqual(figures(nodeBalance(s5, r, 'capital')), [0n, units(30), units(30), units(100)]);
    // After close nothing more is consumed or released.
    assert.equal(stepRefused(s5, [consumeEvent(reservationOf(s5, res.id), [1n])]).code, 'RESERVATION_CLOSED');
    assert.equal(stepRefused(s5, [closeEvent(reservationOf(s5, res.id))]).code, 'RESERVATION_CLOSED');
  });

  it('refuses malformed accounting: unknown reservation, wrong shape, all-zero, wrong generation', () => {
    const s1 = reserve(base, cap(units(50)));
    const res = reservationOf(s1, idOf(cap(units(50))));
    assert.equal(stepRefused(s1, [{ ...consumeEvent(res, [1n]), reservation: digestOf('none') as never }]).code, 'RESERVATION_UNKNOWN');
    assert.equal(stepRefused(s1, [consumeEvent(res, [1n, 1n])]).code, 'ACCOUNTING_SHAPE_INVALID');
    assert.equal(stepRefused(s1, [consumeEvent(res, [0n])]).code, 'ACCOUNTING_SHAPE_INVALID');
    assert.equal(stepRefused(s1, [consumeEvent(res, [-1n])]).code, 'ACCOUNTING_SHAPE_INVALID');
    assert.equal(stepRefused(s1, [{ ...consumeEvent(res, [1n]), generation: 2n as ReservationGeneration }]).code, 'RESERVATION_ID_MISMATCH');
    assert.equal(stepRefused(s1, [restoreEvent(res, [0n])]).code, 'ACCOUNTING_SHAPE_INVALID');
  });

  it('a BUDGET dimension never restores; a demand with both kinds restores only its capacity legs', () => {
    const budget = root({ nonce: 4n, terms: [ALL_MODULES, dim('spend', units(100), { restoration: 'NONE' }), dim('capital', units(100))] });
    const budgetOnly = root({ nonce: 5n, terms: [ALL_MODULES, dim('spend', units(100), { restoration: 'NONE' })] });
    let s = bootstrap(policy(), [budget, budgetOnly]);
    const both = plan({ authority: budget, action: 'both', contributions: [contribution(capital(units(40)))] });
    const only = plan({ authority: budgetOnly, action: 'only', contributions: [contribution(capital(units(40)))] });
    s = reserve(reserve(s, both), only);
    for (const p of [both, only]) {
      const r0 = reservationOf(s, idOf(p));
      s = step(s, [consumeEvent(r0, [units(40)]), closeEvent({ ...r0, demands: r0.demands.map((d) => ({ ...d, consumed: d.reserved })) })]);
    }
    assert.equal(stepRefused(s, [restoreEvent(reservationOf(s, idOf(only)), [units(40)])]).code, 'RESTORE_NOT_PERMITTED');
    s = step(s, [restoreEvent(reservationOf(s, idOf(both)), [units(40)])]);
    assert.deepEqual(figures(nodeBalance(s, budget, 'capital')), [0n, units(40), units(40), units(100)]);
    assert.deepEqual(figures(nodeBalance(s, budget, 'spend')), [0n, units(40), 0n, units(60)]);
  });

  it('refuses an effect whose amount cannot be represented exactly at a leg\'s scale', () => {
    const coarse = root({ nonce: 6n, terms: [ALL_MODULES, dim('capital', 100n, { decimals: 0 })] });
    let s = bootstrap(policy(), [coarse]);
    const p = plan({ authority: coarse, contributions: [contribution(capital(units(10)))] }); // 10.00 at 2 decimals = 10 at 0
    s = reserve(s, p);
    assert.equal(stepRefused(s, [consumeEvent(reservationOf(s, idOf(p)), [150n])]).code, 'INEXACT_RESCALE'); // 1.50 is not a whole unit
    s = step(s, [consumeEvent(reservationOf(s, idOf(p)), [200n])]);
    assert.deepEqual(figures(nodeBalance(s, coarse, 'capital')), [8n, 2n, 0n, 90n]);
  });

  it('refuses an overflow of cumulative consumption in a state no honest history reaches', () => {
    const s1 = reserve(base, cap(units(50)));
    const key = [...s1.targets.sortedKeys()].find((k) => k.includes('capital')) as string;
    const t = s1.targets.get(key);
    assert.ok(t !== undefined);
    const hostile: LedgerState = { ...s1, targets: s1.targets.set(key, { ...t, consumed: UINT256_MAX }) };
    assert.equal(stepRefused(hostile, [consumeEvent(reservationOf(s1, idOf(cap(units(50)))), [1n])]).code, 'AMOUNT_OVERFLOW');
  });
});

describe('charge attribution and restoration', () => {
  const global = dim('global-capital', units(100));
  const r = root({ terms: [ALL_MODULES, DELEGATE(1), dim('capital', units(100))] });
  const a = child(r, { holder: AGENT_A, terms: [ALL_MODULES, dim('capital', units(60))] });
  const b = child(r, { holder: AGENT_B, nonce: 1n, terms: [ALL_MODULES, dim('capital', units(60))] });

  it('restored capacity goes back to the legs originally charged, never to a sibling', () => {
    let s = bootstrap(policy([global]), [r, a, b]);
    const pa = plan({ authority: a, action: 'a', contributions: [contribution(capital(units(40)))] });
    s = reserve(s, pa);
    const ra = reservationOf(s, idOf(pa));
    s = step(s, [consumeEvent(ra, [units(40)]), closeEvent({ ...ra, demands: ra.demands.map((d) => ({ ...d, consumed: d.reserved })) })]);
    assert.deepEqual(reservationOf(s, idOf(pa)).demands[0]?.legs.map((l) => l.ref.kind === 'NODE' ? l.ref.authority : 'POLICY'), [authorityId(a), authorityId(r), 'POLICY']);
    const beforeB = figures(nodeBalance(s, b, 'capital'));
    s = step(s, [restoreEvent(reservationOf(s, idOf(pa)), [units(40)])]);
    assert.deepEqual(figures(nodeBalance(s, a, 'capital')), [0n, units(40), units(40), units(60)]);
    assert.deepEqual(figures(nodeBalance(s, r, 'capital')), [0n, units(40), units(40), units(100)]);
    assert.deepEqual(figures(policyBalance(s, global)), [0n, units(40), units(40), units(100)]);
    assert.deepEqual(figures(nodeBalance(s, b, 'capital')), beforeB);
  });

  it('a sibling cannot restore capacity it never consumed, whoever closes the position', () => {
    let s = bootstrap(policy([global]), [r, a, b]);
    const pa = plan({ authority: a, action: 'a', contributions: [contribution(capital(units(40)))] });
    const pb = plan({ authority: b, action: 'b', contributions: [contribution(capital(units(10)))] });
    s = reserve(reserve(s, pa), pb);
    const ra = reservationOf(s, idOf(pa));
    s = step(s, [consumeEvent(ra, [units(40)])]);
    // B's own reservation consumed nothing, so nothing can be restored through it.
    assert.equal(stepRefused(s, [restoreEvent(reservationOf(s, idOf(pb)), [units(40)])]).code, 'RESTORE_EXCEEDS_CONSUMED');
    // A restoration of A's charge — even one B's close triggered — lands on A's path.
    s = step(s, [restoreEvent(reservationOf(s, idOf(pa)), [units(40)], T0, 'closed-by-b')]);
    assert.equal(nodeBalance(s, b, 'capital').restored, 0n);
    assert.equal(nodeBalance(s, a, 'capital').restored, units(40));
  });

  it('attribution survives any number of partial restores, and never exceeds the charge', () => {
    let s = bootstrap(policy([global]), [r, a]);
    const pa = plan({ authority: a, action: 'a', contributions: [contribution(capital(units(40)))] });
    s = reserve(s, pa);
    s = step(s, [consumeEvent(reservationOf(s, idOf(pa)), [units(40)])]);
    for (const x of [units(10), units(15), units(15)]) s = step(s, [restoreEvent(reservationOf(s, idOf(pa)), [x])]);
    assert.equal(stepRefused(s, [restoreEvent(reservationOf(s, idOf(pa)), [1n])]).code, 'RESTORE_EXCEEDS_CONSUMED');
    assert.equal(reservationOf(s, idOf(pa)).demands[0]?.restored, units(40));
  });
});

describe('reservation generations', () => {
  const r = root({ terms: [ALL_MODULES, dim('capital', units(100))] });
  const gen = (g: bigint, atoms = units(10)) => plan({ authority: r, action: 'retry', generation: g, contributions: [contribution(capital(atoms))] });

  it('are explicit and sequential: first is 1, next only after the previous is closed, never repeated', () => {
    let s = bootstrap(policy(), [r]);
    assert.equal(reserveRefused(s, gen(2n)).code, 'GENERATION_OUT_OF_SEQUENCE');
    s = reserve(s, gen(1n));
    assert.equal(reserveRefused(s, gen(1n)).code, 'RESERVATION_EXISTS');
    assert.equal(reserveRefused(s, gen(2n)).code, 'PREVIOUS_GENERATION_OPEN');
    s = step(s, [closeEvent(reservationOf(s, idOf(gen(1n))))]);
    assert.equal(reserveRefused(s, gen(1n)).code, 'RESERVATION_EXISTS');
    assert.equal(reserveRefused(s, gen(3n)).code, 'GENERATION_OUT_OF_SEQUENCE');
    s = reserve(s, gen(2n));
    assert.notEqual(idOf(gen(1n)), idOf(gen(2n)));
  });

  it('an effect for generation n never mutates generation n + 1', () => {
    let s = bootstrap(policy(), [r]);
    s = reserve(s, gen(1n));
    const g1 = reservationOf(s, idOf(gen(1n)));
    s = step(s, [consumeEvent(g1, [units(4)]), closeEvent({ ...g1, demands: g1.demands.map((d) => ({ ...d, consumed: units(4) })) })]);
    s = reserve(s, gen(2n));
    const g2Before = reservationOf(s, idOf(gen(2n)));
    // Generation 1 is closed: a late fill for it moves nothing.
    assert.equal(stepRefused(s, [consumeEvent(reservationOf(s, g1.id), [1n])]).code, 'RESERVATION_CLOSED');
    // Naming generation 1's reservation as generation 2 is refused, not redirected.
    assert.equal(stepRefused(s, [{ ...consumeEvent(g2Before, [1n]), reservation: g1.id }]).code, 'RESERVATION_ID_MISMATCH');
    assert.equal(stepRefused(s, [{ ...consumeEvent(g2Before, [1n]), generation: 1n as ReservationGeneration }]).code, 'RESERVATION_ID_MISMATCH');
    // Restoring generation 1's consumption credits generation 1's legs and leaves generation 2's record as it was.
    s = step(s, [restoreEvent(reservationOf(s, g1.id), [units(4)])]);
    assert.deepEqual(reservationOf(s, idOf(gen(2n))), g2Before);
    assert.equal(reservationOf(s, g1.id).demands[0]?.restored, units(4));
  });
});

describe('expiry, epochs and time', () => {
  it('expiry refuses new use and releases nothing already reserved', () => {
    const r = root({ expiresAt: T0 + 100n, terms: [ALL_MODULES, dim('capital', units(100))] });
    let s = bootstrap(policy(), [r]);
    const p = plan({ authority: r, contributions: [contribution(capital(units(30)))] });
    s = reserve(s, p, T0 + 50n);
    const after = plan({ authority: r, action: 'later', contributions: [contribution(capital(units(1)))] });
    const refusal = reserveRefused(s, after, T0 + 100n);
    assert.equal(refusal.code, 'AUTHORITY_EXPIRED');
    assert.equal(refusal.code === 'AUTHORITY_EXPIRED' && refusal.node, authorityId(r));
    // The reservation is still held and still reconciles.
    assert.equal(reservationOf(s, idOf(p)).status, 'ACTIVE');
    assert.equal(nodeBalance(s, r, 'capital').reserved, units(30));
    s = step(s, [consumeEvent(reservationOf(s, idOf(p)), [units(30)], T0 + 200n)]);
    assert.deepEqual(figures(nodeBalance(s, r, 'capital'), T0 + 200n), [0n, units(30), 0n, units(70)]);
  });

  it('reading at a later time changes nothing: availability is a pure function of state and time', () => {
    const r = root({ terms: [ALL_MODULES, dim('capital', units(100))] });
    const s = reserve(bootstrap(policy(), [r]), plan({ authority: r, contributions: [contribution(capital(units(30)))] }));
    const bytes = encodeLedgerState(s);
    for (const t of [T0, T0 + DAY, T0 + 365n * DAY]) assert.equal(available(nodeBalance(s, r, 'capital'), t), units(70));
    assert.deepEqual(encodeLedgerState(s), bytes);
  });

  it('an EPOCH budget opens a fresh signed window each epoch, and still counts what is open from before', () => {
    const daily = dim('daily-spend', units(100), { restoration: 'EPOCH', epoch: { anchor: T0, lengthSeconds: DAY } });
    const r = root({ terms: [ALL_MODULES, daily] });
    let s = bootstrap(policy(), [r]);
    const spend = (label: string, atoms: bigint) => plan({ authority: r, action: label, contributions: [contribution(capital(atoms))] });
    s = reserve(s, spend('d0-a', units(60)), T0 + 10n);
    s = step(s, [consumeEvent(reservationOf(s, idOf(spend('d0-a', units(60)))), [units(60)], T0 + 20n)]);
    s = reserve(s, spend('d0-open', units(30)), T0 + 30n);
    assert.equal(available(nodeBalance(s, r, 'daily-spend'), T0 + 40n), units(10));
    // Next day: yesterday's consumption no longer counts; yesterday's still-open reservation does.
    assert.equal(available(nodeBalance(s, r, 'daily-spend'), T0 + DAY + 1n), units(70));
    assert.equal(reserveRefused(s, spend('d1-big', units(71)), T0 + DAY + 1n).code, 'LEDGER_LIMIT_EXCEEDED');
    s = reserve(s, spend('d1', units(70)), T0 + DAY + 1n);
    // A reservation committed before the anchor cannot be attributed to any window.
    const early = root({ nonce: 2n, notBefore: T0 - 100n, terms: [ALL_MODULES, dim('daily-spend', units(100), { restoration: 'EPOCH', epoch: { anchor: T0, lengthSeconds: DAY } })] });
    const s2 = bootstrap(policy(), [early], T0 - 50n);
    assert.equal(reserveRefused(s2, plan({ authority: early, contributions: [contribution(capital(units(1)))] }), T0 - 10n).code, 'EPOCH_NOT_STARTED');
  });

  it('time never regresses on a ledger', () => {
    const r = root({ terms: [ALL_MODULES, dim('capital', units(100))] });
    const s = reserve(bootstrap(policy(), [r]), plan({ authority: r, contributions: [contribution(capital(units(1)))] }), T0 + 100n);
    const e = reserveEvent(s, plan({ authority: r, action: 'b', contributions: [contribution(capital(units(1)))] }), T0 + 99n);
    assert.equal(stepRefused(s, [e]).code, 'EVALUATION_TIME_REGRESSED');
  });
});

describe('who may reserve', () => {
  const r = root({ holder: AGENT_A, terms: [modules(PERP_V1), dim('capital', units(100))] });
  const s = bootstrap(policy(), [r]);

  it('only the leaf\'s holder, for this principal, under an exactly permitted module', () => {
    assert.equal(reserveRefused(s, plan({ authority: r, actor: OUTSIDER })).code, 'ACTOR_NOT_HOLDER');
    assert.equal(reserveRefused(s, plan({ authority: r, principal: P2 })).code, 'PRINCIPAL_MISMATCH');
    assert.equal(reserveRefused(s, plan({ authority: r, module: SPOT_V1 })).code, 'MODULE_NOT_PERMITTED');
    assert.equal(reserveRefused(s, { ...plan({ authority: r }), authority: digestOf('nobody') as never }).code, 'AUTHORITY_UNKNOWN');
    assert.equal(reserveRefused({ ...s, policy: null }, plan({ authority: r })).code, 'PRINCIPAL_POLICY_MISSING');
    assert.equal(reserve(s, plan({ authority: r })).version, s.version + 1n);
  });

  it('records the charge provenance on the reservation: lineage, policy, module, implementation, version', () => {
    const p = plan({ authority: r });
    const s1 = reserve(s, p);
    const rec = reservationOf(s1, idOf(p));
    assert.deepEqual(rec.lineage, [authorityId(r)]);
    assert.equal(rec.policy, s.policy?.id);
    assert.equal(rec.module.moduleDigest, PERP_V1.moduleDigest);
    assert.equal(rec.implementation, p.implementation);
    assert.equal(rec.committedAt, (s.version + 1n) as LedgerVersion);
    assert.equal(rec.action, p.action as ActionId);
  });
});
