/**
 * INV-3: the set of executions Mandate permits is identical whether Jev is
 * present, absent, failed or adversarial.
 *
 * The invariant has to be stated precisely before it can be tested, because
 * the loose reading is false. Jev *does* change which candidate is handed off —
 * that is the entire purpose of the layer. What it cannot change is which
 * candidates are permitted.
 *
 * Formally, for a fixed set of inputs:
 *
 *   Admissible(inputs)                               is independent of Jev
 *   Handoff(inputs, jevBehaviour) ∈ Admissible(inputs) ∪ { none }
 *   every Handoff carries a kernel PASS at handoff time
 *
 * The union of handoffs over *every* Jev behaviour is therefore a subset of
 * the admissible set the deterministic path computes on its own. Jev selects
 * within that set; it cannot widen it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Decision } from '@mandate/kernel';
import { evaluateRoutes, route, type ProviderRouteQuote } from '@mandate/router';
import {
  JevFallbackReason,
  closedChoiceSetDigest,
  buildClosedChoiceSet,
  selectWithJev,
  type JevTransport,
} from '../src/index.ts';
import {
  ALL_ADVERSARIAL_BEHAVIOURS,
  abstainingTransport,
  adversarialTransport,
  choosingTransport,
  failingTransport,
  hangingTransport,
  signalFollowingTransport,
  throwingTransport,
  worstChoiceTransport,
} from '../src/testing/index.ts';
import { maliciousQuote, quoteWithFee, routeRequest, validRoutes, haltedState, ROUTER_CLOCK } from './support/world.ts';

/** Every Jev behaviour the system can encounter, hostile ones included. */
function allBehaviours(): readonly (readonly [string, JevTransport | null])[] {
  const named: (readonly [string, JevTransport | null])[] = [
    ['absent', null],
    ['abstaining', abstainingTransport()],
    ['agreeing', choosingTransport('route_000')],
    ['disagreeing', choosingTransport('route_001')],
    ['worst-choice', worstChoiceTransport()],
    ['signal-following', signalFollowingTransport()],
    ['throwing', throwingTransport()],
    ['hanging', hangingTransport()],
  ];
  for (const reason of Object.values(JevFallbackReason)) named.push([`failing:${reason}`, failingTransport(reason)]);
  for (const behaviour of ALL_ADVERSARIAL_BEHAVIOURS) named.push([`adversarial:${behaviour}`, adversarialTransport(behaviour, 'route.attacker')]);
  return named;
}

/** Valid routes, excluded routes, and one route that ties on every dimension. */
function world(): readonly ProviderRouteQuote[] {
  return [
    maliciousQuote('route.attacker'),
    ...validRoutes(5),
    quoteWithFee('route.valid.tied', 100n),
    { ...quoteWithFee('route.attacker.stale', 0n, 10_000n) },
  ];
}

