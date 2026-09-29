/**
 * The live Lighter state adapter (Phase 7E.2; live-state-adapter.md).
 *
 * `LighterStateReader.read()` turns Lighter's API into the snapshots
 * PerpPolicy v1 asks for — `perp.market`, `perp.asset-price` and
 * `perp.account` — or into `UNKNOWN`, which admits nothing: with no snapshot
 * the control engine refuses. It never guesses:
 *
 * - **Bracketed account read.** account → market metadata → every relevant
 *   market's active orders → account again. The two account reads must agree
 *   on positions, margin settings and order counts; otherwise the state moved
 *   under the read and the snapshot is `UNKNOWN`.
 * - **Orders are read, never inferred.** Active orders are fetched for every
 *   claimed market and every market the account reports; a failed, rejected or
 *   malformed read is `UNKNOWN`, never "no orders". The account's own counts
 *   must equal what was read (all markets, each market), and nothing may be in
 *   flight.
 * - **Margin mode is read, never defaulted.** Cross, a missing mode or an
 *   unknown code are passed through or refused by the normalizer — never
 *   read as isolated; PerpPolicy refuses anything but `ISOLATED`.
 * - **Marks are checked.** Mark and index must agree within a bound; the
 *   higher is used, rounded up.
 * - **Per-read provenance.** Every read — endpoint (never the token), request
 *   and response times, HTTP status and the keccak-256 digest of the exact
 *   body — is returned with the snapshot, for evidence and 7F.
 * - **Read-only auth.** Active orders need an auth token. The reader accepts
 *   only a read-only token (`ro:` prefix) from its token source; a standard
 *   auth token also authorizes account-configuration endpoints and is refused
 *   (security-boundary.md §7).
 *
 * `observedAt` is the time the first read was *requested*: ages are counted
 * from the earliest moment the snapshot could describe.
 */

import { keccakDigest, validateStateEnvelope, type ResourceIdInput } from '@mandate/core';
import { statePayloadDigest, type SuppliedState } from '@mandate/control';
import type { CheckedClaim } from './market.ts';
import { accountOf, activeOrdersOf, isObject, marketStaticOf, markOf, parseJson, type AccountObservation, type Json, type Normalized } from './normalize.ts';
import { PRICE_LADDER, STATE_LADDER, type PerpPolicy } from './policy.ts';
import type { RawRead, StateClient } from './venue.ts';
import {
  STATE_ACCOUNT,
  STATE_ASSET_PRICE,
  STATE_MARKET,
  accountResource,
  encodeAccountBook,
  encodeAssetPrice,
  encodeMarketStatic,
  marketResource,
  type MarketStatic,
  type OpenOrderEntry,
} from './vocabulary.ts';

/** Where the read-only auth token comes from: a credential boundary the agent cannot reach. */
export interface ReadOnlyTokenSource {
  token(): Promise<{ readonly ok: true; readonly token: string } | { readonly ok: false; readonly error: string }>;
}

export interface Provenance {
  readonly endpoint: string;
  /** Milliseconds. */
  readonly requestedAt: bigint;
  readonly receivedAt: bigint;
  readonly status: number | null;
  /** keccak-256 of the exact response body, or `null` when none arrived. */
  readonly bodyDigest: string | null;
  readonly error: string | null;
}

export type Snapshot =
  | { readonly status: 'OK'; readonly observedAt: bigint; readonly states: readonly SuppliedState[]; readonly book: AccountObservation & { readonly openOrders: readonly OpenOrderEntry[] }; readonly provenance: readonly Provenance[] }
  | { readonly status: 'UNKNOWN'; readonly reason: string; readonly provenance: readonly Provenance[] };

export interface StateReaderOptions {
  readonly client: StateClient;
  readonly tokens: ReadOnlyTokenSource;
  readonly policy: PerpPolicy;
  readonly accountIndex: bigint;
  /** Milliseconds. */
  readonly clock: () => bigint;
  /** Largest mark/index divergence accepted, in basis points of the index. */
  readonly maxMarkDivergenceBps: bigint;
}

/** Everything read, raw, before any interpretation. */
export interface Reads {
  readonly first: RawRead;
  readonly markets: RawRead;
  readonly orders: ReadonlyMap<number, RawRead>;
  readonly second: RawRead | null;
  readonly provenance: readonly Provenance[];
  /** Set when the read stopped early (no token, a failed prerequisite). */
  readonly stopped: string | null;
}

const READ_ONLY_TOKEN = /^ro:\S+$/;

async function timed(clock: () => bigint, provenance: Provenance[], read: () => Promise<RawRead>): Promise<RawRead> {
  const requestedAt = clock();
  const r = await read();
  const receivedAt = clock();
  provenance.push(
    r.ok
      ? { endpoint: r.endpoint, requestedAt, receivedAt, status: r.status, bodyDigest: keccakDigest(new TextEncoder().encode(r.body)), error: null }
      : { endpoint: r.endpoint, requestedAt, receivedAt, status: null, bodyDigest: null, error: r.error },
  );
  return r;
}

