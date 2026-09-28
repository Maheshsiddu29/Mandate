/**
 * CONC-1 under concurrency: agents racing through the engine against one
 * store, with seeded random delays between every read and commit so the
 * event loop interleaves them differently on every seed.
 *
 * Every property here is a safety property — no oversubscription, no
 * authorization after a committed revocation — asserted on every seed. Each
 * scenario also asserts that the race was real: both orders won on some
 * seeds, and compare-and-swap conflicts actually happened. Finally, the same
 * races run against a deliberately broken read-then-write store, which does
 * oversubscribe: the tests would catch a store without compare-and-swap.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authorityId, reservationIdFor, type AuthorityGrant, type LedgerHeadDigest, type LedgerVersion, type PrincipalId } from '@mandate/core';
import {
  AuthorityLedger,
  InMemoryLedgerStore,
  applyBatch,
  emptyLedgerState,
  principalKey,
  type ChargePlan,
  type CommitResult,
  type CommittedBatch,
  type LedgerEvent,
  type LedgerOutcome,
  type LedgerSnapshot,
  type LedgerState,
  type LedgerStore,
} from '../src/index.ts';
import {
  AGENT_A,
  AGENT_B,
  AGENT_C,
  ALL_MODULES,
  BTC,
  DELEGATE,
  P2,
  PERP_AGENT,
  PERP_V1,
  PRINCIPAL,
  PRINCIPAL_2,
  REGISTRY,
  RETRY,
  SPOT_AGENT,
  SPOT_V1,
  T0,
  USDG_PERP,
  address,
  capital,
  child,
  committed,
  contribution,
  digestOf,
  dim,
  int,
  jitterHooks,
  modules,
  nodeBalance,
  notional,
  plan,
  policy,
  policyBalance,
  prng,
  refused,
  revocation,
  root,
  setup,
  ticks,
  units,
} from './support/fixtures.ts';

const SEEDS = 150;

async function race(store: LedgerStore, bootstrap: (l: AuthorityLedger) => Promise<void>, tasks: ((l: AuthorityLedger) => Promise<LedgerOutcome>)[]): Promise<LedgerOutcome[]> {
  const ledger = new AuthorityLedger(store, REGISTRY);
  await bootstrap(ledger);
  return Promise.all(tasks.map((t) => t(ledger)));
}

/** Σ of every committed RESERVE leg at a target, read from the log: what was actually authorized there. */
async function authorizedAt(store: LedgerStore, principal: PrincipalId, authority: string, dimensionId: string): Promise<bigint> {
  let sum = 0n;
  for (const b of await store.history(principal)) {
    for (const e of b.events) {
      if (e.kind !== 'RESERVE') continue;
      for (const legs of e.legs) for (const l of legs) if (l.target.dimensionId === dimensionId && (l.target.kind === 'POLICY' ? authority === 'POLICY' : l.target.authority === authority)) sum += l.amount;
    }
  }
  return sum;
}

// --- Scenario builders ---------------------------------------------------------------

function siblings() {
  const parent = root({ holder: TRADING_HOLDER, terms: [ALL_MODULES, DELEGATE(1), dim('capital', units(100))] });
  const a = child(parent, { holder: AGENT_A, terms: [ALL_MODULES, dim('capital', units(80))] });
  const b = child(parent, { holder: AGENT_B, nonce: 1n, terms: [ALL_MODULES, dim('capital', units(80))] });
  return { parent, a, b, grants: [parent, a, b] };
}
const TRADING_HOLDER = address('21');

function twoRoots() {
  const global = dim('global-capital', units(100));
  const a = root({ holder: AGENT_A, terms: [ALL_MODULES, dim('capital', units(80))] });
  const b = root({ holder: AGENT_B, nonce: 1n, terms: [ALL_MODULES, dim('capital', units(80))] });
  return { global, a, b, policy: policy([global]) };
}

const spend = (g: AuthorityGrant, label: string, atoms: bigint, module = PERP_V1): ChargePlan =>
  plan({ authority: g, action: label, module, contributions: [contribution(capital(atoms, module === SPOT_V1 ? undefined : USDG_PERP))] });

