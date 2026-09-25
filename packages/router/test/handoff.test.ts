/**
 * Execution-handoff re-verification: the discriminating tests.
 *
 * Phase 5R made the handoff read state supplied for the handoff rather than the
 * evaluation state, and pinned that with tests asserting `NO_VALID_ROUTE`. The
 * post-remediation audit found those assertions were not evidence (finding N-2):
 * candidate schema v2 required the candidate to commit to the digest of the whole
 * trusted state, so *every* handoff against fresh state failed with
 * `CANDIDATE_STATE_MISMATCH` — including a completely safe one. A test asserting
 * only "no route was selected" is satisfied by the accidental failure just as
 * well as by the intended one.
 *
 * So each case here names the predicate it is about and asserts the reason code
 * that predicate produces. Together with the first test — a fresh, safe world
 * that must *succeed* — they pin both directions:
 *
 * - fresh dynamic state that still satisfies every predicate hands off;
 * - fresh dynamic state carrying a material change refuses, for that change;
 * - structural change refuses as a routing-level "reroute" rather than as one
 *   rejected candidate.
 *
 * The handoff reason code lives on `finalVerificationReceipt`, which
 * `NO_VALID_ROUTE` carries precisely so a caller can tell "nothing was
 * admissible" from "the winner stopped being admissible". Asserting on it is
 * what makes these tests discriminating.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Decision, type ReasonCodeName } from '@mandate/kernel';
import { openRegistry } from '@mandate/registry';
import { route, type RoutingResult } from '../src/index.ts';
import {
  ROUTER_AUTHORIZATION,
  ROUTER_CLOCK,
  ROUTER_DOMAIN,
  ROUTER_MANDATE,
  ROUTER_REGISTRY_INPUT,
  ROUTER_REQUESTED_QUANTITY,
  ROUTER_STATE,
  haltedRouterState,
  pausedRepresentationState,
  refreshedRouterState,
  routeQuote,
  routerHandoff,
  stateWithEpoch,
  stateWithForeignRegistrySnapshot,
  stateWithReference,
  stateWithoutRegistrySnapshot,
  trustedCost,
} from './support/fixture.ts';

const opened = openRegistry(ROUTER_REGISTRY_INPUT);
if (!opened.ok) throw new Error('handoff registry did not open');
const REGISTRY = opened.value;

function request(overrides: Record<string, unknown> = {}) {
  const quote = routeQuote({ routeId: 'route.one' });
  return {
    mandate: ROUTER_MANDATE,
    authorization: ROUTER_AUTHORIZATION,
    registry: REGISTRY,
    trustedMarketState: ROUTER_STATE,
    requestedQuantity: ROUTER_REQUESTED_QUANTITY,
    routes: [quote],
    trustedCosts: [trustedCost(quote)],
    clock: { nowUnixSeconds: ROUTER_CLOCK },
    expectedDomain: ROUTER_DOMAIN,
    ...overrides,
  };
}

/** The reason codes the handoff re-verification itself produced. */
function handoffRejection(result: RoutingResult): readonly ReasonCodeName[] {
  assert.equal(result.status, 'NO_VALID_ROUTE', `expected a handoff refusal, got ${result.status}`);
  if (result.status !== 'NO_VALID_ROUTE') return [];
  const receipt = result.finalVerificationReceipt;
  assert.ok(receipt !== null, 'a handoff refusal must carry the re-verification receipt it refused on');
  assert.equal(receipt.decision, Decision.REJECT);
  // And the route that was ranked first is the one recorded as having failed the
  // re-verification, rather than having been excluded at evaluation.
  const failed = result.receipt.outcomes.find((outcome) =>
    outcome.status === 'EXCLUDED' && outcome.exclusions.some((item) => item.code === 'FINAL_REVERIFICATION_FAILED'));
  assert.ok(failed, 'the winner must be recorded as failing at handoff, not at evaluation');
  assert.equal(result.receipt.selectedCandidateDigest, null);
  return receipt.reasonCodes;
}

/** The routing-level errors, for refusals that happen before any candidate is re-verified. */
function routingErrors(result: RoutingResult): readonly { readonly code: string; readonly detail: Readonly<Record<string, string>> }[] {
  assert.equal(result.status, 'INVALID_INPUT', `expected a routing refusal, got ${result.status}`);
  return result.status === 'INVALID_INPUT' ? result.errors : [];
}

