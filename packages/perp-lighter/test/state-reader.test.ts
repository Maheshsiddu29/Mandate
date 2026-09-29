/**
 * The live Lighter state adapter (Phase 7E.2), offline. The fake state client
 * serves the recorded fixtures (test/fixtures/live-state.json: live testnet
 * captures, sanitized, and schema-derived bodies where live capture needs a
 * funded account), and variants of them built here, each change named.
 *
 * Every failure is checked end to end: the reader returns `UNKNOWN` and no
 * states, and the control engine, given no snapshot, refuses. Where the reader
 * passes an observation through faithfully (cross margin, drifted metadata,
 * an aged snapshot, a foreign order) PerpPolicy or admission refuses it.
 *
 * Mutants: M14 (a failed active-orders read treated as no orders) and M15
 * (cross margin read as isolated) — both killed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccakDigest, type AuthorityTermInput } from '@mandate/core';
import { MAX_MARKED_EXPOSURE, accountOf, activeOrdersOf, markOf, marketStaticOf, maxMarkedExposureParams, parseJson, type MarketStatic, type RawRead, type ReadOnlyTokenSource, type StateClient } from '../src/index.ts';
import { assemble, collect, LighterStateReader, type Reads, type Snapshot } from '../src/state-reader.ts';
import { ACCOUNT, ONCE, SUB_ACCOUNT, T, authorized, btcNotionalDim, btcSizeDim, context, marginDim, order, perpWorld, policy, refusedWith, request, root, setup, type PerpWorld } from './support/world.ts';

const dir = new URL('./fixtures/', import.meta.url);
const text = (f: string) => readFileSync(new URL(f, dir), 'utf8');
const LIVE_PIN = '0x0bdfcec39b98ed9dc1894c77e98823b49ae5d2d28b067538263ecea3e6d20dad';
interface Fixture { name: string; meta: { endpoint: string; network: string; capturedAt: string | null; sdkApi: string; derivation: string; sanitization: string }; http: number; raw: string | null; normalized: unknown }
const LIVE = JSON.parse(text('live-state.json')) as { fixtures: Fixture[] };
const fx = (name: string) => LIVE.fixtures.find((f) => f.name === name) as Fixture;
const OBD_TEXT = text('testnet-order-book-details.json');
const OBD = JSON.parse(OBD_TEXT) as { response: { code: number; order_book_details: { [k: string]: unknown }[] } };
const STATICS = new Map<number, MarketStatic>(OBD.response.order_book_details.map((e) => marketStaticOf(e as never, 300)).filter((m): m is MarketStatic => m !== null).map((m) => [m.marketIndex, m]));
const big = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x))) as unknown;

// --- Bodies ---------------------------------------------------------------------------------

type Pos = { [k: string]: unknown };
/** A position entry in the live account shape (fields as in account-7). */
function pos(marketId: number, o: Pos = {}): Pos {
  return { market_id: marketId, symbol: '', initial_margin_fraction: '5.00', open_order_count: 0, pending_order_count: 0, position_tied_order_count: 0, sign: 1, position: '0.00000', avg_entry_price: '0.0', position_value: '0.000000', unrealized_pnl: '0.000000', realized_pnl: '0.000000', liquidation_price: '0', total_funding_paid_out: '0.000000', margin_mode: 1, margin_set_flag: 1, allocated_margin: '0.000000', ...o };
}

/** The live account-7 body, re-pointed at the test sub-account, with its positions and counts replaced. */
function accountBody(o: { positions?: Pos[]; total?: number; pending?: number; collateral?: string; available?: string; drop?: string } = {}): string {
  const live = JSON.parse(fx('account-7-cross-position').raw as string) as { accounts: { [k: string]: unknown }[] };
  const a = { ...(live.accounts[0] as { [k: string]: unknown }) };
  a['index'] = Number(SUB_ACCOUNT);
  a['account_index'] = Number(SUB_ACCOUNT);
  a['positions'] = o.positions ?? [pos(4096)];
  a['total_order_count'] = o.total ?? 0;
  a['pending_order_count'] = o.pending ?? 0;
  if (o.collateral !== undefined) a['collateral'] = o.collateral;
  if (o.available !== undefined) a['available_balance'] = o.available;
  if (o.drop !== undefined) delete a[o.drop];
  return JSON.stringify({ ...live, accounts: [a] });
}

