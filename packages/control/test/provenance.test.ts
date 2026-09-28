/**
 * Historical semantic provenance (Phase 7D.2). A narrowing the ledger
 * accepted commits the exact definition that proved it — the full
 * `ModuleRef`, digest included. Replay resolves that exact artifact and never
 * the digest a registry maps the module's name to later: with it, the
 * history reproduces its state and head; without it, replay refuses. No
 * newer version, other digest or other implementation stands in.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LedgerHeadDigest, ModuleRef } from '@mandate/core';
import {
  ReferenceModuleRegistry,
  batchHead,
  decodeBatch,
  encodeBatch,
  encodeLedgerState,
  replayEncoded,
  semanticInvariantId,
  type LedgerEvent,
  type SemanticInvariantRef,
} from '@mandate/ledger';
import { ModuleCatalog, ReferenceModuleArchive, controlRules, type DomainModule } from '../src/index.ts';
import {
  AGENT_A,
  AGENT_B,
  ONCE,
  PERP_CFG,
  RETRY,
  T0,
  account,
  action,
  authorized,
  capitalDim,
  child,
  context,
  createSyntheticModule,
  marketStates,
  maxLeverage,
  must,
  policy,
  request,
  root,
  setup,
  sizeFor,
  world,
  type SyntheticModule,
} from './support/world.ts';

/** M1: moduleId `synthetic`, version 1, digest A. B: the same name and version under another digest. */
const CFG = { ...PERP_CFG, moduleId: 'synthetic' };

/** A module whose `noWeaker` calls are counted. */
function spied(m: SyntheticModule, calls: { n: number }): DomainModule {
  return { ...m, noWeaker: (p, c) => ((calls.n += 1), m.noWeaker(p, c)) };
}

const leverageDefinition = (m: ModuleRef): SemanticInvariantRef =>
  ({ owner: { kind: 'MODULE', module: m }, invariantId: `${CFG.moduleId}.account-leverage`, version: 1 }) as SemanticInvariantRef;

/** Steps 1–4: M1 proves a 3x child under a 4x parent, the delegation commits, and the ledger moves on. */
async function history() {
  const a = createSyntheticModule(CFG);
  const w = world({ modules: [a] });
  const acct = account(a);
  const parent = root({ mods: [a], holder: AGENT_A, delegate: 1, terms: [capitalDim('capital', 100_000), maxLeverage(a, acct, 4n)] });
  await setup(w, policy(), [parent]);
  const c = child(parent, { mods: [a], holder: AGENT_B, terms: [capitalDim('capital', 50_000), maxLeverage(a, acct, 3n)] });
  const reg = await w.engine.registerDelegation(c, T0, ONCE);
  assert.equal(reg.status, 'REGISTERED');
  const states = marketStates(a, [{ account: acct }]);
  const ctx = context([a], { accounts: [{ module: a, account: acct }] });
  authorized(await w.engine.authorizeAndReserve(request(action(a, { authority: c, size: sizeFor(1_000) }), states, ctx), RETRY));
  authorized(await w.engine.authorizeAndReserve(request(action(a, { authority: c, size: sizeFor(500), nonce: 1n }), states, ctx), RETRY));
  const principal = parent.principal;
  const committedBatches = await w.store.history(principal);
  const snap = await w.store.read(principal);
  return { a, w, principal, committedBatches, batches: committedBatches.map((b) => b.encoded), head: snap.head, stateBytes: encodeLedgerState(snap.state) };
}

describe('the ledger commits the exact semantics of a narrowing', () => {
  it('the registration event names M1 — domain, id, version and digest A — and the definition it used', async () => {
    const h = await history();
    const proven = h.committedBatches.flatMap((b) => b.events).filter((e): e is Extract<LedgerEvent, { kind: 'REGISTER_GRANT' }> => e.kind === 'REGISTER_GRANT' && (e.proofs?.length ?? 0) > 0);
    assert.equal(proven.length, 1);
    assert.deepEqual(proven[0]?.proofs?.[0]?.definition, leverageDefinition(h.a.ref));
    // Decoded from the stored bytes, not only held in memory.
    const decoded = h.batches.map((b) => must(decodeBatch(b))).flatMap((b) => b.events);
    assert.ok(decoded.some((e) => e.kind === 'REGISTER_GRANT' && e.proofs?.[0]?.definition.owner.kind === 'MODULE' && e.proofs[0].definition.owner.module.moduleDigest === h.a.ref.moduleDigest));
  });
});

