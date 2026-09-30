/**
 * Scene 10: every receipt event is a real PORTFOLIO_RECEIPT.V2 — its digest
 * recomputes from the run's receipt, the first is the committed corpus
 * receipt — and the summary only copies what the receipt says.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PORTFOLIO_RECEIPT_SCHEMA_VERSION, PortfolioTag, receiptDigest } from '@mandate/portfolio';
import { judgeDemo } from './support/demo.ts';

const demo = judgeDemo();
const corpus = JSON.parse(readFileSync(new URL('../../../corpus/portfolio-demo-v1/receipt.json', import.meta.url), 'utf8')) as { receiptDigest: string; schema: string };

describe('scene 10: Portfolio Receipt V2', () => {
  it('one receipt per Portfolio run, each recomputing from the run’s own receipt', async () => {
    const { protocol, transcript } = await demo;
    const events = transcript.events.filter((e) => e.kind === 'PORTFOLIO_RECEIPT_CREATED');
    const runs = [protocol.initial, protocol.attack, protocol.compliant, protocol.conflict];
    assert.deepEqual(events.map((e) => e.run), ['initial', 'attack', 'compliant', 'conflict']);
    for (const [i, e] of events.entries()) {
      const run = runs[i];
      assert.ok(run !== undefined);
      assert.equal(e.artifacts.find((a) => a.name === 'receiptDigest')?.value, receiptDigest(run.receipt));
      assert.equal(receiptDigest(run.receipt), run.digest);
      assert.equal(e.data['schema'], PortfolioTag.RECEIPT);
    }
    assert.equal(PortfolioTag.RECEIPT, 'PORTFOLIO_RECEIPT.V2');
    assert.equal(PORTFOLIO_RECEIPT_SCHEMA_VERSION, 2);
    assert.equal(events[0]?.artifacts[0]?.value, corpus.receiptDigest);
    assert.equal(corpus.schema, 'PORTFOLIO_RECEIPT.V2');
    assert.equal(new Set(events.map((e) => e.artifacts[0]?.value)).size, 4);
  });

  it('the summary is the receipt’s own content: blocked codes, claims, children, reservations, asset decisions, evidence', async () => {
    const { protocol, transcript } = await demo;
    const r = protocol.initial.receipt;
    const s = transcript.events.find((e) => e.kind === 'PORTFOLIO_RECEIPT_CREATED' && e.run === 'initial')?.data;
    assert.ok(s !== undefined);
    assert.equal(s['portfolioMandate'], r.portfolioMandate);
    assert.equal(s['principal'], r.principal);
    assert.equal(s['allocationMode'], 'HYBRID');
    assert.equal((s['proposals'] as readonly unknown[]).length, r.proposals.length);
    assert.deepEqual((s['blocked'] as readonly { codes: readonly string[] }[]).map((b) => b.codes.length > 0), [true, true, true, true]);
    assert.deepEqual((s['reductions'] as readonly unknown[]).length, 2);
    const claims = s['claims'] as readonly { agent: string; from: string | null; resource: string; atoms: string }[];
    assert.deepEqual(claims.filter((c) => c.from === 'nft' && c.resource === 'portfolio-notional').map((c) => [c.agent, c.atoms]), [['stock', '100000000'], ['swap', '50000000'], ['yield', '100000000']]);
    assert.deepEqual((s['selectedActions'] as readonly { child: string }[]).map((c) => c.child), r.childAuthorizations.map((c) => c.child));
    assert.deepEqual((s['reservations'] as readonly { status: string }[]).map((x) => x.status), ['RESERVED', 'RESERVED', 'RESERVED', 'RESERVED']);
    const assets = s['canonicalAssetDecisions'] as readonly { status: string }[];
    assert.deepEqual(assets.map((a) => a.status).sort(), ['ADMISSIBLE', 'EXCLUDED']);
    assert.deepEqual((s['executions'] as readonly { evidence: string }[]).map((x) => x.evidence).sort(), ['OFFCHAIN_ONLY', 'OFFCHAIN_ONLY', 'SIMULATED', 'SIMULATED']);
    assert.equal(s['transactions'], 0);
  });
});
