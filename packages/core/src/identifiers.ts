/**
 * Canonical identifiers (action-state-model.md §2, architecture.md §9).
 *
 * Three families, none interchangeable with another without an explicit
 * conversion:
 *
 * - **Names** — validated ASCII identifiers (ADR 0002 charset): `DomainId`,
 *   `ModuleId`, `StateSourceId`, `ActionType`, ... A name is never identity
 *   for anything whose content matters; it is paired with a digest wherever
 *   the specification says so (`ModuleRef`, `AdapterRef`).
 * - **Content digests** — keccak-256 over a tagged canonical encoding
 *   (decision 3: "Identity is content"): `AuthorityId`, `ActionId`,
 *   `StateId`, `ReservationId`, ... Core computes them; they are never
 *   accepted in place of the object they identify.
 * - **Parties and resources** — structured: `PartyId` (the kernel's scheme +
 *   key, reused unchanged) in a principal or agent role, and `ResourceId`
 *   `(domain, kind, localId)`, compared by exact canonical bytes and never
 *   parsed to infer behaviour.
 */

import { ok, parsePartyId, type ByteWriter, type Identifier } from '@mandate/kernel';
import type { Tagged } from './brand.ts';
import { at, fail, type CoreResult } from './errors.ts';
import { checkFields, parseEnum, parseIdentifierAs, type Digest32 } from './primitives.ts';
import { readCode, writeCode, type CoreReader, type WireCodes } from './encoding.ts';

// --- Names ---------------------------------------------------------------------

/** A domain: the family of actions and state a module interprets, e.g. `perp`, `evm-spot`. */
export type DomainId = Tagged<Identifier, 'DomainId'>;
export type ModuleId = Tagged<Identifier, 'ModuleId'>;
export type AdapterId = Tagged<Identifier, 'AdapterId'>;
/** A configured `StateSource` (action-state-model.md §5.2). */
export type StateSourceId = Tagged<Identifier, 'StateSourceId'>;
/** e.g. `perp.markPrice`, `perp.account`, `evm.balance`. */
export type StateKind = Tagged<Identifier, 'StateKind'>;
/** An entry of a domain's closed action vocabulary. */
export type ActionType = Tagged<Identifier, 'ActionType'>;
export type BoundId = Tagged<Identifier, 'BoundId'>;
export type DimensionId = Tagged<Identifier, 'DimensionId'>;
/** Namespaced: `core.*`, `perp.*`, `lending.*`. */
export type InvariantId = Tagged<Identifier, 'InvariantId'>;
export type FinalityLadderId = Tagged<Identifier, 'FinalityLadderId'>;
export type FinalityLevel = Tagged<Identifier, 'FinalityLevel'>;
/** A named artifact field an enforcement point checks, e.g. `limitPrice`. */
export type ArtifactField = Tagged<Identifier, 'ArtifactField'>;
export type CoreVersionId = Tagged<Identifier, 'CoreVersionId'>;
export type ResourceLocalId = Tagged<Identifier, 'ResourceLocalId'>;

// --- Content digests -----------------------------------------------------------

