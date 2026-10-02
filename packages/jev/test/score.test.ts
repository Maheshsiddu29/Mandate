/**
 * The Score primitive for opportunity cards (src/score.ts). Offline: `fetch`
 * is injected. A score is advisory: every failure is UNAVAILABLE with a
 * reason, nothing is invented, and the payload carries only the whitelisted
 * projection — never the credential.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  API_KEY_ENVIRONMENT_VARIABLE,
  JEV_SCORE_QUESTION_NAME,
  JevFallbackReason,
  SCORE_CRITERIA,
  TypeSafeJevClient,
  buildScorePayload,
  parseJevScoreResponse,
  scoreOpportunity,
  type JevOpportunityInput,
} from '../src/index.ts';

const KEY = 'ts-test-key-not-a-real-credential';
const INPUT: JevOpportunityInput = {
  card: {
    role: 'stock',
    action: 'PROPOSE',
    candidateTitle: 'NVDA · Fixture Backed NVIDIA Note',
    requestedAtoms: 600_000_000n,
    minimumUsefulAtoms: 100_000_000n,
    maximumUsefulAtoms: 750_500_000n,
    metrics: { opportunityQuality: 3, liquidity: 3, executionQuality: 4, downsideRisk: 2, dataConfidence: 2 },
    marketRegime: 'NEUTRAL',
    evidence: [{ kind: 'MARKET', evidence: 'FIXTURE' }, { kind: 'NEWS', evidence: 'DATA_UNAVAILABLE' }],
  },
  objective: 'Build useful NVDA exposure.',
  principalIntent: 'Prefer balanced risk-adjusted opportunities.',
  facts: [{ label: 'Price', value: '125.00 USDC per token (fixture)' }],
};
const ANSWER = { model: 'jev-1.13.0', answers: { [JEV_SCORE_QUESTION_NAME]: { type: 'score', score: 3.1, confidence: 0.82, legend: {}, probabilities: { '0': 0, '1': 0.02, '2': 0.1, '3': 0.63, '4': 0.25 } } }, usage: { input_tokens: 300, output_tokens: 20 } };

function client(body: unknown, status = 200, seen: { body?: string } = {}, env: { [k: string]: string | undefined } = { [API_KEY_ENVIRONMENT_VARIABLE]: KEY }): TypeSafeJevClient {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.body = String(init?.body ?? '');
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return new TypeSafeJevClient({ fetchImpl, env });
}

describe('Jev Score for opportunity cards', () => {
  it('builds a score question over five levels and a whitelisted state', () => {
    const p = buildScorePayload(INPUT);
    assert.equal(p.questions[JEV_SCORE_QUESTION_NAME].type, 'score');
    assert.equal(p.questions[JEV_SCORE_QUESTION_NAME].criteria.length, 5);
    assert.deepEqual(p.questions[JEV_SCORE_QUESTION_NAME].criteria, SCORE_CRITERIA);
    assert.equal(p.state.opportunity.requestedUsdc, '600');
    assert.equal(p.state.opportunity.maximumUsefulUsdc, '750.5');
    assert.deepEqual(Object.keys(p.state.opportunity).sort(), ['action', 'candidate', 'domain', 'evidence', 'facts', 'marketRegime', 'maximumUsefulUsdc', 'minimumUsefulUsdc', 'ratings', 'requestedUsdc'].sort());
  });

  it('scores a well-formed answer, and the key is only in the authorization header', async () => {
    const seen: { body?: string } = {};
    const r = await scoreOpportunity(client(ANSWER, 200, seen), INPUT);
    assert.equal(r.status, 'SCORED');
    if (r.status !== 'SCORED') return;
    assert.equal(r.score, 3.1);
    assert.equal(r.bps, 7750);
    assert.equal(seen.body?.includes(KEY), false);
    assert.equal(JSON.stringify(r).includes(KEY), false);
  });

  it('is UNAVAILABLE without a credential, and invents nothing', async () => {
    const r = await scoreOpportunity(client(ANSWER, 200, {}, {}), INPUT);
    assert.deepEqual({ status: r.status, reason: r.status === 'UNAVAILABLE' ? r.reason : null }, { status: 'UNAVAILABLE', reason: JevFallbackReason.MISSING_CREDENTIAL });
  });

  it('maps service failures to UNAVAILABLE with a reason', async () => {
    for (const [status, reason] of [[401, JevFallbackReason.AUTH_FAILED], [429, JevFallbackReason.RATE_LIMITED], [529, JevFallbackReason.SERVICE_UNAVAILABLE]] as const) {
      const r = await scoreOpportunity(client({}, status), INPUT);
      assert.equal(r.status === 'UNAVAILABLE' ? r.reason : null, reason);
    }
  });

  it('refuses every malformed answer without repairing it', () => {
    const answer = ANSWER.answers[JEV_SCORE_QUESTION_NAME];
    const withAnswer = (a: object) => ({ ...ANSWER, answers: { [JEV_SCORE_QUESTION_NAME]: { ...answer, ...a } } });
    const bad: unknown[] = [
      null,
      [],
      'text',
      { ...ANSWER, model: '' },
      { ...ANSWER, answers: {} },
      withAnswer({ type: 'choice' }),
      withAnswer({ score: 4.01 }),
      withAnswer({ score: -0.1 }),
      withAnswer({ score: Number.NaN }),
      withAnswer({ confidence: 1.5 }),
      withAnswer({ probabilities: { '0': 1 } }),
      withAnswer({ probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '5': 1 } }),
      withAnswer({ probabilities: { '0': 0, '1': 0, '2': 0, '3': 2, '4': 0 } }),
    ];
    for (const b of bad) {
      const r = parseJevScoreResponse(b);
      assert.equal(r.ok, false, JSON.stringify(b));
      if (!r.ok) assert.equal(r.reason, JevFallbackReason.SCHEMA_MISMATCH);
    }
  });

  it('a transport that never answers is a TIMEOUT, not a hang', async () => {
    const r = await scoreOpportunity({ send: () => new Promise(() => {}) }, INPUT, { timeoutMs: 20 });
    assert.equal(r.status === 'UNAVAILABLE' ? r.reason : null, JevFallbackReason.TIMEOUT);
  });
});
