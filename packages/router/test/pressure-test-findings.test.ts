/**
 * Executable evidence for the production architecture pressure test.
 *
 * **These tests pin defects, not desired behaviour.** See
 * [docs/production-architecture-pressure-test.md](../../../docs/production-architecture-pressure-test.md).
 * When a finding is remediated the corresponding test here fails and must be
 * inverted deliberately.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decision, parseTrustedState, verify } from '@mandate/kernel';
import { buildRoutingCandidate } from '../src/candidate.ts';
import { evaluateRoutes, route, selectEvaluated } from '../src/router.ts';
import { openRegistry } from '@mandate/registry';
import {
  ROUTER_AUTHORIZATION,
  ROUTER_CLOCK,
  ROUTER_DOMAIN,
  ROUTER_MANDATE,
  ROUTER_REGISTRY_INPUT,
  ROUTER_REQUESTED_QUANTITY,
  ROUTER_STATE,
  routeQuote,
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

// --- F-2 (HIGH): the all-in cost bound sits outside the authoritative layer --

/**
 * `ExecutionCandidate` carries no fee field and `encodeCandidate` commits to
 * none, so the kernel's `maxNotional` check bounds the notional alone. The
 * all-in bound is `TOTAL_COST_EXCEEDS_MANDATE`, which lives in the router. The
 * component described as the only one that authorizes cannot see the fees, and
 * neither can anything reconstructed from `candidateDigest`.
 */
test('F-2 (HIGH): the kernel passes a route whose fees exceed the mandate cap', () => {
  const quote = routeQuote({
    costs: { venueFee: fee(ROUTER_MANDATE.maxNotional.atoms), executionFee: zeroFee(), settlementFee: zeroFee(), routeFee: zeroFee() },
  });

  const kernelVerdict = verify({
    mandate: ROUTER_MANDATE,
    authorization: ROUTER_AUTHORIZATION,
    candidate: {
      version: 1,
      representationId: quote.representationId,
      canonicalAsset: quote.canonicalAsset,
      issuer: quote.issuer,
      chain: quote.chain,
      venue: quote.venue,
      side: quote.side,
      agent: quote.agent,
      quantity: quote.quantity,
      executionPrice: quote.executionPrice,
      notional: quote.notional,
      referenceStateId: quote.referenceStateId,
      corporateActionEpoch: quote.corporateActionEpoch,
    },
    trustedState: ROUTER_STATE,
    clock: { nowUnixSeconds: ROUTER_CLOCK },
    expectedDomain: ROUTER_DOMAIN,
  });
  assert.equal(kernelVerdict.decision, Decision.PASS, 'the verifier never sees the fee');

  const routerVerdict = buildRoutingCandidate({
    mandate: ROUTER_MANDATE,
    quote,
    trustedState: ROUTER_STATE,
    trustedCost: trustedCost(quote),
    requestedQuantity: ROUTER_REQUESTED_QUANTITY,
    nowUnixSeconds: ROUTER_CLOCK,
  });
  assert.equal(routerVerdict.ok, false, 'only the router catches it');
  assert.ok(!routerVerdict.ok);
  assert.ok(routerVerdict.exclusions.some((item) => item.code === 'TOTAL_COST_EXCEEDS_MANDATE'));
});

// --- F-4 (HIGH): a SELL mandate cannot bound its own proceeds ----------------

/**
 * `SELL_FEES_EXCEED_PROCEEDS` triggers only when fees reach the whole notional.
 * There is no mandate field for a minimum proceed or a maximum fee, so a sale
 * that nets one atom is admissible: technically valid, economically ruinous.
 */
test('F-4 (HIGH): a SELL netting one atom of proceeds is admissible', () => {
  const baseline = routeQuote();
  const proceeds = baseline.notional.atoms;
  const quote = routeQuote({
    side: 'SELL',
    costs: { venueFee: fee(proceeds - 1n), executionFee: zeroFee(), settlementFee: zeroFee(), routeFee: zeroFee() },
  });
  const built = buildRoutingCandidate({
    mandate: { ...ROUTER_MANDATE, side: 'SELL' },
    quote,
    trustedState: ROUTER_STATE,
    trustedCost: trustedCost(quote),
    requestedQuantity: ROUTER_REQUESTED_QUANTITY,
    nowUnixSeconds: ROUTER_CLOCK,
  });
  assert.ok(built.ok, 'no bound refuses it');
  assert.equal(built.quality.economicValue.atoms, 1n);
});

