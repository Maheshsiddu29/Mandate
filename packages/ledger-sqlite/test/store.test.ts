/**
 * The SQLite reference store against the ledger store contract, with real
 * durability: restarts, injected failures at every point of a commit, real
 * process crashes (SIGKILL inside the transaction and just after COMMIT),
 * stale compare-and-swap, concurrent writers in other processes, replay from
 * the stored log, and corruption detection. The outcome is always one
 * complete committed state, never a partial one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { encodeLedgerState, InMemoryLedgerStore, replayEncoded, type LedgerEvent } from '@mandate/ledger';
import { LedgerStoreCorruption, SqliteLedgerStore, type SqliteFaultPoint } from '../src/index.ts';
import { PRINCIPAL, SETUP, admission, admitEvent, must, reserveEvent, runChild, runChildAsync, tempDb } from './support/world.ts';

async function commit(store: SqliteLedgerStore | InMemoryLedgerStore, events: (s: Awaited<ReturnType<SqliteLedgerStore['read']>>) => LedgerEvent[]) {
  const s = await store.read(PRINCIPAL);
  return store.compareAndAppend(PRINCIPAL, s.version, s.head, events(s));
}

async function history(store: SqliteLedgerStore | InMemoryLedgerStore) {
  await commit(store, () => SETUP);
  await commit(store, (s) => [reserveEvent(s.state)]);
  return commit(store, () => [admitEvent()]);
}

describe('SQLite ledger store', () => {
  it('commits exactly what the in-memory reference store commits, byte for byte', async () => {
    const db = tempDb();
    try {
      const durable = SqliteLedgerStore.open({ path: db.path });
      const memory = new InMemoryLedgerStore();
      const a = await history(durable);
      const b = await history(memory);
      assert.ok(a.status === 'COMMITTED' && b.status === 'COMMITTED');
      assert.equal(a.snapshot.head, b.snapshot.head);
      assert.deepEqual(encodeLedgerState(a.snapshot.state), encodeLedgerState(b.snapshot.state));
      assert.equal((await durable.history(PRINCIPAL)).length, 3);
      durable.close();
    } finally {
      db.cleanup();
    }
  });

  it('restart after a reservation, after ADMIT_ATTEMPT, and replay from the stored log all reproduce the committed state', async () => {
    const db = tempDb();
    try {
      const first = SqliteLedgerStore.open({ path: db.path });
      await commit(first, () => SETUP);
      const reserved = await commit(first, (s) => [reserveEvent(s.state)]);
      assert.ok(reserved.status === 'COMMITTED');
      first.close();

      const second = SqliteLedgerStore.open({ path: db.path });
      const afterReserve = await second.read(PRINCIPAL);
      assert.deepEqual(encodeLedgerState(afterReserve.state), encodeLedgerState(reserved.snapshot.state));
      const admitted = await commit(second, () => [admitEvent()]);
      assert.ok(admitted.status === 'COMMITTED');
      second.close();

      const third = SqliteLedgerStore.open({ path: db.path });
      const s = await third.read(PRINCIPAL);
      assert.equal(s.version, 3n);
      assert.equal(s.state.attempts.size, 1);
      assert.deepEqual(encodeLedgerState(s.state), encodeLedgerState(admitted.snapshot.state));
      const replayed = must(replayEncoded(PRINCIPAL, (await third.history(PRINCIPAL)).map((b) => b.encoded)));
      assert.deepEqual(encodeLedgerState(replayed), encodeLedgerState(s.state));
      third.close();
    } finally {
      db.cleanup();
    }
  });

  for (const point of ['BEFORE_BEGIN', 'AFTER_VERSION_CHECK', 'AFTER_INSERT', 'BEFORE_COMMIT'] as const) {
    it(`a failure at ${point} writes nothing, and the store stays usable`, async () => {
      const db = tempDb();
      try {
        const store = SqliteLedgerStore.open({ path: db.path, fault: (p) => { if (p === point && armed) throw new Error(`fault ${p}`); } });
        let armed = false;
        await commit(store, () => SETUP);
        const before = await store.read(PRINCIPAL);
        armed = true;
        await assert.rejects(commit(store, (s) => [reserveEvent(s.state)]), /fault/);
        armed = false;
        const after = await store.read(PRINCIPAL);
        assert.equal(after.version, before.version);
        assert.equal(after.head, before.head);
        store.close();
        const reopened = SqliteLedgerStore.open({ path: db.path });
        assert.equal((await reopened.read(PRINCIPAL)).version, before.version);
        assert.equal((await commit(reopened, (s) => [reserveEvent(s.state)])).status, 'COMMITTED');
        reopened.close();
      } finally {
        db.cleanup();
      }
    });
  }

  it('a failure after COMMIT reaches the caller, but the batch is durable; retrying the same CAS conflicts rather than applying twice', async () => {
    const db = tempDb();
    try {
      let armed = false;
      const store = SqliteLedgerStore.open({ path: db.path, fault: (p) => { if (p === 'AFTER_COMMIT' && armed) throw new Error('lost response'); } });
      await commit(store, () => SETUP);
      const before = await store.read(PRINCIPAL);
      armed = true;
      const event = reserveEvent(before.state);
      await assert.rejects(store.compareAndAppend(PRINCIPAL, before.version, before.head, [event]), /lost response/);
      armed = false;
      const retry = await store.compareAndAppend(PRINCIPAL, before.version, before.head, [event]);
      assert.equal(retry.status, 'CONFLICT');
      store.close();
      const reopened = SqliteLedgerStore.open({ path: db.path });
      assert.equal((await reopened.read(PRINCIPAL)).version, 2n);
      reopened.close();
    } finally {
      db.cleanup();
    }
  });

  const crashes: { point: SqliteFaultPoint; what: 'reserve' | 'admit'; version: bigint }[] = [
    { point: 'AFTER_INSERT', what: 'reserve', version: 1n },
    { point: 'BEFORE_COMMIT', what: 'reserve', version: 1n },
    { point: 'AFTER_COMMIT', what: 'reserve', version: 2n },
    { point: 'BEFORE_COMMIT', what: 'admit', version: 2n },
    { point: 'AFTER_COMMIT', what: 'admit', version: 3n },
  ];
  for (const c of crashes) {
    it(`a real crash (SIGKILL) at ${c.point} while committing ${c.what} leaves version ${c.version} — whole, never partial`, async () => {
      const db = tempDb();
      try {
        assert.equal(runChild(['setup', db.path]).status, 0);
        const r = runChild(['crash', db.path, c.point, c.what]);
        assert.equal(r.signal, 'SIGKILL', r.stderr);
        const store = SqliteLedgerStore.open({ path: db.path });
        const s = await store.read(PRINCIPAL);
        assert.equal(s.version, c.version);
        const replayed = must(replayEncoded(PRINCIPAL, (await store.history(PRINCIPAL)).map((b) => b.encoded)));
        assert.deepEqual(encodeLedgerState(replayed), encodeLedgerState(s.state));
        assert.equal(s.state.attempts.size, c.what === 'admit' && c.version === 3n ? 1 : 0);
        store.close();
      } finally {
        db.cleanup();
      }
    });
  }

  it('a stale compare-and-swap from a second store on the same file conflicts, and its next read sees the other commit', async () => {
    const db = tempDb();
    try {
      const a = SqliteLedgerStore.open({ path: db.path });
      const b = SqliteLedgerStore.open({ path: db.path });
      await commit(a, () => SETUP);
      const staleA = await a.read(PRINCIPAL);
      const fresh = await b.read(PRINCIPAL);
      assert.equal(fresh.version, 1n);
      assert.equal((await b.compareAndAppend(PRINCIPAL, fresh.version, fresh.head, [reserveEvent(fresh.state)])).status, 'COMMITTED');
      const lost = await a.compareAndAppend(PRINCIPAL, staleA.version, staleA.head, [reserveEvent(staleA.state)]);
      assert.equal(lost.status, 'CONFLICT');
      assert.equal((await a.read(PRINCIPAL)).version, 2n);
      a.close();
      b.close();
    } finally {
      db.cleanup();
    }
  });

  it('four writer processes contending on one file each commit every batch exactly once, in one unbroken chain', async () => {
    const db = tempDb();
    try {
      assert.equal(runChild(['setup', db.path]).status, 0);
      const results = await Promise.all([1, 2, 3, 4].map((id) => runChildAsync(['writer', db.path, String(id), '5'])));
      for (const r of results) assert.equal(r.status, 0, r.stderr);
      const store = SqliteLedgerStore.open({ path: db.path });
      const s = await store.read(PRINCIPAL);
      assert.equal(s.version, 21n);
      assert.equal(s.state.nodes.size, 21);
      const replayed = must(replayEncoded(PRINCIPAL, (await store.history(PRINCIPAL)).map((b) => b.encoded)));
      assert.deepEqual(encodeLedgerState(replayed), encodeLedgerState(s.state));
      store.close();
    } finally {
      db.cleanup();
    }
  });

  it('refuses to serve a history whose stored bytes were altered', async () => {
    const db = tempDb();
    try {
      const store = SqliteLedgerStore.open({ path: db.path });
      await history(store);
      store.close();
      const raw = new DatabaseSync(db.path);
      const row = raw.prepare('SELECT encoded FROM ledger_batches WHERE version = 3').get() as { encoded: Uint8Array };
      const tampered = new Uint8Array(row.encoded);
      tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 1;
      raw.prepare('UPDATE ledger_batches SET encoded = ? WHERE version = 3').run(tampered);
      raw.close();
      const reopened = SqliteLedgerStore.open({ path: db.path });
      await assert.rejects(reopened.read(PRINCIPAL), LedgerStoreCorruption);
      reopened.close();
    } finally {
      db.cleanup();
    }
  });

  it('refuses an in-memory database: it exists to be durable', () => {
    assert.throws(() => SqliteLedgerStore.open({ path: ':memory:' }), /durable/);
  });

  it('an attempt admission refused by the reducer writes nothing', async () => {
    const db = tempDb();
    try {
      const store = SqliteLedgerStore.open({ path: db.path });
      await history(store);
      const refused = await commit(store, () => [admitEvent(admission('b', 8n))]);
      assert.ok(refused.status === 'REFUSED');
      assert.equal(refused.refusal.code, 'ATTEMPT_UNRESOLVED');
      assert.equal((await store.read(PRINCIPAL)).version, 3n);
      store.close();
    } finally {
      db.cleanup();
    }
  });
});
