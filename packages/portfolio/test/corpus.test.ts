/**
 * corpus/portfolio-demo-v1: the committed files are exactly what the
 * generator produces, and they say what the demonstration must say.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hexToBytes } from '@mandate/core';
import { decodePortfolioMandate, portfolioMandateDigest } from '../src/index.ts';
import { PORTFOLIO_CORPUS_DIR, PORTFOLIO_CORPUS_VERSION, serializeCorpus } from './support/generate-portfolio-corpus.ts';

const read = (name: string) => readFileSync(join(PORTFOLIO_CORPUS_DIR, name), 'utf8');

describe('corpus/portfolio-demo-v1', () => {
  it('the committed corpus is exactly what the generator produces', async () => {
    const files = await serializeCorpus();
    assert.deepEqual(Object.keys(files).sort(), ['mandate.json', 'receipt.json', 'vectors.json', 'view.json']);
    for (const [name, content] of Object.entries(files)) assert.equal(read(name), content, name);
  });

  it('the committed mandate decodes, and its digest is the one the receipt names', () => {
    const mandate = JSON.parse(read('mandate.json')) as { corpusVersion: number; digest: string; encoding: string };
    assert.equal(mandate.corpusVersion, PORTFOLIO_CORPUS_VERSION);
    const decoded = decodePortfolioMandate(hexToBytes(mandate.encoding));
    assert.ok(decoded.ok);
    assert.equal(portfolioMandateDigest(decoded.value), mandate.digest);
    const receipt = JSON.parse(read('receipt.json')) as { receipt: { portfolioMandate: string; transactions: number } };
    assert.equal(receipt.receipt.portfolioMandate, mandate.digest);
    assert.equal(receipt.receipt.transactions, 0);
  });

  it('every screening vector has the outcome its scenario requires', () => {
    const v = JSON.parse(read('vectors.json')) as { vectorCount: number; vectors: { id: string; outcome: string; reasons: { code: string }[] }[] };
    assert.equal(v.vectorCount, v.vectors.length);
    const by = new Map(v.vectors.map((x) => [x.id, x]));
    const pass = ['stock/approved', 'swap/approved', 'nft/genuine', 'yield/approved-5.20', 'perps/400-at-2x'];
    for (const id of pass) assert.equal(by.get(id)?.outcome, 'PASS', id);
    assert.equal(by.get('perps/600-over-derivative-exposure')?.outcome, 'REDUCE');
    const refusedWith: [string, string][] = [
      ['stock/same-ticker-lookalike', 'REGISTRY:ISSUER_NOT_ALLOWED'],
      ['stock/unregistered-counterfeit', 'REGISTRY:REPRESENTATION_UNKNOWN'],
      ['swap/unknown-router', 'VENUE_NOT_ALLOWED'],
      ['swap/recipient-substituted', 'RECIPIENT_NOT_ALLOWED'],
      ['nft/same-name-impostor', 'REPRESENTATION_NOT_ALLOWED'],
      ['yield/unvetted-12.60', 'ISSUER_NOT_ALLOWED'],
      ['perps/5x-leverage', 'LEVERAGE_NOT_ALLOWED'],
      ['auth/outsider', 'AGENT_UNKNOWN'],
      ['auth/signed-by-another-agent', 'AGENT_SIGNATURE_INVALID'],
      ['form/unknown-critical-extension', 'PROPOSAL_EXTENSION_UNKNOWN'],
    ];
    for (const [id, code] of refusedWith) {
      assert.equal(by.get(id)?.outcome, 'REFUSED', id);
      assert.ok(by.get(id)?.reasons.some((r) => r.code === code), `${id}: ${code}`);
    }
  });
});
