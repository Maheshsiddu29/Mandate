/**
 * Semantic term bindings (Phase 7D.3). Every module-defined term of a
 * registered grant or policy is bound, in its registration event, to one
 * exact definition; the reducer checks the binding set at commit and at
 * replay, a restated term keeps its parent's meaning, a proof agrees with the
 * binding of the term it orders, and history with an unbound module-defined
 * term does not replay. The ledger never infers a binding from a registry.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authorityId, encodeWith, type ModuleRef, type ResourceId, type StateInvariantInput } from '@mandate/core';
import {
  AuthorityLedger,
  InMemoryLedgerStore,
  applyBatch,
  batchHead,
  canonicalBindings,
  checkBindingSet,
  decodeBatch,
  effectiveAuthority,
  encodeBatch,
  encodeLedgerState,
  grantInvariants,
  replay,
  replayEncoded,
  resolveLineage,
  semanticBindingId,
  semanticProofId,
  writeSemanticTermBinding,
  type InvariantOrdering,
  type LedgerEvent,
  type LedgerRefusal,
  type LedgerState,
  type ReducerRules,
  type SemanticInvariantRef,
  type SemanticTermBinding,
} from '../src/index.ts';
import { ALL_MODULES, DELEGATE, ONCE, PERP_V1, PERP_V1_OTHER_DIGEST, PERP_V2, PRINCIPAL, REGISTRY, RETIRED_V0, SPOT_V1, T0, TRADING, UNREGISTERED, child, committed, moduleRef, must, policy, refused, root } from './support/fixtures.ts';
import { genesis, step, stepRefused } from './support/steps.ts';

const LEVERAGE = 'perp-policy.accountLeverage';
const ACCT: ResourceId = { domain: 'perp', kind: 'ACCOUNT', localId: 'acct-1' } as ResourceId;
const leverage = (params: string, scope: readonly ResourceId[] = []): StateInvariantInput => ({ kind: 'STATE_INVARIANT', invariantId: LEVERAGE, version: 1, scope, params });
const core = (params: string): StateInvariantInput => ({ kind: 'STATE_INVARIANT', invariantId: 'core.markedExposure', version: 1, scope: [], params });
const definition = (m: ModuleRef = moduleRef(PERP_V1), invariantId = LEVERAGE, version = 1): SemanticInvariantRef =>
  ({ owner: { kind: 'MODULE', module: m }, invariantId, version }) as unknown as SemanticInvariantRef;
const bind = (d: SemanticInvariantRef = definition(), scope: readonly ResourceId[] = []): SemanticTermBinding => ({ definition: d, scope });
const A = bind();
const B = bind(definition(moduleRef(PERP_V1_OTHER_DIGEST)));

/** Byte parameters: lower is narrower, under PERP_V1's leverage only. */
const ordering: InvariantOrdering = {
  noWeaker: (p, c, d) => (d.owner.kind === 'MODULE' && d.owner.module.moduleDigest === moduleRef(PERP_V1).moduleDigest ? (BigInt(c.params) <= BigInt(p.params) ? 'NO_WEAKER' : 'WEAKER') : 'UNPROVABLE'),
};
const RULES: ReducerRules = { invariantOrdering: ordering };

const parent = root({ holder: TRADING, terms: [ALL_MODULES, DELEGATE(2), leverage('0x04')] });
const withPolicy = step(genesis(), [{ kind: 'REGISTER_POLICY', at: T0, policy: policy() }]);
const withParent = step(withPolicy, [{ kind: 'REGISTER_GRANT', at: T0, grant: parent, bindings: [A] }]);

function code(r: LedgerRefusal): string {
  return `${r.code} at ${r.path}`;
}

