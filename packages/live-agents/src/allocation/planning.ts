/**
 * The Planning Room (docs/v2/mandate-room-v2.md §5): before the principal
 * signs, the agents they left the split to analyze their opportunities and
 * a deterministic allocator proposes budgets.
 *
 * ```text
 * per delegated agent, concurrently:
 *   discovered ─▶ actionable (eligibility) ─▶ executable (capability) ─▶ bounded by the agent's ceiling
 *   ─▶ research (FIXTURE / DATA_UNAVAILABLE) ─▶ model: OPPORTUNITY ─▶ OpportunityCard (strict)
 *   ─▶ Jev Score (optional, advisory, re-validated)
 * ─▶ allocate(pool, cards)  — deterministic, inside every cap
 * ─▶ ALLOCATION_PLAN_PROPOSED: budgets, what stays unallocated, why
 * ```
 *
 * The plan is advisory. It signs nothing, writes no ledger entry and grants
 * no authority; it is analyzed under a provisional, never-signed compilation
 * of the draft. Applying it only writes draft fields, which the principal
 * reviews, may edit, and then signs once.
 */

import { DOMAIN_AGENTS } from '../agents/index.ts';
import { actionableCandidates, type EligibilityFilter } from '../agents/eligibility.ts';
import { LIVE_LAB_SETTLEMENT_PROFILE, executableCandidates, type SettlementProfile } from '../agents/capability.ts';
import { viewOf, type TrustedCandidate } from '../agents/spec.ts';
import type { MandateView } from '../authoring/mandate-versioning.ts';
import { REVIEWED_BOUNDS } from '../authoring/catalog.ts';
import { authorityView } from '../context.ts';
import { reasonCodes } from '../mandate/verifier-adapter.ts';
import { callModel } from '../runtime/agent-runtime.ts';
import type { Clock } from '../runtime/clock.ts';
import { MAX_PRINCIPAL_INTENT, modelEvidenceOf, type AgentModelProvider, type OpportunityRequest, type PlanningPurpose } from '../runtime/provider.ts';
import { parseOpportunity } from '../runtime/schemas.ts';
import type { EventLog } from '../telemetry/events.ts';
import { revalidate, scoreBps, type JevScore, type OpportunityScorer } from '../jev/scorer.ts';
import { ROLE_LABELS, usdcText, type Role } from '../types.ts';
import { allocate, type AgentAllocation, type AllocationEntry } from './allocator.ts';
import { abstainingCard, cardFromAnswer, type CardContext, type OpportunityCard } from './card.ts';
import { researchView, type MarketResearchProvider } from './research.ts';

/** The never-signed compilation a Planning Room analyzes under (MandateVersions.provisional). */
export type ProvisionalMandate = MandateView;

export interface PlanningDeps {
  readonly provider: AgentModelProvider;
  readonly scorer: OpportunityScorer;
  readonly research: MarketResearchProvider;
  readonly clock: Clock;
  readonly events: EventLog;
  readonly protocolNow: () => bigint;
  readonly timeoutMs: number;
  readonly eligibility?: EligibilityFilter;
  readonly settlement?: SettlementProfile | null;
  readonly intent: string | null;
}

export interface PlanInput {
  readonly roomId: string;
  readonly purpose: PlanningPurpose;
  readonly provisional: ProvisionalMandate;
  /** The agents the principal left to the Room, in role order. */
  readonly pool: readonly Role[];
  readonly poolAtoms: bigint;
  /** The principal's own budgets: shown, never changed. */
  readonly fixed: readonly { readonly role: Role; readonly atoms: bigint }[];
  /** The most each pooled agent may hold under the draft's authority (ceiling, domain cap, own exposure). */
  readonly hardCaps: ReadonlyMap<Role, bigint>;
  /** What the plan was computed against; applying it to a different draft is refused. */
  readonly draftKey: string;
}

export interface AllocationPlan {
  readonly roomId: string;
  /** null for a pool of one: nobody to split with, so no Room opened. */
  readonly purpose: PlanningPurpose | null;
  readonly draftKey: string;
  readonly createdAt: bigint;
  /** The earliest card expiry: past it, the plan may not be applied. */
  readonly freshUntil: bigint;
  readonly poolAtoms: bigint;
  readonly fixed: readonly { readonly role: Role; readonly atoms: bigint }[];
  readonly cards: readonly OpportunityCard[];
  readonly scores: ReadonlyMap<Role, JevScore>;
  readonly allocations: readonly AgentAllocation[];
  readonly allocatedAtoms: bigint;
  readonly unallocatedAtoms: bigint;
  readonly explanation: string;
  readonly jev: OpportunityScorer['evidence'];
}

