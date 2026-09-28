/**
 * The engine against a slow, independent reference model of the synthetic
 * module's authorization (brief §59). The model does its own arithmetic from
 * the scenario's numbers — no production projection, admission or ledger
 * code — and predicts the outcome of every step of randomized sequences:
 * random authority trees' limits, held state, marks, pending reservations,
 * lineage and principal-global invariants, stale and missing state, and new
 * actions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_A,
  ONCE,
  T,
  account,
  action,
  aggregate,
  capitalDim,
  child,
  context,
  instrumentsState,
  int,
  markState,
  maxExposure,
  pick,
  policy,
  positionState,
  prng,
  request,
  root,
  setup,
  assetValuedModules,
  world,
  type SyntheticModule,
} from './support/world.ts';

/** The model's arithmetic: USD cents from a 4-decimal size and a 2-decimal price, rounded up; capital ÷ leverage, rounded up. */
function cents(size: bigint, price: bigint): bigint {
  const raw = size * price;
  return raw / 10_000n + (raw % 10_000n === 0n ? 0n : 1n);
}
function capital(size: bigint, limit: bigint, leverage: bigint): bigint {
  const notional = cents(size, limit);
  return notional / leverage + (notional % leverage === 0n ? 0n : 1n);
}

describe('reference model', () => {
  it('predicts every outcome of 30 randomized sequences', async () => {
    let steps = 0;
    const outcomes = new Map<string, number>();
    for (let seed = 1; seed <= 30; seed += 1) {
      const rand = prng(seed * 7919);
      const w = world({ modules: assetValuedModules() });
      const m = w.modules[0] as SyntheticModule;
      const acct = account(m);
      const rootCap = BigInt(int(rand, 50, 200)) * 10_000n;
      const agentCap = BigInt(int(rand, 20, Number(rootCap / 10_000n))) * 10_000n;
      const lineageLimit = int(rand, 50, 300) * 100;
      const globalLimit = int(rand, 50, 300) * 100;
      const heldSize = BigInt(int(rand, 0, 30)) * 10n;
      const mark = pick(rand, [9_000_000n, 10_000_000n, 11_000_000n]);
      const r0 = root({ mods: [m], delegate: 1, terms: [capitalDim('capital', Number(rootCap / 100n)), maxExposure(m, acct, lineageLimit)] });
      const a = child(r0, { mods: [m], holder: AGENT_A, terms: [capitalDim('capital', Number(agentCap / 100n)), maxExposure(m, acct, lineageLimit)] });
      await setup(w, policy([aggregate({ whole: globalLimit, contributors: [m], accounts: [acct] })]), [r0, a]);

      const pending: bigint[] = [];
      let usedRoot = 0n;
      let usedAgent = 0n;
      for (let step = 0; step < 20; step += 1) {
        const size = BigInt(int(rand, 1, 30)) * 10n;
        const leverage = BigInt(int(rand, 1, 3));
        const limit = mark + BigInt(int(rand, 0, 5)) * 100_000n;
        const mode = pick(rand, ['OK', 'OK', 'OK', 'OK', 'OK', 'OK', 'STALE', 'MISSING'] as const);
        const states = [
          markState(m, 'x:BTC-PERP', mark, { observedAt: mode === 'STALE' ? T - 40n : T }),
          instrumentsState(m),
          ...(mode === 'MISSING' ? [] : [positionState(m, acct, heldSize === 0n ? [] : [{ localId: 'x:BTC-PERP', size: heldSize }])]),
        ];
        // The model.
        let expected: string;
        const exposure = cents(heldSize, mark) + pending.reduce((s, p) => s + cents(p, mark), 0n) + cents(size, mark);
        const need = capital(size, limit, leverage);
        if (mode === 'STALE') expected = 'STATE_STALE';
        else if (mode === 'MISSING') expected = 'STATE_MISSING';
        else if (exposure > BigInt(lineageLimit) * 100n || exposure > BigInt(globalLimit) * 100n) expected = 'INVARIANT_FAILED';
        else if (usedRoot + need > rootCap || usedAgent + need > agentCap) expected = 'AUTHORITY_UNAVAILABLE';
        else expected = 'AUTHORIZED';

        const out = await w.engine.authorizeAndReserve(
          request(action(m, { authority: a, size, limitPrice: limit, leverage: { numerator: leverage, scale: 0 }, nonce: BigInt(step) }), states, context([m], { accounts: [{ module: m, account: acct }] })),
          ONCE,
        );
        const actual = out.status === 'AUTHORIZED' ? 'AUTHORIZED' : out.refusal.code;
        assert.equal(actual, expected, `seed ${seed} step ${step}`);
        if (expected === 'AUTHORIZED') {
          pending.push(size);
          usedRoot += need;
          usedAgent += need;
        }
        outcomes.set(expected, (outcomes.get(expected) ?? 0) + 1);
        steps += 1;
      }
    }
    assert.equal(steps, 600);
    // Every outcome occurred, so the comparison was not vacuous.
    for (const k of ['AUTHORIZED', 'STATE_STALE', 'STATE_MISSING', 'INVARIANT_FAILED', 'AUTHORITY_UNAVAILABLE']) assert.ok((outcomes.get(k) ?? 0) > 0, k);
  });
});
