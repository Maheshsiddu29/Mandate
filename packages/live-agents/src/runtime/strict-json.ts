/**
 * Strict reading of model output.
 *
 * Model text is parsed as JSON and then checked field by field: exactly the
 * expected keys (an extra key — `recipient`, `tool`, `calldata` — refuses
 * the whole object), exactly the expected types, closed enums, bounded
 * strings. Nothing is coerced, defaulted or repaired: output that is not
 * exactly right is `INVALID_RESPONSE`, and invalid output never becomes a
 * proposal. The JSON schemas sent to a provider say the same thing, but a
 * provider's own enforcement is never relied on.
 */

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [k: string]: JsonValue };
export type JsonObject = { readonly [k: string]: JsonValue };

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export const good = <T>(value: T): Parsed<T> => ({ ok: true, value });
export const bad = <T>(error: string): Parsed<T> => ({ ok: false, error });

/** At most this much model text is read at all. */
export const MAX_MODEL_TEXT = 16_384;
/** A declared rationale: short, and display only. */
export const MAX_RATIONALE = 280;

export function parseJsonObject(text: string): Parsed<JsonObject> {
  if (text.length > MAX_MODEL_TEXT) return bad('response too long');
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return bad('response is not JSON');
  }
  return isObject(v) ? good(v) : bad('response is not a JSON object');
}

export function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The object has exactly these keys. */
export function exactKeys(o: JsonObject, keys: readonly string[], where: string): Parsed<true> {
  const have = Object.keys(o);
  const extra = have.filter((k) => !keys.includes(k));
  if (extra.length > 0) return bad(`${where}: unexpected field ${extra.map((k) => JSON.stringify(k.slice(0, 40))).join(', ')}`);
  const missing = keys.filter((k) => !have.includes(k));
  if (missing.length > 0) return bad(`${where}: missing field ${missing.join(', ')}`);
  return good(true);
}

export function oneOf<T extends string>(v: JsonValue | undefined, allowed: readonly T[], where: string): Parsed<T> {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? good(v as T) : bad(`${where}: not one of the allowed values`);
}

export function nullableOneOf<T extends string>(v: JsonValue | undefined, allowed: readonly T[], where: string): Parsed<T | null> {
  return v === null ? good(null) : oneOf(v, allowed, where);
}

/** A string of at most `max` characters, without control characters. */
export function boundedText(v: JsonValue | undefined, max: number, where: string): Parsed<string> {
  if (typeof v !== 'string') return bad(`${where}: not a string`);
  if (v.length > max) return bad(`${where}: longer than ${max} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) return bad(`${where}: control characters`);
  return good(v);
}

export function nullableText(v: JsonValue | undefined, max: number, where: string): Parsed<string | null> {
  return v === null ? good(null) : boundedText(v, max, where);
}

export function nullableBoolean(v: JsonValue | undefined, where: string): Parsed<boolean | null> {
  return v === null || typeof v === 'boolean' ? good(v) : bad(`${where}: not a boolean or null`);
}

export function array(v: JsonValue | undefined, max: number, where: string): Parsed<readonly JsonValue[]> {
  if (!Array.isArray(v)) return bad(`${where}: not an array`);
  return v.length > max ? bad(`${where}: more than ${max} items`) : good(v as readonly JsonValue[]);
}

/** JSON-schema helpers for strict structured output: every key required, no other key allowed. */
export function objectSchema(properties: { readonly [k: string]: JsonObject }): JsonObject {
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}

export const nullableString = (maxLength: number): JsonObject => ({ type: ['string', 'null'], maxLength });
export const enumSchema = (values: readonly string[], nullable = false): JsonObject => (nullable ? { type: ['string', 'null'], enum: [...values, null] } : { type: 'string', enum: [...values] });