const view = (atoms: bigint) => ({ atoms, amount: usdcText(atoms) });

/** Candidates bounded to what the agent could be given: never above its cap, never one whose minimum exceeds it. */
export function boundedTo(candidates: readonly TrustedCandidate[], cap: bigint): readonly TrustedCandidate[] {
  return candidates.filter((c) => c.minAtoms <= cap).map((c) => (c.maxAtoms <= cap ? c : { ...c, maxAtoms: cap }));
}

/**
 * One agent's card. A runtime failure is an abstaining card, never a guess.
 * Exposed for the Reallocation Room, which asks the same question about
 * released capital.
 */
export async function analyzeOpportunity(deps: PlanningDeps, a: { readonly roomId: string; readonly purpose: PlanningPurpose; readonly mandate: MandateView; readonly role: Role; readonly candidates: readonly TrustedCandidate[]; readonly cap: bigint; readonly poolAtoms: bigint; readonly participants: readonly Role[] }): Promise<{ readonly card: OpportunityCard; readonly offered: readonly TrustedCandidate[] }> {
  const { role } = a;
  const spec = DOMAIN_AGENTS[role];
  const observedAt = deps.protocolNow();
  const emit = (kind: Parameters<EventLog['emit']>[0], data: { readonly [k: string]: unknown }) => deps.events.emit(kind, { agent: role, roomId: a.roomId, mandateVersion: null, data });
  const active = a.mandate;
  const universe = (deps.eligibility ?? actionableCandidates)(active, role, a.candidates, observedAt);
  const profile = deps.settlement === undefined ? LIVE_LAB_SETTLEMENT_PROFILE : deps.settlement;
  const offered = boundedTo(executableCandidates(profile, role, universe.actionable, observedAt).executable, a.cap);
  const authority = authorityView(active, role);
  const freshFor = BigInt(authority.maxQuoteAgeSeconds ?? REVIEWED_BOUNDS.maxQuoteAgeSeconds);
  const research = await deps.research.research(role, offered, observedAt);
  const ctx: CardContext = { role, observedAt, freshForSeconds: freshFor, research, modelEvidence: modelEvidenceOf(deps.provider.kind) };
  const candidateSummary = { discovered: universe.discovered.map((c) => c.id), actionable: universe.actionable.map((c) => c.id), excluded: universe.excluded.map((x) => ({ candidateId: x.candidate.id, reasons: reasonCodes(x.reasons) })), offered: offered.map((c) => c.id) };
  const done = (card: OpportunityCard) => {
    emit('OPPORTUNITY_CARD_CREATED', {
      roomPurpose: a.purpose,
      action: card.action,
      candidateId: card.candidateId,
      candidate: card.candidateTitle,
      requested: view(card.requestedAtoms),
      minimumUseful: view(card.minimumUsefulAtoms),
      maximumUseful: view(card.maximumUsefulAtoms),
      metrics: card.metrics,
      marketRegime: card.marketRegime,
      rationale: card.rationale,
      observedAt: card.observedAt,
      freshUntil: card.freshUntil,
      evidence: card.evidence,
      modelEvidence: card.modelEvidence,
      marketEvidence: card.marketEvidence,
      runtime: card.runtime,
      cap: view(a.cap),
      candidates: candidateSummary,
      authority: 'NONE — an analysis, not a proposal',
    });
    return { card, offered };
  };
  if (offered.length === 0) return done(abstainingCard(ctx, 'NO_CANDIDATES', 'No eligible, settleable opportunity fits within this agent\'s limit.'));
  const intent = deps.intent === null || deps.intent.trim() === '' ? null : deps.intent.trim().slice(0, MAX_PRINCIPAL_INTENT);
  const request: OpportunityRequest = {
    kind: 'OPPORTUNITY',
    role,
    objective: spec.objective,
    principalIntent: intent,
    purpose: a.purpose,
    authority: { ...authority, maxAllocationAtoms: a.cap.toString() },
    pool: { poolAtoms: a.poolAtoms.toString(), participants: a.participants },
    candidates: offered.map((c) => viewOf(c)),
    research: research.map(researchView),
  };
  const call = await callModel({ provider: deps.provider, request, parse: (t) => parseOpportunity(t, request), timeoutMs: deps.timeoutMs, clock: deps.clock });
  if (call.status !== 'RESPONDED') return done(abstainingCard(ctx, call.status, `No analysis: the model call ${call.status === 'TIMED_OUT' ? 'timed out' : call.status === 'FAILED' ? 'failed' : 'returned an invalid answer'}. Nothing is allocated to this agent.`));
  const chosen = offered.find((c) => c.id === call.value.candidateId) ?? null;
  return done(cardFromAnswer(ctx, call.value, chosen?.title ?? null));
}

