/**
 * A registered portfolio over the demonstration markets: the demo mandate,
 * compiled into Core, registered in a fresh in-memory ledger through the
 * unchanged control engine. Plus builders from a candidate to a signed
 * proposal and to the child authorization the verifier would derive.
 */

import assert from 'node:assert/strict';
import {
  agentPolicyOf,
  amountOf,
  compilePortfolio,
  createPortfolioCore,
  deriveChildAuthorization,
  fullAvailability,
  portfolioMandateDigest,
  proposalDigest,
  proposalSigningHash,
  registerPortfolio,
  resolveCandidate,
  resourceVectorInputOf,
  runMandateRoom,
  mandateSigningHash,
  releaseDigest,
  releaseSigningHash,
  validateAgentProposal,
  validateAgentRelease,
  verificationTranscript,
  verifyPortfolio,
  type ActionCandidate,
  type AgentMessage,
  type AgentStrategy,
  type RoomFeedback,
  type SignedRelease,
  type AgentPolicy,
  type ChildExecutionAuthorization,
  type CompiledPortfolio,
  type PortfolioCore,
  type PortfolioCoreOptions,
  type PortfolioMandate,
  type SignedProposal,
  type VerificationTranscript,
  type VerifiedChild,
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

/** A signed release of `amounts` whole USDC per resource by `role`. */
export function release(m: PortfolioMandate, role: string, amounts: readonly (readonly [string, bigint])[], sequence = 1n): SignedRelease {
  const r = validateAgentRelease({ portfolioMandate: portfolioMandateDigest(m), agent: demoParty(role), sequence, amounts: amounts.map(([resource, whole]) => ({ resource, atoms: whole * 1_000_000n })) });
  if (!r.ok) assert.fail(`release: ${r.error.code} at ${r.error.path}`);
  return { release: r.value, signature: signPrehash(releaseSigningHash(releaseDigest(r.value)), demoKey(role)) };
}

/** The principal's signature over the mandate. */
export function principalSignature(m: PortfolioMandate): string {
  return signPrehash(mandateSigningHash(portfolioMandateDigest(m)), demoKey('principal'));
}

/** A complete verifier transcript and the exact child it derives for one proposal. */
export function authorizationFor(m: PortfolioMandate, role: string, candidate: ActionCandidate, at: bigint = NOW): { readonly transcript: VerificationTranscript; readonly verified: VerifiedChild } {
  return authorizationForSigned(m, role, proposal(m, role, candidate), at);
}

/**
 * The same, for one exact, already-signed proposal: the room (with the other
 * agents releasing their preferred allocation) and the verifier, both at `at`.
 * Re-running it at another `at` presents byte-identical signed input.
 */
export function authorizationForSigned(m: PortfolioMandate, role: string, signed: SignedProposal, at: bigint = NOW): { readonly transcript: VerificationTranscript; readonly verified: VerifiedChild } {
  const agents: ScriptedAgent[] = [new ScriptedAgent(role, [[1, { kind: 'PROPOSE', signed }]])];
  for (const policy of m.agents) {
    if (policy.label === role) continue;
    const atoms = amountOf(policy.preferred, 'portfolio-notional');
    if (atoms > 0n) agents.push(new ScriptedAgent(policy.label, [[1, { kind: 'RELEASE', signed: release(m, policy.label, [['portfolio-notional', atoms / 1_000_000n]]) }]]));
  }
  const room = runMandateRoom({
    mandate: m,
    signature: principalSignature(m),
    bindings: demoBindings(),
    availability: fullAvailability(m),
    now: at,
    agents,
  });
  const input = {
    mandate: m,
    signature: principalSignature(m),
    bindings: demoBindings(),
    availability: fullAvailability(m),
    now: at,
    candidate: room.candidate,
    proposals: room.proposals,
    releases: room.signedReleases,
  };
  const result = verifyPortfolio(input);
  if (result.status !== 'VERIFIED' || result.children.length !== 1) assert.fail(`verify: ${JSON.stringify(result, (_key, value: bigint | unknown) => (typeof value === 'bigint' ? value.toString() : value))}`);
  return { transcript: verificationTranscript(input), verified: result.children[0] as VerifiedChild };
}

/** An agent that sends a fixed message per round and idles otherwise; it records the feedback it gets. */
export class ScriptedAgent implements AgentStrategy {
  readonly agent: { kind: string; value: string };
  readonly script: ReadonlyMap<number, AgentMessage>;
  readonly heard: RoomFeedback[] = [];

  constructor(role: string, script: readonly (readonly [number, AgentMessage])[]) {
    this.agent = demoParty(role);
    this.script = new Map(script);
  }

  act(round: number, feedback: RoomFeedback): AgentMessage {
    this.heard.push(feedback);
    return this.script.get(round) ?? { kind: 'IDLE' };
  }
}
