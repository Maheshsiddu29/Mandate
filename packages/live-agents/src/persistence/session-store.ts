/**
 * The durable Live AI session store — the only module in this package that
 * touches the file system (docs/demo/wallet-settlement-boundaries.md §4).
 *
 * One directory per session, created `0700`, every file `0600`:
 *
 * ```text
 * <stateDir>/sessions/<sessionId>/
 *   session.db            SQLite (WAL, synchronous = FULL): meta, events, versions, approvals,
 *                         wallet challenges, reserved executions, flags, the current draft
 *   portfolio-ledger.db   the session's portfolio ledger: @mandate/ledger-sqlite, the reference durable store
 * ```
 *
 * The ledger file is the authority. Everything in `session.db` is a record
 * of what the session did and evidence of it; a restored session re-derives
 * and re-checks it against the ledger and the frozen protocol before it can
 * matter. A schema it does not know, a record it cannot decode, or a gap in
 * the event sequence is corruption: the store throws rather than serve it.
 *
 * More than one process may hold a session: the local server and a
 * settlement command. Events take their sequence inside one `BEGIN
 * IMMEDIATE` transaction, so both append to one dense, strictly increasing
 * sequence; an event with a dedupe key is appended at most once.
 */

import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LedgerStore, ReducerRules } from '@mandate/ledger';
import { SqliteLedgerStore } from '@mandate/ledger-sqlite';
import type { LiveEvent } from '../telemetry/events.ts';
import { RecordCorruption, decodeRecord, encodeRecord } from './codec.ts';

export const SESSION_SCHEMA = 'mandate-live-session/v1';
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;

export class SessionStoreCorruption extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionStoreCorruption';
  }
}

export interface SessionMeta {
  readonly sessionId: string;
  readonly createdAt: string;
  /** Wall-clock milliseconds when the session started: restored protocol time is measured from it. */
  readonly startWallMs: number;
  /** Protocol time when the session started. */
  readonly protocolAnchor: bigint;
  readonly provider: { readonly name: string; readonly kind: string; readonly model: string };
  readonly chaos: string | null;
}

export interface VersionRow {
  readonly version: number;
  readonly mandateHex: string;
  readonly signature: string;
  readonly draft: string;
  readonly record: string;
}

function touch(path: string): void {
  closeSync(openSync(path, 'a', 0o600));
  chmodSync(path, 0o600);
}

export function sessionDir(stateDir: string, sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new SessionStoreCorruption('invalid session id');
  return join(stateDir, 'sessions', sessionId);
}

export function sessionExists(stateDir: string, sessionId: string): boolean {
  return SESSION_ID.test(sessionId) && existsSync(join(sessionDir(stateDir, sessionId), 'session.db'));
}

export class SessionStore {
  readonly dir: string;
  readonly meta: SessionMeta;
  readonly #db: DatabaseSync;
  #ledger: SqliteLedgerStore | null = null;

  private constructor(dir: string, db: DatabaseSync, meta: SessionMeta) {
    this.dir = dir;
    this.#db = db;
    this.meta = meta;
  }