/** `H("mandate-core/v1/authority", grant)`: the common identity of root grants and delegations. */
export type AuthorityId = Tagged<Digest32, 'AuthorityId'>;
/** The `AuthorityId` of a root grant. Only `grantIdentity` produces one. */
export type MandateId = Tagged<AuthorityId, 'MandateId'>;
/** The `AuthorityId` of a non-root grant. Only `grantIdentity` produces one. */
export type DelegationId = Tagged<AuthorityId, 'DelegationId'>;
/** `H("mandate-core/v1/principal-policy", policy)`; the specification's `PolicyId`. */
export type PrincipalPolicyId = Tagged<Digest32, 'PrincipalPolicyId'>;
/** `H("mandate-core/v1/action", envelope)`: the `ActionDigest`. An intent's identity is its content. */
export type ActionId = Tagged<Digest32, 'ActionId'>;
export type PayloadDigest = Tagged<Digest32, 'PayloadDigest'>;
/** `H("mandate-core/v1/state", envelope)`: the `StateDigest`. */
export type StateId = Tagged<Digest32, 'StateId'>;
export type StatePayloadDigest = Tagged<Digest32, 'StatePayloadDigest'>;
export type StateBindingId = Tagged<Digest32, 'StateBindingId'>;
/** `H("mandate-core/v1/reservation", actionId, generation)`. */
export type ReservationId = Tagged<Digest32, 'ReservationId'>;
export type ReservationRefDigest = Tagged<Digest32, 'ReservationRefDigest'>;
export type ExecutionAuthorizationId = Tagged<Digest32, 'ExecutionAuthorizationId'>;
/** The `bindingDigest` of an `ExecutionBindingRef`. */
export type ExecutionBindingId = Tagged<Digest32, 'ExecutionBindingId'>;
/** The adapter's own digest of its canonical execution parameters. Opaque to Core. */
export type ExecutionParametersDigest = Tagged<Digest32, 'ExecutionParametersDigest'>;
/** Identity of an observation (7D). Referenced, not defined, here. */
export type ObservationId = Tagged<Digest32, 'ObservationId'>;
/** Identity of a receipt (7H). Referenced, not defined, here. */
export type ReceiptId = Tagged<Digest32, 'ReceiptId'>;
export type LedgerHeadDigest = Tagged<Digest32, 'LedgerHeadDigest'>;
/** `H("mandate-core/v1/module", ModuleManifest)`: the semantic module's identity. */
export type ModuleDigest = Tagged<Digest32, 'ModuleDigest'>;
/** Digest of an exact implementation artifact registered as conforming to a `ModuleDigest`. */
export type ImplementationDigest = Tagged<Digest32, 'ImplementationDigest'>;
export type AdapterDigest = Tagged<Digest32, 'AdapterDigest'>;
export type ModuleRefDigest = Tagged<Digest32, 'ModuleRefDigest'>;
export type AdapterRefDigest = Tagged<Digest32, 'AdapterRefDigest'>;
export type QuantityDigest = Tagged<Digest32, 'QuantityDigest'>;

// --- Counters and versions -----------------------------------------------------

export type ModuleVersion = Tagged<number, 'ModuleVersion'>;
export type AdapterVersion = Tagged<number, 'AdapterVersion'>;
export type InvariantVersion = Tagged<number, 'InvariantVersion'>;
export type Nonce = Tagged<bigint, 'Nonce'>;
/** Per-intent reservation counter; ≥ 1 on every reservation (reservations-reconciliation.md §3). */
export type ReservationGeneration = Tagged<bigint, 'ReservationGeneration'>;
/** The principal-wide ledger version (authority-ledger.md §9). */
export type LedgerVersion = Tagged<bigint, 'LedgerVersion'>;
export type PolicySequence = Tagged<bigint, 'PolicySequence'>;

// --- Parties -------------------------------------------------------------------

export interface PartyIdInput {
  readonly kind: string;
  readonly value: string;
}

/** The kernel's `PartyId` (scheme + key), reused unchanged in shape and validation. */
export type PartyId = Tagged<{ readonly kind: Identifier; readonly value: Identifier }, 'PartyId'>;
/** A party in the principal role: whose resources are at stake. */
export type PrincipalId = Tagged<PartyId, 'PrincipalId'>;
/** A party in the holder, actor or delegating-issuer role. */
export type AgentId = Tagged<PartyId, 'AgentId'>;

export function validatePartyId(input: PartyIdInput, path: string): CoreResult<PartyId> {
  const shape = checkFields(input, ['kind', 'value'], path);
  if (!shape.ok) return shape;
  const parsed = parsePartyId(input, 'MALFORMED_IDENTIFIER');
  if (!parsed.ok) return fail('MALFORMED_PARTY', path);
  return ok({ kind: parsed.value.kind, value: parsed.value.value } as PartyId);
}

export function validatePrincipalId(input: PartyIdInput, path: string): CoreResult<PrincipalId> {
  const p = validatePartyId(input, path);
  return p.ok ? ok(p.value as PrincipalId) : p;
}

export function validateAgentId(input: PartyIdInput, path: string): CoreResult<AgentId> {
  const p = validatePartyId(input, path);
  return p.ok ? ok(p.value as AgentId) : p;
}

/**
 * The one sanctioned role conversion. A principal may hold its own root node
 * and act under it (examples.md §D: "the institution acts under R0"); it then
 * appears as a holder and actor, and this call is where the role change is
 * made visible.
 */
export function principalAsAgent(principal: PrincipalId): AgentId {
  const party: PartyId = principal;
  return party as AgentId;
}

export function partyIdsEqual(a: PartyId, b: PartyId): boolean {
  return a.kind === b.kind && a.value === b.value;
}

export function writeParty(w: ByteWriter, p: PartyId): void {
  w.str(p.kind).str(p.value);
}

export function readPartyInput(r: CoreReader): PartyIdInput {
  const kind = r.str();
  const value = r.str();
  return { kind, value };
}

