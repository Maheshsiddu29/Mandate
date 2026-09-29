/**
 * The Mandate Room (portfolio-mandate.md §10).
 *
 * A pure, deterministic, offchain coordination function. **It has no
 * authority**: its output — a `PortfolioCandidate` — is untrusted input to
 * the Portfolio Verifier, which re-derives all of it.
 *
 * ```text
 * room(mandate, signature, bindings, availability, now, agents), at most maxRounds:
 *   refuse outright unless the principal signed a valid, current mandate
 *   each round:
 *     1. every agent strategy returns PROPOSE(signed proposal) | RELEASE(signed release) | IDLE
 *     2. apply releases, in agent order: each becomes a lot
 *     3. screen proposals (screen.ts): authentication, replay, form, identity, honesty, authority
 *     4. accept, in digest order, every proposal its agent's unused allocation already covers
 *     5. then, by (utility desc, digest asc): claim from lots up to the agent's cap → ACCEPTED,
 *        or REDUCE_REQUESTED with the most it could obtain, or REJECTED
 *     6. tell each agent what happened to its messages
 *   stop after a round in which every agent is IDLE
 * ```
 *
 * What the room *can* do is exactly the allocation book's operations: accept,
 * refuse, ask to reduce, apply a release, reassign a released lot. It has no
 * operation that widens a limit, adds an asset, issuer, venue or
 * representation, fabricates state, edits a candidate or skips a check.
 * `utilityBps` is the agent's own ranking metadata: it orders claims on
 * released allocation between agents and can win an agent a larger share
 * inside its cap and the portfolio limit — never more. Input order never
 * changes the outcome: messages are processed in canonical order.
 */

import type { Identifier } from '@mandate/kernel';
import { applyAllocation, initialBook, obtainable, planClaims, type AllocationBook, type AllocationOp } from './allocation.ts';
import { checkPortfolioMandate } from './authority.ts';
import { headroom, type ResourceAvailability } from './availability.ts';
import type { DomainBinding, RepresentationDecisionRecord } from './binding.ts';
import { agentPolicyOf, mandateSignedByPrincipal, portfolioMandateDigest, type PortfolioMandate, type PortfolioMandateDigest } from './mandate.ts';
import { proposalDigest, type ProposalDigest, type SignedProposal } from './proposal.ts';
import { canonicalReasons, reason, type Reason } from './reasons.ts';
import { releaseDigest, releaseSignedByAgent, type ReleaseDigest, type SignedRelease } from './release.ts';
import { addVectors, amountOf, compareResourceIds, type ResourceAmount, type ResourceVector } from './resources.ts';
import { screenProposal } from './screen.ts';

export const DEFAULT_MAX_ROUNDS = 8;

export type AgentMessage =
  | { readonly kind: 'PROPOSE'; readonly signed: SignedProposal }
  | { readonly kind: 'RELEASE'; readonly signed: SignedRelease }
  | { readonly kind: 'IDLE' };

export type DecisionOutcome = 'ACCEPTED' | 'REJECTED' | 'REDUCE_REQUESTED';

export interface RoomDecision {
  readonly round: number;
  readonly agent: Identifier;
  readonly proposal: ProposalDigest;
  readonly outcome: DecisionOutcome;
  readonly reasons: readonly Reason[];
  /** For `REDUCE_REQUESTED`: the most the agent could obtain now, per resource of the demand. Otherwise empty. */
  readonly target: ResourceVector;
  /** The derived demand; empty when identity did not resolve. */
  readonly demand: ResourceVector;
  readonly registry: RepresentationDecisionRecord | null;
}

export interface ReleaseDecision {
  readonly round: number;
  readonly agent: Identifier;
  readonly release: ReleaseDigest;
  readonly applied: boolean;
  readonly reasons: readonly Reason[];
}

export interface RoomFeedback {
  readonly decisions: readonly RoomDecision[];
  readonly releases: readonly ReleaseDecision[];
}

/** An agent: deterministic, driven only by its own feedback. The room never sees its reasoning. */
export interface AgentStrategy {
  readonly agent: { readonly kind: string; readonly value: string };
  act(round: number, feedback: RoomFeedback): AgentMessage;
}

