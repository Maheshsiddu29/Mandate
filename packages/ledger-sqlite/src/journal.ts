/**
 * The issuance journal: what happened to an admitted attempt's artifact
 * *after* `ADMIT_ATTEMPT` (Phase 7E.1; attempt-lifecycle.md §2).
 *
 * The ledger's `ADMIT_ATTEMPT` is the authority fact: it is committed before
 * any key is used, and it alone forbids `NEVER_ISSUED`. The journal records
 * the issuance facts that follow — the artifact was issued (and its bytes,
 * kept inside the signer's boundary), a submission was sent, acknowledged,
 * rejected, or its outcome is unknown. None of these moves authority, and
 * none is evidence of an economic outcome: that is 7F's reconciliation.
 *
 * It lives in the **same SQLite database** as the ledger, and a row can only
 * be created for an attempt the ledger has admitted — checked inside the
 * journal's own transaction against the committed ledger — so there is no
 * second, independent attempt database whose view could diverge from the
 * authority ledger's.
 *
 * Transitions are monotone and closed:
 *
 * ```text
 * (admitted) ──issued──▶ ARTIFACT_ISSUED ──sent──▶ SUBMISSION_SENT ──▶ SUBMISSION_ACKNOWLEDGED
 *     │                        │                          ├──▶ SUBMISSION_REJECTED
 *     │                        │                          └──▶ OUTCOME_UNKNOWN
 *     └──────── recovery ──────┴──────── recovery ──────────▶ OUTCOME_UNKNOWN
 * ```
 *
 * `OUTCOME_UNKNOWN` has no way out here: an unknown outcome is resolved by
 * venue evidence (7F), never by a timeout and never by issuing again. There is
 * no transition back to `SUBMISSION_SENT` — not even with the same bytes —
 * because resubmission safety depends on venue nonce semantics that are not
 * yet evidenced (testnet-evidence.md).
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { PrincipalId } from '@mandate/core';
import { principalKey, type AttemptId } from '@mandate/ledger';
import { blobColumn, intColumn, textColumn, type SqlRow, type SqliteLedgerStore } from './store.ts';

export type IssuanceState = 'ARTIFACT_ISSUED' | 'SUBMISSION_SENT' | 'SUBMISSION_ACKNOWLEDGED' | 'SUBMISSION_REJECTED' | 'OUTCOME_UNKNOWN';

const NEXT: { readonly [S in IssuanceState]: readonly IssuanceState[] } = {
  ARTIFACT_ISSUED: ['SUBMISSION_SENT', 'OUTCOME_UNKNOWN'],
  SUBMISSION_SENT: ['SUBMISSION_ACKNOWLEDGED', 'SUBMISSION_REJECTED', 'OUTCOME_UNKNOWN'],
  SUBMISSION_ACKNOWLEDGED: [],
  SUBMISSION_REJECTED: [],
  OUTCOME_UNKNOWN: [],
};

const STATES: readonly IssuanceState[] = ['ARTIFACT_ISSUED', 'SUBMISSION_SENT', 'SUBMISSION_ACKNOWLEDGED', 'SUBMISSION_REJECTED', 'OUTCOME_UNKNOWN'];

export interface IssuanceRecord {
  readonly attempt: AttemptId;
  readonly state: IssuanceState;
  /** The artifact bytes, kept inside the signer's boundary; `null` if the artifact was never recorded (recovery). */
  readonly artifact: Uint8Array | null;
  /** The venue's reference once known (e.g. the transaction hash it acknowledged). */
  readonly venueRef: string | null;
  /** A short machine-readable note on the last transition. */
  readonly detail: string;
  /** How many transitions this attempt has had. */
  readonly seq: bigint;
}

export type JournalResult =
  | { readonly ok: true; readonly record: IssuanceRecord }
  | { readonly ok: false; readonly reason: 'ATTEMPT_NOT_ADMITTED' | 'ALREADY_RECORDED' | 'NOT_RECORDED' | 'TRANSITION_FORBIDDEN' };

export class IssuanceJournal {
  readonly #store: SqliteLedgerStore;
  readonly #db: DatabaseSync;
  readonly #get: StatementSync;
  readonly #insert: StatementSync;
  readonly #update: StatementSync;
  readonly #event: StatementSync;
  readonly #all: StatementSync;

