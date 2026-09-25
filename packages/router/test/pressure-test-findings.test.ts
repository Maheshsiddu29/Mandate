/**
 * Regression tests for the router findings of the production architecture
 * pressure test.
 *
 * These began as defect-pinning tests. Phase 5R remediated the findings, so each
 * has been **inverted**: it asserts the safe behaviour and fails if the
 * vulnerability returns. See
 * [docs/production-architecture-pressure-test.md](../../../docs/production-architecture-pressure-test.md).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decision, MAX_STATE_REPRESENTATIONS, parseTrustedState, verify } from '@mandate/kernel';
import { openRegistry, registrySnapshotDigest } from '@mandate/registry';
import { buildRoutingCandidate } from '../src/candidate.ts';
import { evaluateRoutes, route, selectEvaluated } from '../src/router.ts';
import {
  ROUTER_AUTHORIZATION,
  ROUTER_CLOCK,
  ROUTER_DOMAIN,
  ROUTER_MANDATE,
  ROUTER_REGISTRY_INPUT,
  ROUTER_REQUESTED_QUANTITY,
  ROUTER_REGISTRY_SNAPSHOT_DIGEST,
  ROUTER_STATE,
  haltedRouterState,
  pausedRepresentationState,
  routeQuote,
  routerHandoff,
  trustedCost,
  zeroFee,
} from './support/fixture.ts';

const opened = openRegistry(ROUTER_REGISTRY_INPUT);
if (!opened.ok) throw new Error('pressure-test registry did not open');
const REGISTRY = opened.value;

function request(routes: readonly ReturnType<typeof routeQuote>[], overrides: Record<string, unknown> = {}) {
  return {
    mandate: ROUTER_MANDATE,
    authorization: ROUTER_AUTHORIZATION,
    registry: REGISTRY,
    trustedMarketState: ROUTER_STATE,
    requestedQuantity: ROUTER_REQUESTED_QUANTITY,
    routes,
    trustedCosts: routes.map((quote) => trustedCost(quote)),
    clock: { nowUnixSeconds: ROUTER_CLOCK },
    expectedDomain: ROUTER_DOMAIN,
    ...overrides,
  };
}

function fee(atoms: bigint) {
  return { ...zeroFee(), atoms };
}

// --- F-2: the router no longer carries an economic permission ---------------

test('F-2 REGRESSION: the router hands the fee total to the kernel and does not gate on it', () => {
  const quote = routeQuote({
    costs: { venueFee: fee(ROUTER_MANDATE.maxNotional.atoms), executionFee: zeroFee(), settlementFee: zeroFee(), routeFee: zeroFee() },
  });

  const built = buildRoutingCandidate({
    mandate: ROUTER_MANDATE,
    quote,
    trustedState: ROUTER_STATE,
    trustedCost: trustedCost(quote),
    requestedQuantity: ROUTER_REQUESTED_QUANTITY,
    nowUnixSeconds: ROUTER_CLOCK,
    registrySnapshotDigest: ROUTER_REGISTRY_SNAPSHOT_DIGEST,
  });
  assert.ok(built.ok, 'construction is not authorization');
  assert.equal(built.candidate.executionCandidate.feeTotal.atoms, ROUTER_MANDATE.maxNotional.atoms);

  // And the kernel — not the router — is what refuses it.
  const verdict = verify({
    mandate: ROUTER_MANDATE,
    authorization: ROUTER_AUTHORIZATION,
    candidate: built.candidate.executionCandidate,
    trustedState: ROUTER_STATE,
    clock: { nowUnixSeconds: ROUTER_CLOCK },
    expectedDomain: ROUTER_DOMAIN,
  });
  assert.equal(verdict.decision, Decision.REJECT);
  assert.ok(verdict.reasonCodes.includes('TOTAL_DEBIT_EXCEEDED'), verdict.reasonCodes.join(', '));
});

test('F-2 REGRESSION: an over-budget route is excluded end to end, by the kernel', () => {
  const quote = routeQuote({
    costs: { venueFee: fee(ROUTER_MANDATE.maxNotional.atoms), executionFee: zeroFee(), settlementFee: zeroFee(), routeFee: zeroFee() },
  });
  const result = route(request([quote]), routerHandoff());
  assert.equal(result.status, 'NO_VALID_ROUTE');
  if (result.status === 'NO_VALID_ROUTE') {
    const excluded = result.receipt.outcomes.find((outcome) => outcome.status === 'EXCLUDED');
    assert.ok(excluded);
    assert.ok(
      excluded.exclusions.some((item) => item.code === 'TOTAL_DEBIT_EXCEEDED'),
      excluded.exclusions.map((item) => item.code).join(', '),
    );
  }
});

// --- F-5: the handoff re-verification reads state supplied for the handoff ---

test('F-5 REGRESSION: a halt arriving after evaluation rejects at handoff', () => {
  const result = route(
    request([routeQuote({ routeId: 'route.one' })]),
    routerHandoff({ trustedMarketState: haltedRouterState() }),
  );
  assert.equal(result.status, 'NO_VALID_ROUTE', 'the halt must reach the re-verification');
  if (result.status === 'NO_VALID_ROUTE') {
    const failed = result.receipt.outcomes.find((outcome) =>
      outcome.status === 'EXCLUDED' && outcome.exclusions.some((item) => item.code === 'FINAL_REVERIFICATION_FAILED'));
    assert.ok(failed, 'FINAL_REVERIFICATION_FAILED is reachable, which it was not before Phase 5R');
    assert.equal(result.receipt.selectedCandidateDigest, null);
  }
});

test('F-5 REGRESSION: the handoff re-verification reads the handoff state, not the evaluation state', () => {
  const seen: unknown[] = [];
  const spy = (input: Parameters<typeof verify>[0]) => {
    seen.push(input.trustedState);
    return verify(input);
  };
  const handoffState = pausedRepresentationState();
  route(request([routeQuote({ routeId: 'route.one' })]), routerHandoff({ trustedMarketState: handoffState }), spy);

  assert.ok(seen.length >= 2);
  const last = seen[seen.length - 1];
  assert.notEqual(last, seen[0], 'the final call must not see the evaluation state object');
});

test('F-5 REGRESSION: each kind of state change between evaluation and handoff rejects', () => {
  const cases: readonly { readonly label: string; readonly handoff: ReturnType<typeof routerHandoff> }[] = [
    { label: 'trading halted', handoff: routerHandoff({ trustedMarketState: haltedRouterState() }) },
    { label: 'representation paused', handoff: routerHandoff({ trustedMarketState: pausedRepresentationState() }) },
    {
      label: 'mandate expired',
      handoff: routerHandoff({ clock: { nowUnixSeconds: ROUTER_MANDATE.expiresAtUnixSeconds } }),
    },
    {
      label: 'price observation now stale',
      handoff: routerHandoff({ clock: { nowUnixSeconds: ROUTER_CLOCK + ROUTER_MANDATE.maxPriceAgeSeconds + 1n } }),
    },
  ];
  for (const item of cases) {
    const result = route(request([routeQuote({ routeId: 'route.one' })]), item.handoff);
    assert.equal(result.status, 'NO_VALID_ROUTE', item.label);
  }
});

test('F-5 REGRESSION: a handoff cannot be omitted, and an unusable one is not silently replaced', () => {
  const evaluated = evaluateRoutes(request([routeQuote({ routeId: 'route.one' })]));
  assert.ok(evaluated.status === 'EVALUATED');

  const missing = selectEvaluated(evaluated.evaluation, 0, undefined as never);
  assert.equal(missing.status, 'INVALID_INPUT');
  if (missing.status === 'INVALID_INPUT') assert.equal(missing.errors[0]?.code, 'HANDOFF_STATE_MISSING');

  const unparseable = selectEvaluated(evaluated.evaluation, 0, { trustedMarketState: 'not a state', clock: { nowUnixSeconds: ROUTER_CLOCK } });
  assert.equal(unparseable.status, 'INVALID_INPUT', 'no fallback to evaluation state');
});

// --- F-9: pipeline time does not run backwards ------------------------------

test('F-9 REGRESSION: a handoff instant earlier than the evaluation instant is refused', () => {
  const rewound = route(
    request([routeQuote({ routeId: 'route.one' })]),
    routerHandoff({ clock: { nowUnixSeconds: ROUTER_CLOCK - 1n } }),
  );
  assert.equal(rewound.status, 'INVALID_INPUT');
  if (rewound.status === 'INVALID_INPUT') assert.equal(rewound.errors[0]?.code, 'HANDOFF_TIME_REGRESSED');

  // Equal is permitted: a pipeline that completes within one second is normal.
  const same = route(request([routeQuote({ routeId: 'route.one' })]), routerHandoff());
  assert.equal(same.status, 'SELECTED');
});

// --- F-7: the registry snapshot is bound to the trusted state ---------------

test('F-7 REGRESSION: a trusted state declaring another registry snapshot is refused', () => {
  const foreign = { ...ROUTER_STATE, registrySnapshotDigest: `0x${'ab'.repeat(32)}` };
  const mismatched = route(request([routeQuote()], { trustedMarketState: foreign }), routerHandoff({ trustedMarketState: foreign }));
  assert.equal(mismatched.status, 'INVALID_INPUT');
  if (mismatched.status === 'INVALID_INPUT') assert.equal(mismatched.errors[0]?.code, 'REGISTRY_SNAPSHOT_MISMATCH');

  // The matching digest is accepted.
  const bound = { ...ROUTER_STATE, registrySnapshotDigest: registrySnapshotDigest(REGISTRY.snapshot) };
  const matched = route(request([routeQuote()], { trustedMarketState: bound }), routerHandoff({ trustedMarketState: bound }));
  assert.equal(matched.status, 'SELECTED');
});

// --- F-3: route() returns a verdict rather than throwing --------------------

test('F-3 REGRESSION: an oversized trusted state is INVALID_INPUT, not a throw', () => {
  const base = ROUTER_STATE.representations[0];
  assert.ok(base !== undefined);
  const representations: unknown[] = [{ provenance: { ...base.provenance }, value: { ...base.value } }];
  for (let index = 1; index <= MAX_STATE_REPRESENTATIONS; index += 1) {
    representations.push({
      provenance: { ...base.provenance },
      value: { ...base.value, representationId: `eip155:4663/erc20:0x${index.toString(16).padStart(40, '0')}` },
    });
  }
  const inflated = {
    version: 2,
    stateId: ROUTER_STATE.stateId,
    registrySnapshotDigest: null,
    representations,
    market: ROUTER_STATE.market,
    corporateAction: ROUTER_STATE.corporateAction,
    replay: ROUTER_STATE.replay,
  };
  assert.equal(parseTrustedState(inflated).ok, false, 'the kernel parser now bounds it');

  const result = route(request([routeQuote()], { trustedMarketState: inflated }), routerHandoff());
  assert.equal(result.status, 'INVALID_INPUT');
  if (result.status === 'INVALID_INPUT') {
    assert.ok(result.errors.some((item) => item.detail['cause'] === 'RESOURCE_LIMIT_EXCEEDED'), JSON.stringify(result.errors));
  }
});
