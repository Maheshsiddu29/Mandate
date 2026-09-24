import { test } from 'node:test';
import assert from 'node:assert/strict';
import { multiplyFixedExact, multiplyFixedFloor, parseFixedDecimal } from '../src/decimal.ts';

test('fixed decimal parsing and multiplier normalization are exact', () => {
  const price = parseFixedDecimal('259.69', 18, 'price');
  const multiplier = parseFixedDecimal('4.000000000000000000', 18, 'multiplier');
  assert.equal(price.ok && multiplier.ok, true);
  if (!price.ok || !multiplier.ok) return;
  const product = multiplyFixedExact(price.value, multiplier.value, 18);
  assert.deepEqual(product, { ok: true, value: { atoms: 1_038_760_000_000_000_000_000n, decimals: 18 } });
});

test('fixed decimal parser refuses signs, exponents, excess precision and overflow', () => {
  for (const value of ['-1', '+1', '1e2', ' 1', '1.0000000000000000001', `${2n ** 256n}`]) {
    assert.equal(parseFixedDecimal(value, 18, 'value').ok, false, value);
  }
});

test('multiplication refuses an inexact boundary instead of rounding', () => {
  const result = multiplyFixedExact({ atoms: 1n, decimals: 1 }, { atoms: 1n, decimals: 1 }, 1);
  assert.equal(result.ok, false);
});

test('Robinhood wire normalization explicitly truncates sub-atom precision', () => {
  const result = multiplyFixedFloor(
    { atoms: 335_900_000_000_000_000_000n, decimals: 18 },
    { atoms: 1_000_566_080_061_092_436n, decimals: 18 },
    18,
  );
  assert.deepEqual(result, { ok: true, value: { atoms: 336_090_146_292_520_949_252n, decimals: 18 } });
});
