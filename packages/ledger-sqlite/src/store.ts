/**
 * The SQLite ledger store — **REFERENCE / SINGLE-NODE TESTNET STORE**, not a
 * horizontally scalable production deployment (ADR 0023; Phase 7E.1 F-3).
 *
 * Why it exists now: once an execution artifact can exist, the ledger's
 * `ADMIT_ATTEMPT` must survive a crash, or `NEVER_ISSUED` could be concluded
 * about an artifact that was in fact signed. The in-memory store cannot give
 * that. This store gives the four properties of the store contract with real
 * durability on one machine:
 *
 * 1. **Consistent read.** A read returns one committed version: version, head
 *    and the state folded from exactly the batches up to it.
 * 2. **Compare-and-append.** A commit runs inside one `BEGIN IMMEDIATE`
 *    transaction: read the committed head, compare version and head, apply
 *    the pure reducer to the whole batch, insert the batch and advance the
 *    head, `COMMIT`. Any other outcome rolls back and writes nothing.
 * 3. **Atomic batches.** A batch is one row and one head update in one
 *    transaction; SQLite's WAL makes the commit all-or-nothing across a crash,
 *    and `synchronous = FULL` makes a returned `COMMITTED` durable.
 * 4. **One linearization domain per principal.** The head row is per
 *    principal; the transaction takes SQLite's database write lock, which
 *    also serializes writers from other processes on the same file
 *    (`busy_timeout` bounds the wait).
 *
 * **The log is authoritative; the state is re-derived.** What is stored is
 * each batch's canonical encoding. The folded state is a per-process cache,
 * rebuilt by decoding and re-applying every batch the cache has not seen —
 * checking each extends the previous head, carries the next version and
 * re-encodes byte for byte — so a restarted process, or a second process on
 * the same file, derives exactly the committed state (LEDGER-6). A stored
 * history that fails that check is corrupt, and the store throws rather than
 * serve it.
 *
 * Crash points can be injected with `fault(point)` (it may throw, or kill the
 * process); a thrown fault before `COMMIT` rolls back, and one after it
 * reaches the caller with the batch already durable — exactly the "committed
 * but the caller never heard" case a client must recover from by re-reading.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { LedgerHeadDigest, LedgerVersion, PrincipalId } from '@mandate/core';
import {
  applyBatch,
  batchHead,
  CORE_RULES,
  decodeBatch,
  emptyLedgerState,
  principalKey,
  type CommitResult,
  type CommittedBatch,
  type LedgerEvent,
  type LedgerSnapshot,
  type LedgerState,
  type LedgerStore,
  type ReducerRules,
} from '@mandate/ledger';

export const SQLITE_STORE_SCHEMA = 'mandate-ledger-sqlite/v1';

export type SqliteFaultPoint = 'BEFORE_BEGIN' | 'AFTER_VERSION_CHECK' | 'AFTER_INSERT' | 'BEFORE_COMMIT' | 'AFTER_COMMIT';

export interface SqliteStoreOptions {
  /** A file path. `:memory:` is refused: this store exists to be durable. */
  readonly path: string;
  /** The reducer rules applied at commit and at every re-derivation; fixed for the store's life. */
  readonly rules?: ReducerRules;
  /** Test hook: called at each named point of a commit. May throw, or end the process. */
  readonly fault?: (point: SqliteFaultPoint, principal: PrincipalId) => void;
  /** Milliseconds a writer waits for another process's write lock. Default 5,000. */
  readonly busyTimeoutMs?: number;
}

/** A stored history that does not re-derive: the store refuses to serve it. */
export class LedgerStoreCorruption extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerStoreCorruption';
  }
}

interface Cached {
  state: LedgerState;
  readonly batches: CommittedBatch[];
}

interface HeadRow {
  readonly version: bigint;
  readonly head: string;
}

interface BatchRow {
  readonly version: bigint;
  readonly previousHead: string;
  readonly head: string;
  readonly encoded: Uint8Array;
}

/** One column of a row SQLite returned, checked for the type the schema declares. */
export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlRow = { readonly [column: string]: SqlValue };

export function intColumn(row: SqlRow, column: string): bigint {
  const v = row[column];
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  throw new LedgerStoreCorruption(`column ${column} is not an integer`);
}

export function textColumn(row: SqlRow, column: string): string {
  const v = row[column];
  if (typeof v !== 'string') throw new LedgerStoreCorruption(`column ${column} is not text`);
  return v;
}

