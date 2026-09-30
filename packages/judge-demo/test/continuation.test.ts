/**
 * Scenes 7–8: after the refused attack the healthy portfolio is exactly
 * where it was, and the same agent key can still act — compliantly —
 * through the full path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { actionId } from '@mandate/core';
import { amountOf, checkChildAuthorization, compileAction, proposalSignedByAgent, reservationPhase, screenProposal } from '@mandate/portfolio';
import { PRINCIPAL_ON_ARBITRUM, USDC } from '@mandate/portfolio/demo';
import { COMPLIANT_TIME, runJudgeDemo, type JudgeEvent } from '../src/index.ts';

const demo = runJudgeDemo();
const one = (events: readonly JudgeEvent[], kind: string): JudgeEvent => {
  const found = events.filter((e) => e.kind === kind);
  assert.equal(found.length, 1, kind);
  return found[0] as JudgeEvent;
};

describe('scene 7: fault isolation', () => {
  it('every healthy reservation is still live in the ledger after the attack, and nothing moved', async () => {
    const { protocol } = await demo;
    const v = protocol.initial.verification;
    assert.ok(v.status === 'VERIFIED');
    for (const c of v.children) {
      const record = protocol.initial.records.get(c.digest);
      assert.ok(record !== undefined);
      const phase = reservationPhase(protocol.afterAttack.state, record.reservation);
      assert.ok(phase === 'RESERVED' || phase === 'ADMITTED', phase);
      assert.equal(protocol.afterAttack.state.reservations.get(record.reservation)?.status, 'ACTIVE');
      assert.deepEqual(checkChildAuthorization(protocol.mandate, c.child), []);
    }
    assert.equal(protocol.afterAttack.version, protocol.afterReplay.version);
  });

  it('the event reports exactly that, per agent, including the compromised agent’s own earlier reservation', async () => {
    const { transcript } = await demo;
    const e = one(transcript.events, 'HEALTHY_AGENTS_UNAFFECTED');
    assert.equal(e.status, 'ACTIVE');
    assert.equal(e.scene, 7);
    assert.equal(e.data['ledgerVersionBefore'], e.data['ledgerVersionAfter']);
    const agents = e.data['agents'] as readonly { agent: string; member: boolean; status: string; compromised: boolean; reservations: readonly string[]; headroomUnchanged: boolean }[];
    assert.deepEqual(agents.map((a) => a.agent), ['stock', 'swap', 'nft', 'yield', 'perps']);
    for (const a of agents) {
      assert.equal(a.member, true);
      assert.equal(a.headroomUnchanged, true, a.agent);
    }
    assert.deepEqual(agents.find((a) => a.agent === 'swap'), { agent: 'swap', member: true, status: 'SETTLED', compromised: true, reservations: ['ADMITTED'], headroomUnchanged: true });
    assert.deepEqual(agents.find((a) => a.agent === 'nft')?.reservations, []);
    assert.equal((e.data['reservedAfter'] as readonly { resource: string; atoms: string }[]).find((a) => a.resource === 'portfolio-notional')?.atoms, USDC(1_900n).toString());
  });
});

describe('scene 8: the same agent, a compliant action', () => {
  it('is signed by the same identity object — the same key — as the attack', async () => {
    const { protocol } = await demo;
    const attack = protocol.attack.room.proposals[0];
    const honest = protocol.compliant.room.proposals[0];
    assert.ok(attack !== undefined && honest !== undefined);
    assert.equal(honest.proposal.agent.value, attack.proposal.agent.value);
    assert.equal(honest.proposal.agent.value, protocol.compromised.party.value);
    assert.deepEqual(protocol.compliantKeyUses, { before: 1, after: 2 });
    assert.equal(proposalSignedByAgent(honest.proposal, honest.signature), true);
    assert.ok(honest.proposal.sequence > attack.proposal.sequence);
    assert.ok(honest.proposal.candidate.kind === 'SWAP_EXACT_IN' && honest.proposal.candidate.recipient === PRINCIPAL_ON_ARBITRUM);
  });

  it('passes screening, the Room, the verifier and the ledger: 50 more reserved, a new Core action', async () => {
    const { protocol, transcript } = await demo;
    const run = protocol.compliant;
    const honest = run.room.proposals[0];
    assert.ok(honest !== undefined);
    assert.deepEqual(screenProposal(protocol.mandate, protocol.core.compiled.bindings, honest, COMPLIANT_TIME).reasons, []);
    assert.deepEqual(run.room.decisions.map((d) => d.outcome), ['ACCEPTED']);
    assert.equal(run.verification.status, 'VERIFIED');
    assert.deepEqual(run.reservations.map((r) => r.status), ['RESERVED']);
    assert.equal(amountOf(run.after.reserved, 'portfolio-notional') - amountOf(run.before.reserved, 'portfolio-notional'), USDC(50n));
    assert.equal(amountOf(run.after.reserved, 'portfolio-notional'), USDC(1_950n));
    assert.equal(protocol.afterCompliant.state.reservations.size, protocol.afterAttack.state.reservations.size + 1);
    const earlier = new Set([...protocol.initial.records.values()].map((r) => r.actionId));
    const v = run.verification;
    assert.ok(v.status === 'VERIFIED');
    const c = v.children[0];
    assert.ok(c !== undefined);
    const compiled = compileAction(protocol.core.compiled, c.child, c.candidate);
    assert.ok(compiled.ok && !earlier.has(actionId(compiled.value.envelope)));
    assert.deepEqual(run.executions.map((e) => [e.status, e.evidence, e.transactions]), [['SETTLED', 'SIMULATED', 0]]);

    const e = one(transcript.events, 'COMPLIANT_PROPOSAL_AUTHORIZED');
    assert.deepEqual([e.status, e.data['authentication'], e.data['action'], e.data['portfolio'], e.evidence], ['AUTHORIZED', 'VALID', 'VALID', 'VALID', 'SIMULATED']);
    const signed = one(transcript.events, 'COMPLIANT_PROPOSAL_SIGNED');
    assert.equal(signed.data['sameKeyObject'], true);
    assert.ok((signed.data['differsFromBlockedAttempt'] as readonly { field: string }[]).some((d) => d.field === 'recipient'));
    assert.ok(transcript.events.filter((x) => x.run === 'compliant').every((x) => x.status !== 'BLOCKED'));
  });
});
