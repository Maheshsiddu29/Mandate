/**
 * The settlement's precondition in front of the principal key.
 *
 * The 7E.3 `LocalGateCustody` already refuses to sign anything but a gate
 * mandate it re-derives from a committed `ADMIT_ATTEMPT` in the domain
 * ledger. This guard runs first, the way the Portfolio layer's
 * `createPortfolioGateSigner` guard does, and adds what only the Live AI
 * side knows: that the Live AI authorization is still eligible *now*
 * (eligibility.ts, re-derived from the frozen protocol and the committed
 * portfolio ledger) and that the artifact is exactly the fixture
 * settlement's — recipient, agent, tokens, quantity, debit, gate and chain.
 * Only then does the inner custody run its own checks and sign.
 */

import { representationIdOf, type ArtifactTerms, type CustodyResult, type GateArtifact, type GateClaim, type GateKeyCustody } from '@mandate/evm-robinhood';
import type { Eligibility } from './eligibility.ts';
import type { FixtureSettlement } from './fixture-mapping.ts';

/** Why `artifact` is not exactly the settlement's, or `null`. */
export function checkArtifact(artifact: GateArtifact, terms: ArtifactTerms, s: FixtureSettlement): string | null {
  if (artifact.domain.chainId !== s.chainId || artifact.domain.verifyingContract !== s.gate || terms.gate.gate !== s.gate) return 'GATE_MISMATCH';
  if (artifact.mandate.principal !== s.recipient || artifact.terms.recipient !== s.recipient || terms.principal !== s.recipient) return 'RECIPIENT_MISMATCH';
  if (artifact.mandate.agent !== s.agent || artifact.candidate.agent !== s.agent) return 'AGENT_MISMATCH';
  if (artifact.candidate.representationId !== representationIdOf(s.chainId, s.tokenOut) || terms.market.representation !== s.tokenOut || terms.market.fundingToken !== s.tokenIn) return 'TOKEN_MISMATCH';
  if (artifact.candidate.quantity.atoms !== s.quantity || terms.quantity !== s.quantity) return 'AMOUNT_MISMATCH';
  if (artifact.terms.fundingLimit !== s.debit || artifact.mandate.economicLimit.atoms !== s.debit) return 'AMOUNT_MISMATCH';
  if (artifact.terms.executionData !== '0x') return 'EXECUTION_DATA_NOT_EMPTY';
  return null;
}

export interface GuardedCustody extends GateKeyCustody {
  /** Signatures the inner custody made through this guard. */
  readonly signatures: () => number;
  /** Refusals this guard made before the inner custody was reached. */
  readonly refusals: () => readonly string[];
}

export function guardCustody(inner: GateKeyCustody, s: FixtureSettlement, eligibleNow: () => Eligibility, boundPrincipal?: string): GuardedCustody {
  let signatures = 0;
  const refusals: string[] = [];
  const refuse = (error: string): CustodyResult<string> => {
    refusals.push(error);
    return { ok: false, error };
  };
  return {
    principal: () => inner.principal(),
    signMandate(artifact: GateArtifact, terms: ArtifactTerms, claim: GateClaim): CustodyResult<string> {
      // V2 names the wallet that may sign. A different custody address is refused before the key is used.
      if (boundPrincipal !== undefined && inner.principal().toLowerCase() !== boundPrincipal.toLowerCase()) return refuse('SETTLEMENT.CUSTODY_PRINCIPAL_MISMATCH');
      const e = eligibleNow();
      if (!e.eligible) return refuse(`LIVE_AI.INELIGIBLE.${e.condition}.${e.reason}`);
      const bad = checkArtifact(artifact, terms, s);
      if (bad !== null) return refuse(`SETTLEMENT.${bad}`);
      const r = inner.signMandate(artifact, terms, claim);
      if (r.ok) signatures += 1;
      return r;
    },
    signatures: () => signatures,
    refusals: () => refusals,
  };
}
