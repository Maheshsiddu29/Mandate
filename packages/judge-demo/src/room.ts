/**
 * The Mandate Room, narrated: the "breakout room" the agents enter.
 *
 * Read from one real `runMandateRoom` outcome — its rounds, releases,
 * decisions and the allocation log it handed the verifier. The Room has
 * zero authorization power, and the narration shows only operations it
 * actually has: accept, refuse, ask to reduce, apply a signed release,
 * reassign a released lot. A security-invalid proposal was refused at
 * screening and appears here only as absent: it never enters negotiation.
 */

import {
  addVectors,
  candidateDigest,
  releaseDigest,
  releaseSignedByAgent,
  validateResourceVector,
  type AllocationOp,
  type ResourceVector,
  type RoomOutcome,
} from '@mandate/portfolio';
import type { SceneContext } from './context.ts';
import { codesOf, reasonViews, type RunId } from './events.ts';
import { because } from './explain.ts';
import type { ProposalEntry } from './proposals.ts';

export const ROOM_CAN = ['ACCEPT', 'REJECT', 'ASK_TO_REDUCE', 'APPLY_SIGNED_RELEASE', 'REASSIGN_RELEASED_LOT'] as const;
export const ROOM_CANNOT = ['CREATE_AUTHORITY', 'WIDEN_A_CHILD', 'RAISE_A_LIMIT', 'APPROVE_A_VENUE', 'APPROVE_A_REPRESENTATION', 'CHANGE_A_CANDIDATE', 'MODIFY_THE_PRINCIPAL_POLICY'] as const;

export interface RoomNarration {
  readonly run: RunId;
  readonly time: bigint;
  readonly room: RoomOutcome;
  readonly entries: readonly ProposalEntry[];
}

/** The claims the room made for each committed proposal: the CLAIM ops it logged just before that COMMIT. */
export function claimsByCommit(log: readonly AllocationOp[]): ReadonlyMap<string, readonly Extract<AllocationOp, { kind: 'CLAIM' }>[]> {
  const out = new Map<string, Extract<AllocationOp, { kind: 'CLAIM' }>[]>();
  let pending: Extract<AllocationOp, { kind: 'CLAIM' }>[] = [];
  for (const op of log) {
    if (op.kind === 'CLAIM') pending.push(op);
    else if (op.kind === 'COMMIT') {
      out.set(op.id, pending);
      pending = [];
    }
  }
  return out;
}

