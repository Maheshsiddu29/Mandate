/**
 * Advisory opportunity scoring (docs/v2/mandate-room-v2.md §6).
 *
 * A scorer — in the lab, Jev through TypeSafe's Score primitive — answers
 * one bounded question per OpportunityCard: how strongly the evidence
 * supports allocating capital to it under the principal's objective. It
 * cannot authorize, sign, reserve, or name an amount. Its answer is
 * validated here, and only a validated score reaches the allocator, as an
 * integer in basis points that scales a card's weight between 0.5× and 1.5×.
 *
 * This package holds the interface and the validation only. The TypeSafe
 * client lives in `@mandate/jev` and is attached by the server scripts (the
 * composition root); this source makes no network call and reads no key.
 */

import type { OpportunityCard } from '../allocation/card.ts';

/** The Score rubric: five levels, 0–4. */
export const SCORE_LEVELS = 5;
const TOP = SCORE_LEVELS - 1;

export type JevScore =
  | {
      readonly status: 'SCORED';
      /** The probability-weighted level, 0–4, exactly as the scorer returned it. */
      readonly score: number;
      readonly confidence: number;
      readonly probabilities: { readonly [level: string]: number };
      /** The score as integer basis points of the top level, 0–10,000: what the allocator may use. */
      readonly bps: number;
      readonly model: string;
      readonly latencyMs: number;
    }
  | { readonly status: 'UNAVAILABLE'; readonly reason: string; readonly latencyMs: number };

export interface ScoreInput {
  readonly card: OpportunityCard;
  readonly objective: string;
  readonly principalIntent: string | null;
  /** The candidate's offered facts, as the agent saw them. */
  readonly facts: readonly { readonly label: string; readonly value: string }[];
}

export interface OpportunityScorer {
  readonly name: string;
  /** `LIVE_JEV` when it calls the real service; never claimed otherwise. */
  readonly evidence: 'LIVE_JEV' | 'NONE' | 'SCRIPTED';
  score(input: ScoreInput): Promise<JevScore>;
}

/** What a raw Score answer must look like before it can be used. */
export interface RawScore {
  readonly score: unknown;
  readonly confidence: unknown;
  readonly probabilities: unknown;
  readonly model: unknown;
}

/**
 * Validate a raw Score answer. Anything not exactly a finite score in 0–4, a
 * finite confidence in 0–1 and a probability for each of the five levels is
 * UNAVAILABLE: nothing is repaired, clamped or guessed.
 */
export function validateScore(raw: RawScore, latencyMs: number): JevScore {
  const unavailable = (reason: string): JevScore => ({ status: 'UNAVAILABLE', reason, latencyMs });
  const { score, confidence, probabilities, model } = raw;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > TOP) return unavailable('SCORE_OUT_OF_RANGE');
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return unavailable('CONFIDENCE_OUT_OF_RANGE');
  if (typeof probabilities !== 'object' || probabilities === null || Array.isArray(probabilities)) return unavailable('PROBABILITIES_MISSING');
  const keys = Object.keys(probabilities).sort();
  if (keys.length !== SCORE_LEVELS || keys.some((k, i) => k !== String(i))) return unavailable('LEVELS_MISMATCH');
  for (const k of keys) {
    const p = (probabilities as { readonly [k: string]: unknown })[k];
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return unavailable('PROBABILITY_OUT_OF_RANGE');
  }
  if (typeof model !== 'string' || model.length === 0 || model.length > 64) return unavailable('MODEL_MISSING');
  return { status: 'SCORED', score, confidence, probabilities: probabilities as { readonly [level: string]: number }, bps: Math.round((score / TOP) * 10_000), model, latencyMs };
}

/**
 * Re-validate what a scorer returned: a SCORED result is accepted only if its
 * own fields pass `validateScore` again, and its basis points are recomputed
 * here, never taken from the scorer.
 */
export function revalidate(s: JevScore): JevScore {
  if (s.status !== 'SCORED') return s;
  return validateScore({ score: s.score, confidence: s.confidence, probabilities: s.probabilities, model: s.model }, s.latencyMs);
}

/** The basis points an allocator may use, or null: only a SCORED result, only an integer 0–10,000. */
export function scoreBps(s: JevScore | null): number | null {
  if (s === null || s.status !== 'SCORED') return null;
  return Number.isInteger(s.bps) && s.bps >= 0 && s.bps <= 10_000 ? s.bps : null;
}

/** No scorer configured: every card is UNAVAILABLE, and no score is ever invented. */
export class NoScorer implements OpportunityScorer {
  readonly name = 'none';
  readonly evidence = 'NONE' as const;

  score(): Promise<JevScore> {
    return Promise.resolve({ status: 'UNAVAILABLE', reason: 'JEV_NOT_CONFIGURED', latencyMs: 0 });
  }
}
