/**
 * Cross-domain authority, offline (robinhood-demo.md §5): Lighter PerpPolicy
 * v1 and GateSpotPolicy v1 in one control engine, reserving into one
 * principal-wide ledger under one principal policy.
 *
 * **The shared quantity** is committed notional — Core kind `NOTIONAL`,
 * unit `USDC`, 6 decimals: quantity × the price the action commits to, before
 * fees. PerpPolicy demands it for every order (quantity × the signed limit
 * price, in Lighter's USDC); GateSpotPolicy demands it for every gate BUY
 * (quantity × the gate's immutable fixture price, in the market's settlement
 * unit). One dimension of that kind and unit with an empty scope is charged by
 * both. Nothing converts or adds different kinds: perp margin (`MARGIN`) and
 * spot capital (`CAPITAL`) are separate dimensions and are never summed with
 * notional or with each other.
 *
 * **What is engineered here.** The gate market in this scenario is declared to
 * settle `USDC` so that it shares Lighter's unit. The live Robinhood testnet
 * gate settles `MDUSD`, a labelled fixture unit, and so deliberately does *not*
 * share a `USDC` dimension: a live cross-domain limit needs a funding token
 * that genuinely settles the same unit, which 7E.3 does not have
 * (robinhood-deployment.md §5, USDG).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { actionPayloadDigest, authorityId, validateActionEnvelope, validateModuleRef, type AuthorityGrant, type LedgerDimensionInput, type PartyIdInput } from '@mandate/core';
import {
  ACTION_GATE_BUY,
  DOMAIN_ID as EVM_DOMAIN,
  STATE_GATE_MARKET,
  accountResource,
  createGateSpotPolicy,
  encodeGateBuy,
  gateAdapterRefInput,
  gateMarketState,
  marketResource,
  reviewedSnapshot,
  type GateSpotPolicy,
  type ReviewedGate,
  type ReviewedMarket,
} from '../src/index.ts';
import { ONCE, P, T, T0, T_END, authorized, btcNotionalDim, btcSizeDim, context as perpContext, marginDim, order, perpWorld, policy as perpPolicy, refusedWith, request as perpRequest, root, setup, states as perpStates, type PerpWorld } from '../../perp-lighter/test/support/world.ts';
import { DOMAIN_SEPARATOR, GATE, GATE_CODEHASH, MARKET, SOURCE, capitalDim, must } from './support/world.ts';

/** The perp world's principal, as an EVM address: one principal across both domains. */
const PRINCIPAL_ADDRESS = (P as PartyIdInput).value;
const CHAIN = 46_630n;

/** An offline gate market declared to settle USDC at 100.000000 USDC per token. Engineered — see the header. */
const USDC_MARKET: ReviewedMarket = { ...MARKET, settlementUnit: 'USDC', fixturePrice: { decimals: 6, atoms: 100_000_000n } };
const USDC_GATE: ReviewedGate = { chainId: CHAIN, gate: GATE, markets: [USDC_MARKET] };
const GATE_ADAPTER_CONFIG = { gate: USDC_GATE, gateCodehash: GATE_CODEHASH, domainSeparator: DOMAIN_SEPARATOR };

/** Principal-wide committed notional: 10,000.000000 USDC across every domain, market and account. */
const globalNotional = (usdc: bigint): LedgerDimensionInput => ({
  kind: 'LEDGER_DIMENSION',
  dimensionId: 'global-committed-notional',
  limit: { kind: 'NOTIONAL', unit: 'USDC', decimals: 6, atoms: usdc * 1_000_000n },
  accounting: 'CAPACITY',
  restoration: 'AS_CHARGED',
  epoch: null,
  sign: 'UNSIGNED',
  scope: { asset: null, market: null, domain: null, account: null },
});

interface World {
  readonly w: PerpWorld;
  readonly gate: GateSpotPolicy;
  readonly g: AuthorityGrant;
}

async function world(o: { global?: boolean } = {}): Promise<World> {
  const gate = createGateSpotPolicy({ gate: USDC_GATE, sources: { gateMarket: SOURCE }, maxMarketAgeSeconds: 60n, lifetimeSeconds: 3_600n });
  const adapter = gateAdapterRefInput(GATE_ADAPTER_CONFIG);
  const w = perpWorld({ extra: [gate], extraAdapters: [adapter] });
  const dims = [btcSizeDim(10n ** 6n), btcNotionalDim(10n ** 12n), marginDim(10n ** 12n), capitalDim('USDC', 10n ** 12n), ...(o.global === false ? [] : [globalNotional(10_000n)])];
  const g = root(w, dims, {
    extra: [gate],
    markets: [marketResource(CHAIN, USDC_MARKET.representation)],
    actionTypes: [{ domain: EVM_DOMAIN, actionType: ACTION_GATE_BUY }],
    adapters: [adapter],
  });
  await setup(w, perpPolicy(), [g]);
  return { w, gate, g };
}

