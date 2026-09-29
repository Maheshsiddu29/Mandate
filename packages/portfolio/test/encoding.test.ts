/**
 * PORTFOLIO_MANDATE.V1, proposals and candidates: one canonical encoding,
 * duplicates and malformed input refused, no trailing bytes, domain-separated
 * signatures, and authoring order that never reaches a digest.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ByteWriter } from '@mandate/kernel';
import {
  candidateDigest,
  decodeAgentProposal,
  decodePortfolioMandate,
  encodeActionCandidate,
  encodeAgentProposal,
  encodePortfolioMandate,
  isCanonical,
  mandateSignedByPrincipal,
  mandateSigningHash,
  portfolioMandateDigest,
  proposalDigest,
  proposalSignedByAgent,
  proposalSigningHash,
  validateActionCandidate,
  validateAgentProposal,
  validatePortfolioMandate,
  type ActionCandidateInput,
  type AgentProposalInput,
} from '../src/index.ts';
import { signHash } from './support/keys.ts';
import { NVDA, OUTSIDER_KEY, codeOf, PERPS_KEY, PRINCIPAL, PRINCIPAL_KEY, STOCK, STOCK_KEY, T0, USDC6, mandateInput, must, sampleMandate, scope } from './support/mandate.ts';

const noClaims = { ticker: null, displayName: null, issuer: null, asset: null };

const CANDIDATES: readonly ActionCandidateInput[] = [
  { kind: 'STOCK_BUY', representation: 'eip155:46630/erc20:0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', account: `eip155:46630/account:${PRINCIPAL.value}`, quantity: 4_800_000_000_000_000_000n, claims: { ticker: 'NVDA', displayName: null, issuer: 'issuer.fixture.alpha', asset: NVDA } },
  { kind: 'SWAP_EXACT_IN', router: 'eip155:421614/router:0x0000000000000000000000000000000000005a01', route: ['pool:zeta', 'pool:alpha'], tokenIn: 'eip155:421614/erc20:0x0000000000000000000000000000000000000c01', tokenOut: 'eip155:421614/erc20:0x00000000000000000000000000000000000e7401', amountIn: USDC6(300n), quotedOut: 100_000_000_000_000_000n, minOut: 99_500_000_000_000_000n, quoteObservedAt: T0, recipient: `eip155:421614/account:${PRINCIPAL.value}`, claims: noClaims },
  { kind: 'NFT_BUY', marketplace: 'eip155:421614/marketplace:0x000000000000000000000000000000000000b0b0', collection: 'eip155:421614/erc721:0x000000000000000000000000000000000000c011', tokenId: 7n, maxPrice: USDC6(250n), recipient: `eip155:421614/account:${PRINCIPAL.value}`, claims: { ticker: null, displayName: 'Mandate-Genesis', issuer: null, asset: null } },
  { kind: 'YIELD_DEPOSIT', product: 'eip155:421614/erc4626:0x000000000000000000000000000000000000fa01', amount: USDC6(600n), quotedApyBps: 520, quoteObservedAt: T0, recipient: `eip155:421614/account:${PRINCIPAL.value}`, claims: { ticker: null, displayName: null, issuer: 'issuer.fixture.vault', asset: null } },
  { kind: 'PERP_OPEN', market: 'lighter:300/perp:4096', account: 'lighter:300/account:281474976710600', side: 'LONG', size: 400n, price: 1_000_000n, initialMarginFraction: 5_000, claims: noClaims },
];

function proposalInput(o: Partial<AgentProposalInput> = {}): AgentProposalInput {
  return {
    portfolioMandate: portfolioMandateDigest(sampleMandate()),
    agent: STOCK,
    sequence: 1n,
    candidate: CANDIDATES[0] as ActionCandidateInput,
    requested: [{ resource: 'portfolio-notional', atoms: USDC6(600n) }, { resource: 'spot-capital', atoms: USDC6(600n) }],
    minimum: [{ resource: 'portfolio-notional', atoms: USDC6(500n) }],
    utilityBps: -25n,
    createdAt: T0,
    expiresAt: T0 + 300n,
    criticalExtensions: [],
    ...o,
  };
}

describe('Portfolio Mandate v1 encoding', () => {
  it('round-trips byte for byte, and the digest is keccak of the encoding', () => {
    const m = sampleMandate();
    const bytes = encodePortfolioMandate(m);
    assert.ok(isCanonical(bytes, decodePortfolioMandate, encodePortfolioMandate));
    assert.equal(portfolioMandateDigest(must(decodePortfolioMandate(bytes))), portfolioMandateDigest(m));
    assert.equal(new TextDecoder().decode(bytes.subarray(2, 2 + 'PORTFOLIO_MANDATE.V1'.length)), 'PORTFOLIO_MANDATE.V1');
  });

  it('authoring order never reaches the digest: sets, resources, limits and agents are canonical', () => {
    const base = mandateInput();
    const shuffled = {
      ...base,
      resources: [...base.resources].reverse(),
      limits: [...base.limits].reverse(),
      agents: [...base.agents].reverse(),
      scope: { ...base.scope, domains: [...base.scope.domains].reverse(), assets: [...base.scope.assets].reverse(), recipients: [...base.scope.recipients].reverse() },
    };
    assert.equal(portfolioMandateDigest(must(validatePortfolioMandate(shuffled))), portfolioMandateDigest(sampleMandate()));
  });

  it('every field is committed: changing one changes the digest', () => {
    const d = portfolioMandateDigest(sampleMandate());
    for (const o of [{ nonce: 8n }, { policyVersion: 2n }, { expiresAt: T0 + 1n + 30n * 86_400n }, { allocationMode: 'DYNAMIC' }, { scope: scope({ maxSlippageBps: 99 }) }]) {
      assert.notEqual(portfolioMandateDigest(sampleMandate(o)), d, JSON.stringify(o, (_, v: bigint | string) => (typeof v === 'bigint' ? v.toString() : v)));
    }
  });

  it('refuses duplicates rather than collapsing them', () => {
    const base = mandateInput();
    const dupResource = { ...base, resources: [...base.resources, { ...(base.resources[0] as (typeof base.resources)[number]), decimals: 2 }] };
    assert.equal(codeOf(validatePortfolioMandate(dupResource)), 'DUPLICATE_SET_MEMBER');
    const dupAgent = { ...base, agents: [...base.agents, { ...(base.agents[0] as (typeof base.agents)[number]), label: 'another' }] };
    assert.equal(codeOf(validatePortfolioMandate(dupAgent)), 'DUPLICATE_SET_MEMBER');
    const dupMember = { ...base, scope: scope({ chains: ['eip155:46630', 'eip155:46630'] }) };
    assert.equal(codeOf(validatePortfolioMandate(dupMember)), 'DUPLICATE_SET_MEMBER');
    const dupLimit = { ...base, limits: [...base.limits, { resource: 'portfolio-notional', atoms: 1n }] };
    assert.equal(codeOf(validatePortfolioMandate(dupLimit)), 'DUPLICATE_SET_MEMBER');
  });

  it('refuses malformed input by name: unknown fields, enums, identifiers, non-ledger kinds, inverted windows', () => {
    const base = mandateInput();
    const cases: [object, string][] = [
      [{ ...base, extra: 1 }, 'UNKNOWN_FIELD'],
      [{ ...base, allocationMode: 'MOSTLY' }, 'UNKNOWN_ENUM_VALUE'],
      [{ ...base, scope: scope({ actions: ['STOCK_SELL'] }) }, 'UNKNOWN_ENUM_VALUE'],
      [{ ...base, scope: scope({ venues: ['has space'] }) }, 'MALFORMED_IDENTIFIER'],
      [{ ...base, resources: [{ resource: 'x', kind: 'GROSS_EXPOSURE', unit: 'USD', decimals: 2, domain: null }] }, 'UNKNOWN_ENUM_VALUE'],
      [{ ...base, resources: [{ resource: 'x', kind: 'COUNT', unit: 'USD', decimals: 0, domain: null }] }, 'COUNT_UNIT_REQUIRED'],
      [{ ...base, notBefore: base.expiresAt }, 'INVALID_TIME_WINDOW'],
      [{ ...base, scope: scope({ maxSlippageBps: 10_001 }) }, 'INTEGER_OUT_OF_RANGE'],
      [{ ...base, limits: [{ resource: 'portfolio-notional', atoms: -1n }] }, 'QUANTITY_NEGATIVE_UNSIGNED'],
      [{ ...base, nonce: 1 }, 'NUMBER_NOT_PERMITTED'],
    ];
    for (const [input, code] of cases) {
      const r = validatePortfolioMandate(input as never);
      assert.equal(r.ok ? 'ok' : r.error.code, code);
    }
  });

  it('decoding fails closed: wrong tag, wrong version, truncation, trailing bytes, misordered sets, unknown codes', () => {
    const bytes = encodePortfolioMandate(sampleMandate());
    const withTrailing = new Uint8Array([...bytes, 0]);
    assert.equal(codeOf(decodePortfolioMandate(withTrailing)), 'ENCODING_TRAILING_BYTES');
    assert.equal(decodePortfolioMandate(bytes.subarray(0, bytes.length - 1)).ok, false);
    const wrongTag = new ByteWriter().str('PORTFOLIO_PROPOSAL.V1').u16(1).raw(bytes.subarray(2 + 'PORTFOLIO_MANDATE.V1'.length + 2)).finish();
    assert.equal(codeOf(decodePortfolioMandate(wrongTag)), 'ENCODING_WRONG_TAG');
    const v2 = new Uint8Array(bytes);
    v2[2 + 'PORTFOLIO_MANDATE.V1'.length + 1] = 2;
    assert.equal(codeOf(decodePortfolioMandate(v2)), 'ENCODING_UNSUPPORTED_VERSION');
    // The allocation mode's wire code sits right after principal, versions, nonce and window.
    const prefix = new ByteWriter().str('PORTFOLIO_MANDATE.V1').u16(1).str(PRINCIPAL.kind).str(PRINCIPAL.value).u64(1n).u64(7n).i64(T0).i64(T0 + 30n * 86_400n).finish();
    const badMode = new Uint8Array(bytes);
    badMode[prefix.length] = 9;
    assert.equal(codeOf(decodePortfolioMandate(badMode)), 'ENCODING_UNKNOWN_CODE');
    assert.equal(decodePortfolioMandate(new Uint8Array()).ok, false);
    assert.equal(codeOf(decodePortfolioMandate('not bytes' as never)), 'WRONG_TYPE');
  });

  it('a set written out of order is refused as non-canonical, not re-sorted', () => {
    // A domains set written descending (same-length members, so only byte order differs).
    const w = new ByteWriter().str('PORTFOLIO_MANDATE.V1').u16(1).str(PRINCIPAL.kind).str(PRINCIPAL.value).u64(1n).u64(7n).i64(T0).i64(T0 + 10n).u8(3).u16(0);
    w.u16(2).str('zeta').str('beta');
    const r = decodePortfolioMandate(w.finish());
    assert.equal(codeOf(r), 'ENCODING_NON_CANONICAL');
  });

  it('only the principal’s key signs the mandate, and the signing hash is domain-separated', () => {
    const m = sampleMandate();
    const digest = portfolioMandateDigest(m);
    assert.ok(mandateSignedByPrincipal(m, signHash(mandateSigningHash(digest), PRINCIPAL_KEY)));
    assert.equal(mandateSignedByPrincipal(m, signHash(mandateSigningHash(digest), OUTSIDER_KEY)), false);
    assert.equal(mandateSignedByPrincipal(m, `0x${'00'.repeat(65)}`), false);
    assert.equal(mandateSignedByPrincipal(m, 'nonsense'), false);
    // A signature the principal made over a proposal hash of the same digest does not verify as a mandate signature.
    assert.equal(mandateSignedByPrincipal(m, signHash(proposalSigningHash(digest as never), PRINCIPAL_KEY)), false);
    // Nor over the raw digest.
    assert.equal(mandateSignedByPrincipal(m, signHash(new Uint8Array(Buffer.from(digest.slice(2), 'hex')), PRINCIPAL_KEY)), false);
  });
});

describe('action candidates', () => {
  it('every kind round-trips; a route keeps its order because a route is a path, not a set', () => {
    for (const input of CANDIDATES) {
      const c = must(validateActionCandidate(input));
      const digest = candidateDigest(c);
      assert.match(digest, /^0x[0-9a-f]{64}$/);
      assert.equal(candidateDigest(must(validateActionCandidate(input))), digest);
    }
    const swap = CANDIDATES[1] as Extract<ActionCandidateInput, { kind: 'SWAP_EXACT_IN' }>;
    const reversed = must(validateActionCandidate({ ...swap, route: [...swap.route].reverse() }));
    assert.notEqual(candidateDigest(reversed), candidateDigest(must(validateActionCandidate(swap))));
    assert.ok(encodeActionCandidate(reversed).length > 0);
  });

  it('claims are committed — a different ticker is a different candidate — but are separate fields from identity', () => {
    const stock = CANDIDATES[0] as Extract<ActionCandidateInput, { kind: 'STOCK_BUY' }>;
    const other = must(validateActionCandidate({ ...stock, claims: { ...stock.claims, ticker: 'NVDX' } }));
    assert.notEqual(candidateDigest(other), candidateDigest(must(validateActionCandidate(stock))));
  });

  it('refuses zero amounts, a minimum above the quote, an empty route, a zero margin fraction and unknown kinds', () => {
    const [stock, swap, , , perp] = CANDIDATES as [Extract<ActionCandidateInput, { kind: 'STOCK_BUY' }>, Extract<ActionCandidateInput, { kind: 'SWAP_EXACT_IN' }>, ActionCandidateInput, ActionCandidateInput, Extract<ActionCandidateInput, { kind: 'PERP_OPEN' }>];
    const code = (i: object) => {
      const r = validateActionCandidate(i as ActionCandidateInput);
      return r.ok ? 'ok' : r.error.code;
    };
    assert.equal(code({ ...stock, quantity: 0n }), 'INTEGER_OUT_OF_RANGE');
    assert.equal(code({ ...swap, minOut: 100_000_000_000_000_001n }), 'INTEGER_OUT_OF_RANGE');
    assert.equal(code({ ...swap, route: [] }), 'COLLECTION_EMPTY');
    assert.equal(code({ ...swap, route: ['a', 'b', 'c', 'd', 'e'] }), 'COLLECTION_TOO_LARGE');
    assert.equal(code({ ...perp, initialMarginFraction: 0 }), 'INTEGER_OUT_OF_RANGE');
    assert.equal(code({ ...perp, side: 'SIDEWAYS' }), 'UNKNOWN_ENUM_VALUE');
    assert.equal(code({ ...stock, kind: 'STOCK_SELL' }), 'UNKNOWN_ENUM_VALUE');
    assert.equal(code({ ...stock, venue: 'x' }), 'UNKNOWN_FIELD');
  });
});

describe('agent proposals', () => {
  it('round-trip canonically and bind the mandate digest, candidate and every declared figure', () => {
    const p = must(validateAgentProposal(proposalInput()));
    const bytes = encodeAgentProposal(p);
    assert.ok(isCanonical(bytes, decodeAgentProposal, encodeAgentProposal));
    const d = proposalDigest(p);
    for (const o of [{ sequence: 2n }, { utilityBps: -24n }, { requested: [{ resource: 'portfolio-notional', atoms: USDC6(601n) }] }, { portfolioMandate: `0x${'ab'.repeat(32)}` }, { criticalExtensions: ['mev-protection'] }]) {
      assert.notEqual(proposalDigest(must(validateAgentProposal(proposalInput(o)))), d);
    }
  });

  it('authentication: the agent’s own key signs; another key, another proposal or a mandate-domain signature do not', () => {
    const p = must(validateAgentProposal(proposalInput()));
    const d = proposalDigest(p);
    assert.ok(proposalSignedByAgent(p, signHash(proposalSigningHash(d), STOCK_KEY)));
    assert.equal(proposalSignedByAgent(p, signHash(proposalSigningHash(d), PERPS_KEY)), false);
    assert.equal(proposalSignedByAgent(p, signHash(mandateSigningHash(d as never), STOCK_KEY)), false);
    const other = must(validateAgentProposal(proposalInput({ sequence: 2n })));
    assert.equal(proposalSignedByAgent(other, signHash(proposalSigningHash(d), STOCK_KEY)), false);
  });

  it('refuses malformed proposals: a window that ends before it starts, bad digests, duplicate extensions', () => {
    const code = (o: Partial<AgentProposalInput>) => {
      const r = validateAgentProposal(proposalInput(o));
      return r.ok ? 'ok' : r.error.code;
    };
    assert.equal(code({ expiresAt: T0 }), 'INVALID_TIME_WINDOW');
    assert.equal(code({ portfolioMandate: '0xABC' }), 'MALFORMED_DIGEST');
    assert.equal(code({ criticalExtensions: ['x', 'x'] }), 'DUPLICATE_SET_MEMBER');
    assert.equal(code({ utilityBps: 2n ** 63n }), 'INTEGER_OUT_OF_RANGE');
    const bytes = encodeAgentProposal(must(validateAgentProposal(proposalInput())));
    assert.equal(decodeAgentProposal(new Uint8Array([...bytes, 1])).ok, false);
  });
});
