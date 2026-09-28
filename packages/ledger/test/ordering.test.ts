/**
 * The 7D extension point: a configured `InvariantOrdering` lets the reducer
 * accept a restated invariant whose parameters its definition proves no
 * weaker (authority-model.md §4, "parameters no weaker").
 *
 * What must hold: without an ordering nothing changes from 7C; with one, the
 * reducer — at commit and at replay — asks it and never an input; a failing
 * or dishonest comparator can only refuse; and a history that relied on a
 * proof does not replay without it.
 *
 * Since 7D.2 the registration commits *whose* definition decided each
 * narrowing (a `SemanticProofRef` naming the exact `ModuleRef`), the reducer
 * asks the ordering under exactly that definition, and a proof set that is
 * missing, spurious, duplicated or structurally inconsistent is refused.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWith, type ModuleRef, type StateInvariantInput, type StateInvariantTerm } from '@mandate/core';
import {
  AuthorityLedger,
  CORE_RULES,
  InMemoryLedgerStore,
  canonicalProofs,
  checkDelegationSubset,
  committedProver,
  decodeBatch,
  encodeBatch,
  replay,
  replayEncoded,
  semanticInvariantId,
  semanticProofId,
  writeSemanticProofRef,
  type InvariantNarrowing,
  type InvariantOrdering,
  type LedgerRefusal,
  type ReducerRules,
  type SemanticInvariantRef,
  type SemanticProofRef,
  type SemanticTermBinding,
} from '../src/index.ts';
import { ALL_MODULES, DELEGATE, ONCE, PERP_V1, PERP_V1_OTHER_DIGEST, PERP_V2, PRINCIPAL, REGISTRY, RETIRED_V0, SPOT_V1, T0, TRADING, child, committed, moduleRef, policy, refused, root } from './support/fixtures.ts';

const LEVERAGE = 'perp-policy.accountLeverage';
const leverage = (params: string): StateInvariantInput => ({ kind: 'STATE_INVARIANT', invariantId: LEVERAGE, version: 1, scope: [], params });
const definition = (m: ModuleRef = moduleRef(PERP_V1), invariantId = LEVERAGE, version = 1): SemanticInvariantRef =>
  ({ owner: { kind: 'MODULE', module: m }, invariantId, version }) as SemanticInvariantRef;
const proof = (d: SemanticInvariantRef = definition()): SemanticProofRef => ({ definition: d, scope: [] });
const PROOF = proof();
/** Every grant here carries the one leverage term, bound to PERP_V1 (7D.3). */
const BINDING: SemanticTermBinding = { definition: definition(), scope: [] };
const BOUND = { bindings: [BINDING] };
const PROVEN = { bindings: [BINDING], proofs: [PROOF] };

/**
 * A test ordering over one-byte parameters: a lower byte is narrower. It
 * knows exactly one definition — PERP_V1's leverage, by exact digest — and
 * records every question it is asked.
 */
function byteOrdering(asked: [string, string, string][] = []): InvariantOrdering {
  const known = semanticInvariantId(definition());
  return {
    noWeaker(parent: StateInvariantTerm, c: StateInvariantTerm, d: SemanticInvariantRef): InvariantNarrowing {
      asked.push([parent.params, c.params, semanticInvariantId(d)]);
      if (semanticInvariantId(d) !== known) return 'UNPROVABLE';
      return BigInt(c.params) <= BigInt(parent.params) ? 'NO_WEAKER' : 'WEAKER';
    },
  };
}

function rulesWith(ordering: InvariantOrdering): ReducerRules {
  return { invariantOrdering: ordering };
}

function violations(r: LedgerRefusal): string[] {
  assert.equal(r.code, 'DELEGATION_REFUSED');
  return r.code === 'DELEGATION_REFUSED' ? r.violations.map((v) => v.code) : [];
}

function ledgerWith(rules: ReducerRules): { store: InMemoryLedgerStore; ledger: AuthorityLedger } {
  const store = new InMemoryLedgerStore({}, rules);
  return { store, ledger: new AuthorityLedger(store, REGISTRY, rules) };
}

