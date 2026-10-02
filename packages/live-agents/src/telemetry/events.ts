/**
 * The `MANDATE_LIVE_AI.V1` event stream (docs/demo/live-ai-lab.md §9).
 *
 * A separate contract from `MANDATE_JUDGE_DEMO.V1`, which it never touches.
 * Every event has every envelope field; `data` holds only explicit, safe,
 * JSON values chosen by the emitter — reason codes, amounts as decimal
 * text, digests, declared rationales, timings. Never a key, a prompt, raw
 * model output or a reasoning trace. Events describe; they authorize
 * nothing.
 */

import type { Clock } from '../runtime/clock.ts';
import type { JsonObject, JsonValue } from '../runtime/strict-json.ts';
import type { Role } from '../types.ts';

export const LIVE_SCHEMA = 'MANDATE_LIVE_AI.V1';

export const LIVE_EVENT_KINDS = [
  'SESSION_STARTED',
  // B.5.3: a durable session reloaded from disk (by the local server or a settlement command).
  'SESSION_RESTORED',
  'MANDATE_DRAFT_REQUESTED',
  'MANDATE_DRAFT_CREATED',
  'MANDATE_DRAFT_CONFLICT',
  // B.5.3: the principal's wallet approval (an offchain EIP-712 signature, verified by the server).
  'MANDATE_WALLET_CHALLENGE_ISSUED',
  'MANDATE_WALLET_APPROVAL_REFUSED',
  'MANDATE_VERSION_AUTHORIZED',
  'MANDATE_VERSION_SUPERSEDED',
  'MANDATE_AMENDMENT_STARTED',
  'MANDATE_AMENDMENT_AUTHORIZED',
  'MANDATE_AMENDMENT_REFUSED',
  'MANDATE_PAUSED',
  'AGENT_REQUEST_STARTED',
  'AGENT_FIRST_RESPONSE',
  'AGENT_DECISION_COMPLETED',
  'AGENT_ABSTAINED',
  'AGENT_TIMED_OUT',
  'AGENT_FAILED',
  'AGENT_INVALID_RESPONSE',
  'PROPOSAL_SIGNED',
  'PROPOSAL_BLOCKED',
  'PROPOSAL_ADMISSIBLE',
  'PROPOSAL_STALE',
  'PORTFOLIO_CONFLICT',
  'ROOM_OPENED',
  'ROOM_GENERATION_STARTED',
  'ROOM_AGENT_RESPONSE',
  'ROOM_AGENT_TIMEOUT',
  'ROOM_AGENT_STALE_RESPONSE',
  'ROOM_REDUCTION',
  'ROOM_RELEASE',
  'ROOM_KEEP',
  'ROOM_NO_FEASIBLE_PORTFOLIO',
  'ROOM_PROPOSAL_CREATED',
  'ROOM_FINALIZED',
  'MANDATE_REVERIFY_STARTED',
  'PORTFOLIO_AUTHORIZED',
  'PORTFOLIO_REFUSED',
  'POLICY_STRESS_STARTED',
  'POLICY_STRESS_CASE_SELECTED',
  'POLICY_STRESS_PROPOSAL_SIGNED',
  'POLICY_STRESS_PROPOSAL_BLOCKED',
  'POLICY_STRESS_PROPOSAL_AUTHORIZED',
  'POLICY_STRESS_COMPLETED',
  // B.5.2: the explicit Robinhood Chain testnet settlement path (@mandate/live-settlement). Emitted only
  // by that package, only when an operator runs a testnet mode; the default runs never emit them.
  'TESTNET_PREFLIGHT_STARTED',
  'TESTNET_PREFLIGHT_PASSED',
  'TESTNET_PREFLIGHT_FAILED',
  'DOMAIN_EXECUTION_INELIGIBLE',
  'DOMAIN_EXECUTION_READY',
  'TESTNET_SIMULATION_STARTED',
  'TESTNET_SIMULATION_PASSED',
  'TESTNET_SIMULATION_FAILED',
  'TESTNET_SEND_AUTHORIZATION_REQUIRED',
  'TESTNET_SEND_AUTHORIZATION_REFUSED',
  'TESTNET_TX_SUBMISSION_STARTED',
  'TESTNET_TX_SUBMITTED',
  'TESTNET_TX_CONFIRMED',
  'TESTNET_TX_FAILED',
  'DOMAIN_EXECUTION_SETTLED',
  'DOMAIN_EXECUTION_FAILED',
  // B.5.3: the durable settlement lifecycle (@mandate/live-settlement): the portfolio attempt, the dry run's end
  // (a send is disabled in B.5.3), reconciliation after a restart, and the reservation's consumption or release.
  'SETTLEMENT_ATTEMPT_PREPARED',
  'TESTNET_READY_FOR_SEND',
  // V2 lab UI: the wallet must sign MandateAuthorization before this run can continue.
  // Not the operator send phrase. Emitted only by the explicit settlement bridge.
  'GATE_EXECUTION_SIGNATURE_REQUIRED',
  // V2 dry run reached READY. Nothing was broadcast. Distinct from TESTNET_READY_FOR_SEND,
  // which the B.5.3 client still reads as "broadcast disabled".
  'SPINE_DRY_RUN_READY',
  'SETTLEMENT_RECONCILIATION_STARTED',
  'SETTLEMENT_RECONCILED',
  'RESERVATION_CONSUMED',
  'RESERVATION_RELEASED',
  'SESSION_COMPLETED',
] as const;
export type LiveEventKind = (typeof LIVE_EVENT_KINDS)[number];

