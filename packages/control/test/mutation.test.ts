/**
 * Mutation testing for 7D (brief §58). Each mutant changes exactly one thing
 * — a pipeline stage, the CAS loop, module resolution, or one module rule —
 * and a safety probe that holds for production code must fail for it. The
 * pipeline's stages are internal (not exported from the package), so the
 * mutants are built here from the same stages production uses.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bindState, moduleRefsEqual, resourceIdsEqual, stateBindingId, stateRequirementInputOf, type ModuleRef } from '@mandate/core';
import { deriveReserveEvent, nodeTargetKey, type TargetBalance } from '@mandate/ledger';
import { admitNeeds, type Admission } from '../src/admission.ts';
import { controlRules, type ControlResult, type ModuleCatalog } from '../src/index.ts';
import { PRODUCTION_PIPELINE, decideWith, type AuthorizationRequest, type Decision, type Pipeline } from '../src/pipeline.ts';
import { reservationFacts } from '../src/facts.ts';
import {
  AGENT_A,
  AGENT_B,
  ONCE,
  PERP_CFG,
  PRICE,
  RETRY,
  T,
  T0,
  account,
  action,
  aggregate,
  capitalDim,
  child,
  context,
  createSyntheticModule,
  markState,
  instrumentsState,
  marketStates,
  maxExposure,
  maxLeverage,
  notionalDim,
  policy,
  positionState,
  request,
  root,
  setup,
  sizeFor,
  syntheticRef,
  usd,
  world,
  type SyntheticModule,
  type World,
} from './support/world.ts';

type Status = 'AUTHORIZED' | 'REFUSED';

/** The engine's CAS loop with an injectable pipeline — the only difference from `ControlEngine.authorizeAndReserve`. */
async function reserveWith(p: Pipeline, w: World, req: AuthorizationRequest, catalog: ModuleCatalog = w.catalog): Promise<{ status: Status; decision: ControlResult<Decision> }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const s = await w.store.read(req.action.principal);
    const d = decideWith(p, s, req, { catalog, registry: w.registry, rules: controlRules(w.catalog) });
    if (!d.ok) return { status: 'REFUSED', decision: d };
    const c = await w.store.compareAndAppend(s.principal, s.version, s.head, [d.value.event]);
    if (c.status === 'COMMITTED') return { status: 'AUTHORIZED', decision: d };
    if (c.status === 'REFUSED') return { status: 'REFUSED', decision: d };
  }
  return { status: 'REFUSED', decision: { ok: false, error: null as never } };
}

async function singleAccount(limit: number) {
  const w = world();
  const m = w.modules[0] as SyntheticModule;
  const acct = account(m);
  const r0 = root({ mods: [m], delegate: 1, terms: [capitalDim('capital', 1_000_000), notionalDim('btc-notional', 1_000_000), maxExposure(m, acct, limit)] });
  const a = child(r0, { mods: [m], holder: AGENT_A, terms: [maxExposure(m, acct, limit)] });
  const b = child(r0, { mods: [m], holder: AGENT_B, nonce: 1n, terms: [maxExposure(m, acct, limit)] });
  await setup(w, policy(), [r0, a, b]);
  const ctx = context([m], { accounts: [{ module: m, account: acct }] });
  return { w, m, acct, r0, a, b, ctx };
}

// --- Probes: each returns true iff the safety property holds under `p` -------------

/** Filled 2,000 + pending 2,000 + new 2,000 must not pass a 5,000 limit (brief §12). */
async function pendingProbe(p: Pipeline): Promise<boolean> {
  const f = await singleAccount(5_000);
  const held = marketStates(f.m, [{ account: f.acct, positions: [{ localId: 'x:BTC-PERP', size: sizeFor(2_000) }] }]);
  const first = await reserveWith(p, f.w, request(action(f.m, { authority: f.a, size: sizeFor(2_000) }), held, f.ctx));
  assert.equal(first.status, 'AUTHORIZED');
  return (await reserveWith(p, f.w, request(action(f.m, { authority: f.b, size: sizeFor(2_000), nonce: 1n }), held, f.ctx))).status === 'REFUSED';
}

