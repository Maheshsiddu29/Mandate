import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider, type FetchLike } from '../src/runtime/openai-provider.ts';
import { callModel } from '../src/runtime/agent-runtime.ts';
import { realClock } from '../src/runtime/clock.ts';
import { describeFailure, ProviderError } from '../src/runtime/errors.ts';
import { LatencyChaosProvider, parseChaosSpec } from '../src/runtime/latency-chaos.ts';
import { StubProvider } from '../src/runtime/stub-provider.ts';
import type { DecisionRequest, NegotiationRequest } from '../src/runtime/provider.ts';
import { parseDecision, parseNegotiation } from '../src/runtime/schemas.ts';
import { readConfig, describeConfig } from '../src/config.ts';
import { ScriptedProvider, json } from './support/providers.ts';

const KEY = 'sk-test-THIS-IS-NOT-A-REAL-KEY-0123456789abcdef';

const decision: DecisionRequest = {
  kind: 'DECISION',
  role: 'swap',
  objective: 'Maximize execution quality.',
  authority: { role: 'swap', mandateVersion: 1, domain: 'swap-fixture', maxAllocationAtoms: '500000000', exposure: null, maxLeverage: null, maxSlippageBps: 50, maxQuoteAgeSeconds: '60' },
  portfolio: { deployableAtoms: '2000000000', availableAtoms: '2000000000', enabledAgents: ['swap'] },
  candidates: [
    { id: 'route-a', title: 'USDC→WETH via router 5a01', facts: [], untrustedText: null, minAtoms: '100000000', maxAtoms: '500000000', resizable: true, advisoryRank: null },
    { id: 'route-b', title: 'USDC→WETH via router bad0', facts: [], untrustedText: null, minAtoms: '100000000', maxAtoms: '500000000', resizable: true, advisoryRank: null },
  ],
};

const negotiation: NegotiationRequest = {
  kind: 'NEGOTIATION',
  role: 'perps',
  objective: 'BTC exposure.',
  roomId: 'room-1',
  generation: 1,
  portfolioAuthorityAtoms: '2000000000',
  admissibleDemandAtoms: '2200000000',
  requiredReductionAtoms: '200000000',
  constraints: [],
  candidateTitle: 'BTC long 2x',
  yourCurrentAtoms: '600000000',
  yourMinimumAtoms: '100000000',
  yourOwnLimitAtoms: '600000000',
  permittedActions: ['KEEP', 'REDUCE', 'RELEASE', 'ABSTAIN'],
  participants: [],
};

