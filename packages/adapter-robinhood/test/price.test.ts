import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { type Identifier, TrustClass } from '@mandate/kernel';
import { parseRobinhoodPriceResponse, requireFreshPrice, tokenEquivalentPrice } from '../src/price.ts';
import { EvidenceClass, ObservationClock } from '../src/evidence.ts';

const generatedAt = 1_790_289_401n;
const fetchedAtUnixSeconds = 1_790_289_408n;

function quote(): Record<string, unknown> {
  return { quotes: [{
    tokenSymbol: 'CRWD',
    deployments: [{ contractAddress: '0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931', chainId: 4663 }],
    bid: '259.69', ask: '259.78', currency: 'USD', dailyTradingVolume: '8387141',
    isTradingHalt: false, generatedAt: '2026-09-24T22:36:41.206300409Z',
    tokenBid: '1038.760000000000000000', tokenAsk: '1039.120000000000000000',
  }] };
}

function multiplier(value: bigint) {
  return {
    value: { atoms: value, decimals: 18 },
    evidenceClass: EvidenceClass.DIRECT_AUTHORITATIVE_OBSERVATION,
    observationClock: ObservationClock.HTTP_RETRIEVAL_TIME,
    provenance: { trustClass: TrustClass.AUTHORITATIVE, sourceId: 'assets' as Identifier, observedAtUnixSeconds: generatedAt },
  };
}

describe('Robinhood price normalization', () => {
  test('uses generatedAt as observation time and preserves fetch time separately', () => {
    const result = parseRobinhoodPriceResponse(quote(), { fetchedAtUnixSeconds });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.generatedAtUnixSeconds, generatedAt);
    assert.equal(result.value.fetchedAtUnixSeconds, fetchedAtUnixSeconds);
    assert.equal(result.value.underlyingBid.provenance.observedAtUnixSeconds, generatedAt);
  });

  test('normalizes multipliers of one, above one, and below one exactly', () => {
    const parsed = parseRobinhoodPriceResponse(quote(), { fetchedAtUnixSeconds });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    for (const [m, expected] of [
      [1_000_000_000_000_000_000n, 259_690_000_000_000_000_000n],
      [4_000_000_000_000_000_000n, 1_038_760_000_000_000_000_000n],
      [500_000_000_000_000_000n, 129_845_000_000_000_000_000n],
    ] as const) {
      const normalized = tokenEquivalentPrice(parsed.value.underlyingBid, multiplier(m));
      assert.equal(normalized.ok, true);
      if (normalized.ok) assert.equal(normalized.value.value.atoms, expected);
    }
  });

  test('agrees exactly with the live wire tokenBid field', () => {
    const parsed = parseRobinhoodPriceResponse(quote(), { fetchedAtUnixSeconds });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const normalized = tokenEquivalentPrice(parsed.value.underlyingBid, multiplier(4_000_000_000_000_000_000n));
    assert.equal(normalized.ok, true);
    if (!normalized.ok) return;
    assert.equal(normalized.value.value.atoms, parsed.value.publishedTokenBid?.value.atoms);
  });

  test('freshness rejects stale and future source timestamps', () => {
    const parsed = parseRobinhoodPriceResponse(quote(), { fetchedAtUnixSeconds });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(requireFreshPrice(parsed.value, generatedAt + 15n, 15n).ok, true);
    assert.equal(requireFreshPrice(parsed.value, generatedAt + 16n, 15n).ok, false);
    assert.equal(requireFreshPrice(parsed.value, generatedAt - 1n, 15n).ok, false);
  });

  test('trading halt is an explicit source value', () => {
    const raw = quote();
    ((raw['quotes'] as Record<string, unknown>[])[0] as Record<string, unknown>)['isTradingHalt'] = true;
    const parsed = parseRobinhoodPriceResponse(raw, { fetchedAtUnixSeconds });
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.value.tradingHalt.value, true);
  });

  test('malformed decimals, missing halt and inverted spread fail closed', () => {
    const mutations = [
      (row: Record<string, unknown>) => { row['bid'] = 'NaN'; },
      (row: Record<string, unknown>) => { delete row['isTradingHalt']; },
      (row: Record<string, unknown>) => { row['bid'] = '300'; row['ask'] = '200'; },
    ];
    for (const mutate of mutations) {
      const raw = quote();
      mutate((raw['quotes'] as Record<string, unknown>[])[0]!);
      assert.equal(parseRobinhoodPriceResponse(raw, { fetchedAtUnixSeconds }).ok, false);
    }
  });
});
