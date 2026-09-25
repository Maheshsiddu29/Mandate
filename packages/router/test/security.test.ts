import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mandateDigest, parseIdentifier } from '@mandate/kernel';
import { openRegistry } from '@mandate/registry';
import { envelopeFor, TEST_PRIVATE_KEY } from '../../kernel/test/support/signing.ts';
import { collectProviderRoutes, route, routingCandidateDigest, type ProviderRouteQuote } from '../src/index.ts';
import {
  ROUTER_CLOCK, ROUTER_DOMAIN, ROUTER_MANDATE, ROUTER_REGISTRY_INPUT, ROUTER_REQUESTED_QUANTITY, ROUTER_STATE,
  routeQuote, trustedCost, zeroFee,
} from './support/fixture.ts';

const registry = openRegistry(ROUTER_REGISTRY_INPUT);
if (!registry.ok) throw new Error('security registry failed');
const SECURITY_REGISTRY = registry.value;

function signedRequest(quote: ProviderRouteQuote, mandate = ROUTER_MANDATE) {
  const digest = mandateDigest(mandate);
  const trustedMarketState = ROUTER_STATE.replay === null ? ROUTER_STATE : {
    ...ROUTER_STATE,
    replay: { ...ROUTER_STATE.replay, value: { ...ROUTER_STATE.replay.value, mandateDigest: digest } },
  };
  return {
    mandate,
    authorization: envelopeFor(digest, TEST_PRIVATE_KEY, ROUTER_DOMAIN),
    registry: SECURITY_REGISTRY,
    trustedMarketState,
    requestedQuantity: ROUTER_REQUESTED_QUANTITY,
    routes: [quote],
    trustedCosts: [trustedCost(quote)],
    clock: { nowUnixSeconds: ROUTER_CLOCK },
    expectedDomain: ROUTER_DOMAIN,
  };
}

