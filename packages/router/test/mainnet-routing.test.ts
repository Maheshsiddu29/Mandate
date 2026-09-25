import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildMainnetRoutingCorpus, buildMainnetRoutingReport } from './support/mainnet-routing.ts';

function read(path: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../../corpus/mainnet-routing-v1/${path}`, import.meta.url), 'utf8'));
}

describe('recorded mainnet candidate-set routing replay', () => {
  it('matches the committed corpus and report', () => {
    assert.deepEqual(read('vectors.json'), buildMainnetRoutingCorpus());
    assert.deepEqual(read('report.json'), buildMainnetRoutingReport());
  });

  it('selects no malicious candidate and reproduces every receipt', () => {
    const report = buildMainnetRoutingReport();
    assert.equal(report['worldsEvaluated'], 6);
    assert.equal(report['unsafeCandidatesReachingExecutionHandoff'], 0);
    assert.equal(report['receiptReproductionFailures'], 0);
  });
});

