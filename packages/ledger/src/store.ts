/**
 * The ledger store contract (authority-ledger.md §9, §13; ADR 0022).
 *
 * A store holds, per principal, the append-only log of committed batches and
 * the state they fold to. Its only job is atomicity and durability; what a
 * batch *means* is decided by the pure reducer, which the store applies at
 * commit. Required semantics:
 *
 * 1. **Consistent read.** `read` returns one committed version: its version,
 *    head and folded state, all from the same commit.
 * 2. **Compare-and-append.** `compareAndAppend(principal, expectedVersion,
 *    expectedHead, events)` commits iff the current version *and* head equal
 *    the expected ones and the reducer accepts the whole batch. Otherwise it
 *    writes nothing and reports why.
 * 3. **Atomic batches.** A batch with any number of events advances the
 *    version exactly once, or not at all. A partially applied batch is
 *    impossible.
 * 4. **One linearization domain per principal.** The version is
 *    principal-wide — every registration, revocation and charge shares it —
 *    and principals are independent: a commit for one never conflicts with,
 *    reads or changes another's.
 *
 * Nothing here names a database. A durable store (PostgreSQL, a replicated
 * log, …) must provide the same four properties with real durability; that is
 * an infrastructure decision left open (open question 8).
 */

import type { LedgerHeadDigest, LedgerVersion, PrincipalId } from '@mandate/core';
import type { LedgerRefusal } from './errors.ts';
import type { LedgerEvent } from './events.ts';
import type { LedgerState } from './state.ts';

export interface LedgerSnapshot {
  readonly principal: PrincipalId;
  readonly version: LedgerVersion;
  readonly head: LedgerHeadDigest;
  /** Immutable: later commits never change a snapshot already read. */
  readonly state: LedgerState;
}

export interface CommittedBatch {
  readonly version: LedgerVersion;
  readonly previousHead: LedgerHeadDigest;
  readonly head: LedgerHeadDigest;
  readonly events: readonly LedgerEvent[];
  /** The canonical encoding the head is the digest of. */
  readonly encoded: Uint8Array;
}

export type CommitResult =
  | { readonly status: 'COMMITTED'; readonly snapshot: LedgerSnapshot }
  /** The ledger moved since the caller read it. Nothing was written; the caller must re-read and recompute. */
  | { readonly status: 'CONFLICT'; readonly reason: 'VERSION_CONFLICT' | 'HEAD_MISMATCH'; readonly version: LedgerVersion; readonly head: LedgerHeadDigest }
  /** The reducer refused the batch against the current state. Nothing was written. */
  | { readonly status: 'REFUSED'; readonly refusal: LedgerRefusal };

export interface LedgerStore {
  read(principal: PrincipalId): Promise<LedgerSnapshot>;
  compareAndAppend(principal: PrincipalId, expectedVersion: LedgerVersion, expectedHead: LedgerHeadDigest, events: readonly LedgerEvent[]): Promise<CommitResult>;
  /** Every committed batch, in order: the authoritative log. */
  history(principal: PrincipalId): Promise<readonly CommittedBatch[]>;
}

/** A stable map key for a principal. */
export function principalKey(p: PrincipalId): string {
  return JSON.stringify([p.kind, p.value]);
}