  constructor(store: SqliteLedgerStore) {
    this.#store = store;
    this.#db = store.database;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS issuance_journal (
        attempt TEXT PRIMARY KEY,
        principal TEXT NOT NULL,
        state TEXT NOT NULL,
        artifact BLOB,
        venue_ref TEXT,
        detail TEXT NOT NULL,
        seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS issuance_events (
        attempt TEXT NOT NULL,
        seq INTEGER NOT NULL,
        state TEXT NOT NULL,
        detail TEXT NOT NULL,
        PRIMARY KEY (attempt, seq)
      ) WITHOUT ROWID;
    `);
    this.#get = this.#db.prepare('SELECT attempt, state, artifact, venue_ref, detail, seq FROM issuance_journal WHERE attempt = ?');
    this.#get.setReadBigInts(true);
    this.#insert = this.#db.prepare('INSERT INTO issuance_journal (attempt, principal, state, artifact, venue_ref, detail, seq) VALUES (?, ?, ?, ?, NULL, ?, 1)');
    this.#update = this.#db.prepare('UPDATE issuance_journal SET state = ?, venue_ref = COALESCE(?, venue_ref), detail = ?, seq = seq + 1 WHERE attempt = ?');
    this.#event = this.#db.prepare('INSERT INTO issuance_events (attempt, seq, state, detail) VALUES (?, ?, ?, ?)');
    this.#all = this.#db.prepare('SELECT attempt, state, artifact, venue_ref, detail, seq FROM issuance_journal WHERE principal = ? ORDER BY attempt');
    this.#all.setReadBigInts(true);
  }

  get(attempt: AttemptId): IssuanceRecord | null {
    const row = this.#get.get(attempt) as SqlRow | undefined;
    return row === undefined ? null : recordOf(row);
  }

  /** Every journal record of a principal, in attempt-id order. */
  list(principal: PrincipalId): readonly IssuanceRecord[] {
    return (this.#all.all(principalKey(principal)) as SqlRow[]).map(recordOf);
  }

  /**
   * First record for an admitted attempt: `ARTIFACT_ISSUED` with its bytes,
   * or `OUTCOME_UNKNOWN` without (recovery found an admitted attempt with no
   * record). Refused unless the committed ledger holds the attempt.
   */
  open(principal: PrincipalId, attempt: AttemptId, state: 'ARTIFACT_ISSUED' | 'OUTCOME_UNKNOWN', artifact: Uint8Array | null, detail: string): JournalResult {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      // Inside the write lock and without yielding: folds every committed batch, including
      // another process's, and nothing can commit between this check and the insert.
      const committed = this.#store.readCommitted(principal);
      if (!committed.state.attempts.has(attempt)) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'ATTEMPT_NOT_ADMITTED' };
      }
      if (this.#get.get(attempt) !== undefined) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'ALREADY_RECORDED' };
      }
      this.#insert.run(attempt, principalKey(principal), state, artifact, detail);
      this.#event.run(attempt, 1n, state, detail);
      this.#db.exec('COMMIT');
    } catch (e) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw e;
    }
    return { ok: true, record: this.get(attempt) as IssuanceRecord };
  }

  /** Move an attempt's issuance forward along the closed transition table. */
  transition(attempt: AttemptId, to: IssuanceState, detail: string, venueRef: string | null = null): JournalResult {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#get.get(attempt) as SqlRow | undefined;
      if (row === undefined) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'NOT_RECORDED' };
      }
      const current = recordOf(row);
      if (!NEXT[current.state].includes(to)) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'TRANSITION_FORBIDDEN' };
      }
      this.#update.run(to, venueRef, detail, attempt);
      this.#event.run(attempt, current.seq + 1n, to, detail);
      this.#db.exec('COMMIT');
    } catch (e) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw e;
    }
    return { ok: true, record: this.get(attempt) as IssuanceRecord };
  }
}

function recordOf(row: SqlRow): IssuanceRecord {
  const state = textColumn(row, 'state');
  const known = STATES.find((s) => s === state);
  if (known === undefined) throw new Error(`issuance journal holds an unknown state ${state}`);
  const artifact = row['artifact'] === null ? null : blobColumn(row, 'artifact');
  const venueRef = row['venue_ref'] === null ? null : textColumn(row, 'venue_ref');
  return { attempt: textColumn(row, 'attempt') as AttemptId, state: known, artifact, venueRef, detail: textColumn(row, 'detail'), seq: intColumn(row, 'seq') };
}
