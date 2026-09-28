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
 * **One valuation context per canonical asset (7D.1).** A marked fact is a
 * value at a price. Two facts valued at different prices are not parts of one
 * number: 4,000 at BTC = 50,000 plus 3,000 at BTC = 52,000 is valued at no
 * price at all. So every matching fact carrying a `MARK` valuation must
 * carry the *same* `ValuationContext` — one admitted observation of the
 * scoped canonical asset's price:
 *
 * ```text
 * ValuationContext {
 *   asset       the snapshot's subject, which must be exactly the aggregate's CANONICAL_ASSET
 *   source      the snapshot's configured StateSourceId
 *   sequence    the snapshot's sequence
 *   observedAt  the snapshot's observation time, equal to the valuation's own
 *   price       the ValuationRef's exact Price (units and decimals included)
 * }
 * ```
 *
 * derived from the fact's `ValuationRef` and the envelope of the admitted
 * snapshot it cites. A `StateId` cannot be the identity: a snapshot is
 * normalized under one exact module (DOM-2), so two modules never share one.
 * What they can share is the module-independent observation, and that is
 * what is compared — byte for byte, never by value, never by newest, never
 * averaged, never converted. A mark taken for a module's own market (its
 * subject a `MARKET`) is a domain-local valuation: it may serve that module's
 * own invariants, but it is not a valuation of the canonical asset and does
 * not join a principal-global aggregate. Any mismatch — or a matched set that
 * mixes marked and unmarked facts — makes the aggregate `UNKNOWN`.
 *
 * A valuation on the `LIMIT` or `EXECUTION` basis (committed notional) is an
 * order's own price or a fill's, fixed when committed and never revalued; a
 * sum of such commitments is what the ledger itself counts, so those facts
 * are not required to share one price.
 *
 * With every marked fact at one context, the sum is carried as a `TOTAL`
 * whose valuation is that context, evidenced by the snapshots in the result.
 *
 * **Closed, fail-closed scope.** The contributor list is the principal's
 * explicit statement of which exact modules' facts the aggregate
 * understands. Nothing is trusted by `DomainId` or by a fact's name. Every
 * module with an unresolved reservation of the principal is consulted for
 * every aggregate, listed or not (pipeline.ts), so pending activity cannot
 * drop out of the aggregate because a policy stopped listing its module. A
 * consulted module that is not a contributor but projects a matching fact is
 * evidence the aggregate would under-count, so the invariant is `UNKNOWN`,
 * and a risk-increasing action refuses (FAIL-1). A contributor — or an
 * unlisted module with unresolved reservations — that cannot be resolved or
 * projected is `UNKNOWN` for the same reason.
 */

import { ByteWriter, ok, type Result } from '@mandate/kernel';
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
  type Price,
  type QuantityKind,
  type ReservationId,
  type StateEnvelope,
  type StateId,
  type StateInvariantTerm,
  type StateSequence,
  type StateSourceId,
  type UnitCode,
} from '@mandate/core';
import type { InvariantNarrowing } from '@mandate/ledger';
import { ControlTag, controlWriter } from './encoding.ts';
import type { AggregateQuery, EconomicFact, InvariantOutcome, Measure, ModuleProjection } from './module.ts';

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
  /** The envelopes admitted to it, by `StateId`: where a `MARK` valuation's snapshot is looked up. */
  readonly admitted: ReadonlyMap<StateId, StateEnvelope>;
}

export interface AggregateEvaluation {
  readonly outcome: InvariantOutcome;
  readonly reason: string;
  readonly observed: Measure | null;
  readonly bound: Measure | null;
  readonly states: readonly StateId[];
  readonly reservations: readonly ReservationId[];
}

/** Evaluate one aggregate over the consulted participants; `active` is every module with an unresolved reservation. */
export type AggregateEvaluator = (spec: AggregateSpec, participants: readonly ParticipantView[], active: readonly ModuleRef[]) => AggregateEvaluation;

function notEvaluable(reason: string): AggregateEvaluation {
  return { outcome: 'UNKNOWN', reason, observed: null, bound: null, states: [], reservations: [] };
}

/** The facts of `p` that are the aggregate's measure: same kind, same unit, exactly the scoped canonical asset. */
export function matchingFacts(spec: AggregateSpec, p: ParticipantView): readonly EconomicFact[] {
  const { kind, unit } = spec.params;
  return p.projection.facts.filter((f) => f.quantity.kind === kind && f.quantity.unit === unit && f.quantity.asset !== null && resourceIdsEqual(f.quantity.asset, spec.asset));
}

const isContributor = (spec: AggregateSpec, m: ModuleRef): boolean => spec.params.contributors.some((c) => moduleRefsEqual(c, m));

/**
 * The closed-scope check, or `null` if it passes: no consulted non-contributor
 * projects a matching fact, every contributor was consulted, and every module
 * with unresolved reservations was consulted.
 */
