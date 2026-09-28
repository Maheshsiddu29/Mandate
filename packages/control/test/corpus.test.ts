/**
 * The committed control authorization corpus (brief §60): the committed file
 * is exactly what the generator produces from the engine, and it covers every
 * scenario the brief requires with the outcome that scenario must have.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONTROL_CORPUS_PATH, CONTROL_CORPUS_VERSION, serializeCorpus } from './support/generate-control-corpus.ts';

interface Corpus {
  corpusVersion: number;
  vectorCount: number;
  vectors: { id: string; outcome: { status?: string; refusal?: { code: string; reason: string }; first?: { status: string }; second?: { status: string; refusal?: { code: string } } } }[];
}

const corpus = JSON.parse(readFileSync(CONTROL_CORPUS_PATH, 'utf8')) as Corpus;

describe('corpus/control-v1', () => {
  it('the committed corpus is the one the engine generates', async () => {
    assert.equal(readFileSync(CONTROL_CORPUS_PATH, 'utf8'), await serializeCorpus());
  });

  it('covers every required scenario with its required outcome', () => {
    assert.equal(corpus.corpusVersion, CONTROL_CORPUS_VERSION);
    assert.equal(corpus.vectorCount, corpus.vectors.length);
    const by = new Map(corpus.vectors.map((v) => [v.id, v.outcome]));
    const code = (id: string) => by.get(id)?.refusal?.code;
    assert.equal(by.get('valid-authorization')?.status, 'AUTHORIZED');
    assert.equal(code('missing-state'), 'STATE_MISSING');
    assert.equal(code('stale-state'), 'STATE_STALE');
    assert.equal(code('global-invariant-refusal'), 'INVARIANT_FAILED');
    assert.equal(code('pending-reservation-refusal'), 'INVARIANT_FAILED');
    assert.equal(by.get('semantic-narrowing-pass')?.status, 'REGISTERED');
    assert.equal(code('semantic-widening-refusal'), 'DELEGATION_REFUSED');
    const cas = by.get('cas-conflict-reprojection');
    assert.deepEqual([cas?.first?.status, cas?.second?.status].sort(), ['AUTHORIZED', 'REFUSED']);
    assert.equal(by.get('never-issued-closure')?.status, 'CLOSED');
  });
});
