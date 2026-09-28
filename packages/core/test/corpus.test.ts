/**
 * The committed Core canonical-encoding corpus.
 *
 * Two obligations, as for every corpus in this repository: the committed file
 * is exactly what the generator produces, and this implementation reproduces
 * every vector from its readable input — canonical bytes, digest, and refusal
 * code for every negative vector.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { actionPayloadDigest, bytesToHex, hexToBytes, reservationIdFor, validateModuleRef, type ActionId, type ReservationGeneration } from '../src/index.ts';
import { JSON_CODECS, type JsonValue } from './support/cases.ts';
import { CORE_CORPUS_PATH, CORE_CORPUS_VERSION, serializeCorpus } from './support/generate-core-corpus.ts';
import { PERP_V1, PERP_V2, must } from './support/fixtures.ts';

interface Corpus {
  corpusVersion: number;
  tags: { [type: string]: string };
  vectorCount: number;
  vectors: { id: string; type: string; input: JsonValue; canonical: string; digest: string | null }[];
  derivations: { id: string; derives: string; input: { actionId?: string; generation?: string; moduleDigest?: string; payload?: string }; digest: string }[];
  negative: { id: string; type: string; bytes: string; error: string }[];
}

const corpus = JSON.parse(readFileSync(CORE_CORPUS_PATH, 'utf8')) as Corpus;

function codec(type: string): (typeof JSON_CODECS)[string] {
  const c = JSON_CODECS[type];
  assert.ok(c !== undefined, `no codec for ${type}`);
  return c;
}

describe('corpus/core-v1', () => {
  it('the committed corpus is the one this package generates', () => {
    assert.equal(readFileSync(CORE_CORPUS_PATH, 'utf8'), serializeCorpus());
  });

  it('metadata is consistent and covers every object type the brief requires', () => {
    assert.equal(corpus.corpusVersion, CORE_CORPUS_VERSION);
    assert.equal(corpus.vectorCount, corpus.vectors.length);
    const types = new Set(corpus.vectors.map((v) => v.type));
    for (const t of ['PrincipalPolicy', 'AuthorityGrant', 'ActionEnvelope', 'StateEnvelope', 'StateBinding', 'EconomicQuantity', 'ModuleRef', 'ReservationRef', 'ExecutionBindingRef']) {
      assert.ok(types.has(t), t);
    }
    const ids = [...corpus.vectors, ...corpus.derivations, ...corpus.negative].map((v) => v.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  for (const v of corpus.vectors) {
    it(`${v.id}: input → canonical bytes → digest, and the bytes round-trip`, () => {
      const c = codec(v.type);
      assert.equal(bytesToHex(must(c.encodeJson(v.input))), v.canonical);
      assert.equal(c.digestJson(v.input), v.digest);
      const bytes = hexToBytes(v.canonical);
      assert.deepEqual(must(c.reencode(bytes)), bytes);
      // The tag named in the corpus is the one the bytes begin with.
      const tag = corpus.tags[v.type] as string;
      assert.equal(new TextDecoder().decode(bytes.subarray(2, 2 + tag.length)), tag);
    });
  }

  for (const d of corpus.derivations) {
    it(`${d.id}: derived identity reproduces`, () => {
      if (d.derives === 'ReservationId') {
        assert.equal(reservationIdFor(d.input.actionId as ActionId, BigInt(d.input.generation as string) as ReservationGeneration), d.digest);
      } else {
        const module = [PERP_V1, PERP_V2].find((m) => m.moduleDigest === d.input.moduleDigest);
        assert.ok(module !== undefined);
        assert.equal(must(actionPayloadDigest(must(validateModuleRef(module)), hexToBytes(d.input.payload as string))), d.digest);
      }
    });
  }

  for (const n of corpus.negative) {
    it(`${n.id}: refused with ${n.error}`, () => {
      assert.equal(codec(n.type).decodeError(hexToBytes(n.bytes))?.code, n.error);
    });
  }
});
