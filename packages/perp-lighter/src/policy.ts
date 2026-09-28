/**
 * PerpPolicy v1 for Lighter — the first production `DomainModule`
 * (Phase 7E.1; perp-policy-v1.md; action-state-model.md §8).
 *
 * Pure: no network, clock, key or ledger. It receives an action, the admitted
 * snapshots it asked for and the unresolved reservations under its own exact
 * `ModuleRef`, and returns typed facts, invariant verdicts and ledger demands.
 * It cannot authorize anything; the control engine decides.
 *
 * **Scope.** Two actions: `perp.create-order` (a `MARKET` IOC order, or a
 * `LIMIT` order that is IOC, GTT or post-only) and `perp.cancel-order` (the
 * live order of a Mandate reservation). Isolated margin only.
 *
 * **Four quantities, never "risk"** (perp-policy-v1.md §2):
 *
 * | Quantity           | Kind             | Unit, decimals                      | Asset                      |
 * | ------------------ | ---------------- | ----------------------------------- | -------------------------- |
 * | position size      | `POSITION_SIZE`  | `UNIT`, the market's size decimals  | canonical underlying       |
 * | committed notional | `NOTIONAL`       | `USDC`, 6 (at the signed price)     | canonical underlying       |
 * | margin commitment  | `MARGIN`         | `USDC`, 6                           | the venue's USDC collateral |
 * | marked exposure    | `GROSS_EXPOSURE` | `USD`, 2 (at an admitted asset price) | canonical underlying     |
 *
 * The first three are ledger demands; marked exposure is an invariant fact and
 * never a ledger counter. Nothing adds one kind to another.
 *
 * **Isolated margin is a module rule, not an option.** A create-order is
 * refused when the target market's margin setting is not `ISOLATED`, or when
 * any market of the account holds a cross position or cross open order. v1 has
 * no cross-margin semantics at all, so no grant can turn this off.
 *
 * **Worst case, always.** Every create-order is `INCREASING` and reserves its
 * full worst case — reduce-only included: the flag is venue-enforced, but no
 * Core exception may rely on it (reservations-reconciliation.md §12). A cancel
 * is `REDUCING` and reserves only a count; it releases nothing — its target's
 * reservation stays pending until reconciliation proves the order dead (7F).
 *
 * **Margin.** `ceil(notional × IMF / 10,000) + ceil(notional × feeHeadroom /
 * 1,000,000)`, with the market's admitted initial margin fraction. Lighter
 * documents IMR as `|pos| × mark × IMF` and the IMF as the account's market
 * setting (lighter-go `UpdateLeverage`); the fee term is conservative because
 * Lighter may take isolated positions' fees from cross collateral
 * (venue-evidence.md L-MAR-6). How much a fill actually allocates is
 * unevidenced (E-7) and is compared at reconciliation, not assumed here.
 *
 * **Pending and foreign orders.** Pending reservations under this module are
 * projected in full (PROJ-1), whatever the venue says about them — a cancel
 * request releases nothing. An open order on the account that no pending
 * reservation accounts for (matched by the client order index the signer
 * derives from each reservation) was placed outside Mandate: every invariant
 * is `UNKNOWN`, and every increase refuses.
 */

import { ByteWriter } from '@mandate/kernel';
import {
  bytesToHex,
  compareRatios,
  hexToBytes,
  keccakDigest,
  resourceIdsEqual,
  validateModuleRef,
  validateQuantity,
  validateQuantityBound,
  validateRatio,
  validateStateRequirement,
  writeDigest,
  type AccountId,
  type ActionId,
  type BoundId,
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
  type StateId,
  type StateInvariantTerm,
  type StateRequirement,
  type UnitCode,
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
} from '@mandate/control';
import { clientOrderIndexFor } from './identity.ts';
import { checkClaim, type CheckedClaim, type LighterMarketClaim } from './market.ts';
import {
  ACTION_CANCEL_ORDER,
  ACTION_CREATE_ORDER,
  ASSET_PRICE_DECIMALS,
  DOMAIN_ID,
  FEE_TICK,
  MARGIN_FRACTION_TICK,
  MODULE_ID,
  MODULE_VERSION,
  STATE_ACCOUNT,
  STATE_ASSET_PRICE,
  STATE_MARKET,
  USDC_DECIMALS,
  USD_DECIMALS,
  accountIndexOf,
  ceilDiv,
  collateralResource,
  decodeAccountBook,
  decodeAction,
  decodeAssetPrice,
  decodeMarketStatic,
  decodeWith,
  encodeMarketStatic,
  marketResource,
  type DecodedCancel,
  type DecodedOrder,
  type SourceConfig,
} from './vocabulary.ts';

