/**
 * The portfolio's precondition in front of the Robinhood principal key
 * (portfolio-mandate.md §12).
 *
 * `createPortfolioGateSigner` captures the existing gate custody — unchanged — so that
 * before the principal's key signs any gate mandate, the portfolio's own
 * `checkBeforeSign` passes against the committed ledger: the reservation
 * belongs to a child the verifier derived, the action is exactly the one that
 * child compiles to, the reservation is active with exactly the approved
 * demand, and the `ADMIT_ATTEMPT` is committed. Only then does the inner
 * custody run its own checks (it re-derives the gate artifact from the
 * committed attempt) and sign.
 *
 * A stock reservation made outside the verified Portfolio transcript cannot
 * reach the captured principal key.
 */

import type { LedgerState } from '@mandate/ledger';
import type { ReservationId } from '@mandate/core';
import type { AuthorizationRecord } from '@mandate/control';
import { GateSigner, type ArtifactTerms, type CustodyResult, type GateArtifact, type GateClaim, type GateKeyCustody, type GateSignerDeps } from '@mandate/evm-robinhood';
import type { ActionCandidate } from '../candidate.ts';
import type { ChildExecutionAuthorization } from '../child.ts';
import { checkBeforeSign, type PortfolioCore } from '../reservation.ts';
import type { VerificationTranscript } from '../verifier.ts';

interface GuardDeps {
  readonly core: PortfolioCore;
  /** The children the verifier derived for this portfolio run. */
  readonly transcriptOf: (reservation: ReservationId) => VerificationTranscript | null;
  /** The child and candidate a reservation was made for, as the portfolio recorded it; `null` if none. */
  readonly childOf: (reservation: ReservationId) => { readonly child: ChildExecutionAuthorization; readonly candidate: ActionCandidate; readonly record: AuthorizationRecord } | null;
  /** The committed ledger, read synchronously as custody reads it. */
  readonly state: () => LedgerState;
}

function guardedCustody(inner: GateKeyCustody, deps: GuardDeps): GateKeyCustody {
  return {
    principal: () => inner.principal(),
    signMandate(artifact: GateArtifact, terms: ArtifactTerms, claim: GateClaim): CustodyResult<string> {
      const found = deps.childOf(claim.reservation);
      const transcript = deps.transcriptOf(claim.reservation);
      if (found === null || transcript === null) return { ok: false, error: 'PORTFOLIO.CHILD_AUTHORIZATION_UNKNOWN' };
      const reasons = checkBeforeSign(deps.core, transcript, {
        agent: found.child.agent,
        child: found.child,
        candidate: found.candidate,
        reservation: claim.reservation,
        action: claim.action,
        generation: claim.generation,
        authorization: found.record.executionId,
        attempt: claim.attempt,
        at: artifact.mandate.createdAtUnixSeconds,
      }, deps.state());
      const first = reasons[0];
      if (first !== undefined) return { ok: false, error: `PORTFOLIO.${first.code}` };
      return inner.signMandate(artifact, terms, claim);
    },
  };
}

/**
 * The only Portfolio-layer construction path for the Robinhood signer. The
 * raw custody is captured inside the factory and only a signer wired to the
 * mandatory Portfolio transcript guard is returned. The generic domain
 * package remains unchanged for non-Portfolio users.
 */
export function createPortfolioGateSigner(deps: Omit<GateSignerDeps, 'custody'> & { readonly custody: GateKeyCustody; readonly portfolio: GuardDeps }): GateSigner {
  const { custody, portfolio, ...signer } = deps;
  return new GateSigner({ ...signer, custody: guardedCustody(custody, portfolio) });
}
