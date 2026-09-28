/**
 * `core.aggregate-max`: Core's own cross-module state invariant (brief §22,
 * §23; action-state-model.md §6 "cross-domain projection"; authority-model.md
 * §8 principal-global invariants).
 *
 * "BTC gross exposure across spot and perps ≤ 6,000 USD" is not a ledger
 * dimension — a marked value floats and is never a counter (decision 10) —
 * and no single domain module may read another's state. So the aggregate is
 * Core's: each contributing module projects its own facts, in a common typed
 * vocabulary, and Core sums only facts that are semantically the same thing.
 *
 * ```text
 * StateInvariantTerm {
 *   invariantId  core.aggregate-max      version 1
 *   scope        exactly one CANONICAL_ASSET, plus the ACCOUNTs whose held state counts
 *   params       str(tag) ‖ u16(1) ‖ kind ‖ str(unit) ‖ u8(decimals) ‖ u256(limit) ‖ u16(n) ‖ ModuleRef₁ … ModuleRefₙ (ascending)
 * }
 * ```
 *
 * **What is summed.** Every `HELD`, `PENDING` and `PROPOSED` fact of every
 * contributor whose kind and unit equal the invariant's and whose asset is
 * *exactly* the scoped canonical asset. Nothing is matched by name: a module
 * counts a position here only if it maps that position to this canonical
 * `AssetId` itself, so `BTC-PERP`, `WBTC` and a BTC-linked stock token are the
 * same exposure only where a module says so (brief §23). Decimals are
 * aligned exactly; there is no rounding.
 *
 * **Why one valuation is not required.** Facts of a marked kind are each
 * valued at a mark the contributing module took from its own admitted
 * snapshot. Their sum is carried as an unvalued `TOTAL`, never as a single
 * `EconomicQuantity`, because no one mark priced it. Whether a principal
 * policy should instead require every contributor to value at one admitted
 * mark is recorded as an open question (implementation-7d.md §17).
 *
 * **Fail closed on undeclared contributors.** The contributor list is the
 * principal's explicit statement of which modules' state the aggregate
 * covers. A consulted module that is not a contributor but projects a
 * matching fact — an agent acting under a module the policy did not list — is
 * evidence the aggregate would under-count, so the invariant is `UNKNOWN`,
 * and a risk-increasing action refuses (FAIL-1). A contributor that cannot be
 * resolved or projected is `UNKNOWN` for the same reason.
 */

import { ok, type ByteWriter, type Result } from '@mandate/kernel';
import {
  CoreReader,
  DecodeFailure,
  QUANTITY_KIND_RULES,
  UINT256_MAX,
  bytesToHex,
  compareBytes,
  encodeWith,
  hexToBytes,
  moduleRefsEqual,
  parseDecimals,
  parseUnitCode,
  readModuleRefInput,
  readQuantityKind,
  resourceIdsEqual,
  validateModuleRef,
  writeModuleRef,
  writeQuantityKind,
  writeResourceId,
  type AccountId,
  type CanonicalAssetRef,
  type ModuleRef,
  type QuantityKind,
  type ReservationId,
  type StateId,
  type StateInvariantTerm,
  type UnitCode,
} from '@mandate/core';
import type { InvariantNarrowing } from '@mandate/ledger';
import { ControlTag, controlWriter } from './encoding.ts';
import type { AggregateQuery, InvariantOutcome, Measure, ModuleProjection } from './module.ts';

export const AGGREGATE_INVARIANT_ID = 'core.aggregate-max';
export const AGGREGATE_INVARIANT_VERSION = 1;
/** Contributors one aggregate may name; bounded by the invariant parameter size Core allows. */
export const MAX_AGGREGATE_CONTRIBUTORS = 12;

export interface AggregateParams {
  readonly kind: QuantityKind;
  readonly unit: UnitCode;
  readonly decimals: number;
  /** At `decimals`. */
  readonly limit: bigint;
  /** Canonical order, no duplicates, at least one. */
  readonly contributors: readonly ModuleRef[];
}

export interface AggregateSpec {
  readonly term: StateInvariantTerm;
  readonly params: AggregateParams;
  readonly asset: CanonicalAssetRef;
  readonly accounts: readonly AccountId[];
}

