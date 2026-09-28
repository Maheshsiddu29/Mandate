/**
 * Typed economic quantities (action-state-model.md §3).
 *
 * There is no Core bare amount. Every economic value is an `EconomicQuantity`
 * of an explicit kind, in an explicit unit, at an explicit number of decimals,
 * with the asset and the valuation its kind requires. The kind is a type
 * parameter as well as a runtime field, so
 *
 *     addQuantities(capital, margin)
 *
 * does not compile, and a JavaScript caller that bypasses the type system is
 * refused at run time with `QUANTITY_KIND_MISMATCH` (UNIT-1: the brand catches
 * the mistake early, the runtime check is the boundary).
 *
 * All arithmetic is exact `bigint` arithmetic on atoms. There is no implicit
 * rescale and no rounding: two quantities at different decimals are refused
 * until the caller rescales one explicitly, and a rescale that would lose
 * precision is refused rather than rounded. Rounding against the actor
 * (UNIT-4) belongs to the rules that compute contributions, in later phases.
 *
 * What is deliberately absent: any conversion between kinds (UNIT-2) or
 * between units (UNIT-3). Those are named domain rules and declared
 * valuations, not arithmetic.
 */

import { ok, type ByteWriter } from '@mandate/kernel';
import type { Tagged } from './brand.ts';
import { at, fail, type CoreResult } from './errors.ts';
import {
  ASSET_KINDS,
  readResourceIdInput,
  resourceIdInputOf,
  validateResourceId,
  writeResourceId,
  type ActionId,
  type AssetId,
  type ObservationId,
  type QuantityDigest,
  type ResourceIdInput,
  type StateId,
} from './identifiers.ts';
import {
  INT256_MAX,
  INT256_MIN,
  UINT256_MAX,
  checkFields,
  parseDigest,
  parseEnum,
  parseInteger,
  parseSmallUint,
  parseUnixSeconds,
  type IntegerInput,
} from './primitives.ts';
import {
  CoreTag,
  bytesEqual,
  decodeTagged,
  encodeWith,
  keccakDigest,
  readCode,
  readNullable,
  taggedWriter,
  writeCode,
  writeDigest,
  writeI256,
  writeNullable,
  type CoreReader,
  type WireCodes,
} from './encoding.ts';
import { MAX_DECIMALS } from './limits.ts';

// --- Units -----------------------------------------------------------------------

/**
 * A canonical unit code: `USD`, `USDG`, `BTC`, `SHARE`, `CONTRACT`, `COUNT`.
 *
 * Uppercase only, 1–32 characters of `A-Z 0-9 . _ -`, starting and ending
 * with a letter or digit. Case variants are refused rather than folded, so
 * `usd` and `USD` can never both be accepted and then disagree about whether
 * they are the same unit. Core knows no unit's meaning: any code of this shape
 * is valid, and which asset or numeraire a code stands for is registry data.
 */
export type UnitCode = Tagged<string, 'UnitCode'>;

const UNIT_CODE = /^[A-Z0-9](?:[A-Z0-9._-]{0,30}[A-Z0-9])?$/;

/** The unit of the `COUNT` kind, and only of it. */
export const COUNT_UNIT = 'COUNT';

export function parseUnitCode(raw: string, path: string): CoreResult<UnitCode> {
  if (typeof raw !== 'string') return fail('WRONG_TYPE', path);
  return UNIT_CODE.test(raw) ? ok(raw as UnitCode) : fail('MALFORMED_UNIT', path);
}

export function parseDecimals(raw: number, path: string): CoreResult<number> {
  const d = parseSmallUint(raw, Number.MAX_SAFE_INTEGER, path);
  if (!d.ok) return d;
  return d.value > MAX_DECIMALS ? fail('INVALID_DECIMALS', path) : d;
}

// --- Kinds -----------------------------------------------------------------------

export const QuantityKind = {
  TOKEN_AMOUNT: 'TOKEN_AMOUNT',
  CAPITAL: 'CAPITAL',
  POSITION_SIZE: 'POSITION_SIZE',
  /** Committed notional: quantity × the execution (or, while pending, limit) price. */
  NOTIONAL: 'NOTIONAL',
  /** Marked gross exposure. Invariant only; never a ledger counter. */
  GROSS_EXPOSURE: 'GROSS_EXPOSURE',
  /** Marked net exposure. Invariant only; never a ledger counter. */
  NET_EXPOSURE: 'NET_EXPOSURE',
  MARGIN: 'MARGIN',
  COLLATERAL: 'COLLATERAL',
  DEBT: 'DEBT',
  PNL: 'PNL',
  COUNT: 'COUNT',
} as const;
export type QuantityKind = (typeof QuantityKind)[keyof typeof QuantityKind];
export const QUANTITY_KINDS: readonly QuantityKind[] = Object.values(QuantityKind);

