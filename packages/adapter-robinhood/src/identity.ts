import { TrustClass, parseIdentifier, type UnixSeconds } from '@mandate/kernel';
import {
  parseCanonicalAssetRecord,
  isAssetClass,
  validateCanonicalAssetId,
  type AssetClass,
  type CanonicalAssetRecord,
  type ValidatedCanonicalAssetId,
} from '@mandate/registry';
import { EvidenceClass, ObservationClock, type Evidence } from './evidence.ts';
import type { NormalizedRobinhoodAsset } from './asset.ts';
import { AdapterErrorCode, adapterErr, adapterOk, type AdapterResult } from './result.ts';

export interface CanonicalIdentityMapping {
  readonly robinhoodUid: string;
  readonly isin: string;
  readonly assetClass: AssetClass;
  readonly primaryName: string;
  readonly displayTicker: string;
  readonly primaryMarketIdentifier: string | null;
  readonly sourceId: string;
  readonly curatedAtUnixSeconds: UnixSeconds;
}

export interface MappedCanonicalAsset {
  readonly identity: Evidence<ValidatedCanonicalAssetId>;
  readonly record: CanonicalAssetRecord;
}

export interface CanonicalIdentityMappingFile {
  readonly version: 1;
  readonly sourceId: string;
  readonly curatedAtUnixSeconds: UnixSeconds;
  readonly policy: string;
  readonly mappings: readonly CanonicalIdentityMapping[];
}

function mappingObject(raw: unknown, path: string): AdapterResult<Record<string, unknown>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return adapterErr(AdapterErrorCode.MALFORMED_RESPONSE, path, 'expected an object');
  }
  return adapterOk(raw as Record<string, unknown>);
}

/** Parse the checked-in curation boundary. Extra or missing mapping fields are
 * rejected so a hand-edited file cannot silently weaken identity policy. */
export function parseCanonicalIdentityMappingFile(raw: unknown): AdapterResult<CanonicalIdentityMappingFile> {
  const file = mappingObject(raw, 'mapping');
  if (!file.ok) return file;
  if (file.value['version'] !== 1) return adapterErr(AdapterErrorCode.UNKNOWN_ENUM, 'mapping.version', 'unsupported mapping version');
  const sourceId = file.value['sourceId'];
  if (typeof sourceId !== 'string' || !parseIdentifier(sourceId).ok) {
    return adapterErr(AdapterErrorCode.INVALID_IDENTITY, 'mapping.sourceId', 'invalid curation source identifier');
  }
  const curatedRaw = file.value['curatedAtUnixSeconds'];
  if (typeof curatedRaw !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(curatedRaw)) {
    return adapterErr(AdapterErrorCode.INVALID_TIMESTAMP, 'mapping.curatedAtUnixSeconds', 'expected unsigned decimal seconds');
  }
  const curatedAtUnixSeconds = BigInt(curatedRaw) as UnixSeconds;
  const policy = file.value['policy'];
  if (typeof policy !== 'string' || policy.length === 0) {
    return adapterErr(AdapterErrorCode.MISSING_REQUIRED_FIELD, 'mapping.policy', 'identity policy is required');
  }
  const rows = file.value['mappings'];
  if (!Array.isArray(rows) || rows.length === 0) {
    return adapterErr(AdapterErrorCode.MISSING_REQUIRED_FIELD, 'mapping.mappings', 'at least one mapping is required');
  }
  const mappings: CanonicalIdentityMapping[] = [];
  const uids = new Set<string>();
  const identities = new Set<string>();
  for (let index = 0; index < rows.length; index += 1) {
    const path = `mapping.mappings[${index}]`;
    const row = mappingObject(rows[index], path);
    if (!row.ok) return row;
    const allowed = new Set([
      'robinhoodUid', 'isin', 'assetClass', 'primaryName', 'displayTicker',
      'primaryMarketIdentifier', 'rationale',
    ]);
    if (Object.keys(row.value).some((key) => !allowed.has(key))) {
      return adapterErr(AdapterErrorCode.MALFORMED_RESPONSE, path, 'unknown mapping field');
    }
    const robinhoodUid = row.value['robinhoodUid'];
    const isin = row.value['isin'];
    const assetClass = row.value['assetClass'];
    const primaryName = row.value['primaryName'];
    const displayTicker = row.value['displayTicker'];
    const primaryMarketIdentifier = row.value['primaryMarketIdentifier'];
    const rationale = row.value['rationale'];
    if (typeof robinhoodUid !== 'string' || !/^0x[0-9a-f]{64}$/.test(robinhoodUid)) {
      return adapterErr(AdapterErrorCode.INVALID_IDENTITY, `${path}.robinhoodUid`, 'invalid Stock Token UID');
    }
    if (typeof assetClass !== 'string' || !isAssetClass(assetClass)) {
      return adapterErr(AdapterErrorCode.UNKNOWN_ENUM, `${path}.assetClass`, 'unknown canonical asset class');
    }
    if (typeof isin !== 'string' || !validateCanonicalAssetId({ assetClass, idScheme: 'isin', value: isin }).ok) {
      return adapterErr(AdapterErrorCode.INVALID_IDENTITY, `${path}.isin`, 'invalid ISIN');
    }
    if (typeof primaryName !== 'string' || primaryName.length === 0 || typeof displayTicker !== 'string' || !/^[A-Z0-9.\-]{1,16}$/.test(displayTicker)) {
      return adapterErr(AdapterErrorCode.INVALID_IDENTITY, path, 'invalid curated display identity');
    }
    if (primaryMarketIdentifier !== null && (typeof primaryMarketIdentifier !== 'string' || !/^[A-Z0-9]{4}$/.test(primaryMarketIdentifier))) {
      return adapterErr(AdapterErrorCode.INVALID_IDENTITY, `${path}.primaryMarketIdentifier`, 'invalid MIC');
    }
    if (typeof rationale !== 'string' || rationale.length === 0) {
      return adapterErr(AdapterErrorCode.MISSING_REQUIRED_FIELD, `${path}.rationale`, 'mapping rationale is required');
    }
    const identityKey = `${assetClass}:isin:${isin}`;
    if (uids.has(robinhoodUid) || identities.has(identityKey)) {
      return adapterErr(AdapterErrorCode.INVALID_IDENTITY, path, 'duplicate mapping identity');
    }
    uids.add(robinhoodUid);
    identities.add(identityKey);
    mappings.push({
      robinhoodUid, isin, assetClass, primaryName, displayTicker,
      primaryMarketIdentifier, sourceId, curatedAtUnixSeconds,
    });
  }
  return adapterOk({ version: 1, sourceId, curatedAtUnixSeconds, policy, mappings });
}

