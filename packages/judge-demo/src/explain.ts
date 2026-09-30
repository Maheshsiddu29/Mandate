/**
 * Plain language over real protocol results. **Presentation only.**
 *
 * Nothing here decides anything. `verdictOf` sorts a real screening result
 * into the three cases the judge sees, by the same rule the Mandate Room
 * applies (screen.ts: `quantityOnly` is what lets the room ask to reduce
 * rather than refuse). `phrase` turns a real reason code into words; a code
 * it does not know is shown as itself.
 */

import type { ActionCandidate, Screening } from '@mandate/portfolio';

/**
 * - `SECURITY_INVALID` — the action itself is outside the authority: blocked,
 *   never negotiated;
 * - `LOCALLY_VALID_RESOURCE_CONFLICT` — inside the agent's authority, but a
 *   quantity does not fit a limit: negotiated;
 * - `ADMISSIBLE` — passes screening; the room decides its allocation.
 */
export type Verdict = 'SECURITY_INVALID' | 'LOCALLY_VALID_RESOURCE_CONFLICT' | 'ADMISSIBLE';

export function verdictOf(s: Screening): Verdict {
  if (s.reasons.length === 0) return 'ADMISSIBLE';
  return s.quantityOnly ? 'LOCALLY_VALID_RESOURCE_CONFLICT' : 'SECURITY_INVALID';
}

const PHRASES: { readonly [code: string]: string } = {
  'REGISTRY:ISSUER_NOT_ALLOWED': 'the registry records its issuer as not approved',
  'REGISTRY:SYNTHETIC_NOT_ALLOWED': 'the registry records it as a synthetic exposure, which the mandate forbids',
  'REGISTRY:REPRESENTATION_UNKNOWN': 'the registry has no record of this token',
  ASSET_NOT_ALLOWED: 'it resolves to a canonical asset the mandate does not name',
  REPRESENTATION_NOT_ALLOWED: 'its exact contract is not an approved representation',
  ISSUER_NOT_ALLOWED: 'its issuer is not approved',
  VENUE_NOT_ALLOWED: 'its venue is not an approved venue',
  ROUTE_NOT_ALLOWED: 'its route uses a pool that is not approved',
  RECIPIENT_NOT_ALLOWED: 'it pays a recipient that is not an approved recipient',
  CHAIN_NOT_ALLOWED: 'it is on a chain the mandate does not name',
  LEVERAGE_NOT_ALLOWED: 'its leverage is above the bound',
  SLIPPAGE_NOT_ALLOWED: 'its slippage is above the bound',
  QUOTE_STALE: 'its quote is too old, or dated in the future',
  AGENT_LIMIT_EXCEEDED: "it is larger than the agent's own hard maximum",
  PORTFOLIO_LIMIT_EXCEEDED: 'it is larger than a portfolio-wide limit',
  ALLOCATION_INSUFFICIENT: 'the portfolio does not have that much left to give',
  AGENT_SIGNATURE_INVALID: 'its signature does not recover to the agent',
  AGENT_UNKNOWN: 'the mandate names no such agent',
  PROPOSAL_REPLAYED: 'it was already presented',
};

export function phrase(code: string): string {
  return PHRASES[code] ?? code;
}

/** "a, b and c" */
export function listed(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Why, in words, from real codes: "its venue is not an approved venue (VENUE_NOT_ALLOWED)". */
export function because(codes: readonly string[]): string {
  return listed(codes.map((c) => `${phrase(c)} (${c})`));
}

/** `0x5a01…` style shortening for messages; data fields always carry the full value. */
export function short(id: string): string {
  const m = /^(.*?)(0x[0-9a-fA-F]{8,})$/.exec(id);
  if (m === null) return id;
  const hex = m[2] as string;
  return `${m[1]}${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

/** Exact basis points as a percentage with two decimals: 1260 → "12.60". */
export function percent(bps: number | bigint): string {
  const b = BigInt(bps);
  return `${b / 100n}.${(b % 100n).toString().padStart(2, '0')}`;
}

/** One line for a candidate: what it would do, in the candidate's own fields. */
export function describeCandidate(c: ActionCandidate): string {
  switch (c.kind) {
    case 'STOCK_BUY':
      return `buy token ${short(c.representation)}${c.claims.ticker === null ? '' : ` (display ticker "${c.claims.ticker}")`}`;
    case 'SWAP_EXACT_IN':
      return `swap through router ${short(c.router)}, paying ${short(c.recipient)}`;
    case 'NFT_BUY':
      return `buy #${c.tokenId}${c.claims.displayName === null ? '' : ` of "${c.claims.displayName}"`} from contract ${short(c.collection)}`;
    case 'YIELD_DEPOSIT':
      return `deposit into vault ${short(c.product)} at an advertised APY of ${percent(c.quotedApyBps)}% (a quote, not a guaranteed return)`;
    case 'PERP_OPEN': {
      const lev = c.initialMarginFraction > 0 && 10_000 % c.initialMarginFraction === 0 ? `${10_000 / c.initialMarginFraction}x` : `initial margin ${percent(c.initialMarginFraction)}%`;
      return `open ${c.side} ${short(c.market)} at ${lev}`;
    }
  }
}
