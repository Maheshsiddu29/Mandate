import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { candidateDigest, parseAmount, parseCandidate, parsePrice } from '@mandate/kernel';
import {
  MAX_ROUTE_CANDIDATES,
  parseProviderRouteQuote,
  parseProviderRouteSet,
  routingCandidateDigest,
} from '../src/index.ts';

const ASSET = { assetClass: 'equity', idScheme: 'isin', value: 'US67066G1040' };
const AGENT = { kind: 'eip155-address', value: '0x1111111111111111111111111111111111111111' };
const REP = 'eip155:4663/erc20:0x2222222222222222222222222222222222222222';
const parsedZero = parseAmount({ unit: 'USD', decimals: 2, atoms: 0n });
if (!parsedZero.ok) throw new Error('invalid test amount');
const ZERO = parsedZero.value;

function rawQuote(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    routeId: 'route.alpha',
    providerId: 'provider.fixture',
    providerClass: 'SYNTHETIC_TEST',
    canonicalAsset: ASSET,
    representationId: REP,
    issuer: 'issuer.fixture',
    chain: 'eip155:4663',
    venue: 'venue.fixture',
    side: 'BUY',
    agent: AGENT,
    quantity: { unit: 'TOKEN', decimals: 18, atoms: 1_000_000_000_000_000_000n },
    executionPrice: { numeratorUnit: 'USD', denominatorUnit: 'TOKEN', decimals: 2, atoms: 10000n },
    notional: { unit: 'USD', decimals: 2, atoms: 10000n },
    quoteObservedAtUnixSeconds: 1_700_000_000n,
    fillPolicy: 'FILL_OR_KILL',
    costs: { venueFee: ZERO, executionFee: ZERO, settlementFee: ZERO, routeFee: ZERO },
    steps: [{ kind: 'TRADE', venue: 'venue.fixture', chain: 'eip155:4663', representationId: REP }],
    referenceStateId: 'state.fixture',
    corporateActionEpoch: 0n,
    ...patch,
  };
}

describe('route-provider boundary', () => {
  it('strictly parses a complete provider quote', () => {
    const result = parseProviderRouteQuote(rawQuote());
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.routeId, 'route.alpha');
  });

  it('rejects unknown fields, malformed amounts and unsupported steps', () => {
    assert.equal(parseProviderRouteQuote(rawQuote({ surprise: true })).ok, false);
    assert.equal(parseProviderRouteQuote(rawQuote({ notional: { unit: 'USD', decimals: 2, atoms: -1n } })).ok, false);
    assert.equal(parseProviderRouteQuote(rawQuote({ steps: [{ kind: 'BRIDGE', venue: 'venue.fixture', chain: 'eip155:4663', representationId: REP }] })).ok, false);
  });

  it('rejects duplicate and oversized route sets before routing', () => {
    const duplicate = parseProviderRouteSet([rawQuote(), rawQuote()]);
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.error.code, 'DUPLICATE_ROUTE_ID');
    const oversized = parseProviderRouteSet(Array.from({ length: MAX_ROUTE_CANDIDATES + 1 }, (_, index) => rawQuote({ routeId: `route.${index}` })));
    assert.equal(oversized.ok, false);
    if (!oversized.ok) assert.equal(oversized.error.code, 'RESOURCE_LIMIT_EXCEEDED');
  });

  it('canonicalizes provider order by route identity', () => {
    const result = parseProviderRouteSet([rawQuote({ routeId: 'route.z' }), rawQuote({ routeId: 'route.a' })]);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value.map((quote) => quote.routeId), ['route.a', 'route.z']);
  });
});

describe('routing-candidate digest', () => {
  it('commits to kernel and route-specific security fields', () => {
    const parsed = parseProviderRouteQuote(rawQuote());
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const executionCandidate = parseCandidate({
      version: 3, representationId: REP, canonicalAsset: ASSET, issuer: 'issuer.fixture',
      chain: 'eip155:4663', venue: 'venue.fixture', side: 'BUY', agent: AGENT,
      quantity: parsed.value.quantity, executionPrice: parsed.value.executionPrice,
      notional: parsed.value.notional, feeTotal: ZERO,
      evaluationStateId: 'state.fixture', evaluationStateDigest: '0x' + '11'.repeat(32),
      registrySnapshotDigest: '0x' + '22'.repeat(32),
      corporateActionEpoch: 0n,
    });
    assert.equal(executionCandidate.ok, true);
    if (!executionCandidate.ok) return;
    const referencePrice = parsePrice(parsed.value.executionPrice);
    assert.equal(referencePrice.ok, true);
    if (!referencePrice.ok) return;
    const base = {
      version: 1 as const, routeId: parsed.value.routeId, providerId: parsed.value.providerId,
      providerClass: parsed.value.providerClass, fillPolicy: 'FILL_OR_KILL' as const,
      quoteObservedAtUnixSeconds: parsed.value.quoteObservedAtUnixSeconds,
      referenceObservedAtUnixSeconds: parsed.value.quoteObservedAtUnixSeconds,
      referencePrice: referencePrice.value,
      trustedCostSourceId: 'trusted.fixture.costs',
      trustedCostObservedAtUnixSeconds: parsed.value.quoteObservedAtUnixSeconds,
      costs: { venueFee: ZERO, executionFee: ZERO, settlementFee: ZERO, routeFee: ZERO },
      steps: parsed.value.steps, feeTotal: ZERO, executionCandidate: executionCandidate.value,
    };
    const digest = routingCandidateDigest(base);
    assert.notEqual(digest, routingCandidateDigest({ ...base, routeId: 'route.beta' }));
    assert.notEqual(digest, routingCandidateDigest({ ...base, costs: { ...base.costs, venueFee: { ...ZERO, atoms: 1n } } }));
    assert.notEqual(digest, routingCandidateDigest({ ...base, quoteObservedAtUnixSeconds: base.quoteObservedAtUnixSeconds - 1n }));
    assert.notEqual(digest, routingCandidateDigest({ ...base, feeTotal: { ...ZERO, atoms: 1n } }), 'the fee total is committed');
    assert.equal(candidateDigest(executionCandidate.value), candidateDigest(executionCandidate.value));
  });
});