export const ValuationBasis = { EXECUTION: 'EXECUTION', LIMIT: 'LIMIT', MARK: 'MARK' } as const;
export type ValuationBasis = (typeof ValuationBasis)[keyof typeof ValuationBasis];
const VALUATION_BASES: readonly ValuationBasis[] = Object.values(ValuationBasis);

/** Which asset a kind requires (action-state-model.md §3.2, `asset` column). */
export const AssetRequirement = {
  /** A token representation: what was transferred. */
  REPRESENTATION: 'REPRESENTATION',
  /** A canonical exposure asset, which is registry data and never a token (INV-6). */
  CANONICAL: 'CANONICAL',
  /** A canonical exposure asset, or none (gross exposure across assets). */
  OPTIONAL_CANONICAL: 'OPTIONAL_CANONICAL',
  /** Either form: funding, collateral or borrowed asset. */
  ANY: 'ANY',
  NONE: 'NONE',
} as const;
export type AssetRequirement = (typeof AssetRequirement)[keyof typeof AssetRequirement];

export interface QuantityKindRule {
  readonly signed: boolean;
  readonly asset: AssetRequirement;
  /** Bases a valuation may have. Empty: the kind is never valued. */
  readonly valuationBases: readonly ValuationBasis[];
  readonly valuationRequired: boolean;
  /** Whether the kind may be a ledger dimension (decision 10: floating values are not counters). */
  readonly ledgerTrackable: boolean;
}

/** action-state-model.md §3.2, row by row. */
export const QUANTITY_KIND_RULES: { readonly [K in QuantityKind]: QuantityKindRule } = {
  TOKEN_AMOUNT: { signed: false, asset: 'REPRESENTATION', valuationBases: [], valuationRequired: false, ledgerTrackable: true },
  CAPITAL: { signed: false, asset: 'ANY', valuationBases: [], valuationRequired: false, ledgerTrackable: true },
  POSITION_SIZE: { signed: true, asset: 'CANONICAL', valuationBases: [], valuationRequired: false, ledgerTrackable: true },
  NOTIONAL: { signed: false, asset: 'CANONICAL', valuationBases: ['EXECUTION', 'LIMIT'], valuationRequired: true, ledgerTrackable: true },
  GROSS_EXPOSURE: { signed: false, asset: 'OPTIONAL_CANONICAL', valuationBases: ['MARK'], valuationRequired: true, ledgerTrackable: false },
  NET_EXPOSURE: { signed: true, asset: 'CANONICAL', valuationBases: ['MARK'], valuationRequired: true, ledgerTrackable: false },
  MARGIN: { signed: false, asset: 'ANY', valuationBases: [], valuationRequired: false, ledgerTrackable: true },
  COLLATERAL: { signed: false, asset: 'ANY', valuationBases: [], valuationRequired: false, ledgerTrackable: true },
  DEBT: { signed: false, asset: 'ANY', valuationBases: [], valuationRequired: false, ledgerTrackable: true },
  /** Realized PnL is unvalued; unrealized PnL is valued at a mark. Only realized PnL is ledger-trackable. */
  PNL: { signed: true, asset: 'NONE', valuationBases: ['MARK'], valuationRequired: false, ledgerTrackable: true },
  COUNT: { signed: false, asset: 'NONE', valuationBases: [], valuationRequired: false, ledgerTrackable: true },
};

const QUANTITY_KIND_CODE: WireCodes<QuantityKind> = {
  TOKEN_AMOUNT: 1,
  CAPITAL: 2,
  POSITION_SIZE: 3,
  NOTIONAL: 4,
  GROSS_EXPOSURE: 5,
  NET_EXPOSURE: 6,
  MARGIN: 7,
  COLLATERAL: 8,
  DEBT: 9,
  PNL: 10,
  COUNT: 11,
};
const VALUATION_BASIS_CODE: WireCodes<ValuationBasis> = { EXECUTION: 1, LIMIT: 2, MARK: 3 };

export function parseQuantityKind(raw: string, path: string): CoreResult<QuantityKind> {
  return parseEnum(raw, QUANTITY_KINDS, path);
}

export function writeQuantityKind(w: ByteWriter, kind: QuantityKind): void {
  writeCode(w, QUANTITY_KIND_CODE, kind);
}

export function readQuantityKind(r: CoreReader): QuantityKind {
  return readCode(r, QUANTITY_KIND_CODE);
}