// --- The races ------------------------------------------------------------------------

describe('sibling agents cannot oversubscribe their parent', () => {
  it('parent 100, children 80 and 80, each reserving 70: exactly one wins, on every interleaving', async () => {
    const winners = new Set<string>();
    let conflicts = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const store = new InMemoryLedgerStore(jitterHooks(prng(seed)));
      const { parent, a, b, grants } = siblings();
      const [oa, ob] = await race(store, async (l) => void (await setup(l, policy(), grants)), [
        (l) => l.reserve(spend(a, 'a', units(70)), T0, RETRY),
        (l) => l.reserve(spend(b, 'b', units(70)), T0, RETRY),
      ]);
      const statuses = [oa?.status, ob?.status].sort();
      assert.deepEqual(statuses, ['COMMITTED', 'REFUSED'], `seed ${seed}`);
      const loser = (oa?.status === 'REFUSED' ? oa : ob) as Extract<LedgerOutcome, { status: 'REFUSED' }>;
      assert.equal(loser.refusal.code, 'LEDGER_LIMIT_EXCEEDED');
      // The binding leg is the parent's, not the loser's own ceiling.
      assert.ok(loser.refusal.code === 'LEDGER_LIMIT_EXCEEDED' && loser.refusal.failures.every((f) => f.target.kind === 'NODE' && f.target.authority === authorityId(parent)));
      const s = await store.read(PRINCIPAL);
      assert.equal(nodeBalance(s.state, parent, 'capital').reserved, units(70));
      assert.equal(await authorizedAt(store, PRINCIPAL, authorityId(parent), 'capital'), units(70), `seed ${seed}: never 140 at the parent`);
      winners.add(oa?.status === 'COMMITTED' ? 'A' : 'B');
      conflicts += store.counters.conflicts;
    }
    assert.deepEqual([...winners].sort(), ['A', 'B'], 'both linearizations occurred');
    assert.ok(conflicts > 0, 'the race produced compare-and-swap conflicts');
  });

  it('many siblings with random demands never exceed any charged capacity', async () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const rand = prng(10_000 + seed);
      const store = new InMemoryLedgerStore(jitterHooks(rand, 4));
      const parent = root({ holder: TRADING_HOLDER, terms: [ALL_MODULES, DELEGATE(1), dim('capital', units(100))] });
      const limits = [0, 1, 2, 3, 4, 5].map(() => units(int(rand, 20, 90)));
      const kids = limits.map((limit, i) => child(parent, { holder: address((0x70 + i).toString(16)), nonce: BigInt(i), terms: [ALL_MODULES, dim('capital', limit)] }));
      const demands = kids.map(() => units(int(rand, 5, 60)));
      const outcomes = await race(store, async (l) => void (await setup(l, policy(), [parent, ...kids])), kids.map((k, i) => (l: AuthorityLedger) => l.reserve(spend(k, `k${i}`, demands[i] as bigint), T0, RETRY)));
      const s = (await store.read(PRINCIPAL)).state;
      let committedTotal = 0n;
      outcomes.forEach((o, i) => {
        if (o.status === 'COMMITTED') committedTotal += demands[i] as bigint;
        else assert.ok(o.status === 'REFUSED' || o.status === 'CONFLICT', `seed ${seed}`);
      });
      assert.ok(committedTotal <= units(100), `seed ${seed}: ${committedTotal} authorized under a parent of 100`);
      assert.equal(nodeBalance(s, parent, 'capital').reserved, committedTotal);
      kids.forEach((k, i) => assert.ok(nodeBalance(s, k, 'capital').reserved <= (limits[i] as bigint)));
    }
  });
});

