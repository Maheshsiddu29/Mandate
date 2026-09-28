/**
 * Mutation testing for 7D (brief §58). Each mutant changes exactly one thing
 * — a pipeline stage, the CAS loop, module resolution, or one module rule —
 * and a safety probe that holds for production code must fail for it. The
 * pipeline's stages are internal (not exported from the package), so the
 * mutants are built here from the same stages production uses.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authorityId, bindState, moduleRefsEqual, resourceIdsEqual, stateBindingId, stateRequirementInputOf, type AuthorityGrant, type ModuleRef, type ResourceId } from '@mandate/core';
import {
  ReferenceModuleRegistry,
  bindingOf,
  checkBindingSet,
  checkGrantRegistration,
  checkPolicyBaseline,
  checkProofsBound,
  committedProver,
  decodeBatch,
  deriveReserveEvent,
  grantInvariants,
  isModuleDefined,
  nodeTargetKey,
  replayEncoded,
  type InvariantOrdering,
  type LedgerEvent,
  type LedgerResult,
  type SemanticTermBinding,
  type TargetBalance,
} from '@mandate/ledger';
import { admitNeeds, type Admission } from '../src/admission.ts';
import { checkAggregateScope, checkValuationContexts, sumAggregate, type AggregateEvaluator } from '../src/aggregate.ts';
import { ModuleCatalog, ReferenceModuleArchive, controlRules, type ControlResult } from '../src/index.ts';
import { PRODUCTION_PIPELINE, committedSemantics, decideWith, type AuthorizationRequest, type Decision, type Pipeline, type SemanticResolver } from '../src/pipeline.ts';
import { CFG, CFG_B, definitionOf, spotOrder, t0, t1 } from './support/drift.ts';
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
  must,
  registerPolicy,
  root,
  setup,
  sizeFor,
  syntheticRef,
  usd,
  assetValuedModules,
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
  const w = world({ modules: assetValuedModules() });
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

/** 7D.1: A at BTC 50,000 and B at BTC 52,000 fit ≤ 10,000 numerically, but must not be summed. */
async function valuationProbe(p: Pipeline): Promise<boolean> {
  const w = world({ modules: assetValuedModules() });
  const a = w.modules[0] as SyntheticModule;
  const b = w.modules[1] as SyntheticModule;
  const acctA = account(a);
  const acctB = account(b);
  const ra = root({ mods: [a], holder: AGENT_A, terms: [capitalDim('capital', 100_000)] });
  const rb = root({ mods: [b], holder: AGENT_B, nonce: 1n, terms: [capitalDim('capital', 100_000)] });
  await setup(w, policy([aggregate({ whole: 10_000, contributors: [a, b], accounts: [acctA, acctB] })]), [ra, rb]);
  const states = [
    ...marketStates(a, [{ account: acctA, positions: [{ localId: 'x:BTC-PERP', size: 800n }] }], 5_000_000n),
    ...marketStates(b, [{ account: acctB, positions: [{ localId: 'x:BTC-SPOT', size: 577n }] }], 5_200_000n),
  ];
  const ctx = context([a, b], { accounts: [{ module: a, account: acctA }, { module: b, account: acctB }] });
  return (await reserveWith(p, w, request(action(a, { authority: ra, size: 20n }), states, ctx))).status === 'REFUSED';
}

/** Policy 1 lists spot and perp; spot reserves 3,000 BTC; policy 2 lists only perp (≤ 10,000 for both). */
async function unlistedPending() {
  const w = world({ modules: assetValuedModules() });
  const perp = w.modules[0] as SyntheticModule;
  const spot = w.modules[1] as SyntheticModule;
  const acctS = account(spot);
  const acctP = account(perp);
  const agg = (whole: number, contributors: readonly SyntheticModule[]) => aggregate({ whole, contributors, accounts: [acctS, acctP] });
  const ra = root({ mods: [spot], holder: AGENT_A, terms: [capitalDim('capital', 100_000)] });
  const rb = root({ mods: [perp], holder: AGENT_B, nonce: 1n, terms: [capitalDim('capital', 100_000)] });
  await setup(w, policy([agg(10_000, [spot, perp])]), [ra, rb]);
  const states = [...marketStates(spot, [{ account: acctS }]), ...marketStates(perp, [{ account: acctP }])];
  const ctx = context([perp, spot], { accounts: [{ module: spot, account: acctS }, { module: perp, account: acctP }] });
  assert.equal((await reserveWith(PRODUCTION_PIPELINE, w, request(action(spot, { authority: ra, size: sizeFor(3_000) }), states, ctx))).status, 'AUTHORIZED');
  return { w, perp, spot, rb, agg, states, ctx };
}

