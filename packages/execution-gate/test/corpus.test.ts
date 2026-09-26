import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { GATE_ERRORS, errorSignature, selectorOf } from '../src/index.ts';
import { MAX_EXECUTION_DATA_BYTES, MAX_PROFILE_SET_SIZE, decodeGateCandidate, decodeGateMandate } from '../src/model.ts';
import { abiEncodeArguments, bytes, CANDIDATE, MANDATE, TERMS, tuple } from './support/abi.ts';
import { READABLE_PATH, SEEDED_PRECISION_COUNT, generateGateCorpus, serialize } from './support/generate-gate-corpus.ts';
import { baseBuy, sign } from './support/world.ts';

const REPO_ROOT = new URL('../../../', import.meta.url);

/** Kernel IDENTIFIER_MAX_LENGTH. */
const IDENTIFIER_MAX = 128;
/** Pinned by contracts/test/Profile.t.sol as well; the two must agree. */
const WORST_CASE_CALLDATA_BYTES = 18_596;

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

  it('agrees with the actual kernel on every seeded maxNotional precision combination, including the M-1 shape', () => {
    // The generator throws before writing if the kernel's MAX_NOTIONAL_EXCEEDED
    // and the gate's MaxNotionalExceeded disagree on any vector; this pins that
    // the sweep is not vacuous on either side of the rule.
    const tally = generated.readable['precisionAgreement'] as Record<string, number>;
    assert.equal(tally['vectors'], SEEDED_PRECISION_COUNT);
    assert.ok((tally['declaredWithinButTrueAbove'] ?? 0) >= 16, 'too few coarse-precision bypass shapes');
    assert.ok((tally['admittedByBoth'] ?? 0) >= 16, 'too few admitted precision combinations');
    const authority = generated.readable['authorityVectors'] as { id: string; kernelReasonCodes: string[] }[];
    for (const id of ['authority-017', 'authority-018', 'authority-019', 'authority-020']) {
      const v = authority.find((a) => a.id === id);
      assert.ok(v !== undefined, id);
      assert.deepEqual(v.kernelReasonCodes, ['MAX_NOTIONAL_EXCEEDED'], id);
    }
  });

  it('reproduces the worst-case executable calldata Profile.t.sol settles, byte for byte in size', () => {
    // Every string a deployment or mandate can choose is a maximal identifier;
    // every set is at the profile maximum with the one entry the market needs;
    // route data is 4,096 non-zero bytes. Same shape as contracts/test/Profile.t.sol.
    const id = (head: string, index: number): string =>
      head + 'x'.repeat(IDENTIFIER_MAX - head.length - 2) + String(index).padStart(2, '0');
    const set = (head: string, required: string): string[] => {
      const maximal = required.length === IDENTIFIER_MAX;
      return [required, ...Array.from({ length: MAX_PROFILE_SET_SIZE - 1 }, (_, i) => id(head, maximal ? i + 1 : i))];
    };
    const asset = { assetClass: id('class.', 0), idScheme: id('scheme.', 0), value: id('value.', 0) };
    const [issuer, venue, qunit, sunit] = [id('issuer.', 0), id('venue.', 0), id('qunit.', 0), id('sunit.', 0)];
    const base = baseBuy();
    const attempt = sign({
      mandate: {
        ...base.mandate,
        mandateId: '0x' + 'ff'.repeat(32),
        nonce: 2n ** 64n - 1n,
        canonicalAsset: asset,
        maxNotional: { unit: sunit, decimals: 0, atoms: 2n ** 256n - 1n },
        economicLimit: { unit: sunit, decimals: 0, atoms: 2n ** 256n - 1n },
        allowedIssuers: set('issuer.', issuer),
        allowedChains: set('chain.', base.candidate.chain),
        allowedVenues: set('venue.', venue),
        requiredCorporateActionEpoch: 2n ** 64n - 1n,
        maxPriceAgeSeconds: 2n ** 32n - 1n,
        maxCorporateActionAgeSeconds: 2n ** 32n - 1n,
      },
      candidate: {
        ...base.candidate,
        canonicalAsset: asset,
        issuer,
        venue,
        quantity: { ...base.candidate.quantity, unit: qunit },
        executionPrice: { ...base.candidate.executionPrice, numeratorUnit: sunit, denominatorUnit: qunit },
        notional: { ...base.candidate.notional, unit: sunit },
        feeTotal: { ...base.candidate.feeTotal, unit: sunit },
        evaluationStateId: id('state.', 0),
        evaluationStateDigest: '0x' + 'ff'.repeat(32),
        registrySnapshotDigest: '0x' + 'ff'.repeat(32),
        corporateActionEpoch: 2n ** 64n - 1n,
      },
      terms: { ...base.terms, deadline: 2n ** 64n - 1n, executionData: '0x' + 'ff'.repeat(MAX_EXECUTION_DATA_BYTES) },
    });
    // The kernel accepts both halves: this is an executable shape, not merely an encodable one.
    assert.ok(decodeGateMandate(attempt.mandate).ok);
    assert.ok(decodeGateCandidate(attempt.candidate).ok);
    const args = tuple(
      ['mandate', MANDATE],
      ['principalSignature', bytes],
      ['candidate', CANDIDATE],
      ['terms', TERMS],
      ['agentSignature', bytes],
    );
    const calldata = `ffffffff${abiEncodeArguments(args, attempt).slice(2)}`;
    const size = calldata.length / 2;
    assert.equal(size, WORST_CASE_CALLDATA_BYTES, 'must equal Profile.t.sol WORST_CASE_CALLDATA_BYTES');
    // 95,000 bytes is Nitro's default max-tx-data-size: keep at least 50% headroom.
    assert.ok(size < 47_500);
    let nonZero = 0;
    for (let k = 0; k < calldata.length; k += 2) if (calldata.slice(k, k + 2) !== '00') nonZero += 1;
    assert.ok(21_000 + 16 * nonZero + 4 * (size - nonZero) < 21_000 + 16 * size);
  });
});