function atomsInRange(signed: boolean, atoms: bigint): boolean {
  return signed ? atoms >= INT256_MIN && atoms <= INT256_MAX : atoms >= 0n && atoms <= UINT256_MAX;
}

// --- Price and valuation ---------------------------------------------------------

export interface PriceInput {
  readonly numeratorUnit: string;
  readonly denominatorUnit: string;
  readonly decimals: number;
  readonly atoms: IntegerInput;
}

/** The kernel's `Price` shape: `numeratorUnit` per `denominatorUnit`, scaled by `10^decimals`, exact. */
export type Price = Tagged<
  { readonly numeratorUnit: UnitCode; readonly denominatorUnit: UnitCode; readonly decimals: number; readonly atoms: bigint },
  'Price'
>;

export function validatePrice(input: PriceInput, path: string): CoreResult<Price> {
  const shape = checkFields(input, ['numeratorUnit', 'denominatorUnit', 'decimals', 'atoms'], path);
  if (!shape.ok) return shape;
  const numeratorUnit = parseUnitCode(input.numeratorUnit, at(path, 'numeratorUnit'));
  if (!numeratorUnit.ok) return numeratorUnit;
  const denominatorUnit = parseUnitCode(input.denominatorUnit, at(path, 'denominatorUnit'));
  if (!denominatorUnit.ok) return denominatorUnit;
  const decimals = parseDecimals(input.decimals, at(path, 'decimals'));
  if (!decimals.ok) return decimals;
  const atoms = parseInteger(input.atoms, at(path, 'atoms'));
  if (!atoms.ok) return atoms;
  if (!atomsInRange(false, atoms.value)) return fail('QUANTITY_OUT_OF_RANGE', at(path, 'atoms'));
  return ok({
    numeratorUnit: numeratorUnit.value,
    denominatorUnit: denominatorUnit.value,
    decimals: decimals.value,
    atoms: atoms.value,
  } as Price);
}

/**
 * Where a valuation's price came from. The specification names a
 * `StateDigest` or an `ObservationId`. `ACTION` is added for the `LIMIT` basis:
 * a worst case valued at an order's own limit price takes that price from the
 * action, which is neither a snapshot nor a fill (ADR 0020).
 */
export type PriceSourceInput =
  | { readonly kind: 'STATE'; readonly stateId: string }
  | { readonly kind: 'OBSERVATION'; readonly observationId: string }
  | { readonly kind: 'ACTION'; readonly actionId: string };

export type PriceSource =
  | { readonly kind: 'STATE'; readonly stateId: StateId }
  | { readonly kind: 'OBSERVATION'; readonly observationId: ObservationId }
  | { readonly kind: 'ACTION'; readonly actionId: ActionId };

const PRICE_SOURCE_CODE: WireCodes<PriceSource['kind']> = { STATE: 1, OBSERVATION: 2, ACTION: 3 };

/**
 * The only source each basis can have. An execution price is a fill's, so it
 * comes from an observation; a limit price is the order's, from its action; a
 * mark is an admitted snapshot's. Without this, a mark read from a snapshot
 * could be labelled `EXECUTION` and pass as committed notional.
 */
const SOURCE_FOR_BASIS: { readonly [B in ValuationBasis]: PriceSource['kind'] } = {
  EXECUTION: 'OBSERVATION',
  LIMIT: 'ACTION',
  MARK: 'STATE',
};
const PRICE_SOURCE_KINDS: readonly PriceSource['kind'][] = ['STATE', 'OBSERVATION', 'ACTION'];

function validatePriceSource(input: PriceSourceInput, path: string): CoreResult<PriceSource> {
  const kind = parseEnum(input.kind, PRICE_SOURCE_KINDS, at(path, 'kind'));
  if (!kind.ok) return kind;
  switch (input.kind) {
    case 'STATE': {
      const shape = checkFields(input, ['kind', 'stateId'], path);
      if (!shape.ok) return shape;
      const id = parseDigest<StateId>(input.stateId, at(path, 'stateId'));
      return id.ok ? ok({ kind: 'STATE', stateId: id.value }) : id;
    }
    case 'OBSERVATION': {
      const shape = checkFields(input, ['kind', 'observationId'], path);
      if (!shape.ok) return shape;
      const id = parseDigest<ObservationId>(input.observationId, at(path, 'observationId'));
      return id.ok ? ok({ kind: 'OBSERVATION', observationId: id.value }) : id;
    }
    case 'ACTION': {
      const shape = checkFields(input, ['kind', 'actionId'], path);
      if (!shape.ok) return shape;
      const id = parseDigest<ActionId>(input.actionId, at(path, 'actionId'));
      return id.ok ? ok({ kind: 'ACTION', actionId: id.value }) : id;
    }
  }
}