describe('two roots cannot bypass a principal-global limit', () => {
  it('global 100, roots 80 and 80, each reserving 60: exactly one wins, and the policy is the binding leg', async () => {
    const winners = new Set<string>();
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const store = new InMemoryLedgerStore(jitterHooks(prng(20_000 + seed)));
      const { global, a, b, policy: p } = twoRoots();
      const [oa, ob] = await race(store, async (l) => void (await setup(l, p, [a, b])), [
        (l) => l.reserve(spend(a, 'a', units(60)), T0, RETRY),
        (l) => l.reserve(spend(b, 'b', units(60)), T0, RETRY),
      ]);
      assert.deepEqual([oa?.status, ob?.status].sort(), ['COMMITTED', 'REFUSED'], `seed ${seed}`);
      const loser = (oa?.status === 'REFUSED' ? oa : ob) as Extract<LedgerOutcome, { status: 'REFUSED' }>;
      assert.ok(loser.refusal.code === 'LEDGER_LIMIT_EXCEEDED' && loser.refusal.failures.length === 1 && loser.refusal.failures[0]?.target.kind === 'POLICY');
      assert.equal(policyBalance((await store.read(PRINCIPAL)).state, global).reserved, units(60));
      assert.equal(await authorizedAt(store, PRINCIPAL, 'POLICY', 'global-capital'), units(60));
      winners.add(oa?.status === 'COMMITTED' ? 'A' : 'B');
    }
    assert.deepEqual([...winners].sort(), ['A', 'B']);
  });
});

describe('two domains share one principal-global budget', () => {
  it('spot and perp agents under different modules and roots race for one global dimension: never an independent budget each', async () => {
    let maxWinners = 0;
    for (let seed = 1; seed <= 80; seed += 1) {
      const rand = prng(30_000 + seed);
      const store = new InMemoryLedgerStore(jitterHooks(rand));
      const global = dim('global-capital', units(100));
      const spotRoot = root({ holder: SPOT_AGENT, terms: [modules(SPOT_V1), dim('capital', units(100))] });
      const perpRoot = root({ holder: PERP_AGENT, nonce: 1n, terms: [modules(PERP_V1), dim('capital', units(100))] });
      const tasks: ((l: AuthorityLedger) => Promise<LedgerOutcome>)[] = [];
      for (let i = 0; i < 3; i += 1) tasks.push((l) => l.reserve(spend(spotRoot, `spot-${i}`, units(30), SPOT_V1), T0, RETRY));
      for (let i = 0; i < 3; i += 1) tasks.push((l) => l.reserve(spend(perpRoot, `perp-${i}`, units(30), PERP_V1), T0, RETRY));
      const outcomes = await race(store, async (l) => void (await setup(l, policy([global]), [spotRoot, perpRoot])), tasks);
      const winners = outcomes.filter((o) => o.status === 'COMMITTED').length;
      // Each domain alone could reserve 90 under its own root; together they get 90 of the one global 100.
      assert.ok(winners <= 3, `seed ${seed}: ${winners} × 30 authorized against a global 100`);
      assert.equal(policyBalance((await store.read(PRINCIPAL)).state, global).reserved, units(30) * BigInt(winners));
      if (winners > maxWinners) maxWinners = winners;
    }
    assert.equal(maxWinners, 3);
  });
});