describe('registry remap: replay asks for digest A, never B', () => {
  it('the name now maps to B; with A archived, replay uses A only and reproduces the state and head; without A it refuses', async () => {
    const h = await history();
    const b = createSyntheticModule({ ...CFG, variant: 'LENIENT_NARROWING' });
    assert.equal(b.ref.moduleId, h.a.ref.moduleId);
    assert.equal(b.ref.moduleVersion, h.a.ref.moduleVersion);
    assert.notEqual(b.ref.moduleDigest, h.a.ref.moduleDigest);

    // 5. A future registry: (synthetic, 1) now points to digest B.
    const future = must(ReferenceModuleRegistry.create([{ module: b.ref, status: 'ACTIVE', implementations: [b.implementation] }]));
    const archive = must(ReferenceModuleArchive.create([{ module: h.a.ref, implementations: [h.a.implementation] }]));
    const callsA = { n: 0 };
    const callsB = { n: 0 };

    // 6. Replay with A archived: A is asked, B never, and the ledger is reproduced exactly.
    const withA = must(ModuleCatalog.create(future, [{ module: spied(b, callsB), corpus: [] }], { archive, modules: [{ module: spied(h.a, callsA), corpus: [] }] }));
    const replayed = replayEncoded(h.principal, h.batches, controlRules(withA));
    assert.ok(replayed.ok, replayed.ok ? '' : `${replayed.error.code} at ${replayed.error.path}`);
    if (replayed.ok) {
      assert.equal(replayed.value.head, h.head);
      assert.deepEqual(encodeLedgerState(replayed.value), h.stateBytes);
    }
    assert.ok(callsA.n > 0, 'digest A was asked');
    assert.equal(callsB.n, 0, 'digest B was never asked');

    // A unavailable: replay refuses — B, current and lenient, is never a substitute.
    const withoutA = must(ModuleCatalog.create(future, [{ module: spied(b, callsB), corpus: [] }]));
    const refusedReplay = replayEncoded(h.principal, h.batches, controlRules(withoutA));
    assert.ok(!refusedReplay.ok);
    if (!refusedReplay.ok) assert.ok(refusedReplay.error.code === 'DELEGATION_REFUSED' && refusedReplay.error.violations.every((v) => v.code === 'DELEGATION_NARROWING_UNPROVEN'));
    assert.equal(callsB.n, 0);
  });

  it('the archive vouches for A by exact identity: another implementation cannot claim A\'s ref, and a newer version cannot own A\'s invariant', async () => {
    const h = await history();
    const archive = must(ReferenceModuleArchive.create([{ module: h.a.ref, implementations: [h.a.implementation] }]));
    const future = must(ReferenceModuleRegistry.create([]));
    const impostor = createSyntheticModule({ ...CFG, variant: 'LENIENT_NARROWING', claim: { ref: { ...h.a.ref }, implementation: `0x${'ee'.repeat(32)}` } });
    const r = ModuleCatalog.create(future, [], { archive, modules: [{ module: impostor, corpus: [] }] });
    assert.ok(!r.ok && r.error.reason === 'MODULE_IMPLEMENTATION_UNREGISTERED');
    const newer = createSyntheticModule({ ...CFG, moduleVersion: 2 });
    const newerArchive = must(ReferenceModuleArchive.create([{ module: newer.ref, implementations: [newer.implementation] }]));
    const claiming = { ...newer, invariants: h.a.invariants } as DomainModule;
    const r2 = ModuleCatalog.create(future, [], { archive: newerArchive, modules: [{ module: claiming, corpus: [] }] });
    assert.ok(!r2.ok && r2.error.reason === 'INVARIANT_OUTSIDE_MODULE_NAMESPACE');
    // Loaded honestly, the newer version is simply not A: replay refuses.
    const withNewer = must(ModuleCatalog.create(future, [], { archive: newerArchive, modules: [{ module: newer, corpus: [] }] }));
    assert.ok(!replayEncoded(h.principal, h.batches, controlRules(withNewer)).ok);
  });

  it('retirement does not touch the committed digest: A retired for new use still replays as A', async () => {
    const h = await history();
    const retired = must(ReferenceModuleRegistry.create([{ module: h.a.ref, status: 'RETIRING', implementations: [h.a.implementation] }]));
    const catalog = must(ModuleCatalog.create(retired, [{ module: h.a, corpus: [] }]));
    const replayed = replayEncoded(h.principal, h.batches, controlRules(catalog));
    assert.ok(replayed.ok);
    if (replayed.ok) assert.equal(replayed.value.head, h.head);
    // The stored bytes still name digest A.
    const events = h.batches.map((x) => must(decodeBatch(x))).flatMap((x) => x.events);
    assert.ok(events.some((e) => e.kind === 'REGISTER_GRANT' && e.proofs?.[0]?.definition.owner.kind === 'MODULE' && e.proofs[0].definition.owner.module.moduleDigest === h.a.ref.moduleDigest));
  });
});

