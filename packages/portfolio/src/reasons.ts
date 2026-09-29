/**
 * Portfolio reason codes (portfolio-mandate.md §16).
 *
 * **Provisional**, like Core's (open question 9): names may change before a
 * freeze, meanings may not. A reason is a value — a code and the subject it
 * concerns (a set, a resource, an agent) — never prose. Registry and control
 * refusals are carried verbatim under a `REGISTRY:` or `LEDGER:` prefix, so
 * the component that decided is never hidden behind a portfolio code.
 *
 * Every list of reasons is canonical: sorted by code then subject, with
 * duplicates removed, so the order in which checks ran never reaches a digest.
 */

export const PORTFOLIO_REASON_CODES_ARE_PROVISIONAL = true;

export const PORTFOLIO_REASON_CODES = [
  // Mandate
  'PORTFOLIO_MANDATE_MALFORMED',
  'PORTFOLIO_MANDATE_SIGNATURE_INVALID',
  'PORTFOLIO_MANDATE_DIGEST_MISMATCH',
  'PORTFOLIO_MANDATE_NOT_YET_VALID',
  'PORTFOLIO_MANDATE_EXPIRED',
  'PREFERRED_EXCEEDS_HARD_MAXIMUM',
  'PREFERRED_EXCEEDS_PORTFOLIO_LIMIT',
  'ALLOCATION_MODE_VIOLATION',
  // Agent
  'AGENT_UNKNOWN',
  'AGENT_SIGNATURE_INVALID',
  'AGENT_NOT_YET_VALID',
  'AGENT_EXPIRED',
  // Proposal
  'PROPOSAL_NOT_YET_VALID',
  'PROPOSAL_EXPIRED',
  'PROPOSAL_REPLAYED',
  'PROPOSAL_EXTENSION_UNKNOWN',
  'PROPOSAL_RESOURCES_MISDECLARED',
  'PROPOSAL_MINIMUM_INVALID',
  // Identity
  'INSTRUMENT_UNKNOWN',
  'IDENTITY_CLAIM_MISMATCH',
  // Scope
  'DOMAIN_NOT_ALLOWED',
  'ACTION_NOT_ALLOWED',
  'CHAIN_NOT_ALLOWED',
  'VENUE_NOT_ALLOWED',
  'ROUTE_NOT_ALLOWED',
  'ASSET_NOT_ALLOWED',
  'REPRESENTATION_NOT_ALLOWED',
  'ISSUER_NOT_ALLOWED',
  'RECIPIENT_NOT_ALLOWED',
  'SYNTHETIC_NOT_ALLOWED',
  'REQUIRED_RIGHT_MISSING',
  'LEVERAGE_NOT_ALLOWED',
  'SLIPPAGE_NOT_ALLOWED',
  'QUOTE_NOT_ALLOWED',
  'QUOTE_STALE',
  // Resources
  'RESOURCE_UNDECLARED',
  'RESOURCE_INCOMPARABLE',
  'AGENT_LIMIT_EXCEEDED',
  'PORTFOLIO_LIMIT_EXCEEDED',
  'ALLOCATION_INSUFFICIENT',
  // Allocation book
  'RELEASE_EXCEEDS_UNUSED',
  'RELEASE_ALREADY_APPLIED',
  'RELEASE_SEQUENCE_INVALID',
  'CLAIM_NOT_PERMITTED_IN_MODE',
  'CLAIM_ALREADY_APPLIED',
  'LOT_UNKNOWN',
  'LOT_EXHAUSTED',
  'COMMIT_EXCEEDS_ALLOCATION',
  'COMMIT_ALREADY_APPLIED',
  // Parent → child derivation
  'CHILD_WIDENS_DOMAINS',
  'CHILD_WIDENS_ACTIONS',
  'CHILD_WIDENS_CHAINS',
  'CHILD_WIDENS_VENUES',
  'CHILD_WIDENS_ASSETS',
  'CHILD_WIDENS_REPRESENTATIONS',
  'CHILD_WIDENS_ISSUERS',
  'CHILD_WIDENS_RECIPIENTS',
  'CHILD_WIDENS_SYNTHETIC_POLICY',
  'CHILD_DROPS_REQUIRED_RIGHT',
  'CHILD_WIDENS_LEVERAGE',
  'CHILD_WIDENS_SLIPPAGE',
  'CHILD_WIDENS_QUOTE_AGE',
  'CHILD_WIDENS_WINDOW',
  'CHILD_RESOURCE_UNDECLARED',
  'CHILD_WIDENS_RESOURCE_LIMIT',
  // Portfolio candidate
  'CANDIDATE_PROPOSAL_UNKNOWN',
  'CANDIDATE_PROPOSAL_DUPLICATED',
  'CANDIDATE_BOOK_MISMATCH',
  // Handoff to Core and the domain signer
  'CHILD_AUTHORIZATION_UNKNOWN',
  'CHILD_AGENT_MISMATCH',
  'CHILD_ACTION_MUTATED',
  'RESERVATION_MISSING',
  'RESERVATION_GENERATION_INVALID',
  'RESERVATION_DEMAND_MISMATCH',
  'ATTEMPT_NOT_COMMITTED',
] as const;

export type PortfolioReasonCode = (typeof PORTFOLIO_REASON_CODES)[number];

/** A portfolio code, or a registry or control code carried verbatim. */
export type ReasonCode = PortfolioReasonCode | `REGISTRY:${string}` | `LEDGER:${string}`;

export interface Reason {
  readonly code: ReasonCode;
  /** What the reason concerns — a set name, a resource id, an agent — in the portfolio's vocabulary; `''` when nothing narrower applies. */
  readonly subject: string;
}

export function reason(code: ReasonCode, subject = ''): Reason {
  return { code, subject };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorted by code then subject, duplicates removed. */
export function canonicalReasons(reasons: readonly Reason[]): readonly Reason[] {
  const seen = new Map<string, Reason>();
  for (const r of reasons) seen.set(`${r.code}\u0000${r.subject}`, r);
  return [...seen.values()].sort((a, b) => compareText(a.code, b.code) || compareText(a.subject, b.subject));
}

export function isPortfolioReasonCode(code: string): code is PortfolioReasonCode {
  return (PORTFOLIO_REASON_CODES as readonly string[]).includes(code);
}
