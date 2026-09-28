/**
 * A deliberately simple, **test-only** reference domain module: a fictional
 * exposure market (brief §38). It exists to exercise the 7D architecture —
 * typed action validation, state requirements across three freshness modes,
 * finality ladders, one marked invariant fact, pending-reservation
 * projection, ledger demands and semantic `noWeaker` — and is not a product
 * integration. It models no real venue, perp, margin system or order type.
 *
 * The fictional market:
 *
 * - markets map, by this module's own table, to a canonical asset; a position
 *   is a size of that asset at 4 decimals;
 * - `synth.open` buys `size` at no worse than `limitPrice` (USD per unit, 2
 *   decimals) with `leverage`; `synth.close` reduces and is never credited
 *   before it settles;
 * - marked gross exposure is size × the admitted mark, rounded up. The mark
 *   is taken either for the module's own market (`valuation: 'MARKET'`, the
 *   default: a domain-local valuation) or for the canonical asset the market
 *   maps to (`valuation: 'ASSET'`: a valuation other modules can share, and
 *   the only kind a principal-global aggregate accepts, 7D.1);
 * - capital is notional-at-limit ÷ leverage in USDG, rounded up, under the
 *   module's declared assumption that USDG settles USD (UNIT-3).
 *
 * Invariants it owns:
 *
 * - `<moduleId>.max-exposure` — an account's marked gross exposure (held +
 *   pending + proposed) ≤ a USD limit; params: `u64` limit atoms at 2 decimals;
 * - `<moduleId>.account-leverage` — that exposure ÷ the account's collateral ≤
 *   a ratio; params: `u64` numerator ‖ `u8` scale.
 *
 * Variants change semantics, and so the manifest and the digest; a variant
 * may also *claim* another's ref, which is how the mutation and malicious
 * module suites build a lying implementation.
 */

import { ByteWriter, type Result } from '@mandate/kernel';
import {
  CoreReader,
  bytesToHex,
  compareRatios,
  encodeWith,
  hexToBytes,
  validateQuantityBound,
  keccakDigest,
  readResourceIdInput,
  resourceIdsEqual,
  validateModuleRef,
  validateQuantity,
  validateRatio,
  validateResourceId,
  validateStateRequirement,
  writeModuleRef,
  writeResourceId,
  type AccountId,
  type ActionId,
  type BoundId,
  type CanonicalAssetRef,
  type EconomicQuantity,
  type FinalityLadderId,
  type FinalityLevel,
  type ImplementationDigest,
  type InvariantId,
  type InvariantVersion,
  type MarketId,
  type ModuleRef,
  type ModuleRefInput,
  type Ratio,
  type ReservationId,
  type ResourceId,
  type ResourceIdInput,
  type StateId,
  type StateInvariantTerm,
  type StateKind,
  type StateRequirement,
  type StateSourceId,
  type UnitCode,
  type VenueId,
} from '@mandate/core';
import type { InvariantNarrowing } from '@mandate/ledger';
import {
  moduleFail,
  statePayloadDigest,
  type ActionAnalysis,
  type ActionContext,
  type AdmittedState,
  type DomainModule,
  type EconomicFact,
  type InvariantEvaluation,
  type InvariantFact,
  type LedgerDemand,
  type ModuleProjection,
  type ModuleResult,
  type ModuleScope,
  type StateNeed,
} from '../../src/index.ts';

// --- Vocabulary --------------------------------------------------------------------

export const MARK = 'synth.mark' as StateKind;
export const POSITION = 'synth.position' as StateKind;
export const INSTRUMENTS = 'synth.instruments' as StateKind;
export const FEED_SOURCE = 'synth.feed' as StateSourceId;
export const VENUE_SOURCE = 'synth.venue' as StateSourceId;
export const REGISTRY_SOURCE = 'synth.registry' as StateSourceId;
/** Invariant ids are the module's own: `<moduleId>.max-exposure`, `<moduleId>.account-leverage`, at the module's version. */
export function maxExposureId(moduleId: string): InvariantId {
  return `${moduleId}.max-exposure` as InvariantId;
}
export function accountLeverageId(moduleId: string): InvariantId {
  return `${moduleId}.account-leverage` as InvariantId;
}
export const ORDER_LEVERAGE_BOUND = 'synth.order-leverage' as BoundId;
export const ORDER_NOTIONAL_BOUND = 'synth.order-notional' as BoundId;
export const OPEN = 'synth.open';
export const CLOSE = 'synth.close';

export const LADDERS = [
  { ladder: 'synth.feed' as FinalityLadderId, levels: ['OBSERVED', 'PUBLISHED'] as FinalityLevel[] },
  { ladder: 'synth.venue' as FinalityLadderId, levels: ['RECEIVED', 'ACKNOWLEDGED', 'FINAL'] as FinalityLevel[] },
  { ladder: 'synth.registry' as FinalityLadderId, levels: ['DRAFT', 'PUBLISHED'] as FinalityLevel[] },
];

