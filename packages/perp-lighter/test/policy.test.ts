/**
 * PerpPolicy v1 through the real control engine: the four quantities and
 * their exact arithmetic, isolated margin as a module rule, market identity
 * by reviewed claim, pending orders projected in full, a cancel that releases
 * nothing, foreign open orders, leverage and direction invariants with
 * semantic narrowing, reduce-only reserved in full, and the cross-domain
 * cancel/replace scenario of perp-policy-v1.md §10.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reservationIdFor, validateAuthorityGrant, authorityId, type AuthorityTermInput } from '@mandate/core';
import { encodeAggregateParams, AGGREGATE_INVARIANT_ID } from '@mandate/control';
import {
  ALLOWED_DIRECTION,
  MAX_LEVERAGE,
  MAX_MARKED_EXPOSURE,
  ORDER_NOTIONAL_BOUND,
  allowedDirectionParams,
  checkClaim,
  clientOrderIndexFor,
  createPerpPolicy,
  maxLeverageParams,
  maxMarkedExposureParams,
  type LighterMarketClaim,
} from '../src/index.ts';
import { createSyntheticModule, markState as synthMark, instrumentsState as synthInstruments, positionState as synthPosition, action as synthAction, SPOT_CFG, FEED_SOURCE, VENUE_SOURCE, REGISTRY_SOURCE, MARK, POSITION, INSTRUMENTS, account as synthAccount, ADAPTER as SYNTH_ADAPTER, capitalDim } from '../../control/test/support/builders.ts';
import {
  ACCOUNT,
  AGENT,
  BTC_ASSET,
  BTC_MARKET,
  BTC_PRICE_LIGHTER,
  CONFIG,
  ETH_MARKET,
  ONCE,
  P,
  T,
  T0,
  T_END,
  authorized,
  btcNotionalDim,
  btcSizeDim,
  cancel,
  context,
  coverage,
  marginDim,
  must,
  order,
  perpWorld,
  policy,
  refusedWith,
  request,
  root,
  setup,
  states,
  type PerpWorld,
} from './support/world.ts';

const inv = (w: PerpWorld, id: string, params: string): AuthorityTermInput => ({ kind: 'STATE_INVARIANT', invariantId: id, version: w.policy.ref.moduleVersion, scope: [ACCOUNT], params });

async function world(terms: readonly AuthorityTermInput[] = []): Promise<{ w: PerpWorld; g: ReturnType<typeof root> }> {
  const w = perpWorld();
  const g = root(w, [btcSizeDim(1_000_000n), btcNotionalDim(1_000_000_000_000n), marginDim(1_000_000_000_000n), ...terms]);
  await setup(w, policy(), [g]);
  return { w, g };
}

describe('PerpPolicy v1 — quantities and demands', () => {
  it('reserves position size, committed notional and margin, each in its own kind and unit, exactly', async () => {
    const { w, g } = await world();
    // 0.00100 BTC at 83,625.0 — notional 83.625000 USDC; IMF 500 (5 %): margin 4.181250 + fee headroom 0.1 % 0.083625.
    const rec = authorized(await w.engine.authorizeAndReserve(request(order(w, g), states(w)), ONCE));
    const r = (await w.store.read(rec.principal)).state.reservations.get(rec.reservation);
    const byKind = new Map(r?.demands.map((d) => [d.contribution.quantity.kind, d.contribution.quantity]));
    assert.deepEqual([byKind.get('POSITION_SIZE')?.atoms, byKind.get('POSITION_SIZE')?.unit, byKind.get('POSITION_SIZE')?.decimals], [100n, 'UNIT', 5]);
    assert.deepEqual([byKind.get('NOTIONAL')?.atoms, byKind.get('NOTIONAL')?.unit, byKind.get('NOTIONAL')?.decimals], [83_625_000n, 'USDC', 6]);
    assert.equal(byKind.get('NOTIONAL')?.valuation?.basis, 'LIMIT');
    assert.deepEqual([byKind.get('MARGIN')?.atoms, byKind.get('MARGIN')?.unit], [4_181_250n + 83_625n, 'USDC']);
    assert.equal(byKind.get('POSITION_SIZE')?.asset?.localId, 'crypto:btc');
    // Margin is charged to the collateral representation, never added to notional.
    assert.equal(byKind.get('MARGIN')?.asset?.kind, 'REPRESENTATION_ASSET');
  });

  it('a reduce-only order still reserves its full worst case: the flag is never relied on to reserve less', async () => {
    const { w, g } = await world();
    const rec = authorized(await w.engine.authorizeAndReserve(request(order(w, g, { side: 'SELL', reduceOnly: true }), states(w, { book: { positions: [{ marketIndex: 4096, size: 500n, marginMode: 'ISOLATED', initialMarginFraction: 500, allocatedMargin: 0n }] } })), ONCE));
    const r = (await w.store.read(rec.principal)).state.reservations.get(rec.reservation);
    assert.equal(r?.demands.find((d) => d.contribution.quantity.kind === 'NOTIONAL')?.reserved, 83_625_000n);
  });

  it('the order-notional bound caps a single order', async () => {
    const { w, g } = await world([{ kind: 'BOUND', boundId: ORDER_NOTIONAL_BOUND, polarity: 'MAX', value: { type: 'QUANTITY', quantity: { kind: 'NOTIONAL', unit: 'USDC', decimals: 6, atoms: 50_000_000n } } }]);
    assert.equal(refusedWith(await w.engine.authorizeAndReserve(request(order(w, g), states(w)), ONCE)).code, 'ACTION_NOT_COVERED');
    authorized(await w.engine.authorizeAndReserve(request(order(w, g, { baseAmount: 50n }), states(w)), ONCE));
  });

  it('the position-size and committed-notional dimensions refuse what would exceed them', async () => {
    const w = perpWorld();
    const g = root(w, [btcSizeDim(150n), btcNotionalDim(1_000_000_000_000n), marginDim(1_000_000_000_000n)]);
    await setup(w, policy(), [g]);
    authorized(await w.engine.authorizeAndReserve(request(order(w, g), states(w)), ONCE));
    assert.equal(refusedWith(await w.engine.authorizeAndReserve(request(order(w, g, { nonce: 1n }), states(w)), ONCE)).code, 'AUTHORITY_UNAVAILABLE');
  });
});

describe('PerpPolicy v1 — isolated margin only', () => {
  it('refuses an order on a cross-margined market, beside a cross position, or where the setting is unknown', async () => {
    const { w, g } = await world();
    const cross = await w.engine.authorizeAndReserve(request(order(w, g), states(w, { book: { positions: [{ marketIndex: 4096, size: 0n, marginMode: 'CROSS', initialMarginFraction: 500, allocatedMargin: 0n }] } })), ONCE);
    assert.deepEqual(refusedWith(cross), { code: 'DEMAND_INVALID', reason: 'CROSS_MARGIN_UNSUPPORTED' });
    const beside = await w.engine.authorizeAndReserve(
      request(order(w, g), states(w, { book: { positions: [{ marketIndex: 4096, size: 0n, marginMode: 'ISOLATED', initialMarginFraction: 500, allocatedMargin: 0n }, { marketIndex: 4095, size: 10n, marginMode: 'CROSS', initialMarginFraction: 500, allocatedMargin: 0n }] } })),
      ONCE,
    );
    assert.deepEqual(refusedWith(beside), { code: 'DEMAND_INVALID', reason: 'CROSS_MARGIN_IN_USE' });
    const unknown = await w.engine.authorizeAndReserve(request(order(w, g), states(w, { book: { positions: [] } })), ONCE);
    assert.deepEqual(refusedWith(unknown), { code: 'DEMAND_INVALID', reason: 'MARGIN_SETTING_UNKNOWN' });
  });
});

describe('PerpPolicy v1 — market identity', () => {
  it('a market is exposure to the asset its reviewed claim names, never to its ticker', async () => {
    const [btc] = CONFIG.claims as LighterMarketClaim[];
    // A claim whose symbol says BTC but whose reviewed underlying is ETH is ETH exposure.
    const liar: LighterMarketClaim = { ...(btc as LighterMarketClaim), underlying: { domain: 'registry', kind: 'CANONICAL_ASSET', localId: 'crypto:eth' } };
    const p = createPerpPolicy({ ...CONFIG, claims: [liar] });
    assert.equal(p.claims[0]?.asset.localId, 'crypto:eth');
    assert.equal(p.claims[0]?.static.symbol, 'BTC');
    assert.notEqual(p.ref.moduleDigest, createPerpPolicy(CONFIG).ref.moduleDigest);
  });

  it('refuses claims it cannot represent exactly: a non-unit multiplier, inexact notional, another chain', () => {
    const [btc] = CONFIG.claims as LighterMarketClaim[];
    const b = btc as LighterMarketClaim;
    assert.deepEqual(checkClaim({ ...b, static: { ...b.static, multiplier: '1000.000000000000000000' } }, 300), { ok: false, reason: 'MULTIPLIER_UNSUPPORTED' });
    assert.deepEqual(checkClaim({ ...b, static: { ...b.static, priceDecimals: 2 } }, 300), { ok: false, reason: 'NOTIONAL_NOT_EXACT_IN_COLLATERAL' });
    assert.deepEqual(checkClaim(b, 304), { ok: false, reason: 'CHAIN_MISMATCH' });
    assert.deepEqual(checkClaim({ ...b, underlying: { domain: 'lighter-perp', kind: 'MARKET', localId: 'x' } }, 300), { ok: false, reason: 'UNDERLYING_NOT_CANONICAL' });
  });

  it('refuses an unclaimed market, and a market outside the grant', async () => {
    const { w, g } = await world();
    const unclaimed = await w.engine.authorizeAndReserve(request(order(w, g, { market: { domain: 'lighter-perp', kind: 'MARKET', localId: 'lighter:300:market:9999' } }), states(w)), ONCE);
    assert.equal(refusedWith(unclaimed).reason, 'MARKET_UNCLAIMED');
    const w2 = perpWorld();
    const onlyEth = must(validateAuthorityGrant({ lineage: { kind: 'ROOT', issuer: P }, principal: P, holder: AGENT, notBefore: T0, expiresAt: T_END, terms: [...(await import('./support/world.ts')).coverage(w2, [ETH_MARKET]), btcSizeDim(1_000_000n), btcNotionalDim(10n ** 12n), marginDim(10n ** 12n)], nonce: 0n }));
    await setup(w2, policy(), [onlyEth]);
    assert.equal(refusedWith(await w2.engine.authorizeAndReserve(request(order(w2, onlyEth), states(w2)), ONCE)).code, 'ACTION_NOT_COVERED');
  });

  it('refuses a snapshot whose market metadata differs from the reviewed claim (pinned version)', async () => {
    const { w, g } = await world();
    const s = states(w);
    const [btc] = w.policy.claims;
    const changed = (await import('./support/world.ts')).marketState(w, { ...(btc as NonNullable<typeof btc>), static: { ...(btc as NonNullable<typeof btc>).static, sizeDecimals: 4, priceDecimals: 2 } });
    const out = await w.engine.authorizeAndReserve(request(order(w, g), [changed, ...s.slice(1)]), ONCE);
    assert.equal(refusedWith(out).code, 'STATE_STALE');
  });
});

describe('PerpPolicy v1 — pending exposure and cancels', () => {
  it('an unresolved order counts in full; a cancel request, even authorized, releases nothing', async () => {
    // 5,000 USD account marked-exposure limit; each order is 0.04 BTC ≈ 3,345 USD at 83,625.
    const { w, g } = await world([{ kind: 'STATE_INVARIANT', invariantId: MAX_MARKED_EXPOSURE, version: 1, scope: [ACCOUNT], params: maxMarkedExposureParams(500_000n) }]);
    const first = authorized(await w.engine.authorizeAndReserve(request(order(w, g, { baseAmount: 4_000n }), states(w)), ONCE));
    const second = await w.engine.authorizeAndReserve(request(order(w, g, { baseAmount: 4_000n, nonce: 1n }), states(w, { book: { openOrders: [{ marketIndex: 4096, clientOrderIndex: clientOrderIndexFor(first.reservation), isAsk: false, remainingBaseAmount: 4_000n, price: BTC_PRICE_LIGHTER, reduceOnly: false }] } })), ONCE);
    assert.deepEqual(refusedWith(second), { code: 'INVARIANT_FAILED', reason: 'MARKED_EXPOSURE_EXCEEDED' });
    // Cancel the first: authorized as its own action, reserving only a count.
    const c = authorized(await w.engine.authorizeAndReserve(request(cancel(w, g, { target: first.reservation, nonce: 2n }), states(w)), ONCE));
    const after = (await w.store.read(c.principal)).state;
    assert.equal(after.reservations.get(first.reservation)?.status, 'ACTIVE');
    assert.ok(after.reservations.get(first.reservation)?.demands.every((d) => d.released === 0n));
    // The replacement is still refused: nothing was released.
    const replaced = await w.engine.authorizeAndReserve(request(order(w, g, { baseAmount: 4_000n, nonce: 3n }), states(w)), ONCE);
    assert.deepEqual(refusedWith(replaced), { code: 'INVARIANT_FAILED', reason: 'MARKED_EXPOSURE_EXCEEDED' });
    // Only what remains fits: 0.01 BTC more.
    authorized(await w.engine.authorizeAndReserve(request(order(w, g, { baseAmount: 1_000n, nonce: 4n }), states(w)), ONCE));
  });

  it('a cancel may only name a pending Mandate reservation', async () => {
    const { w, g } = await world();
    const out = await w.engine.authorizeAndReserve(request(cancel(w, g, { target: reservationIdFor(('0x' + '1'.repeat(64)) as never, 1n as never) }), states(w)), ONCE);
    assert.equal(refusedWith(out).reason, 'CANCEL_TARGET_NOT_PENDING');
  });

  it('an open order no pending reservation accounts for was placed outside Mandate: every invariant is UNKNOWN', async () => {
    const { w, g } = await world([{ kind: 'STATE_INVARIANT', invariantId: MAX_MARKED_EXPOSURE, version: 1, scope: [ACCOUNT], params: maxMarkedExposureParams(10_000_000n) }]);
    const out = await w.engine.authorizeAndReserve(request(order(w, g), states(w, { book: { openOrders: [{ marketIndex: 4096, clientOrderIndex: 42n, isAsk: false, remainingBaseAmount: 100n, price: 1n, reduceOnly: false }] } })), ONCE);
    assert.deepEqual(refusedWith(out), { code: 'INVARIANT_UNKNOWN', reason: 'FOREIGN_OPEN_ORDER' });
  });
});

describe('PerpPolicy v1 — leverage and direction', () => {
  it('max leverage reads the market\'s margin setting: 1 / IMF, rounded against the actor', async () => {
    const { w, g } = await world([inv(perpWorld(), MAX_LEVERAGE, maxLeverageParams(10n, 0))]);
    // IMF 500 → 20x > 10x.
    assert.deepEqual(refusedWith(await w.engine.authorizeAndReserve(request(order(w, g), states(w)), ONCE)), { code: 'INVARIANT_FAILED', reason: 'LEVERAGE_EXCEEDED' });
    // IMF 1000 → 10x.
    authorized(await w.engine.authorizeAndReserve(request(order(w, g), states(w, { book: { positions: [{ marketIndex: 4096, size: 0n, marginMode: 'ISOLATED', initialMarginFraction: 1_000, allocatedMargin: 0n }] } })), ONCE));
  });

  it('allowed direction: a short-only mandate refuses a buy and allows a sell', async () => {
    const { w, g } = await world([inv(perpWorld(), ALLOWED_DIRECTION, allowedDirectionParams('SHORT_ONLY'))]);
    assert.deepEqual(refusedWith(await w.engine.authorizeAndReserve(request(order(w, g), states(w)), ONCE)), { code: 'INVARIANT_FAILED', reason: 'DIRECTION_NOT_ALLOWED' });
    authorized(await w.engine.authorizeAndReserve(request(order(w, g, { side: 'SELL' }), states(w)), ONCE));
  });

  it('delegation narrowing is proven by the module\'s own noWeaker: a child may not loosen leverage, exposure or direction', async () => {
    const w = perpWorld();
    const parent = root(w, [btcSizeDim(10n ** 6n), btcNotionalDim(10n ** 12n), marginDim(10n ** 12n), inv(w, MAX_LEVERAGE, maxLeverageParams(5n, 0)), inv(w, MAX_MARKED_EXPOSURE, maxMarkedExposureParams(100_000n)), inv(w, ALLOWED_DIRECTION, allowedDirectionParams('LONG_ONLY'))], { delegate: 1 });
    await setup(w, policy(), [parent]);
    const childOf = (terms: AuthorityTermInput[]) =>
      must(validateAuthorityGrant({ lineage: { kind: 'DELEGATION', parent: authorityId(parent), issuer: P }, principal: P, holder: AGENT, notBefore: T0, expiresAt: T_END, terms: [...coverage(w), ...terms], nonce: 0n }));
    const base = [inv(w, MAX_LEVERAGE, maxLeverageParams(5n, 0)), inv(w, MAX_MARKED_EXPOSURE, maxMarkedExposureParams(100_000n)), inv(w, ALLOWED_DIRECTION, allowedDirectionParams('LONG_ONLY'))];
    const looser = [
      [inv(w, MAX_LEVERAGE, maxLeverageParams(10n, 0)), base[1], base[2]],
      [base[0], inv(w, MAX_MARKED_EXPOSURE, maxMarkedExposureParams(200_000n)), base[2]],
      [base[0], base[1], inv(w, ALLOWED_DIRECTION, allowedDirectionParams('BOTH'))],
    ] as AuthorityTermInput[][];
    for (const terms of looser) {
      const r = await w.engine.registerDelegation(childOf(terms), T0, ONCE);
      assert.equal(r.status, 'REFUSED');
      if (r.status === 'REFUSED' && r.refusal.detail.kind === 'DELEGATION') {
        assert.equal(r.refusal.code, 'DELEGATION_REFUSED');
        assert.deepEqual(r.refusal.detail.violations.map((v) => v.code), ['DELEGATION_WEAKENS_INVARIANT']);
      } else assert.fail('expected a delegation refusal');
    }
    const tighter = await w.engine.registerDelegation(childOf([inv(w, MAX_LEVERAGE, maxLeverageParams(3n, 0)), inv(w, MAX_MARKED_EXPOSURE, maxMarkedExposureParams(50_000n)), base[2] as AuthorityTermInput]), T0, ONCE);
    assert.equal(tighter.status, 'REGISTERED');
  });
});

describe('cross-domain cancel/replace (perp-policy-v1.md §10)', () => {
  it('an unresolved Lighter order blocks a spot buy on another domain until only the remaining authority fits', async () => {
    const spot = createSyntheticModule({ ...SPOT_CFG, valuation: 'ASSET' });
    const w = perpWorld({ extra: [spot], extraAdapters: [SYNTH_ADAPTER] });
    const spotAcct = synthAccount(spot);
    // Principal-global: BTC gross exposure across Lighter perps and the spot domain ≤ 5,000.00 USD, at one shared observation of BTC.
    const aggregate: AuthorityTermInput = {
      kind: 'STATE_INVARIANT',
      invariantId: AGGREGATE_INVARIANT_ID,
      version: 1,
      scope: [BTC_ASSET, ACCOUNT, spotAcct],
      params: encodeAggregateParams({ kind: 'GROSS_EXPOSURE', unit: 'USD' as never, decimals: 2, limit: 500_000n, contributors: [w.policy.ref, spot.ref] }),
    };
    const g = root(w, [btcSizeDim(10n ** 6n), btcNotionalDim(10n ** 12n), marginDim(10n ** 12n), capitalDim('spot-capital', 1_000_000)], {
      extra: [spot],
      markets: [spot.market('x:BTC-SPOT'), spot.market('x:ETH-SPOT')],
      actionTypes: [{ domain: spot.ref.domainId, actionType: 'synth.open' }, { domain: spot.ref.domainId, actionType: 'synth.close' }],
      adapters: [SYNTH_ADAPTER],
    });
    await setup(w, policy([aggregate as never]), [g]);
    // BTC at 100,000.00 — one observation shared by both modules (same source, time and price).
    const price = 10_000_000n;
    const perpStates = states(w, { btc: price });
    const spotStates = [synthMark(spot, 'x:BTC-SPOT', price), synthMark(spot, 'x:ETH-SPOT', 269_100n), synthInstruments(spot), synthPosition(spot, spotAcct)];
    // One source for the canonical BTC price, configured for both domains' price kinds: a shared observation.
    const merged = {
      ...context(T),
      sources: [
        ...context(T).sources.filter((x) => x.sourceId !== FEED_SOURCE),
        { sourceId: FEED_SOURCE, trustClass: 'VERIFIED' as const, kinds: [{ domain: 'lighter-perp', stateKind: 'perp.asset-price' }, { domain: spot.ref.domainId, stateKind: MARK }] },
        { sourceId: VENUE_SOURCE, trustClass: 'VERIFIED' as const, kinds: [{ domain: spot.ref.domainId, stateKind: POSITION }] },
        { sourceId: REGISTRY_SOURCE, trustClass: 'AUTHORITATIVE' as const, kinds: [{ domain: spot.ref.domainId, stateKind: INSTRUMENTS }] },
      ],
      // The spot module's venue reports a sequence; the ledger has reconciled nothing yet.
      sequenceWatermarks: [{ sourceId: VENUE_SOURCE, stateKind: POSITION, subject: spotAcct, sequence: 0n }],
    };
    const all = [...perpStates, ...spotStates];

    // Lighter: BUY 0.04 BTC at 100,000 → 4,000 USD, resting.
    const lighter = authorized(await w.engine.authorizeAndReserve(request(order(w, g, { baseAmount: 4_000n, price: 1_000_000n }), all, merged), ONCE));
    const resting = { openOrders: [{ marketIndex: 4096, clientOrderIndex: clientOrderIndexFor(lighter.reservation), isAsk: false, remainingBaseAmount: 4_000n, price: 1_000_000n, reduceOnly: false }] };
    const withResting = [...states(w, { btc: price, book: resting }), ...spotStates];
    // The agent requests a cancel; it is authorized and changes nothing about the first order's reservation.
    authorized(await w.engine.authorizeAndReserve(request(cancel(w, g, { target: lighter.reservation, nonce: 1n }), withResting, merged), ONCE));
    // Spot: BUY 0.04 BTC → 4,000 + 4,000 > 5,000: refused.
    const spotBuy = synthAction(spot, { authority: g, size: 400n, market: 'x:BTC-SPOT', account: spotAcct, nonce: 2n });
    const refused = await w.engine.authorizeAndReserve({ action: spotBuy.envelope, payload: spotBuy.payload, generation: 1n, states: withResting, context: merged }, ONCE);
    assert.equal(refusedWith(refused).code, 'INVARIANT_FAILED');
    // It is the principal-global aggregate that refuses: 4,000 pending on Lighter + 4,000 proposed spot > 5,000.
    assert.ok(refused.status === 'REFUSED' && refused.refusal.detail.kind === 'INVARIANTS');
    if (refused.status === 'REFUSED' && refused.refusal.detail.kind === 'INVARIANTS') {
      const agg = refused.refusal.detail.results.find((r) => r.term.invariantId === AGGREGATE_INVARIANT_ID);
      assert.equal(agg?.outcome, 'VIOLATED');
      assert.deepEqual(agg?.observed, { type: 'TOTAL', kind: 'GROSS_EXPOSURE', unit: 'USD', decimals: 2, atoms: 800_000n });
      assert.ok(agg?.reservations.includes(lighter.reservation), 'the unresolved Lighter order is part of the evidence');
    }
    // Spot: BUY 0.01 BTC → 5,000: exactly the remaining authority.
    const small = synthAction(spot, { authority: g, size: 100n, market: 'x:BTC-SPOT', account: spotAcct, nonce: 3n });
    authorized(await w.engine.authorizeAndReserve({ action: small.envelope, payload: small.payload, generation: 1n, states: withResting, context: merged }, ONCE));
    void BTC_MARKET;
  });
});

describe('PerpPolicy v1 — account identity', () => {
  it('refuses an account index Lighter cannot have (above 2^48 − 2)', async () => {
    const { w, g } = await world();
    const out = await w.engine.authorizeAndReserve(request(order(w, g, { account: { domain: 'lighter-perp', kind: 'ACCOUNT', localId: 'lighter:300:account:281474976710700' } }), states(w)), ONCE);
    assert.equal(refusedWith(out).reason, 'ACCOUNT_NOT_ON_CHAIN');
  });
});
