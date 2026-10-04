/**
 * C2.3 browser acceptance instrumentation: V3 is one Mandate signature;
 * per-trade wallet signatures stay at zero. V2 path remains available.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const lab = readFileSync(`${root}/components/demo/live/live-lab.tsx`, 'utf8');
const wallet = readFileSync(`${root}/components/demo/live/wallet.ts`, 'utf8');

describe('C2.3 delegated execution UX contracts', () => {
  it('wallet adapter still cannot send transactions', () => {
    assert.match(wallet, /eth_signTypedData_v4/);
    assert.doesNotMatch(wallet, /eth_sendTransaction|eth_sendRawTransaction/);
  });

  it('V2 path remains: portfolio challenge still names spine V2', () => {
    assert.match(lab, /spine:\s*"V2"/);
  });

  it('documents the V3 one-signature / zero per-trade wallet rule in source once wired', () => {
    // Until the browser V3 path is fully wired, the acceptance rule is pinned here
    // so a partial integration cannot claim completion by deleting V2 only.
    const mandateSigSites = [...lab.matchAll(/\.signTypedData\(/g)].length;
    assert.ok(mandateSigSites >= 1, 'at least the portfolio authorization signing site exists');
    // V2 still has the gate execution signing site; V3 must not add a third.
    assert.ok(mandateSigSites <= 2, `expected at most 2 signTypedData sites, found ${mandateSigSites}`);
  });
});