export interface ValuationRefInput {
  readonly price: PriceInput;
  readonly basis: ValuationBasis;
  readonly source: PriceSourceInput;
  readonly observedAt: IntegerInput;
}

export type ValuationRef = Tagged<
  { readonly price: Price; readonly basis: ValuationBasis; readonly source: PriceSource; readonly observedAt: bigint },
  'ValuationRef'
>;

function validateValuationRef(input: ValuationRefInput, path: string): CoreResult<ValuationRef> {
  const shape = checkFields(input, ['price', 'basis', 'source', 'observedAt'], path);
  if (!shape.ok) return shape;
  const price = validatePrice(input.price, at(path, 'price'));
  if (!price.ok) return price;
  const basis = parseEnum(input.basis, VALUATION_BASES, at(path, 'basis'));
  if (!basis.ok) return basis;
  const source = validatePriceSource(input.source, at(path, 'source'));
  if (!source.ok) return source;
  if (source.value.kind !== SOURCE_FOR_BASIS[basis.value]) return fail('VALUATION_SOURCE_INVALID', at(path, 'source.kind'));
  const observedAt = parseUnixSeconds(input.observedAt, at(path, 'observedAt'));
  if (!observedAt.ok) return observedAt;
  return ok({ price: price.value, basis: basis.value, source: source.value, observedAt: observedAt.value } as ValuationRef);
}

function writePrice(w: ByteWriter, p: Price): void {
  w.str(p.numeratorUnit).str(p.denominatorUnit).u8(p.decimals).u256(p.atoms);
}

function readPriceInput(r: CoreReader): PriceInput {
  const numeratorUnit = r.str();
  const denominatorUnit = r.str();
  const decimals = r.u8();
  const atoms = r.u256();
  return { numeratorUnit, denominatorUnit, decimals, atoms };
}

function writeValuation(w: ByteWriter, v: ValuationRef): void {
  writePrice(w, v.price);
  writeCode(w, VALUATION_BASIS_CODE, v.basis);
  writeCode(w, PRICE_SOURCE_CODE, v.source.kind);
  switch (v.source.kind) {
    case 'STATE':
      writeDigest(w, v.source.stateId);
      break;
    case 'OBSERVATION':
      writeDigest(w, v.source.observationId);
      break;
    case 'ACTION':
      writeDigest(w, v.source.actionId);
      break;
  }
  w.i64(v.observedAt);
}

function readValuationInput(r: CoreReader): ValuationRefInput {
  const price = readPriceInput(r);
  const basis = readCode(r, VALUATION_BASIS_CODE);
  const sourceKind = readCode(r, PRICE_SOURCE_CODE);
  const digest = r.digest();
  const source: PriceSourceInput =
    sourceKind === 'STATE'
      ? { kind: 'STATE', stateId: digest }
      : sourceKind === 'OBSERVATION'
        ? { kind: 'OBSERVATION', observationId: digest }
        : { kind: 'ACTION', actionId: digest };
  const observedAt = r.i64();
  return { price, basis, source, observedAt };
}

function valuationInputOf(v: ValuationRef): ValuationRefInput {
  const s = v.source;
  const source: PriceSourceInput =
    s.kind === 'STATE'
      ? { kind: 'STATE', stateId: s.stateId }
      : s.kind === 'OBSERVATION'
        ? { kind: 'OBSERVATION', observationId: s.observationId }
        : { kind: 'ACTION', actionId: s.actionId };
  return {
    price: { numeratorUnit: v.price.numeratorUnit, denominatorUnit: v.price.denominatorUnit, decimals: v.price.decimals, atoms: v.price.atoms },
    basis: v.basis,
    source,
    observedAt: v.observedAt,
  };
}

// --- EconomicQuantity -----------------------------------------------------------

export interface EconomicQuantityInput<K extends QuantityKind = QuantityKind> {
  readonly kind: K;
  readonly unit: string;
  readonly decimals: number;
  readonly atoms: IntegerInput;
  readonly asset: ResourceIdInput | null;
  readonly valuation: ValuationRefInput | null;
}

export type EconomicQuantity<K extends QuantityKind = QuantityKind> = Tagged<
  {
    readonly kind: K;
    readonly unit: UnitCode;
    readonly decimals: number;
    /** The value scaled by `10^decimals`. Signed only for signed kinds. */
    readonly atoms: bigint;
    readonly asset: AssetId | null;
    readonly valuation: ValuationRef | null;
  },
  'EconomicQuantity'
>;

