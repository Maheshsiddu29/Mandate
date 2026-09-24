/**
 * EIP-712 authorization tests (ADR 0001).
 *
 * The property that matters most here is the last one: the mandate digest is
 * chain-agnostic, so signing the same financial intent under two different
 * EIP-712 domains produces two different signatures over one unchanged digest.
 * If the domain ever leaked into the digest, that test fails.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  EIP712_DOMAIN_TYPE,
  MANDATE_AUTHORIZATION_TYPE,
  domainSeparator,
  eip712SigningHash,
  mandateAuthorizationStructHash,
  bytesToHex,
  hexToBytes,
  mandateDigest,
  parseAuthorizationEnvelope,
  verifyAuthorization,
  type Bytes32,
} from '../src/index.ts';
import { validMandate } from './support/fixtures.ts';
import { TEST_DOMAIN, TEST_PRIVATE_KEY, TEST_PRIVATE_KEY_2, addressOf, envelopeFor, signHash } from './support/signing.ts';

function expectOk<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  assert.equal(r.ok, true, r.ok ? '' : `unexpected error: ${r.error}`);
  return (r as { ok: true; value: T }).value;
}

function errorOf(r: { ok: true } | { ok: false; error: string }): string {
  assert.equal(r.ok, false, 'expected a rejection');
  return (r as { ok: false; error: string }).error;
}

test('a valid signature by the declared signer verifies', () => {
  const digest = mandateDigest(validMandate());
  const envelope = expectOk(parseAuthorizationEnvelope(envelopeFor(digest, TEST_PRIVATE_KEY)));
  const signer = expectOk(verifyAuthorization(envelope, digest, TEST_DOMAIN));
  assert.equal(signer.value, addressOf(TEST_PRIVATE_KEY));
});

test('a signature over a different digest does not verify', () => {
  const digest = mandateDigest(validMandate());
  const otherDigest = mandateDigest(validMandate({ nonce: 99n }));
  const envelope = expectOk(parseAuthorizationEnvelope(envelopeFor(otherDigest, TEST_PRIVATE_KEY)));
  assert.equal(errorOf(verifyAuthorization(envelope, digest, TEST_DOMAIN)), 'SIGNATURE_INVALID');
});

test('a signature by a different key does not verify as the declared signer', () => {
  const digest = mandateDigest(validMandate());
  const raw = envelopeFor(digest, TEST_PRIVATE_KEY_2);
  // Claim to be key 1 while actually signing with key 2.
  raw['signer'] = { kind: 'eip155-address', value: addressOf(TEST_PRIVATE_KEY) };
  const envelope = expectOk(parseAuthorizationEnvelope(raw));
  assert.equal(errorOf(verifyAuthorization(envelope, digest, TEST_DOMAIN)), 'SIGNATURE_INVALID');
});

test('a domain the caller did not ask for is rejected before any recovery', () => {
  const digest = mandateDigest(validMandate());
  const foreign = { ...TEST_DOMAIN, chainId: 1n };
  const envelope = expectOk(parseAuthorizationEnvelope(envelopeFor(digest, TEST_PRIVATE_KEY, foreign)));
  assert.equal(errorOf(verifyAuthorization(envelope, digest, TEST_DOMAIN)), 'AUTHORIZATION_DOMAIN_MISMATCH');

  for (const field of ['name', 'version', 'verifyingContract'] as const) {
    const altered = { ...TEST_DOMAIN, [field]: field === 'verifyingContract' ? '0x' + '02'.repeat(20) : 'other' };
    const e = expectOk(parseAuthorizationEnvelope(envelopeFor(digest, TEST_PRIVATE_KEY, altered)));
    assert.equal(errorOf(verifyAuthorization(e, digest, TEST_DOMAIN)), 'AUTHORIZATION_DOMAIN_MISMATCH', field);
  }
});

test('an unknown scheme rejects as unsupported, not as malformed', () => {
  const digest = mandateDigest(validMandate());
  const raw = envelopeFor(digest, TEST_PRIVATE_KEY);
  raw['scheme'] = 'ed25519-solana';
  assert.equal(errorOf(parseAuthorizationEnvelope(raw)), 'AUTHORIZATION_SCHEME_UNSUPPORTED');
});

test('high-s signatures are rejected as malleable', () => {
  const digest = mandateDigest(validMandate());
  const raw = envelopeFor(digest, TEST_PRIVATE_KEY);
  const sig = hexToBytes(raw['signature'] as string) as Uint8Array;

  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  let s = 0n;
  for (let i = 32; i < 64; i += 1) s = (s << 8n) | BigInt(sig[i] as number);

  // The malleable twin: (r, N - s) with the recovery bit flipped verifies
  // against the same key, so it must be refused rather than accepted as a
  // second valid form of one authorization.
  const flipped = new Uint8Array(sig);
  let t = N - s;
  for (let i = 63; i >= 32; i -= 1) {
    flipped[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  flipped[64] = (sig[64] as number) === 27 ? 28 : 27;
  raw['signature'] = bytesToHex(flipped);

  const envelope = expectOk(parseAuthorizationEnvelope(raw));
  assert.equal(errorOf(verifyAuthorization(envelope, digest, TEST_DOMAIN)), 'SIGNATURE_INVALID');
});

test('structurally invalid signatures reject without throwing', () => {
  const digest = mandateDigest(validMandate());
  const base = envelopeFor(digest, TEST_PRIVATE_KEY);

  const malformed = ['0x', '0xzz', '0x' + '00'.repeat(64), '0x' + 'aa'.repeat(66)];
  for (const signature of malformed) {
    assert.equal(errorOf(parseAuthorizationEnvelope({ ...base, signature })), 'MALFORMED_AUTHORIZATION', signature);
  }

  // Well-formed length, structurally impossible content.
  for (const [label, mutate] of [
    ['zero r and s', (b: Uint8Array) => b.fill(0, 0, 64)],
    ['bad v', (b: Uint8Array) => { b[64] = 29; }],
    ['v = 0', (b: Uint8Array) => { b[64] = 0; }],
  ] as const) {
    const bytes = hexToBytes(base['signature'] as string) as Uint8Array;
    const mutated = new Uint8Array(bytes);
    mutate(mutated);
    const envelope = expectOk(parseAuthorizationEnvelope({ ...base, signature: bytesToHex(mutated) }));
    assert.equal(errorOf(verifyAuthorization(envelope, digest, TEST_DOMAIN)), 'SIGNATURE_INVALID', label);
  }
});

test('the domain separator matches the published EIP-712 example', () => {
  // External known-answer vector from the EIP-712 specification's "Ether Mail"
  // example. This anchors the domain encoding to something outside this
  // repository, rather than to a second copy of our own formula.
  const etherMail = {
    name: 'Ether Mail',
    version: '1',
    chainId: 1n,
    verifyingContract: '0xcccccccccccccccccccccccccccccccccccccccc',
  } as const;
  assert.equal(
    bytesToHex(domainSeparator(etherMail)),
    '0xf2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f',
  );
  assert.equal(EIP712_DOMAIN_TYPE, 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
  assert.equal(MANDATE_AUTHORIZATION_TYPE, 'MandateAuthorization(bytes32 mandateDigest)');
});

test('the signing hash is 0x1901 over the domain separator and the struct hash', () => {
  // Checks the framing - prefix bytes and concatenation order - which is the
  // part a reimplementation gets wrong. The domain separator itself is anchored
  // externally by the test above.
  const digest = mandateDigest(validMandate());
  const structHash = mandateAuthorizationStructHash(digest);
  const framed = new Uint8Array(2 + 32 + 32);
  framed.set([0x19, 0x01], 0);
  framed.set(domainSeparator(TEST_DOMAIN), 2);
  framed.set(structHash, 34);
  assert.equal(bytesToHex(eip712SigningHash(TEST_DOMAIN, digest)), bytesToHex(keccak_256(framed)));
});

test('the mandate digest is chain-agnostic: one digest, many domains', () => {
  const m = validMandate();
  const digest: Bytes32 = mandateDigest(m);

  const arbitrum = { ...TEST_DOMAIN, chainId: 42161n };
  const mainnet = { ...TEST_DOMAIN, chainId: 1n };

  const a = expectOk(parseAuthorizationEnvelope(envelopeFor(digest, TEST_PRIVATE_KEY, arbitrum)));
  const b = expectOk(parseAuthorizationEnvelope(envelopeFor(digest, TEST_PRIVATE_KEY, mainnet)));

  // Different signatures, because the domain differs...
  assert.notEqual(a.signature, b.signature);
  // ...over one unchanged mandate digest. If the domain leaked into the mandate
  // encoding, these two would be authorizing different objects.
  assert.equal(mandateDigest(m), digest);
  assert.equal(expectOk(verifyAuthorization(a, digest, arbitrum)).value, addressOf(TEST_PRIVATE_KEY));
  assert.equal(expectOk(verifyAuthorization(b, digest, mainnet)).value, addressOf(TEST_PRIVATE_KEY));
});

test('signing is deterministic (RFC 6979), so vectors are reproducible', () => {
  const hash = hexToBytes('0x' + '42'.repeat(32)) as Uint8Array;
  assert.equal(signHash(hash, TEST_PRIVATE_KEY), signHash(hash, TEST_PRIVATE_KEY));
});
