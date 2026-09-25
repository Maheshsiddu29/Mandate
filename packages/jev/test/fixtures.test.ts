/**
 * Recorded-exchange fixtures as a contract regression, and the honesty rules
 * that keep a constructed fixture from being mistaken for a measurement.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ABSTAIN_CHOICE_ID,
  JEV_QUESTION_NAME,
  parseJevChoiceResponse,
  parseJevModels,
} from '../src/index.ts';
import { CaptureClass, loadFixtures, validateFixtures } from './support/fixtures.ts';

const FIXTURES = loadFixtures();

describe('jev fixtures', () => {
  it('validates structure, digests and capture-class rules', () => {
    const report = validateFixtures();
    assert.ok(report.fixtures > 0);
    assert.equal(report.live + report.schemaDerived, report.fixtures);
  });

  it('labels every constructed fixture as not a recording', () => {
    for (const fixture of FIXTURES) {
      if (fixture.captureClass !== CaptureClass.SCHEMA_DERIVED) continue;
      assert.match(fixture.note, /not a recording|Not a recording/);
      assert.equal(fixture.observedLatencyMs, null, fixture.id);
    }
  });

  it('contains no credential-shaped content', () => {
    const serialized = JSON.stringify(FIXTURES);
    assert.doesNotMatch(serialized, /Bearer\s|TYPESAFE_API_KEY|"authorization"/i);
  });

  it('parses every recorded choice response with the production parser', () => {
    const choices = FIXTURES.filter((fixture) => fixture.endpoint === 'POST /v1/systemone');
    assert.ok(choices.length >= 3);
    for (const fixture of choices) {
      const parsed = parseJevChoiceResponse(fixture.response, JEV_QUESTION_NAME);
      assert.equal(parsed.ok, true, fixture.id);
      if (!parsed.ok) continue;
      assert.equal(parsed.value.model, fixture.modelReturned, fixture.id);
      assert.ok(parsed.value.confidence >= 0 && parsed.value.confidence <= 1);
      assert.ok(parsed.value.inputTokens !== null && parsed.value.outputTokens !== null, fixture.id);
    }
  });

  it('parses the recorded model listing', () => {
    const listing = FIXTURES.find((fixture) => fixture.endpoint === 'GET /v1/models');
    assert.notEqual(listing, undefined);
    if (listing === undefined) return;
    const parsed = parseJevModels(listing.response);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.ok(parsed.value.some((item) => item.name === 'jev-latest'));
  });

  it('records alias resolution rather than assuming an alias is a version', () => {
    for (const fixture of FIXTURES) {
      if (fixture.endpoint !== 'POST /v1/systemone') continue;
      assert.equal(fixture.modelRequested, 'jev-latest', fixture.id);
      assert.notEqual(fixture.modelReturned, fixture.modelRequested, fixture.id);
    }
  });

  it('covers an explicit abstention, because that is the answer most easily mishandled', () => {
    const abstention = FIXTURES.find((fixture) => {
      const parsed = parseJevChoiceResponse(fixture.response, JEV_QUESTION_NAME);
      return parsed.ok && parsed.value.choice === ABSTAIN_CHOICE_ID;
    });
    assert.notEqual(abstention, undefined, 'no fixture records an abstention');
  });

  it('does not assert which candidate the model should have chosen', () => {
    // A fixture pins the contract, not the decision. The model behind an alias
    // changes, and pinning a selection would assert that it never improves.
    const choices = new Set(FIXTURES.map((fixture) => {
      const parsed = parseJevChoiceResponse(fixture.response, JEV_QUESTION_NAME);
      return parsed.ok ? parsed.value.choice : null;
    }).filter((value) => value !== null));
    assert.ok(choices.size > 1, 'every fixture records the same choice, which reads as an expectation');
  });
});
