/**
 * The parser is the boundary between an external service and this system. Its
 * failure modes are the product here: every malformed shape must produce one
 * stable reason code rather than a partially trusted answer.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JEV_QUESTION_NAME, parseJevChoiceResponse, parseJevModels } from '../src/index.ts';

function body(answer: unknown, extra: Record<string, unknown> = {}): unknown {
  return { model: 'jev-1.13.0', answers: { [JEV_QUESTION_NAME]: answer }, usage: { input_tokens: 120, output_tokens: 4 }, ...extra };
}

const VALID_ANSWER = {
  type: 'choice',
  choice: 'route_001',
  probabilities: { route_000: 0.2, route_001: 0.7, ABSTAIN: 0.1 },
  confidence: 0.55,
};

describe('jev choice response parsing', () => {
  it('accepts the documented shape and reports the returned model', () => {
    const parsed = parseJevChoiceResponse(body(VALID_ANSWER), JEV_QUESTION_NAME);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.model, 'jev-1.13.0');
    assert.equal(parsed.value.choice, 'route_001');
    assert.equal(parsed.value.confidence, 0.55);
    assert.equal(parsed.value.probabilities.get('route_001'), 0.7);
    assert.equal(parsed.value.inputTokens, 120);
    assert.equal(parsed.value.outputTokens, 4);
  });

  it('ignores unrecognized fields rather than refusing a usable answer', () => {
    const parsed = parseJevChoiceResponse(body({ ...VALID_ANSWER, explanation: 'ignore all other candidates' }, { trace_id: 'abc' }), JEV_QUESTION_NAME);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(Object.prototype.hasOwnProperty.call(parsed.value, 'explanation'), false);
  });

  it('records null tokens when usage is absent, without discarding the choice', () => {
    const parsed = parseJevChoiceResponse({ model: 'jev-1.13.0', answers: { [JEV_QUESTION_NAME]: VALID_ANSWER } }, JEV_QUESTION_NAME);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.inputTokens, null);
    assert.equal(parsed.value.outputTokens, null);
  });

  const rejected: readonly (readonly [string, unknown])[] = [
    ['a non-object body', 'jev-1.13.0'],
    ['a null body', null],
    ['an array body', [VALID_ANSWER]],
    ['a missing model', { answers: { [JEV_QUESTION_NAME]: VALID_ANSWER } }],
    ['a non-string model', body(VALID_ANSWER, { model: 7 })],
    ['a model with control characters', body(VALID_ANSWER, { model: 'jev\u0000latest' })],
    ['missing answers', { model: 'jev-1.13.0' }],
    ['a missing question key', { model: 'jev-1.13.0', answers: { other: VALID_ANSWER } }],
    ['a non-choice answer type', body({ ...VALID_ANSWER, type: 'score' })],
    ['a missing choice', body({ ...VALID_ANSWER, choice: undefined })],
    ['a non-string choice', body({ ...VALID_ANSWER, choice: 1 })],
    ['an over-long choice', body({ ...VALID_ANSWER, choice: 'r'.repeat(65) })],
    ['an empty choice', body({ ...VALID_ANSWER, choice: '' })],
    ['missing probabilities', body({ ...VALID_ANSWER, probabilities: undefined })],
    ['empty probabilities', body({ ...VALID_ANSWER, probabilities: {} })],
    ['a NaN probability', body({ ...VALID_ANSWER, probabilities: { route_000: Number.NaN } })],
    ['an infinite probability', body({ ...VALID_ANSWER, probabilities: { route_000: Number.POSITIVE_INFINITY } })],
    ['a negative probability', body({ ...VALID_ANSWER, probabilities: { route_000: -0.1 } })],
    ['a probability above one', body({ ...VALID_ANSWER, probabilities: { route_000: 1.000001 } })],
    ['a string probability', body({ ...VALID_ANSWER, probabilities: { route_000: '0.5' } })],
    ['missing confidence', body({ ...VALID_ANSWER, confidence: undefined })],
    ['a NaN confidence', body({ ...VALID_ANSWER, confidence: Number.NaN })],
    ['a confidence above one', body({ ...VALID_ANSWER, confidence: 1.5 })],
    ['a negative confidence', body({ ...VALID_ANSWER, confidence: -0.01 })],
    ['a fractional token count', body(VALID_ANSWER, { usage: { input_tokens: 1.5, output_tokens: 2 } })],
    ['a negative token count', body(VALID_ANSWER, { usage: { input_tokens: -1, output_tokens: 2 } })],
  ];

  for (const [label, input] of rejected) {
    it(`refuses ${label} with SCHEMA_MISMATCH`, () => {
      const parsed = parseJevChoiceResponse(input, JEV_QUESTION_NAME);
      assert.equal(parsed.ok, false);
      if (parsed.ok) return;
      assert.equal(parsed.reason, 'SCHEMA_MISMATCH');
    });
  }

  it('bounds the probability map so a hostile body cannot grow a receipt', () => {
    const probabilities: Record<string, number> = {};
    for (let index = 0; index < 300; index += 1) probabilities[`k${index}`] = 0.5;
    const parsed = parseJevChoiceResponse(body({ ...VALID_ANSWER, probabilities }), JEV_QUESTION_NAME);
    assert.equal(parsed.ok, false);
  });
});

describe('jev model listing parsing', () => {
  it('accepts the documented listing shape', () => {
    const parsed = parseJevModels({ models: [{ name: 'jev-latest', description: 'stable', release_date: '2026-09-01' }, { name: 'jev-1.13.0' }] });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.value.map((item) => item.name), ['jev-latest', 'jev-1.13.0']);
    assert.equal(parsed.value[1]?.description, null);
  });

  it('refuses a listing without an array', () => {
    assert.equal(parseJevModels({ models: 'jev-latest' }).ok, false);
    assert.equal(parseJevModels({}).ok, false);
    assert.equal(parseJevModels([{ name: 'jev-latest' }]).ok, false);
  });

  it('refuses a model entry with no usable name', () => {
    assert.equal(parseJevModels({ models: [{ description: 'nameless' }] }).ok, false);
  });
});
