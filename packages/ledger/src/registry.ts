/**
 * Module-registry conformance lookup (DOM-2; action-state-model.md §8.1).
 *
 * Read-only. The registry answers three questions about a `ModuleRef` a plan
 * names, before any reservation is decided:
 *
 * 1. Is `(moduleId, moduleVersion)` registered? (`MODULE_UNREGISTERED`)
 * 2. Is this exact ref — domain and digest — the registered one for that
 *    name? A name maps to exactly one digest. (`MODULE_DIGEST_MISMATCH`)
 * 3. Is the implementation that will run registered as conforming to that
 *    digest? (`MODULE_IMPLEMENTATION_UNREGISTERED`)
 *
 * and refuses new decisions under a module marked `RETIRING`.
 *
 * **Lifecycle (7E.1).** Three statuses, which must not be confused:
 *
 * - `ACTIVE` — current; new decisions and new authority bindings.
 * - `RETIRING` — trusted semantics retired for new use: no new decisions or
 *   bindings, but existing reservations and bound authority continue under
 *   exactly it (7D.1, 7D.3), and it stays resolvable for replay.
 * - `DISABLED` — no longer trusted. Nothing new of any kind: no decision, no
 *   binding, no revalidation, no issuance attempt, and a term bound to it is
 *   `UNKNOWN`. Its artifact stays archived and resolvable by exact digest for
 *   historical replay and audit only.
 *
 * Enforcement adapters get the same three statuses in an `AdapterRegistry`,
 * keyed by name and content-addressed by `adapterDigest`: a `RETIRING`
 * adapter authorizes nothing new but may still issue under an existing
 * authorization; a `DISABLED` one issues nothing.
 *
 * Registry *governance* — who may register a module or a conforming
 * implementation, and how reproducible builds are verified — is open question
 * 16 and is not solved here. There is deliberately no method to add, change or
 * mark anything: the reference registry is seeded once, validated, and frozen.
 *
 * The check is a decision input, like admitted state, and runs in the engine
 * at decision time. The reducer does not consult the registry, so the ledger's
 * fold depends on its log alone: retiring a module later does not make an
 * already-committed history unreplayable.
 */

import { ok } from '@mandate/kernel';
import { adapterRefsEqual, moduleRefsEqual, type AdapterRef, type ImplementationDigest, type ModuleRef } from '@mandate/core';
import { refuse, type LedgerResult } from './errors.ts';
import type { SemanticInvariantRef, SemanticProofRef, SemanticTermBinding } from './semantic.ts';

export type ModuleStatus = 'ACTIVE' | 'RETIRING' | 'DISABLED';

export interface ModuleRegistration {
  readonly module: ModuleRef;
  readonly status: ModuleStatus;
  readonly implementations: readonly ImplementationDigest[];
}

export interface ModuleRegistry {
  /** The registration for a module name, or `null`. */
  lookup(moduleId: string, moduleVersion: number): ModuleRegistration | null;
}

function nameKey(moduleId: string, moduleVersion: number): string {
  return JSON.stringify([moduleId, moduleVersion]);
}

/** An immutable registry seeded at construction, for tests and reference use. */
export class ReferenceModuleRegistry implements ModuleRegistry {
  readonly #entries: ReadonlyMap<string, ModuleRegistration>;

  private constructor(entries: ReadonlyMap<string, ModuleRegistration>) {
    this.#entries = entries;
  }

  static create(registrations: readonly ModuleRegistration[]): LedgerResult<ReferenceModuleRegistry> {
    const entries = new Map<string, ModuleRegistration>();
    for (let i = 0; i < registrations.length; i += 1) {
      const r = registrations[i] as ModuleRegistration;
      const key = nameKey(r.module.moduleId, r.module.moduleVersion);
      // Two digests may never share a name (action-state-model.md §8.1).
      if (entries.has(key)) return refuse('REGISTRY_DUPLICATE_MODULE', `registrations[${i}]`);
      entries.set(key, Object.freeze({ module: r.module, status: r.status, implementations: Object.freeze([...r.implementations]) }));
    }
    return ok(new ReferenceModuleRegistry(entries));
  }

  lookup(moduleId: string, moduleVersion: number): ModuleRegistration | null {
    return this.#entries.get(nameKey(moduleId, moduleVersion)) ?? null;
  }
}

/** The conformance check a new decision runs. */
export function checkModuleConformance(registry: ModuleRegistry, module: ModuleRef, implementation: ImplementationDigest, path = 'plan.module'): LedgerResult<true> {
  const entry = registry.lookup(module.moduleId, module.moduleVersion);
  if (entry === null) return refuse('MODULE_UNREGISTERED', path);
  if (!moduleRefsEqual(entry.module, module)) return refuse('MODULE_DIGEST_MISMATCH', path);
  if (entry.status === 'DISABLED') return refuse('MODULE_DISABLED', path);
  if (entry.status === 'RETIRING') return refuse('MODULE_RETIRING', path);
  if (!entry.implementations.includes(implementation)) return refuse('MODULE_IMPLEMENTATION_UNREGISTERED', 'plan.implementation');
  return ok(true);
}