export type TokenAmount = EconomicQuantity<'TOKEN_AMOUNT'>;
export type Capital = EconomicQuantity<'CAPITAL'>;
export type PositionSize = EconomicQuantity<'POSITION_SIZE'>;
/** Committed notional: the ledger-trackable exposure measure. */
export type CommittedNotional = EconomicQuantity<'NOTIONAL'>;
export type GrossExposure = EconomicQuantity<'GROSS_EXPOSURE'>;
export type NetExposure = EconomicQuantity<'NET_EXPOSURE'>;
/** Marked exposure: an invariant value at a stated mark, never a ledger counter. */
export type MarkedExposure = GrossExposure | NetExposure;
export type Margin = EconomicQuantity<'MARGIN'>;
export type Collateral = EconomicQuantity<'COLLATERAL'>;
export type Debt = EconomicQuantity<'DEBT'>;
export type PnL = EconomicQuantity<'PNL'>;
export type ActionCount = EconomicQuantity<'COUNT'>;

export function validateQuantity(input: EconomicQuantityInput, path = 'quantity'): CoreResult<EconomicQuantity> {
  const shape = checkFields(input, ['kind', 'unit', 'decimals', 'atoms', 'asset', 'valuation'], path);
  if (!shape.ok) return shape;
  const kind = parseQuantityKind(input.kind, at(path, 'kind'));
  if (!kind.ok) return kind;
  const rule = QUANTITY_KIND_RULES[kind.value];
  const unit = parseUnitCode(input.unit, at(path, 'unit'));
  if (!unit.ok) return unit;
  if ((kind.value === 'COUNT') !== (unit.value === COUNT_UNIT)) return fail('COUNT_UNIT_REQUIRED', at(path, 'unit'));
  const decimals = parseDecimals(input.decimals, at(path, 'decimals'));
  if (!decimals.ok) return decimals;
  const atoms = parseInteger(input.atoms, at(path, 'atoms'));
  if (!atoms.ok) return atoms;
  if (!rule.signed && atoms.value < 0n) return fail('QUANTITY_NEGATIVE_UNSIGNED', at(path, 'atoms'));
  if (!atomsInRange(rule.signed, atoms.value)) return fail('QUANTITY_OUT_OF_RANGE', at(path, 'atoms'));

  let asset: AssetId | null = null;
  if (input.asset === null) {
    if (rule.asset !== 'NONE' && rule.asset !== 'OPTIONAL_CANONICAL') return fail('ASSET_REQUIRED', at(path, 'asset'));
  } else {
    if (rule.asset === 'NONE') return fail('ASSET_FORBIDDEN', at(path, 'asset'));
    const parsed = validateResourceId(input.asset, ASSET_KINDS, at(path, 'asset'));
    if (!parsed.ok) return parsed.error.code === 'RESOURCE_KIND_MISMATCH' ? fail('ASSET_FORM_INVALID', parsed.error.path) : parsed;
    const form = parsed.value.kind;
    const wantsCanonical = rule.asset === 'CANONICAL' || rule.asset === 'OPTIONAL_CANONICAL';
    if (wantsCanonical && form !== 'CANONICAL_ASSET') return fail('ASSET_FORM_INVALID', at(path, 'asset'));
    if (rule.asset === 'REPRESENTATION' && form !== 'REPRESENTATION_ASSET') return fail('ASSET_FORM_INVALID', at(path, 'asset'));
    asset = parsed.value;
  }

  let valuation: ValuationRef | null = null;
  if (input.valuation === null) {
    if (rule.valuationRequired) return fail('VALUATION_REQUIRED', at(path, 'valuation'));
  } else {
    if (rule.valuationBases.length === 0) return fail('VALUATION_FORBIDDEN', at(path, 'valuation'));
    const parsed = validateValuationRef(input.valuation, at(path, 'valuation'));
    if (!parsed.ok) return parsed;
    if (!rule.valuationBases.includes(parsed.value.basis)) return fail('VALUATION_BASIS_INVALID', at(path, 'valuation.basis'));
    // The value is denominated in the price's numerator: a USD notional needs a USD-per-something price.
    if (parsed.value.price.numeratorUnit !== unit.value) return fail('VALUATION_UNIT_MISMATCH', at(path, 'valuation.price.numeratorUnit'));
    valuation = parsed.value;
  }

  return ok({ kind: kind.value, unit: unit.value, decimals: decimals.value, atoms: atoms.value, asset, valuation } as EconomicQuantity);
}

