/**
 * Derive the V3 fixture MDUSD cumulative debit cap from portfolio plan/max
 * semantics and the quantity-preserving fixture map.
 */

import { buyCost, type ReviewedMarket } from '@mandate/evm-robinhood';
import { FIXTURE_MAX_DEBIT_ATOMS } from '../fixture-mapping.ts';

const NOTE_A_PRICE_USDC_ATOMS = 125_000_000n;

export interface V3CapDraftAgent {
  readonly enabled: boolean | null;
  readonly budget: string | null;
  readonly maxAllocation: string | null;
}

export interface V3CapInput {
  readonly stock: V3CapDraftAgent;
  readonly autoReallocate: boolean;
  readonly market: ReviewedMarket;
}

export type V3CapResult =
  | { readonly ok: true; readonly cumulativeDebitLimit: bigint; readonly stockAuthorityUsdcAtoms: bigint; readonly basis: 'PLAN' | 'MAXIMUM' }
  | { readonly ok: false; readonly reason: string };

export function deriveV3StockFixtureCap(input: V3CapInput): V3CapResult {
  if (input.stock.enabled !== true) return { ok: false, reason: 'STOCK_DISABLED' };

  let stockAuthorityUsdcAtoms: bigint | null = null;
  let basis: 'PLAN' | 'MAXIMUM' = 'PLAN';

  if (!input.autoReallocate) {
    if (input.stock.budget !== null && input.stock.budget !== '') {
      stockAuthorityUsdcAtoms = BigInt(input.stock.budget);
      basis = 'PLAN';
    } else {
      return { ok: false, reason: 'PLAN_REQUIRED_WHEN_AUTO_REALLOC_DISABLED' };
    }
  } else {
    if (input.stock.maxAllocation === null || input.stock.maxAllocation === '') {
      return { ok: false, reason: 'MAX_ALLOCATION_REQUIRED_WHEN_AUTO_REALLOC_ENABLED' };
    }
    stockAuthorityUsdcAtoms = BigInt(input.stock.maxAllocation);
    basis = 'MAXIMUM';
  }

  if (stockAuthorityUsdcAtoms <= 0n) return { ok: false, reason: 'ZERO_STOCK_AUTHORITY' };

  const qty = (stockAuthorityUsdcAtoms * 10n ** 18n) / NOTE_A_PRICE_USDC_ATOMS;
  if (qty === 0n) return { ok: false, reason: 'ZERO_QUANTITY' };

  const debit = buyCost(input.market, qty);
  if (debit > FIXTURE_MAX_DEBIT_ATOMS) return { ok: false, reason: 'FIXTURE_DEBIT_ABOVE_SANITY_CEILING' };

  return { ok: true, cumulativeDebitLimit: debit, stockAuthorityUsdcAtoms, basis };
}
