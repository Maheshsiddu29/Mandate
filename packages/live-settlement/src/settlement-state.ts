/**
 * The durable settlement state of a session's Stock reservation, as the
 * browser restores it (docs/demo/c1-browser-complete-settlement.md §9).
 *
 * It is a projection of records that already exist: the journal's attempt
 * and artifacts (what this process did and may have sent), the portfolio
 * ledger's reservation status (the authority on the reservation), and
 * whether a settle call is open in this process right now. It decides
 * nothing: `executable` only says whether the journal and the ledger leave
 * room for a new execute; the execute itself re-checks everything.
 *
 * Pure: no file, chain, clock or key.
 */

import { isTerminal, type ArtifactRecord, type AttemptRecord, type AttemptState, type Quarantine } from './journal.ts';
import type { ReservationStatus } from './portfolio-ledger.ts';
import { deadOnlyAfter, reconciliationOnly } from './reconcile.ts';

export const SETTLEMENT_STATUSES = ['NO_ATTEMPT', 'PREPARED', 'SIGNATURE_REQUIRED', 'IN_PROGRESS', 'HELD', 'SUBMITTED', 'REVERTED', 'NEEDS_REVIEW', 'SETTLED', 'RELEASED', 'PREPARATION_FAILED', 'UNREADABLE'] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

/** A settle call open in this process: parked for the gate signature, or running. */
export type PendingSettlement = 'AWAITING_SIGNATURE' | 'RUNNING' | null;

export interface DurableSettlement {
  readonly settlementStatus: SettlementStatus;
  readonly reservation: string | null;
  /** The portfolio ledger's word on the reservation. */
  readonly reservationState: ReservationStatus | null;
  readonly attemptState: AttemptState | null;
  readonly quarantine: Quarantine | null;
  /** Reconciliation only, not yet resolved: never resent, released only once every artifact is dead. */
  readonly held: boolean;
  /** Chain seconds after which no artifact of the attempt can execute. */
  readonly heldUntil: string | null;
  readonly txHash: string | null;
  /** Broadcasts the journal proves: 0 without a hash; null when a hash exists but its broadcast is not established. */
  readonly transactions: number | null;
  readonly receiptStatus: string | null;
  readonly pending: PendingSettlement;
  /** A new execute may start: no settle call open, the reservation still open, and no attempt that only reconciliation may resolve. */
  readonly executable: boolean;
  /** Session events when this was read: an event at or past this sequence is newer than this state. */
  readonly asOfEvents: number;
}

export interface SettlementFacts {
  readonly reservation: string | null;
  readonly reservationState: ReservationStatus | null;
  readonly attempt: AttemptRecord | null;
  readonly artifacts: readonly ArtifactRecord[];
  readonly pending: PendingSettlement;
  readonly asOfEvents: number;
}

function statusOf(a: AttemptRecord | null, pending: PendingSettlement): SettlementStatus {
  if (pending === 'AWAITING_SIGNATURE') return 'SIGNATURE_REQUIRED';
  if (pending === 'RUNNING') return 'IN_PROGRESS';
  if (a === null) return 'NO_ATTEMPT';
  if (!reconciliationOnly(a)) return 'PREPARED';
  switch (a.state) {
    case 'PREPARATION_FAILED':
      return 'PREPARATION_FAILED';
    case 'SETTLED':
    case 'CONSUMED':
      return 'SETTLED';
    case 'RELEASED':
      return 'RELEASED';
    case 'CONFIRMED_REVERT':
      return 'REVERTED';
    default:
      if (isTerminal(a)) return 'NEEDS_REVIEW';
      return a.tx === null ? 'HELD' : 'SUBMITTED';
  }
}

function transactionsOf(a: AttemptRecord | null): number | null {
  // Every broadcast is journaled with its hash first: no hash, no broadcast.
  if (a === null || a.tx === null) return 0;
  if (a.receipt !== null || a.state === 'SUBMITTED') return 1;
  return null;
}

export function durableSettlement(f: SettlementFacts): DurableSettlement {
  const a = f.attempt;
  const settlementStatus = statusOf(a, f.pending);
  const held = a !== null && f.pending === null && reconciliationOnly(a) && !isTerminal(a);
  const until = held && a !== null ? deadOnlyAfter(a, f.artifacts) : null;
  const open = f.reservationState === 'RESERVED' || (f.reservationState === 'ADMITTED' && a !== null);
  return {
    settlementStatus,
    reservation: f.reservation,
    reservationState: f.reservationState,
    attemptState: a?.state ?? null,
    quarantine: a?.quarantine ?? null,
    held,
    heldUntil: until === null ? null : until.toString(),
    txHash: a?.tx?.hash ?? null,
    transactions: transactionsOf(a),
    receiptStatus: a?.receipt?.status ?? null,
    pending: f.pending,
    executable: f.pending === null && open && (a === null || !reconciliationOnly(a)),
    asOfEvents: f.asOfEvents,
  };
}

/** The journal or ledger could not be read: nothing is offered. */
export function unreadableSettlement(reservation: string | null, pending: PendingSettlement, asOfEvents: number): DurableSettlement {
  return { settlementStatus: 'UNREADABLE', reservation, reservationState: null, attemptState: null, quarantine: null, held: false, heldUntil: null, txHash: null, transactions: null, receiptStatus: null, pending, executable: false, asOfEvents };
}
