/**
 * Phase 7F.2 audit reproduction (F7F1-01): one signed proposal, many actions.
 *
 * The attack keeps every signed input byte-identical — the principal's
 * mandate, the agent's signed proposal and its candidate — and changes only
 * the time at which the proposal is verified. It runs the real production
 * path: room → verifier → child derivation → Core compilation → reservation
 * through the control engine and ledger.
 *
 * This file first records the pre-fix behavior; the fixing commit turns each
 * assertion into the fail-closed property while keeping the same inputs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { actionId } from '@mandate/core';
import { bytesToHex } from '@mandate/kernel';
import { candidateDigest, compileAction, encodeAgentProposal, portfolioMandateDigest, proposalDigest, reserveChild, type ActionCandidate, type SignedProposal } from '../src/index.ts';
import { USDC } from '../src/demo/index.ts';
import { NOW, swap, yieldDeposit } from './support/candidates.ts';
import { authorizationForSigned, proposal, world } from './support/world.ts';

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
  it('reproduces: a swap proposal derives a second child, action and reservation at T+1', async () => {
    const r = await replayAcrossTime('swap', swap({ amount: USDC(100n) }));
    assert.equal(r.second.verified.proposal, r.first.verified.proposal);
    assert.notEqual(r.second.verified.digest, r.first.verified.digest);
    assert.notEqual(r.secondAction, r.firstAction);
    assert.equal(r.firstOut.status, 'RESERVED');
    assert.equal(r.secondOut.status, 'RESERVED');
    assert.equal(r.reservations, 2);
  });

  it('reproduces: a yield proposal derives a second child, action and reservation at T+1', async () => {
    const r = await replayAcrossTime('yield', yieldDeposit({ amount: USDC(100n) }));
    assert.equal(r.second.verified.proposal, r.first.verified.proposal);
    assert.notEqual(r.second.verified.digest, r.first.verified.digest);
    assert.notEqual(r.secondAction, r.firstAction);
    assert.equal(r.firstOut.status, 'RESERVED');
    assert.equal(r.secondOut.status, 'RESERVED');
    assert.equal(r.reservations, 2);
  });
});
