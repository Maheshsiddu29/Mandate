/**
 * The canonical asset record: one financial identity, plus the display metadata
 * and lookup keys that point at it.
 *
 * The structure carries the rule. `identity` is what the asset *is*; `display` is
 * how humans refer to it. Changing a display name, a ticker or an alias must not
 * change canonical financial identity (design section 5.2), so the two are
 * separate groups rather than sibling fields on one flat object, and the identity
 * digest (ADR 0007) covers only the first. That makes the claim demonstrable
 * instead of asserted.
 *
 * A ticker is a label, not an identifier: tickers are reused across venues,
 * reassigned after delistings, and changed by corporate action. Everything in
 * `display` is therefore a discovery input that may legitimately be ambiguous.
 */

import { err, ok, type Result } from '@mandate/kernel';
import type { RegistryReasonCodeName } from './reason-codes.ts';
import { validateCanonicalAssetId, type ValidatedCanonicalAssetId } from './asset-id.ts';

/**
 * Asset lifecycle state. Not identity: a delisted asset is the same asset it
 * always was, and `UNKNOWN` is a value that fails closed rather than a gap.
 */
export const AssetStatus = {
  ACTIVE: 'ACTIVE',
  DELISTED: 'DELISTED',
  /** Replaced by another canonical asset, typically by merger. */
  SUPERSEDED: 'SUPERSEDED',
  UNKNOWN: 'UNKNOWN',
} as const;
export type AssetStatus = (typeof AssetStatus)[keyof typeof AssetStatus];

/**
 * Display text: a bounded, printable-ASCII string.
 *
 * Deliberately *not* the kernel's `Identifier` type. Display text may contain
 * spaces and is never an identifier, and keeping the types distinct means a
 * display string cannot be passed where identity is expected.
 */
export const DISPLAY_TEXT_MAX_LENGTH = 128;
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

declare const DisplayTextBrand: unique symbol;
export type DisplayText = string & { readonly [DisplayTextBrand]: true };

export function parseDisplayText(raw: unknown): Result<DisplayText, RegistryReasonCodeName> {
  if (typeof raw !== 'string') return err('SNAPSHOT_MALFORMED');
  if (raw.length === 0 || raw.length > DISPLAY_TEXT_MAX_LENGTH) return err('SNAPSHOT_MALFORMED');
  if (!PRINTABLE_ASCII.test(raw)) return err('SNAPSHOT_MALFORMED');
  // Leading or trailing whitespace would make two display strings normalize to
  // one lookup key while remaining distinct on the record. Reject, never trim.
  if (raw !== raw.trim()) return err('SNAPSHOT_MALFORMED');
  return ok(raw as DisplayText);
}

/** ISO 10383 Market Identifier Code: four upper-case alphanumerics (`XNAS`, `XNYS`). */
const MIC_SHAPE = /^[A-Z0-9]{4}$/;
declare const MicBrand: unique symbol;
export type Mic = string & { readonly [MicBrand]: true };

export function parseMic(raw: unknown): Result<Mic, RegistryReasonCodeName> {
  if (typeof raw !== 'string' || !MIC_SHAPE.test(raw)) return err('SNAPSHOT_MALFORMED');
  return ok(raw as Mic);
}

/**
 * Exchange ticker as the venue prints it. Upper-case alphanumerics plus `.` and
 * `-`, which is what real venue symbols use (`BRK.B`, `RDS-A`).
 */
const TICKER_SHAPE = /^[A-Z0-9][A-Z0-9.\-]{0,11}$/;
declare const TickerBrand: unique symbol;
export type Ticker = string & { readonly [TickerBrand]: true };

export function parseTicker(raw: unknown): Result<Ticker, RegistryReasonCodeName> {
  if (typeof raw !== 'string' || !TICKER_SHAPE.test(raw)) return err('SNAPSHOT_MALFORMED');
  return ok(raw as Ticker);
}

/** One venue listing: this asset trades under this ticker at this MIC. */
export interface MarketListing {
  readonly mic: Mic;
  readonly ticker: Ticker;
}

/**
 * Alias kinds.
 *
 * `EXCHANGE_QUALIFIED` is the one that carries a colon, and exists so a curator
 * can register the exchange-*name* forms humans actually type (`NASDAQ:NVDA`)
 * without the registry pretending an exchange name is a market identifier
 * (ADR 0005).
 */
export const AliasKind = {
  NAME: 'NAME',
  SYMBOL: 'SYMBOL',
  LEGACY_TICKER: 'LEGACY_TICKER',
  EXCHANGE_QUALIFIED: 'EXCHANGE_QUALIFIED',
} as const;
export type AliasKind = (typeof AliasKind)[keyof typeof AliasKind];

export interface AssetAlias {
  readonly kind: AliasKind;
  readonly value: DisplayText;
}

/** Display metadata and lookup keys. Nothing here is identity. */
export interface CanonicalAssetDisplay {
  readonly primaryName: DisplayText;
  /** The ticker a UI shows. Null where the asset has no single obvious one. */
  readonly displayTicker: Ticker | null;
  /** The MIC of the primary listing. Null where there is no primary venue. */
  readonly primaryMarketIdentifier: Mic | null;
  readonly listings: readonly MarketListing[];
  readonly aliases: readonly AssetAlias[];
}

/**
 * One canonical financial asset.
 *
 * There is deliberately no field asserting a relationship to any representation.
 * The edge from asset to representation lives on the *representation*, as a
 * provenance-carrying claim, because that edge is the assertion that can be
 * forged (design section 5.4).
 */
