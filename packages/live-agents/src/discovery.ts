/**
 * Concurrent discovery: every enabled agent at once, none waiting for
 * another.
 *
 * Per agent:
 *
 * ```text
 * observe candidates (quote time = now) ─▶ model call (bounded, streamed, validated)
 *   ─▶ PROPOSE: exact lookup ─▶ build under the version it was asked under ─▶ local signature
 *   ─▶ screen under the version active *now* (the frozen screenProposal)
 *        BLOCKED     security invalid; never enters the Room
 *        ADMISSIBLE  individually valid (maybe portfolio invalid); may be negotiated
 *        STALE       the mandate changed meanwhile: Mandate refuses the old digest; REAUTHORIZE_REQUIRED
 * ```
 *
 * A runtime failure (timeout, provider failure, invalid answer) is recorded
 * as such and produces no proposal; it is never a Mandate refusal.
 */

import { candidateDigest, proposalDigest, validateActionCandidate, type SignedProposal } from '@mandate/portfolio';
import type { ActiveMandate } from './authoring/mandate-versioning.ts';
import { DOMAIN_AGENTS } from './agents/index.ts';
import { candidateById, viewOf, type TrustedCandidate } from './agents/spec.ts';
import { amountViews, authorityView, portfolioView } from './context.ts';
import { applyAdvice, type JevAdvisor } from './jev/advisor.ts';
import { buildProposal, type SequenceBook } from './mandate/proposal-builder.ts';
import type { LocalAgentSigner } from './mandate/signer.ts';
import { reasonCodes, screen, type ScreenResult } from './mandate/verifier-adapter.ts';
import { callModel } from './runtime/agent-runtime.ts';
import type { Clock } from './runtime/clock.ts';
import type { AgentModelProvider, DecisionRequest } from './runtime/provider.ts';
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
}

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
}

export async function discoverAgent(deps: DiscoveryDeps, active: ActiveMandate, role: Role, o: DiscoveryOptions = {}): Promise<AgentOutcome> {
  const { clock, events } = deps;
  const spec = DOMAIN_AGENTS[role];
  const candidates = o.candidates ?? spec.candidates;
  const observedAt = deps.protocolNow();
  const emit = (kind: Parameters<EventLog['emit']>[0], data: { readonly [k: string]: unknown }) => events.emit(kind, { agent: role, mandateVersion: active.version, data });
  const base = { role, version: active.version, observedAt } as const;

  const advice = await deps.jev.rank(role, candidates.map((c) => viewOf(c)));
  const views = applyAdvice(candidates.map((c) => viewOf(c)), advice);
  const request: DecisionRequest = { kind: 'DECISION', role, objective: spec.objective, authority: authorityView(active, role), portfolio: await portfolioView(active, observedAt), candidates: views };
  emit('AGENT_REQUEST_STARTED', { provider: deps.provider.name, providerKind: deps.provider.kind, model: deps.provider.model, candidates: views.map((v) => v.id), quoteObservedAt: observedAt, jev: advice === null ? null : advice.source });

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

  const candidate = candidateById({ ...spec, candidates }, decision.candidateId ?? '');
  const size = decision.requestedAtoms ?? 0n;
  if (candidate === null) return end('INVALID_RESPONSE', { decision, error: 'candidate lookup failed' });
  emit('AGENT_DECISION_COMPLETED', { candidateId: candidate.id, candidate: candidate.title, requested: { atoms: size, amount: usdcText(size) }, rationale: decision.rationale, ...latency });

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
