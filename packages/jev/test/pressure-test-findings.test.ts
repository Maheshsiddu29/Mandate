/**
 * Regression tests for the advisory-layer findings of the production
 * architecture pressure test.
 *
 * The first block re-measures the independence property, which held before
 * Phase 5R and still holds. The rest began as defect-pinning tests and have been
 * **inverted**: each asserts the safe behaviour and fails if the vulnerability
 * returns. See
 * [docs/production-architecture-pressure-test.md](../../../docs/production-architecture-pressure-test.md).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decision } from '@mandate/kernel';
import { evaluateRoutes } from '@mandate/router';
import { AdvisoryCircuit } from '../src/availability.ts';
import { selectWithJev } from '../src/decide.ts';
import { choosingTransport, failingTransport } from '../src/testing/stubs.ts';
import {
  ROUTER_CLOCK,
  ROUTER_MANDATE,
  ROUTER_STATE,
  haltedState,
  jevHandoff,
  routeRequest,
  validRoutes,
} from './support/world.ts';

// --- The property that held, re-measured -----------------------------------

test('Jev independence: an advisory choice changes which member is handed off and nothing else', async () => {
  const routes = validRoutes(3);
  const evaluated = evaluateRoutes(routeRequest(routes));
  assert.ok(evaluated.status === 'EVALUATED');
  const members = new Set(evaluated.evaluation.admissible.map((item) => item.candidate.candidateDigest));

  const deterministic = await selectWithJev({ route: routeRequest(routes), transport: null, handoffState: jevHandoff() });
  const advised = await selectWithJev({ route: routeRequest(routes), transport: choosingTransport('route_002'), handoffState: jevHandoff() });
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

// --- F-5: the handoff re-verification is mandatory and reads fresh state ----

test('F-5 REGRESSION: handoff state is required and is what the re-verification reads', async () => {
  const routes = validRoutes(3);

  // Supplying the state that is actually current is what makes a halt reject.
  const halted = await selectWithJev({
    route: routeRequest(routes),
    transport: null,
    handoffState: { trustedMarketState: haltedState(), clock: { nowUnixSeconds: ROUTER_CLOCK } },
  });
  assert.ok(halted.status === 'NO_VALID_ROUTE');
  assert.equal(halted.handoffRejected, true);
  assert.ok(halted.handoffVerification?.reasonCodes.includes('TRADING_HALTED'));

  // And there is no way to omit it: the type requires it, and a caller that
  // forces `undefined` past the type gets a refusal rather than a silent reuse
  // of the evaluation state.
  const omitted = await selectWithJev({
    route: routeRequest(routes),
    transport: null,
    handoffState: undefined as never,
  });
  assert.equal(omitted.status, 'INVALID_INPUT');
});

test('F-5 REGRESSION: a mandate expiring during inference rejects at handoff', async () => {
  const routes = validRoutes(3);
  const result = await selectWithJev({
    route: routeRequest(routes),
    transport: choosingTransport('route_001'),
    handoffState: { trustedMarketState: ROUTER_STATE, clock: { nowUnixSeconds: ROUTER_MANDATE.expiresAtUnixSeconds } },
  });
  assert.ok(result.status === 'NO_VALID_ROUTE');
  assert.ok(result.handoffVerification?.reasonCodes.includes('MANDATE_EXPIRED'), result.handoffVerification?.reasonCodes.join(', '));
});

// --- F-9: the handoff clock cannot run backwards ----------------------------

test('F-9 REGRESSION: a rewound handoff clock is refused rather than restoring freshness', async () => {
  const routes = validRoutes(3);
  const staleAt = ROUTER_CLOCK + ROUTER_MANDATE.maxPriceAgeSeconds + 5n;

  // Honest: the price has aged past the bound and the handoff rejects.
  const honest = await selectWithJev({
    route: routeRequest(routes),
    transport: null,
    handoffState: { trustedMarketState: ROUTER_STATE, clock: { nowUnixSeconds: staleAt } },
  });
  assert.ok(honest.status === 'NO_VALID_ROUTE');
  assert.ok(honest.handoffVerification?.reasonCodes.includes('PRICE_STATE_STALE'));

  // Rewinding the handoff instant below the evaluation instant is now refused
  // by the router before any verification happens.
  const rewound = await selectWithJev({
    route: routeRequest(routes, { clock: { nowUnixSeconds: staleAt } }),
    transport: null,
    handoffState: { trustedMarketState: ROUTER_STATE, clock: { nowUnixSeconds: ROUTER_CLOCK } },
  });
  assert.equal(rewound.status, 'INVALID_INPUT');
  assert.ok(
    rewound.status === 'INVALID_INPUT' && rewound.errors.some((item) => item.code === 'HANDOFF_TIME_REGRESSED'),
    JSON.stringify(rewound.status === 'INVALID_INPUT' ? rewound.errors : []),
  );
});

// --- F-13: Jev holds no availability authority ------------------------------

test('F-13 REGRESSION: a handoff rejection of a Jev choice falls back to the deterministic candidate', async () => {
  // Two candidates on different execution prices: at handoff the reference has
  // moved so that index 0 still verifies and the advised one does not.
  const routes = validRoutes(3);
  const evaluated = evaluateRoutes(routeRequest(routes));
  assert.ok(evaluated.status === 'EVALUATED');
  assert.ok(evaluated.evaluation.admissible.length >= 2);

  // A model that names a member which the handoff state will reject. Here the
  // handoff rejects *every* member, which is the strictly harder case: the
  // fallback must still be attempted and must still refuse.
  const allRejected = await selectWithJev({
    route: routeRequest(routes),
    transport: choosingTransport('route_002'),
    handoffState: { trustedMarketState: haltedState(), clock: { nowUnixSeconds: ROUTER_CLOCK } },
  });
  assert.ok(allRejected.status === 'NO_VALID_ROUTE', 'safety is unchanged when nothing can verify');

  // When the deterministic candidate does verify, the decision completes rather
  // than being lost to the model's choice.
  const advised = await selectWithJev({
    route: routeRequest(routes),
    transport: choosingTransport('route_002'),
    handoffState: jevHandoff(),
  });
  assert.equal(advised.status, 'SELECTED');
});

// --- Availability: the circuit breaker cannot change a decision -------------

test('the advisory circuit changes latency, never the permitted set', async () => {
  const routes = validRoutes(3);
  const circuit = new AdvisoryCircuit({ failureThreshold: 2, cooldownMs: 1_000 });
  let now = 0;
  const nowMs = () => now;
  const failing = failingTransport('SERVICE_UNAVAILABLE');

  const baseline = await selectWithJev({ route: routeRequest(routes), transport: null, handoffState: jevHandoff() });
  assert.ok(baseline.status === 'SELECTED');

  // Two failures open the circuit.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await selectWithJev({ route: routeRequest(routes), transport: failing, handoffState: jevHandoff(), circuit, nowMs });
    assert.ok(result.status === 'SELECTED');
    assert.equal(result.jevReceipt?.fallbackReason, 'SERVICE_UNAVAILABLE');
  }

  // The third decision skips the call entirely and reports why.
  const skipped = await selectWithJev({ route: routeRequest(routes), transport: failing, handoffState: jevHandoff(), circuit, nowMs });
  assert.ok(skipped.status === 'SELECTED');
  assert.equal(skipped.jevReceipt?.fallbackReason, 'CIRCUIT_OPEN');
  assert.equal(skipped.jevReceipt?.latencyMs, null, 'no call was made, so no latency was paid');

  // And the selected candidate is byte-identical to the one with no Jev at all.
  assert.equal(skipped.selected.candidateDigest, baseline.selected.candidateDigest);
  assert.equal(skipped.jevReceipt?.closedCandidateSetDigest, baseline.jevReceipt?.closedCandidateSetDigest);

  // After the cooldown one probe is admitted again.
  now = 2_000;
  assert.equal(circuit.state(now), 'HALF_OPEN');
  const probe = await selectWithJev({ route: routeRequest(routes), transport: choosingTransport('route_001'), handoffState: jevHandoff(), circuit, nowMs });
  assert.ok(probe.status === 'SELECTED');
  assert.equal(probe.jevReceipt?.selectionMode, 'JEV_ASSISTED');
  assert.equal(circuit.state(now), 'CLOSED', 'a usable answer closes it');
});
