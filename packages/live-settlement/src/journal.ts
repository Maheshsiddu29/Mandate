/**
 * The settlement journal: the durable lifecycle of each settlement attempt
 * (docs/demo/wallet-settlement-boundaries.md §5). It is the only module in
 * this package that opens a file of its own.
 *
 * **It has no authority.** The portfolio ledger decides whether a
 * reservation may be attempted (its `ADMIT_ATTEMPT`, one per reservation),
 * consumed or released; the gate decides whether a gate mandate executes
 * (`_executions[mandateDigest]`). The journal records what this process did
 * and saw, write-ahead, so a restart knows exactly which attempt may have
 * reached the network and never has to guess.
 *
 * ```text
 * PREPARED ──▶ SUBMISSION_STARTED ──▶ SUBMITTED ──▶ CONFIRMED_SUCCESS ──▶ SETTLED ──▶ CONSUMED
 *    │                 │                  │      └─▶ CONFIRMED_REVERT ──────────────▶ RELEASED
 *    │                 └──────────────────┴──▶ RECONCILIATION_REQUIRED (ambiguous: resolved by evidence only)
 *    ├──▶ PREPARATION_FAILED   (nothing signed for broadcast, no gate artifact left the process)
 *    └──▶ RELEASED             (a send leg opened, then died before its hash was journaled: released only once every artifact is dead)
 * CONFIRMED_SUCCESS ──▶ RECONCILIATION_REQUIRED (POSTCONDITION_ANOMALY: quarantined, never released, never resent)
 * ```
 *
 * Every write is one `BEGIN IMMEDIATE` transaction on a WAL database with
 * `synchronous = FULL`: when a method returns, the fact is on disk. Every
 * gate artifact is journaled before it leaves the process (an `eth_call`
 * carries it to the RPC node), and a transaction's hash and envelope before
 * it is broadcast. Transitions are monotone and closed; a terminal state has
 * no way out.
 */

