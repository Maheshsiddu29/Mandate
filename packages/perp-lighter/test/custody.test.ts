/**
 * Custody verifies durable admission itself (Phase 7E.2). These tests drive
 * the fake custody, which mirrors the Go custody's `VerifyAdmitted`
 * (custody/ledger.go) over the same committed ledger; `npm run
 * lighter:custody:check` runs the same scenarios against the real Go process
 * and its Go-level mutants.
 *
 * - An attempt admitted for transaction A does not let custody sign B, even
 *   when the caller names A's attempt.
 * - A valid transaction with no durable ADMIT_ATTEMPT is refused; so is a
 *   request with no attempt id.
 * - After a restart the admission is still independently verifiable.
 * - A closed reservation, an already-issued attempt, a disabled module or
 *   adapter and an expired attempt are refused.
 * - M12 (trust that the transaction is the admitted one) and M13 (no attempt
 *   required) sign what production refuses: killed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthorizationRecord } from '@mandate/control';
import { admit, construct, hashTx, readPreExecution, resolveIntent } from '../src/issuance.ts';
import type { AttemptClaim, CustodyTx } from '../src/index.ts';
import { authorizeOrder, issuanceWorld, type CustodyVerification, type IssuanceWorld } from './support/signer-world.ts';

/** Admit A through the production stages — and stop before any key use. */
async function admitOnly(x: IssuanceWorld): Promise<{ rec: AuthorizationRecord; txA: CustodyTx; txB: CustodyTx; claim: AttemptClaim }> {
  const { rec, issue } = await authorizeOrder(x);
  const intent = resolveIntent(x.deps, 'ORDER', rec, issue.payload);
  const ev = await readPreExecution(x.deps);
  assert.ok(intent.ok && ev.ok);
  if (!intent.ok || !ev.ok) throw new Error('prepare');
  const tx = construct(x.deps, intent.value, ev.value.nonce);
  assert.ok(tx.ok);
  if (!tx.ok) throw new Error('construct');
  const h = await hashTx(x.deps, tx.value);
  assert.ok(h.ok);
  if (!h.ok) throw new Error('hash');
  const a = await admit(x.deps, intent.value, issue, tx.value, h.value, ev.value.scope, ev.value.results);
  assert.equal(a.status, 'ADMITTED');
  if (a.status !== 'ADMITTED') throw new Error('admit');
  x.custody.signs.length = 0;
  return { rec, txA: tx.value, txB: { ...tx.value, baseAmount: tx.value.baseAmount + 1n }, claim: { attempt: a.attempt.attempt, reservation: rec.reservation, generation: rec.generation, action: rec.actionId } };
}

async function withWorld(f: (x: IssuanceWorld) => Promise<void>, o: Parameters<typeof issuanceWorld>[0] = {}): Promise<void> {
  const x = await issuanceWorld(o);
  try {
    await f(x);
  } finally {
    x.close();
  }
}

