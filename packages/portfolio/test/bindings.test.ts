/**
 * Domain bindings: identity is resolved from trusted data — the registry for
 * the stock agent, reviewed catalogs and claims for the rest — never from a
 * ticker, a display name or an agent's claim; demand is derived, never
 * declared; and each agent's scope then decides by name.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agentPolicyOf, amountOf, checkPortfolioMandate, deriveChildAuthorization, permits, resolveCandidate, validateAgentProposal, portfolioMandateDigest, type ActionCandidate, type AgentPolicy, type Resolution } from '../src/index.ts';
import {
  DEMO_T0,
  IMPOSTOR_COLLECTION,
  STOCK_COUNTERFEIT,
  STOCK_LOOKALIKE,
  UNKNOWN_ROUTER,
  UNVETTED_VAULT,
  demoBindings,
  demoMandate,
  demoParty,
  USDC,
} from '../src/demo/index.ts';
import { NOW, nftBuy, perpOpen, stockBuy, swap, yieldDeposit } from './support/candidates.ts';

const m = demoMandate();
const bindings = demoBindings();
const agent = (role: string) => agentPolicyOf(m, demoParty(role)) as AgentPolicy;
const resolve = (role: string, c: ActionCandidate): Resolution => resolveCandidate(bindings, m, agent(role), c, NOW);
const codes = (rs: readonly { code: string }[]) => [...new Set(rs.map((r) => r.code))].sort();

/** Resolution, then the agent's scope and the portfolio's: every reason the action would be refused for. */
function verdict(role: string, c: ActionCandidate): string[] {
  const r = resolve(role, c);
  if (!r.ok) return codes(r.reasons);
  return codes([...permits(agent(role).scope, r.action, NOW), ...permits(m.scope, r.action, NOW)]);
}

describe('the demonstration mandate', () => {
  it('is valid: every agent ⊆ the portfolio, preferred allocations sum to the 2,000 limit', () => {
    assert.deepEqual(checkPortfolioMandate(m), []);
    assert.equal(m.agents.reduce((s, a) => s + amountOf(a.preferred, 'portfolio-notional'), 0n), USDC(2_000n));
  });
});

