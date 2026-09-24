import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobinhoodAsset } from '../src/asset.ts';
import { parseOnchainTokenObservation, verifyContractIdentity, type RawOnchainTokenObservation } from '../src/onchain.ts';

const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;
function abiString(value: string): string {
  const body = Buffer.from(value).toString('hex');
  const padded = body.padEnd(Math.ceil(body.length / 64) * 64, '0');
  return `0x${(32n).toString(16).padStart(64, '0')}${BigInt(body.length / 2).toString(16).padStart(64, '0')}${padded}`;
}

function observation(): RawOnchainTokenObservation {
  return {
    chainId: '0x1237', blockNumber: '0x4468e5a', blockTimestamp: '0x6ab5a600',
    contractAddress: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', code: '0x60016000',
    symbolResult: abiString('NVDA'), nameResult: abiString('NVIDIA • Robinhood Token'), decimalsResult: word(18n),
    uidResult: '0x00000000000000000000000000000000915f477416294f5099a5e0e09f327ce5',
    uiMultiplierResult: word(1_000_775_159_164_630_595n), newUIMultiplierResult: word(1_000_775_159_164_630_595n),
    effectiveAtResult: word(1_788_998_430n), oraclePausedResult: word(0n),
  };
}

function asset() {
  const result = parseRobinhoodAsset({
    id: '0x00000000000000000000000000000000915f477416294f5099a5e0e09f327ce5',
    tokenSymbol: 'NVDA', tokenName: 'NVIDIA • Robinhood Token',
    deployments: [{ contractAddress: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', chainId: 4663 }],
    currentMultiplier: '1.000775159164630595', pendingMultiplier: '', status: 'ASSET_STATUS_ACTIVE',
    tradingCapabilities: {
      market: { whole: 'TRADING_STATUS_TRADABLE', fractional: 'TRADING_STATUS_TRADABLE' },
      extended: { whole: 'TRADING_STATUS_TRADABLE', fractional: 'TRADING_STATUS_TRADABLE' },
      overnight: { whole: 'TRADING_STATUS_TRADABLE', fractional: 'TRADING_STATUS_TRADABLE' },
    }, tokenDecimals: 18, isin: 'US67066G1040',
  }, { fetchedAtUnixSeconds: 1_790_289_408n });
  if (!result.ok) throw new Error('asset fixture must parse');
  return result.value;
}

describe('onchain Stock Token normalization', () => {
  test('decodes code, metadata, UID and multiplier at a fixed block', () => {
    const parsed = parseOnchainTokenObservation(observation());
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.chainId.value, 4663n);
    assert.equal(parsed.value.symbol.value, 'NVDA');
    assert.equal(parsed.value.decimals.value, 18);
    assert.equal(parsed.value.currentMultiplier.value.atoms, 1_000_775_159_164_630_595n);
    assert.equal(parsed.value.pendingMultiplier.value, null);
    assert.equal(parsed.value.oraclePaused.value, false);
  });

  test('authoritative deployment plus matching state verifies', () => {
    const parsed = parseOnchainTokenObservation(observation());
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(verifyContractIdentity(asset(), parsed.value).ok, true);
  });

  test('same-symbol fake token does not establish Robinhood identity', () => {
    const fake = { ...observation(), contractAddress: '0x1111111111111111111111111111111111111111' };
    const parsed = parseOnchainTokenObservation(fake);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const verified = verifyContractIdentity(asset(), parsed.value);
    assert.equal(verified.ok, false);
    if (!verified.ok) assert.equal(verified.error.code, 'DEPLOYMENT_MISMATCH');
  });

  test('chain mismatch, missing code and metadata mismatch fail closed', () => {
    for (const mutate of [
      (raw: Record<string, unknown>) => { raw['chainId'] = '0xa4b1'; },
      (raw: Record<string, unknown>) => { raw['code'] = '0x'; },
      (raw: Record<string, unknown>) => { raw['uidResult'] = word(1n); },
    ]) {
      const raw = { ...observation() } as unknown as Record<string, unknown>;
      mutate(raw);
      const parsed = parseOnchainTokenObservation(raw as unknown as RawOnchainTokenObservation);
      if (!parsed.ok) {
        assert.equal(parsed.error.code, 'CONTRACT_CODE_MISSING');
      } else {
        assert.equal(verifyContractIdentity(asset(), parsed.value).ok, false);
      }
    }
  });

  test('represents a future multiplier separately from the active multiplier', () => {
    const raw = { ...observation(), newUIMultiplierResult: word(2_000_000_000_000_000_000n), effectiveAtResult: word(1_800_000_000n) };
    const parsed = parseOnchainTokenObservation(raw);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.currentMultiplier.value.atoms, 1_000_775_159_164_630_595n);
    assert.equal(parsed.value.pendingMultiplier.value?.atoms, 2_000_000_000_000_000_000n);
    assert.equal(parsed.value.pendingMultiplierEffectiveAt.value, 1_800_000_000n);
  });
});
