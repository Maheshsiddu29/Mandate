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
 */

import { parseDecimalAtoms, type MarketStatic } from './vocabulary.ts';

type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };
type JsonObject = { readonly [k: string]: Json };

function isObject(v: Json | undefined): v is JsonObject {
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
