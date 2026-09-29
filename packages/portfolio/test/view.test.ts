/**
 * The UI data contract: everything a frontend needs to animate "5 agents,
 * multiple markets, one principal authority" — without parsing logs, and
 * with every amount exact and every evidence class honest.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_STATUSES, EVIDENCE_CLASSES, PORTFOLIO_STATUSES, portfolioView } from '../src/index.ts';
import { runDemo } from '../src/demo/index.ts';

const run = runDemo();

describe('the portfolio view', () => {
  it('headline: five agents, five markets, one principal, zero transactions', async () => {
    const r = await run;
    const v = portfolioView(r.core, r);
    assert.deepEqual(v.headline, { agents: 5, markets: 5, principals: 1, proposals: 10, refusals: 6, transactions: 0 });
    assert.equal(v.status, 'COMPLETE');
    assert.equal(v.receiptDigest, r.digest);
  });

  it('the timeline walks ACTIVE → NEGOTIATING → AUTHORIZED → EXECUTING → COMPLETE, with a status for every agent at every step', async () => {
    const r = await run;
    const v = portfolioView(r.core, r);
    assert.deepEqual(v.timeline.map((t) => t.portfolio), ['ACTIVE', 'NEGOTIATING', 'NEGOTIATING', 'NEGOTIATING', 'AUTHORIZED', 'EXECUTING', 'COMPLETE']);
    for (const t of v.timeline) {
      assert.equal(t.agents.length, 5);
      for (const a of t.agents) assert.ok((AGENT_STATUSES as readonly string[]).includes(a.status), a.status);
      assert.ok((PORTFOLIO_STATUSES as readonly string[]).includes(t.portfolio));
    }
    const of = (label: string) => v.timeline.map((t) => t.agents.find((a) => a.label === label)?.status);
    assert.deepEqual(of('stock'), ['SEARCHING', 'BLOCKED', 'AUTHORIZED', 'AUTHORIZED', 'AUTHORIZED', 'AUTHORIZED', 'AUTHORIZED']);
    assert.deepEqual(of('yield'), ['SEARCHING', 'BLOCKED', 'RENEGOTIATING', 'AUTHORIZED', 'AUTHORIZED', 'EXECUTING', 'SETTLED']);
    assert.deepEqual(of('perps'), ['SEARCHING', 'RENEGOTIATING', 'AUTHORIZED', 'AUTHORIZED', 'AUTHORIZED', 'AUTHORIZED', 'AUTHORIZED']);
    assert.deepEqual(of('nft'), ['SEARCHING', 'BLOCKED', 'RELEASING', 'RELEASING', 'RELEASING', 'RELEASING', 'RELEASING']);
  });

  it('one row per proposal with every field the UI shows; amounts are exact decimal strings with units', async () => {
    const r = await run;
    const v = portfolioView(r.core, r);
    assert.equal(v.proposals.length, 10);
    for (const p of v.proposals) {
      for (const k of ['agent', 'domain', 'asset', 'representation', 'venue', 'requested', 'approved', 'reasons', 'execution', 'evidence', 'integrationEvidence']) assert.ok(k in p, k);
      for (const a of [...p.requested, ...p.approved]) assert.match(a.amount, /^\d+\.\d{6}$/);
      if (p.outcome !== 'ACCEPTED') assert.equal(p.transactions, 0);
      if (p.integrationEvidence !== null) assert.ok((EVIDENCE_CLASSES as readonly string[]).includes(p.integrationEvidence));
    }
    const lookalike = v.proposals.find((p) => p.label === 'stock' && p.outcome === 'REJECTED');
    assert.deepEqual(lookalike?.registry, { status: 'EXCLUDED', codes: ['ISSUER_NOT_ALLOWED', 'SYNTHETIC_NOT_ALLOWED'] });
    assert.equal(lookalike?.asset, null, 'an unresolved identity shows no asset');
    const approved = v.proposals.find((p) => p.label === 'stock' && p.outcome === 'ACCEPTED');
    assert.equal(approved?.asset, 'equity:figi:BBG000BBJQV0');
    assert.equal(approved?.execution, 'AWAITING_DOMAIN_SIGNER');
    assert.equal(approved?.integrationEvidence, 'LIVE_TESTNET');
    assert.equal(approved?.evidence, 'OFFCHAIN_ONLY', 'this run did not execute it');
  });

  it('never claims five live integrations: each domain states its own evidence class', async () => {
    const r = await run;
    const v = portfolioView(r.core, r);
    assert.deepEqual(v.domains.map((d) => `${d.domain}:${d.evidence}`), ['robinhood-evm:LIVE_TESTNET', 'swap-fixture:FIXTURE', 'nft-fixture:FIXTURE', 'yield-fixture:FIXTURE', 'lighter-perp:OFFCHAIN_ONLY']);
    assert.deepEqual(v.resources.find((x) => x.resource === 'portfolio-notional'), { resource: 'portfolio-notional', unit: 'USDC', limit: '2000.000000', reservedBefore: '0.000000', reservedAfter: '1900.000000' });
  });
});