/** Validate and require a specific kind, returning the precisely typed quantity. */
export function validateQuantityOf<K extends QuantityKind>(
  kind: K,
  input: EconomicQuantityInput,
  path = 'quantity',
): CoreResult<EconomicQuantity<K>> {
  const q = validateQuantity(input, path);
  if (!q.ok) return q;
  if (q.value.kind !== kind) return fail('QUANTITY_KIND_MISMATCH', at(path, 'kind'));
  return ok(q.value as EconomicQuantity<K>);
}

export function writeQuantityBody(w: ByteWriter, q: EconomicQuantity): void {
  writeCode(w, QUANTITY_KIND_CODE, q.kind);
  w.str(q.unit).u8(q.decimals);
  if (QUANTITY_KIND_RULES[q.kind].signed) writeI256(w, q.atoms);
  else w.u256(q.atoms);
  writeNullable(w, q.asset, writeResourceId);
  writeNullable(w, q.valuation, writeValuation);
}

export function readQuantityInput(r: CoreReader): EconomicQuantityInput {
  const kind = readCode(r, QUANTITY_KIND_CODE);
  const unit = r.str();
  const decimals = r.u8();
  const atoms = QUANTITY_KIND_RULES[kind].signed ? r.i256() : r.u256();
  const asset = readNullable(r, readResourceIdInput);
  const valuation = readNullable(r, readValuationInput);
  return { kind, unit, decimals, atoms, asset, valuation };
}

export function quantityInputOf(q: EconomicQuantity): EconomicQuantityInput {
  return {
    kind: q.kind,
    unit: q.unit,
    decimals: q.decimals,
    atoms: q.atoms,
    asset: q.asset === null ? null : resourceIdInputOf(q.asset),
    valuation: q.valuation === null ? null : valuationInputOf(q.valuation),
  };
}

export function encodeQuantity(q: EconomicQuantity): Uint8Array {
  const w = taggedWriter(CoreTag.QUANTITY);
  writeQuantityBody(w, q);
  return w.finish();
}

export function decodeQuantity(bytes: Uint8Array): CoreResult<EconomicQuantity> {
  return decodeTagged(bytes, CoreTag.QUANTITY, readQuantityInput, (input) => validateQuantity(input));
}

export function quantityDigest(q: EconomicQuantity): QuantityDigest {
  return keccakDigest<QuantityDigest>(encodeQuantity(q));
}

// --- Compatibility ---------------------------------------------------------------

export const QuantityMismatch = {
  KIND: 'KIND',
  UNIT: 'UNIT',
  ASSET: 'ASSET',
  DECIMALS: 'DECIMALS',
  VALUATION: 'VALUATION',
} as const;
export type QuantityMismatch = (typeof QuantityMismatch)[keyof typeof QuantityMismatch];

function assetsEqual(a: AssetId | null, b: AssetId | null): boolean {
  if (a === null || b === null) return a === b;
  return a.domain === b.domain && a.kind === b.kind && a.localId === b.localId;
}

function valuationsEqual(a: ValuationRef | null, b: ValuationRef | null): boolean {
  if (a === null || b === null) return a === b;
  return bytesEqual(encodeWith(writeValuation, a), encodeWith(writeValuation, b));
}

/**
 * Every way two quantities differ in what they measure. Empty means same
 * kind, unit, asset, decimals and valuation context: the only case in which
 * Core arithmetic accepts them together.
 *
 * `DECIMALS` alone is resolvable by an explicit exact rescale. `KIND`, `UNIT`
 * and `ASSET` are never resolvable by arithmetic (UNIT-1). `VALUATION` means
 * the two values were priced differently — two marks, or two execution prices
 * — and summing them would produce a number valued at no single price.
 */
export function quantityMismatches(a: EconomicQuantity, b: EconomicQuantity): readonly QuantityMismatch[] {
  const out: QuantityMismatch[] = [];
  if (a.kind !== b.kind) out.push('KIND');
  if (a.unit !== b.unit) out.push('UNIT');
  if (!assetsEqual(a.asset, b.asset)) out.push('ASSET');
  if (a.decimals !== b.decimals) out.push('DECIMALS');
  if (!valuationsEqual(a.valuation, b.valuation)) out.push('VALUATION');
  return out;
}

const MISMATCH_CODE = {
  KIND: 'QUANTITY_KIND_MISMATCH',
  UNIT: 'QUANTITY_UNIT_MISMATCH',
  ASSET: 'QUANTITY_ASSET_MISMATCH',
  DECIMALS: 'QUANTITY_DECIMALS_MISMATCH',
  VALUATION: 'QUANTITY_VALUATION_MISMATCH',
} as const;

function requireCompatible(a: EconomicQuantity, b: EconomicQuantity): CoreResult<true> {
  const first = quantityMismatches(a, b)[0];
  return first === undefined ? ok(true) : fail(MISMATCH_CODE[first], 'quantity');
}

