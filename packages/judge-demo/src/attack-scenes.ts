/**
 * Scenes 6 and 7: a legitimately authenticated agent signs a prohibited
 * action; only that action is blocked.
 *
 * VALID AGENT != VALID ACTION. The compromised swap agent keeps its key,
 * identity, membership and delegation; the Mandate code refuses the action,
 * and the ledger — read before and after — shows nothing else moved.
 */

import { authorityId } from '@mandate/core';
import {
  agentPolicyOf,
  availabilityFrom,
  candidateDigest,
  proposalDigest,
  proposalSignedByAgent,
  reservationPhase,
  screenProposal,
  validateActionCandidate,
} from '@mandate/portfolio';
import type { SceneContext } from './context.ts';
import { codesOf, jsonOf, reasonViews } from './events.ts';
import { because, short } from './explain.ts';
import { changedFields, compliantSwap } from './malicious-agent.ts';
import { ATTACK_TIME, CONTINUATION_SWAP_ATOMS } from './scenario.ts';

export function emitAttack(x: SceneContext): void {
  const p = x.p;
  const id = p.compromised.party.value;
  const label = x.label(id);
  const policy = agentPolicyOf(x.m, p.compromised.party);
  if (policy === null) throw new Error(`${label} is not an agent of this mandate`);
  const time = ATTACK_TIME.toString();
  const delegation = p.core.compiled.delegations.get(id);
  const own = (p.initial.verification.status === 'VERIFIED' ? p.initial.verification.children : []).filter((c) => c.child.agent.value === id).flatMap((c) => {
    const record = p.initial.records.get(c.digest);
    return record === undefined ? [] : [record];
  });
  const earlier = p.initial.room.proposals.filter((s) => s.proposal.agent.value === id);
  const windowOpen = policy.notBefore <= ATTACK_TIME && ATTACK_TIME < policy.expiresAt;
  const before = p.afterReplay;
  const after = p.afterAttack;
  const headroomBefore = availabilityFrom(p.core.compiled, before, ATTACK_TIME).agents.get(id) ?? [];

  x.log.scene(6);
  x.log.emit({
    kind: 'AGENT_COMPROMISED',
    status: 'COMPROMISED',
    run: 'attack',
    protocolTime: time,
    agent: x.agent(id),
    domain: policy.scope.domains[0] ?? null,
    artifacts: delegation === undefined ? [] : [{ name: 'delegation', value: authorityId(delegation) }],
    message: `The ${label} agent is compromised. The attacker holds its real key: same identity, same Portfolio membership, same delegation, and its earlier reservation still active`,
    data: {
      identity: id,
      member: true,
      delegationWindowOpen: windowOpen,
      headroom: x.amounts(headroomBefore),
      proposalsSignedEarlier: earlier.map((s) => proposalDigest(s.proposal)),
      existingReservations: own.map((r) => ({ reservation: r.reservation, phase: reservationPhase(before.state, r.reservation) })),
    },
  });

  const signed = p.attack.room.proposals[0];
  const decision = p.attack.room.decisions[0];
  if (signed === undefined || decision === undefined) throw new Error('the attack run recorded no proposal');
  const digest = proposalDigest(signed.proposal);
  const attempted = signed.proposal.candidate;
  const reference = validateActionCandidate(compliantSwap(CONTINUATION_SWAP_ATOMS, ATTACK_TIME).at(CONTINUATION_SWAP_ATOMS));
  if (!reference.ok) throw new Error('the compliant reference swap does not validate');
  const changes = changedFields(reference.value, attempted, policy);
  const signatureValid = proposalSignedByAgent(signed.proposal, signed.signature);
  const sameIdentity = earlier.length > 0 && earlier.every((s) => s.proposal.agent.value === signed.proposal.agent.value);
  x.log.emit({
    kind: 'MALICIOUS_PROPOSAL_SIGNED',
    status: 'SIGNED',
    run: 'attack',
    round: decision.round,
    protocolTime: time,
    agent: x.agent(id),
    domain: x.domainOf(attempted.kind),
    proposal: digest,
    candidate: candidateDigest(attempted),
    requested: x.amounts(signed.proposal.requested),
    artifacts: [{ name: 'proposalDigest', value: digest }],
    message: `${label} signs, with its real key, the approved swap with one field changed: ${changes.map((c) => `${c.field} → ${typeof c.attempted === 'string' ? short(c.attempted) : JSON.stringify(c.attempted)}`).join(', ')}`,
    data: {
      signatureValid,
      sameIdentityAsEarlierProposals: sameIdentity,
      sequence: signed.proposal.sequence.toString(),
      agentKeySignatures: p.attackKeyUses.after - p.attackKeyUses.before,
      changedFields: changes.map((c) => ({ field: c.field, expected: c.expected, attempted: c.attempted })),
      candidate: jsonOf(attempted),
    },
  });

  const screening = screenProposal(x.m, p.core.compiled.bindings, signed, ATTACK_TIME);
  const backstop = p.attackBackstop;
  const codes = codesOf(decision.reasons);
  const blocked = decision.outcome === 'REJECTED' && screening.child === null;
  x.log.emit({
    kind: 'MALICIOUS_PROPOSAL_BLOCKED',
    status: blocked ? 'BLOCKED' : 'ACCEPTED',
    run: 'attack',
    round: decision.round,
    protocolTime: time,
    agent: x.agent(id),
    domain: x.domainOf(attempted.kind),
    proposal: digest,
    candidate: candidateDigest(attempted),
    requested: x.amounts(signed.proposal.requested),
    reasons: reasonViews(decision.reasons),
    artifacts: [{ name: 'proposalDigest', value: digest }, { name: 'receiptDigest', value: p.attack.digest }],
    message: blocked
      ? `agent signature VALID · agent identity VALID · capability ACTIVE · action UNAUTHORIZED: ${because(codes)}. Blocked before any reservation, attempt, key or transaction${backstop?.result.status === 'REFUSED' ? '; a compromised Room that accepted it anyway is refused by the verifier' : ''}`
      : `the attack was not blocked: room ${decision.outcome}`,
    data: {
      agentAuthentication: signatureValid && agentPolicyOf(x.m, signed.proposal.agent) !== null ? 'VALID' : 'INVALID',
      capability: delegation !== undefined && windowOpen ? 'ACTIVE' : 'INACTIVE',
      action: blocked ? 'UNAUTHORIZED' : 'AUTHORIZED',
      changedFields: changes.map((c) => ({ field: c.field, expected: c.expected, attempted: c.attempted })),
      roomOutcome: decision.outcome,
      screeningCodes: codesOf(screening.reasons),
      verifierBackstop: backstop === null ? null : { verdict: backstop.result.status, codes: backstop.result.status === 'REFUSED' ? codesOf(backstop.result.reasons) : [] },
      agentKeySignatures: p.attackKeyUses.after - p.attackKeyUses.before,
      executionsReachingASigner: p.attack.executions.length,
      reservationsWritten: after.state.reservations.size - before.state.reservations.size,
      attemptsWritten: after.state.attempts.size - before.state.attempts.size,
      ledgerVersionBefore: before.version.toString(),
      ledgerVersionAfter: after.version.toString(),
      transactions: p.attack.receipt.transactions,
    },
  });
}
