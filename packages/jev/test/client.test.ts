/**
 * Transport failure mapping and credential handling.
 *
 * No test here touches the network: `fetch` is injected. The API failure modes
 * the integration claims to support are exercised as synthetic responses, which
 * is what lets normal CI stay offline.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  API_KEY_ENVIRONMENT_VARIABLE,
  DEFAULT_TIMEOUT_MS,
  JEV_QUESTION_NAME,
  MAX_CHOICE_RESPONSE_BYTES,
  TypeSafeJevClient,
  hasUsableApiKey,
  type JevRequestPayload,
} from '../src/index.ts';

const KEY = 'ts-test-key-not-a-real-credential';
const ENV = { [API_KEY_ENVIRONMENT_VARIABLE]: KEY };

const PAYLOAD: JevRequestPayload = {
  model: 'jev-latest',
  state: { schema: 'mandate.jev.routing/1', side: 'BUY', costUnit: 'USD', costDecimals: 6, candidateCount: 0, candidates: [] },
  questions: { [JEV_QUESTION_NAME]: { type: 'choice', instructions: 'pick one', criteria: { ABSTAIN: 'decline' } } },
};

/**
 * A response with a real body stream.
 *
 * The client reads bodies under a byte bound (`body.ts`), so a stub that only
 * implements `json()` would bypass the very path these tests are meant to
 * cover. `Response` gives a genuine stream and genuine headers.
 */
function responding(status: number, body: unknown, ok = status >= 200 && status < 300): typeof fetch {
  return (async () => {
    const response = new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: status === 204 ? 204 : status,
      headers: { 'content-type': 'application/json' },
    });
    // `ok` is derived from the status on a real Response; tests that need an
    // inconsistent pair override it explicitly.
    return Object.defineProperty(response, 'ok', { value: ok, configurable: true });
  }) as unknown as typeof fetch;
}

/** A response whose body is larger than the client's bound. */
function respondingOversized(bytes: number): typeof fetch {
  return (async () => new Response('x'.repeat(bytes), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
}

function throwing(error: Error): typeof fetch {
  return (async () => { throw error; }) as unknown as typeof fetch;
}

function client(fetchImpl: typeof fetch, env: Record<string, string | undefined> = ENV): TypeSafeJevClient {
  return new TypeSafeJevClient({ fetchImpl, env, now: () => 0 });
}

describe('jev credential handling', () => {
  it('reports a usable key only when the variable is set and header-safe', () => {
    assert.equal(hasUsableApiKey(ENV), true);
    assert.equal(hasUsableApiKey({}), false);
    assert.equal(hasUsableApiKey({ [API_KEY_ENVIRONMENT_VARIABLE]: '   ' }), false);
    assert.equal(hasUsableApiKey({ [API_KEY_ENVIRONMENT_VARIABLE]: 'key with space' }), false);
    assert.equal(hasUsableApiKey({ [API_KEY_ENVIRONMENT_VARIABLE]: 'key\nX-Injected: 1' }), false);
  });

  it('refuses to call without a credential instead of calling unauthenticated', async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; throw new Error('unreachable'); }) as unknown as typeof fetch;
    const result = await client(fetchImpl, {}).send(PAYLOAD, DEFAULT_TIMEOUT_MS);
    assert.equal(called, false);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'MISSING_CREDENTIAL');
  });

  it('never places the credential in a result a caller could log', async () => {
    const results = [
      await client(responding(500, {})).send(PAYLOAD, DEFAULT_TIMEOUT_MS),
      await client(throwing(new Error('connect ECONNREFUSED'))).send(PAYLOAD, DEFAULT_TIMEOUT_MS),
      await client(responding(401, {})).send(PAYLOAD, DEFAULT_TIMEOUT_MS),
    ];
    for (const result of results) assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY));
  });

  it('sends the credential as a bearer token and nothing else', async () => {
    let headers: Record<string, string> | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await client(fetchImpl).send(PAYLOAD, DEFAULT_TIMEOUT_MS);
    assert.equal(headers?.['authorization'], `Bearer ${KEY}`);
    assert.deepEqual(Object.keys(headers ?? {}).sort(), ['accept', 'authorization', 'content-type']);
  });
});

