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
import { moduleRefsEqual, type ImplementationDigest, type ModuleRef } from '@mandate/core';
import { refuse, type LedgerResult } from './errors.ts';

export type ModuleStatus = 'ACTIVE' | 'RETIRING';

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
  if (entry.status === 'RETIRING') return refuse('MODULE_RETIRING', path);
  if (!entry.implementations.includes(implementation)) return refuse('MODULE_IMPLEMENTATION_UNREGISTERED', 'plan.implementation');
  return ok(true);
}