export function mapCanonicalAsset(
  asset: NormalizedRobinhoodAsset,
  mapping: CanonicalIdentityMapping,
): AdapterResult<MappedCanonicalAsset> {
  if (mapping.robinhoodUid !== asset.uid.value || mapping.isin !== asset.isin.value) {
    return adapterErr(AdapterErrorCode.INVALID_IDENTITY, 'canonicalMapping', 'mapping UID and ISIN must both match authoritative asset state');
  }
  const sourceId = parseIdentifier(mapping.sourceId);
  if (!sourceId.ok) return adapterErr(AdapterErrorCode.INVALID_IDENTITY, 'canonicalMapping.sourceId', 'invalid mapping source identifier');
  const identity = validateCanonicalAssetId({
    assetClass: mapping.assetClass,
    idScheme: 'isin',
    value: mapping.isin,
  });
  if (!identity.ok) return adapterErr(AdapterErrorCode.INVALID_IDENTITY, 'canonicalMapping.isin', 'mapping contains an invalid canonical identity');

  const rawRecord = {
    identity: identity.value,
    status: asset.status.value === 'ACTIVE' ? 'ACTIVE' : 'UNKNOWN',
    display: {
      primaryName: mapping.primaryName,
      displayTicker: mapping.displayTicker,
      primaryMarketIdentifier: mapping.primaryMarketIdentifier,
      listings: mapping.primaryMarketIdentifier === null
        ? []
        : [{ mic: mapping.primaryMarketIdentifier, ticker: mapping.displayTicker }],
      aliases: [{ kind: 'SYMBOL', value: mapping.displayTicker }],
    },
  };
  const record = parseCanonicalAssetRecord(rawRecord);
  if (!record.ok) return adapterErr(AdapterErrorCode.INVALID_IDENTITY, 'canonicalMapping', 'mapping cannot produce a registry asset record');
  return adapterOk({
    identity: {
      value: identity.value,
      evidenceClass: EvidenceClass.CURATED_MAPPING,
      observationClock: ObservationClock.CURATION_TIME,
      provenance: {
        trustClass: TrustClass.VERIFIED,
        sourceId: sourceId.value,
        observedAtUnixSeconds: mapping.curatedAtUnixSeconds,
      },
    },
    record: record.value,
  });
}