import { chmodSync, closeSync, existsSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const JOURNAL_SCHEMA = 'mandate-live-settlement-journal/v1';

export const ATTEMPT_STATES = ['PREPARED', 'SUBMISSION_STARTED', 'SUBMITTED', 'CONFIRMED_SUCCESS', 'CONFIRMED_REVERT', 'RECONCILIATION_REQUIRED', 'SETTLED', 'CONSUMED', 'RELEASED', 'PREPARATION_FAILED'] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

/** Why an attempt is in RECONCILIATION_REQUIRED. The first three resolve on evidence; the last two are quarantine. */
export const QUARANTINES = ['AMBIGUOUS_BROADCAST', 'BROADCAST_REJECTED', 'AWAITING_DEADLINE', 'POSTCONDITION_ANOMALY', 'EXECUTED_OUTSIDE_ATTEMPT'] as const;
export type Quarantine = (typeof QUARANTINES)[number];
export const TERMINAL_QUARANTINES: readonly Quarantine[] = ['POSTCONDITION_ANOMALY', 'EXECUTED_OUTSIDE_ATTEMPT'];

const NEXT: { readonly [S in AttemptState]: readonly AttemptState[] } = {
  PREPARED: ['SUBMISSION_STARTED', 'PREPARATION_FAILED', 'RELEASED', 'RECONCILIATION_REQUIRED'],
  SUBMISSION_STARTED: ['SUBMITTED', 'RECONCILIATION_REQUIRED', 'CONFIRMED_SUCCESS', 'CONFIRMED_REVERT', 'RELEASED'],
  SUBMITTED: ['CONFIRMED_SUCCESS', 'CONFIRMED_REVERT', 'RECONCILIATION_REQUIRED', 'RELEASED'],
  RECONCILIATION_REQUIRED: ['SUBMITTED', 'CONFIRMED_SUCCESS', 'CONFIRMED_REVERT', 'RELEASED'],
  CONFIRMED_SUCCESS: ['SETTLED', 'RECONCILIATION_REQUIRED'],
  CONFIRMED_REVERT: ['RELEASED'],
  SETTLED: ['CONSUMED'],
  CONSUMED: [],
  RELEASED: [],
  PREPARATION_FAILED: [],
};

export function isTerminal(a: AttemptRecord): boolean {
  if (a.state === 'RECONCILIATION_REQUIRED') return a.quarantine !== null && TERMINAL_QUARANTINES.includes(a.quarantine);
  return NEXT[a.state].length === 0;
}

/** What one attempt is bound to; every field must match on resume. */
export interface AttemptBinding {
  readonly reservation: string;
  readonly session: string;
  readonly proposal: string;
  readonly candidate: string;
  readonly child: string;
  readonly action: string;
  readonly agent: string;
  readonly version: number;
  /** The portfolio principal as authorized: the wallet, or the demonstration key. */
  readonly principal: string;
  readonly authorizationMethod: string;
  readonly chainId: string;
  readonly gate: string;
  /** The settlement binding digest: the fixture settlement derived from exactly this execution. */
  readonly binding: string;
  readonly evidenceClass: string;
}

/** The signed transaction, described: everything but the raw bytes, which are never persisted. */
export interface TxEnvelope {
  readonly hash: string;
  readonly from: string;
  readonly to: string;
  readonly nonce: string;
  readonly calldataDigest: string;
  readonly value: string;
  readonly gasLimit: string;
  readonly maxFeePerGas: string;
  readonly maxPriorityFeePerGas: string;
}

/** A gate artifact that left the process (an `eth_call` carries it to the RPC node): dead after `deadline`. */
export interface ArtifactRecord {
  readonly reservation: string;
  readonly mandateDigest: string;
  readonly commitment: string;
  /** Chain time after which the gate refuses it forever. */
  readonly deadline: string;
  readonly mode: 'DRY_RUN' | 'SEND';
}

/** Public V3 proof facts persisted before submission; never calldata, a signature or a key. */
export interface V3ProofRecord {
  readonly candidateId: string;
  readonly initialAllocationDigest: string;
  readonly delegationDigest: string;
  readonly mandateDigest: string;
  readonly candidateDigest: string;
  readonly executionApprovalDigest: string;
  readonly executionCommitment: string;
  readonly delegate: string;
  readonly agent: string;
  readonly executionNonce: string;
  readonly initialCapacity: string;
  readonly cumulativeDebit: string;
  readonly remainingCapacity: string;
  readonly capacityUnit: string;
  readonly capacityDecimals: number;
  readonly gasEstimate: string;
}

export interface AttemptRecord extends AttemptBinding {
  readonly state: AttemptState;
  readonly quarantine: Quarantine | null;
  /** Chain time the send leg was opened; null until then (a dry run opens none). */
  readonly domainOpenedAt: string | null;
  /** Chain time after which no artifact the send leg could have signed is valid. */
  readonly artifactDeadAfter: string | null;
  readonly tx: TxEnvelope | null;
  /** Gate mandate digest, commitment and deadline of the send artifact. */
  readonly sendArtifact: { readonly mandateDigest: string; readonly commitment: string; readonly deadline: string } | null;
  /** Balances immediately before the broadcast (decimal text). */
  readonly before: { readonly block: string; readonly tokenIn: string; readonly tokenOut: string; readonly agentTokenOut: string } | null;
  readonly receipt: { readonly status: string; readonly blockNumber: string; readonly blockHash: string; readonly gasUsed: string; readonly effectiveGasPrice: string } | null;
  readonly postconditions: { readonly ok: boolean; readonly failures: readonly string[] } | null;
  /** The observation the portfolio ledger's CONSUME or CLOSE names. */
  readonly observation: string | null;
  /** V3-only proof facts. Old and V2 records normalize to null when read. */
  readonly v3Proof: V3ProofRecord | null;
  readonly detail: string;
  readonly revision: number;
}

export class JournalRefusal extends Error {
  readonly code: 'BINDING_MISMATCH' | 'TRANSITION_FORBIDDEN' | 'NOT_RECORDED' | 'ALREADY_BOUND' | 'CORRUPT';
  constructor(code: JournalRefusal['code'], message: string) {
    super(message);
    this.name = 'JournalRefusal';
    this.code = code;
  }
}

const BINDING_FIELDS: readonly (keyof AttemptBinding)[] = ['reservation', 'session', 'proposal', 'candidate', 'child', 'action', 'agent', 'version', 'principal', 'authorizationMethod', 'chainId', 'gate', 'binding', 'evidenceClass'];

type Row = { [k: string]: string | number | null };

export class SettlementJournal {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Open (creating `0600` if absent) the journal at `path`. An unknown schema fails closed. */
  static open(path: string): SettlementJournal {
    const fresh = !existsSync(path);
    closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
    const db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (reservation TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts (mandate_digest TEXT PRIMARY KEY, reservation TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transitions (seq INTEGER PRIMARY KEY AUTOINCREMENT, reservation TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL, detail TEXT NOT NULL);
    `);
    if (fresh) db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema', ?)").run(JOURNAL_SCHEMA);
    const schema = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value?: string } | undefined;
    if (schema?.value !== JOURNAL_SCHEMA) {
      db.close();
      throw new JournalRefusal('CORRUPT', `unknown settlement journal schema: ${schema?.value ?? 'none'}`);
    }
    return new SettlementJournal(db);
  }

  #tx<T>(f: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const out = f();
      this.#db.exec('COMMIT');
      return out;
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
  }

  #read(reservation: string): AttemptRecord | null {
    const row = this.#db.prepare('SELECT json FROM attempts WHERE reservation = ?').get(reservation) as Row | undefined;
    if (row === undefined) return null;
    let a: AttemptRecord;
    try {
      const parsed = JSON.parse(String(row['json'])) as AttemptRecord;
      a = { ...parsed, v3Proof: parsed.v3Proof ?? null };
    } catch {
      throw new JournalRefusal('CORRUPT', `attempt ${reservation} is not JSON`);
    }
    if (a.reservation !== reservation || !(ATTEMPT_STATES as readonly string[]).includes(a.state)) throw new JournalRefusal('CORRUPT', `attempt ${reservation} is malformed`);
    return a;
  }

  #write(a: AttemptRecord, from: AttemptState | null, detail: string): void {
    this.#db.prepare('INSERT INTO attempts (reservation, json) VALUES (?, ?) ON CONFLICT(reservation) DO UPDATE SET json = excluded.json').run(a.reservation, JSON.stringify(a));
    this.#db.prepare('INSERT INTO transitions (reservation, from_state, to_state, detail) VALUES (?, ?, ?, ?)').run(a.reservation, from, a.state, detail.slice(0, 240));
  }

  get(reservation: string): AttemptRecord | null {
    return this.#read(reservation);
  }

  all(): readonly AttemptRecord[] {
    return (this.#db.prepare('SELECT reservation FROM attempts ORDER BY rowid').all() as Row[]).map((r) => this.#read(String(r['reservation'])) as AttemptRecord);
  }

  /** Every attempt that is not terminal: what a restart must reconcile. */
  open(): readonly AttemptRecord[] {
    return this.all().filter((a) => !isTerminal(a));
  }

  /**
   * The attempt for `b.reservation`: created PREPARED, or the existing one if
   * it is bound to exactly the same execution. One reservation never has two
   * attempts; a different binding for it is refused.
   */
  prepare(b: AttemptBinding): { readonly record: AttemptRecord; readonly created: boolean } {
    return this.#tx(() => {
      const existing = this.#read(b.reservation);
      if (existing !== null) {
        for (const f of BINDING_FIELDS) if (existing[f] !== b[f]) throw new JournalRefusal('BINDING_MISMATCH', `the reservation's attempt is bound to another ${f}`);
        return { record: existing, created: false };
      }
      const a: AttemptRecord = { ...b, state: 'PREPARED', quarantine: null, domainOpenedAt: null, artifactDeadAfter: null, tx: null, sendArtifact: null, before: null, receipt: null, postconditions: null, observation: null, v3Proof: null, detail: 'prepared', revision: 1 };
      this.#write(a, null, 'prepared');
      return { record: a, created: true };
    });
  }

  /** Persist the exact public V3 proof before any transaction can be submitted. */
  recordV3Proof(reservation: string, proof: V3ProofRecord): AttemptRecord {
    return this.#tx(() => {
      const a = this.#read(reservation);
      if (a === null) throw new JournalRefusal('NOT_RECORDED', `no attempt for ${reservation}`);
      if (a.state !== 'PREPARED') throw new JournalRefusal('TRANSITION_FORBIDDEN', `${a.state} cannot accept V3 proof`);
      if (a.v3Proof !== null) {
        if (JSON.stringify(a.v3Proof) !== JSON.stringify(proof)) throw new JournalRefusal('BINDING_MISMATCH', 'the attempt is bound to different V3 proof');
        return a;
      }
      const next = { ...a, v3Proof: proof, revision: a.revision + 1, detail: 'V3 technical proof journaled' };
      this.#write(next, a.state, next.detail);
      return next;
    });
  }

  #update(reservation: string, f: (a: AttemptRecord) => AttemptRecord, detail: string): AttemptRecord {
    return this.#tx(() => {
      const a = this.#read(reservation);
      if (a === null) throw new JournalRefusal('NOT_RECORDED', `no attempt for ${reservation}`);
      if (isTerminal(a)) throw new JournalRefusal('TRANSITION_FORBIDDEN', `${a.state}${a.quarantine === null ? '' : ` (${a.quarantine})`} is terminal`);
      const next = { ...f(a), revision: a.revision + 1, detail };
      if (next.state !== a.state && !NEXT[a.state].includes(next.state)) throw new JournalRefusal('TRANSITION_FORBIDDEN', `${a.state} → ${next.state}`);
      this.#write(next, a.state, detail);
      return next;
    });
  }

  /** Before the send leg exists: from now on an artifact may exist, and this attempt never sends again from PREPARED. */
  bindDomain(reservation: string, openedAt: bigint, deadAfter: bigint): AttemptRecord {
    return this.#update(
      reservation,
      (a) => {
        if (a.state !== 'PREPARED' || a.domainOpenedAt !== null) throw new JournalRefusal('ALREADY_BOUND', 'the send leg was already opened for this attempt');
        return { ...a, domainOpenedAt: openedAt.toString(), artifactDeadAfter: deadAfter.toString() };
      },
      'send leg opening',
    );
  }

  /** Before an artifact leaves the process. Idempotent for the same artifact. */
  recordArtifact(x: ArtifactRecord): void {
    this.#tx(() => {
      const seen = this.#db.prepare('SELECT json FROM artifacts WHERE mandate_digest = ?').get(x.mandateDigest) as Row | undefined;
      if (seen !== undefined) return;
      this.#db.prepare('INSERT INTO artifacts (mandate_digest, reservation, json) VALUES (?, ?, ?)').run(x.mandateDigest, x.reservation, JSON.stringify(x));
      if (x.mode === 'SEND') {
        const a = this.#read(x.reservation);
        if (a !== null && a.sendArtifact === null) this.#write({ ...a, sendArtifact: { mandateDigest: x.mandateDigest, commitment: x.commitment, deadline: x.deadline }, revision: a.revision + 1, detail: 'send artifact journaled' }, a.state, 'send artifact journaled');
      }
    });
  }

  /** Every gate artifact that ever left the process for `reservation`, dry runs included. */
  artifacts(reservation: string): readonly ArtifactRecord[] {
    return (this.#db.prepare('SELECT json FROM artifacts WHERE reservation = ? ORDER BY rowid').all(reservation) as Row[]).map((r) => JSON.parse(String(r['json'])) as ArtifactRecord);
  }

  /** Write-ahead: the signed transaction's hash and envelope, before the one broadcast. */
  startSubmission(reservation: string, tx: TxEnvelope, before: NonNullable<AttemptRecord['before']>): AttemptRecord {
    return this.#update(reservation, (a) => ({ ...a, state: 'SUBMISSION_STARTED', tx, before }), `signed ${tx.hash}; broadcasting once`);
  }

  transition(reservation: string, to: AttemptState, patch: Partial<Pick<AttemptRecord, 'quarantine' | 'receipt' | 'postconditions' | 'observation'>> = {}, detail: string = to): AttemptRecord {
    return this.#update(reservation, (a) => ({ ...a, ...patch, state: to, quarantine: to === 'RECONCILIATION_REQUIRED' ? (patch.quarantine ?? a.quarantine ?? 'AMBIGUOUS_BROADCAST') : null }), detail);
  }

  /** Stay in RECONCILIATION_REQUIRED with a different reason (not a state change). */
  requarantine(reservation: string, q: Quarantine, detail: string): AttemptRecord {
    return this.#update(
      reservation,
      (a) => {
        if (a.state !== 'RECONCILIATION_REQUIRED' || (a.quarantine !== null && TERMINAL_QUARANTINES.includes(a.quarantine))) throw new JournalRefusal('TRANSITION_FORBIDDEN', 'only an open reconciliation may change its reason');
        return { ...a, quarantine: q };
      },
      detail,
    );
  }

  transitions(reservation: string): readonly { readonly from: string | null; readonly to: string; readonly detail: string }[] {
    return (this.#db.prepare('SELECT from_state, to_state, detail FROM transitions WHERE reservation = ? ORDER BY seq').all(reservation) as Row[]).map((r) => ({ from: r['from_state'] === null ? null : String(r['from_state']), to: String(r['to_state']), detail: String(r['detail']) }));
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}
