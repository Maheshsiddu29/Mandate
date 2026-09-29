/**
 * Child execution authorizations (portfolio-mandate.md §11).
 *
 * The exact authority one accepted proposal is given: the singleton scope of
 * its resolved action, the resources approved for it, a window no wider than
 * the proposal's, the agent's and the portfolio's, and the digests that bind
 * it to one mandate, one proposal and one candidate.
 *
 * `deriveChildAuthorization` is the only constructor that starts from a
 * proposal, and it refuses unless the child is ⊆ its agent's policy ⊆ the
 * portfolio. `checkChildAuthorization` re-runs exactly that check on any
 * child — one the verifier derived, or one handed back later at handoff —
 * so a child that was altered after derivation is refused by the same rule
 * that would have refused it at first.
 */

import { ok, type ByteWriter } from '@mandate/kernel';
import {
  at,
  checkFields,
  parseDigest,
  partyIdInputOf,
  partyIdsEqual,
  readPartyInput,
  validateAgentId,
  validatePrincipalId,
  validateWindow,
  writeDigest,
  writeParty,
  type AgentId,
  type CoreReader,
  type CoreResult,
  type Digest32,
  type IntegerInput,
  type PartyIdInput,
  type PrincipalId,
  type Tagged,
} from '@mandate/core';
import { actionScope, checkChildLimits, checkChildScope, checkChildWindow, permits, type ResolvedAction } from './authority.ts';
import { candidateDigest, type CandidateDigest } from './candidate.ts';
import { PortfolioTag, decodePortfolio, portfolioDigest, portfolioWriter } from './encoding.ts';
import { agentPolicyOf, portfolioMandateDigest, type PortfolioMandate, type PortfolioMandateDigest } from './mandate.ts';
import { proposalDigest, type AgentProposal, type ProposalDigest } from './proposal.ts';
import { canonicalReasons, reason, type Reason } from './reasons.ts';
import { exceeding, readResourceVectorInput, resourceVectorInputOf, validateResourceVector, writeResourceVector, type ResourceAmountInput, type ResourceVector } from './resources.ts';
import { authorityScopeInputOf, readAuthorityScopeInput, validateAuthorityScope, writeAuthorityScope, type AuthorityScope, type AuthorityScopeInput } from './scope.ts';

export type ChildAuthorizationDigest = Tagged<Digest32, 'ChildAuthorizationDigest'>;

export interface ChildExecutionAuthorizationInput {
  readonly portfolioMandate: string;
  readonly principal: PartyIdInput;
  readonly agent: PartyIdInput;
  readonly proposal: string;
  readonly candidate: string;
  readonly scope: AuthorityScopeInput;
  readonly approved: readonly ResourceAmountInput[];
  readonly notBefore: IntegerInput;
  readonly expiresAt: IntegerInput;
}

export type ChildExecutionAuthorization = Tagged<
  {
    readonly portfolioMandate: PortfolioMandateDigest;
    readonly principal: PrincipalId;
    readonly agent: AgentId;
    readonly proposal: ProposalDigest;
    readonly candidate: CandidateDigest;
    /** The singleton scope of the one resolved action. */
    readonly scope: AuthorityScope;
    /** Exactly the derived demand: what the ledger must reserve, no more and no less. */
    readonly approved: ResourceVector;
    readonly notBefore: bigint;
    readonly expiresAt: bigint;
  },
  'ChildExecutionAuthorization'
>;