export function checkAggregateScope(spec: AggregateSpec, participants: readonly ParticipantView[], active: readonly ModuleRef[]): string | null {
  for (const p of participants) if (!isContributor(spec, p.module) && matchingFacts(spec, p).length > 0) return 'UNDECLARED_CONTRIBUTOR';
  for (const c of spec.params.contributors) if (!participants.some((x) => moduleRefsEqual(x.module, c))) return 'CONTRIBUTOR_UNAVAILABLE';
  for (const a of active) if (!participants.some((x) => moduleRefsEqual(x.module, a))) return 'UNDECLARED_MODULE_UNAVAILABLE';
  return null;
}

/** One admitted observation of a canonical asset's price (see the module comment). */
export interface ValuationContext {
  readonly asset: CanonicalAssetRef;
  readonly source: StateSourceId;
  readonly sequence: StateSequence;
  readonly observedAt: bigint;
  readonly price: Price;
}

/** The canonical bytes two contexts are compared by, as hex. */
export function valuationContextKey(v: ValuationContext): string {
  const w = new ByteWriter();
  writeResourceId(w, v.asset);
  w.str(v.source).str(v.sequence.kind).u64(v.sequence.kind === 'NONE' ? 0n : v.sequence.value).i64(v.observedAt);
  w.str(v.price.numeratorUnit).str(v.price.denominatorUnit).u8(v.price.decimals).u256(v.price.atoms);
  return bytesToHex(w.finish());
}

/**
 * The valuation context of one matching fact for this aggregate: `null` if
 * the fact is not marked, otherwise the context, or the reason it has none.
 */
export function valuationContextOf(spec: AggregateSpec, f: EconomicFact, admitted: ReadonlyMap<StateId, StateEnvelope>): Result<ValuationContext | null, string> {
  const v = f.quantity.valuation;
  if (v === null || v.basis !== 'MARK') return ok(null);
  if (v.source.kind !== 'STATE') return { ok: false, error: 'VALUATION_SOURCE_INVALID' };
  const e = admitted.get(v.source.stateId);
  if (e === undefined) return { ok: false, error: 'VALUATION_STATE_UNRESOLVED' };
  if (e.subject.kind !== 'CANONICAL_ASSET' || !resourceIdsEqual(e.subject, spec.asset)) return { ok: false, error: 'VALUATION_NOT_OF_AGGREGATE_ASSET' };
  if (e.observedAt !== v.observedAt) return { ok: false, error: 'VALUATION_PROVENANCE_MISMATCH' };
  return ok({ asset: spec.asset, source: e.sourceId, sequence: e.sequence, observedAt: e.observedAt, price: v.price });
}

/** The one-valuation-context check over every contributor's matching facts, or `null` if it passes. */
export function checkValuationContexts(spec: AggregateSpec, participants: readonly ParticipantView[]): string | null {
  let key: string | null = null;
  let marked = 0;
  let unmarked = 0;
  for (const p of participants) {
    if (!isContributor(spec, p.module)) continue;
    for (const f of matchingFacts(spec, p)) {
      const v = valuationContextOf(spec, f, p.admitted);
      if (!v.ok) return v.error;
      if (v.value === null) {
        unmarked += 1;
        continue;
      }
      marked += 1;
      const k = valuationContextKey(v.value);
      if (key === null) key = k;
      else if (k !== key) return 'VALUATION_CONTEXT_MISMATCH';
    }
  }
  return marked > 0 && unmarked > 0 ? 'VALUATION_BASIS_MIXED' : null;
}

/** The sum of every contributor's matching facts against the limit. Assumes the scope and valuation checks passed. */
export function sumAggregate(spec: AggregateSpec, participants: readonly ParticipantView[]): AggregateEvaluation {
  const { kind, unit, decimals, limit, contributors } = spec.params;
  let scale = decimals;
  const included: { atoms: bigint; decimals: number }[] = [];
  const states = new Set<StateId>();
  const reservations = new Set<ReservationId>();
  for (const c of contributors) {
    const p = participants.find((x) => moduleRefsEqual(x.module, c));
    if (p === undefined) return notEvaluable('CONTRIBUTOR_UNAVAILABLE');
    for (const f of matchingFacts(spec, p)) {
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
 * Before anything is summed: the closed scope, then one valuation context.
 * `participants` are the modules consulted and projected successfully for
 * this decision; `active`, every module with an unresolved reservation.
 */
export const evaluateAggregate: AggregateEvaluator = (spec, participants, active) => {
  const scope = checkAggregateScope(spec, participants, active);
  if (scope !== null) return notEvaluable(scope);
  const valuation = checkValuationContexts(spec, participants);
  if (valuation !== null) return notEvaluable(valuation);
  return sumAggregate(spec, participants);
};

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
