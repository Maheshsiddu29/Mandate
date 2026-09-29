/**
 * A registered portfolio over the demonstration markets: the demo mandate,
 * compiled into Core, registered in a fresh in-memory ledger through the
 * unchanged control engine. Plus builders from a candidate to a signed
 * proposal and to the child authorization the verifier would derive.
 */

import assert from 'node:assert/strict';
import {
  agentPolicyOf,
  compilePortfolio,
  createPortfolioCore,
  deriveChildAuthorization,
  portfolioMandateDigest,
  proposalDigest,
  proposalSigningHash,
  registerPortfolio,
  resolveCandidate,
  resourceVectorInputOf,
  validateAgentProposal,
  type ActionCandidate,
  type AgentPolicy,
  type ChildExecutionAuthorization,
  type CompiledPortfolio,
  type PortfolioCore,
  type PortfolioCoreOptions,
  type PortfolioMandate,
  type SignedProposal,
} from '../../src/index.ts';
import { actionCandidateInputOf } from '../../src/candidate.ts';
import { DEMO_T0, demoBindings, demoKey, demoMandate, demoParty, signPrehash } from '../../src/demo/index.ts';
import { NOW } from './candidates.ts';

export interface World {
  readonly m: PortfolioMandate;
  readonly compiled: CompiledPortfolio;
  readonly core: PortfolioCore;
}

export async function world(o: PortfolioCoreOptions & { mandate?: PortfolioMandate } = {}): Promise<World> {
  const m = o.mandate ?? demoMandate();
  const compiled = compilePortfolio(m, demoBindings());
  if (!compiled.ok) assert.fail(`compile: ${JSON.stringify(compiled.error)}`);
  const core = createPortfolioCore(compiled.value, o);
  const registered = await registerPortfolio(core, DEMO_T0);
  if (!registered.ok) assert.fail(`register: ${JSON.stringify(registered.error)}`);
  return { m, compiled: compiled.value, core };
}

export function agentOf(m: PortfolioMandate, role: string): AgentPolicy {
  return agentPolicyOf(m, demoParty(role)) as AgentPolicy;
}

/** A proposal for `candidate` by `role`, declaring exactly the demand the binding derives, signed by the role's key. */
export function proposal(m: PortfolioMandate, role: string, candidate: ActionCandidate, o: { sequence?: bigint; utilityBps?: bigint; minimum?: boolean; expiresAt?: bigint; createdAt?: bigint } = {}): SignedProposal {
  const r = resolveCandidate(demoBindings(), m, agentOf(m, role), candidate, NOW);
  const demand = r.ok ? resourceVectorInputOf(r.action.demand) : [];
  const p = validateAgentProposal({
    portfolioMandate: portfolioMandateDigest(m),
    agent: demoParty(role),
    sequence: o.sequence ?? 1n,
    candidate: actionCandidateInputOf(candidate),
    requested: demand,
    minimum: o.minimum === false ? [] : demand,
    utilityBps: o.utilityBps ?? 0n,
    createdAt: o.createdAt ?? DEMO_T0,
    expiresAt: o.expiresAt ?? DEMO_T0 + 3_600n,
    criticalExtensions: [],
  });
  if (!p.ok) assert.fail(`proposal: ${p.error.code} at ${p.error.path}`);
  return { proposal: p.value, signature: signPrehash(proposalSigningHash(proposalDigest(p.value)), demoKey(role)) };
}

/** The child authorization the verifier derives for `candidate`, or a failed assertion naming every reason. */
export function childFor(m: PortfolioMandate, role: string, candidate: ActionCandidate, at: bigint = NOW): ChildExecutionAuthorization {
  const r = resolveCandidate(demoBindings(), m, agentOf(m, role), candidate, at);
  if (!r.ok) assert.fail(`resolve: ${JSON.stringify(r.reasons)}`);
  const d = deriveChildAuthorization(m, proposal(m, role, candidate).proposal, r.action, at);
  if (!d.ok) assert.fail(`derive: ${JSON.stringify(d.reasons)}`);
  return d.value;
}
