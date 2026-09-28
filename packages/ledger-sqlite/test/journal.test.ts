/**
 * The issuance journal shares the ledger's database and refuses to record
 * anything for an attempt the committed ledger has not admitted; its
 * transitions are closed and monotone; `OUTCOME_UNKNOWN` has no way out; and
 * its records survive a restart.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IssuanceJournal, SqliteLedgerStore } from '../src/index.ts';
import { PRINCIPAL, SETUP, admission, admitEvent, reserveEvent, tempDb } from './support/world.ts';

async function admitted(path: string): Promise<SqliteLedgerStore> {
  const store = SqliteLedgerStore.open({ path });
  let s = await store.read(PRINCIPAL);
  for (const events of [SETUP, 'reserve', [admitEvent()]] as const) {
    const out = await store.compareAndAppend(PRINCIPAL, s.version, s.head, events === 'reserve' ? [reserveEvent(s.state)] : [...events]);
    assert.ok(out.status === 'COMMITTED');
    s = out.snapshot;
  }
  return store;
}

describe('issuance journal', () => {
  it('records nothing for an attempt the ledger has not admitted', async () => {
    const db = tempDb();
    try {
      const store = SqliteLedgerStore.open({ path: db.path });
      const journal = new IssuanceJournal(store);
      const r = journal.open(PRINCIPAL, admission().attempt, 'ARTIFACT_ISSUED', new Uint8Array([1]), 'signed');
      assert.deepEqual(r, { ok: false, reason: 'ATTEMPT_NOT_ADMITTED' });
      store.close();
    } finally {
      db.cleanup();
    }
  });

  it('follows the closed transition table; OUTCOME_UNKNOWN and acknowledgement are terminal here', async () => {
    const db = tempDb();
    try {
      const store = await admitted(db.path);
      const journal = new IssuanceJournal(store);
      const id = admission().attempt;
      assert.equal(journal.open(PRINCIPAL, id, 'ARTIFACT_ISSUED', new Uint8Array([1, 2, 3]), 'signed').ok, true);
      assert.deepEqual(journal.open(PRINCIPAL, id, 'ARTIFACT_ISSUED', new Uint8Array([9]), 'again'), { ok: false, reason: 'ALREADY_RECORDED' });
      assert.deepEqual(journal.transition(id, 'SUBMISSION_ACKNOWLEDGED', 'skip'), { ok: false, reason: 'TRANSITION_FORBIDDEN' });
      assert.equal(journal.transition(id, 'SUBMISSION_SENT', 'sent').ok, true);
      const unknown = journal.transition(id, 'OUTCOME_UNKNOWN', 'timeout');
      assert.ok(unknown.ok && unknown.record.state === 'OUTCOME_UNKNOWN');
      for (const to of ['SUBMISSION_SENT', 'SUBMISSION_ACKNOWLEDGED', 'ARTIFACT_ISSUED'] as const) assert.deepEqual(journal.transition(id, to, 'retry'), { ok: false, reason: 'TRANSITION_FORBIDDEN' });
      assert.deepEqual(journal.get(id)?.artifact, new Uint8Array([1, 2, 3]));
      store.close();
    } finally {
      db.cleanup();
    }
  });

  it('survives a restart with its artifact, state and history', async () => {
    const db = tempDb();
    try {
      const store = await admitted(db.path);
      const id = admission().attempt;
      const journal = new IssuanceJournal(store);
      journal.open(PRINCIPAL, id, 'ARTIFACT_ISSUED', new Uint8Array([7]), 'signed');
      journal.transition(id, 'SUBMISSION_SENT', 'sent');
      store.close();
      const reopened = SqliteLedgerStore.open({ path: db.path });
      const again = new IssuanceJournal(reopened);
      const rec = again.get(id);
      assert.equal(rec?.state, 'SUBMISSION_SENT');
      assert.equal(rec?.seq, 2n);
      assert.deepEqual(rec?.artifact, new Uint8Array([7]));
      assert.equal(again.list(PRINCIPAL).length, 1);
      reopened.close();
    } finally {
      db.cleanup();
    }
  });
});