export function blobColumn(row: SqlRow, column: string): Uint8Array {
  const v = row[column];
  if (!(v instanceof Uint8Array)) throw new LedgerStoreCorruption(`column ${column} is not a blob`);
  return v;
}

function headRow(row: SqlRow | undefined): HeadRow | undefined {
  return row === undefined ? undefined : { version: intColumn(row, 'version'), head: textColumn(row, 'head') };
}

function batchRow(row: SqlRow): BatchRow {
  return { version: intColumn(row, 'version'), previousHead: textColumn(row, 'previous_head'), head: textColumn(row, 'head'), encoded: blobColumn(row, 'encoded') };
}

export class SqliteLedgerStore implements LedgerStore {
  readonly #db: DatabaseSync;
  readonly #rules: ReducerRules;
  readonly #fault: SqliteStoreOptions['fault'];
  readonly #cache = new Map<string, Cached>();
  readonly #headOf: StatementSync;
  readonly #batchesAfter: StatementSync;
  readonly #insertBatch: StatementSync;
  readonly #upsertHead: StatementSync;
  #closed = false;

  private constructor(db: DatabaseSync, o: SqliteStoreOptions) {
    this.#db = db;
    this.#rules = o.rules ?? CORE_RULES;
    this.#fault = o.fault;
    this.#headOf = db.prepare('SELECT version, head FROM ledger_heads WHERE principal = ?');
    this.#headOf.setReadBigInts(true);
    this.#batchesAfter = db.prepare('SELECT version, previous_head, head, encoded FROM ledger_batches WHERE principal = ? AND version > ? ORDER BY version');
    this.#batchesAfter.setReadBigInts(true);
    this.#insertBatch = db.prepare('INSERT INTO ledger_batches (principal, version, previous_head, head, encoded) VALUES (?, ?, ?, ?, ?)');
    this.#upsertHead = db.prepare('INSERT INTO ledger_heads (principal, version, head) VALUES (?, ?, ?) ON CONFLICT(principal) DO UPDATE SET version = excluded.version, head = excluded.head');
  }

