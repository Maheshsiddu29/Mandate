/**
 * Every signed proposal a Mandate Room saw, with the real screening verdict
 * and the room's real decision side by side.
 *
 * Screening is re-run here with `screenProposal` — the one rule the room and
 * the verifier share — at the room's own decision time, so the demo can say
 * *why* a proposal is blocked or admissible independently of how the room
 * allocated. If the room's decision and the screening disagree about a
 * security refusal, the demo refuses to narrate it: that would be a story
 * the protocol did not tell.
 */

import { candidateIdentity, proposalDigest, screenProposal, type DomainBinding, type PortfolioMandate, type ProposalDigest, type RoomDecision, type RoomOutcome, type Screening, type SignedProposal } from '@mandate/portfolio';
import { codesOf } from './events.ts';
import { verdictOf, type Verdict } from './explain.ts';

export interface ProposalEntry {
  readonly signed: SignedProposal;
  readonly digest: ProposalDigest;
  readonly agent: string;
  readonly decision: RoomDecision;
  readonly screening: Screening;
  readonly verdict: Verdict;
  /** The entry this one resizes after a `REDUCE_REQUESTED`: a negotiation move, not a new discovery. */
  readonly reduces: ProposalEntry | null;
}

const sameTarget = (a: SignedProposal, b: SignedProposal): boolean => {
  const x = candidateIdentity(a.proposal.candidate);
  const y = candidateIdentity(b.proposal.candidate);
  return a.proposal.candidate.kind === b.proposal.candidate.kind && x.representation === y.representation && x.venue === y.venue;
};

export function proposalEntries(m: PortfolioMandate, bindings: readonly DomainBinding[], room: RoomOutcome, now: bigint): readonly ProposalEntry[] {
  const out: ProposalEntry[] = [];
  const last = new Map<string, ProposalEntry>();
  for (const signed of room.proposals) {
    const digest = proposalDigest(signed.proposal);
    const agent = signed.proposal.agent.value;
    const decision = room.decisions.find((d) => d.proposal === digest);
    if (decision === undefined) throw new Error(`the room recorded no decision for ${digest}`);
    const screening = screenProposal(m, bindings, signed, now);
    const verdict = verdictOf(screening);
    if (verdict === 'SECURITY_INVALID') {
      const same = decision.outcome === 'REJECTED' && codesOf(decision.reasons).sort().join() === codesOf(screening.reasons).sort().join();
      if (!same) throw new Error(`screening and the room disagree on ${digest}`);
    } else if (decision.outcome === 'REJECTED' && decision.reasons.some((r) => r.code !== 'ALLOCATION_INSUFFICIENT' && !screening.reasons.some((s) => s.code === r.code))) {
      throw new Error(`the room refused an admissible proposal for a reason screening does not give: ${digest}`);
    }
    const previous = last.get(agent);
    const reduces = previous !== undefined && previous.decision.outcome === 'REDUCE_REQUESTED' && sameTarget(previous.signed, signed) ? previous : null;
    const entry: ProposalEntry = { signed, digest, agent, decision, screening, verdict, reduces };
    out.push(entry);
    last.set(agent, entry);
  }
  return out;
}
