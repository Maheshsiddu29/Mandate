import { TrustClass, type Identifier, type Provenance, type UnixSeconds } from '@mandate/kernel';
import {
  BackingModel,
  CorporateActionModel,
  InstrumentType,
  RedemptionModel,
  RepresentationOperationalStatus,
  RightKind,
  RightState,
  SettlementModel,
  parseRepresentationId,
  parseRepresentationRecord,
  type Claim,
  type RepresentationRecord,
  type ValidatedCanonicalAssetId,
} from '@mandate/registry';
import type { NormalizedRobinhoodAsset, RobinhoodDeployment } from './asset.ts';
import type { Evidence } from './evidence.ts';
import { AdapterErrorCode, adapterErr, adapterOk, type AdapterResult } from './result.ts';

export const ROBINHOOD_ISSUER_ID = 'robinhood-assets-jersey-limited' as Identifier;
export const ROBINHOOD_DISCLOSURES_SOURCE = 'robinhood-rhj-disclosures' as Identifier;

export interface RepresentationSemanticsContext {
  readonly disclosureObservedAtUnixSeconds: UnixSeconds;
}

function claim<T>(value: T, provenance: Provenance): readonly Claim<T>[] {
  return [{ value, provenance }];
}

function disclosureProvenance(context: RepresentationSemanticsContext): Provenance {
  return {
    trustClass: TrustClass.AUTHORITATIVE,
    sourceId: ROBINHOOD_DISCLOSURES_SOURCE,
    observedAtUnixSeconds: context.disclosureObservedAtUnixSeconds,
  };
}

/** Produce explicit registry claims from issuer disclosures. This function does
 * not infer any right from symbol, name, or ERC-20 behavior. */
export function buildRepresentationRecord(
  asset: NormalizedRobinhoodAsset,
  canonicalAsset: Evidence<ValidatedCanonicalAssetId>,
  deployment: RobinhoodDeployment,
  context: RepresentationSemanticsContext,
): AdapterResult<RepresentationRecord> {
  if (!asset.deployments.value.some((candidate) =>
    candidate.chainId === deployment.chainId && candidate.contractAddress === deployment.contractAddress)) {
    return adapterErr(AdapterErrorCode.DEPLOYMENT_MISMATCH, 'deployment', 'deployment is not present in authoritative asset state');
  }
  const representationId = parseRepresentationId({
    chainNamespace: 'eip155',
    chainReference: String(deployment.chainId),
    assetNamespace: 'erc20',
    contractAddress: deployment.contractAddress,
  });
  if (!representationId.ok) return adapterErr(AdapterErrorCode.INVALID_ADDRESS, 'deployment.contractAddress', 'invalid representation identity');

  const disclosure = disclosureProvenance(context);
  const operational = asset.status.value === 'ACTIVE'
    ? RepresentationOperationalStatus.ACTIVE
    : asset.status.value === 'INACTIVE'
      ? RepresentationOperationalStatus.DEPRECATED
      : RepresentationOperationalStatus.TRANSITION;

  const raw = {
    representationId: representationId.value.value,
    // Robinhood's exact onchain name contains a non-ASCII bullet and the Phase 2
    // registry deliberately accepts printable ASCII display text only. Preserve
    // it in adapter state and omit it here; display fields never establish identity.
    display: { tokenSymbol: asset.tokenSymbol.value, tokenName: null },
    underlying: claim(canonicalAsset.value, canonicalAsset.provenance),
    issuer: claim(ROBINHOOD_ISSUER_ID, disclosure),
    instrumentType: claim(InstrumentType.DEBT_INSTRUMENT, disclosure),
    backing: claim(BackingModel.FULLY_BACKED, disclosure),
    redemption: claim(RedemptionModel.QUALIFIED_HOLDERS_ONLY, disclosure),
    rights: {
      [RightKind.ECONOMIC_EXPOSURE]: claim(RightState.PRESENT, disclosure),
      [RightKind.DIVIDEND_TREATMENT]: claim(RightState.PRICE_ADJUSTED, disclosure),
      [RightKind.VOTING_RIGHTS]: claim(RightState.ABSENT, disclosure),
      [RightKind.REDEMPTION_RIGHTS]: claim(RightState.RESTRICTED, disclosure),
      [RightKind.BENEFICIAL_OWNERSHIP]: claim(RightState.ABSENT, disclosure),
      [RightKind.TRANSFERABILITY]: claim(RightState.PRESENT, disclosure),
    },
    corporateActionHandling: claim(CorporateActionModel.ON_CHAIN_MULTIPLIER, disclosure),
    settlement: claim(SettlementModel.ATOMIC_ON_CHAIN, disclosure),
    operationalStatus: claim(operational, asset.status.provenance),
    // Public material names several prohibited jurisdictions but points to a
    // separate complete list. An incomplete allowlist cannot establish eligibility.
    eligibility: [],
  };
  const parsed = parseRepresentationRecord(raw);
  if (!parsed.ok) return adapterErr(AdapterErrorCode.MALFORMED_RESPONSE, 'representation', 'normalized claims do not form a registry record');
  return adapterOk(parsed.value);
}
