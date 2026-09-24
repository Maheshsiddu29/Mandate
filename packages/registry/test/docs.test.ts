/**
 * Documentation generated from code must not drift from it, and the two reason-code
 * registries must remain one vocabulary rather than two overlapping ones.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ALL_REASON_CODE_NAMES, REASON_CODES } from '@mandate/kernel';
import {
  ALL_REGISTRY_REASON_CODE_NAMES,
  anyReasonCode,
  isKernelReasonCode,
  REGISTRY_REASON_CODES,
  registryReasonCode,
  registryReasonCodeById,
} from '../src/index.ts';
import {
  REGISTRY_DOC_PATH,
  REUSED_KERNEL_CODES,
  renderRegistryReasonCodesDoc,
} from './support/generate-reason-codes-doc.ts';

test('the committed registry reason-code document matches the code', () => {
  assert.equal(
    readFileSync(REGISTRY_DOC_PATH, 'utf8'),
    renderRegistryReasonCodesDoc(),
    'docs/registry-reason-codes.md is stale; run `npm run docs:generate`',
  );
});

test('the two reason-code registries share no name', () => {
  // The property that makes RegistryReasonCode a single vocabulary rather than two
  // that a caller has to disambiguate.
  const kernel = new Set<string>(ALL_REASON_CODE_NAMES);
  for (const name of ALL_REGISTRY_REASON_CODE_NAMES) {
    assert.equal(kernel.has(name), false, `${name} is defined in both registries`);
  }
});

test('the two reason-code registries share no id', () => {
  const kernelIds = new Set(REASON_CODES.map((d) => d.id));
  for (const d of REGISTRY_REASON_CODES) {
    assert.equal(kernelIds.has(d.id), false, `${d.id} is defined in both registries`);
  }
});

test('registry ids are well formed and unique', () => {
  const seen = new Set<string>();
  for (const d of REGISTRY_REASON_CODES) {
    assert.match(d.id, /^MND-(REF|REG)-\d{3}$/, d.id);
    assert.equal(seen.has(d.id), false, `duplicate id ${d.id}`);
    seen.add(d.id);
    assert.equal(registryReasonCodeById(d.id)?.name, d.name);
    assert.equal(registryReasonCode(d.name).id, d.id);
  }
});

test('every registry code has both messages, and the human one leaks nothing', () => {
  for (const d of REGISTRY_REASON_CODES) {
    assert.ok(d.developerMessage.length > 20, d.name);
    assert.ok(d.humanMessage.length > 10, d.name);
    // An end-user message must not carry internal structure.
    assert.doesNotMatch(d.humanMessage, /0x[0-9a-f]{6}|MND-|eip155|claim set|trust floor/i, d.name);
  }
});

test('the reused-kernel-code list names only codes the kernel defines', () => {
  // A documentation list that named a nonexistent code would be worse than no list.
  const kernel = new Set<string>(ALL_REASON_CODE_NAMES);
  for (const [name] of REUSED_KERNEL_CODES) {
    assert.ok(kernel.has(name), `${name} is documented as reused but the kernel does not define it`);
  }
});

test('anyReasonCode resolves codes from either registry', () => {
  const fromKernel = anyReasonCode('REPRESENTATION_UNKNOWN');
  assert.equal(fromKernel.registry, 'kernel');
  assert.match(fromKernel.id, /^MND-ASSET-/);
  assert.ok(isKernelReasonCode('REPRESENTATION_UNKNOWN'));

  const fromRegistry = anyReasonCode('REFERENCE_AMBIGUOUS');
  assert.equal(fromRegistry.registry, 'registry');
  assert.match(fromRegistry.id, /^MND-REF-/);
  assert.equal(isKernelReasonCode('REFERENCE_AMBIGUOUS'), false);
});
