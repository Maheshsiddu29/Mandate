/**
 * Engine-level fixtures: the seeded module registry, a fresh ledger over the
 * in-memory reference store, outcome assertions and balance lookups.
 */

import assert from 'node:assert/strict';
import { policyInvariants, type AuthorityGrant, type ImplementationDigest, type PrincipalPolicy, type StateInvariantTerm } from '@mandate/core';
import {
  AuthorityLedger,
  InMemoryLedgerStore,
  ReferenceModuleRegistry,
  canonicalBindings,
  grantInvariants,
  isModuleDefined,
  type InMemoryStoreHooks,
  type RegistrationSemantics,
  type SemanticTermBinding,
  type LedgerOutcome,
  type LedgerRefusal,
  type LedgerSnapshot,
  type RetryPolicy,
} from '../../src/index.ts';
import { PERP_IMPL, PERP_V1, PERP_V2, PERP_V2_IMPL, RETIRED_V0, SPOT_IMPL, SPOT_V1, T0, digestOf, int, moduleRef, must, ticks } from './grants.ts';

export * from './grants.ts';
export * from './steps.ts';

export const REGISTRY = must(
  ReferenceModuleRegistry.create([
    { module: moduleRef(SPOT_V1), status: 'ACTIVE', implementations: [SPOT_IMPL] },
    { module: moduleRef(PERP_V1), status: 'ACTIVE', implementations: [PERP_IMPL] },
    { module: moduleRef(PERP_V2), status: 'ACTIVE', implementations: [PERP_V2_IMPL] },
    { module: moduleRef(RETIRED_V0), status: 'RETIRING', implementations: [digestOf('implementation:perp-policy:0') as ImplementationDigest] },
  ]),
);

// --- Semantic bindings (7D.3) -------------------------------------------------------

/**
 * Test-only: the binding of each module-defined term to the module the
 * seeded registry names for it (`<moduleId>.<name>` at the module's
 * version). The control engine derives bindings from the modules' declared
 * invariants; the ledger's tests have no modules, only this registry.
 */
export function bindingsOf(terms: readonly StateInvariantTerm[]): SemanticTermBinding[] {
  const out: SemanticTermBinding[] = [];
  for (const t of terms) {
    if (!isModuleDefined(t)) continue;
    const entry = REGISTRY.lookup(t.invariantId.slice(0, t.invariantId.indexOf('.')), t.version);
    if (entry === null) throw new Error(`no test module for ${t.invariantId}`);
    out.push({ definition: { owner: { kind: 'MODULE', module: entry.module }, invariantId: t.invariantId, version: t.version }, scope: t.scope });
  }
  return canonicalBindings(out);
}

/** The already-derived semantics a grant or policy registers with in these tests. */
export function semanticsOf(x: AuthorityGrant | PrincipalPolicy): RegistrationSemantics {
  return { bindings: bindingsOf('lineage' in x ? grantInvariants(x) : policyInvariants(x)) };
}

// --- Engine and outcomes ---------------------------------------------------------

export const ONCE: RetryPolicy = { maxAttempts: 1 };
export const RETRY: RetryPolicy = { maxAttempts: 8 };

export function newLedger(hooks: InMemoryStoreHooks = {}): { store: InMemoryLedgerStore; ledger: AuthorityLedger } {
  const store = new InMemoryLedgerStore(hooks);
  return { store, ledger: new AuthorityLedger(store, REGISTRY) };
}

export function committed(o: LedgerOutcome): LedgerSnapshot {
  if (o.status !== 'COMMITTED') assert.fail(`expected COMMITTED, got ${o.status}${o.status === 'REFUSED' ? ` ${o.refusal.code} at ${o.refusal.path}` : ''}`);
  return o.snapshot;
}

export function refused(o: LedgerOutcome): LedgerRefusal {
  if (o.status !== 'REFUSED') assert.fail(`expected REFUSED, got ${o.status}`);
  return o.refusal;
}

/** Register a policy and grants in order, each its own commit. */
export async function setup(ledger: AuthorityLedger, p: PrincipalPolicy, grants: readonly AuthorityGrant[], at: bigint = T0): Promise<LedgerSnapshot> {
  let last = committed(await ledger.registerPolicy(p, at, ONCE, semanticsOf(p)));
  for (const g of grants) last = committed(await ledger.registerGrant(g, at, ONCE, semanticsOf(g)));
  return last;
}

/** A store whose reads and commits yield a seeded random number of turns: randomized interleavings. */
export function jitterHooks(rand: () => number, maxTicks = 3): InMemoryStoreHooks {
  return { delay: () => ticks(int(rand, 0, maxTicks)) };
}