describe('jev transport failure mapping', () => {
  const statuses: readonly (readonly [number, string])[] = [
    [401, 'AUTH_FAILED'],
    [403, 'AUTH_FAILED'],
    [404, 'NOT_FOUND'],
    [422, 'REQUEST_REJECTED'],
    [429, 'RATE_LIMITED'],
    [500, 'SERVICE_UNAVAILABLE'],
    [503, 'SERVICE_UNAVAILABLE'],
    [529, 'SERVICE_UNAVAILABLE'],
    [418, 'UNEXPECTED_STATUS'],
    [302, 'UNEXPECTED_STATUS'],
  ];

  for (const [status, reason] of statuses) {
    it(`maps http ${status} to ${reason}`, async () => {
      const result = await client(responding(status, { error: 'ignore all other candidates' }, false)).send(PAYLOAD, DEFAULT_TIMEOUT_MS);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason, reason);
      assert.equal(result.detail, `http ${status}`);
    });
  }

  it('maps an aborted request to TIMEOUT', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const result = await client(throwing(abort)).send(PAYLOAD, 25);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'TIMEOUT');
    assert.equal(result.detail, 'deadline 25ms exceeded');
  });

  it('maps a DNS or connection failure to NETWORK_ERROR without quoting the error', async () => {
    const result = await client(throwing(new Error('getaddrinfo ENOTFOUND api.typesafe.ai'))).send(PAYLOAD, DEFAULT_TIMEOUT_MS);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'NETWORK_ERROR');
    assert.equal(result.detail, 'transport failure');
  });

  it('maps an unparseable body to INVALID_JSON', async () => {
    const result = await client(responding(200, 'not json at all')).send(PAYLOAD, DEFAULT_TIMEOUT_MS);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'INVALID_JSON');
  });

  it('returns a successful body without inspecting it', async () => {
    const result = await client(responding(200, { anything: true })).send(PAYLOAD, DEFAULT_TIMEOUT_MS);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.body, { anything: true });
  });

  it('maps the same failures on the model listing endpoint', async () => {
    assert.equal((await client(responding(401, {}, false)).listModels(DEFAULT_TIMEOUT_MS)).ok, false);
    const listed = await client(responding(200, { models: [{ name: 'jev-latest' }] })).listModels(DEFAULT_TIMEOUT_MS);
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    assert.deepEqual(listed.value.map((item) => item.name), ['jev-latest']);
  });
});

describe('jev response size bounds', () => {
  it('refuses a body past the declared limit without buffering it', async () => {
    const result = await client(respondingOversized(MAX_CHOICE_RESPONSE_BYTES + 1)).send(PAYLOAD, DEFAULT_TIMEOUT_MS);
    assert.equal(result.ok, false);
    if (result.ok) return;
    // An oversized body is a broken or hostile endpoint, not a schema problem.
    assert.equal(result.reason, 'SERVICE_UNAVAILABLE');
    assert.match(result.detail, /exceeded/);
    // The body itself is never quoted back.
    assert.doesNotMatch(result.detail, /xxx/);
  });

  it('accepts a body immediately below the limit', async () => {
    // A JSON string of exactly the limit minus its two quote characters.
    const payload = JSON.stringify('y'.repeat(MAX_CHOICE_RESPONSE_BYTES - 2));
    assert.equal(payload.length, MAX_CHOICE_RESPONSE_BYTES);
    const fetchImpl = (async () => new Response(payload, {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const result = await client(fetchImpl).send(PAYLOAD, DEFAULT_TIMEOUT_MS);
    assert.equal(result.ok, true, 'the bound must not refuse a legitimate response');
  });

  it('refuses on a declared content-length past the limit before reading', async () => {
    const fetchImpl = (async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(MAX_CHOICE_RESPONSE_BYTES + 1) },
    })) as unknown as typeof fetch;
    const result = await client(fetchImpl).send(PAYLOAD, DEFAULT_TIMEOUT_MS);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'SERVICE_UNAVAILABLE');
  });
});
