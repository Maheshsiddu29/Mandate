/**
 * Phase 7F.1 audit reproductions.
 *
 * These tests deliberately describe the pre-hardening behavior. The first
 * hardening commit changes each assertion from "the bypass succeeds" to the
 * corresponding fail-closed property while keeping the same attack inputs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Identifier } from '@mandate/kernel';
import {
  candidateDigest,
  childAuthorizationDigest,
  childExecutionAuthorizationInputOf,
  executeFixtureChild,
  fullAvailability,
  portfolioMandateDigest,
  receiptDigest,
  releaseDigest,
  reserveChild,
  runPortfolio,
  validateChildExecutionAuthorization,
  verifyPortfolio,
  type AllocationOp,
} from '../src/index.ts';
import { USDC, demoBindings, demoMandate, demoParty } from '../src/demo/index.ts';
import { NOW, swap, yieldDeposit } from './support/candidates.ts';
import { ScriptedAgent, childFor, principalSignature, release, world } from './support/world.ts';

describe('Phase 7F.1 independent audit reproductions', () => {
  it('reproduces candidate semantic rebinding on the real reservation path', async () => {
    const w = await world();
    const approved = swap();
    const substituted = swap({ minOut: 0n });
    const child = childFor(w.m, 'swap', approved);
    const rebound = validateChildExecutionAuthorization({
      ...childExecutionAuthorizationInputOf(child),
      candidate: candidateDigest(substituted),
    });
    assert.ok(rebound.ok);

    const out = await reserveChild(w.core, rebound.value, substituted, NOW);
    assert.equal(out.status, 'RESERVED');
  });

  it('reproduces caller-forged verifier membership at the pre-sign boundary', async () => {
    const w = await world();
    const candidate = yieldDeposit({ amount: USDC(100n) });
    const child = childFor(w.m, 'yield', candidate);
    const reserved = await reserveChild(w.core, child, candidate, NOW);
    assert.equal(reserved.status, 'RESERVED');
    assert.ok(reserved.status === 'RESERVED');

    const forgedMembership = new Set([childAuthorizationDigest(child)]);
    const executed = await executeFixtureChild(w.core, forgedMembership, child, candidate, reserved.record, NOW + 5n);
    assert.ok(executed.ok);
  });

  it('reproduces verifier acceptance of two distinct releases with the same sequence', () => {
    const mandate = demoMandate();
    const first = release(mandate, 'nft', [['portfolio-notional', 100n]], 7n);
    const second = release(mandate, 'nft', [['portfolio-notional', 50n]], 7n);
    const operations: AllocationOp[] = [first, second].map((signed) => ({
      kind: 'RELEASE',
      agent: signed.release.agent,
      id: `release/${releaseDigest(signed.release)}` as Identifier,
      amounts: signed.release.amounts,
    }));
    const result = verifyPortfolio({
      mandate,
      signature: principalSignature(mandate),
      bindings: demoBindings(),
      availability: fullAvailability(mandate),
      now: NOW,
      candidate: { portfolioMandate: portfolioMandateDigest(mandate), accepted: [], allocationLog: operations },
      proposals: [],
      releases: [first, second],
    });
    assert.equal(result.status, 'VERIFIED');
  });

  it('reproduces a receipt collision when a committed amount changes', async () => {
    const w = await world();
    const signed = {
      kind: 'PROPOSE' as const,
      signed: (await import('./support/world.ts')).proposal(w.m, 'swap', swap({ amount: USDC(100n) })),
    };
    const run = await runPortfolio({
      core: w.core,
      signature: principalSignature(w.m),
      now: NOW,
      agents: [new ScriptedAgent('swap', [[1, signed]])],
      execute: null,
    });
    const log = run.receipt.allocationAfter.log.map((op) =>
      op.kind === 'COMMIT'
        ? { ...op, amounts: op.amounts.map((a) => ({ ...a, atoms: a.atoms + 1n })) }
        : op,
    );
    const altered = {
      ...run.receipt,
      allocationAfter: { ...run.receipt.allocationAfter, log },
    };
    assert.equal(receiptDigest(altered), run.digest);
  });
});
