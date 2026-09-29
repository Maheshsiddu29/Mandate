/**
 * Normalization of Lighter API responses into Mandate's typed values
 * (Phase 7E.1). The JSON boundary: every field is checked for its type and
 * every decimal string converted to integer atoms exactly (`parseDecimalAtoms`);
 * anything that does not fit is refused, never approximated.
 *
 * - `marketStaticOf` — an `orderBookDetails` entry → the static metadata a
 *   market claim pins (live fields — marks, volumes, open interest — are
 *   dropped).
 * - `txRecordOf` — a transaction record (`tx`, `txs`, `account_tx`) → the
 *   normalized observation 7F reconciliation will consume: identity, slot,
 *   sequencing, the four finality timestamps, and the order and trade the
 *   event carries. Structural only: nothing here decides an outcome.
 * - `accountOf`, `activeOrdersOf`, `markOf` — the live state adapter's
 *   normalizers (Phase 7E.2): an `account` response, an
 *   `accountActiveOrders` response and an `orderBookDetails` entry's mark and
 *   index into the typed values `perp.account` and `perp.asset-price` carry.
 *   Every one returns a reason instead of a value when anything is missing,
 *   malformed or outside the v1 vocabulary: an unknown margin mode is never
 *   read as isolated, an unknown market never skipped, and an absent list
 *   never read as empty.
 */

import { ceilDiv, parseDecimalAtoms, type MarginMode, type MarketStatic, type OpenOrderEntry, type PositionEntry } from './vocabulary.ts';

export type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };
type JsonObject = { readonly [k: string]: Json };

export function isObject(v: Json | undefined): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function int(o: JsonObject, k: string): number | null {
  const v = o[k];
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : null;
}

function str(o: JsonObject, k: string): string | null {
  const v = o[k];
  return typeof v === 'string' ? v : null;
}

export function parseJson(text: string): Json | null {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return null;
  }
}

export function marketStaticOf(entry: Json, chainId: number): MarketStatic | null {
  if (!isObject(entry)) return null;
  const marketIndex = int(entry, 'market_id');
  const symbol = str(entry, 'symbol');
  const type = str(entry, 'market_type');
  const sizeDecimals = int(entry, 'size_decimals');
  const priceDecimals = int(entry, 'price_decimals');
  const minBase = str(entry, 'min_base_amount');
  const minQuote = str(entry, 'min_quote_amount');
  const minImf = int(entry, 'min_initial_margin_fraction');
  const defImf = int(entry, 'default_initial_margin_fraction');
  const mmf = int(entry, 'maintenance_margin_fraction');
  const cmf = int(entry, 'closeout_margin_fraction');
  const multiplier = str(entry, 'multiplier');
  if (marketIndex === null || symbol === null || type !== 'perp' || sizeDecimals === null || priceDecimals === null || minBase === null || minQuote === null || minImf === null || defImf === null || mmf === null || cmf === null || multiplier === null) return null;
  const minBaseAmount = parseDecimalAtoms(minBase, sizeDecimals);
  const minQuoteAmount = parseDecimalAtoms(minQuote, 6);
  if (minBaseAmount === null || minQuoteAmount === null) return null;
  return { chainId, marketIndex, symbol, marketType: 'perp', sizeDecimals, priceDecimals, minBaseAmount, minQuoteAmount, minInitialMarginFraction: minImf, defaultInitialMarginFraction: defImf, maintenanceMarginFraction: mmf, closeoutMarginFraction: cmf, multiplier };
}

/** Lighter order status codes (data-structures page; L-LIFE-1). */
export const ORDER_STATUS = [
  'in-progress', 'pending', 'open', 'filled', 'canceled', 'canceled-post-only', 'canceled-reduce-only', 'canceled-position-not-allowed',
  'canceled-margin-not-allowed', 'canceled-too-much-slippage', 'canceled-not-enough-liquidity', 'canceled-self-trade', 'canceled-expired',
  'canceled-oco', 'canceled-child', 'canceled-liquidation', 'canceled-invalid-balance',
] as const;
export type OrderStatus = (typeof ORDER_STATUS)[number];

export interface OrderEvent {
  readonly orderIndex: bigint;
  readonly clientOrderIndex: bigint;
  readonly account: bigint;
  readonly initialBaseAmount: bigint;
  readonly remainingBaseAmount: bigint;
  readonly price: bigint;
  readonly isAsk: boolean;
  readonly status: OrderStatus;
}

