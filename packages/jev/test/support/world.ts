/**
 * Shared Phase 5 test world.
 *
 * The underlying representation, price, contract identity and corporate-action
 * epoch are the recorded Phase 3 NVDA mainnet snapshot, reached through the
 * router's own Phase 4 fixture. Route fees, alternate venues and every
 * adversarial mutation are synthetic and labelled as such.
 */

import { parseIdentifier, type TrustedState } from '@mandate/kernel';
import { openRegistry } from '@mandate/registry';
import { evaluateRoutes, type ProviderRouteQuote, type RouteRequest, type RoutingEvaluation, type TrustedRouteCost } from '@mandate/router';
import {
  ROUTER_AUTHORIZATION, ROUTER_CLOCK, ROUTER_DOMAIN, ROUTER_MANDATE, ROUTER_REGISTRY_INPUT,
  ROUTER_REQUESTED_QUANTITY, ROUTER_STATE, routeQuote, trustedCost, zeroFee,
} from '../../../router/test/support/fixture.ts';

const opened = openRegistry(ROUTER_REGISTRY_INPUT);
if (!opened.ok) throw new Error('jev test registry did not open');
export const REGISTRY = opened.value;

export { ROUTER_CLOCK, ROUTER_MANDATE, ROUTER_STATE };

export function quoteWithFee(routeId: string, feeAtoms: bigint, ageSeconds = 0n): ProviderRouteQuote {
  const fee = { ...zeroFee(), atoms: feeAtoms };
  return routeQuote({
    routeId,
    quoteObservedAtUnixSeconds: ROUTER_CLOCK - ageSeconds,
    costs: { venueFee: fee, executionFee: zeroFee(), settlementFee: zeroFee(), routeFee: zeroFee() },
  });
}

/** A route the kernel rejects: an issuer the mandate does not permit. */
export function maliciousQuote(routeId: string, feeAtoms = 0n): ProviderRouteQuote {
  const attacker = parseIdentifier('issuer.attacker');
  if (!attacker.ok) throw new Error('invalid synthetic issuer');
  return { ...quoteWithFee(routeId, feeAtoms), issuer: attacker.value };
}

export function routeRequest(
  routes: readonly ProviderRouteQuote[],
  overrides: Partial<RouteRequest> = {},
  costs: readonly TrustedRouteCost[] = routes.map((quote) => trustedCost(quote)),
): RouteRequest {
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
    ...overrides,
  };
}

/** `count` valid candidates with strictly increasing fees, so ranking is total. */
export function validRoutes(count: number): readonly ProviderRouteQuote[] {
  const routes: ProviderRouteQuote[] = [];
  for (let index = 0; index < count; index += 1) {
    routes.push(quoteWithFee(`route.valid.${String(index).padStart(3, '0')}`, BigInt(100 + index)));
  }
  return routes;
}

export function evaluationOf(routes: readonly ProviderRouteQuote[], overrides: Partial<RouteRequest> = {}): RoutingEvaluation {
  const evaluated = evaluateRoutes(routeRequest(routes, overrides));
  if (evaluated.status !== 'EVALUATED') throw new Error('test world did not evaluate');
  return evaluated.evaluation;
}

/** The recorded market state with trading halted — every candidate then fails. */
export function haltedState(): TrustedState {
  if (ROUTER_STATE.market === null) throw new Error('fixture has no market state');
  return { ...ROUTER_STATE, market: { ...ROUTER_STATE.market, value: { ...ROUTER_STATE.market.value, haltStatus: 'HALTED' } } };
}

/** The recorded market state with a reference price far from every quote. */
export function movedPriceState(multiplier: bigint): TrustedState {
  if (ROUTER_STATE.market === null || ROUTER_STATE.market.value.referencePrice === null) throw new Error('fixture has no reference price');
  const price = ROUTER_STATE.market.value.referencePrice;
  return {
    ...ROUTER_STATE,
    market: { ...ROUTER_STATE.market, value: { ...ROUTER_STATE.market.value, referencePrice: { ...price, atoms: price.atoms * multiplier } } },
  };
}
