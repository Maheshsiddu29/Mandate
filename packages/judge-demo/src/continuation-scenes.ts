/**
 * Scenes 7–9: after the attack, the portfolio carries on.
 *
 * Scene 7 reads the ledger after the refused attack and reports it as it is.
 * Scene 8 runs the compromised agent's own compliant swap through the full
 * path. Scene 9 is a different class of problem: an individually valid
 * request that the portfolio, as a whole, can no longer fully give.
 */

import {
  agentPolicyOf,
  amountOf,
  availabilityFrom,
  candidateDigest,
  checkChildAuthorization,
  proposalDigest,
  proposalSignedByAgent,
  reservationPhase,
  screenProposal,
  vectorsEqual,
} from '@mandate/portfolio';
import type { SceneContext } from './context.ts';
import { codesOf, jsonOf, type Json } from './events.ts';
import { changedFields } from './malicious-agent.ts';
import { proposalEntries } from './proposals.ts';
import { emitRoom } from './room.ts';
import { ATTACK_TIME, COMPLIANT_TIME } from './scenario.ts';
import { emitVerification } from './verification.ts';

/** Scene 7: block the bad action, not the healthy portfolio. Every value is read from the ledger after the attack. */
export function emitFaultIsolation(x: SceneContext): void {
  const p = x.p;
  const before = p.afterReplay;
  const after = p.afterAttack;
  const children = p.initial.verification.status === 'VERIFIED' ? p.initial.verification.children : [];
  const availBefore = availabilityFrom(p.core.compiled, before, ATTACK_TIME);
  const availAfter = availabilityFrom(p.core.compiled, after, ATTACK_TIME);
  const receiptStatus = new Map<string, string>(p.initial.receipt.agents.map((a) => [a.agent, a.status]));
  const reservations = children.map((v) => {
    const record = p.initial.records.get(v.digest);
    const execution = p.initial.executions.find((e) => e.child === v.digest);
    return {
      agent: x.label(v.child.agent.value),
      child: v.digest,
      reservation: record?.reservation ?? null,
      phase: record === undefined ? 'UNKNOWN' : reservationPhase(after.state, record.reservation),
      childIntact: checkChildAuthorization(x.m, v.child).length === 0,
      execution: execution?.status ?? null,
      evidence: execution?.evidence ?? null,
    };
  });
  const live = reservations.filter((r) => r.phase === 'RESERVED' || r.phase === 'ADMITTED');
  const members = new Map<string, (typeof x.m.agents)[number]>(x.m.agents.map((a) => [a.agent.value, a]));
  const agents = x.ordered([...members.keys()]).map((id) => {
    const policy = members.get(id) ?? null;
    const b = availBefore.agents.get(id) ?? [];
    const a = availAfter.agents.get(id) ?? [];
    return {
      agent: x.label(id),
      member: policy !== null,
      status: receiptStatus.get(id) ?? null,
      compromised: id === p.compromised.party.value,
      reservations: reservations.filter((r) => r.agent === x.label(id)).map((r) => r.phase),
      headroomUnchanged: vectorsEqual(b, a),
    };
  });
  const unchanged = before.version === after.version && vectorsEqual(availBefore.reserved, availAfter.reserved);
  x.log.scene(7);
  x.log.emit({
    kind: 'HEALTHY_AGENTS_UNAFFECTED',
    status: unchanged && live.length === reservations.length ? 'ACTIVE' : 'REFUSED',
    run: 'attack',
    protocolTime: ATTACK_TIME.toString(),
    approved: x.amounts(availAfter.reserved.filter((r) => r.atoms > 0n)),
    message: `BLOCK THE BAD ACTION, NOT THE HEALTHY PORTFOLIO: ${live.length} of ${reservations.length} reservations still live in the ledger (${reservations.map((r) => `${r.agent} ${r.phase}`).join(', ')}), ${x.money(availAfter.reserved)} still reserved, ledger version ${before.version} → ${after.version}`,
    data: {
      ledgerVersionBefore: before.version.toString(),
      ledgerVersionAfter: after.version.toString(),
      reservedBefore: x.amounts(availBefore.reserved),
      reservedAfter: x.amounts(availAfter.reserved),
      availableAfter: x.amounts(availAfter.portfolio),
      reservations,
      agents,
    },
  });
}

