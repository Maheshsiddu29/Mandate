/**
 * Portfolio mandate authority V2. The V1 prehash check is untouched: a V2
 * signature fails it, and a V1 signature fails V2. The room's default
 * (no authority argument) stays the V1 check.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addressOfKey, demoKey, demoMandate, signPrehash } from '../src/demo/index.ts';
import { mandateSignedByPrincipal, mandateSigningHash, portfolioMandateDigest } from '../src/mandate.ts';
import { mandateSignedByPrincipalV2, portfolioMandateV2Hash, portfolioMandateV2Statement, PORTFOLIO_AUTHORITY_V2, type PortfolioAuthorityV2 } from '../src/mandate-v2.ts';
import { mandateReasons } from '../src/room.ts';

const CHAIN = 46_630n;
const SESSION = `0x${'ab'.repeat(32)}`;
const OTHER_SESSION = `0x${'cd'.repeat(32)}`;
const WALLET_KEY = `0x${'11'.repeat(32)}`;
const NOW = demoMandate().notBefore;

function authority(sessionDigest = SESSION, chainId = CHAIN): PortfolioAuthorityV2 {
  return { scheme: PORTFOLIO_AUTHORITY_V2, chainId, sessionDigest };
}

describe('EIP-712 portfolio mandate V2', () => {
  it('accepts the principal’s own V2 signature and refuses every other one', () => {
    const key = demoKey('principal');
    const m = demoMandate();
    const hash = portfolioMandateV2Hash(m, { chainId: CHAIN, sessionDigest: SESSION });
    const signature = signPrehash(hash, key);
    assert.equal(mandateSignedByPrincipalV2(m, signature, { chainId: CHAIN, sessionDigest: SESSION }), true);
    assert.equal(mandateSignedByPrincipal(m, signature), false, 'a V2 signature is not a V1 prehash');
    assert.equal(mandateSignedByPrincipalV2(m, signature, { chainId: CHAIN, sessionDigest: OTHER_SESSION }), false);
    assert.equal(mandateSignedByPrincipalV2(m, signature, { chainId: 1n, sessionDigest: SESSION }), false);
    assert.equal(mandateSignedByPrincipalV2(m, signPrehash(hash, demoKey('outsider')), { chainId: CHAIN, sessionDigest: SESSION }), false);
    assert.equal(mandateSignedByPrincipalV2(m, signPrehash(mandateSigningHash(portfolioMandateDigest(m)), key), { chainId: CHAIN, sessionDigest: SESSION }), false);
    assert.equal(mandateSignedByPrincipalV2(m, '0x', { chainId: CHAIN, sessionDigest: SESSION }), false);
    assert.equal(mandateSignedByPrincipalV2(m, `0x${'00'.repeat(65)}`, { chainId: CHAIN, sessionDigest: SESSION }), false);
  });

  it('a different mandate does not verify, including when only the digest changes', () => {
    const m = demoMandate();
    const signature = signPrehash(portfolioMandateV2Hash(m, { chainId: CHAIN, sessionDigest: SESSION }), demoKey('principal'));
    const sameWords = demoMandate({ nonce: 2n });
    assert.equal(portfolioMandateV2Statement(m), portfolioMandateV2Statement(sameWords));
    assert.notEqual(portfolioMandateDigest(m), portfolioMandateDigest(sameWords));
    assert.equal(mandateSignedByPrincipalV2(sameWords, signature, { chainId: CHAIN, sessionDigest: SESSION }), false);
    const rewritten = demoMandate({ policyVersion: 9n });
    assert.notEqual(portfolioMandateV2Statement(m), portfolioMandateV2Statement(rewritten));
    assert.equal(mandateSignedByPrincipalV2(rewritten, signature, { chainId: CHAIN, sessionDigest: SESSION }), false);
  });

  it('recovers a wallet principal that is not the demonstration key', () => {
    const principal = { kind: 'eip155-address' as const, value: addressOfKey(WALLET_KEY) };
    const m = demoMandate({ principal });
    assert.equal(m.principal.value, principal.value);
    const signature = signPrehash(portfolioMandateV2Hash(m, { chainId: CHAIN, sessionDigest: SESSION }), WALLET_KEY);
    assert.equal(mandateSignedByPrincipalV2(m, signature, { chainId: CHAIN, sessionDigest: SESSION }), true);
    assert.equal(mandateSignedByPrincipalV2(m, signPrehash(portfolioMandateV2Hash(m, { chainId: CHAIN, sessionDigest: SESSION }), demoKey('principal')), { chainId: CHAIN, sessionDigest: SESSION }), false);
  });

  it('accepts a wallet v of 0 or 1 and refuses a truncated signature', () => {
    const m = demoMandate();
    const signature = signPrehash(portfolioMandateV2Hash(m, { chainId: CHAIN, sessionDigest: SESSION }), demoKey('principal'));
    const v = Number.parseInt(signature.slice(130), 16);
    const low = `${signature.slice(0, 130)}${(v - 27).toString(16).padStart(2, '0')}`;
    assert.equal(mandateSignedByPrincipalV2(m, low, { chainId: CHAIN, sessionDigest: SESSION }), true);
    assert.equal(mandateSignedByPrincipalV2(m, `${signature.slice(0, 130)}00`, { chainId: CHAIN, sessionDigest: SESSION }), true);
    assert.equal(mandateSignedByPrincipalV2(m, signature.slice(0, 130), { chainId: CHAIN, sessionDigest: SESSION }), false);
  });

  it('the room’s default stays the V1 verifier; V2 is accepted only when named', () => {
    const m = demoMandate();
    const v1 = signPrehash(mandateSigningHash(portfolioMandateDigest(m)), demoKey('principal'));
    const v2 = signPrehash(portfolioMandateV2Hash(m, { chainId: CHAIN, sessionDigest: SESSION }), demoKey('principal'));
    assert.deepEqual(mandateReasons(m, v1, NOW).map((r) => r.code), []);
    assert.deepEqual(mandateReasons(m, v2, NOW).map((r) => r.code), ['PORTFOLIO_MANDATE_SIGNATURE_INVALID']);
    assert.deepEqual(mandateReasons(m, v2, NOW, authority()).map((r) => r.code), []);
    assert.deepEqual(mandateReasons(m, v1, NOW, authority()).map((r) => r.code), ['PORTFOLIO_MANDATE_SIGNATURE_INVALID']);
    assert.deepEqual(mandateReasons(m, v2, NOW, { scheme: 'V1_PREHASH' }).map((r) => r.code), ['PORTFOLIO_MANDATE_SIGNATURE_INVALID']);
  });
});
