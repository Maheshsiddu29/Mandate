/**
 * The trader-facing surface.
 *
 * The rule being tested is restraint: one headline, an optional mode and
 * confidence, and everything else behind a detail affordance. A probability
 * matrix must not appear unless it was explicitly asked for.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderSelectionSummary, selectWithJev, summarizeSelection } from '../src/index.ts';
import { abstainingTransport, choosingTransport, failingTransport } from '../src/testing/index.ts';
import { ROUTER_CLOCK, haltedState, maliciousQuote, routeRequest, validRoutes } from './support/world.ts';

describe('selection summary', () => {
  it('leads with the outcome, not the mechanism', async () => {
    const result = await selectWithJev({ route: routeRequest(validRoutes(3)), transport: choosingTransport('route_001', 0.94) });
    const summary = summarizeSelection(result);
    assert.equal(summary.headline, 'Best valid execution found');
    assert.equal(summary.decisionMode, 'Jev-assisted');
    assert.equal(summary.confidencePercent, 94);
    assert.deepEqual([...summary.detail], ['3 valid routes', 'Jev selected Route B', 'Final Mandate verification: PASS']);
  });

  it('renders the two-or-three line trader view', async () => {
    const result = await selectWithJev({ route: routeRequest(validRoutes(3)), transport: choosingTransport('route_001', 0.94) });
    assert.equal(renderSelectionSummary(summarizeSelection(result)), 'Best valid execution found\nDecision mode: Jev-assisted\nConfidence: 94%');
  });

  it('withholds probabilities unless they are asked for', async () => {
    const result = await selectWithJev({ route: routeRequest(validRoutes(3)), transport: choosingTransport('route_001', 0.94) });
    assert.equal(summarizeSelection(result).detail.some((line) => line.includes('%')), false);
    const verbose = summarizeSelection(result, { includeProbabilities: true });
    assert.ok(verbose.detail.some((line) => line.trimStart().startsWith('route_000:')));
  });

  it('shows no confidence when the advisory layer did not decide', async () => {
    for (const transport of [null, abstainingTransport(), failingTransport('RATE_LIMITED')]) {
      const result = await selectWithJev({ route: routeRequest(validRoutes(3)), transport });
      const summary = summarizeSelection(result);
      assert.equal(summary.confidencePercent, null);
      assert.equal(summary.headline, 'Best valid execution found');
      assert.ok(summary.detail.includes('Final Mandate verification: PASS'));
    }
  });

  it('names the reason when advice was unavailable, without alarming the trader', async () => {
    const result = await selectWithJev({ route: routeRequest(validRoutes(3)), transport: failingTransport('SERVICE_UNAVAILABLE') });
    const summary = summarizeSelection(result);
    assert.equal(summary.decisionMode, 'Deterministic (Jev unavailable)');
    assert.ok(summary.detail.some((line) => line.includes('SERVICE_UNAVAILABLE')));
    // The outcome is unchanged: the trade is still available.
    assert.equal(summary.headline, 'Best valid execution found');
  });

  it('distinguishes abstention from failure', async () => {
    const result = await selectWithJev({ route: routeRequest(validRoutes(3)), transport: abstainingTransport() });
    assert.equal(summarizeSelection(result).decisionMode, 'Deterministic (Jev abstained)');
  });

  it('reports a refusal as a refusal', async () => {
    const result = await selectWithJev({ route: routeRequest([maliciousQuote('route.attacker')]), transport: choosingTransport('route_000') });
    const summary = summarizeSelection(result);
    assert.equal(summary.headline, 'No valid execution found');
    assert.equal(summary.confidencePercent, null);
    assert.ok(summary.detail.includes('No route satisfied the mandate.'));
  });

  it('explains a handoff refusal as a re-check, not as an absence of routes', async () => {
    const result = await selectWithJev({
      route: routeRequest(validRoutes(3)),
      transport: choosingTransport('route_002'),
      handoffState: { trustedMarketState: haltedState(), clock: { nowUnixSeconds: ROUTER_CLOCK } },
    });
    const summary = summarizeSelection(result);
    assert.equal(summary.headline, 'No valid execution found');
    assert.ok(summary.detail.includes('3 routes passed mandate verification.'));
    assert.ok(summary.detail.includes('Final Mandate verification: REJECT'));
  });

  it('labels routes readably past the alphabet', async () => {
    const result = await selectWithJev({ route: routeRequest(validRoutes(30)), transport: choosingTransport('route_027') });
    assert.ok(summarizeSelection(result).detail.includes('Jev selected Route #28'));
  });
});
