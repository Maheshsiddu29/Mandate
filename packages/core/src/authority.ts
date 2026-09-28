/**
 * Authority grants and the principal policy (authority-model.md §2, §8).
 *
 * A grant is the only way authority comes into existence. Its identity is its
 * content: `AuthorityId = H("mandate-core/v1/authority", grant)`. A root grant's
 * `AuthorityId` is a `MandateId`; a delegation's is a `DelegationId`; only
 * `grantIdentity` produces either, from a validated grant, so a digest cannot
 * be promoted to a `MandateId` without the grant that proves it is a root.
 *
 * The principal policy is a separate Core object with its own tag. It grants
 * nothing. It may carry only principal-global ledger dimensions (charged by the
 * ledger, later), principal-global invariants (evaluated, later) and
 * principal-global state policy (admission requirements) — three distinct
 * term kinds, never merged. A `SET` or `RIGHT` term in a policy is refused as
 * `PRINCIPAL_POLICY_GRANTS_AUTHORITY`, both when the object is constructed and
 * when bytes are decoded, and the input type does not admit one at all.
 *
 * Signing is not implemented. The digest is the signable value: a signature
 * over `AuthorityId` or `PrincipalPolicyId`, under distinct tags, can never be
 * replayed as the other.
 */

import { ok, type ByteWriter } from '@mandate/kernel';
import type { Tagged } from './brand.ts';
import { at, fail, type CoreResult } from './errors.ts';
import {
  partyIdInputOf,
  partyIdsEqual,
  readPartyInput,
  validateAgentId,
  validatePrincipalId,
  writeParty,
  type AgentId,
  type AuthorityId,
  type DelegationId,
  type MandateId,
  type Nonce,
  type PartyIdInput,
  type PolicySequence,
  type PrincipalId,
  type PrincipalPolicyId,
} from './identifiers.ts';
import { checkFields, parseDigest, parseEnum, parseUint64, type IntegerInput } from './primitives.ts';
import {
  CoreTag,
  decodeTagged,
  keccakDigest,
  readCode,
  taggedWriter,
  writeCode,
  writeDigest,
  writeList,
  type CoreReader,
  type WireCodes,
} from './encoding.ts';
import {
  GRANTING_TERM_KINDS,
  TERM_KINDS,
  readTermInput,
  termInputOf,
  validateTerm,
  validateTermList,
  validateWindow,
  writeTerm,
  type AuthorityTerm,
  type AuthorityTermInput,
  type LedgerDimensionTerm,
  type PrincipalPolicyTerm,
  type PrincipalPolicyTermInput,
  type StateInvariantTerm,
  type StatePolicyTerm,
} from './terms.ts';
import { MAX_GRANT_TERMS, MAX_POLICY_TERMS } from './limits.ts';

// --- Grants ----------------------------------------------------------------------

export type GrantLineageInput =
  | { readonly kind: 'ROOT'; readonly issuer: PartyIdInput }
  | { readonly kind: 'DELEGATION'; readonly parent: string; readonly issuer: PartyIdInput };

/**
 * `parent` and `issuer` together, typed by role. A root's issuer is the
 * principal; a delegation's is the parent node's holder, an agent.
 */
export type GrantLineage =
  | { readonly kind: 'ROOT'; readonly issuer: PrincipalId }
  | { readonly kind: 'DELEGATION'; readonly parent: AuthorityId; readonly issuer: AgentId };

const LINEAGE_KINDS: readonly GrantLineage['kind'][] = ['ROOT', 'DELEGATION'];
const LINEAGE_CODE: WireCodes<GrantLineage['kind']> = { ROOT: 1, DELEGATION: 2 };

export interface AuthorityGrantInput {
  readonly lineage: GrantLineageInput;
  readonly principal: PartyIdInput;
  readonly holder: PartyIdInput;
  readonly notBefore: IntegerInput;
  readonly expiresAt: IntegerInput;
  readonly terms: readonly AuthorityTermInput[];
  readonly nonce: IntegerInput;
}

export type AuthorityGrant = Tagged<
  {
    readonly lineage: GrantLineage;
    /** Restated so the digest commits to whose resources are at stake. */
    readonly principal: PrincipalId;
    readonly holder: AgentId;
    /** `notBefore ≤ t < expiresAt`; mandatory, there is no "until revoked" grant. */
    readonly notBefore: bigint;
    readonly expiresAt: bigint;
    readonly terms: readonly AuthorityTerm[];
    /** Distinguishes otherwise identical grants: two such grants are two nodes. */
    readonly nonce: Nonce;
  },
  'AuthorityGrant'
>;

