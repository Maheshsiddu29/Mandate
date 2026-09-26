/**
 * The representation record: one concrete tokenized instrument, and what sources
 * assert about it (design section 6).
 *
 * The shape carries the layer's central rule. Identity is structural —
 * `representationId` and the chain and contract inside it are what the record
 * *is*. Everything semantic is a `ClaimSet`, **including the binding to the
 * canonical underlying**, because "this token is issued against that underlying"
 * is precisely the assertion that can be wrong or forged, and treating it as a
 * plain field would make it indistinguishable from a fact.
 *
 * There is deliberately no field asserting equivalence, substitutability or
 * admissibility. Those depend on a mandate the registry does not have, so storing
 * one would be storing a conclusion drawn from an input that was never supplied
 * (design section 5.4). A structural test enforces the absence.
 */

import {
  err,
  ok,
  parseIdentifier,
  type CanonicalAssetId,
  type IssuerId,
  type Result,
} from '@mandate/kernel';
import type { RegistryReasonCodeName } from './reason-codes.ts';
import { MAX_SNAPSHOT_ENTRIES } from './limits.ts';
import { canonicalAssetKey, validateCanonicalAssetId, type ValidatedCanonicalAssetId } from './asset-id.ts';
import { parseClaimSet, type ClaimSet } from './claims.ts';
import { parseDisplayText, parseTicker, type DisplayText, type Ticker } from './asset.ts';
import {
  BackingModel,
  CorporateActionModel,
  InstrumentType,
  parseEnumFromVocabulary,
  parseJurisdiction,
  RedemptionModel,
  RepresentationOperationalStatus,
  RightKind,
  RightState,
  SettlementModel,
  identityKey,
  type EligibilityProfile,
  type Jurisdiction,
} from './semantics.ts';
import { parseRepresentationId, type RepresentationId } from './representation-id.ts';

/**
 * Display metadata for a representation.
 *
 * The token's own symbol lives here, and it is display only. A token whose symbol
 * is `NVDA` has asserted nothing about what it represents — that is what the
 * `underlying` claim set is for, and the separation is what makes "symbol equality
 * cannot satisfy canonical asset equality" a property of the type rather than a
 * rule someone has to remember.
 */
export interface RepresentationDisplay {
  readonly tokenSymbol: Ticker | null;
  readonly tokenName: DisplayText | null;
}

/** Per-right claims. A right absent from the map has no claims, so it is UNKNOWN. */
export type RightsClaims = Readonly<Partial<Record<RightKind, ClaimSet<RightState>>>>;

export interface RepresentationRecord {
  // --- identity: what this record is -------------------------------------
  readonly representationId: RepresentationId;

  // --- display: never identity, never read by a decision ------------------
  readonly display: RepresentationDisplay;

  // --- claims: what sources assert, each with provenance -------------------
  /** The canonical underlying. A claim, because this edge is what can be forged. */
  readonly underlying: ClaimSet<ValidatedCanonicalAssetId>;
  readonly issuer: ClaimSet<IssuerId>;
  readonly instrumentType: ClaimSet<InstrumentType>;
  readonly backing: ClaimSet<BackingModel>;
  readonly redemption: ClaimSet<RedemptionModel>;
  readonly rights: RightsClaims;
  readonly corporateActionHandling: ClaimSet<CorporateActionModel>;
  readonly settlement: ClaimSet<SettlementModel>;
  readonly operationalStatus: ClaimSet<RepresentationOperationalStatus>;
  readonly eligibility: ClaimSet<EligibilityProfile>;
}

const RECORD_FIELDS = [
  'representationId',
  'display',
  'underlying',
  'issuer',
  'instrumentType',
  'backing',
  'redemption',
  'rights',
  'corporateActionHandling',
  'settlement',
  'operationalStatus',
  'eligibility',
] as const;

function rejectUnknownKeys(r: Record<string, unknown>, known: readonly string[]): boolean {
  const set = new Set<string>(known);
  for (const k of Object.keys(r)) if (!set.has(k)) return false;
  return true;
}

function parseIssuerId(raw: unknown): Result<IssuerId, RegistryReasonCodeName> {
  const id = parseIdentifier(raw);
  if (!id.ok) return err('SNAPSHOT_MALFORMED');
  return ok(id.value);
}

function parseUnderlying(raw: unknown): Result<ValidatedCanonicalAssetId, RegistryReasonCodeName> {
  return validateCanonicalAssetId(raw);
}

/**
 * Eligibility comparison key.
 *
 * Sorted before joining so two sources that listed the same jurisdictions in a
 * different order agree rather than registering as a conflict.
 */
export function eligibilityKey(profile: EligibilityProfile): string {
  const permitted = [...profile.permitted].sort().join(',');
  const prohibited = [...profile.prohibited].sort().join(',');
  return `P:${permitted}|X:${prohibited}`;
}

