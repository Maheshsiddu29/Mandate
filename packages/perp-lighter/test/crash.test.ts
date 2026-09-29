/**
 * Durable crash behaviour of issuance (Phase 7E.1 §34, §35), with real
 * process death: the signer runs in a child process on a SQLite file and is
 * SIGKILLed at a chosen instant. A fresh process then reopens the file.
 *
 * After ADMIT_ATTEMPT (and after the key was used): the attempt is present,
 * the reservation is still held, NEVER_ISSUED is forbidden, a new request gets
 * the existing attempt (no fresh one), and recovery marks it OUTCOME_UNKNOWN —
 * for an operator and, later, reconciliation. Before ADMIT_ATTEMPT: no attempt
 * exists, and when revalidation fails NEVER_ISSUED closes the reservation.
 *
 * Phase 7E.2: after the kill, custody's independent verification still finds
 * the durable admission in the reopened file; once recovery records the
 * attempt, custody refuses to sign it again.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeOrder } from '../src/index.ts';
import { ACCOUNT, BTC_MARKET, BTC_PRICE_LIGHTER, ONCE, T, context, states } from './support/world.ts';
import { issuanceWorld, recordFromJson, tempDir } from './support/signer-world.ts';

/** The child's default BUY, re-encoded exactly: the record commits to its digest. */
const PAYLOAD = encodeOrder({ account: ACCOUNT, market: BTC_MARKET, side: 'BUY', baseAmount: 100n, price: BTC_PRICE_LIGHTER, execution: 'LIMIT_IOC', reduceOnly: false, orderExpiryMs: 0n });

const CHILD = fileURLToPath(new URL('./support/crash-child.ts', import.meta.url));

function crash(mode: string): { dir: string; path: string; record: string; cleanup: () => void } {
  const t = tempDir();
  const path = join(t.dir, 'ledger.db');
  const record = join(t.dir, 'record.json');
  const r = spawnSync(process.execPath, ['--no-warnings', CHILD, mode, path, record], { encoding: 'utf8' });
  assert.equal(r.signal, 'SIGKILL', `child did not die at ${mode}: status ${r.status} ${r.stderr}`);
  return { dir: t.dir, path, record, cleanup: t.cleanup };
}

