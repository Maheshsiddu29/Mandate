/**
 * REAL PROCESS CRASH TESTS (B.5.3, docs/demo/wallet-settlement-boundaries.md §8).
 *
 * A child process restores a durable Live AI session, sends its reserved
 * Stock child over a reference-model chain that outlives it, and is killed
 * with SIGKILL just after a chosen durable write. Fresh processes then
 * reconcile and try to send again. Every case proves: the reservation, the
 * journal and the chain agree; nothing is broadcast twice; nothing executes
 * twice; a possible execution is never released; a successful one ends
 * CONSUMED, and stays consumed across another restart.
 *
 * The chain is the Phase 6 reference model (no network). The unit
 * simulation of every fault point is reconcile.test.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./support/crash-child.ts', import.meta.url));

function child(args: readonly string[], expectKill = false): { readonly out: string } {
  const r = spawnSync(process.execPath, ['--no-warnings', CHILD, ...args], { encoding: 'utf8' });
  if (expectKill) assert.equal(r.signal, 'SIGKILL', `child did not die at ${args.join(' ')}: status ${r.status} ${r.stderr}`);
  else assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
  return { out: r.stdout };
}

interface Reconciled {
  readonly reservations: number;
  readonly orphans: readonly string[];
  readonly state: string | null;
  readonly quarantine: string | null;
  readonly ledger: string;
  readonly mined: number;
  readonly kinds: readonly string[];
}

const reconcile = (dir: string, advance?: number): Reconciled => JSON.parse(child(['reconcile', dir, ...(advance === undefined ? [] : [String(advance)])]).out) as Reconciled;
const again = (dir: string): { readonly status: string; readonly mined: number; readonly ledger: string } => JSON.parse(child(['again', dir]).out);

function withDir(f: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mandate-crash-'));
  try {
    f(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const count = (r: Reconciled, kind: string) => r.kinds.filter((k) => k === kind).length;

describe('settlement crash recovery (REAL PROCESS CRASH: SIGKILL)', () => {
  it('1. killed after the reservation, before any settlement: the reservation survives, and one later send settles it once', () => {
    withDir((dir) => {
      child(['setup-die', dir], true);
      const r = reconcile(dir);
      assert.equal(r.reservations, 1);
      assert.deepEqual(r.orphans, []);
      assert.equal(r.state, null);
      assert.equal(r.ledger, 'RESERVED');
      const sent = again(dir);
      assert.equal(sent.status, 'CONFIRMED');
      assert.equal(sent.mined, 1);
      assert.equal(sent.ledger, 'CONSUMED');
      assert.equal(again(dir).status, 'INELIGIBLE');
      assert.equal(reconcile(dir).mined, 1);
    });
  });

  const cases = [
    { n: 2, point: 'AFTER_PREPARED', after: 'PREPARED', mined: 0, final: 'CONSUMED', resend: true },
    { n: 3, point: 'AFTER_TX_HASH_PERSISTED', after: 'RECONCILIATION_REQUIRED', mined: 0, final: 'RELEASED', resend: false },
    { n: 4, point: 'AFTER_BROADCAST_ACCEPTED', after: 'CONSUMED', mined: 1, final: 'CONSUMED', resend: false },
    { n: 5, point: 'AFTER_SUBMITTED', after: 'CONSUMED', mined: 1, final: 'CONSUMED', resend: false },
    { n: 6, point: 'AFTER_RECEIPT', after: 'CONSUMED', mined: 1, final: 'CONSUMED', resend: false },
    { n: 6, point: 'AFTER_CONFIRMED', after: 'CONSUMED', mined: 1, final: 'CONSUMED', resend: false },
    { n: 7, point: 'AFTER_SETTLED', after: 'CONSUMED', mined: 1, final: 'CONSUMED', resend: false },
    { n: 8, point: 'AFTER_CONSUMED', after: 'CONSUMED', mined: 1, final: 'CONSUMED', resend: false },
  ] as const;

  for (const c of cases) {
    it(`${c.n}. killed ${c.point}: a restart reconciles to ${c.final}, with ${c.mined === 0 ? 'no' : 'one'} execution and never a second`, () => {
      withDir((dir) => {
        child(['setup', dir]);
        child(['run', dir, c.point], true);
        // The first restart, before any deadline has passed.
        const first = reconcile(dir);
        assert.equal(first.state, c.after, JSON.stringify(first));
        assert.equal(first.mined, c.mined);
        if (c.after === 'RECONCILIATION_REQUIRED') {
          assert.equal(first.quarantine, 'AWAITING_DEADLINE');
          assert.equal(first.ledger, 'ADMITTED', 'possible execution: never released before the deadline');
        }
        // A fresh process may send only a PREPARED attempt with no send leg — and then exactly once.
        const sent = again(dir);
        if (c.resend) {
          assert.equal(sent.status, 'CONFIRMED');
          assert.equal(sent.mined, 1);
        } else {
          assert.equal(sent.status, 'INELIGIBLE');
          assert.equal(sent.mined, c.mined);
        }
        // Past every gate deadline: the final word.
        const last = reconcile(dir, 2_000);
        assert.equal(last.state, c.final, JSON.stringify(last));
        assert.equal(last.ledger, c.final === 'CONSUMED' ? 'CONSUMED' : 'RELEASED');
        assert.ok(last.mined <= 1, 'never two executions');
        if (c.final === 'CONSUMED') {
          assert.equal(count(last, 'RESERVATION_CONSUMED'), 1, 'the browser hears it once');
          assert.equal(count(last, 'DOMAIN_EXECUTION_SETTLED'), 1);
        } else assert.equal(count(last, 'RESERVATION_RELEASED'), 1);
        // And again, after one more restart: unchanged, no duplicate event, no execution.
        const still = reconcile(dir);
        assert.equal(still.state, c.final);
        assert.equal(still.mined, last.mined);
        assert.equal(count(still, 'RESERVATION_CONSUMED'), count(last, 'RESERVATION_CONSUMED'));
        assert.equal(again(dir).status, 'INELIGIBLE');
      });
    });
  }
});
