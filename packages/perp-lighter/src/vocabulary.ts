/**
 * PerpPolicy v1's vocabulary and canonical codecs (Phase 7E.1; perp-policy-v1.md).
 *
 * Everything here is pure: identifiers, resource ids, the typed action
 * payloads the agent signs, and the typed state payloads a reader normalizes
 * from Lighter's API. Nothing is parsed from floating point: Lighter's decimal
 * strings are converted to integer atoms exactly (`parseDecimalAtoms`), and a
 * string that does not fit its declared decimals is refused, never rounded.
 */

import { ByteWriter } from '@mandate/kernel';
import {
  CoreReader,
  readResourceIdInput,
  validateResourceId,
  writeDigest,
  writeResourceId,
  type AccountId,
  type CanonicalAssetRef,
  type MarketId,
  type ResourceId,
  type ResourceIdInput,
  type ReservationId,
  type StateKind,
  type StateSourceId,
} from '@mandate/core';

export const DOMAIN_ID = 'lighter-perp';
export const MODULE_ID = 'perp';
export const MODULE_VERSION = 1;

export const ACTION_CREATE_ORDER = 'perp.create-order';
export const ACTION_CANCEL_ORDER = 'perp.cancel-order';

export const STATE_MARKET = 'perp.market' as StateKind;
export const STATE_ASSET_PRICE = 'perp.asset-price' as StateKind;
export const STATE_ACCOUNT = 'perp.account' as StateKind;

/** The price decimals of the canonical-asset valuation: USD per unit at 2 decimals. */
export const ASSET_PRICE_DECIMALS = 2;
/** USD value decimals of marked exposure. */
export const USD_DECIMALS = 2;
/** Lighter's collateral (USDC) atoms: 6 decimals. Notional in atoms is `baseAmount × price` at size + price decimals, which Lighter keeps at 6. */
export const USDC_DECIMALS = 6;
/** Initial margin fractions are in ticks of 1/10,000 (lighter-go `MarginFractionTick`). */
export const MARGIN_FRACTION_TICK = 10_000n;
/** Fee rates are in units of 1/1,000,000 (lighter-go `FeeTick`). */
export const FEE_TICK = 1_000_000n;

export interface SourceConfig {
  readonly market: StateSourceId;
  readonly assetPrice: StateSourceId;
  readonly account: StateSourceId;
}

// --- Resources -----------------------------------------------------------------------

function must<T>(r: { ok: true; value: T } | { ok: false; error: { code: string; path: string } }): T {
  if (!r.ok) throw new Error(`perp-lighter constant invalid: ${r.error.code} at ${r.error.path}`);
  return r.value;
}

export function marketResource(chainId: number, marketIndex: number): MarketId {
  return must(validateResourceId({ domain: DOMAIN_ID, kind: 'MARKET', localId: `lighter:${chainId}:market:${marketIndex}` }, ['MARKET'] as const, 'market'));
}

export function accountResource(chainId: number, accountIndex: bigint): AccountId {
  return must(validateResourceId({ domain: DOMAIN_ID, kind: 'ACCOUNT', localId: `lighter:${chainId}:account:${accountIndex}` }, ['ACCOUNT'] as const, 'account'));
}

export function collateralResource(chainId: number): ResourceIdInput {
  return { domain: DOMAIN_ID, kind: 'REPRESENTATION_ASSET', localId: `lighter:${chainId}:asset:usdc` };
}

export function venueResource(chainId: number): ResourceIdInput {
  return { domain: DOMAIN_ID, kind: 'VENUE', localId: `lighter:${chainId}` };
}

/** Lighter's largest account index, 2^48 − 2 (lighter-go `MaxAccountIndex`). */
export const MAX_ACCOUNT_INDEX = 281_474_976_710_654n;

/** `lighter:<chain>:account:<index>` → the account index, or `null` — including for an index Lighter cannot have. */
export function accountIndexOf(r: ResourceId, chainId: number): bigint | null {
  const m = /^lighter:(\d+):account:(\d+)$/.exec(r.localId);
  if (r.domain !== DOMAIN_ID || r.kind !== 'ACCOUNT' || m === null || Number(m[1]) !== chainId) return null;
  const index = BigInt(m[2] as string);
  return index <= MAX_ACCOUNT_INDEX ? index : null;
}

