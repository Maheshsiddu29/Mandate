/**
 * Screening, as Mandate does it (portfolio-mandate.md §9–§11).
 *
 * `screenProposal` is the frozen rule the Mandate Room and the Portfolio
 * Verifier share. This adapter only classifies its answer:
 *
 * | reasons | verdict | meaning |
 * | --- | --- | --- |
 * | none | ADMISSIBLE | individually and portfolio valid |
 * | only `PORTFOLIO_LIMIT_EXCEEDED` | ADMISSIBLE | individually valid, portfolio invalid: negotiable |
 * | only quantity (`AGENT_LIMIT_EXCEEDED`, `PORTFOLIO_LIMIT_EXCEEDED`) | ADMISSIBLE | a smaller version could pass: negotiable |
 * | anything else | BLOCKED | security invalid: never enters the Room |
 *
 * Whether several admissible proposals *together* fit is a separate
 * question (room/negotiation.ts), and the final answer is always the full
 * `runPortfolio` path.
 */

import { screenProposal, type DomainBinding, type PortfolioMandate, type Reason, type ResourceVector, type SignedProposal } from '@mandate/portfolio';

export interface ScreenResult {
  readonly verdict: 'ADMISSIBLE' | 'BLOCKED';
  /** Inside the agent's own authority: every reason, if any, is the portfolio's limit. */
  readonly individuallyValid: boolean;
  /** No reason at all. */
  readonly portfolioValid: boolean;
  readonly reasons: readonly Reason[];
  readonly demand: ResourceVector;
}

export function screen(mandate: PortfolioMandate, bindings: readonly DomainBinding[], signed: SignedProposal, now: bigint): ScreenResult {
  const s = screenProposal(mandate, bindings, signed, now);
  const admissible = s.reasons.length === 0 || s.quantityOnly;
  return {
    verdict: admissible ? 'ADMISSIBLE' : 'BLOCKED',
    individuallyValid: s.reasons.every((r) => r.code === 'PORTFOLIO_LIMIT_EXCEEDED'),
    portfolioValid: s.reasons.length === 0,
    reasons: s.reasons,
    demand: s.demand,
  };
}

export const reasonCodes = (rs: readonly Reason[]): readonly string[] => rs.map((r) => (r.subject === '' ? r.code : `${r.code}:${r.subject}`));