/** 7D.1: spot's unresolved 3,000 must not drop out of the aggregate when a new policy stops listing spot. */
async function unlistedProbe(p: Pipeline): Promise<boolean> {
  const f = await unlistedPending();
  assert.equal((await registerPolicy(f.w, policy([f.agg(10_000, [f.perp])], 2n), T)).status, 'REGISTERED');
  return (await reserveWith(p, f.w, request(action(f.perp, { authority: f.rb, size: sizeFor(1_000) }), f.states, f.ctx))).status === 'REFUSED';
}

/** Mutant A: the closed scope is checked, then everything is summed whatever it was valued at. */
const sumAcrossValuations: AggregateEvaluator = (spec, participants, active) => {
  const scope = checkAggregateScope(spec, participants, active);
  return scope !== null ? { outcome: 'UNKNOWN', reason: scope, observed: null, bound: null, states: [], reservations: [] } : sumAggregate(spec, participants);
};

/** Mutant B: only listed contributors are looked at; an unlisted module's matching facts are ignored. */
const ignoreUnlisted: AggregateEvaluator = (spec, participants) => {
  const valuation = checkValuationContexts(spec, participants);
  return valuation !== null ? { outcome: 'UNKNOWN', reason: valuation, observed: null, bound: null, states: [], reservations: [] } : sumAggregate(spec, participants);
};

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
  { name: 'skip the principal-global invariants', pipeline: { ...PRODUCTION_PIPELINE, applicable: (e) => e.invariants.map((b) => ({ origin: 'LINEAGE' as const, term: b.term, binding: b.binding })) }, probe: globalProbe },
  { name: 'authorize after a stale-state failure', pipeline: { ...PRODUCTION_PIPELINE, admit: admitWithoutChecks }, probe: staleProbe },
  { name: '7D.1 A: aggregate two marked facts valued at different BTC observations', pipeline: { ...PRODUCTION_PIPELINE, aggregate: sumAcrossValuations }, probe: valuationProbe },
  { name: '7D.1 B: ignore an unlisted module\'s matching aggregate fact', pipeline: { ...PRODUCTION_PIPELINE, aggregate: ignoreUnlisted }, probe: unlistedProbe },
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
      const w = world({ modules: assetValuedModules(), hooks: { delay: async (point) => { if (point === 'READ' && armed) { reads += 1; if (reads === 2) hold?.(); if (reads <= 2) await gate; } } } });
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
        resolveDefinition: w.catalog.resolveDefinition.bind(w.catalog),
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

