/**
 * Exact module resolution and catalog admission (DOM-2; action-state-model.md
 * §8.1; brief §5, §50): an implementation runs only for exactly the
 * `ModuleRef` the registry maps its name to, and nothing falls back.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateModuleRef } from '@mandate/core';
import { ReferenceModuleRegistry, type ModuleRegistration } from '@mandate/ledger';
import { ModuleCatalog, type DomainModule } from '../src/index.ts';
import { createSyntheticModule, syntheticRef, type SyntheticConfig } from './support/synthetic.ts';

const PERP_CFG: SyntheticConfig = { domainId: 'synth-perp', moduleId: 'perp-like', moduleVersion: 1, markets: [{ localId: 'x:BTC-PERP', asset: { domain: 'registry', kind: 'CANONICAL_ASSET', localId: 'crypto:btc' } }] };
const SPOT_CFG: SyntheticConfig = { ...PERP_CFG, domainId: 'synth-spot', moduleId: 'spot-like', markets: [{ localId: 'x:BTC-SPOT', asset: { domain: 'registry', kind: 'CANONICAL_ASSET', localId: 'crypto:btc' } }] };

function must<T>(r: { ok: true; value: T } | { ok: false; error: object }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function registryOf(entries: readonly { m: DomainModule; status?: ModuleRegistration['status'] }[]): ReferenceModuleRegistry {
  return must(ReferenceModuleRegistry.create(entries.map((e) => ({ module: e.m.ref, status: e.status ?? 'ACTIVE', implementations: [e.m.implementation] }))));
}

function catalogError(registry: ReferenceModuleRegistry, modules: readonly DomainModule[]) {
  const r = ModuleCatalog.create(registry, modules.map((module) => ({ module, corpus: [] })));
  assert.ok(!r.ok, 'expected the catalog to refuse');
  return r.ok ? (null as never) : r.error;
}

describe('exact ModuleRef resolution (brief §5)', () => {
  it('refuses an unknown module, another digest under the same name, a retiring module for new decisions, and a registered module with no loaded implementation', async () => {
    const perp = createSyntheticModule(PERP_CFG);
    const spot = createSyntheticModule(SPOT_CFG);
    const registry = registryOf([{ m: perp }, { m: spot, status: 'RETIRING' }]);
    const catalog = must(ModuleCatalog.create(registry, [{ module: perp, corpus: [] }]));
    const other = must(validateModuleRef({ ...syntheticRef(PERP_CFG), moduleDigest: `0x${'ab'.repeat(32)}` }));
    const unknown = must(validateModuleRef({ domainId: 'synth-perp', moduleId: 'nobody', moduleVersion: 1, moduleDigest: `0x${'cd'.repeat(32)}` }));
    const r = (x: ReturnType<ModuleCatalog['resolveForDecision']>) => (x.ok ? 'OK' : `${x.error.code}/${x.error.reason}`);
    assert.equal(r(catalog.resolveForDecision(perp.ref)), 'OK');
    assert.equal(r(catalog.resolveForDecision(unknown)), 'MODULE_NOT_FOUND/MODULE_UNREGISTERED');
    assert.equal(r(catalog.resolveForDecision(other)), 'MODULE_NOT_FOUND/MODULE_DIGEST_MISMATCH');
    assert.equal(r(catalog.resolveForDecision(spot.ref)), 'MODULE_NOT_FOUND/MODULE_RETIRING');
    assert.equal(r(catalog.resolveForLifecycle(spot.ref)), 'MODULE_NOT_FOUND/NO_CONFORMING_IMPLEMENTATION');
  });

  it('refuses a catalog with an unregistered module, an unregistered implementation, a duplicate, a claimed core invariant or an invariant owned twice', () => {
    const perp = createSyntheticModule(PERP_CFG);
    const reg = registryOf([{ m: perp }]);
    const spot = createSyntheticModule(SPOT_CFG);
    assert.equal(catalogError(reg, [spot]).reason, 'MODULE_UNREGISTERED');
    const liar = createSyntheticModule({ ...PERP_CFG, claim: { ref: syntheticRef(PERP_CFG), implementation: `0x${'ee'.repeat(32)}` } });
    assert.equal(catalogError(reg, [liar]).reason, 'MODULE_IMPLEMENTATION_UNREGISTERED');
    assert.equal(catalogError(reg, [perp, perp]).reason, 'DUPLICATE_IMPLEMENTATION');
    const greedy = { ...perp, invariants: [{ invariantId: "core.aggregate-max", version: 1 }] } as unknown as DomainModule;
    assert.equal(catalogError(reg, [greedy]).reason, 'CORE_INVARIANT_CLAIMED');
    const twin = createSyntheticModule({ ...PERP_CFG, moduleVersion: 2 });
    const twinClaims = { ...twin, invariants: perp.invariants } as DomainModule;
    assert.equal(catalogError(registryOf([{ m: perp }, { m: twin }]), [perp, twinClaims]).reason, 'INVARIANT_OWNED_TWICE');
  });
});

describe('declared identity and shape', () => {
  it('a semantic change changes the digest even when nobody changes the version; the other digest is refused', () => {
    const reference = createSyntheticModule(PERP_CFG);
    const other = createSyntheticModule({ ...PERP_CFG, variant: 'PENDING_HALF' });
    assert.equal(other.ref.moduleVersion, reference.ref.moduleVersion);
    assert.notEqual(other.ref.moduleDigest, reference.ref.moduleDigest);
    assert.equal(catalogError(registryOf([{ m: reference }]), [other]).reason, 'MODULE_DIGEST_MISMATCH');
  });

  it('a module declaring a ref other than the registered one, or missing a function, is not conforming', () => {
    const perp = createSyntheticModule(PERP_CFG);
    const reg = registryOf([{ m: perp }]);
    const wrongRef = createSyntheticModule({ ...PERP_CFG, claim: { ref: { ...syntheticRef(PERP_CFG), domainId: 'other-domain' }, implementation: perp.implementation } });
    assert.equal(catalogError(reg, [wrongRef]).reason, 'MODULE_DIGEST_MISMATCH');
    const incomplete = { ...perp, project: undefined } as unknown as DomainModule;
    assert.equal(catalogError(reg, [incomplete]).reason, 'FUNCTION_MISSING');
  });
});
