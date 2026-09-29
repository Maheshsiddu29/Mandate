/**
 * Phase 7F.2 audit reproduction (F7F1-01): one signed proposal, many actions.
 *
 * The attack keeps every signed input byte-identical — the principal's
 * mandate, the agent's signed proposal and its candidate — and changes only
 * the time at which the proposal is verified. It runs the real production
 * path: room → verifier → child derivation → Core compilation → reservation
 * through the control engine and ledger.
 *
 * Before the fix both verifications reserved: the child committed the quote's
 * age at verification time, so each time minted a new child and action. The
 * same inputs now derive one child and one action, and the ledger refuses
 * the second reservation as the replay it is.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { actionId, keccakDigest, type Digest32 } from '@mandate/core';
import { bytesToHex } from '@mandate/kernel';
import { AuthorityLedger } from '@mandate/ledger';
import { controlRules } from '@mandate/control';
import {
  candidateDigest,
  checkBeforeSign,
  childAuthorizationDigest,
  compileAction,
  defaultExecutor,
  encodeAgentProposal,
  executeFixtureChild,
  fullAvailability,
  portfolioMandateDigest,
  proposalDigest,
  quoteAgeBound,
  quoteExpiresAt,
  requestFor,
  reservationPhase,
  reserveChild,
  runPortfolio,
  screenProposal,
  verifyPortfolio,
  type ActionCandidate,
  type ChildExecutor,
  type ChildExecutionAuthorization,
  type PortfolioMandate,
  type SignedProposal,
} from '../src/index.ts';
import { USDC, demoBindings } from '../src/demo/index.ts';
import { NOW, stockBuy, swap, yieldDeposit } from './support/candidates.ts';
import { gateWorld } from './support/gate.ts';
import { ScriptedAgent, agentOf, authorizationForSigned, principalSignature, proposal, world, type World } from './support/world.ts';

async function replayAcrossTime(role: 'swap' | 'yield', candidate: ActionCandidate) {
  const w = await world();
  const signed: SignedProposal = proposal(w.m, role, candidate);
  const bytes = bytesToHex(encodeAgentProposal(signed.proposal));
  const mandate = portfolioMandateDigest(w.m);

  const first = authorizationForSigned(w.m, role, signed, NOW);
  const firstOut = await reserveChild(w.core, first.transcript, first.verified.digest, NOW);

  const second = authorizationForSigned(w.m, role, signed, NOW + 1n);
  const secondOut = await reserveChild(w.core, second.transcript, second.verified.digest, NOW + 1n);

  // Only the verification time changed: the signed proposal, its signature, its candidate and the mandate are identical.
  const replayed = second.transcript.proposals.find((p) => proposalDigest(p.proposal) === proposalDigest(signed.proposal));
  assert.ok(replayed !== undefined);
  assert.equal(bytesToHex(encodeAgentProposal(replayed.proposal)), bytes);
  assert.equal(replayed.signature, signed.signature);
  assert.equal(candidateDigest(replayed.proposal.candidate), candidateDigest(candidate));
  assert.equal(portfolioMandateDigest(w.m), mandate);
  assert.equal(second.transcript.signature, first.transcript.signature);
  assert.notEqual(second.transcript.verifiedAt, first.transcript.verifiedAt);

  const action = (x: typeof first) => {
    const a = compileAction(w.compiled, x.verified.child, x.verified.candidate);
    assert.ok(a.ok);
    return actionId(a.value.envelope);
  };
  const state = (await w.core.engine.read(w.m.principal)).state;
  return { first, second, firstOut, secondOut, firstAction: action(first), secondAction: action(second), reservations: state.reservations.size };
}

describe('F7F1-01: one signed proposal verified at two times', () => {
  for (const [role, candidate] of [['swap', swap({ amount: USDC(100n) })], ['yield', yieldDeposit({ amount: USDC(100n) })]] as const) {
    it(`${role}: the same signed proposal has one child and one action; the second reservation is the ledger's replay`, async () => {
      const r = await replayAcrossTime(role, candidate);
      assert.equal(r.second.verified.proposal, r.first.verified.proposal);
      assert.equal(r.second.verified.digest, r.first.verified.digest);
      assert.equal(r.secondAction, r.firstAction);
      assert.equal(r.firstOut.status, 'RESERVED');
      assert.ok(r.secondOut.status === 'REFUSED', JSON.stringify(r.secondOut.status));
      assert.deepEqual(r.secondOut.reasons.map((x) => x.code), ['LEDGER:REQUEST_INVALID/RESERVATION_EXISTS']);
      assert.equal(r.reservations, 1);
    });
  }
});

// --- Phase 7F.2: the invariant, freshness, mutation, and replay in every ledger state ---------------

/** The quote the default candidates carry and each agent's static bound (demo mandate: swap 60 s, yield 300 s). */
const QUOTED = NOW - 10n;
const BOUND = { swap: 60n, yield: 300n } as const;
const big = (_key: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

function screenedAt(m: PortfolioMandate, signed: SignedProposal, at: bigint) {
  return screenProposal(m, demoBindings(), signed, at);
}

function actionOf(w: World, child: ChildExecutionAuthorization, candidate: ActionCandidate): string {
  const a = compileAction(w.compiled, child, candidate);
  assert.ok(a.ok);
  return actionId(a.value.envelope);
}

describe('F7F1-01: proposal, child and Core action identity do not depend on the verification time', () => {
  for (const [role, candidate] of [['swap', swap({ amount: USDC(100n) })], ['yield', yieldDeposit({ amount: USDC(100n) })]] as const) {
    it(`${role}: every still-fresh verification time derives the identical proposal ID, child digest and action ID`, async () => {
      const w = await world();
      const signed = proposal(w.m, role, candidate);
      const lastFresh = QUOTED + BOUND[role];
      const identities = new Set<string>();
      for (const at of [NOW, NOW + 1n, NOW + 7n, lastFresh - 1n, lastFresh]) {
        const s = screenedAt(w.m, signed, at);
        assert.ok(s.child !== null, `${role} at ${at}: ${JSON.stringify(s.reasons)}`);
        identities.add(`${proposalDigest(signed.proposal)} ${childAuthorizationDigest(s.child)} ${actionOf(w, s.child, candidate)}`);
      }
      assert.equal(identities.size, 1);
      // And through the whole room → verifier path, at the first and the last fresh second.
      assert.equal(authorizationForSigned(w.m, role, signed, NOW).verified.digest, authorizationForSigned(w.m, role, signed, lastFresh).verified.digest);
    });

    it(`${role}: the freshness boundary is exact — age = bound is fresh, age = bound + 1 is QUOTE_STALE with no child`, async () => {
      const w = await world();
      const signed = proposal(w.m, role, candidate);
      const lastFresh = QUOTED + BOUND[role];
      const fresh = screenedAt(w.m, signed, lastFresh);
      assert.ok(fresh.child !== null);
      const stale = screenedAt(w.m, signed, lastFresh + 1n);
      assert.equal(stale.child, null);
      assert.deepEqual(stale.reasons.map((r) => r.code), ['QUOTE_STALE']);
      // The child's window is the quote's: it ends exactly where freshness does, and so does its Core action's.
      assert.equal(fresh.child.expiresAt, quoteExpiresAt(QUOTED, BOUND[role]));
      assert.equal(fresh.child.expiresAt, lastFresh + 1n);
      assert.equal(fresh.child.scope.maxQuoteAgeSeconds, BOUND[role]);
      const compiled = compileAction(w.compiled, fresh.child, candidate);
      assert.ok(compiled.ok);
      assert.equal(compiled.value.envelope.expiresAt, lastFresh + 1n);
    });

    it(`${role}: Core itself refuses the compiled action once its quote has expired, independently of the portfolio's own screening`, async () => {
      const w = await world();
      const child = screenedAt(w.m, proposal(w.m, role, candidate), NOW).child;
      assert.ok(child !== null);
      const expiry = quoteExpiresAt(QUOTED, BOUND[role]);
      const inside = requestFor(w.core, child, candidate, expiry - 1n);
      const past = requestFor(w.core, child, candidate, expiry);
      assert.ok(inside.ok && past.ok);
      assert.ok((await w.core.engine.decide(inside.value)).ok);
      const refused = await w.core.engine.decide(past.value);
      assert.ok(!refused.ok && refused.error.reason === 'ACTION_EXPIRED', JSON.stringify(refused));
    });
  }

  it('a quote observed in the future, or an agent or portfolio without a quote bound, derives no child at all', async () => {
    const w = await world();
    const future = screenedAt(w.m, proposal(w.m, 'swap', swap({ observedAt: NOW + 1n })), NOW);
    assert.ok(future.child === null && future.reasons.some((r) => r.code === 'QUOTE_STALE'));
    assert.equal(quoteAgeBound(agentOf(w.m, 'swap').scope, w.m.scope), 60n);
    assert.equal(quoteAgeBound(agentOf(w.m, 'nft').scope, w.m.scope), null);
  });
});

describe('F7F1-01: every material change is a new identity; time alone is not', () => {
  it('quote time, amount, minimum out, venue and recipient each change the proposal and candidate identity', async () => {
    const w = await world();
    const base = swap({ amount: USDC(100n) });
    const baseSigned = proposal(w.m, 'swap', base);
    const baseChild = screenedAt(w.m, baseSigned, NOW).child;
    assert.ok(baseChild !== null);
    const mutations = [
      ['quoteObservedAt', swap({ amount: USDC(100n), observedAt: QUOTED - 1n }), true],
      ['amount', swap({ amount: USDC(101n) }), true],
      ['minOut', swap({ amount: USDC(100n), minOut: 119_700_000_000_000_000n }), true],
      ['venue', swap({ amount: USDC(100n), router: 'eip155:421614/router:0x0000000000000000000000000000000000005a02' }), false],
      ['recipient', swap({ amount: USDC(100n), recipient: 'eip155:421614/account:0x9999999999999999999999999999999999999999' }), false],
    ] as const;
    for (const [name, mutated, admissible] of mutations) {
      const signed = proposal(w.m, 'swap', mutated);
      assert.notEqual(candidateDigest(mutated), candidateDigest(base), name);
      assert.notEqual(proposalDigest(signed.proposal), proposalDigest(baseSigned.proposal), name);
      const child = screenedAt(w.m, signed, NOW).child;
      if (!admissible) {
        assert.equal(child, null, name);
        continue;
      }
      assert.ok(child !== null, name);
      assert.notEqual(childAuthorizationDigest(child), childAuthorizationDigest(baseChild), name);
      assert.notEqual(actionOf(w, child, mutated), actionOf(w, baseChild, base), name);
    }
    // The unchanged proposal, later: nothing changes.
    const later = screenedAt(w.m, baseSigned, NOW + 30n).child;
    assert.ok(later !== null);
    assert.equal(childAuthorizationDigest(later), childAuthorizationDigest(baseChild));
    assert.equal(actionOf(w, later, base), actionOf(w, baseChild, base));
  });
});

describe('F7F1-01: the same signed proposal is refused by the existing ledger in every reservation state', () => {
  const candidate = yieldDeposit({ amount: USDC(100n) });
  const replayCodes = (out: Awaited<ReturnType<typeof reserveChild>>) => (out.status === 'REFUSED' ? out.reasons.map((r) => r.code) : ['RESERVED']);

  async function reservedOnce() {
    const w = await world();
    const signed = proposal(w.m, 'yield', candidate);
    const first = authorizationForSigned(w.m, 'yield', signed, NOW);
    const out = await reserveChild(w.core, first.transcript, first.verified.digest, NOW);
    assert.ok(out.status === 'RESERVED');
    const replay = async () => {
      const again = authorizationForSigned(w.m, 'yield', signed, NOW + 1n);
      assert.equal(again.verified.digest, first.verified.digest);
      return reserveChild(w.core, again.transcript, again.verified.digest, NOW + 1n);
    };
    const state = async () => (await w.core.engine.read(w.m.principal)).state;
    return { w, first, record: out.record, replay, state };
  }

  it('RESERVED (ACTIVE): the replay is RESERVATION_EXISTS', async () => {
    const r = await reservedOnce();
    assert.deepEqual(replayCodes(await r.replay()), ['LEDGER:REQUEST_INVALID/RESERVATION_EXISTS']);
    assert.equal((await r.state()).reservations.size, 1);
  });

  it('ADMITTED: the replay is RESERVATION_EXISTS and no second ADMIT_ATTEMPT is written', async () => {
    const r = await reservedOnce();
    const executed = await executeFixtureChild(r.w.core, r.first.transcript, r.first.verified.child, candidate, r.record, NOW + 5n);
    assert.ok(executed.ok);
    assert.equal(reservationPhase(await r.state(), r.record.reservation), 'ADMITTED');
    assert.deepEqual(replayCodes(await r.replay()), ['LEDGER:REQUEST_INVALID/RESERVATION_EXISTS']);
    const s = await r.state();
    assert.equal(s.reservations.size, 1);
    assert.equal(s.attempts.size, 1);
  });

  it('CLOSED before any attempt (NEVER_ISSUED): the replay is RESERVATION_EXISTS — a retry is a new signed proposal, never a new identity', async () => {
    const r = await reservedOnce();
    const compiled = compileAction(r.w.compiled, r.first.verified.child, candidate);
    assert.ok(compiled.ok);
    // A pre-execution failure: revalidation cannot see the venue's state, so the engine closes the reservation.
    const closed = await r.w.core.engine.closeNeverIssued(r.record, { payload: compiled.value.payload, states: [], context: { evaluationTime: NOW + 1n, sources: [], blockHeads: [], sequenceWatermarks: [] } }, { maxAttempts: 1 });
    assert.equal(closed.status, 'CLOSED', JSON.stringify(closed, big));
    assert.equal(reservationPhase(await r.state(), r.record.reservation), 'CLOSED');
    assert.deepEqual(replayCodes(await r.replay()), ['LEDGER:REQUEST_INVALID/RESERVATION_EXISTS']);
    assert.equal((await r.state()).reservations.size, 1);
  });

  it('SETTLED (consumed and closed by the ledger): the replay is RESERVATION_EXISTS', async () => {
    const r = await reservedOnce();
    const executed = await executeFixtureChild(r.w.core, r.first.transcript, r.first.verified.child, candidate, r.record, NOW + 5n);
    assert.ok(executed.ok);
    const ledger = new AuthorityLedger(r.w.core.store, r.w.core.registry, controlRules(r.w.core.catalog));
    const held = (await r.state()).reservations.get(r.record.reservation);
    assert.ok(held !== undefined);
    const evidence = keccakDigest<Digest32>(new TextEncoder().encode('observation:settled')) as never;
    const settled = await ledger.settle(r.w.m.principal, [
      { kind: 'CONSUME', reservation: r.record.reservation, generation: r.record.generation, evidence, amounts: held.demands.map((d) => d.reserved) },
      { kind: 'CLOSE', reservation: r.record.reservation, generation: r.record.generation, evidence },
    ], NOW + 6n, { maxAttempts: 1 });
    assert.equal(settled.status, 'COMMITTED', JSON.stringify(settled, big));
    const s = await r.state();
    assert.equal(s.reservations.get(r.record.reservation)?.status, 'CLOSED');
    assert.ok(s.reservations.get(r.record.reservation)?.demands.every((d) => d.consumed === d.reserved));
    assert.deepEqual(replayCodes(await r.replay()), ['LEDGER:REQUEST_INVALID/RESERVATION_EXISTS']);
    assert.equal((await r.state()).reservations.size, 1);
  });
});

describe('F7F1-01 hostile replay, end to end', () => {
  it('swap: a malicious room replays the exact signed 100 USDC proposal while fresh, then after expiry — one reservation, one attempt, one pre-sign pass', async () => {
    const w = await world();
    const candidate = swap({ amount: USDC(100n) });
    // 1–2. The Portfolio Mandate is registered; the swap agent signs one valid proposal.
    const signed = proposal(w.m, 'swap', candidate);
    // 3–4. Verify at T and reserve.
    const first = authorizationForSigned(w.m, 'swap', signed, NOW);
    const reserved = await reserveChild(w.core, first.transcript, first.verified.digest, NOW);
    assert.ok(reserved.status === 'RESERVED');
    // 5–6. ADMIT_ATTEMPT is committed, then the pre-sign check passes (FIXTURE: the signature is SIMULATED).
    // FIXTURE: no key and no transaction exist; count the pre-sign passes, where a domain signer would use its key.
    let presignPasses = 0;
    const executed = await executeFixtureChild(w.core, first.transcript, first.verified.child, candidate, reserved.record, NOW + 5n);
    assert.ok(executed.ok);
    presignPasses += 1;
    const attempt = executed.value.attempt.attempt;
    const state = async () => (await w.core.engine.read(w.m.principal)).state;
    assert.equal((await state()).attempts.size, 1);

    // 7–8. The exact same signed proposal, re-submitted at T+1 while fresh; the room accepts it again (it has no memory).
    const second = authorizationForSigned(w.m, 'swap', signed, NOW + 1n);
    assert.equal(proposalDigest(second.transcript.proposals[0]?.proposal as never), proposalDigest(signed.proposal));
    assert.equal(second.verified.proposal, first.verified.proposal);
    assert.equal(second.verified.digest, first.verified.digest);
    assert.equal(actionOf(w, second.verified.child, candidate), reserved.record.actionId);
    const replay = await reserveChild(w.core, second.transcript, second.verified.digest, NOW + 1n);
    assert.ok(replay.status === 'REFUSED');
    assert.deepEqual(replay.reasons.map((r) => r.code), ['LEDGER:REQUEST_INVALID/RESERVATION_EXISTS']);
    // The pipeline executes only what it reserved: nothing reaches a signer, so the counters stay.
    let s = await state();
    assert.equal(s.reservations.size, 1);
    assert.equal(s.attempts.size, 1);
    assert.ok(s.attempts.get(attempt) !== undefined);

    // 9. After the quote's expiry (observed T−10, bound 60 s): no child, no action identity, no key, no transaction.
    const expired = quoteExpiresAt(QUOTED, BOUND.swap);
    const late = screenedAt(w.m, signed, expired);
    assert.equal(late.child, null);
    assert.deepEqual(late.reasons.map((r) => r.code), ['QUOTE_STALE']);
    // A malicious room replaying the old accepted candidate at the new time is refused by the verifier…
    const replayedLate = verifyPortfolio({ mandate: w.m, signature: principalSignature(w.m), bindings: demoBindings(), availability: fullAvailability(w.m), now: expired, candidate: first.transcript.candidate, proposals: first.transcript.proposals, releases: first.transcript.releases });
    assert.ok(replayedLate.status === 'REFUSED' && replayedLate.reasons.some((r) => r.code === 'QUOTE_STALE'));
    // …by reservation and by the pre-sign check, each at the boundary's own time.
    const lateReserve = await reserveChild(w.core, first.transcript, first.verified.digest, expired);
    assert.ok(lateReserve.status === 'REFUSED' && lateReserve.reasons.some((r) => r.code === 'QUOTE_STALE'));
    const lateSign = checkBeforeSign(w.core, first.transcript, { agent: first.verified.child.agent, child: first.verified.child, candidate, reservation: reserved.record.reservation, action: reserved.record.actionId, generation: reserved.record.generation, authorization: reserved.record.executionId, attempt, at: expired }, s);
    assert.ok(lateSign.some((r) => r.code === 'QUOTE_STALE'));
    s = await state();
    assert.equal(s.reservations.size, 1);
    assert.equal(s.attempts.size, 1);
    assert.equal(presignPasses, 1);
  });

  for (const [role, candidate] of [['swap', swap({ amount: USDC(100n) })], ['yield', yieldDeposit({ amount: USDC(100n) })]] as const) {
    it(`${role}: one unchanged signed proposal across two Portfolio runs settles once`, async () => {
      const w = await world();
      const signed = proposal(w.m, role, candidate);
      let executorCalls = 0;
      const inner = defaultExecutor(w.core);
      const execute: ChildExecutor = async (...args) => {
        executorCalls += 1;
        return inner(...args);
      };
      const run = (now: bigint) => runPortfolio({ core: w.core, signature: principalSignature(w.m), now, agents: [new ScriptedAgent(role, [[1, { kind: 'PROPOSE', signed }]])], execute });
      const one = await run(NOW);
      const two = await run(NOW + 1n);
      assert.equal(one.executions.filter((e) => e.status === 'SETTLED').length, 1);
      assert.equal(two.verification.status, 'VERIFIED');
      assert.ok(two.verification.status === 'VERIFIED' && one.verification.status === 'VERIFIED');
      assert.equal(two.verification.children[0]?.digest, one.verification.children[0]?.digest);
      assert.deepEqual(two.reservations.map((r) => [r.status, r.reasons.map((x) => x.code)]), [['REFUSED', ['LEDGER:REQUEST_INVALID/RESERVATION_EXISTS']]]);
      assert.equal(two.executions.length, 0);
      assert.equal(executorCalls, 1);
      assert.equal(one.receipt.transactions + two.receipt.transactions, 0);
      const s = (await w.core.engine.read(w.m.principal)).state;
      assert.equal(s.reservations.size, 1);
      assert.equal(s.attempts.size, 1);
    });
  }

  it('stock, through the real custody: a replayed signed proposal reaches the principal key once and sends one transaction', async () => {
    const g = await gateWorld();
    try {
      const m = g.core.compiled.mandate;
      const candidate = stockBuy({ tenths: 48n });
      const signed = proposal(m, 'stock', candidate);
      const first = authorizationForSigned(m, 'stock', signed, NOW);
      const r = await reserveChild(g.core, first.transcript, first.verified.digest, NOW);
      assert.ok(r.status === 'RESERVED');
      g.children.set(r.record.reservation, { child: first.verified.child, candidate, record: r.record, transcript: first.transcript });
      const compiled = compileAction(g.core.compiled, first.verified.child, candidate);
      assert.ok(compiled.ok);
      const issue = () => g.signer.issueAuthorizedBuy(r.record, { payload: compiled.value.payload, states: g.binding.states(candidate, NOW + 5n), context: { evaluationTime: NOW + 5n, sources: [...g.binding.sources()], blockHeads: [], sequenceWatermarks: [] } });
      assert.equal((await issue()).status, 'ISSUED');
      assert.equal(g.keyUses(), 1);
      assert.equal(g.chain.txs.length, 1);

      const second = authorizationForSigned(m, 'stock', signed, NOW + 1n);
      assert.equal(second.verified.digest, first.verified.digest);
      const replay = await reserveChild(g.core, second.transcript, second.verified.digest, NOW + 1n);
      assert.ok(replay.status === 'REFUSED' && replay.reasons.some((x) => x.code.endsWith('/RESERVATION_EXISTS')));
      const state = (await g.core.engine.read(m.principal)).state;
      assert.equal(state.reservations.size, 1);
      assert.equal(state.attempts.size, 1);
      assert.equal(g.keyUses(), 1);
      assert.equal(g.chain.txs.length, 1);
    } finally {
      g.close();
    }
  });
});
