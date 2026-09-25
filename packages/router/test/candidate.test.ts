import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UINT256_MAX, parseIdentifier } from '@mandate/kernel';
import { buildRoutingCandidate } from '../src/index.ts';
import { ROUTER_CLOCK, ROUTER_MANDATE, ROUTER_REQUESTED_QUANTITY, ROUTER_STATE, routeQuote, sellMandate, trustedCost, zeroFee } from './support/fixture.ts';

describe('execution candidate construction', () => {
  it('constructs a committed candidate only after independent cost and identity checks', () => {
    const quote = routeQuote();
    const result = build(ROUTER_MANDATE, quote, trustedCost(quote));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.candidate.executionCandidate.representationId, quote.representationId);
    assert.equal(result.quality.economicValue.atoms, quote.notional.atoms);
    assert.match(result.candidate.candidateDigest, /^0x[0-9a-f]{64}$/);
  });

  it('fails closed on partial fills, unknown costs and fee understatement', () => {
    const partial = routeQuote({ fillPolicy: 'ALLOW_PARTIAL' });
    const partialResult = build(ROUTER_MANDATE, partial, trustedCost(partial));
    assert.equal(partialResult.ok, false);
    if (!partialResult.ok) assert.ok(partialResult.exclusions.some((item) => item.code === 'PARTIAL_FILL_UNSUPPORTED'));

    const unknown = routeQuote({ costs: { venueFee: null, executionFee: zeroFee(), settlementFee: zeroFee(), routeFee: zeroFee() } });
    const unknownResult = build(ROUTER_MANDATE, unknown, trustedCost(unknown));
    assert.equal(unknownResult.ok, false);
    if (!unknownResult.ok) assert.ok(unknownResult.exclusions.some((item) => item.code === 'UNKNOWN_COST'));

    const stated = routeQuote();
    const trusted = trustedCost(stated, { costs: { ...stated.costs, venueFee: { ...zeroFee(), atoms: 25n } } });
    const mismatch = build(ROUTER_MANDATE, stated, trusted);
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.ok(mismatch.exclusions.some((item) => item.code === 'UNTRUSTED_COST_MISMATCH'));
  });

  it('rejects stale or future trusted cost observations', () => {
    const quote = routeQuote();
    const stale = trustedCost(quote, { observedAtUnixSeconds: ROUTER_CLOCK - ROUTER_MANDATE.maxPriceAgeSeconds - 1n });
    const staleResult = build(ROUTER_MANDATE, quote, stale);
    assert.equal(staleResult.ok, false);
    if (!staleResult.ok) assert.ok(staleResult.exclusions.some((item) => item.code === 'COST_STATE_STALE'));
    const future = trustedCost(quote, { observedAtUnixSeconds: ROUTER_CLOCK + 1n });
    const futureResult = build(ROUTER_MANDATE, quote, future);
    assert.equal(futureResult.ok, false);
    if (!futureResult.ok) assert.ok(futureResult.exclusions.some((item) => item.code === 'COST_STATE_FUTURE'));
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
      const result = build(ROUTER_MANDATE, quote, trustedCost(quote));
      assert.equal(result.ok, false);
    }
  });

  it('computes BUY cost and SELL net proceeds symmetrically', () => {
    const fee = { ...zeroFee(), atoms: 10n };
    const buy = routeQuote({ costs: { venueFee: fee, executionFee: zeroFee(), settlementFee: zeroFee(), routeFee: zeroFee() } });
    const buyResult = build(ROUTER_MANDATE, buy, trustedCost(buy));
    assert.equal(buyResult.ok, true);
    if (buyResult.ok) assert.equal(buyResult.quality.economicValue.atoms, buy.notional.atoms + 10n);

    const sell = routeQuote({ side: 'SELL', costs: buy.costs });
    const sellResult = build(sellMandate(), sell, trustedCost(sell));
    assert.equal(sellResult.ok, true);
    if (sellResult.ok) assert.equal(sellResult.quality.economicValue.atoms, sell.notional.atoms - 10n);
  });

  it('rejects economic overflow and sell fees that consume proceeds', () => {
    const huge = { ...zeroFee(), atoms: UINT256_MAX };
    const buy = routeQuote({ costs: { venueFee: huge, executionFee: zeroFee(), settlementFee: zeroFee(), routeFee: zeroFee() } });
    const overflow = build(ROUTER_MANDATE, buy, trustedCost(buy));
    assert.equal(overflow.ok, false);
    if (!overflow.ok) assert.ok(overflow.exclusions.some((item) => item.code === 'COST_OVERFLOW'));

    // A SELL whose fees consume the whole notional still *builds*: it is the
    // kernel that refuses it, with FEES_EXCEED_NOTIONAL (ADR 0014). The router
    // establishes the fee total and ranks on it; it does not authorize.
    const proceeds = routeQuote({ side: 'SELL' });
    const fee = { ...zeroFee(), atoms: proceeds.notional.atoms };
    const expensive = { ...proceeds, costs: { venueFee: fee, executionFee: zeroFee(), settlementFee: zeroFee(), routeFee: zeroFee() } };
    const result = build(sellMandate(), expensive, trustedCost(expensive));
    assert.equal(result.ok, true, 'construction is not authorization');
    if (result.ok) {
      assert.equal(result.candidate.feeTotal.atoms, proceeds.notional.atoms);
      assert.equal(result.candidate.executionCandidate.feeTotal.atoms, proceeds.notional.atoms, 'the kernel sees the fee');
      assert.equal(result.quality.economicValue.atoms, 0n, 'a net debit ranks last rather than being refused here');
    }
  });

  it('hands the all-in BUY cost to the kernel rather than deciding it', () => {
    const quote = routeQuote();
    const remaining = ROUTER_MANDATE.maxNotional.atoms - quote.notional.atoms;
    const fee = { ...zeroFee(), atoms: remaining + 1n };
    const over = { ...quote, costs: { venueFee: fee, executionFee: zeroFee(), settlementFee: zeroFee(), routeFee: zeroFee() } };
    const result = build(ROUTER_MANDATE, over, trustedCost(over));
    assert.equal(result.ok, true, 'the router no longer carries an economic permission');
    if (result.ok) {
      assert.equal(result.candidate.executionCandidate.feeTotal.atoms, remaining + 1n);
      // And the candidate digest commits to it, so a Phase 6 gate can re-assert
      // the bound the kernel enforced.
      const cheaper = build(ROUTER_MANDATE, quote, trustedCost(quote));
      assert.ok(cheaper.ok);
      if (cheaper.ok) assert.notEqual(result.candidate.kernelCandidateDigest, cheaper.candidate.kernelCandidateDigest);
    }
  });
});

function build(mandate: typeof ROUTER_MANDATE, quote: ReturnType<typeof routeQuote>, cost: ReturnType<typeof trustedCost>) {
  return buildRoutingCandidate({ mandate, quote, trustedState: ROUTER_STATE, trustedCost: cost, requestedQuantity: ROUTER_REQUESTED_QUANTITY, nowUnixSeconds: ROUTER_CLOCK });
}

function identifier(value: string) {
  const parsed = parseIdentifier(value);
  if (!parsed.ok) throw new Error('invalid test identifier');
  return parsed.value;
}
