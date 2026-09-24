import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ConsistencyStatus,
  compareAssetAndOnchain,
  compareOracleWithRest,
  compareRestTokenPrices,
  parseOracleObservation,
  tokenEquivalentPrice,
} from '../src/index.ts';
import {
  FIXTURE_SYMBOLS,
  loadMainnetAssets,
  loadMainnetPrice,
  loadOnchainToken,
  loadOraclePrice,
} from './support/mainnet-fixture.ts';

describe('REST and onchain cross-surface consistency', () => {
  it('matches every comparable contract fact in the fixed-block capture', () => {
    const assets = loadMainnetAssets();
    for (const symbol of FIXTURE_SYMBOLS) {
      const asset = assets.find((candidate) => candidate.tokenSymbol.value === symbol);
      assert.ok(asset);
      const diagnostics = compareAssetAndOnchain(asset, loadOnchainToken(symbol));
      assert.equal(diagnostics.length, 7);
      assert.ok(diagnostics.every((item) => item.status === ConsistencyStatus.MATCH));
    }
  });

  it('proves raw REST prices require multiplier normalization', () => {
    const assets = loadMainnetAssets();
    for (const symbol of FIXTURE_SYMBOLS) {
      const asset = assets.find((candidate) => candidate.tokenSymbol.value === symbol);
      assert.ok(asset);
      assert.ok(compareRestTokenPrices(asset, loadMainnetPrice(symbol)).every((item) => item.status === ConsistencyStatus.MATCH));
    }
  });

  it('parses five live feed observations but does not compare different times', () => {
    const assets = loadMainnetAssets();
    for (const symbol of ['AAPL', 'NVDA', 'TSLA', 'QQQ', 'MSFT'] as const) {
      const asset = assets.find((candidate) => candidate.tokenSymbol.value === symbol);
      assert.ok(asset);
      const oracle = loadOraclePrice(symbol);
      assert.equal(oracle.chainId.value, 4663n);
      assert.ok(oracle.codeBytes > 0);
      assert.equal(compareOracleWithRest(asset, loadMainnetPrice(symbol), oracle, 15n).status, ConsistencyStatus.NOT_COMPARABLE);
    }
  });

  it('compares multiplier-adjusted values when source times are compatible', () => {
    const asset = loadMainnetAssets().find((candidate) => candidate.tokenSymbol.value === 'AAPL');
    assert.ok(asset);
    const price = loadMainnetPrice('AAPL');
    const normalizedBid = tokenEquivalentPrice(price.underlyingBid, asset.currentMultiplier);
    assert.ok(normalizedBid.ok);
    const captured = loadOraclePrice('AAPL');
    const comparable = {
      ...captured,
      updatedAtUnixSeconds: price.generatedAtUnixSeconds,
      tokenPrice: { ...captured.tokenPrice, value: normalizedBid.value.value },
    };
    assert.equal(compareOracleWithRest(asset, price, comparable, 15n).status, ConsistencyStatus.MATCH);
    const outsideSpread = {
      ...comparable,
      tokenPrice: { ...comparable.tokenPrice, value: { ...comparable.tokenPrice.value, atoms: 1n } },
    };
    assert.equal(compareOracleWithRest(asset, price, outsideSpread, 15n).status, ConsistencyStatus.MISMATCH);
  });

  it('reports a contract multiplier mismatch explicitly', () => {
    const asset = loadMainnetAssets().find((candidate) => candidate.tokenSymbol.value === 'NVDA');
    assert.ok(asset);
    const token = loadOnchainToken('NVDA');
    const altered = { ...token, currentMultiplier: { ...token.currentMultiplier, value: { atoms: 1n, decimals: 18 } } };
    const mismatch = compareAssetAndOnchain(asset, altered).find((item) => item.fact === 'currentMultiplier');
    assert.equal(mismatch?.status, ConsistencyStatus.MISMATCH);
  });

  it('fails closed on missing code, negative answer and future observation', () => {
    const valid = loadOraclePrice('AAPL');
    const word = (value: bigint): string => value.toString(16).padStart(64, '0');
    const raw = {
      chainId: '0x1237', blockNumber: '0x1', blockTimestamp: '0x64',
      feedAddress: valid.feedAddress.value, code: '0x01', decimalsResult: `0x${word(8n)}`,
      latestRoundDataResult: `0x${word(1n)}${word(100n)}${word(1n)}${word(99n)}${word(1n)}`,
    };
    assert.equal(parseOracleObservation({ ...raw, code: '0x' }).ok, false);
    assert.equal(parseOracleObservation({ ...raw, latestRoundDataResult: `0x${word(1n)}${word((1n << 256n) - 1n)}${word(1n)}${word(99n)}${word(1n)}` }).ok, false);
    assert.equal(parseOracleObservation({ ...raw, latestRoundDataResult: `0x${word(1n)}${word(100n)}${word(1n)}${word(101n)}${word(1n)}` }).ok, false);
  });
});
