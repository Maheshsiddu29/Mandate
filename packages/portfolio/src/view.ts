/**
 * The UI data contract (portfolio-mandate.md §14).
 *
 * Plain, JSON-ready data a frontend can animate without parsing logs: the
 * portfolio's status over time, every agent's status over time, one row per
 * proposal, and the headline counts. Every value is derived from the run's
 * recorded decisions, reservations and executions — nothing here is
 * reported by an agent — and every amount is a decimal string with its unit,
 * never a float.
 *
 * The view is a *rendering* of the receipt, never an input to it: it carries
 * the receipt's digest, and nothing in the receipt depends on it.
 */

import type { Identifier } from '@mandate/kernel';
import type { EvidenceClass } from './binding.ts';
import type { AgentStatus, ExecutionResult, ReceiptReservation } from './receipt.ts';
import type { ReasonCode } from './reasons.ts';
import { resourceTable, type ResourceVector } from './resources.ts';
import type { PortfolioRun } from './run.ts';
import { roundStatus } from './status.ts';
import { candidateIdentity } from './receipt.ts';
import { proposalDigest } from './proposal.ts';
import { bindingFor } from './binding.ts';
import type { PortfolioCore } from './reservation.ts';

export const PORTFOLIO_STATUSES = ['ACTIVE', 'NEGOTIATING', 'AUTHORIZED', 'EXECUTING', 'COMPLETE'] as const;
export type PortfolioStatus = (typeof PORTFOLIO_STATUSES)[number];

/** One step of the timeline: `step` 0 is before the room; 1…rounds are room rounds; then reservation and execution. */
export interface TimelineStep {
  readonly step: number;
  readonly phase: 'START' | 'ROUND' | 'VERIFY_AND_RESERVE' | 'EXECUTE' | 'DONE';
  readonly portfolio: PortfolioStatus;
  readonly agents: readonly { readonly agent: Identifier; readonly label: Identifier; readonly status: AgentStatus }[];
}

export interface AmountView {
  readonly resource: string;
  readonly unit: string;
  /** Exact decimal text at the resource's declared decimals. */
  readonly amount: string;
}

export interface ProposalRow {
  readonly proposal: string;
  readonly round: number;
  readonly agent: Identifier;
  readonly label: Identifier;
  readonly domain: string | null;
  readonly kind: string;
  /** The canonical asset the portfolio resolved it to, or `null` when identity did not resolve. */
  readonly asset: string | null;
  readonly representation: Identifier;
  readonly venue: Identifier | null;
  readonly requested: readonly AmountView[];
  /** What the room approved: the derived demand when accepted, empty otherwise. */
  readonly approved: readonly AmountView[];
  readonly outcome: 'ACCEPTED' | 'REJECTED' | 'REDUCE_REQUESTED';
  readonly reasons: readonly ReasonCode[];
  /** The registry's verdict, for stock candidates. */
  readonly registry: { readonly status: 'ADMISSIBLE' | 'EXCLUDED'; readonly codes: readonly string[] } | null;
  readonly execution: 'NOT_AUTHORIZED' | 'RESERVED' | 'AWAITING_DOMAIN_SIGNER' | 'SETTLED' | 'FAILED';
  /** The evidence behind this row's execution in this run, and behind its domain's integration. */
  readonly evidence: EvidenceClass | null;
  readonly integrationEvidence: EvidenceClass | null;
  /** Onchain transactions this proposal caused in this run: always 0 for a refusal. */
  readonly transactions: number;
}

export interface PortfolioView {
  readonly receiptDigest: string;
  readonly headline: { readonly agents: number; readonly markets: number; readonly principals: 1; readonly proposals: number; readonly refusals: number; readonly transactions: number };
  readonly status: PortfolioStatus;
  readonly timeline: readonly TimelineStep[];
  readonly proposals: readonly ProposalRow[];
  readonly resources: readonly { readonly resource: string; readonly unit: string; readonly limit: string; readonly reservedBefore: string; readonly reservedAfter: string }[];
  readonly domains: readonly { readonly domain: string; readonly integration: string; readonly evidence: EvidenceClass }[];
}

