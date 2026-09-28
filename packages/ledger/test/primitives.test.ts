/**
 * The ledger's primitives: the persistent map every snapshot is built on, the
 * revocation object, and exact rescaling.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PMap, compareScaled, decodeRevocation, encodeRevocation, rescaleExact, revocationId, revocationInputOf, validateRevocation } from '../src/index.ts';
import { P, TRADING, digestOf, int, must, prng } from './support/basics.ts';

describe('PMap: persistent, structurally shared map', () => {
  it('agrees with a mutable Map over random inserts and overwrites, and old versions never change', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const rand = prng(seed);
      let m = PMap.empty<number>();
      const reference = new Map<string, number>();
      const versions: { map: PMap<number>; copy: Map<string, number> }[] = [];
      for (let i = 0; i < 600; i += 1) {
        // A small key space forces overwrites; long keys and prefixes exercise the trie depth.
        const key = `k${int(rand, 0, 400)}${rand() < 0.1 ? ':suffix' : ''}`;
        m = m.set(key, i);
        reference.set(key, i);
        if (i % 97 === 0) versions.push({ map: m, copy: new Map(reference) });
      }
      assert.equal(m.size, reference.size);
      for (const [k, v] of reference) assert.equal(m.get(k), v);
      assert.equal(m.get('absent'), undefined);
      assert.deepEqual(m.sortedKeys(), [...reference.keys()].sort());
      for (const { map, copy } of versions) {
        assert.equal(map.size, copy.size);
        for (const [k, v] of copy) assert.equal(map.get(k), v);
      }
    }
  });

  it('handles full 32-bit hash collisions', () => {
    // "Aa" and "BB" collide under many string hashes; find FNV-1a collisions by brute force over a small alphabet.
    const seen = new Map<number, string>();
    const collisions: [string, string][] = [];
    const hash = (key: string): number => {
      let h = 0x811c9dc5;
      for (let i = 0; i < key.length; i += 1) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
      return h >>> 0;
    };
    for (let i = 0; collisions.length < 3 && i < 2_000_000; i += 1) {
      const key = `c${i.toString(36)}`;
      const h = hash(key);
      const prev = seen.get(h);
      if (prev !== undefined) collisions.push([prev, key]);
      else seen.set(h, key);
    }
    assert.ok(collisions.length > 0, 'no collision found');
    let m = PMap.empty<string>();
    for (const [a, b] of collisions) m = m.set(a, `v${a}`).set(b, `v${b}`);
    for (const [a, b] of collisions) {
      assert.equal(m.get(a), `v${a}`);
      assert.equal(m.get(b), `v${b}`);
      m = m.set(b, 'overwritten');
      assert.equal(m.get(b), 'overwritten');
      assert.equal(m.get(a), `v${a}`);
    }
    assert.equal(m.size, collisions.length * 2);
  });
});

describe('Revocation object', () => {
  const input = { target: digestOf('node'), issuer: P, effectiveAt: 1_790_812_800n, nonce: 7n };

  it('round-trips canonically and has a stable, content-derived identity', () => {
    const r = must(validateRevocation(input));
    const bytes = encodeRevocation(r);
    const back = must(decodeRevocation(bytes));
    assert.deepEqual(encodeRevocation(back), bytes);
    assert.equal(revocationId(back), revocationId(r));
    assert.deepEqual(must(validateRevocation(revocationInputOf(r))), r);
    // The tag is the one Phase 7B reserved for revocations.
    assert.ok(new TextDecoder().decode(bytes).includes('mandate-core/v1/revocation'));
  });

  it('changes identity when any field changes', () => {
    const ids = new Set([
      revocationId(must(validateRevocation(input))),
      revocationId(must(validateRevocation({ ...input, target: digestOf('other') }))),
      revocationId(must(validateRevocation({ ...input, issuer: TRADING }))),
      revocationId(must(validateRevocation({ ...input, effectiveAt: 1n }))),
      revocationId(must(validateRevocation({ ...input, nonce: 8n }))),
    ]);
    assert.equal(ids.size, 5);
  });

  it('refuses unknown fields, JavaScript numbers, trailing bytes and a wrong tag', () => {
    assert.equal(validateRevocation({ ...input, reason: 'x' } as typeof input).ok, false);
    assert.equal(validateRevocation({ ...input, nonce: 7 as unknown as bigint }).ok, false);
    const bytes = encodeRevocation(must(validateRevocation(input)));
    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    const t = decodeRevocation(trailing);
    assert.ok(!t.ok && t.error.code === 'ENCODING_TRAILING_BYTES');
    const wrong = bytes.slice();
    wrong[3] = (wrong[3] as number) ^ 1;
    assert.equal(decodeRevocation(wrong).ok, false);
  });
});

describe('exact scale', () => {
  it('rescales up exactly, down only without loss, and compares across scales without rounding', () => {
    assert.equal(rescaleExact(123n, 2, 6), 1_230_000n);
    assert.equal(rescaleExact(1_230_000n, 6, 2), 123n);
    assert.equal(rescaleExact(1_230_001n, 6, 2), null);
    assert.equal(compareScaled(100n, 2, 1n, 0), 0);
    assert.equal(compareScaled(101n, 2, 1n, 0), 1);
    assert.equal(compareScaled(99_999_999n, 8, 1n, 0), -1);
  });
});
