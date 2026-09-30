/**
 * Scene 6: VALID AGENT != VALID ACTION. The compromised swap agent signs
 * with the same key that signed its approved swap; the real screening
 * refuses the action for the real reason; nothing is reserved, admitted,
 * signed or sent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agentPolicyOf, proposalSignedByAgent, screenProposal, validateAgentProposal, agentProposalInputOf } from '@mandate/portfolio';
import { PRINCIPAL_ON_ARBITRUM, demoParty } from '@mandate/portfolio/demo';
import { ATTACKER_RECIPIENT, ATTACK_TIME, AgentIdentity, runJudgeDemo, type JudgeEvent } from '../src/index.ts';

const demo = runJudgeDemo();
const one = (events: readonly JudgeEvent[], kind: string): JudgeEvent => {
  const found = events.filter((e) => e.kind === kind);
  assert.equal(found.length, 1, kind);
  return found[0] as JudgeEvent;
};

describe('scene 6: a malicious, legitimately authenticated agent', () => {
  it('signs with the same legitimate identity that signed its approved swap', async () => {
    const { protocol } = await demo;
    const signed = protocol.attack.room.proposals[0];
    assert.ok(signed !== undefined);
    const swap = demoParty('swap');
    assert.deepEqual([signed.proposal.agent.kind, signed.proposal.agent.value], [swap.kind, swap.value]);
    assert.equal(protocol.compromised.party.value, swap.value);
    const earlier = protocol.initial.room.proposals.filter((s) => s.proposal.agent.value === swap.value);
    assert.equal(earlier.length, 2);
    for (const s of [...earlier, signed]) assert.equal(proposalSignedByAgent(s.proposal, s.signature), true);
    // The signature is the swap agent's and no one else's: re-attributed to another agent it no longer verifies.
    const moved = validateAgentProposal({ ...agentProposalInputOf(signed.proposal), agent: demoParty('stock') });
    assert.ok(moved.ok);
    assert.equal(proposalSignedByAgent(moved.value, signed.signature), false);
    assert.ok(agentPolicyOf(protocol.mandate, signed.proposal.agent) !== null);
    // Its sequence continues from the agent's own earlier proposals.
    assert.ok(earlier.every((s) => s.proposal.sequence < signed.proposal.sequence));
    assert.deepEqual(protocol.attackKeyUses, { before: 0, after: 1 });
  });

  it('changes exactly one field of the approved swap: the recipient, to the attacker', async () => {
    const { transcript } = await demo;
    const e = one(transcript.events, 'MALICIOUS_PROPOSAL_SIGNED');
    assert.equal(e.data['signatureValid'], true);
    assert.equal(e.data['sameIdentityAsEarlierProposals'], true);
    assert.deepEqual(e.data['changedFields'], [{ field: 'recipient', expected: [PRINCIPAL_ON_ARBITRUM], attempted: ATTACKER_RECIPIENT }]);
    assert.equal(e.agent?.label, 'swap');
  });

  it('is refused by the real Mandate screening for the real reason, and by the verifier behind a compromised Room', async () => {
    const { protocol, transcript } = await demo;
    const signed = protocol.attack.room.proposals[0];
    assert.ok(signed !== undefined);
    const s = screenProposal(protocol.mandate, protocol.core.compiled.bindings, signed, ATTACK_TIME);
    assert.deepEqual(s.reasons.map((r) => r.code), ['RECIPIENT_NOT_ALLOWED']);
    assert.equal(s.child, null);
    assert.equal(s.quantityOnly, false);
    assert.deepEqual(protocol.attack.room.decisions.map((d) => [d.outcome, d.reasons.map((r) => r.code).join()]), [['REJECTED', 'RECIPIENT_NOT_ALLOWED']]);
    const backstop = protocol.attackBackstop;
    assert.ok(backstop !== null && backstop.result.status === 'REFUSED');
    assert.ok(backstop.result.reasons.some((r) => r.code === 'RECIPIENT_NOT_ALLOWED'));
    const e = one(transcript.events, 'MALICIOUS_PROPOSAL_BLOCKED');
    assert.equal(e.status, 'BLOCKED');
    assert.deepEqual(e.reasons.map((r) => r.code), ['RECIPIENT_NOT_ALLOWED']);
    assert.deepEqual([e.data['agentAuthentication'], e.data['capability'], e.data['action']], ['VALID', 'ACTIVE', 'UNAUTHORIZED']);
  });

  it('causes zero unauthorized execution: no reservation, attempt, signer call or transaction; the ledger does not move', async () => {
    const { protocol, transcript } = await demo;
    assert.equal(protocol.attack.reservations.length, 0);
    assert.equal(protocol.attack.executions.length, 0);
    assert.equal(protocol.attack.receipt.transactions, 0);
    assert.equal(protocol.afterAttack.version, protocol.afterReplay.version);
    assert.equal(protocol.afterAttack.state.reservations.size, protocol.afterReplay.state.reservations.size);
    assert.equal(protocol.afterAttack.state.attempts.size, protocol.afterReplay.state.attempts.size);
    const e = one(transcript.events, 'MALICIOUS_PROPOSAL_BLOCKED');
    assert.deepEqual([e.data['reservationsWritten'], e.data['attemptsWritten'], e.data['executionsReachingASigner'], e.data['transactions'], e.data['agentKeySignatures']], [0, 0, 0, 0, 1]);
  });

  it('an agent identity signs only for itself', () => {
    const swap = new AgentIdentity('swap');
    const stockProposal = { agent: demoParty('stock') } as unknown as Parameters<AgentIdentity['sign']>[0];
    assert.throws(() => swap.sign(stockProposal), /will not sign for another agent/);
    assert.equal(swap.uses, 0);
  });
});