describe('7D.1 and 7D.2 mutants outside the pipeline are killed', () => {
  it('C: activate a tightened principal-global invariant despite unresolved activity and no baseline', async () => {
    // The reducer's policy-update gate, and a mutant of it that forgets principal-global invariants.
    const forgetful: typeof checkPolicyBaseline = (s, p, rules) => checkPolicyBaseline(s, { ...p, terms: p.terms.filter((t) => t.kind !== 'STATE_INVARIANT') }, rules);
    const probe = async (gate: typeof checkPolicyBaseline): Promise<boolean> => {
      const f = await unlistedPending();
      const tightened = policy([f.agg(5_000, [f.spot, f.perp])], 2n);
      const s = await f.w.store.read(tightened.principal);
      const refusedByGate = !gate(s.state, tightened, controlRules(f.w.catalog)).ok;
      if (gate === checkPolicyBaseline) {
        // The production gate is the one the store's reducer applies.
        const o = await f.w.ledger.registerPolicy(tightened, T, ONCE);
        assert.equal(o.status === 'REFUSED' ? o.refusal.code : o.status, 'POLICY_UPDATE_REQUIRES_BASELINE');
      }
      return refusedByGate;
    };
    assert.equal(await probe(checkPolicyBaseline), true);
    assert.equal(await probe(forgetful), false);
  });

  it('D: replay a historical semantic narrowing after its module comparator was removed', async () => {
    const probe = async (orderingOf: (verifier: ModuleCatalog) => InvariantOrdering): Promise<boolean> => {
      const w = world({ modules: [createSyntheticModule(PERP_CFG)] });
      const m = w.modules[0] as SyntheticModule;
      const acct = account(m);
      const parent = root({ mods: [m], holder: AGENT_A, delegate: 1, terms: [capitalDim('capital', 1_000), maxLeverage(m, acct, 4n)] });
      await setup(w, policy(), [parent]);
      assert.equal((await w.engine.registerDelegation(child(parent, { mods: [m], holder: AGENT_B, terms: [maxLeverage(m, acct, 3n)] }), T0, ONCE)).status, 'REGISTERED');
      const batches = (await w.store.history(parent.principal)).map((b) => b.encoded);
      // The historical verifier no longer has M.
      const verifier = must(ModuleCatalog.create(w.registry, []));
      return !replayEncoded(parent.principal, batches, { invariantOrdering: orderingOf(verifier) }).ok;
    };
    // Mutant: when the comparator cannot be resolved, trust the committed history.
    const trustHistory = (c: ModuleCatalog): InvariantOrdering => ({
      noWeaker: (p, ch, d) => {
        const v = c.compareInvariants(p, ch, d).verdict;
        return v === 'UNPROVABLE' ? 'NO_WEAKER' : v;
      },
    });
    assert.equal(await probe((c) => c.invariantOrdering()), true);
    assert.equal(await probe(trustHistory), false);
  });

  it('E (7D.2): resolve a historical comparator by name through the current registry — a remapped digest re-proves history', async () => {
    const probe = async (orderingOf: (verifier: ModuleCatalog) => InvariantOrdering): Promise<boolean> => {
      const cfg = { ...PERP_CFG, moduleId: 'synthetic' };
      const w = world({ modules: [createSyntheticModule(cfg)] });
      const a = w.modules[0] as SyntheticModule;
      const acct = account(a);
      const parent = root({ mods: [a], holder: AGENT_A, delegate: 1, terms: [capitalDim('capital', 1_000), maxLeverage(a, acct, 4n)] });
      await setup(w, policy(), [parent]);
      assert.equal((await w.engine.registerDelegation(child(parent, { mods: [a], holder: AGENT_B, terms: [maxLeverage(a, acct, 3n)] }), T0, ONCE)).status, 'REGISTERED');
      const batches = (await w.store.history(parent.principal)).map((x) => x.encoded);
      // The name now maps to digest B; digest A is not available.
      const b = createSyntheticModule({ ...cfg, variant: 'LENIENT_NARROWING' });
      const future = must(ReferenceModuleRegistry.create([{ module: b.ref, status: 'ACTIVE', implementations: [b.implementation] }]));
      const verifier = must(ModuleCatalog.create(future, [{ module: b, corpus: [] }]));
      return !replayEncoded(parent.principal, batches, { invariantOrdering: orderingOf(verifier) }).ok;
    };
    // Mutant: whatever definition was committed, use the current owner of the invariant's name.
    const byName = (c: ModuleCatalog): InvariantOrdering => ({
      noWeaker: (p, ch, d) => {
        const current = c.definitionFor(d.invariantId, d.version);
        return current === null ? 'UNPROVABLE' : c.compareInvariants(p, ch, current).verdict;
      },
    });
    assert.equal(await probe((c) => c.invariantOrdering()), true);
    assert.equal(await probe(byName), false);
  });
});