/** Scene 8: the same key signs the compliant action; the full path authorizes it. */
export function emitCompliant(x: SceneContext): void {
  const p = x.p;
  const run = p.compliant;
  const signed = run.room.proposals[0];
  const attack = p.attack.room.proposals[0];
  if (signed === undefined || attack === undefined) throw new Error('the compliant run recorded no proposal');
  const id = signed.proposal.agent.value;
  const policy = agentPolicyOf(x.m, signed.proposal.agent);
  if (policy === null) throw new Error('the compliant proposal names no agent of this mandate');
  const digest = proposalDigest(signed.proposal);
  const time = COMPLIANT_TIME.toString();
  const screening = screenProposal(x.m, p.core.compiled.bindings, signed, COMPLIANT_TIME);
  const differs = changedFields(attack.proposal.candidate, signed.proposal.candidate, policy);
  const attempted = jsonOf(attack.proposal.candidate) as { readonly [field: string]: Json };
  const sameKey = attack.proposal.agent.value === id && p.compliantKeyUses.before === p.attackKeyUses.after;

  x.log.scene(8);
  x.log.emit({
    kind: 'COMPLIANT_PROPOSAL_SIGNED',
    status: 'SIGNED',
    run: 'compliant',
    round: 1,
    protocolTime: time,
    agent: x.agent(id),
    domain: x.domainOf(signed.proposal.candidate.kind),
    proposal: digest,
    candidate: candidateDigest(signed.proposal.candidate),
    requested: x.amounts(signed.proposal.requested),
    artifacts: [{ name: 'proposalDigest', value: digest }],
    message: `The same ${x.label(id)} key — not a replacement agent — signs the swap paying the principal; it differs from the blocked attempt in: ${differs.map((d) => d.field).join(', ')}`,
    data: {
      signatureValid: proposalSignedByAgent(signed.proposal, signed.signature),
      sameIdentityAsAttack: attack.proposal.agent.value === id,
      sameKeyObject: sameKey,
      agentKeyUsesSoFar: p.compliantKeyUses.after,
      sequence: signed.proposal.sequence.toString(),
      attackSequence: attack.proposal.sequence.toString(),
      differsFromBlockedAttempt: differs.map((d) => ({ field: d.field, blocked: attempted[d.field] ?? null, now: d.attempted, permitted: d.expected })),
      screeningCodes: codesOf(screening.reasons),
    },
  });

  const entries = proposalEntries(x.m, p.core.compiled.bindings, run.room, COMPLIANT_TIME);
  emitRoom(x, { run: 'compliant', time: COMPLIANT_TIME, room: run.room, entries });
  emitVerification(x, { run: 'compliant', time: COMPLIANT_TIME, result: run, requested: signed.proposal.requested, ledgerBefore: p.afterAttack, ledgerAfter: p.afterCompliant, forgery: null });

  const reserved = run.reservations.filter((r) => r.status === 'RESERVED');
  const execution = run.executions[0];
  const authorized = run.verification.status === 'VERIFIED' && reserved.length === 1;
  x.log.emit({
    kind: 'COMPLIANT_PROPOSAL_AUTHORIZED',
    status: authorized ? 'AUTHORIZED' : 'REFUSED',
    run: 'compliant',
    protocolTime: time,
    agent: x.agent(id),
    domain: x.domainOf(signed.proposal.candidate.kind),
    proposal: digest,
    approved: authorized ? x.amounts(signed.proposal.requested) : [],
    evidence: execution?.evidence ?? null,
    artifacts: [{ name: 'proposalDigest', value: digest }, { name: 'receiptDigest', value: run.digest }],
    message: authorized
      ? `authentication VALID · action VALID · portfolio constraints VALID → AUTHORIZED. ${x.money(run.after.reserved)} of ${x.money(x.m.limits)} now reserved; execution ${execution?.evidence ?? 'none'} (fixture venue), ${run.receipt.transactions} transactions`
      : 'the compliant action was not authorized',
    data: {
      authentication: proposalSignedByAgent(signed.proposal, signed.signature) ? 'VALID' : 'INVALID',
      action: screening.reasons.length === 0 ? 'VALID' : 'INVALID',
      portfolio: authorized ? 'VALID' : 'INVALID',
      executionStatus: execution?.status ?? null,
      integrationEvidence: execution?.integrationEvidence ?? null,
      reservedAfter: x.amounts(run.after.reserved.filter((r) => r.atoms > 0n)),
      availableAfter: amountOf(run.after.portfolio, 'portfolio-notional').toString(),
      transactions: run.receipt.transactions,
    },
  });
}
