/**
 * Scenes 1–3: the Portfolio Mandate, five agents searching, and the
 * resource conflict. Everything is read from the canonical run
 * (`JudgeProtocol.initial`) and the real screening of each signed proposal.
 */

import { authorityId } from '@mandate/core';
import {
  addVectors,
  agentPolicyOf,
  amountOf,
  assetKey,
  candidateDigest,
  mandateReasons,
  mandateSignedByPrincipal,
  portfolioMandateDigest,
  proposalSignedByAgent,
  type AgentPolicy,
  type ResourceVector,
} from '@mandate/portfolio';
import { DEMO_OPPORTUNITIES } from '@mandate/portfolio/demo';
import type { SceneContext } from './context.ts';
import { codesOf, jsonOf, reasonViews } from './events.ts';
import { because, describeCandidate, percent, short } from './explain.ts';
import type { ProposalEntry } from './proposals.ts';
import { INITIAL_TIME, ROLES } from './scenario.ts';

const time = INITIAL_TIME.toString();

/** The agents in the order the story tells them (scenario.ts), then any the scenario does not name. */
export function inProductOrder(x: SceneContext): readonly AgentPolicy[] {
  const known = ROLES.flatMap((r) => x.m.agents.filter((a) => a.label === r));
  return [...known, ...x.m.agents.filter((a) => !known.includes(a))];
}

export function emitPortfolioCreated(x: SceneContext): void {
  const { m, p } = x;
  const c = p.core.compiled;
  x.log.scene(1);
  x.log.emit({
    kind: 'PORTFOLIO_CREATED',
    status: 'CREATED',
    run: 'initial',
    protocolTime: time,
    artifacts: [
      { name: 'portfolioMandateDigest', value: portfolioMandateDigest(m) },
      { name: 'rootGrant', value: authorityId(c.root) },
    ],
    message: `Principal ${short(m.principal.value)} signs one Portfolio Mandate: ${m.allocationMode} allocation of ${x.money(m.limits)} across ${m.agents.length} agents, compiled into Core and registered in the ledger`,
    data: {
      principal: m.principal.value,
      principalSignatureValid: mandateSignedByPrincipal(m, p.signature),
      mandateRefusals: reasonViews(mandateReasons(m, p.signature, INITIAL_TIME)),
      allocationMode: m.allocationMode,
      policyVersion: m.policyVersion.toString(),
      notBefore: m.notBefore.toString(),
      expiresAt: m.expiresAt.toString(),
      resources: m.resources.map((r) => ({ resource: r.resource, kind: r.kind, unit: r.unit, decimals: r.decimals, domain: r.domain })),
      globalAuthority: x.amounts(m.limits),
      agents: m.agents.map((a) => {
        const g = c.delegations.get(a.agent.value);
        return {
          agent: a.agent.value,
          label: a.label,
          delegation: g === undefined ? null : authorityId(g),
          scope: jsonOf(a.scope),
          preferred: x.amounts(a.preferred),
          hardMaxima: x.amounts(a.hardMaxima),
        };
      }),
      domains: c.bindings.map((b) => ({ domain: b.domain, integration: b.integration, evidence: b.evidence })),
      ledgerVersionAtRegistration: p.initial.before.ledgerVersion.toString(),
    },
  });
}

function emitDiscovered(x: SceneContext, e: ProposalEntry): void {
  const s = e.signed;
  const c = s.proposal.candidate;
  x.log.emit({
    kind: 'PROPOSAL_DISCOVERED',
    status: 'SIGNED',
    run: 'initial',
    round: e.decision.round,
    protocolTime: time,
    agent: x.agent(e.agent),
    domain: x.domainOf(c.kind),
    proposal: e.digest,
    candidate: candidateDigest(c),
    requested: x.amounts(s.proposal.requested),
    artifacts: [{ name: 'proposalDigest', value: e.digest }],
    message: `${x.label(e.agent)} signs a proposal with its own key: ${describeCandidate(c)}, requesting ${x.money(s.proposal.requested)} of portfolio-notional`,
    data: {
      sequence: s.proposal.sequence.toString(),
      signatureValid: proposalSignedByAgent(s.proposal, s.signature),
      agentIsMember: agentPolicyOf(x.m, s.proposal.agent) !== null,
      createdAt: s.proposal.createdAt.toString(),
      expiresAt: s.proposal.expiresAt.toString(),
      utilityBps: s.proposal.utilityBps.toString(),
      candidate: jsonOf(c),
    },
  });
}