// --- Resources -----------------------------------------------------------------

/**
 * Resource kinds (action-state-model.md §2). The specification's single
 * `asset` kind is split into `CANONICAL_ASSET` and `REPRESENTATION_ASSET`
 * because it also requires the two to be distinct types (INV-6): a canonical
 * asset and a token representing it are never the same identifier.
 */
export const ResourceKind = {
  MARKET: 'MARKET',
  CANONICAL_ASSET: 'CANONICAL_ASSET',
  REPRESENTATION_ASSET: 'REPRESENTATION_ASSET',
  ACCOUNT: 'ACCOUNT',
  VENUE: 'VENUE',
  RECIPIENT: 'RECIPIENT',
  PROPOSAL: 'PROPOSAL',
} as const;
export type ResourceKind = (typeof ResourceKind)[keyof typeof ResourceKind];
export const RESOURCE_KINDS: readonly ResourceKind[] = Object.values(ResourceKind);

const RESOURCE_KIND_CODE: WireCodes<ResourceKind> = {
  MARKET: 1,
  CANONICAL_ASSET: 2,
  REPRESENTATION_ASSET: 3,
  ACCOUNT: 4,
  VENUE: 5,
  RECIPIENT: 6,
  PROPOSAL: 7,
};

export interface ResourceIdInput {
  readonly domain: string;
  readonly kind: ResourceKind;
  readonly localId: string;
}

/**
 * `(domain, kind, localId)`. For a market, the registry assigns a `localId`
 * per `(venue, instrument)`, so `BTC-PERP` on two venues is two markets; the
 * `localId` is opaque and nothing parses it.
 */
export type ResourceId<K extends ResourceKind = ResourceKind> = Tagged<
  { readonly domain: DomainId; readonly kind: K; readonly localId: ResourceLocalId },
  'ResourceId'
>;
export type MarketId = ResourceId<'MARKET'>;
export type CanonicalAssetRef = ResourceId<'CANONICAL_ASSET'>;
export type RepresentationAssetRef = ResourceId<'REPRESENTATION_ASSET'>;
/** Either form of asset; which one is part of its identity. */
export type AssetId = CanonicalAssetRef | RepresentationAssetRef;
export type AccountId = ResourceId<'ACCOUNT'>;
export type VenueId = ResourceId<'VENUE'>;
export type RecipientId = ResourceId<'RECIPIENT' | 'ACCOUNT'>;
export type ProposalId = ResourceId<'PROPOSAL'>;

export const ASSET_KINDS = ['CANONICAL_ASSET', 'REPRESENTATION_ASSET'] as const;

export function validateResourceId<K extends ResourceKind>(
  input: ResourceIdInput,
  allowed: readonly K[],
  path: string,
): CoreResult<ResourceId<K>> {
  const shape = checkFields(input, ['domain', 'kind', 'localId'], path);
  if (!shape.ok) return shape;
  const domain = parseIdentifierAs<DomainId>(input.domain, at(path, 'domain'));
  if (!domain.ok) return domain;
  const kind = parseEnum(input.kind, RESOURCE_KINDS, at(path, 'kind'));
  if (!kind.ok) return kind;
  if (!(allowed as readonly ResourceKind[]).includes(kind.value)) return fail('RESOURCE_KIND_MISMATCH', at(path, 'kind'));
  const localId = parseIdentifierAs<ResourceLocalId>(input.localId, at(path, 'localId'));
  if (!localId.ok) return localId;
  return ok({ domain: domain.value, kind: kind.value as K, localId: localId.value } as ResourceId<K>);
}

export function writeResourceId(w: ByteWriter, r: ResourceId): void {
  w.str(r.domain);
  writeCode(w, RESOURCE_KIND_CODE, r.kind);
  w.str(r.localId);
}

export function readResourceIdInput(r: CoreReader): ResourceIdInput {
  const domain = r.str();
  const kind = readCode(r, RESOURCE_KIND_CODE);
  const localId = r.str();
  return { domain, kind, localId };
}

export function resourceIdsEqual(a: ResourceId, b: ResourceId): boolean {
  return a.domain === b.domain && a.kind === b.kind && a.localId === b.localId;
}

export function resourceIdInputOf(r: ResourceId): ResourceIdInput {
  return { domain: r.domain, kind: r.kind, localId: r.localId };
}

export function partyIdInputOf(p: PartyId): PartyIdInput {
  return { kind: p.kind, value: p.value };
}
