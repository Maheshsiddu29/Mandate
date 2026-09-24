import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { verifyContractIdentity } from '../src/index.ts';
import { validateFixtureManifest } from './support/fixture-manifest.ts';
import {
  FIXTURE_SYMBOLS,
  MAINNET_FIXTURE_ROOT,
  expectAdapter,
  loadCanonicalMappings,
  loadMainnetAssets,
  loadMainnetCorporateActions,
  loadMainnetPrice,
  loadOnchainToken,
} from './support/mainnet-fixture.ts';

describe('recorded Robinhood mainnet fixture', () => {
  it('pins every raw response by SHA-256', () => {
    const report = validateFixtureManifest(MAINNET_FIXTURE_ROOT);
    assert.equal(report.captureId, 'robinhood-mainnet-2026-09-24T22-36-48Z');
    assert.equal(report.artifacts, 21);
    assert.equal(report.bytes, 399_881);
  });

  it('strictly parses the full real assets and corporate-action responses', () => {
    const assets = loadMainnetAssets();
    const actions = loadMainnetCorporateActions();
    assert.equal(assets.length, 195);
    assert.equal(actions.length, 52);
    assert.deepEqual([...new Set(actions.map((action) => action.type.value))], ['CASH_DIVIDEND']);
  });

  it('maps seven UID-plus-ISIN identities without treating ticker as authority', () => {
    const assets = loadMainnetAssets();
    const mapping = loadCanonicalMappings();
    assert.equal(mapping.mappings.length, 7);
    assert.equal(mapping.mappings.find((item) => item.displayTicker === 'QQQ')?.assetClass, 'fund');
    for (const item of mapping.mappings) {
      const asset = assets.find((candidate) => candidate.uid.value === item.robinhoodUid);
      assert.equal(asset?.isin.value, item.isin);
    }
  });

  it('parses six real price snapshots and preserves real non-halted state', () => {
    for (const symbol of FIXTURE_SYMBOLS) {
      const price = loadMainnetPrice(symbol);
      assert.equal(price.tokenSymbol.value, symbol);
      assert.equal(price.tradingHalt.value, false);
      assert.ok(price.generatedAtUnixSeconds <= price.fetchedAtUnixSeconds + 1n);
    }
  });

  it('verifies six fixed-block contracts against authoritative deployments', () => {
    const assets = loadMainnetAssets();
    for (const symbol of FIXTURE_SYMBOLS) {
      const asset = assets.find((candidate) => candidate.tokenSymbol.value === symbol);
      assert.ok(asset);
      const onchain = loadOnchainToken(symbol);
      assert.equal(onchain.blockNumber.value, 0x4468e5an);
      assert.ok(onchain.codeBytes > 0);
      expectAdapter(verifyContractIdentity(asset, onchain), `${symbol} identity`);
    }
  });

  it('retains the observed capability-only asset whose price endpoint was unavailable', () => {
    const wyfi = loadMainnetAssets().find((asset) => asset.tokenSymbol.value === 'WYFI');
    assert.ok(wyfi);
    assert.equal(wyfi.tradingCapabilities.value.market.whole, 'TRADABLE');
    assert.equal(wyfi.tradingCapabilities.value.market.fractional, 'UNTRADABLE');
  });
});
