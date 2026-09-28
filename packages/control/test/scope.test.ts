/**
 * Closed aggregate scope and the policy-update baseline (7D.1 rulings;
 * aggregate.ts, pipeline.ts; ledger reducer `checkPolicyBaseline`).
 *
 * - An aggregate names the exact `ModuleRef`s whose facts it understands.
 *   Every module with an unresolved reservation is consulted for it anyway,
 *   so pending activity never drops out because a policy stopped listing its
 *   module: a matching fact from an unlisted module, or an unlisted module
 *   that cannot be consulted, makes the aggregate UNKNOWN.
 * - A new or tightened principal-global invariant cannot become active once
 *   anything was reserved: no baseline is established (AUTH-GLOBAL-2 is not).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthorityGrant, StateInvariantInput } from '@mandate/core';
import { AuthorityLedger, CORE_RULES, replay, replayEncoded, type LedgerOutcome } from '@mandate/ledger';
import { ControlEngine, ModuleCatalog, controlRules, type RegistrationOutcome } from '../src/index.ts';
import {
  AGENT_A,
  AGENT_B,
  AGENT_C,
  ETH,
  ONCE,
  RETRY,
  SPOT_CFG,
  T,
  account,
  action,
  aggregate,
  assetValued,
  assetValuedModules,
  authorized,
  capitalDim,
  context,
  createSyntheticModule,
  evidenceFor,
  marketStates,
  must,
  policy,
  refused,
  registerPolicy,
  request,
  root,
  setup,
  sizeFor,
  world,
  type SyntheticModule,
  type World,
} from './support/world.ts';

function committed(o: RegistrationOutcome | LedgerOutcome): void {
  if (o.status === 'REGISTERED' || o.status === 'COMMITTED') return;
  assert.fail(`expected it committed, got ${o.status}${'refusal' in o ? ` ${o.refusal.code} at ${o.refusal.path}` : ''}`);
}

/** The ledger rule that refused the update. */
function refusedUpdate(o: RegistrationOutcome): string {
  if (o.status !== 'REFUSED') assert.fail(`expected REFUSED, got ${o.status}`);
  return o.refusal.reason;
}

interface Fixture {
  readonly w: World;
  readonly perp: SyntheticModule;
  readonly spot: SyntheticModule;
  readonly rootA: AuthorityGrant;
  readonly rootB: AuthorityGrant;
  readonly agg: (whole: number, contributors: readonly SyntheticModule[]) => StateInvariantInput;
  readonly states: ReturnType<typeof marketStates>;
  readonly ctx: ReturnType<typeof context>;
}

/** Policy 1: BTC marked exposure ≤ 10,000 over spot and perp. Agent A trades spot, agent B perp. */
async function fixture(extra: readonly SyntheticModule[] = []): Promise<Fixture> {
  const w = world({ modules: [...assetValuedModules(), ...extra] });
  const perp = w.modules[0] as SyntheticModule;
  const spot = w.modules[1] as SyntheticModule;
  const acctS = account(spot);
  const acctP = account(perp);
  const agg = (whole: number, contributors: readonly SyntheticModule[]) => aggregate({ whole, contributors, accounts: [acctS, acctP] });
  const rootA = root({ mods: [spot], holder: AGENT_A, terms: [capitalDim('capital', 100_000)] });
  const rootB = root({ mods: [perp], holder: AGENT_B, nonce: 1n, terms: [capitalDim('capital', 100_000)] });
  await setup(w, policy([agg(10_000, [spot, perp])]), [rootA, rootB]);
  const states = [...marketStates(spot, [{ account: acctS }]), ...marketStates(perp, [{ account: acctP }])];
  const ctx = context([perp, spot], { accounts: [{ module: spot, account: acctS }, { module: perp, account: acctP }] });
  return { w, perp, spot, rootA, rootB, agg, states, ctx };
}