/** The schema-derived open order, for the test sub-account. */
function ordersBody(orders: { [k: string]: unknown }[]): string {
  return JSON.stringify({ code: 200, next_cursor: '', orders });
}
const OPEN_ORDER = (JSON.parse(fx('active-orders-one-open').raw as string) as { orders: { [k: string]: unknown }[] }).orders[0] as { [k: string]: unknown };

function obdWith(change: (entries: { [k: string]: unknown }[]) => void): string {
  const r = structuredClone(OBD.response);
  change(r.order_book_details);
  return JSON.stringify(r);
}

// --- Fake client ----------------------------------------------------------------------------

type Serve = RawRead | ((call: number) => RawRead);
const ok = (endpoint: string, body: string, status = 200): RawRead => ({ ok: true, endpoint, status, body });

class FakeStateClient implements StateClient {
  accountReply: Serve = ok('/account', accountBody());
  marketsReply: Serve = ok('/orderBookDetails', JSON.stringify(OBD.response));
  orders = new Map<number, Serve>();
  tokens: string[] = [];
  #accountCalls = 0;
  #pick = (s: Serve, n: number) => (typeof s === 'function' ? s(n) : s);

  async account(): Promise<RawRead> {
    this.#accountCalls += 1;
    return this.#pick(this.accountReply, this.#accountCalls);
  }

  async orderBookDetails(): Promise<RawRead> {
    return this.#pick(this.marketsReply, 1);
  }

  async activeOrders(_a: bigint, m: number, token: string): Promise<RawRead> {
    this.tokens.push(token);
    return this.#pick(this.orders.get(m) ?? ok(`/accountActiveOrders?market_id=${m}`, ordersBody([])), 1);
  }
}

const RO: ReadOnlyTokenSource = { token: async () => ({ ok: true, token: 'ro:test-read-only-token' }) };

async function world(terms: readonly AuthorityTermInput[] = []): Promise<{ w: PerpWorld; g: ReturnType<typeof root> }> {
  const w = perpWorld();
  const g = root(w, [btcSizeDim(1_000_000n), btcNotionalDim(10n ** 12n), marginDim(10n ** 12n), ...terms]);
  await setup(w, policy(), [g]);
  return { w, g };
}

function readerFor(w: PerpWorld, client: StateClient, tokens: ReadOnlyTokenSource = RO): LighterStateReader {
  let ms = T * 1_000n;
  return new LighterStateReader({ client, tokens, policy: w.policy, accountIndex: SUB_ACCOUNT, clock: () => (ms += 7n), maxMarkDivergenceBps: 100n });
}

/** Decide a BTC buy on whatever the reader produced: `UNKNOWN` supplies no states. */
async function decide(w: PerpWorld, g: ReturnType<typeof root>, s: Snapshot, at = T + 1n, o: Parameters<typeof order>[2] = {}) {
  return w.engine.authorizeAndReserve(request(order(w, g, o), s.status === 'OK' ? s.states : [], context(at)), ONCE);
}

async function unknown(client: FakeStateClient, reason: RegExp, tokens: ReadOnlyTokenSource = RO): Promise<void> {
  const { w, g } = await world();
  const s = await readerFor(w, client, tokens).read();
  assert.equal(s.status, 'UNKNOWN', 'reader produced a snapshot');
  if (s.status === 'UNKNOWN') assert.match(s.reason, reason);
  refusedWith(await decide(w, g, s));
}

// --- Tests ----------------------------------------------------------------------------------

