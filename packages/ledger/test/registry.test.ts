/**
 * Module-registry conformance at decision time (DOM-2): the exact ModuleRef
 * must be the registered one for its name, active, and run by a registered
 * conforming implementation. The registry has no way to change itself.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ReferenceModuleRegistry, checkModuleConformance } from '../src/index.ts';
import {
  ALL_MODULES,
  ONCE,
  PERP_IMPL,
  PERP_V1,
  PERP_V1_OTHER_DIGEST,
  PERP_V2,
  PERP_V2_IMPL,
  PRINCIPAL,
  RETIRED_V0,
  REGISTRY,
  ROGUE_IMPL,
  UNREGISTERED,
  capital,
  committed,
  contribution,
  dim,
  modules,
  moduleRef,
  newLedger,
  plan,
  policy,
  refused,
  root,
  setup,
  T0,
  units,
} from './support/fixtures.ts';

describe('module registry', () => {
  it('answers the three conformance questions and refuses a retiring module for new decisions', () => {
    const check = (m: typeof PERP_V1, impl = PERP_IMPL) => {
      const r = checkModuleConformance(REGISTRY, moduleRef(m), impl);
      return r.ok ? 'OK' : r.error.code;
    };
    assert.equal(check(PERP_V1), 'OK');
    assert.equal(check(PERP_V2, PERP_V2_IMPL), 'OK');
    assert.equal(check(UNREGISTERED), 'MODULE_UNREGISTERED');
    assert.equal(check(PERP_V1_OTHER_DIGEST), 'MODULE_DIGEST_MISMATCH');
    assert.equal(check({ ...PERP_V1, domainId: 'evm-spot' }), 'MODULE_DIGEST_MISMATCH');
    assert.equal(check(PERP_V1, ROGUE_IMPL), 'MODULE_IMPLEMENTATION_UNREGISTERED');
    assert.equal(check(PERP_V2, PERP_IMPL), 'MODULE_IMPLEMENTATION_UNREGISTERED');
    assert.equal(check(RETIRED_V0), 'MODULE_RETIRING');
  });

  it('never maps one name to two digests, and offers no mutation', () => {
    const dup = ReferenceModuleRegistry.create([
      { module: moduleRef(PERP_V1), status: 'ACTIVE', implementations: [PERP_IMPL] },
      { module: moduleRef(PERP_V1_OTHER_DIGEST), status: 'ACTIVE', implementations: [PERP_IMPL] },
    ]);
    assert.ok(!dup.ok && dup.error.code === 'REGISTRY_DUPLICATE_MODULE');
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(REGISTRY)).filter((m) => m !== 'constructor');
    assert.deepEqual(methods, ['lookup']);
    const entry = REGISTRY.lookup(PERP_V1.moduleId, PERP_V1.moduleVersion);
    assert.ok(entry !== null && Object.isFrozen(entry) && Object.isFrozen(entry.implementations));
  });

  it('is checked before any reservation, even when the grant permits the module', async () => {
    const { ledger } = newLedger();
    const r = root({ terms: [modules(PERP_V1, PERP_V1_OTHER_DIGEST, UNREGISTERED), dim('capital', units(100))] });
    await setup(ledger, policy(), [r]);
    const go = (m: typeof PERP_V1, impl?: string) => ledger.reserve(plan({ authority: r, module: m, ...(impl === undefined ? {} : { implementation: impl }), contributions: [contribution(capital(units(1)))] }), T0, ONCE);
    assert.equal(refused(await go(PERP_V1_OTHER_DIGEST)).code, 'MODULE_DIGEST_MISMATCH');
    assert.equal(refused(await go(UNREGISTERED)).code, 'MODULE_UNREGISTERED');
    assert.equal(refused(await go(PERP_V1, ROGUE_IMPL)).code, 'MODULE_IMPLEMENTATION_UNREGISTERED');
    assert.equal((await ledger.read(PRINCIPAL)).state.reservations.size, 0);
    committed(await go(PERP_V1));
  });

  it('and conformance is not permission: a registered module outside the grant is still refused', async () => {
    const { ledger } = newLedger();
    const r = root({ terms: [modules(PERP_V1), dim('capital', units(100))] });
    await setup(ledger, policy(), [r]);
    const out = refused(await ledger.reserve(plan({ authority: r, module: PERP_V2, contributions: [contribution(capital(units(1)))] }), T0, ONCE));
    assert.equal(out.code, 'MODULE_NOT_PERMITTED');
    void ALL_MODULES;
  });
});
