/**
 * One portfolio run, end to end (portfolio-mandate.md §2):
 *
 * ```text
 * availability(ledger) → Mandate Room → Portfolio Verifier → reserve each child (control engine)
 *                      → execute through the domain's executor → availability(ledger) → receipt
 * ```
 *
 * Every step's output is the next step's *untrusted* input: the verifier
 * re-derives the room, the ledger re-checks the verifier, the domain signer
 * re-checks the ledger. Reservations run in canonical child order, so the
 * ledger versions — and therefore the receipt — are deterministic.
 *
 * The executor is supplied by the caller (domains/executors.ts): this module
 * knows no domain.
 */

import type { AuthorizationRecord } from '@mandate/control';
import { initialBook } from './allocation.ts';
import type { ResourceAvailability } from './availability.ts';
import { bindingFor } from './binding.ts';
import { candidateDigest } from './candidate.ts';
import { candidateIdentity, receiptDigest, type ExecutionResult, type PortfolioReceipt, type ReceiptDigest, type ReceiptReservation } from './receipt.ts';
import { availabilityFrom, reserveChild, type PortfolioCore } from './reservation.ts';
import { proposalDigest } from './proposal.ts';
import { releaseDigest } from './release.ts';
import type { PortfolioAuthority } from './mandate-v2.ts';
import { runMandateRoom, type AgentStrategy, type RoomOutcome } from './room.ts';
import { finalStatus } from './status.ts';
import { assetKey } from './scope.ts';
import { verificationTranscript, verifyPortfolio, type VerificationTranscript, type VerifiedChild, type VerifierResult } from './verifier.ts';

/** Executes one reserved, verified child; the result carries its own evidence class. */
export type ChildExecutor = (child: VerifiedChild, record: AuthorizationRecord, at: bigint, transcript: VerificationTranscript) => Promise<ExecutionResult>;

export interface PortfolioRunInput {
  readonly core: PortfolioCore;
  readonly signature: string;
  /** Omitted means the V1 prehash check. A V2 run names `V2_EIP712` and nothing else is accepted. */
  readonly authority?: PortfolioAuthority;
  readonly now: bigint;
  readonly agents: readonly AgentStrategy[];
  /** `null`: stop after reservation. */
  readonly execute: ChildExecutor | null;
  readonly maxRounds?: number;
  /** Seconds after `now` at which issuance and execution run. */
  readonly executeAfter?: bigint;
}

export interface PortfolioRun {
  readonly room: RoomOutcome;
  readonly verification: VerifierResult;
  readonly reservations: readonly ReceiptReservation[];
  readonly records: ReadonlyMap<string, AuthorizationRecord>;
  readonly executions: readonly ExecutionResult[];
  readonly before: ResourceAvailability;
  readonly after: ResourceAvailability;
  readonly receipt: PortfolioReceipt;
  readonly digest: ReceiptDigest;
}

