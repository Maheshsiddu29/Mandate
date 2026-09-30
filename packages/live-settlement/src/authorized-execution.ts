/**
 * The authorized execution: the one object the settlement path may act on.
 *
 * It is the Stock child the real Mandate path verified and reserved in a
 * Live AI session (`LiveSession.reservedExecutions`), taken by reference —
 * never rebuilt. Every digest below is read off that object, and eligibility
 * (eligibility.ts) re-derives each of them from the frozen protocol before a
 * key can be used:
 *
 * ```text
 * VERIFIED_CANDIDATE == COMPILED_CANDIDATE == RESERVED_CANDIDATE
 *   == ADMITTED_CANDIDATE == SIGNED_CANDIDATE == TESTNET_SUBMITTED_CANDIDATE
 * ```
 */

import type { ActionId, ExecutionAuthorizationId, ReservationGeneration, ReservationId } from '@mandate/core';
import { candidateDigest, proposalDigest, type ActionCandidate, type CandidateDigest, type ChildAuthorizationDigest, type ProposalDigest } from '@mandate/portfolio';
import type { ReservedExecution } from '@mandate/live-agents';

export type StockCandidate = Extract<ActionCandidate, { readonly kind: 'STOCK_BUY' }>;

export interface AuthorizedExecution {
  /** The exact reserved object, by reference. */
  readonly reserved: ReservedExecution;
  readonly role: 'stock';
  readonly candidateId: string;
  readonly version: number;
  readonly portfolioMandate: string;
  readonly proposal: ProposalDigest;
  readonly candidateDigest: CandidateDigest;
  readonly child: ChildAuthorizationDigest;
  readonly reservation: ReservationId;
  readonly executionAuthorization: ExecutionAuthorizationId;
  readonly action: ActionId;
  readonly generation: ReservationGeneration;
  readonly receiptDigest: string;
  /** The verifier's candidate: the STOCK_BUY that was reserved. */
  readonly candidate: StockCandidate;
  /** The approved portfolio notional, USDC atoms. */
  readonly notionalAtoms: bigint;
  /** Protocol time. */
  readonly proposalExpiresAt: bigint;
}

export type Selected = { readonly ok: true; readonly execution: AuthorizedExecution } | { readonly ok: false; readonly reason: 'NO_STOCK_RESERVATION' | 'STOCK_RESERVATION_AMBIGUOUS' | 'NOT_A_STOCK_BUY' };

/**
 * The session's one reserved Stock child. Anything else — none, or more
 * than one — settles nothing: the settlement path never chooses between
 * reservations.
 */
export function selectStockExecution(reserved: readonly ReservedExecution[]): Selected {
  const stock = reserved.filter((r) => r.role === 'stock');
  if (stock.length === 0) return { ok: false, reason: 'NO_STOCK_RESERVATION' };
  if (stock.length > 1) return { ok: false, reason: 'STOCK_RESERVATION_AMBIGUOUS' };
  const r = stock[0] as ReservedExecution;
  const candidate = r.verified.candidate;
  if (candidate.kind !== 'STOCK_BUY') return { ok: false, reason: 'NOT_A_STOCK_BUY' };
  const notional = r.verified.child.approved.find((a) => a.resource === 'portfolio-notional')?.atoms ?? 0n;
  return {
    ok: true,
    execution: {
      reserved: r,
      role: 'stock',
      candidateId: r.candidateId,
      version: r.version,
      portfolioMandate: r.signed.proposal.portfolioMandate,
      proposal: proposalDigest(r.signed.proposal),
      candidateDigest: candidateDigest(candidate),
      child: r.verified.digest,
      reservation: r.record.reservation,
      executionAuthorization: r.record.executionId,
      action: r.record.actionId,
      generation: r.record.generation,
      receiptDigest: r.receiptDigest,
      candidate,
      notionalAtoms: notional,
      proposalExpiresAt: r.signed.proposal.expiresAt,
    },
  };
}