describe('which terms are bound', () => {
  it('a module-defined term must be bound: a root, a delegation and a policy without its binding are refused', () => {
    assert.equal(code(stepRefused(withPolicy, [{ kind: 'REGISTER_GRANT', at: T0, grant: parent }])), 'SEMANTIC_BINDING_MISSING at events[0].grant.terms.invariant[0]');
    const c = child(parent, { terms: [ALL_MODULES, leverage('0x04')] });
    assert.equal(stepRefused(withParent, [{ kind: 'REGISTER_GRANT', at: T0, grant: c }]).code, 'SEMANTIC_BINDING_MISSING');
    assert.equal(code(stepRefused(genesis(), [{ kind: 'REGISTER_POLICY', at: T0, policy: policy([leverage('0x04')]) }])), 'SEMANTIC_BINDING_MISSING at events[0].policy.terms.invariant[0]');
    // Bound, each commits, and the record keeps the binding.
    assert.deepEqual(withParent.nodes.get(authorityId(parent))?.bindings, [A]);
    const p = step(genesis(), [{ kind: 'REGISTER_POLICY', at: T0, policy: policy([leverage('0x04')]), bindings: [A] }]);
    assert.deepEqual(p.policy?.bindings, [A]);
  });

  it('a Core term is never bound; a binding for a term the registration does not carry is unexpected', () => {
    const coreOnly = root({ holder: TRADING, nonce: 1n, terms: [ALL_MODULES, core('0x10')] });
    step(withPolicy, [{ kind: 'REGISTER_GRANT', at: T0, grant: coreOnly }]);
    const coreBinding = bind(definition(moduleRef(PERP_V1), 'core.markedExposure'));
    assert.equal(stepRefused(withPolicy, [{ kind: 'REGISTER_GRANT', at: T0, grant: coreOnly, bindings: [coreBinding] }]).code, 'SEMANTIC_BINDING_INVALID');
    assert.equal(stepRefused(withPolicy, [{ kind: 'REGISTER_GRANT', at: T0, grant: coreOnly, bindings: [A] }]).code, 'SEMANTIC_BINDING_UNEXPECTED');
    // A binding for another scope binds nothing the grant carries.
    assert.equal(stepRefused(withPolicy, [{ kind: 'REGISTER_GRANT', at: T0, grant: parent, bindings: canonicalBindings([A, bind(definition(), [ACCT])]) }]).code, 'SEMANTIC_BINDING_UNEXPECTED');
  });

  it('refuses a Core owner, an owner that cannot define the invariant, two bindings for one term, and bindings out of order', () => {
    const attempt = (bindings: readonly SemanticTermBinding[]) => stepRefused(withPolicy, [{ kind: 'REGISTER_GRANT', at: T0, grant: parent, bindings }]).code;
    assert.equal(attempt([bind({ owner: { kind: 'CORE' }, invariantId: LEVERAGE, version: 1 } as unknown as SemanticInvariantRef)]), 'SEMANTIC_BINDING_INVALID');
    assert.equal(attempt([bind(definition(moduleRef(SPOT_V1)))]), 'SEMANTIC_BINDING_INVALID');
    assert.equal(attempt([bind(definition(moduleRef(PERP_V2)))]), 'SEMANTIC_BINDING_INVALID');
    const pair = canonicalBindings([A, B]);
    assert.equal(attempt(pair), 'SEMANTIC_BINDING_INVALID');
    assert.equal(attempt([...pair].reverse()), 'SEMANTIC_BINDING_INVALID');
    // The binding set is checked as one rule: this is what the reducer runs.
    assert.ok(checkBindingSet([A], grantInvariants(parent), 'bindings', 'grant.terms').ok);
  });
});

describe('a restated term restates its meaning', () => {
  it('a child restating the parent term must carry the parent\'s binding, whatever its parameters', () => {
    const same = child(parent, { terms: [ALL_MODULES, leverage('0x04')] });
    step(withParent, [{ kind: 'REGISTER_GRANT', at: T0, grant: same, bindings: [A] }]);
    assert.equal(code(stepRefused(withParent, [{ kind: 'REGISTER_GRANT', at: T0, grant: same, bindings: [B] }])), 'SEMANTIC_BINDING_MISMATCH at events[0].grant.terms.invariant[0]');
  });

  it('a proof must name the term\'s own binding: comparator B for a term bound to A is refused before any comparator is asked', () => {
    const asked: string[] = [];
    const rules: ReducerRules = { invariantOrdering: { noWeaker: (p, c, d) => (asked.push(semanticBindingId(bind(d))), ordering.noWeaker(p, c, d)) } };
    const narrow = child(parent, { terms: [ALL_MODULES, leverage('0x03')] });
    const r = applyRefused(withParent, [{ kind: 'REGISTER_GRANT', at: T0, grant: narrow, bindings: [A], proofs: [{ definition: B.definition, scope: [] }] }], rules);
    assert.equal(code(r), 'SEMANTIC_BINDING_MISMATCH at events[0].proofs[0].definition');
    assert.deepEqual(asked, []);
    // Agreeing, it is proven under exactly A.
    assert.ok(applyBatch(withParent, [{ kind: 'REGISTER_GRANT', at: T0, grant: narrow, bindings: [A], proofs: [{ definition: A.definition, scope: [] }] }], rules).ok);
    assert.equal(asked.length, 1);
  });
});

