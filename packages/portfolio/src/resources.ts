/**
 * Resources (portfolio-mandate.md §3).
 *
 * A resource is a declared, typed quantity the portfolio accounts for: a
 * Core quantity kind, a unit, decimals and an optional domain scope. Every
 * amount in this package is `(resource, atoms)` and takes its measure from
 * the declaration, so an amount cannot exist without a unit.
 *
 * **Only the same resource combines.** There is no conversion and no
 * normalization: spot `CAPITAL` and perp `MARGIN`, both in USDC, are two
 * resources, and `NOTIONAL` in USDC and in USD are two resources. A single
 * amount can only be added to an amount of the same resource
 * (`RESOURCE_INCOMPARABLE` otherwise), and a vector is keyed by resource, so
 * vector arithmetic never merges two resources either.
 *
 * A resource maps one-to-one onto a Core `LEDGER_DIMENSION`, and a
 * contribution counts toward it by Core's own matching rule — equal kind and
 * unit, and equal domain when the resource names one — rescaled exactly
 * (`demandOf`). That is the only way a domain's quantity reaches a resource.
 */

import { err, ok, type ByteWriter, type Identifier, type Result } from '@mandate/kernel';
import {
  COUNT_UNIT,
  QUANTITY_KIND_RULES,
  UINT256_MAX,
  at,
  canonicalSet,
  checkArray,
  checkFields,
  fail,
  parseDecimals,
  parseEnum,
  parseIdentifierAs,
  parseInteger,
  parseUnitCode,
  readCode,
  readNullable,
  writeCode,
  writeNullable,
  type CoreReader,
  type CoreResult,
  type DomainId,
  type IntegerInput,
  type QuantityKind,
  type Tagged,
  type UnitCode,
  type WireCodes,
} from '@mandate/core';
import { rescaleExact } from '@mandate/ledger';
import { reason, type Reason } from './reasons.ts';

/** The most resources one mandate may declare, and the most entries in one vector. */
export const MAX_RESOURCES = 32;

export type PortfolioResourceId = Tagged<Identifier, 'PortfolioResourceId'>;

/**
 * Ledger-trackable Core kinds a resource may measure. Marked exposure is an
 * invariant, never a counter (decision 10), and realized PnL is signed: both
 * are excluded, because a resource is a capacity the ledger charges.
 */
export const RESOURCE_KINDS = ['TOKEN_AMOUNT', 'CAPITAL', 'POSITION_SIZE', 'NOTIONAL', 'MARGIN', 'COLLATERAL', 'DEBT', 'COUNT'] as const satisfies readonly QuantityKind[];
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
const RESOURCE_KIND_CODE: WireCodes<ResourceKind> = { TOKEN_AMOUNT: 1, CAPITAL: 2, POSITION_SIZE: 3, NOTIONAL: 4, MARGIN: 5, COLLATERAL: 6, DEBT: 7, COUNT: 8 };

export interface ResourceDefinitionInput {
  readonly resource: string;
  readonly kind: string;
  readonly unit: string;
  readonly decimals: number;
  /** `null`: every domain contributes; otherwise only that domain. */
  readonly domain: string | null;
}

export type ResourceDefinition = Tagged<
  { readonly resource: PortfolioResourceId; readonly kind: ResourceKind; readonly unit: UnitCode; readonly decimals: number; readonly domain: DomainId | null },
  'ResourceDefinition'
>;

export interface ResourceAmountInput {
  readonly resource: string;
  readonly atoms: IntegerInput;
}

/** `atoms` at the resource's declared decimals. */
export type ResourceAmount = Tagged<{ readonly resource: PortfolioResourceId; readonly atoms: bigint }, 'ResourceAmount'>;

/** Canonical: ascending by encoded resource id, one entry per resource. */
export type ResourceVector = readonly ResourceAmount[];

// --- Validation ----------------------------------------------------------------------

export function validateResourceDefinition(input: ResourceDefinitionInput, path: string): CoreResult<ResourceDefinition> {
  const shape = checkFields(input, ['resource', 'kind', 'unit', 'decimals', 'domain'], path);
  if (!shape.ok) return shape;
  const resource = parseIdentifierAs<PortfolioResourceId>(input.resource, at(path, 'resource'));
  if (!resource.ok) return resource;
  const kind = parseEnum(input.kind, RESOURCE_KINDS, at(path, 'kind'));
  if (!kind.ok) return kind;
  if (!QUANTITY_KIND_RULES[kind.value].ledgerTrackable) return fail('DIMENSION_KIND_NOT_LEDGER_TRACKABLE', at(path, 'kind'));
  const unit = parseUnitCode(input.unit, at(path, 'unit'));
  if (!unit.ok) return unit;
  if ((kind.value === 'COUNT') !== (unit.value === COUNT_UNIT)) return fail('COUNT_UNIT_REQUIRED', at(path, 'unit'));
  const decimals = parseDecimals(input.decimals, at(path, 'decimals'));
  if (!decimals.ok) return decimals;
  let domain: DomainId | null = null;
  if (input.domain !== null) {
    const d = parseIdentifierAs<DomainId>(input.domain, at(path, 'domain'));
    if (!d.ok) return d;
    domain = d.value;
  }
  return ok({ resource: resource.value, kind: kind.value, unit: unit.value, decimals: decimals.value, domain } as ResourceDefinition);
}

