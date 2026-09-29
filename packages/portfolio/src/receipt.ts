/**
 * The Portfolio Receipt (portfolio-mandate.md §13).
 *
 * A deterministic, canonically encoded record of one portfolio run: what was
 * proposed, what was decided and why, what was released and reassigned, the
 * allocation and the ledger before and after, every child authorization,
 * every registry verdict, every reservation and every execution result with
 * its evidence class. Its digest is keccak-256 of `PORTFOLIO_RECEIPT.V2`.
 *
 * **Only semantic order affects the digest.** Unordered sets are written in a
 * canonical order (by digest, identifier or party), so reordering the
 * candidate's selections, the proposals or the agents cannot change it. The
 * allocation event log keeps its replay-significant order. There is no free
 * text, model output or display string in the encoding — labels are the
 * mandate's own identifiers, reasons are codes and subjects.
 */

import { ByteWriter, type Identifier } from '@mandate/kernel';
import { writeDigest, type ActionId, type Digest32, type DomainId, type ReservationGeneration, type Tagged } from '@mandate/core';
import { writeAllocationOp, type AllocationBook } from './allocation.ts';
import type { ResourceAvailability } from './availability.ts';
import type { EvidenceClass, RepresentationDecisionRecord } from './binding.ts';
import { candidateDigest, encodeActionCandidate, type ActionCandidate, type CandidateDigest } from './candidate.ts';
import { encodeChildExecutionAuthorization, type ChildAuthorizationDigest, type ChildExecutionAuthorization } from './child.ts';
import { PORTFOLIO_RECEIPT_SCHEMA_VERSION, PortfolioTag, portfolioDigest, portfolioWriter } from './encoding.ts';
import { encodePortfolioMandate, type AllocationMode, type PortfolioMandate, type PortfolioMandateDigest } from './mandate.ts';
import type { ProposalDigest } from './proposal.ts';
import type { Reason } from './reasons.ts';
import type { ReleaseDigest } from './release.ts';
import { compareResourceIds, type ResourceVector } from './resources.ts';
import type { ActionKind } from './scope.ts';

export type ReceiptDigest = Tagged<Digest32, 'ReceiptDigest'>;

