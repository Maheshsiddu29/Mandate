/**
 * Failure injection (LEDGER-4): a failure at any point of a commit leaves
 * the entire old state or — for a commit that completed — the entire new
 * one, never a partially charged path.
 *
 * The reference store is in memory: these tests inject thrown failures at
 * each point of its critical section and around it. They do not, and cannot,
 * model a machine crash or a lost fsync; durable atomicity is the production
 * store's responsibility (ADR 0023).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reservationIdFor } from '@mandate/core';
import { AuthorityLedger, InMemoryLedgerStore, encodeLedgerState, type FaultPoint, type LedgerOutcome } from '../src/index.ts';
import {
  AGENT_A,
  AGENT_B,
  ALL_MODULES,
  DELEGATE,
  ONCE,
  PRINCIPAL,
  REGISTRY,
  RETRY,
  T0,
  capital,
  child,
  committed,
  contribution,
  dim,
  evidence,
  int,
  jitterHooks,
  nodeBalance,
  plan,
  policy,
  policyBalance,
  prng,
  refused,
  root,
  setup,
  units,
} from './support/fixtures.ts';

const POINTS: readonly FaultPoint[] = ['BEFORE_CAS', 'AFTER_VERSION_CHECK', 'AFTER_VALIDATION', 'BEFORE_PUBLISH'];
const global = dim('global-capital', units(1_000));
const r = root({ terms: [ALL_MODULES, DELEGATE(1), dim('capital', units(500))] });
const a = child(r, { holder: AGENT_A, terms: [ALL_MODULES, dim('capital', units(300))] });
const b = child(r, { holder: AGENT_B, nonce: 1n, terms: [ALL_MODULES, dim('capital', units(300))] });

function faulty(point: FaultPoint | null) {
  let armed = false;
  const store = new InMemoryLedgerStore({
    fault: (p) => {
      if (armed && p === point) throw new Error(`injected failure at ${p}`);
    },
  });
  return { store, ledger: new AuthorityLedger(store, REGISTRY), arm: (on: boolean) => (armed = on) };
}

async function snapshotBytes(store: InMemoryLedgerStore): Promise<[bigint, string, Uint8Array, number]> {
  const s = await store.read(PRINCIPAL);
  return [s.version, s.head, encodeLedgerState(s.state), (await store.history(PRINCIPAL)).length];
}

describe('a failure inside a commit leaves the entire old state', () => {
  for (const point of POINTS) {
    it(`at ${point}: a multi-leg reservation, a multi-event settlement and a batch of registrations`, async () => {
      const { store, ledger, arm } = faulty(point);
      await setup(ledger, policy([global]), [r, a]);
      const operations: [string, () => Promise<LedgerOutcome>][] = [
        ['reserve', () => ledger.reserve(plan({ authority: a, contributions: [contribution(capital(units(100)))] }), T0, ONCE)],
        ['register', () => ledger.registerAll(PRINCIPAL, [{ kind: 'REGISTER_GRANT', at: T0, grant: b }, { kind: 'REGISTER_GRANT', at: T0, grant: root({ nonce: 9n }) }], ONCE)],
      ];
      for (const [name, run] of operations) {
        const before = await snapshotBytes(store);
        arm(true);
        await assert.rejects(run(), /injected failure/, `${name} at ${point}`);
        arm(false);
        assert.deepEqual(await snapshotBytes(store), before, `${name} at ${point}: partial state`);
        // The same operation, without the failure, commits in full.
        committed(await run());
      }
      // A settlement of several effects: all of them, or none.
      const p = plan({ authority: a, contributions: [contribution(capital(units(100)))] });
      const id = reservationIdFor(p.action, p.generation);
      const settle = () =>
        ledger.settle(PRINCIPAL, [
          { kind: 'CONSUME', reservation: id, generation: p.generation, evidence: evidence('f1'), amounts: [units(40)] },
          { kind: 'CLOSE', reservation: id, generation: p.generation, evidence: evidence('final') },
        ], T0, ONCE);
      const before = await snapshotBytes(store);
      arm(true);
      await assert.rejects(settle(), /injected failure/);
      arm(false);
      assert.deepEqual(await snapshotBytes(store), before);
      const s = committed(await settle());
      assert.deepEqual([nodeBalance(s.state, a, 'capital').reserved, nodeBalance(s.state, a, 'capital').consumed], [0n, units(40)]);
      assert.deepEqual([nodeBalance(s.state, r, 'capital').reserved, nodeBalance(s.state, r, 'capital').consumed], [0n, units(40)]);
      assert.deepEqual([policyBalance(s.state, global).reserved, policyBalance(s.state, global).consumed], [0n, units(40)]);
    });
  }
});

describe('a failure while building a batch writes nothing', () => {
  it('a plan refused while being built, or a later event of a batch refused, commits no earlier part', async () => {
    const { store, ledger } = faulty(null);
    await setup(ledger, policy([global]), [r, a]);
    const before = await snapshotBytes(store);
    // Refused during planning: nothing reaches the store.
    const reads = store.counters.reads;
    assert.equal(refused(await ledger.reserve(plan({ authority: a, contributions: [contribution(capital(units(301)))] }), T0, ONCE)).code, 'LEDGER_LIMIT_EXCEEDED');
    assert.equal(store.counters.reads, reads + 1);
    assert.equal(store.counters.commits, 3);
    // A batch whose third event is invalid: the first two are not applied either.
    const out = refused(await ledger.registerAll(PRINCIPAL, [
      { kind: 'REGISTER_GRANT', at: T0, grant: b },
      { kind: 'REGISTER_GRANT', at: T0, grant: root({ nonce: 7n }) },
      { kind: 'REGISTER_GRANT', at: T0, grant: b },
    ], ONCE));
    assert.equal(out.code, 'AUTHORITY_ALREADY_REGISTERED');
    assert.deepEqual(await snapshotBytes(store), before);
  });
});

describe('an outcome lost after a successful commit', () => {
  it('is recovered by retrying the same plan: the content-derived ReservationId makes the retry a refusal, not a second charge', async () => {
    const { store, ledger } = faulty(null);
    await setup(ledger, policy([global]), [r, a]);
    const p = plan({ authority: a, contributions: [contribution(capital(units(100)))] });
    await ledger.reserve(p, T0, ONCE); // the caller never sees this outcome
    const retry = refused(await ledger.reserve(p, T0, ONCE));
    assert.equal(retry.code, 'RESERVATION_EXISTS');
    const s = (await store.read(PRINCIPAL)).state;
    assert.equal(nodeBalance(s, r, 'capital').reserved, units(100));
    assert.ok(s.reservations.has(reservationIdFor(p.action, p.generation)));
  });
});

describe('failures injected into racing agents never leave a partial or oversubscribed path', () => {
  it('random faults during concurrent reservations: every committed reservation is whole, every failed one absent', async () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const rand = prng(80_000 + seed);
      const jitter = jitterHooks(rand);
      let faultsOn = false;
      const store = new InMemoryLedgerStore({
        ...jitter,
        fault: () => {
          if (faultsOn && rand() < 0.15) throw new Error('injected');
        },
      });
      const ledger = new AuthorityLedger(store, REGISTRY);
      await setup(ledger, policy([global]), [r, a, b]);
      faultsOn = true;
      const demands = [0, 1, 2, 3, 4, 5].map(() => units(int(rand, 20, 200)));
      const results = await Promise.allSettled(demands.map((d, i) => ledger.reserve(plan({ authority: i % 2 === 0 ? a : b, action: `r${i}`, contributions: [contribution(capital(d))] }), T0, RETRY)));
      faultsOn = false;
      const s = (await store.read(PRINCIPAL)).state;
      let total = 0n;
      results.forEach((res, i) => {
        const p = plan({ authority: i % 2 === 0 ? a : b, action: `r${i}`, contributions: [contribution(capital(demands[i] as bigint))] });
        const rec = s.reservations.get(reservationIdFor(p.action, p.generation));
        if (res.status === 'fulfilled' && res.value.status === 'COMMITTED') {
          assert.ok(rec !== undefined && rec.demands[0]?.legs.length === 3, `seed ${seed}: committed reservation missing or partial`);
          total += demands[i] as bigint;
        } else {
          assert.equal(rec, undefined, `seed ${seed}: a failed reservation left a record`);
        }
      });
      // Every leg of the path moved by exactly the committed total — root, children and policy alike.
      assert.equal(nodeBalance(s, r, 'capital').reserved, total, `seed ${seed}`);
      assert.equal(policyBalance(s, global).reserved, total, `seed ${seed}`);
      assert.equal(nodeBalance(s, a, 'capital').reserved + nodeBalance(s, b, 'capital').reserved, total, `seed ${seed}`);
      assert.ok(total <= units(500), `seed ${seed}`);
    }
  });
});