describe('the effective authority carries each term with its committed binding', () => {
  it('lineage and policy invariants reach an evaluator bound; the same name under two definitions is two constraints', () => {
    const narrow = child(parent, { terms: [ALL_MODULES, leverage('0x04')] });
    const s = step(withParent, [{ kind: 'REGISTER_GRANT', at: T0, grant: narrow, bindings: [A] }]);
    const e = must(effectiveAuthority(must(resolveLineage(s, authorityId(narrow))), policy([leverage('0x09')]), 'authority', [B]));
    assert.deepEqual(e.invariants, [{ term: grantInvariants(parent)[0], binding: A }]);
    assert.deepEqual(e.principalInvariants.map((x) => x.binding), [B]);
    // Without the policy's bindings, its module-defined term reaches the evaluator unbound: nothing may interpret it.
    const unbound = must(effectiveAuthority(must(resolveLineage(s, authorityId(narrow))), policy([leverage('0x09')])));
    assert.deepEqual(unbound.principalInvariants.map((x) => x.binding), [null]);
  });
});

describe('policy terms keep their meaning', () => {
  it('before activity a replacement may rebind a term; once anything was reserved, a rebinding is a new constraint and needs a baseline', async () => {
    const p1 = policy([leverage('0x04')]);
    const p2 = policy([leverage('0x04')], 2n);
    const s1 = step(genesis(), [{ kind: 'REGISTER_POLICY', at: T0, policy: p1, bindings: [A] }]);
    const rebound = step(s1, [{ kind: 'REGISTER_POLICY', at: T0, policy: p2, bindings: [B] }]);
    assert.deepEqual(rebound.policy?.bindings, [B]);
    const active = { ...s1, everReserved: true };
    assert.equal(stepRefused(active, [{ kind: 'REGISTER_POLICY', at: T0, policy: p2, bindings: [B] }]).code, 'POLICY_UPDATE_REQUIRES_BASELINE');
    step(active, [{ kind: 'REGISTER_POLICY', at: T0, policy: p2, bindings: [A] }]);
  });
});

describe('the binding-carrying event form', () => {
  const e: LedgerEvent = { kind: 'REGISTER_GRANT', at: T0, grant: parent, bindings: [A] };
  const head = `0x${'11'.repeat(32)}` as never;

  it('round-trips with and without proofs; an event without bindings keeps its earlier code and bytes', () => {
    for (const x of [e, { ...e, proofs: [{ definition: A.definition, scope: [] }] }] as LedgerEvent[]) {
      const bytes = encodeBatch(PRINCIPAL, 1n as never, head, [x]);
      const d = must(decodeBatch(bytes));
      assert.deepEqual(d.events, [x]);
      assert.deepEqual(encodeBatch(PRINCIPAL, 1n as never, head, d.events), bytes);
    }
    const plain = { kind: 'REGISTER_GRANT', at: T0, grant: parent } as const;
    assert.deepEqual(encodeBatch(PRINCIPAL, 1n as never, head, [{ ...plain, bindings: [] }]), encodeBatch(PRINCIPAL, 1n as never, head, [plain]));
    assert.notDeepEqual(encodeBatch(PRINCIPAL, 1n as never, head, [e]), encodeBatch(PRINCIPAL, 1n as never, head, [plain]));
  });

  it('a binding-carrying form never has an empty binding list', () => {
    const bytes = encodeBatch(PRINCIPAL, 1n as never, head, [e]);
    // The form ends `u16(1) ‖ binding ‖ u16(0)`; rewritten to `u16(0) ‖ u16(0)` it is not a valid encoding.
    const cut = bytes.length - encodeWith(writeSemanticTermBinding, A).length - 4;
    assert.ok(!decodeBatch(new Uint8Array([...bytes.slice(0, cut), 0, 0, 0, 0])).ok);
  });

  it('the binding identity changes with every field and is domain-separated from a proof of the same bytes', () => {
    const variants = [B, bind(definition(moduleRef({ ...PERP_V1, domainId: 'perp-b' }))), bind(definition(moduleRef(PERP_V1), 'perp-policy.other')), bind(definition(), [ACCT])];
    assert.equal(new Set([A, ...variants].map(semanticBindingId)).size, variants.length + 1);
    assert.notEqual(semanticBindingId(A), semanticProofId({ definition: A.definition, scope: [] }));
  });
});

