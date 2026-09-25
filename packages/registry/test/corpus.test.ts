/**
 * The committed registry corpus must match what the generator produces.
 *
 * A compatibility contract that drifts from the implementation is worse than none:
 * a reimplementer would target a decision this package no longer makes. If this
 * test fails, decide whether the behaviour change was intended before regenerating.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildRegistryCorpus,
  REGISTRY_CORPUS_PATH,
  serializeRegistryCorpus,
} from './support/generate-corpus.ts';
import { ALL_REGISTRY_REASON_CODE_NAMES } from '../src/index.ts';

test('the committed registry corpus matches the generator', () => {
  assert.equal(
    readFileSync(REGISTRY_CORPUS_PATH, 'utf8'),
    serializeRegistryCorpus(),
    'corpus/registry-v1/vectors.json is stale; run `npm run registry-corpus:generate`',
  );
});

test('the corpus is reproducible across repeated generation', () => {
  // Determinism of the whole pipeline: worlds, digests, resolutions and decisions.
  assert.equal(serializeRegistryCorpus(), serializeRegistryCorpus());
});

test('vector ids are unique and stable in shape', () => {
  const corpus = buildRegistryCorpus() as { vectors: { id: string; family: string }[]; vectorCount: number };
  const ids = corpus.vectors.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(corpus.vectorCount, corpus.vectors.length);
  for (const id of ids) assert.match(id, /^registry-\d{3}$/);
});

test('every vector is self-contained', () => {
  const corpus = buildRegistryCorpus() as {
    vectors: { input: Record<string, unknown>; expected: Record<string, unknown> }[];
  };
  for (const vector of corpus.vectors) {
    // A reimplementer needs the snapshot and the mandate, or the vector is not a
    // contract they can execute against.
    assert.ok(vector.input['snapshot'] !== undefined, 'missing snapshot');
    assert.ok(vector.input['mandate'] !== undefined, 'missing mandate');
    assert.match(vector.expected['snapshotDigest'] as string, /^0x[0-9a-f]{64}$/);
    assert.ok(Array.isArray(vector.expected['resolutions']));
    assert.ok(Array.isArray(vector.expected['decisions']));
  }
});

test('all four resolution outcomes appear in the corpus', () => {
  const corpus = buildRegistryCorpus() as {
    vectors: { expected: { resolutions: { status: string }[] } }[];
  };
  const seen = new Set<string>();
  for (const vector of corpus.vectors) {
    for (const resolution of vector.expected.resolutions) seen.add(resolution.status);
  }
  assert.deepEqual([...seen].sort(), ['AMBIGUOUS', 'INVALID', 'RESOLVED', 'UNKNOWN']);
});

test('every registry exclusion reason code is exercised by a vector or is resolution-only', () => {
  // The registry's coverage map. A code no vector produces is either dead or
  // untested, and both are worth knowing about.
  const corpus = buildRegistryCorpus() as {
    vectors: {
      expected: { resolutions: { reasonCode?: string }[]; decisions: { reasonCodes: string[] }[] };
    }[];
  };
  const produced = new Set<string>();
  for (const vector of corpus.vectors) {
    for (const resolution of vector.expected.resolutions) {
      if (resolution.reasonCode !== undefined) produced.add(resolution.reasonCode);
    }
    for (const decision of vector.expected.decisions) {
      for (const code of decision.reasonCodes) produced.add(code);
    }
  }
  // Both of these are construction-time refusals: a snapshot that does not parse
  // never becomes a vector, because a vector's input must open. They are covered
  // by unit tests instead, and are the codes deliberately absent here.
  const constructionOnly = new Set(['SNAPSHOT_MALFORMED', 'SNAPSHOT_RESOURCE_LIMIT_EXCEEDED']);
  const missing = ALL_REGISTRY_REASON_CODE_NAMES.filter(
    (name) => !produced.has(name) && !constructionOnly.has(name),
  );
  assert.deepEqual(missing, [], `registry reason codes with no vector: ${missing.join(', ')}`);
});