describe('execution handoff against fresh trusted state', () => {
  it('N-2: a handoff whose only change is a newer observation succeeds', () => {
    // The evaluation world, for comparison: it selects.
    const baseline = route(request(), routerHandoff());
    assert.equal(baseline.status, 'SELECTED');

    // The same world re-observed five seconds later. Every value identical, every
    // observation timestamp newer, a different snapshot label, and the handoff
    // clock advanced by the same five seconds — so every age bound is exactly as
    // satisfied as it was at evaluation.
    const refreshed = refreshedRouterState(5n);
    const result = route(
      request(),
      routerHandoff({ trustedMarketState: refreshed, clock: { nowUnixSeconds: ROUTER_CLOCK + 5n } }),
    );

    assert.equal(
      result.status,
      'SELECTED',
      result.status === 'NO_VALID_ROUTE'
        ? `a safe refresh must hand off: ${result.finalVerificationReceipt?.reasonCodes.join(', ') ?? 'no receipt'}`
        : `a safe refresh must hand off, got ${result.status}`,
    );
    if (result.status !== 'SELECTED') return;

    // It really was different state, and the receipt records both worlds: the
    // evaluation digest and the handoff digest are separate commitments.
    assert.notEqual(result.receipt.handoffStateDigest, result.receipt.marketStateDigest);
    assert.equal(result.receipt.handoffAtUnixSeconds, ROUTER_CLOCK + 5n);
    assert.equal(result.finalVerificationReceipt.decision, Decision.PASS);
    // And the candidate handed off is the one that was evaluated, unchanged.
    assert.equal(result.selected.candidateDigest, result.receipt.selectedCandidateDigest);
  });

  it('N-2: a halt introduced after evaluation refuses for the halt', () => {
    const codes = handoffRejection(route(request(), routerHandoff({ trustedMarketState: haltedRouterState() })));
    assert.ok(codes.includes('TRADING_HALTED'), codes.join(', '));
  });

  it('N-2: a representation going inactive after evaluation refuses for the representation', () => {
    const codes = handoffRejection(route(request(), routerHandoff({ trustedMarketState: pausedRepresentationState() })));
    assert.ok(codes.includes('REPRESENTATION_INACTIVE'), codes.join(', '));
  });

  it('N-2: a reference price moving outside the mandate bound refuses for the deviation', () => {
    if (ROUTER_STATE.market?.value.referencePrice === null || ROUTER_STATE.market === null) {
      throw new Error('fixture has no reference price');
    }
    const reference = ROUTER_STATE.market.value.referencePrice.atoms;
    // Inside the bound the handoff still succeeds, which is the other half of the
    // property: the price is allowed to move, just not past the signed bound.
    const inside = reference + reference * ROUTER_MANDATE.maxDeviationBps / 20_000n;
    assert.equal(route(request(), routerHandoff({ trustedMarketState: stateWithReference(inside) })).status, 'SELECTED');

    // Far outside it refuses, and names the deviation.
    const outside = reference * 2n;
    const codes = handoffRejection(route(request(), routerHandoff({ trustedMarketState: stateWithReference(outside) })));
    assert.ok(codes.includes('PRICE_DEVIATION_EXCEEDED'), codes.join(', '));
  });

  it('N-2: a corporate-action epoch change refuses for the corporate action', () => {
    const epoch = ROUTER_STATE.corporateAction?.value.epoch;
    assert.ok(epoch !== null && epoch !== undefined, 'fixture has no epoch');

    const advanced = handoffRejection(route(request(), routerHandoff({ trustedMarketState: stateWithEpoch(epoch + 1n) })));
    assert.ok(advanced.includes('CORPORATE_ACTION_STATE_CHANGED'), advanced.join(', '));

    // An epoch running *behind* the authorization is a different fault and has
    // its own code, so the two are not collapsed.
    const behind = handoffRejection(route(request(), routerHandoff({ trustedMarketState: stateWithEpoch(epoch - 1n) })));
    assert.ok(behind.includes('CORPORATE_ACTION_STATE_INCONSISTENT'), behind.join(', '));
  });

  it('N-2: a price observation that has gone stale by handoff refuses for staleness', () => {
    // The evaluation state, unchanged, read at an instant past its freshness
    // bound. Nothing about the world moved; time did.
    const codes = handoffRejection(route(
      request(),
      routerHandoff({ clock: { nowUnixSeconds: ROUTER_CLOCK + ROUTER_MANDATE.maxPriceAgeSeconds + 1n } }),
    ));
    assert.ok(codes.includes('PRICE_STATE_STALE'), codes.join(', '));
  });

  it('N-2: a mandate that expires between evaluation and handoff refuses for expiry', () => {
    const codes = handoffRejection(route(
      request(),
      routerHandoff({ clock: { nowUnixSeconds: ROUTER_MANDATE.expiresAtUnixSeconds } }),
    ));
    assert.ok(codes.includes('MANDATE_EXPIRED'), codes.join(', '));
  });

  it('N-2: an authorization consumed between evaluation and handoff refuses for replay', () => {
    if (ROUTER_STATE.replay === null) throw new Error('fixture has no replay state');
    const consumed = {
      ...ROUTER_STATE,
      replay: { ...ROUTER_STATE.replay, value: { ...ROUTER_STATE.replay.value, status: 'CONSUMED' as const } },
    };
    const codes = handoffRejection(route(request(), routerHandoff({ trustedMarketState: consumed })));
    assert.ok(codes.includes('MANDATE_ALREADY_CONSUMED'), codes.join(', '));
  });

  it('N-2 / N-8: a registry snapshot change at handoff refuses explicitly and demands rerouting', () => {
    // Structural, not dynamic: the admissible set was computed against one
    // snapshot, so a different one invalidates the ranking rather than one
    // candidate. It is therefore a routing refusal, not a candidate rejection.
    const errors = routingErrors(route(request(), routerHandoff({ trustedMarketState: stateWithForeignRegistrySnapshot() })));
    const mismatch = errors.find((item) => item.code === 'REGISTRY_SNAPSHOT_MISMATCH');
    assert.ok(mismatch, errors.map((item) => item.code).join(', '));
    assert.equal(mismatch.detail['input'], 'handoff.trustedMarketState');

    // And a handoff state that declares no snapshot cannot establish the binding,
    // so it fails closed rather than being accepted as agreement.
    const undeclared = routingErrors(route(request(), routerHandoff({ trustedMarketState: stateWithoutRegistrySnapshot() })));
    assert.ok(undeclared.some((item) => item.code === 'REGISTRY_SNAPSHOT_UNKNOWN'), undeclared.map((item) => item.code).join(', '));
  });

  it('N-2: a handoff instant earlier than the evaluation instant refuses for time regression', () => {
    const errors = routingErrors(route(request(), routerHandoff({ clock: { nowUnixSeconds: ROUTER_CLOCK - 1n } })));
    const regressed = errors.find((item) => item.code === 'HANDOFF_TIME_REGRESSED');
    assert.ok(regressed, errors.map((item) => item.code).join(', '));
    assert.equal(regressed.detail['evaluatedAt'], String(ROUTER_CLOCK));
    assert.equal(regressed.detail['handoffAt'], String(ROUTER_CLOCK - 1n));
  });

  it('N-1: the evaluation state digest is not a handoff predicate, and both worlds are committed', () => {
    // Two handoffs of one evaluation: the same world, and a refreshed world. Both
    // succeed, and the receipts differ — so the handoff state is committed and is
    // not required to be the evaluation state.
    const same = route(request(), routerHandoff());
    const fresh = route(request(), routerHandoff({
      trustedMarketState: refreshedRouterState(3n),
      clock: { nowUnixSeconds: ROUTER_CLOCK + 3n },
    }));
    assert.equal(same.status, 'SELECTED');
    assert.equal(fresh.status, 'SELECTED');
    if (same.status !== 'SELECTED' || fresh.status !== 'SELECTED') return;

    // One evaluation, so one candidate: the commitment the kernel checks did not
    // change, because the registry did not change.
    assert.equal(same.selected.candidateDigest, fresh.selected.candidateDigest);
    assert.equal(
      same.selected.executionCandidate.registrySnapshotDigest,
      fresh.selected.executionCandidate.registrySnapshotDigest,
    );
    // Two different handoff worlds, so two different receipts. Neither world can
    // be substituted for the other after the fact.
    assert.notEqual(same.receipt.handoffStateDigest, fresh.receipt.handoffStateDigest);
    assert.notEqual(same.receipt.receiptDigest, fresh.receipt.receiptDigest);
    assert.notEqual(same.finalVerificationReceipt.receiptDigest, fresh.finalVerificationReceipt.receiptDigest);
    // And the evaluation half of the receipt is identical across both, since it
    // is the same evaluation.
    assert.equal(same.receipt.marketStateDigest, fresh.receipt.marketStateDigest);
  });
});