function withAtoms<K extends QuantityKind>(q: EconomicQuantity<K>, atoms: bigint, decimals: number): CoreResult<EconomicQuantity<K>> {
  const rule = QUANTITY_KIND_RULES[q.kind];
  if (!rule.signed && atoms < 0n) return fail('QUANTITY_NEGATIVE_UNSIGNED', 'quantity.atoms');
  if (!atomsInRange(rule.signed, atoms)) return fail('QUANTITY_OUT_OF_RANGE', 'quantity.atoms');
  return ok({ kind: q.kind, unit: q.unit, decimals, atoms, asset: q.asset, valuation: q.valuation } as EconomicQuantity<K>);
}

/**
 * `a + b`. `NoInfer` pins the kind to `a`'s, so `addQuantities(capital, margin)`
 * is a compile error rather than an inference of `'CAPITAL' | 'MARGIN'`.
 */
export function addQuantities<K extends QuantityKind>(
  a: EconomicQuantity<K>,
  b: EconomicQuantity<NoInfer<K>>,
): CoreResult<EconomicQuantity<K>> {
  const compatible = requireCompatible(a, b);
  if (!compatible.ok) return compatible;
  return withAtoms(a, a.atoms + b.atoms, a.decimals);
}

/** `a − b`. An unsigned result below zero is refused, never wrapped or saturated (UNIT-5). */
export function subtractQuantities<K extends QuantityKind>(
  a: EconomicQuantity<K>,
  b: EconomicQuantity<NoInfer<K>>,
): CoreResult<EconomicQuantity<K>> {
  const compatible = requireCompatible(a, b);
  if (!compatible.ok) return compatible;
  return withAtoms(a, a.atoms - b.atoms, a.decimals);
}

export function compareQuantities<K extends QuantityKind>(
  a: EconomicQuantity<K>,
  b: EconomicQuantity<NoInfer<K>>,
): CoreResult<-1 | 0 | 1> {
  const compatible = requireCompatible(a, b);
  if (!compatible.ok) return compatible;
  return ok(a.atoms < b.atoms ? -1 : a.atoms > b.atoms ? 1 : 0);
}

/**
 * Explicit, exact change of scale. Raising decimals multiplies by a power of
 * ten and is always exact; lowering them is accepted only when no non-zero
 * digit is dropped. There is no rounding mode, because there is no rounding.
 */
export function rescaleQuantity<K extends QuantityKind>(q: EconomicQuantity<K>, decimals: number): CoreResult<EconomicQuantity<K>> {
  const d = parseDecimals(decimals, 'decimals');
  if (!d.ok) return d;
  if (d.value >= q.decimals) return withAtoms(q, q.atoms * 10n ** BigInt(d.value - q.decimals), d.value);
  const divisor = 10n ** BigInt(q.decimals - d.value);
  if (q.atoms % divisor !== 0n) return fail('INEXACT_RESCALE', 'decimals');
  return withAtoms(q, q.atoms / divisor, d.value);
}

// --- Bounds (limits) -------------------------------------------------------------

export interface QuantityBoundInput {
  readonly kind: QuantityKind;
  readonly unit: string;
  readonly decimals: number;
  readonly atoms: IntegerInput;
}

/**
 * A limit on a measure: kind, unit, decimals and a non-negative magnitude,
 * with no asset and no valuation.
 *
 * A limit is not an observation, so it carries no price. A committed-notional
 * limit of 5,000.00 USD holds for notional committed at many execution prices,
 * and could not satisfy the rule that a `NOTIONAL` quantity carries exactly
 * one valuation. Asset scoping of a limit is the dimension's `scope`, not a
 * field of the limit (ADR 0020).
 */
export type QuantityBound<K extends QuantityKind = QuantityKind> = Tagged<
  { readonly kind: K; readonly unit: UnitCode; readonly decimals: number; readonly atoms: bigint },
  'QuantityBound'
>;

export function validateQuantityBound(input: QuantityBoundInput, path: string): CoreResult<QuantityBound> {
  const shape = checkFields(input, ['kind', 'unit', 'decimals', 'atoms'], path);
  if (!shape.ok) return shape;
  const kind = parseQuantityKind(input.kind, at(path, 'kind'));
  if (!kind.ok) return kind;
  const unit = parseUnitCode(input.unit, at(path, 'unit'));
  if (!unit.ok) return unit;
  if ((kind.value === 'COUNT') !== (unit.value === COUNT_UNIT)) return fail('COUNT_UNIT_REQUIRED', at(path, 'unit'));
  const decimals = parseDecimals(input.decimals, at(path, 'decimals'));
  if (!decimals.ok) return decimals;
  const atoms = parseInteger(input.atoms, at(path, 'atoms'));
  if (!atoms.ok) return atoms;
  if (atoms.value < 0n) return fail('QUANTITY_NEGATIVE_UNSIGNED', at(path, 'atoms'));
  if (atoms.value > UINT256_MAX) return fail('QUANTITY_OUT_OF_RANGE', at(path, 'atoms'));
  return ok({ kind: kind.value, unit: unit.value, decimals: decimals.value, atoms: atoms.value } as QuantityBound);
}

