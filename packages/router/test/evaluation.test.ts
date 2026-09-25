/**
 * The evaluation/selection split exists so an advisory selector can address the
 * closed admissible set without a second ranking implementation. These tests
 * pin the two properties that make the split safe: `route` is exactly
 * evaluate-then-select-zero, and no index outside the closed set is reachable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Decision, parseIdentifier } from '@mandate/kernel';
import { openRegistry } from '@mandate/registry';
import { evaluateRoutes, route, selectEvaluated, type ProviderRouteQuote, type TrustedRouteCost } from '../src/index.ts';
import {
  ROUTER_AUTHORIZATION, ROUTER_CLOCK, ROUTER_DOMAIN, ROUTER_MANDATE, ROUTER_REGISTRY_INPUT,
  ROUTER_REQUESTED_QUANTITY, ROUTER_STATE, routeQuote, trustedCost, zeroFee,
} from './support/fixture.ts';

const opened = openRegistry(ROUTER_REGISTRY_INPUT);
if (!opened.ok) throw new Error('router test registry did not open');
const REGISTRY = opened.value;

function request(routes: readonly ProviderRouteQuote[], costs: readonly TrustedRouteCost[] = routes.map((quote) => trustedCost(quote))) {
  return {
    mandate: ROUTER_MANDATE,
    authorization: ROUTER_AUTHORIZATION,
    registry: REGISTRY,
    trustedMarketState: ROUTER_STATE,
    requestedQuantity: ROUTER_REQUESTED_QUANTITY,
    routes,
    trustedCosts: costs,
    clock: { nowUnixSeconds: ROUTER_CLOCK },
    expectedDomain: ROUTER_DOMAIN,
  };
}

function withFee(routeId: string, atoms: bigint): ProviderRouteQuote {
  const fee = { ...zeroFee(), atoms };
  return routeQuote({ routeId, costs: { venueFee: fee, executionFee: zeroFee(), settlementFee: zeroFee(), routeFee: zeroFee() } });
}

describe('route evaluation and selection', () => {
  it('reproduces route() exactly as evaluate-then-select-index-zero', () => {
    const input = request([withFee('route.c', 300n), withFee('route.a', 100n), withFee('route.b', 200n)]);
    const baseline = route(input);
    const evaluated = evaluateRoutes(input);
    assert.equal(evaluated.status, 'EVALUATED');
    if (evaluated.status !== 'EVALUATED') return;
    const split = selectEvaluated(evaluated.evaluation, 0);
    assert.equal(baseline.status, 'SELECTED');
    assert.equal(split.status, 'SELECTED');
    if (baseline.status !== 'SELECTED' || split.status !== 'SELECTED') return;
    assert.equal(split.receipt.receiptDigest, baseline.receipt.receiptDigest);
    assert.equal(split.selected.candidateDigest, baseline.selected.candidateDigest);
    assert.equal(split.finalVerificationReceipt.receiptDigest, baseline.finalVerificationReceipt.receiptDigest);
  });

  it('exposes the admissible set already in deterministic ranking order', () => {
    const evaluated = evaluateRoutes(request([withFee('route.c', 300n), withFee('route.a', 100n), withFee('route.b', 200n)]));
    assert.equal(evaluated.status, 'EVALUATED');
    if (evaluated.status !== 'EVALUATED') return;
    assert.deepEqual(evaluated.evaluation.admissible.map((item) => item.candidate.routeId), ['route.a', 'route.b', 'route.c']);
    for (const item of evaluated.evaluation.admissible) assert.equal(item.verificationReceipt.decision, Decision.PASS);
  });

  it('excludes a mandate-invalid route from the closed set entirely', () => {
    const attacker = parseIdentifier('issuer.attacker');
    assert.equal(attacker.ok, true);
    if (!attacker.ok) return;
    const evaluated = evaluateRoutes(request([{ ...withFee('route.attacker', 0n), issuer: attacker.value }, withFee('route.valid', 500n)]));
    assert.equal(evaluated.status, 'EVALUATED');
    if (evaluated.status !== 'EVALUATED') return;
    assert.deepEqual(evaluated.evaluation.admissible.map((item) => item.candidate.routeId), ['route.valid']);
    assert.equal(evaluated.evaluation.outcomes.length, 2);
  });

  it('selects a non-preferred member of the closed set and still re-verifies it', () => {
    const evaluated = evaluateRoutes(request([withFee('route.a', 100n), withFee('route.b', 200n)]));
    assert.equal(evaluated.status, 'EVALUATED');
    if (evaluated.status !== 'EVALUATED') return;
    const second = selectEvaluated(evaluated.evaluation, 1);
    assert.equal(second.status, 'SELECTED');
    if (second.status !== 'SELECTED') return;
    assert.equal(second.selected.routeId, 'route.b');
    assert.equal(second.finalVerificationReceipt.decision, Decision.PASS);
  });

  it('refuses an index outside the closed set rather than choosing something else', () => {
    const evaluated = evaluateRoutes(request([withFee('route.a', 100n)]));
    assert.equal(evaluated.status, 'EVALUATED');
    if (evaluated.status !== 'EVALUATED') return;
    for (const index of [-1, 1, 2, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = selectEvaluated(evaluated.evaluation, index);
      assert.equal(result.status, 'INVALID_INPUT', `index ${index}`);
      if (result.status !== 'INVALID_INPUT') continue;
      assert.equal(result.errors[0]?.code, 'INPUT_INVALID');
      assert.equal(result.errors[0]?.detail['input'], 'selectedIndex');
    }
  });

  it('reports no valid route from an empty closed set whatever index is asked for', () => {
    const attacker = parseIdentifier('issuer.attacker');
    assert.equal(attacker.ok, true);
    if (!attacker.ok) return;
    const input = request([{ ...withFee('route.attacker', 0n), issuer: attacker.value }]);
    const evaluated = evaluateRoutes(input);
    assert.equal(evaluated.status, 'EVALUATED');
    if (evaluated.status !== 'EVALUATED') return;
    assert.equal(evaluated.evaluation.admissible.length, 0);
    const baseline = route(input);
    for (const index of [0, 7, -3]) {
      const result = selectEvaluated(evaluated.evaluation, index);
      assert.equal(result.status, 'NO_VALID_ROUTE');
      if (result.status !== 'NO_VALID_ROUTE' || baseline.status !== 'NO_VALID_ROUTE') continue;
      assert.equal(result.receipt.receiptDigest, baseline.receipt.receiptDigest);
    }
  });

  it('propagates invalid input from evaluation without producing a set', () => {
    const evaluated = evaluateRoutes({ ...request([withFee('route.a', 100n)]), clock: { nowUnixSeconds: 'not-a-time' } });
    assert.equal(evaluated.status, 'INVALID_INPUT');
    if (evaluated.status !== 'INVALID_INPUT') return;
    assert.ok(evaluated.errors.some((item) => item.code === 'INPUT_INVALID'));
  });
});