export interface CanonicalAssetRecord {
  readonly identity: ValidatedCanonicalAssetId;
  readonly status: AssetStatus;
  readonly display: CanonicalAssetDisplay;
}

const ASSET_FIELDS = ['identity', 'status', 'display'] as const;
const DISPLAY_FIELDS = [
  'primaryName',
  'displayTicker',
  'primaryMarketIdentifier',
  'listings',
  'aliases',
] as const;

function rejectUnknownKeys(r: Record<string, unknown>, known: readonly string[]): boolean {
  const set = new Set<string>(known);
  for (const k of Object.keys(r)) if (!set.has(k)) return false;
  return true;
}

function parseEnumValue<T extends string>(
  raw: unknown,
  values: Record<string, T>,
): Result<T, RegistryReasonCodeName> {
  if (typeof raw !== 'string' || !Object.prototype.hasOwnProperty.call(values, raw)) {
    return err('SNAPSHOT_MALFORMED');
  }
  return ok(values[raw] as T);
}

function parseListings(raw: unknown): Result<readonly MarketListing[], RegistryReasonCodeName> {
  if (!Array.isArray(raw)) return err('SNAPSHOT_MALFORMED');
  const out: MarketListing[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return err('SNAPSHOT_MALFORMED');
    const e = entry as Record<string, unknown>;
    if (!rejectUnknownKeys(e, ['mic', 'ticker'])) return err('SNAPSHOT_MALFORMED');
    const mic = parseMic(e['mic']);
    if (!mic.ok) return mic;
    const ticker = parseTicker(e['ticker']);
    if (!ticker.ok) return ticker;
    // A duplicate listing means the caller did not build the record it believed
    // it built. Reject rather than collapse (ADR 0002's reasoning).
    const key = `${mic.value}:${ticker.value}`;
    if (seen.has(key)) return err('SNAPSHOT_MALFORMED');
    seen.add(key);
    out.push({ mic: mic.value, ticker: ticker.value });
  }
  return ok(out);
}

function parseAliases(raw: unknown): Result<readonly AssetAlias[], RegistryReasonCodeName> {
  if (!Array.isArray(raw)) return err('SNAPSHOT_MALFORMED');
  const out: AssetAlias[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return err('SNAPSHOT_MALFORMED');
    const e = entry as Record<string, unknown>;
    if (!rejectUnknownKeys(e, ['kind', 'value'])) return err('SNAPSHOT_MALFORMED');
    const kind = parseEnumValue(e['kind'], AliasKind);
    if (!kind.ok) return kind;
    const value = parseDisplayText(e['value']);
    if (!value.ok) return value;
    // An exchange-qualified alias is the only kind permitted to carry a colon,
    // and it must carry exactly one with content on both sides.
    const colons = value.value.split(':').length - 1;
    if (kind.value === AliasKind.EXCHANGE_QUALIFIED) {
      const parts = value.value.split(':');
      if (colons !== 1 || (parts[0] ?? '') === '' || (parts[1] ?? '') === '') {
        return err('SNAPSHOT_MALFORMED');
      }
    } else if (colons !== 0) {
      return err('SNAPSHOT_MALFORMED');
    }
    const key = `${kind.value}\u0000${value.value}`;
    if (seen.has(key)) return err('SNAPSHOT_MALFORMED');
    seen.add(key);
    out.push({ kind: kind.value, value: value.value });
  }
  return ok(out);
}

export function parseCanonicalAssetRecord(
  raw: unknown,
): Result<CanonicalAssetRecord, RegistryReasonCodeName> {
  if (typeof raw !== 'object' || raw === null) return err('SNAPSHOT_MALFORMED');
  const r = raw as Record<string, unknown>;
  if (!rejectUnknownKeys(r, ASSET_FIELDS)) return err('SNAPSHOT_MALFORMED');

  const identity = validateCanonicalAssetId(r['identity']);
  if (!identity.ok) return identity;
  const status = parseEnumValue(r['status'], AssetStatus);
  if (!status.ok) return status;

  const rawDisplay = r['display'];
  if (typeof rawDisplay !== 'object' || rawDisplay === null) return err('SNAPSHOT_MALFORMED');
  const d = rawDisplay as Record<string, unknown>;
  if (!rejectUnknownKeys(d, DISPLAY_FIELDS)) return err('SNAPSHOT_MALFORMED');

  const primaryName = parseDisplayText(d['primaryName']);
  if (!primaryName.ok) return primaryName;

  let displayTicker: Ticker | null = null;
  if (d['displayTicker'] !== null && d['displayTicker'] !== undefined) {
    const t = parseTicker(d['displayTicker']);
    if (!t.ok) return t;
    displayTicker = t.value;
  }

  let primaryMarketIdentifier: Mic | null = null;
  if (d['primaryMarketIdentifier'] !== null && d['primaryMarketIdentifier'] !== undefined) {
    const m = parseMic(d['primaryMarketIdentifier']);
    if (!m.ok) return m;
    primaryMarketIdentifier = m.value;
  }

  const listings = parseListings(d['listings']);
  if (!listings.ok) return listings;
  const aliases = parseAliases(d['aliases']);
  if (!aliases.ok) return aliases;

  return ok({
    identity: identity.value,
    status: status.value,
    display: {
      primaryName: primaryName.value,
      displayTicker,
      primaryMarketIdentifier,
      listings: listings.value,
      aliases: aliases.value,
    },
  });
}
