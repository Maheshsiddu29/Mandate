import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UINT256_MAX, parseIdentifier } from '@mandate/kernel';
import { buildRoutingCandidate } from '../src/index.ts';
import { ROUTER_CLOCK, ROUTER_MANDATE, ROUTER_STATE, routeQuote, sellMandate, trustedCost, zeroFee } from './support/fixture.ts';

describe('execution candidate construction', () => {
  it('constructs a committed candidate only after independent cost and identity checks', () => {
    const quote = routeQuote();
    const result = buildRoutingCandidate({ mandate: ROUTER_MANDATE, quote, trustedState: ROUTER_STATE, trustedCost: trustedCost(quote), nowUnixSeconds: ROUTER_CLOCK });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.candidate.executionCandidate.representationId, quote.representationId);
    assert.equal(result.quality.economicValue.atoms, quote.notional.atoms);
    assert.match(result.candidate.candidateDigest, /^0x[0-9a-f]{64}$/);
  });

  it('fails closed on partial fills, unknown costs and fee understatement', () => {
    const partial = routeQuote({ fillPolicy: 'ALLOW_PARTIAL' });
    const partialResult = buildRoutingCandidate({ mandate: ROUTER_MANDATE, quote: partial, trustedState: ROUTER_STATE, trustedCost: trustedCost(partial), nowUnixSeconds: ROUTER_CLOCK });
    assert.equal(partialResult.ok, false);
    if (!partialResult.ok) assert.ok(partialResult.exclusions.some((item) => item.code === 'PARTIAL_FILL_UNSUPPORTED'));

    const unknown = routeQuote({ costs: { venueFee: null, executionFee: zeroFee(), settlementFee: zeroFee(), routeFee: zeroFee() } });
    const unknownResult = buildRoutingCandidate({ mandate: ROUTER_MANDATE, quote: unknown, trustedState: ROUTER_STATE, trustedCost: trustedCost(unknown), nowUnixSeconds: ROUTER_CLOCK });
    assert.equal(unknownResult.ok, false);
    if (!unknownResult.ok) assert.ok(unknownResult.exclusions.some((item) => item.code === 'UNKNOWN_COST'));

    const stated = routeQuote();
    const trusted = trustedCost(stated, { costs: { ...stated.costs, venueFee: { ...zeroFee(), atoms: 25n } } });
    const mismatch = buildRoutingCandidate({ mandate: ROUTER_MANDATE, quote: stated, trustedState: ROUTER_STATE, trustedCost: trusted, nowUnixSeconds: ROUTER_CLOCK });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.ok(mismatch.exclusions.some((item) => item.code === 'UNTRUSTED_COST_MISMATCH'));
  });

  it('rejects identity, state, step and quote-time mutations', () => {
    const cases = [
      routeQuote({ issuer: identifier('issuer.attacker') }),
      routeQuote({ chain: identifier('eip155:1') }),
      routeQuote({ side: 'SELL' }),
      routeQuote({ referenceStateId: 'state.attacker' }),
      routeQuote({ quoteObservedAtUnixSeconds: ROUTER_CLOCK - ROUTER_MANDATE.maxPriceAgeSeconds - 1n }),
      routeQuote({ quoteObservedAtUnixSeconds: ROUTER_CLOCK + 1n }),
    ];
    for (const quote of cases) {
      const result = buildRoutingCandidate({ mandate: ROUTER_MANDATE, quote, trustedState: ROUTER_STATE, trustedCost: trustedCost(quote), nowUnixSeconds: ROUTER_CLOCK });
      assert.equal(result.ok, false);
    }
  });

  it('computes BUY cost and SELL net proceeds symmetrically', () => {
    const fee = { ...zeroFee(), atoms: 10n };
    const buy = routeQuote({ costs: { venueFee: fee, executionFee: zeroFee(), settlementFee: zeroFee(), routeFee: zeroFee() } });
    const buyResult = buildRoutingCandidate({ mandate: ROUTER_MANDATE, quote: buy, trustedState: ROUTER_STATE, trustedCost: trustedCost(buy), nowUnixSeconds: ROUTER_CLOCK });
    assert.equal(buyResult.ok, true);
    if (buyResult.ok) assert.equal(buyResult.quality.economicValue.atoms, buy.notional.atoms + 10n);

    const sell = routeQuote({ side: 'SELL', costs: buy.costs });
    const sellResult = buildRoutingCandidate({ mandate: sellMandate(), quote: sell, trustedState: ROUTER_STATE, trustedCost: trustedCost(sell), nowUnixSeconds: ROUTER_CLOCK });
    assert.equal(sellResult.ok, true);
    if (sellResult.ok) assert.equal(sellResult.quality.economicValue.atoms, sell.notional.atoms - 10n);
  });

  it('rejects economic overflow and sell fees that consume proceeds', () => {
    const huge = { ...zeroFee(), atoms: UINT256_MAX };
    const buy = routeQuote({ costs: { venueFee: huge, executionFee: zeroFee(), settlementFee: zeroFee(), routeFee: zeroFee() } });
    const overflow = buildRoutingCandidate({ mandate: ROUTER_MANDATE, quote: buy, trustedState: ROUTER_STATE, trustedCost: trustedCost(buy), nowUnixSeconds: ROUTER_CLOCK });
    assert.equal(overflow.ok, false);
    if (!overflow.ok) assert.ok(overflow.exclusions.some((item) => item.code === 'COST_OVERFLOW'));

    const proceeds = routeQuote({ side: 'SELL' });
    const fee = { ...zeroFee(), atoms: proceeds.notional.atoms };
    const expensive = { ...proceeds, costs: { venueFee: fee, executionFee: zeroFee(), settlementFee: zeroFee(), routeFee: zeroFee() } };
    const result = buildRoutingCandidate({ mandate: sellMandate(), quote: expensive, trustedState: ROUTER_STATE, trustedCost: trustedCost(expensive), nowUnixSeconds: ROUTER_CLOCK });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.exclusions.some((item) => item.code === 'SELL_FEES_EXCEED_PROCEEDS'));
  });
});

function identifier(value: string) {
  const parsed = parseIdentifier(value);
  if (!parsed.ok) throw new Error('invalid test identifier');
  return parsed.value;
}