describe('a multi-dimension request recomputes every dimension after a conflict', () => {
  const r = root({
    terms: [ALL_MODULES, dim('capital', units(100)), dim('btc-notional', units(100), { kind: 'NOTIONAL', unit: 'USD', scope: { asset: BTC } })],
  });
  const both = plan({ authority: r, action: 'mine', contributions: [contribution(capital(units(40))), contribution(notional(units(70), digestOf('action:mine')))] });
  const notionalOnly = (atoms: bigint) => plan({ authority: r, action: 'competitor', contributions: [contribution(notional(atoms, digestOf('action:competitor')))] });

  async function withCompetitor(competitorNotional: bigint) {
    let armed = false;
    const store: InMemoryLedgerStore = new InMemoryLedgerStore({
      delay: async (point) => {
        if (point !== 'COMMIT' || !armed) return;
        armed = false;
        // Between this request's read and its CAS, a competitor changes one of its two dimensions.
        const competitor = new AuthorityLedger(store, REGISTRY);
        committed(await competitor.reserve(notionalOnly(competitorNotional), T0, { maxAttempts: 1 }));
      },
    });
    const ledger = new AuthorityLedger(store, REGISTRY);
    await setup(ledger, policy(), [r]);
    armed = true;
    const out = await ledger.reserve(both, T0, RETRY);
    return { out, store };
  }

  it('refuses on the retry when the changed dimension no longer fits — the other dimension\'s old result is not reused', async () => {
    const { out, store } = await withCompetitor(units(50));
    assert.equal(out.status, 'REFUSED');
    assert.ok(out.status === 'REFUSED' && out.attempts === 2 && out.refusal.code === 'LEDGER_LIMIT_EXCEEDED');
    assert.ok(out.status === 'REFUSED' && out.refusal.code === 'LEDGER_LIMIT_EXCEEDED' && out.refusal.failures.map((f) => f.target.dimensionId).join() === 'btc-notional');
    const s = (await store.read(PRINCIPAL)).state;
    // Capital, which still had room, was not charged either.
    assert.equal(nodeBalance(s, r, 'capital').reserved, 0n);
    assert.equal(nodeBalance(s, r, 'btc-notional').reserved, units(50));
  });

  it('commits on the retry at the new version, with both dimensions recomputed against it', async () => {
    const { out, store } = await withCompetitor(units(20));
    const snap = committed(out);
    assert.ok(out.status === 'COMMITTED' && out.attempts === 2);
    const rec = snap.state.reservations.get(reservationIdFor(both.action, both.generation));
    assert.ok(rec !== undefined);
    assert.equal(rec.committedAt, snap.version);
    assert.equal(nodeBalance(snap.state, r, 'capital').reserved, units(40));
    assert.equal(nodeBalance(snap.state, r, 'btc-notional').reserved, units(90));
    assert.equal(store.counters.conflicts, 1);
  });
});

describe('independent principals share no linearization domain', () => {
  it('interleaved commits for two principals never conflict with each other and never change each other\'s state', async () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const store = new InMemoryLedgerStore(jitterHooks(prng(40_000 + seed), 4));
      const ledger = new AuthorityLedger(store, REGISTRY);
      const a = root({ terms: [ALL_MODULES, dim('capital', units(1_000))] });
      const b = root({ principal: P2, terms: [ALL_MODULES, dim('capital', units(1_000))] });
      committed(await ledger.registerPolicy(policy(), T0, RETRY));
      committed(await ledger.registerPolicy(policy([], 1n, P2), T0, RETRY));
      committed(await ledger.registerGrant(a, T0, RETRY));
      committed(await ledger.registerGrant(b, T0, RETRY));
      const before = store.counters.conflicts;
      // One writer per principal: any conflict could only come from the other principal.
      const run = async (g: AuthorityGrant, tag: string) => {
        for (let i = 0; i < 6; i += 1) committed(await ledger.reserve(plan({ authority: g, action: `${tag}${i}`, contributions: [contribution(capital(units(10)))] }), T0, { maxAttempts: 1 }));
      };
      await Promise.all([run(a, 'a'), run(b, 'b')]);
      assert.equal(store.counters.conflicts, before, `seed ${seed}`);
      const sa = await store.read(PRINCIPAL);
      const sb = await store.read(PRINCIPAL_2);
      assert.equal(sa.version, 8n);
      assert.equal(sb.version, 8n);
      assert.notEqual(sa.head, sb.head);
      assert.equal(nodeBalance(sa.state, a, 'capital').reserved, units(60));
      assert.equal(nodeBalance(sb.state, b, 'capital').reserved, units(60));
    }
  });
});