export interface LiveEvent {
  readonly schema: typeof LIVE_SCHEMA;
  readonly sessionId: string;
  /** 0, 1, 2, …: the only order. */
  readonly sequence: number;
  readonly kind: LiveEventKind;
  /** Wall clock, for display. */
  readonly at: string;
  /** Monotonic milliseconds since the session started. */
  readonly elapsedMs: number;
  /** The protocol time in force when it was emitted (unix seconds, decimal text). */
  readonly protocolTime: string;
  readonly mandateVersion: number | null;
  readonly agent: Role | null;
  readonly roomId: string | null;
  readonly generation: number | null;
  readonly data: JsonObject;
}

export interface EmitFields {
  readonly agent?: Role | null;
  readonly roomId?: string | null;
  readonly generation?: number | null;
  readonly mandateVersion?: number | null;
  readonly data?: { readonly [k: string]: unknown };
  /** A durable session appends an event with a dedupe key at most once, across processes and restarts. */
  readonly dedupe?: string;
}

/**
 * Where a durable session's events live (persistence/session-store.ts). The
 * sink assigns the sequence, so several processes appending to one session
 * share one dense, strictly increasing order.
 */
export interface EventSink {
  appendEvent(e: Omit<LiveEvent, 'sequence'>, dedupe: string | null): { readonly sequence: number; readonly inserted: boolean };
  eventsAfter(after: number): readonly LiveEvent[];
}

/** JSON-safe: bigints become decimal text, undefined is dropped, anything else unrepresentable becomes null. */
export function safe(v: unknown): JsonValue {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(safe);
  if (typeof v === 'object') {
    const out: { [k: string]: JsonValue } = {};
    for (const [k, x] of Object.entries(v as object)) if (x !== undefined) out[k] = safe(x);
    return out;
  }
  return null;
}

export type Listener = (e: LiveEvent) => void;

export class EventLog {
  readonly sessionId: string;
  readonly #clock: Clock;
  readonly #elapsedMs: () => number;
  readonly #protocolNow: () => bigint;
  readonly #version: () => number | null;
  readonly #events: LiveEvent[] = [];
  readonly #listeners = new Set<Listener>();
  readonly #sink: EventSink | null;
  /** In memory: the sequence each dedupe key was first appended at (a durable sink keeps its own). */
  readonly #deduped = new Map<string, number>();

  constructor(o: { readonly sessionId: string; readonly clock: Clock; readonly startMs: number; readonly protocolNow: () => bigint; readonly version: () => number | null; readonly sink?: EventSink; readonly elapsedMs?: () => number }) {
    this.sessionId = o.sessionId;
    this.#clock = o.clock;
    this.#elapsedMs = o.elapsedMs ?? (() => o.clock.nowMs() - o.startMs);
    this.#protocolNow = o.protocolNow;
    this.#version = o.version;
    this.#sink = o.sink ?? null;
    if (this.#sink !== null) this.sync();
  }

  emit(kind: LiveEventKind, f: EmitFields = {}): LiveEvent {
    const base: Omit<LiveEvent, 'sequence'> = {
      schema: LIVE_SCHEMA,
      sessionId: this.sessionId,
      kind,
      at: this.#clock.wallIso(),
      elapsedMs: Math.round(this.#elapsedMs()),
      protocolTime: this.#protocolNow().toString(),
      mandateVersion: f.mandateVersion === undefined ? this.#version() : f.mandateVersion,
      agent: f.agent ?? null,
      roomId: f.roomId ?? null,
      generation: f.generation ?? null,
      data: safe(f.data ?? {}) as JsonObject,
    };
    if (this.#sink !== null) {
      const { sequence } = this.#sink.appendEvent(base, f.dedupe ?? null);
      this.sync();
      return this.#events[sequence] as LiveEvent;
    }
    const seen = f.dedupe === undefined ? undefined : this.#deduped.get(f.dedupe);
    if (seen !== undefined) return this.#events[seen] as LiveEvent;
    const e: LiveEvent = { ...base, sequence: this.#events.length };
    if (f.dedupe !== undefined) this.#deduped.set(f.dedupe, e.sequence);
    this.#events.push(e);
    for (const l of this.#listeners) l(e);
    return e;
  }

  /** Read what other processes appended to a durable session since, in order, and tell every listener. */
  sync(): number {
    if (this.#sink === null) return 0;
    const fresh = this.#sink.eventsAfter(this.#events.length - 1);
    for (const e of fresh) {
      this.#events.push(e);
      for (const l of this.#listeners) l(e);
    }
    return fresh.length;
  }

  get events(): readonly LiveEvent[] {
    return this.#events;
  }

  subscribe(l: Listener): () => void {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }
}