export const BTC: ResourceIdInput = { domain: 'registry', kind: 'CANONICAL_ASSET', localId: 'crypto:btc' };
export const ETH: ResourceIdInput = { domain: 'registry', kind: 'CANONICAL_ASSET', localId: 'crypto:eth' };

/** Size decimals, price decimals, USD value decimals. */
export const SIZE_DECIMALS = 4;
export const PRICE_DECIMALS = 2;
export const USD_DECIMALS = 2;

export type Variant =
  /** The reference semantics. */
  | 'STANDARD'
  /** A different, honest semantics: pending reservations count at half. A different manifest and digest. */
  | 'PENDING_HALF'
  /** Mutant: pending reservations are ignored. */
  | 'IGNORE_PENDING'
  /** Mutant: committed notional valued at the mark, labelled as the limit. */
  | 'MARK_NOTIONAL'
  /** Mutant: every narrowing is "no weaker". */
  | 'LENIENT_NARROWING'
  /**
   * Another semantics for the same invariant name (7D.3): the account-leverage
   * bound is read at twice its value. A different manifest and digest — the
   * registry drift a committed binding must never let reinterpret old authority.
   */
  | 'DOUBLE_LEVERAGE'
  /** Broken: output differs between identical calls. */
  | 'UNSTABLE'
  /** Broken: projection omits a required output. */
  | 'OMIT_OUTPUT'
  /** Broken: emits a quantity of an unrepresentable value. */
  | 'NAN_FACT'
  /** Broken: demands a marked (not ledger-trackable) kind. */
  | 'CHARGE_MARKED'
  /** Broken: mutates what it is given. */
  | 'MUTATING'
  /** Broken: emits a fact citing state it was not given. */
  | 'SMUGGLE_STATE';

export interface SyntheticConfig {
  readonly domainId: string;
  readonly moduleId: string;
  readonly moduleVersion: number;
  /** Market local ids and the canonical asset each is exposure to. */
  readonly markets: readonly { readonly localId: string; readonly asset: ResourceIdInput }[];
  readonly variant?: Variant;
  /** The subject a mark is taken for: the module's own market (default) or the market's canonical asset. */
  readonly valuation?: 'MARKET' | 'ASSET';
  /** Declare this ref and implementation instead of the variant's own (a lying implementation). */
  readonly claim?: { readonly ref: ModuleRefInput; readonly implementation: string };
}

function must<T>(r: Result<T, { code: string; path: string }>): T {
  if (!r.ok) throw new Error(`synthetic module constant invalid: ${r.error.code} at ${r.error.path}`);
  return r.value;
}

// --- Payload codecs ------------------------------------------------------------------

export interface Order {
  readonly side: 'OPEN' | 'CLOSE';
  readonly market: ResourceIdInput;
  readonly account: ResourceIdInput;
  /** Asset units at `SIZE_DECIMALS`. */
  readonly size: bigint;
  /** USD per unit at `PRICE_DECIMALS`. */
  readonly limitPrice: bigint;
  readonly leverage: { readonly numerator: bigint; readonly scale: number };
}

export function encodeOrder(o: Order): Uint8Array {
  const w = new ByteWriter().str('synthetic/v1/order').u8(o.side === 'OPEN' ? 1 : 2);
  writeResourceId(w, must(validateResourceId(o.market, ['MARKET'] as const, 'market')));
  writeResourceId(w, must(validateResourceId(o.account, ['ACCOUNT'] as const, 'account')));
  return w.u64(o.size).u64(o.limitPrice).u64(o.leverage.numerator).u8(o.leverage.scale).finish();
}

function decodeWith<T>(bytes: Uint8Array, read: (r: CoreReader) => T): T | null {
  try {
    const r = new CoreReader(bytes);
    const v = read(r);
    r.finish();
    return v;
  } catch {
    return null;
  }
}

interface DecodedOrder {
  readonly side: 'OPEN' | 'CLOSE';
  readonly market: MarketId;
  readonly account: AccountId;
  readonly size: bigint;
  readonly limitPrice: bigint;
  readonly leverage: Ratio;
}

function decodeOrder(bytes: Uint8Array): DecodedOrder | null {
  return decodeWith(bytes, (r) => {
    if (r.str() !== 'synthetic/v1/order') throw new Error('tag');
    const side = r.u8();
    const market = validateResourceId(readResourceIdInput(r), ['MARKET'] as const, 'market');
    const account = validateResourceId(readResourceIdInput(r), ['ACCOUNT'] as const, 'account');
    const size = r.u64();
    const limitPrice = r.u64();
    const leverage = validateRatio({ numerator: r.u64(), scale: r.u8() }, 'leverage');
    if ((side !== 1 && side !== 2) || !market.ok || !account.ok || !leverage.ok) throw new Error('order');
    return { side: side === 1 ? 'OPEN' : 'CLOSE', market: market.value, account: account.value, size, limitPrice, leverage: leverage.value };
  });
}

