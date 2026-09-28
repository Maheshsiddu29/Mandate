/**
 * DOM-2 at the representation layer: a semantic module's identity includes
 * its digest, and so does an adapter's.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ZERO_DIGEST,
  adapterRefDigest,
  adapterRefsEqual,
  encodeAdapterRef,
  encodeModuleRef,
  moduleRefDigest,
  moduleRefsEqual,
  validateAdapterRef,
  validateModuleRef,
  type ModuleRefInput,
} from '../src/index.ts';
import { EVM_GATE, PERP_V1, PERP_V2, digestOf, must } from './support/basics.ts';

describe('ModuleRef', () => {
  it('is the full four-field object', () => {
    const m = must(validateModuleRef(PERP_V1));
    assert.deepEqual(Object.keys(m).sort(), ['domainId', 'moduleDigest', 'moduleId', 'moduleVersion']);
  });

  it('has no shorthand: a name string is not a ModuleRef', () => {
    const r = validateModuleRef('perp-policy@1' as unknown as ModuleRefInput);
    assert.deepEqual(r, { ok: false, error: { code: 'WRONG_TYPE', path: 'moduleRef' } });
  });

  it('requires the digest, and refuses the all-zero placeholder', () => {
    const { moduleDigest: _omitted, ...withoutDigest } = PERP_V1;
    assert.deepEqual(validateModuleRef(withoutDigest as ModuleRefInput), { ok: false, error: { code: 'MISSING_FIELD', path: 'moduleRef.moduleDigest' } });
    assert.deepEqual(validateModuleRef({ ...PERP_V1, moduleDigest: ZERO_DIGEST }), { ok: false, error: { code: 'ZERO_DIGEST', path: 'moduleRef.moduleDigest' } });
    assert.equal(validateModuleRef({ ...PERP_V1, moduleDigest: PERP_V1.moduleDigest.toUpperCase().replace('0X', '0x') }).ok, false);
  });

  it('refuses a version outside uint32 or not an integer', () => {
    for (const v of [-1, 1.5, Number.NaN, 2 ** 32]) {
      assert.equal(validateModuleRef({ ...PERP_V1, moduleVersion: v }).ok, false, String(v));
    }
  });

  it('two refs differing only by digest are two different semantic modules', () => {
    const patched = must(validateModuleRef({ ...PERP_V2, moduleDigest: digestOf('manifest:perp-policy:2:patched') }));
    const v2 = must(validateModuleRef(PERP_V2));
    assert.equal(patched.moduleId, v2.moduleId);
    assert.equal(patched.moduleVersion, v2.moduleVersion);
    assert.ok(!moduleRefsEqual(patched, v2));
    assert.notDeepEqual(encodeModuleRef(patched), encodeModuleRef(v2));
    assert.notEqual(moduleRefDigest(patched), moduleRefDigest(v2));
  });

  it('every field is part of the identity', () => {
    const base = moduleRefDigest(must(validateModuleRef(PERP_V1)));
    const variants: ModuleRefInput[] = [
      { ...PERP_V1, domainId: 'perp2' },
      { ...PERP_V1, moduleId: 'perp-policy-x' },
      { ...PERP_V1, moduleVersion: 2 },
      { ...PERP_V1, moduleDigest: digestOf('other') },
    ];
    const digests = variants.map((v) => moduleRefDigest(must(validateModuleRef(v))));
    assert.equal(new Set([base, ...digests]).size, variants.length + 1);
  });
});

describe('AdapterRef', () => {
  it('binds the adapter implementation by digest, as a module is', () => {
    const a = must(validateAdapterRef(EVM_GATE));
    const changed = must(validateAdapterRef({ ...EVM_GATE, adapterDigest: digestOf('adapter:evm-gate:1:changed-observation-rule') }));
    assert.ok(!adapterRefsEqual(a, changed));
    assert.notEqual(adapterRefDigest(a), adapterRefDigest(changed));
    assert.notDeepEqual(encodeAdapterRef(a), encodeAdapterRef(changed));
  });

  it('requires a non-zero digest', () => {
    assert.deepEqual(validateAdapterRef({ ...EVM_GATE, adapterDigest: ZERO_DIGEST }), { ok: false, error: { code: 'ZERO_DIGEST', path: 'adapterRef.adapterDigest' } });
  });

  it('is not interchangeable with a ModuleRef, even when the digest bytes coincide', () => {
    const digest = digestOf('shared');
    const m = must(validateModuleRef({ domainId: 'evm-gate', moduleId: 'evm-gate', moduleVersion: 1, moduleDigest: digest }));
    const a = must(validateAdapterRef({ adapterId: 'evm-gate', adapterVersion: 1, adapterDigest: digest }));
    assert.notEqual(moduleRefDigest(m), adapterRefDigest(a));
  });
});