/** `lighter:<chain>:market:<index>` → the market index, or `null`. */
export function marketIndexOf(r: ResourceId, chainId: number): number | null {
  const m = /^lighter:(\d+):market:(\d+)$/.exec(r.localId);
  return r.domain === DOMAIN_ID && r.kind === 'MARKET' && m !== null && Number(m[1]) === chainId ? Number(m[2]) : null;
}

// --- Exact decimals --------------------------------------------------------------------

/**
 * `"0.00020"` at 5 decimals → `20n`. Exact: extra fractional digits must be
 * zeros, a sign is refused unless `signed`, and anything else is `null`.
 */
export function parseDecimalAtoms(text: string, decimals: number, signed = false): bigint | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (m === null) return null;
  if (m[1] === '-' && !signed) return null;
  const frac = m[3] ?? '';
  const kept = frac.slice(0, decimals);
  if (!/^0*$/.test(frac.slice(decimals))) return null;
  const atoms = BigInt(`${m[2] as string}${kept.padEnd(decimals, '0')}`);
  return m[1] === '-' ? -atoms : atoms;
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a + b - 1n) / b;
}

// --- Action payloads ---------------------------------------------------------------------

export type Side = 'BUY' | 'SELL';
export type Execution = 'MARKET_IOC' | 'LIMIT_IOC' | 'LIMIT_GTT' | 'LIMIT_POST_ONLY';
const EXECUTIONS: readonly Execution[] = ['MARKET_IOC', 'LIMIT_IOC', 'LIMIT_GTT', 'LIMIT_POST_ONLY'];

/**
 * `perp.create-order`: one Lighter order, in Mandate's types. Signer-owned
 * fields — API key index, nonce, `ExpiredAt`, client order index, integrator
 * and self-trade attributes — are deliberately absent (perp-policy-v1.md §4).
 */
export interface PerpOrder {
  readonly account: ResourceIdInput;
  readonly market: ResourceIdInput;
  readonly side: Side;
  /** Base amount at the market's size decimals (Lighter `BaseAmount`). */
  readonly baseAmount: bigint;
  /** Limit price, or a market order's signed worst price, at the market's price decimals (Lighter `Price`). */
  readonly price: bigint;
  readonly execution: Execution;
  /** Venue-enforced; never relied on to reserve less (reservations-reconciliation.md §12). */
  readonly reduceOnly: boolean;
  /** Milliseconds; required for GTT and post-only, `0` otherwise. */
  readonly orderExpiryMs: bigint;
}

/** `perp.cancel-order`: cancel the live order of one Mandate reservation. */
export interface PerpCancel {
  readonly account: ResourceIdInput;
  readonly market: ResourceIdInput;
  readonly target: ReservationId;
}

export function encodeOrder(o: PerpOrder): Uint8Array {
  const w = new ByteWriter().str('lighter-perp/v1/create-order');
  writeResourceId(w, must(validateResourceId(o.account, ['ACCOUNT'] as const, 'account')));
  writeResourceId(w, must(validateResourceId(o.market, ['MARKET'] as const, 'market')));
  w.u8(o.side === 'BUY' ? 1 : 2).u64(o.baseAmount).u64(o.price).u8(EXECUTIONS.indexOf(o.execution) + 1).u8(o.reduceOnly ? 1 : 0).u64(o.orderExpiryMs);
  return w.finish();
}

export function encodeCancel(c: PerpCancel): Uint8Array {
  const w = new ByteWriter().str('lighter-perp/v1/cancel-order');
  writeResourceId(w, must(validateResourceId(c.account, ['ACCOUNT'] as const, 'account')));
  writeResourceId(w, must(validateResourceId(c.market, ['MARKET'] as const, 'market')));
  writeDigest(w, c.target);
  return w.finish();
}

export function decodeWith<T>(bytes: Uint8Array, read: (r: CoreReader) => T): T | null {
  try {
    const r = new CoreReader(bytes);
    const v = read(r);
    r.finish();
    return v;
  } catch {
    return null;
  }
}

