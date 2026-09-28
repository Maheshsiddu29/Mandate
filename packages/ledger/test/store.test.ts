/**
 * The store contract (ADR 0023) and the engine's bounded compare-and-swap
 * loop: consistent immutable reads, compare-and-append on version and head,
 * nothing written by any failed commit, one version per batch, independent
 * principals, and plans recomputed from the new snapshot on every retry.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reservationIdFor, type LedgerHeadDigest, type LedgerVersion } from '@mandate/core';
import { MAX_COMMIT_ATTEMPTS, deriveReserveEvent, encodeLedgerState, type LedgerEvent } from '../src/index.ts';
import {
  AGENT_A,
  ALL_MODULES,
  P2,
  PRINCIPAL,
  PRINCIPAL_2,
  RETRY,
  ONCE,
  P,
  T0,
  capital,
  committed,
  contribution,
  digestOf,
  dim,
  evidence,
  newLedger,
  nodeBalance,
  plan,
  policy,
  refused,
  revocation,
  root,
  setup,
  units,
} from './support/fixtures.ts';

describe('store contract', () => {
  it('reads version 0 at the principal\'s genesis head, and one batch of many events is one version', async () => {
    const { store } = newLedger();
    const s0 = await store.read(PRINCIPAL);
    assert.equal(s0.version, 0n);
    const g1 = root({ nonce: 1n });
    const g2 = root({ nonce: 2n });
    const events: LedgerEvent[] = [{ kind: 'REGISTER_POLICY', at: T0, policy: policy() }, { kind: 'REGISTER_GRANT', at: T0, grant: g1 }, { kind: 'REGISTER_GRANT', at: T0, grant: g2 }];
    const out = await store.compareAndAppend(PRINCIPAL, s0.version, s0.head, events);
    assert.ok(out.status === 'COMMITTED');
    assert.equal(out.snapshot.version, 1n);
    assert.equal(out.snapshot.state.nodes.size, 2);
    const history = await store.history(PRINCIPAL);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.events.length, 3);
    assert.equal(history[0]?.previousHead, s0.head);
    assert.equal(history[0]?.head, out.snapshot.head);
  });

  it('a wrong expected version or head appends nothing, and reports the current position', async () => {
    const { store } = newLedger();
    const s0 = await store.read(PRINCIPAL);
    const ev: LedgerEvent[] = [{ kind: 'REGISTER_POLICY', at: T0, policy: policy() }];
    const ok = await store.compareAndAppend(PRINCIPAL, s0.version, s0.head, ev);
    assert.ok(ok.status === 'COMMITTED');
    const stale = await store.compareAndAppend(PRINCIPAL, s0.version, s0.head, [{ kind: 'REGISTER_GRANT', at: T0, grant: root() }]);
    assert.ok(stale.status === 'CONFLICT' && stale.reason === 'VERSION_CONFLICT' && stale.version === 1n);
    const wrongHead = await store.compareAndAppend(PRINCIPAL, 1n as LedgerVersion, digestOf('forged head') as LedgerHeadDigest, [{ kind: 'REGISTER_GRANT', at: T0, grant: root() }]);
    assert.ok(wrongHead.status === 'CONFLICT' && wrongHead.reason === 'HEAD_MISMATCH');
    const after = await store.read(PRINCIPAL);
    assert.equal(after.version, 1n);
    assert.equal(after.head, ok.snapshot.head);
    assert.equal((await store.history(PRINCIPAL)).length, 1);
    assert.equal(after.state.nodes.size, 0);
  });

  it('a refused batch appends nothing', async () => {
    const { store } = newLedger();
    const s0 = await store.read(PRINCIPAL);
    const out = await store.compareAndAppend(PRINCIPAL, s0.version, s0.head, [{ kind: 'REGISTER_POLICY', at: T0, policy: policy() }, { kind: 'REGISTER_GRANT', at: T0, grant: root({ principal: P2 }) }]);
    assert.ok(out.status === 'REFUSED' && out.refusal.code === 'PRINCIPAL_MISMATCH');
    const s1 = await store.read(PRINCIPAL);
    assert.equal(s1.version, 0n);
    assert.equal(s1.state.policy, null);
    assert.equal((await store.history(PRINCIPAL)).length, 0);
  });

  it('snapshots are immutable: a snapshot read at v is still v after later commits', async () => {
    const { ledger } = newLedger();
    const r = root({ terms: [ALL_MODULES, dim('capital', units(100))] });
    const at1 = await setup(ledger, policy(), [r]);
    const bytes = encodeLedgerState(at1.state);
    committed(await ledger.reserve(plan({ authority: r, contributions: [contribution(capital(units(60)))] }), T0, ONCE));
    assert.deepEqual(encodeLedgerState(at1.state), bytes);
    assert.equal(nodeBalance(at1.state, r, 'capital').reserved, 0n);
    assert.equal(nodeBalance((await ledger.read(PRINCIPAL)).state, r, 'capital').reserved, units(60));
  });

  it('keeps principals independent: separate versions, heads and state, with no shared counter', async () => {
    const { ledger, store } = newLedger();
    const a = root({ terms: [ALL_MODULES, dim('capital', units(100))] });
    const b = root({ principal: P2, terms: [ALL_MODULES, dim('capital', units(100))] });
    committed(await ledger.registerPolicy(policy(), T0, ONCE));
    committed(await ledger.registerPolicy(policy([], 1n, P2), T0, ONCE));
    committed(await ledger.registerGrant(a, T0, ONCE));
    committed(await ledger.registerGrant(b, T0, ONCE));
    const b0 = await store.read(PRINCIPAL_2);
    // A stale-looking commit for A (version 2) is not affected by B also being at version 2.
    for (let i = 0; i < 5; i += 1) committed(await ledger.reserve(plan({ authority: a, action: `a${i}`, contributions: [contribution(capital(units(1)))] }), T0, ONCE));
    const b1 = await store.read(PRINCIPAL_2);
    assert.equal(b1.version, b0.version);
    assert.equal(b1.head, b0.head);
    assert.deepEqual(encodeLedgerState(b1.state), encodeLedgerState(b0.state));
    assert.equal((await store.read(PRINCIPAL)).version, 7n);
    // Committing for B at B's own version succeeds regardless of A's.
    committed(await ledger.reserve(plan({ authority: b, action: 'b', contributions: [contribution(capital(units(1)))] }), T0, ONCE));
  });
});

describe('engine: decide against one snapshot, commit at its version', () => {
  it('requires an explicit bounded retry policy', async () => {
    const { ledger } = newLedger();
    for (const maxAttempts of [0, -1, 1.5, MAX_COMMIT_ATTEMPTS + 1, Number.NaN]) {
      assert.equal(refused(await ledger.registerPolicy(policy(), T0, { maxAttempts })).code, 'RETRY_POLICY_INVALID');
    }
    committed(await ledger.registerPolicy(policy(), T0, { maxAttempts: MAX_COMMIT_ATTEMPTS }));
  });

  it('recomputes the plan from the new snapshot after a conflict, never reusing the old availability', async () => {
    const r = root({ terms: [ALL_MODULES, dim('capital', units(100))] });
    let injected = false;
    const { ledger, store } = newLedger({
      delay: async (point) => {
        // Just before the first reservation's commit, a competitor takes 70 of the 100.
        if (point === 'COMMIT' && !injected && armed) {
          injected = true;
          const s = await store.read(PRINCIPAL);
          const competitor = plan({ authority: r, action: 'competitor', contributions: [contribution(capital(units(70)))] });
          const e = deriveReserveEvent(s.state, competitor, T0);
          assert.ok(e.ok);
          assert.equal((await store.compareAndAppend(PRINCIPAL, s.version, s.head, [e.value])).status, 'COMMITTED');
        }
      },
    });
    let armed = false;
    await setup(ledger, policy(), [r]);
    armed = true;
    // 40 fitted at the version it was planned against, and does not fit at the next one.
    const out = await ledger.reserve(plan({ authority: r, action: 'mine', contributions: [contribution(capital(units(40)))] }), T0, RETRY);
    assert.equal(out.status, 'REFUSED');
    assert.equal(out.status === 'REFUSED' && out.attempts, 2);
    assert.equal(out.status === 'REFUSED' && out.refusal.code, 'LEDGER_LIMIT_EXCEEDED');
    assert.equal(store.counters.conflicts, 1);
    assert.equal(nodeBalance((await ledger.read(PRINCIPAL)).state, r, 'capital').reserved, units(70));
  });

  it('gives up after maxAttempts conflicts, having written nothing of its own', async () => {
    const r = root({ terms: [ALL_MODULES, dim('capital', units(1_000))] });
    let armed = false;
    let n = 0;
    const { ledger, store } = newLedger({
      delay: async (point) => {
        if (point !== 'COMMIT' || !armed) return;
        armed = false; // the competitor's own commit must not recurse
        const s = await store.read(PRINCIPAL);
        const e = deriveReserveEvent(s.state, plan({ authority: r, action: `c${n++}`, contributions: [contribution(capital(units(1)))] }), T0);
        assert.ok(e.ok);
        await store.compareAndAppend(PRINCIPAL, s.version, s.head, [e.value]);
        armed = true;
      },
    });
    await setup(ledger, policy(), [r]);
    armed = true;
    const out = await ledger.reserve(plan({ authority: r, action: 'loser', contributions: [contribution(capital(units(1)))] }), T0, { maxAttempts: 3 });
    armed = false;
    assert.deepEqual(out, { status: 'CONFLICT', attempts: 3 });
    const s = await ledger.read(PRINCIPAL);
    const loser = plan({ authority: r, action: 'loser', contributions: [contribution(capital(units(1)))] });
    assert.equal(s.state.reservations.has(reservationIdFor(loser.action, loser.generation)), false);
  });

  it('settles several accounting effects as one atomic batch, deriving the release from the draft', async () => {
    const r = root({ terms: [ALL_MODULES, dim('capital', units(100))] });
    const { ledger } = newLedger();
    await setup(ledger, policy(), [r]);
    const p = plan({ authority: r, contributions: [contribution(capital(units(50)))] });
    committed(await ledger.reserve(p, T0, ONCE));
    const id = reservationIdFor(p.action, p.generation);
    const s = committed(
      await ledger.settle(PRINCIPAL, [
        { kind: 'CONSUME', reservation: id, generation: p.generation, evidence: evidence('fill-1'), amounts: [units(20)] },
        { kind: 'CONSUME', reservation: id, generation: p.generation, evidence: evidence('fill-2'), amounts: [units(10)] },
        { kind: 'CLOSE', reservation: id, generation: p.generation, evidence: evidence('final') },
      ], T0, ONCE),
    );
    const b = nodeBalance(s.state, r, 'capital');
    assert.deepEqual([b.reserved, b.consumed], [0n, units(30)]);
    assert.equal(s.state.reservations.get(id)?.demands[0]?.released, units(20));
    // One invalid effect anywhere refuses the whole batch.
    const p2 = plan({ authority: r, action: 'second', contributions: [contribution(capital(units(10)))] });
    committed(await ledger.reserve(p2, T0, ONCE));
    const id2 = reservationIdFor(p2.action, p2.generation);
    const before = await ledger.read(PRINCIPAL);
    const bad = refused(
      await ledger.settle(PRINCIPAL, [
        { kind: 'CONSUME', reservation: id2, generation: p2.generation, evidence: evidence('ok'), amounts: [units(5)] },
        { kind: 'RESTORE', reservation: id2, generation: p2.generation, evidence: evidence('too much'), amounts: [units(6)] },
      ], T0, ONCE),
    );
    assert.equal(bad.code, 'RESTORE_EXCEEDS_CONSUMED');
    assert.equal(bad.path, 'effects[1].amounts[0]');
    assert.equal((await ledger.read(PRINCIPAL)).version, before.version);
  });

  it('registers several grants atomically, or none', async () => {
    const { ledger } = newLedger();
    committed(await ledger.registerPolicy(policy(), T0, ONCE));
    const first = root({ nonce: 5n });
    const second = root({ holder: AGENT_A, nonce: 6n });
    const out = refused(
      await ledger.registerAll(PRINCIPAL, [
        { kind: 'REGISTER_GRANT', at: T0, grant: first },
        { kind: 'REGISTER_GRANT', at: T0, grant: second },
        { kind: 'REVOKE', at: T0, revocation: revocation(first, P, T0 + 5n) }, // scheduled into the future: refused
      ], ONCE),
    );
    assert.equal(out.code, 'REVOCATION_NOT_EFFECTIVE');
    assert.equal(out.path, 'events[2].revocation.effectiveAt');
    const s = await ledger.read(PRINCIPAL);
    assert.equal(s.state.nodes.size, 0);
    assert.equal(s.version, 1n);
  });
});