function contributorsInOrder(refs: readonly ModuleRef[]): ModuleRef[] {
  return [...refs].sort((a, b) => compareBytes(encodeWith(writeModuleRef, a), encodeWith(writeModuleRef, b)));
}

/** The canonical parameter bytes, as the `0x`-hex a `StateInvariantTerm` carries. */
export function encodeAggregateParams(p: AggregateParams): string {
  const w = controlWriter(ControlTag.AGGREGATE_PARAMS);
  writeQuantityKind(w, p.kind);
  w.str(p.unit).u8(p.decimals).u256(p.limit);
  const refs = contributorsInOrder(p.contributors);
  w.u16(refs.length);
  for (const r of refs) writeModuleRef(w, r);
  return bytesToHex(w.finish());
}

export function decodeAggregateParams(hex: string): Result<AggregateParams, string> {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(hex);
  } catch {
    return { ok: false, error: 'AGGREGATE_PARAMS_MALFORMED' };
  }
  const r = new CoreReader(bytes);
  try {
    if (r.str() !== ControlTag.AGGREGATE_PARAMS || r.u16() !== 1) return { ok: false, error: 'AGGREGATE_PARAMS_MALFORMED' };
    const kind = readQuantityKind(r);
    const unit = parseUnitCode(r.str(), 'unit');
    const decimals = parseDecimals(r.u8(), 'decimals');
    const limit = r.u256();
    const inputs = r.list(MAX_AGGREGATE_CONTRIBUTORS, readModuleRefInput, true);
    r.finish();
    if (!unit.ok || !decimals.ok || limit > UINT256_MAX || inputs.length === 0) return { ok: false, error: 'AGGREGATE_PARAMS_INVALID' };
    const contributors: ModuleRef[] = [];
    for (const input of inputs) {
      const m = validateModuleRef(input);
      if (!m.ok) return { ok: false, error: 'AGGREGATE_PARAMS_INVALID' };
      contributors.push(m.value);
    }
    return ok({ kind, unit: unit.value, decimals: decimals.value, limit, contributors });
  } catch (e) {
    if (e instanceof DecodeFailure) return { ok: false, error: 'AGGREGATE_PARAMS_MALFORMED' };
    throw e;
  }
}

/** Parameters and scope of an aggregate term, or why it cannot be evaluated. */
export function aggregateSpecOf(term: StateInvariantTerm): Result<AggregateSpec, string> {
  const params = decodeAggregateParams(term.params);
  if (!params.ok) return params;
  const assets = term.scope.filter((r) => r.kind === 'CANONICAL_ASSET');
  if (assets.length !== 1) return { ok: false, error: 'AGGREGATE_ASSET_SCOPE_INVALID' };
  const accounts: AccountId[] = [];
  for (const r of term.scope) {
    if (r.kind === 'CANONICAL_ASSET') continue;
    if (r.kind !== 'ACCOUNT') return { ok: false, error: 'AGGREGATE_SCOPE_INVALID' };
    accounts.push(r as AccountId);
  }
  return ok({ term, params: params.value, asset: assets[0] as CanonicalAssetRef, accounts });
}

/** What a contributor is asked for: its part of this aggregate, over the scoped accounts in its own domain. */
export function aggregateQueryFor(spec: AggregateSpec, contributor: ModuleRef): AggregateQuery {
  return {
    kind: spec.params.kind,
    unit: spec.params.unit,
    asset: spec.asset,
    accounts: spec.accounts.filter((a) => a.domain === contributor.domainId),
  };
}

function writeAggregateQuery(w: ByteWriter, q: AggregateQuery): void {
  w.str(q.kind).str(q.unit);
  writeResourceId(w, q.asset);
  const accounts = [...q.accounts].sort((a, b) => compareBytes(encodeWith(writeResourceId, a), encodeWith(writeResourceId, b)));
  w.u32(accounts.length);
  for (const a of accounts) writeResourceId(w, a);
}

/** Queries in canonical order with duplicates removed: two aggregates asking a module the same question ask it once. */
export function distinctQueries(queries: readonly AggregateQuery[]): AggregateQuery[] {
  const byBytes = new Map<string, AggregateQuery>();
  for (const q of queries) byBytes.set(bytesToHex(encodeWith(writeAggregateQuery, q)), q);
  return [...byBytes.keys()].sort().map((k) => byBytes.get(k) as AggregateQuery);
}