export function writeResourceDefinition(w: ByteWriter, d: ResourceDefinition): void {
  w.str(d.resource);
  writeCode(w, RESOURCE_KIND_CODE, d.kind);
  w.str(d.unit).u8(d.decimals);
  writeNullable(w, d.domain, (x, v) => x.str(v));
}

export function readResourceDefinitionInput(r: CoreReader): ResourceDefinitionInput {
  const resource = r.str();
  const kind = readCode(r, RESOURCE_KIND_CODE);
  const unit = r.str();
  const decimals = r.u8();
  const domain = readNullable(r, (x) => x.str());
  return { resource, kind, unit, decimals, domain };
}

export function resourceDefinitionInputOf(d: ResourceDefinition): ResourceDefinitionInput {
  return { resource: d.resource, kind: d.kind, unit: d.unit, decimals: d.decimals, domain: d.domain };
}

/** Definitions are keyed by resource id alone: two definitions of one id are refused even if they differ in measure. */
export function validateResourceDefinitions(inputs: readonly ResourceDefinitionInput[], path: string): CoreResult<readonly ResourceDefinition[]> {
  const arr = checkArray(inputs, MAX_RESOURCES, path);
  if (!arr.ok) return arr;
  const out: ResourceDefinition[] = [];
  for (let i = 0; i < inputs.length; i += 1) {
    const d = validateResourceDefinition(inputs[i] as ResourceDefinitionInput, at(path, i));
    if (!d.ok) return d;
    out.push(d.value);
  }
  return canonicalSet(out, (w, d) => w.str(d.resource), path);
}

function validateAmount(input: ResourceAmountInput, path: string): CoreResult<ResourceAmount> {
  const shape = checkFields(input, ['resource', 'atoms'], path);
  if (!shape.ok) return shape;
  const resource = parseIdentifierAs<PortfolioResourceId>(input.resource, at(path, 'resource'));
  if (!resource.ok) return resource;
  const atoms = parseInteger(input.atoms, at(path, 'atoms'));
  if (!atoms.ok) return atoms;
  if (atoms.value < 0n) return fail('QUANTITY_NEGATIVE_UNSIGNED', at(path, 'atoms'));
  if (atoms.value > UINT256_MAX) return fail('QUANTITY_OUT_OF_RANGE', at(path, 'atoms'));
  return ok({ resource: resource.value, atoms: atoms.value } as ResourceAmount);
}

/** One entry per resource: a second entry for the same resource is refused, never summed. */
export function validateResourceVector(inputs: readonly ResourceAmountInput[], path: string): CoreResult<ResourceVector> {
  const arr = checkArray(inputs, MAX_RESOURCES, path);
  if (!arr.ok) return arr;
  const out: ResourceAmount[] = [];
  for (let i = 0; i < inputs.length; i += 1) {
    const a = validateAmount(inputs[i] as ResourceAmountInput, at(path, i));
    if (!a.ok) return a;
    out.push(a.value);
  }
  return canonicalSet(out, (w, a) => w.str(a.resource), path);
}

export function writeResourceVector(w: ByteWriter, v: ResourceVector): void {
  w.u16(v.length);
  for (const a of v) w.str(a.resource).u256(a.atoms);
}

export function readResourceVectorInput(r: CoreReader): ResourceAmountInput[] {
  return r.list(MAX_RESOURCES, (x) => ({ resource: x.str(), atoms: x.u256() }), true);
}

export function resourceVectorInputOf(v: ResourceVector): ResourceAmountInput[] {
  return v.map((a) => ({ resource: a.resource, atoms: a.atoms }));
}

// --- The table and exact arithmetic -------------------------------------------------------

export type ResourceTable = ReadonlyMap<string, ResourceDefinition>;

export function resourceTable(defs: readonly ResourceDefinition[]): ResourceTable {
  return new Map(defs.map((d) => [d.resource as string, d]));
}

/** Every resource the vector names that the table does not declare. */
export function undeclared(v: ResourceVector, table: ResourceTable): readonly Reason[] {
  return v.filter((a) => !table.has(a.resource)).map((a) => reason('RESOURCE_UNDECLARED', a.resource));
}

