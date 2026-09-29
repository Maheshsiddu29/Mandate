/**
 * The Portfolio Verifier (portfolio-mandate.md §11).
 *
 * Pure and total. It trusts nothing the Mandate Room produced — not its
 * screening, not its allocation, not its arithmetic — and re-derives it all
 * from the principal's signed mandate, the agents' signed messages, the
 * domain bindings and the ledger's availability:
 *
 * 1. the mandate: principal signature, validity, window;
 * 2. the candidate names this mandate, each accepted proposal once, and
 *    every accepted proposal is supplied;
 * 3. every accepted proposal passes the same screening the room uses
 *    (screen.ts), and per agent their sequences strictly increase;
 * 4. the allocation log replays from the mandate's initial book under the
 *    book's own rules; every release in it is one the agent signed; every
 *    accepted proposal is committed exactly once, for exactly its derived
 *    demand, and nothing else is committed;
 * 5. what is approved fits what the ledger still has room for, per resource
 *    and per agent;
 * 6. every child authorization is ⊆ its agent ⊆ the portfolio.
 *
 * Its output — the child authorizations, in canonical order — is still only
 * an input to Core: the ledger re-checks every limit at reservation.
 */

import { replayAllocation, checkBookInvariant, type AllocationBook } from './allocation.ts';
import { headroom, type ResourceAvailability } from './availability.ts';
import type { DomainBinding, RepresentationDecisionRecord } from './binding.ts';
import type { ActionCandidate } from './candidate.ts';
import { checkChildAuthorization, childAuthorizationDigest, type ChildAuthorizationDigest, type ChildExecutionAuthorization } from './child.ts';
import { portfolioMandateDigest, type PortfolioMandate } from './mandate.ts';
import { proposalDigest, type ProposalDigest, type SignedProposal } from './proposal.ts';
import { canonicalReasons, reason, type Reason } from './reasons.ts';
import { releaseDigest, releaseSignedByAgent, type SignedRelease } from './release.ts';
import { addVectors, amountOf, vectorsEqual, type ResourceVector } from './resources.ts';
import { mandateReasons, type PortfolioCandidate } from './room.ts';
import { screenProposal } from './screen.ts';

export interface VerifierInput {
  readonly mandate: PortfolioMandate;
  readonly signature: string;
  readonly bindings: readonly DomainBinding[];
  readonly availability: ResourceAvailability;
  readonly now: bigint;
  readonly candidate: PortfolioCandidate;
  /** Signed proposals; must include every accepted one. Others are ignored. */
  readonly proposals: readonly SignedProposal[];
  /** Signed releases; must include every release the allocation log applies. */
  readonly releases: readonly SignedRelease[];
}

export interface VerifiedChild {
  readonly child: ChildExecutionAuthorization;
  readonly digest: ChildAuthorizationDigest;
  readonly candidate: ActionCandidate;
  readonly proposal: ProposalDigest;
  readonly registry: RepresentationDecisionRecord | null;
}