export interface ParticipantView {
  readonly module: ModuleRef;
  readonly projection: ModuleProjection;
}

export interface AggregateEvaluation {
  readonly outcome: InvariantOutcome;
  readonly reason: string;
  readonly observed: Measure | null;
  readonly bound: Measure | null;
  readonly states: readonly StateId[];
  readonly reservations: readonly ReservationId[];
}

function notEvaluable(reason: string): AggregateEvaluation {
  return { outcome: 'UNKNOWN', reason, observed: null, bound: null, states: [], reservations: [] };
}

/**
 * Sum every matching fact of every contributor and compare with the limit.
 * `participants` are the modules that were consulted and projected
 * successfully for this decision.
 */
export function evaluateAggregate(spec: AggregateSpec, participants: readonly ParticipantView[]): AggregateEvaluation {
  const { kind, unit, decimals, limit, contributors } = spec.params;
  const matches = (p: ParticipantView) => p.projection.facts.filter((f) => f.quantity.kind === kind && f.quantity.unit === unit && f.quantity.asset !== null && resourceIdsEqual(f.quantity.asset, spec.asset));

  for (const p of participants) {
    const isContributor = contributors.some((c) => moduleRefsEqual(c, p.module));
    if (!isContributor && matches(p).length > 0) return notEvaluable('UNDECLARED_CONTRIBUTOR');
  }
  let scale = decimals;
  const included: { atoms: bigint; decimals: number }[] = [];
  const states = new Set<StateId>();
  const reservations = new Set<ReservationId>();
  for (const c of contributors) {
    const p = participants.find((x) => moduleRefsEqual(x.module, c));
    if (p === undefined) return notEvaluable('CONTRIBUTOR_UNAVAILABLE');
    for (const f of matches(p)) {
      included.push({ atoms: f.quantity.atoms, decimals: f.quantity.decimals });
      if (f.quantity.decimals > scale) scale = f.quantity.decimals;
      for (const s of f.states) states.add(s);
      for (const r of f.reservations) reservations.add(r);
    }
  }
  let sum = 0n;
  for (const x of included) sum += x.atoms * 10n ** BigInt(scale - x.decimals);
  const bound = limit * 10n ** BigInt(scale - decimals);
  return {
    outcome: sum <= bound ? 'HOLDS' : 'VIOLATED',
    reason: sum <= bound ? 'AGGREGATE_WITHIN_LIMIT' : 'AGGREGATE_LIMIT_EXCEEDED',
    observed: { type: 'TOTAL', kind, unit, decimals: scale, atoms: sum },
    bound: { type: 'TOTAL', kind, unit, decimals, atoms: limit },
    states: [...states].sort(),
    reservations: [...reservations].sort(),
  };
}

/**
 * Core's `noWeaker` for its own aggregate. A child is no weaker iff it bounds
 * the same measure, counts at least every contributor the parent counts, and
 * its limit is at most the parent's. Counting more contributors only raises
 * the sum when every fact is non-negative, so for a signed kind the
 * contributor sets must be equal.
 */
export function compareAggregateParams(parent: StateInvariantTerm, child: StateInvariantTerm): InvariantNarrowing {
  const p = decodeAggregateParams(parent.params);
  const c = decodeAggregateParams(child.params);
  if (!p.ok || !c.ok) return 'UNPROVABLE';
  if (p.value.kind !== c.value.kind || p.value.unit !== c.value.unit) return 'UNPROVABLE';
  const covers = p.value.contributors.every((x) => c.value.contributors.some((y) => moduleRefsEqual(x, y)));
  if (!covers) return 'WEAKER';
  if (QUANTITY_KIND_RULES[p.value.kind].signed && c.value.contributors.length !== p.value.contributors.length) return 'UNPROVABLE';
  const scale = p.value.decimals > c.value.decimals ? p.value.decimals : c.value.decimals;
  const pl = p.value.limit * 10n ** BigInt(scale - p.value.decimals);
  const cl = c.value.limit * 10n ** BigInt(scale - c.value.decimals);
  return cl <= pl ? 'NO_WEAKER' : 'WEAKER';
}