describe('permitted-execution set equivalence', () => {
  const routes = world();

  it('computes the same admissible set whether or not Jev is involved', async () => {
    const evaluated = evaluateRoutes(routeRequest(routes));
    assert.equal(evaluated.status, 'EVALUATED');
    if (evaluated.status !== 'EVALUATED') return;
    const baselineDigest = closedChoiceSetDigest(buildClosedChoiceSet(evaluated.evaluation.admissible));

    for (const [name, transport] of allBehaviours()) {
      const result = await selectWithJev({ route: routeRequest(routes), transport, policy: { timeoutMs: 60 } });
      const receipt = result.jevReceipt;
      assert.notEqual(receipt, null, name);
      if (receipt === null) continue;
      assert.equal(receipt.closedCandidateSetDigest, baselineDigest, `${name} saw a different closed set`);
      assert.deepEqual([...receipt.candidateDigests], evaluated.evaluation.admissible.map((item) => item.candidate.candidateDigest), name);
    }
  });

  it('never hands off anything outside the deterministic admissible set', async () => {
    const evaluated = evaluateRoutes(routeRequest(routes));
    assert.equal(evaluated.status, 'EVALUATED');
    if (evaluated.status !== 'EVALUATED') return;
    const admissible = new Set<string>(evaluated.evaluation.admissible.map((item) => item.candidate.candidateDigest));

    const reached = new Set<string>();
    for (const [name, transport] of allBehaviours()) {
      const result = await selectWithJev({ route: routeRequest(routes), transport, policy: { timeoutMs: 60 } });
      if (result.status !== 'SELECTED') continue;
      assert.ok(admissible.has(result.selected.candidateDigest), `${name} handed off a candidate outside the admissible set`);
      assert.equal(result.handoffVerification.decision, Decision.PASS, `${name} handed off without a final PASS`);
      reached.add(result.selected.candidateDigest);
    }

    // The union over every behaviour is a strict subset of the admissible set,
    // which is the invariant: Jev moves within the set and cannot widen it.
    for (const digest of reached) assert.ok(admissible.has(digest));
    assert.ok(reached.size > 1, 'the behaviours did not actually exercise different selections');
  });

  it('refuses identically for every Jev behaviour when nothing is admissible', async () => {
    const impossible = [maliciousQuote('route.attacker.a'), maliciousQuote('route.attacker.b')];
    const deterministicBaseline = route(routeRequest(impossible));
    assert.equal(deterministicBaseline.status, 'NO_VALID_ROUTE');
    if (deterministicBaseline.status !== 'NO_VALID_ROUTE') return;

    for (const [name, transport] of allBehaviours()) {
      const result = await selectWithJev({ route: routeRequest(impossible), transport, policy: { timeoutMs: 60 } });
      assert.equal(result.status, 'NO_VALID_ROUTE', name);
      assert.equal(
        result.routing.status === 'NO_VALID_ROUTE' ? result.routing.receipt.receiptDigest : null,
        deterministicBaseline.receipt.receiptDigest,
        `${name} produced a different refusal`,
      );
    }
  });

  it('refuses identically for every Jev behaviour when the state changes before handoff', async () => {
    const handoffState = { trustedMarketState: haltedState(), clock: { nowUnixSeconds: ROUTER_CLOCK } };
    for (const [name, transport] of allBehaviours()) {
      const result = await selectWithJev({ route: routeRequest(routes), transport, handoffState, policy: { timeoutMs: 60 } });
      assert.equal(result.status, 'NO_VALID_ROUTE', name);
      if (result.status !== 'NO_VALID_ROUTE') continue;
      assert.equal(result.handoffRejected, true, name);
    }
  });

  it('produces the byte-identical Phase 4 result whenever the deterministic candidate is chosen', async () => {
    const baseline = route(routeRequest(routes));
    assert.equal(baseline.status, 'SELECTED');
    if (baseline.status !== 'SELECTED') return;

    for (const [name, transport] of [...allBehaviours()].filter(([label]) => label !== 'disagreeing' && label !== 'worst-choice' && label !== 'signal-following')) {
      const result = await selectWithJev({ route: routeRequest(routes), transport, policy: { timeoutMs: 60 } });
      if (result.status !== 'SELECTED') continue;
      if (result.selected.candidateDigest !== baseline.selected.candidateDigest) continue;
      assert.equal(
        result.routing.status === 'SELECTED' ? result.routing.receipt.receiptDigest : null,
        baseline.receipt.receiptDigest,
        `${name} produced a different routing receipt for the same selection`,
      );
    }
  });

  it('keeps the invariant at the cardinality boundary, where Jev is skipped', async () => {
    for (const count of [254, 255]) {
      const bulk = validRoutes(count);
      const baseline = route(routeRequest(bulk));
      const result = await selectWithJev({ route: routeRequest(bulk), transport: worstChoiceTransport(), policy: { timeoutMs: 500 } });
      assert.equal(result.status, 'SELECTED', `count ${count}`);
      assert.equal(baseline.status, 'SELECTED', `count ${count}`);
      if (result.status !== 'SELECTED' || baseline.status !== 'SELECTED') continue;
      if (count === 255) {
        // Skipped: the deterministic answer stands and nothing was dropped.
        assert.equal(result.selected.candidateDigest, baseline.selected.candidateDigest);
        assert.equal(result.jevReceipt?.candidateIds.length, 255);
      } else {
        // Eligible: the model moved the answer, inside the same closed set.
        assert.notEqual(result.selected.candidateDigest, baseline.selected.candidateDigest);
        assert.equal(result.jevReceipt?.candidateIds.length, 254);
      }
    }
  });
});
