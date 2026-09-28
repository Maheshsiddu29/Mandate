/**
 * Model-based differential test (the brief's §40; security-invariants.md
 * test kind D and S): the production engine and an independent, deliberately
 * slow reference model see the same randomized operation sequence in the same
 * order, and must agree on every outcome — accepted, or refused with the same
 * code (and, for delegations, the same violations) — and on every balance of
 * every charge target after every step.
 *
 * On top of agreement, every step checks the ledger's safety invariants on
 * the production state directly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ReservationRecord, TargetBalance } from '../src/index.ts';
import { drive } from './support/drive.ts';

const SEEDS = 40;
const STEPS = 120;

function recordKey(r: ReservationRecord): string {
  return JSON.stringify(r.demands.map((d) => [d.reserved, d.consumed, d.released, d.restored].map(String)).concat([[r.status]]));
}

describe('production ledger agrees with the reference model', () => {
  it(`on every outcome and every balance, over ${SEEDS} seeds × ${STEPS} operations`, async () => {
    const seen = new Map<string, number>();
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      await drive(seed, STEPS, (step, run) => {
        const where = `seed ${seed} step ${step.index} ${step.op.kind}`;
        assert.deepEqual(step.production, step.model, where);
        const tag = `${step.op.kind}:${step.model.code}`;
        seen.set(tag, (seen.get(tag) ?? 0) + 1);

        // Every balance, recomputed by the model from scratch, equals the ledger's.
        for (const [modelKey, prodKey] of run.keys) {
          const b = step.after.state.targets.get(prodKey) as TargetBalance;
          const m = run.model.balance(modelKey);
          assert.deepEqual([b.reserved, b.consumed, b.restored], [m.reserved, m.consumed, m.restored], `${where} target ${modelKey}`);
        }

        // Safety invariants on the ledger itself (LEDGER-1, LEDGER-RESTORE-1, UNIT-5).
        for (const b of step.after.state.targets.values()) {
          assert.ok(b.reserved >= 0n && b.consumed >= 0n && b.restored >= 0n, where);
          assert.ok(b.restored <= b.consumed, `${where}: restored above consumed`);
          if (b.dimension.accounting === 'BUDGET') assert.equal(b.restored, 0n, where);
          assert.ok(b.consumed + b.reserved <= b.dimension.limit.atoms + b.restored, `${where}: capacity exceeded`);
        }

        if (step.production.code !== 'OK') {
          // A refused operation changes nothing: same version, same head, same state.
          assert.equal(step.after.version, step.before.version, where);
          assert.equal(step.after.head, step.before.head, where);
        } else if (step.op.kind === 'RESERVE') {
          // A committed reservation's lineage is complete and was valid: no ancestor omitted, none revoked.
          const rec = [...step.after.state.reservations.values()].find((r) => r.committedAt === step.after.version) as ReservationRecord;
          assert.deepEqual(rec.lineage, run.model.lineage(rec.authority).map((n) => n.id), where);
          for (const id of rec.lineage) assert.equal(step.after.state.nodes.get(id)?.revokedAt, null, where);
        } else if (step.op.kind === 'CONSUME' || step.op.kind === 'CLOSE' || step.op.kind === 'RESTORE') {
          // An effect for one reservation (one generation) leaves every other reservation exactly as it was.
          const target = step.op.reservation;
          for (const r of step.before.state.reservations.values()) {
            if (r.id === target) continue;
            assert.equal(recordKey(step.after.state.reservations.get(r.id) as ReservationRecord), recordKey(r), where);
          }
        }
      });
    }
    // The generator exercised acceptances and refusals of every kind that matters.
    for (const tag of [
      'ROOT:OK',
      'DELEGATE:OK',
      'DELEGATE:DELEGATION_REFUSED',
      'RESERVE:OK',
      'RESERVE:LEDGER_LIMIT_EXCEEDED',
      'RESERVE:AUTHORITY_REVOKED',
      'RESERVE:AUTHORITY_EXPIRED',
      'RESERVE:MODULE_NOT_PERMITTED',
      'RESERVE:UNBOUNDED_CONTRIBUTION',
      'RESERVE:PREVIOUS_GENERATION_OPEN',
      'RESERVE:GENERATION_OUT_OF_SEQUENCE',
      'REVOKE:OK',
      'REVOKE:AUTHORITY_REVOKED',
      'CONSUME:OK',
      'CONSUME:CONSUME_EXCEEDS_RESERVED',
      'CONSUME:RESERVATION_CLOSED',
      'CONSUME:RESERVATION_ID_MISMATCH',
      'CLOSE:OK',
      'RESTORE:OK',
      'RESTORE:RESTORE_EXCEEDS_CONSUMED',
    ]) {
      assert.ok((seen.get(tag) ?? 0) > 0, `never exercised: ${tag}`);
    }
  });
});