function decimal(atoms: bigint, decimals: number): string {
  if (decimals === 0) return atoms.toString();
  const s = atoms.toString().padStart(decimals + 1, '0');
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

export function portfolioView(core: PortfolioCore, run: PortfolioRun): PortfolioView {
  const m = core.compiled.mandate;
  const table = resourceTable(m.resources);
  const amounts = (v: ResourceVector): AmountView[] =>
    v.map((a) => {
      const d = table.get(a.resource);
      return { resource: a.resource, unit: d?.unit ?? 'UNKNOWN', amount: decimal(a.atoms, d?.decimals ?? 0) };
    });
  const labels = new Map<string, Identifier>(m.agents.map((a) => [a.agent.value, a.label]));
  const receipt = run.receipt;

  // --- the timeline ---------------------------------------------------------------
  const timeline: TimelineStep[] = [];
  const agentsAt = (status: (agent: string) => AgentStatus) => m.agents.map((a) => ({ agent: a.agent.value as Identifier, label: a.label, status: status(a.agent.value) }));
  timeline.push({ step: 0, phase: 'START', portfolio: 'ACTIVE', agents: agentsAt(() => 'SEARCHING') });
  const last = new Map<string, AgentStatus>(m.agents.map((a) => [a.agent.value, 'SEARCHING']));
  for (let round = 1; round <= run.room.rounds; round += 1) {
    for (const a of m.agents) {
      const decisions = run.room.decisions.filter((d) => d.round === round && d.agent === a.agent.value);
      const releases = run.room.releases.filter((r) => r.round === round && r.agent === a.agent.value);
      if (decisions.length > 0 || releases.length > 0) last.set(a.agent.value, roundStatus(decisions, releases));
    }
    timeline.push({ step: round, phase: 'ROUND', portfolio: 'NEGOTIATING', agents: agentsAt((x) => last.get(x) ?? 'SEARCHING') });
  }
  const childOf = new Map<string, string>(receipt.childAuthorizations.map((c) => [c.proposal as string, c.child as string]));
  const agentOfChild = new Map<string, string>(receipt.childAuthorizations.map((c) => [c.child as string, c.agent as string]));
  const reservationOf = new Map<string, ReceiptReservation>(receipt.reservations.map((r) => [r.child as string, r]));
  const executionOf = new Map<string, ExecutionResult>(receipt.executions.map((e) => [e.child as string, e]));
  const reserved = new Set<string>(receipt.reservations.filter((r) => r.status === 'RESERVED').map((r) => agentOfChild.get(r.child) ?? ''));
  timeline.push({ step: run.room.rounds + 1, phase: 'VERIFY_AND_RESERVE', portfolio: receipt.verification.status === 'VERIFIED' ? 'AUTHORIZED' : 'NEGOTIATING', agents: agentsAt((x) => (reserved.has(x) ? 'AUTHORIZED' : (last.get(x) ?? 'SEARCHING'))) });
  // Only children this run actually executed are EXECUTING; those handed to their domain's signer stay AUTHORIZED.
  const executing = new Set<string>(receipt.executions.filter((e) => e.status !== 'AWAITING_DOMAIN_SIGNER').map((e) => agentOfChild.get(e.child) ?? ''));
  timeline.push({ step: run.room.rounds + 2, phase: 'EXECUTE', portfolio: 'EXECUTING', agents: agentsAt((x) => (executing.has(x) ? 'EXECUTING' : reserved.has(x) ? 'AUTHORIZED' : (last.get(x) ?? 'SEARCHING'))) });
  const final = new Map<string, AgentStatus>(receipt.agents.map((a) => [a.agent as string, a.status]));
  const status: PortfolioStatus = receipt.verification.status === 'VERIFIED' ? 'COMPLETE' : 'NEGOTIATING';
  timeline.push({ step: run.room.rounds + 3, phase: 'DONE', portfolio: status, agents: agentsAt((x) => final.get(x) ?? 'SEARCHING') });

  // --- one row per proposal ---------------------------------------------------------
  const proposals: ProposalRow[] = run.room.proposals.map((s) => {
    const d = proposalDigest(s.proposal);
    const decision = run.room.decisions.find((x) => x.proposal === d);
    const b = bindingFor(core.compiled.bindings, s.proposal.candidate.kind);
    const id = candidateIdentity(s.proposal.candidate);
    const child = childOf.get(d);
    const reservation = child === undefined ? undefined : reservationOf.get(child);
    const execution = child === undefined ? undefined : executionOf.get(child);
    const resolved = decision !== undefined && decision.demand.length > 0 && decision.outcome === 'ACCEPTED';
    const asset = decision?.registry?.status === 'ADMISSIBLE' || resolved ? assetOf(core, s) : null;
    return {
      proposal: d,
      round: decision?.round ?? 0,
      agent: s.proposal.agent.value,
      label: labels.get(s.proposal.agent.value) ?? ('unknown' as Identifier),
      domain: 'refused' in b ? null : b.domain,
      kind: s.proposal.candidate.kind,
      asset,
      representation: id.representation,
      venue: id.venue,
      requested: amounts(s.proposal.requested),
      approved: decision?.outcome === 'ACCEPTED' ? amounts(decision.demand) : [],
      outcome: decision?.outcome ?? 'REJECTED',
      reasons: (decision?.reasons ?? []).map((r) => r.code),
      registry: decision?.registry === null || decision?.registry === undefined ? null : { status: decision.registry.status, codes: decision.registry.codes },
      execution: execution !== undefined ? execution.status : reservation?.status === 'RESERVED' ? 'RESERVED' : reservation?.status === 'REFUSED' ? 'FAILED' : 'NOT_AUTHORIZED',
      evidence: execution?.evidence ?? null,
      integrationEvidence: execution?.integrationEvidence ?? ('refused' in b ? null : b.evidence),
      transactions: execution?.transactions ?? 0,
    };
  });

  return {
    receiptDigest: run.digest,
    headline: {
      agents: m.agents.length,
      markets: new Set(core.compiled.bindings.map((b) => b.domain)).size,
      principals: 1,
      proposals: proposals.length,
      refusals: receipt.decisions.filter((x) => x.refusal === 'OFFCHAIN_REFUSAL').length,
      transactions: receipt.transactions,
    },
    status,
    timeline,
    proposals,
    resources: m.limits.map((l) => {
      const d = table.get(l.resource);
      const dec = d?.decimals ?? 0;
      const before = run.before.reserved.find((x) => x.resource === l.resource)?.atoms ?? 0n;
      const after = run.after.reserved.find((x) => x.resource === l.resource)?.atoms ?? 0n;
      return { resource: l.resource, unit: d?.unit ?? 'UNKNOWN', limit: decimal(l.atoms, dec), reservedBefore: decimal(before, dec), reservedAfter: decimal(after, dec) };
    }),
    domains: core.compiled.bindings.map((b) => ({ domain: b.domain, integration: b.integration, evidence: b.evidence })),
  };
}

/** The canonical asset a proposal resolved to, as text; only for proposals whose identity resolved. */
function assetOf(core: PortfolioCore, s: PortfolioRun['room']['proposals'][number]): string | null {
  const b = bindingFor(core.compiled.bindings, s.proposal.candidate.kind);
  if ('refused' in b) return null;
  const agent = core.compiled.mandate.agents.find((a) => a.agent.value === s.proposal.agent.value);
  if (agent === undefined) return null;
  const r = b.resolve(s.proposal.candidate, { mandate: core.compiled.mandate, agent, table: resourceTable(core.compiled.mandate.resources), now: s.proposal.createdAt });
  return r.ok ? `${r.action.asset.assetClass}:${r.action.asset.idScheme}:${r.action.asset.value}` : null;
}