function body(r: RawRead): Normalized<Json> {
  if (!r.ok) return { ok: false, reason: `FETCH_FAILED:${r.error}` };
  if (r.status !== 200) {
    // Lighter reports some refusals with an HTTP error status and a JSON code; keep the code when there is one.
    const j = parseJson(r.body);
    const code = isObject(j ?? undefined) ? (j as { readonly [k: string]: Json })['code'] : undefined;
    return { ok: false, reason: code === 20001 ? 'ORDERS_AUTH_MISSING' : code === 20013 ? 'ORDERS_AUTH_REJECTED' : `HTTP_${r.status}` };
  }
  const j = parseJson(r.body);
  return j === null ? { ok: false, reason: 'REPLY_NOT_JSON' } : { ok: true, value: j };
}

function marketsOf(r: RawRead, chainId: number): Normalized<{ statics: Map<number, MarketStatic>; entries: Map<number, Json> }> {
  const b = body(r);
  if (!b.ok) return b;
  const j = b.value;
  if (!isObject(j ?? undefined)) return { ok: false, reason: 'MARKETS_REPLY_MALFORMED' };
  const o = j as { readonly [k: string]: Json };
  const list = o['order_book_details'];
  if (o['code'] !== 200 || !Array.isArray(list)) return { ok: false, reason: 'MARKETS_REPLY_MALFORMED' };
  const statics = new Map<number, MarketStatic>();
  const entries = new Map<number, Json>();
  for (const e of list as readonly Json[]) {
    const m = marketStaticOf(e, chainId);
    // Entries that are not v1 perps are not interpreted; a position in one is an unknown market.
    if (m === null) continue;
    if (statics.has(m.marketIndex)) return { ok: false, reason: 'MARKET_DUPLICATED' };
    statics.set(m.marketIndex, m);
    entries.set(m.marketIndex, e);
  }
  return { ok: true, value: { statics, entries } };
}

/** The markets whose active orders must be read: every claimed market and every market the account reports. */
export function orderMarkets(policy: PerpPolicy, account: AccountObservation): number[] {
  const set = new Set<number>(policy.claims.map((c) => c.static.marketIndex));
  for (const p of account.positions) set.add(p.marketIndex);
  return [...set].sort((a, b) => a - b);
}

/** Performs the reads, in bracket order. No interpretation beyond what choosing the next read needs. */
export async function collect(o: StateReaderOptions): Promise<Reads> {
  const provenance: Provenance[] = [];
  const first = await timed(o.clock, provenance, () => o.client.account(o.accountIndex));
  const markets = await timed(o.clock, provenance, () => o.client.orderBookDetails());
  const orders = new Map<number, RawRead>();
  const stop = (why: string): Reads => ({ first, markets, orders, second: null, provenance, stopped: why });
  const ms = marketsOf(markets, o.policy.config.chainId);
  if (!ms.ok) return stop(`MARKETS:${ms.reason}`);
  const fb = body(first);
  if (!fb.ok) return stop(`ACCOUNT:${fb.reason}`);
  const a = accountOf(fb.value, o.accountIndex, ms.value.statics);
  if (!a.ok) return stop(`ACCOUNT:${a.reason}`);
  const t = await o.tokens.token();
  if (!t.ok) return stop(`AUTH_TOKEN_UNAVAILABLE:${t.error}`);
  if (!READ_ONLY_TOKEN.test(t.token)) return stop('AUTH_TOKEN_NOT_READ_ONLY');
  for (const m of orderMarkets(o.policy, a.value)) orders.set(m, await timed(o.clock, provenance, () => o.client.activeOrders(o.accountIndex, m, t.token)));
  const second = await timed(o.clock, provenance, () => o.client.account(o.accountIndex));
  return { first, markets, orders, second, provenance, stopped: null };
}

function sameAccount(a: AccountObservation, b: AccountObservation): boolean {
  const key = (x: AccountObservation) =>
    JSON.stringify({ p: x.positions.map((p) => ({ ...p, size: p.size.toString(), allocatedMargin: p.allocatedMargin.toString() })), c: x.counts });
  return key(a) === key(b);
}

function envelopeOf(policy: PerpPolicy, stateKind: string, subject: ResourceIdInput, payload: Uint8Array, sourceId: string, finality: { ladder: string; level: string }, observedAt: bigint): Normalized<SuppliedState> {
  const ref = policy.ref;
  const e = validateStateEnvelope({
    module: { domainId: ref.domainId, moduleId: ref.moduleId, moduleVersion: ref.moduleVersion, moduleDigest: ref.moduleDigest },
    stateKind,
    subject,
    sourceId,
    trustClass: 'VERIFIED',
    observedAt,
    sequence: { kind: 'NONE' },
    validUntil: null,
    finality,
    payloadDigest: statePayloadDigest(ref, payload),
  });
  return e.ok ? { ok: true, value: { envelope: e.value, payload } } : { ok: false, reason: `ENVELOPE_${e.error.code}` };
}

