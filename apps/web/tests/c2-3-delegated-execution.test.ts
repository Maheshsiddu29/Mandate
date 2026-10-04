/**
 * C2.3 browser acceptance: V3 is one Mandate signature; per-trade wallet
 * signatures stay at zero. V2 path remains available.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { LiveEvent } from '../components/demo/live/live-client.ts';
import { derivePresentation } from '../components/demo/live/live-model.ts';
import { executeOffered, parseRestored, parseV3TechnicalProof, restoreSettlement } from '../components/demo/live/settlement-restore.ts';

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

  it('hydrates confirmed V3 proof from the durable session DTO and preserves every actual receipt field', () => {
    const txHash = `0x${'11'.repeat(32)}`;
    const proof = {
      version: 'V3', sessionId: 'lab-v3-proof', candidateId: 'nvda-note-a',
      walletPrincipal: `0x${'22'.repeat(20)}`, gate: `0x${'33'.repeat(20)}`, delegate: `0x${'44'.repeat(20)}`,
      agent: `0x${'55'.repeat(20)}`, delegationDigest: `0x${'66'.repeat(32)}`,
      gateMandateDigest: `0x${'77'.repeat(32)}`, gateCandidateDigest: `0x${'88'.repeat(32)}`,
      executionApprovalDigest: `0x${'99'.repeat(32)}`, executionCommitment: `0x${'aa'.repeat(32)}`,
      executionNonce: '1', reservation: `0x${'bb'.repeat(32)}`, initialAllocationDigest: `0x${'cc'.repeat(32)}`,
      initialCapacity: '64000000', cumulativeDebit: '64000000', remainingCapacity: '0', capacityUnit: 'MDUSD', capacityDecimals: 6,
      gasEstimate: '330000', transactionHash: txHash, blockNumber: '128655452', gasUsed: '322661', transactionStatus: 'SUCCESS',
      transactionTo: `0x${'33'.repeat(20)}`, chainId: '46630', receiptDigest: `0x${'dd'.repeat(32)}`,
      explorerUrl: `https://explorer.testnet.chain.robinhood.com/tx/${txHash}`, evidence: 'LIVE_TESTNET', broadcast: true,
    } as const;
    assert.deepEqual(parseV3TechnicalProof(proof), proof);
    const event: LiveEvent = {
      schema: 'MANDATE_LIVE_AI.V1', sessionId: proof.sessionId, sequence: 1, kind: 'DOMAIN_EXECUTION_SETTLED',
      at: '2026-10-04T00:00:00.000Z', elapsedMs: 1, protocolTime: '1', mandateVersion: 1, agent: 'stock', roomId: null, generation: null,
      data: { spine: 'V3', evidence: 'LIVE_TESTNET', txHash, executionNonce: '1', remainingCapacity: '0', transactions: 1 },
    };
    const restored = parseRestored({
      settlementStatus: 'SETTLED', reservation: proof.reservation, reservationState: 'CONSUMED', attemptState: 'CONSUMED',
      quarantine: null, held: false, heldUntil: null, txHash, transactions: 1, receiptStatus: 'SUCCESS', pending: null,
      executable: false, asOfEvents: 2, technicalProof: proof,
    });
    assert.ok(restored);
    const settlement = restoreSettlement(derivePresentation([event]).settlement, [event], restored);
    assert.deepEqual(settlement.v3Proof, proof);
    assert.equal(settlement.stage, 'SETTLED');
    assert.equal(settlement.settled, true);
    assert.equal(settlement.txHash, txHash);
    assert.equal(settlement.block, '128655452');
    assert.equal(settlement.gasUsed, '322661');
    assert.equal(settlement.walletPrincipal, proof.walletPrincipal);
    assert.equal(settlement.gate, proof.gate);
    assert.equal(settlement.v3Proof?.delegate, proof.delegate);
    assert.equal(settlement.v3Proof?.delegationDigest, proof.delegationDigest);
    assert.equal(settlement.v3Proof?.executionNonce, '1');
    assert.equal(settlement.v3Proof?.reservation, proof.reservation);
    assert.equal(settlement.v3Proof?.cumulativeDebit, '64000000');
    assert.equal(settlement.v3Proof?.remainingCapacity, '0');
    assert.equal(settlement.receiptDigest, proof.receiptDigest);
    assert.equal(settlement.evidence, 'LIVE_TESTNET');
    assert.equal(executeOffered(restored, [event]), false, 'restore must not reopen execute / resend');
    assert.equal(settlement.gateSign, null);
    assert.doesNotMatch(JSON.stringify(proof), /privateKey|delegateSignature|agentSignature|principalSignature|"raw"|calldata/i);
    assert.match(outcome, /Initial authorized capacity/);
    assert.match(outcome, /Consumed capacity/);
    assert.match(outcome, /Remaining capacity/);
    assert.match(outcome, /Execution delegate/);
    assert.match(outcome, /Delegation digest/);
    assert.match(outcome, /Expanded proof/);
    assert.match(outcome, /Copy \$\{label\}/);
    assert.match(outcome, /FIXTURE_QUALIFICATION/);
    // V2 technical labels remain for the non-V3 path.
    assert.match(outcome, /\["Gate", settlement\.gate/);
    assert.match(outcome, /Gate mandate digest/);
  });

  it('does not create successful proof from failed, unsent or malformed payloads', () => {
    assert.equal(parseV3TechnicalProof({ version: 'V3', evidence: 'LIVE_TESTNET', broadcast: false }), null);
    assert.equal(parseV3TechnicalProof({ version: 'V3', evidence: 'FAILED', broadcast: true }), null);
    assert.equal(parseV3TechnicalProof({ version: 'V3', evidence: 'LIVE_TESTNET', broadcast: true, transactionStatus: 'SUCCESS' }), null);
    const event: LiveEvent = {
      schema: 'MANDATE_LIVE_AI.V1', sessionId: 'lab-fail', sequence: 1, kind: 'DOMAIN_EXECUTION_SETTLED',
      at: '2026-10-04T00:00:00.000Z', elapsedMs: 1, protocolTime: '1', mandateVersion: 1, agent: 'stock', roomId: null, generation: null,
      data: { spine: 'V3', evidence: 'FAILED', txHash: `0x${'11'.repeat(32)}`, transactions: 0 },
    };
    assert.equal(derivePresentation([event]).settlement.v3Proof, null);
  });
});
