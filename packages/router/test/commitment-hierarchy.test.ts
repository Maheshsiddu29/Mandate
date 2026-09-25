/**
 * The commitment hierarchy, end to end.
 *
 * ```
 *   signed mandate digest              EIP-712 over keccak256(MCE(mandate))
 *     └─ candidate digest              every execution field, plus
 *        │                             evaluationStateDigest (audit) and
 *        │                             registrySnapshotDigest (enforced)
 *        └─ routing candidate digest   the kernel candidate digest, plus route
 *           │                          identity, the reference observation, the
 *           │                          trusted cost source and the fee total
 *           └─ routing receipt digest  mandate, registry snapshot, *evaluation*
 *                                      state, every outcome, the ranking, the
 *                                      selected candidate, the *handoff* state
 *                                      and instant, and the final
 *                                      re-verification receipt digest
 * ```
 *
 * Phase 5R.1 changed the middle of that chain (ADR 0017), so the audit asked for
 * the whole of it to be stated and tested rather than inferred from the encoders.
 * The property under test is the one the change has to preserve: **no
 * security-relevant execution field escapes commitment**, while fresh dynamic
 * state is revalidated instead of being required to stay byte-identical.
 *
 * The kernel half — candidate field coverage, and the difference between a field
 * committed for audit and one committed for enforcement — is in
 * `kernel/test/commitment.test.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { candidateDigest as kernelCandidateDigest, mandateDigest, trustedStateDigest, verify } from '@mandate/kernel';
import { openRegistry, registrySnapshotDigest } from '@mandate/registry';
import { route } from '../src/index.ts';
import {
  ROUTER_AUTHORIZATION,
  ROUTER_CLOCK,
  ROUTER_DOMAIN,
  ROUTER_MANDATE,
  ROUTER_REGISTRY_INPUT,
  ROUTER_REGISTRY_SNAPSHOT_DIGEST,
  ROUTER_REQUESTED_QUANTITY,
  ROUTER_STATE,
  refreshedRouterState,
  routeQuote,
  routerHandoff,
  trustedCost,
} from './support/fixture.ts';

const opened = openRegistry(ROUTER_REGISTRY_INPUT);
if (!opened.ok) throw new Error('commitment registry did not open');
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

describe('the commitment hierarchy', () => {
  it('links the signed mandate to the handoff receipt with no unbound step', () => {
    const handoffState = refreshedRouterState(4n);
    const result = route(request(), routerHandoff({
      trustedMarketState: handoffState,
      clock: { nowUnixSeconds: ROUTER_CLOCK + 4n },
    }));
    assert.equal(result.status, 'SELECTED');
    if (result.status !== 'SELECTED') return;
    const { selected, receipt, finalVerificationReceipt } = result;

    // 1. The signed mandate. The routing receipt names it, and so does the
    //    verification receipt, so a receipt cannot be moved to another mandate.
    assert.equal(receipt.mandateDigest, mandateDigest(ROUTER_MANDATE));
    assert.equal(finalVerificationReceipt.mandateDigest, mandateDigest(ROUTER_MANDATE));

    // 2. The execution candidate. The router's own digest is built over the kernel
    //    candidate digest, so the two cannot drift.
    assert.equal(selected.kernelCandidateDigest, kernelCandidateDigest(selected.executionCandidate));
    assert.equal(finalVerificationReceipt.candidateDigest, selected.kernelCandidateDigest);
    assert.equal(receipt.selectedCandidateDigest, selected.candidateDigest);
    assert.ok(receipt.rankedCandidateDigests.includes(selected.candidateDigest));

    // 3. Evaluation-state provenance: committed on the candidate, and the same
    //    digest the routing receipt records as the evaluation world.
    assert.equal(selected.executionCandidate.evaluationStateDigest, trustedStateDigest(ROUTER_STATE));
    assert.equal(receipt.marketStateDigest, trustedStateDigest(ROUTER_STATE));
    assert.equal(selected.executionCandidate.evaluationStateId, ROUTER_STATE.stateId);

    // 4. Structural authority: the candidate's registry snapshot is the snapshot
    //    the router evaluated, and the receipt records the same one.
    assert.equal(selected.executionCandidate.registrySnapshotDigest, ROUTER_REGISTRY_SNAPSHOT_DIGEST);
    assert.equal(receipt.registrySnapshotDigest, registrySnapshotDigest(REGISTRY.snapshot));
    assert.equal(selected.executionCandidate.registrySnapshotDigest, receipt.registrySnapshotDigest);

    // 5. The fresh handoff world: a separate commitment, not a repeat of the
    //    evaluation one, and the instant it was read at.
    assert.equal(receipt.handoffStateDigest, trustedStateDigest(handoffState));
    assert.notEqual(receipt.handoffStateDigest, receipt.marketStateDigest);
    assert.equal(receipt.handoffAtUnixSeconds, ROUTER_CLOCK + 4n);
    assert.equal(finalVerificationReceipt.trustedStateDigest, trustedStateDigest(handoffState));
    assert.equal(finalVerificationReceipt.evaluatedAtUnixSeconds, ROUTER_CLOCK + 4n);

    // 6. The receipt that authorized the handoff is itself committed, so the
    //    routing receipt is not merely correlated with a verdict — it names it.
    assert.equal(receipt.finalVerificationReceiptDigest, finalVerificationReceipt.receiptDigest);

    // And the whole chain is reproducible: re-verifying the committed candidate
    // against the committed handoff world reproduces the committed receipt digest.
    const replayed = verify({
      mandate: ROUTER_MANDATE,
      authorization: ROUTER_AUTHORIZATION,
      candidate: selected.executionCandidate,
      trustedState: handoffState,
      clock: { nowUnixSeconds: ROUTER_CLOCK + 4n },
      expectedDomain: ROUTER_DOMAIN,
    });
    assert.equal(replayed.receiptDigest, finalVerificationReceipt.receiptDigest);
  });

  it('a different handoff world produces a different receipt, for one unchanged candidate', () => {
    // The distinguishing property of the layered commitment: the candidate is
    // identical across both runs — it commits to the registry and to its own
    // provenance, neither of which moved — while the receipt is not, because the
    // world the handoff read is committed separately.
    const first = route(request(), routerHandoff());
    const second = route(request(), routerHandoff({
      trustedMarketState: refreshedRouterState(7n),
      clock: { nowUnixSeconds: ROUTER_CLOCK + 7n },
    }));
    assert.equal(first.status, 'SELECTED');
    assert.equal(second.status, 'SELECTED');
    if (first.status !== 'SELECTED' || second.status !== 'SELECTED') return;

    assert.equal(first.selected.candidateDigest, second.selected.candidateDigest);
    assert.notEqual(first.receipt.handoffStateDigest, second.receipt.handoffStateDigest);
    assert.notEqual(first.receipt.finalVerificationReceiptDigest, second.receipt.finalVerificationReceiptDigest);
    assert.notEqual(first.receipt.receiptDigest, second.receipt.receiptDigest);
  });

  it('every field of the handoff commitment changes the routing receipt digest', () => {
    const base = route(request(), routerHandoff());
    assert.equal(base.status, 'SELECTED');
    if (base.status !== 'SELECTED') return;

    // A later instant with a correspondingly later observation: the handoff state
    // digest and the handoff instant are both committed, so each one moving
    // changes the receipt.
    const laterInstant = route(request(), routerHandoff({ clock: { nowUnixSeconds: ROUTER_CLOCK + 1n } }));
    assert.equal(laterInstant.status, 'SELECTED');
    if (laterInstant.status === 'SELECTED') {
      assert.equal(laterInstant.receipt.handoffStateDigest, base.receipt.handoffStateDigest, 'same world');
      assert.notEqual(laterInstant.receipt.handoffAtUnixSeconds, base.receipt.handoffAtUnixSeconds);
      assert.notEqual(laterInstant.receipt.receiptDigest, base.receipt.receiptDigest);
    }

    const laterWorld = route(request(), routerHandoff({
      trustedMarketState: refreshedRouterState(1n),
      clock: { nowUnixSeconds: ROUTER_CLOCK + 1n },
    }));
    assert.equal(laterWorld.status, 'SELECTED');
    if (laterWorld.status === 'SELECTED') {
      assert.notEqual(laterWorld.receipt.handoffStateDigest, base.receipt.handoffStateDigest);
      assert.notEqual(laterWorld.receipt.receiptDigest, base.receipt.receiptDigest);
      // And the two later runs differ from each other, so the instant and the
      // world are independently committed rather than conflated.
      if (laterInstant.status === 'SELECTED') {
        assert.notEqual(laterWorld.receipt.receiptDigest, laterInstant.receipt.receiptDigest);
      }
    }
  });

  it('a refused handoff still commits to the world it refused against', () => {
    // A refusal that leaves no auditable record is not a refusal anyone can check.
    const expired = route(request(), routerHandoff({ clock: { nowUnixSeconds: ROUTER_MANDATE.expiresAtUnixSeconds } }));
    assert.equal(expired.status, 'NO_VALID_ROUTE');
    if (expired.status !== 'NO_VALID_ROUTE') return;
    assert.equal(expired.receipt.selectedCandidateDigest, null);
    assert.equal(expired.receipt.handoffStateDigest, trustedStateDigest(ROUTER_STATE));
    assert.equal(expired.receipt.handoffAtUnixSeconds, ROUTER_MANDATE.expiresAtUnixSeconds);
    assert.ok(expired.finalVerificationReceipt !== null);
    assert.equal(expired.receipt.finalVerificationReceiptDigest, expired.finalVerificationReceipt.receiptDigest);
    // The candidates that were ranked are still recorded, so "which route would
    // have executed" is answerable after the fact.
    assert.equal(expired.receipt.rankedCandidateDigests.length, 1);
  });
});
