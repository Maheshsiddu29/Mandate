import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCorporateActionsResponse } from '../src/corporate-action.ts';

const fetchedAt = 1_790_289_378n;
function row(): Record<string, unknown> {
  return {
    id: '0x00000000000000000000000000000000915f477416294f5099a5e0e09f327ce5',
    type: 'CORPORATE_ACTION_TYPE_CASH_DIVIDEND', status: 'CORPORATE_ACTION_STATUS_IN_PROGRESS',
    processDate: { year: 2026, month: 10, day: 1 }, tokenSymbol: 'NVDA',
    deployments: [{ contractAddress: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', chainId: 4663 }],
    details: { cashDividend: { underlyingSymbol: 'NVDA', rate: '0.25' } },
  };
}

describe('corporate-action normalization', () => {
  test('parses the real captured cash-dividend shape', () => {
    const result = parseCorporateActionsResponse({ corpActions: [row()] }, fetchedAt);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value[0]?.type.value, 'CASH_DIVIDEND');
    assert.equal(result.value[0]?.status.value, 'IN_PROGRESS');
    assert.deepEqual(result.value[0]?.processDate.value, { year: 2026, month: 10, day: 1 });
    assert.equal(result.value[0]?.supportedForDecision, true);
  });

  test('preserves a future type as unsupported UNKNOWN', () => {
    const future = row();
    future['type'] = 'CORPORATE_ACTION_TYPE_FUTURE_EVENT';
    future['details'] = { futureEvent: { opaque: 'value' } };
    const result = parseCorporateActionsResponse({ corpActions: [future] }, fetchedAt);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value[0]?.type.value, 'UNKNOWN');
    assert.equal(result.value[0]?.supportedForDecision, false);
  });

  test('unknown status, mismatched details and malformed rate fail closed', () => {
    for (const mutate of [
      (value: Record<string, unknown>) => { value['status'] = 'CORPORATE_ACTION_STATUS_FUTURE'; },
      (value: Record<string, unknown>) => { value['details'] = { forwardSplit: { underlyingSymbol: 'NVDA', oldRate: '1', newRate: '2' } }; },
      (value: Record<string, unknown>) => { value['details'] = { cashDividend: { underlyingSymbol: 'NVDA', rate: '2e-1' } }; },
    ]) {
      const value = row();
      mutate(value);
      assert.equal(parseCorporateActionsResponse({ corpActions: [value] }, fetchedAt).ok, false);
    }
  });

  test('pending action remains pending rather than completed state', () => {
    const result = parseCorporateActionsResponse({ corpActions: [row()] }, fetchedAt);
    assert.equal(result.ok, true);
    if (result.ok) assert.notEqual(result.value[0]?.status.value, 'COMPLETED');
  });
});
