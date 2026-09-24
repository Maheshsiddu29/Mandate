/**
 * Units and fixed-point arithmetic.
 *
 * INV-18: every quantity carries its unit and its decimals; a unit-less
 * quantity is not representable. INV-16: no floating point participates in a
 * safety decision.
 *
 * `500000000` is not a value in this kernel. It is meaningless until it is
 * known whether it is $500.00, 500 shares, 500 USDC or 5 tokens, and the
 * purpose of these types is to make the ambiguous form impossible to construct
 * rather than merely discouraged.
 *
 * All arithmetic is exact integer arithmetic on `atoms`, the value scaled by
 * `10^decimals`. Where a result is not exactly representable, the rounding
 * direction is stated at the call site and chosen so the conservative outcome
 * is the one that happens: costs round up, deviations round up, and nothing
 * that bounds risk is ever rounded in the caller's favour.
 */

import { type Result, ok, err } from './result.ts';
import type { ReasonCodeName } from './reason-codes.ts';
import { parseIdentifier, type Identifier } from './identifiers.ts';
import { parseBigInt } from './time.ts';

/** Unit code: `USD`, `SHARE`, `USDC`. An identifier, never free text. */
export type UnitCode = Identifier;

export const MAX_DECIMALS = 38;
export const UINT256_MAX = 2n ** 256n - 1n;

/**
 * A scalar amount of one unit.
 *
 * `atoms` is the value scaled by `10^decimals`; `decimals` is part of the
 * value's identity, not a display preference. Two amounts with the same unit
 * but different scales are not interchangeable without an explicit, checked
 * rescale.
 */
export interface Amount {
  readonly unit: UnitCode;
  readonly decimals: number;
  readonly atoms: bigint;
}

/**
 * A price: `numeratorUnit` per `denominatorUnit`, scaled by `10^decimals`.
 *
 * Held as a ratio of two named units rather than a bare number so that
 * multiplying a quantity by a price is a unit-checked operation and a
 * shares/dollars transposition cannot type-check its way into an execution.
 */
export interface Price {
  readonly numeratorUnit: UnitCode;
  readonly denominatorUnit: UnitCode;
  readonly decimals: number;
  readonly atoms: bigint;
}

function parseDecimals(raw: unknown): Result<number, ReasonCodeName> {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return err('MALFORMED_IDENTIFIER');
  if (raw < 0 || raw > MAX_DECIMALS) return err('VALUE_OUT_OF_RANGE');
  return ok(raw);
}

function parseAtoms(raw: unknown): Result<bigint, ReasonCodeName> {
  const v = parseBigInt(raw);
  if (v === undefined) return err('MALFORMED_IDENTIFIER');
  if (v < 0n || v > UINT256_MAX) return err('VALUE_OUT_OF_RANGE');
  return ok(v);
}

export function parseAmount(raw: unknown): Result<Amount, ReasonCodeName> {
  if (typeof raw !== 'object' || raw === null) return err('MALFORMED_IDENTIFIER');
  const r = raw as Record<string, unknown>;
  const unit = parseIdentifier(r['unit']);
  if (!unit.ok) return unit;
  const decimals = parseDecimals(r['decimals']);
  if (!decimals.ok) return decimals;
  const atoms = parseAtoms(r['atoms']);
  if (!atoms.ok) return atoms;
  return ok({ unit: unit.value, decimals: decimals.value, atoms: atoms.value });
}

export function parsePrice(raw: unknown): Result<Price, ReasonCodeName> {
  if (typeof raw !== 'object' || raw === null) return err('MALFORMED_IDENTIFIER');
  const r = raw as Record<string, unknown>;
  const numeratorUnit = parseIdentifier(r['numeratorUnit']);
  if (!numeratorUnit.ok) return numeratorUnit;
  const denominatorUnit = parseIdentifier(r['denominatorUnit']);
  if (!denominatorUnit.ok) return denominatorUnit;
  const decimals = parseDecimals(r['decimals']);
  if (!decimals.ok) return decimals;
  const atoms = parseAtoms(r['atoms']);
  if (!atoms.ok) return atoms;
  return ok({
    numeratorUnit: numeratorUnit.value,
    denominatorUnit: denominatorUnit.value,
    decimals: decimals.value,
    atoms: atoms.value,
  });
}

