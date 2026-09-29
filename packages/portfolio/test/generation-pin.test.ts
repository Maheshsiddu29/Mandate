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
 * Generation 1 is Portfolio policy, not Core's: `checkBeforeSign` now
 * requires both the claimed and the reserved generation to be
 * `PORTFOLIO_GENERATION`, and `executeFixtureChild` refuses before admitting
 * any attempt. Core's own generation semantics are unchanged — the direct
 * generation 2 below is still AUTHORIZED by Core — and it can never be
 * signed or settled as a Portfolio child.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthorizationRecord } from '@mandate/control';
import {
  PORTFOLIO_GENERATION,
  checkBeforeSign,
  compileAction,
  defaultExecutor,
  executeFixtureChild,
  requestFor,
  reserveChild,
  type ActionCandidate,
  type PortfolioCore,
  type VerifiedChild,
} from '../src/index.ts';
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
  it('yield (FIXTURE): the replay is RESERVATION_EXISTS; a directly reserved generation 2 is refused before any attempt, execution or settlement', async () => {
    const w = await world();
    const candidate = yieldDeposit({ amount: USDC(100n) });
    const signed = proposal(w.m, 'yield', candidate);
    const first = authorizationForSigned(w.m, 'yield', signed, NOW);
    const reserved = await reserveChild(w.core, first.transcript, first.verified.digest, NOW);
    assert.ok(reserved.status === 'RESERVED');
    assert.equal(reserved.record.generation, PORTFOLIO_GENERATION);
    await closeNeverIssued(w.core, first.verified, reserved.record, NOW + 1n);

    // Through Portfolio the same signed proposal stays spent.
    const again = authorizationForSigned(w.m, 'yield', signed, NOW + 2n);
    assert.deepEqual(codes(await reserveChild(w.core, again.transcript, again.verified.digest, NOW + 2n)), ['LEDGER:REQUEST_INVALID/RESERVATION_EXISTS']);

    // Directly through Core, generation 2 of the same action is still Core's to grant (unchanged)…
    const gen2 = await directGenerationTwo(w.core, again.verified, candidate, NOW + 2n);
    assert.equal(gen2.actionId, reserved.record.actionId);

    // …but it is never a Portfolio reservation: no attempt, no pre-sign pass, no settlement.
    const executed = await executeFixtureChild(w.core, again.transcript, again.verified.child, candidate, gen2, NOW + 5n);
    assert.ok(!executed.ok);
    assert.deepEqual(executed.error.map((r) => r.code), ['RESERVATION_GENERATION_INVALID']);
    const settled = await defaultExecutor(w.core)(again.verified, gen2, NOW + 5n, again.transcript);
    assert.equal(settled.status, 'FAILED');
    assert.deepEqual(settled.reasons.map((r) => r.code), ['RESERVATION_GENERATION_INVALID']);
    assert.equal(settled.transactions, 0);
    assert.equal(settled.attempt, null);
    const s = (await w.core.engine.read(w.m.principal)).state;
    assert.equal(s.reservations.size, 2);
    assert.equal(s.attempts.size, 0);
  });

  it('stock, through the real custody: a directly reserved generation 2 never reaches the principal key', async () => {
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
      assert.notEqual(issued.status, 'ISSUED');
      assert.equal(g.keyUses(), 0);
      assert.equal(g.chain.txs.length, 0);

      // The unchanged Phase 7E.3 signer admitted its attempt before custody; with the exact attempt, the only reason left is the generation.
      const state = g.store.readCommitted(first.verified.child.principal).state;
      const attempt = [...state.attempts.values()].find((a) => a.reservation === gen2.reservation);
      assert.ok(attempt !== undefined);
      const claim = { agent: first.verified.child.agent, child: first.verified.child, candidate, reservation: gen2.reservation, action: gen2.actionId, generation: gen2.generation, authorization: gen2.executionId, attempt: attempt.attempt, at: NOW + 5n };
      assert.deepEqual(checkBeforeSign(g.core, first.transcript, claim, state).map((r) => [r.code, r.subject]), [
        ['RESERVATION_GENERATION_INVALID', 'claim:2'],
        ['RESERVATION_GENERATION_INVALID', 'reservation:2'],
      ]);
      // Claiming generation 1 against the generation-2 reservation does not help.
      assert.deepEqual(checkBeforeSign(g.core, first.transcript, { ...claim, generation: PORTFOLIO_GENERATION }, state).map((r) => r.code), ['ATTEMPT_NOT_COMMITTED', 'RESERVATION_GENERATION_INVALID', 'RESERVATION_MISSING']);
    } finally {
      g.close();
    }
  });
});

describe('generation 1 is unaffected', () => {
  it('the exact generation-1 path executes; claiming generation 2 for it is refused; its replay stays RESERVATION_EXISTS', async () => {
    const w = await world();
    const candidate = yieldDeposit({ amount: USDC(100n) });
    const signed = proposal(w.m, 'yield', candidate);
    const first = authorizationForSigned(w.m, 'yield', signed, NOW);
    const reserved = await reserveChild(w.core, first.transcript, first.verified.digest, NOW);
    assert.ok(reserved.status === 'RESERVED');
    const executed = await executeFixtureChild(w.core, first.transcript, first.verified.child, candidate, reserved.record, NOW + 5n);
    assert.ok(executed.ok, executed.ok ? '' : JSON.stringify(executed.error));
    const state = (await w.core.engine.read(w.m.principal)).state;
    const claim = { agent: first.verified.child.agent, child: first.verified.child, candidate, reservation: reserved.record.reservation, action: reserved.record.actionId, generation: reserved.record.generation, authorization: reserved.record.executionId, attempt: executed.value.attempt.attempt, at: NOW + 5n };
    assert.deepEqual(checkBeforeSign(w.core, first.transcript, claim, state), []);
    // Claim generation 2 against the generation-1 reservation.
    assert.deepEqual(checkBeforeSign(w.core, first.transcript, { ...claim, generation: 2n as never }, state).map((r) => [r.code, r.subject]), [
      ['ATTEMPT_NOT_COMMITTED', executed.value.attempt.attempt],
      ['RESERVATION_GENERATION_INVALID', 'claim:2'],
      ['RESERVATION_MISSING', reserved.record.reservation],
    ]);
    const again = authorizationForSigned(w.m, 'yield', signed, NOW + 1n);
    assert.deepEqual(codes(await reserveChild(w.core, again.transcript, again.verified.digest, NOW + 1n)), ['LEDGER:REQUEST_INVALID/RESERVATION_EXISTS']);
  });

  it('Core outside Portfolio: generation 2 while generation 1 is open is refused, and after a close is granted — as before', async () => {
    const w = await world();
    const candidate = yieldDeposit({ amount: USDC(100n) });
    const first = authorizationForSigned(w.m, 'yield', proposal(w.m, 'yield', candidate), NOW);
    const reserved = await reserveChild(w.core, first.transcript, first.verified.digest, NOW);
    assert.ok(reserved.status === 'RESERVED');
    const request = requestFor(w.core, first.verified.child, candidate, NOW + 1n);
    assert.ok(request.ok);
    const open = await w.core.engine.authorizeAndReserve({ ...request.value, generation: 2n }, { maxAttempts: 1 });
    assert.ok(open.status !== 'AUTHORIZED' && open.refusal.reason === 'PREVIOUS_GENERATION_OPEN', JSON.stringify(open.status));
    await closeNeverIssued(w.core, first.verified, reserved.record, NOW + 1n);
    assert.equal((await directGenerationTwo(w.core, first.verified, candidate, NOW + 2n)).generation, 2n);
  });
});