export function writeQuantityBound(w: ByteWriter, b: QuantityBound): void {
  writeCode(w, QUANTITY_KIND_CODE, b.kind);
  w.str(b.unit).u8(b.decimals).u256(b.atoms);
}

export function readQuantityBoundInput(r: CoreReader): QuantityBoundInput {
  const kind = readCode(r, QUANTITY_KIND_CODE);
  const unit = r.str();
  const decimals = r.u8();
  const atoms = r.u256();
  return { kind, unit, decimals, atoms };
}

export function quantityBoundInputOf(b: QuantityBound): QuantityBoundInput {
  return { kind: b.kind, unit: b.unit, decimals: b.decimals, atoms: b.atoms };
}

// --- Ratio -----------------------------------------------------------------------

export interface RatioInput {
  readonly numerator: IntegerInput;
  readonly scale: number;
}

/**
 * An exact non-negative ratio `numerator / 10^scale`: leverage multiples,
 * basis points, health factors, probabilities. Not an economic quantity and
 * not addable to one (action-state-model.md §3.1): `3x` is `{3, 0}`, 50 bps is
 * `{50, 4}`. As with decimals, the scale is part of the value's identity.
 */
export type Ratio = Tagged<{ readonly numerator: bigint; readonly scale: number }, 'Ratio'>;

export function validateRatio(input: RatioInput, path: string): CoreResult<Ratio> {
  const shape = checkFields(input, ['numerator', 'scale'], path);
  if (!shape.ok) return shape;
  const numerator = parseInteger(input.numerator, at(path, 'numerator'));
  if (!numerator.ok) return numerator;
  if (numerator.value < 0n || numerator.value > UINT256_MAX) return fail('INTEGER_OUT_OF_RANGE', at(path, 'numerator'));
  const scale = parseDecimals(input.scale, at(path, 'scale'));
  if (!scale.ok) return scale;
  return ok({ numerator: numerator.value, scale: scale.value } as Ratio);
}

export function writeRatio(w: ByteWriter, r: Ratio): void {
  w.u256(r.numerator).u8(r.scale);
}

export function readRatioInput(r: CoreReader): RatioInput {
  const numerator = r.u256();
  const scale = r.u8();
  return { numerator, scale };
}

/** Exact comparison by cross-multiplication; no rescale, no rounding. */
export function compareRatios(a: Ratio, b: Ratio): -1 | 0 | 1 {
  const left = a.numerator * 10n ** BigInt(b.scale);
  const right = b.numerator * 10n ** BigInt(a.scale);
  return left < right ? -1 : left > right ? 1 : 0;
}

// --- Human-readable fixed-point text --------------------------------------------

/**
 * Parse `"1234.56"` at 2 decimals into `123456n`. Canonical only: exactly
 * `decimals` fractional digits (none when `decimals` is 0), no leading zeros,
 * no sign on zero, no exponent. `"1234.5"` and `"1234.560"` are both refused at
 * 2 decimals, because a scale is part of the value's identity.
 */
export function parseFixedDecimal(text: string, decimals: number, path: string): CoreResult<bigint> {
  const d = parseDecimals(decimals, path);
  if (!d.ok) return d;
  if (typeof text !== 'string' || text.length > 120) return fail('NON_CANONICAL_DECIMAL', path);
  const pattern = d.value === 0 ? /^-?(?:0|[1-9][0-9]*)$/ : new RegExp(`^-?(?:0|[1-9][0-9]*)\\.[0-9]{${d.value}}$`);
  if (!pattern.test(text)) return fail('NON_CANONICAL_DECIMAL', path);
  const atoms = BigInt(text.replace('.', ''));
  if (atoms === 0n && text.startsWith('-')) return fail('NON_CANONICAL_DECIMAL', path);
  return ok(atoms);
}

export function formatFixedDecimal(atoms: bigint, decimals: number): string {
  const negative = atoms < 0n;
  const digits = (negative ? -atoms : atoms).toString().padStart(decimals + 1, '0');
  const text = decimals === 0 ? digits : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
  return negative ? `-${text}` : text;
}