describe('revocation races have deterministic safe outcomes', () => {
  const tree = () => {
    const r0 = root({ terms: [ALL_MODULES, DELEGATE(1), dim('capital', units(100))] });
    const agent = child(r0, { holder: AGENT_C, terms: [ALL_MODULES, dim('capital', units(100))] });
    return { r0, agent };
  };

  it('case A: the reservation commits first; the later revocation keeps it held and refuses new ones', async () => {
    const { r0, agent } = tree();
    const store = new InMemoryLedgerStore();
    const ledger = new AuthorityLedger(store, REGISTRY);
    await setup(ledger, policy(), [r0, agent]);
    const first = spend(agent, 'first', units(30));
    committed(await ledger.reserve(first, T0, RETRY));
    const revoked = committed(await ledger.revoke(PRINCIPAL, revocation(agent), T0, RETRY));
    const rec = revoked.state.reservations.get(reservationIdFor(first.action, first.generation));
    assert.equal(rec?.status, 'ACTIVE');
    assert.ok((rec?.committedAt as bigint) < (revoked.state.nodes.get(authorityId(agent))?.revokedAt as bigint));
    assert.equal(nodeBalance(revoked.state, agent, 'capital').reserved, units(30));
    assert.equal(nodeBalance(revoked.state, r0, 'capital').reserved, units(30));
    assert.equal(refused(await ledger.reserve(spend(agent, 'second', units(1)), T0, RETRY)).code, 'AUTHORITY_REVOKED');
    // The held reservation still reconciles normally after revocation.
    const id = reservationIdFor(first.action, first.generation);
    const settled = committed(await ledger.settle(PRINCIPAL, [{ kind: 'CONSUME', reservation: id, generation: first.generation, evidence: digestOf('fill') as never, amounts: [units(30)] }], T0, RETRY));
    assert.equal(nodeBalance(settled.state, agent, 'capital').consumed, units(30));
  });

  it('case B: the revocation commits inside the reservation\'s window; the retry recomputes and is refused', async () => {
    const { r0, agent } = tree();
    let armed = false;
    const store: InMemoryLedgerStore = new InMemoryLedgerStore({
      delay: async (point) => {
        if (point !== 'COMMIT' || !armed) return;
        armed = false;
        committed(await new AuthorityLedger(store, REGISTRY).revoke(PRINCIPAL, revocation(agent), T0, { maxAttempts: 1 }));
      },
    });
    const ledger = new AuthorityLedger(store, REGISTRY);
    await setup(ledger, policy(), [r0, agent]);
    armed = true;
    const out = refused(await ledger.reserve(spend(agent, 'racing', units(30)), T0, RETRY));
    assert.equal(out.code, 'AUTHORITY_REVOKED');
    assert.equal(store.counters.conflicts, 1);
    const s = (await store.read(PRINCIPAL)).state;
    assert.equal(s.reservations.size, 0);
    assert.equal(nodeBalance(s, r0, 'capital').reserved, 0n);
  });

  it('randomized: a reservation is never committed at or after the version that revoked its lineage', async () => {
    const outcomes = new Set<string>();
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const { r0, agent } = tree();
      const store = new InMemoryLedgerStore(jitterHooks(prng(50_000 + seed)));
      const [res, rev] = await race(store, async (l) => void (await setup(l, policy(), [r0, agent])), [
        (l) => l.reserve(spend(agent, 'x', units(30)), T0, RETRY),
        (l) => l.revoke(PRINCIPAL, revocation(agent), T0, RETRY),
      ]);
      const snap = committed(rev as LedgerOutcome);
      const revokedAt = snap.state.nodes.get(authorityId(agent))?.revokedAt as LedgerVersion;
      const s = (await store.read(PRINCIPAL)).state;
      if (res?.status === 'COMMITTED') {
        const p = spend(agent, 'x', units(30));
        const rec = s.reservations.get(reservationIdFor(p.action, p.generation));
        assert.ok(rec !== undefined && rec.committedAt < revokedAt && rec.status === 'ACTIVE', `seed ${seed}`);
        outcomes.add('reserved-then-revoked');
      } else {
        assert.equal(res?.status === 'REFUSED' && res.refusal.code, 'AUTHORITY_REVOKED', `seed ${seed}`);
        assert.equal(s.reservations.size, 0);
        outcomes.add('revoked-then-refused');
      }
    }
    assert.deepEqual([...outcomes].sort(), ['reserved-then-revoked', 'revoked-then-refused']);
  });
});