/**
 * What made the blocked candidate attractive, from the real candidates: the
 * better quote or higher advertised APY than the agent's own admissible
 * alternative. `null` when there is no comparable alternative.
 */
function lure(e: ProposalEntry, entries: readonly ProposalEntry[]): string | null {
  const c = e.signed.proposal.candidate;
  const alt = entries.find((y) => y.agent === e.agent && y.verdict !== 'SECURITY_INVALID' && y.signed.proposal.candidate.kind === c.kind)?.signed.proposal.candidate;
  if (c.kind === 'SWAP_EXACT_IN' && alt?.kind === 'SWAP_EXACT_IN' && alt.amountIn === c.amountIn && c.quotedOut > alt.quotedOut) {
    return `a better quote (${percent(((c.quotedOut - alt.quotedOut) * 10_000n) / alt.quotedOut)}% more output than the approved route) is not authority`;
  }
  if (c.kind === 'YIELD_DEPOSIT' && alt?.kind === 'YIELD_DEPOSIT' && c.quotedApyBps > alt.quotedApyBps) {
    return `a higher advertised APY (${percent(c.quotedApyBps)}% against the approved vault's ${percent(alt.quotedApyBps)}%; a quote, not a guaranteed return) is not authority`;
  }
  return null;
}

/** Why the verdict, in words: the claim or lure the agent leaned on, then the real reasons. */
function blockedMessage(x: SceneContext, e: ProposalEntry, entries: readonly ProposalEntry[]): string {
  const c = e.signed.proposal.candidate;
  const codes = codesOf(e.screening.reasons);
  const lead =
    c.kind === 'STOCK_BUY' && c.claims.ticker !== null
      ? `display ticker "${c.claims.ticker}" may match, but a ticker is never identity`
      : c.kind === 'NFT_BUY' && c.claims.displayName !== null
        ? `display name "${c.claims.displayName}" may match, but a name is never identity`
        : lure(e, entries);
  return `${x.label(e.agent)}: SECURITY INVALID → BLOCKED. ${lead === null ? '' : `${lead}: `}${because(codes)}. Never negotiated; 0 transactions`;
}

function emitVerdict(x: SceneContext, e: ProposalEntry, entries: readonly ProposalEntry[]): void {
  const s = e.screening;
  const c = e.signed.proposal.candidate;
  const base = {
    run: 'initial' as const,
    round: e.decision.round,
    protocolTime: time,
    agent: x.agent(e.agent),
    domain: x.domainOf(c.kind),
    proposal: e.digest,
    candidate: candidateDigest(c),
    requested: x.amounts(e.signed.proposal.requested),
    reasons: reasonViews(s.reasons),
    artifacts: [{ name: 'proposalDigest', value: e.digest }],
  };
  const resolved =
    s.action === null
      ? null
      : { asset: assetKey(s.action.asset), representation: s.action.representation, issuer: s.action.issuer, venue: s.action.venue, recipient: s.action.recipient, chain: s.action.chain, synthetic: s.action.synthetic };
  const shared = {
    verdict: e.verdict,
    resolved,
    registry: s.registry === null ? null : { representation: s.registry.representation, status: s.registry.status, codes: [...s.registry.codes] },
    roomOutcome: e.decision.outcome,
  };
  if (e.verdict === 'SECURITY_INVALID') {
    x.log.emit({ ...base, kind: 'PROPOSAL_BLOCKED', status: 'BLOCKED', message: blockedMessage(x, e, entries), data: { ...shared, negotiated: false, refusal: 'OFFCHAIN_REFUSAL', transactions: 0 } });
    return;
  }
  const conflict = e.verdict === 'LOCALLY_VALID_RESOURCE_CONFLICT';
  x.log.emit({
    ...base,
    kind: 'PROPOSAL_ADMISSIBLE',
    status: conflict ? 'CONFLICT' : 'ADMISSIBLE',
    approved: [],
    message: conflict
      ? `${x.label(e.agent)}: LOCALLY VALID — inside its own authority, but ${because(codesOf(s.reasons))}. Not malicious: a resource conflict for the Mandate Room`
      : `${x.label(e.agent)}: passes screening — ${s.action === null ? '' : `resolves to canonical asset "${assetKey(s.action.asset)}"; `}representation, ${s.action?.issuer === null ? '' : 'issuer, '}venue, recipient and its own limits check out; allocation is up to the Mandate Room`,
    data: { ...shared, derivedDemand: x.amounts(s.demand) },
  });
}