export interface TxRecord {
  readonly hash: string;
  readonly type: number;
  /** 0 Failed, 1 Pending, 2 Executed, 3 "Pending – Final State" (L-LIFE-6). */
  readonly status: number;
  readonly accountIndex: bigint;
  readonly apiKeyIndex: number;
  readonly nonce: bigint;
  /** `null` when the venue reports no representable deadline (internal transactions carry 2^63 − 1). */
  readonly expireAt: bigint | null;
  readonly blockHeight: bigint;
  readonly sequenceIndex: bigint;
  readonly queuedAt: bigint;
  readonly executedAt: bigint;
  /** 0 when absent: the Ethereum commitment and proof verification (L-FIN-3). */
  readonly committedAt: bigint;
  readonly verifiedAt: bigint;
  readonly appError: string;
  /** For a create-order: the taker order as executed, and the trade if one occurred. */
  readonly takerOrder: OrderEvent | null;
  readonly trade: { readonly price: bigint; readonly size: bigint; readonly takerFeeRate: bigint } | null;
}

function orderEvent(o: Json | undefined): OrderEvent | null {
  if (!isObject(o)) return null;
  const i = int(o, 'i');
  const u = int(o, 'u');
  const a = int(o, 'a');
  const is = int(o, 'is');
  const rs = int(o, 'rs');
  const p = int(o, 'p');
  const ia = int(o, 'ia');
  const st = int(o, 'st');
  if (i === null || u === null || a === null || is === null || rs === null || p === null || ia === null || st === null) return null;
  const status = ORDER_STATUS[st];
  if (status === undefined) return null;
  return { orderIndex: BigInt(i), clientOrderIndex: BigInt(u), account: BigInt(a), initialBaseAmount: BigInt(is), remainingBaseAmount: BigInt(rs), price: BigInt(p), isAsk: ia === 1, status };
}

export function txRecordOf(record: Json): TxRecord | null {
  if (!isObject(record)) return null;
  const hash = str(record, 'hash');
  const fields = ['type', 'status', 'account_index', 'api_key_index', 'nonce', 'block_height', 'sequence_index', 'queued_at', 'executed_at'] as const;
  const n = fields.map((f) => int(record, f));
  if (hash === null || n.some((x) => x === null) || typeof record['expire_at'] !== 'number') return null;
  const [type, status, account, key, nonce, height, seq, queued, executed] = n as number[];
  const expireAt = int(record, 'expire_at');
  const eventText = str(record, 'event_info') ?? '';
  const event = eventText === '' ? null : parseJson(eventText);
  const ev = isObject(event) ? event : null;
  const t = ev !== null && isObject(ev['t']) ? (ev['t'] as JsonObject) : null;
  const tp = t === null ? null : int(t, 'p');
  const ts = t === null ? null : int(t, 's');
  const tf = t === null ? null : int(t, 'tf');
  return {
    hash,
    type: type as number,
    status: status as number,
    accountIndex: BigInt(account as number),
    apiKeyIndex: key as number,
    nonce: BigInt(nonce as number),
    expireAt: expireAt === null ? null : BigInt(expireAt),
    blockHeight: BigInt(height as number),
    sequenceIndex: BigInt(seq as number),
    queuedAt: BigInt(queued as number),
    executedAt: BigInt(executed as number),
    committedAt: BigInt(int(record, 'committed_at') ?? 0),
    verifiedAt: BigInt(int(record, 'verified_at') ?? 0),
    appError: ev !== null ? (str(ev, 'ae') ?? '') : '',
    takerOrder: ev === null ? null : orderEvent(ev['to']),
    trade: tp !== null && ts !== null && tf !== null ? { price: BigInt(tp), size: BigInt(ts), takerFeeRate: BigInt(tf) } : null,
  };
}

// --- Live state (Phase 7E.2) ------------------------------------------------------------

export type Normalized<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

function no<T>(reason: string): Normalized<T> {
  return { ok: false, reason };
}

/** Lighter's `margin_mode`: 0 cross, 1 isolated (lighter-go `CrossMargin`/`IsolatedMargin`). Anything else is not a mode. */
export function marginModeOf(code: Json | undefined): MarginMode | null {
  return code === 1 ? 'ISOLATED' : code === 0 ? 'CROSS' : null;
}

