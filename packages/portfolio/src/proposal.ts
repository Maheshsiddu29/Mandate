/**
 * Agent proposals (portfolio-mandate.md §9).
 *
 * A proposal is an agent's signed request: one exact action candidate, the
 * resources the agent says it needs and the least it would accept, ranking
 * metadata, a validity window and a per-agent sequence — bound to one
 * portfolio mandate by digest.
 *
 * **Authentication, not authorization.** The signature (secp256k1 over a
 * domain-separated hash of the proposal digest, under the kernel's acceptance
 * rule) establishes only that the agent the mandate names sent it. Whether the
 * candidate is inside that agent's authority is the verifier's question, and a
 * valid signature answers none of it.
 *
 * Everything the agent declares is untrusted: `requested` must equal the
 * demand the verifier derives, `utilityBps` only orders claims on released
 * allocation, and a `criticalExtensions` entry the verifier does not know
 * refuses the proposal rather than being ignored.
 */

import { ok, type ByteWriter, type Identifier } from '@mandate/kernel';
import {
  INT64_MAX,
  INT64_MIN,
  UINT64_MAX,
  at,
  canonicalSet,
  checkArray,
  checkFields,
  hexToBytes,
  keccakDigest,
  parseDigest,
  parseIdentifierAs,
  parseIntegerInRange,
  partyIdInputOf,
  readPartyInput,
  validateAgentId,
  validateWindow,
  writeDigest,
  writeParty,
  type AgentId,
  type CoreReader,
  type CoreResult,
  type Digest32,
  type IntegerInput,
  type PartyIdInput,
  type Tagged,
} from '@mandate/core';
import { recoverSigner } from '@mandate/execution-gate';
import { actionCandidateInputOf, readActionCandidateInput, validateActionCandidate, writeActionCandidate, type ActionCandidate, type ActionCandidateInput } from './candidate.ts';
import { PortfolioTag, decodePortfolio, portfolioDigest, portfolioWriter } from './encoding.ts';
import type { PortfolioMandateDigest } from './mandate.ts';
import { readResourceVectorInput, resourceVectorInputOf, validateResourceVector, writeResourceVector, type ResourceAmountInput, type ResourceVector } from './resources.ts';

export const MAX_EXTENSIONS = 8;

export type ProposalDigest = Tagged<Digest32, 'ProposalDigest'>;

export interface AgentProposalInput {
  readonly portfolioMandate: string;
  readonly agent: PartyIdInput;
  readonly sequence: IntegerInput;
  readonly candidate: ActionCandidateInput;
  readonly requested: readonly ResourceAmountInput[];
  readonly minimum: readonly ResourceAmountInput[];
  readonly utilityBps: IntegerInput;
  readonly createdAt: IntegerInput;
  readonly expiresAt: IntegerInput;
  readonly criticalExtensions: readonly string[];
}

export type AgentProposal = Tagged<
  {
    readonly portfolioMandate: PortfolioMandateDigest;
    readonly agent: AgentId;
    /** Strictly increasing per agent: an older or repeated sequence is a replay. */
    readonly sequence: bigint;
    readonly candidate: ActionCandidate;
    readonly requested: ResourceVector;
    readonly minimum: ResourceVector;
    /** Ranking metadata. Signed i64 basis points; orders claims, authorizes nothing. */
    readonly utilityBps: bigint;
    readonly createdAt: bigint;
    readonly expiresAt: bigint;
    readonly criticalExtensions: readonly Identifier[];
  },
  'AgentProposal'
>;

/** A proposal and the agent's signature over it: what an agent hands the room. */
export interface SignedProposal {
  readonly proposal: AgentProposal;
  /** 65-byte `r ‖ s ‖ v`, lowercase `0x` hex. */
  readonly signature: string;
}

