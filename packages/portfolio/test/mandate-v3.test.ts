import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addressOfKey, demoKey, demoMandate, signPrehash } from '../src/demo/index.ts';
import {
  mandateSignedByPrincipalV3,
  portfolioMandateAuthorizationV3Hash,
  PORTFOLIO_AUTHORITY_V3,
  type PortfolioAuthorityV3,
} from '../src/mandate-v3.ts';
import { mandateReasons } from '../src/room.ts';

const CHAIN = 46_630n;
const GATE = '0xa0cb889707d426a7a386870a03bc70d1b0697598';
const SESSION = `0x${'5e'.repeat(32)}`;
const PLAN = `0x${'a1'.repeat(32)}`;
const NOW = 1_800_000_000n;

function authority(over: Partial<PortfolioAuthorityV3> = {}): PortfolioAuthorityV3 {
  return {
    scheme: PORTFOLIO_AUTHORITY_V3,
    chainId: CHAIN,
    verifyingContract: GATE,
    sessionDigest: SESSION,
    initialAllocationDigest: PLAN,
    delegate: '0x88f9b82462f6c4bf4a0fb15e5c3971559a316e7f',
    agent: addressOfKey(demoKey('stock')),
    representationIdHash: `0x${'ce'.repeat(32)}`,
    fundingToken: '0x53b640b9a573e33c541de5a4917bc4d28d956abf',
    cumulativeDebitLimit: 32_000_000n,
    validAfter: NOW - 60n,
    validUntil: NOW + 3_600n,
    generation: 1n,
    ...over,
  };
}

describe('portfolio mandate V3', () => {
  it('accepts the principal signature and refuses wrong scope', () => {
    const m = demoMandate();
    const a = authority();
    const hash = portfolioMandateAuthorizationV3Hash(m, a);
    const signature = signPrehash(hash, demoKey('principal'));
    assert.equal(mandateSignedByPrincipalV3(m, signature, a), true);
    assert.equal(mandateSignedByPrincipalV3(m, signature, { ...a, sessionDigest: `0x${'00'.repeat(32)}` }), false);
    assert.equal(mandateSignedByPrincipalV3(m, signature, { ...a, cumulativeDebitLimit: 1n }), false);
    assert.equal(mandateSignedByPrincipalV3(m, signPrehash(hash, demoKey('outsider')), a), false);
    assert.deepEqual(mandateReasons(m, signature, NOW, a).map((r) => r.code), []);
  });

  it('refuses a delegation where delegate equals the stock agent', () => {
    const m = demoMandate();
    const stock = addressOfKey(demoKey('stock'));
    const a = authority({ delegate: stock });
    assert.equal(mandateSignedByPrincipalV3(m, '0x' + '11'.repeat(65), a), false);
  });
});
