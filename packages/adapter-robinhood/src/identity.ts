import { TrustClass, parseIdentifier, type UnixSeconds } from '@mandate/kernel';
import {
  parseCanonicalAssetRecord,
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
