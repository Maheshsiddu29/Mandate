/**
 * Strict parsing of TypeSafe responses.
 *
 * The parser's job is not to extract as much as possible. It is to decide
 * whether the body is a well-formed `choice` answer, and to refuse everything
 * else with one stable reason code. A refused body costs the advisory layer for
 * that decision and nothing more.
 *
 * Nothing here reads a field as an address, an amount, a quantity, a side or a
 * constraint. `choice` leaves this module as an unresolved string.
 */

import {
  JevFallbackReason,
  type JevChoiceAnswer,
  type JevModelDescriptor,
} from './types.ts';

export type ParseOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: JevFallbackReason; readonly detail: string };

/** Bounds chosen so a hostile body cannot turn into an unbounded receipt. */
const MAX_MODEL_LENGTH = 128;
const MAX_CHOICE_LENGTH = 64;
const MAX_PROBABILITY_ENTRIES = 256;
const MAX_PROBABILITY_KEY_LENGTH = 64;
const MAX_TOKEN_COUNT = 100_000_000;

function mismatch(detail: string): ParseOutcome<never> {
  return { ok: false, reason: JevFallbackReason.SCHEMA_MISMATCH, detail };
}

function plainObject(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

/** Printable ASCII only: a model identifier reaches a receipt and a log line. */
function boundedText(raw: unknown, limit: number): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > limit) return undefined;
  if (/[^\x20-\x7e]/.test(raw)) return undefined;
  return raw;
}

function unitInterval(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  if (raw < 0 || raw > 1) return undefined;
  return raw;
}

function tokenCount(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) return undefined;
  if (raw < 0 || raw > MAX_TOKEN_COUNT) return undefined;
  return raw;
}

function parseProbabilities(raw: unknown): ReadonlyMap<string, number> | undefined {
  const value = plainObject(raw);
  if (value === undefined) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_PROBABILITY_ENTRIES) return undefined;
  const parsed = new Map<string, number>();
  for (const [key, item] of entries) {
    if (boundedText(key, MAX_PROBABILITY_KEY_LENGTH) === undefined) return undefined;
    const probability = unitInterval(item);
    if (probability === undefined) return undefined;
    parsed.set(key, probability);
  }
  return parsed;
}

/**
 * Parse a `POST /v1/systemone` body into one choice answer.
 *
 * Unrecognized top-level and answer-level fields are ignored rather than
 * refused: the response schema belongs to TypeSafe and may gain fields. What is
 * never tolerated is a field this integration reads being absent, the wrong
 * type, or out of range.
 */
export function parseJevChoiceResponse(body: unknown, questionName: string): ParseOutcome<JevChoiceAnswer> {
  const root = plainObject(body);
  if (root === undefined) return mismatch('body is not a JSON object');

  const model = boundedText(root['model'], MAX_MODEL_LENGTH);
  if (model === undefined) return mismatch('model missing or unusable');

  const answers = plainObject(root['answers']);
  if (answers === undefined) return mismatch('answers missing');

  const answer = plainObject(answers[questionName]);
  if (answer === undefined) return mismatch(`answer ${questionName} missing`);
  if (answer['type'] !== 'choice') return mismatch('answer is not a choice');

  const choice = boundedText(answer['choice'], MAX_CHOICE_LENGTH);
  if (choice === undefined) return mismatch('choice missing or unusable');

  const probabilities = parseProbabilities(answer['probabilities']);
  if (probabilities === undefined) return mismatch('probabilities missing or out of range');

  const confidence = unitInterval(answer['confidence']);
  if (confidence === undefined) return mismatch('confidence missing or out of range');

  // `usage` is documented but its absence says nothing about the answer, so a
  // missing block records null tokens rather than discarding a valid choice.
  const usage = plainObject(root['usage']);
  const inputTokens = usage === undefined ? null : tokenCount(usage['input_tokens']);
  const outputTokens = usage === undefined ? null : tokenCount(usage['output_tokens']);
  if (inputTokens === undefined || outputTokens === undefined) return mismatch('usage present but unusable');

  return { ok: true, value: { model, choice, probabilities, confidence, inputTokens, outputTokens } };
}

/** Parse a `GET /v1/models` body. Used only by the characterization harness. */
export function parseJevModels(body: unknown): ParseOutcome<readonly JevModelDescriptor[]> {
  const root = plainObject(body);
  if (root === undefined) return mismatch('body is not a JSON object');
  const raw = root['models'];
  if (!Array.isArray(raw)) return mismatch('models is not an array');
  const models: JevModelDescriptor[] = [];
  for (const item of raw) {
    const entry = plainObject(item);
    if (entry === undefined) return mismatch('model entry is not an object');
    const name = boundedText(entry['name'], MAX_MODEL_LENGTH);
    if (name === undefined) return mismatch('model entry has no usable name');
    models.push({
      name,
      description: boundedText(entry['description'], 512) ?? null,
      releaseDate: boundedText(entry['release_date'], 64) ?? null,
    });
  }
  return { ok: true, value: models };
}