describe('a semantic identity is the exact ModuleRef plus the local invariant identifier', () => {
  it('the same invariant name under another digest is another identity, and cannot prove under A\'s', async () => {
    const h = await history();
    const b = createSyntheticModule({ ...CFG, variant: 'LENIENT_NARROWING' });
    assert.notEqual(semanticInvariantId(leverageDefinition(h.a.ref)), semanticInvariantId(leverageDefinition(b.ref)));
    const acct = account(h.a);
    const parent = must({ ok: true as const, value: root({ mods: [h.a], terms: [maxLeverage(h.a, acct, 4n)] }) });
    const kid = child(parent, { mods: [h.a], terms: [maxLeverage(h.a, acct, 3n)] });
    const term = (g: typeof parent) => g.terms.find((t) => t.kind === 'STATE_INVARIANT') as never;
    // Only A is loaded: a definition naming B is unprovable, one naming A is proved by A.
    assert.equal(h.w.catalog.compareInvariants(term(parent), term(kid), leverageDefinition(b.ref)).verdict, 'UNPROVABLE');
    assert.equal(h.w.catalog.compareInvariants(term(parent), term(kid), leverageDefinition(h.a.ref)).verdict, 'NO_WEAKER');
  });

  it('a proof committed under A cannot be re-pointed to B: the history\'s head changes, whatever B would say', async () => {
    const h = await history();
    const b = createSyntheticModule({ ...CFG, variant: 'LENIENT_NARROWING' });
    // Re-pointing only the proof is refused outright: it no longer agrees with the term's committed binding (7D.3).
    const proofOnly = h.committedBatches.map((batch) =>
      encodeBatch(h.principal, batch.version, batch.previousHead, batch.events.map((e) => (e.kind === 'REGISTER_GRANT' && e.proofs !== undefined ? { ...e, proofs: e.proofs.map((p) => ({ ...p, definition: leverageDefinition(b.ref) })) } : e))),
    );
    const mismatched = replayEncoded(h.principal, proofOnly, controlRules(h.w.catalog));
    assert.ok(!mismatched.ok && mismatched.error.code === 'SEMANTIC_BINDING_MISMATCH');
    // Re-point every committed proof and binding at B and re-chain the whole history, as a forger would have to.
    const toB = <T extends { definition: SemanticInvariantRef }>(x: T): T => (x.definition.owner.kind === 'MODULE' ? { ...x, definition: { ...x.definition, owner: { kind: 'MODULE', module: b.ref } } } : x);
    let previous = h.committedBatches[0]?.previousHead as LedgerHeadDigest;
    const forged: Uint8Array[] = [];
    for (const batch of h.committedBatches) {
      const events = batch.events.map((e) =>
        e.kind === 'REGISTER_GRANT' && e.bindings !== undefined ? { ...e, bindings: e.bindings.map(toB), ...(e.proofs !== undefined ? { proofs: e.proofs.map(toB) } : {}) } : e,
      );
      const bytes = encodeBatch(h.principal, batch.version, previous, events);
      forged.push(bytes);
      previous = batchHead(bytes);
    }
    const k = h.committedBatches.findIndex((x) => x.events.some((e) => e.kind === 'REGISTER_GRANT' && e.proofs !== undefined));
    // Only the child's registration altered, on the genuine previous head.
    const genuineK = h.committedBatches[k] as (typeof h.committedBatches)[number];
    const childOnly = encodeBatch(h.principal, genuineK.version, genuineK.previousHead, genuineK.events.map((e) => (e.kind === 'REGISTER_GRANT' && e.bindings !== undefined ? { ...e, bindings: e.bindings.map(toB), ...(e.proofs !== undefined ? { proofs: e.proofs.map(toB) } : {}) } : e)));
    const spliced = h.batches.map((x, i) => (i === k ? childOnly : x));
    // Spliced into the genuine chain, the child's term now means B under a parent whose term means A: refused, under any verifier.
    const bRegistry = must(ReferenceModuleRegistry.create([{ module: b.ref, status: 'ACTIVE', implementations: [b.implementation] }]));
    const bCatalog = must(ModuleCatalog.create(bRegistry, [{ module: b, corpus: [] }]));
    for (const verifier of [h.w.catalog, bCatalog]) {
      const r = replayEncoded(h.principal, spliced, controlRules(verifier));
      assert.ok(!r.ok && r.error.code === 'SEMANTIC_BINDING_MISMATCH', r.ok ? 'ok' : `${r.error.code} at ${r.error.path}`);
    }
    // Fully re-chained under the genuine verifier, B's semantics are not there, so the narrowing is unproven.
    const unproven = replayEncoded(h.principal, forged, controlRules(h.w.catalog));
    assert.ok(!unproven.ok && unproven.error.code === 'DELEGATION_REFUSED');
    // Fully re-chained, it may fold — but to another head than the one attested.
    const refolded = replayEncoded(h.principal, forged, controlRules(bCatalog));
    assert.ok(refolded.ok);
    if (refolded.ok) assert.notEqual(refolded.value.head, h.head);
  });
});
