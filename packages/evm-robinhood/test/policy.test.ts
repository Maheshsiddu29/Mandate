/**
 * GateSpotPolicy v1 through the real control engine and the SQLite reference
 * store: the capital and notional demands and their exact arithmetic, the
 * 500-unit authority scenario of the live demonstration (300 fits, a further
 * 250 is refused before any transaction exists), capital as a required
 * dimension, chain state pinned to the reviewed market, and module/adapter
 * identity that changes with every fact it depends on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reservationIdFor } from '@mandate/core';
import {
  ORDER_DEBIT_BOUND,
  buyCost,
  createGateSpotPolicy,
  gateAdapterRefInput,
  gateSpotModuleRef,
  marketResource,
  accountResource,
  reviewedSnapshot,
  gateMarketState,
  encodeGateBuy,
  decodeGateBuy,
} from '../src/index.ts';
import {
  ACCOUNT,
  ADAPTER_CONFIG,
  CHAIN,
  DEMO_MARKET,
  GATE,
  MARKET,
  ONCE,
  REVIEWED,
  T,
  authorized,
  buy,
  capitalDim,
  context,
  mdemo,
  mdusd,
  policyConfig,
  refusal,
  request,
  rootGrant,
  withWorld,
  type GateWorld,
} from './support/world.ts';

/** Capital held by the principal's active reservations, in MDUSD atoms. */
const reservedCapital = (w: GateWorld): bigint => {
  const state = w.store.readCommitted(w.deps.config.principal).state;
  let total = 0n;
  for (const r of state.reservations.values()) {
    if (r.status !== 'ACTIVE') continue;
    for (const d of r.demands) if (d.contribution.quantity.kind === 'CAPITAL') total += d.reserved - d.consumed - d.released;
  }
  return total;
};

describe('GateSpotPolicy v1 — exact demands', () => {
  it('reserves exactly the venue quote as CAPITAL and quantity × fixture price as NOTIONAL', () =>
    withWorld(async (w) => {
      const rec = authorized(await w.engine.authorizeAndReserve(request(w.policy, buy(w.policy, w.grant, mdemo(30n))), ONCE));
      assert.equal(buyCost(MARKET, mdemo(30n)), mdusd(300n));
      const r = w.store.readCommitted(rec.principal).state.reservations.get(rec.reservation);
      assert.equal(r?.status, 'ACTIVE');
      const capital = r?.demands.find((d) => d.contribution.quantity.kind === 'CAPITAL')?.contribution.quantity;
      const notional = r?.demands.find((d) => d.contribution.quantity.kind === 'NOTIONAL')?.contribution.quantity;
      assert.deepEqual([capital?.unit, capital?.decimals, capital?.atoms], ['MDUSD', 6, mdusd(300n)]);
      assert.deepEqual([notional?.unit, notional?.atoms, notional?.valuation?.basis], ['MDUSD', mdusd(300n), 'LIMIT']);
      assert.equal(reservedCapital(w), mdusd(300n));
    }));

  it('rounds a sub-atom cost up, never in the agent’s favour', () => {
    const odd = { ...MARKET, fixturePrice: { decimals: 6, atoms: 3n } }; // 0.000003 MDUSD per MDEMO
    assert.equal(buyCost(odd, 1n), 1n); // 1 atom of MDEMO costs 3e-24 MDUSD atoms → 1 atom
    assert.equal(buyCost({ ...MARKET, feeBps: 30 }, mdemo(30n)), mdusd(300n) + 900_000n);
  });

  it('reports the order debit as a per-action bound', () =>
    withWorld(async (w) => {
      const a = buy(w.policy, w.grant, mdemo(30n));
      const v = w.policy.validateAction({ envelope: a.envelope, actionId: '0x01' as never, payload: a.payload });
      assert.ok(v.ok);
      if (v.ok) assert.deepEqual(v.value.bounds.map((b) => [b.boundId, b.value.type === 'QUANTITY' ? b.value.quantity.atoms : null]), [[ORDER_DEBIT_BOUND, mdusd(300n)]]);
    }));
});

