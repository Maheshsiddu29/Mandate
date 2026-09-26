import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { GATE_ERRORS, errorSignature, selectorOf } from '../src/index.ts';
import { MAX_EXECUTION_DATA_BYTES, MAX_PROFILE_SET_SIZE } from '../src/model.ts';
import { abiEncodeArguments, bytes, CANDIDATE, MANDATE, TERMS, tuple } from './support/abi.ts';
import { READABLE_PATH, generateGateCorpus, serialize } from './support/generate-gate-corpus.ts';
import { baseBuy, sign } from './support/world.ts';

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
      // Constructor-only.
      .filter(([name]) => !['InvalidMarket', 'RealMarketStateSourceRequired', 'FixtureSettlementInconsistent'].includes(name))
      .filter(([name, types]) => !selectors.has(selectorOf(errorSignature(name, types))))
      .map(([name]) => name);
    assert.deepEqual(missing, []);
    assert.ok(buys > 20);
  });

  it('carries every ABI entry the readable corpus lists, in the same order', () => {
    const counts = generated.readable['counts'] as Record<string, number>;
    const abi = generated.abi as { vectors: string[]; authorityVectors: string[]; mandateEncodings: string[]; candidateEncodings: string[] };
    assert.equal(abi.vectors.length, counts['vectors']);
    assert.equal(abi.mandateEncodings.length, counts['mandateEncodings']);
    assert.equal(abi.candidateEncodings.length, counts['candidateEncodings']);
    assert.equal(abi.authorityVectors.length, counts['maliciousAgentKernelRejectAttempts']);
  });

  it('uses the actual kernel to select malicious-agent reject vectors, and none may settle', () => {
    const vectors = generated.readable['authorityVectors'] as {
      kernelDecision: string;
      kernelReasonCodes: string[];
      gateSettled: boolean;
      responsibility: string;
    }[];
    assert.ok(vectors.length >= 7);
    for (const vector of vectors) {
      assert.equal(vector.kernelDecision, 'REJECT');
      assert.equal(vector.responsibility, 'ONCHAIN_ENFORCED');
      assert.ok(vector.kernelReasonCodes.length > 0);
      assert.equal(vector.gateSettled, false);
    }
  });

  it('measures the worst-case Phase 6 profile calldata with headroom below the target default', () => {
    const identifiers = Array.from({ length: MAX_PROFILE_SET_SIZE }, (_, i) =>
      `id${i.toString().padStart(2, '0')}${'x'.repeat(124)}`,
    );
    const unsigned = baseBuy();
    const attempt = sign({
      mandate: {
        ...unsigned.mandate,
        allowedIssuers: identifiers,
        allowedChains: identifiers,
        allowedVenues: identifiers,
      },
      candidate: unsigned.candidate,
      terms: { ...unsigned.terms, executionData: '0x' + '00'.repeat(MAX_EXECUTION_DATA_BYTES) },
    });
    const args = tuple(
      ['mandate', MANDATE],
      ['principalSignature', bytes],
      ['candidate', CANDIDATE],
      ['terms', TERMS],
      ['agentSignature', bytes],
    );
    const encoded = abiEncodeArguments(args, attempt).slice(2);
    const calldata = `ffffffff${encoded}`;
    const bytesTotal = calldata.length / 2;
    let calldataGas = 0;
    for (let i = 0; i < calldata.length; i += 2) calldataGas += calldata.slice(i, i + 2) === '00' ? 4 : 16;
    assert.ok(bytesTotal < 47_500, `worst-case calldata ${bytesTotal} lacks 50% headroom below 95,000 bytes`);
    assert.ok(calldataGas + 21_000 < 1_000_000, `intrinsic calldata gas unexpectedly high: ${calldataGas + 21_000}`);
  });
});