export interface RoomInput {
  readonly mandate: PortfolioMandate;
  /** The principal's signature over the mandate digest. */
  readonly signature: string;
  readonly bindings: readonly DomainBinding[];
  readonly availability: ResourceAvailability;
  readonly now: bigint;
  readonly agents: readonly AgentStrategy[];
  readonly maxRounds?: number;
}

/** What the room hands the verifier. Untrusted. */
export interface PortfolioCandidate {
  readonly portfolioMandate: PortfolioMandateDigest;
  /** Canonical order: ascending digest. */
  readonly accepted: readonly ProposalDigest[];
  /** The allocation operations, in the order the room applied them. */
  readonly allocationLog: readonly AllocationOp[];
}

export interface RoomOutcome {
  readonly status: 'COMPLETE' | 'REFUSED';
  /** Why the room would not run at all (the mandate); empty when it ran. */
  readonly reasons: readonly Reason[];
  readonly rounds: number;
  readonly decisions: readonly RoomDecision[];
  readonly releases: readonly ReleaseDecision[];
  /** Every signed proposal the room saw, in the order it screened them. */
  readonly proposals: readonly SignedProposal[];
  readonly signedReleases: readonly SignedRelease[];
  readonly book: AllocationBook;
  readonly candidate: PortfolioCandidate;
}

