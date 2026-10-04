/**
 * C2.3 browser acceptance: V3 is one Mandate signature; per-trade wallet
 * signatures stay at zero. V2 path remains available.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const lab = readFileSync(`${root}/components/demo/live/live-lab.tsx`, 'utf8');
const wallet = readFileSync(`${root}/components/demo/live/wallet.ts`, 'utf8');
const configure = readFileSync(`${root}/components/demo/live/stage-configure.tsx`, 'utf8');
const outcome = readFileSync(`${root}/components/demo/live/stage-outcome.tsx`, 'utf8');

describe('C2.3 delegated execution UX contracts', () => {
  it('wallet adapter signs typed data; only bounded ERC-20 approve may send', () => {
    assert.match(wallet, /eth_signTypedData_v4/);
    assert.match(wallet, /eth_sendTransaction/);
    assert.match(wallet, /sendBoundedErc20Approve/);
    assert.doesNotMatch(wallet, /eth_sendRawTransaction/);
    assert.match(wallet, /Unlimited or zero approval is refused/);
  });

  it('V2 path remains: portfolio challenge still names spine V2 as fallback', () => {
    assert.match(lab, /spine:\s*preferV3\s*\?\s*"V3"\s*:\s*"V2"/);
  });

  it('V3 authorize screen discloses autonomous settlement before signature', () => {
    assert.match(configure, /AUTHORIZE AUTONOMOUS MANDATE/);
    assert.match(configure, /Allowed Stock actions may settle without another wallet approval/);
    assert.match(configure, /Automatic execution/);
    assert.doesNotMatch(configure, /Approve every trade|Auto-trade everything|Unlimited execution/);
    assert.match(configure, /v3 \? null/); // demo principal hidden for V3
  });

  it('V3 settling UX has no Execute button path and no per-trade sign step', () => {
    assert.match(outcome, /No additional wallet approval required/);
    assert.match(outcome, /no Execute button/);
    assert.match(lab, /WALLET_PRINCIPAL_V3_DELEGATED/);
    assert.match(lab, /v3AutoSettleStarted/);
    assert.match(lab, /MANDATE ACTIVE/);
    assert.match(lab, /AUTONOMOUS EXECUTION ACTIVE/);
  });

  it('signTypedData sites: V2 may use portfolio+gate; V3 auto-settle adds none', () => {
    const sites = [...lab.matchAll(/\.signTypedData\(/g)];
    assert.equal(sites.length, 2, `expected V2 portfolio + V2 gate sites only, found ${sites.length}`);
    const authFn = lab.indexOf('async function authorizeWithWallet');
    const signStock = lab.indexOf('async function signStock');
    const settleAuto = lab.indexOf('v3AutoSettleStarted');
    assert.ok(authFn >= 0 && signStock >= 0 && settleAuto >= 0);
    assert.ok(lab.indexOf('.signTypedData(', authFn) < signStock);
    assert.ok(lab.indexOf('.signTypedData(', signStock) > signStock);
    // V3 auto-settle posts SEND without any wallet signature.
    const arm = lab.indexOf('v3AutoSettleStarted.current = true');
    assert.ok(arm > settleAuto);
    const autoBlock = lab.slice(arm, arm + 400);
    assert.match(autoBlock, /postSettle\(\{\s*mode:\s*"SEND"\s*\}/);
    assert.doesNotMatch(autoBlock, /\.signTypedData\(/);
  });

  it('V3 receipt discloses bounded delegation and no per-trade wallet approval', () => {
    assert.match(outcome, /Bounded V3 delegation/);
    assert.match(outcome, /Wallet approval for this trade: None/);
    assert.match(outcome, /One reusable bounded mandate signature/);
  });
});
