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
  'MANDATE_DRAFT_REQUESTED',
  'MANDATE_DRAFT_CREATED',
  'MANDATE_DRAFT_CONFLICT',
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
  'ROGUE_AGENT_STARTED',
  'ROGUE_ATTACK_SELECTED',
  'ROGUE_ACTION_SIGNED',
  'ROGUE_ACTION_BLOCKED',
  'ROGUE_ACTION_AUTHORIZED_IF_COMPLIANT',
  'ROGUE_CAPABILITY_REFUSED',
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
  readonly #startMs: number;
  readonly #protocolNow: () => bigint;
  readonly #version: () => number | null;
  readonly #events: LiveEvent[] = [];
  readonly #listeners = new Set<Listener>();

  constructor(o: { readonly sessionId: string; readonly clock: Clock; readonly startMs: number; readonly protocolNow: () => bigint; readonly version: () => number | null }) {
    this.sessionId = o.sessionId;
    this.#clock = o.clock;
    this.#startMs = o.startMs;
    this.#protocolNow = o.protocolNow;
    this.#version = o.version;
  }

  emit(kind: LiveEventKind, f: EmitFields = {}): LiveEvent {
    const e: LiveEvent = {
      schema: LIVE_SCHEMA,
      sessionId: this.sessionId,
      sequence: this.#events.length,
      kind,
      at: this.#clock.wallIso(),
      elapsedMs: Math.round(this.#clock.nowMs() - this.#startMs),
      protocolTime: this.#protocolNow().toString(),
      mandateVersion: f.mandateVersion === undefined ? this.#version() : f.mandateVersion,
      agent: f.agent ?? null,
      roomId: f.roomId ?? null,
      generation: f.generation ?? null,
      data: safe(f.data ?? {}) as JsonObject,
    };
    this.#events.push(e);
    for (const l of this.#listeners) l(e);
    return e;
  }

  get events(): readonly LiveEvent[] {
    return this.#events;
  }

  subscribe(l: Listener): () => void {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }
}
