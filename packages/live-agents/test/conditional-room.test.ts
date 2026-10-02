/**
 * The Mandate Room is conditional. Under the balanced default (2,500
 * portfolio notional, 400 derivative, 400 illiquid; agents 800 / 500 / 400 /
 * 800 / 400):
 *
 * - individually valid proposals whose typed demand fits every limit go
 *   straight to the verifier: no conflict, no Room, no negotiation call;
 * - a real shared-resource excess (capital, derivative, or an agent's own
 *   domain limit) opens exactly one Room, which has no authority, and its
 *   result is re-verified by the frozen Mandate path;
 * - a hard violation is blocked at screening and never counts toward a
 *   conflict or enters a Room, even when its size would have caused one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerView } from '../src/mandate/portfolio-adapter.ts';
import type { JsonObject } from '../src/runtime/strict-json.ts';
import { keep, propose, reduce, scriptedSession, type Decisions } from './support/session.ts';
import { everyCandidate } from './support/world.ts';

const ROOM_KINDS = ['PORTFOLIO_CONFLICT', 'ROOM_OPENED', 'ROOM_GENERATION_STARTED', 'ROOM_AGENT_RESPONSE', 'ROOM_PROPOSAL_CREATED', 'ROOM_FINALIZED', 'ROOM_NO_FEASIBLE_PORTFOLIO'] as const;
const conflicts = (data: JsonObject) => (data['conflicts'] as JsonObject[]).map((c) => [c['resource'], (c['requiredReduction'] as { amount: string }).amount]);
const negotiationCalls = (t: { provider: { requests: readonly { kind: string }[] } }) => t.provider.requests.filter((r) => r.kind === 'NEGOTIATION').length;

/**
 * 600 + 250 + 300 + 400 + 400 = 1,950 asked of 2,500; derivative 400 of 400; illiquid 300 of 400.
 * Note C's 600 is fee-inclusive: its portfolio notional is the 598.503739 USDC before the gate fee.
 */
const FITS: Decisions = {
  stock: { text: propose('nvda-note-c', 600) },
  swap: { text: propose('route-c', 250) },
  nft: { text: propose('genesis-11', 300) },
  yield: { text: propose('beta-usd-vault', 400) },
  perps: { text: propose('btc-long-2x', 400) },
};

/** 800 + 500 + 300 + 500 + 400 = exactly 2,500, and derivative exactly 400. */
const AT_THE_LIMIT: Decisions = {
  stock: { text: propose('nvda-note-a', 800) },
  swap: { text: propose('route-a', 500) },
  nft: { text: propose('genesis-11', 300) },
  yield: { text: propose('alpha-usd-vault', 500) },
  perps: { text: propose('btc-long-2x', 400) },
};

/** 800 + 500 + 300 + 800 + 400 = 2,800 of 2,500 (reduce 300); derivative 400 fits. */
const CAPITAL_OVER: Decisions = { ...AT_THE_LIMIT, yield: { text: propose('alpha-usd-vault', 800) } };

/** Stock 300 and perps 600: 900 of 2,500 capital, but 600 of 400 derivative notional. */
const DERIVATIVE_OVER: Decisions = { stock: { text: propose('nvda-note-a', 300) }, perps: { text: propose('btc-long-2x', 600) } };

describe('direct authorization: a portfolio that fits never meets the Room', () => {
  for (const [name, decisions, total] of [
    ['five valid proposals well inside every limit', FITS, 1_948_503_739n],
    ['five valid proposals exactly at the capital and derivative limits', AT_THE_LIMIT, 2_500_000_000n],
  ] as const) {
    it(name, async () => {
      const t = await scriptedSession(decisions, () => {
        throw new Error('no negotiation may be asked for');
      });
      const before = (await ledgerView(t.session.versions.active!.core)).reservations.length;
      const result = await t.session.run();
      assert.deepEqual(t.of('PROPOSAL_ADMISSIBLE').map((e) => [e.agent, e.data['portfolioValid']]).sort(), [['nft', true], ['perps', true], ['stock', true], ['swap', true], ['yield', true]]);
      for (const kind of ROOM_KINDS) assert.equal(t.of(kind).length, 0, kind);
      assert.equal(negotiationCalls(t), 0);
      assert.equal(result.room, null);
      // The final verifier still runs, and the ledger reserves.
      assert.equal(t.of('MANDATE_REVERIFY_STARTED').length, 1);
      assert.equal(t.of('PORTFOLIO_AUTHORIZED')[0]?.data['verification'], 'VERIFIED');
      assert.equal(result.status, 'AUTHORIZED');
      assert.equal(result.reservedAtoms, total);
      assert.equal((await ledgerView(t.session.versions.active!.core)).reservations.length, before + 5);
      assert.deepEqual(t.session.reservedExecutions.map((x) => x.role).sort(), ['nft', 'perps', 'stock', 'swap', 'yield']);
    });
  }

  it('a perps request at the derivative limit is no derivative conflict', async () => {
    const t = await scriptedSession({ perps: { text: propose('btc-long-2x', 400) } });
    const result = await t.session.run();
    assert.equal(t.of('ROOM_OPENED').length, 0);
    assert.equal(result.status, 'AUTHORIZED');
  });
});