/** A mark of a market, or of a canonical asset. */
export function encodeMark(subject: ResourceIdInput, price: bigint): Uint8Array {
  const w = new ByteWriter().str('synthetic/v1/mark');
  writeResourceId(w, must(validateResourceId(subject, ['MARKET', 'CANONICAL_ASSET'] as const, 'subject')));
  return w.u64(price).finish();
}

function decodeMark(bytes: Uint8Array): { subject: ResourceId; price: bigint } | null {
  return decodeWith(bytes, (r) => {
    if (r.str() !== 'synthetic/v1/mark') throw new Error('tag');
    const subject = validateResourceId(readResourceIdInput(r), ['MARKET', 'CANONICAL_ASSET'] as const, 'subject');
    const price = r.u64();
    if (!subject.ok || price === 0n) throw new Error('mark');
    return { subject: subject.value, price };
  });
}

function subjectKey(r: ResourceId): string {
  return bytesToHex(encodeWith(writeResourceId, r));
}

export interface PositionBook {
  readonly account: ResourceIdInput;
  /** USDG at 2 decimals. */
  readonly collateral: bigint;
  readonly positions: readonly { readonly market: ResourceIdInput; readonly size: bigint }[];
}

export function encodePosition(p: PositionBook): Uint8Array {
  const w = new ByteWriter().str('synthetic/v1/position');
  writeResourceId(w, must(validateResourceId(p.account, ['ACCOUNT'] as const, 'account')));
  w.u64(p.collateral).u16(p.positions.length);
  for (const x of p.positions) {
    writeResourceId(w, must(validateResourceId(x.market, ['MARKET'] as const, 'market')));
    w.u64(x.size);
  }
  return w.finish();
}

function decodePosition(bytes: Uint8Array): { account: AccountId; collateral: bigint; positions: { market: MarketId; size: bigint }[] } | null {
  return decodeWith(bytes, (r) => {
    if (r.str() !== 'synthetic/v1/position') throw new Error('tag');
    const account = validateResourceId(readResourceIdInput(r), ['ACCOUNT'] as const, 'account');
    const collateral = r.u64();
    const n = r.u16();
    const positions: { market: MarketId; size: bigint }[] = [];
    for (let i = 0; i < n; i += 1) {
      const market = validateResourceId(readResourceIdInput(r), ['MARKET'] as const, 'market');
      if (!market.ok) throw new Error('market');
      positions.push({ market: market.value, size: r.u64() });
    }
    if (!account.ok) throw new Error('account');
    return { account: account.value, collateral, positions };
  });
}

// --- Arithmetic: exact, rounded against the actor ------------------------------------

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** size × price → USD at 2 decimals, rounded up. */
export function valueOf(size: bigint, price: bigint): bigint {
  return ceilDiv(size * price, 10n ** BigInt(SIZE_DECIMALS + PRICE_DECIMALS - USD_DECIMALS));
}

/** notional ÷ leverage, rounded up. */
export function capitalFor(notional: bigint, leverage: Ratio): bigint {
  return ceilDiv(notional * 10n ** BigInt(leverage.scale), leverage.numerator);
}

function u64Hex(x: bigint): string {
  return bytesToHex(new ByteWriter().u64(x).finish());
}

export function maxExposureParams(limitUsdAtoms: bigint): string {
  return u64Hex(limitUsdAtoms);
}

export function leverageParams(numerator: bigint, scale: number): string {
  return bytesToHex(new ByteWriter().u64(numerator).u8(scale).finish());
}

function readLimit(params: string): bigint | null {
  return decodeWith(hexToBytes(params), (r) => r.u64());
}

function readRatio(params: string): Ratio | null {
  return decodeWith(hexToBytes(params), (r) => {
    const v = validateRatio({ numerator: r.u64(), scale: r.u8() }, 'params');
    if (!v.ok) throw new Error('ratio');
    return v.value;
  });
}

// --- The module ------------------------------------------------------------------------

export interface SyntheticModule extends DomainModule {
  readonly config: SyntheticConfig;
  readonly venue: VenueId;
  readonly collateralAsset: ResourceIdInput;
  readonly instrumentsPayload: Uint8Array;
  market(localId: string): ResourceIdInput;
  /** Counts `project` calls, for tests that must see recomputation. */
  readonly calls: { project: number };
}

const ASSUMPTIONS = ['synth.pending-full-fill', 'synth.marked-at-admitted-mark', 'synth.no-reduction-credit', 'synth.usdg-settles-usd'];

