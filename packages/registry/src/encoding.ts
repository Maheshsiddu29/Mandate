/**
 * Deterministic registry encoding and digests (ADR 0007).
 *
 * Reuses the kernel's MCE primitives — big-endian fixed-width integers,
 * `u16`-length-prefixed strings, counted collections in a sorted order — so there
 * is one set of encoding principles in the project and no JSON numeric ambiguity
 * anywhere in a digest path. It does **not** join the kernel's frozen object set:
 * a snapshot is not signed, it is far larger, and it grows a field every time a
 * metadata dimension is added. Keeping the two apart is what lets the registry
 * schema evolve without touching a single mandate digest.
 *
 * Enum wire codes are written out explicitly rather than derived from declaration
 * order, following the kernel's codec: a reordered `const` object must never
 * silently change what a digest means.
 *
 * Two digests, deliberately:
 *
 * - `registrySnapshotDigest` names the state a decision was made against;
 * - `canonicalAssetIdentityDigest` covers a canonical identity *alone*, so
 *   "changing a ticker does not change financial identity" is demonstrable by
 *   comparing digests rather than by asserting it in a comment.
 */

import { ByteWriter, keccak256, type Bytes32 } from '@mandate/kernel';
import type { CanonicalAssetId } from '@mandate/kernel';
import { canonicalAssetKey } from './asset-id.ts';
import { AliasKind, AssetStatus, type CanonicalAssetRecord } from './asset.ts';
import { sortClaims, type ClaimSet } from './claims.ts';
import {
  BackingModel,
  CorporateActionModel,
  InstrumentType,
  RedemptionModel,
  RepresentationOperationalStatus,
  RightKind,
  RightState,
  SettlementModel,
  identityKey,
  type EligibilityProfile,
} from './semantics.ts';
import { eligibilityKey, type RepresentationRecord } from './representation.ts';
import { compareRepresentationIds } from './representation-id.ts';
import { DataClass, type RegistrySnapshot } from './snapshot.ts';
import { anyReasonCode } from './reason-codes.ts';
import type { RepresentationDecision } from './evaluate.ts';

/**
 * Registry domain tags.
 *
 * Unterminated, so a tag that were a prefix of another would break domain
 * separation. A test asserts no registry tag equals or prefixes any kernel tag,
 * and vice versa.
 */
export const RegistryDomainTag = {
  SNAPSHOT: 'MANDATE.REGISTRY.SNAPSHOT.V1',
  ASSET: 'MANDATE.REGISTRY.ASSET.V1',
  ASSET_IDENTITY: 'MANDATE.REGISTRY.ASSETID.V1',
  REPRESENTATION: 'MANDATE.REGISTRY.REPRESENTATION.V1',
  DECISION: 'MANDATE.REGISTRY.DECISION.V1',
} as const;

// --- Frozen wire codes ------------------------------------------------------