/**
 * A new proof's comparator must be the registry's current, active module for
 * its name (7D.2). A decision input, like `checkModuleConformance`: applied
 * when a proof is first committed, never by the reducer, so replay depends
 * only on the exact `ModuleRef` the event committed.
 */
export function checkProofOwnersCurrent(registry: ModuleRegistry, proofs: readonly SemanticProofRef[], path = 'proofs'): LedgerResult<true> {
  return checkOwnersCurrent(registry, proofs, path);
}

/**
 * A new binding's definition must be the registry's current, active module
 * for its name (7D.3): new authority is only ever bound to current
 * semantics. A decision input like `checkProofOwnersCurrent`, applied when a
 * registration is first committed and never by the reducer — so a later
 * registry change can neither reinterpret nor unreplay an existing binding.
 */
export function checkBindingOwnersCurrent(registry: ModuleRegistry, bindings: readonly SemanticTermBinding[], path = 'bindings'): LedgerResult<true> {
  return checkOwnersCurrent(registry, bindings, path);
}

function checkOwnersCurrent(registry: ModuleRegistry, xs: readonly { readonly definition: SemanticInvariantRef }[], path: string): LedgerResult<true> {
  for (let i = 0; i < xs.length; i += 1) {
    const owner = (xs[i] as { readonly definition: SemanticInvariantRef }).definition.owner;
    if (owner.kind !== 'MODULE') continue;
    const entry = registry.lookup(owner.module.moduleId, owner.module.moduleVersion);
    const at = `${path}[${i}].definition.owner`;
    if (entry === null) return refuse('MODULE_UNREGISTERED', at);
    if (!moduleRefsEqual(entry.module, owner.module)) return refuse('MODULE_DIGEST_MISMATCH', at);
    if (entry.status === 'DISABLED') return refuse('MODULE_DISABLED', at);
    if (entry.status === 'RETIRING') return refuse('MODULE_RETIRING', at);
  }
  return ok(true);
}

// --- Enforcement adapters (7E.1) --------------------------------------------------------

export type AdapterStatus = 'ACTIVE' | 'RETIRING' | 'DISABLED';

export interface AdapterRegistration {
  readonly adapter: AdapterRef;
  readonly status: AdapterStatus;
}

export interface AdapterRegistry {
  /** The registration for an adapter name, or `null`. */
  lookup(adapterId: string, adapterVersion: number): AdapterRegistration | null;
}

/** An immutable adapter registry seeded at construction. Status changes are governance, which is not built. */
export class ReferenceAdapterRegistry implements AdapterRegistry {
  readonly #entries: ReadonlyMap<string, AdapterRegistration>;

  private constructor(entries: ReadonlyMap<string, AdapterRegistration>) {
    this.#entries = entries;
  }

  static create(registrations: readonly AdapterRegistration[]): LedgerResult<ReferenceAdapterRegistry> {
    const entries = new Map<string, AdapterRegistration>();
    for (let i = 0; i < registrations.length; i += 1) {
      const r = registrations[i] as AdapterRegistration;
      const key = nameKey(r.adapter.adapterId, r.adapter.adapterVersion);
      if (entries.has(key)) return refuse('REGISTRY_DUPLICATE_ADAPTER', `registrations[${i}]`);
      entries.set(key, Object.freeze({ adapter: r.adapter, status: r.status }));
    }
    return ok(new ReferenceAdapterRegistry(entries));
  }

  lookup(adapterId: string, adapterVersion: number): AdapterRegistration | null {
    return this.#entries.get(nameKey(adapterId, adapterVersion)) ?? null;
  }
}

/**
 * Whether `adapter` may be used — for a new authorization (`DECISION`), or to
 * admit an issuance attempt under an existing one (`ATTEMPT`). Exact by
 * digest: an upgraded adapter is a different adapter and never reinterprets
 * an existing authorization or attempt.
 */
export function checkAdapterUsable(registry: AdapterRegistry, adapter: AdapterRef, purpose: 'DECISION' | 'ATTEMPT', path = 'adapter'): LedgerResult<true> {
  const entry = registry.lookup(adapter.adapterId, adapter.adapterVersion);
  if (entry === null) return refuse('ADAPTER_UNREGISTERED', path);
  if (!adapterRefsEqual(entry.adapter, adapter)) return refuse('ADAPTER_DIGEST_MISMATCH', path);
  if (entry.status === 'DISABLED') return refuse('ADAPTER_DISABLED', path);
  if (entry.status === 'RETIRING' && purpose === 'DECISION') return refuse('ADAPTER_RETIRING', path);
  return ok(true);
}

/** Whether a module may carry an existing reservation to a new issuance attempt: `ACTIVE` or `RETIRING`, never `DISABLED`. */
export function checkModuleIssuable(registry: ModuleRegistry, module: ModuleRef, path = 'module'): LedgerResult<true> {
  const entry = registry.lookup(module.moduleId, module.moduleVersion);
  if (entry === null) return refuse('MODULE_UNREGISTERED', path);
  if (!moduleRefsEqual(entry.module, module)) return refuse('MODULE_DIGEST_MISMATCH', path);
  if (entry.status === 'DISABLED') return refuse('MODULE_DISABLED', path);
  return ok(true);
}