/** The manifest the module digest is taken over: every semantic constant and the variant. */
export function syntheticManifest(config: SyntheticConfig): Uint8Array {
  const w = new ByteWriter().str('mandate-core/v1/control/test/synthetic-manifest').u16(1);
  w.str(config.domainId).str(config.moduleId).u32(config.moduleVersion).str(config.variant ?? 'STANDARD');
  w.u16(config.markets.length);
  for (const m of config.markets) w.str(m.localId).str(m.asset.domain).str(m.asset.kind).str(m.asset.localId);
  w.u8(SIZE_DECIMALS).u8(PRICE_DECIMALS).u8(USD_DECIMALS);
  for (const a of ASSUMPTIONS) w.str(a);
  // The conformance corpus's expected summaries are fixed by these semantics, and so bound here too.
  w.str('corpus:synthetic/v1');
  // Appended only when set, so every market-valued module keeps its 7D digest.
  if ((config.valuation ?? 'MARKET') === 'ASSET') w.str('valuation:ASSET');
  return w.finish();
}

export function syntheticRef(config: SyntheticConfig): ModuleRefInput {
  return { domainId: config.domainId, moduleId: config.moduleId, moduleVersion: config.moduleVersion, moduleDigest: keccakDigest(syntheticManifest(config)) };
}

export function syntheticImplementation(config: SyntheticConfig): string {
  return keccakDigest(new TextEncoder().encode(`implementation:${syntheticRef(config).moduleDigest}:${config.variant ?? 'STANDARD'}`));
}

function requirement(input: Parameters<typeof validateStateRequirement>[0]): StateRequirement {
  return must(validateStateRequirement(input, 'requirement'));
}

