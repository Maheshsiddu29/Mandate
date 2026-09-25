/**
 * Executable evidence for the production architecture pressure test.
 *
 * **These tests pin defects, not desired behaviour**, except where noted: the
 * first block re-measures the advisory layer's central safety property directly,
 * and that one *is* the desired behaviour. See
 * [docs/production-architecture-pressure-test.md](../../../docs/production-architecture-pressure-test.md).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decision } from '@mandate/kernel';
import { evaluateRoutes } from '@mandate/router';
import { selectWithJev } from '../src/decide.ts';
import { choosingTransport } from '../src/testing/stubs.ts';
import { ROUTER_CLOCK, ROUTER_MANDATE, ROUTER_STATE, haltedState, routeRequest, validRoutes } from './support/world.ts';

// --- The property that holds. Re-measured rather than taken on trust. --------

test('Jev independence: an advisory choice changes which member is handed off and nothing else', async () => {
  const routes = validRoutes(3);
  const evaluated = evaluateRoutes(routeRequest(routes));
  assert.ok(evaluated.status === 'EVALUATED');
  const members = new Set(evaluated.evaluation.admissible.map((item) => item.candidate.candidateDigest));

  const deterministic = await selectWithJev({ route: routeRequest(routes), transport: null });
  const advised = await selectWithJev({ route: routeRequest(routes), transport: choosingTransport('route_002') });
  assert.ok(deterministic.status === 'SELECTED' && advised.status === 'SELECTED');

  assert.equal(
    deterministic.jevReceipt?.closedCandidateSetDigest,
    advised.jevReceipt?.closedCandidateSetDigest,
    'the closed set is identical with and without advice',
  );
  assert.notEqual(deterministic.selected.candidateDigest, advised.selected.candidateDigest, 'the choice did take effect');
  assert.ok(members.has(advised.selected.candidateDigest), 'the handoff is a member of the deterministic admissible set');
  assert.equal(advised.handoffVerification.decision, Decision.PASS, 'the handoff carries a kernel PASS');
});

// --- F-5 (HIGH): the handoff re-verification is opt-in ----------------------

/**
 * `decide.ts` describes the handoff re-verification as "against the state that
 * is current now — not the state the closed set was built from", and
 * `docs/security-review.md` repeats the claim. `handoffState` is optional and
 * defaults to the evaluation state, so in the default configuration the
 * re-verification reads exactly what the set was built from.
 */
test('F-5 (HIGH): omitting handoffState makes the handoff re-verification a tautology', async () => {
  const routes = validRoutes(3);

  const defaulted = await selectWithJev({ route: routeRequest(routes), transport: null });
  assert.ok(defaulted.status === 'SELECTED');
  assert.equal(defaulted.handoffVerification.decision, Decision.PASS);

  // Supplying the state that is actually current is what makes the halt reject.
  const supplied = await selectWithJev({
    route: routeRequest(routes),
    transport: null,
    handoffState: { trustedMarketState: haltedState(), clock: { nowUnixSeconds: ROUTER_CLOCK } },
  });
  assert.ok(supplied.status === 'NO_VALID_ROUTE');
  assert.equal(supplied.handoffRejected, true);
  assert.ok(supplied.handoffVerification?.reasonCodes.includes('TRADING_HALTED'));
});

// --- F-9 (MEDIUM): the handoff clock is unconstrained -----------------------

/**
 * Nothing requires the handoff clock to be at or after the evaluation clock.
 * Rewinding it restores freshness that real time had already removed, which
 * defeats every age bound in the mandate. The verifier is pure by design and
 * cannot check this; the orchestrator is therefore inside the trusted computing
 * base, and Phase 6 must anchor safety-critical time on chain (INV-10).
 */
test('F-9 (MEDIUM): a rewound handoff clock turns a stale price back into a pass', async () => {
  const routes = validRoutes(3);
  const staleAt = ROUTER_CLOCK + ROUTER_MANDATE.maxPriceAgeSeconds + 5n;

  const honest = await selectWithJev({
    route: routeRequest(routes),
    transport: null,
    handoffState: { trustedMarketState: ROUTER_STATE, clock: { nowUnixSeconds: staleAt } },
  });
  assert.ok(honest.status === 'NO_VALID_ROUTE');
  assert.ok(honest.handoffVerification?.reasonCodes.includes('PRICE_STATE_STALE'));

  const rewound = await selectWithJev({
    route: routeRequest(routes),
    transport: null,
    handoffState: { trustedMarketState: ROUTER_STATE, clock: { nowUnixSeconds: ROUTER_CLOCK } },
  });
  assert.ok(rewound.status === 'SELECTED', 'no monotonicity check rejects the earlier clock');
});

// --- F-13 (MEDIUM): a failed handoff does not fall back to index 0 -----------

/**
 * ADR 0013 states that every failure selects index 0. A handoff rejection of a
 * *Jev-chosen* candidate is not covered: `selectWithJev` returns
 * `NO_VALID_ROUTE` without re-attempting the deterministic candidate. The
 * permitted set is unchanged, so INV-3 holds, but the model holds availability
 * authority over the outcome.
 */
test('F-13 (MEDIUM): a handoff rejection ends the decision rather than falling back', async () => {
  const routes = validRoutes(3);
  const result = await selectWithJev({
    route: routeRequest(routes),
    transport: choosingTransport('route_002'),
    handoffState: { trustedMarketState: haltedState(), clock: { nowUnixSeconds: ROUTER_CLOCK } },
  });
  assert.ok(result.status === 'NO_VALID_ROUTE');
  assert.equal(result.handoffRejected, true);
  assert.notEqual(result.deterministicCandidate, null, 'index 0 was available and was not re-attempted');
});