/** Score a proposing card; abstainers are not scored. Every result is re-validated here. */
export async function scoreCard(deps: PlanningDeps, roomId: string, card: OpportunityCard, offered: readonly TrustedCandidate[]): Promise<JevScore | null> {
  if (card.action !== 'PROPOSE') return null;
  let s: JevScore;
  try {
    s = revalidate(await deps.scorer.score({ card, objective: DOMAIN_AGENTS[card.role].objective, principalIntent: deps.intent, facts: offered.find((c) => c.id === card.candidateId)?.facts ?? [] }));
  } catch {
    s = { status: 'UNAVAILABLE', reason: 'SCORER_THREW', latencyMs: 0 };
  }
  deps.events.emit('JEV_SCORE_RECORDED', {
    agent: card.role,
    roomId,
    mandateVersion: null,
    data: s.status === 'SCORED' ? { status: s.status, evidence: deps.scorer.evidence, scorer: deps.scorer.name, score: s.score, confidence: s.confidence, bps: s.bps, model: s.model, latencyMs: s.latencyMs, authority: 'NONE — advisory weight only' } : { status: s.status, evidence: 'JEV_UNAVAILABLE', scorer: deps.scorer.name, reason: s.reason, latencyMs: s.latencyMs, authority: 'NONE' },
  });
  return s;
}

const ZERO_TEXT: { readonly [k: string]: string } = {
  ABSTAINED: 'abstained: no opportunity met its bar',
  NO_DATA_CONFIDENCE: 'no confidence in the available evidence',
  BELOW_UTILITY_THRESHOLD: 'too weak a risk-adjusted case',
  NO_CAPACITY: 'no useful size fits within its limit',
  BELOW_MINIMUM_USEFUL: 'its share would be below the smallest useful position',
};

/** Why this split, in a sentence or two — from the allocator's own numbers, never from model prose. */
export function explainPlan(allocations: readonly AgentAllocation[], cards: readonly OpportunityCard[], unallocated: bigint): string {
  const funded = allocations.filter((a) => a.atoms > 0n).sort((x, y) => (y.weight > x.weight ? 1 : y.weight < x.weight ? -1 : 0));
  const parts: string[] = [];
  if (funded.length === 0) parts.push('No agent made a strong enough case: nothing is allocated, and the whole pool stays in your wallet.');
  else {
    const top = funded.filter((a) => a.weight === funded[0]?.weight).map((a) => ROLE_LABELS[a.role].replace(' Agent', ''));
    if (funded.length > 1 && top.length < funded.length) parts.push(`${top.join(' and ')} received more capital because ${top.length > 1 ? 'their' : 'its'} opportunity and execution ratings were strongest under your objective.`);
    else if (funded.length > 1) parts.push('The funded agents made equally strong cases and share the pool by weight.');
    const capped = funded.filter((a) => a.capped).map((a) => ROLE_LABELS[a.role].replace(' Agent', ''));
    if (capped.length > 0) parts.push(`${capped.join(' and ')} ${capped.length > 1 ? 'are' : 'is'} at the most ${capped.length > 1 ? 'they' : 'it'} can usefully take.`);
  }
  for (const a of allocations.filter((x) => x.zero !== null)) {
    const regime = cards.find((c) => c.role === a.role)?.marketRegime;
    parts.push(`${ROLE_LABELS[a.role].replace(' Agent', '')}: ${ZERO_TEXT[a.zero as string] ?? 'nothing allocated'}${regime === 'STRESSED' ? ' (stressed conditions)' : ''}.`);
  }
  if (unallocated > 0n && funded.length > 0) parts.push(`${usdcText(unallocated)} USDC stays unallocated in your wallet.`);
  return parts.join(' ');
}