describe('issuance crash behaviour (real SIGKILL)', () => {
  for (const mode of ['after-sign', 'after-send'] as const) {
    it(`killed ${mode === 'after-sign' ? 'after ADMIT_ATTEMPT and signing, before any record' : 'after submission, before the reply is recorded'}: the attempt survives, authority stays held, NEVER_ISSUED is forbidden, nothing is issued again`, async () => {
      const c = crash(mode);
      try {
        const rec = recordFromJson(readFileSync(c.record, 'utf8'));
        const x = await issuanceWorld({ path: c.path, reopen: true, clockMs: (T + 30n) * 1_000n });
        try {
          const state = x.store.readCommitted(rec.principal).state;
          const attempts = state.reservationAttempts.get(rec.reservation) ?? [];
          assert.equal(attempts.length, 1, 'the attempt is present');
          assert.equal(state.reservations.get(rec.reservation)?.status, 'ACTIVE', 'the reservation is unavailable to anyone else');
          assert.ok(state.reservations.get(rec.reservation)?.demands.every((d) => d.released === 0n));
          // Even where revalidation now fails — here the authorization's lifetime is over — nothing may close it NEVER_ISSUED.
          const expired = rec.validUntil + 1n;
          const reval = await x.w.engine.revalidate(rec, { payload: PAYLOAD, states: states(x.w, { at: expired }), context: context(expired) });
          assert.ok(reval.ok && reval.value.status === 'FAILED');
          const close = await x.w.engine.closeNeverIssued(rec, { payload: PAYLOAD, states: states(x.w, { at: expired }), context: context(expired) }, ONCE);
          assert.ok(close.status === 'REFUSED' && close.refusal.code === 'NEVER_ISSUED_FORBIDDEN');
          // The same generation cannot produce a second executable action.
          const again = await x.signer.issueAuthorizedPerpOrder(rec, { payload: PAYLOAD, states: states(x.w, { at: T + 30n }), context: context(T + 30n) });
          assert.equal(again.status, 'EXISTING');
          assert.equal(x.custody.signs.length, 0);
          // Custody's own check reads the admission from the reopened file (the committed artifact, its slot).
          const admitted = state.attempts.get(attempts[0] as never);
          assert.ok(admitted !== undefined && admitted.slot !== null);
          const claim = { attempt: admitted.attempt, reservation: rec.reservation, generation: rec.generation, action: rec.actionId };
          const committed = [...admitted.artifact.id].map((b) => b.toString(16).padStart(2, '0')).join('');
          const tx = { type: 'CREATE_ORDER', chainId: 300, accountIndex: 0n, apiKeyIndex: 0, marketIndex: 4096, clientOrderIndex: 0n, baseAmount: 100n, price: BTC_PRICE_LIGHTER, isAsk: 0, orderType: 0, timeInForce: 0, reduceOnly: 0, orderExpiry: 0n, cancelIndex: 0n, expiredAt: admitted.validUntil * 1_000n, nonce: admitted.slot.sequence, selfTradeBehavior: 0, selfTradeEquality: 0 };
          assert.equal(x.custody.verify(claim, tx, committed), mode === 'after-sign' ? null : 'ATTEMPT_ALREADY_ISSUED');
          // Recovery: the interrupted issuance is OUTCOME_UNKNOWN until evidence says otherwise.
          const report = x.signer.recover();
          assert.deepEqual(report, mode === 'after-sign' ? { unrecorded: 1, interrupted: 0 } : { unrecorded: 0, interrupted: 1 });
          assert.equal(x.journal.get(attempts[0] as never)?.state, 'OUTCOME_UNKNOWN');
          assert.deepEqual(x.signer.recover(), { unrecorded: 0, interrupted: 0 }, 'recovery is idempotent');
          assert.equal(x.custody.verify(claim, tx, committed), 'ATTEMPT_ALREADY_ISSUED', 'once recorded, custody will not sign the attempt again');
          // Time does not release it.
          const later = await x.w.engine.closeNeverIssued(rec, { payload: PAYLOAD, states: states(x.w, { at: T + 86_400n }), context: context(T + 86_400n) }, ONCE);
          assert.ok(later.status === 'REFUSED' && later.refusal.code === 'NEVER_ISSUED_FORBIDDEN');
        } finally {
          x.store.close();
        }
      } finally {
        c.cleanup();
      }
    });
  }

  it('killed before ADMIT_ATTEMPT: no attempt exists, and when revalidation fails NEVER_ISSUED may close the reservation', async () => {
    const c = crash('before-admit');
    try {
      const rec = recordFromJson(readFileSync(c.record, 'utf8'));
      const x = await issuanceWorld({ path: c.path, reopen: true, clockMs: (T + 30n) * 1_000n });
      try {
        const state = x.store.readCommitted(rec.principal).state;
        assert.equal(state.attempts.size, 0, 'no attempt was admitted');
        assert.equal(state.reservations.get(rec.reservation)?.status, 'ACTIVE');
        // Revalidation fails (the authorization's lifetime is over); no attempt exists, so the ledger proves no artifact.
        const expired = rec.validUntil + 1n;
        const close = await x.w.engine.closeNeverIssued(rec, { payload: PAYLOAD, states: states(x.w, { at: expired }), context: context(expired) }, ONCE);
        assert.equal(close.status, 'CLOSED');
        const after = x.store.readCommitted(rec.principal).state.reservations.get(rec.reservation);
        assert.ok(after?.status === 'CLOSED' && after.demands.every((d) => d.released === d.reserved));
      } finally {
        x.store.close();
      }
    } finally {
      c.cleanup();
    }
  });
});