describe('live state fixtures', () => {
  it('each records endpoint, network, capture date, SDK/API version and derivation, and normalizes to its recorded result', () => {
    for (const f of LIVE.fixtures) {
      assert.ok(f.meta.endpoint.startsWith('GET /api/v1/') && f.meta.network.includes('chain id 300') && f.meta.sdkApi.includes('lighter-go v1.0.10'), f.name);
      assert.ok(f.meta.derivation.startsWith('LIVE') ? f.meta.capturedAt !== null : f.meta.derivation.startsWith('SCHEMA_DERIVED'), f.name);
    }
    const acct = fx('account-7-cross-position');
    assert.doesNotMatch(acct.raw as string, /"l1_address":"0x(?!0{40})/, 'the owner address is sanitized');
    assert.deepEqual(big(accountOf(parseJson(acct.raw as string), 7n, STATICS)), acct.normalized);
    assert.deepEqual(big(activeOrdersOf(parseJson(fx('active-orders-no-auth').raw as string), 7n, STATICS.get(4095) as MarketStatic)), fx('active-orders-no-auth').normalized);
    assert.deepEqual(big(activeOrdersOf(parseJson(fx('active-orders-invalid-token').raw as string), 7n, STATICS.get(4095) as MarketStatic)), fx('active-orders-invalid-token').normalized);
    assert.deepEqual(big(activeOrdersOf(parseJson(fx('active-orders-one-open').raw as string), SUB_ACCOUNT, STATICS.get(4096) as MarketStatic)), fx('active-orders-one-open').normalized);
    assert.deepEqual(big(activeOrdersOf(parseJson(fx('active-orders-empty').raw as string), SUB_ACCOUNT, STATICS.get(4096) as MarketStatic)), fx('active-orders-empty').normalized);
    const marks = Object.fromEntries([4095, 4096, 4097].map((m) => [m, markOf(OBD.response.order_book_details.find((e) => e['market_id'] === m) as never, STATICS.get(m) as MarketStatic, 100n)]));
    assert.deepEqual(big(marks), fx('order-book-details-marks').normalized);
  });

  it('the live account reads Lighter\'s units exactly: IMF percent to ticks, signed size, USDC atoms', () => {
    const n = accountOf(parseJson(fx('account-7-cross-position').raw as string), 7n, STATICS);
    assert.ok(n.ok);
    assert.deepEqual(n.value.positions, [{ marketIndex: 4095, size: -3715n, marginMode: 'CROSS', initialMarginFraction: 500, allocatedMargin: 0n }]);
    assert.equal(n.value.collateral, 9_997_578_346n);
  });

  it('is pinned: the fixture file is a reviewed change', () => {
    assert.equal(keccakDigest(new Uint8Array(readFileSync(new URL('live-state.json', dir)))), LIVE_PIN);
  });
});

describe('live state reader — a consistent read', () => {
  it('assembles market, price and account snapshots the engine authorizes on, with per-read provenance', async () => {
    const { w, g } = await world();
    const c = new FakeStateClient();
    const s = await readerFor(w, c).read();
    assert.equal(s.status, 'OK');
    if (s.status !== 'OK') return;
    assert.equal(s.observedAt, T);
    assert.equal(s.states.length, 7); // 3 markets, 3 prices, 1 account
    authorized(await decide(w, g, s));
    // account → markets → orders for each claimed market → account; every body digested; the token never in an endpoint.
    assert.deepEqual(s.provenance.map((p) => p.endpoint.split('?')[0]), ['/account', '/orderBookDetails', '/accountActiveOrders', '/accountActiveOrders', '/accountActiveOrders', '/account']);
    assert.ok(s.provenance.every((p) => p.status === 200 && /^0x[0-9a-f]{64}$/.test(p.bodyDigest ?? '') && !p.endpoint.includes('ro:') && p.receivedAt >= p.requestedAt));
    assert.deepEqual(c.tokens, ['ro:test-read-only-token', 'ro:test-read-only-token', 'ro:test-read-only-token']);
  });

  it('reads orders in every market the account reports, not only claimed ones', async () => {
    const { w } = await world();
    const c = new FakeStateClient();
    c.accountReply = ok('/account', accountBody({ positions: [pos(4096), pos(4095)] }));
    const s = await readerFor(w, c).read();
    assert.equal(s.status, 'OK');
    const r = await collect({ client: c, tokens: RO, policy: w.policy, accountIndex: SUB_ACCOUNT, clock: () => T * 1_000n, maxMarkDivergenceBps: 100n });
    assert.deepEqual([...r.orders.keys()], [4095, 4096, 4097]);
  });
});

describe('live state reader — failures are UNKNOWN, and UNKNOWN refuses', () => {
  it('account endpoint failure: network error, HTTP error, non-200 code, or a failed re-read', async () => {
    for (const account of [{ ok: false, endpoint: '/account', error: 'TimeoutError' } as RawRead, ok('/account', 'Bad Gateway', 502), ok('/account', '{"code":21100,"message":"account not found"}')]) {
      const c = new FakeStateClient();
      c.accountReply = account;
      await unknown(c, /^ACCOUNT:/);
    }
    const c = new FakeStateClient();
    c.accountReply = (n) => (n === 1 ? ok('/account', accountBody()) : { ok: false, endpoint: '/account', error: 'TimeoutError' });
    await unknown(c, /^ACCOUNT_REREAD:/);
  });

  it('active-orders failure is never "no orders": a network error, an HTTP error, a missing list or a non-200 code', async () => {
    for (const r of [{ ok: false, endpoint: '/accountActiveOrders', error: 'TimeoutError' } as RawRead, ok('/accountActiveOrders', 'oops', 500), ok('/accountActiveOrders', '{"code":200}'), ok('/accountActiveOrders', '{"code":29500,"message":"internal"}')]) {
      const c = new FakeStateClient();
      c.orders.set(4096, r);
      await unknown(c, /^ORDERS_4096:/);
    }
  });

  it('auth-token failure: no token, a standard (not read-only) token, a missing or rejected token at the venue', async () => {
    await unknown(new FakeStateClient(), /^AUTH_TOKEN_UNAVAILABLE:/, { token: async () => ({ ok: false, error: 'CUSTODY_UNREACHABLE' }) });
    const standard = new FakeStateClient();
    await unknown(standard, /^AUTH_TOKEN_NOT_READ_ONLY$/, { token: async () => ({ ok: true, token: '1790640000:281474976710600:5:abcdef' }) });
    assert.deepEqual(standard.tokens, [], 'a standard token is never sent');
    const missing = new FakeStateClient();
    missing.orders.set(4096, ok('/accountActiveOrders', fx('active-orders-no-auth').raw as string, 400));
    await unknown(missing, /ORDERS_AUTH_MISSING/);
    const rejected = new FakeStateClient();
    rejected.orders.set(4096, ok('/accountActiveOrders', fx('active-orders-invalid-token').raw as string, 401));
    await unknown(rejected, /ORDERS_AUTH_REJECTED/);
  });

  it('stale mark: a snapshot older than the price age limit is refused at admission; a mark diverged from its index is UNKNOWN', async () => {
    const { w, g } = await world();
    const s = await readerFor(w, new FakeStateClient()).read();
    assert.equal(s.status, 'OK');
    refusedWith(await decide(w, g, s, T + w.policy.config.maxAge.assetPrice + 1n));
    const c = new FakeStateClient();
    c.marketsReply = ok('/orderBookDetails', obdWith((es) => { (es.find((e) => e['market_id'] === 4096) as { [k: string]: unknown })['mark_price'] = '85000.0'; }));
    await unknown(c, /^PRICE_4096:MARK_INDEX_DIVERGED$/);
    const zero = new FakeStateClient();
    zero.marketsReply = ok('/orderBookDetails', obdWith((es) => { (es.find((e) => e['market_id'] === 4096) as { [k: string]: unknown })['mark_price'] = '0.0'; }));
    await unknown(zero, /^PRICE_4096:MARK_MISSING$/);
  });

  it('market metadata mismatch: passed through as observed, and refused by the pinned version', async () => {
    const { w, g } = await world();
    const c = new FakeStateClient();
    c.marketsReply = ok('/orderBookDetails', obdWith((es) => { (es.find((e) => e['market_id'] === 4096) as { [k: string]: unknown })['min_base_amount'] = '0.00030'; }));
    const s = await readerFor(w, c).read();
    assert.equal(s.status, 'OK');
    refusedWith(await decide(w, g, s));
    const gone = new FakeStateClient();
    gone.marketsReply = ok('/orderBookDetails', obdWith((es) => { es.splice(es.findIndex((e) => e['market_id'] === 4096), 1); }));
    // The account's BTC setting now names a market with no metadata: UNKNOWN before anything is assembled.
    await unknown(gone, /UNKNOWN_MARKET_4096/);
  });

  it('unknown market: a position in a market with no metadata is UNKNOWN, never skipped', async () => {
    const c = new FakeStateClient();
    c.accountReply = ok('/account', accountBody({ positions: [pos(4096), pos(9999)] }));
    await unknown(c, /UNKNOWN_MARKET_9999/);
  });

  it('cross margin: passed through as CROSS and refused by PerpPolicy — on the target market, and beside it (the live account-7 shape)', async () => {
    const { w, g } = await world();
    const c = new FakeStateClient();
    c.accountReply = ok('/account', accountBody({ positions: [pos(4096, { margin_mode: 0 })] }));
    const s = await readerFor(w, c).read();
    assert.ok(s.status === 'OK' && s.book.positions[0]?.marginMode === 'CROSS');
    assert.equal(refusedWith(await decide(w, g, s)).reason, 'CROSS_MARGIN_UNSUPPORTED');
    const beside = new FakeStateClient();
    beside.accountReply = ok('/account', accountBody({ positions: [pos(4096), pos(4095, { margin_mode: 0, sign: -1, position: '0.3715' })] }));
    const s2 = await readerFor(w, beside).read();
    assert.equal(s2.status, 'OK');
    assert.equal(refusedWith(await decide(w, g, s2, T + 1n, { nonce: 1n })).reason, 'CROSS_MARGIN_IN_USE');
  });

  it('an unknown or missing margin mode is UNKNOWN — never read as isolated', async () => {
    for (const [p, reason] of [[pos(4096, { margin_mode: 2 }), /MARGIN_MODE_UNKNOWN/], [pos(4096, { margin_mode: '1' }), /MARGIN_MODE_UNKNOWN/], [(({ margin_mode: _m, ...rest }) => rest)(pos(4096)), /MARGIN_MODE_MISSING/]] as const) {
      const c = new FakeStateClient();
      c.accountReply = ok('/account', accountBody({ positions: [p] }));
      await unknown(c, reason);
    }
  });

  it('a flat market with no margin setting reported is refused, not assumed isolated', async () => {
    const { w, g } = await world();
    const c = new FakeStateClient();
    c.accountReply = ok('/account', accountBody({ positions: [] }));
    const s = await readerFor(w, c).read();
    assert.equal(s.status, 'OK');
    assert.equal(refusedWith(await decide(w, g, s)).reason, 'MARGIN_SETTING_UNKNOWN');
  });

  it('missing position data: a missing field, a missing positions list, missing order counts', async () => {
    const noSize = new FakeStateClient();
    noSize.accountReply = ok('/account', accountBody({ positions: [(({ position: _p, ...rest }) => rest)(pos(4096))] }));
    await unknown(noSize, /POSITION_FIELD_MISSING/);
    const noList = new FakeStateClient();
    noList.accountReply = ok('/account', accountBody({ drop: 'positions' }));
    await unknown(noList, /POSITIONS_MISSING/);
    const noCounts = new FakeStateClient();
    noCounts.accountReply = ok('/account', accountBody({ drop: 'total_order_count' }));
    await unknown(noCounts, /ACCOUNT_ORDER_COUNTS_MISSING/);
  });

  it('malformed amount: excess decimals, a float, a sign where none belongs, text', async () => {
    for (const b of [accountBody({ collateral: '12.3456789' }), accountBody({ available: '-1.000000' }), accountBody({ positions: [pos(4096, { position: '0.000001' })] }), accountBody({ positions: [pos(4096, { position: 'NaN' })] }), accountBody({ positions: [pos(4096, { initial_margin_fraction: '5.001' })] })]) {
      const c = new FakeStateClient();
      c.accountReply = ok('/account', b);
      await unknown(c, /MALFORMED/);
    }
    const c = new FakeStateClient();
    c.orders.set(4096, ok('/accountActiveOrders', ordersBody([{ ...OPEN_ORDER, remaining_base_amount: 0.001 }])));
    c.accountReply = ok('/account', accountBody({ positions: [pos(4096, { open_order_count: 1 })], total: 1 }));
    await unknown(c, /ORDER_FIELD_MISSING/);
  });

  it('inconsistency: the account moved during the read, counts that disagree with the orders read, orders in flight', async () => {
    const moved = new FakeStateClient();
    moved.accountReply = (n) => ok('/account', accountBody({ positions: [pos(4096, { position: n === 1 ? '0.00000' : '0.00100' })] }));
    await unknown(moved, /^ACCOUNT_MOVED_DURING_READ$/);
    const hidden = new FakeStateClient();
    hidden.accountReply = ok('/account', accountBody({ positions: [pos(4096, { open_order_count: 1 })], total: 1 }));
    await unknown(hidden, /^ORDER_COUNT_MISMATCH_4096$/);
    const elsewhere = new FakeStateClient();
    elsewhere.accountReply = ok('/account', accountBody({ total: 1 }));
    await unknown(elsewhere, /^ORDER_COUNT_MISMATCH_TOTAL$/);
    const inFlight = new FakeStateClient();
    inFlight.accountReply = ok('/account', accountBody({ pending: 1 }));
    await unknown(inFlight, /^ORDERS_IN_FLIGHT$/);
    const notOpen = new FakeStateClient();
    notOpen.accountReply = ok('/account', accountBody({ positions: [pos(4096, { open_order_count: 1 })], total: 1 }));
    notOpen.orders.set(4096, ok('/accountActiveOrders', ordersBody([{ ...OPEN_ORDER, status: 'pending' }])));
    await unknown(notOpen, /ORDER_NOT_SETTLED/);
  });

  it('a foreign open order read correctly is passed through, and PerpPolicy refuses the increase', async () => {
    const { w, g } = await world([{ kind: 'STATE_INVARIANT', invariantId: MAX_MARKED_EXPOSURE, version: 1, scope: [ACCOUNT], params: maxMarkedExposureParams(10_000_000n) }]);
    const c = new FakeStateClient();
    c.accountReply = ok('/account', accountBody({ positions: [pos(4096, { open_order_count: 1 })], total: 1 }));
    c.orders.set(4096, ok('/accountActiveOrders', fx('active-orders-one-open').raw as string));
    const s = await readerFor(w, c).read();
    assert.ok(s.status === 'OK' && s.book.openOrders.length === 1);
    assert.deepEqual(refusedWith(await decide(w, g, s)), { code: 'INVARIANT_UNKNOWN', reason: 'FOREIGN_OPEN_ORDER' });
  });
});

describe('live state adapter mutants', () => {
  /** A read in which the orders fetch failed while the account's counts show nothing (the reader cannot know which is true). */
  function failedOrdersClient(): FakeStateClient {
    const c = new FakeStateClient();
    c.orders.set(4096, { ok: false, endpoint: '/accountActiveOrders', error: 'TimeoutError' });
    return c;
  }

  // M14: treat a failed active-orders read as an empty list.
  function m14(reads: Reads): Reads {
    const orders = new Map([...reads.orders].map(([m, r]) => [m, r.ok && r.status === 200 ? r : ok(r.endpoint, '{"code":200,"orders":[]}')]));
    return { ...reads, orders };
  }

  // M15: read cross margin (0) as isolated.
  function m15(reads: Reads): Reads {
    const cross = (r: RawRead | null) => (r !== null && r.ok ? { ...r, body: r.body.replace(/"margin_mode":0/g, '"margin_mode":1') } : r);
    return { ...reads, first: cross(reads.first) as RawRead, second: cross(reads.second) };
  }

  async function run(client: FakeStateClient, mutant: (r: Reads) => Reads): Promise<{ snapshot: Snapshot; authorized: boolean }> {
    const { w, g } = await world();
    let ms = T * 1_000n;
    const o = { client, tokens: RO, policy: w.policy, accountIndex: SUB_ACCOUNT, clock: () => (ms += 7n), maxMarkDivergenceBps: 100n };
    const snapshot = assemble(w.policy, SUB_ACCOUNT, mutant(await collect(o)), 100n);
    return { snapshot, authorized: (await decide(w, g, snapshot)).status === 'AUTHORIZED' };
  }

  const crossClient = (): FakeStateClient => {
    const c = new FakeStateClient();
    c.accountReply = ok('/account', accountBody({ positions: [pos(4096, { margin_mode: 0 })] }));
    return c;
  };

  it('production: a failed orders read yields no snapshot, and a cross market refuses', async () => {
    const failed = await run(failedOrdersClient(), (r) => r);
    assert.ok(failed.snapshot.status === 'UNKNOWN' && !failed.authorized);
    assert.equal((await run(crossClient(), (r) => r)).authorized, false);
  });

  it('killed: M14 treats a failed active-orders fetch as no orders', async () => {
    const r = await run(failedOrdersClient(), m14);
    assert.ok(r.snapshot.status === 'OK' && r.authorized, 'the mutant produced a snapshot from a failed read, and it authorized');
  });

  it('killed: M15 accepts CROSS for an isolated-only risk-increasing action', async () => {
    assert.equal((await run(crossClient(), m15)).authorized, true);
  });
});
