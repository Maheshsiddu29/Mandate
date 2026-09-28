/**
 * A deterministic offline world for control tests: the registry and catalog
 * over synthetic modules, an in-memory store configured with the catalog's
 * rules, the engine, and outcome helpers. The builders are in builders.ts.
 */

import assert from 'node:assert/strict';
import { policyInvariants, type ActionEnvelope, type AuthorityGrant, type ModuleRef, type PrincipalPolicy } from '@mandate/core';
import { AuthorityLedger, InMemoryLedgerStore, ReferenceModuleRegistry, type InMemoryStoreHooks, type LedgerOutcome, type LedgerSnapshot, type ModuleStatus } from '@mandate/ledger';
import {
  ControlEngine,
  ModuleCatalog,
  controlRules,
  policyProofs,
  semanticProofRefs,
  type AuthorizationOutcome,
  type AuthorizationRecord,
  type AuthorizationRequest,
  type ConformanceVector,
  type ControlRefusal,
  type EvaluationContextInput,
  type SuppliedState,
} from '../../src/index.ts';
import { ONCE, PERP_CFG, SPOT_CFG, T0, must } from './builders.ts';
import { createSyntheticModule, type SyntheticModule } from './synthetic.ts';

export * from './builders.ts';

// --- Results ---------------------------------------------------------------------

export function authorized(o: AuthorizationOutcome): AuthorizationRecord {
  if (o.status !== 'AUTHORIZED') assert.fail(`expected AUTHORIZED, got ${o.status} ${o.refusal.code}/${o.refusal.reason} at ${o.refusal.path}`);
  return o.authorization;
}

export function refused(o: AuthorizationOutcome): ControlRefusal {
  if (o.status !== 'REFUSED') assert.fail(`expected REFUSED, got ${o.status}`);
  return o.refusal;
}

// --- World -----------------------------------------------------------------------

export interface World {
  readonly modules: readonly SyntheticModule[];
  readonly registry: ReferenceModuleRegistry;
  readonly catalog: ModuleCatalog;
  readonly store: InMemoryLedgerStore;
  readonly engine: ControlEngine;
  /** Infrastructure registration only: policies and roots. */
  readonly ledger: AuthorityLedger;
}

export interface WorldOptions {
  readonly modules?: readonly SyntheticModule[];
  readonly hooks?: InMemoryStoreHooks;
  readonly corpus?: (m: SyntheticModule) => readonly ConformanceVector[];
  readonly status?: (m: SyntheticModule) => ModuleStatus;
  /** Registry entries beyond the loaded modules' own. */
  readonly register?: readonly { module: ModuleRef; implementations: readonly string[]; status?: ModuleStatus }[];
}

export function world(o: WorldOptions = {}): World {
  const modules = o.modules ?? [createSyntheticModule(PERP_CFG), createSyntheticModule(SPOT_CFG)];
  const registry = must(
    ReferenceModuleRegistry.create([
      ...modules.map((m) => ({ module: m.ref, status: o.status?.(m) ?? ('ACTIVE' as ModuleStatus), implementations: [m.implementation] })),
      ...(o.register ?? []).map((r) => ({ module: r.module, status: r.status ?? ('ACTIVE' as ModuleStatus), implementations: r.implementations as never })),
    ]),
  );
  const catalog = must(ModuleCatalog.create(registry, modules.map((module) => ({ module, corpus: o.corpus?.(module) ?? [] }))));
  const rules = controlRules(catalog);
  const store = new InMemoryLedgerStore(o.hooks ?? {}, rules);
  return { modules, registry, catalog, store, engine: new ControlEngine({ store, registry, catalog }), ledger: new AuthorityLedger(store, registry, rules) };
}

/**
 * Register a policy through the infrastructure ledger, committing a proof —
 * the exact definition — for each principal-global invariant it restates
 * once activity exists (7D.2).
 */
export async function registerPolicy(w: World, p: PrincipalPolicy, at: bigint, catalog: ModuleCatalog = w.catalog): Promise<LedgerOutcome> {
  const snap = await w.store.read(p.principal);
  const proofs = semanticProofRefs(policyProofs(snap.state, p, catalog), policyInvariants(p));
  return w.ledger.registerPolicy(p, at, ONCE, proofs);
}

function committedOutcome(o: LedgerOutcome): LedgerSnapshot {
  if (o.status !== 'COMMITTED') assert.fail(`expected COMMITTED, got ${o.status}${o.status === 'REFUSED' ? ` ${o.refusal.code} at ${o.refusal.path}` : ''}`);
  return o.snapshot;
}

/** Register a policy and grants, in order. */
export async function setup(w: World, p: PrincipalPolicy, grants: readonly AuthorityGrant[], at: bigint = T0): Promise<LedgerSnapshot> {
  let last = committedOutcome(await w.ledger.registerPolicy(p, at, ONCE));
  for (const g of grants) {
    const r = await w.engine.registerDelegation(g, at, ONCE);
    if (r.status !== 'REGISTERED') assert.fail(`registration refused: ${r.status === 'REFUSED' || r.status === 'CONFLICT' ? `${r.refusal.code}/${r.refusal.reason}` : ''}`);
    last = r.snapshot;
  }
  return last;
}

export function request(a: { envelope: ActionEnvelope; payload: Uint8Array }, states: readonly SuppliedState[], ctx: EvaluationContextInput, generation: bigint = 1n): AuthorizationRequest {
  return { action: a.envelope, payload: a.payload, generation, states, context: ctx };
}