// --- Identity ----------------------------------------------------------------------------

export const MAX_LEVERAGE = `${MODULE_ID}.max-leverage` as InvariantId;
export const MAX_MARKED_EXPOSURE = `${MODULE_ID}.max-marked-exposure` as InvariantId;
export const ALLOWED_DIRECTION = `${MODULE_ID}.allowed-direction` as InvariantId;
export const ORDER_NOTIONAL_BOUND = `${MODULE_ID}.order-notional` as BoundId;

export const STATE_LADDER = { ladder: 'lighter.state' as FinalityLadderId, levels: ['SEQUENCED', 'COMMITTED', 'VERIFIED'] as FinalityLevel[] };
export const PRICE_LADDER = { ladder: 'perp.price' as FinalityLadderId, levels: ['PUBLISHED'] as FinalityLevel[] };

/** Worst-case assumptions this module makes, bound into its digest (PROJ-1). */
export const ASSUMPTIONS = [
  'perp.pending-full-fill',
  'perp.no-reduction-credit',
  'perp.reduce-only-reserved-in-full',
  'perp.cancel-request-releases-nothing',
  'perp.isolated-margin-only',
  'perp.fee-headroom-in-margin',
  'perp.usdc-settles-usd',
  'perp.marked-at-canonical-asset-price',
] as const;

export interface PerpPolicyConfig {
  readonly chainId: number;
  readonly claims: readonly LighterMarketClaim[];
  readonly sources: SourceConfig;
  /** Default freshness, tightenable by every grant and the principal policy. */
  readonly maxAge: { readonly assetPrice: bigint; readonly account: bigint; readonly market: bigint };
  /** Module cap on an authorization's lifetime, from the action's `validFrom`. */
  readonly lifetimeSeconds: bigint;
}

export interface PerpPolicy extends DomainModule {
  readonly config: PerpPolicyConfig;
  readonly claims: readonly CheckedClaim[];
  claimFor(market: ResourceId): CheckedClaim | null;
}

function must<T>(r: { ok: true; value: T } | { ok: false; error: { code: string; path: string } }): T {
  if (!r.ok) throw new Error(`perp policy constant invalid: ${r.error.code} at ${r.error.path}`);
  return r.value;
}

/** Every semantic constant the module's meaning depends on: its digest is the module's identity (DOM-2). */
export function perpManifest(config: PerpPolicyConfig): Uint8Array {
  const checked = config.claims.map((c) => {
    const k = checkClaim(c, config.chainId);
    if (!k.ok) throw new Error(`claim for market ${c.static.marketIndex} refused: ${k.reason}`);
    return k.value;
  });
  const w = new ByteWriter().str('mandate/perp-lighter/policy-manifest').u16(1);
  w.str(DOMAIN_ID).str(MODULE_ID).u32(MODULE_VERSION).u32(config.chainId);
  w.u16(checked.length);
  for (const c of [...checked].sort((a, b) => a.static.marketIndex - b.static.marketIndex)) {
    writeDigest(w, c.staticDigest);
    w.str(c.asset.domain).str(c.asset.kind).str(c.asset.localId).u64(c.maxTakerFeeRate);
  }
  w.str(config.sources.market).str(config.sources.assetPrice).str(config.sources.account);
  w.u64(config.maxAge.assetPrice).u64(config.maxAge.account).u64(config.maxAge.market).u64(config.lifetimeSeconds);
  for (const a of ASSUMPTIONS) w.str(a);
  for (const id of [MAX_LEVERAGE, MAX_MARKED_EXPOSURE, ALLOWED_DIRECTION, ORDER_NOTIONAL_BOUND]) w.str(id);
  return w.finish();
}

export function perpModuleRef(config: PerpPolicyConfig): ModuleRefInput {
  return { domainId: DOMAIN_ID, moduleId: MODULE_ID, moduleVersion: MODULE_VERSION, moduleDigest: keccakDigest(perpManifest(config)) };
}

export function perpImplementation(config: PerpPolicyConfig): ImplementationDigest {
  return keccakDigest<ImplementationDigest>(new TextEncoder().encode(`mandate/perp-lighter/implementation/v1:${perpModuleRef(config).moduleDigest}`));
}

// --- Parameters ---------------------------------------------------------------------------

export function maxLeverageParams(numerator: bigint, scale: number): string {
  return bytesToHex(new ByteWriter().u64(numerator).u8(scale).finish());
}

export function maxMarkedExposureParams(usdAtoms: bigint): string {
  return bytesToHex(new ByteWriter().u64(usdAtoms).finish());
}

