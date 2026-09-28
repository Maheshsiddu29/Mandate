/**
 * Cost of the authorization hot path (brief §55).
 *
 * The purpose is to find pathological scaling — a cost that grows with
 * history, or super-linearly with pending reservations or lineage depth —
 * not to optimize. Every case measures the pure functions a decision runs,
 * against an immutable snapshot, so no iteration changes what the next one
 * reads. Numbers are machine-dependent and are reported, never asserted.
 *
 * Stages: state admission (prepare, requirements, admission and bindings),
 * projection (the acting module over its admitted state and pending facts),
 * invariant evaluation (every applicable invariant on the projection),
 * ledger reservation (the RESERVE the ledger derives, applied to the
 * snapshot), and the whole pure decision plus its reservation.
 *
 * 7D.2 adds principal-global aggregate cases at 20, 100, 1,000 and 4,096
 * unresolved reservations (the `MAX_RESERVATION_FACTS` bound): two
 * asset-valued modules, the pending reservations split between them, one
 * shared valuation, and the 7D.1 closed-scope consultation of every module
 * with unresolved activity. Two further stages are reported: reading the
 * reservation facts from the snapshot, and Core's aggregate evaluation
 * (scope, valuation context and sum) over the decision's participants.
 * Their pending reservations are committed through the ledger from one
 * engine-decided plan per module, varied only in action identity — the same
 * ledger state the engine would build, without quadratic set-up.
 *
 * Run: `npm run control:benchmark`. Offline; nothing is written to disk.
 */

import { applyBatch, deriveReserveEvent, type ChargePlan, type LedgerSnapshot } from '@mandate/ledger';
import { actionId, type ActionId, type AuthorityGrant, type AuthorityTermInput, type LedgerDimensionInput, type StateEnvelope, type StateId } from '@mandate/core';
import { evaluateAggregate, aggregateSpecOf, type AggregateSpec, type ParticipantView } from '../src/aggregate.ts';
import { admitNeeds, effectiveNeed, mergeNeeds, prepareStates } from '../src/admission.ts';
import { validateEvaluationContext } from '../src/context.ts';
import { reservationFacts, factsFor } from '../src/facts.ts';
import { controlRules, type SuppliedState } from '../src/index.ts';
import { invariantVerdict } from '../src/invariants.ts';
import { PRODUCTION_PIPELINE, decideWith, evaluateState, resolveAuthority, type AuthorizationRequest } from '../src/pipeline.ts';
import {
  AGENT_A,
  ONCE,
  T,
  account,
  action,
  address,
  aggregate,
  assetValuedModules,
  capitalDim,
  digestOf,
  child,
  context,
  marketStates,
  maxExposure,
  maxLeverage,
  must,
  notionalDim,
  policy,
  request,
  root,
  setup,
  sizeFor,
  world,
  type SyntheticModule,
  type World,
} from '../test/support/world.ts';

const ROUNDS = 7;

function medianMicros(iterations: number, run: () => void): number {
  for (let i = 0; i < iterations; i += 1) run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) run();
    samples.push(Number(process.hrtime.bigint() - start) / 1_000 / iterations);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(ROUNDS / 2)] as number;
}

function dim(id: string, kind: 'POSITION_SIZE' | 'COUNT'): LedgerDimensionInput {
  const unit = kind === 'COUNT' ? 'COUNT' : 'UNIT';
  const decimals = kind === 'COUNT' ? 0 : 4;
  return { ...capitalDim(id, 1), limit: { kind, unit, decimals, atoms: 10n ** 12n }, scope: { asset: null, market: null, domain: null, account: null } };
}

interface Case {
  readonly name: string;
  readonly w: World;
  readonly m: SyntheticModule;
  readonly snapshot: LedgerSnapshot;
  readonly req: AuthorizationRequest;
}

/** `count` more reservations of `template`'s plan, each under a fresh action identity, through the ledger. */
async function reserveCopies(w: World, template: ChargePlan, count: number, label: string): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const plan = { ...template, action: digestOf(`benchmark:${label}:${i}`) as ActionId };
    const r = await w.ledger.reserve(plan, T, ONCE);
    if (r.status !== 'COMMITTED') throw new Error(`setup reservation ${label}/${i}: ${r.status === 'REFUSED' ? r.refusal.code : r.status}`);
  }
}

