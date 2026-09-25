/**
 * The advisory receipt and its binding into the selection record.
 *
 * A receipt exists for every decision, including the ones where no call was
 * made. Attribution after the fact is the only reason the receipt exists, and
 * attribution needs the model identity, the exact set the advice was given
 * over, and what was actually handed off.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  JEV_INTEGRATION_VERSION,
  JevFallbackReason,
  jevDecisionReceiptDigest,
  jevSelectionReceiptDigest,
  selectWithJev,
} from '../src/index.ts';
import { abstainingTransport, choosingTransport, failingTransport } from '../src/testing/index.ts';
import { maliciousQuote, routeRequest, validRoutes, haltedState, ROUTER_CLOCK } from './support/world.ts';

async function decide(count: number, transport: Parameters<typeof selectWithJev>[0]['transport']) {
  return selectWithJev({ route: routeRequest(validRoutes(count)), transport });
}

describe('jev decision receipt', () => {
  it('is produced in every mode, including when no call was made', async () => {
    const cases = [
      [null, JevFallbackReason.JEV_DISABLED],
      [choosingTransport('route_001'), null],
      [abstainingTransport(), null],
      [failingTransport(JevFallbackReason.RATE_LIMITED), JevFallbackReason.RATE_LIMITED],
    ] as const;
    for (const [transport, reason] of cases) {
      const result = await decide(3, transport);
      assert.notEqual(result.jevReceipt, null);
      assert.equal(result.jevReceipt?.integrationVersion, JEV_INTEGRATION_VERSION);
      assert.equal(result.jevReceipt?.fallbackReason, reason);
      assert.equal(result.jevReceipt?.selectionMode, result.selectionMode);
    }
  });

  it('commits to the exact closed set the advice was given over', async () => {
    const result = await decide(4, choosingTransport('route_003'));
    const receipt = result.jevReceipt;
    assert.notEqual(receipt, null);
    if (receipt === null) return;
    assert.deepEqual([...receipt.candidateIds], ['route_000', 'route_001', 'route_002', 'route_003']);
    assert.equal(receipt.candidateDigests.length, 4);
    assert.equal(result.status, 'SELECTED');
    if (result.status !== 'SELECTED') return;
    assert.equal(receipt.candidateDigests[3], result.selected.candidateDigest);
  });

  it('records the requested name and the returned identifier separately', async () => {
    const result = await selectWithJev({
      route: routeRequest(validRoutes(3)),
      transport: choosingTransport('route_001', 0.9, { model: 'jev-1.13.0' }),
      policy: { model: 'jev-latest' },
    });
    assert.equal(result.jevReceipt?.modelRequested, 'jev-latest');
    assert.equal(result.jevReceipt?.modelReturned, 'jev-1.13.0');
  });

  it('reproduces its digest and changes it when any field changes', async () => {
    const result = await decide(3, choosingTransport('route_002', 0.42));
    const receipt = result.jevReceipt;
    assert.notEqual(receipt, null);
    if (receipt === null) return;
    const { receiptDigest, ...unsigned } = receipt;
    assert.equal(jevDecisionReceiptDigest(unsigned), receiptDigest);
    assert.notEqual(jevDecisionReceiptDigest({ ...unsigned, confidence: 0.43 }), receiptDigest);
    assert.notEqual(jevDecisionReceiptDigest({ ...unsigned, selectedChoice: 'route_001' }), receiptDigest);
    assert.notEqual(jevDecisionReceiptDigest({ ...unsigned, modelReturned: 'jev-1.14.0' }), receiptDigest);
    assert.notEqual(jevDecisionReceiptDigest({ ...unsigned, outcome: 'ABSTAIN' }), receiptDigest);
  });

  it('orders probabilities so the digest does not depend on response key order', async () => {
    const result = await decide(3, choosingTransport('route_001'));
    const names = result.jevReceipt?.probabilities.map(([name]) => name) ?? [];
    assert.deepEqual([...names], [...names].sort());
  });

  it('holds no credential and no free text from the response', async () => {
    const result = await decide(3, choosingTransport('route_001'));
    const serialized = JSON.stringify(result.jevReceipt, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
    assert.doesNotMatch(serialized, /Bearer|TYPESAFE_API_KEY|sk-|authorization/i);
    assert.equal(/explanation|reasoning|description|instructions/i.test(serialized), false);
  });

  it('records latency and usage as observed, never as a target', async () => {
    const result = await decide(3, choosingTransport('route_001', 0.9, { latencyMs: 37 }));
    assert.equal(result.jevReceipt?.latencyMs, 37);
    assert.equal(result.jevReceipt?.inputTokens, 256);
    assert.equal(result.jevReceipt?.outputTokens, 3);
  });

  it('leaves usage and latency null when no call was made', async () => {
    const result = await decide(3, null);
    assert.equal(result.jevReceipt?.latencyMs, null);
    assert.equal(result.jevReceipt?.inputTokens, null);
    assert.equal(result.jevReceipt?.outputTokens, null);
  });
});

describe('jev selection receipt', () => {
  it('binds the routing receipt, the advisory receipt and the handoff verification', async () => {
    const result = await decide(3, choosingTransport('route_002'));
    assert.equal(result.status, 'SELECTED');
    if (result.status !== 'SELECTED') return;
    const receipt = result.selectionReceipt;
    assert.notEqual(receipt, null);
    if (receipt === null) return;
    assert.equal(receipt.routingReceiptDigest, result.routing.status === 'SELECTED' ? result.routing.receipt.receiptDigest : null);
    assert.equal(receipt.jevReceiptDigest, result.jevReceipt?.receiptDigest);
    assert.equal(receipt.handoffVerificationReceiptDigest, result.handoffVerification.receiptDigest);
    assert.equal(receipt.handoffDecision, 'PASS');
    const { receiptDigest, ...unsigned } = receipt;
    assert.equal(jevSelectionReceiptDigest(unsigned), receiptDigest);
  });

  it('shows when a model changed the answer, and when it did not', async () => {
    const moved = await decide(3, choosingTransport('route_002'));
    assert.notEqual(moved.selectionReceipt?.selectedCandidateDigest, moved.selectionReceipt?.deterministicCandidateDigest);
    assert.equal(moved.selectionReceipt?.selectionMode, 'JEV_ASSISTED');

    const agreed = await decide(3, choosingTransport('route_000'));
    assert.equal(agreed.selectionReceipt?.selectedCandidateDigest, agreed.selectionReceipt?.deterministicCandidateDigest);

    const abstained = await decide(3, abstainingTransport());
    assert.equal(abstained.selectionReceipt?.selectedCandidateDigest, abstained.selectionReceipt?.deterministicCandidateDigest);
    assert.equal(abstained.selectionReceipt?.selectionMode, 'JEV_ABSTAINED');
  });

  it('records a refusal with no selected candidate and no handoff', async () => {
    const result = await selectWithJev({ route: routeRequest([maliciousQuote('route.attacker')]), transport: choosingTransport('route_000') });
    assert.equal(result.status, 'NO_VALID_ROUTE');
    assert.equal(result.selectionReceipt?.selectedCandidateDigest, null);
    assert.equal(result.selectionReceipt?.deterministicCandidateDigest, null);
    assert.equal(result.selectionReceipt?.handoffDecision, 'NONE');
    assert.equal(result.jevReceipt?.candidateIds.length, 0);
  });

  it('records a handoff rejection distinctly from an empty admissible set', async () => {
    const result = await selectWithJev({
      route: routeRequest(validRoutes(3)),
      transport: choosingTransport('route_002'),
      handoffState: { trustedMarketState: haltedState(), clock: { nowUnixSeconds: ROUTER_CLOCK } },
    });
    assert.equal(result.status, 'NO_VALID_ROUTE');
    if (result.status !== 'NO_VALID_ROUTE') return;
    assert.equal(result.handoffRejected, true);
    assert.equal(result.selectionReceipt?.handoffDecision, 'REJECT');
    // The routing stage still passed at t0; only the handoff check refused.
    assert.equal(result.routing.status, 'SELECTED');
  });
});