const parentGrant = root({ holder: TRADING, terms: [ALL_MODULES, DELEGATE(2), leverage('0x04')] });

describe('invariant ordering (7D extension point)', () => {
  it('without an ordering, 7C behaviour is unchanged: different parameters are unproven', () => {
    const c = child(parentGrant, { terms: [ALL_MODULES, leverage('0x03')] });
    assert.deepEqual(checkDelegationSubset(parentGrant, c, 2).map((v) => v.code), ['DELEGATION_NARROWING_UNPROVEN']);
    assert.deepEqual(checkDelegationSubset(parentGrant, c, 2, committedProver(null, [PROOF])).map((v) => v.code), ['DELEGATION_NARROWING_UNPROVEN']);
    assert.equal(CORE_RULES.invariantOrdering, null);
    assert.ok(Object.isFrozen(CORE_RULES));
  });

  it('a proven narrowing is accepted, a proven widening is DELEGATION_WEAKENS_INVARIANT', () => {
    const p = committedProver(byteOrdering(), [PROOF]);
    assert.deepEqual(checkDelegationSubset(parentGrant, child(parentGrant, { terms: [ALL_MODULES, leverage('0x03')] }), 2, p), []);
    assert.deepEqual(
      checkDelegationSubset(parentGrant, child(parentGrant, { terms: [ALL_MODULES, leverage('0x05')] }), 2, p).map((v) => v.code),
      ['DELEGATION_WEAKENS_INVARIANT'],
    );
  });

  it('is asked only for a restated invariant whose parameters differ, and only under the committed definition', () => {
    const asked: [string, string, string][] = [];
    const p = committedProver(byteOrdering(asked), [PROOF]);
    checkDelegationSubset(parentGrant, child(parentGrant, { terms: [ALL_MODULES, leverage('0x04')] }), 2, p);
    assert.deepEqual(asked, []);
    checkDelegationSubset(parentGrant, child(parentGrant, { terms: [ALL_MODULES, leverage('0x02')] }), 2, p);
    assert.deepEqual(asked, [['0x04', '0x02', semanticInvariantId(definition())]]);
    // No committed proof: the ordering is not even asked.
    checkDelegationSubset(parentGrant, child(parentGrant, { terms: [ALL_MODULES, leverage('0x01')] }), 2, committedProver(byteOrdering(asked), []));
    assert.equal(asked.length, 1);
  });

  it('a comparator that throws or answers outside the vocabulary can only refuse', () => {
    const thrower: InvariantOrdering = {
      noWeaker() {
        throw new Error('comparator fault');
      },
    };
    const junk = { noWeaker: () => 'YES' } as unknown as InvariantOrdering;
    const c = child(parentGrant, { terms: [ALL_MODULES, leverage('0x03')] });
    for (const o of [thrower, junk]) assert.deepEqual(checkDelegationSubset(parentGrant, c, 2, committedProver(o, [PROOF])).map((v) => v.code), ['DELEGATION_NARROWING_UNPROVEN']);
  });

  it('dropping the invariant is still refused whatever the ordering says', () => {
    const always: InvariantOrdering = { noWeaker: () => 'NO_WEAKER' };
    const c = child(parentGrant, { terms: [ALL_MODULES] });
    assert.deepEqual(checkDelegationSubset(parentGrant, c, 2, committedProver(always, [PROOF])).map((v) => v.code), ['DELEGATION_DROPS_INVARIANT']);
  });

  it('the store applies its configured ordering at commit; the engine refuses the same way before writing', async () => {
    const narrow = child(parentGrant, { terms: [ALL_MODULES, leverage('0x03')] });
    const wide = child(parentGrant, { terms: [ALL_MODULES, leverage('0x05')], nonce: 1n });

    const plain = ledgerWith(CORE_RULES);
    committed(await plain.ledger.registerPolicy(policy(), T0, ONCE));
    committed(await plain.ledger.registerGrant(parentGrant, T0, ONCE, BOUND));
    assert.deepEqual(violations(refused(await plain.ledger.registerGrant(narrow, T0, ONCE, PROVEN))), ['DELEGATION_NARROWING_UNPROVEN']);

    const ordered = ledgerWith(rulesWith(byteOrdering()));
    committed(await ordered.ledger.registerPolicy(policy(), T0, ONCE));
    committed(await ordered.ledger.registerGrant(parentGrant, T0, ONCE, BOUND));
    // No committed proof: unproven, whatever the ordering could say.
    assert.deepEqual(violations(refused(await ordered.ledger.registerGrant(narrow, T0, ONCE, BOUND))), ['DELEGATION_NARROWING_UNPROVEN']);
    committed(await ordered.ledger.registerGrant(narrow, T0, ONCE, PROVEN));
    assert.deepEqual(violations(refused(await ordered.ledger.registerGrant(wide, T0, ONCE, PROVEN))), ['DELEGATION_WEAKENS_INVARIANT']);

    // A writer bypassing the engine meets the same rule inside the store's critical section.
    const s = await ordered.store.read(PRINCIPAL);
    const direct = await ordered.store.compareAndAppend(PRINCIPAL, s.version, s.head, [{ kind: 'REGISTER_GRANT', at: T0, grant: wide, ...PROVEN }]);
    assert.equal(direct.status, 'REFUSED');
  });

  it('a history that relied on a proof replays under the ordering and refuses without it', async () => {
    const rules = rulesWith(byteOrdering());
    const { store, ledger } = ledgerWith(rules);
    committed(await ledger.registerPolicy(policy(), T0, ONCE));
    committed(await ledger.registerGrant(parentGrant, T0, ONCE, BOUND));
    committed(await ledger.registerGrant(child(parentGrant, { terms: [ALL_MODULES, leverage('0x03')] }), T0, ONCE, PROVEN));
    const history = await store.history(PRINCIPAL);
    const events = history.map((b) => b.events);
    const bytes = history.map((b) => b.encoded);

    const withOrdering = replay(PRINCIPAL, events, rules);
    assert.ok(withOrdering.ok);
    assert.ok(replayEncoded(PRINCIPAL, bytes, rules).ok);
    for (const r of [replay(PRINCIPAL, events), replayEncoded(PRINCIPAL, bytes)]) {
      assert.ok(!r.ok);
      if (!r.ok) assert.deepEqual(violations(r.error), ['DELEGATION_NARROWING_UNPROVEN']);
    }
  });

  it('no event carries a verdict: the registration carries the grant and whose definition decides, and nothing else', async () => {
    const narrow = child(parentGrant, { terms: [ALL_MODULES, leverage('0x03')] });
    const event = { kind: 'REGISTER_GRANT', at: T0, grant: narrow, bindings: [BINDING], proofs: [PROOF] } as const;
    assert.deepEqual(Object.keys(event).sort(), ['at', 'bindings', 'grant', 'kind', 'proofs']);
    assert.deepEqual(Object.keys(BINDING).sort(), ['definition', 'scope']);
    assert.deepEqual(Object.keys(PROOF).sort(), ['definition', 'scope']);
    const { store, ledger } = ledgerWith(rulesWith(byteOrdering()));
    committed(await ledger.registerPolicy(policy(), T0, ONCE));
    committed(await ledger.registerGrant(parentGrant, T0, ONCE, BOUND));
    const before = await store.read(PRINCIPAL);
    committed(await ledger.registerGrant(narrow, T0, ONCE, PROVEN));
    const stored = (await store.history(PRINCIPAL)).at(-1);
    assert.ok(stored !== undefined);
    assert.deepEqual(stored.encoded, encodeBatch(PRINCIPAL, stored.version, before.head, [event]));
  });
});

