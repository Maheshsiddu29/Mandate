/**
 * Advisory opportunity scoring with TypeSafe's Score primitive
 * (docs/v2/mandate-room-v2.md §6).
 *
 * The Live AI Lab's Planning and Reallocation Rooms ask one bounded question
 * per opportunity card: how strongly the evidence supports allocating
 * incremental capital to it under the principal's stated objective. The
 * answer is a position on five ordered levels (0–4), parsed strictly here.
 *
 * Nothing here decides an amount. The score leaves this module as a number
 * and is validated again by the caller before a deterministic allocator may
 * use it to scale a weight; it can never lift a cap, enable an agent or
 * become dollars by itself. The routing integration's `choice` question is
 * untouched: this is a separate question, payload and parser.
 *
 * The state sent is a whitelisted projection: a role, a candidate title, the
 * candidate's offered facts, ordinal ratings, amounts as decimal USDC text
 * and evidence classes. No address, key, identifier or provider text that
 * means anything outside the process.
 */

import { JevFallbackReason, DEFAULT_MODEL, type JevTransport, type JevTransportOutcome } from './types.ts';
import type { ParseOutcome } from './parse.ts';

export const JEV_SCORE_QUESTION_NAME = 'allocation_support';
export const JEV_SCORE_STATE_SCHEMA = 'mandate.jev.opportunity/1';
export const JEV_SCORE_LEVELS = 5;
/** A Planning Room waits this long for advice, then proceeds without it. */
export const DEFAULT_SCORE_TIMEOUT_MS = 4_000;

const MAX_TEXT = 240;
const MAX_FACTS = 16;
const MAX_EVIDENCE = 16;
const MAX_MODEL_LENGTH = 128;

export const SCORE_INSTRUCTIONS =
  'How strongly does the evidence in `opportunity` support allocating incremental capital to this opportunity under the principal\'s stated objective in `objective` and `principalIntent`? Judge only from the supplied facts, ratings and evidence classes. Evidence marked DATA_UNAVAILABLE does not exist; facts marked FIXTURE are labelled demonstration data, not live market data.';

/** Five levels, each a situation that stands on its own. */
export const SCORE_CRITERIA: readonly string[] = [
  'No support: the opportunity does not serve the objective, abstains, or the evidence contradicts allocating to it.',
  'Weak support: some fit with the objective, but the evidence is thin, mostly unavailable, or the downside clearly outweighs the edge.',
  'Moderate support: a reasonable fit with balanced edge and risk, on partial evidence.',
  'Strong support: a clear fit with good edge, liquidity and execution, and manageable risk on the available evidence.',
  'Very strong support: an excellent fit, strong on every rated dimension, with the available evidence consistently supporting more capital.',
];

export interface JevScoreQuestion {
  readonly type: 'score';
  readonly instructions: string;
  readonly criteria: readonly string[];
}

/** The whitelisted state of one opportunity. Integers leave as decimal text. */
export interface JevOpportunityState {
  readonly schema: typeof JEV_SCORE_STATE_SCHEMA;
  readonly objective: string;
  readonly principalIntent: string | null;
  readonly opportunity: {
    readonly domain: string;
    readonly action: 'PROPOSE' | 'ABSTAIN';
    readonly candidate: string | null;
    readonly facts: readonly { readonly label: string; readonly value: string }[];
    readonly ratings: { readonly opportunityQuality: number; readonly liquidity: number; readonly executionQuality: number; readonly downsideRisk: number; readonly dataConfidence: number };
    readonly marketRegime: string;
    readonly requestedUsdc: string;
    readonly minimumUsefulUsdc: string;
    readonly maximumUsefulUsdc: string;
    readonly evidence: readonly { readonly kind: string; readonly evidence: string }[];
  };
}

export interface JevScorePayload {
  readonly state: JevOpportunityState;
  readonly model: string;
  readonly questions: { readonly [JEV_SCORE_QUESTION_NAME]: JevScoreQuestion };
}