describe('adversarial route providers', () => {
  it('rejects provider spoofing and thrown provider failures', () => {
    const spoofed = collectProviderRoutes({ providerId: 'provider.expected', providerClass: 'SYNTHETIC_TEST', discover: () => [routeQuote()] });
    assert.equal(spoofed.ok, false);
    if (!spoofed.ok) assert.equal(spoofed.error.code, 'PROVIDER_IDENTITY_MISMATCH');
    const thrown = collectProviderRoutes({ providerId: 'provider.fixture', providerClass: 'SYNTHETIC_TEST', discover: () => { throw new Error('provider failure'); } });
    assert.equal(thrown.ok, false);
  });

  it('rejects amount, canonical asset, chain, venue, side and state mutations', () => {
    const identifier = (value: string) => {
      const parsed = parseIdentifier(value);
      if (!parsed.ok) throw new Error('bad test identifier');
      return parsed.value;
    };
    const mutations: ProviderRouteQuote[] = [
      routeQuote({ notional: { ...routeQuote().notional, atoms: routeQuote().notional.atoms + 1n } }),
      routeQuote({
        quantity: { ...routeQuote().quantity, atoms: routeQuote().quantity.atoms / 2n },
        notional: { ...routeQuote().notional, atoms: routeQuote().notional.atoms / 2n },
      }),
      routeQuote({ canonicalAsset: { ...routeQuote().canonicalAsset, value: identifier('US0378331005') } }),
      routeQuote({ chain: identifier('eip155:1') }),
      routeQuote({ venue: identifier('venue.attacker') }),
      routeQuote({ side: 'SELL' }),
      routeQuote({ corporateActionEpoch: routeQuote().corporateActionEpoch + 1n }),
    ];
    for (const quote of mutations) assert.notEqual(route(signedRequest(quote)).status, 'SELECTED');
  });

  it('enforces BUY upper and SELL lower price boundaries at one atom', () => {
    const reference = routeQuote().executionPrice;
    const buyAbove = routeQuote({
      executionPrice: { ...reference, atoms: reference.atoms + 1n },
      notional: { ...routeQuote().notional, atoms: routeQuote().notional.atoms + 1n },
    });
    assert.equal(route(signedRequest(buyAbove)).status, 'NO_VALID_ROUTE');
    assert.equal(route(signedRequest(routeQuote())).status, 'SELECTED');

    const sellMandate = { ...ROUTER_MANDATE, side: 'SELL' as const };
    const sellExact = routeQuote({ side: 'SELL' });
    assert.equal(route(signedRequest(sellExact, sellMandate)).status, 'SELECTED');
    const sellBelow = routeQuote({
      side: 'SELL',
      executionPrice: { ...reference, atoms: reference.atoms - 1n },
      notional: { ...routeQuote().notional, atoms: routeQuote().notional.atoms - 1n },
    });
    assert.equal(route(signedRequest(sellBelow, sellMandate)).status, 'NO_VALID_ROUTE');
  });

  it('detects malicious zero fees against independent cost state', () => {
    const quote = routeQuote();
    const trusted = trustedCost(quote, { costs: { ...quote.costs, routeFee: { ...zeroFee(), atoms: 1n } } });
    const input = signedRequest(quote);
    const result = route({ ...input, trustedCosts: [trusted] });
    assert.equal(result.status, 'NO_VALID_ROUTE');
  });

  it('changes candidate commitments under route-level tampering without collisions', () => {
    const quote = routeQuote();
    const base = {
      version: 1 as const, routeId: quote.routeId, providerId: quote.providerId,
      providerClass: quote.providerClass, fillPolicy: 'FILL_OR_KILL' as const,
      quoteObservedAtUnixSeconds: quote.quoteObservedAtUnixSeconds,
      referenceObservedAtUnixSeconds: ROUTER_STATE.market?.provenance.observedAtUnixSeconds ?? ROUTER_CLOCK,
      referencePrice: ROUTER_STATE.market?.value.referencePrice ?? quote.executionPrice,
      trustedCostSourceId: 'trusted.fixture.costs',
      trustedCostObservedAtUnixSeconds: ROUTER_CLOCK,
      costs: { venueFee: zeroFee(), executionFee: zeroFee(), settlementFee: zeroFee(), routeFee: zeroFee() },
      steps: quote.steps,
      executionCandidate: {
        version: 1, representationId: quote.representationId, canonicalAsset: quote.canonicalAsset,
        issuer: quote.issuer, chain: quote.chain, venue: quote.venue, side: quote.side, agent: quote.agent,
        quantity: quote.quantity, executionPrice: quote.executionPrice, notional: quote.notional,
        referenceStateId: quote.referenceStateId, corporateActionEpoch: quote.corporateActionEpoch,
      },
    };
    const changedVenue = parseIdentifier('venue.changed');
    if (!changedVenue.ok) throw new Error('invalid test venue');
    const digests = new Set([
      routingCandidateDigest(base),
      routingCandidateDigest({ ...base, routeId: 'route.changed' }),
      routingCandidateDigest({ ...base, providerId: 'provider.changed' }),
      routingCandidateDigest({ ...base, steps: [{ ...base.steps[0]!, venue: changedVenue.value }] }),
    ]);
    assert.equal(digests.size, 4);
  });

  it('reproduces receipts and changes them when the explicit clock changes', () => {
    const input = signedRequest(routeQuote());
    const first = route(input);
    const second = route(input);
    assert.equal(first.status, 'SELECTED');
    assert.equal(second.status, 'SELECTED');
    if (first.status === 'SELECTED' && second.status === 'SELECTED') assert.equal(first.receipt.receiptDigest, second.receipt.receiptDigest);
    const later = route({ ...input, clock: { nowUnixSeconds: ROUTER_CLOCK + 1n } });
    if (first.status === 'SELECTED' && later.status === 'SELECTED') assert.notEqual(first.receipt.receiptDigest, later.receipt.receiptDigest);
  });
});