describe('history whose semantics were never bound (HISTORICAL_SEMANTICS_UNBOUND)', () => {
  it('a pre-7D.3 registration of a module-defined term without a binding does not replay; nothing is inferred for it', () => {
    const legacy = [[{ kind: 'REGISTER_POLICY', at: T0, policy: policy() }], [{ kind: 'REGISTER_GRANT', at: T0, grant: parent }]] as LedgerEvent[][];
    const r = replay(PRINCIPAL, legacy, RULES);
    assert.ok(!r.ok && r.error.code === 'HISTORICAL_SEMANTICS_UNBOUND');
    // The same history as stored bytes, correctly chained: it fails on its semantics, not its chain.
    let previous = genesis().head;
    const bytes = legacy.map((events, i) => {
      const b = encodeBatch(PRINCIPAL, BigInt(i + 1) as never, previous, events);
      previous = batchHead(b);
      return b;
    });
    const encoded = replayEncoded(PRINCIPAL, bytes, RULES);
    assert.equal(encoded.ok ? 'ok' : code(encoded.error), 'HISTORICAL_SEMANTICS_UNBOUND at batches[1].events[0].grant.terms.invariant[0]');
    // At commit, the same registration is refused as new: it is missing its binding.
    assert.equal(stepRefused(withPolicy, legacy[1] as LedgerEvent[]).code, 'SEMANTIC_BINDING_MISSING');
    // A history whose terms are all Core's is unaffected.
    assert.ok(replay(PRINCIPAL, [[{ kind: 'REGISTER_POLICY', at: T0, policy: policy([core('0x10')]) }]], RULES).ok);
  });
});

describe('the infrastructure registration checks, and the store re-checks', () => {
  it('each binding must name the registry\'s current, active module; a direct store write meets the reducer\'s rules', async () => {
    const store = new InMemoryLedgerStore({}, RULES);
    const ledger = new AuthorityLedger(store, REGISTRY, RULES);
    committed(await ledger.registerPolicy(policy(), T0, ONCE));
    assert.equal(refused(await ledger.registerGrant(parent, T0, ONCE, { bindings: [B] })).code, 'MODULE_DIGEST_MISMATCH');
    assert.equal(refused(await ledger.registerGrant(parent, T0, ONCE, { bindings: [bind(definition(moduleRef(UNREGISTERED), 'unknown-policy.rule'))] })).code, 'MODULE_UNREGISTERED');
    const retiring = root({ holder: TRADING, nonce: 3n, terms: [ALL_MODULES, { ...leverage('0x04'), version: 0 }] });
    assert.equal(refused(await ledger.registerGrant(retiring, T0, ONCE, { bindings: [bind(definition(moduleRef(RETIRED_V0), LEVERAGE, 0))] })).code, 'MODULE_RETIRING');
    assert.equal(refused(await ledger.registerGrant(parent, T0, ONCE)).code, 'SEMANTIC_BINDING_MISSING');
    committed(await ledger.registerGrant(parent, T0, ONCE, { bindings: [A] }));
    // History replays byte-identically, bindings included.
    const history = await store.history(PRINCIPAL);
    const replayed = must(replayEncoded(PRINCIPAL, history.map((b) => b.encoded), RULES));
    assert.deepEqual(encodeLedgerState(replayed), encodeLedgerState((await store.read(PRINCIPAL)).state));
  });
});

function applyRefused(s: LedgerState, events: readonly LedgerEvent[], rules: ReducerRules): LedgerRefusal {
  const r = applyBatch(s, events, rules);
  if (r.ok) assert.fail('expected a refusal');
  return r.error;
}