describe('semantic provenance of a narrowing (7D.2)', () => {
  it('the committed proof names the exact ModuleRef, and decodes back to it', async () => {
    const { store, ledger } = ledgerWith(rulesWith(byteOrdering()));
    committed(await ledger.registerPolicy(policy(), T0, ONCE));
    committed(await ledger.registerGrant(parentGrant, T0, ONCE, BOUND));
    committed(await ledger.registerGrant(child(parentGrant, { terms: [ALL_MODULES, leverage('0x03')] }), T0, ONCE, PROVEN));
    const last = (await store.history(PRINCIPAL)).at(-1);
    assert.ok(last !== undefined);
    const decoded = decodeBatch(last.encoded);
    assert.ok(decoded.ok);
    if (decoded.ok) {
      const e = decoded.value.events[0];
      assert.ok(e?.kind === 'REGISTER_GRANT');
      if (e?.kind === 'REGISTER_GRANT') assert.deepEqual(e.proofs, [PROOF]);
    }
  });

  it('an event without proofs keeps its 7C code and bytes; a proof-carrying form never has an empty list', () => {
    const e = { kind: 'REGISTER_GRANT', at: T0, grant: parentGrant } as const;
    const head = digestHead();
    const a = encodeBatch(PRINCIPAL, 1n as never, head, [e]);
    assert.deepEqual(encodeBatch(PRINCIPAL, 1n as never, head, [{ ...e, proofs: [] }]), a);
    const proven = encodeBatch(PRINCIPAL, 1n as never, head, [{ ...e, proofs: [PROOF] }]);
    assert.notDeepEqual(proven, a);
    assert.ok(decodeBatch(proven).ok);
    // The proven form ends `u16(1) ‖ proof`; rewritten to `u16(0)` it is not a valid encoding.
    const cut = proven.length - encodeWith(writeSemanticProofRef, PROOF).length - 2;
    const tampered = new Uint8Array([...proven.slice(0, cut), 0, 0]);
    assert.ok(!decodeBatch(tampered).ok);
  });

  it('a proof under another digest of the same name is refused for new use, and cannot be proved at commit or replay', async () => {
    const other = proof(definition(moduleRef(PERP_V1_OTHER_DIGEST)));
    const { store, ledger } = ledgerWith(rulesWith(byteOrdering()));
    committed(await ledger.registerPolicy(policy(), T0, ONCE));
    committed(await ledger.registerGrant(parentGrant, T0, ONCE, BOUND));
    const narrow = child(parentGrant, { terms: [ALL_MODULES, leverage('0x03')] });
    assert.equal(refused(await ledger.registerGrant(narrow, T0, ONCE, { bindings: [BINDING], proofs: [other] })).code, 'MODULE_DIGEST_MISMATCH');
    // Straight into the store: a proof under another digest than the term's binding is refused outright (7D.3)…
    const s = await store.read(PRINCIPAL);
    const direct = await store.compareAndAppend(PRINCIPAL, s.version, s.head, [{ kind: 'REGISTER_GRANT', at: T0, grant: narrow, bindings: [BINDING], proofs: [other] }]);
    assert.equal(direct.status === 'REFUSED' ? direct.refusal.code : direct.status, 'SEMANTIC_BINDING_MISMATCH');
    // …and rebinding the child's term to that digest too departs from the parent's meaning.
    const rebound = await store.compareAndAppend(PRINCIPAL, s.version, s.head, [{ kind: 'REGISTER_GRANT', at: T0, grant: narrow, bindings: [{ ...BINDING, definition: other.definition }], proofs: [other] }]);
    assert.equal(rebound.status === 'REFUSED' ? rebound.refusal.code : rebound.status, 'SEMANTIC_BINDING_MISMATCH');
    // A retiring module cannot prove a new narrowing either.
    const retired = proof(definition(moduleRef(RETIRED_V0), LEVERAGE, 0));
    assert.equal(refused(await ledger.registerGrant(narrow, T0, ONCE, { bindings: [BINDING], proofs: [retired] })).code, 'MODULE_RETIRING');
  });

  it('refuses a proof for a term that needs none, a duplicate, a proof out of order, and an owner that cannot define the invariant', async () => {
    const { store, ledger } = ledgerWith(rulesWith(byteOrdering()));
    committed(await ledger.registerPolicy(policy(), T0, ONCE));
    committed(await ledger.registerGrant(parentGrant, T0, ONCE, BOUND));
    const s = await store.read(PRINCIPAL);
    const attempt = async (grant: typeof parentGrant, proofs: readonly SemanticProofRef[]) => {
      const r = await store.compareAndAppend(PRINCIPAL, s.version, s.head, [{ kind: 'REGISTER_GRANT', at: T0, grant, bindings: [BINDING], proofs }]);
      return r.status === 'REFUSED' ? r.refusal.code : r.status;
    };
    const narrow = child(parentGrant, { terms: [ALL_MODULES, leverage('0x03')] });
    // An exact restatement, and a root, need no proof.
    assert.equal(await attempt(child(parentGrant, { terms: [ALL_MODULES, leverage('0x04')] }), [PROOF]), 'SEMANTIC_PROOF_UNEXPECTED');
    assert.equal(await attempt(root({ holder: TRADING, nonce: 5n, terms: [ALL_MODULES, leverage('0x04')] }), [PROOF]), 'SEMANTIC_PROOF_UNEXPECTED');
    // Two proofs for one term (two digests of the same name), in canonical order and reversed.
    const pair = canonicalProofs([PROOF, proof(definition(moduleRef(PERP_V1_OTHER_DIGEST)))]);
    assert.equal(await attempt(narrow, pair), 'SEMANTIC_PROOF_INVALID');
    assert.equal(await attempt(narrow, [...pair].reverse()), 'SEMANTIC_PROOF_INVALID');
    const v2 = proof(definition(moduleRef(PERP_V2), LEVERAGE, 1));
    // Another module name, or another version of the same module, claiming perp-policy's v1 invariant.
    assert.equal(await attempt(narrow, [proof(definition(moduleRef(SPOT_V1)))]), 'SEMANTIC_PROOF_INVALID');
    assert.equal(await attempt(narrow, [v2]), 'SEMANTIC_PROOF_INVALID');
    // Core cannot own a module's invariant.
    assert.equal(await attempt(narrow, [{ definition: { owner: { kind: 'CORE' }, invariantId: LEVERAGE, version: 1 } as SemanticInvariantRef, scope: [] }]), 'SEMANTIC_PROOF_INVALID');
    assert.equal(await attempt(narrow, [PROOF]), 'COMMITTED');
  });

  it('the semantic identity changes with every field of the ModuleRef and of the definition', () => {
    const base = moduleRef(PERP_V1);
    const variants: SemanticInvariantRef[] = [
      definition(moduleRef({ ...PERP_V1, moduleDigest: PERP_V1_OTHER_DIGEST.moduleDigest })),
      definition(moduleRef({ ...PERP_V1, moduleVersion: 2 })),
      definition(moduleRef({ ...PERP_V1, moduleId: 'perp-policy-b' })),
      definition(moduleRef({ ...PERP_V1, domainId: 'perp-b' })),
      definition(base, 'perp-policy.otherRule'),
      definition(base, LEVERAGE, 2),
      { owner: { kind: 'CORE' }, invariantId: LEVERAGE, version: 1 } as SemanticInvariantRef,
    ];
    const ids = new Set([semanticInvariantId(definition(base)), ...variants.map(semanticInvariantId)]);
    assert.equal(ids.size, variants.length + 1);
    const proofs = new Set([semanticProofId(PROOF), ...variants.map((d) => semanticProofId(proof(d)))]);
    assert.equal(proofs.size, variants.length + 1);
    // Same name, another digest: never the same semantic identity.
    assert.notEqual(semanticInvariantId(definition(moduleRef(PERP_V1_OTHER_DIGEST))), semanticInvariantId(definition(base)));
    // And deterministic.
    assert.equal(semanticProofId(proof(definition(moduleRef(PERP_V1)))), semanticProofId(PROOF));
  });
});

/** Any head: the batch encoding is what is compared. */
function digestHead(): never {
  return `0x${'11'.repeat(32)}` as never;
}
