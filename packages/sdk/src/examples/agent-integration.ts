/**
 * Minimal external-agent integration example.
 *
 * Demonstrates VALID AGENT != VALID ACTION without the Mandate web UI.
 * The caller supplies an authorized MandateClient (with attachAuthority)
 * and a signed proposal — no demo fixture defaults are implied here.
 */

import type { SignedProposal } from '@mandate/portfolio';
import type { MandateClient } from '../client.ts';

export type AgentHandleResult =
  | { readonly status: 'REFUSED'; readonly reasons: readonly string[] }
  | { readonly status: 'AUTHORIZED'; readonly reservationId: string };

/**
 * Screen one agent proposal and, only if Mandate authorizes it, reserve.
 *
 * A well-formed agent signature is not sufficient: the deterministic
 * portfolio/control boundary must accept the action.
 */
export async function handleAgentProposal(mandate: MandateClient, proposal: SignedProposal): Promise<AgentHandleResult> {
  const decision = await mandate.screen({ proposal });
  if (!decision.authorized) {
    return {
      status: 'REFUSED',
      reasons: decision.reasons.map((r) => r.code),
    };
  }
  const reservation = await mandate.reserve(decision);
  if (!reservation.ok) {
    return { status: 'REFUSED', reasons: reservation.reasons };
  }
  return { status: 'AUTHORIZED', reservationId: reservation.reservationId };
}
