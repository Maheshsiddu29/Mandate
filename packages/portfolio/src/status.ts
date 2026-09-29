/**
 * Agent status, derived — never reported by the agent (portfolio-mandate.md §14).
 *
 * A pure function of what the room, the verifier, the ledger and the
 * executors recorded. The UI animates it; the receipt carries each agent's
 * final value.
 */

import type { ExecutionResult, ReceiptReservation, AgentStatus } from './receipt.ts';
import type { ReleaseDecision, RoomDecision } from './room.ts';

export interface AgentHistory {
  readonly decisions: readonly RoomDecision[];
  readonly releases: readonly ReleaseDecision[];
  /** Reservations and executions of this agent's children. */
  readonly reservations: readonly ReceiptReservation[];
  readonly executions: readonly ExecutionResult[];
}

/** The status an agent ends the run in. */
export function finalStatus(h: AgentHistory): AgentStatus {
  if (h.executions.some((e) => e.status === 'SETTLED')) return 'SETTLED';
  if (h.executions.some((e) => e.status === 'FAILED') || h.reservations.some((r) => r.status === 'REFUSED')) return 'FAILED';
  if (h.reservations.some((r) => r.status === 'RESERVED')) return 'AUTHORIZED';
  const lastRound = Math.max(0, ...h.decisions.map((d) => d.round), ...h.releases.map((r) => r.round));
  if (lastRound === 0) return 'SEARCHING';
  if (h.releases.some((r) => r.round === lastRound && r.applied)) return 'RELEASING';
  const last = h.decisions.filter((d) => d.round === lastRound);
  if (last.some((d) => d.outcome === 'REDUCE_REQUESTED')) return 'RENEGOTIATING';
  // Accepted by the room but not reserved: the verifier or the ledger held it back.
  return last.some((d) => d.outcome === 'ACCEPTED') ? 'FAILED' : 'BLOCKED';
}

/** The status an agent shows at the end of a room round: what it did, and what happened to it. */
export function roundStatus(decisions: readonly RoomDecision[], releases: readonly ReleaseDecision[]): AgentStatus {
  if (releases.some((r) => r.applied)) return 'RELEASING';
  if (decisions.some((d) => d.outcome === 'ACCEPTED')) return 'AUTHORIZED';
  if (decisions.some((d) => d.outcome === 'REDUCE_REQUESTED')) return 'RENEGOTIATING';
  if (decisions.some((d) => d.outcome === 'REJECTED')) return 'BLOCKED';
  return decisions.length > 0 || releases.length > 0 ? 'PROPOSING' : 'SEARCHING';
}
