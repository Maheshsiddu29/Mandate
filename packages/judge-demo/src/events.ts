/**
 * The judge demo's UI event contract: `MANDATE_JUDGE_DEMO.V1`.
 *
 * **Presentation data, never authority.** Every event narrates something the
 * real Mandate code returned during one deterministic protocol run; nothing
 * reads an event back to decide anything. Reason codes, digests, amounts and
 * statuses are copied from protocol results, never written by hand.
 *
 * The contract is plain, JSON-ready data a frontend can replay without
 * re-running the protocol:
 *
 * - order is `sequence` (0, 1, 2, …), a logical tick — there is no wall
 *   clock anywhere in the transcript;
 * - `protocolTime` is the decision time (unix seconds, a decimal string) the
 *   protocol call was made at: a parameter of the run, not an observation;
 * - every amount is exact decimal text with its unit and its atoms, never a
 *   float;
 * - `presentationDigest` detects drift between the transcript a UI was built
 *   against and the one the protocol now produces. It is keccak-256 over the
 *   canonical JSON of the events and is **presentation-only**: it is not a
 *   protocol commitment and must never be treated as one. The protocol
 *   commitments are the receipt digests the events carry.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@mandate/core';
import type { EvidenceClass, Reason, ResourceDefinition, ResourceVector } from '@mandate/portfolio';

export const JUDGE_DEMO_SCHEMA = 'MANDATE_JUDGE_DEMO.V1';
export const JUDGE_DEMO_SCHEMA_VERSION = 1;

export const EVENT_KINDS = [
  'PORTFOLIO_CREATED',
  'AGENT_SEARCH_STARTED',
  'PROPOSAL_DISCOVERED',
  'PROPOSAL_BLOCKED',
  'PROPOSAL_ADMISSIBLE',
  'AGENT_NO_COMPLIANT_OPPORTUNITY',
  'RESOURCE_CONFLICT',
  'MANDATE_ROOM_OPENED',
  'AGENT_RELEASED_AUTHORITY',
  'AGENT_REDUCTION_REQUESTED',
  'AGENT_PROPOSAL_REDUCED',
  'AUTHORITY_REALLOCATED',
  'PROPOSAL_ACCEPTED',
  'MANDATE_ROOM_PROPOSED_PORTFOLIO',
  'PORTFOLIO_REVERIFY_STARTED',
  'VERIFIER_CHECKLIST',
  'ROOM_FORGERY_REFUSED',
  'CHILD_AUTHORIZATION_CREATED',
  'RESOURCE_RESERVED',
  'REPLAY_REFUSED',
  'EXECUTION_HANDOFF',
  'PORTFOLIO_AUTHORIZED',
  'AGENT_COMPROMISED',
  'MALICIOUS_PROPOSAL_SIGNED',
  'MALICIOUS_PROPOSAL_BLOCKED',
  'HEALTHY_AGENTS_UNAFFECTED',
  'COMPLIANT_PROPOSAL_SIGNED',
  'COMPLIANT_PROPOSAL_AUTHORIZED',
  'PORTFOLIO_RESOURCE_CONFLICT',
  'LIVE_TESTNET_EVIDENCE',
  'PORTFOLIO_RECEIPT_CREATED',
  'DEMO_COMPLETED',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** What the event says happened, in one word the UI can colour. */
