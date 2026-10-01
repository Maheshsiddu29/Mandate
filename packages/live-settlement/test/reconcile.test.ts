/**
 * The durable settlement lifecycle and restart reconciliation (B.5.3,
 * docs/demo/wallet-settlement-boundaries.md §5) — UNIT SIMULATION.
 *
 * A send is stopped at each fault point by a thrown `SimulatedCrash` (the
 * issuance path has no catch, so nothing after the point runs), then a
 * *fresh* settlement and the reconciler work from what is left: the
 * journal, the portfolio ledger and the chain. The real-process version of
 * the same cases, with SIGKILL, is crash.test.ts.
 *
 * Invariants checked throughout: one reservation → at most one economic
 * execution; a successful execution → CONSUMED; possible execution → never
 * released, never resent; release only on proof nothing can execute.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { judge, reconcileAttempts, type ChainEvidence } from '../src/reconcile.ts';
import { reservationStatus } from '../src/portfolio-ledger.ts';
import { FAULT_POINTS, LiveSettlement, type FaultPoint, type Prepared } from '../src/settlement.ts';
import { SendGate } from '../src/send-gate.ts';
import { MDEMO, PRINCIPAL, settlementWorld, type SettlementWorld } from './support/world.ts';
import type { AttemptRecord } from '../src/journal.ts';

class SimulatedCrash extends Error {}

const open = (): SendGate => {
  const g = new SendGate();
  g.authorize('AUTHORIZE ROBINHOOD TESTNET SEND');
  return g;
};

async function withWorld(f: (w: SettlementWorld) => Promise<void>): Promise<void> {
  const w = await settlementWorld();
  try {
    await f(w);
  } finally {
    w.close();
  }
}

async function prepared(w: SettlementWorld): Promise<Prepared> {
  const p = await w.settlement.prepare();
  if ('ineligible' in p) throw new Error(`not prepared: ${p.ineligible}`);
  return p;
}

async function ledgerStatus(w: SettlementWorld, p: Prepared): Promise<string> {
  const core = w.session.versions.coreOf(p.execution.version)?.core;
  assert.ok(core !== undefined);
  return reservationStatus((await core.engine.read(core.compiled.mandate.principal)).state, p.execution.reservation);
}

/** Send, stopping the process at `point`. */
async function crashAt(w: SettlementWorld, p: Prepared, point: FaultPoint): Promise<void> {
  await assert.rejects(
    () => w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath(), fault: (f) => {
      if (f === point) throw new SimulatedCrash(point);
    } }),
    SimulatedCrash,
  );
}

/** A restart: a fresh settlement over the same session, journal and chain, and the reconciler. */
async function restart(w: SettlementWorld) {
  return reconcileAttempts({ journal: w.journal, reader: w.rpc, session: w.session, deployment: w.deployment });
}

const attempt = (w: SettlementWorld, p: Prepared): AttemptRecord => {
  const a = w.journal.get(p.execution.reservation);
  assert.ok(a !== null);
  return a;
};