export function validateChildExecutionAuthorization(input: ChildExecutionAuthorizationInput, path = 'child'): CoreResult<ChildExecutionAuthorization> {
  const shape = checkFields(input, ['portfolioMandate', 'principal', 'agent', 'proposal', 'candidate', 'scope', 'approved', 'notBefore', 'expiresAt'], path);
  if (!shape.ok) return shape;
  const portfolioMandate = parseDigest<PortfolioMandateDigest>(input.portfolioMandate, at(path, 'portfolioMandate'));
  if (!portfolioMandate.ok) return portfolioMandate;
  const principal = validatePrincipalId(input.principal, at(path, 'principal'));
  if (!principal.ok) return principal;
  const agent = validateAgentId(input.agent, at(path, 'agent'));
  if (!agent.ok) return agent;
  const proposal = parseDigest<ProposalDigest>(input.proposal, at(path, 'proposal'));
  if (!proposal.ok) return proposal;
  const candidate = parseDigest<CandidateDigest>(input.candidate, at(path, 'candidate'));
  if (!candidate.ok) return candidate;
  const scope = validateAuthorityScope(input.scope, at(path, 'scope'));
  if (!scope.ok) return scope;
  const approved = validateResourceVector(input.approved, at(path, 'approved'));
  if (!approved.ok) return approved;
  const window = validateWindow(input.notBefore, input.expiresAt, path);
  if (!window.ok) return window;
  return ok({
    portfolioMandate: portfolioMandate.value,
    principal: principal.value,
    agent: agent.value,
    proposal: proposal.value,
    candidate: candidate.value,
    scope: scope.value,
    approved: approved.value,
    notBefore: window.value.notBefore,
    expiresAt: window.value.expiresAt,
  } as ChildExecutionAuthorization);
}

export function writeChildBody(w: ByteWriter, c: ChildExecutionAuthorization): void {
  writeDigest(w, c.portfolioMandate);
  writeParty(w, c.principal);
  writeParty(w, c.agent);
  writeDigest(w, c.proposal);
  writeDigest(w, c.candidate);
  writeAuthorityScope(w, c.scope);
  writeResourceVector(w, c.approved);
  w.i64(c.notBefore).i64(c.expiresAt);
}

export function encodeChildExecutionAuthorization(c: ChildExecutionAuthorization): Uint8Array {
  const w = portfolioWriter(PortfolioTag.CHILD_AUTHORIZATION);
  writeChildBody(w, c);
  return w.finish();
}

function readChildInput(r: CoreReader): ChildExecutionAuthorizationInput {
  const portfolioMandate = r.digest();
  const principal = readPartyInput(r);
  const agent = readPartyInput(r);
  const proposal = r.digest();
  const candidate = r.digest();
  const scope = readAuthorityScopeInput(r);
  const approved = readResourceVectorInput(r);
  const notBefore = r.i64();
  const expiresAt = r.i64();
  return { portfolioMandate, principal, agent, proposal, candidate, scope, approved, notBefore, expiresAt };
}

export function decodeChildExecutionAuthorization(bytes: Uint8Array): CoreResult<ChildExecutionAuthorization> {
  return decodePortfolio(bytes, PortfolioTag.CHILD_AUTHORIZATION, readChildInput, (input) => validateChildExecutionAuthorization(input));
}

export function childAuthorizationDigest(c: ChildExecutionAuthorization): ChildAuthorizationDigest {
  return portfolioDigest<ChildAuthorizationDigest>(encodeChildExecutionAuthorization(c));
}

export function childExecutionAuthorizationInputOf(c: ChildExecutionAuthorization): ChildExecutionAuthorizationInput {
  return {
    portfolioMandate: c.portfolioMandate,
    principal: partyIdInputOf(c.principal),
    agent: partyIdInputOf(c.agent),
    proposal: c.proposal,
    candidate: c.candidate,
    scope: authorityScopeInputOf(c.scope),
    approved: resourceVectorInputOf(c.approved),
    notBefore: c.notBefore,
    expiresAt: c.expiresAt,
  };
}

// --- The check, at every level --------------------------------------------------------------

/**
 * Level 2 (and, redundantly, level 1) of the subset rule for one child:
 * bound to this mandate and principal; its agent is one of the mandate's;
 * its scope ⊆ the agent's scope and ⊆ the portfolio's; its window ⊆ both;
 * its approved resources declared and ≤ the agent's hard maxima and ≤ the
 * portfolio limits. Every violation, canonical order.
 */