describe('stock: identity through the existing registry', () => {
  it('the approved, fully backed representation resolves; demand is the gate’s own quote', () => {
    const r = resolve('stock', stockBuy({ tenths: 48n }));
    assert.ok(r.ok);
    assert.deepEqual(r.registry, { representation: r.action.representation, status: 'ADMISSIBLE', codes: [] });
    assert.equal(r.action.issuer, 'issuer.fixture.alpha');
    assert.equal(r.action.synthetic, false);
    assert.ok(r.action.rights.includes('ECONOMIC_EXPOSURE'));
    // 4.8 tokens × 125.00 USDC = 600.00 USDC of notional and of capital (no fee on this market).
    assert.equal(amountOf(r.action.demand, 'portfolio-notional'), USDC(600n));
    assert.equal(amountOf(r.action.demand, 'spot-capital'), USDC(600n));
    assert.equal(amountOf(r.action.demand, 'derivative-notional'), 0n);
    assert.deepEqual(verdict('stock', stockBuy()), []);
  });

  it('a cheaper look-alike with the same ticker is excluded by the registry: unapproved issuer, synthetic', () => {
    const r = resolve('stock', stockBuy({ representation: STOCK_LOOKALIKE, claims: { ticker: 'NVDA', issuer: null } }));
    assert.equal(r.ok, false);
    assert.equal(r.registry?.status, 'EXCLUDED');
    assert.deepEqual(r.registry?.codes, ['BACKING_REQUIREMENT_NOT_MET', 'ISSUER_NOT_ALLOWED', 'RIGHTS_REQUIREMENT_NOT_MET', 'SYNTHETIC_NOT_ALLOWED'].filter((c) => r.registry?.codes.includes(c)));
    assert.ok(r.registry?.codes.includes('ISSUER_NOT_ALLOWED'));
    assert.ok(r.registry?.codes.includes('SYNTHETIC_NOT_ALLOWED'));
    assert.ok(!r.ok && r.reasons.every((x) => x.code.startsWith('REGISTRY:')));
  });

  it('an unregistered counterfeit is REPRESENTATION_UNKNOWN whatever it claims', () => {
    const r = resolve('stock', stockBuy({ representation: STOCK_COUNTERFEIT, claims: { ticker: 'NVDA', issuer: 'issuer.fixture.alpha', asset: { assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBJQV0' } } }));
    assert.deepEqual(r.ok ? [] : codes(r.reasons), ['REGISTRY:REPRESENTATION_UNKNOWN']);
    assert.deepEqual(r.registry?.codes, ['REPRESENTATION_UNKNOWN']);
  });

  it('claims are never identity: the approved token with a false issuer claim is refused, a ticker claim is never read', () => {
    assert.deepEqual(verdict('stock', stockBuy({ claims: { issuer: 'issuer.fixture.omega' } })), ['IDENTITY_CLAIM_MISMATCH']);
    assert.deepEqual(verdict('stock', stockBuy({ claims: { ticker: 'SOMETHING-ELSE' } })), []);
  });

  it('a stock buy for another recipient is refused', () => {
    assert.deepEqual(verdict('stock', stockBuy({ account: 'eip155:46630/account:0x9999999999999999999999999999999999999999' })), ['RECIPIENT_NOT_ALLOWED']);
  });
});

describe('swap: venue, route, recipient and slippage are bound', () => {
  it('the approved router and pool are eligible; demand is the amount in', () => {
    const r = resolve('swap', swap());
    assert.ok(r.ok);
    assert.equal(amountOf(r.action.demand, 'portfolio-notional'), USDC(300n));
    assert.equal(r.action.slippageBps, 30);
    assert.deepEqual(verdict('swap', swap()), []);
  });

  it('an unknown router offering more output is VENUE_NOT_ALLOWED', () => {
    assert.deepEqual(verdict('swap', swap({ router: UNKNOWN_ROUTER, quotedOut: 125_000_000_000_000_000n })), ['VENUE_NOT_ALLOWED']);
  });

  it('an unreviewed pool, a substituted recipient, too much slippage, a stale quote: each by name', () => {
    assert.deepEqual(verdict('swap', swap({ route: ['eip155:421614/pool:0x000000000000000000000000000000000000dead'] })), ['ROUTE_NOT_ALLOWED']);
    assert.deepEqual(verdict('swap', swap({ recipient: 'eip155:421614/account:0x9999999999999999999999999999999999999999' })), ['RECIPIENT_NOT_ALLOWED']);
    assert.deepEqual(verdict('swap', swap({ minOut: 119_000_000_000_000_000n })), ['SLIPPAGE_NOT_ALLOWED']);
    assert.deepEqual(verdict('swap', swap({ observedAt: NOW - 61n })), ['QUOTE_STALE']);
  });

  it('spending anything but the reviewed funding token is refused before any scope check', () => {
    assert.deepEqual(verdict('swap', swap({ tokenIn: 'eip155:421614/erc20:0x0000000000000000000000000000000000000bad' })), ['INSTRUMENT_UNKNOWN']);
  });
});

describe('nft: collection contract identity, not display name', () => {
  it('the genuine collection is eligible and counts toward illiquid exposure', () => {
    const r = resolve('nft', nftBuy({ price: USDC(250n) }));
    assert.ok(r.ok);
    assert.equal(amountOf(r.action.demand, 'illiquid-notional'), USDC(250n));
    assert.deepEqual(verdict('nft', nftBuy()), []);
  });

  it('an impostor with the same display name and a lower price is refused for its contract identity', () => {
    assert.deepEqual(verdict('nft', nftBuy({ collection: IMPOSTOR_COLLECTION, price: USDC(200n) })), ['ASSET_NOT_ALLOWED', 'REPRESENTATION_NOT_ALLOWED']);
  });

  it('a contract nobody reviewed is INSTRUMENT_UNKNOWN', () => {
    assert.deepEqual(verdict('nft', nftBuy({ collection: 'eip155:421614/erc721:0x0000000000000000000000000000000000000077' })), ['INSTRUMENT_UNKNOWN']);
  });
});

describe('yield: product and issuer eligibility; APY is a quote, never authority', () => {
  it('the approved 5.20 % product is eligible', () => {
    assert.deepEqual(verdict('yield', yieldDeposit({ apyBps: 520 })), []);
  });

  it('a 12.60 % product from an unvetted issuer is refused by identity, whatever its yield', () => {
    assert.deepEqual(verdict('yield', yieldDeposit({ product: UNVETTED_VAULT, apyBps: 1_260 })), ['ASSET_NOT_ALLOWED', 'ISSUER_NOT_ALLOWED', 'REPRESENTATION_NOT_ALLOWED', 'VENUE_NOT_ALLOWED']);
  });

  it('a quote older than the agent’s bound is stale; a false issuer claim is a mismatch', () => {
    assert.deepEqual(verdict('yield', yieldDeposit({ observedAt: NOW - 301n })), ['QUOTE_STALE']);
    assert.deepEqual(verdict('yield', yieldDeposit({ issuer: 'issuer.fixture.omega' })), ['IDENTITY_CLAIM_MISMATCH']);
  });
});

describe('perps: leverage bound and portfolio-wide derivative exposure', () => {
  it('demand is PerpPolicy’s: notional, margin with fee headroom, and derivative exposure', () => {
    const r = resolve('perps', perpOpen({ usdc: 400n }));
    assert.ok(r.ok);
    assert.equal(amountOf(r.action.demand, 'portfolio-notional'), USDC(400n));
    assert.equal(amountOf(r.action.demand, 'derivative-notional'), USDC(400n));
    // ⌈400 × 5,000 / 10,000⌉ + ⌈400 × 1,000 / 10⁶⌉ = 200 + 0.4 USDC.
    assert.equal(amountOf(r.action.demand, 'perp-margin'), 200_400_000n);
    assert.equal(amountOf(r.action.demand, 'spot-capital'), 0n, 'perp margin is never spot capital');
    assert.deepEqual(verdict('perps', perpOpen({ usdc: 400n })), []);
  });

  it('leverage above the agent’s 3x is refused; 2x is not', () => {
    assert.deepEqual(verdict('perps', perpOpen({ imf: 2_000 })), ['LEVERAGE_NOT_ALLOWED']);
    assert.deepEqual(verdict('perps', perpOpen({ imf: 3_334 })), []);
  });

  it('600 is locally valid — inside the agent’s own 600 — yet exceeds the portfolio’s 400 derivative exposure', () => {
    const r = resolve('perps', perpOpen({ usdc: 600n }));
    assert.ok(r.ok);
    assert.deepEqual(verdict('perps', perpOpen({ usdc: 600n })), [], 'no scope reason: locally valid');
    const proposal = validateAgentProposal({
      portfolioMandate: portfolioMandateDigest(m),
      agent: demoParty('perps'),
      sequence: 1n,
      candidate: { kind: 'PERP_OPEN', market: 'lighter:300/perp:4096', account: 'lighter:300/account:281474976710600', side: 'LONG', size: 600n, price: 1_000_000n, initialMarginFraction: 5_000, claims: { ticker: null, displayName: null, issuer: null, asset: null } },
      requested: [],
      minimum: [],
      utilityBps: 0n,
      createdAt: DEMO_T0,
      expiresAt: DEMO_T0 + 3_600n,
      criticalExtensions: [],
    });
    assert.ok(proposal.ok);
    const child = deriveChildAuthorization(m, proposal.value, r.action, NOW);
    assert.deepEqual(child.ok ? [] : child.reasons, [{ code: 'PORTFOLIO_LIMIT_EXCEEDED', subject: 'derivative-notional' }]);
  });

  it('an unclaimed market is INSTRUMENT_UNKNOWN; another account is refused', () => {
    assert.deepEqual(verdict('perps', perpOpen({ market: 'lighter:300/perp:9999' })), ['INSTRUMENT_UNKNOWN']);
    assert.deepEqual(verdict('perps', perpOpen({ account: 'lighter:300/account:281474976710601' })), ['RECIPIENT_NOT_ALLOWED']);
  });
});

describe('an agent acting outside its own domain', () => {
  it('the stock agent proposing a swap is refused by its scope even though the swap itself is valid', () => {
    assert.deepEqual(verdict('stock', swap()), ['ACTION_NOT_ALLOWED', 'ASSET_NOT_ALLOWED', 'CHAIN_NOT_ALLOWED', 'DOMAIN_NOT_ALLOWED', 'RECIPIENT_NOT_ALLOWED', 'REPRESENTATION_NOT_ALLOWED', 'REQUIRED_RIGHT_MISSING', 'SLIPPAGE_NOT_ALLOWED', 'QUOTE_NOT_ALLOWED', 'ROUTE_NOT_ALLOWED', 'VENUE_NOT_ALLOWED'].sort());
  });
});
