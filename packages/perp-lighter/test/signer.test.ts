/**
 * The Lighter Venue Signer against the durable ledger (offline, fake custody
 * and venue). The probe that matters most runs inside the fake custody: at
 * the instant of every signature it records which committed attempts bind
 * that exact hash. Each test then states what must have been true.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type ReservationId } from '@mandate/core';
import * as pkg from '../src/index.ts';
import { VenueSigner, clientOrderIndexFor, encodeOrder, type CustodyTx } from '../src/index.ts';
import { construct, guard, resolveIntent } from '../src/issuance.ts';
import { ACCOUNT, API_KEY_INDEX, BTC_MARKET, BTC_PRICE_LIGHTER, ETH_MARKET, ONCE, T, authorized, cancel, context, request, states } from './support/world.ts';
import { NOW_MS, PUBLIC_KEY, authorizeOrder, issuanceWorld, noSignature, type IssuanceWorld } from './support/signer-world.ts';

async function withWorld(f: (x: IssuanceWorld) => Promise<void>, o: Parameters<typeof issuanceWorld>[0] = {}): Promise<void> {
  const x = await issuanceWorld(o);
  try {
    await f(x);
  } finally {
    x.close();
  }
}

describe('issuance: the happy path and what the agent receives', () => {
  it('admits, then signs exactly the committed hash, keeps the artifact inside, and returns only references', () =>
    withWorld(async (x) => {
      x.venue.next = 7n;
      const { rec, issue } = await authorizeOrder(x);
      const out = await x.signer.issueAuthorizedPerpOrder(rec, issue);
      assert.equal(out.status, 'ISSUED');
      if (out.status !== 'ISSUED') return;
      assert.equal(out.issuance, 'SUBMISSION_ACKNOWLEDGED');
      assert.deepEqual(Object.keys(out).sort(), ['attempt', 'detail', 'issuance', 'status', 'txHash']);
      // The key was used once, for a hash already bound — at that instant — by exactly this reservation's attempt.
      assert.equal(x.custody.signs.length, 1);
      const [sig] = x.custody.signs;
      assert.equal(sig?.boundTo.length, 1);
      assert.equal(sig?.boundTo[0]?.reservation, rec.reservation);
      assert.equal(sig?.boundTo[0]?.attempt, out.attempt);
      assert.equal(sig?.boundTo[0]?.slot?.sequence, 7n);
      // Signed fields are exactly the authorized order's.
      const tx = sig?.tx as CustodyTx;
      assert.deepEqual([tx.type, tx.marketIndex, tx.baseAmount, tx.price, tx.isAsk, tx.reduceOnly, tx.orderType, tx.timeInForce], ['CREATE_ORDER', 4096, 100n, BTC_PRICE_LIGHTER, 0, 0, 0, 0]);
      assert.equal(tx.clientOrderIndex, clientOrderIndexFor(rec.reservation));
      assert.equal(tx.selfTradeBehavior, 1);
      assert.ok(tx.expiredAt > NOW_MS && tx.expiredAt <= rec.validUntil * 1_000n);
      // The signed transaction went to the venue and to the journal — not to the caller.
      assert.equal(x.venue.sent.length, 1);
      assert.ok(x.journal.get(out.attempt)?.artifact !== null);
      assert.equal(JSON.stringify(out).includes('fake-signature'), false);
    }));

  it('the reservation stays held after issuance; NEVER_ISSUED is forbidden', () =>
    withWorld(async (x) => {
      const { rec, issue } = await authorizeOrder(x);
      await x.signer.issueAuthorizedPerpOrder(rec, issue);
      const r = x.store.readCommitted(rec.principal).state.reservations.get(rec.reservation);
      assert.equal(r?.status, 'ACTIVE');
      const c = await x.w.engine.closeNeverIssued(rec, { payload: issue.payload, states: states(x.w, { btc: 20_000_000n, at: T + 6n }), context: context(T + 6n) }, ONCE);
      assert.ok(c.status === 'REFUSED' && c.refusal.code === 'NEVER_ISSUED_FORBIDDEN');
    }));
});

describe('one generation, one attempt', () => {
  it('a second request refers to the existing attempt and never signs again', () =>
    withWorld(async (x) => {
      const { rec, issue } = await authorizeOrder(x);
      const first = await x.signer.issueAuthorizedPerpOrder(rec, issue);
      x.venue.next = 1n; // even if the venue has moved on
      const second = await x.signer.issueAuthorizedPerpOrder(rec, issue);
      assert.equal(second.status, 'EXISTING');
      if (first.status === 'ISSUED' && second.status === 'EXISTING') assert.equal(second.attempt, first.attempt);
      assert.equal(x.custody.signs.length, 1);
      assert.equal(x.venue.sent.length, 1);
    }));

  it('100 concurrent issuance calls for one generation: one ADMIT_ATTEMPT, one signature, every other call refers to it', () =>
    withWorld(async (x) => {
      const { rec, issue } = await authorizeOrder(x);
      const outs = await Promise.all(Array.from({ length: 100 }, () => x.signer.issueAuthorizedPerpOrder(rec, issue)));
      assert.equal(outs.filter((o) => o.status === 'ISSUED').length, 1);
      for (const o of outs) assert.ok(o.status === 'ISSUED' || o.status === 'EXISTING', `${o.status} ${o.status === 'REFUSED' ? o.reason : ''}`);
      assert.equal(x.store.readCommitted(rec.principal).state.attempts.size, 1);
      assert.equal(x.custody.signs.length, 1);
      assert.equal(x.venue.sent.length, 1);
    }));
});

describe('exact binding: mutation is refused before key use', () => {
  it('a payload differing in quantity, price, market, side or reduce-only from the authorized one is refused', () =>
    withWorld(async (x) => {
      const { rec } = await authorizeOrder(x);
      const base = { account: ACCOUNT, market: BTC_MARKET, side: 'BUY' as const, baseAmount: 100n, price: BTC_PRICE_LIGHTER, execution: 'LIMIT_IOC' as const, reduceOnly: false, orderExpiryMs: 0n };
      for (const mutated of [
        { ...base, baseAmount: 101n },
        { ...base, price: BTC_PRICE_LIGHTER + 1n },
        { ...base, market: ETH_MARKET },
        { ...base, side: 'SELL' as const },
        { ...base, reduceOnly: true },
      ]) {
        const out = await x.signer.issueAuthorizedPerpOrder(rec, { payload: encodeOrder(mutated), states: states(x.w, { at: T + 5n }), context: context(T + 5n) });
        assert.deepEqual(out, { status: 'REFUSED', stage: 'RESOLVE', reason: 'PAYLOAD_NOT_AUTHORIZED', attemptAdmitted: false });
      }
      noSignature(x, 'mutated payloads');
      assert.equal(x.custody.hashes.length, 0);
      assert.equal(x.store.readCommitted(rec.principal).state.attempts.size, 0);
    }));

  it('a transaction differing from the derived one in any field — the nonce binding included — is refused before hashing', () =>
    withWorld(async (x) => {
      const { rec, issue } = await authorizeOrder(x);
      const intent = resolveIntent(x.deps, 'ORDER', rec, issue.payload);
      assert.ok(intent.ok);
      if (!intent.ok) return;
      const tx = construct(x.deps, intent.value, 7n);
      assert.ok(tx.ok);
      if (!tx.ok) return;
      for (const [field, value] of [['baseAmount', 101n], ['price', 1n], ['marketIndex', 4095], ['isAsk', 1], ['reduceOnly', 1], ['nonce', 8n], ['accountIndex', 1n], ['clientOrderIndex', 1n], ['expiredAt', tx.value.expiredAt + 1n], ['selfTradeBehavior', 0]] as const) {
        const g = guard(x.deps, intent.value, { ...tx.value, [field]: value }, 7n);
        assert.ok(!g.ok && g.reason === `TX_FIELD_MISMATCH.${field}`, field);
      }
      noSignature(x, 'mutated transactions');
    }));

  it('withdraw, transfer, pool, stake, sub-account, API-key, leverage and margin transactions are refused before key use', () =>
    withWorld(async (x) => {
      const { rec, issue } = await authorizeOrder(x);
      const intent = resolveIntent(x.deps, 'ORDER', rec, issue.payload);
      const tx = intent.ok ? construct(x.deps, intent.value, 7n) : null;
      assert.ok(intent.ok && tx !== null && tx.ok);
      if (!intent.ok || tx === null || !tx.ok) return;
      for (const type of ['WITHDRAW', 'TRANSFER', 'TRANSFER_SAME_MASTER', 'MINT_SHARES', 'BURN_SHARES', 'STAKE_ASSETS', 'CREATE_SUB_ACCOUNT', 'CREATE_PUBLIC_POOL', 'CHANGE_PUB_KEY', 'UPDATE_LEVERAGE', 'UPDATE_MARGIN', 'APPROVE_INTEGRATOR', 'MODIFY_ORDER']) {
        const g = guard(x.deps, intent.value, { ...tx.value, type }, 7n);
        assert.ok(!g.ok && g.reason === 'TX_TYPE_FORBIDDEN', type);
      }
      noSignature(x, 'forbidden transaction types');
    }));

  it('an authorization for another module, adapter or operation is refused before anything is read', () =>
    withWorld(async (x) => {
      const { rec, issue } = await authorizeOrder(x);
      const wrong = await x.signer.issueAuthorizedCancel(rec, issue);
      assert.deepEqual(wrong, { status: 'REFUSED', stage: 'RESOLVE', reason: 'ACTION_TYPE_NOT_THIS_OPERATION', attemptAdmitted: false });
      const otherAdapter = await x.signer.issueAuthorizedPerpOrder({ ...rec, adapter: { ...rec.adapter, adapterDigest: ('0x' + '9'.repeat(64)) as never } }, issue);
      assert.equal(otherAdapter.status === 'REFUSED' && otherAdapter.reason, 'ADAPTER_NOT_THIS_SIGNER');
      noSignature(x, 'foreign authorizations');
    }));
});

describe('submission outcomes: nothing is resubmitted, nothing released', () => {
  for (const [send, state] of [['UNKNOWN', 'OUTCOME_UNKNOWN'], ['REJECT', 'SUBMISSION_REJECTED'], ['ACK_OTHER_HASH', 'OUTCOME_UNKNOWN']] as const) {
    it(`a ${send} submission leaves the attempt ${state}; a later request refers to it and nothing is re-signed`, () =>
      withWorld(async (x) => {
        x.venue.send = send;
        const { rec, issue } = await authorizeOrder(x);
        const out = await x.signer.issueAuthorizedPerpOrder(rec, issue);
        assert.ok(out.status === 'ISSUED' && out.issuance === state);
        x.venue.send = 'ACK';
        const again = await x.signer.issueAuthorizedPerpOrder(rec, issue);
        assert.equal(again.status, 'EXISTING');
        assert.equal(x.custody.signs.length, 1);
        assert.equal(x.venue.sent.length, 1);
        assert.equal(x.store.readCommitted(rec.principal).state.reservations.get(rec.reservation)?.status, 'ACTIVE');
      }));
  }
});

describe('cancel issuance', () => {
  it('signs a cancel naming the target\'s derived client order index; the target reservation is untouched', () =>
    withWorld(async (x) => {
      const { rec: first, issue } = await authorizeOrder(x);
      await x.signer.issueAuthorizedPerpOrder(first, issue);
      x.venue.next = 1n; // the order's slot was consumed
      const c = cancel(x.w, x.g, { target: first.reservation as ReservationId, nonce: 1n });
      const resting = { openOrders: [{ marketIndex: 4096, clientOrderIndex: clientOrderIndexFor(first.reservation), isAsk: false, remainingBaseAmount: 100n, price: BTC_PRICE_LIGHTER, reduceOnly: false }] };
      const crec = authorized(await x.w.engine.authorizeAndReserve(request(c, states(x.w, { book: resting, at: T + 6n }), context(T + 6n)), ONCE));
      x.clock.ms = (T + 7n) * 1_000n;
      const out = await x.signer.issueAuthorizedCancel(crec, { payload: c.payload, states: states(x.w, { book: resting, at: T + 7n }), context: context(T + 7n) });
      assert.equal(out.status, 'ISSUED');
      const tx = x.custody.signs.at(-1)?.tx as CustodyTx;
      assert.deepEqual([tx.type, tx.cancelIndex, tx.marketIndex, tx.nonce], ['CANCEL_ORDER', clientOrderIndexFor(first.reservation), 4096, 1n]);
      const target = x.store.readCommitted(first.principal).state.reservations.get(first.reservation);
      assert.equal(target?.status, 'ACTIVE');
      assert.ok(target?.demands.every((d) => d.released === 0n));
    }));
});

describe('pre-execution requirements at the signer', () => {
  it('a foreign key on the sub-account refuses issuance before key use', () =>
    withWorld(async (x) => {
      x.venue.keys = [...x.venue.keys, { apiKeyIndex: 2, publicKey: 'cd'.repeat(40) }];
      const { rec, issue } = await authorizeOrder(x);
      const out = await x.signer.issueAuthorizedPerpOrder(rec, issue);
      assert.deepEqual(out, { status: 'REFUSED', stage: 'ADMIT', reason: 'PRE_EXECUTION_FAILED.CREDENTIAL_SCOPE.FAIL.FOREIGN_KEY_REGISTERED', attemptAdmitted: false });
      noSignature(x, 'foreign key');
    }));

  it('a registered key that is not custody\'s refuses; a venue nonce ahead of the ledger refuses', () =>
    withWorld(async (x) => {
      x.custody.publicKeyValue = 'ef'.repeat(40);
      const { rec, issue } = await authorizeOrder(x);
      const a = await x.signer.issueAuthorizedPerpOrder(rec, issue);
      assert.ok(a.status === 'REFUSED' && a.reason === 'PRE_EXECUTION_FAILED.CREDENTIAL_SCOPE.FAIL.REGISTERED_KEY_NOT_CUSTODY_KEY');
      x.custody.publicKeyValue = PUBLIC_KEY;
      noSignature(x, 'wrong key');
    }));

  it('one serialized lane per key: while an admitted transaction has not consumed its slot, another order is LANE_BUSY', () =>
    withWorld(async (x) => {
      x.venue.next = 3n;
      const { rec, issue } = await authorizeOrder(x);
      assert.equal((await x.signer.issueAuthorizedPerpOrder(rec, issue)).status, 'ISSUED');
      const second = await authorizeOrder(x, { baseAmount: 50n, nonce: 1n }, T + 6n);
      // The venue still reports 3: slot 3 is unconsumed, its outcome not established.
      const busy = await x.signer.issueAuthorizedPerpOrder(second.rec, second.issue);
      assert.ok(busy.status === 'REFUSED' && busy.reason === 'PRE_EXECUTION_FAILED.NONCE_SLOT.FAIL.LANE_BUSY');
      // A venue ahead of the ledger means something else signed with the key.
      x.venue.next = 9n;
      const ahead = await x.signer.issueAuthorizedPerpOrder(second.rec, second.issue);
      assert.ok(ahead.status === 'REFUSED' && ahead.reason === 'PRE_EXECUTION_FAILED.NONCE_SLOT.FAIL.NONCE_AHEAD_OF_LEDGER');
      // Once slot 3 is consumed, the lane moves on.
      x.venue.next = 4n;
      assert.equal((await x.signer.issueAuthorizedPerpOrder(second.rec, second.issue)).status, 'ISSUED');
      assert.equal(x.custody.signs.length, 2);
    }));

  it('a resting order that would outlive the authorization, or live less than the venue minimum, is refused', () =>
    withWorld(async (x) => {
      const { rec, a } = await authorizeOrder(x, { execution: 'LIMIT_GTT', orderExpiryMs: (T0plus(600n)) * 1_000n });
      // The authorization's lifetime ends earlier than this GTT expiry would allow? Construct both cases directly.
      const tooSoon = resolveIntent({ ...x.deps, clock: () => (T0plus(600n) - 60n) * 1_000n }, 'ORDER', rec, a.payload);
      assert.ok(!tooSoon.ok && tooSoon.reason === 'ORDER_EXPIRY_TOO_SOON');
      const late = resolveIntent(x.deps, 'ORDER', { ...rec, validUntil: T + 60n }, a.payload);
      assert.ok(!late.ok && late.reason === 'ORDER_OUTLIVES_AUTHORIZATION');
    }));
});

function T0plus(s: bigint): bigint {
  return T + s;
}

describe('module and adapter lifecycle at the signer', () => {
  it('a DISABLED module or adapter refuses admission — the key is never used', async () => {
    for (const o of [{ moduleStatus: 'DISABLED' as const }, { adapterStatus: 'DISABLED' as const }]) {
      // Authorize under an ACTIVE world, then issue through one where the status has changed.
      const x = await issuanceWorld();
      try {
        const { rec, issue } = await authorizeOrder(x);
        x.store.close();
        const y = await issuanceWorld({ path: x.path, reopen: true, ...o });
        try {
          const out = await y.signer.issueAuthorizedPerpOrder(rec, issue);
          assert.equal(out.status, 'REFUSED');
          if (out.status === 'REFUSED') assert.match(out.reason, o.moduleStatus !== undefined ? /MODULE_DISABLED/ : /ADAPTER_DISABLED/);
          noSignature(y, JSON.stringify(o));
        } finally {
          y.store.close();
        }
      } finally {
        x.close();
      }
    }
  });
});

describe('the signer\'s surface', () => {
  it('has two typed issue operations and recovery — no sign(bytes), no key, no SDK client', () => {
    assert.deepEqual(Object.getOwnPropertyNames(VenueSigner.prototype).sort(), ['constructor', 'issueAuthorizedCancel', 'issueAuthorizedPerpOrder', 'recover']);
    for (const name of Object.keys(pkg)) assert.doesNotMatch(name, /^sign|signBytes|signTransaction|privateKey|rawKey|issue$|construct|guard|resolveIntent/i, name);
    void API_KEY_INDEX;
  });
});
