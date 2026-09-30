import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { LiveLab, type ApiRequest } from '../src/server/app.ts';
import { createLabServer, listen, MAX_BODY_BYTES } from '../src/server/http.ts';
import { OpenAIProvider } from '../src/runtime/openai-provider.ts';
import { realClock } from '../src/runtime/clock.ts';
import type { JsonObject, JsonValue } from '../src/runtime/strict-json.ts';
import { containsKey } from './support/world.ts';

/** A placeholder, deliberately not key-shaped so the repository credential scan stays meaningful. */
const FAKE_KEY = 'FAKEKEY-s3rv';
const ORIGIN = 'http://localhost:3000';

function lab(live = false): LiveLab {
  const provider = live ? new OpenAIProvider({ apiKey: FAKE_KEY, model: 'test-model', fetch: () => Promise.reject(new Error('offline')) }) : null;
  return new LiveLab({ live: provider, clock: realClock, agentTimeoutMs: 1_000, roomRoundTimeoutMs: 1_000, allowChaos: false, maxSessions: 2 });
}

const req = (method: string, path: string, body: JsonValue | null = null): ApiRequest => ({ method, path, query: new URLSearchParams(), body });
const obj = (v: JsonValue | undefined): JsonObject => (v ?? {}) as JsonObject;

async function until(fn: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out waiting');
}

describe('the local API (transport-independent)', () => {
  it('reports whether the live provider exists, and never the key', async () => {
    for (const live of [false, true]) {
      const r = await lab(live).handle(req('GET', '/api/live/status'));
      assert.equal(r.status, 200);
      assert.equal(obj(obj(obj(r.body)['providers'])['openai'])['available'], live);
      assert.doesNotMatch(JSON.stringify(r.body), /FAKEKEY/);
    }
  });

  it('refuses an OpenAI session without a key; the stub is always available', async () => {
    const l = lab(false);
    assert.equal((await l.handle(req('POST', '/api/live/sessions', { provider: 'openai' }))).status, 409);
    assert.equal((await l.handle(req('POST', '/api/live/sessions', { provider: 'stub' }))).status, 201);
    assert.equal((await l.handle(req('POST', '/api/live/sessions', { provider: 'shell' }))).status, 400);
  });

  it('a full stub session: draft, edit, exact confirmation, run, policy stress — every response free of any key', async () => {
    const l = lab(true);
    const created = await l.handle(req('POST', '/api/live/sessions', { provider: 'stub' }));
    const id = String(obj(created.body)['sessionId']);
    const at = (p: string) => `/api/live/sessions/${id}${p}`;
    const bodies: JsonValue[] = [created.body];
    const call = async (method: string, p: string, body: JsonValue | null = null) => {
      const r = await l.handle(req(method, at(p), body));
      bodies.push(r.body);
      return r;
    };

    assert.equal((await call('POST', '/authorize', { confirmation: 'AUTHORIZE MANDATE V1' })).status, 409);
    assert.equal((await call('POST', '/draft', { preset: 'balanced' })).status, 200);
    assert.equal((await call('POST', '/draft/field', { path: 'agents.perps.maxAllocation', value: '500' })).status, 200);
    assert.equal((await call('POST', '/draft/field', { path: 'portfolio.__proto__', value: 'x' })).status, 400);
    assert.equal((await call('POST', '/draft/field', { path: 'market.venues', value: ['0x000000000000000000000000000000000000bad0'] })).status, 400);
    assert.equal((await call('POST', '/draft/field', { path: 'agents.swap.enabled', value: 'yes' })).status, 400);
    const wrong = await call('POST', '/authorize', { confirmation: 'authorize mandate v1' });
    assert.equal(wrong.status, 409);
    assert.equal(obj(wrong.body)['error'], 'CONFIRMATION_REQUIRED');
    assert.equal(obj(wrong.body)['activeVersion'], null);
    const good = await call('POST', '/authorize', { confirmation: 'AUTHORIZE MANDATE V1' });
    assert.equal(good.status, 200);
    assert.equal(obj(good.body)['activeVersion'], 1);

    assert.equal((await call('POST', '/run')).status, 202);
    assert.equal((await call('POST', '/run')).status, 409);
    await until(async () => obj((await call('GET', '')).body)['task'] === null);
    const afterRun = obj((await call('GET', '')).body);
    assert.equal(obj(afterRun['lastRun'])['status'], 'AUTHORIZED');

    assert.equal((await call('POST', '/policy-stress', { maxAttempts: 99 })).status, 400);
    assert.equal((await call('POST', '/policy-stress', { maxAttempts: 5 })).status, 202);
    await until(async () => obj((await call('GET', '')).body)['task'] === null);
    const stress = obj(obj((await call('GET', '')).body)['lastPolicyStress']);
    assert.equal(stress['endedBy'], 'MAX_ATTEMPTS');

    const events: string[] = [];
    const stop = l.subscribe(id, -1, (e) => events.push(JSON.stringify(e)));
    stop?.();
    const all = `${JSON.stringify(bodies)}\n${events.join('\n')}`;
    assert.doesNotMatch(all, /FAKEKEY|OPENAI_API_KEY=/);
    assert.equal(containsKey(all), false);
  });

  it('bounds the number of sessions', async () => {
    const l = lab(false);
    assert.equal((await l.handle(req('POST', '/api/live/sessions', {}))).status, 201);
    assert.equal((await l.handle(req('POST', '/api/live/sessions', {}))).status, 201);
    assert.equal((await l.handle(req('POST', '/api/live/sessions', {}))).status, 429);
  });

  it('latency chaos is refused unless the server allows it', async () => {
    assert.equal((await lab(false).handle(req('POST', '/api/live/sessions', { provider: 'stub', chaos: 'perps:3000' }))).status, 403);
  });
});