  /** Open (creating if absent) the store at `o.path`. */
  static open(o: SqliteStoreOptions): SqliteLedgerStore {
    if (o.path === '' || o.path === ':memory:') throw new Error('SqliteLedgerStore requires a file path: it exists to be durable');
    const db = new DatabaseSync(o.path);
    db.exec(`PRAGMA busy_timeout = ${Math.trunc(o.busyTimeoutMs ?? 5_000)}`);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger_heads (principal TEXT PRIMARY KEY, version INTEGER NOT NULL, head TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger_batches (
        principal TEXT NOT NULL,
        version INTEGER NOT NULL,
        previous_head TEXT NOT NULL,
        head TEXT NOT NULL,
        encoded BLOB NOT NULL,
        PRIMARY KEY (principal, version)
      ) WITHOUT ROWID;
    `);
    db.prepare('INSERT OR IGNORE INTO store_meta (key, value) VALUES (?, ?)').run('schema', SQLITE_STORE_SCHEMA);
    const schema = db.prepare('SELECT value FROM store_meta WHERE key = ?').get('schema') as SqlRow | undefined;
    if (schema === undefined || schema['value'] !== SQLITE_STORE_SCHEMA) {
      db.close();
      throw new LedgerStoreCorruption('unsupported store schema');
    }
    return new SqliteLedgerStore(db, o);
  }

  /** The database handle, for components that must share this store's transactional boundary (journal.ts). */
  get database(): DatabaseSync {
    return this.#db;
  }

  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#db.close();
    }
  }

  #cached(key: string, principal: PrincipalId): Cached {
    let c = this.#cache.get(key);
    if (c === undefined) {
      c = { state: emptyLedgerState(principal), batches: [] };
      this.#cache.set(key, c);
    }
    return c;
  }

  /**
   * Bring the cache up to the committed head by re-deriving every batch it
   * has not seen. Called inside the commit transaction and on every read, so
   * batches committed by another process are always folded before use.
   */
  #refresh(key: string, principal: PrincipalId): Cached {
    const c = this.#cached(key, principal);
    const row = headRow(this.#headOf.get(key) as SqlRow | undefined);
    const version = row?.version ?? 0n;
    if (version === c.state.version && (row === undefined || row.head === c.state.head)) return c;
    if (version < c.state.version) throw new LedgerStoreCorruption(`ledger head for ${key} regressed from ${c.state.version} to ${version}`);
    const rows = (this.#batchesAfter.all(key, c.state.version) as SqlRow[]).map(batchRow);
    let state = c.state;
    const added: CommittedBatch[] = [];
    for (const r of rows) {
      const decoded = decodeBatch(r.encoded);
      if (!decoded.ok) throw new LedgerStoreCorruption(`batch ${r.version} of ${key} does not decode: ${decoded.error.code}`);
      const b = decoded.value;
      if (b.version !== state.version + 1n || r.version !== b.version || b.previousHead !== state.head || r.previousHead !== state.head || principalKey(b.principal) !== key) {
        throw new LedgerStoreCorruption(`batch ${r.version} of ${key} does not extend version ${state.version}`);
      }
      const applied = applyBatch(state, b.events, this.#rules);
      if (!applied.ok) throw new LedgerStoreCorruption(`batch ${r.version} of ${key} does not re-apply: ${applied.error.code} at ${applied.error.path}`);
      if (!sameBytes(applied.value.encoded, r.encoded) || applied.value.state.head !== r.head || batchHead(r.encoded) !== r.head) {
        throw new LedgerStoreCorruption(`batch ${r.version} of ${key} does not re-encode to its stored bytes`);
      }
      added.push({ version: applied.value.state.version, previousHead: state.head, head: applied.value.state.head, events: b.events, encoded: new Uint8Array(r.encoded) });
      state = applied.value.state;
    }
    if (state.version !== version || (row !== undefined && state.head !== row.head)) throw new LedgerStoreCorruption(`ledger head for ${key} is not the fold of its batches`);
    c.state = state;
    c.batches.push(...added);
    return c;
  }

  async read(principal: PrincipalId): Promise<LedgerSnapshot> {
    return this.readCommitted(principal);
  }

  /**
   * The committed snapshot, synchronously: for a component sharing this
   * connection that must check ledger state inside its own transaction
   * without yielding (journal.ts). Nothing can interleave with it.
   */
  readCommitted(principal: PrincipalId): LedgerSnapshot {
    const c = this.#refresh(principalKey(principal), principal);
    return { principal, version: c.state.version, head: c.state.head, state: c.state };
  }

  async compareAndAppend(principal: PrincipalId, expectedVersion: LedgerVersion, expectedHead: LedgerHeadDigest, events: readonly LedgerEvent[]): Promise<CommitResult> {
    const key = principalKey(principal);
    const fault = this.#fault;
    fault?.('BEFORE_BEGIN', principal);
    // --- one synchronous transaction from here to COMMIT ---
    this.#db.exec('BEGIN IMMEDIATE');
    let result: CommitResult;
    let next: { state: LedgerState; batch: CommittedBatch } | null = null;
    try {
      const c = this.#refresh(key, principal);
      const current = c.state;
      if (current.version !== expectedVersion || current.head !== expectedHead) {
        this.#db.exec('ROLLBACK');
        return { status: 'CONFLICT', reason: current.version !== expectedVersion ? 'VERSION_CONFLICT' : 'HEAD_MISMATCH', version: current.version, head: current.head };
      }
      fault?.('AFTER_VERSION_CHECK', principal);
      const applied = applyBatch(current, events, this.#rules);
      if (!applied.ok) {
        this.#db.exec('ROLLBACK');
        return { status: 'REFUSED', refusal: applied.error };
      }
      const state = applied.value.state;
      this.#insertBatch.run(key, state.version, current.head, state.head, applied.value.encoded);
      this.#upsertHead.run(key, state.version, state.head);
      fault?.('AFTER_INSERT', principal);
      fault?.('BEFORE_COMMIT', principal);
      this.#db.exec('COMMIT');
      next = { state, batch: { version: state.version, previousHead: current.head, head: state.head, events: [...events], encoded: applied.value.encoded } };
      result = { status: 'COMMITTED', snapshot: { principal, version: state.version, head: state.head, state } };
    } catch (e) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      // The cache may have been refreshed inside the rolled-back transaction; a
      // refresh only ever folds committed rows, so it is still exactly committed state.
      throw e;
    }
    const c = this.#cached(key, principal);
    c.state = next.state;
    c.batches.push(next.batch);
    // After COMMIT: the batch is durable whatever happens to this call now.
    fault?.('AFTER_COMMIT', principal);
    return result;
  }

  async history(principal: PrincipalId): Promise<readonly CommittedBatch[]> {
    return [...this.#refresh(principalKey(principal), principal).batches];
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
