/**
 * The exact unsigned Lighter transaction for an authorized action
 * (Phase 7E.1; signer-architecture.md §5).
 *
 * Every economically meaningful field is derived from the authorized payload
 * and the signer's fixed configuration — never from the agent at issue time —
 * and `checkBinding` re-derives the whole transaction and refuses any field
 * that differs, so a faulty or tampered builder cannot produce a transaction
 * the authorization does not describe. Signer-owned fields: the API key index,
 * the nonce (from the `NONCE_SLOT` rule), `ExpiredAt` (bounded by the
 * authorization), the client order index (derived from the reservation), and
 * the self-trade behaviour (fixed by the adapter).
 */

import type { ReservationId } from '@mandate/core';
import { ALLOWED_TX_TYPES, SELF_TRADE_BEHAVIOR_EXPIRE_TAKER } from './adapter.ts';
import type { CustodyTx } from './custody.ts';
import { clientOrderIndexFor } from './identity.ts';
import { marketIndexOf, type DecodedCancel, type DecodedOrder, type Execution } from './vocabulary.ts';

export interface SignerIdentity {
  readonly chainId: number;
  readonly accountIndex: bigint;
  readonly apiKeyIndex: number;
}

/** Lighter order type and time in force (lighter-go `txtypes`). */
const EXECUTION: { readonly [E in Execution]: { readonly orderType: number; readonly timeInForce: number } } = {
  MARKET_IOC: { orderType: 1, timeInForce: 0 },
  LIMIT_IOC: { orderType: 0, timeInForce: 0 },
  LIMIT_GTT: { orderType: 0, timeInForce: 1 },
  LIMIT_POST_ONLY: { orderType: 0, timeInForce: 2 },
};

export function buildOrderTx(o: DecodedOrder, id: SignerIdentity, reservation: ReservationId, nonce: bigint, expiredAt: bigint): CustodyTx | null {
  const market = marketIndexOf(o.market, id.chainId);
  if (market === null) return null;
  const e = EXECUTION[o.execution];
  return {
    type: 'CREATE_ORDER',
    chainId: id.chainId,
    accountIndex: id.accountIndex,
    apiKeyIndex: id.apiKeyIndex,
    marketIndex: market,
    clientOrderIndex: clientOrderIndexFor(reservation),
    baseAmount: o.baseAmount,
    price: o.price,
    isAsk: o.side === 'SELL' ? 1 : 0,
    orderType: e.orderType,
    timeInForce: e.timeInForce,
    reduceOnly: o.reduceOnly ? 1 : 0,
    orderExpiry: o.orderExpiryMs,
    cancelIndex: 0n,
    expiredAt,
    nonce,
    selfTradeBehavior: SELF_TRADE_BEHAVIOR_EXPIRE_TAKER,
    selfTradeEquality: 0,
  };
}

export function buildCancelTx(c: DecodedCancel, id: SignerIdentity, nonce: bigint, expiredAt: bigint): CustodyTx | null {
  const market = marketIndexOf(c.market, id.chainId);
  if (market === null) return null;
  return {
    type: 'CANCEL_ORDER',
    chainId: id.chainId,
    accountIndex: id.accountIndex,
    apiKeyIndex: id.apiKeyIndex,
    marketIndex: market,
    clientOrderIndex: 0n,
    baseAmount: 0n,
    price: 0n,
    isAsk: 0,
    orderType: 0,
    timeInForce: 0,
    reduceOnly: 0,
    orderExpiry: 0n,
    // The target is named by the client order index the signer derived for the target reservation.
    cancelIndex: clientOrderIndexFor(c.target),
    expiredAt,
    nonce,
    selfTradeBehavior: 0,
    selfTradeEquality: 0,
  };
}

/** The allowlist check, before any hash or signature. */
export function checkAllowed(tx: CustodyTx, allowed: readonly string[] = ALLOWED_TX_TYPES): string | null {
  return allowed.includes(tx.type) ? null : 'TX_TYPE_FORBIDDEN';
}

const FIELDS: readonly (keyof CustodyTx)[] = [
  'type', 'chainId', 'accountIndex', 'apiKeyIndex', 'marketIndex', 'clientOrderIndex', 'baseAmount', 'price', 'isAsk',
  'orderType', 'timeInForce', 'reduceOnly', 'orderExpiry', 'cancelIndex', 'expiredAt', 'nonce', 'selfTradeBehavior', 'selfTradeEquality',
];

/**
 * Re-derive the transaction from the authorized action and compare every
 * field. `null` when it is exactly the authorized transaction; otherwise the
 * first field that differs.
 */
export function checkBinding(tx: CustodyTx, action: DecodedOrder | DecodedCancel, id: SignerIdentity, reservation: ReservationId, nonce: bigint, expiredAt: bigint): string | null {
  const expected = action.kind === 'ORDER' ? buildOrderTx(action, id, reservation, nonce, expiredAt) : buildCancelTx(action, id, nonce, expiredAt);
  if (expected === null) return 'MARKET_NOT_ON_CHAIN';
  for (const f of FIELDS) if (tx[f] !== expected[f]) return `TX_FIELD_MISMATCH.${f}`;
  return null;
}