function validateLineage(input: GrantLineageInput, path: string): CoreResult<GrantLineage> {
  if (typeof input !== 'object' || input === null) return fail('WRONG_TYPE', path);
  const kind = parseEnum(input.kind, LINEAGE_KINDS, at(path, 'kind'));
  if (!kind.ok) return kind;
  if (input.kind === 'ROOT') {
    const shape = checkFields(input, ['kind', 'issuer'], path);
    if (!shape.ok) return shape;
    const issuer = validatePrincipalId(input.issuer, at(path, 'issuer'));
    return issuer.ok ? ok({ kind: 'ROOT', issuer: issuer.value }) : issuer;
  }
  const shape = checkFields(input, ['kind', 'parent', 'issuer'], path);
  if (!shape.ok) return shape;
  const parent = parseDigest<AuthorityId>(input.parent, at(path, 'parent'));
  if (!parent.ok) return parent;
  const issuer = validateAgentId(input.issuer, at(path, 'issuer'));
  return issuer.ok ? ok({ kind: 'DELEGATION', parent: parent.value, issuer: issuer.value }) : issuer;
}

export function validateAuthorityGrant(input: AuthorityGrantInput, path = 'grant'): CoreResult<AuthorityGrant> {
  const shape = checkFields(input, ['lineage', 'principal', 'holder', 'notBefore', 'expiresAt', 'terms', 'nonce'], path);
  if (!shape.ok) return shape;
  const lineage = validateLineage(input.lineage, at(path, 'lineage'));
  if (!lineage.ok) return lineage;
  const principal = validatePrincipalId(input.principal, at(path, 'principal'));
  if (!principal.ok) return principal;
  // Checkable from the grant alone; the delegation rule (issuer = parent's holder) needs the parent and is 7C's.
  if (lineage.value.kind === 'ROOT' && !partyIdsEqual(lineage.value.issuer, principal.value)) {
    return fail('ROOT_ISSUER_NOT_PRINCIPAL', at(path, 'lineage.issuer'));
  }
  const holder = validateAgentId(input.holder, at(path, 'holder'));
  if (!holder.ok) return holder;
  const window = validateWindow(input.notBefore, input.expiresAt, path);
  if (!window.ok) return window;
  const terms = validateTermList(input.terms, MAX_GRANT_TERMS, at(path, 'terms'), validateTerm);
  if (!terms.ok) return terms;
  const nonce = parseUint64(input.nonce, at(path, 'nonce'));
  if (!nonce.ok) return nonce;
  return ok({
    lineage: lineage.value,
    principal: principal.value,
    holder: holder.value,
    notBefore: window.value.notBefore,
    expiresAt: window.value.expiresAt,
    terms: terms.value,
    nonce: nonce.value as Nonce,
  } as AuthorityGrant);
}

function writeLineage(w: ByteWriter, l: GrantLineage): void {
  writeCode(w, LINEAGE_CODE, l.kind);
  if (l.kind === 'DELEGATION') writeDigest(w, l.parent);
  writeParty(w, l.issuer);
}

function readLineageInput(r: CoreReader): GrantLineageInput {
  const kind = readCode(r, LINEAGE_CODE);
  if (kind === 'ROOT') return { kind, issuer: readPartyInput(r) };
  const parent = r.digest();
  return { kind, parent, issuer: readPartyInput(r) };
}

export function encodeAuthorityGrant(g: AuthorityGrant): Uint8Array {
  const w = taggedWriter(CoreTag.AUTHORITY);
  writeLineage(w, g.lineage);
  writeParty(w, g.principal);
  writeParty(w, g.holder);
  w.i64(g.notBefore).i64(g.expiresAt);
  writeList(w, g.terms, writeTerm);
  w.u64(g.nonce);
  return w.finish();
}

function readGrantInput(r: CoreReader): AuthorityGrantInput {
  const lineage = readLineageInput(r);
  const principal = readPartyInput(r);
  const holder = readPartyInput(r);
  const notBefore = r.i64();
  const expiresAt = r.i64();
  const terms = r.list(MAX_GRANT_TERMS, readTermInput, true);
  const nonce = r.u64();
  return { lineage, principal, holder, notBefore, expiresAt, terms, nonce };
}

export function decodeAuthorityGrant(bytes: Uint8Array): CoreResult<AuthorityGrant> {
  return decodeTagged(bytes, CoreTag.AUTHORITY, readGrantInput, (input) => validateAuthorityGrant(input));
}

export function authorityId(g: AuthorityGrant): AuthorityId {
  return keccakDigest<AuthorityId>(encodeAuthorityGrant(g));
}

/** The grant's identity, typed by its position in the tree. */
export function grantIdentity(g: AuthorityGrant): { readonly kind: 'ROOT'; readonly id: MandateId } | { readonly kind: 'DELEGATION'; readonly id: DelegationId } {
  const id = authorityId(g);
  return g.lineage.kind === 'ROOT' ? { kind: 'ROOT', id: id as MandateId } : { kind: 'DELEGATION', id: id as DelegationId };
}

export function authorityGrantInputOf(g: AuthorityGrant): AuthorityGrantInput {
  const l = g.lineage;
  return {
    lineage:
      l.kind === 'ROOT'
        ? { kind: 'ROOT', issuer: partyIdInputOf(l.issuer) }
        : { kind: 'DELEGATION', parent: l.parent, issuer: partyIdInputOf(l.issuer) },
    principal: partyIdInputOf(g.principal),
    holder: partyIdInputOf(g.holder),
    notBefore: g.notBefore,
    expiresAt: g.expiresAt,
    terms: g.terms.map(termInputOf),
    nonce: g.nonce,
  };
}

