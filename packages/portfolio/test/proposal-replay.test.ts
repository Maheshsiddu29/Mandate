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
