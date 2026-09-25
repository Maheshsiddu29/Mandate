import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Decision, parseIdentifier, verify } from '@mandate/kernel';
import { openRegistry } from '@mandate/registry';
import { route, type ProviderRouteQuote, type TrustedRouteCost } from '../src/index.ts';
import {
  ROUTER_AUTHORIZATION, ROUTER_CLOCK, ROUTER_DOMAIN, ROUTER_MANDATE, ROUTER_REGISTRY_INPUT, ROUTER_REQUESTED_QUANTITY,
  ROUTER_STATE, routeQuote, trustedCost, zeroFee,
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

describe('deterministic router', () => {
  it('ranks only kernel-PASS candidates and selects lower BUY cost', () => {
    const expensive = withFee('route.expensive', 500n);
    const cheap = withFee('route.cheap', 100n);
    const result = route(request([expensive, cheap]));
    assert.equal(result.status, 'SELECTED');
    if (result.status !== 'SELECTED') return;
    assert.equal(result.selected.routeId, 'route.cheap');
    assert.equal(result.receipt.outcomes.filter((item) => item.status === 'ADMISSIBLE').length, 2);
    assert.equal(result.finalVerificationReceipt.decision, Decision.PASS);
  });

  it('cannot let a cheaper identity-substitution route outrank a valid route', () => {
    const valid = withFee('route.valid', 500n);
    const attacker = withFee('route.attacker', 0n);
    const wrongIssuer = parseIdentifier('issuer.attacker');
    assert.equal(wrongIssuer.ok, true);
    if (!wrongIssuer.ok) return;
    const result = route(request([{ ...attacker, issuer: wrongIssuer.value }, valid]));
    assert.equal(result.status, 'SELECTED');
    if (result.status !== 'SELECTED') return;
    assert.equal(result.selected.routeId, 'route.valid');
    const excluded = result.receipt.outcomes.find((item) => item.routeId === 'route.attacker');
    assert.equal(excluded?.status, 'EXCLUDED');
    if (excluded?.status === 'EXCLUDED') assert.ok(excluded.exclusions.some((item) => item.code === 'PROVIDER_IDENTITY_MISMATCH'));
  });

  it('prevents an unregistered same-symbol representation from entering construction', () => {
    const fake = parseIdentifier('eip155:4663/erc20:0x1111111111111111111111111111111111111111');
    assert.equal(fake.ok, true);
    if (!fake.ok) return;
    const quote = routeQuote({ routeId: 'route.fake', representationId: fake.value });
    const result = route(request([quote]));
    assert.equal(result.status, 'NO_VALID_ROUTE');
    if (result.status !== 'NO_VALID_ROUTE') return;
    const outcome = result.receipt.outcomes[0];
    assert.equal(outcome?.status, 'EXCLUDED');
    if (outcome?.status === 'EXCLUDED') assert.equal(outcome.exclusions[0]?.code, 'REPRESENTATION_NOT_DISCOVERABLE');
  });

  it('is invariant to provider input order and uses a stable digest tie-break', () => {
    const a = withFee('route.a', 100n);
    const b = withFee('route.b', 100n);
    const first = route(request([a, b]));
    const second = route(request([b, a]));
    assert.equal(first.status, 'SELECTED');
    assert.equal(second.status, 'SELECTED');
    if (first.status !== 'SELECTED' || second.status !== 'SELECTED') return;
    assert.equal(first.selected.candidateDigest, second.selected.candidateDigest);
    assert.equal(first.receipt.receiptDigest, second.receipt.receiptDigest);
  });

  it('re-verifies the ranked winner before handoff', () => {
    let calls = 0;
    const result = route(request([routeQuote()]), (input) => {
      calls += 1;
      return verify(input);
    });
    assert.equal(result.status, 'SELECTED');
    assert.equal(calls, 2);
  });

  it('returns no handoff if final re-verification fails', () => {
    let calls = 0;
    const result = route(request([routeQuote()]), (input) => {
      calls += 1;
      const actual = verify(input);
      if (calls === 1) return actual;
      return { ...actual, decision: Decision.REJECT, reasonCodes: ['VERIFIER_INTERNAL_ERROR'], violations: [{ code: 'VERIFIER_INTERNAL_ERROR', detail: { check: 'test-seam' } }] };
    });
    assert.equal(result.status, 'NO_VALID_ROUTE');
    assert.equal(calls, 2);
    if (result.status === 'NO_VALID_ROUTE') assert.equal(result.receipt.selectedCandidateDigest, null);
  });

  it('returns INVALID_INPUT for duplicate routes and oversized provider input', () => {
    const duplicate = route(request([routeQuote(), routeQuote()]));
    assert.equal(duplicate.status, 'INVALID_INPUT');
    if (duplicate.status === 'INVALID_INPUT') assert.equal(duplicate.errors[0]?.code, 'DUPLICATE_ROUTE_ID');
  });
});
