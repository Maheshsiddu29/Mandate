/**
 * Semantic delegation narrowing (AUTH-2 semantic half; authority-model.md §4;
 * examples.md §D; brief §17–§19). The verdict is always the owning
 * definition's, resolved by exact ModuleRef; no caller ever supplies one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthorityGrant, StateInvariantInput } from '@mandate/core';
import { replay } from '@mandate/ledger';
import { ControlEngine, controlRules, type RegistrationOutcome } from '../src/index.ts';
import {
  AGENT_A,
  AGENT_B,
  ONCE,
  PERP_CFG,
  RETRY,
  SPOT_CFG,
  T0,
  account,
  action,
  aggregate,
  authorized,
  capitalDim,
  child,
  context,
  createSyntheticModule,
  marketStates,
  maxLeverage,
  policy,
  refused,
  request,
  root,
  setup,
  sizeFor,
  usd,
  world,
  type SyntheticModule,
  type World,
} from './support/world.ts';

function registered(o: RegistrationOutcome): Extract<RegistrationOutcome, { status: 'REGISTERED' }> {
  if (o.status !== 'REGISTERED') assert.fail(`expected REGISTERED, got ${o.status} ${o.refusal.code}/${o.refusal.reason}`);
  return o;
}

function refusedRegistration(o: RegistrationOutcome) {
  if (o.status !== 'REFUSED') assert.fail(`expected REFUSED, got ${o.status}`);
  return o.refusal;
}

async function parentWith(w: World, invariant: (m: SyntheticModule) => StateInvariantInput): Promise<{ m: SyntheticModule; parent: AuthorityGrant }> {
  const m = w.modules[0] as SyntheticModule;
  const parent = root({ mods: [m], holder: AGENT_A, delegate: 1, terms: [capitalDim('capital', 100_000), invariant(m)] });
  await setup(w, policy(), [parent]);
  return { m, parent };
}

describe('noWeaker by the owning module', () => {
  it('parent ≤ 4x, child ≤ 3x registers, with the proof naming the exact comparator (brief §19)', async () => {
    const w = world();
    const { m, parent } = await parentWith(w, (x) => maxLeverage(x, account(x), 4n));
    const c = child(parent, { mods: [m], holder: AGENT_B, terms: [maxLeverage(m, account(m), 3n)] });
    const r = registered(await w.engine.registerDelegation(c, T0, ONCE));
    assert.equal(r.proofs.length, 1);
    assert.equal(r.proofs[0]?.verdict, 'NO_WEAKER');
    assert.deepEqual(r.proofs[0]?.evaluator, { kind: 'MODULE', module: m.ref });
  });

  it('parent ≤ 4x, child ≤ 5x is refused DELEGATION_WEAKENS_INVARIANT', async () => {
    const w = world();
    const { m, parent } = await parentWith(w, (x) => maxLeverage(x, account(x), 4n));
    const r = refusedRegistration(await w.engine.registerDelegation(child(parent, { mods: [m], holder: AGENT_B, terms: [maxLeverage(m, account(m), 5n)] }), T0, ONCE));
    assert.equal(r.code, 'DELEGATION_REFUSED');
    assert.equal(r.detail.kind, 'DELEGATION');
    if (r.detail.kind === 'DELEGATION') {
      assert.deepEqual(r.detail.violations.map((v) => v.code), ['DELEGATION_WEAKENS_INVARIANT']);
      assert.equal(r.detail.proofs[0]?.verdict, 'WEAKER');
    }
  });

  it('two different opaque invariants no module can order stay refused', async () => {
    const w = world();
    const opaque = (params: string): StateInvariantInput => ({ kind: 'STATE_INVARIANT', invariantId: 'nobody.opaque', version: 1, scope: [], params });
    const { m, parent } = await parentWith(w, () => opaque('0x01'));
    const r = refusedRegistration(await w.engine.registerDelegation(child(parent, { mods: [m], holder: AGENT_B, terms: [opaque('0x02')] }), T0, ONCE));
    assert.equal(r.code, 'SEMANTIC_NARROWING_UNPROVABLE');
    if (r.detail.kind === 'DELEGATION') assert.deepEqual(r.detail.proofs.map((p) => [p.verdict, p.evaluator.kind]), [['UNPROVABLE', 'NONE']]);
  });

  it('the narrowed child is enforced by both invariants at action time: 3.5x passes the parent, fails the child', async () => {
    const w = world();
    const { m, parent } = await parentWith(w, (x) => maxLeverage(x, account(x), 4n));
    const c = child(parent, { mods: [m], holder: AGENT_B, terms: [maxLeverage(m, account(m), 3n)] });
    registered(await w.engine.registerDelegation(c, T0, ONCE));
    const acct = account(m);
    const states = marketStates(m, [{ account: acct, collateral: usd(1_000) }]);
    const ctx = context([m], { accounts: [{ module: m, account: acct }] });
    const r = refused(await w.engine.authorizeAndReserve(request(action(m, { authority: c, size: sizeFor(3_500) }), states, ctx), RETRY));
    assert.equal(r.code, 'INVARIANT_FAILED');
    if (r.detail.kind === 'INVARIANTS') assert.deepEqual(r.detail.results.map((x) => x.outcome).sort(), ['HOLDS', 'VIOLATED']);
    authorized(await w.engine.authorizeAndReserve(request(action(m, { authority: parent, size: sizeFor(3_500) }), states, ctx), RETRY));
  });

  it('a different module digest is a different comparator, resolved afresh; the other catalog cannot replay its proof', async () => {
    // Catalog A: the reference semantics. Catalog B: a module under the same name whose digest differs (a lenient comparator).
    const a = world();
    const lenient = createSyntheticModule({ ...PERP_CFG, variant: 'LENIENT_NARROWING' });
    assert.notEqual(lenient.ref.moduleDigest, (a.modules[0] as SyntheticModule).ref.moduleDigest);
    const b = world({ modules: [lenient] });
    const pa = await parentWith(a, (x) => maxLeverage(x, account(x), 4n));
    const pb = await parentWith(b, (x) => maxLeverage(x, account(x), 4n));
    refusedRegistration(await a.engine.registerDelegation(child(pa.parent, { mods: [pa.m], holder: AGENT_B, terms: [maxLeverage(pa.m, account(pa.m), 5n)] }), T0, ONCE));
    const rb = registered(await b.engine.registerDelegation(child(pb.parent, { mods: [pb.m], holder: AGENT_B, terms: [maxLeverage(pb.m, account(pb.m), 5n)] }), T0, ONCE));
    assert.deepEqual(rb.proofs[0]?.evaluator, { kind: 'MODULE', module: lenient.ref });
    // B's history does not replay under A's ordering: A's comparator proves the child weaker.
    const history = await b.store.history(pb.parent.principal);
    const replayed = replay(pb.parent.principal, history.map((x) => x.events), controlRules(a.catalog));
    assert.ok(!replayed.ok);
    assert.ok(replay(pb.parent.principal, history.map((x) => x.events), controlRules(b.catalog)).ok);
  });

  it('a store not configured with the catalog\'s ordering refuses the proven narrowing at commit (LEDGER_CONFLICT, fail closed)', async () => {
    const w = world();
    const { m, parent } = await parentWith(w, (x) => maxLeverage(x, account(x), 4n));
    const { InMemoryLedgerStore, AuthorityLedger } = await import('@mandate/ledger');
    const plainStore = new InMemoryLedgerStore();
    const plainLedger = new AuthorityLedger(plainStore, w.registry);
    await plainLedger.registerPolicy(policy(), T0, ONCE);
    await plainLedger.registerGrant(parent, T0, ONCE);
    const engine = new ControlEngine({ store: plainStore, registry: w.registry, catalog: w.catalog });
    const r = refusedRegistration(await engine.registerDelegation(child(parent, { mods: [m], holder: AGENT_B, terms: [maxLeverage(m, account(m), 3n)] }), T0, ONCE));
    assert.equal(r.code, 'LEDGER_CONFLICT');
  });

  it('a retiring owner cannot prove a new narrowing', async () => {
    const w = world({ status: () => 'RETIRING' });
    const { m, parent } = await parentWith(w, (x) => maxLeverage(x, account(x), 4n));
    const r = refusedRegistration(await w.engine.registerDelegation(child(parent, { mods: [m], holder: AGENT_B, terms: [maxLeverage(m, account(m), 3n)] }), T0, ONCE));
    assert.equal(r.code, 'SEMANTIC_NARROWING_UNPROVABLE');
    assert.equal(r.reason, 'COMPARATOR_NOT_ACTIVE');
  });

  it('the registration API takes a grant, a time and a retry policy — never a verdict', () => {
    assert.equal(ControlEngine.prototype.registerDelegation.length, 3);
    const names = Object.getOwnPropertyNames(ControlEngine.prototype);
    for (const n of names) assert.doesNotMatch(n, /subset|verdict|proof|narrow(?!ing)|assert|force/i);
  });
});

describe('Core\'s own comparator for the aggregate invariant', () => {
  it('a smaller limit over at least the same contributors is no weaker; a larger limit or a dropped contributor is weaker', async () => {
    const perp = createSyntheticModule(PERP_CFG);
    const spot = createSyntheticModule(SPOT_CFG);
    const w = world({ modules: [perp, spot] });
    const acct = account(perp);
    const agg = (whole: number, contributors: SyntheticModule[]) => aggregate({ whole, contributors, accounts: [acct] });
    const parent = root({ mods: [perp], holder: AGENT_A, delegate: 1, terms: [capitalDim('capital', 1_000), agg(6_000, [perp])] });
    await setup(w, policy(), [parent]);
    const ok = registered(await w.engine.registerDelegation(child(parent, { mods: [perp], holder: AGENT_B, terms: [agg(5_000, [perp, spot])] }), T0, ONCE));
    assert.deepEqual(ok.proofs[0]?.evaluator, { kind: 'CORE' });
    for (const [whole, contributors] of [
      [7_000, [perp]],
      [5_000, [spot]],
    ] as const) {
      const r = refusedRegistration(await w.engine.registerDelegation(child(parent, { mods: [perp], holder: AGENT_B, nonce: BigInt(whole), terms: [agg(whole, [...contributors])] }), T0, ONCE));
      assert.equal(r.code, 'DELEGATION_REFUSED');
    }
  });
});