function sse(events: readonly unknown[]): Response {
  const body = events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('OpenAI Responses provider (offline, fake network)', () => {
  it('sends strict structured output, streamed, not stored — and never the key in the body', () => {
    const p = new OpenAIProvider({ apiKey: KEY, model: 'test-model' });
    const body = JSON.parse(p.body(decision)) as { model: string; stream: boolean; store: boolean; text: { format: { type: string; strict: boolean; schema: { additionalProperties: boolean; properties: { candidateId: { enum: unknown[] } } } } }; input: string };
    assert.equal(body.model, 'test-model');
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.schema.additionalProperties, false);
    assert.deepEqual(body.text.format.schema.properties.candidateId.enum, ['route-a', 'route-b', null]);
    assert.doesNotMatch(p.body(decision), /sk-test/);
    assert.doesNotMatch(JSON.stringify(p), /sk-test/);
  });

  it('reads the stream, times the first chunk once, and prefers the final text', async () => {
    let auth = '';
    const fetch: FetchLike = async (_u, init) => {
      auth = init.headers['authorization'] ?? '';
      return sse([{ type: 'response.created' }, { type: 'response.output_text.delta', delta: '{"action":' }, { type: 'response.output_text.delta', delta: '"ABSTAIN"' }, { type: 'response.output_text.done', text: '{"action":"ABSTAIN","candidateId":null,"requestedAtoms":null,"rationale":"none fit"}' }, { type: 'response.completed' }]);
    };
    const p = new OpenAIProvider({ apiKey: KEY, model: 'm', fetch });
    let first = 0;
    const r = await p.decide(decision, { signal: new AbortController().signal, onFirstChunk: () => (first += 1) });
    assert.equal(first, 1);
    assert.equal(auth, `Bearer ${KEY}`);
    assert.equal(parseDecision(r.text, decision).ok, true);
  });

  it('an HTTP error is reported by status and code only — never the body, never the key', async () => {
    const fetch: FetchLike = async () => new Response(JSON.stringify({ error: { code: 'invalid_api_key', message: `Incorrect API key provided: ${KEY}` } }), { status: 401 });
    const p = new OpenAIProvider({ apiKey: KEY, model: 'm', fetch });
    const out = await callModel({ provider: p, request: decision, parse: (t) => parseDecision(t, decision), timeoutMs: 1_000, clock: realClock });
    assert.equal(out.status, 'FAILED');
    if ('error' in out) {
      assert.match(out.error, /HTTP 401.*invalid_api_key/);
      assert.doesNotMatch(out.error, /sk-test|Incorrect/);
    }
  });

  it('a refusal and a failed response are failures, not decisions', async () => {
    for (const events of [[{ type: 'response.refusal.delta', delta: 'no' }], [{ type: 'response.failed', response: { error: { code: 'server_error' } } }]]) {
      const p = new OpenAIProvider({ apiKey: KEY, model: 'm', fetch: async () => sse(events) });
      const out = await callModel({ provider: p, request: decision, parse: (t) => parseDecision(t, decision), timeoutMs: 1_000, clock: realClock });
      assert.equal(out.status, 'FAILED');
    }
  });

  it('test 12: a provider timeout aborts the request', async () => {
    let aborted = false;
    const fetch: FetchLike = (_u, init) =>
      new Promise((_, reject) => init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      }));
    const p = new OpenAIProvider({ apiKey: KEY, model: 'm', fetch });
    const out = await callModel({ provider: p, request: decision, parse: (t) => parseDecision(t, decision), timeoutMs: 30, clock: realClock });
    assert.equal(out.status, 'TIMED_OUT');
    assert.equal(aborted, true);
    assert.equal(out.timing.providerLatencyMs, null);
  });

  it('refuses to exist without a key; configuration never prints one', () => {
    assert.throws(() => new OpenAIProvider({ apiKey: ' ', model: 'm' }), ProviderError);
    const c = readConfig({ OPENAI_API_KEY: KEY });
    assert.match(describeConfig(c), /OPENAI_API_KEY present/);
    assert.doesNotMatch(describeConfig(c), /sk-test/);
    assert.equal(readConfig({}).openaiApiKey, null);
    assert.equal(describeFailure(new Error(KEY)), 'provider error');
  });
});

describe('strict decision schema (tests 14–17)', () => {
  const ok = { action: 'PROPOSE', candidateId: 'route-a', requestedAtoms: '300000000', rationale: 'Best reviewed route.' };

  it('accepts exactly the schema', () => {
    const d = parseDecision(json(ok), decision);
    assert.ok(d.ok);
    assert.equal(d.value.requestedAtoms, 300_000_000n);
  });

  it('test 14: malformed output cannot become a proposal', () => {
    for (const bad of ['', 'PROPOSE route-a', '[]', json({ ...ok, requestedAtoms: 300000000 }), json({ ...ok, requestedAtoms: '3e8' }), json({ ...ok, requestedAtoms: '300.5' }), json({ ...ok, requestedAtoms: '-1' }), json({ ...ok, action: 'propose' }), json({ ...ok, rationale: 'x'.repeat(281) }), json({ action: 'ABSTAIN', candidateId: 'route-a', requestedAtoms: null, rationale: '' })]) {
      assert.equal(parseDecision(bad, decision).ok, false, bad);
    }
  });

  it('test 15: an unknown candidate cannot be selected', () => {
    assert.equal(parseDecision(json({ ...ok, candidateId: 'route-c' }), decision).ok, false);
    assert.equal(parseDecision(json({ ...ok, candidateId: 'ROUTE-A' }), decision).ok, false);
  });

  it('tests 16–17: a model cannot inject a recipient, a venue, a tool or calldata', () => {
    for (const extra of [{ recipient: 'eip155:421614/account:0x9999999999999999999999999999999999999999' }, { router: '0xbad0' }, { venue: 'attacker-dex' }, { tool: 'shell' }, { calldata: '0xa9059cbb' }]) {
      const d = parseDecision(json({ ...ok, ...extra }), decision);
      assert.equal(d.ok, false);
      if (!d.ok) assert.match(d.error, /unexpected field/);
    }
  });

  it('amounts outside the supplied bounds are refused', () => {
    assert.equal(parseDecision(json({ ...ok, requestedAtoms: '99999999' }), decision).ok, false);
    assert.equal(parseDecision(json({ ...ok, requestedAtoms: '500000001' }), decision).ok, false);
  });
});