const ASSET_STATUS_CODE: Record<string, number> = { ACTIVE: 1, DELISTED: 2, SUPERSEDED: 3, UNKNOWN: 4 };
const ALIAS_KIND_CODE: Record<string, number> = { NAME: 1, SYMBOL: 2, LEGACY_TICKER: 3, EXCHANGE_QUALIFIED: 4 };
const DATA_CLASS_CODE: Record<string, number> = { SYNTHETIC_FIXTURE: 1, OBSERVED: 2 };
const TRUST_CLASS_CODE: Record<string, number> = { AUTHORITATIVE: 1, VERIFIED: 2, ADVISORY: 3, UNTRUSTED: 4 };
const INSTRUMENT_TYPE_CODE: Record<string, number> = {
  BACKED_NOTE: 1, DEPOSITARY_RECEIPT: 2, FUND_SHARE: 3, SYNTHETIC_EXPOSURE: 4, DEBT_INSTRUMENT: 5,
};
const BACKING_CODE: Record<string, number> = {
  FULLY_BACKED: 1, PARTIALLY_BACKED: 2, COLLATERALIZED: 3, DEBT_LINKED: 4, SYNTHETIC: 5, UNBACKED: 6,
};
const REDEMPTION_CODE: Record<string, number> = {
  NONE: 1, QUALIFIED_HOLDERS_ONLY: 2, OPEN_REDEMPTION: 3, ISSUER_DISCRETION: 4,
};
const RIGHT_KIND_CODE: Record<string, number> = {
  ECONOMIC_EXPOSURE: 1, DIVIDEND_TREATMENT: 2, VOTING_RIGHTS: 3,
  REDEMPTION_RIGHTS: 4, BENEFICIAL_OWNERSHIP: 5, TRANSFERABILITY: 6,
};
const RIGHT_STATE_CODE: Record<string, number> = { PRESENT: 1, PRICE_ADJUSTED: 2, RESTRICTED: 3, ABSENT: 4 };
const CORPORATE_ACTION_CODE: Record<string, number> = {
  SUPPLY_REBASE: 1, ON_CHAIN_MULTIPLIER: 2, ISSUER_ACCOUNTING_ADJUSTMENT: 3, CASH_DISTRIBUTION: 4, NOT_APPLIED: 5,
};
const SETTLEMENT_CODE: Record<string, number> = { ATOMIC_ON_CHAIN: 1, DEFERRED: 2, ISSUER_CONFIRMED: 3 };
const OPERATIONAL_STATUS_CODE: Record<string, number> = { ACTIVE: 1, PAUSED: 2, TRANSITION: 3, DEPRECATED: 4 };

const ABSENT = 0;
const PRESENT = 1;

function codeOf(table: Record<string, number>, value: string, label: string): number {
  const code = table[value];
  // Reaching here with an unmapped value means a vocabulary gained a member and
  // its wire code was not assigned. Throwing is correct: it is a defect in this
  // package, not a financial outcome, and the same rule the kernel's writers use.
  if (code === undefined) throw new Error(`unmapped ${label} wire code: ${value}`);
  return code;
}

// --- Ordering ---------------------------------------------------------------