/** Pure: the reads → a snapshot, or `UNKNOWN` with the first reason found. */
export function assemble(policy: PerpPolicy, accountIndex: bigint, reads: Reads, maxMarkDivergenceBps: bigint): Snapshot {
  const unknown = (reason: string): Snapshot => ({ status: 'UNKNOWN', reason, provenance: reads.provenance });
  if (reads.stopped !== null) return unknown(reads.stopped);
  if (reads.second === null) return unknown('ACCOUNT_NOT_REREAD');
  const chainId = policy.config.chainId;
  const ms = marketsOf(reads.markets, chainId);
  if (!ms.ok) return unknown(`MARKETS:${ms.reason}`);
  const account = (r: RawRead): Normalized<AccountObservation> => {
    const b = body(r);
    return b.ok ? accountOf(b.value, accountIndex, ms.value.statics) : b;
  };
  const first = account(reads.first);
  const second = account(reads.second);
  if (!first.ok) return unknown(`ACCOUNT:${first.reason}`);
  if (!second.ok) return unknown(`ACCOUNT_REREAD:${second.reason}`);
  if (!sameAccount(first.value, second.value)) return unknown('ACCOUNT_MOVED_DURING_READ');
  const a = first.value;

  // Orders: every required market read, and read successfully; counts must match.
  const openOrders: OpenOrderEntry[] = [];
  for (const m of orderMarkets(policy, a)) {
    const r = reads.orders.get(m);
    if (r === undefined) return unknown(`ORDERS_NOT_READ_${m}`);
    const b = body(r);
    if (!b.ok) return unknown(`ORDERS_${m}:${b.reason}`);
    const st = ms.value.statics.get(m);
    if (st === undefined) return unknown(`UNKNOWN_MARKET_${m}`);
    const o = activeOrdersOf(b.value, accountIndex, st);
    if (!o.ok) return unknown(`ORDERS_${m}:${o.reason}`);
    const reported = a.counts.perMarket.find((c) => c.marketIndex === m);
    if ((reported?.open ?? 0) !== o.value.length) return unknown(`ORDER_COUNT_MISMATCH_${m}`);
    openOrders.push(...o.value);
  }
  if (a.counts.pending !== 0 || a.counts.perMarket.some((c) => c.pending !== 0)) return unknown('ORDERS_IN_FLIGHT');
  if (a.counts.total !== openOrders.length) return unknown('ORDER_COUNT_MISMATCH_TOTAL');

  const first0 = reads.provenance[0];
  if (first0 === undefined) return unknown('NO_PROVENANCE');
  const observedAt = first0.requestedAt / 1_000n;
  const src = policy.config.sources;
  const states: SuppliedState[] = [];
  for (const c of policy.claims as readonly CheckedClaim[]) {
    const live = ms.value.statics.get(c.static.marketIndex);
    if (live === undefined) return unknown(`CLAIMED_MARKET_MISSING_${c.static.marketIndex}`);
    // The observed metadata, as observed: PerpPolicy's VERSION pin refuses it if it is not the reviewed claim.
    const market = envelopeOf(policy, STATE_MARKET, marketResource(chainId, live.marketIndex), encodeMarketStatic(live), src.market, { ladder: STATE_LADDER.ladder, level: 'SEQUENCED' }, observedAt);
    if (!market.ok) return unknown(market.reason);
    const mark = markOf(ms.value.entries.get(live.marketIndex) ?? null, live, maxMarkDivergenceBps);
    if (!mark.ok) return unknown(`PRICE_${live.marketIndex}:${mark.reason}`);
    const asset = { domain: c.asset.domain, kind: c.asset.kind, localId: c.asset.localId };
    const price = envelopeOf(policy, STATE_ASSET_PRICE, asset, encodeAssetPrice(asset, mark.value), src.assetPrice, { ladder: PRICE_LADDER.ladder, level: 'PUBLISHED' }, observedAt);
    if (!price.ok) return unknown(price.reason);
    states.push(market.value, price.value);
  }
  const minCollateral = a.collateral < second.value.collateral ? a.collateral : second.value.collateral;
  const minAvailable = a.availableBalance < second.value.availableBalance ? a.availableBalance : second.value.availableBalance;
  const bookAccount = accountResource(chainId, accountIndex);
  const book = envelopeOf(
    policy,
    STATE_ACCOUNT,
    bookAccount,
    encodeAccountBook({ account: bookAccount, collateral: minCollateral, availableBalance: minAvailable, positions: a.positions, openOrders }),
    src.account,
    { ladder: STATE_LADDER.ladder, level: 'SEQUENCED' },
    observedAt,
  );
  if (!book.ok) return unknown(book.reason);
  states.push(book.value);
  return { status: 'OK', observedAt, states, book: { ...a, collateral: minCollateral, availableBalance: minAvailable, openOrders }, provenance: reads.provenance };
}

export class LighterStateReader {
  readonly #o: StateReaderOptions;

  constructor(o: StateReaderOptions) {
    this.#o = o;
  }

  async read(): Promise<Snapshot> {
    return assemble(this.#o.policy, this.#o.accountIndex, await collect(this.#o), this.#o.maxMarkDivergenceBps);
  }
}
