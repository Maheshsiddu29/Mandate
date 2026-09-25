/**
 * The TypeSafe HTTP client — the only network-aware module in this package.
 *
 * It is a transport and nothing else: it obtains a body, maps every failure to
 * one stable reason code, and makes no claim about what the body contains.
 * Validation lives in `parse.ts`, on the caller's side of the seam.
 *
 * Credential rules, enforced here rather than by convention:
 *
 * - the key is read from `TYPESAFE_API_KEY` and from no other source;
 * - it is never returned, logged, thrown, or placed in a `detail` string;
 * - a key containing whitespace or control characters is refused rather than
 *   being interpolated into a header.
 *
 * The client does not retry. A retry inside a routing decision spends the
 * latency budget that exists to keep the trading path responsive, and the
 * deterministic fallback is already correct (ADR 0013).
 *
 * Response bodies are read under an explicit byte bound. A choice answer is a
 * few hundred bytes and the model listing is a few kilobytes, so the limits are
 * generous by orders of magnitude and exist to stop unbounded allocation, not
 * to police the vendor's schema.
 */

import { BodyReadError, readJsonBounded } from './body.ts';
import { parseJevModels, type ParseOutcome } from './parse.ts';
import {
  DEFAULT_BASE_URL,
  JevFallbackReason,
  type JevModelDescriptor,
  type JevRequestPayload,
  type JevTransport,
  type JevTransportOutcome,
} from './types.ts';

export interface JevClientOptions {
  readonly baseUrl?: string;
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injected for tests. Defaults to `performance.now`. */
  readonly now?: () => number;
}

export const API_KEY_ENVIRONMENT_VARIABLE = 'TYPESAFE_API_KEY';

/**
 * Byte bounds on response bodies.
 *
 * A `choice` answer is a few hundred bytes even with a full probability map at
 * the parser's 256-entry limit; 1 MiB is roughly three orders of magnitude of
 * headroom. The model listing is larger and rarer, so it gets 4 MiB. Both exist
 * to bound allocation, and neither is tight enough to refuse a legitimate
 * response.
 */
export const MAX_CHOICE_RESPONSE_BYTES = 1024 * 1024;
export const MAX_MODELS_RESPONSE_BYTES = 4 * 1024 * 1024;

function bodyFailureReason(error: BodyReadError): JevFallbackReason {
  // An oversized body is a broken or hostile endpoint, which is a service
  // problem rather than a schema one.
  return error === BodyReadError.NOT_JSON ? JevFallbackReason.INVALID_JSON : JevFallbackReason.SERVICE_UNAVAILABLE;
}

/**
 * Resolve the credential. Returns presence and validity only — the value is
 * kept inside the closure that uses it and is never part of a result a caller
 * could log.
 */
export function hasUsableApiKey(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return readApiKey(env) !== undefined;
}

function readApiKey(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const raw = env[API_KEY_ENVIRONMENT_VARIABLE];
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (value.length === 0) return undefined;
  // A header value with a control character or whitespace is a header-injection
  // vector, and a key that looks like one is a configuration error, not a key.
  if (/[^\x21-\x7e]/.test(value)) return undefined;
  return value;
}

function statusReason(status: number): JevFallbackReason {
  if (status === 401 || status === 403) return JevFallbackReason.AUTH_FAILED;
  if (status === 404) return JevFallbackReason.NOT_FOUND;
  if (status === 422) return JevFallbackReason.REQUEST_REJECTED;
  if (status === 429) return JevFallbackReason.RATE_LIMITED;
  if (status >= 500) return JevFallbackReason.SERVICE_UNAVAILABLE;
  return JevFallbackReason.UNEXPECTED_STATUS;
}

/**
 * Classify a thrown transport error without quoting its message.
 *
 * An error message can contain a request body, and a request body is data this
 * integration minimizes deliberately. The error's name is enough to separate a
 * deadline from a network failure.
 */
function throwReason(error: unknown): JevFallbackReason {
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') return JevFallbackReason.TIMEOUT;
  return JevFallbackReason.NETWORK_ERROR;
}

export class TypeSafeJevClient implements JevTransport {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #now: () => number;

  constructor(options: JevClientOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#env = options.env ?? process.env;
    this.#now = options.now ?? (() => performance.now());
  }

  async send(payload: JevRequestPayload, timeoutMs: number): Promise<JevTransportOutcome> {
    const started = this.#now();
    const elapsed = (): number => Math.max(0, Math.round(this.#now() - started));
    const key = readApiKey(this.#env);
    if (key === undefined) {
      return { ok: false, reason: JevFallbackReason.MISSING_CREDENTIAL, detail: `${API_KEY_ENVIRONMENT_VARIABLE} is unset or unusable`, latencyMs: elapsed() };
    }
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = throwReason(error);
      return { ok: false, reason, detail: reason === JevFallbackReason.TIMEOUT ? `deadline ${timeoutMs}ms exceeded` : 'transport failure', latencyMs: elapsed() };
    }
    if (!response.ok) {
      // The body is discarded: it is attacker-influenceable text of no
      // operational value beyond the status that already classified it.
      return { ok: false, reason: statusReason(response.status), detail: `http ${response.status}`, latencyMs: elapsed() };
    }
    const body = await readJsonBounded(response, MAX_CHOICE_RESPONSE_BYTES);
    if (!body.ok) {
      return {
        ok: false,
        reason: bodyFailureReason(body.error),
        // The body itself is never quoted; only its size and disposition.
        detail: body.error === BodyReadError.TOO_LARGE
          ? `response body exceeded ${MAX_CHOICE_RESPONSE_BYTES} bytes`
          : 'response body was not readable JSON',
        latencyMs: elapsed(),
      };
    }
    return { ok: true, body: body.value, latencyMs: elapsed() };
  }

  /**
   * `GET /v1/models`. Used by the characterization harness to discover what the
   * account may actually send; the decision path never calls it.
   */
  async listModels(timeoutMs: number): Promise<ParseOutcome<readonly JevModelDescriptor[]>> {
    const key = readApiKey(this.#env);
    if (key === undefined) {
      return { ok: false, reason: JevFallbackReason.MISSING_CREDENTIAL, detail: `${API_KEY_ENVIRONMENT_VARIABLE} is unset or unusable` };
    }
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/v1/models`, {
        method: 'GET',
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { ok: false, reason: throwReason(error), detail: 'transport failure' };
    }
    if (!response.ok) return { ok: false, reason: statusReason(response.status), detail: `http ${response.status}` };
    const body = await readJsonBounded(response, MAX_MODELS_RESPONSE_BYTES);
    if (!body.ok) {
      return {
        ok: false,
        reason: bodyFailureReason(body.error),
        detail: body.error === BodyReadError.TOO_LARGE
          ? `response body exceeded ${MAX_MODELS_RESPONSE_BYTES} bytes`
          : 'response body was not readable JSON',
      };
    }
    return parseJevModels(body.value);
  }
}
