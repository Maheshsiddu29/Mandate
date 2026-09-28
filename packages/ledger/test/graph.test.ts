/**
 * The authority graph: registration, lineage validity and revocation
 * (authority-model.md §5–§9). Every refusal the graph can produce is produced
 * here, including those that honest registration makes unreachable, by
 * handing the rules a state no honest history could create.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LINEAGE_LENGTH,
  authorityId,
  validateAuthorityGrant,
  type AuthorityGrant,
  type AuthorityId,
  type LedgerVersion,
  type PartyIdInput,
} from '@mandate/core';
import {
  checkLineageValid,
  effectiveAuthority,
  resolveLineage,
  type LedgerRefusal,
  type LedgerState,
  type NodeRecord,
} from '../src/index.ts';
import {
  AGENT_A,
  AGENT_B,
  ALL_MODULES,
  DELEGATE,
  ONCE,
  OUTSIDER,
  P,
  P2,
  PERP_AGENT,
  PERP_V1,
  PERP_V1_OTHER_DIGEST,
  PERP_V2,
  PRINCIPAL,
  PRINCIPAL_2,
  SPOT_V1,
  T0,
  T_END,
  TRADING,
  address,
  child,
  committed,
  contribution,
  capital,
  digestOf,
  dim,
  modules,
  must,
  newLedger,
  plan,
  policy,
  prng,
  refused,
  revocation,
  root,
  semanticsOf,
  setup,
  units,
} from './support/fixtures.ts';
import { grantOf, narrow, randomSpec, widen } from './support/specs.ts';

function violations(r: LedgerRefusal): string[] {
  assert.equal(r.code, 'DELEGATION_REFUSED', `expected DELEGATION_REFUSED, got ${r.code}`);
  return r.code === 'DELEGATION_REFUSED' ? r.violations.map((v) => v.code) : [];
}

function nodeOf(r: LedgerRefusal): AuthorityId | null {
  return 'node' in r ? r.node : null;
}

describe('principal policy precedes every root', () => {
  it('refuses a root before any policy, and accepts one after an explicitly empty policy', async () => {
    const { ledger } = newLedger();
    const r = root();
    assert.equal(refused(await ledger.registerGrant(r, T0, ONCE)).code, 'PRINCIPAL_POLICY_MISSING');
    committed(await ledger.registerPolicy(policy([]), T0, ONCE));
    const s = committed(await ledger.registerGrant(r, T0, ONCE));
    assert.equal(s.version, 2n);
    assert.ok(s.state.nodes.has(authorityId(r)));
  });

  it('the policy grants nothing: it is not a node, and nothing can be reserved "under" it', async () => {
    const { ledger } = newLedger();
    const p = policy([dim('global-capital', units(10_000))]);
    committed(await ledger.registerPolicy(p, T0, ONCE));
    const s = await ledger.read(PRINCIPAL);
    assert.equal(s.state.nodes.size, 0);
    // A plan naming the policy's own digest as its authority names no node.
    const r = root();
    const bogus = { ...plan({ authority: r }), authority: s.state.policy?.id as unknown as AuthorityId };
    const out = refused(await ledger.reserve(bogus, T0, ONCE));
    assert.equal(out.code, 'AUTHORITY_UNKNOWN');
  });
});

describe('registration refusals', () => {
  it('missing parent', async () => {
    const { ledger } = newLedger();
    const r = root();
    committed(await ledger.registerPolicy(policy(), T0, ONCE));
    const c = child(r, { holder: AGENT_A });
    const out = refused(await ledger.registerGrant(c, T0, ONCE));
    assert.equal(out.code, 'AUTHORITY_UNKNOWN');
    assert.equal(nodeOf(out), authorityId(r));
  });

  it('a grant for another principal cannot enter this principal\'s ledger', async () => {
    const { store } = newLedger();
    const s = await store.read(PRINCIPAL);
    const ok = await store.compareAndAppend(PRINCIPAL, s.version, s.head, [{ kind: 'REGISTER_POLICY', at: T0, policy: policy() }]);
    assert.equal(ok.status, 'COMMITTED');
    const foreign = root({ principal: P2 });
    const s1 = await store.read(PRINCIPAL);
    const out = await store.compareAndAppend(PRINCIPAL, s1.version, s1.head, [{ kind: 'REGISTER_GRANT', at: T0, grant: foreign }]);
    assert.ok(out.status === 'REFUSED' && out.refusal.code === 'PRINCIPAL_MISMATCH');
    // Nor may a policy for another principal.
    const out2 = await store.compareAndAppend(PRINCIPAL, s1.version, s1.head, [{ kind: 'REGISTER_POLICY', at: T0, policy: policy([], 2n, P2) }]);
    assert.ok(out2.status === 'REFUSED' && out2.refusal.code === 'PRINCIPAL_MISMATCH');
  });

  it('a delegation claiming another principal is refused against the parent\'s principal', async () => {
    const { store } = newLedger();
    const r = root();
    const s0 = await store.read(PRINCIPAL);
    assert.equal((await store.compareAndAppend(PRINCIPAL, s0.version, s0.head, [{ kind: 'REGISTER_POLICY', at: T0, policy: policy() }, { kind: 'REGISTER_GRANT', at: T0, grant: r }])).status, 'COMMITTED');
    const s1 = await store.read(PRINCIPAL);
    const c = child(r, { principal: P2 });
    const out = await store.compareAndAppend(PRINCIPAL, s1.version, s1.head, [{ kind: 'REGISTER_GRANT', at: T0, grant: c }]);
    assert.ok(out.status === 'REFUSED' && out.refusal.code === 'PRINCIPAL_MISMATCH');
  });

  it('issuer must be the parent\'s holder', async () => {
    const { ledger } = newLedger();
    const r = root({ holder: TRADING });
    await setup(ledger, policy(), [r]);
    const out = refused(await ledger.registerGrant(child(r, { issuer: OUTSIDER }), T0, ONCE));
    assert.equal(out.code, 'AUTHORITY_ISSUER_MISMATCH');
  });

  it('duplicate registration is refused deterministically and changes nothing', async () => {
    const { ledger } = newLedger();
    const r = root();
    const s = await setup(ledger, policy(), [r]);
    const a = refused(await ledger.registerGrant(r, T0, ONCE));
    const b = refused(await ledger.registerGrant(r, T0, ONCE));
    assert.deepEqual(a, b);
    assert.equal(a.code, 'AUTHORITY_ALREADY_REGISTERED');
    assert.equal((await ledger.read(PRINCIPAL)).version, s.version);
  });

  it('a grant that has already expired is not registered', async () => {
    const { ledger } = newLedger();
    committed(await ledger.registerPolicy(policy(), T0, ONCE));
    const out = refused(await ledger.registerGrant(root({ expiresAt: T0 + 10n }), T0 + 10n, ONCE));
    assert.equal(out.code, 'AUTHORITY_EXPIRED');
  });

  it('child after a revoked parent', async () => {
    const { ledger } = newLedger();
    const r = root({ holder: TRADING });
    await setup(ledger, policy(), [r]);
    committed(await ledger.revoke(PRINCIPAL, revocation(r), T0, ONCE));
    const out = refused(await ledger.registerGrant(child(r), T0, ONCE));
    assert.equal(out.code, 'AUTHORITY_REVOKED');
    assert.equal(nodeOf(out), authorityId(r));
  });

  it('child after an expired parent, and before a parent is valid', async () => {
    const { ledger } = newLedger();
    const r = root({ holder: TRADING, expiresAt: T0 + 100n });
    const later = root({ holder: TRADING, notBefore: T0 + 50n, nonce: 1n });
    await setup(ledger, policy(), [r, later]);
    const early = refused(await ledger.registerGrant(child(later, { notBefore: T0 + 50n }), T0 + 10n, ONCE));
    assert.equal(early.code, 'AUTHORITY_NOT_YET_VALID');
    const expired = refused(await ledger.registerGrant(child(r, { expiresAt: T0 + 200n }), T0 + 100n, ONCE));
    assert.equal(expired.code, 'AUTHORITY_EXPIRED');
    assert.equal(nodeOf(expired), authorityId(r));
  });

  it('a parent without DELEGATE cannot delegate, and a child may delegate one level less at most', async () => {
    const { ledger } = newLedger();
    const leafOnly = root({ holder: TRADING, terms: [ALL_MODULES] });
    const deep = root({ holder: TRADING, terms: [ALL_MODULES, DELEGATE(1)], nonce: 1n });
    await setup(ledger, policy(), [leafOnly, deep]);
    assert.deepEqual(violations(refused(await ledger.registerGrant(child(leafOnly), T0, ONCE))), ['DELEGATION_DEPTH_EXCEEDED']);
    assert.deepEqual(violations(refused(await ledger.registerGrant(child(deep, { terms: [ALL_MODULES, DELEGATE(1)] }), T0, ONCE))), ['DELEGATION_DEPTH_EXCEEDED']);
    committed(await ledger.registerGrant(child(deep, { terms: [ALL_MODULES] }), T0, ONCE));
  });

  it('the lineage is bounded: a root of depth 7 admits eight nodes and no ninth', async () => {
    const { ledger } = newLedger();
    const holders = ['40', '41', '42', '43', '44', '45', '46', '47', '48'].map((b) => address(b));
    const h = (i: number) => holders[i] as PartyIdInput;
    let parent = root({ holder: h(0), terms: [ALL_MODULES, DELEGATE(7)] });
    await setup(ledger, policy(), [parent]);
    for (let depth = 6; depth >= 0; depth -= 1) {
      const terms = depth > 0 ? [ALL_MODULES, DELEGATE(depth)] : [ALL_MODULES];
      const c = child(parent, { holder: h(7 - depth), terms });
      committed(await ledger.registerGrant(c, T0, ONCE));
      parent = c;
    }
    const s = await ledger.read(PRINCIPAL);
    assert.equal(must(resolveLineage(s.state, authorityId(parent))).length, MAX_LINEAGE_LENGTH);
    const ninth = refused(await ledger.registerGrant(child(parent, { holder: h(8) }), T0, ONCE));
    assert.equal(ninth.code, 'DELEGATION_REFUSED');
  });

  it('refuses every widening at once, naming each (examples §D, D2 bad)', async () => {
    const { ledger } = newLedger();
    const inv = { kind: 'STATE_INVARIANT', invariantId: 'perp-policy.accountLeverage', version: 1, scope: [], params: '0x04' } as const;
    const exposure = { kind: 'STATE_INVARIANT', invariantId: 'core.markedExposure', version: 1, scope: [], params: '0x2000' } as const;
    const bound = (x: bigint) => ({ kind: 'BOUND', boundId: 'perp.orderLeverage', polarity: 'MAX', value: { type: 'RATIO', ratio: { numerator: x, scale: 0 } } }) as const;
    const markPolicy = {
      kind: 'STATE_POLICY',
      domain: 'perp',
      stateKind: 'perp.markPrice',
      admittedSources: ['venue-l.ws'],
      requirement: { freshness: { kind: 'AGE', maxAgeSeconds: 10n }, minTrust: 'VERIFIED', minFinality: { ladder: 'venue-l.market-data', level: 'PUBLISHED' }, atIssue: 'RECHECK', atExecution: { kind: 'NOT_REQUIRED' } },
    } as const;
    const markets = (...ids: string[]) => ({ kind: 'SET', vocabulary: 'MARKETS', members: ids.map((localId) => ({ domain: 'perp', kind: 'MARKET' as const, localId })) }) as const;
    const t = root({
      holder: TRADING,
      expiresAt: T_END - 1_000n,
      terms: [modules(PERP_V1), markets('venue-l:BTC-PERP', 'venue-l:ETH-PERP'), { kind: 'RIGHT', right: 'OPEN_RISK' }, DELEGATE(1), bound(5n), inv, exposure, markPolicy, dim('capital', units(6_000))],
    });
    await setup(ledger, policy(), [t]);
    const bad = child(t, {
      holder: PERP_AGENT,
      expiresAt: T_END,
      terms: [
        modules(PERP_V1, PERP_V2),
        markets('venue-l:BTC-PERP', 'venue-l:SOL-PERP'),
        { kind: 'RIGHT', right: 'OPEN_RISK' },
        { kind: 'RIGHT', right: 'TRANSFER_OUT' },
        DELEGATE(1),
        bound(10n),
        { ...inv, params: '0x06' },
        markPolicy,
        dim('capital', units(8_000)),
      ],
    });
    const codes = violations(refused(await ledger.registerGrant(bad, T0, ONCE, semanticsOf(bad))));
    assert.deepEqual(
      [...codes].sort(),
      [
        'DELEGATION_DEPTH_EXCEEDED',
        'DELEGATION_DROPS_INVARIANT', // markedExposure omitted
        'DELEGATION_NARROWING_UNPROVEN', // accountLeverage restated with different opaque parameters
        'DELEGATION_WIDENS_BOUND',
        'DELEGATION_WIDENS_LIMIT',
        'DELEGATION_WIDENS_RIGHT',
        'DELEGATION_WIDENS_SET', // markets
        'DELEGATION_WIDENS_SET', // modules
        'DELEGATION_WIDENS_WINDOW',
      ].sort(),
    );
  });

  it('module widening: a different version, or the same version with another digest, is not the parent\'s module', async () => {
    const { ledger } = newLedger();
    const t = root({ holder: TRADING, terms: [modules(PERP_V1), DELEGATE(1)] });
    await setup(ledger, policy(), [t]);
    for (const m of [PERP_V2, PERP_V1_OTHER_DIGEST, SPOT_V1]) {
      assert.deepEqual(violations(refused(await ledger.registerGrant(child(t, { terms: [modules(m)] }), T0, ONCE))), ['DELEGATION_WIDENS_SET']);
    }
    committed(await ledger.registerGrant(child(t, { terms: [modules(PERP_V1)] }), T0, ONCE));
  });
});

describe('cycles and hostile graph state', () => {
  it('registration order is topological: a child can only name an already-registered parent', () => {
    // A grant's AuthorityId commits to its parent's AuthorityId, so a cycle would need a fixed point of keccak-256.
    const a = root();
    const b = child(a);
    assert.notEqual(authorityId(a), authorityId(b));
    assert.equal(b.lineage.kind === 'DELEGATION' && b.lineage.parent, authorityId(a));
  });

  it('a cyclic state that no history could produce is still bounded and refused', async () => {
    const { ledger } = newLedger();
    const s = committed(await ledger.registerPolicy(policy(), T0, ONCE)).state;
    const x = digestOf('x') as AuthorityId;
    const y = digestOf('y') as AuthorityId;
    const mk = (parent: AuthorityId): AuthorityGrant =>
      must(validateAuthorityGrant({ lineage: { kind: 'DELEGATION', parent, issuer: AGENT_A }, principal: P, holder: AGENT_A, notBefore: T0, expiresAt: T_END, terms: [], nonce: 0n }));
    const node = (id: AuthorityId, grant: AuthorityGrant): NodeRecord => ({ id, grant, depth: 1, bindings: [], registeredAt: 1n as LedgerVersion, revokedAt: null, revocation: null });
    const cyclic: LedgerState = { ...s, nodes: s.nodes.set(x, node(x, mk(y))).set(y, node(y, mk(x))) };
    const r = resolveLineage(cyclic, x);
    assert.ok(!r.ok && r.error.code === 'AUTHORITY_DEPTH_EXCEEDED');
  });

  it('lineage validity re-checks principal, issuer and depth even for nodes registration would have refused', async () => {
    const { ledger } = newLedger();
    const r = root({ holder: TRADING, terms: [ALL_MODULES] }); // no DELEGATE
    const s = (await setup(ledger, policy(), [r])).state;
    const forged = child(r, { holder: AGENT_A });
    const inject = (g: AuthorityGrant, over: Partial<NodeRecord> = {}): LedgerState => ({
      ...s,
      nodes: s.nodes.set(authorityId(g), { id: authorityId(g), grant: g, depth: 1, bindings: [], registeredAt: 9n as LedgerVersion, revokedAt: null, revocation: null, ...over }),
    });
    const depth = checkLineageValid(inject(forged), must(resolveLineage(inject(forged), authorityId(forged))), T0);
    assert.ok(!depth.ok && depth.error.code === 'AUTHORITY_DEPTH_EXCEEDED');

    const wrongIssuer = child(r, { issuer: OUTSIDER });
    const issuer = checkLineageValid(inject(wrongIssuer), must(resolveLineage(inject(wrongIssuer), authorityId(wrongIssuer))), T0);
    assert.ok(!issuer.ok && issuer.error.code === 'AUTHORITY_ISSUER_MISMATCH');

    const foreignRoot = root({ principal: P2 });
    const st = inject(foreignRoot);
    const principal = checkLineageValid(st, must(resolveLineage(st, authorityId(foreignRoot))), T0);
    assert.ok(!principal.ok && principal.error.code === 'AUTHORITY_PRINCIPAL_MISMATCH');
  });

  it('requires a registered policy for lineage validity', async () => {
    const { ledger } = newLedger();
    const r = root();
    const s = (await setup(ledger, policy(), [r])).state;
    const noPolicy: LedgerState = { ...s, policy: null };
    const out = checkLineageValid(noPolicy, must(resolveLineage(noPolicy, authorityId(r))), T0);
    assert.ok(!out.ok && out.error.code === 'PRINCIPAL_POLICY_MISSING');
  });
});

describe('revocation', () => {
  async function tree() {
    const { ledger, store } = newLedger();
    const r0 = root(); // held by the principal
    const d1 = child(r0, { holder: TRADING, terms: [ALL_MODULES, DELEGATE(1), dim('capital', units(6_000))] });
    const d2 = child(d1, { holder: PERP_AGENT, terms: [modules(PERP_V1), dim('capital', units(4_000))] });
    const sibling = child(r0, { holder: AGENT_B, nonce: 1n, terms: [ALL_MODULES, dim('capital', units(1_000))] });
    await setup(ledger, policy(), [r0, d1, d2, sibling]);
    return { ledger, store, r0, d1, d2, sibling };
  }

  it('revokes the whole subtree for new use, keeps every node, and leaves siblings untouched', async () => {
    const { ledger, r0, d1, d2, sibling } = await tree();
    const s = committed(await ledger.revoke(PRINCIPAL, revocation(d1), T0 + 1n, ONCE));
    assert.equal(s.state.nodes.size, 4);
    assert.equal(s.state.nodes.get(authorityId(d1))?.revokedAt, s.version);
    assert.equal(s.state.nodes.get(authorityId(d2))?.revokedAt, null); // revoked through its ancestor, not marked
    const blocked = refused(await ledger.reserve(plan({ authority: d2, contributions: [contribution(capital(units(1)))] }), T0 + 1n, ONCE));
    assert.equal(blocked.code, 'AUTHORITY_REVOKED');
    assert.equal(nodeOf(blocked), authorityId(d1));
    committed(await ledger.reserve(plan({ authority: sibling, contributions: [contribution(capital(units(1)))] }), T0 + 1n, ONCE));
    // Registering a new child under the revoked subtree is refused too.
    assert.equal(refused(await ledger.registerGrant(child(d2, { holder: AGENT_A }), T0 + 1n, ONCE)).code, 'AUTHORITY_REVOKED');
    void r0;
  });

  it('is irreversible: the same grant cannot be re-registered, and a second revocation is refused', async () => {
    const { ledger, d1, d2 } = await tree();
    committed(await ledger.revoke(PRINCIPAL, revocation(d1), T0, ONCE));
    assert.equal(refused(await ledger.registerGrant(d1, T0, ONCE)).code, 'AUTHORITY_ALREADY_REGISTERED');
    assert.equal(refused(await ledger.revoke(PRINCIPAL, revocation(d1, P, T0, 1n), T0, ONCE)).code, 'AUTHORITY_REVOKED');
    const below = refused(await ledger.revoke(PRINCIPAL, revocation(d2), T0, ONCE));
    assert.equal(below.code, 'AUTHORITY_REVOKED');
    assert.equal(nodeOf(below), authorityId(d1));
  });

  it('may be issued by the issuer of the target or of any ancestor, never by a descendant or an outsider', async () => {
    const { ledger, r0, d1, d2 } = await tree();
    // TRADING (holder of D1) issued D2, so it may revoke D2 — but not its own node D1, nor the root.
    assert.equal(refused(await ledger.revoke(PRINCIPAL, revocation(d1, TRADING), T0, ONCE)).code, 'REVOCATION_ISSUER_NOT_ELIGIBLE');
    assert.equal(refused(await ledger.revoke(PRINCIPAL, revocation(r0, TRADING), T0, ONCE)).code, 'REVOCATION_ISSUER_NOT_ELIGIBLE');
    // A holder cannot revoke its own node; an outsider nothing.
    assert.equal(refused(await ledger.revoke(PRINCIPAL, revocation(d2, PERP_AGENT), T0, ONCE)).code, 'REVOCATION_ISSUER_NOT_ELIGIBLE');
    assert.equal(refused(await ledger.revoke(PRINCIPAL, revocation(d2, OUTSIDER), T0, ONCE)).code, 'REVOCATION_ISSUER_NOT_ELIGIBLE');
    committed(await ledger.revoke(PRINCIPAL, revocation(d2, TRADING), T0, ONCE));
  });

  it('is not scheduled: effectiveAt after the registration time is refused; an unknown target is refused', async () => {
    const { ledger, d1 } = await tree();
    assert.equal(refused(await ledger.revoke(PRINCIPAL, revocation(d1, P, T0 + 60n), T0, ONCE)).code, 'REVOCATION_NOT_EFFECTIVE');
    assert.equal(refused(await ledger.revoke(PRINCIPAL, revocation(digestOf('nobody') as AuthorityId), T0, ONCE)).code, 'AUTHORITY_UNKNOWN');
  });

  it('keeps independent principals apart: revoking in one ledger touches nothing in another', async () => {
    const { ledger, d1 } = await tree();
    const other = root({ principal: P2 });
    committed(await ledger.registerPolicy(policy([], 1n, P2), T0, ONCE));
    committed(await ledger.registerGrant(other, T0, ONCE));
    const before = await ledger.read(PRINCIPAL_2);
    committed(await ledger.revoke(PRINCIPAL, revocation(d1), T0, ONCE));
    const after = await ledger.read(PRINCIPAL_2);
    assert.equal(after.version, before.version);
    assert.equal(after.head, before.head);
    // Nor can one principal's issuer revoke in another's ledger.
    assert.equal(refused(await ledger.revoke(PRINCIPAL_2, revocation(other, P), T0, ONCE)).code, 'REVOCATION_ISSUER_NOT_ELIGIBLE');
  });
});

describe('effective authority is readable for any registered node', () => {
  it('computes the meet over the whole lineage', async () => {
    const { ledger } = newLedger();
    const r0 = root({ terms: [modules(PERP_V1, SPOT_V1), DELEGATE(2)] });
    const d1 = child(r0, { holder: TRADING, terms: [modules(PERP_V1, SPOT_V1), DELEGATE(1)] });
    const d2 = child(d1, { holder: AGENT_A, terms: [modules(PERP_V1)], expiresAt: T_END - 10n });
    const s = (await setup(ledger, policy(), [r0, d1, d2])).state;
    const e = must(effectiveAuthority(must(resolveLineage(s, authorityId(d2))), s.policy?.policy as never));
    assert.deepEqual(e.lineage, [authorityId(d2), authorityId(d1), authorityId(r0)]);
    assert.equal(e.validity.expiresAt, T_END - 10n);
    assert.equal(e.delegateDepth, 0);
    const mods = e.sets.find((x) => x.vocabulary === 'MODULES');
    assert.equal(mods?.members.length, 1);
  });
});

describe('AUTH-2 registration half, end to end through the ledger', () => {
  it('holds end to end through the ledger: a refused child never becomes a node', async () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const rand = prng(1000 + seed);
      const { ledger } = newLedger();
      const p = randomSpec(rand);
      const parent = grantOf(p, null, address('50'));
      committed(await ledger.registerPolicy(policy(), T0, ONCE));
      committed(await ledger.registerGrant(parent, p.notBefore, ONCE, semanticsOf(parent)));
      const w = widen(rand, p, narrow(rand, p));
      const bad = grantOf(w.spec, parent);
      const r = refused(await ledger.registerGrant(bad, p.notBefore + 10n, ONCE, semanticsOf(bad)));
      assert.equal(r.code, 'DELEGATION_REFUSED');
      assert.equal((await ledger.read(parent.principal)).state.nodes.has(authorityId(bad)), false);
    }
  });
});