export const AGENT_STATUSES = ['SEARCHING', 'PROPOSING', 'BLOCKED', 'RENEGOTIATING', 'RELEASING', 'AUTHORIZED', 'EXECUTING', 'SETTLED', 'FAILED'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const EXECUTION_STATUSES = ['SETTLED', 'AWAITING_DOMAIN_SIGNER', 'FAILED'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export interface ReceiptProposal {
  readonly proposal: ProposalDigest;
  readonly candidate: CandidateDigest;
  readonly agent: Identifier;
  readonly round: number;
  readonly kind: ActionKind;
  readonly domain: DomainId | null;
  /** The exact identity the candidate names: token, collection, vault or market. */
  readonly representation: Identifier;
  /** The venue the candidate names, where it names one. */
  readonly venue: Identifier | null;
  readonly requested: ResourceVector;
}

export interface ReceiptDecision {
  readonly proposal: ProposalDigest;
  readonly round: number;
  readonly outcome: 'ACCEPTED' | 'REJECTED' | 'REDUCE_REQUESTED';
  readonly reasons: readonly Reason[];
  readonly target: ResourceVector;
  /** A refusal before any transaction: 0 transactions, 0 gas. */
  readonly refusal: 'NONE' | 'OFFCHAIN_REFUSAL';
}

export interface ReceiptRelease {
  readonly release: ReleaseDigest;
  readonly agent: Identifier;
  readonly round: number;
  readonly sequence: bigint;
  readonly amounts: ResourceVector;
  readonly applied: boolean;
  readonly reasons: readonly Reason[];
}

export interface ReceiptReservation {
  readonly child: ChildAuthorizationDigest;
  readonly status: 'RESERVED' | 'REFUSED';
  readonly reservation: Digest32 | null;
  readonly authorization: Digest32 | null;
  readonly executionAuthorization: Digest32 | null;
  readonly action: ActionId | null;
  readonly generation: ReservationGeneration | null;
  readonly ledgerVersion: bigint | null;
  readonly reasons: readonly Reason[];
}

export interface ExecutionResult {
  readonly child: ChildAuthorizationDigest;
  readonly status: ExecutionStatus;
  /** The evidence behind *this* result in *this* run. */
  readonly evidence: EvidenceClass;
  /** The domain integration and the evidence that stands behind it (portfolio-mandate.md §15). */
  readonly integration: Identifier;
  readonly integrationEvidence: EvidenceClass;
  readonly attempt: Digest32 | null;
  readonly artifact: Digest32 | null;
  /** Onchain transactions this run sent for it. */
  readonly transactions: number;
  readonly reasons: readonly Reason[];
}

export interface ReceiptAgent {
  readonly agent: Identifier;
  readonly label: Identifier;
  readonly status: AgentStatus;
}

export interface PortfolioReceipt {
  readonly principal: Identifier;
  readonly portfolioMandate: PortfolioMandateDigest;
  /** The complete canonical mandate whose digest is named above. */
  readonly mandate: PortfolioMandate;
  readonly policyVersion: bigint;
  readonly allocationMode: AllocationMode;
  readonly rounds: number;
  readonly agents: readonly ReceiptAgent[];
  readonly proposals: readonly ReceiptProposal[];
  readonly decisions: readonly ReceiptDecision[];
  readonly releases: readonly ReceiptRelease[];
  readonly allocationBefore: AllocationBook;
  readonly allocationAfter: AllocationBook;
  readonly resourcesBefore: ResourceAvailability;
  readonly resourcesAfter: ResourceAvailability;
  readonly verification: { readonly status: 'VERIFIED' | 'REFUSED'; readonly reasons: readonly Reason[] };
  readonly childAuthorizations: readonly { readonly child: ChildAuthorizationDigest; readonly agent: Identifier; readonly proposal: ProposalDigest; readonly candidate: ActionCandidate; readonly authorization: ChildExecutionAuthorization; readonly action: ActionId | null; readonly approved: ResourceVector }[];
  readonly representationDecisions: readonly (RepresentationDecisionRecord & { readonly proposal: ProposalDigest; readonly asset: string | null })[];
  readonly reservations: readonly ReceiptReservation[];
  readonly executions: readonly ExecutionResult[];
  /** Onchain transactions the whole run sent. */
  readonly transactions: number;
}

/** The exact identity and venue a candidate names — read for the receipt, never as authority. */
export function candidateIdentity(c: ActionCandidate): { readonly representation: Identifier; readonly venue: Identifier | null } {
  switch (c.kind) {
    case 'STOCK_BUY':
      return { representation: c.representation, venue: null };
    case 'SWAP_EXACT_IN':
      return { representation: c.tokenOut, venue: c.router };
    case 'NFT_BUY':
      return { representation: c.collection, venue: c.marketplace };
    case 'YIELD_DEPOSIT':
      return { representation: c.product, venue: null };
    case 'PERP_OPEN':
      return { representation: c.market, venue: null };
  }
}

// --- Canonical encoding ------------------------------------------------------------------------

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const w8 = (w: ByteWriter, xs: readonly string[]) => {
  w.u16(xs.length);
  for (const x of xs) w.str(x);
};

function writeVector(w: ByteWriter, v: ResourceVector): void {
  const sorted = [...v].sort((a, b) => compareResourceIds(a.resource, b.resource));
  w.u16(sorted.length);
  for (const a of sorted) w.str(a.resource).u256(a.atoms);
}

function writeReasons(w: ByteWriter, rs: readonly Reason[]): void {
  const sorted = [...rs].sort((a, b) => byText(a.code, b.code) || byText(a.subject, b.subject));
  w.u16(sorted.length);
  for (const r of sorted) w.str(r.code).str(r.subject);
}

function writeNullableText(w: ByteWriter, s: string | null): void {
  w.u8(s === null ? 0 : 1);
  if (s !== null) w.str(s);
}

function writeNullableDigest(w: ByteWriter, d: string | null): void {
  w.u8(d === null ? 0 : 1);
  if (d !== null) writeDigest(w, d as Digest32);
}

/** State sets are canonical; the event stream is committed in execution order with every field. */
function writeBook(w: ByteWriter, b: AllocationBook): void {
  const entries = [...b.entries].sort((x, y) => byText(x.agent.value, y.agent.value) || compareResourceIds(x.resource, y.resource));
  w.u16(entries.length);
  for (const e of entries) w.str(e.agent.value).str(e.resource).u256(e.allocated).u256(e.committed);
  const lots = [...b.lots].sort((x, y) => byText(x.id, y.id));
  w.u16(lots.length);
  for (const l of lots) {
    w.str(l.id).str(l.resource);
    writeNullableText(w, l.from === null ? null : l.from.value);
    w.u256(l.amount).u256(l.remaining);
  }
  w.u16(b.log.length);
  for (const op of b.log) writeAllocationOp(w, op);
}

function writeAvailability(w: ByteWriter, a: ResourceAvailability): void {
  w.u64(a.ledgerVersion);
  writeVector(w, a.portfolio);
  writeVector(w, a.reserved);
  const agents = [...a.agents.keys()].sort(byText);
  w.u16(agents.length);
  for (const k of agents) {
    w.str(k);
    writeVector(w, a.agents.get(k) ?? []);
  }
}

export function encodeReceipt(r: PortfolioReceipt): Uint8Array {
  const w = portfolioWriter(PortfolioTag.RECEIPT, PORTFOLIO_RECEIPT_SCHEMA_VERSION);
  w.str(r.principal);
  writeDigest(w, r.portfolioMandate);
  const mandate = encodePortfolioMandate(r.mandate);
  w.u32(mandate.length).raw(mandate);
  w.u64(r.policyVersion).str(r.allocationMode).u16(r.rounds);
  const agents = [...r.agents].sort((a, b) => byText(a.agent, b.agent));
  w.u16(agents.length);
  for (const a of agents) w.str(a.agent).str(a.label).str(a.status);
  const proposals = [...r.proposals].sort((a, b) => byText(a.proposal, b.proposal));
  w.u16(proposals.length);
  for (const p of proposals) {
    writeDigest(w, p.proposal);
    writeDigest(w, p.candidate);
    w.str(p.agent).u16(p.round).str(p.kind);
    writeNullableText(w, p.domain);
    w.str(p.representation);
    writeNullableText(w, p.venue);
    writeVector(w, p.requested);
  }
  const decisions = [...r.decisions].sort((a, b) => byText(a.proposal, b.proposal) || a.round - b.round);
  w.u16(decisions.length);
  for (const d of decisions) {
    writeDigest(w, d.proposal);
    w.u16(d.round).str(d.outcome).str(d.refusal);
    writeReasons(w, d.reasons);
    writeVector(w, d.target);
  }
  const releases = [...r.releases].sort((a, b) => byText(a.release, b.release) || a.round - b.round);
  w.u16(releases.length);
  for (const x of releases) {
    writeDigest(w, x.release);
    w.str(x.agent).u16(x.round).u64(x.sequence).u8(x.applied ? 1 : 0);
    writeVector(w, x.amounts);
    writeReasons(w, x.reasons);
  }
  writeBook(w, r.allocationBefore);
  writeBook(w, r.allocationAfter);
  writeAvailability(w, r.resourcesBefore);
  writeAvailability(w, r.resourcesAfter);
  w.str(r.verification.status);
  writeReasons(w, r.verification.reasons);
  const children = [...r.childAuthorizations].sort((a, b) => byText(a.child, b.child));
  w.u16(children.length);
  for (const c of children) {
    writeDigest(w, c.child);
    w.str(c.agent);
    writeDigest(w, c.proposal);
    writeDigest(w, candidateDigest(c.candidate));
    const candidate = encodeActionCandidate(c.candidate);
    w.u32(candidate.length).raw(candidate);
    const child = encodeChildExecutionAuthorization(c.authorization);
    w.u32(child.length).raw(child);
    writeNullableDigest(w, c.action);
    writeVector(w, c.approved);
  }
  const reps = [...r.representationDecisions].sort((a, b) => byText(a.proposal, b.proposal));
  w.u16(reps.length);
  for (const x of reps) {
    writeDigest(w, x.proposal);
    w.str(x.representation).str(x.status);
    writeNullableText(w, x.asset);
    w8(w, [...x.codes].sort(byText));
  }
  const reservations = [...r.reservations].sort((a, b) => byText(a.child, b.child));
  w.u16(reservations.length);
  for (const x of reservations) {
    writeDigest(w, x.child);
    w.str(x.status);
    writeNullableDigest(w, x.reservation);
    writeNullableDigest(w, x.authorization);
    writeNullableDigest(w, x.executionAuthorization);
    writeNullableDigest(w, x.action);
    w.u8(x.generation === null ? 0 : 1);
    if (x.generation !== null) w.u64(x.generation);
    w.u8(x.ledgerVersion === null ? 0 : 1);
    if (x.ledgerVersion !== null) w.u64(x.ledgerVersion);
    writeReasons(w, x.reasons);
  }
  const executions = [...r.executions].sort((a, b) => byText(a.child, b.child));
  w.u16(executions.length);
  for (const x of executions) {
    writeDigest(w, x.child);
    w.str(x.status).str(x.evidence).str(x.integration).str(x.integrationEvidence);
    writeNullableDigest(w, x.attempt);
    writeNullableDigest(w, x.artifact);
    w.u32(x.transactions);
    writeReasons(w, x.reasons);
  }
  w.u32(r.transactions);
  return w.finish();
}

export function receiptDigest(r: PortfolioReceipt): ReceiptDigest {
  return portfolioDigest<ReceiptDigest>(encodeReceipt(r));
}