export function amountOf(v: ResourceVector, resource: string): bigint {
  return v.find((a) => a.resource === resource)?.atoms ?? 0n;
}

function vectorOf(entries: ReadonlyMap<string, bigint>): ResourceVector {
  return [...entries.keys()].sort(compareResourceIds).map((resource) => ({ resource, atoms: entries.get(resource) as bigint }) as ResourceAmount);
}

/**
 * Resource ids in canonical order: the order of their `u16`-prefixed
 * encodings — shorter first, then byte order — the same order `canonicalSet`
 * produces, so a computed vector encodes exactly like a validated one.
 */
export function compareResourceIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `a + b`, both amounts of one resource. Two different resources are never
 * added, whatever their kinds and units: a shared limit exists only where a
 * mandate declares one resource.
 */
export function addAmounts(a: ResourceAmount, b: ResourceAmount): Result<ResourceAmount, Reason> {
  if (a.resource !== b.resource) return err(reason('RESOURCE_INCOMPARABLE', `${a.resource}+${b.resource}`));
  return ok({ resource: a.resource, atoms: a.atoms + b.atoms } as ResourceAmount);
}

/** Per-resource sum. Entries for different resources stay different entries. */
export function addVectors(a: ResourceVector, b: ResourceVector): ResourceVector {
  const out = new Map<string, bigint>();
  for (const x of [...a, ...b]) out.set(x.resource, (out.get(x.resource) ?? 0n) + x.atoms);
  return vectorOf(out);
}

/** Per-resource `a − b`, or the first resource where `b` exceeds `a` (never a negative amount). */
export function subtractVectors(a: ResourceVector, b: ResourceVector): Result<ResourceVector, PortfolioResourceId> {
  const out = new Map<string, bigint>(a.map((x) => [x.resource, x.atoms]));
  for (const x of b) {
    const have = out.get(x.resource) ?? 0n;
    if (x.atoms > have) return err(x.resource);
    out.set(x.resource, have - x.atoms);
  }
  return ok(vectorOf(out));
}

export function vectorsEqual(a: ResourceVector, b: ResourceVector): boolean {
  const keys = new Set([...a.map((x) => x.resource as string), ...b.map((x) => x.resource as string)]);
  for (const k of keys) if (amountOf(a, k) !== amountOf(b, k)) return false;
  return true;
}

/**
 * Every resource where `v` exceeds `limits`. Closed world: a resource with no
 * limit entry has limit zero, so an amount in it exceeds. This is the rule for
 * portfolio limits.
 */
export function exceeding(v: ResourceVector, limits: ResourceVector): readonly string[] {
  return v.filter((a) => a.atoms > amountOf(limits, a.resource)).map((a) => a.resource);
}

/**
 * Every resource where `v` exceeds a limit `limits` actually lists. A resource
 * with no entry is not limited *here* — the rule for an agent's hard maxima,
 * which sit under the portfolio's closed-world limits.
 */
export function exceedingListed(v: ResourceVector, limits: ResourceVector): readonly string[] {
  return v.filter((a) => limits.some((l) => l.resource === a.resource && a.atoms > l.atoms)).map((a) => a.resource);
}

// --- Contributions: the only way a domain quantity reaches a resource ----------------------

/** A typed quantity a domain says an action consumes, before it is attributed to resources. */
export interface Contribution {
  readonly kind: QuantityKind;
  readonly unit: string;
  readonly decimals: number;
  readonly atoms: bigint;
  readonly domain: string;
}

/**
 * The demand a set of contributions places on each declared resource, by
 * Core's matching rule restricted to the resource's scope: equal kind, equal
 * unit, and equal domain when the resource names one. A contribution may
 * count toward several resources (the portfolio-wide notional and a
 * derivative-only notional), exactly as it would be charged at several ledger
 * dimensions. A contribution that cannot be rescaled exactly is refused: no
 * rounding direction is defined.
 */
export function demandOf(table: ResourceTable, contributions: readonly Contribution[]): Result<ResourceVector, Reason> {
  const out = new Map<string, bigint>();
  for (const def of table.values()) {
    for (const c of contributions) {
      if (c.kind !== def.kind || c.unit !== def.unit) continue;
      if (def.domain !== null && def.domain !== c.domain) continue;
      const atoms = rescaleExact(c.atoms, c.decimals, def.decimals);
      if (atoms === null) return err(reason('RESOURCE_INCOMPARABLE', def.resource));
      out.set(def.resource, (out.get(def.resource) ?? 0n) + atoms);
    }
  }
  return ok(vectorOf(out));
}
