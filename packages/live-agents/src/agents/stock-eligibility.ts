/**
 * Stock actionable set.
 *
 * Broad discovery may include a same-ticker lookalike. Before a model
 * selects an executable action, each candidate is canonicalized by the
 * representation its local `build` names — never by ticker text, price
 * text, or a later rationale — and admitted only when the active mandate's
 * stock binding resolves that identity. The binding is the registry's own
 * verdict. This filter does not replace it: anything submitted directly is
 * still screened by `screenProposal`.
 *
 * A candidate that resolves stays actionable even if a particular size
 * would later exceed a limit. Quantity is Mandate's second screen, and a
 * smaller version can still be negotiated. A candidate that does not
 * resolve is not offered as a selectable id. It is never rewritten onto
 * one that does.
 */

import { agentPolicyOf, resolveCandidate, validateActionCandidate, type DomainBinding, type PortfolioMandate, type Reason } from '@mandate/portfolio';
import type { Party } from '../mandate/signer.ts';
import type { TrustedCandidate } from './spec.ts';

export interface ExcludedStockCandidate {
  readonly candidateId: string;
  readonly reasons: readonly string[];
}

export interface StockEligibility {
  /** Broad discovery, in the order it was supplied. May include representations the model must not execute. */
  readonly discovered: readonly TrustedCandidate[];
  /** The closed set a model may select, in discovered order. */
  readonly actionable: readonly TrustedCandidate[];
  readonly excluded: readonly ExcludedStockCandidate[];
}

function reasonText(reasons: readonly Reason[]): readonly string[] {
  return reasons.map((r) => (r.subject === '' ? r.code : `${r.code}:${r.subject}`));
}

export function stockEligibility(discovered: readonly TrustedCandidate[], mandate: PortfolioMandate, bindings: readonly DomainBinding[], agent: Party, now: bigint): StockEligibility {
  const policy = agentPolicyOf(mandate, agent);
  const actionable: TrustedCandidate[] = [];
  const excluded: ExcludedStockCandidate[] = [];
  for (const candidate of discovered) {
    if (policy === null) {
      excluded.push({ candidateId: candidate.id, reasons: ['AGENT_UNKNOWN'] });
      continue;
    }
    // Identity is the representation `build` closes over. Facts are not read.
    const built = validateActionCandidate(candidate.build(candidate.minAtoms, now));
    if (!built.ok) {
      excluded.push({ candidateId: candidate.id, reasons: [built.error.code] });
      continue;
    }
    const resolved = resolveCandidate(bindings, mandate, policy, built.value, now);
    if (!resolved.ok) excluded.push({ candidateId: candidate.id, reasons: reasonText(resolved.reasons) });
    else actionable.push(candidate);
  }
  return { discovered, actionable, excluded };
}
