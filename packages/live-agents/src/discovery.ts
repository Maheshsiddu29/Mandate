/**
 * Concurrent discovery: every enabled agent at once, none waiting for
 * another.
 *
 * Per agent:
 *
 * ```text
 * observe candidates (quote time = now)
 *   ─▶ eligibility: discovered ─▶ actionable (agents/eligibility.ts; policy, advisory, deterministic)
 *        none actionable  ABSTAINED without a model call
 *   ─▶ capability: actionable ─▶ executable (agents/capability.ts; the active settlement profile, no authority)
 *        none executable  ABSTAINED without a model call
 *   ─▶ model call over the executable candidates only (bounded, streamed, validated)
 *   ─▶ PROPOSE: exact lookup ─▶ build under the version it was asked under ─▶ local signature
 *   ─▶ screen under the version active *now* (the frozen screenProposal)
 *        BLOCKED     security invalid; never enters the Room
 *        ADMISSIBLE  individually valid (maybe portfolio invalid); may be negotiated
 *        STALE       the mandate changed meanwhile: Mandate refuses the old digest; REAUTHORIZE_REQUIRED
 * ```
 *
 * A runtime failure (timeout, provider failure, invalid answer) is recorded
 * as such and produces no proposal; it is never a Mandate refusal.
 *
 * Eligibility and capability narrow what the model optimizes over; neither
 * authorizes anything. The model's choice is looked up exactly — never
 * replaced by another candidate — and its proposal is screened in full
 * whatever either filter said.
 */

import { candidateDigest, proposalDigest, validateActionCandidate, type SignedProposal } from '@mandate/portfolio';
import type { ActiveMandate } from './authoring/mandate-versioning.ts';
import { DOMAIN_AGENTS } from './agents/index.ts';
import { actionableCandidates, type EligibilityFilter } from './agents/eligibility.ts';
import { LIVE_LAB_SETTLEMENT_PROFILE, executableCandidates, type SettlementProfile } from './agents/capability.ts';
import { candidateById, viewOf, type TrustedCandidate } from './agents/spec.ts';
import { boundedTo } from './allocation/planning.ts';
import { amountViews, authorityView, portfolioView } from './context.ts';
import { applyAdvice, type JevAdvisor } from './jev/advisor.ts';
import { buildProposal, type SequenceBook } from './mandate/proposal-builder.ts';
import type { LocalAgentSigner } from './mandate/signer.ts';
import { reasonCodes, screen, type ScreenResult } from './mandate/verifier-adapter.ts';
import { callModel } from './runtime/agent-runtime.ts';
import type { Clock } from './runtime/clock.ts';
import { MAX_PRINCIPAL_INTENT, modelEvidenceOf, type AgentModelProvider, type DecisionRequest } from './runtime/provider.ts';
import { parseDecision, type AgentDecision } from './runtime/schemas.ts';
import type { EventLog } from './telemetry/events.ts';
import { agentTiming, type AgentTiming } from './telemetry/latency.ts';
import { usdcText, type AgentRuntimeState, type Role } from './types.ts';

export interface DiscoveryDeps {
  readonly provider: AgentModelProvider;
  readonly jev: JevAdvisor;
  readonly clock: Clock;
  readonly events: EventLog;
  readonly signers: ReadonlyMap<Role, LocalAgentSigner>;
  readonly sequences: SequenceBook;
  readonly protocolNow: () => bigint;
  readonly timeoutMs: number;
  /** The version active at this moment, or null when paused. */
  readonly current: () => ActiveMandate | null;
  /** Discovered → actionable. Defaults to the deterministic filter; adversarial tests replace it to show screening stands alone. */
  readonly eligibility?: EligibilityFilter;
  /** The principal's stated preference for this session, passed to the models as ranking guidance; null for none. */
  readonly intent?: string | null;
  /**
   * The active settlement profile: actionable → executable. Defaults to the
   * Live Lab profile. `null` evaluates no capability: for adversarial tests
   * that must reach Mandate's screening with a candidate no connector settles.
   */
  readonly settlement?: SettlementProfile | null;
  /** The agent's budget under the signed plan (allocation/intent.ts), or null: its candidates are bounded to it. */
  readonly budgetOf?: (role: Role) => bigint | null;
}

/** The declared reason when eligibility leaves nothing to choose from. */
export const NO_ELIGIBLE_OPPORTUNITIES = 'No eligible opportunities under this mandate.';
/** The declared reason when every actionable candidate is one the active connector cannot settle. */
export const NO_EXECUTABLE_OPPORTUNITIES = 'No opportunity under this mandate can be settled by the active connector.';

export interface AgentOutcome {
  readonly role: Role;
  /** The version the agent was asked under. */
  readonly version: number;
  readonly state: AgentRuntimeState;
  readonly decision: AgentDecision | null;
  readonly candidate: TrustedCandidate | null;
  readonly sizeAtoms: bigint;
  /** When the candidate's quote was observed: the context's construction time. */
  readonly observedAt: bigint;
  readonly signed: SignedProposal | null;
  readonly screening: ScreenResult | null;
  readonly error: string | null;
  readonly timing: AgentTiming | null;
}