  static #openDb(dir: string): DatabaseSync {
    const path = join(dir, 'session.db');
    touch(path);
    const db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS planning (planning_id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reallocations (reallocation_id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, json TEXT NOT NULL);
    `);
    return db;
  }

  /** Create a new session's directory and records. Refuses an existing session. */
  static create(stateDir: string, meta: SessionMeta): SessionStore {
    const dir = sessionDir(stateDir, meta.sessionId);
    if (existsSync(join(dir, 'session.db'))) throw new SessionStoreCorruption('session already exists');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(join(stateDir, 'sessions'), 0o700);
    chmodSync(dir, 0o700);
    const db = SessionStore.#openDb(dir);
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, json TEXT NOT NULL, dedupe TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS versions (version INTEGER PRIMARY KEY, mandate TEXT NOT NULL, signature TEXT NOT NULL, draft TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (version INTEGER PRIMARY KEY, message TEXT NOT NULL, signature TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reserved (reservation TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, json TEXT NOT NULL);
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      const put = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
      put.run('schema', SESSION_SCHEMA);
      put.run('session', encodeRecord(meta));
      put.run('flags', encodeRecord({ paused: false, reserved: false }));
      put.run('draft', 'null');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      db.close();
      throw e;
    }
    touch(join(dir, 'portfolio-ledger.db'));
    return new SessionStore(dir, db, meta);
  }

  /** Open an existing session. Unknown schema or undecodable meta fails closed. */
  static open(stateDir: string, sessionId: string): SessionStore {
    const dir = sessionDir(stateDir, sessionId);
    if (!existsSync(join(dir, 'session.db'))) throw new SessionStoreCorruption('no such session');
    const db = SessionStore.#openDb(dir);
    try {
      const schema = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value?: string } | undefined;
      if (schema?.value !== SESSION_SCHEMA) throw new SessionStoreCorruption(`unknown session schema: ${schema?.value ?? 'none'}`);
      const raw = db.prepare("SELECT value FROM meta WHERE key = 'session'").get() as { value?: string } | undefined;
      if (raw?.value === undefined) throw new SessionStoreCorruption('session meta missing');
      const meta = SessionStore.#decode<SessionMeta>(raw.value, 'meta');
      if (meta.sessionId !== sessionId) throw new SessionStoreCorruption('session meta names another session');
      return new SessionStore(dir, db, meta);
    } catch (e) {
      db.close();
      throw e;
    }
  }

  static #decode<T>(text: string, what: string): T {
    try {
      return decodeRecord<T>(text);
    } catch (e) {
      throw new SessionStoreCorruption(`${what}: ${e instanceof RecordCorruption ? e.message : 'undecodable'}`);
    }
  }

  get ledgerPath(): string {
    return join(this.dir, 'portfolio-ledger.db');
  }

  /** The session's durable portfolio ledger, opened once with the reducer rules of its first version. */
  readonly ledgerStoreOf = (rules: ReducerRules): LedgerStore => {
    this.#ledger ??= SqliteLedgerStore.open({ path: this.ledgerPath, rules });
    return this.#ledger;
  };

  // --- Events ---------------------------------------------------------------------------------

  /**
   * Append an event at the next sequence, in one write transaction shared
   * with every other process holding the session. With a dedupe key the
   * event is appended at most once; a repeat returns the first sequence.
   */
  appendEvent(e: Omit<LiveEvent, 'sequence'>, dedupe: string | null): { readonly sequence: number; readonly inserted: boolean } {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (dedupe !== null) {
        const seen = this.#db.prepare('SELECT seq FROM events WHERE dedupe = ?').get(dedupe) as { seq: number } | undefined;
        if (seen !== undefined) {
          this.#db.exec('COMMIT');
          return { sequence: Number(seen.seq), inserted: false };
        }
      }
      const last = this.#db.prepare('SELECT MAX(seq) AS seq FROM events').get() as { seq: number | null };
      const sequence = last.seq === null ? 0 : Number(last.seq) + 1;
      this.#db.prepare('INSERT INTO events (seq, kind, json, dedupe) VALUES (?, ?, ?, ?)').run(sequence, e.kind, JSON.stringify({ ...e, sequence }), dedupe);
      this.#db.exec('COMMIT');
      return { sequence, inserted: true };
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Every event after `after`, in order. A gap or a mislabelled row is corruption. */
  eventsAfter(after: number): readonly LiveEvent[] {
    const rows = this.#db.prepare('SELECT seq, json FROM events WHERE seq > ? ORDER BY seq').all(after) as { seq: number; json: string }[];
    const out: LiveEvent[] = [];
    let expected = after + 1;
    for (const r of rows) {
      const e = SessionStore.#decode<LiveEvent>(r.json, `event ${r.seq}`);
      if (Number(r.seq) !== expected || e.sequence !== expected || e.sessionId !== this.meta.sessionId) throw new SessionStoreCorruption(`event sequence broken at ${r.seq}`);
      out.push(e);
      expected += 1;
    }
    return out;
  }

  hasEvent(dedupe: string): boolean {
    return this.#db.prepare('SELECT 1 AS x FROM events WHERE dedupe = ?').get(dedupe) !== undefined;
  }

  // --- Versions, approvals, challenges ----------------------------------------------------------

  putVersion(row: VersionRow): void {
    this.#db.prepare('INSERT INTO versions (version, mandate, signature, draft, record) VALUES (?, ?, ?, ?, ?)').run(row.version, row.mandateHex, row.signature, row.draft, row.record);
  }

  putRecord(version: number, record: string): void {
    const r = this.#db.prepare('UPDATE versions SET record = ? WHERE version = ?').run(record, version);
    if (Number(r.changes) !== 1) throw new SessionStoreCorruption(`no version ${version} to update`);
  }

  versions(): readonly VersionRow[] {
    const rows = this.#db.prepare('SELECT version, mandate, signature, draft, record FROM versions ORDER BY version').all() as { version: number; mandate: string; signature: string; draft: string; record: string }[];
    return rows.map((r, i) => {
      if (Number(r.version) !== i + 1) throw new SessionStoreCorruption('version numbering broken');
      return { version: Number(r.version), mandateHex: r.mandate, signature: r.signature, draft: r.draft, record: r.record };
    });
  }

  putApproval(version: number, message: string, signature: string): void {
    this.#db.prepare('INSERT INTO approvals (version, message, signature) VALUES (?, ?, ?)').run(version, message, signature);
  }

  approvals(): readonly { readonly version: number; readonly message: string; readonly signature: string }[] {
    return (this.#db.prepare('SELECT version, message, signature FROM approvals ORDER BY version').all() as { version: number; message: string; signature: string }[]).map((r) => ({ version: Number(r.version), message: r.message, signature: r.signature }));
  }

  putChallenge(id: string, json: string): void {
    this.#db.prepare('INSERT INTO challenges (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json').run(id, json);
  }

  challenges(): readonly string[] {
    return (this.#db.prepare('SELECT json FROM challenges ORDER BY rowid').all() as { json: string }[]).map((r) => r.json);
  }

  // --- Planning and reallocation evidence -----------------------------------------------------

  putPlanning(id: string, json: string): void {
    const seen = this.#db.prepare('SELECT ordinal FROM planning WHERE planning_id = ?').get(id) as { ordinal: number } | undefined;
    if (seen === undefined) {
      const n = this.#db.prepare('SELECT COUNT(*) AS n FROM planning').get() as { n: number };
      this.#db.prepare('INSERT INTO planning (planning_id, ordinal, json) VALUES (?, ?, ?)').run(id, Number(n.n), json);
      return;
    }
    this.#db.prepare('UPDATE planning SET json = ? WHERE planning_id = ?').run(json, id);
  }

  planning(): readonly string[] {
    return (this.#db.prepare('SELECT json FROM planning ORDER BY ordinal').all() as { json: string }[]).map((r) => r.json);
  }

  putReallocation(id: string, json: string): void {
    const n = this.#db.prepare('SELECT COUNT(*) AS n FROM reallocations').get() as { n: number };
    this.#db.prepare('INSERT INTO reallocations (reallocation_id, ordinal, json) VALUES (?, ?, ?)').run(id, Number(n.n), json);
  }

  reallocations(): readonly string[] {
    return (this.#db.prepare('SELECT json FROM reallocations ORDER BY ordinal').all() as { json: string }[]).map((r) => r.json);
  }

  // --- Reserved executions, flags, draft --------------------------------------------------------

  putReserved(reservation: string, json: string): void {
    const n = this.#db.prepare('SELECT COUNT(*) AS n FROM reserved').get() as { n: number };
    this.#db.prepare('INSERT INTO reserved (reservation, ordinal, json) VALUES (?, ?, ?)').run(reservation, Number(n.n), json);
  }

  reserved(): readonly string[] {
    return (this.#db.prepare('SELECT json FROM reserved ORDER BY ordinal').all() as { json: string }[]).map((r) => r.json);
  }

  putFlags(flags: { readonly paused: boolean; readonly reserved: boolean }): void {
    this.#db.prepare("UPDATE meta SET value = ? WHERE key = 'flags'").run(encodeRecord(flags));
  }

  flags(): { readonly paused: boolean; readonly reserved: boolean } {
    const raw = this.#db.prepare("SELECT value FROM meta WHERE key = 'flags'").get() as { value?: string } | undefined;
    const f = SessionStore.#decode<{ paused?: unknown; reserved?: unknown }>(raw?.value ?? '', 'flags');
    if (typeof f.paused !== 'boolean' || typeof f.reserved !== 'boolean') throw new SessionStoreCorruption('flags');
    return { paused: f.paused, reserved: f.reserved };
  }

  putDraft(json: string): void {
    this.#db.prepare("UPDATE meta SET value = ? WHERE key = 'draft'").run(json);
  }

  draft(): string {
    const raw = this.#db.prepare("SELECT value FROM meta WHERE key = 'draft'").get() as { value?: string } | undefined;
    return raw?.value ?? 'null';
  }

  close(): void {
    this.#ledger?.close();
    this.#ledger = null;
    if (this.#db.isOpen) this.#db.close();
  }
}