export type VerifierResult =
  | { readonly status: 'VERIFIED'; readonly children: readonly VerifiedChild[]; readonly book: AllocationBook; readonly approved: ResourceVector }
  | { readonly status: 'REFUSED'; readonly reasons: readonly Reason[] };

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function verifyPortfolio(input: VerifierInput): VerifierResult {
  const m = input.mandate;
  const refuse = (reasons: readonly Reason[]): VerifierResult => ({ status: 'REFUSED', reasons: canonicalReasons(reasons) });

  const mandate = mandateReasons(m, input.signature, input.now);
  if (mandate.length > 0) return refuse(mandate);
  const c = input.candidate;
  if (c.portfolioMandate !== portfolioMandateDigest(m)) return refuse([reason('PORTFOLIO_MANDATE_DIGEST_MISMATCH', 'candidate')]);

  const found: Reason[] = [];
  const accepted = new Set<string>();
  for (const d of c.accepted) {
    if (accepted.has(d)) found.push(reason('CANDIDATE_PROPOSAL_DUPLICATED', d));
    accepted.add(d);
  }
  const byDigest = new Map<string, SignedProposal>();
  for (const s of input.proposals) byDigest.set(proposalDigest(s.proposal), s);

  // 3. Every accepted proposal, re-screened by the room's own rule.
  const children: VerifiedChild[] = [];
  const demands = new Map<string, ResourceVector>();
  const lastSequence = new Map<string, bigint>();
  const inOrder = [...accepted].map((d) => byDigest.get(d)).filter((s): s is SignedProposal => s !== undefined).sort((a, b) => (a.proposal.sequence < b.proposal.sequence ? -1 : a.proposal.sequence > b.proposal.sequence ? 1 : byText(proposalDigest(a.proposal), proposalDigest(b.proposal))));
  for (const d of accepted) if (!byDigest.has(d)) found.push(reason('CANDIDATE_PROPOSAL_UNKNOWN', d));
  for (const signed of inOrder) {
    const d = proposalDigest(signed.proposal);
    const agent = signed.proposal.agent.value;
    const last = lastSequence.get(agent);
    if (last !== undefined && signed.proposal.sequence <= last) found.push(reason('PROPOSAL_REPLAYED', d));
    lastSequence.set(agent, signed.proposal.sequence);
    const s = screenProposal(m, input.bindings, signed, input.now);
    if (s.child === null) {
      for (const r of s.reasons) found.push(reason(r.code, r.subject === '' ? d : `${d}/${r.subject}`));
      continue;
    }
    demands.set(d, s.demand);
    children.push({ child: s.child, digest: childAuthorizationDigest(s.child), candidate: signed.proposal.candidate, proposal: d as ProposalDigest, registry: s.registry });
  }

  // 4. The allocation, replayed under the book's own rules — never taken from the room.
  const replay = replayAllocation(m, c.allocationLog);
  if (!replay.ok) return refuse([...found, reason('CANDIDATE_BOOK_MISMATCH', `log[${replay.error.index}]:${replay.error.reason.code}`)]);
  const book = replay.value;
  found.push(...checkBookInvariant(m, book));
  const signedReleases = new Map<string, SignedRelease>();
  for (const s of input.releases) signedReleases.set(`release/${releaseDigest(s.release)}`, s);
  const committed = new Map<string, number>();
  for (const op of c.allocationLog) {
    if (op.kind === 'RELEASE') {
      const s = signedReleases.get(op.id);
      const genuine = s !== undefined && s.release.agent.value === op.agent.value && s.release.portfolioMandate === c.portfolioMandate && vectorsEqual(s.release.amounts, op.amounts) && releaseSignedByAgent(s.release, s.signature);
      if (!genuine) found.push(reason('CANDIDATE_BOOK_MISMATCH', `release-unsigned:${op.id}`));
    }
    if (op.kind === 'COMMIT') {
      committed.set(op.id, (committed.get(op.id) ?? 0) + 1);
      const signed = byDigest.get(op.id);
      const demand = demands.get(op.id);
      if (!accepted.has(op.id) || signed === undefined) found.push(reason('CANDIDATE_BOOK_MISMATCH', `commit-not-accepted:${op.id}`));
      else if (signed.proposal.agent.value !== op.agent.value) found.push(reason('CANDIDATE_BOOK_MISMATCH', `commit-agent:${op.id}`));
      else if (demand !== undefined && !vectorsEqual(demand, op.amounts)) found.push(reason('CANDIDATE_BOOK_MISMATCH', `commit-amount:${op.id}`));
    }
  }
  for (const d of accepted) if (committed.get(d) !== 1) found.push(reason('CANDIDATE_BOOK_MISMATCH', `commit-missing:${d}`));

  // 5. What the ledger still has room for, per resource and per agent.
  let approved: ResourceVector = [];
  const perAgent = new Map<string, ResourceVector>();
  for (const x of children) {
    approved = addVectors(approved, x.child.approved);
    perAgent.set(x.child.agent.value, addVectors(perAgent.get(x.child.agent.value) ?? [], x.child.approved));
  }
  for (const a of approved) if (a.atoms > amountOf(input.availability.portfolio, a.resource)) found.push(reason('PORTFOLIO_LIMIT_EXCEEDED', a.resource));
  for (const [agent, v] of perAgent) for (const a of v) if (a.atoms > headroom(input.availability, agent, a.resource)) found.push(reason('AGENT_LIMIT_EXCEEDED', `${agent}/${a.resource}`));

  // 6. Every child ⊆ its agent ⊆ the portfolio, by the same rule anyone can re-run later.
  for (const x of children) for (const r of checkChildAuthorization(m, x.child)) found.push(reason(r.code, `${x.digest}/${r.subject}`));

  if (found.length > 0) return refuse(found);
  return { status: 'VERIFIED', children: [...children].sort((a, b) => byText(a.digest, b.digest)), book, approved };
}

/** The set of child digests a verification produced: the only children `checkBeforeSign` will accept. */
export function verifiedDigests(r: VerifierResult): ReadonlySet<ChildAuthorizationDigest> {
  return new Set(r.status === 'VERIFIED' ? r.children.map((c) => c.digest) : []);
}
