import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobinhoodAsset } from '../src/asset.ts';
import { mapCanonicalAsset } from '../src/identity.ts';
import { buildRepresentationRecord } from '../src/representation.ts';

const observedAt = 1_790_289_408n;

function normalizedAsset() {
  const parsed = parseRobinhoodAsset({
    id: '0x000000000000000000000000000000002470b933c52d47ccad017ed9ee80c9ed',
    tokenSymbol: 'QQQ', tokenName: 'Invesco QQQ • Robinhood Token',
    deployments: [{ contractAddress: '0xD5f3879160bc7c32ebb4dC785F8a4F505888de68', chainId: 4663 }],
    currentMultiplier: '1.000700791241405425', pendingMultiplier: '', status: 'ASSET_STATUS_ACTIVE',
    tradingCapabilities: {
      market: { whole: 'TRADING_STATUS_TRADABLE', fractional: 'TRADING_STATUS_TRADABLE' },
      extended: { whole: 'TRADING_STATUS_TRADABLE', fractional: 'TRADING_STATUS_TRADABLE' },
      overnight: { whole: 'TRADING_STATUS_TRADABLE', fractional: 'TRADING_STATUS_TRADABLE' },
    },
    tokenDecimals: 18, isin: 'US46090E1038',
  }, { fetchedAtUnixSeconds: observedAt });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('fixture must parse');
  return parsed.value;
}

describe('canonical mapping and representation semantics', () => {
  test('keeps authoritative ISIN separate from curated asset class', () => {
    const asset = normalizedAsset();
    const mapped = mapCanonicalAsset(asset, {
      robinhoodUid: asset.uid.value,
      isin: asset.isin.value,
      assetClass: 'fund',
      primaryName: 'Invesco QQQ Trust',
      displayTicker: 'QQQ',
      primaryMarketIdentifier: 'XNAS',
      sourceId: 'mandate-curation-2026-09-24',
      curatedAtUnixSeconds: observedAt,
    });
    assert.equal(mapped.ok, true);
    if (!mapped.ok) return;
    assert.equal(mapped.value.identity.value.assetClass, 'fund');
    assert.equal(mapped.value.identity.evidenceClass, 'CURATED_MAPPING');
  });

  test('emits explicit debt, backing, rights and multiplier claims', () => {
    const asset = normalizedAsset();
    const mapped = mapCanonicalAsset(asset, {
      robinhoodUid: asset.uid.value, isin: asset.isin.value, assetClass: 'fund',
      primaryName: 'Invesco QQQ Trust', displayTicker: 'QQQ', primaryMarketIdentifier: 'XNAS',
      sourceId: 'mandate-curation-2026-09-24', curatedAtUnixSeconds: observedAt,
    });
    assert.equal(mapped.ok, true);
    if (!mapped.ok) return;
    const representation = buildRepresentationRecord(asset, mapped.value.identity, asset.deployments.value[0]!, {
      disclosureObservedAtUnixSeconds: observedAt,
    });
    assert.equal(representation.ok, true);
    if (!representation.ok) return;
    assert.equal(representation.value.instrumentType[0]?.value, 'DEBT_INSTRUMENT');
    assert.equal(representation.value.backing[0]?.value, 'FULLY_BACKED');
    assert.equal(representation.value.rights.BENEFICIAL_OWNERSHIP?.[0]?.value, 'ABSENT');
    assert.equal(representation.value.rights.DIVIDEND_TREATMENT?.[0]?.value, 'PRICE_ADJUSTED');
    assert.equal(representation.value.corporateActionHandling[0]?.value, 'ON_CHAIN_MULTIPLIER');
  });

  test('refuses a mapping that matches ticker but not authoritative UID', () => {
    const asset = normalizedAsset();
    const mapped = mapCanonicalAsset(asset, {
      robinhoodUid: '0x0000000000000000000000000000000000000000000000000000000000000000',
      isin: asset.isin.value, assetClass: 'fund', primaryName: 'Invesco QQQ Trust', displayTicker: 'QQQ',
      primaryMarketIdentifier: 'XNAS', sourceId: 'mandate-curation-2026-09-24', curatedAtUnixSeconds: observedAt,
    });
    assert.equal(mapped.ok, false);
  });
});