describe('the 500-unit authority scenario (robinhood-demo.md §3)', () => {
  it('300 MDUSD fits; a further 250 would be 550 > 500 and is refused before any artifact exists', () =>
    withWorld(async (w) => {
      authorized(await w.engine.authorizeAndReserve(request(w.policy, buy(w.policy, w.grant, mdemo(30n))), ONCE));
      assert.equal(reservedCapital(w), mdusd(300n));
      const second = await w.engine.authorizeAndReserve(request(w.policy, buy(w.policy, w.grant, mdemo(25n), { nonce: 1n })), ONCE);
      // The ledger refuses the charge: 300 reserved + 250 proposed exceeds the 500 MDUSD capital limit.
      assert.deepEqual(refusal(second), { code: 'AUTHORITY_UNAVAILABLE', reason: 'LEDGER_LIMIT_EXCEEDED' });
      // Nothing was written: the refused action reserved nothing, and no attempt or transaction exists.
      assert.equal(reservedCapital(w), mdusd(300n));
      assert.equal(w.chain.txs.length, 0);
      // Exactly the remaining 200 fits.
      authorized(await w.engine.authorizeAndReserve(request(w.policy, buy(w.policy, w.grant, mdemo(20n), { nonce: 2n })), ONCE));
      assert.equal(reservedCapital(w), mdusd(500n));
    }));

  it('a reservation that has executed still counts: nothing is credited back before reconciliation', () =>
    withWorld(async (w) => {
      const a = buy(w.policy, w.grant, mdemo(30n));
      const rec = authorized(await w.engine.authorizeAndReserve(request(w.policy, a), ONCE));
      w.chain.time = T + 5n;
      const out = await w.signer.issueAuthorizedBuy(rec, { payload: a.payload, states: [gateMarketState(w.policy, reviewedSnapshot(CHAIN, GATE, MARKET), T + 5n)], context: context(T + 5n) });
      assert.equal(out.status, 'ISSUED');
      assert.equal(reservedCapital(w), mdusd(300n));
      refusal(await w.engine.authorizeAndReserve(request(w.policy, buy(w.policy, w.grant, mdemo(25n), { nonce: 1n }), T + 6n), ONCE));
    }));
});

describe('capital is a required dimension', () => {
  it('refuses an EVM spend under a lineage with no capital dimension in the settlement unit', () =>
    withWorld(
      async (w) => {
        // A USDC capital limit does not bound an MDUSD spend: no conversion, so the required demand is unbounded.
        assert.deepEqual(refusal(await w.engine.authorizeAndReserve(request(w.policy, buy(w.policy, w.grant, mdemo(1n))), ONCE)), { code: 'AUTHORITY_UNAVAILABLE', reason: 'UNBOUNDED_CONTRIBUTION' });
      },
      { grantOf: (p) => rootGrant(p, [capitalDim('USDC', mdusd(10_000n))]) },
    ));
});

describe('action validation', () => {
  it('refuses an unreviewed market, another chain’s account, a zero quantity and a malformed payload', () =>
    withWorld(async (w) => {
      const cases: [ReturnType<typeof buy>, string][] = [
        [buy(w.policy, w.grant, mdemo(1n), { market: marketResource(CHAIN, '0x000000000000000000000000000000000000aa02') }), 'MARKET_NOT_REVIEWED'],
        [buy(w.policy, w.grant, mdemo(1n), { account: accountResource(4663n, ACCOUNT.localId.slice(-42)) }), 'ACCOUNT_NOT_ON_CHAIN'],
        [buy(w.policy, w.grant, 0n), 'QUANTITY_OUT_OF_RANGE'],
      ];
      for (const [a, reason] of cases) {
        const out = await w.engine.authorizeAndReserve(request(w.policy, a), ONCE);
        assert.equal(out.status, 'REFUSED', reason);
        if (out.status === 'REFUSED') assert.equal(out.refusal.reason, reason);
      }
      assert.equal(decodeGateBuy(new Uint8Array([1, 2, 3])), null);
      const bytes = encodeGateBuy({ account: ACCOUNT, market: DEMO_MARKET, quantity: 7n });
      assert.equal(decodeGateBuy(bytes)?.quantity, 7n);
      assert.equal(decodeGateBuy(new Uint8Array([...bytes, 0])), null);
    }));

  it('refuses an adapter the grant does not cover', () =>
    withWorld(async (w) => {
      const other = gateAdapterRefInput({ ...ADAPTER_CONFIG, gateCodehash: `0x${'c1'.repeat(32)}` });
      const out = await w.engine.authorizeAndReserve(request(w.policy, buy(w.policy, w.grant, mdemo(1n), { adapter: other })), ONCE);
      assert.equal(out.status, 'REFUSED');
    }));
});