export const EVENT_STATUSES = [
  'INFO',
  'SIGNED',
  'BLOCKED',
  'ADMISSIBLE',
  'CONFLICT',
  'NEGOTIATING',
  'RELEASED',
  'REDUCED',
  'REALLOCATED',
  'ACCEPTED',
  'PROPOSED',
  'VERIFYING',
  'VERIFIED',
  'REFUSED',
  'CREATED',
  'RESERVED',
  'AUTHORIZED',
  'COMPROMISED',
  'ACTIVE',
  'RECORDED',
  'COMPLETE',
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** The ten scenes, in order. */
export const SCENES = [
  { scene: 1, title: 'Portfolio Mandate' },
  { scene: 2, title: 'Five agents search' },
  { scene: 3, title: 'Resource conflict' },
  { scene: 4, title: 'Mandate Room' },
  { scene: 5, title: 'Independent reverification' },
  { scene: 6, title: 'Malicious authorized agent' },
  { scene: 7, title: 'Fault isolation' },
  { scene: 8, title: 'Same agent, compliant action' },
  { scene: 9, title: 'Portfolio-level conflict' },
  { scene: 10, title: 'Receipt and evidence' },
] as const;
export type SceneNumber = (typeof SCENES)[number]['scene'];

/** The protocol runs the demo makes, in order, all against one ledger. */
export const RUN_IDS = ['initial', 'attack', 'compliant', 'conflict'] as const;
export type RunId = (typeof RUN_IDS)[number];

export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

export interface AmountView {
  readonly resource: string;
  readonly unit: string;
  readonly decimals: number;
  /** Exact integer atoms, as decimal text. */
  readonly atoms: string;
  /** Exact decimal text at the resource's declared decimals, trailing zeros trimmed. */
  readonly amount: string;
}

export interface AgentRef {
  /** The agent's party value (its address). */
  readonly id: string;
  /** The mandate's own label for it. */
  readonly label: string;
}

export interface ReasonView {
  readonly code: string;
  readonly subject: string;
}

export interface ArtifactRef {
  /** What the value is, e.g. `proposalDigest`, `receiptDigest`, `reservation`. */
  readonly name: string;
  readonly value: string;
}

export interface JudgeEvent {
  readonly schema: typeof JUDGE_DEMO_SCHEMA;
  readonly sequence: number;
  readonly scene: SceneNumber;
  readonly kind: EventKind;
  readonly run: RunId | null;
  /** The Mandate Room round, for events the room produced. */
  readonly round: number | null;
  readonly protocolTime: string | null;
  readonly agent: AgentRef | null;
  readonly domain: string | null;
  readonly proposal: string | null;
  readonly candidate: string | null;
  readonly requested: readonly AmountView[];
  readonly approved: readonly AmountView[];
  readonly status: EventStatus;
  readonly reasons: readonly ReasonView[];
  readonly evidence: EvidenceClass | null;
  readonly artifacts: readonly ArtifactRef[];
  /** One human-readable line. Presentation wording over the real values in `data`. */
  readonly message: string;
  readonly data: { readonly [key: string]: Json };
}

export type EventInput = Partial<Omit<JudgeEvent, 'schema' | 'sequence' | 'scene' | 'kind' | 'status' | 'message'>> & {
  readonly kind: EventKind;
  readonly status: EventStatus;
  readonly message: string;
};

/** Collects events in order and gives each its sequence number. */
export class EventLog {
  readonly #events: JudgeEvent[] = [];
  #scene: SceneNumber = 1;

  scene(n: SceneNumber): void {
    if (n < this.#scene) throw new Error(`scene ${n} after scene ${this.#scene}`);
    this.#scene = n;
  }

  emit(e: EventInput): JudgeEvent {
    const event: JudgeEvent = {
      schema: JUDGE_DEMO_SCHEMA,
      sequence: this.#events.length,
      scene: this.#scene,
      kind: e.kind,
      run: e.run ?? null,
      round: e.round ?? null,
      protocolTime: e.protocolTime ?? null,
      agent: e.agent ?? null,
      domain: e.domain ?? null,
      proposal: e.proposal ?? null,
      candidate: e.candidate ?? null,
      requested: e.requested ?? [],
      approved: e.approved ?? [],
      status: e.status,
      reasons: e.reasons ?? [],
      evidence: e.evidence ?? null,
      artifacts: e.artifacts ?? [],
      message: e.message,
      data: e.data ?? {},
    };
    this.#events.push(event);
    return event;
  }

  get events(): readonly JudgeEvent[] {
    return this.#events;
  }
}

// --- Conversions: protocol values → presentation values ------------------------------------

/** Exact decimal text: `1900000000` at 6 decimals is `"1900"`, `200400000` is `"200.4"`. */
export function decimalText(atoms: bigint, decimals: number): string {
  const negative = atoms < 0n;
  const abs = negative ? -atoms : atoms;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fraction = decimals === 0 ? '' : (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

export function amountViews(v: ResourceVector, resources: readonly ResourceDefinition[]): AmountView[] {
  return v.map((a) => {
    const d = resources.find((r) => r.resource === a.resource);
    const decimals = d?.decimals ?? 0;
    return { resource: a.resource, unit: d?.unit ?? 'UNKNOWN', decimals, atoms: a.atoms.toString(), amount: decimalText(a.atoms, decimals) };
  });
}

export function reasonViews(rs: readonly Reason[]): ReasonView[] {
  return rs.map((r) => ({ code: r.code, subject: r.subject }));
}

/** Distinct reason codes in first-seen order. */
export function codesOf(rs: readonly { readonly code: string }[]): string[] {
  return [...new Set(rs.map((r) => r.code))];
}

/**
 * Any protocol value as JSON: bigints become decimal strings, `Map`s become
 * objects keyed by their (string) keys, `undefined` fields are dropped.
 * Functions and symbols are refused rather than silently lost.
 */
export function jsonOf(x: unknown): Json {
  if (x === null || x === undefined) return null;
  switch (typeof x) {
    case 'string':
    case 'boolean':
      return x;
    case 'number':
      if (!Number.isSafeInteger(x)) throw new Error(`non-integer number in presentation data: ${x}`);
      return x;
    case 'bigint':
      return x.toString();
    case 'object': {
      if (Array.isArray(x)) return x.map(jsonOf);
      if (x instanceof Map) return Object.fromEntries([...x.entries()].map(([k, v]) => [String(k), jsonOf(v)]));
      const out: { [key: string]: Json } = {};
      for (const [k, v] of Object.entries(x)) if (v !== undefined) out[k] = jsonOf(v);
      return out;
    }
    default:
      throw new Error(`unrepresentable ${typeof x} in presentation data`);
  }
}

/** JSON with object keys sorted at every level: the input to the presentation digest. */
export function canonicalJson(x: Json): string {
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return `[${(x as readonly Json[]).map(canonicalJson).join(',')}]`;
  const o = x as { readonly [key: string]: Json };
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k] ?? null)}`)
    .join(',')}}`;
}

/** Presentation-only drift detector over a transcript's events. Not a protocol commitment. */
export function presentationDigest(events: readonly JudgeEvent[]): string {
  return bytesToHex(keccak_256(new TextEncoder().encode(canonicalJson(jsonOf(events)))));
}