export interface DiscoveryOptions {
  /** Replace the candidate set (a refresh offers the same candidate, bounded by what the Room agreed). */
  readonly candidates?: readonly TrustedCandidate[];
  /** A local re-plan: the agent's own limit, shown to the model (room/classify.ts). */
  readonly localConstraint?: DecisionRequest['localConstraint'];
}

export async function discoverAgent(deps: DiscoveryDeps, active: ActiveMandate, role: Role, o: DiscoveryOptions = {}): Promise<AgentOutcome> {
  const { clock, events } = deps;
  const spec = DOMAIN_AGENTS[role];
  const observedAt = deps.protocolNow();
  const emit = (kind: Parameters<EventLog['emit']>[0], data: { readonly [k: string]: unknown }) => events.emit(kind, { agent: role, mandateVersion: active.version, data });
  const base = { role, version: active.version, observedAt } as const;

  // Discovery is broad; the model is offered only what could be authorized and then settled. The rest remain evidence.
  const universe = (deps.eligibility ?? actionableCandidates)(active, role, o.candidates ?? spec.candidates, observedAt);
  const profile = deps.settlement === undefined ? LIVE_LAB_SETTLEMENT_PROFILE : deps.settlement;
  const live = executableCandidates(profile, role, universe.actionable, observedAt);
  // A budget bounds what the agent is offered: never a candidate it could not afford, never more than its budget.
  const budget = deps.budgetOf?.(role) ?? null;
  const candidates = budget === null ? live.executable : boundedTo(live.executable, budget);
  emit('AGENT_CANDIDATES_EVALUATED', {
    basis: 'ADVISORY',
    marketEvidence: [...new Set(universe.discovered.map((c) => c.marketEvidence))],
    discovered: universe.discovered.map((c) => c.id),
    actionable: universe.actionable.map((c) => c.id),
    excluded: universe.excluded.map((x) => ({ candidateId: x.candidate.id, candidate: x.candidate.title, reasons: reasonCodes(x.reasons) })),
    settlementProfile: profile?.id ?? null,
    executable: candidates.map((c) => c.id),
    capability: live.capability.map((c) => ({ candidateId: c.candidateId, status: c.status, connector: c.connector, reason: c.reason })),
    budget: budget === null ? null : { atoms: budget, amount: usdcText(budget) },
    localConstraint: o.localConstraint ?? null,
  });
  if (universe.actionable.length === 0) {
    // Nothing to choose from: no model call, no placeholder candidate, no proposal.
    emit('AGENT_ABSTAINED', { rationale: NO_ELIGIBLE_OPPORTUNITIES, cause: 'NO_ACTIONABLE_CANDIDATES', modelCalled: false });
    return { ...base, state: 'ABSTAINED', decision: null, candidate: null, sizeAtoms: 0n, signed: null, screening: null, error: null, timing: null };
  }
  if (candidates.length === 0 && live.executable.length > 0) {
    // Settleable, but nothing fits within the budget the principal signed: nothing to choose.
    emit('AGENT_ABSTAINED', { rationale: 'No opportunity fits within this agent\'s budget.', cause: 'NO_CANDIDATE_WITHIN_BUDGET', modelCalled: false });
    return { ...base, state: 'ABSTAINED', decision: null, candidate: null, sizeAtoms: 0n, signed: null, screening: null, error: null, timing: null };
  }
  if (candidates.length === 0) {
    // Allowed, but nothing the active connector can settle: never offered as executable.
    emit('AGENT_ABSTAINED', { rationale: NO_EXECUTABLE_OPPORTUNITIES, cause: 'NO_EXECUTABLE_CANDIDATES', modelCalled: false });
    return { ...base, state: 'ABSTAINED', decision: null, candidate: null, sizeAtoms: 0n, signed: null, screening: null, error: null, timing: null };
  }

  const advice = await deps.jev.rank(role, candidates.map((c) => viewOf(c)));
  const views = applyAdvice(candidates.map((c) => viewOf(c)), advice);
  const principalIntent = deps.intent === undefined || deps.intent === null || deps.intent.trim() === '' ? null : deps.intent.trim().slice(0, MAX_PRINCIPAL_INTENT);
  const request: DecisionRequest = { kind: 'DECISION', role, objective: spec.objective, principalIntent, authority: authorityView(active, role), portfolio: await portfolioView(active, observedAt), candidates: views, ...(budget === null ? {} : { budgetAtoms: budget.toString() }), ...(o.localConstraint === undefined ? {} : { localConstraint: o.localConstraint }) };
  const modelEvidence = modelEvidenceOf(deps.provider.kind);
  emit('AGENT_REQUEST_STARTED', { provider: deps.provider.name, providerKind: deps.provider.kind, model: deps.provider.model, modelEvidence, candidates: views.map((v) => v.id), principalIntent, quoteObservedAt: observedAt, jev: advice === null ? null : advice.source });

  const call = await callModel({
    provider: deps.provider,
    request,
    parse: (t) => parseDecision(t, request),
    timeoutMs: deps.timeoutMs,
    clock,
    onFirstChunk: () => emit('AGENT_FIRST_RESPONSE', {}),
  });
  const end = (state: AgentRuntimeState, extra: Partial<AgentOutcome>, marks: { signedAt?: string; signedMs?: number; screenedAt?: string; screenedMs?: number } = {}): AgentOutcome => ({
    ...base,
    state,
    decision: null,
    candidate: null,
    sizeAtoms: 0n,
    signed: null,
    screening: null,
    error: null,
    ...extra,
    timing: agentTiming(deps.provider, call.timing, { signedAt: marks.signedAt ?? null, signedMs: marks.signedMs ?? null, screenedAt: marks.screenedAt ?? null, screenedMs: marks.screenedMs ?? null, endMs: clock.nowMs() }),
  });
  const latency = { providerLatencyMs: call.timing.providerLatencyMs, timeToFirstResponseMs: call.timing.timeToFirstResponseMs, injectedLatencyMs: call.timing.injectedLatencyMs };

  if (call.status !== 'RESPONDED') {
    const kind = call.status === 'TIMED_OUT' ? 'AGENT_TIMED_OUT' : call.status === 'FAILED' ? 'AGENT_FAILED' : 'AGENT_INVALID_RESPONSE';
    emit(kind, call.status === 'TIMED_OUT' ? { timeoutMs: deps.timeoutMs, ...latency } : { error: call.error, ...latency });
    return end(call.status, { error: call.error });
  }
  const decision = call.value;
  if (decision.action === 'ABSTAIN') {
    emit('AGENT_ABSTAINED', { rationale: decision.rationale, ...latency });
    return end('ABSTAINED', { decision });
  }

  // Exact lookup among the candidates offered: the proposal is for the candidate the model chose, or nothing.
  const candidate = candidateById({ ...spec, candidates }, decision.candidateId ?? '');
  const size = decision.requestedAtoms ?? 0n;
  if (candidate === null) return end('INVALID_RESPONSE', { decision, error: 'candidate lookup failed' });
  emit('AGENT_DECISION_COMPLETED', { candidateId: candidate.id, candidate: candidate.title, requested: { atoms: size, amount: usdcText(size) }, rationale: decision.rationale, alternatives: candidates.filter((c) => c !== candidate).map((c) => c.id), modelEvidence, marketEvidence: candidate.marketEvidence, ...latency });

  // Build under the version the agent was asked under; sign locally.
  const signer = deps.signers.get(role);
  const input = candidate.build(size, observedAt);
  const built = signer === undefined ? null : buildProposal({ mandate: active.mandate, bindings: active.compiled.bindings, agent: signer.party, candidate: input, sizeAtoms: size, minimumAtoms: candidate.resizable ? candidate.minAtoms : size, sequence: deps.sequences.next(signer.party), now: deps.protocolNow() });
  if (signer === undefined || built === null || !built.ok) return end('INVALID_RESPONSE', { decision, candidate, sizeAtoms: size, error: built !== null && !built.ok ? built.error : 'no signer' });
  const signed = signer.sign(built.proposal);
  const signedMs = clock.nowMs();
  const signedAt = clock.wallIso();
  const c = validateActionCandidate(input);
  emit('PROPOSAL_SIGNED', { proposal: proposalDigest(signed.proposal), candidate: c.ok ? candidateDigest(c.value) : null, signer: signer.party.value, sequence: signed.proposal.sequence, requested: amountViews(built.demand) });

  // Screen under the version active now.
  const now = deps.protocolNow();
  const current = deps.current();
  const judge = current ?? active;
  const s = screen(judge.mandate, judge.compiled.bindings, signed, now);
  const screenedMs = clock.nowMs();
  const marks = { signedAt, signedMs, screenedAt: clock.wallIso(), screenedMs };
  const common = { decision, candidate, sizeAtoms: size, signed, screening: s };
  if (current === null || current.version !== active.version) {
    emit('PROPOSAL_STALE', { cause: current === null ? 'MANDATE_PAUSED' : 'MANDATE_SUPERSEDED', askedUnder: active.version, screenedUnder: current?.version ?? null, reasons: reasonCodes(s.reasons), next: 'REAUTHORIZE_REQUIRED' });
    return end('STALE', common, marks);
  }
  if (s.verdict === 'BLOCKED') {
    emit('PROPOSAL_BLOCKED', { proposal: proposalDigest(signed.proposal), reasons: reasonCodes(s.reasons), individuallyValid: false });
    return end('BLOCKED', common, marks);
  }
  emit('PROPOSAL_ADMISSIBLE', { proposal: proposalDigest(signed.proposal), demand: amountViews(s.demand), individuallyValid: s.individuallyValid, portfolioValid: s.portfolioValid, reasons: reasonCodes(s.reasons) });
  return end('ADMISSIBLE', common, marks);
}

/** All agents at once. Completion order is whatever the providers' latency makes it. */
export function discover(deps: DiscoveryDeps, active: ActiveMandate, roles: readonly Role[]): Promise<readonly AgentOutcome[]> {
  return Promise.all(roles.map((r) => discoverAgent(deps, active, r)));
}
