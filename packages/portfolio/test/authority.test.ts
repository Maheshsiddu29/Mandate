/**
 * Parent → child authority: CHILD ⊆ PARENT at every level, enforced
 * mechanically, every violation reported by name.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAgentPolicy,
  checkChildAuthorization,
  checkChildScope,
  checkPortfolioMandate,
  childAuthorizationDigest,
  childExecutionAuthorizationInputOf,
  decodeChildExecutionAuthorization,
  deriveChildAuthorization,
  encodeChildExecutionAuthorization,
  isCanonical,
  permits,
  validateAgentProposal,
  validateAuthorityScope,
  validateChildExecutionAuthorization,
  validateResourceVector,
  portfolioMandateDigest,
  type AgentPolicy,
  type AuthorityScopeInput,
  type ChildExecutionAuthorization,
  type ResolvedAction,
} from '../src/index.ts';
import { NVDA, PRINCIPAL, STOCK, T0, T_END, USDC6, agent, mandateInput, must, sampleMandate, scope, STOCK_KEY } from './support/mandate.ts';

const S = (o: Partial<AuthorityScopeInput> = {}) => must(validateAuthorityScope(scope(o), 's'));
const codes = (rs: readonly { code: string }[]) => [...new Set(rs.map((r) => r.code))].sort();

const REP = 'eip155:46630/erc20:0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
const GATE = 'eip155:46630/gate:0x000000000000000000000000000000000000a7e0';
const ACCOUNT = `eip155:46630/account:${PRINCIPAL.value}`;

function stockAction(o: Partial<ResolvedAction> = {}): ResolvedAction {
  return {
    kind: 'STOCK_BUY',
    domain: 'robinhood-evm' as never,
    chain: 'eip155:46630' as never,
    venue: GATE as never,
    route: [],
    asset: NVDA as never,
    representation: REP as never,
    issuer: 'issuer.fixture.alpha' as never,
    recipient: ACCOUNT as never,
    synthetic: false,
    rights: ['ECONOMIC_EXPOSURE'],
    leverage: null,
    slippageBps: null,
    quoteObservedAt: null,
    demand: must(validateResourceVector([{ resource: 'portfolio-notional', atoms: USDC6(600n) }, { resource: 'spot-capital', atoms: USDC6(600n) }], 'd')),
    ...o,
  };
}

describe('checkChildScope: the subset rule, per term', () => {
  it('a narrower child is valid; an identical child is valid', () => {
    assert.deepEqual(checkChildScope(S(), S()), []);
    assert.deepEqual(checkChildScope(S(), S({ chains: ['eip155:46630'], venues: [], maxLeverage: { numerator: 2n, scale: 0 }, maxSlippageBps: 10, maxQuoteAgeSeconds: null })), []);
  });

  it('the specification’s examples: {Arbitrum, Robinhood} ⊇ {Robinhood} is valid; {Solana} is not', () => {
    const parent = S({ chains: ['eip155:42161', 'eip155:46630'] });
    assert.deepEqual(checkChildScope(parent, S({ chains: ['eip155:46630'] })), []);
    assert.deepEqual(checkChildScope(parent, S({ chains: ['solana:mainnet'] })), [{ code: 'CHILD_WIDENS_CHAINS', subject: 'chains:solana:mainnet' }]);
  });

  it('every set: a member the parent lacks widens it, named', () => {
    const cases: [Partial<AuthorityScopeInput>, string][] = [
      [{ domains: ['robinhood-evm', 'solana-spot'] }, 'CHILD_WIDENS_DOMAINS'],
      [{ actions: ['STOCK_BUY', 'NFT_BUY'] }, 'CHILD_WIDENS_ACTIONS'],
      [{ venues: ['eip155:421614/router:0x00000000000000000000000000000000000bad01'] }, 'CHILD_WIDENS_VENUES'],
      [{ assets: [{ assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBQCY0' }] }, 'CHILD_WIDENS_ASSETS'],
      [{ representations: ['eip155:46630/erc20:0xfefefefefefefefefefefefefefefefefefefefe'] }, 'CHILD_WIDENS_REPRESENTATIONS'],
      [{ issuers: ['issuer.fixture.omega'] }, 'CHILD_WIDENS_ISSUERS'],
      [{ recipients: ['eip155:46630/account:0x9999999999999999999999999999999999999999'] }, 'CHILD_WIDENS_RECIPIENTS'],
    ];
    for (const [o, code] of cases) assert.deepEqual(codes(checkChildScope(S(), S(o))), [code], code);
  });

  it('bounds: null permits nothing that needs it, so a child may not add a bound the parent lacks or raise one', () => {
    const noBounds = S({ maxLeverage: null, maxSlippageBps: null, maxQuoteAgeSeconds: null });
    assert.deepEqual(codes(checkChildScope(noBounds, S())), ['CHILD_WIDENS_LEVERAGE', 'CHILD_WIDENS_QUOTE_AGE', 'CHILD_WIDENS_SLIPPAGE']);
    assert.deepEqual(codes(checkChildScope(S(), S({ maxLeverage: { numerator: 301n, scale: 2 } }))), ['CHILD_WIDENS_LEVERAGE']);
    assert.deepEqual(checkChildScope(S(), S({ maxLeverage: { numerator: 300n, scale: 2 } })), [], '3.00x equals 3x exactly');
    assert.deepEqual(codes(checkChildScope(S(), S({ maxSlippageBps: 101 }))), ['CHILD_WIDENS_SLIPPAGE']);
    assert.deepEqual(codes(checkChildScope(S(), S({ maxQuoteAgeSeconds: 121n }))), ['CHILD_WIDENS_QUOTE_AGE']);
  });

  it('synthetic policy is one-way and required rights can only grow', () => {
    assert.deepEqual(codes(checkChildScope(S(), S({ syntheticPolicy: 'ALLOWED' }))), ['CHILD_WIDENS_SYNTHETIC_POLICY']);
    assert.deepEqual(checkChildScope(S({ syntheticPolicy: 'ALLOWED' }), S()), []);
    assert.deepEqual(codes(checkChildScope(S({ requiredRights: ['ECONOMIC_EXPOSURE'] }), S())), ['CHILD_DROPS_REQUIRED_RIGHT']);
    assert.deepEqual(checkChildScope(S(), S({ requiredRights: ['ECONOMIC_EXPOSURE', 'VOTING_RIGHTS'] })), []);
  });

  it('reports every violation at once, in canonical order', () => {
    const r = checkChildScope(S({ maxLeverage: null }), S({ chains: ['z:1', 'y:1'], syntheticPolicy: 'ALLOWED', maxLeverage: { numerator: 1n, scale: 0 } }));
    assert.deepEqual(r.map((x) => `${x.code} ${x.subject}`), ['CHILD_WIDENS_CHAINS chains:y:1', 'CHILD_WIDENS_CHAINS chains:z:1', 'CHILD_WIDENS_LEVERAGE maxLeverage', 'CHILD_WIDENS_SYNTHETIC_POLICY syntheticPolicy']);
  });
});

describe('checkPortfolioMandate: every agent ⊆ the portfolio', () => {
  it('the sample mandate is valid', () => {
    assert.deepEqual(checkPortfolioMandate(sampleMandate()), []);
  });

  it('a child resource maximum of 600 under a 2,000 limit is valid; 2,500 is not; an undeclared or unlimited resource is not', () => {
    const base = mandateInput();
    const withStock = (hardMaxima: { resource: string; atoms: bigint }[]) => sampleMandate({ agents: [agent(STOCK_KEY, 'stock', { scope: (base.agents[0] as { scope: AuthorityScopeInput }).scope, hardMaxima })] });
    assert.deepEqual(checkPortfolioMandate(withStock([{ resource: 'portfolio-notional', atoms: USDC6(600n) }])), []);
    assert.deepEqual(codes(checkPortfolioMandate(withStock([{ resource: 'portfolio-notional', atoms: USDC6(2_500n) }]))), ['CHILD_WIDENS_RESOURCE_LIMIT']);
    assert.deepEqual(codes(checkPortfolioMandate(withStock([{ resource: 'made-up', atoms: 1n }]))), ['CHILD_RESOURCE_UNDECLARED']);
    const noMarginLimit = sampleMandate({ limits: base.limits.filter((l) => l.resource !== 'perp-margin') });
    assert.ok(checkPortfolioMandate(noMarginLimit).some((r) => r.code === 'CHILD_WIDENS_RESOURCE_LIMIT' && r.subject.endsWith('perp-margin')));
  });

  it('child expiry cannot exceed the parent’s, nor can it start earlier', () => {
    const late = sampleMandate({ agents: [agent(STOCK_KEY, 'stock', { scope: scope({ requiredRights: [] }), expiresAt: T_END + 1n })] });
    assert.deepEqual(codes(checkPortfolioMandate(late)), ['CHILD_WIDENS_WINDOW']);
    const early = sampleMandate({ agents: [agent(STOCK_KEY, 'stock', { scope: scope(), notBefore: T0 - 1n })] });
    assert.deepEqual(codes(checkPortfolioMandate(early)), ['CHILD_WIDENS_WINDOW']);
  });

  it('allocation rules: preferred within hard maximum, together within the limit, and none in DYNAMIC', () => {
    const over = sampleMandate({ agents: [agent(STOCK_KEY, 'stock', { hardMaxima: [{ resource: 'portfolio-notional', atoms: 10n }], preferred: [{ resource: 'portfolio-notional', atoms: 11n }] })] });
    assert.deepEqual(codes(checkPortfolioMandate(over)), ['PREFERRED_EXCEEDS_HARD_MAXIMUM']);
    const total = sampleMandate({ limits: [{ resource: 'portfolio-notional', atoms: USDC6(1_000n) }, { resource: 'derivative-notional', atoms: USDC6(400n) }, { resource: 'spot-capital', atoms: USDC6(800n) }, { resource: 'perp-margin', atoms: USDC6(300n) }] });
    assert.ok(codes(checkPortfolioMandate(total)).includes('PREFERRED_EXCEEDS_PORTFOLIO_LIMIT'));
    assert.ok(codes(checkPortfolioMandate(sampleMandate({ allocationMode: 'DYNAMIC' }))).includes('ALLOCATION_MODE_VIOLATION'));
  });

  it('an agent policy is checked against the portfolio scope, window and limits, subject-prefixed by agent', () => {
    const m = sampleMandate();
    const wide = sampleMandate({ agents: [agent(STOCK_KEY, 'stock', { scope: scope({ chains: ['solana:mainnet'] }) })] });
    const r = checkAgentPolicy(wide, wide.agents[0] as never);
    assert.deepEqual(r, [{ code: 'CHILD_WIDENS_CHAINS', subject: `${STOCK.value}/chains:solana:mainnet` }]);
    assert.deepEqual(checkAgentPolicy(m, m.agents[0] as never), []);
  });
});

describe('permits: an action is its singleton scope', () => {
  const stockScope = () => (sampleMandate().agents.find((a) => a.label === 'stock') as AgentPolicy).scope;

  it('the approved representation from the approved issuer is permitted', () => {
    assert.deepEqual(permits(stockScope(), stockAction(), T0), []);
  });

  it('a same-ticker look-alike, an unapproved issuer, a synthetic, a missing right: each by name', () => {
    assert.deepEqual(codes(permits(stockScope(), stockAction({ representation: 'eip155:46630/erc20:0xfefefefefefefefefefefefefefefefefefefefe' as never }), T0)), ['REPRESENTATION_NOT_ALLOWED']);
    assert.deepEqual(codes(permits(stockScope(), stockAction({ issuer: 'issuer.fixture.omega' as never }), T0)), ['ISSUER_NOT_ALLOWED']);
    assert.deepEqual(codes(permits(stockScope(), stockAction({ synthetic: true }), T0)), ['SYNTHETIC_NOT_ALLOWED']);
    assert.deepEqual(codes(permits(stockScope(), stockAction({ rights: [] }), T0)), ['REQUIRED_RIGHT_MISSING']);
    assert.deepEqual(codes(permits(stockScope(), stockAction({ recipient: 'eip155:46630/account:0x9999999999999999999999999999999999999999' as never }), T0)), ['RECIPIENT_NOT_ALLOWED']);
    assert.deepEqual(codes(permits(stockScope(), stockAction({ leverage: { numerator: 1n, scale: 0 } as never }), T0)), ['LEVERAGE_NOT_ALLOWED']);
  });

  it('quotes: a quote-dependent action needs a quote-age bound; a stale or future-dated quote is stale', () => {
    const swapScope = S({ maxQuoteAgeSeconds: 60n });
    const base = stockAction({ quoteObservedAt: T0 - 60n });
    assert.deepEqual(permits(swapScope, base, T0), []);
    assert.deepEqual(codes(permits(swapScope, stockAction({ quoteObservedAt: T0 - 61n }), T0)), ['QUOTE_STALE']);
    assert.deepEqual(codes(permits(swapScope, stockAction({ quoteObservedAt: T0 + 1n }), T0)), ['QUOTE_STALE']);
    assert.deepEqual(codes(permits(S({ maxQuoteAgeSeconds: null }), base, T0)), ['QUOTE_NOT_ALLOWED']);
  });

  it('a swap route is checked hop by hop against the allowed venues', () => {
    const s = S({ venues: [GATE, 'eip155:421614/pool:0x0000000000000000000000000000000000000a01'] });
    assert.deepEqual(permits(s, stockAction({ route: ['eip155:421614/pool:0x0000000000000000000000000000000000000a01' as never] }), T0), []);
    assert.deepEqual(codes(permits(s, stockAction({ route: ['eip155:421614/pool:0x0000000000000000000000000000000000000bad' as never] }), T0)), ['ROUTE_NOT_ALLOWED']);
  });
});

describe('child execution authorizations', () => {
  const m = sampleMandate();
  const proposal = must(
    validateAgentProposal({
      portfolioMandate: portfolioMandateDigest(m),
      agent: STOCK,
      sequence: 1n,
      candidate: { kind: 'STOCK_BUY', representation: REP, account: ACCOUNT, quantity: 4_800_000_000_000_000_000n, claims: { ticker: 'NVDA', displayName: null, issuer: null, asset: null } },
      requested: [{ resource: 'portfolio-notional', atoms: USDC6(600n) }, { resource: 'spot-capital', atoms: USDC6(600n) }],
      minimum: [],
      utilityBps: 0n,
      createdAt: T0,
      expiresAt: T0 + 600n,
      criticalExtensions: [],
    }),
  );

  const derived = (): ChildExecutionAuthorization => {
    const r = deriveChildAuthorization(m, proposal, stockAction(), T0 + 1n);
    if (!r.ok) assert.fail(JSON.stringify(r.reasons));
    return r.value;
  };

  it('derives a child ⊆ its agent ⊆ the portfolio, windowed by the proposal, and it re-checks clean', () => {
    const c = derived();
    assert.equal(c.expiresAt, T0 + 600n);
    assert.equal(c.notBefore, T0);
    assert.deepEqual(checkChildAuthorization(m, c), []);
    assert.ok(isCanonical(encodeChildExecutionAuthorization(c), decodeChildExecutionAuthorization, encodeChildExecutionAuthorization));
    assert.match(childAuthorizationDigest(c), /^0x[0-9a-f]{64}$/);
  });

  it('refuses an action beyond the child authority: amount above the agent’s hard maximum, and above the portfolio limit', () => {
    const over = deriveChildAuthorization(m, proposal, stockAction({ demand: must(validateResourceVector([{ resource: 'portfolio-notional', atoms: USDC6(801n) }], 'd')) }), T0 + 1n);
    assert.deepEqual(over.ok ? [] : codes(over.reasons), ['AGENT_LIMIT_EXCEEDED']);
    const beyond = deriveChildAuthorization(m, proposal, stockAction({ demand: must(validateResourceVector([{ resource: 'portfolio-notional', atoms: USDC6(2_001n) }], 'd')) }), T0 + 1n);
    assert.deepEqual(beyond.ok ? [] : codes(beyond.reasons), ['AGENT_LIMIT_EXCEEDED', 'PORTFOLIO_LIMIT_EXCEEDED']);
  });

  it('refuses an expired proposal, an expired portfolio and an unknown agent', () => {
    const late = deriveChildAuthorization(m, proposal, stockAction(), T0 + 600n);
    assert.deepEqual(late.ok ? [] : codes(late.reasons), ['PROPOSAL_EXPIRED']);
    const expired = deriveChildAuthorization(m, proposal, stockAction(), T_END);
    assert.ok(!expired.ok && codes(expired.reasons).includes('PORTFOLIO_MANDATE_EXPIRED'));
    const stranger = deriveChildAuthorization(m, { ...proposal, agent: { kind: 'eip155-address', value: `0x${'77'.repeat(20)}` } } as never, stockAction(), T0 + 1n);
    assert.deepEqual(stranger.ok ? [] : codes(stranger.reasons), ['AGENT_UNKNOWN']);
  });

  it('a child altered after derivation fails the same check: wider scope, larger amount, longer window, other mandate', () => {
    const c = derived();
    const input = childExecutionAuthorizationInputOf(c);
    const tamper = (o: object) => checkChildAuthorization(m, must(validateChildExecutionAuthorization({ ...input, ...o })));
    assert.deepEqual(codes(tamper({ scope: { ...input.scope, representations: ['eip155:46630/erc20:0xfefefefefefefefefefefefefefefefefefefefe'] } })), ['CHILD_WIDENS_REPRESENTATIONS']);
    assert.deepEqual(codes(tamper({ approved: [{ resource: 'portfolio-notional', atoms: USDC6(900n) }] })), ['CHILD_WIDENS_RESOURCE_LIMIT']);
    assert.deepEqual(codes(tamper({ expiresAt: T_END + 1n })), ['CHILD_WIDENS_WINDOW']);
    assert.deepEqual(codes(tamper({ portfolioMandate: `0x${'cd'.repeat(32)}` })), ['PORTFOLIO_MANDATE_DIGEST_MISMATCH']);
    assert.deepEqual(codes(tamper({ scope: { ...input.scope, recipients: ['eip155:46630/account:0x9999999999999999999999999999999999999999'] } })), ['CHILD_WIDENS_RECIPIENTS']);
  });
});