describe('strict negotiation schema', () => {
  const n = (v: unknown) => parseNegotiation(json(v), negotiation);
  it('KEEP, REDUCE, RELEASE and ABSTAIN mean exactly what they say', () => {
    const keep = n({ action: 'KEEP', newRequestedAtoms: null, rationale: '' });
    assert.ok(keep.ok && keep.value.newAtoms === 600_000_000n);
    const reduce = n({ action: 'REDUCE', newRequestedAtoms: '450000000', rationale: '' });
    assert.ok(reduce.ok && reduce.value.newAtoms === 450_000_000n);
    const release = n({ action: 'RELEASE', newRequestedAtoms: null, rationale: '' });
    assert.ok(release.ok && release.value.newAtoms === 0n);
    const abstain = n({ action: 'ABSTAIN', newRequestedAtoms: null, rationale: '' });
    assert.ok(abstain.ok && abstain.value.newAtoms === 600_000_000n);
  });
  it('refuses a reduce that is not a reduction, goes below the minimum, or increases', () => {
    for (const atoms of ['600000000', '700000000', '0', '50000000']) assert.equal(n({ action: 'REDUCE', newRequestedAtoms: atoms, rationale: '' }).ok, false, atoms);
    assert.equal(n({ action: 'KEEP', newRequestedAtoms: '500000000', rationale: '' }).ok, false);
    assert.equal(n({ action: 'REDUCE', newRequestedAtoms: '450000000', rationale: '', speakFor: 'stock' }).ok, false);
    assert.equal(parseNegotiation(json({ action: 'REDUCE', newRequestedAtoms: '450000000', rationale: '' }), { ...negotiation, permittedActions: ['KEEP', 'RELEASE', 'ABSTAIN'] }).ok, false);
  });
});

describe('latency chaos (tests 13, 49)', () => {
  it('injected latency is labelled and excluded from provider latency', async () => {
    const plan = parseChaosSpec('swap:250');
    assert.ok(Array.isArray(plan));
    const chaos = new LatencyChaosProvider(new StubProvider(0), plan, realClock);
    const out = await callModel({ provider: chaos, request: decision, parse: (t) => parseDecision(t, decision), timeoutMs: 2_000, clock: realClock });
    assert.equal(out.status, 'RESPONDED');
    assert.equal(out.timing.injectedLatencyMs, 250);
    assert.ok((out.timing.providerLatencyMs ?? Infinity) < 200, `provider latency ${out.timing.providerLatencyMs}`);
  });

  it('test 13: a forced failure is FAILED; a forced hang is TIMED_OUT', async () => {
    const fail = parseChaosSpec('decide.swap:failure');
    const hang = parseChaosSpec('swap:timeout');
    assert.ok(Array.isArray(fail) && Array.isArray(hang));
    const f = await callModel({ provider: new LatencyChaosProvider(new StubProvider(0), fail, realClock), request: decision, parse: (t) => parseDecision(t, decision), timeoutMs: 500, clock: realClock });
    assert.equal(f.status, 'FAILED');
    if ('error' in f) assert.match(f.error, /INJECTED_FAILURE/);
    const h = await callModel({ provider: new LatencyChaosProvider(new StubProvider(0), hang, realClock), request: decision, parse: (t) => parseDecision(t, decision), timeoutMs: 40, clock: realClock });
    assert.equal(h.status, 'TIMED_OUT');
  });

  it('only the documented delays are accepted from a spec', () => {
    assert.ok('error' in parseChaosSpec('swap:500'));
    assert.ok('error' in parseChaosSpec('treasurer:250'));
    assert.ok(Array.isArray(parseChaosSpec('room.perps:3000,*:0,stock:timeout')));
  });

  it('a scripted slow first chunk is timed separately from completion', async () => {
    const p = new ScriptedProvider({ decide: () => ({ text: json({ action: 'ABSTAIN', candidateId: null, requestedAtoms: null, rationale: 'x' }), firstChunkAfterMs: 20, delayMs: 60 }) });
    const out = await callModel({ provider: p, request: decision, parse: (t) => parseDecision(t, decision), timeoutMs: 1_000, clock: realClock });
    assert.equal(out.status, 'RESPONDED');
    assert.ok((out.timing.timeToFirstResponseMs ?? 0) >= 15);
    assert.ok((out.timing.providerLatencyMs ?? 0) >= (out.timing.timeToFirstResponseMs ?? 0) + 20);
  });
});
