/**
 * The trusted proposal builder.
 *
 * ```text
 * model: { candidateId, requestedAtoms }  ─▶  exact lookup (agents/spec.ts)  ─▶  candidate.build(size, observedAt)
 *        ─▶  demand priced by the portfolio's own public binding code  ─▶  AgentProposal  ─▶  local signer
 * ```
 *
 * The proposal declares exactly the demand the verifier will derive, so it
 * is never refused for misdeclaring (an agent that lied about its demand
 * would be — `PROPOSAL_RESOURCES_MISDECLARED`). Where an instrument cannot
 * be resolved — it is outside the reviewed tables — the demand is the
 * requested notional, as the Phase 7F agents estimate it; Mandate refuses
 * the identity anyway.
 *
 * Quote time is whatever the candidate was built with. Nothing here
 * re-stamps a quote: a stale proposal is refreshed only by a new decision
 * on a newly observed candidate.
 */

import {
  agentPolicyOf,
  amountOf,
  portfolioMandateDigest,
  resolveCandidate,
  resourceVectorInputOf,
  validateActionCandidate,
  validateAgentProposal,
  validateResourceVector,
  type ActionCandidateInput,
  type AgentProposal,
  type DomainBinding,
  type PortfolioMandate,
  type ResourceVector,
} from '@mandate/portfolio';
import type { Party } from './signer.ts';

/** How long a signed proposal stays valid, in protocol seconds. */
export const PROPOSAL_LIFETIME_SECONDS = 600n;

export interface BuildInput {
  readonly mandate: PortfolioMandate;
  readonly bindings: readonly DomainBinding[];
  readonly agent: Party;
  readonly candidate: ActionCandidateInput;
  /** The notional the model asked for; the demand estimate when the instrument does not resolve. */
  readonly sizeAtoms: bigint;
  /** The least the agent would accept, in portfolio-notional atoms. */
  readonly minimumAtoms: bigint;
  readonly sequence: bigint;
  readonly now: bigint;
}

export type Built = { readonly ok: true; readonly proposal: AgentProposal; readonly demand: ResourceVector; readonly resolved: boolean } | { readonly ok: false; readonly error: string };

/** The demand of `candidate` under `mandate` for `agent`, and whether its identity resolved. */
export function demandOf(mandate: PortfolioMandate, bindings: readonly DomainBinding[], agent: Party, candidate: ActionCandidateInput, sizeAtoms: bigint, now: bigint): { readonly demand: ResourceVector; readonly resolved: boolean } {
  const c = validateActionCandidate(candidate);
  const policy = agentPolicyOf(mandate, agent);
  if (c.ok && policy !== null) {
    const r = resolveCandidate(bindings, mandate, policy, c.value, now);
    if (r.ok) return { demand: r.action.demand, resolved: true };
  }
  const estimate = validateResourceVector([{ resource: 'portfolio-notional', atoms: sizeAtoms }], 'estimate');
  return { demand: estimate.ok ? estimate.value : [], resolved: false };
}

export function buildProposal(b: BuildInput): Built {
  const { demand, resolved } = demandOf(b.mandate, b.bindings, b.agent, b.candidate, b.sizeAtoms, b.now);
  const notional = amountOf(demand, 'portfolio-notional');
  const p = validateAgentProposal({
    portfolioMandate: portfolioMandateDigest(b.mandate),
    agent: b.agent,
    sequence: b.sequence,
    candidate: b.candidate,
    requested: resourceVectorInputOf(demand),
    minimum: [{ resource: 'portfolio-notional', atoms: b.minimumAtoms < notional ? b.minimumAtoms : notional }],
    // No model-controlled ranking: every live proposal carries the same utility.
    utilityBps: 0n,
    createdAt: b.now,
    expiresAt: b.now + PROPOSAL_LIFETIME_SECONDS,
    criticalExtensions: [],
  });
  if (!p.ok) return { ok: false, error: `${p.error.code} at ${p.error.path}` };
  return { ok: true, proposal: p.value, demand, resolved };
}

/** Per-agent monotonic sequences, across every run in a session. */
export class SequenceBook {
  readonly #next = new Map<string, bigint>();

  next(agent: Party): bigint {
    const n = this.#next.get(agent.value) ?? 1n;
    this.#next.set(agent.value, n + 1n);
    return n;
  }
}
