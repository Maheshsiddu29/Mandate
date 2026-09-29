/**
 * Screening one signed proposal (portfolio-mandate.md §9–§11).
 *
 * Shared, unchanged, by the Mandate Room and the Portfolio Verifier: the
 * verifier re-screens every proposal the room accepted with exactly the rule
 * the room was supposed to use, so a room that skipped a check is caught.
 *
 * In order, collecting every reason once identity allows:
 *
 * 1. authentication — the mandate digest, a known agent, its signature;
 * 2. form — no unknown critical extension; minimum ≤ requested;
 * 3. identity — resolution through the domain's binding (the registry for
 *    the stock agent); an unresolvable candidate stops here;
 * 4. honesty — the declared demand equals the derived demand;
 * 5. authority — the child authorization derivation: `permits` under the
 *    agent's scope and the portfolio's, the agent's listed hard maxima, the
 *    portfolio limits and every window.
 *
 * `quantityOnly` says whether every reason is a resource quantity — the case
 * where a smaller version of the same action could pass, and the room may
 * ask the agent to reduce rather than refuse.
 */

import type { ResolvedAction } from './authority.ts';
import { resolveCandidate, type DomainBinding, type RepresentationDecisionRecord } from './binding.ts';
import { deriveChildAuthorization, type ChildExecutionAuthorization } from './child.ts';
import { agentPolicyOf, portfolioMandateDigest, type PortfolioMandate } from './mandate.ts';
import { proposalSignedByAgent, type SignedProposal } from './proposal.ts';
import { canonicalReasons, reason, type Reason } from './reasons.ts';
import { amountOf, vectorsEqual, type ResourceVector } from './resources.ts';

export interface Screening {
  readonly reasons: readonly Reason[];
  /** Every reason is a resource quantity: a reduced version of the same action could pass. */
  readonly quantityOnly: boolean;
  readonly action: ResolvedAction | null;
  /** The derived demand, when identity resolved. */
  readonly demand: ResourceVector;
  /** Present exactly when the proposal passed: the child the verifier would derive. */
  readonly child: ChildExecutionAuthorization | null;
  readonly registry: RepresentationDecisionRecord | null;
}

const QUANTITY_CODES = new Set<string>(['AGENT_LIMIT_EXCEEDED', 'PORTFOLIO_LIMIT_EXCEEDED']);

function refused(reasons: readonly Reason[], registry: RepresentationDecisionRecord | null = null, action: ResolvedAction | null = null): Screening {
  const r = canonicalReasons(reasons);
  return { reasons: r, quantityOnly: r.length > 0 && r.every((x) => QUANTITY_CODES.has(x.code)), action, demand: action?.demand ?? [], child: null, registry };
}

export function screenProposal(m: PortfolioMandate, bindings: readonly DomainBinding[], signed: SignedProposal, now: bigint): Screening {
  const p = signed.proposal;
  const found: Reason[] = [];
  if (p.portfolioMandate !== portfolioMandateDigest(m)) return refused([reason('PORTFOLIO_MANDATE_DIGEST_MISMATCH')]);
  const agent = agentPolicyOf(m, p.agent);
  if (agent === null) return refused([reason('AGENT_UNKNOWN', p.agent.value)]);
  if (!proposalSignedByAgent(p, signed.signature)) return refused([reason('AGENT_SIGNATURE_INVALID', p.agent.value)]);
  for (const e of p.criticalExtensions) found.push(reason('PROPOSAL_EXTENSION_UNKNOWN', e));
  for (const r of new Set([...p.minimum.map((x) => x.resource as string), ...p.requested.map((x) => x.resource as string)])) {
    if (amountOf(p.minimum, r) > amountOf(p.requested, r)) found.push(reason('PROPOSAL_MINIMUM_INVALID', r));
  }
  const resolution = resolveCandidate(bindings, m, agent, p.candidate, now);
  if (!resolution.ok) return refused([...found, ...resolution.reasons], resolution.registry);
  const action = resolution.action;
  if (!vectorsEqual(p.requested, action.demand)) found.push(reason('PROPOSAL_RESOURCES_MISDECLARED', 'requested'));
  const derived = deriveChildAuthorization(m, p, action, now);
  if (!derived.ok) return refused([...found, ...derived.reasons], resolution.registry, action);
  if (found.length > 0) return refused(found, resolution.registry, action);
  return { reasons: [], quantityOnly: false, action, demand: action.demand, child: derived.value, registry: resolution.registry };
}