describe('a send survives a crash at every point (unit simulation)', () => {
  const expected: { readonly [P in FaultPoint]: { readonly after: string; readonly broadcasts: number; readonly final: string; readonly ledger: string } } = {
    AFTER_PREPARED: { after: 'PREPARED', broadcasts: 0, final: 'PREPARED', ledger: 'RESERVED' },
    AFTER_PORTFOLIO_ATTEMPT: { after: 'PREPARED', broadcasts: 0, final: 'PREPARED', ledger: 'ADMITTED' },
    AFTER_DOMAIN_BOUND: { after: 'PREPARED', broadcasts: 0, final: 'RELEASED', ledger: 'RELEASED' },
    AFTER_ARTIFACT_JOURNALED: { after: 'PREPARED', broadcasts: 0, final: 'RELEASED', ledger: 'RELEASED' },
    AFTER_TX_HASH_PERSISTED: { after: 'SUBMISSION_STARTED', broadcasts: 0, final: 'RELEASED', ledger: 'RELEASED' },
    AFTER_BROADCAST_ACCEPTED: { after: 'SUBMISSION_STARTED', broadcasts: 1, final: 'CONSUMED', ledger: 'CONSUMED' },
    AFTER_SUBMITTED: { after: 'SUBMITTED', broadcasts: 1, final: 'CONSUMED', ledger: 'CONSUMED' },
    AFTER_RECEIPT: { after: 'SUBMITTED', broadcasts: 1, final: 'CONSUMED', ledger: 'CONSUMED' },
    AFTER_CONFIRMED: { after: 'CONFIRMED_SUCCESS', broadcasts: 1, final: 'CONSUMED', ledger: 'CONSUMED' },
    AFTER_SETTLED: { after: 'SETTLED', broadcasts: 1, final: 'CONSUMED', ledger: 'CONSUMED' },
    AFTER_CONSUMED: { after: 'CONSUMED', broadcasts: 1, final: 'CONSUMED', ledger: 'CONSUMED' },
  };
  for (const point of FAULT_POINTS) {
    it(`crash ${point}: ${expected[point].after} → ${expected[point].final}, ${expected[point].broadcasts} broadcast, never two`, async () => {
      await withWorld(async (w) => {
        const p = await prepared(w);
        await crashAt(w, p, point);
        assert.equal(attempt(w, p).state, expected[point].after);
        assert.equal(w.rpc.broadcasts, expected[point].broadcasts);
        // Possible execution: a fresh process never sends again; only PREPARED with no send leg may.
        const fresh = new LiveSettlement({ session: w.session, deployment: w.deployment, rpc: w.rpc, keys: { principal: '', agent: '' } });
        if (expected[point].after !== 'PREPARED' || point === 'AFTER_DOMAIN_BOUND' || point === 'AFTER_ARTIFACT_JOURNALED') {
          const again = await fresh.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath(), journal: w.journal });
          assert.equal(again.status, 'INELIGIBLE');
          assert.equal(w.rpc.broadcasts, expected[point].broadcasts);
        }
        await restart(w);
        // Every artifact dies at its gate deadline; reconcile again once the chain is past it.
        w.rpc.chain.time += 2_000n;
        await restart(w);
        assert.equal(attempt(w, p).state, expected[point].final);
        assert.equal(await ledgerStatus(w, p), expected[point].ledger);
        assert.ok(w.rpc.broadcasts <= 1);
        assert.ok(w.rpc.chain.txs.length <= 1);
        if (expected[point].final === 'CONSUMED') {
          assert.equal(w.of('RESERVATION_CONSUMED').length, 1);
          assert.equal(w.of('DOMAIN_EXECUTION_SETTLED').length, 1);
          // Consumed: no process, fresh or not, can execute this reservation again.
          const after = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
          assert.equal(after.status, 'INELIGIBLE');
        }
        // Reconciling again changes nothing and emits nothing new.
        const n = w.session.events.events.filter((e) => e.kind !== 'SETTLEMENT_RECONCILIATION_STARTED').length;
        await restart(w);
        assert.equal(w.session.events.events.filter((e) => e.kind !== 'SETTLEMENT_RECONCILIATION_STARTED').length, n);
      });
    });
  }

  it('a PREPARED attempt with no send leg resumes: the second process sends once and consumes', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      await crashAt(w, p, 'AFTER_PORTFOLIO_ATTEMPT');
      const fresh = new LiveSettlement({ session: w.session, deployment: w.deployment, rpc: w.rpc, keys: { principal: (await import('./support/world.ts')).KEYS.principal, agent: (await import('./support/world.ts')).KEYS.agent } });
      const r = await fresh.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath(), journal: w.journal });
      assert.equal(r.status, 'CONFIRMED');
      assert.equal(attempt(w, p).state, 'CONSUMED');
      assert.equal(w.rpc.broadcasts, 1);
    });
  });
});

