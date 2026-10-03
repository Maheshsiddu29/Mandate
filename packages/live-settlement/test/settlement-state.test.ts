/**
 * C1.5: every journal state, projected for a restored page. Real journal
 * transitions on a scratch file; the projection itself is pure.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettlementJournal, type AttemptBinding } from '../src/journal.ts';
import { durableSettlement, type PendingSettlement } from '../src/settlement-state.ts';
import type { ReservationStatus } from '../src/portfolio-ledger.ts';

const R = '0xreservation';
const binding: AttemptBinding = { reservation: R, session: 'lab-1', proposal: '0xp', candidate: '0xc', child: '0xchild', action: '0xa', agent: '0xagent', version: 1, principal: '0xwallet', authorizationMethod: 'WALLET_PRINCIPAL_V2_PLAN', chainId: '46630', gate: '0xgate', binding: '0xbinding', evidenceClass: 'REFERENCE_MODEL' };
const tx = { hash: '0xhash', from: '0xfrom', to: '0xgate', nonce: '1', calldataDigest: '0xcd', value: '0', gasLimit: '1', maxFeePerGas: '1', maxPriorityFeePerGas: '0' };
const before = { block: '1', tokenIn: '1', tokenOut: '0', agentTokenOut: '0' };
const receipt = (status: string) => ({ status, blockNumber: '9', blockHash: '0xb', gasUsed: '1', effectiveGasPrice: '1' });

function withJournal(f: (j: SettlementJournal, view: (o?: { reservation?: ReservationStatus; pending?: PendingSettlement }) => ReturnType<typeof durableSettlement>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mandate-settlement-state-'));
  const j = SettlementJournal.open(join(dir, 'settlement.db'));
  try {
    f(j, (o = {}) => durableSettlement({ reservation: R, reservationState: o.reservation ?? 'ADMITTED', attempt: j.get(R), artifacts: j.artifacts(R), pending: o.pending ?? null, asOfEvents: 7 }));
  } finally {
    j.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('C1.5 durable settlement state', () => {
  it('nothing attempted: executable only while the ledger keeps the reservation open and its attempt (if any) is this journal’s', () => {
    withJournal((j, view) => {
      assert.equal(view({ reservation: 'RESERVED' }).executable, true);
      assert.equal(view({ reservation: 'RESERVED' }).settlementStatus, 'NO_ATTEMPT');
      // The ledger admitted an attempt this journal never recorded: the send refuses, so nothing is offered.
      assert.equal(view({ reservation: 'ADMITTED' }).executable, false);
      for (const closed of ['CONSUMED', 'RELEASED', 'UNKNOWN'] as const) assert.equal(view({ reservation: closed }).executable, false, closed);
      assert.equal(view({ reservation: 'RESERVED', pending: 'RUNNING' }).executable, false);
      assert.equal(view({ reservation: 'RESERVED', pending: 'RUNNING' }).settlementStatus, 'IN_PROGRESS');
      assert.equal(view().asOfEvents, 7);
      j.prepare(binding);
      const prepared = view();
      assert.deepEqual({ s: prepared.settlementStatus, held: prepared.held, executable: prepared.executable, transactions: prepared.transactions }, { s: 'PREPARED', held: false, executable: true, transactions: 0 });
    });
  });

  it('once the send leg is bound the attempt is HELD until its last artifact deadline, with no hash and no broadcast — unless a settle call in this process still owns it', () => {
    withJournal((j, view) => {
      j.prepare(binding);
      j.bindDomain(R, 1_000n, 2_000n);
      const parked = view({ pending: 'AWAITING_SIGNATURE' });
      assert.deepEqual({ s: parked.settlementStatus, held: parked.held, executable: parked.executable }, { s: 'SIGNATURE_REQUIRED', held: false, executable: false });
      const held = view();
      assert.deepEqual(
        { s: held.settlementStatus, held: held.held, until: held.heldUntil, attempt: held.attemptState, tx: held.txHash, transactions: held.transactions, executable: held.executable },
        { s: 'HELD', held: true, until: '2000', attempt: 'PREPARED', tx: null, transactions: 0, executable: false },
      );
      j.recordArtifact({ reservation: R, mandateDigest: '0xm', commitment: '0xc', deadline: '2500', mode: 'SEND' });
      assert.equal(view().heldUntil, '2500');
      j.transition(R, 'RECONCILIATION_REQUIRED', { quarantine: 'AWAITING_DEADLINE' });
      assert.equal(view().settlementStatus, 'HELD');
      assert.equal(view().quarantine, 'AWAITING_DEADLINE');
      j.transition(R, 'RELEASED');
      const released = view({ reservation: 'RELEASED' });
      assert.deepEqual({ s: released.settlementStatus, held: released.held, until: released.heldUntil, executable: released.executable }, { s: 'RELEASED', held: false, until: null, executable: false });
    });
  });

  it('a hash without a receipt is SUBMITTED; an ambiguous broadcast does not claim a count; a revert, a quarantine and a settlement are never executable', () => {
    withJournal((j, view) => {
      j.prepare(binding);
      j.bindDomain(R, 1_000n, 2_000n);
      j.startSubmission(R, tx, before);
      assert.deepEqual({ s: view().settlementStatus, tx: view().txHash, transactions: view().transactions, held: view().held }, { s: 'SUBMITTED', tx: '0xhash', transactions: null, held: true });
      j.transition(R, 'RECONCILIATION_REQUIRED', { quarantine: 'BROADCAST_REJECTED' });
      assert.equal(view().settlementStatus, 'SUBMITTED');
      assert.equal(view().transactions, null);
      j.transition(R, 'SUBMITTED');
      assert.equal(view().transactions, 1);
      j.transition(R, 'CONFIRMED_REVERT', { receipt: receipt('REVERTED') });
      assert.deepEqual({ s: view().settlementStatus, receipt: view().receiptStatus, held: view().held, executable: view().executable }, { s: 'REVERTED', receipt: 'REVERTED', held: true, executable: false });
    });
    withJournal((j, view) => {
      j.prepare(binding);
      j.bindDomain(R, 1_000n, 2_000n);
      j.startSubmission(R, tx, before);
      j.transition(R, 'SUBMITTED');
      j.transition(R, 'CONFIRMED_SUCCESS', { receipt: receipt('SUCCESS') });
      assert.equal(view().settlementStatus, 'SUBMITTED');
      j.transition(R, 'RECONCILIATION_REQUIRED', { quarantine: 'POSTCONDITION_ANOMALY' });
      assert.deepEqual({ s: view().settlementStatus, held: view().held, executable: view().executable, transactions: view().transactions }, { s: 'NEEDS_REVIEW', held: false, executable: false, transactions: 1 });
    });
    withJournal((j, view) => {
      j.prepare(binding);
      j.transition(R, 'PREPARATION_FAILED');
      assert.deepEqual({ s: view({ reservation: 'RESERVED' }).settlementStatus, executable: view({ reservation: 'RESERVED' }).executable }, { s: 'PREPARATION_FAILED', executable: false });
    });
  });
});
