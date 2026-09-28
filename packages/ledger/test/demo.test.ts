/**
 * The Mandate thesis, as a deterministic fixture: autonomous agents under
 * different roots and in different domains cannot together consume more
 * authority than the principal granted or globally permitted.
 *
 * Two shapes, both with one principal-global capital limit of 10,000:
 *
 * 1. **One delegation tree.** Trading (8,000) delegates to SpotAgent (6,000)
 *    and PerpAgent (5,000). SpotAgent reserves 6,000. PerpAgent, racing it,
 *    asks for 5,000: its own ceiling passes; the root has 2,000 left and the
 *    principal 4,000 — refused, naming both. 2,000 then passes.
 * 2. **Two independent roots.** Spot root (8,000) and Perp root (5,000), whose
 *    only shared quantitative constraint is the principal policy. SpotAgent
 *    reserves 6,000; PerpAgent's 5,000 passes its own root and is refused by
 *    the policy alone. 4,000 then passes, filling the principal to 10,000.
 *
 * Fixture data only: the modules, assets and amounts are placeholders.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authorityId } from '@mandate/core';
import { AuthorityLedger, InMemoryLedgerStore, previewCharge, type LimitFailure } from '../src/index.ts';
import {
  DELEGATE,
  ONCE,
  PERP_AGENT,
  PERP_V1,
  PRINCIPAL,
  REGISTRY,
  RETRY,
  SPOT_AGENT,
  SPOT_V1,
  T0,
  TRADING,
  USDG_PERP,
  capital,
  child,
  committed,
  contribution,
  dim,
  modules,
  must,
  nodeBalance,
  plan,
  policy,
  policyBalance,
  refused,
  root,
  setup,
  units,
  available,
} from './support/fixtures.ts';

const GLOBAL_CAPITAL = dim('GLOBAL_CAPITAL', units(10_000));
const spot = (g: Parameters<typeof plan>[0]['authority'], label: string, n: number) =>
  plan({ authority: g, module: SPOT_V1, action: label, contributions: [contribution(capital(units(n)))] });
const perp = (g: Parameters<typeof plan>[0]['authority'], label: string, n: number) =>
  plan({ authority: g, module: PERP_V1, action: label, contributions: [contribution(capital(units(n), USDG_PERP))] });

function describeFailure(f: LimitFailure, names: Map<string, string>): string {
  const where = f.target.kind === 'NODE' ? (names.get(f.target.authority) ?? '?') : 'PrincipalPolicy';
  return `${where}/${f.target.dimensionId}: requested ${f.requested / 100n}, available ${f.available / 100n}`;
}

describe('thesis: one delegation tree under a principal-global limit', () => {
  const trading = root({ holder: TRADING, terms: [modules(SPOT_V1, PERP_V1), DELEGATE(1), dim('capital', units(8_000))] });
  const spotAgent = child(trading, { holder: SPOT_AGENT, terms: [modules(SPOT_V1), dim('capital', units(6_000))] });
  const perpAgent = child(trading, { holder: PERP_AGENT, nonce: 1n, terms: [modules(PERP_V1), dim('capital', units(5_000))] });
  const names = new Map([
    [authorityId(trading), 'Trading'],
    [authorityId(spotAgent), 'SpotAgent'],
    [authorityId(perpAgent), 'PerpAgent'],
  ]);

  it('PerpAgent\'s 5,000 passes locally and is refused by the root and the principal; 2,000 then passes', async () => {
    let perpRead = false;
    const store: InMemoryLedgerStore = new InMemoryLedgerStore({
      delay: async (point) => {
        // PerpAgent has read the ledger and is about to commit; SpotAgent commits first.
        if (point === 'COMMIT' && perpRead) {
          perpRead = false;
          committed(await new AuthorityLedger(store, REGISTRY).reserve(spot(spotAgent, 'spot-6000', 6_000), T0, ONCE));
        }
      },
    });
    const ledger = new AuthorityLedger(store, REGISTRY);
    const s0 = await setup(ledger, policy([GLOBAL_CAPITAL]), [trading, spotAgent, perpAgent]);

    // What PerpAgent sees before the race: every leg of its path has room.
    const view = must(previewCharge(s0.state, perp(perpAgent, 'perp-5000', 5_000), T0))[0] ?? [];
    assert.deepEqual(view.map((l) => [l.target.kind === 'NODE' ? names.get(l.target.authority) : 'PrincipalPolicy', l.available / 100n]), [
      ['PerpAgent', 5_000n],
      ['Trading', 8_000n],
      ['PrincipalPolicy', 10_000n],
    ]);

    perpRead = true;
    const out = await ledger.reserve(perp(perpAgent, 'perp-5000', 5_000), T0, RETRY);
    const refusal = refused(out);
    assert.equal(out.status === 'REFUSED' && out.attempts, 2); // lost the CAS, recomputed, refused
    assert.equal(refusal.code, 'LEDGER_LIMIT_EXCEEDED');
    assert.deepEqual(refusal.code === 'LEDGER_LIMIT_EXCEEDED' && refusal.failures.map((f) => describeFailure(f, names)), [
      'Trading/capital: requested 5000, available 2000',
      'PrincipalPolicy/GLOBAL_CAPITAL: requested 5000, available 4000',
    ]);
    // Its own ceiling was never the problem.
    const s1 = await ledger.read(PRINCIPAL);
    assert.equal(available(nodeBalance(s1.state, perpAgent, 'capital')), units(5_000));

    const s2 = committed(await ledger.reserve(perp(perpAgent, 'perp-2000', 2_000), T0, ONCE));
    assert.equal(available(nodeBalance(s2.state, trading, 'capital')), 0n);
    assert.equal(available(policyBalance(s2.state, GLOBAL_CAPITAL)), units(2_000));
    assert.equal(available(nodeBalance(s2.state, perpAgent, 'capital')), units(3_000));
    assert.equal(available(nodeBalance(s2.state, spotAgent, 'capital')), 0n);
  });
});

describe('thesis: two independent roots, one principal-global limit', () => {
  const spotRoot = root({ holder: SPOT_AGENT, terms: [modules(SPOT_V1), dim('capital', units(8_000))] });
  const perpRoot = root({ holder: PERP_AGENT, nonce: 1n, terms: [modules(PERP_V1), dim('capital', units(5_000))] });
  const names = new Map([
    [authorityId(spotRoot), 'SpotRoot'],
    [authorityId(perpRoot), 'PerpRoot'],
  ]);

  it('the policy is the only shared constraint, and it is enough', async () => {
    const ledger = new AuthorityLedger(new InMemoryLedgerStore(), REGISTRY);
    await setup(ledger, policy([GLOBAL_CAPITAL]), [spotRoot, perpRoot]);
    committed(await ledger.reserve(spot(spotRoot, 'spot-6000', 6_000), T0, ONCE));
    const refusal = refused(await ledger.reserve(perp(perpRoot, 'perp-5000', 5_000), T0, ONCE));
    assert.deepEqual(refusal.code === 'LEDGER_LIMIT_EXCEEDED' && refusal.failures.map((f) => describeFailure(f, names)), ['PrincipalPolicy/GLOBAL_CAPITAL: requested 5000, available 4000']);
    const s = committed(await ledger.reserve(perp(perpRoot, 'perp-4000', 4_000), T0, ONCE));
    assert.equal(available(policyBalance(s.state, GLOBAL_CAPITAL)), 0n);
    assert.equal(available(nodeBalance(s.state, perpRoot, 'capital')), units(1_000));
    assert.equal(available(nodeBalance(s.state, spotRoot, 'capital')), units(2_000));
    // With an empty policy the same two roots are independent: nothing aggregates them.
    const free = new AuthorityLedger(new InMemoryLedgerStore(), REGISTRY);
    await setup(free, policy([]), [spotRoot, perpRoot]);
    committed(await free.reserve(spot(spotRoot, 'spot-6000', 6_000), T0, ONCE));
    committed(await free.reserve(perp(perpRoot, 'perp-5000', 5_000), T0, ONCE));
  });
});