/** A transport that can carry a Score payload (TypeSafeJevClient is one). */
export interface JevScoreTransport {
  send(payload: JevScorePayload, timeoutMs: number): Promise<JevTransportOutcome>;
}

export interface JevScoreAnswer {
  readonly model: string;
  readonly score: number;
  readonly confidence: number;
  readonly probabilities: { readonly [level: string]: number };
}

/** What the caller supplies, structurally: an opportunity card and its context. */
export interface JevOpportunityInput {
  readonly card: {
    readonly role: string;
    readonly action: 'PROPOSE' | 'ABSTAIN';
    readonly candidateTitle: string | null;
    readonly requestedAtoms: bigint;
    readonly minimumUsefulAtoms: bigint;
    readonly maximumUsefulAtoms: bigint;
    readonly metrics: JevOpportunityState['opportunity']['ratings'];
    readonly marketRegime: string;
    readonly evidence: readonly { readonly kind: string; readonly evidence: string }[];
  };
  readonly objective: string;
  readonly principalIntent: string | null;
  readonly facts: readonly { readonly label: string; readonly value: string }[];
}

export type JevScoreResult =
  | { readonly status: 'SCORED'; readonly score: number; readonly confidence: number; readonly probabilities: { readonly [level: string]: number }; readonly bps: number; readonly model: string; readonly latencyMs: number }
  | { readonly status: 'UNAVAILABLE'; readonly reason: JevFallbackReason; readonly latencyMs: number };

const clip = (text: string, limit = MAX_TEXT): string => text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);