describe('the HTTP binding', () => {
  let server: Server;
  let port = 0;

  before(async () => {
    server = createLabServer(lab(true), { port: 0, allowedOrigins: [ORIGIN] });
    await listen(server, 0);
    port = (server.address() as AddressInfo).port;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  function raw(o: { method: string; path: string; headers?: { [k: string]: string }; body?: string }): Promise<{ status: number; headers: { [k: string]: string | string[] | undefined }; text: string }> {
    return new Promise((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, method: o.method, path: o.path, headers: { host: `127.0.0.1:${port}`, ...o.headers } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          text += c;
          if ((res.headers['content-type'] ?? '').startsWith('text/event-stream') && text.includes('SESSION_STARTED')) res.destroy();
        });
        res.on('close', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      });
      r.on('error', reject);
      if (o.body !== undefined) r.write(o.body);
      r.end();
    });
  }

  it('listens on loopback only', () => {
    assert.equal((server.address() as AddressInfo).address, '127.0.0.1');
  });

  it('refuses a foreign Host (DNS rebinding) and a foreign Origin', async () => {
    assert.equal((await raw({ method: 'GET', path: '/api/live/status', headers: { host: `evil.example:${port}` } })).status, 421);
    assert.equal((await raw({ method: 'GET', path: '/api/live/status', headers: { origin: 'https://evil.example' } })).status, 403);
    const okay = await raw({ method: 'GET', path: '/api/live/status', headers: { origin: ORIGIN } });
    assert.equal(okay.status, 200);
    assert.equal(okay.headers['access-control-allow-origin'], ORIGIN);
    assert.doesNotMatch(okay.text, /FAKEKEY/);
  });

  it('requires JSON bodies of bounded size', async () => {
    assert.equal((await raw({ method: 'POST', path: '/api/live/sessions', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await raw({ method: 'POST', path: '/api/live/sessions', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
    assert.equal((await raw({ method: 'POST', path: '/api/live/sessions', headers: { 'content-type': 'application/json' }, body: `"${'x'.repeat(MAX_BODY_BYTES + 10)}"` })).status, 413);
  });

  it('streams MANDATE_LIVE_AI.V1 events as Server-Sent Events', async () => {
    const created = await raw({ method: 'POST', path: '/api/live/sessions', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ provider: 'stub' }) });
    assert.equal(created.status, 201);
    const id = String((JSON.parse(created.text) as { sessionId: string }).sessionId);
    const stream = await raw({ method: 'GET', path: `/api/live/sessions/${id}/events?after=-1`, headers: { origin: ORIGIN } });
    assert.match(String(stream.headers['content-type']), /text\/event-stream/);
    assert.match(stream.text, /^id: 0\nevent: live\ndata: \{"schema":"MANDATE_LIVE_AI\.V1"/);
  });
});