export function checkChildAuthorization(m: PortfolioMandate, c: ChildExecutionAuthorization): readonly Reason[] {
  const found: Reason[] = [];
  if (c.portfolioMandate !== portfolioMandateDigest(m)) found.push(reason('PORTFOLIO_MANDATE_DIGEST_MISMATCH'));
  if (!partyIdsEqual(c.principal, m.principal)) found.push(reason('PORTFOLIO_MANDATE_DIGEST_MISMATCH', 'principal'));
  const agent = agentPolicyOf(m, c.agent);
  if (agent === null) return canonicalReasons([...found, reason('AGENT_UNKNOWN', c.agent.value)]);
  const declared = new Set<string>(m.resources.map((d) => d.resource));
  found.push(...checkChildScope(agent.scope, c.scope), ...checkChildScope(m.scope, c.scope));
  found.push(...checkChildWindow(agent, c), ...checkChildWindow(m, c));
  found.push(...checkChildLimits(agent.hardMaxima, c.approved, declared), ...checkChildLimits(m.limits, c.approved, declared));
  return canonicalReasons(found);
}

/**
 * Derive the child authorization for an accepted proposal from its resolved
 * action. Refuses — with every reason — unless the action is permitted by the
 * agent's scope and the portfolio's at `now`, its demand is within the
 * agent's hard maxima and the portfolio limits, and `now` is inside every
 * window. The window is the intersection of the proposal's, the agent's and
 * the portfolio's.
 */
export function deriveChildAuthorization(
  m: PortfolioMandate,
  p: AgentProposal,
  a: ResolvedAction,
  now: bigint,
): { readonly ok: true; readonly value: ChildExecutionAuthorization } | { readonly ok: false; readonly reasons: readonly Reason[] } {
  const agent = agentPolicyOf(m, p.agent);
  if (agent === null) return { ok: false, reasons: [reason('AGENT_UNKNOWN', p.agent.value)] };
  const found: Reason[] = [...permits(agent.scope, a, now), ...permits(m.scope, a, now)];
  for (const r of exceeding(a.demand, agent.hardMaxima)) found.push(reason('AGENT_LIMIT_EXCEEDED', r));
  for (const r of exceeding(a.demand, m.limits)) found.push(reason('PORTFOLIO_LIMIT_EXCEEDED', r));
  const notBefore = [p.createdAt, agent.notBefore, m.notBefore].reduce((x, y) => (x > y ? x : y));
  const expiresAt = [p.expiresAt, agent.expiresAt, m.expiresAt].reduce((x, y) => (x < y ? x : y));
  if (now < m.notBefore) found.push(reason('PORTFOLIO_MANDATE_NOT_YET_VALID'));
  if (now >= m.expiresAt) found.push(reason('PORTFOLIO_MANDATE_EXPIRED'));
  if (now < agent.notBefore) found.push(reason('AGENT_NOT_YET_VALID', agent.agent.value));
  if (now >= agent.expiresAt) found.push(reason('AGENT_EXPIRED', agent.agent.value));
  if (now < p.createdAt) found.push(reason('PROPOSAL_NOT_YET_VALID'));
  if (now >= p.expiresAt) found.push(reason('PROPOSAL_EXPIRED'));
  if (found.length > 0) return { ok: false, reasons: canonicalReasons(found) };
  const child = {
    portfolioMandate: portfolioMandateDigest(m),
    principal: m.principal,
    agent: agent.agent,
    proposal: proposalDigest(p),
    candidate: candidateDigest(p.candidate),
    scope: actionScope(a, now),
    approved: a.demand,
    notBefore,
    expiresAt,
  } as ChildExecutionAuthorization;
  // Defence in depth: the derived child must pass the same check anyone can run on it later.
  const recheck = checkChildAuthorization(m, child);
  return recheck.length === 0 ? { ok: true, value: child } : { ok: false, reasons: recheck };
}