/** A principal-global BTC aggregate over spot-like and perp-like, `pending` unresolved reservations split between them; perp acts. */
async function buildGlobal(name: string, pending: number): Promise<Case> {
  const w = world({ modules: assetValuedModules() });
  const perp = w.modules[0] as SyntheticModule;
  const spot = w.modules[1] as SyntheticModule;
  const acctS = account(spot);
  const acctP = account(perp);
  const rootS = root({ mods: [spot], holder: AGENT_A, terms: [capitalDim('capital', 100_000_000)] });
  const rootP = root({ mods: [perp], holder: address('62'), nonce: 1n, terms: [capitalDim('capital', 100_000_000)] });
  await setup(w, policy([aggregate({ whole: 100_000_000, contributors: [spot, perp], accounts: [acctS, acctP] })]), [rootS, rootP]);
  const states: SuppliedState[] = [...marketStates(spot, [{ account: acctS }]), ...marketStates(perp, [{ account: acctP }])];
  const ctx = context([perp, spot], { accounts: [{ module: spot, account: acctS }, { module: perp, account: acctP }] });
  const templates: ChargePlan[] = [];
  for (const [m, g] of [[spot, rootS], [perp, rootP]] as const) {
    const s = await w.store.read(g.principal);
    templates.push(must(decideWith(PRODUCTION_PIPELINE, s, request(action(m, { authority: g, size: sizeFor(100), nonce: 99_999n }), states, ctx), { catalog: w.catalog, registry: w.registry, rules: controlRules(w.catalog) })).plan);
  }
  await reserveCopies(w, templates[0] as ChargePlan, Math.floor(pending / 2), 'spot');
  await reserveCopies(w, templates[1] as ChargePlan, pending - Math.floor(pending / 2), 'perp');
  const req = request(action(perp, { authority: rootP, size: sizeFor(100) }), states, ctx);
  return { name, w, m: perp, snapshot: await w.store.read(req.action.principal), req };
}

async function build(name: string, o: { invariants: 'ONE' | 'FIVE'; depth: number; dims: 'ONE' | 'FOUR'; pending: number }): Promise<Case> {
  // The five-invariant case carries a principal-global marked aggregate, which only asset-valued marks may join (7D.1).
  const w = o.invariants === 'FIVE' ? world({ modules: assetValuedModules() }) : world();
  const m = w.modules[0] as SyntheticModule;
  const acct = account(m);
  const acct2 = account(m, 'acct-2');
  const lineageInvariants: AuthorityTermInput[] = o.invariants === 'ONE' ? [maxExposure(m, acct, 1_000_000)] : [maxExposure(m, acct, 1_000_000), maxLeverage(m, acct, 1_000n), maxExposure(m, acct2, 1_000_000), maxLeverage(m, acct2, 1_000n)];
  const dims: AuthorityTermInput[] = o.dims === 'ONE' ? [capitalDim('capital', 100_000_000)] : [capitalDim('capital', 100_000_000), notionalDim('notional', 100_000_000), dim('position', 'POSITION_SIZE'), dim('count', 'COUNT')];
  const policyTerms = o.invariants === 'FIVE' ? [aggregate({ whole: 100_000_000, contributors: [m], accounts: [acct, acct2] })] : [];
  const grants: AuthorityGrant[] = [root({ mods: [m], delegate: o.depth, terms: [...dims, ...lineageInvariants] })];
  for (let i = 1; i < o.depth; i += 1) {
    const parent = grants[i - 1] as AuthorityGrant;
    grants.push(child(parent, { mods: [m], holder: address((0x60 + i).toString(16)), delegate: o.depth - i - 1, terms: [...dims, ...lineageInvariants] }));
  }
  if (o.depth === 1) grants.push(child(grants[0] as AuthorityGrant, { mods: [m], holder: AGENT_A, terms: [...dims, ...lineageInvariants] }));
  await setup(w, policy(policyTerms), grants);
  const leaf = grants[grants.length - 1] as AuthorityGrant;
  const states: SuppliedState[] = marketStates(m, [{ account: acct }, ...(o.invariants === 'FIVE' ? [{ account: acct2 }] : [])]);
  const ctx = context([m], { accounts: [{ module: m, account: acct }, { module: m, account: acct2 }] });
  for (let i = 0; i < o.pending; i += 1) {
    const r = await w.engine.authorizeAndReserve(request(action(m, { authority: leaf, size: sizeFor(100), nonce: BigInt(10_000 + i) }), states, ctx), ONCE);
    if (r.status !== 'AUTHORIZED') throw new Error(`setup reservation ${i}: ${r.status}`);
  }
  const req = request(action(m, { authority: leaf, size: sizeFor(100) }), states, ctx);
  return { name, w, m, snapshot: await w.store.read(req.action.principal), req };
}