/** Order counts the account reports, cross-checked against the active-orders reads. */
export interface OrderCounts {
  /** Account-level `total_order_count`: the account's live orders, all markets. */
  readonly total: number;
  /** Account-level `pending_order_count`: orders in flight. */
  readonly pending: number;
  readonly perMarket: readonly { readonly marketIndex: number; readonly open: number; readonly pending: number }[];
}

export interface AccountObservation {
  readonly accountIndex: bigint;
  /** USDC atoms. */
  readonly collateral: bigint;
  readonly availableBalance: bigint;
  readonly positions: readonly PositionEntry[];
  readonly counts: OrderCounts;
}

/**
 * `GET /api/v1/account?by=index&value=<i>` → the account's collateral,
 * positions (with each market's margin setting) and order counts. Position
 * sizes are read at their market's size decimals, so a position in a market
 * absent from `markets` is `UNKNOWN_MARKET`, never skipped.
 */
export function accountOf(body: Json, accountIndex: bigint, markets: ReadonlyMap<number, MarketStatic>): Normalized<AccountObservation> {
  if (!isObject(body)) return no('ACCOUNT_REPLY_MALFORMED');
  if (body['code'] !== 200) return no(`ACCOUNT_CODE_${String(body['code'])}`);
  const list = body['accounts'];
  if (!Array.isArray(list) || list.length !== 1 || !isObject(list[0])) return no('ACCOUNT_NOT_EXACTLY_ONE');
  const a = list[0] as JsonObject;
  if (int(a, 'index') !== Number(accountIndex) || int(a, 'account_index') !== Number(accountIndex)) return no('ACCOUNT_INDEX_MISMATCH');
  const collateralText = str(a, 'collateral');
  const availableText = str(a, 'available_balance');
  const collateral = collateralText === null ? null : parseDecimalAtoms(collateralText, 6);
  const availableBalance = availableText === null ? null : parseDecimalAtoms(availableText, 6);
  if (collateral === null || availableBalance === null) return no('ACCOUNT_AMOUNT_MALFORMED');
  const total = int(a, 'total_order_count');
  const pending = int(a, 'pending_order_count');
  if (total === null || pending === null || total < 0 || pending < 0) return no('ACCOUNT_ORDER_COUNTS_MISSING');
  const raw = a['positions'];
  if (!Array.isArray(raw)) return no('POSITIONS_MISSING');
  const positions: PositionEntry[] = [];
  const perMarket: { marketIndex: number; open: number; pending: number }[] = [];
  for (const p of raw as readonly Json[]) {
    if (!isObject(p)) return no('POSITION_MALFORMED');
    const marketIndex = int(p, 'market_id');
    if (marketIndex === null) return no('POSITION_MALFORMED');
    const m = markets.get(marketIndex);
    if (m === undefined) return no(`UNKNOWN_MARKET_${marketIndex}`);
    if (!('margin_mode' in p)) return no('MARGIN_MODE_MISSING');
    const marginMode = marginModeOf(p['margin_mode']);
    if (marginMode === null) return no('MARGIN_MODE_UNKNOWN');
    const sign = int(p, 'sign');
    const sizeText = str(p, 'position');
    const imfText = str(p, 'initial_margin_fraction');
    const allocatedText = str(p, 'allocated_margin');
    const open = int(p, 'open_order_count');
    const pend = int(p, 'pending_order_count');
    if (sign === null || sizeText === null || imfText === null || allocatedText === null || open === null || pend === null) return no('POSITION_FIELD_MISSING');
    const atoms = parseDecimalAtoms(sizeText, m.sizeDecimals);
    // `initial_margin_fraction` is a percent at 2 decimals: "5.00" is 500 ticks of 1/10,000.
    const imf = parseDecimalAtoms(imfText, 2);
    const allocatedMargin = parseDecimalAtoms(allocatedText, 6);
    if (atoms === null || imf === null || allocatedMargin === null) return no('POSITION_AMOUNT_MALFORMED');
    if ((sign !== 1 && sign !== -1 && !(sign === 0 && atoms === 0n)) || imf <= 0n || imf > 10_000n || open < 0 || pend < 0) return no('POSITION_OUT_OF_RANGE');
    if (positions.some((q) => q.marketIndex === marketIndex)) return no('POSITION_DUPLICATED');
    positions.push({ marketIndex, size: sign === -1 ? -atoms : atoms, marginMode, initialMarginFraction: Number(imf), allocatedMargin });
    perMarket.push({ marketIndex, open, pending: pend });
  }
  return { ok: true, value: { accountIndex, collateral, availableBalance, positions, counts: { total, pending, perMarket } } };
}