// --- Mutation: a store without compare-and-swap ----------------------------------------------

/**
 * A read-then-write store: it applies each batch against the state the caller
 * read — so each batch is individually valid — and publishes it on top of
 * whatever is current, ignoring the expected version. This is the store the
 * specification says is not conforming (CONC-1's mutation).
 */
class ReadThenWriteStore implements LedgerStore {
  readonly #byVersion = new Map<string, LedgerState[]>();
  readonly #batches = new Map<string, CommittedBatch[]>();
  readonly #rand: () => number;

  constructor(rand: () => number) {
    this.#rand = rand;
  }

  #states(p: PrincipalId): LedgerState[] {
    const k = principalKey(p);
    let s = this.#byVersion.get(k);
    if (s === undefined) {
      s = [emptyLedgerState(p)];
      this.#byVersion.set(k, s);
      this.#batches.set(k, []);
    }
    return s;
  }

  async read(p: PrincipalId): Promise<LedgerSnapshot> {
    const states = this.#states(p);
    const state = states[states.length - 1] as LedgerState;
    await ticks(int(this.#rand, 0, 3));
    return { principal: p, version: state.version, head: state.head, state };
  }

  async compareAndAppend(p: PrincipalId, expectedVersion: LedgerVersion, _head: LedgerHeadDigest, events: readonly LedgerEvent[]): Promise<CommitResult> {
    await ticks(int(this.#rand, 0, 3));
    const states = this.#states(p);
    const base = states[Number(expectedVersion)] as LedgerState;
    const applied = applyBatch(base, events);
    if (!applied.ok) return { status: 'REFUSED', refusal: applied.error };
    const current = states[states.length - 1] as LedgerState;
    const next = { ...applied.value.state, version: (current.version + 1n) as LedgerVersion };
    states.push(next);
    (this.#batches.get(principalKey(p)) as CommittedBatch[]).push({ version: next.version, previousHead: current.head, head: next.head, events: [...events], encoded: applied.value.encoded });
    return { status: 'COMMITTED', snapshot: { principal: p, version: next.version, head: next.head, state: next } };
  }

  async history(p: PrincipalId): Promise<readonly CommittedBatch[]> {
    this.#states(p);
    return [...(this.#batches.get(principalKey(p)) as CommittedBatch[])];
  }
}

describe('mutation: replacing compare-and-swap with read-then-write oversubscribes', () => {
  it('the sibling race authorizes 140 under a parent of 100 against the broken store, on some interleaving', async () => {
    let oversubscribed = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const store = new ReadThenWriteStore(prng(60_000 + seed));
      const { parent, a, b, grants } = siblings();
      await race(store, async (l) => void (await setup(l, policy(), grants)), [
        (l) => l.reserve(spend(a, 'a', units(70)), T0, RETRY),
        (l) => l.reserve(spend(b, 'b', units(70)), T0, RETRY),
      ]);
      if ((await authorizedAt(store, PRINCIPAL, authorityId(parent), 'capital')) > units(100)) oversubscribed += 1;
    }
    assert.ok(oversubscribed > 0, 'the broken store never oversubscribed: the race would not detect a missing CAS');
  });

  it('the two-root race breaches the principal-global limit against the broken store', async () => {
    let breached = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const store = new ReadThenWriteStore(prng(70_000 + seed));
      const { a, b, policy: p } = twoRoots();
      await race(store, async (l) => void (await setup(l, p, [a, b])), [
        (l) => l.reserve(spend(a, 'a', units(60)), T0, RETRY),
        (l) => l.reserve(spend(b, 'b', units(60)), T0, RETRY),
      ]);
      if ((await authorizedAt(store, PRINCIPAL, 'POLICY', 'global-capital')) > units(100)) breached += 1;
    }
    assert.ok(breached > 0);
  });
});