function usdc(atoms: bigint): string {
  const whole = atoms / 1_000_000n;
  const frac = (atoms % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole}.${frac}`;
}

export function buildScorePayload(input: JevOpportunityInput, model: string = DEFAULT_MODEL): JevScorePayload {
  const c = input.card;
  return {
    model,
    state: {
      schema: JEV_SCORE_STATE_SCHEMA,
      objective: clip(input.objective),
      principalIntent: input.principalIntent === null ? null : clip(input.principalIntent, 600),
      opportunity: {
        domain: clip(c.role, 16),
        action: c.action,
        candidate: c.candidateTitle === null ? null : clip(c.candidateTitle, 120),
        facts: input.facts.slice(0, MAX_FACTS).map((f) => ({ label: clip(f.label, 40), value: clip(f.value, 120) })),
        ratings: { opportunityQuality: c.metrics.opportunityQuality, liquidity: c.metrics.liquidity, executionQuality: c.metrics.executionQuality, downsideRisk: c.metrics.downsideRisk, dataConfidence: c.metrics.dataConfidence },
        marketRegime: clip(c.marketRegime, 16),
        requestedUsdc: usdc(c.requestedAtoms),
        minimumUsefulUsdc: usdc(c.minimumUsefulAtoms),
        maximumUsefulUsdc: usdc(c.maximumUsefulAtoms),
        evidence: c.evidence.slice(0, MAX_EVIDENCE).map((e) => ({ kind: clip(e.kind, 32), evidence: clip(e.evidence, 32) })),
      },
    },
    questions: { [JEV_SCORE_QUESTION_NAME]: { type: 'score', instructions: SCORE_INSTRUCTIONS, criteria: SCORE_CRITERIA } },
  };
}

function mismatch(detail: string): ParseOutcome<never> {
  return { ok: false, reason: JevFallbackReason.SCHEMA_MISMATCH, detail };
}

function plainObject(raw: unknown): { readonly [k: string]: unknown } | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as { readonly [k: string]: unknown }) : undefined;
}

const finite = (raw: unknown, lo: number, hi: number): number | undefined => (typeof raw === 'number' && Number.isFinite(raw) && raw >= lo && raw <= hi ? raw : undefined);

/**
 * A well-formed Score answer for `question`, or a refusal. Exactly the five
 * levels, each probability in [0, 1], the score in [0, 4], confidence in
 * [0, 1], a printable model name. Nothing is clamped or repaired.
 */
export function parseJevScoreResponse(raw: unknown, question: string = JEV_SCORE_QUESTION_NAME, levels: number = JEV_SCORE_LEVELS): ParseOutcome<JevScoreAnswer> {
  const body = plainObject(raw);
  if (body === undefined) return mismatch('body is not an object');
  const model = body['model'];
  if (typeof model !== 'string' || model.length === 0 || model.length > MAX_MODEL_LENGTH || /[^\x20-\x7e]/.test(model)) return mismatch('model is missing or malformed');
  const answers = plainObject(body['answers']);
  if (answers === undefined) return mismatch('answers is not an object');
  const answer = plainObject(answers[question]);
  if (answer === undefined) return mismatch('the score answer is missing');
  if (answer['type'] !== 'score') return mismatch('the answer is not a score');
  const score = finite(answer['score'], 0, levels - 1);
  if (score === undefined) return mismatch('score is outside the rubric');
  const confidence = finite(answer['confidence'], 0, 1);
  if (confidence === undefined) return mismatch('confidence is outside [0, 1]');
  const probabilities = plainObject(answer['probabilities']);
  if (probabilities === undefined) return mismatch('probabilities is not an object');
  const keys = Object.keys(probabilities).sort();
  if (keys.length !== levels || keys.some((k, i) => k !== String(i))) return mismatch('probabilities do not name exactly the rubric levels');
  const out: { [level: string]: number } = {};
  for (const k of keys) {
    const p = finite(probabilities[k], 0, 1);
    if (p === undefined) return mismatch('a probability is outside [0, 1]');
    out[k] = p;
  }
  return { ok: true, value: { model, score, confidence, probabilities: out } };
}

async function withDeadline(work: Promise<JevTransportOutcome>, timeoutMs: number): Promise<JevTransportOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<JevTransportOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: JevFallbackReason.TIMEOUT, detail: `deadline ${timeoutMs}ms exceeded`, latencyMs: timeoutMs }), timeoutMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Score one opportunity. Never throws: every failure — no credential, a
 * transport error, a deadline, a malformed body — is UNAVAILABLE with its
 * reason, and no score is invented.
 */
export async function scoreOpportunity(transport: JevScoreTransport, input: JevOpportunityInput, o: { readonly model?: string; readonly timeoutMs?: number } = {}): Promise<JevScoreResult> {
  const timeoutMs = o.timeoutMs ?? DEFAULT_SCORE_TIMEOUT_MS;
  let outcome: JevTransportOutcome;
  try {
    outcome = await withDeadline(Promise.resolve(transport.send(buildScorePayload(input, o.model), timeoutMs)), timeoutMs);
  } catch {
    return { status: 'UNAVAILABLE', reason: JevFallbackReason.TRANSPORT_EXCEPTION, latencyMs: 0 };
  }
  if (!outcome.ok) return { status: 'UNAVAILABLE', reason: outcome.reason, latencyMs: outcome.latencyMs };
  const parsed = parseJevScoreResponse(outcome.body);
  if (!parsed.ok) return { status: 'UNAVAILABLE', reason: parsed.reason, latencyMs: outcome.latencyMs };
  const a = parsed.value;
  return { status: 'SCORED', score: a.score, confidence: a.confidence, probabilities: a.probabilities, bps: Math.round((a.score / (JEV_SCORE_LEVELS - 1)) * 10_000), model: a.model, latencyMs: outcome.latencyMs };
}

/** An opportunity scorer over a transport: the shape the Live AI Lab's Rooms consume. */
export function opportunityScorer(transport: JevScoreTransport, o: { readonly model?: string; readonly timeoutMs?: number } = {}): { readonly name: string; readonly evidence: 'LIVE_JEV'; score(input: JevOpportunityInput): Promise<JevScoreResult> } {
  return { name: `jev-score:${o.model ?? DEFAULT_MODEL}`, evidence: 'LIVE_JEV', score: (input) => scoreOpportunity(transport, input, o) };
}
