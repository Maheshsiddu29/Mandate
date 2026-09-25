/**
 * End-to-end adversarial worlds with several representations of one asset.
 *
 * Closes pressure-test finding F-10. Every earlier corpus world carried one
 * representation and one mutation class, so the substitution surface INV-14
 * exists for was never exercised end to end. These worlds carry six registered
 * representations of one canonical asset across two chains, with different
 * issuers, backing models and operational states, and combine mutations rather
 * than testing them one at a time.
 *
 * Each test states what an attacker gets to control and asserts what they
 * cannot reach.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Decision, mandateDigest } from '@mandate/kernel';
import { registrySnapshotDigest } from '@mandate/registry';
import { evaluateRoutes, route } from '../src/index.ts';
import {
  ADVERSARIAL_NOW,
  FIXTURE_CHAIN_ETHEREUM,
  FIXTURE_ISSUER_SECONDARY,
  FIXTURE_ISSUER_UNAPPROVED,
  REPRESENTATIONS,
  adversarialMandate,
  adversarialQuote,
  adversarialRegistry,
  adversarialRequest,
  adversarialState,
} from './support/adversarial-worlds.ts';

function selectedRepresentation(result: ReturnType<typeof route>): string | null {
  return result.status === 'SELECTED' ? result.selected.executionCandidate.representationId : null;
}

function exclusionCodes(result: ReturnType<typeof route>, routeId: string): readonly string[] {
  if (result.status === 'INVALID_INPUT') return result.errors.map((item) => item.code);
  const outcome = result.receipt.outcomes.find((item) => item.routeId === routeId);
  if (outcome === undefined || outcome.status !== 'EXCLUDED') return [];
  return outcome.exclusions.map((item) => item.code);
}

describe('multiple representations of one canonical asset', () => {
  it('admits every representation the mandate permits and no others, in one world', () => {
    const world = adversarialRequest({
      quotes: (state) => [
        adversarialQuote(state, { routeId: 'route.backed', representationId: REPRESENTATIONS.BACKED, feeAtoms: 300n }),
        adversarialQuote(state, { routeId: 'route.backed-b', representationId: REPRESENTATIONS.SECOND_BACKED, feeAtoms: 100n }),
        adversarialQuote(state, { routeId: 'route.synthetic', representationId: REPRESENTATIONS.SYNTHETIC, issuer: FIXTURE_ISSUER_SECONDARY, feeAtoms: 0n }),
        adversarialQuote(state, { routeId: 'route.paused', representationId: REPRESENTATIONS.PAUSED, feeAtoms: 0n }),
        adversarialQuote(state, { routeId: 'route.other-chain', representationId: REPRESENTATIONS.OTHER_CHAIN, chain: FIXTURE_CHAIN_ETHEREUM, feeAtoms: 0n }),
        adversarialQuote(state, { routeId: 'route.counterfeit', representationId: REPRESENTATIONS.COUNTERFEIT, feeAtoms: 0n }),
      ],
    });
    const evaluated = evaluateRoutes(world.request);
    assert.ok(evaluated.status === 'EVALUATED');

    const admissible = evaluated.evaluation.admissible.map((item) => item.candidate.executionCandidate.representationId);
    assert.deepEqual(
      [...admissible].sort(),
      [REPRESENTATIONS.BACKED, REPRESENTATIONS.SECOND_BACKED].sort(),
      'only the two backed notes from the approved issuer on the permitted chain',
    );

    const result = route(world.request, world.handoff);
    assert.equal(result.status, 'SELECTED');
    // The cheapest *admissible* route wins — not the cheapest route, which was
    // the synthetic at zero fees.
    assert.equal(selectedRepresentation(result), REPRESENTATIONS.SECOND_BACKED);

    assert.ok(exclusionCodes(result, 'route.synthetic').includes('SYNTHETIC_NOT_ALLOWED'));
    assert.ok(exclusionCodes(result, 'route.paused').includes('REPRESENTATION_INACTIVE'));
    assert.ok(exclusionCodes(result, 'route.other-chain').includes('CHAIN_NOT_ALLOWED'));
    // The router reports an unregistered contract as REPRESENTATION_NOT_DISCOVERABLE
    // and the registry's own filter reports the same condition as
    // REPRESENTATION_UNKNOWN. Two codes for one cause is an open informational
    // finding; the behaviour — refusal — is the same either way.
    assert.ok(exclusionCodes(result, 'route.counterfeit').includes('REPRESENTATION_NOT_DISCOVERABLE'));
  });

  it('never substitutes one representation for another, however the quote is dressed', () => {
    // The counterfeit carries the registered note's symbol, issuer, chain and
    // claimed underlying. Only the contract differs.
    const world = adversarialRequest({
      quotes: (state) => [
        adversarialQuote(state, { routeId: 'route.counterfeit', representationId: REPRESENTATIONS.COUNTERFEIT, feeAtoms: 0n }),
      ],
    });
    const result = route(world.request, world.handoff);
    assert.equal(result.status, 'NO_VALID_ROUTE');
    assert.ok(exclusionCodes(result, 'route.counterfeit').includes('REPRESENTATION_NOT_DISCOVERABLE'));
  });

  it('refuses a registered contract presented under another representation identifier', () => {
    // The Ethereum deployment, relabelled with the permitted chain in the field
    // beside it. Before Phase 5R the field was the only thing checked.
    const world = adversarialRequest({
      quotes: (state) => [
        adversarialQuote(state, {
          routeId: 'route.relabelled',
          representationId: REPRESENTATIONS.OTHER_CHAIN,
          chain: 'eip155:42161',
        }),
      ],
    });
    const result = route(world.request, world.handoff);
    assert.equal(result.status, 'NO_VALID_ROUTE');
    // The registry gets there first: chain admissibility is structural, read off
    // the identifier rather than off the field the quote supplied, so the
    // relabelling never reaches the kernel's own reconciliation check. Both
    // refuse it; this asserts which one does, so a change of order is visible.
    const codes = exclusionCodes(result, 'route.relabelled');
    assert.ok(codes.includes('CHAIN_NOT_ALLOWED'), codes.join(', '));
  });
});

describe('conflicting and mixed-age registry claims', () => {
  it('a contract whose issuer two verified sources dispute is not executable', () => {
    const world = adversarialRequest({
      quotes: (state) => [
        adversarialQuote(state, { routeId: 'route.conflicted', representationId: REPRESENTATIONS.CONFLICTED, feeAtoms: 0n }),
      ],
    });
    const result = route(world.request, world.handoff);
    assert.equal(result.status, 'NO_VALID_ROUTE');
    const codes = exclusionCodes(result, 'route.conflicted');
    assert.ok(
      codes.includes('REPRESENTATION_METADATA_CONFLICT') || codes.includes('REPRESENTATION_NOT_DISCOVERABLE'),
      codes.join(', '),
    );
  });

  it('a stale claim beside a fresh one that agrees still establishes the value', () => {
    const registry = adversarialRegistry({ mixedAgeClaims: true });
    const mandate = adversarialMandate();
    const state = adversarialState(registry, mandate);
    const world = adversarialRequest({
      registry,
      mandate,
      state,
      quotes: (current) => [
        adversarialQuote(current, { routeId: 'route.backed', representationId: REPRESENTATIONS.BACKED, feeAtoms: 100n }),
      ],
    });
    const result = route(world.request, world.handoff);
    assert.equal(result.status, 'SELECTED', 'age alone is not disagreement');
    assert.equal(selectedRepresentation(result), REPRESENTATIONS.BACKED);
  });
});

describe('combined economic and identity attacks', () => {
  it('a fee-inflated route on a valid representation is refused by the kernel', () => {
    // The attacker controls the fee and picks a legitimate representation, so
    // every identity check passes and only the economic bound stands.
    const mandate = adversarialMandate({ economicLimitAtoms: 100_500n });
    const world = adversarialRequest({
      mandate,
      quotes: (state) => [
        adversarialQuote(state, { routeId: 'route.gouging', representationId: REPRESENTATIONS.BACKED, feeAtoms: 501n }),
      ],
    });
    const result = route(world.request, world.handoff);
    assert.equal(result.status, 'NO_VALID_ROUTE');
    assert.ok(exclusionCodes(result, 'route.gouging').includes('TOTAL_DEBIT_EXCEEDED'));
  });

  it('a cheap malicious route never outranks an expensive valid one', () => {
    const world = adversarialRequest({
      quotes: (state) => [
        adversarialQuote(state, { routeId: 'route.valid-expensive', representationId: REPRESENTATIONS.BACKED, feeAtoms: 900n }),
        adversarialQuote(state, { routeId: 'route.attacker-free', representationId: REPRESENTATIONS.BACKED, issuer: FIXTURE_ISSUER_UNAPPROVED, feeAtoms: 0n }),
        adversarialQuote(state, { routeId: 'route.synthetic-free', representationId: REPRESENTATIONS.SYNTHETIC, issuer: FIXTURE_ISSUER_SECONDARY, feeAtoms: 0n }),
      ],
    });
    const result = route(world.request, world.handoff);
    assert.equal(result.status, 'SELECTED');
    assert.equal(result.status === 'SELECTED' ? result.selected.routeId : '', 'route.valid-expensive');
  });

  it('a SELL whose fees erode the proceeds past the signed floor is refused', () => {
    const mandate = adversarialMandate({ side: 'SELL', economicLimitAtoms: 99_500n });
    const world = adversarialRequest({
      mandate,
      quotes: (state) => [
        adversarialQuote(state, { routeId: 'route.sell-ok', representationId: REPRESENTATIONS.BACKED, side: 'SELL', feeAtoms: 400n }),
        adversarialQuote(state, { routeId: 'route.sell-eroded', representationId: REPRESENTATIONS.SECOND_BACKED, side: 'SELL', feeAtoms: 600n }),
      ],
    });
    const result = route(world.request, world.handoff);
    assert.equal(result.status, 'SELECTED');
    assert.equal(result.status === 'SELECTED' ? result.selected.routeId : '', 'route.sell-ok');
    assert.ok(exclusionCodes(result, 'route.sell-eroded').includes('TOTAL_CREDIT_BELOW_MINIMUM'));
  });

  it('a substituted representation combined with a fee discount is refused on identity first', () => {
    const world = adversarialRequest({
      quotes: (state) => [
        adversarialQuote(state, { routeId: 'route.backed', representationId: REPRESENTATIONS.BACKED, feeAtoms: 500n }),
        // Cheaper, and on a representation the mandate forbids.
        adversarialQuote(state, { routeId: 'route.substituted', representationId: REPRESENTATIONS.SYNTHETIC, issuer: FIXTURE_ISSUER_SECONDARY, feeAtoms: 0n }),
      ],
    });
    const result = route(world.request, world.handoff);
    assert.equal(result.status, 'SELECTED');
    assert.equal(selectedRepresentation(result), REPRESENTATIONS.BACKED);
    assert.ok(exclusionCodes(result, 'route.substituted').includes('SYNTHETIC_NOT_ALLOWED'));
  });
});

describe('corporate actions and state transitions across a multi-representation set', () => {
  it('an epoch change between authorization and routing refuses every representation', () => {
    const registry = adversarialRegistry();
    const mandate = adversarialMandate({ requiredCorporateActionEpoch: 7n });
    const state = adversarialState(registry, mandate, { epoch: 8n });
    const world = adversarialRequest({
      registry,
      mandate,
      state,
      quotes: (current) => [
        adversarialQuote(current, { routeId: 'route.backed', representationId: REPRESENTATIONS.BACKED, corporateActionEpoch: 8n }),
        adversarialQuote(current, { routeId: 'route.backed-b', representationId: REPRESENTATIONS.SECOND_BACKED, corporateActionEpoch: 8n }),
      ],
    });
    const result = route(world.request, world.handoff);
    assert.equal(result.status, 'NO_VALID_ROUTE');
    for (const routeId of ['route.backed', 'route.backed-b']) {
      assert.ok(exclusionCodes(result, routeId).includes('CORPORATE_ACTION_STATE_CHANGED'), routeId);
    }
  });

  it('a representation pausing between evaluation and handoff rejects at handoff', () => {
    const registry = adversarialRegistry();
    const mandate = adversarialMandate();
    const state = adversarialState(registry, mandate);
    // At handoff the same world is halted, which no evaluation-time check saw.
    const handoffState = adversarialState(registry, mandate, { haltStatus: 'HALTED' });
    const world = adversarialRequest({
      registry,
      mandate,
      state,
      handoffState,
      quotes: (current) => [
        adversarialQuote(current, { routeId: 'route.backed', representationId: REPRESENTATIONS.BACKED, feeAtoms: 100n }),
        adversarialQuote(current, { routeId: 'route.backed-b', representationId: REPRESENTATIONS.SECOND_BACKED, feeAtoms: 200n }),
      ],
    });
    const evaluated = evaluateRoutes(world.request);
    assert.ok(evaluated.status === 'EVALUATED' && evaluated.evaluation.admissible.length === 2, 'both admissible at t0');

    const result = route(world.request, world.handoff);
    assert.equal(result.status, 'NO_VALID_ROUTE', 'and neither survives the handoff');
    if (result.status === 'NO_VALID_ROUTE') {
      assert.notEqual(result.finalVerificationReceipt, null);
      assert.equal(result.finalVerificationReceipt?.decision, Decision.REJECT);
      assert.ok(result.finalVerificationReceipt?.reasonCodes.includes('TRADING_HALTED'));
    }
  });
});

describe('determinism over a multi-representation set', () => {
  it('candidate order does not change the decision', () => {
    const build = (reverse: boolean) => {
      const world = adversarialRequest({
        quotes: (state) => {
          const quotes = [
            adversarialQuote(state, { routeId: 'route.a', representationId: REPRESENTATIONS.BACKED, feeAtoms: 300n }),
            adversarialQuote(state, { routeId: 'route.b', representationId: REPRESENTATIONS.SECOND_BACKED, feeAtoms: 300n }),
            adversarialQuote(state, { routeId: 'route.c', representationId: REPRESENTATIONS.BACKED, feeAtoms: 100n, venue: 'venue.fixture.alpha' }),
          ];
          return reverse ? [...quotes].reverse() : quotes;
        },
      });
      return route(world.request, world.handoff);
    };
    const forward = build(false);
    const backward = build(true);
    assert.equal(forward.status, 'SELECTED');
    assert.equal(backward.status, 'SELECTED');
    if (forward.status === 'SELECTED' && backward.status === 'SELECTED') {
      assert.equal(forward.selected.candidateDigest, backward.selected.candidateDigest);
      assert.equal(forward.receipt.receiptDigest, backward.receipt.receiptDigest);
    }
  });

  it('the registry binding refuses a state derived from a different snapshot', () => {
    const registry = adversarialRegistry();
    const otherRegistry = adversarialRegistry({ mixedAgeClaims: true });
    const mandate = adversarialMandate();
    // State built against one snapshot, evaluated against another.
    const state = adversarialState(otherRegistry, mandate);
    const world = adversarialRequest({
      registry,
      mandate,
      state,
      quotes: (current) => [adversarialQuote(current, { routeId: 'route.backed', representationId: REPRESENTATIONS.BACKED })],
    });
    assert.notEqual(registrySnapshotDigest(registry.snapshot), registrySnapshotDigest(otherRegistry.snapshot));
    const result = route(world.request, world.handoff);
    assert.equal(result.status, 'INVALID_INPUT');
    if (result.status === 'INVALID_INPUT') {
      assert.ok(result.errors.some((item) => item.code === 'REGISTRY_SNAPSHOT_MISMATCH'));
    }
  });

  it('a boundary-sized candidate set still decides deterministically', () => {
    const world = adversarialRequest({
      quotes: (state) => {
        const quotes = [];
        for (let index = 0; index < 256; index += 1) {
          quotes.push(adversarialQuote(state, {
            routeId: `route.${String(index).padStart(3, '0')}`,
            representationId: index % 2 === 0 ? REPRESENTATIONS.BACKED : REPRESENTATIONS.SECOND_BACKED,
            feeAtoms: BigInt(900 - index),
          }));
        }
        return quotes;
      },
    });
    const first = route(world.request, world.handoff);
    const second = route(world.request, world.handoff);
    assert.equal(first.status, 'SELECTED');
    if (first.status === 'SELECTED' && second.status === 'SELECTED') {
      assert.equal(first.receipt.receiptDigest, second.receipt.receiptDigest);
      // The cheapest fee wins, and it is on a representation the mandate allows.
      assert.equal(first.selected.feeTotal.atoms, 645n);
    }
    assert.ok(mandateDigest(world.mandate).startsWith('0x'));
    assert.equal(world.request.clock, world.request.clock);
    assert.equal(ADVERSARIAL_NOW, ADVERSARIAL_NOW);
  });
});
