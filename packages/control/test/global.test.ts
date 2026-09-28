/**
 * Principal-global state invariants across roots and domains (AUTH-GLOBAL-1
 * state-invariant portion; authority-model.md §8; brief §22, §23, §40, §41,
 * §65). The aggregate is Core's: it sums only facts that each contributing
 * module mapped to exactly the scoped canonical asset.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { StateInvariantInput } from '@mandate/core';
import { AuthorityLedger } from '@mandate/ledger';
import { controlRules, type InvariantResult } from '../src/index.ts';
import {
  AGENT_A,
  AGENT_B,
  AGENT_C,
  BTC,
  ONCE,
  RETRY,
  T,
  SPOT_CFG,
  PERP_CFG,
  account,
  action,
  aggregate,
  authorized,
  capitalDim,
  context,
  createSyntheticModule,
  evidenceFor,
  marketStates,
  maxExposure,
  policy,
  refused,
  request,
  root,
  setup,
  sizeFor,
  usd,
  world,
  type SyntheticModule,
} from './support/world.ts';

interface Book {
  readonly localId: string;
  readonly size: bigint;
}

async function twoRoots(o: { limit: number; spot?: readonly Book[]; perp?: readonly Book[]; contributors?: 'BOTH' | 'PERP_ONLY'; extraPolicy?: readonly StateInvariantInput[]; modules?: readonly SyntheticModule[] }) {
  const w = world(o.modules === undefined ? {} : { modules: o.modules });
  const perp = w.modules[0] as SyntheticModule;
  const spot = w.modules[1] as SyntheticModule;
  const acctS = account(spot);
  const acctP = account(perp);
  const contributors = o.contributors === 'PERP_ONLY' ? [perp] : [spot, perp];
  const agg = aggregate({ whole: o.limit, contributors, accounts: [acctS, acctP] });
  // Each root is generous on its own: 100,000 of capital and no local invariant it could fail.
  const rootA = root({ mods: [spot], holder: AGENT_A, terms: [capitalDim('capital', 100_000)] });
  const rootB = root({ mods: [perp], holder: AGENT_B, nonce: 1n, terms: [capitalDim('capital', 100_000)] });
  await setup(w, policy([agg, ...(o.extraPolicy ?? [])]), [rootA, rootB]);
  const states = [...marketStates(spot, [{ account: acctS, positions: o.spot ?? [] }]), ...marketStates(perp, [{ account: acctP, positions: o.perp ?? [] }])];
  const ctx = context([perp, spot], { accounts: [{ module: spot, account: acctS }, { module: perp, account: acctP }] });
  return { w, perp, spot, acctS, acctP, rootA, rootB, states, ctx };
}

function policyResult(results: readonly InvariantResult[]): InvariantResult {
  const r = results.find((x) => x.origin === 'POLICY');
  assert.ok(r !== undefined);
  return r;
}

describe('principal-global aggregate across roots', () => {
  it('spot 4,000 + perp 3,000 + 1,000 = 8,000 > 6,000 refuses; under 8,500 the same action passes (brief §22)', async () => {
    const held = { spot: [{ localId: 'x:BTC-SPOT', size: sizeFor(4_000) }], perp: [{ localId: 'x:BTC-PERP', size: sizeFor(3_000) }] };
    const tight = await twoRoots({ limit: 6_000, ...held });
    const r = refused(await tight.w.engine.authorizeAndReserve(request(action(tight.perp, { authority: tight.rootB, size: sizeFor(1_000) }), tight.states, tight.ctx), RETRY));
    assert.equal(r.code, 'INVARIANT_FAILED');
    assert.equal(r.reason, 'AGGREGATE_LIMIT_EXCEEDED');
    assert.ok(r.detail.kind === 'INVARIANTS');
    if (r.detail.kind === 'INVARIANTS') {
      const g = policyResult(r.detail.results);
      assert.deepEqual(g.evaluator, { kind: 'CORE' });
      assert.deepEqual(g.observed, { type: 'TOTAL', kind: 'GROSS_EXPOSURE', unit: 'USD', decimals: 2, atoms: usd(8_000) });
      assert.deepEqual(g.bound, { type: 'TOTAL', kind: 'GROSS_EXPOSURE', unit: 'USD', decimals: 2, atoms: usd(6_000) });
      // Evidence: the admitted snapshots of both modules.
      assert.ok(g.states.length >= 4);
    }
    const loose = await twoRoots({ limit: 8_500, ...held });
    authorized(await loose.w.engine.authorizeAndReserve(request(action(loose.perp, { authority: loose.rootB, size: sizeFor(1_000) }), loose.states, loose.ctx), RETRY));
  });

  it('each root permits the action locally; only the principal-global projection refuses it (brief §41)', async () => {
    const s = await twoRoots({ limit: 5_000, spot: [{ localId: 'x:BTC-SPOT', size: sizeFor(3_000) }] });
    // Spot-like agent A and perp-like agent B each propose 1,500 under their own roots.
    authorized(await s.w.engine.authorizeAndReserve(request(action(s.spot, { authority: s.rootA, size: sizeFor(1_500) }), s.states, s.ctx), RETRY));
    const r = refused(await s.w.engine.authorizeAndReserve(request(action(s.perp, { authority: s.rootB, size: sizeFor(1_500) }), s.states, s.ctx), RETRY));
    assert.equal(r.code, 'INVARIANT_FAILED');
    // Nothing for B was reserved: exactly one reservation exists.
    const snap = await s.w.store.read(s.rootA.principal);
    assert.equal(snap.state.reservations.size, 1);
  });

  it('never matches by name: a WBTC-like market mapped to another canonical asset, and ETH, are not BTC (brief §23)', async () => {
    const spot = createSyntheticModule({
      ...SPOT_CFG,
      markets: [
        { localId: 'x:BTC-SPOT', asset: BTC },
        { localId: 'x:WBTC-SPOT', asset: { domain: 'registry', kind: 'CANONICAL_ASSET', localId: 'crypto:wbtc' } },
        { localId: 'x:ETH-SPOT', asset: { domain: 'registry', kind: 'CANONICAL_ASSET', localId: 'crypto:eth' } },
      ],
    });
    const perp = createSyntheticModule(PERP_CFG);
    const s = await twoRoots({
      limit: 5_000,
      modules: [perp, spot],
      spot: [
        { localId: 'x:WBTC-SPOT', size: sizeFor(40_000) },
        { localId: 'x:ETH-SPOT', size: sizeFor(40_000) },
        { localId: 'x:BTC-SPOT', size: sizeFor(1_000) },
      ],
    });
    const d = await s.w.engine.decide(request(action(s.perp, { authority: s.rootB, size: sizeFor(3_000) }), s.states, s.ctx));
    assert.ok(d.ok, d.ok ? '' : `${d.error.code}/${d.error.reason} at ${d.error.path}`);
    if (d.ok) assert.deepEqual(policyResult(d.value.invariants).observed, { type: 'TOTAL', kind: 'GROSS_EXPOSURE', unit: 'USD', decimals: 2, atoms: usd(4_000) });
  });

  it('a consulted module the policy does not list as a contributor makes the aggregate UNKNOWN (fail closed)', async () => {
    const s = await twoRoots({ limit: 1_000_000, contributors: 'PERP_ONLY' });
    const r = refused(await s.w.engine.authorizeAndReserve(request(action(s.spot, { authority: s.rootA, size: sizeFor(100) }), s.states, s.ctx), RETRY));
    assert.equal(r.code, 'INVARIANT_UNKNOWN');
    assert.equal(r.reason, 'UNDECLARED_CONTRIBUTOR');
  });

  it('a contributor with no conforming implementation makes the aggregate UNKNOWN', async () => {
    const perp = createSyntheticModule(PERP_CFG);
    const ghost = createSyntheticModule({ ...SPOT_CFG, moduleId: 'ghost-like' });
    const w = world({ modules: [perp], register: [{ module: ghost.ref, implementations: [ghost.implementation] }] });
    const acctP = account(perp);
    const agg: StateInvariantInput = aggregate({ whole: 1_000_000, contributors: [perp, ghost], accounts: [acctP] });
    const r0 = root({ mods: [perp], holder: AGENT_B, terms: [capitalDim('capital', 100_000)] });
    await setup(w, policy([agg]), [r0]);
    const r = refused(await w.engine.authorizeAndReserve(request(action(perp, { authority: r0, size: sizeFor(100) }), marketStates(perp, [{ account: acctP }]), context([perp], { accounts: [{ module: perp, account: acctP }] })), RETRY));
    assert.equal(r.code, 'INVARIANT_UNKNOWN');
    assert.equal(r.reason, 'CONTRIBUTOR_UNAVAILABLE');
  });

  it('an invariant no loaded module defines is UNKNOWN, and every applicable invariant is reported, not only the first failure', async () => {
    const s = await twoRoots({
      limit: 1_000,
      extraPolicy: [{ kind: 'STATE_INVARIANT', invariantId: 'nobody.defines-this', version: 1, scope: [], params: '0x01' }],
    });
    const r = refused(await s.w.engine.authorizeAndReserve(request(action(s.perp, { authority: s.rootB, size: sizeFor(2_000) }), s.states, s.ctx), RETRY));
    // A violation outranks an unknown in the code; both are in the evidence.
    assert.equal(r.code, 'INVARIANT_FAILED');
    assert.ok(r.detail.kind === 'INVARIANTS');
    if (r.detail.kind === 'INVARIANTS') {
      assert.deepEqual(r.detail.results.map((x) => x.outcome).sort(), ['UNKNOWN', 'VIOLATED']);
      assert.ok(r.detail.results.some((x) => x.reason === 'INVARIANT_DEFINITION_UNRESOLVED'));
    }
  });

  it('an aggregate that cannot be read — no contributors, no asset in scope — is UNKNOWN, never skipped', async () => {
    for (const bad of [
      aggregate({ whole: 1, contributors: [], accounts: [] }),
      { ...aggregate({ whole: 1, contributors: [createSyntheticModule(PERP_CFG)], accounts: [] }), scope: [] },
    ]) {
      const s = await twoRoots({ limit: 1_000_000, extraPolicy: [bad] });
      const r = refused(await s.w.engine.authorizeAndReserve(request(action(s.perp, { authority: s.rootB, size: sizeFor(100) }), s.states, s.ctx), RETRY));
      assert.equal(r.code, 'INVARIANT_UNKNOWN');
      assert.match(r.reason, /^AGGREGATE_/);
    }
  });
});

describe('end-to-end offline scenario: pending state across agents and roots (brief §40, §65)', () => {
  it('1,500 filled + 2,500 pending + 2,000 proposed = 6,000 > 5,000 refuses; 1,000 passes; releasing the pending lets 2,000 pass', async () => {
    const s = await twoRoots({ limit: 5_000, spot: [{ localId: 'x:BTC-SPOT', size: sizeFor(1_500) }] });
    // Agent A's unresolved 2,500 (1,500 + 2,500 = 4,000 ≤ 5,000).
    const pendingA = authorized(await s.w.engine.authorizeAndReserve(request(action(s.spot, { authority: s.rootA, size: sizeFor(2_500) }), s.states, s.ctx), RETRY));

    // Agent B's root permits 2,000, and so does the ledger: its capital has 100,000 of headroom.
    const d = await s.w.engine.decide(request(action(s.perp, { authority: s.rootB, size: sizeFor(2_000) }), s.states, s.ctx));
    assert.ok(!d.ok);
    const r = refused(await s.w.engine.authorizeAndReserve(request(action(s.perp, { authority: s.rootB, size: sizeFor(2_000) }), s.states, s.ctx), RETRY));
    assert.equal(r.code, 'INVARIANT_FAILED');
    if (r.detail.kind === 'INVARIANTS') {
      const g = policyResult(r.detail.results);
      assert.equal(g.outcome, 'VIOLATED');
      assert.deepEqual(g.observed, { type: 'TOTAL', kind: 'GROSS_EXPOSURE', unit: 'USD', decimals: 2, atoms: usd(6_000) });
      assert.deepEqual(g.reservations, [pendingA.reservation]);
    }

    // A smaller permitted action reserves: 1,500 + 2,500 + 1,000 = 5,000.
    const small = authorized(await s.w.engine.authorizeAndReserve(request(action(s.perp, { authority: s.rootB, size: sizeFor(1_000), nonce: 1n }), s.states, s.ctx), RETRY));
    assert.ok(small.ledgerVersionCommitted > pendingA.ledgerVersionCommitted);

    // Release A's reservation through the test-only infrastructure transition (the ledger's raw CLOSE).
    const infra = new AuthorityLedger(s.w.store, s.w.registry, controlRules(s.w.catalog));
    const closed = await infra.settle(pendingA.principal, [{ kind: 'CLOSE', reservation: pendingA.reservation, generation: pendingA.generation, evidence: evidenceFor('test-release') }], T, ONCE);
    assert.equal(closed.status, 'COMMITTED');
    // Now 1,500 + 1,000 (B's) + 2,000 = 4,500.
    authorized(await s.w.engine.authorizeAndReserve(request(action(s.perp, { authority: s.rootB, size: sizeFor(2_000), nonce: 2n }), s.states, s.ctx), RETRY));
  });

  it('the same pending state is seen whichever agent under whichever root acts', async () => {
    const s = await twoRoots({ limit: 5_000 });
    authorized(await s.w.engine.authorizeAndReserve(request(action(s.perp, { authority: s.rootB, size: sizeFor(4_000) }), s.states, s.ctx), RETRY));
    const rootC = root({ mods: [s.spot], holder: AGENT_C, nonce: 7n, terms: [capitalDim('capital', 100_000)] });
    const reg = await s.w.engine.registerDelegation(rootC, T, ONCE);
    assert.equal(reg.status, 'REGISTERED');
    const r = refused(await s.w.engine.authorizeAndReserve(request(action(s.spot, { authority: rootC, size: sizeFor(1_010) }), s.states, s.ctx), RETRY));
    assert.equal(r.code, 'INVARIANT_FAILED');
  });

  it('a lineage invariant still applies to its own root, next to the policy\'s', async () => {
    const s = await twoRoots({ limit: 100_000 });
    const tight = root({ mods: [s.perp], holder: AGENT_C, nonce: 9n, terms: [capitalDim('capital', 100_000), maxExposure(s.perp, s.acctP, 1_000)] });
    assert.equal((await s.w.engine.registerDelegation(tight, T, ONCE)).status, 'REGISTERED');
    const r = refused(await s.w.engine.authorizeAndReserve(request(action(s.perp, { authority: tight, size: sizeFor(1_500) }), s.states, s.ctx), RETRY));
    assert.equal(r.code, 'INVARIANT_FAILED');
    assert.equal(r.reason, 'EXPOSURE_LIMIT_EXCEEDED');
  });
});