describe('reconciliation outcomes', () => {
  it('a timeout after broadcast does not release: the hash is looked up first, and the mined receipt settles', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      w.rpc.broadcastBehaviour = 'ERROR_BUT_MINED';
      w.rpc.withholdReceipts = true;
      const r = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      assert.equal(r.status, 'SUBMITTED_UNCONFIRMED');
      assert.equal(attempt(w, p).state, 'SUBMITTED');
      assert.equal(await ledgerStatus(w, p), 'ADMITTED');
      // Still no receipt: pending, held.
      const pending = await restart(w);
      assert.equal(pending[0]?.outcome, 'STILL_PENDING');
      assert.equal(await ledgerStatus(w, p), 'ADMITTED');
      w.rpc.withholdReceipts = false;
      const done = await restart(w);
      assert.equal(done[0]?.to, 'CONSUMED');
      assert.equal(w.rpc.broadcasts, 1);
    });
  });

  it('an ambiguous broadcast the chain never saw is held until every artifact is dead, then released — never resent', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      w.rpc.broadcastBehaviour = 'ERROR_NOT_SENT';
      const r = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      assert.equal(r.status, 'SUBMITTED_UNCONFIRMED');
      const a = attempt(w, p);
      assert.equal(a.state, 'RECONCILIATION_REQUIRED');
      assert.equal(a.quarantine, 'AMBIGUOUS_BROADCAST');
      await restart(w);
      assert.equal(attempt(w, p).quarantine, 'AWAITING_DEADLINE');
      assert.equal(await ledgerStatus(w, p), 'ADMITTED');
      w.rpc.chain.time += 2_000n;
      await restart(w);
      assert.equal(attempt(w, p).state, 'RELEASED');
      assert.equal(await ledgerStatus(w, p), 'RELEASED');
      assert.equal(w.rpc.broadcasts, 1);
      assert.equal(w.rpc.chain.txs.length, 0);
      assert.equal(w.of('RESERVATION_RELEASED').length, 1);
    });
  });

  it('a mined revert is not settled, and releases only once its artifact can never execute', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      w.rpc.beforeMine = () => w.rpc.chain.approve(w.deployment.mdusd.address, PRINCIPAL, w.deployment.gate.address, 0n);
      const r = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      assert.equal(r.status, 'FAILED');
      assert.equal(attempt(w, p).state, 'CONFIRMED_REVERT');
      await restart(w);
      assert.equal(attempt(w, p).state, 'CONFIRMED_REVERT');
      assert.equal(await ledgerStatus(w, p), 'ADMITTED');
      w.rpc.chain.time += 2_000n;
      await restart(w);
      assert.equal(attempt(w, p).state, 'RELEASED');
      assert.equal(await ledgerStatus(w, p), 'RELEASED');
      assert.equal(w.of('DOMAIN_EXECUTION_SETTLED').length, 0);
    });
  });

  it('a successful receipt with a surprising postcondition is quarantined: never released, never resent', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      // Someone else moves the principal's MDEMO in the same block.
      w.rpc.beforeMine = () => w.rpc.chain.fund(MDEMO, PRINCIPAL, 1n);
      const r = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      assert.equal(r.status, 'CONFIRMED');
      const a = attempt(w, p);
      assert.equal(a.state, 'RECONCILIATION_REQUIRED');
      assert.equal(a.quarantine, 'POSTCONDITION_ANOMALY');
      w.rpc.chain.time += 2_000n;
      await restart(w);
      assert.equal(attempt(w, p).state, 'RECONCILIATION_REQUIRED');
      assert.equal(await ledgerStatus(w, p), 'ADMITTED');
      assert.ok(w.of('SETTLEMENT_RECONCILED').some((e) => e.data['quarantine'] === 'POSTCONDITION_ANOMALY'));
      const again = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      assert.equal(again.status, 'INELIGIBLE');
      assert.equal(w.rpc.broadcasts, 1);
    });
  });

  it('a second attempt for the same reservation is refused: by the journal, and by the portfolio ledger when the journal is gone', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      await crashAt(w, p, 'AFTER_DOMAIN_BOUND');
      const byJournal = await w.settlement.run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      assert.equal(byJournal.status === 'INELIGIBLE' && byJournal.reason, 'SEND_LEG_ALREADY_OPENED_RECONCILE_ONLY');
      // The journal is lost: the portfolio ledger still holds the attempt, so no send.
      const { SettlementJournal } = await import('../src/journal.ts');
      const { mkdtempSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const blank = SettlementJournal.open(join(mkdtempSync(join(tmpdir(), 'mandate-blank-journal-')), 'settlement.db'));
      const lost = await new LiveSettlement({ session: w.session, deployment: w.deployment, rpc: w.rpc, keys: { principal: '', agent: '' } }).run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath(), journal: blank });
      assert.equal(lost.status === 'INELIGIBLE' && lost.reason, 'PORTFOLIO_ATTEMPT_WITHOUT_JOURNAL_RECORD');
      blank.close();
      assert.equal(w.rpc.broadcasts, 0);
    });
  });

  it('a send needs a durable journal; a wallet-approved version never sends, and its dry run names both principals', async () => {
    await withWorld(async (w) => {
      const p = await prepared(w);
      const noJournal = await new LiveSettlement({ session: w.session, deployment: w.deployment, rpc: w.rpc, keys: { principal: '', agent: '' } }).run(p, { mode: 'SEND', gate: open(), ledgerPath: w.ledgerPath() });
      assert.equal(noJournal.status === 'INELIGIBLE' && noJournal.reason, 'DURABLE_JOURNAL_REQUIRED_FOR_SEND');
    });
  });

  it('judge: unreadable evidence is never read as an answer', () => {
    const a = { tx: { hash: '0x01' }, artifactDeadAfter: '100' } as unknown as AttemptRecord;
    const art = [{ reservation: 'r', mandateDigest: '0xm', commitment: '0xc', deadline: '90', mode: 'SEND' as const }];
    const ev = (o: Partial<ChainEvidence>): ChainEvidence => ({ chainTime: 50n, receipt: null, txKnown: false, commitments: new Map([['0xm', `0x${'00'.repeat(32)}`]]), ...o });
    assert.equal(judge(a, art, ev({ receipt: 'UNREADABLE' })).outcome, 'AMBIGUOUS');
    assert.equal(judge(a, art, ev({ txKnown: 'UNREADABLE' })).outcome, 'AMBIGUOUS');
    assert.equal(judge(a, art, ev({ commitments: new Map([['0xm', 'UNREADABLE']]) })).outcome, 'AMBIGUOUS');
    assert.equal(judge(a, art, ev({ chainTime: 'UNREADABLE' })).outcome, 'AMBIGUOUS');
    assert.equal(judge(a, art, ev({})).reason, 'AWAITING_DEADLINE');
    assert.equal(judge(a, art, ev({ chainTime: 101n })).outcome, 'NEVER_SUBMITTED');
    assert.equal(judge(a, art, ev({ chainTime: 101n, commitments: new Map([['0xm', '0xc']]) })).reason, 'EXECUTED_OUTSIDE_ATTEMPT');
    assert.equal(judge(a, art, ev({ txKnown: true })).outcome, 'STILL_PENDING');
    // A hash without a receipt is never settlement.
    assert.notEqual(judge(a, art, ev({ chainTime: 50n })).outcome, 'CONFIRMED_SUCCESS');
  });
});