export async function runPortfolio(input: PortfolioRunInput): Promise<PortfolioRun> {
  const core = input.core;
  const c = core.compiled;
  const m = c.mandate;
  const before = availabilityFrom(c, await core.engine.read(m.principal), input.now);

  const authority = input.authority === undefined ? {} : { authority: input.authority };
  const room = runMandateRoom({ mandate: m, signature: input.signature, ...authority, bindings: c.bindings, availability: before, now: input.now, agents: input.agents, ...(input.maxRounds === undefined ? {} : { maxRounds: input.maxRounds }) });
  const verifierInput = { mandate: m, signature: input.signature, ...authority, bindings: c.bindings, availability: before, now: input.now, candidate: room.candidate, proposals: room.proposals, releases: room.signedReleases };
  const verification = verifyPortfolio(verifierInput);
  const transcript = verificationTranscript(verifierInput);

  const reservations: ReceiptReservation[] = [];
  const records = new Map<string, AuthorizationRecord>();
  const executions: ExecutionResult[] = [];
  if (verification.status === 'VERIFIED') {
    for (const v of verification.children) {
      const r = await reserveChild(core, transcript, v.digest, input.now);
      if (r.status === 'RESERVED') {
        records.set(v.digest, r.record);
        reservations.push({ child: v.digest, status: 'RESERVED', reservation: r.record.reservation, authorization: r.record.id, executionAuthorization: r.record.executionId, action: r.record.actionId, generation: r.record.generation, ledgerVersion: r.record.ledgerVersionCommitted, reasons: [] });
      } else {
        reservations.push({ child: v.digest, status: 'REFUSED', reservation: null, authorization: null, executionAuthorization: null, action: null, generation: null, ledgerVersion: null, reasons: r.reasons });
      }
    }
    if (input.execute !== null) {
      const at = input.now + (input.executeAfter ?? 5n);
      for (const v of verification.children) {
        const record = records.get(v.digest);
        if (record === undefined) continue;
        executions.push(await input.execute(v, record, at, transcript));
      }
    }
  }
  const after = availabilityFrom(c, await core.engine.read(m.principal), input.now);

  const agentOfChild = new Map<string, string>(verification.status === 'VERIFIED' ? verification.children.map((v) => [v.digest, v.child.agent.value]) : []);
  const roundOf = new Map<string, number>();
  for (const d of room.decisions) if (!roundOf.has(d.proposal)) roundOf.set(d.proposal, d.round);
  const receipt: PortfolioReceipt = {
    principal: m.principal.value,
    portfolioMandate: room.candidate.portfolioMandate,
    mandate: m,
    policyVersion: m.policyVersion,
    allocationMode: m.allocationMode,
    rounds: room.rounds,
    agents: m.agents.map((a) => ({
      agent: a.agent.value,
      label: a.label,
      status: finalStatus({
        decisions: room.decisions.filter((d) => d.agent === a.agent.value),
        releases: room.releases.filter((r) => r.agent === a.agent.value),
        reservations: reservations.filter((r) => agentOfChild.get(r.child) === a.agent.value),
        executions: executions.filter((e) => agentOfChild.get(e.child) === a.agent.value),
      }),
    })),
    proposals: room.proposals.map((s) => {
      const d = proposalDigest(s.proposal);
      const id = candidateIdentity(s.proposal.candidate);
      const b = bindingFor(c.bindings, s.proposal.candidate.kind);
      return { proposal: d, candidate: candidateDigest(s.proposal.candidate), agent: s.proposal.agent.value, round: roundOf.get(d) ?? 0, kind: s.proposal.candidate.kind, domain: 'refused' in b ? null : b.domain, representation: id.representation, venue: id.venue, requested: s.proposal.requested };
    }),
    decisions: room.decisions.map((d) => ({ proposal: d.proposal, round: d.round, outcome: d.outcome, reasons: d.reasons, target: d.target, refusal: d.outcome === 'ACCEPTED' ? 'NONE' : 'OFFCHAIN_REFUSAL' })),
    releases: room.releases.map((r) => {
      const signed = room.signedReleases.find((x) => releaseDigest(x.release) === r.release);
      return { release: r.release, agent: r.agent, round: r.round, sequence: signed?.release.sequence ?? 0n, amounts: signed?.release.amounts ?? [], applied: r.applied, reasons: r.reasons };
    }),
    allocationBefore: initialBook(m),
    allocationAfter: room.book,
    resourcesBefore: before,
    resourcesAfter: after,
    verification: verification.status === 'VERIFIED' ? { status: 'VERIFIED', reasons: [] } : { status: 'REFUSED', reasons: verification.reasons },
    childAuthorizations: verification.status === 'VERIFIED' ? verification.children.map((v) => ({ child: v.digest, agent: v.child.agent.value, proposal: v.proposal, candidate: v.candidate, authorization: v.child, action: records.get(v.digest)?.actionId ?? null, approved: v.child.approved })) : [],
    representationDecisions: room.decisions.flatMap((d) => {
      if (d.registry === null) return [];
      const child = verification.status === 'VERIFIED' ? verification.children.find((v) => v.proposal === d.proposal) : undefined;
      const asset = child?.child.scope.assets[0];
      return [{ ...d.registry, proposal: d.proposal, asset: asset === undefined ? null : assetKey(asset) }];
    }),
    reservations,
    executions,
    transactions: executions.reduce((s, e) => s + e.transactions, 0),
  };
  return { room, verification, reservations, records, executions, before, after, receipt, digest: receiptDigest(receipt) };
}
