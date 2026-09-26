import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { GATE_ERRORS, errorSignature, selectorOf } from '../src/index.ts';
import { READABLE_PATH, generateGateCorpus, serialize } from './support/generate-gate-corpus.ts';

const REPO_ROOT = new URL('../../../', import.meta.url);

describe('gate differential corpus', () => {
  const generated = generateGateCorpus();

  it('matches the committed corpus byte for byte', () => {
    // If this fails, decide whether the behaviour change was intended before
    // running `npm run gate-corpus:generate`.
    const committed = readFileSync(new URL(READABLE_PATH, REPO_ROOT), 'utf8');
    assert.equal(committed, serialize(generated.readable));
  });

  it('is deterministic, including the seeded mutations and the ABI form', () => {
    const again = generateGateCorpus();
    assert.equal(serialize(again.readable), serialize(generated.readable));
    assert.equal(serialize(again.abi), serialize(generated.abi));
  });

  it('produces every refusal the gate can make during execution, and settlements on both sides', () => {
    const vectors = generated.readable['vectors'] as { attempts: { expected: { settled: boolean; revertData: string } }[] }[];
    const selectors = new Set<string>();
    let buys = 0;
    for (const v of vectors) for (const a of v.attempts) {
      if (a.expected.settled) buys += 1;
      else selectors.add(a.expected.revertData.slice(0, 10));
    }
    const missing = Object.entries(GATE_ERRORS)
      .filter(([name]) => name !== 'InvalidMarket') // constructor-only; covered by Foundry unit tests
      .filter(([name, types]) => !selectors.has(selectorOf(errorSignature(name, types))))
      .map(([name]) => name);
    assert.deepEqual(missing, []);
    assert.ok(buys > 20);
  });

  it('carries every ABI entry the readable corpus lists, in the same order', () => {
    const counts = generated.readable['counts'] as Record<string, number>;
    const abi = generated.abi as { vectors: string[]; mandateEncodings: string[]; candidateEncodings: string[] };
    assert.equal(abi.vectors.length, counts['vectors']);
    assert.equal(abi.mandateEncodings.length, counts['mandateEncodings']);
    assert.equal(abi.candidateEncodings.length, counts['candidateEncodings']);
  });
});
