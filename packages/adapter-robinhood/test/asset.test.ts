import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobinhoodAsset } from '../src/asset.ts';

const fetchedAtUnixSeconds = 1_790_289_408n;

function asset(): Record<string, unknown> {
  return {
    id: '0x000000000000000000000000000000001adecf2c6a3749f9873b8926b5977c0a',
    tokenSymbol: 'CRWD',
    tokenName: 'CrowdStrike Holdings • Robinhood Token',
    deployments: [{ contractAddress: '0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931', chainId: 4663 }],
    currentMultiplier: '4.000000000000000000',
    pendingMultiplier: '',
    status: 'ASSET_STATUS_ACTIVE',
    tradingCapabilities: {
      market: { whole: 'TRADING_STATUS_TRADABLE', fractional: 'TRADING_STATUS_TRADABLE' },
      extended: { whole: 'TRADING_STATUS_TRADABLE', fractional: 'TRADING_STATUS_TRADABLE' },
      overnight: { whole: 'TRADING_STATUS_TRADABLE', fractional: 'TRADING_STATUS_TRADABLE' },
    },
    tokenDecimals: 18,
    isin: 'US22788C1053',
  };
}

describe('Robinhood asset normalization', () => {
  test('strictly normalizes a live-shaped asset and authoritative ISIN identity', () => {
    const result = parseRobinhoodAsset(asset(), { fetchedAtUnixSeconds });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.canonicalAsset.value, { assetClass: 'equity', idScheme: 'isin', value: 'US22788C1053' });
    assert.equal(result.value.currentMultiplier.value.atoms, 4_000_000_000_000_000_000n);
    assert.equal(result.value.deployments.value[0]?.contractAddress, '0xea72ecca2d0f6bfa1394dbbcff85b52cd4233931');
    assert.equal(result.value.pendingMultiplier.value, null);
  });

  test('rejects ticker-only identity when ISIN is missing', () => {
    const raw = asset();
    delete raw['isin'];
    const result = parseRobinhoodAsset(raw, { fetchedAtUnixSeconds });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'INVALID_IDENTITY');
  });

  test('rejects malformed multiplier, address and chain id', () => {
    for (const mutate of [
      (raw: Record<string, unknown>) => { raw['currentMultiplier'] = '4e0'; },
      (raw: Record<string, unknown>) => { (raw['deployments'] as Record<string, unknown>[])[0]!['contractAddress'] = '0x1234'; },
      (raw: Record<string, unknown>) => { (raw['deployments'] as Record<string, unknown>[])[0]!['chainId'] = '4663'; },
    ]) {
      const raw = asset();
      mutate(raw);
      assert.equal(parseRobinhoodAsset(raw, { fetchedAtUnixSeconds }).ok, false);
    }
  });

  test('rejects unknown trading status rather than treating it as tradable', () => {
    const raw = asset();
    const capabilities = raw['tradingCapabilities'] as Record<string, Record<string, unknown>>;
    capabilities['overnight']!['whole'] = 'TRADING_STATUS_FUTURE_VALUE';
    const result = parseRobinhoodAsset(raw, { fetchedAtUnixSeconds });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'UNKNOWN_ENUM');
  });

  test('requires a pending multiplier and its effective time together', () => {
    const missingTime = asset();
    missingTime['pendingMultiplier'] = '0.500000000000000000';
    assert.equal(parseRobinhoodAsset(missingTime, { fetchedAtUnixSeconds }).ok, false);

    const orphanTime = asset();
    orphanTime['pendingMultiplierEffectiveTime'] = '2026-10-01T00:00:00Z';
    assert.equal(parseRobinhoodAsset(orphanTime, { fetchedAtUnixSeconds }).ok, false);
  });
});
