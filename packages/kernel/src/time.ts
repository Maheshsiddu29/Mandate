/**
 * Time.
 *
 * The kernel never reads a clock. Evaluation time is an explicit parameter
 * (design section 10.1, property 1), so a verdict is reproducible from its
 * recorded inputs years later, and a test can place the evaluation instant
 * exactly on a boundary.
 *
 * Unix seconds, as a signed 64-bit integer, held in a `bigint`. Signed because
 * the encoding is two's complement and a negative timestamp must round-trip
 * rather than silently becoming a huge positive one; `bigint` because
 * `number` loses integer precision above 2^53 and no safety-critical value in
 * this kernel is ever a `number`.
 */

import { type Result, ok, err } from './result.ts';
import type { ReasonCodeName } from './reason-codes.ts';

export const INT64_MIN = -(2n ** 63n);
export const INT64_MAX = 2n ** 63n - 1n;
export const UINT32_MAX = 2n ** 32n - 1n;

export type UnixSeconds = bigint;

/** Evaluation time, passed in. There is no default and no fallback to a system clock. */
export interface Clock {
  readonly nowUnixSeconds: UnixSeconds;
}

export function parseUnixSeconds(raw: unknown, code: ReasonCodeName): Result<UnixSeconds, ReasonCodeName> {
  const v = parseBigInt(raw);
  if (v === undefined) return err(code);
  if (v < INT64_MIN || v > INT64_MAX) return err('VALUE_OUT_OF_RANGE');
  return ok(v);
}

/** Duration in seconds, unsigned, 32-bit. Used for freshness bounds. */
export function parseDurationSeconds(raw: unknown, code: ReasonCodeName): Result<bigint, ReasonCodeName> {
  const v = parseBigInt(raw);
  if (v === undefined) return err(code);
  if (v < 0n || v > UINT32_MAX) return err('VALUE_OUT_OF_RANGE');
  return ok(v);
}

/**
 * Accepts a `bigint`, or a decimal string, and nothing else.
 *
 * A `number` is deliberately refused even when integral: accepting one would
 * make the boundary between safe and unsafe numeric input depend on magnitude,
 * which is exactly the class of bug the bigint rule exists to prevent.
 */
export function parseBigInt(raw: unknown): bigint | undefined {
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'string') {
    if (!/^-?(0|[1-9][0-9]*)$/.test(raw)) return undefined;
    return BigInt(raw);
  }
  return undefined;
}

export function parseClock(raw: unknown): Result<Clock, ReasonCodeName> {
  if (typeof raw !== 'object' || raw === null) return err('MALFORMED_TRUSTED_STATE');
  const now = parseUnixSeconds((raw as Record<string, unknown>)['nowUnixSeconds'], 'MALFORMED_TRUSTED_STATE');
  if (!now.ok) return now;
  return ok({ nowUnixSeconds: now.value });
}