describe('a real shared-resource conflict opens the Room', () => {
  it('capital: exact typed deficit, one Room, zero authority, re-verified, only the feasible portfolio reserved', async () => {
    const t = await scriptedSession(CAPITAL_OVER, (r) => ({ text: r.role === 'yield' ? reduce(500) : keep }));
    const result = await t.session.run();
    const conflict = t.of('PORTFOLIO_CONFLICT')[0];
    assert.ok(conflict);
    assert.deepEqual(conflicts(conflict.data), [['portfolio-notional', '300']]);
    assert.deepEqual(conflict.data['agentExcess'], []);
    assert.equal(t.of('ROOM_OPENED').length, 1);
    // The Room is handed the authority as a fact; it holds none.
    assert.equal((t.of('ROOM_OPENED')[0]?.data['authority'] as { amount: string }).amount, '2500');
    assert.ok(negotiationCalls(t) >= 1);
    assert.equal(t.of('ROOM_REDUCTION')[0]?.agent, 'yield');
    // The Room's output re-enters the deterministic path as freshly signed proposals.
    const kinds = t.kinds();
    assert.ok(kinds.indexOf('MANDATE_REVERIFY_STARTED') > kinds.indexOf('ROOM_FINALIZED'));
    assert.equal(t.of('PROPOSAL_SIGNED').filter((e) => e.data['phase'] === 'FINAL').length, 5);
    assert.equal(t.of('PORTFOLIO_AUTHORIZED')[0]?.data['verification'], 'VERIFIED');
    assert.equal(result.status, 'AUTHORIZED');
    assert.equal(result.reservedAtoms, 2_500_000_000n);
    assert.equal(result.final.find((f) => f.role === 'yield')?.requested, 500_000_000n);
  });

  it('derivative: a perps request above the derivative limit is a real conflict, never clamped before the Room', async () => {
    const t = await scriptedSession(DERIVATIVE_OVER, (r) => ({ text: r.role === 'perps' ? reduce(400) : keep }));
    const result = await t.session.run();
    const admissible = t.of('PROPOSAL_ADMISSIBLE').find((e) => e.agent === 'perps');
    // The proposal Mandate screened is the model's 600, not a pre-clamped 400.
    assert.equal((admissible?.data['demand'] as { resource: string; amount: string }[]).find((d) => d.resource === 'derivative-notional')?.amount, '600');
    const conflict = t.of('PORTFOLIO_CONFLICT')[0];
    assert.ok(conflict);
    assert.deepEqual(conflicts(conflict.data), [['derivative-notional', '200']]);
    assert.equal(t.of('ROOM_OPENED').length, 1);
    assert.equal(result.status, 'AUTHORIZED');
    const reserved = (await ledgerView(t.session.versions.active!.core)).reservations;
    assert.equal(reserved.length, 2);
    assert.equal(result.final.find((f) => f.role === 'perps')?.requested, 400_000_000n);
  });

  it('the Room opens once per run, and its generations are numbered without repetition', async () => {
    const t = await scriptedSession(CAPITAL_OVER, (r) => ({ text: r.generation === 1 ? keep : r.role === 'yield' ? reduce(500) : keep }), { maxGenerations: 3 });
    const result = await t.session.run();
    assert.equal(t.of('ROOM_OPENED').length, 1);
    assert.equal(t.of('PORTFOLIO_CONFLICT').length, 1);
    assert.deepEqual(t.of('ROOM_GENERATION_STARTED').map((e) => e.generation), [1, 2]);
    assert.equal(t.of('ROOM_FINALIZED').length, 1);
    assert.equal(result.status, 'AUTHORIZED');
  });

  it('no feasible portfolio: no authorization, no reservation, no executor call', async () => {
    const t = await scriptedSession(CAPITAL_OVER, () => ({ text: keep }), { maxGenerations: 2 });
    const before = await ledgerView(t.session.versions.active!.core);
    const result = await t.session.run();
    assert.equal(result.status, 'NO_FEASIBLE_PORTFOLIO');
    assert.equal(t.of('MANDATE_REVERIFY_STARTED').length, 0);
    assert.equal(t.of('PORTFOLIO_AUTHORIZED').length, 0);
    assert.equal(result.executorCalls, 0);
    assert.equal(t.session.reservedExecutions.length, 0);
    assert.deepEqual(await ledgerView(t.session.versions.active!.core), before);
  });
});

describe('hard violations are blocked, never negotiated', () => {
  // Eligibility is bypassed so each forbidden candidate actually reaches Mandate's screening. The other four
  // proposals fit (2,000 to 2,500 of 2,500); counted with the forbidden one, every set below would be over.
  for (const [role, id, size, code] of [
    ['stock', 'nvda-token-b', 800, 'REGISTRY'],
    ['swap', 'route-b', 500, 'VENUE_NOT_ALLOWED'],
    ['yield', 'high-yield-usd', 800, 'ISSUER_NOT_ALLOWED'],
    ['nft', 'genesis-7', 240, 'ASSET_NOT_ALLOWED'],
    ['perps', 'btc-long-5x', 600, 'LEVERAGE_NOT_ALLOWED'],
  ] as const) {
    it(`${role}/${id}: BLOCKED with ${code}, not counted toward any conflict, no Room, no reservation`, async () => {
      const t = await scriptedSession({ ...CAPITAL_OVER, [role]: { text: propose(id, size) } }, () => {
        throw new Error('no negotiation may be asked for');
      }, { eligibility: everyCandidate, settlement: null });
      const result = await t.session.run();
      const blocked = t.of('PROPOSAL_BLOCKED');
      assert.deepEqual(blocked.map((e) => e.agent), [role]);
      assert.ok((blocked[0]?.data['reasons'] as string[]).some((r) => r.split(':')[0] === code), JSON.stringify(blocked[0]?.data['reasons']));
      for (const kind of ROOM_KINDS) assert.equal(t.of(kind).length, 0, kind);
      assert.equal(negotiationCalls(t), 0);
      assert.ok(!t.session.reservedExecutions.some((x) => x.role === role));
      assert.equal(result.status, 'AUTHORIZED');
      assert.equal(t.session.reservedExecutions.length, 4);
    });
  }
});
