import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mandateDigest, type CanonicalMandate } from '@mandate/kernel';
import { openRegistry } from '@mandate/registry';
import { envelopeFor, TEST_PRIVATE_KEY } from '../../kernel/test/support/signing.ts';
import { route, type ProviderRouteQuote } from '../src/index.ts';
import {
  ROUTER_CLOCK, ROUTER_DOMAIN, ROUTER_MANDATE, ROUTER_REGISTRY_INPUT,
  ROUTER_REQUESTED_QUANTITY, ROUTER_STATE, routeQuote, trustedCost, zeroFee,
} from './support/fixture.ts';

const opened = openRegistry(ROUTER_REGISTRY_INPUT);
if (!opened.ok) throw new Error('ranking registry failed');
const RANKING_REGISTRY = opened.value;

function run(mandate: CanonicalMandate, routes: readonly ProviderRouteQuote[]) {
  const digest = mandateDigest(mandate);
  const state = ROUTER_STATE.replay === null ? ROUTER_STATE : {
    ...ROUTER_STATE,
    replay: { ...ROUTER_STATE.replay, value: { ...ROUTER_STATE.replay.value, mandateDigest: digest } },
  };
  return route({
    mandate,
    authorization: envelopeFor(digest, TEST_PRIVATE_KEY, ROUTER_DOMAIN),
    registry: RANKING_REGISTRY,
    trustedMarketState: state,
    requestedQuantity: ROUTER_REQUESTED_QUANTITY,
    routes,
    trustedCosts: routes.map((quote) => trustedCost(quote)),
    clock: { nowUnixSeconds: ROUTER_CLOCK },
    expectedDomain: ROUTER_DOMAIN,
  });
}

function feeQuote(routeId: string, atoms: bigint, patch: Partial<ProviderRouteQuote> = {}): ProviderRouteQuote {
  const fee = { ...zeroFee(), atoms };
  return routeQuote({ routeId, costs: { venueFee: fee, executionFee: zeroFee(), settlementFee: zeroFee(), routeFee: zeroFee() }, ...patch });
}

describe('lexicographic route quality', () => {
  it('uses lower deviation after equal BUY economic cost', () => {
    const mandate = { ...ROUTER_MANDATE, maxDeviationBps: 1n };
    const exact = feeQuote('route.exact', 2n);
    const deviated = feeQuote('route.deviated', 1n, {
      executionPrice: { ...exact.executionPrice, atoms: exact.executionPrice.atoms + 1n },
      notional: { ...exact.notional, atoms: exact.notional.atoms + 1n },
    });
    const result = run(mandate, [deviated, exact]);
    assert.equal(result.status, 'SELECTED');
    if (result.status === 'SELECTED') assert.equal(result.selected.routeId, 'route.exact');
  });

  it('uses fresher quote after equal cost and deviation', () => {
    const fresh = feeQuote('route.fresh', 10n);
    const older = feeQuote('route.older', 10n, { quoteObservedAtUnixSeconds: ROUTER_CLOCK - 1n });
    const result = run(ROUTER_MANDATE, [older, fresh]);
    assert.equal(result.status, 'SELECTED');
    if (result.status === 'SELECTED') assert.equal(result.selected.routeId, 'route.fresh');
  });

  it('uses fewer route steps after equal cost, deviation and freshness', () => {
    const simple = feeQuote('route.simple', 10n);
    const complex = feeQuote('route.complex', 10n, { steps: [simple.steps[0]!, simple.steps[0]!] });
    const result = run(ROUTER_MANDATE, [complex, simple]);
    assert.equal(result.status, 'SELECTED');
    if (result.status === 'SELECTED') assert.equal(result.selected.routeId, 'route.simple');
  });

  it('ranks SELL routes by higher net proceeds', () => {
    const mandate = { ...ROUTER_MANDATE, side: 'SELL' as const };
    const lowerFee = feeQuote('route.sell-low-fee', 10n, { side: 'SELL' });
    const higherFee = feeQuote('route.sell-high-fee', 20n, { side: 'SELL' });
    const result = run(mandate, [higherFee, lowerFee]);
    assert.equal(result.status, 'SELECTED');
    if (result.status === 'SELECTED') assert.equal(result.selected.routeId, 'route.sell-low-fee');
  });
});