/** A mandate the room may coordinate under at `now`: principal-signed, valid, current. Every reason otherwise. */
export function mandateReasons(m: PortfolioMandate, signature: string, now: bigint): readonly Reason[] {
  const found: Reason[] = [];
  if (!mandateSignedByPrincipal(m, signature)) found.push(reason('PORTFOLIO_MANDATE_SIGNATURE_INVALID'));
  if (now < m.notBefore) found.push(reason('PORTFOLIO_MANDATE_NOT_YET_VALID'));
  if (now >= m.expiresAt) found.push(reason('PORTFOLIO_MANDATE_EXPIRED'));
  found.push(...checkPortfolioMandate(m));
  return canonicalReasons(found);
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Screened {
  readonly signed: SignedProposal;
  readonly digest: ProposalDigest;
  readonly agent: Identifier;
  readonly reasons: readonly Reason[];
  readonly quantityOnly: boolean;
  readonly demand: ResourceVector;
  readonly registry: RepresentationDecisionRecord | null;
}

export function runMandateRoom(input: RoomInput): RoomOutcome {
  const m = input.mandate;
  const digest = portfolioMandateDigest(m);
  const empty: RoomOutcome = { status: 'REFUSED', reasons: [], rounds: 0, decisions: [], releases: [], proposals: [], signedReleases: [], book: initialBook(m), candidate: { portfolioMandate: digest, accepted: [], allocationLog: [] } };
  const refusal = mandateReasons(m, input.signature, input.now);
  if (refusal.length > 0) return { ...empty, reasons: refusal };

  let book = initialBook(m);
  const decisions: RoomDecision[] = [];
  const releases: ReleaseDecision[] = [];
  const proposals: SignedProposal[] = [];
  const signedReleases: SignedRelease[] = [];
  const accepted: ProposalDigest[] = [];
  const seen = new Set<string>();
  const proposalSequence = new Map<string, bigint>();
  const releaseSequence = new Map<string, bigint>();
  /** What this run has accepted, per agent and in total: capped again by what the ledger still has room for. */
  let acceptedTotal: ResourceVector = [];
  const acceptedBy = new Map<string, ResourceVector>();
  const feedback = new Map<string, RoomFeedback>();
  const agents = [...input.agents].sort((a, b) => byText(a.agent.value, b.agent.value));
  const maxRounds = input.maxRounds ?? DEFAULT_MAX_ROUNDS;
  let rounds = 0;

  for (let round = 1; round <= maxRounds; round += 1) {
    const messages = agents.map((a) => ({ agent: a.agent.value, message: a.act(round, feedback.get(a.agent.value) ?? { decisions: [], releases: [] }) }));
    if (messages.every((x) => x.message.kind === 'IDLE')) break;
    rounds = round;
    const roundDecisions: RoomDecision[] = [];
    const roundReleases: ReleaseDecision[] = [];

    // 2. Releases first, so what an agent gives back this round can be reassigned this round.
    for (const { agent, message } of messages) {
      if (message.kind !== 'RELEASE') continue;
      const r = message.signed.release;
      signedReleases.push(message.signed);
      const id = releaseDigest(r);
      const found: Reason[] = [];
      if (r.agent.value !== agent) found.push(reason('AGENT_SIGNATURE_INVALID', agent));
      if (r.portfolioMandate !== digest) found.push(reason('PORTFOLIO_MANDATE_DIGEST_MISMATCH'));
      if (agentPolicyOf(m, r.agent) === null) found.push(reason('AGENT_UNKNOWN', r.agent.value));
      else if (!releaseSignedByAgent(r, message.signed.signature)) found.push(reason('AGENT_SIGNATURE_INVALID', r.agent.value));
      const last = releaseSequence.get(r.agent.value);
      if (last !== undefined && r.sequence <= last) found.push(reason('RELEASE_ALREADY_APPLIED', `sequence:${r.sequence}`));
      let applied = false;
      if (found.length === 0) {
        const next = applyAllocation(m, book, { kind: 'RELEASE', agent: r.agent, id: `release/${id}` as Identifier, amounts: r.amounts });
        if (next.ok) {
          book = next.value;
          applied = true;
          releaseSequence.set(r.agent.value, r.sequence);
        } else found.push(next.error);
      }
      roundReleases.push({ round, agent: r.agent.value as Identifier, release: id, applied, reasons: canonicalReasons(found) });
    }

    // 3. Screen, in digest order: arrival order never matters.
    const screened: Screened[] = [];
    const incoming = messages.flatMap((x) => (x.message.kind === 'PROPOSE' ? [{ agent: x.agent, signed: x.message.signed }] : []));
    incoming.sort((a, b) => byText(proposalDigest(a.signed.proposal), proposalDigest(b.signed.proposal)));
    for (const { agent, signed } of incoming) {
      proposals.push(signed);
      const d = proposalDigest(signed.proposal);
      const s = screenProposal(m, input.bindings, signed, input.now);
      const extra: Reason[] = [];
      if (signed.proposal.agent.value !== agent) extra.push(reason('AGENT_SIGNATURE_INVALID', agent));
      // Replay: a digest seen before, or a sequence not above the agent's last authenticated one.
      const authenticated = !s.reasons.some((r) => r.code === 'AGENT_UNKNOWN' || r.code === 'AGENT_SIGNATURE_INVALID' || r.code === 'PORTFOLIO_MANDATE_DIGEST_MISMATCH');
      const last = proposalSequence.get(signed.proposal.agent.value);
      if (seen.has(d) || (authenticated && last !== undefined && signed.proposal.sequence <= last)) extra.push(reason('PROPOSAL_REPLAYED', d));
      seen.add(d);
      if (authenticated && (last === undefined || signed.proposal.sequence > last)) proposalSequence.set(signed.proposal.agent.value, signed.proposal.sequence);
      const reasons = canonicalReasons([...s.reasons, ...extra]);
      screened.push({ signed, digest: d, agent: signed.proposal.agent.value as Identifier, reasons, quantityOnly: extra.length === 0 && s.quantityOnly, demand: s.demand, registry: s.registry });
    }

    const decide = (x: Screened, outcome: DecisionOutcome, reasons: readonly Reason[], target: ResourceVector) =>
      roundDecisions.push({ round, agent: x.agent, proposal: x.digest, outcome, reasons: canonicalReasons(reasons), target, demand: x.demand, registry: x.registry });

    /** What `agent` could still obtain of each resource of `demand`: its allocation, claimable lots, and the ledger's room. */
    const targetFor = (x: Screened): ResourceVector => {
      const out: ResourceAmount[] = [];
      for (const a of [...x.demand].sort((p, q) => compareResourceIds(p.resource, q.resource))) {
        const fromBook = obtainable(m, book, x.signed.proposal.agent, a.resource);
        const ledger = headroom(input.availability, x.agent, a.resource) - amountOf(acceptedBy.get(x.agent) ?? [], a.resource);
        const portfolio = amountOf(input.availability.portfolio, a.resource) - amountOf(acceptedTotal, a.resource);
        const most = [fromBook, ledger, portfolio].reduce((p, q) => (p < q ? p : q));
        out.push({ resource: a.resource, atoms: most > 0n ? most : 0n } as ResourceAmount);
      }
      return out;
    };

    const fitsLedger = (x: Screened): boolean =>
      x.demand.every((a) => amountOf(acceptedTotal, a.resource) + a.atoms <= amountOf(input.availability.portfolio, a.resource) && amountOf(acceptedBy.get(x.agent) ?? [], a.resource) + a.atoms <= headroom(input.availability, x.agent, a.resource));

    /** Claims for whatever the agent's unused allocation does not cover, then the commit; `null` if the lots cannot supply it. */
    const plan = (x: Screened): AllocationOp[] | null => {
      const ops: AllocationOp[] = [];
      let draft = book;
      for (const a of x.demand) {
        const e = draft.entries.find((y) => y.agent.value === x.agent && y.resource === a.resource);
        const unused = e === undefined ? 0n : e.allocated - e.committed;
        if (a.atoms <= unused) continue;
        const claims = planClaims(draft, x.signed.proposal.agent, a.resource, a.atoms - unused, `claim/${x.digest}/${a.resource}`);
        if (claims === null) return null;
        for (const c of claims) {
          const next = applyAllocation(m, draft, c);
          if (!next.ok) return null;
          draft = next.value;
          ops.push(c);
        }
      }
      ops.push({ kind: 'COMMIT', agent: x.signed.proposal.agent, id: x.digest as string as Identifier, amounts: x.demand });
      return applyAllocation(m, draft, ops[ops.length - 1] as AllocationOp).ok ? ops : null;
    };

    const accept = (x: Screened, ops: readonly AllocationOp[]) => {
      // Applied as one unit: a plan the book refuses part-way (it cannot, having just been planned) changes nothing.
      let draft = book;
      for (const op of ops) {
        const next = applyAllocation(m, draft, op);
        if (!next.ok) {
          decide(x, 'REJECTED', [next.error], []);
          return;
        }
        draft = next.value;
      }
      book = draft;
      accepted.push(x.digest);
      acceptedTotal = addVectors(acceptedTotal, x.demand);
      acceptedBy.set(x.agent, addVectors(acceptedBy.get(x.agent) ?? [], x.demand));
      decide(x, 'ACCEPTED', [], []);
    };

    const reduceOrReject = (x: Screened, why: readonly Reason[]) => {
      const target = targetFor(x);
      const minimum = x.signed.proposal.minimum;
      const enough = target.every((t) => t.atoms >= amountOf(minimum, t.resource)) && target.some((t) => t.atoms > 0n);
      if (enough) decide(x, 'REDUCE_REQUESTED', why, target);
      else decide(x, 'REJECTED', [...why, reason('ALLOCATION_INSUFFICIENT')], []);
    };

    // 4–5. Refusals first; quantity-only refusals may be asked to reduce.
    const eligible: Screened[] = [];
    for (const x of screened) {
      if (x.reasons.length === 0) eligible.push(x);
      else if (x.quantityOnly) reduceOrReject(x, x.reasons);
      else decide(x, 'REJECTED', x.reasons, []);
    }
    const coveredNow = (x: Screened) => x.demand.every((a) => {
      const e = book.entries.find((y) => y.agent.value === x.agent && y.resource === a.resource);
      return e !== undefined && a.atoms <= e.allocated - e.committed;
    });
    const later: Screened[] = [];
    for (const x of eligible) {
      if (coveredNow(x) && fitsLedger(x)) accept(x, [{ kind: 'COMMIT', agent: x.signed.proposal.agent, id: x.digest as string as Identifier, amounts: x.demand }]);
      else later.push(x);
    }
    later.sort((a, b) => (a.signed.proposal.utilityBps > b.signed.proposal.utilityBps ? -1 : a.signed.proposal.utilityBps < b.signed.proposal.utilityBps ? 1 : byText(a.digest, b.digest)));
    for (const x of later) {
      const ops = fitsLedger(x) ? plan(x) : null;
      if (ops !== null) accept(x, ops);
      else reduceOrReject(x, [reason('ALLOCATION_INSUFFICIENT', x.agent)]);
    }

    decisions.push(...roundDecisions);
    releases.push(...roundReleases);
    for (const a of agents) {
      feedback.set(a.agent.value, { decisions: roundDecisions.filter((d) => d.agent === a.agent.value), releases: roundReleases.filter((r) => r.agent === a.agent.value) });
    }
  }

  return {
    status: 'COMPLETE',
    reasons: [],
    rounds,
    decisions,
    releases,
    proposals,
    signedReleases,
    book,
    candidate: { portfolioMandate: digest, accepted: [...accepted].sort(byText), allocationLog: book.log },
  };
}