describe('closed aggregate scope: an unlisted module\'s activity is never silently ignored', () => {
  it('pending BTC under a module the new policy no longer lists makes the aggregate UNKNOWN; it counts again once resolved', async () => {
    const f = await fixture();
    const pending = authorized(await f.w.engine.authorizeAndReserve(request(action(f.spot, { authority: f.rootA, size: sizeFor(3_000) }), f.states, f.ctx), RETRY));
    // Dropping a contributor is provably no stronger, so no baseline is needed to install it…
    committed(await registerPolicy(f.w, policy([f.agg(10_000, [f.perp])], 2n), T));
    // …but spot's unresolved 3,000 does not disappear from the aggregate with it.
    const r = refused(await f.w.engine.authorizeAndReserve(request(action(f.perp, { authority: f.rootB, size: sizeFor(1_000) }), f.states, f.ctx), RETRY));
    assert.equal(r.code, 'INVARIANT_UNKNOWN');
    assert.equal(r.reason, 'UNDECLARED_CONTRIBUTOR');
    // Resolved (the test-only infrastructure CLOSE), spot has no activity left for the aggregate to miss.
    const infra = new AuthorityLedger(f.w.store, f.w.registry, controlRules(f.w.catalog));
    committed(await infra.settle(pending.principal, [{ kind: 'CLOSE', reservation: pending.reservation, generation: pending.generation, evidence: evidenceFor('test-release') }], T, ONCE));
    authorized(await f.w.engine.authorizeAndReserve(request(action(f.perp, { authority: f.rootB, size: sizeFor(1_000) }), f.states, f.ctx), RETRY));
  });

  it('an unlisted module with unresolved reservations that cannot be consulted makes the aggregate UNKNOWN', async () => {
    const f = await fixture();
    authorized(await f.w.engine.authorizeAndReserve(request(action(f.spot, { authority: f.rootA, size: sizeFor(3_000) }), f.states, f.ctx), RETRY));
    committed(await registerPolicy(f.w, policy([f.agg(10_000, [f.perp])], 2n), T));
    // An engine whose catalog has no implementation for spot: its pending activity cannot be accounted for.
    const perpOnly = must(ModuleCatalog.create(f.w.registry, [{ module: f.perp, corpus: [] }]));
    const engine = new ControlEngine({ store: f.w.store, registry: f.w.registry, catalog: perpOnly });
    const r = refused(await engine.authorizeAndReserve(request(action(f.perp, { authority: f.rootB, size: sizeFor(1_000) }), f.states, f.ctx), RETRY));
    assert.equal(r.code, 'INVARIANT_UNKNOWN');
    assert.equal(r.reason, 'UNDECLARED_MODULE_UNAVAILABLE');
  });

  it('an unlisted module is consulted under its exact semantics, not refused by name: its pending ETH is not BTC', async () => {
    const f = await fixture();
    authorized(await f.w.engine.authorizeAndReserve(request(action(f.spot, { authority: f.rootA, size: sizeFor(3_000), market: 'x:ETH-SPOT' }), f.states, f.ctx), RETRY));
    committed(await registerPolicy(f.w, policy([f.agg(10_000, [f.perp])], 2n), T));
    const d = await f.w.engine.decide(request(action(f.perp, { authority: f.rootB, size: sizeFor(1_000) }), f.states, f.ctx));
    assert.ok(d.ok, d.ok ? '' : `${d.error.code}/${d.error.reason}`);
    // Spot was a participant: asked, under its own ModuleRef, for its part of the BTC aggregate.
    if (d.ok) assert.ok(d.value.projection.participants.some((p) => p.module.moduleDigest === f.spot.ref.moduleDigest && p.reservations.length === 1));
  });

  it('a module of a listed module\'s domain, under another ModuleRef, is not trusted by DomainId', async () => {
    const spot2 = createSyntheticModule({ ...assetValued(SPOT_CFG), moduleVersion: 2 });
    const f = await fixture([spot2]);
    const rootC = root({ mods: [spot2], holder: AGENT_C, nonce: 2n, terms: [capitalDim('capital', 100_000)] });
    assert.equal((await f.w.engine.registerDelegation(rootC, T, ONCE)).status, 'REGISTERED');
    const states = [...f.states, ...marketStates(spot2, [{ account: account(spot2) }])];
    const ctx = context([f.perp, f.spot, spot2], { accounts: [{ module: f.spot, account: account(f.spot) }, { module: f.perp, account: account(f.perp) }] });
    const r = refused(await f.w.engine.authorizeAndReserve(request(action(spot2, { authority: rootC, size: sizeFor(100) }), states, ctx), RETRY));
    assert.equal(r.code, 'INVARIANT_UNKNOWN');
    assert.equal(r.reason, 'UNDECLARED_CONTRIBUTOR');
  });
});

describe('policy update: a new or tightened principal-global invariant requires a baseline', () => {
  it('before anything is reserved the empty baseline is provable: tightening is allowed', async () => {
    const f = await fixture();
    committed(await registerPolicy(f.w, policy([f.agg(5_000, [f.spot, f.perp])], 2n), T));
  });

  it('after activity: a tighter limit, an added contributor or a new aggregate is refused POLICY_UPDATE_REQUIRES_BASELINE', async () => {
    const spot2 = createSyntheticModule({ ...assetValued(SPOT_CFG), moduleVersion: 2 });
    const f = await fixture([spot2]);
    authorized(await f.w.engine.authorizeAndReserve(request(action(f.spot, { authority: f.rootA, size: sizeFor(3_000) }), f.states, f.ctx), RETRY));
    const eth = aggregate({ whole: 1_000_000, contributors: [f.spot], accounts: [account(f.spot)], asset: ETH });
    for (const terms of [[f.agg(9_999, [f.spot, f.perp])], [f.agg(10_000, [f.spot, f.perp, spot2])], [f.agg(10_000, [f.spot, f.perp]), eth]]) {
      assert.equal(refusedUpdate(await registerPolicy(f.w, policy(terms, 2n), T)), 'POLICY_UPDATE_REQUIRES_BASELINE');
    }
    // The refused updates wrote nothing: policy 1 still decides.
    const snap = await f.w.store.read(f.rootA.principal);
    assert.equal(snap.state.policy?.policy.sequence, 1n);
  });

  it('after activity: an unchanged restatement, a looser limit and a removal need no baseline, and replay re-proves the loosening', async () => {
    const f = await fixture();
    authorized(await f.w.engine.authorizeAndReserve(request(action(f.spot, { authority: f.rootA, size: sizeFor(3_000) }), f.states, f.ctx), RETRY));
    committed(await registerPolicy(f.w, policy([f.agg(10_000, [f.spot, f.perp])], 2n), T));
    committed(await registerPolicy(f.w, policy([f.agg(20_000, [f.spot, f.perp])], 3n), T));
    committed(await registerPolicy(f.w, policy([], 4n), T));
    const principal = f.rootA.principal;
    const history = await f.w.store.history(principal);
    const head = (await f.w.store.read(principal)).head;
    const replayed = replayEncoded(principal, history.map((b) => b.encoded), controlRules(f.w.catalog));
    assert.ok(replayed.ok);
    if (replayed.ok) assert.equal(replayed.value.head, head);
    // Without the ordering the loosening is unprovable, and replay refuses rather than accept it.
    const bare = replay(principal, history.map((b) => b.events), CORE_RULES);
    assert.ok(!bare.ok);
    if (!bare.ok) assert.equal(bare.error.code, 'POLICY_UPDATE_REQUIRES_BASELINE');
  });
});