/** Mutant F's resolver: the invariant's name through the catalog's current owner — what 7D.3 forbids for existing authority. */
const byCurrentName: SemanticResolver = (a, catalog) => {
  const owner = catalog.invariantOwner(a.term.invariantId, a.term.version);
  return owner === null ? { ok: false, reason: 'INVARIANT_DEFINITION_UNRESOLVED' } : { ok: true, module: owner };
};

describe('7D.3 mutants are killed', () => {
  it('F: evaluate an old grant under the registry\'s current module instead of its committed binding', async () => {
    const probe = async (semantics: SemanticResolver): Promise<boolean> => {
      const f = await t0();
      const x = t1(f, { archiveA: true });
      // 5x against the old 4x term, with state for both A and B, so nothing but the choice of semantics decides.
      const req = spotOrder(f, f.grant, 5, 1n);
      const both = { ...req, states: [...req.states, ...marketStates(x.b, [{ account: f.acctA, positions: [{ localId: 'x:BTC-PERP', size: sizeFor(500_000) }], collateral: usd(100_000) }])] };
      const snapshot = await f.w.store.read(f.grant.principal);
      const d = decideWith({ ...PRODUCTION_PIPELINE, semantics }, snapshot, both, { catalog: x.catalog, registry: x.registry, rules: controlRules(x.catalog) });
      return !d.ok && d.error.code === 'INVARIANT_FAILED';
    };
    assert.equal(await probe(committedSemantics), true);
    assert.equal(await probe(byCurrentName), false);
  });

  it('G: accept a module-defined authority term with no semantic binding — at registration, or at evaluation', async () => {
    // At registration: the reducer's binding-set rule, and a mutant of it that forgets unbound terms.
    const forgetful: typeof checkBindingSet = (b, terms, path, termsPath) => checkBindingSet(b, terms.filter((t) => bindingOf(b, t) !== null), path, termsPath);
    const f = await t0();
    const gate = (check: typeof checkBindingSet): boolean => !check([], grantInvariants(f.grant), 'bindings', 'grant.terms').ok;
    assert.equal(gate(checkBindingSet), true);
    assert.equal(gate(forgetful), false);
    // The production gate is the one the store applies: an unbound registration is refused at commit.
    const unbound = root({ mods: [f.a, f.s], holder: AGENT_B, nonce: 9n, terms: [maxLeverage(f.a, f.acctA, 4n)] });
    const s = await f.w.store.read(f.grant.principal);
    const direct = await f.w.store.compareAndAppend(s.principal, s.version, s.head, [{ kind: 'REGISTER_GRANT', at: T0, grant: unbound }]);
    assert.equal(direct.status === 'REFUSED' ? direct.refusal.code : direct.status, 'SEMANTIC_BINDING_MISSING');

    // At evaluation: a node whose term is unbound (as legacy state would be), and a resolver that falls back to the name.
    const fallback: SemanticResolver = (a, catalog) => (a.binding === null && isModuleDefined(a.term) ? byCurrentName(a, catalog) : committedSemantics(a, catalog));
    const probe = async (semantics: SemanticResolver): Promise<boolean> => {
      const snap = await f.w.store.read(f.grant.principal);
      const node = snap.state.nodes.get(authorityId(f.grant));
      assert.ok(node !== undefined);
      const legacy = { ...snap, state: { ...snap.state, nodes: snap.state.nodes.set(node.id, { ...node, bindings: [] }) } };
      const d = decideWith({ ...PRODUCTION_PIPELINE, semantics }, legacy, spotOrder(f, f.grant, 3, 1n), { catalog: f.w.catalog, registry: f.w.registry, rules: controlRules(f.w.catalog) });
      return !d.ok && d.error.code === 'INVARIANT_UNKNOWN';
    };
    assert.equal(await probe(committedSemantics), true);
    assert.equal(await probe(fallback), false);
  });

  it('H: use comparator B for a narrowing proof while the authority term is bound to A', async () => {
    const f = await t0();
    const lenient = createSyntheticModule({ ...CFG, variant: 'LENIENT_NARROWING' });
    const scope = [f.acctA as ResourceId];
    const boundA: SemanticTermBinding = { definition: definitionOf(f.a.ref), scope };
    const proofB = { definition: definitionOf(lenient.ref), scope };
    // A 5x child under the 4x parent: its term (necessarily, like its parent's) means A; its proof claims lenient B.
    const wide = child(f.grant, { mods: [f.a, f.s], holder: AGENT_B, terms: [capitalDim('capital', 1_000), maxLeverage(f.a, f.acctA, 5n)] });
    const archive = must(ReferenceModuleArchive.create([{ module: lenient.ref, implementations: [lenient.implementation] }]));
    const verifier = must(ModuleCatalog.create(f.w.registry, f.w.modules.map((module) => ({ module, corpus: [] })), { archive, modules: [{ module: lenient, corpus: [] }] }));
    // Safe iff the reducer's agreement rule refuses the proof before any comparator can order the parameters.
    const probe = (gate: typeof checkProofsBound): boolean => {
      const agreed: LedgerResult<true> = gate([proofB], [boundA], 'proofs');
      return !agreed.ok;
    };
    assert.equal(probe(checkProofsBound), true);
    assert.equal(probe(() => ({ ok: true, value: true })), false);
    // The widening the mutant would let through: under B's comparator, the 5x child passes the subset check.
    const snap = await f.w.store.read(f.grant.principal);
    const unchecked = checkGrantRegistration(snap.state, authorityId(wide), wide, T0, 'grant', committedProver(verifier.invariantOrdering(), [proofB]));
    assert.ok(unchecked.ok, 'without the agreement rule, lenient B proves 5x no weaker than 4x');
    // Production refuses it at commit, whatever comparators the store can reach.
    const direct = await f.w.store.compareAndAppend(snap.principal, snap.version, snap.head, [{ kind: 'REGISTER_GRANT', at: T0, grant: wide, bindings: [boundA], proofs: [proofB] }]);
    assert.equal(direct.status === 'REFUSED' ? direct.refusal.code : direct.status, 'SEMANTIC_BINDING_MISMATCH');
  });

  it('I: let a caller supply its own trusted semantics — structurally impossible through the control engine', async () => {
    type Register = (w: World, grant: AuthorityGrant, forged: readonly SemanticTermBinding[]) => Promise<unknown>;
    const probe = async (register: Register): Promise<boolean> => {
      const a = createSyntheticModule(CFG);
      const b = createSyntheticModule(CFG_B);
      const w = world({ modules: [a] });
      await setup(w, policy(), []);
      const scope = [account(a) as ResourceId];
      const g = root({ mods: [a], holder: AGENT_A, terms: [maxLeverage(a, account(a), 4n)] });
      await register(w, g, [{ definition: definitionOf(b.ref), scope }]);
      const events = (await w.store.history(g.principal)).flatMap((x) => must(decodeBatch(x.encoded)).events);
      const reg = events.find((e): e is Extract<LedgerEvent, { kind: 'REGISTER_GRANT' }> => e.kind === 'REGISTER_GRANT');
      // Safe iff what was committed is the catalog's own derivation: A, never the caller's B.
      return reg !== undefined && JSON.stringify(reg.bindings?.map((x) => x.definition)) === JSON.stringify([definitionOf(a.ref)]);
    };
    // Production: the engine's surface has no place for semantics; whatever a caller adds is ignored.
    const production: Register = (w, g, forged) => (w.engine.registerDelegation.bind(w.engine) as unknown as (...args: unknown[]) => Promise<unknown>)({ ...g, bindings: forged }, T0, ONCE, { bindings: forged }, forged);
    // Mutant: a registration path that commits the caller's semantics as given.
    const trusting: Register = async (w, g, forged) => {
      const s = await w.store.read(g.principal);
      return w.store.compareAndAppend(s.principal, s.version, s.head, [{ kind: 'REGISTER_GRANT', at: T0, grant: g, bindings: forged }]);
    };
    assert.equal(await probe(production), true);
    assert.equal(await probe(trusting), false);
  });
});
