/**
 * The continuation agents: real cryptographic identities, deterministic
 * strategies, no model.
 *
 * `AgentIdentity` is the only place in this package that holds a key. It is
 * the agent's Phase 7F demonstration key (`@mandate/portfolio/demo`):
 * derived from a public label, it secures nothing, is never committed as a
 * value, never exported, never printed and must never hold value. The same
 * derivation gives the same key the canonical run's agents signed with, so
 * a continuation agent *is* that agent — the compromised swap agent of
 * scene 6 signs with exactly the key that signed its approved swap in
 * scene 2.
 *
 * `ContinuationAgent` speaks to the real Mandate Room through its public
 * `AgentStrategy` interface: propose one opportunity; on `REDUCE_REQUESTED`
 * sign the largest size whose derived demand fits the Room's target (never
 * below its own minimum); stop once accepted or refused.
 */

import {
  agentPolicyOf,
  amountOf,
  portfolioMandateDigest,
  proposalDigest,
  proposalSigningHash,
  resolveCandidate,
  resourceVectorInputOf,
  validateActionCandidate,
  validateAgentProposal,
  validateResourceVector,
  type ActionCandidateInput,
  type AgentMessage,
  type AgentPolicy,
  type AgentProposal,
  type AgentStrategy,
  type DomainBinding,
  type PortfolioMandate,
  type ResourceAmountInput,
  type ResourceVector,
  type RoomFeedback,
  type SignedProposal,
} from '@mandate/portfolio';
import { DEMO_UTILITY, demoKey, demoParty, signPrehash } from '@mandate/portfolio/demo';
import { PROPOSAL_LIFETIME_SECONDS, QUOTE_LEAD_SECONDS } from './scenario.ts';

/** An agent's identity and signing key. The key never leaves this object. */
export class AgentIdentity {
  readonly role: string;
  readonly party: { readonly kind: string; readonly value: string };
  readonly #key: string;
  #uses = 0;

  constructor(role: string) {
    this.role = role;
    this.party = demoParty(role);
    this.#key = demoKey(role);
  }

  /** Signs a proposal's domain-separated digest (the kernel's acceptance rule). */
  sign(p: AgentProposal): SignedProposal {
    if (p.agent.kind !== this.party.kind || p.agent.value !== this.party.value) throw new Error(`${this.role} will not sign for another agent`);
    this.#uses += 1;
    return { proposal: p, signature: signPrehash(proposalSigningHash(proposalDigest(p)), this.#key) };
  }

  /** How many times the key has signed. */
  get uses(): number {
    return this.#uses;
  }
}

/** One thing the agent wants, at a size in atoms of portfolio-notional. */
export interface Opportunity {
  readonly name: string;
  readonly at: (size: bigint) => ActionCandidateInput;
  readonly size: bigint;
  readonly minimum: bigint;
  readonly resizable: boolean;
}

export class ContinuationAgent implements AgentStrategy {
  readonly identity: AgentIdentity;
  readonly agent: { readonly kind: string; readonly value: string };
  readonly #m: PortfolioMandate;
  readonly #policy: AgentPolicy;
  readonly #bindings: readonly DomainBinding[];
  readonly #now: bigint;
  readonly #opportunity: Opportunity;
  #size: bigint;
  #sequence: bigint;
  #done = false;

  /** `sequence` is the first sequence it signs: one above the highest it has signed before. */
  constructor(identity: AgentIdentity, m: PortfolioMandate, bindings: readonly DomainBinding[], now: bigint, opportunity: Opportunity, sequence: bigint) {
    const policy = agentPolicyOf(m, identity.party);
    if (policy === null) throw new Error(`${identity.role} is not an agent of this mandate`);
    this.identity = identity;
    this.agent = identity.party;
    this.#m = m;
    this.#policy = policy;
    this.#bindings = bindings;
    this.#now = now;
    this.#opportunity = opportunity;
    this.#size = opportunity.size;
    this.#sequence = sequence;
  }

  /** The demand at a size, by the portfolio's public binding code; its own size as notional if it cannot resolve. */
  demandAt(size: bigint): ResourceVector {
    const c = validateActionCandidate(this.#opportunity.at(size));
    if (c.ok) {
      const r = resolveCandidate(this.#bindings, this.#m, this.#policy, c.value, this.#now);
      if (r.ok) return r.action.demand;
    }
    const own = validateResourceVector([{ resource: 'portfolio-notional', atoms: size }], 'estimate');
    return own.ok ? own.value : [];
  }

  /** The largest size at most the current one whose demand fits `target`, if it is still at least the minimum. */
  #fit(target: ResourceVector): bigint | null {
    const fits = (s: bigint) => this.demandAt(s).every((a) => target.every((t) => t.resource !== a.resource || a.atoms <= t.atoms));
    if (fits(this.#size)) return this.#size;
    let lo = 0n;
    let hi = this.#size;
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    return lo >= this.#opportunity.minimum && fits(lo) ? lo : null;
  }

  act(_round: number, feedback: RoomFeedback): AgentMessage {
    for (const d of feedback.decisions) {
      if (d.outcome !== 'REDUCE_REQUESTED') this.#done = true;
      else {
        const size = this.#opportunity.resizable ? this.#fit(d.target) : null;
        if (size === null) this.#done = true;
        else this.#size = size;
      }
    }
    if (this.#done) return { kind: 'IDLE' };
    const demand = this.demandAt(this.#size);
    const notional = amountOf(demand, 'portfolio-notional');
    const minimum: ResourceAmountInput[] = [{ resource: 'portfolio-notional', atoms: this.#opportunity.minimum < notional ? this.#opportunity.minimum : notional }];
    const p = validateAgentProposal({
      portfolioMandate: portfolioMandateDigest(this.#m),
      agent: this.identity.party,
      sequence: this.#sequence,
      candidate: this.#opportunity.at(this.#size),
      requested: resourceVectorInputOf(demand),
      minimum,
      utilityBps: DEMO_UTILITY[this.identity.role] ?? 0n,
      createdAt: this.#now - QUOTE_LEAD_SECONDS,
      expiresAt: this.#now + PROPOSAL_LIFETIME_SECONDS,
      criticalExtensions: [],
    });
    if (!p.ok) throw new Error(`${this.identity.role} could not form a proposal: ${p.error.code} at ${p.error.path}`);
    this.#sequence += 1n;
    return { kind: 'PROPOSE', signed: this.identity.sign(p.value) };
  }
}

/** One above the highest sequence `party` signed in a room: sequences keep increasing across runs. */
export function nextSequence(proposals: readonly SignedProposal[], party: { readonly value: string }): bigint {
  return proposals.filter((s) => s.proposal.agent.value === party.value).reduce((n, s) => (s.proposal.sequence >= n ? s.proposal.sequence + 1n : n), 1n);
}