export function createSyntheticModule(config: SyntheticConfig): SyntheticModule {
  const variant = config.variant ?? 'STANDARD';
  const ref: ModuleRef = must(validateModuleRef(config.claim?.ref ?? syntheticRef(config)));
  const implementation = (config.claim?.implementation ?? syntheticImplementation(config)) as ImplementationDigest;
  const d = config.domainId;
  const venue = must(validateResourceId({ domain: d, kind: 'VENUE', localId: 'synthetic-venue' }, ['VENUE'] as const, 'venue'));
  const collateralAsset: ResourceIdInput = { domain: d, kind: 'REPRESENTATION_ASSET', localId: 'synthetic:usdg' };
  const markets = config.markets.map((m) => ({
    market: must(validateResourceId({ domain: d, kind: 'MARKET', localId: m.localId }, ['MARKET'] as const, 'market')),
    asset: must(validateResourceId(m.asset, ['CANONICAL_ASSET'] as const, 'asset')) as CanonicalAssetRef,
  }));
  const tableWriter = new ByteWriter().str('synthetic/v1/instruments').u16(markets.length);
  for (const m of markets) {
    writeResourceId(tableWriter, m.market);
    writeResourceId(tableWriter, m.asset);
  }
  const instrumentsPayload = tableWriter.finish();
  const pinned = statePayloadDigest(ref, instrumentsPayload);
  const MAX_EXPOSURE = maxExposureId(config.moduleId);
  const ACCOUNT_LEVERAGE = accountLeverageId(config.moduleId);
  const invariantVersion = config.moduleVersion as InvariantVersion;
  let unstable = 0;
  const calls = { project: 0 };

  const assetOf = (market: MarketId): CanonicalAssetRef | null => markets.find((m) => resourceIdsEqual(m.market, market))?.asset ?? null;
  const byAsset = (config.valuation ?? 'MARKET') === 'ASSET';
  /** What a position in `market` is marked by. */
  const markSubject = (market: MarketId): ResourceId => (byAsset ? (assetOf(market) ?? market) : market);
  const marketNeed = (market: MarketId): StateNeed => ({
    stateKind: MARK,
    subject: markSubject(market),
    admittedSources: [FEED_SOURCE],
    requirement: requirement({
      freshness: { kind: 'AGE', maxAgeSeconds: 30n },
      minTrust: 'VERIFIED',
      minFinality: { ladder: 'synth.feed', level: 'PUBLISHED' },
      atIssue: 'RECHECK',
      atExecution: { kind: 'BOUNDED_BY_FRESHNESS' },
    }),
  });
  const positionNeed = (account: AccountId): StateNeed => ({
    stateKind: POSITION,
    subject: account,
    admittedSources: [VENUE_SOURCE],
    requirement: requirement({
      freshness: { kind: 'SEQUENCE' },
      minTrust: 'VERIFIED',
      minFinality: { ladder: 'synth.venue', level: 'ACKNOWLEDGED' },
      atIssue: 'WITHIN_POLICY',
      atExecution: { kind: 'NOT_REQUIRED' },
    }),
  });
  const instrumentsNeed = (): StateNeed => ({
    stateKind: INSTRUMENTS,
    subject: venue,
    admittedSources: [REGISTRY_SOURCE],
    requirement: requirement({
      freshness: { kind: 'VERSION', pinnedDigest: pinned, maxAgeSeconds: 86_400n },
      minTrust: 'AUTHORITATIVE',
      minFinality: { ladder: 'synth.registry', level: 'PUBLISHED' },
      atIssue: 'WITHIN_POLICY',
      atExecution: { kind: 'ENFORCED_BY_ARTIFACT', field: 'market' },
    }),
  });

  const usd = (atoms: bigint, asset: CanonicalAssetRef, price: bigint, state: StateId, observedAt: bigint): EconomicQuantity =>
    must(
      validateQuantity({
        kind: 'GROSS_EXPOSURE',
        unit: 'USD',
        decimals: USD_DECIMALS,
        atoms,
        asset: { domain: asset.domain, kind: asset.kind, localId: asset.localId },
        valuation: {
          price: { numeratorUnit: 'USD', denominatorUnit: 'UNIT', decimals: PRICE_DECIMALS, atoms: price },
          basis: 'MARK',
          source: { kind: 'STATE', stateId: state },
          observedAt,
        },
      }),
    );
  const sizeQ = (atoms: bigint, asset: CanonicalAssetRef): EconomicQuantity =>
    must(validateQuantity({ kind: 'POSITION_SIZE', unit: 'UNIT', decimals: SIZE_DECIMALS, atoms, asset: { domain: asset.domain, kind: asset.kind, localId: asset.localId }, valuation: null }));

  function analyse(ctx: ActionContext): ModuleResult<{ order: DecodedOrder; asset: CanonicalAssetRef }> {
    const order = decodeOrder(ctx.payload);
    if (order === null) return moduleFail('PAYLOAD_MALFORMED', 'payload');
    const expectedType = order.side === 'OPEN' ? OPEN : CLOSE;
    if (ctx.envelope.actionType !== expectedType) return moduleFail('ACTION_TYPE_MISMATCH', 'actionType');
    const asset = assetOf(order.market);
    if (asset === null) return moduleFail('MARKET_UNKNOWN', 'market');
    if (order.account.domain !== d) return moduleFail('ACCOUNT_OUTSIDE_DOMAIN', 'account');
    if (order.size <= 0n || order.limitPrice <= 0n || order.leverage.numerator <= 0n) return moduleFail('ORDER_NOT_POSITIVE', 'order');
    return { ok: true, value: { order, asset } };
  }

  const module: SyntheticModule = {
    ref,
    implementation,
    config,
    venue,
    collateralAsset,
    instrumentsPayload,
    calls,
    market: (localId: string) => ({ domain: d, kind: 'MARKET', localId }),
    invariants: [
      { invariantId: MAX_EXPOSURE, version: invariantVersion },
      { invariantId: ACCOUNT_LEVERAGE, version: invariantVersion },
    ],
    finalityLadders: LADDERS,
    demandMeasures:
      variant === 'CHARGE_MARKED'
        ? [
            { kind: 'CAPITAL', unit: 'USDG' as UnitCode },
            { kind: 'COUNT', unit: 'COUNT' as UnitCode },
          ]
        : [
            { kind: 'CAPITAL', unit: 'USDG' as UnitCode },
            { kind: 'NOTIONAL', unit: 'USD' as UnitCode },
            { kind: 'POSITION_SIZE', unit: 'UNIT' as UnitCode },
            { kind: 'COUNT', unit: 'COUNT' as UnitCode },
          ],

    validateAction(ctx: ActionContext): ModuleResult<ActionAnalysis> {
      const a = analyse(ctx);
      if (!a.ok) return a;
      const { order } = a.value;
      const notional = valueOf(order.size, order.limitPrice);
      return {
        ok: true,
        value: {
          target: order.market,
          resources: [order.account],
          riskDirection: order.side === 'OPEN' ? 'INCREASING' : 'REDUCING',
          requiredRights: [order.side === 'OPEN' ? 'OPEN_RISK' : 'REDUCE_RISK'],
          bounds: [
            { boundId: ORDER_LEVERAGE_BOUND, value: { type: 'RATIO', ratio: order.leverage } },
            { boundId: ORDER_NOTIONAL_BOUND, value: { type: 'QUANTITY', quantity: must(validateQuantityBound({ kind: 'NOTIONAL', unit: 'USD', decimals: USD_DECIMALS, atoms: notional }, 'bound')) } },
          ],
          validUntil: ctx.envelope.validFrom + 3_600n,
        },
      };
    },

    stateRequirements(scope: ModuleScope): ModuleResult<readonly StateNeed[]> {
      const needs = new Map<string, StateNeed>();
      const add = (n: StateNeed): void => {
        needs.set(`${n.stateKind}/${bytesToHex(encodeWith(writeResourceId, n.subject))}`, n);
      };
      if (scope.action !== null) {
        const a = analyse(scope.action);
        if (!a.ok) return a;
        add(marketNeed(a.value.order.market));
        add(positionNeed(a.value.order.account));
        add(instrumentsNeed());
      }
      for (const t of scope.invariants) {
        for (const r of t.scope) if (r.kind === 'ACCOUNT') add(positionNeed(r as AccountId));
        for (const m of markets) add(marketNeed(m.market));
      }
      for (const q of scope.aggregates) {
        for (const a of q.accounts) add(positionNeed(a));
        // A position book may hold any market, so every mark is needed to value it; only the query's asset is reported.
        for (const m of markets) add(marketNeed(m.market));
      }
      for (const f of scope.reservations) {
        for (const e of f.effects) {
          if (e.quantity.kind !== 'POSITION_SIZE' || e.market === null) continue;
          if (assetOf(e.market) === null) return moduleFail('PENDING_MARKET_UNKNOWN', 'reservations');
          add(marketNeed(e.market));
        }
      }
      return { ok: true, value: [...needs.keys()].sort().map((k) => needs.get(k) as StateNeed) };
    },

    validateStatePayload(state: AdmittedState): ModuleResult<true> {
      const e = state.envelope;
      if (e.stateKind === MARK) {
        const m = decodeMark(state.payload);
        return m !== null && resourceIdsEqual(m.subject, e.subject) ? { ok: true, value: true } : moduleFail('MARK_PAYLOAD_INVALID');
      }
      if (e.stateKind === POSITION) {
        const p = decodePosition(state.payload);
        return p !== null && resourceIdsEqual(p.account, e.subject) ? { ok: true, value: true } : moduleFail('POSITION_PAYLOAD_INVALID');
      }
      if (e.stateKind === INSTRUMENTS) {
        const same = state.payload.length === instrumentsPayload.length && state.payload.every((b, i) => b === instrumentsPayload[i]);
        return same ? { ok: true, value: true } : moduleFail('INSTRUMENTS_MISMATCH');
      }
      return moduleFail('STATE_KIND_UNKNOWN');
    },

    project(scope: ModuleScope, states: readonly AdmittedState[]): ModuleResult<ModuleProjection> {
      calls.project += 1;
      if (variant === 'MUTATING') (scope.reservations as ReservationFactLike[]).length = 0;
      const marks = new Map<string, { price: bigint; state: StateId; observedAt: bigint }>();
      const books: { account: AccountId; collateral: bigint; state: StateId; positions: { market: MarketId; size: bigint }[] }[] = [];
      for (const s of states) {
        if (s.envelope.stateKind === MARK) {
          const m = decodeMark(s.payload);
          if (m === null) return moduleFail('MARK_PAYLOAD_INVALID');
          marks.set(subjectKey(m.subject), { price: m.price, state: s.stateId, observedAt: s.envelope.observedAt });
        } else if (s.envelope.stateKind === POSITION) {
          const p = decodePosition(s.payload);
          if (p === null) return moduleFail('POSITION_PAYLOAD_INVALID');
          books.push({ ...p, state: s.stateId });
        }
      }
      const facts: EconomicFact[] = [];
      const perAccount = new Map<string, { account: AccountId; gross: bigint; states: Set<StateId>; reservations: Set<ReservationId>; collateral: bigint | null }>();
      const touch = (account: AccountId) => {
        let a = perAccount.get(account.localId);
        if (a === undefined) {
          a = { account, gross: 0n, states: new Set(), reservations: new Set(), collateral: null };
          perAccount.set(account.localId, a);
        }
        return a;
      };
      const emit = (component: EconomicFact['component'], market: MarketId, account: AccountId, size: bigint, states: StateId[], reservations: ReservationId[]): ModuleResult<true> => {
        const asset = assetOf(market);
        if (asset === null) return moduleFail('MARKET_UNKNOWN');
        const mark = marks.get(subjectKey(markSubject(market)));
        if (mark === undefined) return moduleFail('MARK_MISSING');
        const value = valueOf(size, mark.price);
        const acc = touch(account);
        acc.gross += value;
        for (const s of [...states, mark.state]) acc.states.add(s);
        for (const r of reservations) acc.reservations.add(r);
        facts.push({ component, quantity: sizeQ(size, asset), market, account, states, reservations });
        facts.push({ component, quantity: usd(value, asset, mark.price, mark.state, mark.observedAt), market, account, states: [...states, mark.state], reservations });
        return { ok: true, value: true };
      };
      for (const b of books) {
        const acc = touch(b.account);
        acc.collateral = b.collateral;
        acc.states.add(b.state);
        for (const p of b.positions) {
          if (p.size === 0n) continue;
          const r = emit('HELD', p.market, b.account, p.size, [b.state], []);
          if (!r.ok) return r;
        }
      }
      if (variant !== 'IGNORE_PENDING') {
        for (const f of scope.reservations) {
          for (const e of f.effects) {
            // Only increases are reserved as POSITION_SIZE; nothing pending is credited as a reduction (PROJ-1).
            if (e.quantity.kind !== 'POSITION_SIZE' || e.market === null || e.account === null) continue;
            const size = variant === 'PENDING_HALF' ? e.quantity.atoms / 2n : e.quantity.atoms;
            if (size === 0n) continue;
            const r = emit('PENDING', e.market, e.account, size, [], [f.reservation]);
            if (!r.ok) return r;
          }
        }
      }
      if (scope.action !== null && scope.action.mode === 'PROPOSE') {
        const a = analyse(scope.action);
        if (!a.ok) return a;
        if (a.value.order.side === 'OPEN') {
          const r = emit('PROPOSED', a.value.order.market, a.value.order.account, a.value.order.size, [], []);
          if (!r.ok) return r;
        } else touch(a.value.order.account);
      }
      const invariantFacts: InvariantFact[] = [];
      const payload = new ByteWriter().str('synthetic/v1/projection');
      for (const key of [...perAccount.keys()].sort()) {
        const a = perAccount.get(key) as NonNullable<ReturnType<typeof perAccount.get>>;
        const states2 = [...a.states].sort();
        const reservations = [...a.reservations].sort();
        invariantFacts.push({ factId: 'synth.account-gross', subject: a.account, value: { type: 'TOTAL', kind: 'GROSS_EXPOSURE', unit: 'USD' as UnitCode, decimals: USD_DECIMALS, atoms: a.gross }, states: states2, reservations });
        if (a.collateral !== null && a.collateral > 0n) {
          invariantFacts.push({ factId: 'synth.account-leverage', subject: a.account, value: { type: 'RATIO', ratio: must(validateRatio({ numerator: ceilDiv(a.gross * 10_000n, a.collateral), scale: 4 }, 'leverage')) }, states: states2, reservations });
        }
        payload.str(key).u256(a.gross);
      }
      if (variant === 'UNSTABLE') {
        unstable += 1;
        payload.u32(unstable);
      }
      if (variant === 'NAN_FACT' && facts.length > 0) {
        const f = facts[0] as EconomicFact;
        facts[0] = { ...f, quantity: { ...f.quantity, atoms: Number.NaN as never } };
      }
      if (variant === 'SMUGGLE_STATE' && facts.length > 0) {
        const f = facts[0] as EconomicFact;
        facts[0] = { ...f, states: [...f.states, keccakDigest(new TextEncoder().encode('smuggled')) as StateId] };
      }
      const markets2 = [...new Set(facts.map((f) => f.market).filter((m): m is MarketId => m !== null))];
      const projection: ModuleProjection = {
        facts,
        invariantFacts,
        resources: [...markets2, ...[...perAccount.values()].map((a) => a.account)],
        assumptions: ASSUMPTIONS,
        payload: payload.finish(),
      };
      if (variant === 'OMIT_OUTPUT') return { ok: true, value: { ...projection, facts: undefined as never } };
      return { ok: true, value: projection };
    },

    evaluateInvariant(term: StateInvariantTerm, projection: ModuleProjection): ModuleResult<InvariantEvaluation> {
      const accounts = term.scope.filter((r) => r.kind === 'ACCOUNT');
      if (accounts.length !== 1 || term.version !== invariantVersion) return { ok: true, value: { outcome: 'UNKNOWN', reason: 'SCOPE_INVALID', observed: null, bound: null } };
      const account = accounts[0] as ResourceId;
      const fact = (id: string) => projection.invariantFacts.find((f) => f.factId === id && f.subject !== null && resourceIdsEqual(f.subject, account));
      if (term.invariantId === MAX_EXPOSURE) {
        const limit = readLimit(term.params);
        if (limit === null) return { ok: true, value: { outcome: 'UNKNOWN', reason: 'PARAMS_INVALID', observed: null, bound: null } };
        const gross = fact('synth.account-gross');
        if (gross === undefined || gross.value.type !== 'TOTAL') return { ok: true, value: { outcome: 'UNKNOWN', reason: 'EXPOSURE_UNAVAILABLE', observed: null, bound: null } };
        const bound = { type: 'TOTAL' as const, kind: 'GROSS_EXPOSURE' as const, unit: 'USD' as UnitCode, decimals: USD_DECIMALS, atoms: limit };
        return { ok: true, value: { outcome: gross.value.atoms <= limit ? 'HOLDS' : 'VIOLATED', reason: gross.value.atoms <= limit ? 'WITHIN_LIMIT' : 'EXPOSURE_LIMIT_EXCEEDED', observed: gross.value, bound } };
      }
      if (term.invariantId === ACCOUNT_LEVERAGE) {
        const read = readRatio(term.params);
        if (read === null) return { ok: true, value: { outcome: 'UNKNOWN', reason: 'PARAMS_INVALID', observed: null, bound: null } };
        const max = variant === 'DOUBLE_LEVERAGE' ? { ...read, numerator: read.numerator * 2n } : read;
        const lev = fact('synth.account-leverage');
        if (lev === undefined || lev.value.type !== 'RATIO') return { ok: true, value: { outcome: 'UNKNOWN', reason: 'COLLATERAL_UNAVAILABLE', observed: null, bound: null } };
        const holds = compareRatios(lev.value.ratio, max) <= 0;
        return { ok: true, value: { outcome: holds ? 'HOLDS' : 'VIOLATED', reason: holds ? 'WITHIN_LEVERAGE' : 'LEVERAGE_EXCEEDED', observed: lev.value, bound: { type: 'RATIO', ratio: max } } };
      }
      return moduleFail('INVARIANT_UNKNOWN');
    },

    deriveLedgerDemands(ctx: ActionContext, projection: ModuleProjection): ModuleResult<readonly LedgerDemand[]> {
      void projection;
      const a = analyse(ctx);
      if (!a.ok) return a;
      const { order, asset } = a.value;
      const count: LedgerDemand = { quantity: must(validateQuantity({ kind: 'COUNT', unit: 'COUNT', decimals: 0, atoms: 1n, asset: null, valuation: null })), market: null, account: null, required: false };
      if (order.side === 'CLOSE') return { ok: true, value: [count] };
      let price = order.limitPrice;
      if (variant === 'MARK_NOTIONAL') {
        const mark = projection.facts.find((f) => f.component === 'PROPOSED' && f.quantity.kind === 'GROSS_EXPOSURE');
        if (mark?.quantity.valuation !== null && mark?.quantity.valuation !== undefined) price = mark.quantity.valuation.price.atoms;
      }
      const notional = valueOf(order.size, price);
      const assetInput = { domain: asset.domain, kind: asset.kind, localId: asset.localId };
      const demands: LedgerDemand[] = [
        { quantity: must(validateQuantity({ kind: 'CAPITAL', unit: 'USDG', decimals: USD_DECIMALS, atoms: capitalFor(valueOf(order.size, order.limitPrice), order.leverage), asset: collateralAsset, valuation: null })), market: null, account: order.account, required: true },
        {
          quantity: must(
            validateQuantity({
              kind: 'NOTIONAL',
              unit: 'USD',
              decimals: USD_DECIMALS,
              atoms: notional,
              asset: assetInput,
              valuation: { price: { numeratorUnit: 'USD', denominatorUnit: 'UNIT', decimals: PRICE_DECIMALS, atoms: price }, basis: 'LIMIT', source: { kind: 'ACTION', actionId: ctx.actionId as ActionId }, observedAt: ctx.envelope.validFrom },
            }),
          ),
          market: order.market,
          account: null,
          required: false,
        },
        { quantity: sizeQ(order.size, asset), market: order.market, account: order.account, required: false },
        count,
      ];
      if (variant === 'CHARGE_MARKED') {
        const proposed = projection.facts.find((f) => f.component === 'PROPOSED' && f.quantity.kind === 'GROSS_EXPOSURE');
        if (proposed !== undefined) demands.push({ quantity: proposed.quantity, market: order.market, account: null, required: false });
      }
      return { ok: true, value: demands };
    },

    noWeaker(parent: StateInvariantTerm, child: StateInvariantTerm): ModuleResult<InvariantNarrowing> {
      if (variant === 'LENIENT_NARROWING') return { ok: true, value: 'NO_WEAKER' };
      if (parent.invariantId !== child.invariantId || parent.version !== child.version) return { ok: true, value: 'UNPROVABLE' };
      if (parent.invariantId === MAX_EXPOSURE) {
        const p = readLimit(parent.params);
        const c = readLimit(child.params);
        if (p === null || c === null) return { ok: true, value: 'UNPROVABLE' };
        return { ok: true, value: c <= p ? 'NO_WEAKER' : 'WEAKER' };
      }
      if (parent.invariantId === ACCOUNT_LEVERAGE) {
        const p = readRatio(parent.params);
        const c = readRatio(child.params);
        if (p === null || c === null) return { ok: true, value: 'UNPROVABLE' };
        // Lower leverage is narrower under this module's definition.
        return { ok: true, value: compareRatios(c, p) <= 0 ? 'NO_WEAKER' : 'WEAKER' };
      }
      return { ok: true, value: 'UNPROVABLE' };
    },
  };
  return module;
}

type ReservationFactLike = ModuleScope['reservations'][number];

/** For tests: the digest a module-ref encoding has. */
export function refBytes(ref: ModuleRef): string {
  return bytesToHex(encodeWith(writeModuleRef, ref));
}
