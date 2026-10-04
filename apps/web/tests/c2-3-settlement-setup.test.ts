/**
 * C2.3.3 — wallet-native bounded V3 MDUSD allowance setup.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  UINT256_MAX,
  allowanceSufficient,
  boundedApproveTx,
  encodeApproveCalldata,
  formatMdusdAtoms,
  parseTrustedSettlementPlan,
  readinessAfterAllowance,
} from '../components/demo/live/settlement-setup.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const wallet = readFileSync(`${root}/components/demo/live/wallet.ts`, 'utf8');
const configure = readFileSync(`${root}/components/demo/live/stage-configure.tsx`, 'utf8');
const lab = readFileSync(`${root}/components/demo/live/live-lab.tsx`, 'utf8');
const setup = readFileSync(`${root}/components/demo/live/settlement-setup.ts`, 'utf8');
const v2Gate = readFileSync(`${root}/../../contracts/src/MandateExecutionGate.sol`, 'utf8');

const LIVE_GATE = '0x5cf0621ab974d100fd5df225dab046bf35fa7519';
const MDUSD = '0x53b640b9a573e33c541de5a4917bc4d28d956abf';
const PRINCIPAL = '0x1111111111111111111111111111111111111111';

function plan(over: Partial<{ chainId: number; gate: string; fundingToken: string; requiredAllowanceAtoms: string; principal: string; basis: 'PLAN' | 'MAXIMUM' }> = {}) {
  return {
    chainId: 46_630,
    gate: LIVE_GATE,
    fundingToken: MDUSD,
    requiredAllowanceAtoms: '64000000',
    principal: PRINCIPAL,
    basis: 'MAXIMUM' as const,
    ...over,
  };
}

describe('C2.3.3 wallet-native V3 settlement setup', () => {
  it('principal comes from connected wallet; no manual principal input', () => {
    assert.match(configure, /wallet\.address/);
    assert.doesNotMatch(configure, /principal address|enter your wallet|paste.*0x/i);
    assert.doesNotMatch(configure, /<input[^>]+principal/i);
    assert.match(lab, /wallet\/settlement-setup/);
    assert.match(lab, /address/);
  });

  it('zero allowance → setup required; sufficient → ready', () => {
    assert.equal(readinessAfterAllowance(0n, '64000000'), 'NEED_ENABLE');
    assert.equal(readinessAfterAllowance(63_999_999n, '64000000'), 'NEED_ENABLE');
    assert.equal(readinessAfterAllowance(64_000_000n, '64000000'), 'READY');
    assert.equal(allowanceSufficient(64_000_000n, '64000000'), true);
  });

  it('approval amount equals deterministic bounded V3 cap and is never uint256.max', () => {
    const p = parseTrustedSettlementPlan(plan(), PRINCIPAL);
    assert.equal(p.ok, true);
    if (!p.ok) return;
    assert.equal(p.plan.requiredAllowanceAtoms, '64000000');
    assert.equal(formatMdusdAtoms(p.plan.requiredAllowanceAtoms), '64 MDUSD');
    const tx = boundedApproveTx(p.plan, PRINCIPAL);
    assert.equal(tx.ok, true);
    if (!tx.ok) return;
    assert.equal(tx.tx.to, MDUSD);
    assert.match(tx.tx.data, /^0x095ea7b3/);
    assert.ok(!tx.tx.data.toLowerCase().endsWith('f'.repeat(64)));
    assert.equal(encodeApproveCalldata(LIVE_GATE, UINT256_MAX), null);
    assert.equal(parseTrustedSettlementPlan(plan({ requiredAllowanceAtoms: UINT256_MAX.toString() }), PRINCIPAL).ok, false);
  });

  it('wrong chain / wrong principal / browser-supplied addresses refuse', () => {
    assert.equal(parseTrustedSettlementPlan(plan({ chainId: 1 }), PRINCIPAL).ok, false);
    assert.equal(parseTrustedSettlementPlan(plan({ principal: '0x2222222222222222222222222222222222222222' }), PRINCIPAL).ok, false);
    // Plan fields are server-authored; UI has no inputs for gate/token/amount.
    assert.doesNotMatch(configure, /name=["']gate["']|name=["']mdusd["']|name=["']allowance["']/i);
    assert.match(lab, /parseTrustedSettlementPlan/);
    assert.match(wallet, /plan\.chainId !== APPROVAL_CHAIN\.chainId/);
  });

  it('rejected or reverted approval stays NOT READY; confirmation re-reads allowance', () => {
    assert.match(lab, /sendBoundedErc20Approve/);
    assert.match(lab, /waitForReceipt/);
    assert.match(lab, /refreshAllowance/);
    assert.match(lab, /NEED_ENABLE/);
    assert.match(lab, /Approval transaction reverted|still below the required/);
    assert.match(lab, /setupStatus !== "READY"/);
  });

  it('V3 mandate signature cannot proceed before setup; authorize label is autonomous', () => {
    assert.match(configure, /Enable settlement/);
    assert.match(configure, /Authorize autonomous mandate/i);
    assert.match(configure, /setupReady/);
    assert.match(lab, /Enable settlement before authorizing/);
    assert.match(wallet, /eth_sendTransaction/);
    assert.doesNotMatch(wallet, /eth_sendRawTransaction/);
    assert.match(wallet, /Unlimited or zero approval is refused/);
  });

  it('settlement-allowance copy is renew-when-insufficient, never one-time forever', () => {
    assert.match(configure, /Settlement allowance required/);
    assert.match(configure, /Allow the Mandate V3 Gate to use up to/);
    assert.match(configure, /This bounded ERC-20 allowance is separate from your Mandate authorization/);
    assert.match(configure, /Renew it only when the remaining settlement allowance is insufficient/);
    assert.doesNotMatch(configure, /One-time setup required/);
    assert.doesNotMatch(configure, /one-time bounded ERC-20 approval/i);
    assert.doesNotMatch(configure, /not required for every trade/i);
    assert.doesNotMatch(configure, /permanent approval|one approval forever|forever/i);
  });

  it('trade path still auto-settles without additional wallet signatures', () => {
    assert.match(lab, /v3AutoSettleStarted/);
    assert.match(lab, /postSettle\(\{\s*mode:\s*"SEND"\s*\}/);
    const arm = lab.indexOf('v3AutoSettleStarted.current = true');
    assert.ok(arm > 0);
    assert.doesNotMatch(lab.slice(arm, arm + 500), /\.signTypedData\(/);
  });

  it('V2 Gate source file is unchanged by this UX path', () => {
    assert.match(v2Gate, /contract MandateExecutionGate/);
    assert.doesNotMatch(setup, /MandateExecutionGate\.sol/);
    assert.doesNotMatch(lab, /MandateExecutionGate\.sol/);
    assert.doesNotMatch(wallet, /MandateExecutionGate\.sol/);
  });

  it('trusted plan binds live Gate and MDUSD from server body shapes only', () => {
    const live = JSON.parse(readFileSync(`${root}/../../contracts/deploy/robinhood-testnet-delegated-live.json`, 'utf8')) as {
      gate: string;
      fixture: { fundingToken: string };
    };
    assert.equal(live.gate.toLowerCase(), LIVE_GATE);
    assert.equal(live.fixture.fundingToken.toLowerCase(), MDUSD);
    const ok = parseTrustedSettlementPlan(plan({ gate: live.gate, fundingToken: live.fixture.fundingToken }), PRINCIPAL);
    assert.equal(ok.ok, true);
  });
});
