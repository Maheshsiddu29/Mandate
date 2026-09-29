/**
 * Agent releases (portfolio-mandate.md §6, §10).
 *
 * An agent returning unused allocation to the portfolio signs a release, as it
 * signs a proposal: a release can only *reduce* the releasing agent's own
 * allocation, so it can never create authority, but an unauthenticated one
 * would let any party strip an agent of its allocation.
 */

import { ok } from '@mandate/kernel';
import {
  UINT64_MAX,
  at,
  checkFields,
  hexToBytes,
  keccakDigest,
  parseDigest,
  parseIntegerInRange,
  partyIdInputOf,
  readPartyInput,
  validateAgentId,
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
import { PortfolioTag, decodePortfolio, portfolioDigest, portfolioWriter } from './encoding.ts';
import type { PortfolioMandateDigest } from './mandate.ts';
import { readResourceVectorInput, resourceVectorInputOf, validateResourceVector, writeResourceVector, type ResourceAmountInput, type ResourceVector } from './resources.ts';

export type ReleaseDigest = Tagged<Digest32, 'ReleaseDigest'>;

export interface AgentReleaseInput {
  readonly portfolioMandate: string;
  readonly agent: PartyIdInput;
  /** Strictly increasing per agent, in its own sequence space. */
  readonly sequence: IntegerInput;
  readonly amounts: readonly ResourceAmountInput[];
}

export type AgentRelease = Tagged<{ readonly portfolioMandate: PortfolioMandateDigest; readonly agent: AgentId; readonly sequence: bigint; readonly amounts: ResourceVector }, 'AgentRelease'>;

export interface SignedRelease {
  readonly release: AgentRelease;
  readonly signature: string;
}

export function validateAgentRelease(input: AgentReleaseInput, path = 'release'): CoreResult<AgentRelease> {
  const shape = checkFields(input, ['portfolioMandate', 'agent', 'sequence', 'amounts'], path);
  if (!shape.ok) return shape;
  const portfolioMandate = parseDigest<PortfolioMandateDigest>(input.portfolioMandate, at(path, 'portfolioMandate'));
  if (!portfolioMandate.ok) return portfolioMandate;
  const agent = validateAgentId(input.agent, at(path, 'agent'));
  if (!agent.ok) return agent;
  const sequence = parseIntegerInRange(input.sequence, 0n, UINT64_MAX, at(path, 'sequence'));
  if (!sequence.ok) return sequence;
  const amounts = validateResourceVector(input.amounts, at(path, 'amounts'));
  if (!amounts.ok) return amounts;
  return ok({ portfolioMandate: portfolioMandate.value, agent: agent.value, sequence: sequence.value, amounts: amounts.value } as AgentRelease);
}

export function encodeAgentRelease(r: AgentRelease): Uint8Array {
  const w = portfolioWriter(PortfolioTag.RELEASE);
  writeDigest(w, r.portfolioMandate);
  writeParty(w, r.agent);
  w.u64(r.sequence);
  writeResourceVector(w, r.amounts);
  return w.finish();
}

function readReleaseInput(r: CoreReader): AgentReleaseInput {
  const portfolioMandate = r.digest();
  const agent = readPartyInput(r);
  const sequence = r.u64();
  const amounts = readResourceVectorInput(r);
  return { portfolioMandate, agent, sequence, amounts };
}

export function decodeAgentRelease(bytes: Uint8Array): CoreResult<AgentRelease> {
  return decodePortfolio(bytes, PortfolioTag.RELEASE, readReleaseInput, (input) => validateAgentRelease(input));
}

export function releaseDigest(r: AgentRelease): ReleaseDigest {
  return portfolioDigest<ReleaseDigest>(encodeAgentRelease(r));
}

export function releaseSigningHash(digest: ReleaseDigest): Uint8Array {
  const w = portfolioWriter(PortfolioTag.RELEASE_SIGNATURE);
  writeDigest(w, digest);
  return hexToBytes(keccakDigest<Digest32>(w.finish()));
}

export function releaseSignedByAgent(r: AgentRelease, signature: string): boolean {
  if (r.agent.kind !== 'eip155-address') return false;
  return recoverSigner(releaseSigningHash(releaseDigest(r)), signature) === r.agent.value;
}

export function agentReleaseInputOf(r: AgentRelease): AgentReleaseInput {
  return { portfolioMandate: r.portfolioMandate, agent: partyIdInputOf(r.agent), sequence: r.sequence, amounts: resourceVectorInputOf(r.amounts) };
}