/** A held 4,000 must count: +2,000 against 5,000 refuses. */
async function heldStateProbe(p: Pipeline): Promise<boolean> {
  const f = await singleAccount(5_000);
  const held = marketStates(f.m, [{ account: f.acct, positions: [{ localId: 'x:BTC-PERP', size: sizeFor(4_000) }] }]);
  return (await reserveWith(p, f.w, request(action(f.m, { authority: f.a, size: sizeFor(2_000) }), held, f.ctx))).status === 'REFUSED';
}

/** Two roots each within their own authority must not together pass a principal-global 5,000 (brief §41). */
async function globalProbe(p: Pipeline): Promise<boolean> {
  const w = world();
  const perp = w.modules[0] as SyntheticModule;
  const spot = w.modules[1] as SyntheticModule;
  const acctS = account(spot);
  const acctP = account(perp);
  const ra = root({ mods: [spot], holder: AGENT_A, terms: [capitalDim('capital', 100_000)] });
  const rb = root({ mods: [perp], holder: AGENT_B, nonce: 1n, terms: [capitalDim('capital', 100_000)] });
  await setup(w, policy([aggregate({ whole: 5_000, contributors: [spot, perp], accounts: [acctS, acctP] })]), [ra, rb]);
  const states = [...marketStates(spot, [{ account: acctS }]), ...marketStates(perp, [{ account: acctP }])];
  const ctx = context([perp, spot], { accounts: [{ module: spot, account: acctS }, { module: perp, account: acctP }] });
  assert.equal((await reserveWith(p, w, request(action(spot, { authority: ra, size: sizeFor(3_000) }), states, ctx))).status, 'AUTHORIZED');
  return (await reserveWith(p, w, request(action(perp, { authority: rb, size: sizeFor(3_000) }), states, ctx))).status === 'REFUSED';
}

/** A position snapshot behind the reconciliation watermark must not authorize (STATE-3). */
async function staleProbe(p: Pipeline): Promise<boolean> {
  const f = await singleAccount(1_000_000);
  const ctx = context([f.m], { accounts: [{ module: f.m, account: f.acct, watermark: 11n }] });
  return (await reserveWith(p, f.w, request(action(f.m, { authority: f.a, size: sizeFor(1_000) }), marketStates(f.m, [{ account: f.acct }]), ctx))).status === 'REFUSED';
}

// --- Mutant stages -------------------------------------------------------------------

const withoutKind =
  (kind: string): Pipeline['admit'] =>
  (needs, prepared, ctx, path) => {
    const r = admitNeeds(needs, prepared, ctx, path);
    return r.ok ? { ok: true, value: r.value.filter((a) => a.need.stateKind !== kind) } : r;
  };

/** Admission that binds the one candidate without asking whether it is fresh, trusted or final. */
const admitWithoutChecks: Pipeline['admit'] = (needs, prepared) => {
  const out: Admission[] = [];
  for (const need of needs) {
    const c = prepared.find((x) => moduleRefsEqual(x.envelope.module, need.module.ref) && x.envelope.stateKind === need.stateKind && resourceIdsEqual(x.envelope.subject, need.subject));
    if (c === undefined) continue;
    const binding = bindState(c.envelope, stateRequirementInputOf(need.requirement));
    if (!binding.ok) continue;
    out.push({ need, state: { envelope: c.envelope, stateId: c.stateId, payload: c.payload }, binding: binding.value, bindingId: stateBindingId(binding.value) });
  }
  return { ok: true, value: out };
};

const MUTANTS: { name: string; pipeline: Pipeline; probe: (p: Pipeline) => Promise<boolean> }[] = [
  { name: 'drop one required state binding (the position book)', pipeline: { ...PRODUCTION_PIPELINE, admit: withoutKind('synth.position') }, probe: heldStateProbe },
  { name: 'ignore one pending reservation', pipeline: { ...PRODUCTION_PIPELINE, facts: (s) => { const r = reservationFacts(s); return r.ok ? { ok: true, value: r.value.slice(1) } : r; } }, probe: pendingProbe },
  { name: 'skip the principal-global invariants', pipeline: { ...PRODUCTION_PIPELINE, applicable: (e) => e.invariants.map((term) => ({ origin: 'LINEAGE' as const, term })) }, probe: globalProbe },
  { name: 'authorize after a stale-state failure', pipeline: { ...PRODUCTION_PIPELINE, admit: admitWithoutChecks }, probe: staleProbe },
];

