/**
 * The live Mandate Room coordinator (docs/demo/live-ai-lab.md §6).
 *
 * Autonomous: no human is asked anything. Each generation asks every
 * participant at once, validates each answer as it arrives, and closes as
 * soon as the requests — the answers so far, everyone else unchanged — fit;
 * or when every participant has answered or timed out; or when the mandate
 * is superseded. A pending or timed-out agent is *unchanged*: never forced
 * to reduce, never treated as releasing, never given more than it signed
 * for. If no generation fits, the result is NO_FEASIBLE_PORTFOLIO.
 *
 * The coordinator has no authority. Its PROPOSED result is a set of sizes
 * that the session turns into freshly signed proposals and hands to the
 * frozen `runPortfolio` — the real Room, verifier and ledger.
 */

import { headroom, type ResourceAvailability } from '@mandate/portfolio';
import { DOMAIN_AGENTS } from '../agents/index.ts';
import { usdcText, type Role } from '../types.ts';
import { callModel, type CallOutcome } from '../runtime/agent-runtime.ts';
import type { Clock } from '../runtime/clock.ts';
import type { AgentModelProvider, NegotiationRequest } from '../runtime/provider.ts';
import { parseNegotiation, type NegotiationDecision } from '../runtime/schemas.ts';
import type { EventLog } from '../telemetry/events.ts';
import { GenerationGate } from './generation.ts';
import { assess, permittedActions, type DemandAt, type Fit, type Participant } from './negotiation.ts';

export const DEFAULT_MAX_GENERATIONS = 3;

export interface RoomDeps {
  readonly provider: AgentModelProvider;
  readonly clock: Clock;
  readonly events: EventLog;
  readonly roundTimeoutMs: number;
  readonly maxGenerations: number;
  /** Aborted when the mandate the Room negotiates under is superseded or paused. */
  readonly superseded: AbortSignal;
}

export interface RoomInput {
  readonly roomId: string;
  readonly version: number;
  readonly participants: readonly Participant[];
  readonly availability: ResourceAvailability;
  readonly demandAt: DemandAt;
}

export interface ReplyRecord {
  readonly generation: number;
  readonly role: Role;
  readonly status: 'RESPONDED' | 'TIMED_OUT' | 'FAILED' | 'INVALID_RESPONSE' | 'STALE' | 'IGNORED';
  readonly action: string | null;
  readonly elapsedMs: number;
  readonly providerLatencyMs: number | null;
  readonly injectedLatencyMs: number;
}

export interface RoomStats {
  readonly generations: number;
  readonly durationMs: number;
  readonly replies: readonly ReplyRecord[];
  readonly requiredAtoms: bigint;
  readonly offeredAtoms: bigint;
}

export type RoomResult =
  | { readonly status: 'PROPOSED'; readonly requests: ReadonlyMap<Role, bigint>; readonly fit: Fit; readonly stats: RoomStats; readonly drain: () => Promise<void> }
  | { readonly status: 'NO_FEASIBLE_PORTFOLIO' | 'SUPERSEDED'; readonly requests: ReadonlyMap<Role, bigint>; readonly fit: Fit; readonly stats: RoomStats; readonly drain: () => Promise<void> };

const text = (atoms: bigint) => ({ atoms, amount: usdcText(atoms) });