function measure(c: Case): { [stage: string]: number | string } {
  const env = { catalog: c.w.catalog, registry: c.w.registry, rules: controlRules(c.w.catalog) };
  const ctx = must(validateEvaluationContext(c.req.context));
  const authority = must(resolveAuthority(c.snapshot, c.req.action, T));
  const scoped = { envelope: c.req.action, actionId: actionId(c.req.action), payload: c.req.payload, mode: 'PROPOSE' as const };
  const facts = must(reservationFacts(c.snapshot.state));
  const scope = { principal: c.snapshot.principal, action: scoped, invariants: [], aggregates: [], reservations: factsFor(c.m.ref, facts).own };
  const needs = must(c.m.stateRequirements(scope));
  const decision = must(decideWith(PRODUCTION_PIPELINE, c.snapshot, c.req, env));
  const n = decision.invariants.length;

  const admission = medianMicros(200, () => {
    const prepared = must(prepareStates(c.req.states, 's'));
    const eff = needs.map((x) => must(effectiveNeed(c.m, x, authority.effective.statePolicies, 'n')));
    must(admitNeeds(must(mergeNeeds(eff, 'r')), prepared, ctx, 'state'));
  });
  const admitted = decision.admissions.map((a) => a.state);
  const projection = medianMicros(200, () => {
    must(c.m.project(scope, admitted));
  });
  const stateEval = medianMicros(100, () => {
    const e = must(evaluateState(PRODUCTION_PIPELINE, { snapshot: c.snapshot, effective: authority.effective, acting: c.m, action: scoped, prepared: must(prepareStates(c.req.states, 's')), ctx, catalog: c.w.catalog }));
    invariantVerdict(e.results);
  });
  const reservation = medianMicros(200, () => {
    must(applyBatch(c.snapshot.state, [must(deriveReserveEvent(c.snapshot.state, decision.plan, T))], env.rules));
  });
  const total = medianMicros(100, () => {
    const d = must(decideWith(PRODUCTION_PIPELINE, c.snapshot, c.req, env));
    must(applyBatch(c.snapshot.state, [d.event], env.rules));
  });
  const factsStage = medianMicros(100, () => {
    must(reservationFacts(c.snapshot.state));
  });
  // Core's aggregate over the decision's own participants, if a principal-global aggregate applies.
  const agg = decision.invariants.find((r) => r.evaluator.kind === 'CORE');
  let aggregateStage = '—';
  if (agg !== undefined) {
    const spec = aggregateSpecOf(agg.term);
    if (!spec.ok) throw new Error(spec.error);
    const views: ParticipantView[] = decision.projection.participants.map((p) => ({
      module: p.module,
      projection: p.projection,
      admitted: new Map<StateId, StateEnvelope>(decision.admissions.filter((a) => a.need.module.ref.moduleDigest === p.module.moduleDigest).map((a) => [a.state.stateId, a.state.envelope])),
    }));
    const active = [...new Map(facts.map((f) => [f.module.moduleDigest, f.module])).values()];
    aggregateStage = medianMicros(100, () => {
      evaluateAggregate(spec.value as AggregateSpec, views, active);
    }).toFixed(1);
  }
  return {
    case: c.name,
    invariants: n,
    states: decision.bindings.length,
    legs: decision.event.legs.reduce((s, l) => s + l.length, 0),
    lineage: decision.lineage.length,
    pending: facts.length,
    'admission µs': admission.toFixed(1),
    'projection µs': projection.toFixed(1),
    'admission+projection+invariants µs': stateEval.toFixed(1),
    'ledger reservation µs': reservation.toFixed(1),
    'reservation facts µs': factsStage.toFixed(1),
    'aggregate µs': aggregateStage,
    participants: decision.projection.participants.length,
    'total µs': total.toFixed(1),
  };
}

const cases = [
  await build('1 invariant / 1 dimension', { invariants: 'ONE', depth: 1, dims: 'ONE', pending: 0 }),
  await build('5 invariants / 4 dimensions', { invariants: 'FIVE', depth: 1, dims: 'FOUR', pending: 0 }),
  await build('5-deep lineage', { invariants: 'ONE', depth: 5, dims: 'ONE', pending: 0 }),
  await build('20 pending reservation facts', { invariants: 'ONE', depth: 1, dims: 'ONE', pending: 20 }),
  await build('100 pending reservation facts', { invariants: 'ONE', depth: 1, dims: 'ONE', pending: 100 }),
  await build('1,000 pending reservation facts', { invariants: 'ONE', depth: 1, dims: 'ONE', pending: 1_000 }),
  await buildGlobal('global aggregate, 20 pending', 20),
  await buildGlobal('global aggregate, 100 pending', 100),
  await buildGlobal('global aggregate, 1,000 pending', 1_000),
  await buildGlobal('global aggregate, 4,096 pending', 4_096),
];
process.stdout.write(`control benchmark — Node ${process.version}, median of ${ROUNDS} rounds\n`);
for (const c of cases) process.stdout.write(`${JSON.stringify(measure(c))}\n`);