describe('custody verifies the durable ADMIT_ATTEMPT itself', () => {
  it('wrong ledger record: A is admitted; asked to sign B under A\'s attempt, custody refuses before key use', () =>
    withWorld(async (x) => {
      const { txA, txB, claim } = await admitOnly(x);
      const b = await x.custody.sign(txB, claim);
      assert.deepEqual(b, { ok: false, error: 'ARTIFACT_NOT_ADMITTED' });
      // The admitted transaction itself is signable.
      assert.equal((await x.custody.sign(txA, claim)).ok, true);
      assert.deepEqual(x.custody.signs.map((s) => [s.signed, s.refusal]), [[false, 'ARTIFACT_NOT_ADMITTED'], [true, null]]);
    }));

  it('missing attempt: a valid transaction with no durable admission, or no attempt id at all, is refused', () =>
    withWorld(async (x) => {
      const { txA, claim } = await admitOnly(x);
      assert.deepEqual(await x.custody.sign(txA, { ...claim, attempt: `0x${'7'.repeat(64)}` }), { ok: false, error: 'ATTEMPT_NOT_ADMITTED' });
      assert.deepEqual(await x.custody.sign(txA, null), { ok: false, error: 'ATTEMPT_ID_MISSING' });
      assert.deepEqual(await x.custody.sign(txA, { ...claim, attempt: '' }), { ok: false, error: 'ATTEMPT_ID_MISSING' });
      // A claim naming the wrong reservation for a real attempt is refused too.
      assert.deepEqual(await x.custody.sign(txA, { ...claim, reservation: `0x${'5'.repeat(64)}` }), { ok: false, error: 'RESERVATION_MISMATCH' });
      assert.ok(x.custody.signs.every((s) => !s.signed));
    }));

  it('after a restart, the admission is independently verifiable from the durable file', async () => {
    const x = await issuanceWorld();
    try {
      const { txA, claim } = await admitOnly(x);
      x.store.close();
      const y = await issuanceWorld({ path: x.path, reopen: true, clockMs: x.clock.ms });
      try {
        const h = await y.custody.hash(txA);
        assert.ok(h.ok);
        if (!h.ok) return;
        assert.equal(y.custody.verify(claim, txA, h.value.hash), null);
        assert.deepEqual(await y.custody.sign({ ...txA, price: txA.price + 1n }, claim), { ok: false, error: 'ARTIFACT_NOT_ADMITTED' });
      } finally {
        y.store.close();
      }
    } finally {
      x.close();
    }
  });

  it('refuses once the attempt is recorded as issued', () =>
    withWorld(async (x) => {
      const { txA, claim } = await admitOnly(x);
      x.journal.open(x.deps.config.principal, claim.attempt as never, 'OUTCOME_UNKNOWN', null, 'TEST');
      assert.deepEqual(await x.custody.sign(txA, claim), { ok: false, error: 'ATTEMPT_ALREADY_ISSUED' });
    }));

  it('refuses when the attempt has expired', () =>
    withWorld(async (x) => {
      const { txA, claim } = await admitOnly(x);
      x.clock.ms += 3_600_000n;
      assert.deepEqual(await x.custody.sign(txA, claim), { ok: false, error: 'ATTEMPT_EXPIRED' });
    }));

  it('refuses when the module or the adapter has been DISABLED since admission', async () => {
    for (const kind of ['MODULE', 'ADAPTER'] as const) {
      await withWorld(async (x) => {
        const { txA, claim } = await admitOnly(x);
        if (kind === 'MODULE') x.lifecycle.setModule({ module: x.w.policy.ref, status: 'DISABLED', implementations: [x.w.policy.implementation] });
        else x.lifecycle.setAdapter({ adapter: x.deps.config.adapter, status: 'DISABLED' });
        assert.deepEqual(await x.custody.sign(txA, claim), { ok: false, error: `${kind}_DISABLED` });
      });
    }
  });
});

describe('custody mutants', () => {
  /** A custody mutant's scenario: A admitted; a caller asks for B under A's attempt, and for A with no attempt. */
  async function scenario(mode: CustodyVerification): Promise<{ signedUnbound: number }> {
    const x = await issuanceWorld();
    try {
      const { txA, txB, claim } = await admitOnly(x);
      x.custody.verification = mode;
      await x.custody.sign(txB, claim);
      await x.custody.sign(txA, null);
      // A signature is safe only when the claimed attempt's committed artifact is exactly what was signed.
      const signedUnbound = x.custody.signs.filter((s) => s.signed && !s.boundTo.some((a) => s.claim !== null && a.attempt === s.claim.attempt)).length;
      return { signedUnbound };
    } finally {
      x.close();
    }
  }

  it('production custody signs nothing unbound', async () => {
    assert.deepEqual(await scenario('DURABLE'), { signedUnbound: 0 });
  });

  it('killed: M12 custody trusts that the transaction is the admitted one', async () => {
    assert.ok((await scenario('TRUST_CALLER_HASH')).signedUnbound > 0);
  });

  it('killed: M13 custody signs when the attempt id is absent', async () => {
    assert.ok((await scenario('NO_ATTEMPT_REQUIRED')).signedUnbound > 0);
  });
});
