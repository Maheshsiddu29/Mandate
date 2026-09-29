/**
 * 7E.2 derived indexes and durable lifecycle. The attempt and closure
 * indexes are written in the batch's own transaction (a failed commit writes
 * neither), and point at the batch whose bytes carry the fact. The lifecycle
 * table is the one status source for Control and custody; changes take effect
 * at the next lookup.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateModuleRef } from '@mandate/core';
import { decodeBatch } from '@mandate/ledger';
import type { ImplementationDigest } from '@mandate/core';
import { DurableAdapterRegistry, DurableModuleRegistry, LifecycleTable, SqliteLedgerStore, type SqlRow } from '../src/index.ts';
import { ADAPTER, PRINCIPAL, SETUP, admission, admitEvent, digestOf, must, reserveEvent, tempDb } from './support/world.ts';

describe('derived attempt and closure indexes', () => {
  it('an admission is indexed, in its own batch, atomically with it', async () => {
    const db = tempDb();
    try {
      let fail = false;
      const store = SqliteLedgerStore.open({ path: db.path, fault: (p) => { if (fail && p === 'BEFORE_COMMIT') throw new Error('fault'); } });
      let s = await store.read(PRINCIPAL);
      for (const events of [SETUP, 'reserve'] as const) {
        const out = await store.compareAndAppend(PRINCIPAL, s.version, s.head, events === 'reserve' ? [reserveEvent(s.state)] : [...events]);
        assert.ok(out.status === 'COMMITTED');
        s = out.snapshot;
      }
      fail = true;
      await assert.rejects(store.compareAndAppend(PRINCIPAL, s.version, s.head, [admitEvent()]));
      const q = store.database.prepare('SELECT principal, version FROM ledger_attempt_index WHERE attempt = ?');
      q.setReadBigInts(true);
      assert.equal(q.get(admission().attempt), undefined, 'a failed commit indexes nothing');
      fail = false;
      const ok = await store.compareAndAppend(PRINCIPAL, s.version, s.head, [admitEvent()]);
      assert.ok(ok.status === 'COMMITTED');
      const row = q.get(admission().attempt) as SqlRow;
      assert.equal(row['version'], 3n);
      const batch = store.database.prepare('SELECT encoded FROM ledger_batches WHERE principal = ? AND version = 3').get(row['principal'] as string) as { encoded: Uint8Array };
      const decoded = must(decodeBatch(batch.encoded));
      assert.equal(decoded.events[0]?.kind, 'ADMIT_ATTEMPT');
      store.close();
    } finally {
      db.cleanup();
    }
  });
});

describe('durable lifecycle', () => {
  it('Control and custody read one status source; a change applies at the next lookup', () => {
    const db = tempDb();
    try {
      const store = SqliteLedgerStore.open({ path: db.path });
      const table = new LifecycleTable(store);
      const ref = must(validateModuleRef({ domainId: 'perp', moduleId: 'perp-policy', moduleVersion: 1, moduleDigest: digestOf('manifest:perp-policy:1') }));
      const modules = new DurableModuleRegistry(table);
      const adapters = new DurableAdapterRegistry(table);
      assert.equal(modules.lookup('perp-policy', 1), null);
      table.setModule({ module: ref, status: 'ACTIVE', implementations: [digestOf('impl') as ImplementationDigest] });
      table.setAdapter({ adapter: ADAPTER, status: 'ACTIVE' });
      assert.equal(modules.lookup('perp-policy', 1)?.status, 'ACTIVE');
      assert.deepEqual(modules.lookup('perp-policy', 1)?.module, ref);
      table.setModule({ module: ref, status: 'DISABLED', implementations: [] });
      assert.equal(modules.lookup('perp-policy', 1)?.status, 'DISABLED');
      assert.equal(adapters.lookup(ADAPTER.adapterId, ADAPTER.adapterVersion)?.status, 'ACTIVE');
      store.close();
      const reopened = SqliteLedgerStore.open({ path: db.path });
      assert.equal(new DurableModuleRegistry(new LifecycleTable(reopened)).lookup('perp-policy', 1)?.status, 'DISABLED', 'durable across restart');
      reopened.close();
    } finally {
      db.cleanup();
    }
  });
});