export interface DecodedOrder {
  readonly kind: 'ORDER';
  readonly account: AccountId;
  readonly market: MarketId;
  readonly side: Side;
  readonly baseAmount: bigint;
  readonly price: bigint;
  readonly execution: Execution;
  readonly reduceOnly: boolean;
  readonly orderExpiryMs: bigint;
}

export interface DecodedCancel {
  readonly kind: 'CANCEL';
  readonly account: AccountId;
  readonly market: MarketId;
  readonly target: ReservationId;
}

export function decodeAction(bytes: Uint8Array): DecodedOrder | DecodedCancel | null {
  return decodeWith(bytes, (r) => {
    const tag = r.str();
    const account = validateResourceId(readResourceIdInput(r), ['ACCOUNT'] as const, 'account');
    const market = validateResourceId(readResourceIdInput(r), ['MARKET'] as const, 'market');
    if (!account.ok || !market.ok) throw new Error('resource');
    if (tag === 'lighter-perp/v1/cancel-order') return { kind: 'CANCEL' as const, account: account.value, market: market.value, target: r.digest() as ReservationId };
    if (tag !== 'lighter-perp/v1/create-order') throw new Error('tag');
    const side = r.u8();
    const baseAmount = r.u64();
    const price = r.u64();
    const execution = EXECUTIONS[r.u8() - 1];
    const reduceOnly = r.u8();
    const orderExpiryMs = r.u64();
    if ((side !== 1 && side !== 2) || execution === undefined || (reduceOnly !== 0 && reduceOnly !== 1)) throw new Error('order');
    return { kind: 'ORDER' as const, account: account.value, market: market.value, side: side === 1 ? ('BUY' as const) : ('SELL' as const), baseAmount, price, execution, reduceOnly: reduceOnly === 1, orderExpiryMs };
  });
}

// --- State payloads ------------------------------------------------------------------------

/** The static metadata of one market: what the pinned version digest covers. Live fields (marks, volumes) are excluded. */
export interface MarketStatic {
  readonly chainId: number;
  readonly marketIndex: number;
  readonly symbol: string;
  readonly marketType: 'perp';
  readonly sizeDecimals: number;
  readonly priceDecimals: number;
  /** At size decimals. */
  readonly minBaseAmount: bigint;
  /** USDC atoms. */
  readonly minQuoteAmount: bigint;
  /** Ticks of 1/10,000. */
  readonly minInitialMarginFraction: number;
  readonly defaultInitialMarginFraction: number;
  readonly maintenanceMarginFraction: number;
  readonly closeoutMarginFraction: number;
  /** Lighter's contract multiplier as published, e.g. `"1.000000000000000000"`. */
  readonly multiplier: string;
}

export function encodeMarketStatic(m: MarketStatic): Uint8Array {
  return new ByteWriter()
    .str('lighter-perp/v1/market')
    .u32(m.chainId)
    .u16(m.marketIndex)
    .str(m.symbol)
    .str(m.marketType)
    .u8(m.sizeDecimals)
    .u8(m.priceDecimals)
    .u64(m.minBaseAmount)
    .u64(m.minQuoteAmount)
    .u16(m.minInitialMarginFraction)
    .u16(m.defaultInitialMarginFraction)
    .u16(m.maintenanceMarginFraction)
    .u16(m.closeoutMarginFraction)
    .str(m.multiplier)
    .finish();
}

export function decodeMarketStatic(bytes: Uint8Array): MarketStatic | null {
  return decodeWith(bytes, (r) => {
    if (r.str() !== 'lighter-perp/v1/market') throw new Error('tag');
    const m: MarketStatic = {
      chainId: r.u32(),
      marketIndex: r.u16(),
      symbol: r.str(),
      marketType: r.str() as 'perp',
      sizeDecimals: r.u8(),
      priceDecimals: r.u8(),
      minBaseAmount: r.u64(),
      minQuoteAmount: r.u64(),
      minInitialMarginFraction: r.u16(),
      defaultInitialMarginFraction: r.u16(),
      maintenanceMarginFraction: r.u16(),
      closeoutMarginFraction: r.u16(),
      multiplier: r.str(),
    };
    if (m.marketType !== 'perp') throw new Error('type');
    return m;
  });
}