export type Direction = 'LONG_ONLY' | 'SHORT_ONLY' | 'BOTH';
const DIRECTIONS: readonly Direction[] = ['LONG_ONLY', 'SHORT_ONLY', 'BOTH'];

export function allowedDirectionParams(d: Direction): string {
  return bytesToHex(new ByteWriter().u8(DIRECTIONS.indexOf(d) + 1).finish());
}

function readRatio(params: string): Ratio | null {
  return decodeWith(hexToBytes(params), (r) => {
    const v = validateRatio({ numerator: r.u64(), scale: r.u8() }, 'params');
    if (!v.ok || v.value.numerator === 0n) throw new Error('ratio');
    return v.value;
  });
}

function readU64(params: string): bigint | null {
  return decodeWith(hexToBytes(params), (r) => r.u64());
}

function readDirection(params: string): Direction | null {
  return decodeWith(hexToBytes(params), (r) => {
    const d = DIRECTIONS[r.u8() - 1];
    if (d === undefined) throw new Error('direction');
    return d;
  });
}

// --- The module -----------------------------------------------------------------------------

const notEvaluable = (reason: string): ModuleResult<InvariantEvaluation> => ({ ok: true, value: { outcome: 'UNKNOWN', reason, observed: null, bound: null } });

export function createPerpPolicy(config: PerpPolicyConfig): PerpPolicy {
  const ref: ModuleRef = must(validateModuleRef(perpModuleRef(config)));
  const implementation = perpImplementation(config);
  const invariantVersion = MODULE_VERSION as InvariantVersion;
  const claims: CheckedClaim[] = config.claims.map((c) => {
    const k = checkClaim(c, config.chainId);
    if (!k.ok) throw new Error(`claim refused: ${k.reason}`);
    return k.value;
  });
  const collateral = collateralResource(config.chainId);
  const claimFor = (market: ResourceId): CheckedClaim | null => claims.find((c) => resourceIdsEqual(marketResource(config.chainId, c.static.marketIndex), market)) ?? null;
  const claimByIndex = (index: number): CheckedClaim | null => claims.find((c) => c.static.marketIndex === index) ?? null;

  const requirement = (input: Parameters<typeof validateStateRequirement>[0]): StateRequirement => must(validateStateRequirement(input, 'requirement'));
  const marketNeed = (c: CheckedClaim): StateNeed => ({
    stateKind: STATE_MARKET,
    subject: marketResource(config.chainId, c.static.marketIndex),
    admittedSources: [config.sources.market],
    requirement: requirement({
      // Pinned to the reviewed claim's static metadata, as this module normalizes it (DOM-2).
      freshness: { kind: 'VERSION', pinnedDigest: statePayloadDigest(ref, encodeMarketStatic(c.static)), maxAgeSeconds: config.maxAge.market },
      minTrust: 'VERIFIED',
      minFinality: { ladder: STATE_LADDER.ladder, level: 'SEQUENCED' },
      atIssue: 'WITHIN_POLICY',
      // Size and price are signed integers at these decimals: the artifact fixes what the metadata meant.
      atExecution: { kind: 'ENFORCED_BY_ARTIFACT', field: 'market' },
    }),
  });
  const priceNeed = (c: CheckedClaim): StateNeed => ({
    stateKind: STATE_ASSET_PRICE,
    subject: c.asset,
    admittedSources: [config.sources.assetPrice],
    requirement: requirement({
      freshness: { kind: 'AGE', maxAgeSeconds: config.maxAge.assetPrice },
      minTrust: 'VERIFIED',
      minFinality: { ladder: PRICE_LADDER.ladder, level: 'PUBLISHED' },
      atIssue: 'RECHECK',
      // A GTT order lives at least 5 minutes; a seconds-old price cannot bound it. Marked exposure is pre-trade.
      atExecution: { kind: 'NOT_REQUIRED' },
    }),
  });
  const accountNeed = (account: ResourceId): StateNeed => ({
    stateKind: STATE_ACCOUNT,
    subject: account,
    admittedSources: [config.sources.account],
    requirement: requirement({
      // Lighter publishes no account sequence (venue-evidence.md L-OBS-1): age only.
      freshness: { kind: 'AGE', maxAgeSeconds: config.maxAge.account },
      minTrust: 'VERIFIED',
      minFinality: { ladder: STATE_LADDER.ladder, level: 'SEQUENCED' },
      atIssue: 'RECHECK',
      atExecution: { kind: 'NOT_REQUIRED' },
    }),
  });

  function analyse(ctx: ActionContext): ModuleResult<{ action: DecodedOrder | DecodedCancel; claim: CheckedClaim }> {
    const action = decodeAction(ctx.payload);
    if (action === null) return moduleFail('PAYLOAD_MALFORMED', 'payload');
    const expected = action.kind === 'ORDER' ? ACTION_CREATE_ORDER : ACTION_CANCEL_ORDER;
    if (ctx.envelope.actionType !== expected) return moduleFail('ACTION_TYPE_MISMATCH', 'actionType');
    if (accountIndexOf(action.account, config.chainId) === null) return moduleFail('ACCOUNT_NOT_ON_CHAIN', 'account');
    const claim = claimFor(action.market);
    if (claim === null) return moduleFail('MARKET_UNCLAIMED', 'market');
    if (action.kind === 'ORDER') {
      const o = action;
      if (o.baseAmount <= 0n || o.baseAmount > 0xffff_ffff_ffffn || o.price <= 0n || o.price > 0xffff_ffffn) return moduleFail('ORDER_OUT_OF_RANGE', 'order');
      if (o.baseAmount < claim.static.minBaseAmount) return moduleFail('ORDER_BELOW_MINIMUM', 'order.baseAmount');
      const resting = o.execution === 'LIMIT_GTT' || o.execution === 'LIMIT_POST_ONLY';
      if (resting !== o.orderExpiryMs > 0n) return moduleFail('ORDER_EXPIRY_INCONSISTENT', 'order.orderExpiryMs');
      if (resting) {
        // Lighter: 5 minutes to 30 days (L-ORD-4); Mandate: within the module's lifetime cap, so the order dies by the ceiling.
        const from = ctx.envelope.validFrom * 1000n;
        if (o.orderExpiryMs < from + 300_000n || o.orderExpiryMs > (ctx.envelope.validFrom + config.lifetimeSeconds) * 1000n) return moduleFail('ORDER_EXPIRY_OUT_OF_RANGE', 'order.orderExpiryMs');
      }
    }
    return { ok: true, value: { action, claim } };
  }

  const notionalOf = (o: DecodedOrder): bigint => o.baseAmount * o.price; // exact: size + price decimals = 6 (market.ts)

  const module: PerpPolicy = {
    ref,
    implementation,
    config,
    claims,
    claimFor,
    invariants: [
      { invariantId: MAX_LEVERAGE, version: invariantVersion },
      { invariantId: MAX_MARKED_EXPOSURE, version: invariantVersion },
      { invariantId: ALLOWED_DIRECTION, version: invariantVersion },
    ],
    finalityLadders: [STATE_LADDER, PRICE_LADDER],
    demandMeasures: [
      { kind: 'POSITION_SIZE', unit: 'UNIT' as UnitCode },
      { kind: 'NOTIONAL', unit: 'USDC' as UnitCode },
      { kind: 'MARGIN', unit: 'USDC' as UnitCode },
      { kind: 'COUNT', unit: 'COUNT' as UnitCode },
    ],

    validateAction(ctx: ActionContext): ModuleResult<ActionAnalysis> {
      const a = analyse(ctx);
      if (!a.ok) return a;
      const { action } = a.value;
      const notional = action.kind === 'ORDER' ? notionalOf(action) : 0n;
      return {
        ok: true,
        value: {
          target: action.market,
          resources: [action.account],
          riskDirection: action.kind === 'ORDER' ? 'INCREASING' : 'REDUCING',
          requiredRights: [action.kind === 'ORDER' ? 'OPEN_RISK' : 'REDUCE_RISK'],
          bounds: [{ boundId: ORDER_NOTIONAL_BOUND, value: { type: 'QUANTITY', quantity: must(validateQuantityBound({ kind: 'NOTIONAL', unit: 'USDC', decimals: USDC_DECIMALS, atoms: notional }, 'bound')) } }],
          validUntil: ctx.envelope.validFrom + config.lifetimeSeconds,
        },
      };
    },

    stateRequirements(scope: ModuleScope): ModuleResult<readonly StateNeed[]> {
      const accounts = new Map<string, ResourceId>();
      if (scope.action !== null) {
        const a = analyse(scope.action);
        if (!a.ok) return a;
        accounts.set(a.value.action.account.localId, a.value.action.account);
      }
      for (const t of scope.invariants) for (const r of t.scope) if (r.kind === 'ACCOUNT') accounts.set(r.localId, r);
      for (const q of scope.aggregates) for (const acct of q.accounts) accounts.set(acct.localId, acct);
      for (const f of scope.reservations) for (const e of f.effects) if (e.account !== null) accounts.set(e.account.localId, e.account);
      // Held positions may be in any claimed market: every market's metadata and every underlying's price are needed to value them.
      const needs: StateNeed[] = [];
      for (const c of claims) needs.push(marketNeed(c));
      const assets = new Map<string, CheckedClaim>();
      for (const c of claims) assets.set(c.asset.localId, c);
      for (const k of [...assets.keys()].sort()) needs.push(priceNeed(assets.get(k) as CheckedClaim));
      for (const k of [...accounts.keys()].sort()) needs.push(accountNeed(accounts.get(k) as ResourceId));
      return { ok: true, value: needs };
    },

    validateStatePayload(state: AdmittedState): ModuleResult<true> {
      const e = state.envelope;
      if (e.stateKind === STATE_MARKET) {
        const m = decodeMarketStatic(state.payload);
        const c = claimFor(e.subject);
        return m !== null && c !== null && m.marketIndex === c.static.marketIndex && m.chainId === config.chainId ? { ok: true, value: true } : moduleFail('MARKET_PAYLOAD_INVALID');
      }
      if (e.stateKind === STATE_ASSET_PRICE) {
        const p = decodeAssetPrice(state.payload);
        return p !== null && resourceIdsEqual(p.asset, e.subject) ? { ok: true, value: true } : moduleFail('PRICE_PAYLOAD_INVALID');
      }
      if (e.stateKind === STATE_ACCOUNT) {
        const b = decodeAccountBook(state.payload);
        return b !== null && resourceIdsEqual(b.account, e.subject) ? { ok: true, value: true } : moduleFail('ACCOUNT_PAYLOAD_INVALID');
      }
      return moduleFail('STATE_KIND_UNKNOWN');
    },

    project(scope: ModuleScope, states: readonly AdmittedState[]): ModuleResult<ModuleProjection> {
      const prices = new Map<string, { price: bigint; state: StateId; observedAt: bigint }>();
      const books: { account: AccountId; state: StateId; book: NonNullable<ReturnType<typeof decodeAccountBook>> }[] = [];
      for (const s of states) {
        if (s.envelope.stateKind === STATE_ASSET_PRICE) {
          const p = decodeAssetPrice(s.payload);
          if (p === null) return moduleFail('PRICE_PAYLOAD_INVALID');
          prices.set(p.asset.localId, { price: p.price, state: s.stateId, observedAt: s.envelope.observedAt });
        } else if (s.envelope.stateKind === STATE_ACCOUNT) {
          const b = decodeAccountBook(s.payload);
          if (b === null) return moduleFail('ACCOUNT_PAYLOAD_INVALID');
          books.push({ account: b.account, state: s.stateId, book: b });
        }
      }

      const facts: EconomicFact[] = [];
      interface Acc {
        account: AccountId;
        gross: bigint;
        states: Set<StateId>;
        reservations: Set<ReservationId>;
        long: boolean;
        short: boolean;
        cross: boolean;
        foreign: boolean;
        leverage: Ratio | null;
      }
      const perAccount = new Map<string, Acc>();
      const touch = (account: AccountId): Acc => {
        let a = perAccount.get(account.localId);
        if (a === undefined) {
          a = { account, gross: 0n, states: new Set(), reservations: new Set(), long: false, short: false, cross: false, foreign: false, leverage: null };
          perAccount.set(account.localId, a);
        }
        return a;
      };
      const valued = (claim: CheckedClaim, size: bigint): { usd: bigint; price: { price: bigint; state: StateId; observedAt: bigint } } | null => {
        const p = prices.get(claim.asset.localId);
        if (p === undefined) return null;
        const abs = size < 0n ? -size : size;
        return { usd: ceilDiv(abs * p.price, 10n ** BigInt(claim.static.sizeDecimals + ASSET_PRICE_DECIMALS - USD_DECIMALS)), price: p };
      };
      const assetInput = (c: CheckedClaim) => ({ domain: c.asset.domain, kind: c.asset.kind, localId: c.asset.localId });
      const emit = (component: EconomicFact['component'], claim: CheckedClaim, account: AccountId, size: bigint, states2: StateId[], reservations: ReservationId[]): ModuleResult<true> => {
        const v = valued(claim, size);
        if (v === null) return moduleFail('ASSET_PRICE_MISSING');
        const market = marketResource(config.chainId, claim.static.marketIndex);
        const acc = touch(account);
        acc.gross += v.usd;
        for (const s of [...states2, v.price.state]) acc.states.add(s);
        for (const r of reservations) acc.reservations.add(r);
        facts.push({ component, quantity: must(validateQuantity({ kind: 'POSITION_SIZE', unit: 'UNIT', decimals: claim.static.sizeDecimals, atoms: size, asset: assetInput(claim), valuation: null })), market, account, states: states2, reservations });
        facts.push({
          component,
          quantity: must(
            validateQuantity({
              kind: 'GROSS_EXPOSURE',
              unit: 'USD',
              decimals: USD_DECIMALS,
              atoms: v.usd,
              asset: assetInput(claim),
              valuation: { price: { numeratorUnit: 'USD', denominatorUnit: 'UNIT', decimals: ASSET_PRICE_DECIMALS, atoms: v.price.price }, basis: 'MARK', source: { kind: 'STATE', stateId: v.price.state }, observedAt: v.price.observedAt },
            }),
          ),
          market,
          account,
          states: [...states2, v.price.state],
          reservations,
        });
        return { ok: true, value: true };
      };

      // Every client order index a pending reservation of this module can have placed.
      const expectedOrders = new Set<string>();
      for (const f of scope.reservations) expectedOrders.add(clientOrderIndexFor(f.reservation).toString());

      // HELD: the admitted book, with its margin settings and open orders.
      for (const b of books) {
        const acc = touch(b.account);
        acc.states.add(b.state);
        for (const p of b.book.positions) {
          const claim = claimByIndex(p.marketIndex);
          if (p.size !== 0n && claim === null) return moduleFail('POSITION_IN_UNCLAIMED_MARKET');
          if (p.size !== 0n && p.marginMode === 'CROSS') acc.cross = true;
          if (p.size > 0n) acc.long = true;
          if (p.size < 0n) acc.short = true;
          if (p.size !== 0n && claim !== null) {
            const r = emit('HELD', claim, b.account, p.size, [b.state], []);
            if (!r.ok) return r;
          }
        }
        for (const o of b.book.openOrders) {
          if (!expectedOrders.has(o.clientOrderIndex.toString())) acc.foreign = true;
          const setting = b.book.positions.find((p) => p.marketIndex === o.marketIndex);
          if (setting === undefined || setting.marginMode === 'CROSS') acc.cross = true;
        }
      }

      // PENDING: every unresolved reservation in full, never credited as a reduction (PROJ-1).
      for (const f of scope.reservations) {
        for (const e of f.effects) {
          if (e.quantity.kind !== 'POSITION_SIZE' || e.market === null || e.account === null) continue;
          const claim = claimFor(e.market);
          if (claim === null) return moduleFail('PENDING_MARKET_UNCLAIMED');
          const size = e.quantity.atoms - e.consumed;
          if (size <= 0n) continue;
          const r = emit('PENDING', claim, e.account, size, [], [f.reservation]);
          if (!r.ok) return r;
        }
      }

      // PROPOSED, and the target market's margin setting.
      const invariantFacts: InvariantFact[] = [];
      if (scope.action !== null) {
        const a = analyse(scope.action);
        if (!a.ok) return a;
        const { action, claim } = a.value;
        const acc = touch(action.account);
        if (action.kind === 'CANCEL' && scope.action.mode === 'PROPOSE' && !scope.reservations.some((f) => f.reservation === action.target)) {
          return moduleFail('CANCEL_TARGET_NOT_PENDING');
        }
        if (action.kind === 'ORDER') {
          if (action.side === 'BUY') acc.long = true;
          else acc.short = true;
          if (scope.action.mode === 'PROPOSE') {
            const r = emit('PROPOSED', claim, action.account, action.side === 'BUY' ? action.baseAmount : -action.baseAmount, [], []);
            if (!r.ok) return r;
          }
        }
        const book = books.find((b) => resourceIdsEqual(b.account, action.account));
        const setting = book?.book.positions.find((p) => p.marketIndex === claim.static.marketIndex);
        const market = marketResource(config.chainId, claim.static.marketIndex);
        if (book !== undefined && setting !== undefined) {
          invariantFacts.push({ factId: 'perp.target-isolated', subject: market, value: { type: 'FLAG', value: setting.marginMode === 'ISOLATED' }, states: [book.state], reservations: [] });
          invariantFacts.push({ factId: 'perp.target-imf', subject: market, value: { type: 'RATIO', ratio: must(validateRatio({ numerator: BigInt(setting.initialMarginFraction), scale: 4 }, 'imf')) }, states: [book.state], reservations: [] });
          if (setting.initialMarginFraction <= 0) return moduleFail('MARGIN_FRACTION_INVALID');
          // Leverage = 1 / IMF, rounded up against the actor.
          acc.leverage = must(validateRatio({ numerator: ceilDiv(MARGIN_FRACTION_TICK * 100n, BigInt(setting.initialMarginFraction)), scale: 2 }, 'leverage'));
        }
      }

      const payload = new ByteWriter().str('lighter-perp/v1/projection');
      for (const key of [...perAccount.keys()].sort()) {
        const a = perAccount.get(key) as Acc;
        const st = [...a.states].sort();
        const rs = [...a.reservations].sort();
        invariantFacts.push({ factId: 'perp.account-gross', subject: a.account, value: { type: 'TOTAL', kind: 'GROSS_EXPOSURE', unit: 'USD' as UnitCode, decimals: USD_DECIMALS, atoms: a.gross }, states: st, reservations: rs });
        invariantFacts.push({ factId: 'perp.cross-in-use', subject: a.account, value: { type: 'FLAG', value: a.cross }, states: st, reservations: rs });
        invariantFacts.push({ factId: 'perp.foreign-open-orders', subject: a.account, value: { type: 'FLAG', value: a.foreign }, states: st, reservations: rs });
        invariantFacts.push({ factId: 'perp.long-exposure', subject: a.account, value: { type: 'FLAG', value: a.long }, states: st, reservations: rs });
        invariantFacts.push({ factId: 'perp.short-exposure', subject: a.account, value: { type: 'FLAG', value: a.short }, states: st, reservations: rs });
        if (a.leverage !== null) invariantFacts.push({ factId: 'perp.target-leverage', subject: a.account, value: { type: 'RATIO', ratio: a.leverage }, states: st, reservations: rs });
        payload.str(key).u256(a.gross).u8(a.cross ? 1 : 0).u8(a.foreign ? 1 : 0);
      }
      const markets = [...new Set(facts.map((f) => f.market).filter((m): m is MarketId => m !== null).map((m) => m.localId))].sort().map((l) => facts.find((f) => f.market?.localId === l)?.market as MarketId);
      return {
        ok: true,
        value: { facts, invariantFacts, resources: [...markets, ...[...perAccount.values()].map((a) => a.account)], assumptions: [...ASSUMPTIONS], payload: payload.finish() },
      };
    },

    evaluateInvariant(term: StateInvariantTerm, projection: ModuleProjection): ModuleResult<InvariantEvaluation> {
      const accounts = term.scope.filter((r) => r.kind === 'ACCOUNT');
      if (accounts.length !== 1 || term.version !== invariantVersion) return notEvaluable('SCOPE_INVALID');
      const account = accounts[0] as ResourceId;
      const fact = (id: string) => projection.invariantFacts.find((f) => f.factId === id && f.subject !== null && resourceIdsEqual(f.subject, account));
      const foreign = fact('perp.foreign-open-orders');
      if (foreign === undefined) return notEvaluable('ACCOUNT_STATE_UNAVAILABLE');
      if (foreign.value.type === 'FLAG' && foreign.value.value) return notEvaluable('FOREIGN_OPEN_ORDER');
      if (term.invariantId === MAX_MARKED_EXPOSURE) {
        const limit = readU64(term.params);
        const gross = fact('perp.account-gross');
        if (limit === null) return notEvaluable('PARAMS_INVALID');
        if (gross === undefined || gross.value.type !== 'TOTAL') return notEvaluable('EXPOSURE_UNAVAILABLE');
        const bound = { type: 'TOTAL' as const, kind: 'GROSS_EXPOSURE' as const, unit: 'USD' as UnitCode, decimals: USD_DECIMALS, atoms: limit };
        const holds = gross.value.atoms <= limit;
        return { ok: true, value: { outcome: holds ? 'HOLDS' : 'VIOLATED', reason: holds ? 'WITHIN_LIMIT' : 'MARKED_EXPOSURE_EXCEEDED', observed: gross.value, bound } };
      }
      if (term.invariantId === MAX_LEVERAGE) {
        const max = readRatio(term.params);
        if (max === null) return notEvaluable('PARAMS_INVALID');
        const lev = fact('perp.target-leverage');
        if (lev === undefined || lev.value.type !== 'RATIO') return notEvaluable('MARGIN_SETTING_UNKNOWN');
        const holds = compareRatios(lev.value.ratio, max) <= 0;
        return { ok: true, value: { outcome: holds ? 'HOLDS' : 'VIOLATED', reason: holds ? 'WITHIN_LEVERAGE' : 'LEVERAGE_EXCEEDED', observed: lev.value, bound: { type: 'RATIO', ratio: max } } };
      }
      if (term.invariantId === ALLOWED_DIRECTION) {
        const d = readDirection(term.params);
        if (d === null) return notEvaluable('PARAMS_INVALID');
        const long = fact('perp.long-exposure');
        const short = fact('perp.short-exposure');
        if (long?.value.type !== 'FLAG' || short?.value.type !== 'FLAG') return notEvaluable('DIRECTION_UNAVAILABLE');
        const violated = (d === 'LONG_ONLY' && short.value.value) || (d === 'SHORT_ONLY' && long.value.value);
        return { ok: true, value: { outcome: violated ? 'VIOLATED' : 'HOLDS', reason: violated ? 'DIRECTION_NOT_ALLOWED' : 'DIRECTION_ALLOWED', observed: { type: 'FLAG', value: violated }, bound: { type: 'FLAG', value: false } } };
      }
      return moduleFail('INVARIANT_UNKNOWN');
    },

    deriveLedgerDemands(ctx: ActionContext, projection: ModuleProjection): ModuleResult<readonly LedgerDemand[]> {
      const a = analyse(ctx);
      if (!a.ok) return a;
      const count: LedgerDemand = { quantity: must(validateQuantity({ kind: 'COUNT', unit: 'COUNT', decimals: 0, atoms: 1n, asset: null, valuation: null })), market: null, account: null, required: false };
      const { action, claim } = a.value;
      if (action.kind === 'CANCEL') return { ok: true, value: [count] };
      const market = marketResource(config.chainId, claim.static.marketIndex);
      const find = (id: string) => projection.invariantFacts.find((f) => f.factId === id && f.subject !== null && resourceIdsEqual(f.subject, market));
      const cross = projection.invariantFacts.find((f) => f.factId === 'perp.cross-in-use' && f.subject !== null && resourceIdsEqual(f.subject, action.account));
      const isolated = find('perp.target-isolated');
      const imf = find('perp.target-imf');
      // v1 has no cross-margin semantics: an order that would join or sit beside cross margin is not a v1 order.
      if (isolated === undefined || imf === undefined || imf.value.type !== 'RATIO') return moduleFail('MARGIN_SETTING_UNKNOWN', 'market');
      if (isolated.value.type !== 'FLAG' || !isolated.value.value) return moduleFail('CROSS_MARGIN_UNSUPPORTED', 'market');
      if (cross === undefined || cross.value.type !== 'FLAG' || cross.value.value) return moduleFail('CROSS_MARGIN_IN_USE', 'account');
      const notional = notionalOf(action);
      const margin = ceilDiv(notional * imf.value.ratio.numerator, MARGIN_FRACTION_TICK) + ceilDiv(notional * claim.maxTakerFeeRate, FEE_TICK);
      const assetInput = { domain: claim.asset.domain, kind: claim.asset.kind, localId: claim.asset.localId };
      return {
        ok: true,
        value: [
          { quantity: must(validateQuantity({ kind: 'POSITION_SIZE', unit: 'UNIT', decimals: claim.static.sizeDecimals, atoms: action.baseAmount, asset: assetInput, valuation: null })), market, account: action.account, required: false },
          {
            quantity: must(
              validateQuantity({
                kind: 'NOTIONAL',
                unit: 'USDC',
                decimals: USDC_DECIMALS,
                atoms: notional,
                asset: assetInput,
                valuation: { price: { numeratorUnit: 'USDC', denominatorUnit: 'UNIT', decimals: claim.static.priceDecimals, atoms: action.price }, basis: 'LIMIT', source: { kind: 'ACTION', actionId: ctx.actionId as ActionId }, observedAt: ctx.envelope.validFrom },
              }),
            ),
            market,
            account: null,
            required: false,
          },
          { quantity: must(validateQuantity({ kind: 'MARGIN', unit: 'USDC', decimals: USDC_DECIMALS, atoms: margin, asset: collateral, valuation: null })), market: null, account: action.account, required: false },
          count,
        ],
      };
    },

    noWeaker(parent: StateInvariantTerm, child: StateInvariantTerm): ModuleResult<InvariantNarrowing> {
      if (parent.invariantId !== child.invariantId || parent.version !== child.version) return { ok: true, value: 'UNPROVABLE' };
      if (parent.invariantId === MAX_MARKED_EXPOSURE) {
        const p = readU64(parent.params);
        const c = readU64(child.params);
        return { ok: true, value: p === null || c === null ? 'UNPROVABLE' : c <= p ? 'NO_WEAKER' : 'WEAKER' };
      }
      if (parent.invariantId === MAX_LEVERAGE) {
        const p = readRatio(parent.params);
        const c = readRatio(child.params);
        return { ok: true, value: p === null || c === null ? 'UNPROVABLE' : compareRatios(c, p) <= 0 ? 'NO_WEAKER' : 'WEAKER' };
      }
      if (parent.invariantId === ALLOWED_DIRECTION) {
        const p = readDirection(parent.params);
        const c = readDirection(child.params);
        if (p === null || c === null) return { ok: true, value: 'UNPROVABLE' };
        return { ok: true, value: p === 'BOTH' || p === c ? 'NO_WEAKER' : 'WEAKER' };
      }
      return { ok: true, value: 'UNPROVABLE' };
    },
  };
  return module;
}
