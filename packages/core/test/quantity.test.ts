/**
 * Typed economic quantities: UNIT-1 (no silent mixing), UNIT-5 (unsigned kinds
 * never go negative), exact arithmetic with explicit rescale, and the per-kind
 * asset and valuation rules of action-state-model.md §3.2.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  QUANTITY_KIND_RULES,
  QUANTITY_KINDS,
  addQuantities,
  compareQuantities,
  compareRatios,
  formatFixedDecimal,
  parseFixedDecimal,
  parseUnitCode,
  quantityMismatches,
  rescaleQuantity,
  subtractQuantities,
  validateQuantity,
  validateQuantityBound,
  validateQuantityOf,
  validateRatio,
  type CoreResult,
  type EconomicQuantity,
  type EconomicQuantityInput,
  type QuantityKind,
  type ResourceIdInput,
  type ValuationRefInput,
} from '../src/index.ts';
import { BTC, USDG, USDG_ON_L, digestOf, must } from './support/basics.ts';

function code<T>(r: CoreResult<T>): string {
  return r.ok ? 'OK' : r.error.code;
}

const USDC: ResourceIdInput = { domain: 'evm-spot', kind: 'REPRESENTATION_ASSET', localId: 'arbitrum:erc20:usdc' };
const ETH: ResourceIdInput = { domain: 'registry', kind: 'CANONICAL_ASSET', localId: 'crypto:eth' };

function q(kind: QuantityKind, unit: string, decimals: number, atoms: bigint, asset: ResourceIdInput | null, valuation: ValuationRefInput | null = null): EconomicQuantityInput {
  return { kind, unit, decimals, atoms, asset, valuation };
}

function mark(price: bigint, source = 'mark:1'): ValuationRefInput {
  return {
    price: { numeratorUnit: 'USD', denominatorUnit: 'BTC', decimals: 2, atoms: price },
    basis: 'MARK',
    source: { kind: 'STATE', stateId: digestOf(source) },
    observedAt: 1_000n,
  };
}

function execution(price: bigint, fill = 'fill:1'): ValuationRefInput {
  return {
    price: { numeratorUnit: 'USD', denominatorUnit: 'BTC', decimals: 2, atoms: price },
    basis: 'EXECUTION',
    source: { kind: 'OBSERVATION', observationId: digestOf(fill) },
    observedAt: 1_000n,
  };
}

const capital = (atoms: bigint, asset = USDG): EconomicQuantity<'CAPITAL'> => must(validateQuantityOf('CAPITAL', q('CAPITAL', 'USDG', 6, atoms, asset)));
const margin = (atoms: bigint): EconomicQuantity<'MARGIN'> => must(validateQuantityOf('MARGIN', q('MARGIN', 'USDG', 6, atoms, USDG_ON_L)));
const position = (atoms: bigint): EconomicQuantity<'POSITION_SIZE'> => must(validateQuantityOf('POSITION_SIZE', q('POSITION_SIZE', 'BTC', 8, atoms, BTC)));
const grossExposure = (atoms: bigint): EconomicQuantity<'GROSS_EXPOSURE'> =>
  must(validateQuantityOf('GROSS_EXPOSURE', q('GROSS_EXPOSURE', 'USD', 2, atoms, BTC, mark(10_000_000n))));

describe('kinds', () => {
  it('are the eleven of action-state-model.md §3.2, and only non-floating kinds are ledger-trackable', () => {
    assert.deepEqual([...QUANTITY_KINDS].sort(), [
      'CAPITAL',
      'COLLATERAL',
      'COUNT',
      'DEBT',
      'GROSS_EXPOSURE',
      'MARGIN',
      'NET_EXPOSURE',
      'NOTIONAL',
      'PNL',
      'POSITION_SIZE',
      'TOKEN_AMOUNT',
    ]);
    const notTrackable = QUANTITY_KINDS.filter((k) => !QUANTITY_KIND_RULES[k].ledgerTrackable);
    assert.deepEqual(notTrackable.sort(), ['GROSS_EXPOSURE', 'NET_EXPOSURE']);
  });

  it('enforce their asset requirement', () => {
    assert.equal(code(validateQuantity(q('POSITION_SIZE', 'BTC', 8, 1n, null))), 'ASSET_REQUIRED');
    assert.equal(code(validateQuantity(q('CAPITAL', 'USDG', 6, 1n, null))), 'ASSET_REQUIRED');
    assert.equal(code(validateQuantity(q('PNL', 'USDG', 6, 1n, USDG))), 'ASSET_FORBIDDEN');
    assert.equal(code(validateQuantity(q('COUNT', 'COUNT', 0, 1n, USDG))), 'ASSET_FORBIDDEN');
    // A token amount is of a representation; an exposure is to a canonical asset (INV-6).
    assert.equal(code(validateQuantity(q('TOKEN_AMOUNT', 'USDG', 6, 1n, BTC))), 'ASSET_FORM_INVALID');
    assert.equal(code(validateQuantity(q('POSITION_SIZE', 'USDG', 6, 1n, USDG))), 'ASSET_FORM_INVALID');
    assert.equal(code(validateQuantity(q('NOTIONAL', 'USD', 2, 1n, USDG, execution(1n)))), 'ASSET_FORM_INVALID');
    // Gross exposure may span assets.
    assert.equal(code(validateQuantity(q('GROSS_EXPOSURE', 'USD', 2, 1n, null, mark(1n)))), 'OK');
  });

  it('enforce their valuation requirement and basis', () => {
    assert.equal(code(validateQuantity(q('NOTIONAL', 'USD', 2, 1n, BTC))), 'VALUATION_REQUIRED');
    assert.equal(code(validateQuantity(q('GROSS_EXPOSURE', 'USD', 2, 1n, BTC))), 'VALUATION_REQUIRED');
    assert.equal(code(validateQuantity(q('NOTIONAL', 'USD', 2, 1n, BTC, mark(1n)))), 'VALUATION_BASIS_INVALID');
    assert.equal(code(validateQuantity(q('NET_EXPOSURE', 'USD', 2, 1n, BTC, execution(1n)))), 'VALUATION_BASIS_INVALID');
    assert.equal(code(validateQuantity(q('CAPITAL', 'USDG', 6, 1n, USDG, execution(1n)))), 'VALUATION_FORBIDDEN');
    // Realized PnL is unvalued; unrealized PnL is valued at a mark.
    assert.equal(code(validateQuantity(q('PNL', 'USD', 2, -3_500n, null))), 'OK');
    assert.equal(code(validateQuantity(q('PNL', 'USD', 2, -3_500n, null, mark(1n)))), 'OK');
    // A USD value needs a USD-per-something price.
    const eurPrice = { ...execution(1n), price: { numeratorUnit: 'EUR', denominatorUnit: 'BTC', decimals: 2, atoms: 1n } };
    assert.equal(code(validateQuantity(q('NOTIONAL', 'USD', 2, 1n, BTC, eurPrice))), 'VALUATION_UNIT_MISMATCH');
  });

  it('enforce signedness: unsigned kinds never hold a negative value (UNIT-5)', () => {
    assert.equal(code(validateQuantity(q('CAPITAL', 'USDG', 6, -1n, USDG))), 'QUANTITY_NEGATIVE_UNSIGNED');
    assert.equal(code(validateQuantity(q('POSITION_SIZE', 'BTC', 8, -5_000_000n, BTC))), 'OK');
    assert.equal(code(validateQuantity(q('NET_EXPOSURE', 'USD', 2, -120_000n, BTC, mark(1n)))), 'OK');
  });

  it('tie the COUNT unit to the COUNT kind, both ways', () => {
    assert.equal(code(validateQuantity(q('COUNT', 'COUNT', 0, 3n, null))), 'OK');
    assert.equal(code(validateQuantity(q('COUNT', 'USD', 0, 3n, null))), 'COUNT_UNIT_REQUIRED');
    assert.equal(code(validateQuantity(q('CAPITAL', 'COUNT', 0, 3n, USDG))), 'COUNT_UNIT_REQUIRED');
  });
});

describe('no floating point, no ambiguous numbers', () => {
  it('atoms are never a JavaScript number, including NaN and Infinity', () => {
    for (const n of [600, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53 + 2]) {
      assert.equal(code(validateQuantity(q('CAPITAL', 'USDG', 6, n as unknown as bigint, USDG))), 'NUMBER_NOT_PERMITTED');
    }
  });

  it('atoms as text must be a canonical integer, not a decimal', () => {
    assert.equal(code(validateQuantity({ ...q('CAPITAL', 'USDG', 6, 0n, USDG), atoms: '600000000' })), 'OK');
    for (const bad of ['600.5', '6e8', '0600', '-0']) {
      assert.equal(code(validateQuantity({ ...q('CAPITAL', 'USDG', 6, 0n, USDG), atoms: bad })), 'NON_CANONICAL_INTEGER', bad);
    }
  });

  it('decimals are an explicit integer 0..38', () => {
    assert.equal(code(validateQuantity(q('CAPITAL', 'USDG', 0, 1n, USDG))), 'OK');
    assert.equal(code(validateQuantity(q('CAPITAL', 'USDG', 39, 1n, USDG))), 'INVALID_DECIMALS');
    assert.equal(code(validateQuantity(q('CAPITAL', 'USDG', Number.NaN, 1n, USDG))), 'NON_FINITE_NUMBER');
    assert.equal(code(validateQuantity(q('CAPITAL', 'USDG', 2.5, 1n, USDG))), 'NON_INTEGER');
  });

  it('atoms stay inside uint256 or int256 by signedness', () => {
    assert.equal(code(validateQuantity(q('CAPITAL', 'USDG', 6, 2n ** 256n - 1n, USDG))), 'OK');
    assert.equal(code(validateQuantity(q('CAPITAL', 'USDG', 6, 2n ** 256n, USDG))), 'QUANTITY_OUT_OF_RANGE');
    assert.equal(code(validateQuantity(q('POSITION_SIZE', 'BTC', 8, -(2n ** 255n), BTC))), 'OK');
    assert.equal(code(validateQuantity(q('POSITION_SIZE', 'BTC', 8, 2n ** 255n, BTC))), 'QUANTITY_OUT_OF_RANGE');
  });
});

describe('units', () => {
  it('any canonical code is valid; Core hardcodes no asset list', () => {
    for (const u of ['USD', 'USDG', 'USDC', 'BTC', 'ETH', 'SHARE', 'CONTRACT', 'XAU', 'STETH', 'EUR.CASH', 'COUNT']) {
      assert.equal(code(parseUnitCode(u, 'u')), 'OK', u);
    }
  });

  it('refuse case variants and malformed codes rather than folding them', () => {
    for (const bad of ['usd', 'Usd', 'stETH', '', 'U$D', '-USD', 'USD-', 'A'.repeat(33), 'US D']) {
      assert.equal(code(parseUnitCode(bad, 'u')), 'MALFORMED_UNIT', bad);
    }
  });
});

describe('UNIT-1: compatibility and arithmetic', () => {
  it('Capital USDG + Capital USDG is structurally compatible and exact', () => {
    const sum = must(addQuantities(capital(800_000_000n), capital(600_000_000n)));
    assert.equal(sum.atoms, 1_400_000_000n);
    assert.equal(sum.kind, 'CAPITAL');
    assert.deepEqual(quantityMismatches(capital(1n), capital(2n)), []);
  });

  it('Capital USDG + Margin USDG is refused although both are USDG', () => {
    const a: EconomicQuantity = capital(800_000_000n);
    const b: EconomicQuantity = margin(600_000_000n);
    assert.ok(quantityMismatches(a, b).includes('KIND'));
    assert.equal(code(addQuantities(a, b)), 'QUANTITY_KIND_MISMATCH');
    assert.equal(code(compareQuantities(a, b)), 'QUANTITY_KIND_MISMATCH');
  });

  it('PositionSize BTC + MarkedExposure USD is refused on kind, unit and valuation', () => {
    const a: EconomicQuantity = position(3_000_000n);
    const b: EconomicQuantity = grossExposure(300_000n);
    assert.deepEqual(quantityMismatches(a, b), ['KIND', 'UNIT', 'DECIMALS', 'VALUATION']);
    assert.equal(code(addQuantities(a, b)), 'QUANTITY_KIND_MISMATCH');
  });

  it('same kind in different units, or of different assets, is refused', () => {
    const usdc = must(validateQuantityOf('CAPITAL', q('CAPITAL', 'USDC', 6, 1n, USDC)));
    assert.equal(code(addQuantities(capital(1n), usdc)), 'QUANTITY_UNIT_MISMATCH');
    const ethPosition = must(validateQuantityOf('POSITION_SIZE', q('POSITION_SIZE', 'BTC', 8, 1n, ETH)));
    assert.equal(code(addQuantities(position(1n), ethPosition)), 'QUANTITY_ASSET_MISMATCH');
  });

  it('valued quantities combine only at the same valuation', () => {
    const n1 = must(validateQuantityOf('NOTIONAL', q('NOTIONAL', 'USD', 2, 150_000n, BTC, execution(10_000_000n, 'fill:1'))));
    const n2 = must(validateQuantityOf('NOTIONAL', q('NOTIONAL', 'USD', 2, 299_700n, BTC, execution(9_990_000n, 'fill:2'))));
    assert.deepEqual(quantityMismatches(n1, n2), ['VALUATION']);
    assert.equal(code(addQuantities(n1, n2)), 'QUANTITY_VALUATION_MISMATCH');
    assert.equal(code(addQuantities(n1, n1)), 'OK');
  });

  it('different decimals are refused until the caller rescales explicitly', () => {
    const coarse = must(validateQuantityOf('CAPITAL', q('CAPITAL', 'USDG', 2, 100n, USDG)));
    assert.equal(code(addQuantities(capital(1_000_000n), coarse)), 'QUANTITY_DECIMALS_MISMATCH');
    const lifted = must(rescaleQuantity(coarse, 6));
    assert.equal(lifted.atoms, 1_000_000n);
    assert.equal(must(addQuantities(capital(1_000_000n), lifted)).atoms, 2_000_000n);
  });

  it('a rescale that would drop a non-zero digit is refused, never rounded', () => {
    assert.equal(must(rescaleQuantity(capital(1_230_000n), 4)).atoms, 12_300n);
    assert.equal(code(rescaleQuantity(capital(1_230_001n), 4)), 'INEXACT_RESCALE');
    assert.equal(code(rescaleQuantity(capital(1n), 39)), 'INVALID_DECIMALS');
  });

  it('an unsigned subtraction below zero is refused, never wrapped or saturated (UNIT-5)', () => {
    assert.equal(code(subtractQuantities(capital(400n), capital(600n))), 'QUANTITY_NEGATIVE_UNSIGNED');
    assert.equal(must(subtractQuantities(position(5_000_000n), position(6_000_000n))).atoms, -1_000_000n);
  });

  it('a sum past the kind\'s range is refused', () => {
    assert.equal(code(addQuantities(capital(2n ** 256n - 1n), capital(1n))), 'QUANTITY_OUT_OF_RANGE');
  });

  it('comparison is exact', () => {
    assert.equal(must(compareQuantities(capital(1n), capital(2n))), -1);
    assert.equal(must(compareQuantities(capital(2n), capital(2n))), 0);
  });
});

describe('mark-priced exposure cannot satisfy committed notional (Phase 7B.1 ruling 2)', () => {
  it('a notional valued at a mark is refused', () => {
    assert.equal(code(validateQuantity(q('NOTIONAL', 'USD', 2, 100_000n, BTC, mark(10_000_000n)))), 'VALUATION_BASIS_INVALID');
  });

  it('a mark read from a snapshot cannot be relabelled as an execution price: EXECUTION needs fill evidence', () => {
    const markAsExecution: ValuationRefInput = { ...execution(10_000_000n), source: { kind: 'STATE', stateId: digestOf('mark:1') } };
    assert.deepEqual(validateQuantity(q('NOTIONAL', 'USD', 2, 100_000n, BTC, markAsExecution)), {
      ok: false,
      error: { code: 'VALUATION_SOURCE_INVALID', path: 'quantity.valuation.source.kind' },
    });
    const limitFromFill: ValuationRefInput = { ...execution(10_000_000n), basis: 'LIMIT' };
    assert.equal(code(validateQuantity(q('NOTIONAL', 'USD', 2, 100_000n, BTC, limitFromFill))), 'VALUATION_SOURCE_INVALID');
    const markFromFill: ValuationRefInput = { ...mark(10_000_000n), source: { kind: 'OBSERVATION', observationId: digestOf('fill:1') } };
    assert.equal(code(validateQuantity(q('GROSS_EXPOSURE', 'USD', 2, 100_000n, BTC, markFromFill))), 'VALUATION_SOURCE_INVALID');
  });

  it('a marked exposure is not a committed notional, and neither adds to nor compares with one', () => {
    const exposure = grossExposure(100_000n);
    const committed = must(validateQuantityOf('NOTIONAL', q('NOTIONAL', 'USD', 2, 100_000n, BTC, execution(10_000_000n))));
    assert.equal(code(validateQuantityOf('NOTIONAL', q('GROSS_EXPOSURE', 'USD', 2, 100_000n, BTC, mark(10_000_000n)))), 'QUANTITY_KIND_MISMATCH');
    assert.equal(code(addQuantities(committed as EconomicQuantity, exposure as EconomicQuantity)), 'QUANTITY_KIND_MISMATCH');
    assert.equal(code(compareQuantities(exposure as EconomicQuantity, committed as EconomicQuantity)), 'QUANTITY_KIND_MISMATCH');
    // A marked value floats and is never a ledger counter (decision 10), so no committed-notional dimension can receive it.
    assert.equal(QUANTITY_KIND_RULES.GROSS_EXPOSURE.ledgerTrackable, false);
    assert.equal(QUANTITY_KIND_RULES.NET_EXPOSURE.ledgerTrackable, false);
  });
});

describe('bounds and ratios', () => {
  it('a limit carries kind, unit and decimals, no asset and no price, and is never negative', () => {
    assert.equal(code(validateQuantityBound({ kind: 'NOTIONAL', unit: 'USD', decimals: 2, atoms: 500_000n }, 'limit')), 'OK');
    assert.equal(code(validateQuantityBound({ kind: 'CAPITAL', unit: 'USDG', decimals: 6, atoms: -1n }, 'limit')), 'QUANTITY_NEGATIVE_UNSIGNED');
    assert.equal(code(validateQuantityBound({ kind: 'CAPITAL', unit: 'USDG', decimals: 6, atoms: 1n, asset: null } as never, 'limit')), 'UNKNOWN_FIELD');
  });

  it('ratios are exact: 3x is {3, 0}, 50 bps is {50, 4}, and compare by cross-multiplication', () => {
    const three = must(validateRatio({ numerator: 3n, scale: 0 }, 'r'));
    const threeAgain = must(validateRatio({ numerator: 30n, scale: 1 }, 'r'));
    const fiveBps = must(validateRatio({ numerator: 50n, scale: 4 }, 'r'));
    assert.equal(compareRatios(three, threeAgain), 0);
    assert.equal(compareRatios(fiveBps, three), -1);
    assert.equal(code(validateRatio({ numerator: -1n, scale: 0 }, 'r')), 'INTEGER_OUT_OF_RANGE');
    assert.equal(code(validateRatio({ numerator: 1n, scale: 39 }, 'r')), 'INVALID_DECIMALS');
  });
});

describe('fixed-point text', () => {
  it('parses only the canonical form at the stated decimals', () => {
    assert.deepEqual(parseFixedDecimal('1234.56', 2, 'x'), { ok: true, value: 123_456n });
    assert.deepEqual(parseFixedDecimal('-0.05', 2, 'x'), { ok: true, value: -5n });
    assert.deepEqual(parseFixedDecimal('7', 0, 'x'), { ok: true, value: 7n });
    for (const bad of ['1234.5', '1234.560', '01234.56', '-0.00', '1e3', '1234', '.56', '1,234.56', ' 1.00']) {
      assert.equal(code(parseFixedDecimal(bad, 2, 'x')), 'NON_CANONICAL_DECIMAL', bad);
    }
  });

  it('formats exactly and inverts parsing', () => {
    for (const [atoms, decimals, text] of [
      [123_456n, 2, '1234.56'],
      [5n, 2, '0.05'],
      [-5n, 2, '-0.05'],
      [600_000_000n, 6, '600.000000'],
      [7n, 0, '7'],
    ] as const) {
      assert.equal(formatFixedDecimal(atoms, decimals), text);
      assert.deepEqual(parseFixedDecimal(text, decimals, 'x'), { ok: true, value: atoms });
    }
  });
});