export function emitRoom(x: SceneContext, n: RoomNarration): void {
  const { room, entries } = n;
  const time = n.time.toString();
  const negotiating = entries.filter((e) => e.verdict !== 'SECURITY_INVALID');
  const participants = x.ordered([...new Set([...negotiating.map((e) => e.agent), ...room.releases.map((r) => r.agent as string)])]);
  x.log.emit({
    kind: 'MANDATE_ROOM_OPENED',
    status: 'NEGOTIATING',
    run: n.run,
    protocolTime: time,
    message: `The Mandate Room opens with ${participants.map((a) => x.label(a)).join(', ')}. It has ZERO authorization power: it can only accept, refuse, ask to reduce, apply a signed release and reassign released allocation`,
    data: {
      participants: participants.map((a) => x.label(a)),
      rounds: room.rounds,
      can: [...ROOM_CAN],
      cannot: [...ROOM_CANNOT],
      excludedAtScreening: entries.filter((e) => e.verdict === 'SECURITY_INVALID').map((e) => e.digest),
    },
  });

  const claims = claimsByCommit(room.candidate.allocationLog);
  const lotSource = (lot: string): string | null => room.book.lots.find((l) => l.id === lot)?.from?.value ?? null;
  for (let round = 1; round <= room.rounds; round += 1) {
    for (const r of room.releases.filter((y) => y.round === round)) {
      const signed = room.signedReleases.find((s) => releaseDigest(s.release) === r.release);
      const amounts: ResourceVector = signed?.release.amounts ?? [];
      x.log.emit({
        kind: 'AGENT_RELEASED_AUTHORITY',
        status: r.applied ? 'RELEASED' : 'REFUSED',
        run: n.run,
        round,
        protocolTime: time,
        agent: x.agent(r.agent),
        approved: x.amounts(amounts),
        reasons: reasonViews(r.reasons),
        artifacts: [{ name: 'releaseDigest', value: r.release }],
        message: r.applied
          ? `${x.label(r.agent)} releases its unused allocation (${x.vector(amounts)}) with a signed release: it becomes a lot other agents may claim, exactly once`
          : `${x.label(r.agent)}'s release is refused: ${because(codesOf(r.reasons))}`,
        data: { applied: r.applied, sequence: signed?.release.sequence.toString() ?? null, signatureValid: signed === undefined ? false : releaseSignedByAgent(signed.release, signed.signature) },
      });
    }
    for (const d of room.decisions.filter((y) => y.round === round)) {
      const e = entries.find((y) => y.digest === d.proposal);
      if (e === undefined) throw new Error(`no proposal for decision ${d.proposal}`);
      if (e.verdict === 'SECURITY_INVALID') continue;
      const base = {
        run: n.run,
        round,
        protocolTime: time,
        agent: x.agent(e.agent),
        domain: x.domainOf(e.signed.proposal.candidate.kind),
        proposal: e.digest,
        candidate: candidateDigest(e.signed.proposal.candidate),
        requested: x.amounts(e.signed.proposal.requested),
        artifacts: [{ name: 'proposalDigest', value: e.digest }],
      };
      if (e.reduces !== null) {
        x.log.emit({
          ...base,
          kind: 'AGENT_PROPOSAL_REDUCED',
          status: 'REDUCED',
          message: `${x.label(e.agent)} signs a smaller proposal for the same target: ${x.money(e.reduces.signed.proposal.requested)} → ${x.money(e.signed.proposal.requested)}`,
          data: { reduces: e.reduces.digest, from: x.amounts(e.reduces.signed.proposal.requested), to: x.amounts(e.signed.proposal.requested), sequence: e.signed.proposal.sequence.toString() },
        });
      }
      if (d.outcome === 'REDUCE_REQUESTED') {
        x.log.emit({
          ...base,
          kind: 'AGENT_REDUCTION_REQUESTED',
          status: 'NEGOTIATING',
          reasons: reasonViews(d.reasons),
          approved: x.amounts(d.target),
          message: `Room → ${x.label(e.agent)}: reduce to at most ${x.vector(d.target)} — ${because(codesOf(d.reasons))}`,
          data: { target: x.amounts(d.target), demand: x.amounts(d.demand) },
        });
      } else if (d.outcome === 'ACCEPTED') {
        const mine = claims.get(e.digest) ?? [];
        for (const c of mine) {
          const from = lotSource(c.lot);
          const resource = room.book.lots.find((l) => l.id === c.lot)?.resource ?? 'unknown';
          const parsed = validateResourceVector([{ resource, atoms: c.amount }], 'claim');
          const v: ResourceVector = parsed.ok ? parsed.value : [];
          x.log.emit({
            ...base,
            kind: 'AUTHORITY_REALLOCATED',
            status: 'REALLOCATED',
            approved: x.amounts(v),
            message: `${x.label(e.agent)} claims ${x.money(v, resource)} of ${resource} from ${from === null ? 'the unallocated remainder of the portfolio limit' : `${x.label(from)}'s released lot`}`,
            data: { lot: c.lot, from: from === null ? null : x.label(from), claim: c.id, resource, atoms: c.amount.toString() },
          });
        }
        x.log.emit({
          ...base,
          kind: 'PROPOSAL_ACCEPTED',
          status: 'ACCEPTED',
          approved: x.amounts(d.demand),
          message: `Room accepts ${x.label(e.agent)}'s ${x.money(d.demand)}${mine.length === 0 ? ', inside its own allocation' : `, ${mine.length} claim${mine.length === 1 ? '' : 's'} on released or unallocated authority`} — accepted is not authorized`,
          data: { claims: mine.map((c) => c.id), authorized: false },
        });
      } else {
        // An admissible proposal the room could not fit at all. The deterministic scenario has none; narrating one would need a kind the contract does not have yet.
        throw new Error(`the room refused admissible proposal ${e.digest}: ${codesOf(d.reasons).join(', ')}`);
      }
    }
  }

  const accepted = entries.filter((e) => room.candidate.accepted.includes(e.digest));
  const total = accepted.reduce<ResourceVector>((v, e) => addVectors(v, e.decision.demand), []);
  x.log.emit({
    kind: 'MANDATE_ROOM_PROPOSED_PORTFOLIO',
    status: 'PROPOSED',
    run: n.run,
    protocolTime: time,
    approved: x.amounts(total),
    message: `The Room proposes a portfolio of ${accepted.length} action${accepted.length === 1 ? '' : 's'} totalling ${x.money(total)} — still NOT authorized: untrusted input to the Portfolio Verifier`,
    data: {
      accepted: accepted.map((e) => ({ agent: x.label(e.agent), proposal: e.digest, demand: x.amounts(e.decision.demand) })),
      allocationOps: room.candidate.allocationLog.length,
      rounds: room.rounds,
      authorized: false,
    },
  });
}