function parseEligibilityProfile(raw: unknown): Result<EligibilityProfile, RegistryReasonCodeName> {
  if (typeof raw !== 'object' || raw === null) return err('SNAPSHOT_MALFORMED');
  const r = raw as Record<string, unknown>;
  if (!rejectUnknownKeys(r, ['permitted', 'prohibited'])) return err('SNAPSHOT_MALFORMED');
  const lists: Jurisdiction[][] = [];
  for (const field of ['permitted', 'prohibited'] as const) {
    const value = r[field];
    if (!Array.isArray(value)) return err('SNAPSHOT_MALFORMED');
    // Each list is encoded with a u16 count. Refuse an unencodable collection
    // before iterating it, even though the two-letter jurisdiction vocabulary
    // makes a unique list this large impossible in ordinary valid data.
    if (value.length > MAX_SNAPSHOT_ENTRIES) return err('SNAPSHOT_RESOURCE_LIMIT_EXCEEDED');
    const out: Jurisdiction[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
      const j = parseJurisdiction(entry);
      if (!j.ok) return j;
      if (seen.has(j.value)) return err('SNAPSHOT_MALFORMED');
      seen.add(j.value);
      out.push(j.value);
    }
    lists.push(out);
  }
  const permitted = lists[0] as Jurisdiction[];
  const prohibited = lists[1] as Jurisdiction[];
  // A jurisdiction both permitted and prohibited is a contradiction inside one
  // claim, not a conflict between sources. The source has to fix it.
  for (const j of permitted) if (prohibited.includes(j)) return err('SNAPSHOT_MALFORMED');
  return ok({ permitted, prohibited });
}

function parseRights(raw: unknown): Result<RightsClaims, RegistryReasonCodeName> {
  if (raw === undefined || raw === null) return ok({});
  if (typeof raw !== 'object' || Array.isArray(raw)) return err('SNAPSHOT_MALFORMED');
  const r = raw as Record<string, unknown>;
  const out: Partial<Record<RightKind, ClaimSet<RightState>>> = {};
  for (const [key, value] of Object.entries(r)) {
    if (!Object.prototype.hasOwnProperty.call(RightKind, key)) return err('SNAPSHOT_MALFORMED');
    const claims = parseClaimSet(value, (v) => parseEnumFromVocabulary(v, RightState), identityKey);
    if (!claims.ok) return claims;
    out[key as RightKind] = claims.value;
  }
  return ok(out);
}

export function parseRepresentationRecord(
  raw: unknown,
): Result<RepresentationRecord, RegistryReasonCodeName> {
  if (typeof raw !== 'object' || raw === null) return err('SNAPSHOT_MALFORMED');
  const r = raw as Record<string, unknown>;
  if (!rejectUnknownKeys(r, RECORD_FIELDS)) return err('SNAPSHOT_MALFORMED');

  const representationId = parseRepresentationId(r['representationId']);
  if (!representationId.ok) return representationId;

  const rawDisplay = r['display'];
  if (typeof rawDisplay !== 'object' || rawDisplay === null) return err('SNAPSHOT_MALFORMED');
  const d = rawDisplay as Record<string, unknown>;
  if (!rejectUnknownKeys(d, ['tokenSymbol', 'tokenName'])) return err('SNAPSHOT_MALFORMED');

  let tokenSymbol: Ticker | null = null;
  if (d['tokenSymbol'] !== null && d['tokenSymbol'] !== undefined) {
    const t = parseTicker(d['tokenSymbol']);
    if (!t.ok) return t;
    tokenSymbol = t.value;
  }
  let tokenName: DisplayText | null = null;
  if (d['tokenName'] !== null && d['tokenName'] !== undefined) {
    const t = parseDisplayText(d['tokenName']);
    if (!t.ok) return t;
    tokenName = t.value;
  }

  const underlying = parseClaimSet(r['underlying'], parseUnderlying, canonicalAssetKey);
  if (!underlying.ok) return underlying;
  const issuer = parseClaimSet(r['issuer'], parseIssuerId, identityKey);
  if (!issuer.ok) return issuer;
  const instrumentType = parseClaimSet(r['instrumentType'], (v) => parseEnumFromVocabulary(v, InstrumentType), identityKey);
  if (!instrumentType.ok) return instrumentType;
  const backing = parseClaimSet(r['backing'], (v) => parseEnumFromVocabulary(v, BackingModel), identityKey);
  if (!backing.ok) return backing;
  const redemption = parseClaimSet(r['redemption'], (v) => parseEnumFromVocabulary(v, RedemptionModel), identityKey);
  if (!redemption.ok) return redemption;
  const rights = parseRights(r['rights']);
  if (!rights.ok) return rights;
  const corporateActionHandling = parseClaimSet(
    r['corporateActionHandling'],
    (v) => parseEnumFromVocabulary(v, CorporateActionModel),
    identityKey,
  );
  if (!corporateActionHandling.ok) return corporateActionHandling;
  const settlement = parseClaimSet(r['settlement'], (v) => parseEnumFromVocabulary(v, SettlementModel), identityKey);
  if (!settlement.ok) return settlement;
  const operationalStatus = parseClaimSet(
    r['operationalStatus'],
    (v) => parseEnumFromVocabulary(v, RepresentationOperationalStatus),
    identityKey,
  );
  if (!operationalStatus.ok) return operationalStatus;
  const eligibility = parseClaimSet(r['eligibility'], parseEligibilityProfile, eligibilityKey);
  if (!eligibility.ok) return eligibility;

  return ok({
    representationId: representationId.value,
    display: { tokenSymbol, tokenName },
    underlying: underlying.value,
    issuer: issuer.value,
    instrumentType: instrumentType.value,
    backing: backing.value,
    redemption: redemption.value,
    rights: rights.value,
    corporateActionHandling: corporateActionHandling.value,
    settlement: settlement.value,
    operationalStatus: operationalStatus.value,
    eligibility: eligibility.value,
  });
}

export { canonicalAssetKey };
export type { CanonicalAssetId };