// --- Principal policy ------------------------------------------------------------

export interface PrincipalPolicyInput {
  readonly principal: PartyIdInput;
  readonly sequence: IntegerInput;
  readonly terms: readonly PrincipalPolicyTermInput[];
  readonly nonce: IntegerInput;
}

export type PrincipalPolicy = Tagged<
  {
    readonly principal: PrincipalId;
    /** Strictly greater than the policy it replaces (checked by the ledger). */
    readonly sequence: PolicySequence;
    /** Dimensions, invariants and state policy only. May be empty: an explicit statement that roots are independent. */
    readonly terms: readonly PrincipalPolicyTerm[];
    readonly nonce: Nonce;
  },
  'PrincipalPolicy'
>;

function validatePolicyTerm(input: AuthorityTermInput, path: string): CoreResult<PrincipalPolicyTerm> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail('WRONG_TYPE', path);
  const kind = parseEnum(input.kind, TERM_KINDS, at(path, 'kind'));
  if (!kind.ok) return kind;
  // Checked before the body is validated, so a granting term is named as such even if it is also malformed.
  if (GRANTING_TERM_KINDS.includes(kind.value)) return fail('PRINCIPAL_POLICY_GRANTS_AUTHORITY', at(path, 'kind'));
  if (kind.value !== 'LEDGER_DIMENSION' && kind.value !== 'STATE_INVARIANT' && kind.value !== 'STATE_POLICY') {
    return fail('PRINCIPAL_POLICY_TERM_NOT_PERMITTED', at(path, 'kind'));
  }
  const term = validateTerm(input, path);
  if (!term.ok) return term;
  return ok(term.value as PrincipalPolicyTerm);
}

export function validatePrincipalPolicy(input: PrincipalPolicyInput, path = 'policy'): CoreResult<PrincipalPolicy> {
  const shape = checkFields(input, ['principal', 'sequence', 'terms', 'nonce'], path);
  if (!shape.ok) return shape;
  const principal = validatePrincipalId(input.principal, at(path, 'principal'));
  if (!principal.ok) return principal;
  const sequence = parseUint64(input.sequence, at(path, 'sequence'));
  if (!sequence.ok) return sequence;
  const terms = validateTermList(input.terms, MAX_POLICY_TERMS, at(path, 'terms'), validatePolicyTerm);
  if (!terms.ok) return terms;
  const nonce = parseUint64(input.nonce, at(path, 'nonce'));
  if (!nonce.ok) return nonce;
  return ok({
    principal: principal.value,
    sequence: sequence.value as PolicySequence,
    terms: terms.value,
    nonce: nonce.value as Nonce,
  } as PrincipalPolicy);
}

export function encodePrincipalPolicy(p: PrincipalPolicy): Uint8Array {
  const w = taggedWriter(CoreTag.PRINCIPAL_POLICY);
  writeParty(w, p.principal);
  w.u64(p.sequence);
  writeList(w, p.terms, writeTerm);
  w.u64(p.nonce);
  return w.finish();
}

function readPolicyInput(r: CoreReader): PrincipalPolicyInput {
  const principal = readPartyInput(r);
  const sequence = r.u64();
  // Any term kind decodes; the validator then refuses granting kinds by name.
  const terms = r.list(MAX_POLICY_TERMS, readTermInput, true) as PrincipalPolicyTermInput[];
  const nonce = r.u64();
  return { principal, sequence, terms, nonce };
}

export function decodePrincipalPolicy(bytes: Uint8Array): CoreResult<PrincipalPolicy> {
  return decodeTagged(bytes, CoreTag.PRINCIPAL_POLICY, readPolicyInput, (input) => validatePrincipalPolicy(input));
}

export function principalPolicyId(p: PrincipalPolicy): PrincipalPolicyId {
  return keccakDigest<PrincipalPolicyId>(encodePrincipalPolicy(p));
}

export function principalPolicyInputOf(p: PrincipalPolicy): PrincipalPolicyInput {
  return {
    principal: partyIdInputOf(p.principal),
    sequence: p.sequence,
    terms: p.terms.map((t) => termInputOf(t) as PrincipalPolicyTermInput),
    nonce: p.nonce,
  };
}

/** Principal-global ledger dimensions: legs on every charging path (7C). */
export function policyDimensions(p: PrincipalPolicy): readonly LedgerDimensionTerm[] {
  return p.terms.filter((t): t is LedgerDimensionTerm => t.kind === 'LEDGER_DIMENSION');
}

/** Principal-global invariants: evaluated over all admitted state and every pending reservation (7D). */
export function policyInvariants(p: PrincipalPolicy): readonly StateInvariantTerm[] {
  return p.terms.filter((t): t is StateInvariantTerm => t.kind === 'STATE_INVARIANT');
}

/** Principal-global state policy: tightens every lineage's admission requirement (7D). */
export function policyStatePolicy(p: PrincipalPolicy): readonly StatePolicyTerm[] {
  return p.terms.filter((t): t is StatePolicyTerm => t.kind === 'STATE_POLICY');
}