describe('mutants of the decision pipeline are killed (brief §58)', () => {
  for (const m of MUTANTS) {
    it(m.name, async () => {
      assert.equal(await m.probe(PRODUCTION_PIPELINE), true, 'the property holds for production code');
      assert.equal(await m.probe(m.pipeline), false, 'the mutant violates it');
    });
  }
});

describe('mutants outside the pipeline are killed', () => {
  it('reuse the pre-CAS projection after a conflict (retry the old plan): the loser oversubscribes the invariant', async () => {
    const run = async (mutant: boolean): Promise<number> => {
      let hold: (() => void) | null = null;
      let reads = 0;
      let armed = false;
      const gate = new Promise<void>((resolve) => (hold = resolve));
      const w = world({ hooks: { delay: async (point) => { if (point === 'READ' && armed) { reads += 1; if (reads === 2) hold?.(); if (reads <= 2) await gate; } } } });
      const perp = w.modules[0] as SyntheticModule;
      const spot = w.modules[1] as SyntheticModule;
      const acctS = account(spot);
      const acctP = account(perp);
      const r0 = root({ mods: [perp, spot], delegate: 1, terms: [capitalDim('capital', 1_000_000)] });
      const a = child(r0, { mods: [spot], holder: AGENT_A, terms: [capitalDim('capital', 100_000)] });
      const b = child(r0, { mods: [perp], holder: AGENT_B, terms: [capitalDim('capital', 100_000)] });
      await setup(w, policy([aggregate({ whole: 5_000, contributors: [spot, perp], accounts: [acctS, acctP] })]), [r0, a, b]);
      const states = [...marketStates(spot, [{ account: acctS }]), ...marketStates(perp, [{ account: acctP }])];
      const ctx = context([perp, spot], { accounts: [{ module: spot, account: acctS }, { module: perp, account: acctP }] });
      armed = true;
      const go = async (req: AuthorizationRequest): Promise<Status> => {
        if (!mutant) return (await w.engine.authorizeAndReserve(req, RETRY)).status === 'AUTHORIZED' ? 'AUTHORIZED' : 'REFUSED';
        // Mutant: decide once, then on a conflict re-derive only the RESERVE for the same plan.
        const first = await w.store.read(req.action.principal);
        const d = decideWith(PRODUCTION_PIPELINE, first, req, { catalog: w.catalog, registry: w.registry, rules: controlRules(w.catalog) });
        if (!d.ok) return 'REFUSED';
        let s = first;
        for (let i = 0; i < 8; i += 1) {
          const ev = deriveReserveEvent(s.state, d.value.plan, T);
          if (!ev.ok) return 'REFUSED';
          const c = await w.store.compareAndAppend(s.principal, s.version, s.head, [ev.value]);
          if (c.status === 'COMMITTED') return 'AUTHORIZED';
          if (c.status === 'REFUSED') return 'REFUSED';
          s = await w.store.read(req.action.principal);
        }
        return 'REFUSED';
      };
      const out = await Promise.all([
        go(request(action(spot, { authority: a, size: sizeFor(3_000) }), states, ctx)),
        go(request(action(perp, { authority: b, size: sizeFor(3_000) }), states, ctx)),
      ]);
      return out.filter((x) => x === 'AUTHORIZED').length;
    };
    assert.equal(await run(false), 1, 'production recomputes the projection and admits one');
    assert.equal(await run(true), 2, 'the mutant admits both: 6,000 > 5,000');
  });

  it('change the ModuleRef digest (resolve by name only): a patched digest is executed', async () => {
    const probe = async (catalogOf: (w: World) => ModuleCatalog): Promise<boolean> => {
      const f = await singleAccount(1_000_000);
      const patched = { ...syntheticRef(PERP_CFG), moduleDigest: `0x${'ab'.repeat(32)}` };
      const req = request(action(f.m, { authority: f.r0, size: sizeFor(100), module: patched }), marketStates(f.m, [{ account: f.acct }]), f.ctx);
      const s = await f.w.store.read(req.action.principal);
      const d = decideWith(PRODUCTION_PIPELINE, s, req, { catalog: catalogOf(f.w), registry: f.w.registry, rules: controlRules(f.w.catalog) });
      return !d.ok && d.error.code === 'MODULE_NOT_FOUND';
    };
    const byName = (w: World): ModuleCatalog =>
      ({
        resolveForDecision: (ref: ModuleRef) => {
          const m = w.catalog.modules().find((x) => x.ref.moduleId === ref.moduleId && x.ref.moduleVersion === ref.moduleVersion);
          return m === undefined ? { ok: false, error: null as never } : { ok: true, value: m };
        },
        resolveForLifecycle: (ref: ModuleRef) => w.catalog.resolveForLifecycle(ref),
        invariantOwner: (id: string, v: number) => w.catalog.invariantOwner(id, v),
        compareInvariants: w.catalog.compareInvariants.bind(w.catalog),
        modules: () => w.catalog.modules(),
      }) as unknown as ModuleCatalog;
    assert.equal(await probe((w) => w.catalog), true);
    assert.equal(await probe(byName), false);
  });

  it('treat marked exposure as committed notional: the notional counter follows the mark', async () => {
    const probe = async (m: SyntheticModule): Promise<boolean> => {
      const w = world({ modules: [m] });
      const acct = account(m);
      const r0 = root({ mods: [m], holder: AGENT_A, terms: [capitalDim('capital', 1_000_000), notionalDim('btc-notional', 1_000_000)] });
      await setup(w, policy(), [r0]);
      // Limit 101,000; mark 100,000: committed notional must be 2,020.00, never the marked 2,000.00.
      const rec = await w.engine.authorizeAndReserve(request(action(m, { authority: r0, size: sizeFor(2_000), limitPrice: 10_100_000n }), marketStates(m, [{ account: acct }], PRICE), context([m], { accounts: [{ module: m, account: acct }] })), ONCE);
      assert.equal(rec.status, 'AUTHORIZED');
      const s = await w.store.read(r0.principal);
      const t = s.state.targets.get(nodeTargetKey(rec.status === 'AUTHORIZED' ? (rec.authorization.lineage.at(-1) as never) : (null as never), 'btc-notional' as never)) as TargetBalance;
      return t.reserved === usd(2_020);
    };
    assert.equal(await probe(createSyntheticModule(PERP_CFG)), true);
    assert.equal(await probe(createSyntheticModule({ ...PERP_CFG, variant: 'MARK_NOTIONAL' })), false);
  });

  it('allow a 5x child under a 4x parent: the widening registers', async () => {
    const probe = async (m: SyntheticModule): Promise<boolean> => {
      const w = world({ modules: [m] });
      const acct = account(m);
      const parent = root({ mods: [m], holder: AGENT_A, delegate: 1, terms: [capitalDim('capital', 1_000), maxLeverage(m, acct, 4n)] });
      await setup(w, policy(), [parent]);
      const r = await w.engine.registerDelegation(child(parent, { mods: [m], holder: AGENT_B, terms: [maxLeverage(m, acct, 5n)] }), T0, ONCE);
      return r.status === 'REFUSED';
    };
    assert.equal(await probe(createSyntheticModule(PERP_CFG)), true);
    assert.equal(await probe(createSyntheticModule({ ...PERP_CFG, variant: 'LENIENT_NARROWING' })), false);
  });

  it('the stale-state mutant also passes a stale mark, which production refuses by name', async () => {
    const f = await singleAccount(1_000_000);
    const states = [markState(f.m, 'x:BTC-PERP', PRICE, { observedAt: T - 31n }), instrumentsState(f.m), positionState(f.m, f.acct)];
    const req = request(action(f.m, { authority: f.a, size: sizeFor(100) }), states, f.ctx);
    const s = await f.w.store.read(req.action.principal);
    const env = { catalog: f.w.catalog, registry: f.w.registry, rules: controlRules(f.w.catalog) };
    const prod = decideWith(PRODUCTION_PIPELINE, s, req, env);
    assert.ok(!prod.ok && prod.error.code === 'STATE_STALE');
    const mut = decideWith({ ...PRODUCTION_PIPELINE, admit: admitWithoutChecks }, s, req, env);
    // Defence in depth: the lifetime rule still refuses a mark already past its freshness, but not as stale state.
    assert.ok(!mut.ok && mut.error.code !== 'STATE_STALE');
  });
});
