/**
 * The OpportunityCard (docs/v2/mandate-room-v2.md §5.1): what an agent hands
 * a Planning or Reallocation Room.
 *
 * The model supplies only what the strict schema lets it: one offered
 * candidate id, three amounts inside that candidate's bounds, five ordinals,
 * a regime word and a short declared rationale. Everything else — the role,
 * the observation and freshness times, the evidence classes — is set here by
 * trusted code. No hidden reasoning is requested or kept.
 */

import type { ResearchEvidence } from './research.ts';
import type { MarketRegime, OpportunityAnswer, OpportunityMetrics } from '../runtime/schemas.ts';
import type { ModelEvidence } from '../runtime/provider.ts';
import type { Role } from '../types.ts';

/** What happened to the agent's model call. Anything but RESPONDED yields an abstaining card. */
export type CardRuntime = 'RESPONDED' | 'TIMED_OUT' | 'FAILED' | 'INVALID_RESPONSE' | 'NO_CANDIDATES';

export interface OpportunityCard {
  readonly role: Role;
  readonly candidateId: string | null;
  readonly candidateTitle: string | null;
  readonly action: 'PROPOSE' | 'ABSTAIN';
  readonly requestedAtoms: bigint;
  readonly minimumUsefulAtoms: bigint;
  readonly maximumUsefulAtoms: bigint;
  readonly metrics: OpportunityMetrics;
  readonly marketRegime: MarketRegime;
  readonly rationale: string;
  /** Protocol time the candidates' facts were observed. */
  readonly observedAt: bigint;
  /** After this protocol time the card may not be compared or used: the facts are stale. */
  readonly freshUntil: bigint;
  readonly evidence: readonly { readonly kind: string; readonly evidence: string; readonly source: string }[];
  readonly modelEvidence: ModelEvidence;
  readonly marketEvidence: 'FIXTURE';
  readonly runtime: CardRuntime;
}

const NO_METRICS: OpportunityMetrics = { opportunityQuality: 0, liquidity: 0, executionQuality: 0, downsideRisk: 4, dataConfidence: 0 };

export interface CardContext {
  readonly role: Role;
  readonly observedAt: bigint;
  readonly freshForSeconds: bigint;
  readonly research: readonly ResearchEvidence[];
  readonly modelEvidence: ModelEvidence;
}

function evidenceOf(c: CardContext): OpportunityCard['evidence'] {
  return [...c.research.map((e) => ({ kind: e.kind, evidence: e.evidence, source: e.source })), { kind: 'INFERENCE', evidence: c.modelEvidence, source: 'opportunity analysis' }];
}

export function cardFromAnswer(c: CardContext, a: OpportunityAnswer, title: string | null): OpportunityCard {
  return {
    role: c.role,
    candidateId: a.candidateId,
    candidateTitle: a.action === 'PROPOSE' ? title : null,
    action: a.action,
    requestedAtoms: a.requestedAtoms,
    minimumUsefulAtoms: a.minimumUsefulAtoms,
    maximumUsefulAtoms: a.maximumUsefulAtoms,
    metrics: a.metrics,
    marketRegime: a.marketRegime,
    rationale: a.rationale,
    observedAt: c.observedAt,
    freshUntil: c.observedAt + c.freshForSeconds,
    evidence: evidenceOf(c),
    modelEvidence: c.modelEvidence,
    marketEvidence: 'FIXTURE',
    runtime: 'RESPONDED',
  };
}

/** A card for an agent that could not analyze: it abstains, with the runtime reason, and is given nothing. */
export function abstainingCard(c: CardContext, runtime: Exclude<CardRuntime, 'RESPONDED'>, rationale: string): OpportunityCard {
  return {
    role: c.role,
    candidateId: null,
    candidateTitle: null,
    action: 'ABSTAIN',
    requestedAtoms: 0n,
    minimumUsefulAtoms: 0n,
    maximumUsefulAtoms: 0n,
    metrics: NO_METRICS,
    marketRegime: 'UNKNOWN',
    rationale,
    observedAt: c.observedAt,
    freshUntil: c.observedAt + c.freshForSeconds,
    evidence: evidenceOf(c),
    modelEvidence: c.modelEvidence,
    marketEvidence: 'FIXTURE',
    runtime,
  };
}
