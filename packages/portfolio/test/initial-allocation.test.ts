import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { partyIdInputOf } from '@mandate/core';
import { demoMandate } from '../src/demo/index.ts';
import { decodeInitialAllocationPlan, encodeInitialAllocationPlan, initialAllocationDigest, initialAllocationPlanInputOf, validateInitialAllocationPlan, type InitialAllocationPlanInput } from '../src/initial-allocation.ts';
import { portfolioMandateDigest } from '../src/mandate.ts';

const must = <T>(r: { readonly ok: true; readonly value: T } | { readonly ok: false }): T => {
  assert.equal(r.ok, true);
  return (r as { readonly ok: true; readonly value: T }).value;
};

function input(overrides: Partial<InitialAllocationPlanInput> = {}): { readonly mandate: ReturnType<typeof demoMandate>; readonly input: InitialAllocationPlanInput } {
  const mandate = demoMandate();
  const amounts = [800_000_000n, 400_000_000n, 500_000_000n, 300_000_000n, 0n];
  return {
    mandate,
    input: {
      portfolioMandateDigest: portfolioMandateDigest(mandate),
      totalCapitalAtoms: 2_000_000_000n,
      mode: 'FIXED',
      autoReallocate: false,
      entries: mandate.agents.map((policy, i) => ({ agent: partyIdInputOf(policy.agent), allocatedAtoms: amounts[i] ?? 0n, source: 'FIXED' })),
      unallocatedAtoms: 0n,
      ...overrides,
    },
  };
}

describe('canonical initial allocation', () => {
  it('is deterministic and input order cannot change the digest', () => {
    const a = input();
    const plan = must(validateInitialAllocationPlan(a.input, a.mandate));
    const reversed = must(validateInitialAllocationPlan({ ...a.input, entries: [...a.input.entries].reverse() }, a.mandate));
    assert.equal(initialAllocationDigest(plan), initialAllocationDigest(reversed));
    assert.deepEqual(must(decodeInitialAllocationPlan(encodeInitialAllocationPlan(plan), a.mandate)), plan);
    assert.equal(initialAllocationDigest(must(validateInitialAllocationPlan(initialAllocationPlanInputOf(plan), a.mandate))), initialAllocationDigest(plan));
  });

  it('commits amounts, unallocated capital, mode and reallocation permission', () => {
    const a = input();
    const base = initialAllocationDigest(must(validateInitialAllocationPlan(a.input, a.mandate)));
    const changedEntry = a.input.entries.map((entry, i) => (i === 0 ? { ...entry, allocatedAtoms: entry.allocatedAtoms as bigint - 100_000_000n } : i === 1 ? { ...entry, allocatedAtoms: entry.allocatedAtoms as bigint + 100_000_000n } : entry));
    assert.notEqual(initialAllocationDigest(must(validateInitialAllocationPlan({ ...a.input, entries: changedEntry }, a.mandate))), base);
    assert.notEqual(initialAllocationDigest(must(validateInitialAllocationPlan({ ...a.input, entries: a.input.entries.map((entry, i) => (i === 0 ? { ...entry, allocatedAtoms: entry.allocatedAtoms as bigint - 1n } : entry)), unallocatedAtoms: 1n }, a.mandate))), base);
    assert.notEqual(initialAllocationDigest(must(validateInitialAllocationPlan({ ...a.input, autoReallocate: true }, a.mandate))), base);
    const dynamicEntries = a.input.entries.map((entry) => ({ ...entry, source: 'PLANNED' }));
    assert.notEqual(initialAllocationDigest(must(validateInitialAllocationPlan({ ...a.input, mode: 'DYNAMIC', entries: dynamicEntries }, a.mandate))), base);
  });

  it('refuses duplicates, disabled agents, incoherent totals and malformed amounts', () => {
    const a = input();
    assert.equal(validateInitialAllocationPlan({ ...a.input, entries: [a.input.entries[0]!, a.input.entries[0]!, ...a.input.entries.slice(2)] }, a.mandate).ok, false);
    const outsider = { agent: { kind: 'agent-id', value: 'agent:disabled' }, allocatedAtoms: 0n, source: 'FIXED' };
    assert.equal(validateInitialAllocationPlan({ ...a.input, entries: [outsider, ...a.input.entries.slice(1)] }, a.mandate).ok, false);
    assert.equal(validateInitialAllocationPlan({ ...a.input, unallocatedAtoms: 1n }, a.mandate).ok, false);
    assert.equal(validateInitialAllocationPlan({ ...a.input, entries: a.input.entries.map((entry, i) => (i === 0 ? { ...entry, allocatedAtoms: -1n } : entry)), unallocatedAtoms: 800_000_001n }, a.mandate).ok, false);
    assert.equal(validateInitialAllocationPlan({ ...a.input, entries: a.input.entries.map((entry, i) => (i === 0 ? { ...entry, allocatedAtoms: '01' } : entry)) }, a.mandate).ok, false);
  });

  it('supports FIXED, DYNAMIC and HYBRID accepted plans', () => {
    const a = input();
    assert.equal(validateInitialAllocationPlan(a.input, a.mandate).ok, true);
    assert.equal(validateInitialAllocationPlan({ ...a.input, mode: 'DYNAMIC', entries: a.input.entries.map((entry) => ({ ...entry, source: 'PLANNED' })) }, a.mandate).ok, true);
    assert.equal(validateInitialAllocationPlan({ ...a.input, mode: 'HYBRID', entries: a.input.entries.map((entry, i) => ({ ...entry, source: i < 2 ? 'FIXED' : 'PLANNED' })) }, a.mandate).ok, true);
  });
});
