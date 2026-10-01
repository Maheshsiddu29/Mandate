/**
 * The Portfolio Mandate v1 object (portfolio-mandate.md §4–§5).
 *
 * `PORTFOLIO_MANDATE.V1` is a separate, versioned object above Core — not MCE
 * v3 and not a Core grant. It is the principal's statement of which agents may
 * act, in which scope, over which declared resources, within which limits and
 * under which allocation mode. Core objects are *derived* from it
 * (compile.ts); it grants nothing on its own.
 *
 * This module is structure only: shape, canonical order, the encoding, the
 * digest and the principal's signing hash. Whether a well-formed mandate is
 * *valid* — every agent a subset of the portfolio, every resource declared,
 * the allocation mode's rules obeyed — is `checkPortfolioMandate`
 * (authority.ts), which collects every violation.
 */

import { ok, type ByteWriter, type Identifier } from '@mandate/kernel';
import {
  UINT64_MAX,
  at,
  canonicalSet,
  checkArray,
  checkFields,
  hexToBytes,
  keccakDigest,
  parseEnum,
  parseIdentifierAs,
  parseIntegerInRange,
  partyIdInputOf,
  readCode,
  readPartyInput,
  validateAgentId,
  validatePrincipalId,
  validateWindow,
  writeCode,
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
  type WireCodes,
} from '@mandate/core';
import { recoverSigner } from '@mandate/execution-gate';
import { PortfolioTag, decodePortfolio, portfolioDigest, portfolioWriter } from './encoding.ts';
import {
  MAX_RESOURCES,
  readResourceDefinitionInput,
  readResourceVectorInput,
  resourceDefinitionInputOf,
  resourceVectorInputOf,
  validateResourceDefinitions,
  validateResourceVector,
  writeResourceDefinition,
  writeResourceVector,
  type ResourceAmountInput,
  type ResourceDefinition,
  type ResourceDefinitionInput,
  type ResourceVector,
} from './resources.ts';
import { authorityScopeInputOf, readAuthorityScopeInput, validateAuthorityScope, writeAuthorityScope, type AuthorityScope, type AuthorityScopeInput } from './scope.ts';

export const MAX_AGENTS = 16;

export type PortfolioMandateDigest = Tagged<Digest32, 'PortfolioMandateDigest'>;

export const AllocationMode = { PREALLOCATED: 'PREALLOCATED', DYNAMIC: 'DYNAMIC', HYBRID: 'HYBRID' } as const;
export type AllocationMode = (typeof AllocationMode)[keyof typeof AllocationMode];
const ALLOCATION_MODES: readonly AllocationMode[] = Object.values(AllocationMode);
const ALLOCATION_MODE_CODE: WireCodes<AllocationMode> = { PREALLOCATED: 1, DYNAMIC: 2, HYBRID: 3 };

export interface AgentPolicyInput {
  readonly agent: PartyIdInput;
  /** Display only; no decision reads it. */
  readonly label: string;
  readonly scope: AuthorityScopeInput;
  readonly notBefore: IntegerInput;
  readonly expiresAt: IntegerInput;
  readonly hardMaxima: readonly ResourceAmountInput[];
  readonly preferred: readonly ResourceAmountInput[];
}

export type AgentPolicy = Tagged<
  {
    readonly agent: AgentId;
    readonly label: Identifier;
    readonly scope: AuthorityScope;
    readonly notBefore: bigint;
    readonly expiresAt: bigint;
    /**
     * The agent's own ceilings, each ≤ the portfolio limit of the same resource. A resource the agent
     * does not list is bounded by the portfolio limit alone — exactly Core's rule that a child need not
     * restate a ledger dimension because the parent's leg is charged regardless (authority-model.md §4).
     */
    readonly hardMaxima: ResourceVector;
    /** PREALLOCATED: the allocation. HYBRID: the preferred allocation. DYNAMIC: empty. */
    readonly preferred: ResourceVector;
  },
  'AgentPolicy'
>;

export interface PortfolioMandateInput {
  readonly principal: PartyIdInput;
  readonly policyVersion: IntegerInput;
  readonly nonce: IntegerInput;
  readonly notBefore: IntegerInput;
  readonly expiresAt: IntegerInput;
  readonly allocationMode: string;
  readonly resources: readonly ResourceDefinitionInput[];
  readonly scope: AuthorityScopeInput;
  readonly limits: readonly ResourceAmountInput[];
  readonly agents: readonly AgentPolicyInput[];
}

export type PortfolioMandate = Tagged<
  {
    readonly principal: PrincipalId;
    readonly policyVersion: bigint;
    readonly nonce: bigint;
    readonly notBefore: bigint;
    readonly expiresAt: bigint;
    readonly allocationMode: AllocationMode;
    readonly resources: readonly ResourceDefinition[];
    /** The portfolio's own authority: every agent's scope must be a subset of it. */
    readonly scope: AuthorityScope;
    /** Portfolio-wide limits. Closed world: an undeclared or unlimited resource has limit zero. */
    readonly limits: ResourceVector;
    /** Ascending by the agent party's encoding. */
    readonly agents: readonly AgentPolicy[];
  },
  'PortfolioMandate'
