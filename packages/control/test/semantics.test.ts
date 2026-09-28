/**
 * Immutable authority semantics (Phase 7D.3; SEMANTIC-AUTH-1…3).
 *
 * A grant or policy is bound, at registration, to the exact definition of
 * each module-defined term — the owning `ModuleRef`, digest included — and
 * every later authorization evaluates the term under exactly that
 * definition. A registry that later maps the invariant's name to another
 * digest changes nothing about existing authority: the old term is still
 * evaluated by A, B is never asked, and without A the action refuses. New
 * authority registered after the change binds to B. Same name, two meanings,
 * each fixed and auditable.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authorityId, type AuthorityGrant, type ResourceId } from '@mandate/core';
import { ReferenceModuleRegistry, encodeLedgerState, replayEncoded, semanticBindingId, semanticInvariantId, type SemanticTermBinding } from '@mandate/ledger';
import { ControlEngine, ModuleCatalog, ReferenceModuleArchive, controlRules, type RegistrationOutcome } from '../src/index.ts';
import { CFG, CFG_B, definitionOf, invariantFrom, registrationOf, spied, spotOrder, storedEvents, t0, t1, type Calls } from './support/drift.ts';
import {
  AGENT_A,
  AGENT_B,
  ONCE,
  RETRY,
  T,
  T0,
  account,
  authorized,
  capitalDim,
  child,
  createSyntheticModule,
  maxLeverage,
  must,
  policy,
  refused,
  registered,
  root,
  setup,
  world,
} from './support/world.ts';

describe('SEMANTIC-AUTH-1: a registered term is bound to its exact definition', () => {
  it('the registration event commits the binding to A — domain, id, version and digest — decoded from the stored bytes', async () => {
    const f = await t0();
    const e = registrationOf(await storedEvents(f.w), f.grant);
    const binding: SemanticTermBinding = { definition: definitionOf(f.a.ref), scope: [f.acctA as ResourceId] };
    assert.deepEqual(e.bindings, [binding]);
    assert.equal(e.proofs, undefined);
    // The node keeps it for its life.
    const node = (await f.w.store.read(f.grant.principal)).state.nodes.get(authorityId(f.grant));
    assert.deepEqual(node?.bindings, [binding]);
  });

  it('a Core-defined term carries no binding, and an event with none keeps its earlier bytes', async () => {
    const f = await t0({ grantTerms: () => [] });
    const e = registrationOf(await storedEvents(f.w), f.grant);
    assert.equal(e.bindings, undefined);
  });
});

describe('registry drift: the old grant is evaluated by A, never by B (SEMANTIC-AUTH-1, -2)', () => {
  it('at T0, A holds 3x and refuses 5x against the 4x term', async () => {
    const f = await t0();
    authorized(await f.w.engine.authorizeAndReserve(spotOrder(f, f.grant, 3, 1n), RETRY));
    const r = refused(await f.w.engine.authorizeAndReserve(spotOrder(f, f.grant, 5, 2n), RETRY));
    assert.equal(r.code, 'INVARIANT_FAILED');
  });

  it('at T1 the name maps to B, which would read 4x as 8x; the old term is still evaluated by archived A, and B is never called', async () => {
    const f = await t0();
    const x = t1(f, { archiveA: true });
    assert.equal(x.b.ref.moduleId, f.a.ref.moduleId);
    assert.equal(x.b.ref.moduleVersion, f.a.ref.moduleVersion);
    assert.notEqual(x.b.ref.moduleDigest, f.a.ref.moduleDigest);
    // B is the name's current owner: a name lookup would pick it.
    assert.equal(x.catalog.invariantOwner('perp.account-leverage', 1)?.ref.moduleDigest, x.b.ref.moduleDigest);

    // 5x: A says VIOLATED. (B, reading the bound as 8x, would have said HOLDS.)
    const r = refused(await x.engine.authorizeAndReserve(spotOrder(f, f.grant, 5, 1n), RETRY));
    assert.equal(r.code, 'INVARIANT_FAILED');
    const result = invariantFrom(r, 'perp.account-leverage');
    assert.equal(result.outcome, 'VIOLATED');
    assert.deepEqual(result.evaluator, { kind: 'MODULE', module: f.a.ref });

    // 3x: A says HOLDS, and the authorization records that A decided it.
    const ok = await x.engine.authorizeAndReserve(spotOrder(f, f.grant, 3, 2n), RETRY);
    authorized(ok);
    if (ok.status === 'AUTHORIZED') {
      const held = ok.decision.invariants.find((y) => y.term.invariantId === 'perp.account-leverage');
      assert.deepEqual(held?.evaluator, { kind: 'MODULE', module: f.a.ref });
      assert.equal(held?.outcome, 'HOLDS');
    }
    assert.ok(x.callsA.n > 0, 'A was asked');
    assert.equal(x.callsB.n, 0, 'B was never asked for the old term');
  });

  it('SEMANTIC-AUTH-3: with A unavailable the old term cannot be evaluated — the action refuses, and B is still never called', async () => {
    const f = await t0();
    const x = t1(f, { archiveA: false });
    for (const [leverage, nonce] of [[3, 1n], [5, 2n]] as const) {
      const r = refused(await x.engine.authorizeAndReserve(spotOrder(f, f.grant, leverage, nonce), RETRY));
      assert.equal(r.code, 'INVARIANT_UNKNOWN');
      const result = invariantFrom(r, 'perp.account-leverage');
      assert.equal(result.reason, 'SEMANTIC_DEFINITION_UNAVAILABLE');
      assert.deepEqual(result.evaluator, { kind: 'NONE' });
    }
    assert.equal(x.callsB.n, 0);
  });
});

describe('new authority binds to the new definition; both meanings stay fixed', () => {
  it('after the switch a new grant with the byte-identical term binds to B; the old grant still means A', async () => {
    const f = await t0();
    const x = t1(f, { archiveA: true });
    const fresh = root({ mods: [x.b, f.s], holder: AGENT_B, nonce: 7n, terms: [capitalDim('capital', 1_000_000), maxLeverage(x.b, account(x.b), 4n)] });
    // The very same term bytes as the old grant's: same name, version, scope and parameters.
    assert.deepEqual(fresh.terms.find((t) => t.kind === 'STATE_INVARIANT'), f.grant.terms.find((t) => t.kind === 'STATE_INVARIANT'));
    const outcome = await x.engine.registerDelegation(fresh, T0, ONCE);
    registered(outcome);
    if (outcome.status === 'REGISTERED') assert.deepEqual(outcome.bindings.map((b) => b.definition), [definitionOf(x.b.ref)]);

    // 5x: the old grant refuses under A; the new grant holds under B (bound 8x).
    const old = refused(await x.engine.authorizeAndReserve(spotOrder(f, f.grant, 5, 1n), RETRY));
    assert.deepEqual(invariantFrom(old, 'perp.account-leverage').evaluator, { kind: 'MODULE', module: f.a.ref });
    const now = await x.engine.authorizeAndReserve(spotOrder(f, fresh, 5, 2n, x.b), RETRY);
    authorized(now);
    if (now.status === 'AUTHORIZED') assert.deepEqual(now.decision.invariants.find((y) => y.term.invariantId === 'perp.account-leverage')?.evaluator, { kind: 'MODULE', module: x.b.ref });

    // Independently auditable: each node carries its own committed definition.
    const state = (await f.w.store.read(f.grant.principal)).state;
    assert.deepEqual(state.nodes.get(authorityId(f.grant))?.bindings.map((b) => b.definition), [definitionOf(f.a.ref)]);
    assert.deepEqual(state.nodes.get(authorityId(fresh))?.bindings.map((b) => b.definition), [definitionOf(x.b.ref)]);

    // The whole history replays to the same state and head under B current and A archived.
    const history = await f.w.store.history(f.grant.principal);
    const replayed = replayEncoded(f.grant.principal, history.map((b) => b.encoded), controlRules(x.catalog));
    assert.ok(replayed.ok);
    if (replayed.ok) assert.deepEqual(encodeLedgerState(replayed.value), encodeLedgerState(state));
  });
});

describe('same human-readable name, different semantic identity', () => {
  it('A and B both define perp.account-leverage v1; their definitions and bindings are different identities, and neither resolves for the other', async () => {
    const a = createSyntheticModule(CFG);
    const b = createSyntheticModule(CFG_B);
    assert.deepEqual(a.invariants, b.invariants);
    assert.notEqual(a.ref.moduleDigest, b.ref.moduleDigest);
    const [da, db] = [definitionOf(a.ref), definitionOf(b.ref)];
    assert.equal(da.invariantId, db.invariantId);
    assert.notEqual(semanticInvariantId(da), semanticInvariantId(db));
    const scope = [account(a) as ResourceId];
    assert.notEqual(semanticBindingId({ definition: da, scope }), semanticBindingId({ definition: db, scope }));

    const bCurrent = must(ReferenceModuleRegistry.create([{ module: b.ref, status: 'ACTIVE', implementations: [b.implementation] }]));
    const onlyB = must(ModuleCatalog.create(bCurrent, [{ module: b, corpus: [] }]));
    // B owns the name now, and still never answers for A.
    assert.equal(onlyB.invariantOwner(da.invariantId, da.version), onlyB.resolveDefinition(db));
    assert.equal(onlyB.resolveDefinition(da), null);
    const archive = must(ReferenceModuleArchive.create([{ module: a.ref, implementations: [a.implementation] }]));
    const both = must(ModuleCatalog.create(bCurrent, [{ module: b, corpus: [] }], { archive, modules: [{ module: a, corpus: [] }] }));
    assert.equal(both.resolveDefinition(da)?.ref.moduleDigest, a.ref.moduleDigest);
    assert.equal(both.resolveDefinition(db)?.ref.moduleDigest, b.ref.moduleDigest);
  });
});

describe('narrowing proofs agree with the bindings of both terms', () => {
  it('after the switch, restating an A-bound term under B is refused: the proof would name B for a term that means A', async () => {
    const f = await t0();
    const x = t1(f, { archiveA: true });
    const c = child(f.grant, { mods: [f.a, f.s], holder: AGENT_B, terms: [capitalDim('capital', 1_000), maxLeverage(f.a, f.acctA, 3n)] });
    const r = await x.engine.registerDelegation(c, T0, ONCE);
    assert.equal(r.status, 'REFUSED');
    if (r.status === 'REFUSED') {
      assert.equal(r.refusal.code, 'SEMANTIC_BINDING_REFUSED');
      assert.equal(r.refusal.reason, 'SEMANTIC_BINDING_MISMATCH');
    }
    assert.equal(x.callsA.n + x.callsB.n, 0, 'no comparator is asked across two meanings');
  });

  it('a proof naming B for a child whose term, like its parent\'s, is bound to A is refused at commit', async () => {
    const f = await t0();
    const b = createSyntheticModule(CFG_B);
    const c = child(f.grant, { mods: [f.a, f.s], holder: AGENT_B, terms: [capitalDim('capital', 1_000), maxLeverage(f.a, f.acctA, 3n)] });
    const scope = [f.acctA as ResourceId];
    const s = await f.w.store.read(f.grant.principal);
    const direct = await f.w.store.compareAndAppend(s.principal, s.version, s.head, [
      { kind: 'REGISTER_GRANT', at: T0, grant: c, bindings: [{ definition: definitionOf(f.a.ref), scope }], proofs: [{ definition: definitionOf(b.ref), scope }] },
    ]);
    assert.equal(direct.status === 'REFUSED' ? `${direct.refusal.code} at ${direct.refusal.path}` : direct.status, 'SEMANTIC_BINDING_MISMATCH at events[0].proofs[0].definition');
    // Consistent, it commits: binding A, proof A.
    const ok = await f.w.engine.registerDelegation(c, T0, ONCE);
    assert.equal(ok.status, 'REGISTERED');
    if (ok.status === 'REGISTERED') assert.deepEqual(ok.proofs[0]?.definition, definitionOf(f.a.ref));
  });
});

describe('principal policy terms keep their committed meaning', () => {
  it('a principal-global term bound to A is evaluated by A after the switch; restating it after activity rebinds it to B only through a baseline, which is refused', async () => {
    const f = await t0({ grantTerms: () => [], policyTerms: (a) => [maxLeverage(a, account(a), 4n)] });
    assert.deepEqual((await f.w.store.read(f.grant.principal)).state.policy?.bindings.map((b) => b.definition), [definitionOf(f.a.ref)]);
    // Activity under A.
    authorized(await f.w.engine.authorizeAndReserve(spotOrder(f, f.grant, 3, 1n), RETRY));
    const x = t1(f, { archiveA: true });
    const r = refused(await x.engine.authorizeAndReserve(spotOrder(f, f.grant, 5, 2n), RETRY));
    const result = invariantFrom(r, 'perp.account-leverage');
    assert.equal(result.origin, 'POLICY');
    assert.deepEqual(result.evaluator, { kind: 'MODULE', module: f.a.ref });
    assert.equal(x.callsB.n, 0);
    // The same term restated, now bound to B: a new constraint on existing activity.
    const update = await x.engine.registerPolicy(policy([maxLeverage(f.a, f.acctA, 4n)], 2n), T, ONCE);
    assert.equal(update.status === 'REFUSED' ? update.refusal.reason : update.status, 'POLICY_UPDATE_REQUIRES_BASELINE');
    assert.equal(x.callsA.n + x.callsB.n, 1, 'only the refused action\'s evaluation by A: no comparator was asked across two meanings');
    assert.deepEqual((await f.w.store.read(f.grant.principal)).state.policy?.bindings.map((b) => b.definition), [definitionOf(f.a.ref)]);
  });

  it('before any activity, the principal may explicitly register a new policy, which binds to B', async () => {
    const f = await t0({ grantTerms: () => [], policyTerms: (a) => [maxLeverage(a, account(a), 4n)] });
    const x = t1(f, { archiveA: true });
    const update = await x.engine.registerPolicy(policy([maxLeverage(f.a, f.acctA, 4n)], 2n), T0, ONCE);
    assert.equal(update.status, 'REGISTERED');
    assert.deepEqual((await f.w.store.read(f.grant.principal)).state.policy?.bindings.map((b) => b.definition), [definitionOf(x.b.ref)]);
    const now = await x.engine.authorizeAndReserve(spotOrder(f, f.grant, 5, 1n, x.b), RETRY);
    authorized(now);
    if (now.status === 'AUTHORIZED') assert.deepEqual(now.decision.invariants.find((y) => y.origin === 'POLICY')?.evaluator, { kind: 'MODULE', module: x.b.ref });
  });
});

describe('retirement is lifecycle, not meaning', () => {
  it('A retiring: the old term is still evaluated by A for new actions; new authority cannot bind to A; the committed digest never changes', async () => {
    const f = await t0();
    const retiring = must(
      ReferenceModuleRegistry.create([
        { module: f.a.ref, status: 'RETIRING', implementations: [f.a.implementation] },
        { module: f.s.ref, status: 'ACTIVE', implementations: [f.s.implementation] },
      ]),
    );
    const calls: Calls = { n: 0 };
    const catalog = must(ModuleCatalog.create(retiring, [{ module: spied(f.a, calls), corpus: [] }, { module: f.s, corpus: [] }]));
    const engine = new ControlEngine({ store: f.w.store, registry: retiring, catalog });
    const r = refused(await engine.authorizeAndReserve(spotOrder(f, f.grant, 5, 1n), RETRY));
    assert.deepEqual(invariantFrom(r, 'perp.account-leverage').evaluator, { kind: 'MODULE', module: f.a.ref });
    authorized(await engine.authorizeAndReserve(spotOrder(f, f.grant, 3, 2n), RETRY));
    assert.ok(calls.n > 0);
    const again = await engine.registerDelegation(root({ mods: [f.a, f.s], holder: AGENT_B, nonce: 3n, terms: [maxLeverage(f.a, f.acctA, 4n)] }), T0, ONCE);
    assert.equal(again.status === 'REFUSED' ? again.refusal.code : again.status, 'SEMANTIC_BINDING_REFUSED');
    assert.equal(again.status === 'REFUSED' ? again.refusal.reason : again.status, 'MODULE_RETIRING');
    assert.deepEqual((await f.w.store.read(f.grant.principal)).state.nodes.get(authorityId(f.grant))?.bindings.map((b) => b.definition), [definitionOf(f.a.ref)]);
  });
});

describe('caller trust boundary: no caller supplies semantics', () => {
  it('the registration surface takes an object, a time and a retry policy; extra arguments and fields change nothing that is committed', async () => {
    assert.equal(ControlEngine.prototype.registerDelegation.length, 3);
    assert.equal(ControlEngine.prototype.registerPolicy.length, 3);
    const source = readFileSync(new URL('../src/engine.ts', import.meta.url), 'utf8');
    assert.match(source, /async registerDelegation\(grant: AuthorityGrant, at: bigint, retry: RetryPolicy\): Promise<RegistrationOutcome>/);
    assert.match(source, /async registerPolicy\(policy: PrincipalPolicy, at: bigint, retry: RetryPolicy\): Promise<RegistrationOutcome>/);

    const a = createSyntheticModule(CFG);
    const b = createSyntheticModule(CFG_B);
    const w = world({ modules: [a] });
    await setup(w, policy(), []);
    const scope = [account(a) as ResourceId];
    const forged: SemanticTermBinding = { definition: definitionOf(b.ref), scope };
    const g = root({ mods: [a], holder: AGENT_A, terms: [maxLeverage(a, account(a), 4n)] });
    // A caller asserting its own semantics, as fields of the grant and as extra arguments.
    const claiming = { ...g, bindings: [forged], proofs: [forged], semanticNarrowing: true } as AuthorityGrant;
    const loose = w.engine.registerDelegation.bind(w.engine) as unknown as (...args: unknown[]) => Promise<RegistrationOutcome>;
    const r = await loose(claiming, T0, ONCE, { bindings: [forged], proofs: [forged] }, [forged], true);
    assert.equal(r.status, 'REGISTERED');
    if (r.status === 'REGISTERED') assert.deepEqual(r.bindings, [{ definition: definitionOf(a.ref), scope }]);
    assert.deepEqual(registrationOf(await storedEvents(w), g).bindings, [{ definition: definitionOf(a.ref), scope }]);

    // The ledger's infrastructure form, which does take derived semantics, refuses a definition that is not current.
    const infra = await w.ledger.registerGrant(root({ mods: [a], holder: AGENT_B, nonce: 1n, terms: [maxLeverage(a, account(a), 4n)] }), T0, ONCE, { bindings: [forged] });
    assert.equal(infra.status === 'REFUSED' ? infra.refusal.code : infra.status, 'MODULE_DIGEST_MISMATCH');
  });
});
