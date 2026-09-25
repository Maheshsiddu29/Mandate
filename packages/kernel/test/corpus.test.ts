/**
 * Decision-vector corpus tests.
 *
 * Two obligations. First, the kernel reproduces every committed vector exactly
 * — the same contract a Solidity or Rust implementation will be held to.
 * Second, the committed file matches what the generator produces, so the corpus
 * cannot silently drift away from the verifier it is supposed to pin.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ALL_REASON_CODE_NAMES, Decision, VERIFIER_VERSION, verify } from '../src/index.ts';
import { CORPUS_PATH, CORPUS_VERSION, serializeCorpus } from './support/generate-corpus.ts';

interface Vector {
  readonly id: string;
  readonly family: string;
  readonly description: string;
  readonly input: Record<string, unknown>;
  readonly expected: {
    readonly decision: string;
    readonly reasonCodes: readonly string[];
    readonly mandateDigest: string | null;
    readonly candidateDigest: string | null;
    readonly trustedStateDigest: string | null;
    readonly receiptDigest: string;
  };
}

const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as {
  corpusVersion: number;
  verifierVersion: string;
  vectorCount: number;
  vectors: Vector[];
};

test('the committed corpus is the one this kernel generates', () => {
  // If this fails, either the verifier changed behaviour or the corpus was
  // hand-edited. Both need a deliberate `npm run corpus:generate` and a look at
  // the diff, because the corpus is a compatibility contract.
  assert.equal(readFileSync(CORPUS_PATH, 'utf8'), serializeCorpus());
});

test('corpus metadata is consistent', () => {
  assert.equal(corpus.corpusVersion, CORPUS_VERSION);
  assert.equal(corpus.verifierVersion, VERIFIER_VERSION);
  assert.equal(corpus.vectorCount, corpus.vectors.length);
  const ids = corpus.vectors.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length, 'vector ids must be unique');
  for (const v of corpus.vectors) {
    assert.ok(v.description.length > 20, `${v.id} needs a description`);
    for (const code of v.expected.reasonCodes) {
      assert.ok(ALL_REASON_CODE_NAMES.includes(code as never), `${v.id}: unknown reason code ${code}`);
    }
  }
});

test('the corpus covers every required family, with both outcomes represented', () => {
  const families = new Set(corpus.vectors.map((v) => v.family));
  const required = [
    'valid',
    'wrong-canonical-asset',
    'wrong-representation',
    'issuer-violation',
    'chain-violation',
    'synthetic-violation',
    'notional-overrun',
    'notional-boundary',
    'price-deviation-boundary',
    'stale-price',
    'trading-halt',
    'inactive-representation',
    'corporate-action-changed',
    'expired-mandate',
    'not-yet-active-mandate',
    'invalid-signature',
    'replay',
    'unit-mismatch',
    'malformed-identifier',
    'maximum-size-values',
  ];
  for (const f of required) assert.ok(families.has(f), `missing required family: ${f}`);

  const decisions = corpus.vectors.map((v) => v.expected.decision);
  assert.ok(decisions.includes('PASS'), 'the corpus must contain valid vectors');
  assert.ok(decisions.includes('REJECT'), 'the corpus must contain invalid vectors');
});

test('every vector reproduces exactly', () => {
  for (const v of corpus.vectors) {
    const receipt = verify({
      mandate: v.input['mandate'],
      authorization: v.input['authorization'],
      candidate: v.input['candidate'],
      trustedState: v.input['trustedState'],
      clock: v.input['clock'],
      expectedDomain: v.input['expectedDomain'],
    });

    assert.equal(receipt.decision, v.expected.decision, `${v.id}: decision`);
    assert.deepEqual([...receipt.reasonCodes].sort(), [...v.expected.reasonCodes], `${v.id}: reason codes`);
    assert.equal(receipt.mandateDigest, v.expected.mandateDigest, `${v.id}: mandate digest`);
    assert.equal(receipt.candidateDigest, v.expected.candidateDigest, `${v.id}: candidate digest`);
    assert.equal(receipt.trustedStateDigest, v.expected.trustedStateDigest, `${v.id}: trusted state digest`);
    assert.equal(receipt.receiptDigest, v.expected.receiptDigest, `${v.id}: receipt digest`);

    if (v.expected.decision === Decision.PASS) {
      assert.deepEqual(receipt.reasonCodes, [], `${v.id}: a PASS carries no reason codes`);
    } else {
      assert.ok(receipt.reasonCodes.length > 0, `${v.id}: a REJECT must name a reason`);
    }
  }
});

test('vector inputs carry no JSON numbers where an integer is meant', () => {
  // A JSON number would reintroduce IEEE-754 into the digest path. The parsers
  // refuse one; this asserts the corpus never contains one in the first place.
  const integerKeys = new Set([
    'nonce', 'atoms', 'maxDeviationBps', 'requiredCorporateActionEpoch', 'maxPriceAgeSeconds',
    'maxCorporateActionAgeSeconds', 'createdAtUnixSeconds', 'notBeforeUnixSeconds',
    'expiresAtUnixSeconds', 'corporateActionEpoch', 'observedAtUnixSeconds', 'nowUnixSeconds',
    'epoch', 'chainId',
  ]);
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
    if (node === null || typeof node !== 'object') return;
    for (const [k, value] of Object.entries(node as Record<string, unknown>)) {
      if (integerKeys.has(k) && typeof value === 'number') {
        assert.fail(`${path}.${k} is a JSON number; integers must be decimal strings`);
      }
      walk(value, `${path}.${k}`);
    }
  };
  for (const v of corpus.vectors) walk(v.input, v.id);
});