export async function runPlanning(deps: PlanningDeps, input: PlanInput): Promise<AllocationPlan> {
  const { roomId, purpose, pool, poolAtoms } = input;
  const room = pool.length >= 2;
  const emit = (kind: Parameters<EventLog['emit']>[0], data: { readonly [k: string]: unknown }) => deps.events.emit(kind, { roomId, mandateVersion: null, data });
  const createdAt = deps.protocolNow();
  if (room) {
    emit('ROOM_OPENED', {
      roomPurpose: purpose,
      stage: 'PRE_AUTHORIZATION',
      autonomous: true,
      authority: 'NONE — proposes a split for you to review; signs nothing',
      reason: purpose === 'HYBRID_ALLOCATION' ? 'You fixed some budgets and left the rest to these agents.' : 'You gave these agents a shared pool and left the split to them.',
      participants: pool.map((r) => ({ role: r, cap: view(input.hardCaps.get(r) ?? 0n) })),
      pool: view(poolAtoms),
      fixed: input.fixed.map((f) => ({ role: f.role, budget: view(f.atoms) })),
      jev: deps.scorer.evidence,
      research: deps.research.name,
    });
  }
  const analyzed = await Promise.all(pool.map((role) => analyzeOpportunity(deps, { roomId, purpose, mandate: input.provisional, role, candidates: DOMAIN_AGENTS[role].candidates, cap: input.hardCaps.get(role) ?? 0n, poolAtoms, participants: pool })));
  const scored = await Promise.all(analyzed.map((x) => scoreCard(deps, roomId, x.card, x.offered)));
  const scores = new Map<Role, JevScore>();
  analyzed.forEach((x, i) => {
    const s = scored[i];
    if (s !== null && s !== undefined) scores.set(x.card.role, s);
  });
  const entries: AllocationEntry[] = analyzed.map((x) => ({ card: x.card, jevBps: scoreBps(scores.get(x.card.role) ?? null), hardCapAtoms: input.hardCaps.get(x.card.role) ?? 0n }));
  const r = allocate(poolAtoms, entries);
  const cards = analyzed.map((x) => x.card);
  const freshUntil = cards.reduce((m, c) => (c.freshUntil < m ? c.freshUntil : m), cards[0]?.freshUntil ?? createdAt);
  // An incoherent or malformed input proposes nothing: the whole pool stays unallocated.
  const allocations: readonly AgentAllocation[] = r.ok ? r.allocations : cards.map((c) => ({ role: c.role, atoms: 0n, weight: 0n, utility: 0, capAtoms: 0n, zero: 'NO_CAPACITY' as const, capped: false }));
  const allocatedAtoms = r.ok ? r.allocatedAtoms : 0n;
  const unallocatedAtoms = poolAtoms - allocatedAtoms;
  const explanation = r.ok ? explainPlan(allocations, cards, unallocatedAtoms) : `No split could be proposed (${r.reason}). Nothing is allocated; ask the agents again.`;
  emit('ALLOCATION_PLAN_PROPOSED', {
    roomPurpose: room ? purpose : null,
    stage: 'PRE_AUTHORIZATION',
    pool: view(poolAtoms),
    fixed: input.fixed.map((f) => ({ role: f.role, budget: view(f.atoms) })),
    budgets: allocations.map((a) => ({ role: a.role, budget: view(a.atoms), cap: view(a.capAtoms), zero: a.zero, capped: a.capped, rationale: cards.find((c) => c.role === a.role)?.rationale ?? null })),
    allocated: view(allocatedAtoms),
    unallocated: view(unallocatedAtoms),
    explanation,
    allocator: r.ok ? 'DETERMINISTIC' : `REFUSED:${r.reason}`,
    freshUntil,
    note: room ? null : 'SINGLE_AGENT_POOL: one agent, nobody to split with — no Room opened.',
    authority: 'NONE — review and edit before you sign; only your signature authorizes',
  });
  if (room) emit('ROOM_FINALIZED', { roomPurpose: purpose, result: 'PLAN_PROPOSED', stage: 'PRE_AUTHORIZATION', generations: 1, replies: cards.length, timeouts: cards.filter((c) => c.runtime === 'TIMED_OUT').length, failures: cards.filter((c) => c.runtime === 'FAILED' || c.runtime === 'INVALID_RESPONSE').length });
  return { roomId, purpose: room ? purpose : null, draftKey: input.draftKey, createdAt, freshUntil, poolAtoms, fixed: input.fixed, cards, scores, allocations, allocatedAtoms, unallocatedAtoms, explanation, jev: deps.scorer.evidence };
}
