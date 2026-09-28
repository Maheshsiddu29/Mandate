/**
 * The module archive: semantic artifacts by exact, content-addressed identity
 * (Phase 7D.2).
 *
 * A registry answers "which digest is `(moduleId, version)` *now*" — one
 * digest per name, a fact about the present that governance may change. A
 * ledger history answers to the past: every narrowing it accepted names the
 * exact `ModuleRef` whose comparator proved it (ledger `SemanticProofRef`).
 * Replaying that history therefore needs the implementation for *that*
 * `ModuleRef`, digest included, whatever the registry maps its name to
 * today. The archive is where such implementations are found:
 *
 * - keyed by the full `ModuleRef` digest, never by name — two digests of one
 *   name are two entries, and neither stands in for the other;
 * - each entry lists the implementation digests conforming to it, exactly as
 *   a registration does;
 * - seeded once and immutable, like the reference registry.
 *
 * An archived implementation is loaded into a catalog only for exact
 * historical resolution (catalog.ts `resolveExact`). It never owns an
 * invariant by name, never serves a new decision and never proves a new
 * narrowing. Keeping every artifact a history depends on — and governing who
 * may add one — is the production archive's job (open question 16); this is
 * the reference form.
 */

import { ok } from '@mandate/kernel';
import { moduleRefDigest, type ImplementationDigest, type ModuleRef } from '@mandate/core';
import { refuse, type ControlResult } from './errors.ts';

export interface ArchivedModule {
  readonly module: ModuleRef;
  readonly implementations: readonly ImplementationDigest[];
}

export interface ModuleArchive {
  /** The entry for exactly this `ModuleRef` — domain, id, version and digest — or `null`. */
  lookup(module: ModuleRef): ArchivedModule | null;
}

export class ReferenceModuleArchive implements ModuleArchive {
  readonly #entries: ReadonlyMap<string, ArchivedModule>;

  private constructor(entries: ReadonlyMap<string, ArchivedModule>) {
    this.#entries = entries;
  }

  static create(entries: readonly ArchivedModule[]): ControlResult<ReferenceModuleArchive> {
    const map = new Map<string, ArchivedModule>();
    for (let i = 0; i < entries.length; i += 1) {
      const e = entries[i] as ArchivedModule;
      const key = moduleRefDigest(e.module);
      if (map.has(key)) return refuse('REQUEST_INVALID', 'ARCHIVE_DUPLICATE_MODULE', `entries[${i}]`, { module: e.module });
      map.set(key, Object.freeze({ module: e.module, implementations: Object.freeze([...e.implementations]) }));
    }
    return ok(new ReferenceModuleArchive(map));
  }

  lookup(module: ModuleRef): ArchivedModule | null {
    return this.#entries.get(moduleRefDigest(module)) ?? null;
  }
}

/** An empty archive: nothing but the current registry's modules can be resolved. */
export const EMPTY_ARCHIVE: ModuleArchive = Object.freeze({ lookup: () => null });