export async function runLiveRoom(deps: RoomDeps, input: RoomInput): Promise<RoomResult> {
  const { clock, events } = deps;
  const { roomId, participants, availability: av, demandAt } = input;
  const gate = new GenerationGate(roomId);
  const startMs = clock.nowMs();
  const requests = new Map<Role, bigint>(participants.map((p) => [p.role, p.originalAtoms]));
  const replies: ReplyRecord[] = [];
  const outstanding: Promise<void>[] = [];
  const initial = assess(participants, requests, av, demandAt);
  const emit = (kind: Parameters<EventLog['emit']>[0], generation: number | null, data: { readonly [k: string]: unknown }, agent: Role | null = null) => events.emit(kind, { roomId, generation, agent, mandateVersion: input.version, data });
  const stats = (): RoomStats => ({
    generations: gate.generation,
    durationMs: Math.round(clock.nowMs() - startMs),
    replies,
    requiredAtoms: initial.requiredAtoms,
    offeredAtoms: participants.reduce((s, p) => s + (p.originalAtoms - (requests.get(p.role) ?? 0n)), 0n),
  });
  const drain = async () => {
    await Promise.all(outstanding);
  };

  emit('ROOM_OPENED', null, {
    autonomous: true,
    participants: participants.map((p) => ({ role: p.role, candidate: p.candidate.id, request: text(p.originalAtoms), minimum: text(p.minimumAtoms) })),
    authority: text(initial.authorityAtoms),
    admissibleDemand: text(initial.demandAtoms),
    requiredReduction: text(initial.requiredAtoms),
    constraints: initial.lines,
    agentExcess: initial.agentExcess.map((x) => ({ ...x, requestedAtoms: x.requestedAtoms.toString(), limitAtoms: x.limitAtoms.toString() })),
  });

  const finish = (status: RoomResult['status'], fit: Fit): RoomResult => {
    gate.finalize();
    if (status === 'PROPOSED') {
      emit('ROOM_PROPOSAL_CREATED', gate.generation, {
        requests: participants.map((p) => ({ role: p.role, from: text(p.originalAtoms), to: text(requests.get(p.role) ?? 0n) })),
        requiredReduction: text(initial.requiredAtoms),
        offeredReduction: text(stats().offeredAtoms),
        demand: text(fit.demandAtoms),
        authority: text(fit.authorityAtoms),
        next: 'MANDATE_REVERIFICATION',
      });
    }
    if (status === 'NO_FEASIBLE_PORTFOLIO') {
      emit('ROOM_NO_FEASIBLE_PORTFOLIO', gate.generation, { requiredReduction: text(initial.requiredAtoms), offeredReduction: text(stats().offeredAtoms), remaining: fit.lines.filter((l) => l.requiredReductionAtoms !== '0'), agentExcess: fit.agentExcess.map((x) => ({ role: x.role, resource: x.resource })), execution: 'NONE' });
    }
    const s = stats();
    emit('ROOM_FINALIZED', gate.generation, { result: status, generations: s.generations, durationMs: s.durationMs, replies: s.replies.length, timeouts: s.replies.filter((r) => r.status === 'TIMED_OUT').length, failures: s.replies.filter((r) => r.status === 'FAILED' || r.status === 'INVALID_RESPONSE').length });
    return { status, requests, fit, stats: s, drain };
  };

  for (let g = 0; g < deps.maxGenerations; g += 1) {
    if (deps.superseded.aborted) return finish('SUPERSEDED', assess(participants, requests, av, demandAt));
    const generation = gate.open();
    const before = assess(participants, requests, av, demandAt);
    const active = participants.filter((p) => (requests.get(p.role) ?? 0n) > 0n);
    emit('ROOM_GENERATION_STARTED', generation, { participants: active.map((p) => p.role), admissibleDemand: text(before.demandAtoms), requiredReduction: text(before.requiredAtoms), constraints: before.lines, roundTimeoutMs: deps.roundTimeoutMs });

    const answers = new Map<Role, NegotiationDecision>();
    const pending = new Set<Role>(active.map((p) => p.role));
    // Mutated from reply callbacks: kept in an object so the type is not narrowed away.
    const round: { closed: 'FEASIBLE' | 'ALL_ANSWERED' | 'SUPERSEDED' | null } = { closed: null };
    let close: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      close = resolve;
    });
    const tryClose = () => {
      if (round.closed !== null) return;
      const tentative = new Map(requests);
      for (const [r, a] of answers) tentative.set(r, a.newAtoms);
      if (assess(participants, tentative, av, demandAt).feasible) round.closed = 'FEASIBLE';
      else if (pending.size === 0) round.closed = 'ALL_ANSWERED';
      if (round.closed !== null) close();
    };
    const onAbort = () => {
      if (round.closed === null) {
        round.closed = 'SUPERSEDED';
        close();
      }
    };
    deps.superseded.addEventListener('abort', onAbort, { once: true });

    const record = (p: Participant, gen: number, status: ReplyRecord['status'], action: string | null, o: CallOutcome<NegotiationDecision> | null) =>
      replies.push({ generation: gen, role: p.role, status, action, elapsedMs: Math.round(clock.nowMs() - startMs), providerLatencyMs: o?.timing.providerLatencyMs ?? null, injectedLatencyMs: o?.timing.injectedLatencyMs ?? 0 });

    const ignored = (p: Participant, gen: number, o: CallOutcome<NegotiationDecision>, late: boolean) => {
      const status = gate.classify(roomId, gen);
      const reason = late ? 'ANSWERED_AFTER_TIMEOUT' : status === 'FINALIZED' ? 'ROOM_FINALIZED' : gen < gate.generation ? 'LATER_GENERATION_STARTED' : 'GENERATION_CLOSED';
      record(p, gen, status === 'FINALIZED' || reason === 'GENERATION_CLOSED' ? 'IGNORED' : 'STALE', o.status === 'RESPONDED' ? o.value.action : null, o);
      emit('ROOM_AGENT_STALE_RESPONSE', gen, { answeredGeneration: gen, currentGeneration: gate.generation, finalized: gate.finalized, reason, action: o.status === 'RESPONDED' ? o.value.action : o.status, effect: 'IGNORED' }, p.role);
    };

    for (const p of active) {
      const current = requests.get(p.role) ?? 0n;
      const own = headroom(av, p.agent.value, 'portfolio-notional');
      const request: NegotiationRequest = {
        kind: 'NEGOTIATION',
        role: p.role,
        objective: DOMAIN_AGENTS[p.role].objective,
        roomId,
        generation,
        portfolioAuthorityAtoms: before.authorityAtoms.toString(),
        admissibleDemandAtoms: before.demandAtoms.toString(),
        requiredReductionAtoms: before.requiredAtoms.toString(),
        constraints: before.lines,
        candidateTitle: p.candidate.title,
        yourCurrentAtoms: current.toString(),
        yourMinimumAtoms: (p.minimumAtoms < current ? p.minimumAtoms : current).toString(),
        yourOwnLimitAtoms: own.toString(),
        permittedActions: permittedActions(p),
        participants: active.filter((x) => x.role !== p.role).map((x) => ({ role: x.role, currentAtoms: (requests.get(x.role) ?? 0n).toString() })),
      };
      const gen = generation;
      const call = callModel({
        provider: deps.provider,
        request,
        parse: (t) => parseNegotiation(t, request),
        timeoutMs: deps.roundTimeoutMs,
        clock,
        onLate: (late) => ignored(p, gen, late, true),
        track: (settled) => outstanding.push(settled),
      }).then((o) => {
        // A reply that lands after this generation decided to close changes nothing, even before the gate records it.
        if (gate.classify(roomId, gen) !== 'CURRENT' || round.closed !== null) {
          ignored(p, gen, o, false);
          return;
        }
        pending.delete(p.role);
        const latency = { providerLatencyMs: o.timing.providerLatencyMs, injectedLatencyMs: o.timing.injectedLatencyMs };
        if (o.status === 'RESPONDED') {
          answers.set(p.role, o.value);
          record(p, gen, 'RESPONDED', o.value.action, o);
          const change = { from: text(current), to: text(o.value.newAtoms), rationale: o.value.rationale, ...latency };
          emit('ROOM_AGENT_RESPONSE', gen, { action: o.value.action, ...change }, p.role);
          if (o.value.action === 'KEEP') emit('ROOM_KEEP', gen, change, p.role);
          if (o.value.action === 'REDUCE') emit('ROOM_REDUCTION', gen, { ...change, offered: text(current - o.value.newAtoms) }, p.role);
          if (o.value.action === 'RELEASE') emit('ROOM_RELEASE', gen, { ...change, offered: text(current) }, p.role);
        } else if (o.status === 'TIMED_OUT') {
          record(p, gen, 'TIMED_OUT', null, o);
          emit('ROOM_AGENT_TIMEOUT', gen, { timeoutMs: deps.roundTimeoutMs, effect: 'UNCHANGED: no consent, no release, no new authority' }, p.role);
        } else {
          record(p, gen, o.status, null, o);
          emit('ROOM_AGENT_RESPONSE', gen, { status: o.status, error: o.error, effect: 'UNCHANGED', ...latency }, p.role);
        }
        tryClose();
      });
      outstanding.push(call);
    }
    tryClose();
    await done;
    deps.superseded.removeEventListener('abort', onAbort);
    // Close the generation before anything else can land in it: whatever is still in flight is now stale.
    gate.closeGeneration();
    const reason = round.closed;
    for (const [r, a] of answers) requests.set(r, a.newAtoms);
    if (reason === 'SUPERSEDED') return finish('SUPERSEDED', assess(participants, requests, av, demandAt));
    const fit = assess(participants, requests, av, demandAt);
    if (fit.feasible) return finish('PROPOSED', fit);
  }
  return finish('NO_FEASIBLE_PORTFOLIO', assess(participants, requests, av, demandAt));
}