/** Length first, then content — the kernel's encoded-bytes order for strings. */
function compareEncoded(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareAssets(a: CanonicalAssetRecord, b: CanonicalAssetRecord): number {
  return compareEncoded(canonicalAssetKey(a.identity), canonicalAssetKey(b.identity));
}

// --- Component writers ------------------------------------------------------

function writeAssetIdentity(w: ByteWriter, id: CanonicalAssetId): void {
  w.str(id.assetClass).str(id.idScheme).str(id.value);
}

function writeClaims<T>(
  w: ByteWriter,
  claims: ClaimSet<T>,
  keyOf: (v: T) => string,
  writeValue: (w: ByteWriter, value: T) => void,
): void {
  // Sorted by the same total order `resolveClaimSet` reports in, so adapter
  // emission order cannot reach the digest.
  const sorted = sortClaims(claims, keyOf);
  w.u16(sorted.length);
  for (const claim of sorted) {
    w.u8(codeOf(TRUST_CLASS_CODE, claim.provenance.trustClass, 'trust class'));
    w.str(claim.provenance.sourceId);
    w.i64(claim.provenance.observedAtUnixSeconds);
    writeValue(w, claim.value);
  }
}

function enumWriter(table: Record<string, number>, label: string) {
  return (w: ByteWriter, value: string): void => {
    w.u8(codeOf(table, value, label));
  };
}

function writeEligibility(w: ByteWriter, profile: EligibilityProfile): void {
  // Jurisdiction lists are sorted, matching `eligibilityKey`, so two sources that
  // listed the same jurisdictions in a different order encode identically — and
  // therefore are not a conflict and do not change the digest.
  const permitted = [...profile.permitted].sort();
  const prohibited = [...profile.prohibited].sort();
  w.u16(permitted.length);
  for (const j of permitted) w.str(j);
  w.u16(prohibited.length);
  for (const j of prohibited) w.str(j);
}

// --- Canonical asset --------------------------------------------------------

/**
 * Canonical identity alone, with its own domain tag.
 *
 * Deliberately excludes status and every display field, which is what makes the
 * identity digest useful: it changes if and only if the asset is a different asset.
 */
export function encodeCanonicalAssetIdentity(id: CanonicalAssetId): Uint8Array {
  const w = new ByteWriter();
  w.tag(RegistryDomainTag.ASSET_IDENTITY).u16(1);
  writeAssetIdentity(w, id);
  return w.finish();
}

export function canonicalAssetIdentityDigest(id: CanonicalAssetId): Bytes32 {
  return keccak256(encodeCanonicalAssetIdentity(id));
}

export function encodeCanonicalAssetRecord(record: CanonicalAssetRecord): Uint8Array {
  const w = new ByteWriter();
  w.tag(RegistryDomainTag.ASSET).u16(1);
  writeAssetIdentity(w, record.identity);
  w.u8(codeOf(ASSET_STATUS_CODE, record.status, 'asset status'));
  w.str(record.display.primaryName);
  if (record.display.displayTicker === null) w.u8(ABSENT);
  else w.u8(PRESENT).str(record.display.displayTicker);
  if (record.display.primaryMarketIdentifier === null) w.u8(ABSENT);
  else w.u8(PRESENT).str(record.display.primaryMarketIdentifier);

  const listings = [...record.display.listings].sort(
    (a, b) => compareEncoded(a.mic, b.mic) || compareEncoded(a.ticker, b.ticker),
  );
  w.u16(listings.length);
  for (const listing of listings) w.str(listing.mic).str(listing.ticker);

  const aliases = [...record.display.aliases].sort(
    (a, b) =>
      codeOf(ALIAS_KIND_CODE, a.kind, 'alias kind') - codeOf(ALIAS_KIND_CODE, b.kind, 'alias kind') ||
      compareEncoded(a.value, b.value),
  );
  w.u16(aliases.length);
  for (const alias of aliases) {
    w.u8(codeOf(ALIAS_KIND_CODE, alias.kind, 'alias kind')).str(alias.value);
  }
  return w.finish();
}

export function canonicalAssetRecordDigest(record: CanonicalAssetRecord): Bytes32 {
  return keccak256(encodeCanonicalAssetRecord(record));
}

// --- Representation ---------------------------------------------------------

export function encodeRepresentationRecord(record: RepresentationRecord): Uint8Array {
  const w = new ByteWriter();
  w.tag(RegistryDomainTag.REPRESENTATION).u16(1);
  w.str(record.representationId.value);

  if (record.display.tokenSymbol === null) w.u8(ABSENT);
  else w.u8(PRESENT).str(record.display.tokenSymbol);
  if (record.display.tokenName === null) w.u8(ABSENT);
  else w.u8(PRESENT).str(record.display.tokenName);

  writeClaims(w, record.underlying, canonicalAssetKey, (writer, id) => writeAssetIdentity(writer, id));
  writeClaims(w, record.issuer, identityKey, (writer, issuer) => {
    writer.str(issuer);
  });
  writeClaims(w, record.instrumentType, identityKey, enumWriter(INSTRUMENT_TYPE_CODE, 'instrument type'));
  writeClaims(w, record.backing, identityKey, enumWriter(BACKING_CODE, 'backing model'));
  writeClaims(w, record.redemption, identityKey, enumWriter(REDEMPTION_CODE, 'redemption model'));

  // Rights are encoded in wire-code order rather than object-key order, so the
  // order a curator happened to author them in cannot reach the digest.
  const rightKinds = (Object.keys(RightKind) as RightKind[])
    .filter((kind) => record.rights[kind] !== undefined)
    .sort((a, b) => codeOf(RIGHT_KIND_CODE, a, 'right kind') - codeOf(RIGHT_KIND_CODE, b, 'right kind'));
  w.u16(rightKinds.length);
  for (const kind of rightKinds) {
    w.u8(codeOf(RIGHT_KIND_CODE, kind, 'right kind'));
    writeClaims(w, record.rights[kind] ?? [], identityKey, enumWriter(RIGHT_STATE_CODE, 'right state'));
  }

  writeClaims(w, record.corporateActionHandling, identityKey, enumWriter(CORPORATE_ACTION_CODE, 'corporate action model'));
  writeClaims(w, record.settlement, identityKey, enumWriter(SETTLEMENT_CODE, 'settlement model'));
  writeClaims(w, record.operationalStatus, identityKey, enumWriter(OPERATIONAL_STATUS_CODE, 'operational status'));
  writeClaims(w, record.eligibility, eligibilityKey, writeEligibility);

  return w.finish();
}

export function representationRecordDigest(record: RepresentationRecord): Bytes32 {
  return keccak256(encodeRepresentationRecord(record));
}

// --- Snapshot ---------------------------------------------------------------

export function encodeRegistrySnapshot(snapshot: RegistrySnapshot): Uint8Array {
  const w = new ByteWriter();
  w.tag(RegistryDomainTag.SNAPSHOT).u16(snapshot.registrySchemaVersion);
  w.str(snapshot.snapshotId);
  w.i64(snapshot.createdAtUnixSeconds);
  w.u8(codeOf(DATA_CLASS_CODE, snapshot.dataClass, 'data class'));

  const sources = [...snapshot.sourceVersions].sort((a, b) => compareEncoded(a.sourceId, b.sourceId));
  w.u16(sources.length);
  for (const source of sources) w.str(source.sourceId).str(source.version);

  // Records are digested through their own tagged encodings, so a record digest is
  // meaningful on its own and a snapshot is a commitment over those digests.
  const assets = [...snapshot.assets].sort(compareAssets);
  w.u16(assets.length);
  for (const asset of assets) w.raw(keccakBytes(encodeCanonicalAssetRecord(asset)));

  const representations = [...snapshot.representations].sort((a, b) =>
    compareRepresentationIds(a.representationId, b.representationId),
  );
  w.u16(representations.length);
  for (const record of representations) w.raw(keccakBytes(encodeRepresentationRecord(record)));

  return w.finish();
}

/** `keccak256` as raw bytes, for embedding one digest inside another encoding. */
function keccakBytes(bytes: Uint8Array): Uint8Array {
  const hex = keccak256(bytes);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

export function registrySnapshotDigest(snapshot: RegistrySnapshot): Bytes32 {
  return keccak256(encodeRegistrySnapshot(snapshot));
}

// --- Decision ---------------------------------------------------------------

/**
 * Encode an admissibility decision.
 *
 * Exists so a decision vector can pin a decision as a digest rather than as a
 * structure a reimplementation might serialize differently. Exclusion detail keys
 * are sorted, because an object's own key order is an accident of construction and
 * must not reach a digest.
 */
export function encodeRepresentationDecision(decision: RepresentationDecision): Uint8Array {
  const w = new ByteWriter();
  w.tag(RegistryDomainTag.DECISION).u16(1);
  w.str(decision.status);
  if (decision.representationId === null) w.u8(ABSENT);
  else w.u8(PRESENT).str(decision.representationId.value);

  const exclusions = decision.status === 'EXCLUDED' ? decision.exclusions : [];
  w.u16(exclusions.length);
  for (const e of exclusions) {
    w.str(anyReasonCode(e.code).id);
    w.str(e.code);
    const keys = Object.keys(e.detail).sort();
    w.u16(keys.length);
    for (const k of keys) w.str(k).str(e.detail[k] as string);
  }
  return w.finish();
}

export function representationDecisionDigest(decision: RepresentationDecision): Bytes32 {
  return keccak256(encodeRepresentationDecision(decision));
}
