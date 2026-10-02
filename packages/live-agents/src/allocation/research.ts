/**
 * Market research: the evidence an agent's opportunity analysis may use
 * (docs/v2/mandate-room-v2.md §9).
 *
 * The seam follows the analyst pattern of TradingAgents (Apache-2.0,
 * https://github.com/TauricResearch/TradingAgents; no code reused): each
 * domain has its own kinds of evidence, every item says where it came from
 * and when it was observed, and evidence that is not available is reported
 * as `DATA_UNAVAILABLE` rather than estimated.
 *
 * The shipped provider has no live source. It reports the candidates'
 * labelled fixture facts as `FIXTURE`, and every kind of research the lab
 * cannot supply as `DATA_UNAVAILABLE`. A live adapter would implement the
 * same interface; nothing downstream would change, and nothing here is
 * authority — research changes what an agent believes, never what Mandate
 * permits.
 */

import type { TrustedCandidate } from '../agents/spec.ts';
import type { ResearchEvidenceView } from '../runtime/provider.ts';
import type { Role } from '../types.ts';

export type EvidenceClass = ResearchEvidenceView['evidence'];

export interface ResearchEvidence {
  readonly kind: string;
  readonly evidence: EvidenceClass;
  readonly source: string;
  /** Protocol time the evidence describes. */
  readonly observedAt: bigint;
  readonly note: string;
}

export interface MarketResearchProvider {
  readonly name: string;
  /** Every evidence class this provider can produce: what a session may claim about its research. */
  readonly classes: readonly EvidenceClass[];
  research(role: Role, candidates: readonly TrustedCandidate[], observedAt: bigint): Promise<readonly ResearchEvidence[]>;
}

/** The research each domain would want, and what the lab has for it. */
const DOMAIN_RESEARCH: { readonly [R in Role]: readonly { readonly kind: string; readonly available: boolean; readonly note: string }[] } = {
  stock: [
    { kind: 'MARKET', available: true, note: 'quoted price, gate fee, all-in cost and order depth per candidate' },
    { kind: 'REDEMPTION', available: true, note: 'registry redemption terms per candidate' },
    { kind: 'FUNDAMENTALS', available: false, note: 'no filings source is connected' },
    { kind: 'NEWS', available: false, note: 'no news source is connected' },
    { kind: 'SENTIMENT', available: false, note: 'no sentiment source is connected' },
    { kind: 'TECHNICAL', available: false, note: 'no price history is connected' },
  ],
  swap: [
    { kind: 'QUOTE', available: true, note: 'expected output, fee tier and slippage bound per route' },
    { kind: 'ROUTE_LIQUIDITY', available: true, note: 'fixture pool depth per route' },
    { kind: 'VOLATILITY', available: false, note: 'no live price series is connected' },
  ],
  nft: [
    { kind: 'LISTING', available: true, note: 'listing price and collection per candidate' },
    { kind: 'MARKET_INTELLIGENCE', available: false, note: 'no floor-price or sales-history source is connected' },
  ],
  yield: [
    { kind: 'NET_YIELD', available: true, note: 'advertised APY, capacity and withdrawal terms per vault' },
    { kind: 'PROTOCOL_RISK', available: false, note: 'no protocol risk feed is connected' },
  ],
  perps: [
    { kind: 'MARKET', available: true, note: 'price, leverage, margin and funding per candidate' },
    { kind: 'OPEN_INTEREST', available: false, note: 'no open-interest or basis source is connected' },
  ],
};

/** The lab's research: labelled fixtures, and explicit gaps. */
export const FIXTURE_RESEARCH: MarketResearchProvider = {
  name: 'fixture-research.v1',
  classes: ['FIXTURE', 'DATA_UNAVAILABLE'],
  research: (role, candidates, observedAt) =>
    Promise.resolve(
      DOMAIN_RESEARCH[role].map((r) =>
        r.available
          ? { kind: r.kind, evidence: 'FIXTURE' as const, source: `fixture:${candidates.map((c) => c.id).join(',')}`, observedAt, note: r.note }
          : { kind: r.kind, evidence: 'DATA_UNAVAILABLE' as const, source: 'none', observedAt, note: r.note },
      ),
    ),
};

export function researchView(e: ResearchEvidence): ResearchEvidenceView {
  return { kind: e.kind, evidence: e.evidence, source: e.source, observedAt: e.observedAt.toString(), note: e.note };
}
