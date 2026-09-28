/**
 * A deterministic offline world for control tests: the registry and catalog
 * over synthetic modules, an in-memory store configured with the catalog's
 * rules, the engine, and outcome helpers. The builders are in builders.ts.
 */

import assert from 'node:assert/strict';
import { validateAdapterRef, type ActionEnvelope, type AuthorityGrant, type ModuleRef, type PrincipalPolicy } from '@mandate/core';
import { AuthorityLedger, InMemoryLedgerStore, ReferenceAdapterRegistry, ReferenceModuleRegistry, type AdapterStatus, type InMemoryStoreHooks, type LedgerSnapshot, type ModuleStatus } from '@mandate/ledger';
import {
  ControlEngine,
  ModuleCatalog,
  controlRules,
  type AuthorizationOutcome,
  type AuthorizationRecord,
  type AuthorizationRequest,
  type ConformanceVector,
  type ControlRefusal,
  type EvaluationContextInput,
  type RegistrationOutcome,
  type SuppliedState,
} from '../../src/index.ts';
import { ADAPTER, ONCE, PERP_CFG, SPOT_CFG, T0, must } from './builders.ts';
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
  /** Infrastructure only: registrations with already-derived semantics, and tests of that boundary. */
  readonly ledger: AuthorityLedger;
  /** 7E.1: the enforcement-adapter registry, holding the synthetic `ADAPTER`. */
  readonly adapters: ReferenceAdapterRegistry;
}

export interface WorldOptions {
  readonly modules?: readonly SyntheticModule[];
  readonly hooks?: InMemoryStoreHooks;
  readonly corpus?: (m: SyntheticModule) => readonly ConformanceVector[];
  readonly status?: (m: SyntheticModule) => ModuleStatus;
  /** Registry entries beyond the loaded modules' own. */
  readonly register?: readonly { module: ModuleRef; implementations: readonly string[]; status?: ModuleStatus }[];
  /** 7E.1: the synthetic adapter's status. Default `ACTIVE`. */
  readonly adapterStatus?: AdapterStatus;
  /** 7E.1: reuse another world's store (a registry or adapter status change over the same ledger). */
  readonly store?: InMemoryLedgerStore;
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
  const store = o.store ?? new InMemoryLedgerStore(o.hooks ?? {}, rules);
  const adapters = must(ReferenceAdapterRegistry.create([{ adapter: must(validateAdapterRef(ADAPTER)), status: o.adapterStatus ?? 'ACTIVE' }]));
  return { modules, registry, catalog, store, adapters, engine: new ControlEngine({ store, registry, catalog, adapters }), ledger: new AuthorityLedger(store, registry, rules) };
}

/**
 * Register a policy through the control engine, which binds each
 * module-defined term to its exact definition (7D.3) and commits a proof for
 * each principal-global invariant restated once activity exists (7D.2).
 */
export function registerPolicy(w: World, p: PrincipalPolicy, at: bigint): Promise<RegistrationOutcome> {
  return w.engine.registerPolicy(p, at, ONCE);
}

export function registered(r: RegistrationOutcome): LedgerSnapshot {
  if (r.status !== 'REGISTERED') assert.fail(`registration refused: ${r.refusal.code}/${r.refusal.reason} at ${r.refusal.path}`);
  return r.snapshot;
}

/** Register a policy and grants, in order, through the engine. */
export async function setup(w: World, p: PrincipalPolicy, grants: readonly AuthorityGrant[], at: bigint = T0): Promise<LedgerSnapshot> {
  let last = registered(await w.engine.registerPolicy(p, at, ONCE));
  for (const g of grants) last = registered(await w.engine.registerDelegation(g, at, ONCE));
  return last;
}

export function request(a: { envelope: ActionEnvelope; payload: Uint8Array }, states: readonly SuppliedState[], ctx: EvaluationContextInput, generation: bigint = 1n): AuthorizationRequest {
  return { action: a.envelope, payload: a.payload, generation, states, context: ctx };
}
