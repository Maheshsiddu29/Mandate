/**
 * One model call, bounded and validated.
 *
 * ```text
 * request ─▶ provider (streams; first chunk timed) ─▶ raw text ─▶ strict parse ─▶ value
 *              │ timeout: abort, TIMED_OUT          │ throw: FAILED    │ reject: INVALID_RESPONSE
 * ```
 *
 * The outcome is a runtime fact, never an authorization decision. A call
 * that times out keeps running in the background only so its late answer
 * can be *observed* (`onLate`) and recorded as ignored; it is never used.
 * Durations are monotonic; any artificial delay a chaos wrapper injected is
 * reported as `injectedLatencyMs` and excluded from `providerLatencyMs`.
 */

import type { Clock } from './clock.ts';
import { describeFailure } from './errors.ts';
import { callProvider, type AgentModelProvider, type ModelRequest, type ModelResponse } from './provider.ts';
import type { Parsed } from './strict-json.ts';

export const CALL_STATUSES = ['RESPONDED', 'TIMED_OUT', 'FAILED', 'INVALID_RESPONSE'] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export interface CallTiming {
  readonly requestStartedAt: string;
  readonly firstResponseAt: string | null;
  readonly responseCompletedAt: string | null;
  readonly decisionValidatedAt: string | null;
  /** Monotonic milliseconds, for deriving durations. */
  readonly startMs: number;
  readonly firstMs: number | null;
  readonly completedMs: number | null;
  readonly validatedMs: number | null;
  readonly providerLatencyMs: number | null;
  readonly timeToFirstResponseMs: number | null;
  readonly validationLatencyMs: number | null;
  readonly injectedLatencyMs: number;
}

export type CallOutcome<T> =
  | { readonly status: 'RESPONDED'; readonly value: T; readonly timing: CallTiming }
  | { readonly status: 'TIMED_OUT' | 'FAILED' | 'INVALID_RESPONSE'; readonly error: string; readonly timing: CallTiming };

export interface CallSpec<T> {
  readonly provider: AgentModelProvider;
  readonly request: ModelRequest;
  readonly parse: (text: string) => Parsed<T>;
  readonly timeoutMs: number;
  readonly clock: Clock;
  readonly onFirstChunk?: () => void;
  /** The answer of a call that had already timed out: observed, never used. */
  readonly onLate?: (late: CallOutcome<T>) => void;
  /** Receives a promise that settles when the provider call itself does — including after a timeout — so a caller can wait for late answers. */
  readonly track?: (settled: Promise<void>) => void;
}

const round = (ms: number) => Math.round(ms * 10) / 10;

export async function callModel<T>(spec: CallSpec<T>): Promise<CallOutcome<T>> {
  const { clock } = spec;
  const startMs = clock.nowMs();
  const requestStartedAt = clock.wallIso();
  let firstMs: number | null = null;
  let firstAt: string | null = null;
  const abort = new AbortController();
  const timer = new AbortController();
  let settled = false;

  const timing = (completedMs: number | null, completedAt: string | null, validatedMs: number | null, validatedAt: string | null, injected: number): CallTiming => {
    const first = firstMs ?? completedMs;
    return {
      requestStartedAt,
      firstResponseAt: firstAt ?? completedAt,
      responseCompletedAt: completedAt,
      decisionValidatedAt: validatedAt,
      startMs,
      firstMs: first,
      completedMs,
      validatedMs,
      providerLatencyMs: completedMs === null ? null : round(Math.max(0, completedMs - startMs - injected)),
      timeToFirstResponseMs: first === null ? null : round(Math.max(0, first - startMs - injected)),
      validationLatencyMs: validatedMs === null || completedMs === null ? null : round(validatedMs - completedMs),
      injectedLatencyMs: injected,
    };
  };

  const finish = (r: { ok: true; response: ModelResponse } | { ok: false; error: unknown }): CallOutcome<T> => {
    const completedMs = clock.nowMs();
    const completedAt = clock.wallIso();
    if (!r.ok) return { status: 'FAILED', error: describeFailure(r.error), timing: timing(completedMs, completedAt, null, null, 0) };
    const injected = r.response.injectedLatencyMs ?? 0;
    const parsed = spec.parse(r.response.text);
    const validatedMs = clock.nowMs();
    const t = timing(completedMs, completedAt, validatedMs, clock.wallIso(), injected);
    return parsed.ok ? { status: 'RESPONDED', value: parsed.value, timing: t } : { status: 'INVALID_RESPONSE', error: parsed.error, timing: t };
  };

  const call = callProvider(spec.provider, spec.request, {
    signal: abort.signal,
    onFirstChunk: () => {
      if (firstMs !== null) return;
      firstMs = clock.nowMs();
      firstAt = clock.wallIso();
      if (!settled) spec.onFirstChunk?.();
    },
  }).then(
    (response) => ({ ok: true as const, response }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const deadline = clock.sleep(spec.timeoutMs, timer.signal).then(
    () => 'TIMEOUT' as const,
    () => 'CANCELLED' as const,
  );

  const first = await Promise.race([call, deadline]);
  if (first === 'TIMEOUT' || first === 'CANCELLED') {
    settled = true;
    abort.abort();
    const out: CallOutcome<T> = { status: 'TIMED_OUT', error: `no answer within ${spec.timeoutMs} ms`, timing: timing(null, null, null, null, 0) };
    const onLate = spec.onLate;
    const background = call.then((r) => {
      // An abort-induced rejection is the timeout itself, not a late answer.
      if (r.ok && onLate !== undefined) onLate(finish(r));
    });
    spec.track?.(background);
    return out;
  }
  settled = true;
  timer.abort();
  return finish(first);
}