/** A gate BUY of `tokens` whole tokens for the perp world's principal. */
function gateBuy(x: World, tokens: bigint, nonce: bigint) {
  const ref = x.gate.ref;
  const moduleInput = { domainId: ref.domainId, moduleId: ref.moduleId, moduleVersion: ref.moduleVersion, moduleDigest: ref.moduleDigest };
  const account = accountResource(CHAIN, PRINCIPAL_ADDRESS);
  const market = marketResource(CHAIN, USDC_MARKET.representation);
  const payload = encodeGateBuy({ account, market, quantity: tokens * 10n ** 18n });
  const envelope = must(
    validateActionEnvelope({
      principal: P,
      authority: authorityId(x.g),
      actor: { kind: x.g.holder.kind, value: x.g.holder.value },
      module: moduleInput,
      actionType: ACTION_GATE_BUY,
      adapter: gateAdapterRefInput(GATE_ADAPTER_CONFIG),
      target: market,
      resources: [account],
      payloadDigest: must(actionPayloadDigest(must(validateModuleRef(moduleInput)), payload)),
      validFrom: T0,
      expiresAt: T_END,
      nonce,
    }),
  );
  const ctx = perpContext(T, [{ sourceId: SOURCE, trustClass: 'VERIFIED', kinds: [{ domain: EVM_DOMAIN, stateKind: STATE_GATE_MARKET }] }]);
  return { action: envelope, payload, generation: 1n, states: [gateMarketState(x.gate, reviewedSnapshot(CHAIN, GATE, USDC_MARKET), T)], context: ctx };
}

/** A Lighter BUY of `usdc` whole USDC of BTC at 100,000.0 (0.01 BTC per 1,000 USDC). */
const lighterBuy = (x: World, usdc: bigint, nonce: bigint) => perpRequest(order(x.w, x.g, { baseAmount: usdc, price: 1_000_000n, nonce }), perpStates(x.w, { btc: 10_000_000n }), perpContext(T));

describe('one principal-wide ledger across Robinhood EVM and Lighter perps', () => {
  it('6,000 USDC reserved on Robinhood + 5,000 USDC proposed on Lighter = 11,000 > 10,000: REFUSED; 4,000 fits exactly', async () => {
    const x = await world();
    const rh = authorized(await x.w.engine.authorizeAndReserve(gateBuy(x, 60n, 0n), ONCE));
    assert.equal(rh.module.domainId, 'robinhood-evm');
    const refused = await x.w.engine.authorizeAndReserve(lighterBuy(x, 5_000n, 1n), ONCE);
    assert.deepEqual(refusedWith(refused), { code: 'AUTHORITY_UNAVAILABLE', reason: 'LEDGER_LIMIT_EXCEEDED' });
    const fits = authorized(await x.w.engine.authorizeAndReserve(lighterBuy(x, 4_000n, 2n), ONCE));
    assert.equal(fits.module.domainId, 'lighter-perp');
    // Both reservations are in one principal's ledger, each under its own module and adapter.
    const snap = await x.w.engine.read(rh.principal);
    const active = [...snap.state.reservations.values()].filter((r) => r.status === 'ACTIVE');
    assert.deepEqual(active.map((r) => r.module.domainId).sort(), ['lighter-perp', 'robinhood-evm']);
    const notional = active.flatMap((r) => r.demands.filter((d) => d.contribution.quantity.kind === 'NOTIONAL' && d.contribution.quantity.unit === 'USDC').map((d) => d.reserved));
    assert.equal(notional.reduce((a, b) => a + b, 0n), 10_000_000_000n);
  });

  it('the same refusal from the other side: Lighter 5,000 first, then a Robinhood 6,000 BUY is refused', async () => {
    const x = await world();
    authorized(await x.w.engine.authorizeAndReserve(lighterBuy(x, 5_000n, 1n), ONCE));
    assert.deepEqual(refusedWith(await x.w.engine.authorizeAndReserve(gateBuy(x, 60n, 0n), ONCE)), { code: 'AUTHORITY_UNAVAILABLE', reason: 'LEDGER_LIMIT_EXCEEDED' });
    authorized(await x.w.engine.authorizeAndReserve(gateBuy(x, 50n, 3n), ONCE));
  });

  it('control: without the principal-wide dimension both fit — it is the shared notional limit that refuses', async () => {
    const x = await world({ global: false });
    authorized(await x.w.engine.authorizeAndReserve(gateBuy(x, 60n, 0n), ONCE));
    authorized(await x.w.engine.authorizeAndReserve(lighterBuy(x, 5_000n, 1n), ONCE));
  });

  it('each reservation keeps its own kinds; the only kind and unit both carry is NOTIONAL in USDC', async () => {
    const x = await world({ global: false });
    // Each reservation carries its own kinds; the only kind both carry is NOTIONAL in USDC, the shared quantity.
    const rh = authorized(await x.w.engine.authorizeAndReserve(gateBuy(x, 60n, 0n), ONCE));
    const lighter = authorized(await x.w.engine.authorizeAndReserve(lighterBuy(x, 5_000n, 1n), ONCE));
    const snap = await x.w.engine.read(rh.principal);
    const kinds = (id: string) => snap.state.reservations.get(id as never)?.demands.map((d) => `${d.contribution.quantity.kind}:${d.contribution.quantity.unit}`).sort();
    assert.deepEqual(kinds(rh.reservation), ['CAPITAL:USDC', 'COUNT:COUNT', 'NOTIONAL:USDC']);
    assert.deepEqual(kinds(lighter.reservation), ['COUNT:COUNT', 'MARGIN:USDC', 'NOTIONAL:USDC', 'POSITION_SIZE:UNIT']);
  });
});
