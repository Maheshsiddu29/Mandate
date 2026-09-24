/**
 * Canonical encoding and digest tests (ADR 0002).
 *
 * The round-trip is asserted in both directions. `decode(encode(x)) == x` shows
 * the decoder reads what the encoder wrote. `encode(decode(b)) == b` is the one
 * that establishes canonicality: if two distinct byte strings decoded to the
 * same value, re-encoding one of them would reveal it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ByteWriter,
  DomainTag,
  WIRE_TABLES,
  bytesToHex,
  candidateDigest,
  compareIdentifierBytes,
  decodeCandidate,
  decodeMandate,
  decodeTrustedState,
  encodeCandidate,
  encodeMandate,
  encodeTrustedState,
  mandateDigest,
  parseMandate,
  trustedStateDigest,
} from '../src/index.ts';
import {
  CHAIN,
  ISSUER,
  OTHER_CHAIN,
  VENUE,
  mandateInput,
  representationInput,
  syntheticRepresentationInput,
  validCandidate,
  validMandate,
  validState,
} from './support/fixtures.ts';

function indexOfSubsequence(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function expectOk<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  assert.equal(r.ok, true, r.ok ? '' : `unexpected error: ${r.error}`);
  return (r as { ok: true; value: T }).value;
}

test('mandate round-trips through the canonical encoding', () => {
  const m = validMandate();
  const bytes = encodeMandate(m);
  const back = expectOk(decodeMandate(bytes));
  assert.deepEqual(back, m);
  assert.deepEqual(encodeMandate(back), bytes);
});

test('candidate and trusted state round-trip', () => {
  const c = validCandidate();
  assert.deepEqual(expectOk(decodeCandidate(encodeCandidate(c))), c);

  const s = validState({}, [representationInput(), syntheticRepresentationInput()]);
  const decoded = expectOk(decodeTrustedState(encodeTrustedState(s)));
  assert.deepEqual(encodeTrustedState(decoded), encodeTrustedState(s));
});

test('allowlist order does not change the digest, but membership does', () => {
  const a = validMandate({ allowedChains: [CHAIN, OTHER_CHAIN] });
  const b = validMandate({ allowedChains: [OTHER_CHAIN, CHAIN] });
  assert.equal(mandateDigest(a), mandateDigest(b), 'authoring order must not affect the digest');

  const c = validMandate({ allowedChains: [CHAIN] });
  assert.notEqual(mandateDigest(a), mandateDigest(c), 'membership must affect the digest');
});

test('duplicate allowlist entries reject rather than collapsing', () => {
  const r = parseMandate(mandateInput({ allowedIssuers: [ISSUER, ISSUER] }));
  assert.equal(r.ok, false);
  assert.equal(r.ok ? '' : r.error, 'MALFORMED_MANDATE');
});

test('every security-relevant field change changes the mandate digest', () => {
  const base = mandateDigest(validMandate());
  const mutations: Record<string, Record<string, unknown>> = {
    mandateId: { mandateId: '0x' + '22'.repeat(32) },
    nonce: { nonce: 2n },
    principal: { principal: { kind: 'eip155-address', value: '0x' + '99'.repeat(20) } },
    agent: { agent: { kind: 'eip155-address', value: '0x' + '88'.repeat(20) } },
    canonicalAsset: { canonicalAsset: { assetClass: 'equity', idScheme: 'figi', value: 'BBG000000000' } },
    side: { side: 'SELL' },
    maxNotionalAtoms: { maxNotional: { unit: 'USD', decimals: 2, atoms: 100_001n } },
    maxNotionalUnit: { maxNotional: { unit: 'EUR', decimals: 2, atoms: 100_000n } },
    maxNotionalDecimals: { maxNotional: { unit: 'USD', decimals: 6, atoms: 100_000n } },
    maxDeviationBps: { maxDeviationBps: 41n },
    syntheticPolicy: { syntheticPolicy: 'ALLOWED' },
    allowedIssuers: { allowedIssuers: [ISSUER, 'issuer.beta'] },
    allowedChains: { allowedChains: [CHAIN, OTHER_CHAIN] },
    allowedVenues: { allowedVenues: [VENUE, 'venue.beta'] },
    requiredCorporateActionEpoch: { requiredCorporateActionEpoch: 8n },
    maxPriceAgeSeconds: { maxPriceAgeSeconds: 61n },
    haltPolicy: { haltPolicy: 'ALLOW_WHEN_HALTED' },
    createdAtUnixSeconds: { createdAtUnixSeconds: 1_799_999_000n },
    notBeforeUnixSeconds: { notBeforeUnixSeconds: 1_799_999_001n },
    expiresAtUnixSeconds: { expiresAtUnixSeconds: 1_800_000_601n },
  };

  const seen = new Map<string, string>([[base, 'baseline']]);
  for (const [field, override] of Object.entries(mutations)) {
    const d = mandateDigest(validMandate(override));
    assert.notEqual(d, base, `${field} must change the digest`);
    const collision = seen.get(d);
    assert.equal(collision, undefined, `${field} collided with ${collision}`);
    seen.set(d, field);
  }
});

test('trailing bytes reject rather than being ignored', () => {
  const bytes = encodeMandate(validMandate());
  const extended = new Uint8Array(bytes.length + 1);
  extended.set(bytes);
  const r = decodeMandate(extended);
  assert.equal(r.ok, false);
  assert.equal(r.ok ? '' : r.error, 'MALFORMED_MANDATE');
});

test('truncation at every length rejects and never throws', () => {
  const bytes = encodeMandate(validMandate());
  for (let i = 0; i < bytes.length; i += 1) {
    const r = decodeMandate(bytes.subarray(0, i));
    assert.equal(r.ok, false, `truncation at ${i} must reject`);
  }
});

test('a wrong domain tag never decodes as a mandate', () => {
  const candidateBytes = encodeCandidate(validCandidate());
  assert.equal(decodeMandate(candidateBytes).ok, false);
  assert.equal(decodeCandidate(encodeMandate(validMandate())).ok, false);
});

test('object digests are domain-separated', () => {
  const digests = new Set([
    mandateDigest(validMandate()),
    candidateDigest(validCandidate()),
    trustedStateDigest(validState()),
  ]);
  assert.equal(digests.size, 3);

  const tags = new Set(Object.values(DomainTag));
  assert.equal(tags.size, Object.keys(DomainTag).length, 'domain tags must be distinct');
});

test('an unknown mandate version rejects as such, not as malformed', () => {
  const bytes = encodeMandate(validMandate());
  const mutated = new Uint8Array(bytes);
  // The two bytes immediately after the ASCII tag are the schema version.
  mutated[DomainTag.MANDATE.length + 1] = 2;
  const r = decodeMandate(mutated);
  assert.equal(r.ok, false);
  assert.equal(r.ok ? '' : r.error, 'UNSUPPORTED_MANDATE_VERSION');
});

test('a set encoded out of order, or with duplicates, rejects', () => {
  // Both identifiers are the same byte length, so swapping them in place leaves
  // every other offset untouched: the only difference is set ordering.
  const m = validMandate({ allowedIssuers: ['issuer.aaa', 'issuer.bbb'] });
  const good = encodeMandate(m);

  const ascending = new ByteWriter().u16(2).str('issuer.aaa').str('issuer.bbb').finish();
  const descending = new ByteWriter().u16(2).str('issuer.bbb').str('issuer.aaa').finish();
  const duplicated = new ByteWriter().u16(2).str('issuer.aaa').str('issuer.aaa').finish();

  const at = indexOfSubsequence(good, ascending);
  assert.notEqual(at, -1, 'the ascending issuer set must appear in the encoding');
  assert.equal(indexOfSubsequence(good.subarray(at + 1), ascending), -1, 'the pattern must be unique');

  for (const [label, replacement] of [['descending', descending], ['duplicated', duplicated]] as const) {
    const mutated = new Uint8Array(good);
    mutated.set(replacement, at);
    assert.equal(mutated.length, good.length, 'the splice must not change length');
    const r = decodeMandate(mutated);
    assert.equal(r.ok, false, `a ${label} set must not decode`);
    assert.equal(r.ok ? '' : r.error, 'MALFORMED_MANDATE');
  }

  // The unmodified buffer still decodes, so the rejections above are caused by
  // the ordering change and not by the splice itself.
  assert.equal(decodeMandate(good).ok, true);
});

test('identifier byte order is length-first, matching the encoded form', () => {
  assert.equal(compareIdentifierBytes('b', 'ab') < 0, true, 'shorter sorts first regardless of content');
  assert.equal(compareIdentifierBytes('ab', 'ac') < 0, true);
  assert.equal(compareIdentifierBytes('ab', 'ab'), 0);

  // The comparator must agree with actual encoded-byte order.
  const encode = (s: string) => bytesToHex(new ByteWriter().str(s).finish());
  for (const [x, y] of [['b', 'ab'], ['ab', 'ac'], ['a', 'z']] as const) {
    const byComparator = compareIdentifierBytes(x, y) < 0;
    const byBytes = encode(x) < encode(y);
    assert.equal(byComparator, byBytes, `${x} vs ${y}`);
  }
});

test('wire tables cover every enum member and map back one-to-one', () => {
  for (const [name, table] of Object.entries(WIRE_TABLES)) {
    const members = Object.values(table.values) as string[];
    const codes = new Set<number>();
    for (const member of members) {
      const code = table.forward[member];
      assert.notEqual(code, undefined, `${name}.${member} has no wire code`);
      assert.equal(table.reverse[code as number], member, `${name} code ${code} does not map back`);
      assert.equal(codes.has(code as number), false, `${name} reuses code ${code}`);
      codes.add(code as number);
    }
    assert.equal(Object.keys(table.reverse).length, members.length, `${name} reverse table has extra entries`);
  }
});
