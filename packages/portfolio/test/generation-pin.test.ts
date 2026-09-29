/**
 * Phase 7F.3 audit reproduction (7F.2 audit LOW-1): a Core generation 2 of a
 * Portfolio action at the signing boundary.
 *
 * Portfolio reserves only generation 1 (`requestFor`), so one signed proposal
 * has at most one Portfolio reservation. Core itself admits generation 2 of
 * the same action once generation 1 is closed — a Core feature for callers
 * that retry an action. A party with direct access to the control engine can
 * therefore reserve generation 2 of a Portfolio child's exact action, outside
 * Portfolio's reservation path, and hand it to Portfolio's pre-sign check.
 *
 * This file first records the pre-fix behavior; the fixing commit turns each
 * assertion into the fail-closed property while keeping the same inputs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthorizationRecord } from '@mandate/control';
import { compileAction, executeFixtureChild, requestFor, reserveChild, type ActionCandidate, type PortfolioCore, type VerifiedChild } from '../src/index.ts';
import { USDC } from '../src/demo/index.ts';
import { NOW, stockBuy, yieldDeposit } from './support/candidates.ts';
import { gateWorld } from './support/gate.ts';
import { authorizationForSigned, proposal, world } from './support/world.ts';

const codes = (out: Awaited<ReturnType<typeof reserveChild>>) => (out.status === 'REFUSED' ? out.reasons.map((r) => r.code) : ['RESERVED']);

/** A pre-execution failure: revalidation cannot see the venue's state, so the engine closes the reservation NEVER_ISSUED. */
async function closeNeverIssued(core: PortfolioCore, verified: VerifiedChild, record: AuthorizationRecord, at: bigint): Promise<void> {
  const compiled = compileAction(core.compiled, verified.child, verified.candidate);
  assert.ok(compiled.ok);
  const closed = await core.engine.closeNeverIssued(record, { payload: compiled.value.payload, states: [], context: { evaluationTime: at, sources: [], blockHeads: [], sequenceWatermarks: [] } }, { maxAttempts: 1 });
  assert.equal(closed.status, 'CLOSED');
}

/** Generation 2 of the child's exact action, reserved directly through Core's control engine — not through Portfolio. */
async function directGenerationTwo(core: PortfolioCore, verified: VerifiedChild, candidate: ActionCandidate, at: bigint): Promise<AuthorizationRecord> {
  const request = requestFor(core, verified.child, candidate, at);
  assert.ok(request.ok);
  const out = await core.engine.authorizeAndReserve({ ...request.value, generation: 2n }, { maxAttempts: 1 });
  assert.ok(out.status === 'AUTHORIZED', JSON.stringify(out.status));
  assert.equal(out.authorization.generation, 2n);
  return out.authorization;
}

describe('LOW-1: a direct Core generation 2 of a Portfolio action at the signing boundary', () => {
  it('yield (FIXTURE): Portfolio refuses the replay, but executeFixtureChild accepts a directly reserved generation 2', async () => {
    const w = await world();
    const candidate = yieldDeposit({ amount: USDC(100n) });
    const signed = proposal(w.m, 'yield', candidate);
    const first = authorizationForSigned(w.m, 'yield', signed, NOW);
    const reserved = await reserveChild(w.core, first.transcript, first.verified.digest, NOW);
    assert.ok(reserved.status === 'RESERVED');
    assert.equal(reserved.record.generation, 1n);
    await closeNeverIssued(w.core, first.verified, reserved.record, NOW + 1n);

    // Through Portfolio the same signed proposal stays spent.
    const again = authorizationForSigned(w.m, 'yield', signed, NOW + 2n);
    assert.deepEqual(codes(await reserveChild(w.core, again.transcript, again.verified.digest, NOW + 2n)), ['LEDGER:REQUEST_INVALID/RESERVATION_EXISTS']);

    // Directly through Core it does not: generation 2 of the same action.
    const gen2 = await directGenerationTwo(w.core, again.verified, candidate, NOW + 2n);
    assert.equal(gen2.actionId, reserved.record.actionId);

    // PRE-FIX: the Portfolio pre-sign check passes and the fixture settles a second time.
    const executed = await executeFixtureChild(w.core, again.transcript, again.verified.child, candidate, gen2, NOW + 5n);
    assert.ok(executed.ok);
    const s = (await w.core.engine.read(w.m.principal)).state;
    assert.equal(s.reservations.size, 2);
    assert.equal(s.attempts.size, 1);
  });

  it('stock, through the real custody: a directly reserved generation 2 reaches the principal key', async () => {
    const g = await gateWorld();
    try {
      const m = g.core.compiled.mandate;
      const candidate = stockBuy({ tenths: 48n });
      const signed = proposal(m, 'stock', candidate);
      const first = authorizationForSigned(m, 'stock', signed, NOW);
      const reserved = await reserveChild(g.core, first.transcript, first.verified.digest, NOW);
      assert.ok(reserved.status === 'RESERVED');
      await closeNeverIssued(g.core, first.verified, reserved.record, NOW + 1n);
      const gen2 = await directGenerationTwo(g.core, first.verified, candidate, NOW + 2n);
      // An integrator that records every reservation of a verified child's action.
      g.children.set(gen2.reservation, { child: first.verified.child, candidate, record: gen2, transcript: first.transcript });
      const compiled = compileAction(g.core.compiled, first.verified.child, candidate);
      assert.ok(compiled.ok);
      const issued = await g.signer.issueAuthorizedBuy(gen2, { payload: compiled.value.payload, states: g.binding.states(candidate, NOW + 5n), context: { evaluationTime: NOW + 5n, sources: [...g.binding.sources()], blockHeads: [], sequenceWatermarks: [] } });
      // PRE-FIX: the key signs and the gate executes.
      assert.equal(issued.status, 'ISSUED');
      assert.equal(g.keyUses(), 1);
      assert.equal(g.chain.txs.length, 1);
    } finally {
      g.close();
    }
  });
});