>;

// --- Validation ------------------------------------------------------------------------

export function validateAgentPolicy(input: AgentPolicyInput, path: string): CoreResult<AgentPolicy> {
  const shape = checkFields(input, ['agent', 'label', 'scope', 'notBefore', 'expiresAt', 'hardMaxima', 'preferred'], path);
  if (!shape.ok) return shape;
  const agent = validateAgentId(input.agent, at(path, 'agent'));
  if (!agent.ok) return agent;
  const label = parseIdentifierAs(input.label, at(path, 'label'));
  if (!label.ok) return label;
  const scope = validateAuthorityScope(input.scope, at(path, 'scope'));
  if (!scope.ok) return scope;
  const window = validateWindow(input.notBefore, input.expiresAt, path);
  if (!window.ok) return window;
  const hardMaxima = validateResourceVector(input.hardMaxima, at(path, 'hardMaxima'));
  if (!hardMaxima.ok) return hardMaxima;
  const preferred = validateResourceVector(input.preferred, at(path, 'preferred'));
  if (!preferred.ok) return preferred;
  return ok({
    agent: agent.value,
    label: label.value,
    scope: scope.value,
    notBefore: window.value.notBefore,
    expiresAt: window.value.expiresAt,
    hardMaxima: hardMaxima.value,
    preferred: preferred.value,
  } as AgentPolicy);
}

function writeAgentPolicy(w: ByteWriter, a: AgentPolicy): void {
  writeParty(w, a.agent);
  w.str(a.label);
  writeAuthorityScope(w, a.scope);
  w.i64(a.notBefore).i64(a.expiresAt);
  writeResourceVector(w, a.hardMaxima);
  writeResourceVector(w, a.preferred);
}

function readAgentPolicyInput(r: CoreReader): AgentPolicyInput {
  const agent = readPartyInput(r);
  const label = r.str();
  const scope = readAuthorityScopeInput(r);
  const notBefore = r.i64();
  const expiresAt = r.i64();
  const hardMaxima = readResourceVectorInput(r);
  const preferred = readResourceVectorInput(r);
  return { agent, label, scope, notBefore, expiresAt, hardMaxima, preferred };
}

/** Structure only; `checkPortfolioMandate` decides validity. Agents are unique by party, whatever else differs. */
export function validatePortfolioMandate(input: PortfolioMandateInput, path = 'mandate'): CoreResult<PortfolioMandate> {
  const shape = checkFields(input, ['principal', 'policyVersion', 'nonce', 'notBefore', 'expiresAt', 'allocationMode', 'resources', 'scope', 'limits', 'agents'], path);
  if (!shape.ok) return shape;
  const principal = validatePrincipalId(input.principal, at(path, 'principal'));
  if (!principal.ok) return principal;
  const policyVersion = parseIntegerInRange(input.policyVersion, 0n, UINT64_MAX, at(path, 'policyVersion'));
  if (!policyVersion.ok) return policyVersion;
  const nonce = parseIntegerInRange(input.nonce, 0n, UINT64_MAX, at(path, 'nonce'));
  if (!nonce.ok) return nonce;
  const window = validateWindow(input.notBefore, input.expiresAt, path);
  if (!window.ok) return window;
  const allocationMode = parseEnum(input.allocationMode, ALLOCATION_MODES, at(path, 'allocationMode'));
  if (!allocationMode.ok) return allocationMode;
  const resources = validateResourceDefinitions(input.resources, at(path, 'resources'));
  if (!resources.ok) return resources;
  const scope = validateAuthorityScope(input.scope, at(path, 'scope'));
  if (!scope.ok) return scope;
  const limits = validateResourceVector(input.limits, at(path, 'limits'));
  if (!limits.ok) return limits;
  const arr = checkArray(input.agents, MAX_AGENTS, at(path, 'agents'));
  if (!arr.ok) return arr;
  const agents: AgentPolicy[] = [];
  for (let i = 0; i < input.agents.length; i += 1) {
    const a = validateAgentPolicy(input.agents[i] as AgentPolicyInput, at(at(path, 'agents'), i));
    if (!a.ok) return a;
    agents.push(a.value);
  }
  const unique = canonicalSet(agents, (w, a) => writeParty(w, a.agent), at(path, 'agents'));
  if (!unique.ok) return unique;
  return ok({
    principal: principal.value,
    policyVersion: policyVersion.value,
    nonce: nonce.value,
    notBefore: window.value.notBefore,
    expiresAt: window.value.expiresAt,
    allocationMode: allocationMode.value,
    resources: resources.value,
    scope: scope.value,
    limits: limits.value,
    agents: unique.value,
  } as PortfolioMandate);
}