/** Same unit and same scale. Amounts that merely represent the same value but at different scales are not equal. */
export function sameUnitAndScale(a: Amount, b: Amount): boolean {
  return a.unit === b.unit && a.decimals === b.decimals;
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/**
 * Compare two amounts of the same unit, at possibly different scales, exactly.
 *
 * Returns `UNIT_MISMATCH` when the units differ. Differing scales are handled
 * by cross-multiplication rather than by rescaling either side, so no precision
 * is lost and no rounding decision is smuggled into a comparison.
 */
export function compareAmounts(a: Amount, b: Amount): Result<-1 | 0 | 1, ReasonCodeName> {
  if (a.unit !== b.unit) return err('UNIT_MISMATCH');
  const left = a.atoms * pow10(b.decimals);
  const right = b.atoms * pow10(a.decimals);
  return ok(left < right ? -1 : left > right ? 1 : 0);
}

export interface NotionalBounds {
  /** Product rounded toward zero, at the target scale. */
  readonly floorAtoms: bigint;
  /** Product rounded away from zero, at the target scale. */
  readonly ceilAtoms: bigint;
}

/**
 * `quantity * price`, expressed at `targetDecimals` in the price's numerator
 * unit, as the pair of adjacent representable values.
 *
 * The product is rarely exactly representable at the target scale, and which
 * way a candidate builder rounded is not knowable. Returning both bounds lets
 * the verifier accept either convention while still rejecting anything outside
 * a one-atom band — which is what catches a 10x amount error or a decimal
 * transposition, the failure this check exists for.
 *
 * `price.denominatorUnit` must be the quantity's unit; otherwise the
 * multiplication is meaningless and returns `UNIT_MISMATCH`.
 */
export function notionalBounds(
  quantity: Amount,
  price: Price,
  targetUnit: UnitCode,
  targetDecimals: number,
): Result<NotionalBounds, ReasonCodeName> {
  if (price.denominatorUnit !== quantity.unit) return err('UNIT_MISMATCH');
  if (price.numeratorUnit !== targetUnit) return err('UNIT_MISMATCH');
  if (targetDecimals < 0 || targetDecimals > MAX_DECIMALS) return err('VALUE_OUT_OF_RANGE');

  // value = (qAtoms / 10^qd) * (pAtoms / 10^pd), rendered at 10^td:
  //   numerator   = qAtoms * pAtoms * 10^td
  //   denominator = 10^(qd + pd)
  const numerator = quantity.atoms * price.atoms * pow10(targetDecimals);
  const denominator = pow10(quantity.decimals + price.decimals);
  const floorAtoms = numerator / denominator;
  const ceilAtoms = numerator % denominator === 0n ? floorAtoms : floorAtoms + 1n;
  if (ceilAtoms > UINT256_MAX) return err('VALUE_OUT_OF_RANGE');
  return ok({ floorAtoms, ceilAtoms });
}

export const BPS_SCALE = 10_000n;

/**
 * `|execution - reference| / reference` in basis points, **rounded up**.
 *
 * Rounding up means a deviation is never reported as smaller than it is, so a
 * candidate sitting a fraction of a basis point outside the mandate's bound is
 * rejected rather than admitted by a favourable rounding.
 *
 * A non-positive reference price is `MARKET_STATE_UNKNOWN`: there is no
 * defensible deviation from a zero or negative reference, and computing one
 * anyway would be inventing a number.
 */
export function deviationBps(execution: Price, reference: Price): Result<bigint, ReasonCodeName> {
  if (execution.numeratorUnit !== reference.numeratorUnit) return err('UNIT_MISMATCH');
  if (execution.denominatorUnit !== reference.denominatorUnit) return err('UNIT_MISMATCH');
  if (reference.atoms <= 0n) return err('MARKET_STATE_UNKNOWN');

  // Cross-multiply to a common scale so differing `decimals` never forces a rescale.
  const e = execution.atoms * pow10(reference.decimals);
  const r = reference.atoms * pow10(execution.decimals);
  const diff = e > r ? e - r : r - e;
  const numerator = diff * BPS_SCALE;
  const quotient = numerator / r;
  return ok(numerator % r === 0n ? quotient : quotient + 1n);
}
