/**
 * The portfolio's precondition in front of the Robinhood principal key
 * (portfolio-mandate.md §12).
 *
 * `guardGateCustody` wraps the existing gate custody — unchanged — so that
 * before the principal's key signs any gate mandate, the portfolio's own
 * `checkBeforeSign` passes against the committed ledger: the reservation
 * belongs to a child the verifier derived, the action is exactly the one that
 * child compiles to, the reservation is active with exactly the approved
 * demand, and the `ADMIT_ATTEMPT` is committed. Only then does the inner
 * custody run its own checks (it re-derives the gate artifact from the
 * committed attempt) and sign.
 *
 * A stock reservation made outside the portfolio — directly against the
 * engine, under the agent's delegation — can therefore reach the gate signer
 * but never the principal's signature.
 */

import type { LedgerState } from '@mandate/ledger';
import type { ReservationId } from '@mandate/core';
import type { ArtifactTerms, CustodyResult, GateArtifact, GateClaim, GateKeyCustody } from '@mandate/evm-robinhood';
import type { ActionCandidate } from '../candidate.ts';
import type { ChildAuthorizationDigest, ChildExecutionAuthorization } from '../child.ts';
import { checkBeforeSign, type PortfolioCore } from '../reservation.ts';

export interface GuardDeps {
  readonly core: PortfolioCore;
  /** The children the verifier derived for this portfolio run. */
  readonly verified: ReadonlySet<ChildAuthorizationDigest>;
  /** The child and candidate a reservation was made for, as the portfolio recorded it; `null` if none. */
  readonly childOf: (reservation: ReservationId) => { readonly child: ChildExecutionAuthorization; readonly candidate: ActionCandidate } | null;
  /** The committed ledger, read synchronously as custody reads it. */
  readonly state: () => LedgerState;
}

export function guardGateCustody(inner: GateKeyCustody, deps: GuardDeps): GateKeyCustody {
  return {
    principal: () => inner.principal(),
    signMandate(artifact: GateArtifact, terms: ArtifactTerms, claim: GateClaim): CustodyResult<string> {
      const found = deps.childOf(claim.reservation);
      if (found === null) return { ok: false, error: 'PORTFOLIO.CHILD_AUTHORIZATION_UNKNOWN' };
      const reasons = checkBeforeSign(deps.core, deps.verified, { agent: found.child.agent, child: found.child, candidate: found.candidate, reservation: claim.reservation, action: claim.action }, deps.state());
      const first = reasons[0];
      if (first !== undefined) return { ok: false, error: `PORTFOLIO.${first.code}` };
      return inner.signMandate(artifact, terms, claim);
    },
  };
}
