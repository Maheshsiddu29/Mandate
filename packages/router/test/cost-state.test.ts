/**
 * The independently established cost state: bounds and validation order.
 *
 * Two post-remediation audit findings live here.
 *
 * **N-9.** `trustedCosts` was the one externally sized collection in the system
 * with no bound. Every other one — the route set, the trusted-state
 * representation list, every counted registry collection — is bounded at its
 * parser and refuses oversize input with a typed reason code, because an
 * unbounded parse is work an untrusted caller can ask for without limit. The
 * bound is `MAX_TRUSTED_ROUTE_COSTS`, defined as `MAX_ROUTE_CANDIDATES` rather
 * than picked: one cost entry per route quote, duplicate route ids refused, and
 * the route set itself bounded at that number, so a larger cost set cannot
 * describe a meaningful request.
 *
 * **N-10.** `validateCosts` checked unit and scale inside a loop that began with
 * `if (established === null) continue`, a branch `knownCosts` had already made
 * unreachable. The check was in fact reachable, but reading the code could not
 * establish that, and "is this security check dead?" is not a question a reader
 * should have to resolve by reasoning about a type guard three lines up. It is now
 * an explicit pass that returns before any atoms are summed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAmount, type Amount } from '@mandate/kernel';
import { MAX_ROUTE_CANDIDATES, MAX_TRUSTED_ROUTE_COSTS, buildRoutingCandidate, parseTrustedRouteCosts } from '../src/index.ts';
import {
  ROUTER_CLOCK,
  ROUTER_MANDATE,
  ROUTER_REGISTRY_SNAPSHOT_DIGEST,
  ROUTER_REQUESTED_QUANTITY,
  ROUTER_STATE,
  routeQuote,
  trustedCost,
  zeroFee,
} from './support/fixture.ts';

/** A parsed amount, so a test can name a unit the notional does not use. */
function amount(unit: string, decimals: number, atoms: bigint): Amount {
  const parsed = parseAmount({ unit, decimals, atoms });
  if (!parsed.ok) throw new Error(`invalid test amount: ${parsed.error}`);
  return parsed.value;
}

function rawCost(index: number): Record<string, unknown> {
  return {
    routeId: `route.${String(index).padStart(4, '0')}`,
    costs: { venueFee: zeroFee(), executionFee: zeroFee(), settlementFee: zeroFee(), routeFee: zeroFee() },
    provenanceSourceId: 'trusted.fixture.costs',
    observedAtUnixSeconds: ROUTER_CLOCK,
  };
}

function costSetOfSize(count: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let index = 0; index < count; index += 1) out.push(rawCost(index));
  return out;
}

function build(quote: ReturnType<typeof routeQuote>, cost: ReturnType<typeof trustedCost>) {
  return buildRoutingCandidate({
    mandate: ROUTER_MANDATE,
    quote,
    trustedState: ROUTER_STATE,
    trustedCost: cost,
    requestedQuantity: ROUTER_REQUESTED_QUANTITY,
    nowUnixSeconds: ROUTER_CLOCK,
    registrySnapshotDigest: ROUTER_REGISTRY_SNAPSHOT_DIGEST,
  });
}

describe('trusted cost-state bounds', () => {
  it('N-9: the bound is the route bound, so the two cannot drift apart', () => {
    assert.equal(MAX_TRUSTED_ROUTE_COSTS, MAX_ROUTE_CANDIDATES);
  });

  it('N-9: below, at and above the bound', () => {
    const below = parseTrustedRouteCosts(costSetOfSize(MAX_TRUSTED_ROUTE_COSTS - 1));
    assert.equal(below.ok, true, 'one under the bound is accepted');
    if (below.ok) assert.equal(below.value.size, MAX_TRUSTED_ROUTE_COSTS - 1);

    const at = parseTrustedRouteCosts(costSetOfSize(MAX_TRUSTED_ROUTE_COSTS));
    assert.equal(at.ok, true, 'exactly at the bound is accepted');
    if (at.ok) assert.equal(at.value.size, MAX_TRUSTED_ROUTE_COSTS);

    const above = parseTrustedRouteCosts(costSetOfSize(MAX_TRUSTED_ROUTE_COSTS + 1));
    assert.equal(above.ok, false, 'one over the bound is refused');
    if (!above.ok) {
      assert.equal(above.error.code, 'RESOURCE_LIMIT_EXCEEDED', 'a typed resource-limit refusal, not a parse error');
      assert.equal(above.error.detail['input'], 'trustedCosts');
      assert.equal(above.error.detail['limit'], String(MAX_TRUSTED_ROUTE_COSTS));
      assert.equal(above.error.detail['observed'], String(MAX_TRUSTED_ROUTE_COSTS + 1));
    }
  });

  it('N-9: the bound is applied before any entry is parsed', () => {
    // Every entry past the first is malformed. If the bound were applied after
    // iteration this would report a parse failure for entry 1; it reports the
    // limit, which is what proves the refusal is not work already performed.
    const oversized: unknown[] = [rawCost(0)];
    for (let index = 1; index <= MAX_TRUSTED_ROUTE_COSTS; index += 1) oversized.push({ nonsense: index });
    const result = parseTrustedRouteCosts(oversized);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'RESOURCE_LIMIT_EXCEEDED');
  });

  it('N-9: a non-array cost input is refused without a size check', () => {
    for (const raw of [null, undefined, 'costs', 0, {}, { length: 1 }]) {
      const result = parseTrustedRouteCosts(raw);
      assert.equal(result.ok, false, String(raw));
      if (!result.ok) assert.equal(result.error.code, 'INPUT_INVALID', String(raw));
    }
  });
});