// --- F-5 (HIGH): the final re-verification reads the evaluation-time state ---

/**
 * `selectEvaluated` re-verifies against `context.trustedState` and
 * `context.clock` — the very objects `evaluateRoutes` decided over. The check is
 * therefore a tautology for a deterministic verifier, and `route()` exposes no
 * parameter through which a later state could be supplied, so
 * `FINAL_REVERIFICATION_FAILED` is unreachable on the deterministic path.
 */
test('F-5 (HIGH): every verifier call in route() sees one identical trusted state', () => {
  const seen: unknown[] = [];
  const spy = (input: Parameters<typeof verify>[0]) => {
    seen.push(input.trustedState);
    return verify(input);
  };
  const result = route(request([routeQuote({ routeId: 'route.one' }), routeQuote({ routeId: 'route.two' })]), spy);
  assert.equal(result.status, 'SELECTED');
  assert.ok(seen.length >= 2, 'evaluation and the final re-verification both ran');
  assert.ok(seen.every((state) => state === seen[0]), 'the re-verification cannot observe a later state');
});

test('F-5 (HIGH): a halt arriving after evaluation cannot reach selectEvaluated', () => {
  const evaluated = evaluateRoutes(request([routeQuote({ routeId: 'route.one' }), routeQuote({ routeId: 'route.two' })]));
  assert.ok(evaluated.status === 'EVALUATED');

  // Trading halts between closing the set and handing off. `selectEvaluated`
  // takes only the evaluation, an index and a verifier, so there is no
  // parameter through which the halt could be supplied, and it selects anyway.
  assert.equal(selectEvaluated(evaluated.evaluation, 0).status, 'SELECTED');

  // The same candidate against the halted state is a REJECT, which is what the
  // re-verification would have caught had it been able to see it.
  const market = ROUTER_STATE.market;
  assert.ok(market !== null);
  const halted = { ...ROUTER_STATE, market: { ...market, value: { ...market.value, haltStatus: 'HALTED' as const } } };
  const selected = evaluated.evaluation.admissible[0];
  assert.ok(selected !== undefined);
  const wouldReject = verify({
    mandate: ROUTER_MANDATE,
    authorization: ROUTER_AUTHORIZATION,
    candidate: selected.candidate.executionCandidate,
    trustedState: halted,
    clock: { nowUnixSeconds: ROUTER_CLOCK },
    expectedDomain: ROUTER_DOMAIN,
  });
  assert.equal(wouldReject.decision, Decision.REJECT);
  assert.ok(wouldReject.reasonCodes.includes('TRADING_HALTED'));
});

// --- F-3 (HIGH): the u16 defect propagates into route() ----------------------

/**
 * `route()` documents `INVALID_INPUT` for unusable input. An oversized
 * representation collection escapes as a throw instead, from
 * `trustedStateDigest` inside `finishReceipt`.
 */
test('F-3 (HIGH): route() throws rather than returning INVALID_INPUT on an oversized state', () => {
  const base = ROUTER_STATE.representations[0];
  assert.ok(base !== undefined);
  const representations: unknown[] = [{ provenance: { ...base.provenance }, value: { ...base.value } }];
  for (let index = 1; index < 65_536; index += 1) {
    representations.push({
      provenance: { ...base.provenance },
      value: { ...base.value, representationId: `eip155:4663/erc20:0x${index.toString(16).padStart(40, '0')}` },
    });
  }
  const inflated = {
    version: 1,
    stateId: ROUTER_STATE.stateId,
    representations,
    market: ROUTER_STATE.market,
    corporateAction: ROUTER_STATE.corporateAction,
    replay: ROUTER_STATE.replay,
  };
  assert.equal(parseTrustedState(inflated).ok, true, 'the kernel parser accepts it');
  assert.throws(
    () => route(request([routeQuote()], { trustedMarketState: inflated })),
    /exceeds 2-byte unsigned field/,
  );
});
