/**
 * Display formatting for exact protocol amounts.
 *
 * Arithmetic that decides a story uses `bigint` on `atoms`. Grouping and the
 * dollar sign are display only. A CSS width may use an integer basis-point
 * ratio; that number is geometry, not a protocol result.
 */

import type { AmountView, Json } from './types.ts';

export const PORTFOLIO_NOTIONAL = 'portfolio-notional';

export function isRecord(value: unknown): value is { readonly [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function jsonRecord(value: Json | undefined): { readonly [key: string]: Json } | null {
  return isRecord(value) ? value : null;
}

export function jsonText(value: Json | undefined): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return null;
}

export function jsonInteger(value: Json | undefined): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

export function amountByResource(amounts: readonly AmountView[] | undefined, resource: string): AmountView | null {
  return amounts?.find((amount) => amount.resource === resource) ?? null;
}

export function notional(amounts: readonly AmountView[] | undefined): AmountView | null {
  return amountByResource(amounts, PORTFOLIO_NOTIONAL);
}

export function atomsOf(amount: AmountView | null | undefined): bigint {
  if (!amount || !/^-?\d+$/.test(amount.atoms)) return 0n;
  return BigInt(amount.atoms);
}

/** Thousands separators on exact decimal text. The fraction is preserved. */
export function groupDecimal(amount: string): string {
  const negative = amount.startsWith('-');
  const body = negative ? amount.slice(1) : amount;
  const [whole, fraction] = body.split('.');
  if (whole === undefined || !/^\d+$/.test(whole) || (fraction !== undefined && !/^\d+$/.test(fraction))) return amount;
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fraction === undefined ? '' : `.${fraction}`}`;
}

export function formatUsdc(amount: AmountView | null | undefined): string {
  if (!amount) return '—';
  return `$${groupDecimal(amount.amount)}`;
}

/** Shorten a long hex identifier for display. The full value stays available to callers. */
export function shortId(id: string): string {
  const match = /^(.*?)(0x[0-9a-fA-F]{8,})$/.exec(id);
  if (match === null) return id;
  const prefix = match[1] ?? '';
  const hex = match[2] ?? id;
  return `${prefix}${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

/**
 * Integer percent with two decimal places from basis points.
 * 416n → "4.16". Display only.
 */
export function formatBps(bps: bigint): string {
  const negative = bps < 0n;
  const abs = negative ? -bps : bps;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * CSS width, 0–100, from an integer ratio. Capped. Not a protocol amount.
 */
export function widthPercent(part: bigint, whole: bigint): number {
  if (whole <= 0n || part <= 0n) return 0;
  const bps = (part * 10_000n) / whole;
  const capped = bps > 10_000n ? 10_000n : bps;
  return Number(capped) / 100;
}

export function domainTitle(domain: string, label: string): string {
  const known: { readonly [key: string]: string } = {
    'robinhood-evm': 'Stock',
    'swap-fixture': 'Swap',
    'nft-fixture': 'NFT',
    'yield-fixture': 'Yield',
    'lighter-perp': 'Perps',
  };
  return known[domain] ?? titleCase(label);
}

export function titleCase(value: string): string {
  if (value.length === 0) return value;
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

export function agentTitle(label: string): string {
  if (label === 'nft') return 'NFT Agent';
  return `${titleCase(label)} Agent`;
}

/** Story order for the five roles. Unknown labels follow, stably. */
export function storyRank(label: string): number {
  const order = ['stock', 'swap', 'nft', 'yield', 'perps'];
  const index = order.indexOf(label);
  return index < 0 ? order.length : index;
}