describe('cost commensurability precedes summation', () => {
  it('N-10: costs in a unit the notional does not use cannot be numerically added', () => {
    const quote = routeQuote();
    const foreign = amount('EUR', 2, 700n);
    // Both the quote *and* the independently established cost state agree on the
    // foreign unit, so there is no disagreement to hide behind: the only thing
    // wrong is that EUR atoms and USD atoms are not addable. Before N-10 the
    // reachability of this check could not be established by reading the code.
    const mismatched = routeQuote({ costs: { ...quote.costs, venueFee: foreign } });
    const result = build(mismatched, trustedCost(mismatched));

    assert.equal(result.ok, false, 'incommensurable costs must not produce a candidate');
    if (result.ok) return;
    const codes = result.exclusions.map((item) => item.code);
    assert.ok(codes.includes('COST_UNIT_MISMATCH'), codes.join(', '));
    // Specifically not reported as a disagreement with cost state, and not as an
    // overflow from having added the atoms anyway.
    assert.ok(!codes.includes('UNTRUSTED_COST_MISMATCH'), codes.join(', '));
    assert.ok(!codes.includes('COST_OVERFLOW'), codes.join(', '));
    const mismatch = result.exclusions.find((item) => item.code === 'COST_UNIT_MISMATCH');
    assert.equal(mismatch?.detail['component'], 'venueFee');
  });

  it('N-10: a cost at a different decimal scale is incommensurable too', () => {
    // Same unit, different scale. 700 atoms at 6 decimals is 0.0007 USD, not 7.00,
    // so adding the atom counts would overstate the fee by a factor of 10 000. The
    // check is on unit *and* scale for exactly this reason.
    const quote = routeQuote();
    const rescaled = amount(quote.notional.unit, 6, 700n);
    const mismatched = routeQuote({ costs: { ...quote.costs, settlementFee: rescaled } });
    const result = build(mismatched, trustedCost(mismatched));
    assert.equal(result.ok, false);
    if (result.ok) return;
    const mismatch = result.exclusions.find((item) => item.code === 'COST_UNIT_MISMATCH');
    assert.ok(mismatch, result.exclusions.map((item) => item.code).join(', '));
    assert.equal(mismatch.detail['component'], 'settlementFee');
  });

  it('N-10: an incommensurable cost on the trusted side alone is also refused', () => {
    // The provider quotes correctly and the independently established cost state
    // is the one denominated wrongly. Both sides are checked, because either one
    // reaching the summation would be the same defect.
    const quote = routeQuote();
    const trusted = trustedCost(quote, {
      costs: { ...quote.costs, routeFee: amount('EUR', 2, 0n) },
    });
    const result = build(quote, trusted);
    assert.equal(result.ok, false);
    if (result.ok) return;
    const mismatch = result.exclusions.find((item) => item.code === 'COST_UNIT_MISMATCH');
    assert.ok(mismatch, result.exclusions.map((item) => item.code).join(', '));
    assert.equal(mismatch.detail['source'], 'trusted');
  });

  it('N-10: commensurable costs that disagree with cost state are a disagreement, not a unit fault', () => {
    // The ordering is observable: with units sound, the *second* pass decides, and
    // it reports the right thing.
    const quote = routeQuote();
    const trusted = trustedCost(quote, { costs: { ...quote.costs, routeFee: { ...zeroFee(), atoms: 1n } } });
    const result = build(quote, trusted);
    assert.equal(result.ok, false);
    if (result.ok) return;
    const codes = result.exclusions.map((item) => item.code);
    assert.ok(codes.includes('UNTRUSTED_COST_MISMATCH'), codes.join(', '));
    assert.ok(!codes.includes('COST_UNIT_MISMATCH'), codes.join(', '));
  });

  it('N-10: commensurable, agreeing costs sum exactly', () => {
    const quote = routeQuote({
      costs: {
        venueFee: { ...zeroFee(), atoms: 11n },
        executionFee: { ...zeroFee(), atoms: 22n },
        settlementFee: { ...zeroFee(), atoms: 33n },
        routeFee: { ...zeroFee(), atoms: 44n },
      },
    });
    const result = build(quote, trustedCost(quote));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.candidate.feeTotal.atoms, 110n);
    assert.equal(result.candidate.feeTotal.unit, quote.notional.unit);
    assert.equal(result.candidate.feeTotal.decimals, quote.notional.decimals);
    // And the kernel reads the same total from the candidate, so there is one
    // number, committed once.
    assert.equal(result.candidate.executionCandidate.feeTotal.atoms, 110n);
  });
});