// --- Encoding and identity ------------------------------------------------------------------

export function encodePortfolioMandate(m: PortfolioMandate): Uint8Array {
  const w = portfolioWriter(PortfolioTag.MANDATE);
  writeParty(w, m.principal);
  w.u64(m.policyVersion).u64(m.nonce);
  w.i64(m.notBefore).i64(m.expiresAt);
  writeCode(w, ALLOCATION_MODE_CODE, m.allocationMode);
  w.u16(m.resources.length);
  for (const d of m.resources) writeResourceDefinition(w, d);
  writeAuthorityScope(w, m.scope);
  writeResourceVector(w, m.limits);
  w.u16(m.agents.length);
  for (const a of m.agents) writeAgentPolicy(w, a);
  return w.finish();
}

function readMandateInput(r: CoreReader): PortfolioMandateInput {
  const principal = readPartyInput(r);
  const policyVersion = r.u64();
  const nonce = r.u64();
  const notBefore = r.i64();
  const expiresAt = r.i64();
  const allocationMode = readCode(r, ALLOCATION_MODE_CODE);
  const resources = r.list(MAX_RESOURCES, readResourceDefinitionInput, true);
  const scope = readAuthorityScopeInput(r);
  const limits = readResourceVectorInput(r);
  // Agents are ordered by party, and the rest of each entry follows: the set rule is checked on the party by the validator.
  const agents = r.list(MAX_AGENTS, readAgentPolicyInput, true);
  return { principal, policyVersion, nonce, notBefore, expiresAt, allocationMode, resources, scope, limits, agents };
}

export function decodePortfolioMandate(bytes: Uint8Array): CoreResult<PortfolioMandate> {
  return decodePortfolio(bytes, PortfolioTag.MANDATE, readMandateInput, (input) => validatePortfolioMandate(input));
}

export function portfolioMandateDigest(m: PortfolioMandate): PortfolioMandateDigest {
  return portfolioDigest<PortfolioMandateDigest>(encodePortfolioMandate(m));
}

export function agentPolicyInputOf(a: AgentPolicy): AgentPolicyInput {
  return {
    agent: partyIdInputOf(a.agent),
    label: a.label,
    scope: authorityScopeInputOf(a.scope),
    notBefore: a.notBefore,
    expiresAt: a.expiresAt,
    hardMaxima: resourceVectorInputOf(a.hardMaxima),
    preferred: resourceVectorInputOf(a.preferred),
  };
}

export function portfolioMandateInputOf(m: PortfolioMandate): PortfolioMandateInput {
  return {
    principal: partyIdInputOf(m.principal),
    policyVersion: m.policyVersion,
    nonce: m.nonce,
    notBefore: m.notBefore,
    expiresAt: m.expiresAt,
    allocationMode: m.allocationMode,
    resources: m.resources.map(resourceDefinitionInputOf),
    scope: authorityScopeInputOf(m.scope),
    limits: resourceVectorInputOf(m.limits),
    agents: m.agents.map(agentPolicyInputOf),
  };
}

export function agentPolicyOf(m: PortfolioMandate, agent: { readonly kind: string; readonly value: string }): AgentPolicy | null {
  return m.agents.find((a) => a.agent.kind === agent.kind && a.agent.value === agent.value) ?? null;
}

// --- Signatures --------------------------------------------------------------------------

/**
 * What the principal signs: `keccak(str("PORTFOLIO_MANDATE_SIGNATURE.V1") ‖
 * u16(1) ‖ digest)`. The prefix is this object's alone, so a signature over a
 * portfolio mandate cannot stand for a proposal, a kernel mandate or a Core
 * grant, or the reverse.
 */
export function mandateSigningHash(digest: PortfolioMandateDigest): Uint8Array {
  const w = portfolioWriter(PortfolioTag.MANDATE_SIGNATURE);
  writeDigest(w, digest);
  return hexToBytes(keccakDigest<Digest32>(w.finish()));
}

/**
 * V1: whether `signature` (65-byte `r ‖ s ‖ v`, the kernel's acceptance rule)
 * recovers to the mandate's own principal over `mandateSigningHash`. Only
 * `eip155-address` principals can sign in v1; any other scheme is refused.
 * An EIP-712 wallet signature is a different object and is refused here;
 * `mandateSignedByPrincipalV2` (mandate-v2.ts) checks that one, and only
 * when the caller names the V2 authority.
 */
export function mandateSignedByPrincipal(m: PortfolioMandate, signature: string): boolean {
  if (m.principal.kind !== 'eip155-address') return false;
  return recoverSigner(mandateSigningHash(portfolioMandateDigest(m)), signature) === m.principal.value;
}