export function validateAgentProposal(input: AgentProposalInput, path = 'proposal'): CoreResult<AgentProposal> {
  const shape = checkFields(input, ['portfolioMandate', 'agent', 'sequence', 'candidate', 'requested', 'minimum', 'utilityBps', 'createdAt', 'expiresAt', 'criticalExtensions'], path);
  if (!shape.ok) return shape;
  const portfolioMandate = parseDigest<PortfolioMandateDigest>(input.portfolioMandate, at(path, 'portfolioMandate'));
  if (!portfolioMandate.ok) return portfolioMandate;
  const agent = validateAgentId(input.agent, at(path, 'agent'));
  if (!agent.ok) return agent;
  const sequence = parseIntegerInRange(input.sequence, 0n, UINT64_MAX, at(path, 'sequence'));
  if (!sequence.ok) return sequence;
  const candidate = validateActionCandidate(input.candidate, at(path, 'candidate'));
  if (!candidate.ok) return candidate;
  const requested = validateResourceVector(input.requested, at(path, 'requested'));
  if (!requested.ok) return requested;
  const minimum = validateResourceVector(input.minimum, at(path, 'minimum'));
  if (!minimum.ok) return minimum;
  const utility = parseIntegerInRange(input.utilityBps, INT64_MIN, INT64_MAX, at(path, 'utilityBps'));
  if (!utility.ok) return utility;
  const window = validateWindow(input.createdAt, input.expiresAt, path, 'createdAt');
  if (!window.ok) return window;
  const arr = checkArray(input.criticalExtensions, MAX_EXTENSIONS, at(path, 'criticalExtensions'));
  if (!arr.ok) return arr;
  const ext: Identifier[] = [];
  for (let i = 0; i < input.criticalExtensions.length; i += 1) {
    const e = parseIdentifierAs(input.criticalExtensions[i] as string, at(at(path, 'criticalExtensions'), i));
    if (!e.ok) return e;
    ext.push(e.value);
  }
  const extensions = canonicalSet(ext, (w, e) => w.str(e), at(path, 'criticalExtensions'));
  if (!extensions.ok) return extensions;
  return ok({
    portfolioMandate: portfolioMandate.value,
    agent: agent.value,
    sequence: sequence.value,
    candidate: candidate.value,
    requested: requested.value,
    minimum: minimum.value,
    utilityBps: utility.value,
    createdAt: window.value.notBefore,
    expiresAt: window.value.expiresAt,
    criticalExtensions: extensions.value,
  } as AgentProposal);
}

export function encodeAgentProposal(p: AgentProposal): Uint8Array {
  const w = portfolioWriter(PortfolioTag.PROPOSAL);
  writeDigest(w, p.portfolioMandate);
  writeParty(w, p.agent);
  w.u64(p.sequence);
  writeActionCandidate(w, p.candidate);
  writeResourceVector(w, p.requested);
  writeResourceVector(w, p.minimum);
  w.i64(p.utilityBps).i64(p.createdAt).i64(p.expiresAt);
  w.u16(p.criticalExtensions.length);
  for (const e of p.criticalExtensions) w.str(e);
  return w.finish();
}

function readProposalInput(r: CoreReader): AgentProposalInput {
  const portfolioMandate = r.digest();
  const agent = readPartyInput(r);
  const sequence = r.u64();
  const candidate = readActionCandidateInput(r);
  const requested = readResourceVectorInput(r);
  const minimum = readResourceVectorInput(r);
  const utilityBps = r.i64();
  const createdAt = r.i64();
  const expiresAt = r.i64();
  const criticalExtensions = r.list(MAX_EXTENSIONS, (x) => x.str(), true);
  return { portfolioMandate, agent, sequence, candidate, requested, minimum, utilityBps, createdAt, expiresAt, criticalExtensions };
}

export function decodeAgentProposal(bytes: Uint8Array): CoreResult<AgentProposal> {
  return decodePortfolio(bytes, PortfolioTag.PROPOSAL, readProposalInput, (input) => validateAgentProposal(input));
}

export function proposalDigest(p: AgentProposal): ProposalDigest {
  return portfolioDigest<ProposalDigest>(encodeAgentProposal(p));
}

export function agentProposalInputOf(p: AgentProposal): AgentProposalInput {
  return {
    portfolioMandate: p.portfolioMandate,
    agent: partyIdInputOf(p.agent),
    sequence: p.sequence,
    candidate: actionCandidateInputOf(p.candidate),
    requested: resourceVectorInputOf(p.requested),
    minimum: resourceVectorInputOf(p.minimum),
    utilityBps: p.utilityBps,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    criticalExtensions: [...p.criticalExtensions],
  };
}

/** What an agent signs: `keccak(str("PORTFOLIO_PROPOSAL_SIGNATURE.V1") ‖ u16(1) ‖ proposalDigest)`. */
export function proposalSigningHash(digest: ProposalDigest): Uint8Array {
  const w: ByteWriter = portfolioWriter(PortfolioTag.PROPOSAL_SIGNATURE);
  writeDigest(w, digest);
  return hexToBytes(keccakDigest<Digest32>(w.finish()));
}

/** Authentication only: the signature recovers to the proposal's own `agent`. Only `eip155-address` agents can sign in v1. */
export function proposalSignedByAgent(p: AgentProposal, signature: string): boolean {
  if (p.agent.kind !== 'eip155-address') return false;
  return recoverSigner(proposalSigningHash(proposalDigest(p)), signature) === p.agent.value;
}
