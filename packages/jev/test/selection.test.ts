/**
 * Selection modes, explicit abstention, cardinality boundaries and the
 * confidence policy.
 *
 * Every test here asserts two things about a Jev problem: the deterministic
 * candidate is selected, and the reason is recorded. The second half matters as
 * much as the first — a permanently broken integration is invisible to users by
 * design, so it has to be visible in the receipt.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Decision } from '@mandate/kernel';
import {
  ABSTAIN_CHOICE_ID,
  JEV_MAX_CANDIDATES,
  JEV_MIN_CANDIDATES,
  JevFallbackReason,
  selectWithJev,
} from '../src/index.ts';
import {
  abstainingTransport,
  choosingTransport,
  failingTransport,
  hangingTransport,
  throwingTransport,
  worstChoiceTransport,
} from '../src/testing/index.ts';
import { maliciousQuote, routeRequest, validRoutes, jevHandoff, } from './support/world.ts';

async function run(count: number, transport: Parameters<typeof selectWithJev>[0]['transport'], policy: Parameters<typeof selectWithJev>[0]['policy'] = {}) {
  return selectWithJev({ route: routeRequest(validRoutes(count)), transport, policy, handoffState: jevHandoff() });
}

describe('jev selection modes', () => {
  it('is total over malformed top-level and nested ordinary values', async () => {
    const hostile: readonly unknown[] = [null, undefined, false, true, 0, 1, '', 'request', [], {}, { policy: null }];
    for (const raw of hostile) {
      await assert.doesNotReject(() => selectWithJev(raw), String(raw));
      const result = await selectWithJev(raw);
      assert.equal(result.status, 'INVALID_INPUT', String(raw));
      assert.equal(result.routing.status, 'INVALID_INPUT', String(raw));
    }

    const base = { route: routeRequest(validRoutes(2)), transport: null, handoffState: jevHandoff() };
    const malformed: readonly unknown[] = [
      { ...base, policy: false },
      { ...base, policy: { timeoutMs: 0 } },
      { ...base, policy: { timeoutMs: Number.POSITIVE_INFINITY } },
      { ...base, policy: { minimumConfidence: Number.NaN } },
      { ...base, policy: { allowedModels: [7] } },
      { ...base, transport: false },
      { ...base, transport: {} },
      { ...base, advisoryByRouteId: [] },
      { ...base, circuit: {} },
      { ...base, nowMs: 1 },
      { ...base, verifier: 'verify' },
      { ...base, extra: true },
    ];
    for (const raw of malformed) {
      await assert.doesNotReject(() => selectWithJev(raw));
      const result = await selectWithJev(raw);
      assert.equal(result.status, 'INVALID_INPUT');
      assert.notEqual(result.status, 'SELECTED');
    }
  });

  it('selects the candidate Jev names and records it as assisted', async () => {
    const result = await run(3, choosingTransport('route_002', 0.88));
    assert.equal(result.status, 'SELECTED');
    if (result.status !== 'SELECTED') return;
    assert.equal(result.selectionMode, 'JEV_ASSISTED');
    assert.equal(result.selected.routeId, 'route.valid.002');
    assert.equal(result.jevReceipt?.outcome, 'SELECTED');
    assert.equal(result.jevReceipt?.selectedChoice, 'route_002');
    assert.equal(result.jevReceipt?.confidence, 0.88);
    assert.equal(result.handoffVerification.decision, Decision.PASS);
    // Jev moved the answer away from the deterministic one, which is the whole
    // point of the layer — and both are members of the same closed set.
    assert.notEqual(result.selected.candidateDigest, result.deterministicCandidate?.candidateDigest);
  });

  it('falls back to the deterministic candidate when Jev abstains', async () => {
    const result = await run(3, abstainingTransport());
    assert.equal(result.status, 'SELECTED');
    if (result.status !== 'SELECTED') return;
    assert.equal(result.selectionMode, 'JEV_ABSTAINED');
    assert.equal(result.jevReceipt?.outcome, 'ABSTAIN');
    assert.equal(result.jevReceipt?.selectedChoice, ABSTAIN_CHOICE_ID);
    assert.equal(result.jevReceipt?.fallbackReason, null);
    assert.equal(result.selected.routeId, 'route.valid.000');
    assert.equal(result.selected.candidateDigest, result.deterministicCandidate?.candidateDigest);
  });

  it('never turns abstention into a refusal when a valid route exists', async () => {
    const result = await run(2, abstainingTransport());
    assert.equal(result.status, 'SELECTED');
  });

  it('runs deterministically with no transport at all', async () => {
    const result = await run(3, null);
    assert.equal(result.status, 'SELECTED');
    if (result.status !== 'SELECTED') return;
    assert.equal(result.selectionMode, 'DETERMINISTIC');
    assert.equal(result.jevReceipt?.fallbackReason, JevFallbackReason.JEV_DISABLED);
    assert.equal(result.jevReceipt?.modelReturned, null);
    assert.equal(result.selected.routeId, 'route.valid.000');
  });

  it('runs deterministically when the policy disables the integration', async () => {
    const result = await run(3, choosingTransport('route_002'), { enabled: false });
    assert.equal(result.status, 'SELECTED');
    if (result.status !== 'SELECTED') return;
    assert.equal(result.selectionMode, 'DETERMINISTIC');
    assert.equal(result.selected.routeId, 'route.valid.000');
  });
});

describe('jev fallback behaviour', () => {
  const transportFailures: readonly JevFallbackReason[] = [
    JevFallbackReason.TIMEOUT,
    JevFallbackReason.NETWORK_ERROR,
    JevFallbackReason.AUTH_FAILED,
    JevFallbackReason.NOT_FOUND,
    JevFallbackReason.REQUEST_REJECTED,
    JevFallbackReason.RATE_LIMITED,
    JevFallbackReason.SERVICE_UNAVAILABLE,
    JevFallbackReason.UNEXPECTED_STATUS,
    JevFallbackReason.INVALID_JSON,
    JevFallbackReason.MISSING_CREDENTIAL,
  ];

  for (const reason of transportFailures) {
    it(`selects the deterministic candidate on ${reason}`, async () => {
      const result = await run(3, failingTransport(reason));
      assert.equal(result.status, 'SELECTED');
      if (result.status !== 'SELECTED') return;
      assert.equal(result.selectionMode, 'JEV_FALLBACK');
      assert.equal(result.jevReceipt?.fallbackReason, reason);
      assert.equal(result.selected.routeId, 'route.valid.000');
    });
  }

  it('contains a transport that throws', async () => {
    const result = await run(3, throwingTransport());
    assert.equal(result.status, 'SELECTED');
    if (result.status !== 'SELECTED') return;
    assert.equal(result.jevReceipt?.fallbackReason, JevFallbackReason.TRANSPORT_EXCEPTION);
    assert.equal(result.selected.routeId, 'route.valid.000');
  });

  it('contains a transport that never settles, using its own deadline', async () => {
    const started = Date.now();
    const result = await selectWithJev({ route: routeRequest(validRoutes(3)), transport: hangingTransport(), policy: { timeoutMs: 60 }, handoffState: jevHandoff() });
    assert.ok(Date.now() - started < 5_000, 'the decision path waited on a hanging transport');
    assert.equal(result.status, 'SELECTED');
    if (result.status !== 'SELECTED') return;
    assert.equal(result.jevReceipt?.fallbackReason, JevFallbackReason.TIMEOUT);
    assert.equal(result.selected.routeId, 'route.valid.000');
  });

  it('refuses a model the account is not known to have', async () => {
    const result = await run(3, choosingTransport('route_002'), { model: 'jev-9.9.9', allowedModels: ['jev-latest', 'jev-1.13.0'] });
    assert.equal(result.status, 'SELECTED');
    if (result.status !== 'SELECTED') return;
    assert.equal(result.jevReceipt?.fallbackReason, JevFallbackReason.MODEL_UNAVAILABLE);
    assert.equal(result.jevReceipt?.modelRequested, 'jev-9.9.9');
    assert.equal(result.selected.routeId, 'route.valid.000');
  });

  it('produces identical selections for every Jev problem', async () => {
    const transports = [
      null,
      throwingTransport(),
      abstainingTransport(),
      failingTransport(JevFallbackReason.TIMEOUT),
      failingTransport(JevFallbackReason.SCHEMA_MISMATCH),
    ];
    const digests = new Set<string>();
    for (const transport of transports) {
      const result = await selectWithJev({ route: routeRequest(validRoutes(4)), transport, handoffState: jevHandoff() });
      assert.equal(result.status, 'SELECTED');
      if (result.status !== 'SELECTED') continue;
      digests.add(result.selected.candidateDigest);
    }
    assert.equal(digests.size, 1, 'fallback is not a single deterministic answer');
  });
});

describe('jev cardinality boundary', () => {
  it('makes no call below the minimum', async () => {
    for (const count of [0, 1]) {
      const routes = count === 0 ? [maliciousQuote('route.attacker')] : validRoutes(1);
      const result = await selectWithJev({ route: routeRequest(routes), transport: worstChoiceTransport(), handoffState: jevHandoff() });
      assert.equal(result.selectionMode, 'DETERMINISTIC');
      assert.equal(result.jevReceipt?.fallbackReason, JevFallbackReason.CARDINALITY_BELOW_MINIMUM);
    }
  });

  it('is eligible at the minimum and at the documented maximum', async () => {
    for (const count of [JEV_MIN_CANDIDATES, JEV_MAX_CANDIDATES]) {
      const result = await run(count, choosingTransport('route_001'));
      assert.equal(result.selectionMode, 'JEV_ASSISTED', `count ${count}`);
      assert.equal(result.jevReceipt?.candidateIds.length, count);
    }
  });

  it('skips Jev above the documented maximum without dropping a candidate', async () => {
    for (const count of [JEV_MAX_CANDIDATES + 1, JEV_MAX_CANDIDATES + 2]) {
      const result = await run(count, worstChoiceTransport());
      assert.equal(result.selectionMode, 'JEV_FALLBACK', `count ${count}`);
      assert.equal(result.jevReceipt?.fallbackReason, JevFallbackReason.CARDINALITY_UNSUPPORTED);
      // The admissible set is intact: every candidate is still in the receipt.
      assert.equal(result.jevReceipt?.candidateIds.length, count);
      assert.equal(result.status, 'SELECTED');
      if (result.status !== 'SELECTED') continue;
      assert.equal(result.selected.routeId, 'route.valid.000');
    }
  });
});

describe('jev confidence policy', () => {
  it('accepts every in-set choice when no threshold is configured', async () => {
    const result = await run(3, choosingTransport('route_002', 0.01));
    assert.equal(result.selectionMode, 'JEV_ASSISTED');
    assert.equal(result.jevReceipt?.confidence, 0.01);
  });

  it('treats the threshold as inclusive on both sides of the boundary', async () => {
    const above = await run(3, choosingTransport('route_002', 0.7), { minimumConfidence: 0.7 });
    assert.equal(above.selectionMode, 'JEV_ASSISTED');

    const below = await run(3, choosingTransport('route_002', 0.699999), { minimumConfidence: 0.7 });
    assert.equal(below.selectionMode, 'JEV_FALLBACK');
    assert.equal(below.jevReceipt?.fallbackReason, JevFallbackReason.CONFIDENCE_BELOW_THRESHOLD);
  });

  it('falls back rather than rejecting when confidence is too low', async () => {
    const result = await run(3, choosingTransport('route_002', 0.1), { minimumConfidence: 0.9 });
    assert.equal(result.status, 'SELECTED');
    if (result.status !== 'SELECTED') return;
    assert.equal(result.selected.routeId, 'route.valid.000');
    // The advice is still recorded: a low-confidence answer is evidence about
    // the model, and discarding it would make a threshold impossible to tune.
    assert.equal(result.jevReceipt?.selectedChoice, 'route_002');
    assert.equal(result.jevReceipt?.confidence, 0.1);
  });
});