/**
 * `GET /api/v1/accountActiveOrders?account_index=<i>&market_id=<m>` (authenticated)
 * → that market's live orders. Only status `open` is a settled live order;
 * anything else in the list (in flight, or a status the list should not
 * carry) makes the read inconclusive. The list must be present: a reply with
 * no `orders` field is not "no orders".
 */
export function activeOrdersOf(body: Json, accountIndex: bigint, market: MarketStatic): Normalized<readonly OpenOrderEntry[]> {
  if (!isObject(body)) return no('ORDERS_REPLY_MALFORMED');
  if (body['code'] === 20001) return no('ORDERS_AUTH_MISSING');
  if (body['code'] === 20013) return no('ORDERS_AUTH_REJECTED');
  if (body['code'] !== 200) return no(`ORDERS_CODE_${String(body['code'])}`);
  const list = body['orders'];
  if (!Array.isArray(list)) return no('ORDERS_LIST_MISSING');
  const out: OpenOrderEntry[] = [];
  for (const o of list as readonly Json[]) {
    if (!isObject(o)) return no('ORDER_MALFORMED');
    if (int(o, 'owner_account_index') !== Number(accountIndex)) return no('ORDER_OTHER_ACCOUNT');
    if (int(o, 'market_index') !== market.marketIndex) return no('ORDER_OTHER_MARKET');
    if (str(o, 'status') !== 'open') return no('ORDER_NOT_SETTLED');
    const coi = int(o, 'client_order_index');
    const remaining = str(o, 'remaining_base_amount');
    const price = str(o, 'price');
    const isAsk = o['is_ask'];
    const reduceOnly = o['reduce_only'];
    if (coi === null || coi < 0 || remaining === null || price === null || typeof isAsk !== 'boolean' || typeof reduceOnly !== 'boolean') return no('ORDER_FIELD_MISSING');
    const remainingBaseAmount = parseDecimalAtoms(remaining, market.sizeDecimals);
    const priceAtoms = parseDecimalAtoms(price, market.priceDecimals);
    if (remainingBaseAmount === null || priceAtoms === null || remainingBaseAmount <= 0n || priceAtoms <= 0n) return no('ORDER_AMOUNT_MALFORMED');
    out.push({ marketIndex: market.marketIndex, clientOrderIndex: BigInt(coi), isAsk, remainingBaseAmount, price: priceAtoms, reduceOnly });
  }
  return { ok: true, value: out };
}

/**
 * An `orderBookDetails` entry's mark and index prices → the canonical asset's
 * USD price at 2 decimals, rounded **up** (marked exposure is never
 * understated). Both must be present and positive, and within
 * `maxDivergenceBps` of each other: a mark that has drifted from the index is
 * not a price to value exposure at.
 */
export function markOf(entry: Json, market: MarketStatic, maxDivergenceBps: bigint): Normalized<bigint> {
  if (!isObject(entry) || int(entry, 'market_id') !== market.marketIndex) return no('MARKET_ENTRY_MISSING');
  if (str(entry, 'status') !== 'active' || entry['is_frozen'] !== false) return no('MARKET_NOT_ACTIVE');
  const markText = str(entry, 'mark_price');
  const indexText = str(entry, 'index_price');
  const mark = markText === null ? null : parseDecimalAtoms(markText, market.priceDecimals);
  const index = indexText === null ? null : parseDecimalAtoms(indexText, market.priceDecimals);
  if (mark === null || index === null) return no('MARK_MALFORMED');
  if (mark <= 0n || index <= 0n) return no('MARK_MISSING');
  const diff = mark > index ? mark - index : index - mark;
  if (diff * 10_000n > index * maxDivergenceBps) return no('MARK_INDEX_DIVERGED');
  const high = mark > index ? mark : index;
  const scale = market.priceDecimals - 2;
  return { ok: true, value: scale >= 0 ? ceilDiv(high, 10n ** BigInt(scale)) : high * 10n ** BigInt(-scale) };
}