/** An admitted observation of a canonical asset's price, USD per unit at 2 decimals. */
export function encodeAssetPrice(asset: CanonicalAssetRef | ResourceIdInput, price: bigint): Uint8Array {
  const w = new ByteWriter().str('lighter-perp/v1/asset-price');
  writeResourceId(w, must(validateResourceId(asset, ['CANONICAL_ASSET'] as const, 'asset')));
  return w.u64(price).finish();
}

export function decodeAssetPrice(bytes: Uint8Array): { asset: CanonicalAssetRef; price: bigint } | null {
  return decodeWith(bytes, (r) => {
    if (r.str() !== 'lighter-perp/v1/asset-price') throw new Error('tag');
    const asset = validateResourceId(readResourceIdInput(r), ['CANONICAL_ASSET'] as const, 'asset');
    const price = r.u64();
    if (!asset.ok || price === 0n) throw new Error('price');
    return { asset: asset.value as CanonicalAssetRef, price };
  });
}

export type MarginMode = 'CROSS' | 'ISOLATED';

export interface PositionEntry {
  readonly marketIndex: number;
  /** Signed, at the market's size decimals. */
  readonly size: bigint;
  /** The market's margin setting for this account — present even when flat. */
  readonly marginMode: MarginMode;
  readonly initialMarginFraction: number;
  /** USDC atoms. */
  readonly allocatedMargin: bigint;
}

export interface OpenOrderEntry {
  readonly marketIndex: number;
  readonly clientOrderIndex: bigint;
  readonly isAsk: boolean;
  readonly remainingBaseAmount: bigint;
  readonly price: bigint;
  readonly reduceOnly: boolean;
}

export interface AccountBook {
  readonly account: ResourceIdInput;
  /** USDC atoms. */
  readonly collateral: bigint;
  readonly availableBalance: bigint;
  readonly positions: readonly PositionEntry[];
  readonly openOrders: readonly OpenOrderEntry[];
}

export function encodeAccountBook(b: AccountBook): Uint8Array {
  const w = new ByteWriter().str('lighter-perp/v1/account');
  writeResourceId(w, must(validateResourceId(b.account, ['ACCOUNT'] as const, 'account')));
  w.u64(b.collateral).u64(b.availableBalance).u16(b.positions.length);
  for (const p of b.positions) w.u16(p.marketIndex).i64(p.size).u8(p.marginMode === 'ISOLATED' ? 1 : 0).u16(p.initialMarginFraction).u64(p.allocatedMargin);
  w.u16(b.openOrders.length);
  for (const o of b.openOrders) w.u16(o.marketIndex).u64(o.clientOrderIndex).u8(o.isAsk ? 1 : 0).u64(o.remainingBaseAmount).u64(o.price).u8(o.reduceOnly ? 1 : 0);
  return w.finish();
}

export function decodeAccountBook(bytes: Uint8Array): (Omit<AccountBook, 'account'> & { account: AccountId }) | null {
  return decodeWith(bytes, (r) => {
    if (r.str() !== 'lighter-perp/v1/account') throw new Error('tag');
    const account = validateResourceId(readResourceIdInput(r), ['ACCOUNT'] as const, 'account');
    if (!account.ok) throw new Error('account');
    const collateral = r.u64();
    const availableBalance = r.u64();
    const positions: PositionEntry[] = [];
    for (let i = r.u16(); i > 0; i -= 1) {
      const marketIndex = r.u16();
      const size = r.i64();
      const mode = r.u8();
      if (mode > 1) throw new Error('mode');
      positions.push({ marketIndex, size, marginMode: mode === 1 ? 'ISOLATED' : 'CROSS', initialMarginFraction: r.u16(), allocatedMargin: r.u64() });
    }
    const openOrders: OpenOrderEntry[] = [];
    for (let i = r.u16(); i > 0; i -= 1) {
      const marketIndex = r.u16();
      const clientOrderIndex = r.u64();
      const isAsk = r.u8() === 1;
      openOrders.push({ marketIndex, clientOrderIndex, isAsk, remainingBaseAmount: r.u64(), price: r.u64(), reduceOnly: r.u8() === 1 });
    }
    return { account: account.value, collateral, availableBalance, positions, openOrders };
  });
}
