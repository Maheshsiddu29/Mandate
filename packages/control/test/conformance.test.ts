/**
 * Conformance: the corpus, determinism and purity, digest discipline against
 * a lying implementation, and hostile modules — rejected by conformance and,
 * if loaded without it, refused at run time with the ledger untouched
 * (DOM-1; brief §47–§50).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ReferenceModuleRegistry, type ModuleRegistration } from '@mandate/ledger';
import { ModuleCatalog, checkConformance, type DomainModule } from '../src/index.ts';
import { syntheticCorpus } from './support/corpus.ts';
import {
  AGENT_A,
  ONCE,
  PERP_CFG,
  SPOT_CFG,
  account,
  action,
  capitalDim,
  context,
  createSyntheticModule,
  marketStates,
  must,
  policy,
  refused,
  request,
  root,
  setup,
  sizeFor,
  syntheticImplementation,
  syntheticRef,
  world,
  type SyntheticModule,
  type Variant,
} from './support/world.ts';
import { validateModuleRef } from '@mandate/core';

function registryOf(entries: readonly { m: DomainModule; status?: ModuleRegistration['status'] }[]): ReferenceModuleRegistry {
  return must(ReferenceModuleRegistry.create(entries.map((e) => ({ module: e.m.ref, status: e.status ?? 'ACTIVE', implementations: [e.m.implementation] }))));
}

function catalogError(registry: ReferenceModuleRegistry, modules: readonly DomainModule[], corpus = true) {
  const r = ModuleCatalog.create(registry, modules.map((module) => ({ module, corpus: corpus ? syntheticCorpus(module as SyntheticModule) : [] })));
  assert.ok(!r.ok, 'expected the catalog to refuse');
  return r.ok ? (null as never) : r.error;
}

describe('conformance of the reference module', () => {
  it('passes its own corpus, twice, deterministically', () => {
    for (const cfg of [PERP_CFG, SPOT_CFG]) {
      const m = createSyntheticModule(cfg);
      assert.ok(checkConformance(m, registryOf([{ m }]), syntheticCorpus(m)).ok);
    }
  });

  it('is pure: the same inputs give byte-identical outputs across fresh instances', () => {
    const a = createSyntheticModule(PERP_CFG);
    const b = createSyntheticModule(PERP_CFG);
    assert.equal(a.ref.moduleDigest, b.ref.moduleDigest);
    const [va] = syntheticCorpus(a);
    assert.ok(va !== undefined);
    for (let i = 0; i < 5; i += 1) {
      assert.deepEqual(a.stateRequirements(va.scope), b.stateRequirements(va.scope));
      const pa = a.project(va.scope, va.states);
      const pb = b.project(va.scope, va.states);
      assert.deepEqual(pa, pb);
      assert.ok(pa.ok);
      if (pa.ok) {
        assert.deepEqual(a.evaluateInvariant(va.scope.invariants[0] as never, pa.value), b.evaluateInvariant(va.scope.invariants[0] as never, pa.value));
        assert.deepEqual(a.deriveLedgerDemands(va.scope.action as never, pa.value), b.deriveLedgerDemands(va.scope.action as never, pa.value));
      }
    }
  });
});

describe('module digest discipline (brief §50)', () => {
  it('two implementations of one (domain, id, version) with different semantics: only the registered digest executes', () => {
    const reference = createSyntheticModule(PERP_CFG);
    const honestOther = createSyntheticModule({ ...PERP_CFG, variant: 'PENDING_HALF' });
    // A semantic change changes the digest even though nobody changed the version.
    assert.equal(honestOther.ref.moduleVersion, reference.ref.moduleVersion);
    assert.notEqual(honestOther.ref.moduleDigest, reference.ref.moduleDigest);
    const registry = registryOf([{ m: reference }]);
    assert.equal(catalogError(registry, [honestOther]).reason, 'MODULE_DIGEST_MISMATCH');
    // An implementation that claims the registered ref and implementation digest but computes other semantics
    // fails the corpus the registered digest names.
    const liar = createSyntheticModule({ ...PERP_CFG, variant: 'PENDING_HALF', claim: { ref: syntheticRef(PERP_CFG), implementation: syntheticImplementation(PERP_CFG) } });
    assert.equal(catalogError(registry, [liar]).reason, 'CORPUS_MISMATCH');
    assert.ok(ModuleCatalog.create(registry, [{ module: reference, corpus: syntheticCorpus(reference) }]).ok);
  });
});

describe('broken and malicious modules (brief §48)', () => {
  const cases: { variant: Variant; conformance: string; runtime: [string, string] | null }[] = [
    { variant: 'OMIT_OUTPUT', conformance: 'MODULE_OUTPUT_NOT_A_LIST', runtime: ['MODULE_NOT_CONFORMING', 'MODULE_OUTPUT_NOT_A_LIST'] },
    { variant: 'NAN_FACT', conformance: 'NUMBER_NOT_PERMITTED', runtime: ['MODULE_NOT_CONFORMING', 'NUMBER_NOT_PERMITTED'] },
    { variant: 'CHARGE_MARKED', conformance: 'DEMAND_MEASURE_UNDECLARED', runtime: ['DEMAND_INVALID', 'DEMAND_MEASURE_UNDECLARED'] },
    { variant: 'MUTATING', conformance: 'MODULE_FAULT', runtime: ['MODULE_NOT_CONFORMING', 'MODULE_FAULT'] },
    { variant: 'SMUGGLE_STATE', conformance: 'STATE_NOT_ADMITTED_TO_MODULE', runtime: ['MODULE_NOT_CONFORMING', 'STATE_NOT_ADMITTED_TO_MODULE'] },
    // One call cannot show instability; the corpus's second run does.
    { variant: 'UNSTABLE', conformance: 'NONDETERMINISTIC', runtime: null },
  ];

  for (const c of cases) {
    it(`${c.variant}: rejected by conformance, and at run time refused without touching the ledger`, async () => {
      const bad = createSyntheticModule({ ...PERP_CFG, variant: c.variant });
      assert.equal(catalogError(registryOf([{ m: bad }]), [bad]).reason, c.conformance);
      if (c.runtime === null) return;
      // Loaded without its corpus: only the engine's own re-validation stands between it and the ledger.
      const w = world({ modules: [bad] });
      const acct = account(bad);
      const r0 = root({ mods: [bad], holder: AGENT_A, terms: [capitalDim('capital', 100_000)] });
      await setup(w, policy(), [r0]);
      const before = await w.store.read(r0.principal);
      const r = refused(await w.engine.authorizeAndReserve(request(action(bad, { authority: r0, size: sizeFor(100) }), marketStates(bad, [{ account: acct, positions: [{ localId: 'x:BTC-PERP', size: 10n }] }]), context([bad], { accounts: [{ module: bad, account: acct }] })), ONCE));
      assert.deepEqual([r.code, r.reason], c.runtime);
      const after = await w.store.read(r0.principal);
      assert.equal(after.head, before.head);
    });
  }

});