describe('chain state is pinned to the reviewed market', () => {
  for (const [label, drift] of [
    ['another fixture price', { fixturePrice: { decimals: 6, atoms: 9_000_000n } }],
    ['another fee', { feeBps: 1 }],
    ['another adapter', { adapter: '0x00000000000000000000000000000000000000ad' }],
    ['another funding token', { fundingToken: '0x000000000000000000000000000000000000f018' }],
  ] as const) {
    it(`refuses a snapshot reporting ${label}`, () =>
      withWorld(async (w) => {
        const a = buy(w.policy, w.grant, mdemo(1n));
        const states = [gateMarketState(w.policy, reviewedSnapshot(CHAIN, GATE, { ...MARKET, ...drift }), T)];
        const out = await w.engine.authorizeAndReserve({ action: a.envelope, payload: a.payload, generation: 1n, states, context: context(T) }, ONCE);
        assert.equal(out.status, 'REFUSED');
        if (out.status === 'REFUSED') assert.match(`${out.refusal.code}.${out.refusal.reason}`, /STATE|VERSION|PIN/);
      }));
  }

  it('refuses a snapshot older than its age limit, and no snapshot at all', () =>
    withWorld(async (w) => {
      const a = buy(w.policy, w.grant, mdemo(1n));
      const stale = [gateMarketState(w.policy, reviewedSnapshot(CHAIN, GATE, MARKET), T - 61n)];
      assert.equal((await w.engine.authorizeAndReserve({ action: a.envelope, payload: a.payload, generation: 1n, states: stale, context: context(T) }, ONCE)).status, 'REFUSED');
      assert.equal((await w.engine.authorizeAndReserve({ action: a.envelope, payload: a.payload, generation: 1n, states: [], context: context(T) }, ONCE)).status, 'REFUSED');
    }));
});

describe('identity (DOM-2 for the module and the adapter)', () => {
  it('the module digest changes with any reviewed market fact; the adapter digest with the gate’s code, domain or address', () => {
    const base = gateSpotModuleRef(policyConfig()).moduleDigest;
    assert.notEqual(gateSpotModuleRef(policyConfig({ ...REVIEWED, markets: [{ ...MARKET, feeBps: 1 }] })).moduleDigest, base);
    assert.notEqual(gateSpotModuleRef(policyConfig({ ...REVIEWED, gate: '0x000000000000000000000000000000000000a7e1' })).moduleDigest, base);
    const a = gateAdapterRefInput(ADAPTER_CONFIG).adapterDigest;
    assert.notEqual(gateAdapterRefInput({ ...ADAPTER_CONFIG, gateCodehash: `0x${'c1'.repeat(32)}` }).adapterDigest, a);
    assert.notEqual(gateAdapterRefInput({ ...ADAPTER_CONFIG, domainSeparator: `0x${'d1'.repeat(32)}` }).adapterDigest, a);
    assert.notEqual(gateAdapterRefInput({ ...ADAPTER_CONFIG, gate: { ...REVIEWED, gate: '0x000000000000000000000000000000000000a7e1' } }).adapterDigest, a);
  });

  it('refuses a reviewed record the frozen gate could not have built', () => {
    assert.throws(() => createGateSpotPolicy(policyConfig({ ...REVIEWED, markets: [{ ...MARKET, fixturePrice: { decimals: 8, atoms: 1n } }] })), /PRICE_NOT_REPRESENTABLE/);
    assert.throws(() => createGateSpotPolicy(policyConfig({ ...REVIEWED, markets: [{ ...MARKET, fundingToken: MARKET.representation }] })), /REPRESENTATION_IS_FUNDING/);
    assert.throws(() => createGateSpotPolicy(policyConfig({ ...REVIEWED, markets: [{ ...MARKET, representation: '0x000000000000000000000000000000000000AA01' }] })), /ADDRESS_NOT_LOWERCASE/);
  });

  it('two generations of one action are two reservations', () => {
    assert.notEqual(reservationIdFor('0x01'.padEnd(66, '0') as never, 1n as never), reservationIdFor('0x01'.padEnd(66, '0') as never, 2n as never));
  });
});