/** Scene 2: each agent's search, in the mandate's agent order; reductions belong to scene 4. */
export function emitAgentSearch(x: SceneContext, entries: readonly ProposalEntry[]): void {
  x.log.scene(2);
  for (const a of inProductOrder(x)) {
    const id = a.agent.value;
    const found = DEMO_OPPORTUNITIES[a.label]?.length ?? 0;
    x.log.emit({
      kind: 'AGENT_SEARCH_STARTED',
      status: 'INFO',
      run: 'initial',
      protocolTime: time,
      agent: x.agent(id),
      domain: a.scope.domains[0] ?? null,
      message: `${a.label} starts searching ${a.scope.domains.join(', ')}: ${found} candidate${found === 1 ? '' : 's'} found, ranked by its own preference`,
      data: { candidatesFound: found, preferred: x.amounts(a.preferred), hardMaxima: x.amounts(a.hardMaxima), scope: jsonOf(a.scope) },
    });
    const mine = entries.filter((e) => e.agent === id && e.reduces === null);
    for (const e of mine) {
      emitDiscovered(x, e);
      emitVerdict(x, e, entries);
    }
    if (mine.length > 0 && mine.every((e) => e.verdict === 'SECURITY_INVALID')) {
      x.log.emit({
        kind: 'AGENT_NO_COMPLIANT_OPPORTUNITY',
        status: 'INFO',
        run: 'initial',
        protocolTime: time,
        agent: x.agent(id),
        domain: a.scope.domains[0] ?? null,
        message: `${a.label}: NO COMPLIANT OPPORTUNITY — every candidate it found was blocked; it invents no trade`,
        data: { blocked: mine.map((e) => e.digest) },
      });
    }
  }
}

/** Scene 3: after the security-invalid proposals are gone, does the admissible demand fit the authority? */
export function emitResourceConflict(x: SceneContext, entries: readonly ProposalEntry[]): void {
  x.log.scene(3);
  const firstRound = entries.filter((e) => e.decision.round === 1);
  const initialRequested = firstRound.reduce<ResourceVector>((v, e) => addVectors(v, e.signed.proposal.requested), []);
  const blocked = entries.filter((e) => e.verdict === 'SECURITY_INVALID');
  const perAgent = inProductOrder(x).flatMap((a) => {
    const first = entries.find((e) => e.agent === a.agent.value && e.reduces === null && e.verdict !== 'SECURITY_INVALID');
    return first === undefined ? [] : [first];
  });
  const demand = perAgent.reduce<ResourceVector>((v, e) => addVectors(v, e.screening.demand), []);
  const limits = x.p.initial.before.portfolio;
  const exceeding = demand.filter((a) => a.atoms > amountOf(limits, a.resource));
  if (exceeding.length === 0) return;
  x.log.emit({
    kind: 'RESOURCE_CONFLICT',
    status: 'CONFLICT',
    run: 'initial',
    protocolTime: time,
    requested: x.amounts(demand),
    message: `The agents first asked for ${x.money(initialRequested)}; ${blocked.length} security-invalid proposals are gone. The admissible demand, ${exceeding.map((a) => `${x.money(demand, a.resource)} of ${a.resource} against ${x.money(limits, a.resource)}`).join(' and ')}, exceeds the authority → negotiation required, not a block`,
    data: {
      initialRequested: x.amounts(initialRequested),
      blockedProposals: blocked.map((e) => e.digest),
      admissible: perAgent.map((e) => ({ agent: x.label(e.agent), proposal: e.digest, round: e.decision.round, verdict: e.verdict, demand: x.amounts(e.screening.demand) })),
      authority: x.amounts(limits),
      exceeding: exceeding.map((a) => ({ resource: a.resource, demand: a.atoms.toString(), limit: amountOf(limits, a.resource).toString(), over: (a.atoms - amountOf(limits, a.resource)).toString() })),
    },
  });
}
