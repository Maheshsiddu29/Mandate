/**
 * Durable module and adapter lifecycle (Phase 7E.2).
 *
 * The status of every module and enforcement adapter — `ACTIVE`, `RETIRING`,
 * `DISABLED` — lives in one table of the ledger's database, so that the
 * control engine (through `DurableModuleRegistry` / `DurableAdapterRegistry`)
 * and the key-custody process (reading the same table read-only) see the same
 * lifecycle. There is no second, in-memory source of truth for a durable
 * deployment. Rows are keyed by name and version and carry the exact ref, so a
 * re-digested module or adapter under the same name is a different entry, and
 * a lookup under another digest is refused by the usual exact-ref checks.
 *
 * Changing a status is infrastructure (`LifecycleTable.set*`); no governance
 * is built. A lookup reads the table every time, so a status change takes
 * effect at the next decision or attempt.
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { validateAdapterRef, validateModuleRef, type AdapterRef, type ImplementationDigest, type ModuleRef } from '@mandate/core';
import type { AdapterRegistration, AdapterRegistry, AdapterStatus, ModuleRegistration, ModuleRegistry, ModuleStatus } from '@mandate/ledger';
import { textColumn, type SqlRow, type SqliteLedgerStore } from './store.ts';

const STATUSES = ['ACTIVE', 'RETIRING', 'DISABLED'] as const;

export class LifecycleTable {
  readonly #db: DatabaseSync;
  readonly #upsert: StatementSync;
  readonly #get: StatementSync;

  constructor(store: SqliteLedgerStore) {
    this.#db = store.database;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS lifecycle (
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        ref TEXT NOT NULL,
        digest TEXT NOT NULL,
        status TEXT NOT NULL,
        implementations TEXT NOT NULL,
        PRIMARY KEY (kind, name, version)
      ) WITHOUT ROWID;
    `);
    this.#upsert = this.#db.prepare(
      'INSERT INTO lifecycle (kind, name, version, ref, digest, status, implementations) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(kind, name, version) DO UPDATE SET ref = excluded.ref, digest = excluded.digest, status = excluded.status, implementations = excluded.implementations',
    );
    this.#get = this.#db.prepare('SELECT ref, status, implementations FROM lifecycle WHERE kind = ? AND name = ? AND version = ?');
  }

  setModule(r: ModuleRegistration): void {
    this.#upsert.run('MODULE', r.module.moduleId, r.module.moduleVersion, JSON.stringify(r.module), r.module.moduleDigest, r.status, JSON.stringify(r.implementations));
  }

  setAdapter(r: AdapterRegistration): void {
    this.#upsert.run('ADAPTER', r.adapter.adapterId, r.adapter.adapterVersion, JSON.stringify(r.adapter), r.adapter.adapterDigest, r.status, '[]');
  }

  /** The row for `(kind, name, version)`, or `null`; anything malformed is `null` — never a status it does not say. */
  read(kind: 'MODULE' | 'ADAPTER', name: string, version: number): { ref: string; status: (typeof STATUSES)[number]; implementations: string } | null {
    const row = this.#get.get(kind, name, version) as SqlRow | undefined;
    if (row === undefined) return null;
    const status = STATUSES.find((s) => s === textColumn(row, 'status'));
    return status === undefined ? null : { ref: textColumn(row, 'ref'), status, implementations: textColumn(row, 'implementations') };
  }
}

export class DurableModuleRegistry implements ModuleRegistry {
  readonly #table: LifecycleTable;

  constructor(table: LifecycleTable) {
    this.#table = table;
  }

  lookup(moduleId: string, moduleVersion: number): ModuleRegistration | null {
    const row = this.#table.read('MODULE', moduleId, moduleVersion);
    if (row === null) return null;
    const ref = validateModuleRef(JSON.parse(row.ref) as ModuleRef);
    const impls = JSON.parse(row.implementations) as string[];
    if (!ref.ok || !Array.isArray(impls)) return null;
    return { module: ref.value, status: row.status as ModuleStatus, implementations: impls as ImplementationDigest[] };
  }
}

export class DurableAdapterRegistry implements AdapterRegistry {
  readonly #table: LifecycleTable;

  constructor(table: LifecycleTable) {
    this.#table = table;
  }

  lookup(adapterId: string, adapterVersion: number): AdapterRegistration | null {
    const row = this.#table.read('ADAPTER', adapterId, adapterVersion);
    if (row === null) return null;
    const ref = validateAdapterRef(JSON.parse(row.ref) as AdapterRef);
    return ref.ok ? { adapter: ref.value, status: row.status as AdapterStatus } : null;
  }
}
