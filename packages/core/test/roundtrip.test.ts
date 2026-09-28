/**
 * Canonical encoding round trips (ADR 0002's obligation, carried to Core).
 *
 * For every canonical Core object:
 *
 *     construct → validate → encode → decode → validate → encode
 *
 * is byte-identical, the object's own input form reproduces it, and its JSON
 * form (bigints as decimal strings) validates to the same bytes. The second
 * direction, `encode(decode(b)) == b`, is what proves canonicality: if two byte
 * strings decoded to one value, re-encoding would reveal it.
 *
 * The negative half corrupts each canonical encoding in every structural way
 * a decoder must refuse, and requires a structured error rather than a throw
 * or a silently repaired value.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CoreTag,
  CORE_SCHEMA_VERSION,
  decodeActionEnvelope,
  decodeAuthorityGrant,
  decodePrincipalPolicy,
  decodeStateBinding,
  encodeActionEnvelope,
  encodeAuthorityGrant,
  encodePrincipalPolicy,
  validateActionEnvelope,
  validateAuthorityGrant,
  validatePrincipalPolicy,
} from '../src/index.ts';
import { coreCases } from './support/cases.ts';
import { BTC_PERP_L, ETH_PERP_L, must, sampleActionInput, sampleGrantInput, samplePolicyInput } from './support/fixtures.ts';

const utf8 = new TextEncoder();

function tagLength(tag: string): number {
  return 2 + utf8.encode(tag).length;
}

describe('round trip: every canonical Core object', () => {
  for (const c of coreCases()) {
    it(`${c.type}: validate → encode → decode → validate → encode is byte-identical`, () => {
      const first = c.canonical();
      const second = c.reencode(first);
      assert.ok(second.ok, `decode failed: ${second.ok ? '' : `${second.error.code} at ${second.error.path}`}`);
      assert.deepEqual(second.value, first);
      const third = c.reencode(second.value);
      assert.ok(third.ok);
      assert.deepEqual(third.value, first);
    });

    it(`${c.type}: the object's own input form and its JSON form reproduce the same bytes`, () => {
      const bytes = c.canonical();
      assert.deepEqual(c.reencodeViaInputOf(), bytes);
      assert.deepEqual(c.canonicalFromJson(), bytes);
    });

    it(`${c.type}: truncation at every length is refused with a structured error`, () => {
      const bytes = c.canonical();
      for (let n = 0; n < bytes.length; n += 1) {
        const error = c.decodeError(bytes.subarray(0, n));
        assert.ok(error !== null, `truncated to ${n} bytes decoded`);
      }
    });

    it(`${c.type}: trailing bytes are refused`, () => {
      const bytes = c.canonical();
      const extended = new Uint8Array(bytes.length + 1);
      extended.set(bytes);
      assert.equal(c.decodeError(extended)?.code, 'ENCODING_TRAILING_BYTES');
    });

    it(`${c.type}: an unsupported schema version is refused`, () => {
      const bytes = c.canonical().slice();
      const tagEnd = 2 + ((bytes[0] as number) << 8 | (bytes[1] as number));
      bytes[tagEnd + 1] = CORE_SCHEMA_VERSION + 1;
      assert.equal(c.decodeError(bytes)?.code, 'ENCODING_UNSUPPORTED_VERSION');
    });

    it(`${c.type}: every single-byte corruption is refused or decodes to a different canonical encoding, never a crash`, () => {
      const bytes = c.canonical();
      for (let i = 0; i < bytes.length; i += 1) {
        const mutated = bytes.slice();
        mutated[i] = (mutated[i] as number) ^ 0x01;
        const r = c.reencode(mutated);
        if (r.ok) assert.deepEqual(r.value, mutated, `byte ${i}: accepted but not canonical`);
      }
    });
  }
});

describe('decoding refuses what the encoder never writes', () => {
  it('a buffer with another object type\'s tag', () => {
    const grant = encodeAuthorityGrant(must(validateAuthorityGrant(sampleGrantInput())));
    assert.equal(decodeActionEnvelope(grant).ok, false);
    const r = decodePrincipalPolicy(grant);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'ENCODING_WRONG_TAG');
  });

  it('a set written out of canonical order', () => {
    const input = sampleActionInput();
    const action = must(validateActionEnvelope(input));
    const bytes = encodeActionEnvelope(action);
    // resources are [L_SUB, USDG_ON_L] in canonical order; find the two encoded
    // elements and swap them. The decoder must refuse; it must not re-sort.
    const encodedA = encodeResource(action.resources[0] as { domain: string; kind: string; localId: string });
    const encodedB = encodeResource(action.resources[1] as { domain: string; kind: string; localId: string });
    const at = indexOf(bytes, concat(encodedA, encodedB));
    assert.ok(at > 0);
    const swapped = bytes.slice();
    swapped.set(concat(encodedB, encodedA), at);
    const r = decodeActionEnvelope(swapped);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'ENCODING_NON_CANONICAL');
  });

  it('a duplicated set member', () => {
    // Duplicates cannot be written by the encoder, and the validator refuses them on input.
    const dup = validateAuthorityGrant({
      ...sampleGrantInput(),
      terms: [{ kind: 'SET', vocabulary: 'MARKETS', members: [BTC_PERP_L, ETH_PERP_L, BTC_PERP_L] }],
    });
    assert.ok(!dup.ok);
    assert.equal(dup.error.code, 'DUPLICATE_SET_MEMBER');
    assert.equal(dup.error.path, 'grant.terms[0].members');
  });

  it('a presence flag other than 0 or 1', () => {
    // The state binding's `validUntil` flag follows the observation time; set it to 2.
    const c = coreCases().find((x) => x.type === 'StateBinding');
    assert.ok(c !== undefined);
    const bytes = c.canonical();
    let refusedAsFlag = false;
    for (let i = tagLength(CoreTag.STATE_BINDING) + 2; i < bytes.length; i += 1) {
      if (bytes[i] !== 0) continue;
      const mutated = bytes.slice();
      mutated[i] = 2;
      const r = decodeStateBinding(mutated);
      if (!r.ok && r.error.code === 'ENCODING_INVALID_FLAG') refusedAsFlag = true;
    }
    assert.ok(refusedAsFlag);
  });

  it('an unknown enum wire code', () => {
    const policy = encodePrincipalPolicy(must(validatePrincipalPolicy(samplePolicyInput())));
    // The first term's kind code sits right after the principal, sequence and term count.
    const mutated = policy.slice();
    const offset = tagLength(CoreTag.PRINCIPAL_POLICY) + 2 + 2 + 'eip155-address'.length + 2 + 42 + 8 + 2;
    mutated[offset] = 0xee;
    const r = decodePrincipalPolicy(mutated);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'ENCODING_UNKNOWN_CODE');
  });

  it('something that is not bytes at all', () => {
    const r = decodeAuthorityGrant('0x00' as unknown as Uint8Array);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'WRONG_TYPE');
  });
});

describe('field order at construction never changes the encoding', () => {
  it('sets and term lists in any order produce the same grant digest', () => {
    const a = sampleGrantInput();
    const reversedTerms = [...a.terms].reverse().map((t) =>
      t.kind === 'SET' ? { ...t, members: [...t.members].reverse() } : t,
    ) as typeof a.terms;
    const b = { ...a, terms: reversedTerms };
    assert.deepEqual(
      encodeAuthorityGrant(must(validateAuthorityGrant(a))),
      encodeAuthorityGrant(must(validateAuthorityGrant(b))),
    );
  });

  it('object key order is irrelevant', () => {
    const a = sampleActionInput();
    const entries = Object.entries(a).reverse();
    const b = Object.fromEntries(entries) as typeof a;
    assert.deepEqual(encodeActionEnvelope(must(validateActionEnvelope(a))), encodeActionEnvelope(must(validateActionEnvelope(b))));
  });

  it('resource order in an action is irrelevant', () => {
    const a = sampleActionInput();
    const b = { ...a, resources: [...a.resources].reverse() };
    assert.deepEqual(encodeActionEnvelope(must(validateActionEnvelope(a))), encodeActionEnvelope(must(validateActionEnvelope(b))));
  });
});

// --- helpers --------------------------------------------------------------------

function encodeResource(r: { domain: string; kind: string; localId: string }): Uint8Array {
  const codes: { [k: string]: number } = { MARKET: 1, CANONICAL_ASSET: 2, REPRESENTATION_ASSET: 3, ACCOUNT: 4, VENUE: 5, RECIPIENT: 6, PROPOSAL: 7 };
  const d = utf8.encode(r.domain);
  const l = utf8.encode(r.localId);
  return concat(new Uint8Array([d.length >> 8, d.length & 255]), d, new Uint8Array([codes[r.kind] as number]), new Uint8Array([l.length >> 8, l.length & 255]), l);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
