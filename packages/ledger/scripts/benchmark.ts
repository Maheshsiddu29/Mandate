/**
 * Cost of the authority ledger's hot paths.
 *
 * The purpose is to catch an accidentally O(history × tree) design on the
 * authorization path, not to optimize: an authorization reads the current
 * derived state and appends evidence; it never replays the log. Numbers are
 * machine-dependent and are reported, never asserted.
 *
 * Every case runs the pure functions the store runs at commit (plan, then
 * `applyBatch`), against an immutable state, so no case mutates what the next
 * iteration reads.
 *
 * Memory is reported as encoded sizes — the log a store persists and the
 * canonical encoding of the folded state — which are deterministic; heap
 * deltas are dominated by the garbage collector and are not reported.
 *
 * Run: `npm run ledger:benchmark`. Offline; nothing is written to disk.
 */

import { authorityId, reservationIdFor, type AuthorityGrant } from '@mandate/core';
import {
  applyBatch,
  deriveReserveEvent,
  effectiveAuthority,
  encodeLedgerState,
  replay,
  replayEncoded,
  resolveLineage,
  checkLineageValid,
  type LedgerEvent,
  type LedgerState,
} from '../src/index.ts';
import {
  ALL_MODULES,
  BTC,
  DELEGATE,
  PRINCIPAL,
  T0,
  address,
  capital,
  child,
  contribution,
  count,
  digestOf,
  dim,
  notional,
  plan,
  policy,
  root,
  units,
} from '../test/support/grants.ts';
import { bootstrap, closeEvent, consumeEvent, reserveEvent, restoreEvent, step } from '../test/support/steps.ts';

const ROUNDS = 7;

function medianMicros(iterations: number, run: () => void): number {
  for (let i = 0; i < iterations; i += 1) run(); // warm-up
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) run();
    samples.push(Number(process.hrtime.bigint() - start) / 1_000 / iterations);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] as number;
}

function must<T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}

// --- Fixtures -----------------------------------------------------------------------

/** A chain of `depth` nodes below a root, each with a capital dimension. */
function chain(depth: number): { grants: AuthorityGrant[]; leaf: AuthorityGrant } {
  const top = root({ holder: address('40'), terms: [ALL_MODULES, DELEGATE(7), dim('capital', units(1_000_000))] });
  const grants = [top];
  let parent = top;
  for (let i = 1; i < depth; i += 1) {
    const d = 7 - i;
    const c = child(parent, { holder: address((0x40 + i).toString(16)), terms: d > 0 ? [ALL_MODULES, DELEGATE(d), dim('capital', units(1_000_000 - i))] : [ALL_MODULES, dim('capital', units(1_000_000 - i))] });
    grants.push(c);
    parent = c;
  }
  return { grants, leaf: parent };
}

const global = dim('global-capital', units(100_000_000));

const rows: { name: string; micros: number; note: string }[] = [];

// Lineage resolution and the meet.
for (const depth of [1, 5]) {
  const { grants, leaf } = chain(depth);
  const s = bootstrap(policy([global]), grants);
  const id = authorityId(leaf);
  const pol = s.policy?.policy;
  if (pol === undefined) throw new Error('no policy');
  rows.push({
    name: `resolve ${depth}-deep lineage (+ validity + meet)`,
    micros: medianMicros(20_000, () => {
      const l = must(resolveLineage(s, id));
      must(checkLineageValid(s, l, T0));
      must(effectiveAuthority(l, pol));
    }),
    note: `${depth} node(s)`,
  });
}

// Reservations: plan (derive the full path) + the reducer's commit-time application.
function reservationCase(name: string, s: LedgerState, p: ReturnType<typeof plan>, note: string): void {
  rows.push({
    name,
    micros: medianMicros(5_000, () => {
      const e = must(deriveReserveEvent(s, p, T0));
      must(applyBatch(s, [e]));
    }),
    note,
  });
}

{
  const r = root({ terms: [ALL_MODULES, dim('capital', units(1_000_000))] });
  const s = bootstrap(policy([]), [r]);
  reservationCase('single-dimension reservation', s, plan({ authority: r, contributions: [contribution(capital(units(10)))] }), '1 leg');
}
{
  const r = root({
    terms: [
      ALL_MODULES,
      dim('capital', units(1_000_000)),
      dim('btc-notional', units(1_000_000), { kind: 'NOTIONAL', unit: 'USD', scope: { asset: BTC } }),
      dim('actions', 1_000_000n, { kind: 'COUNT', unit: 'COUNT', decimals: 0, restoration: 'NONE' }),
      dim('daily-spend', units(1_000_000), { restoration: 'EPOCH' }),
    ],
  });
  const s = bootstrap(policy([]), [r]);
  const p = plan({ authority: r, action: 'four', contributions: [contribution(capital(units(10))), contribution(notional(units(70), digestOf('action:four'))), contribution(count(1n))] });
  reservationCase('four-dimension reservation', s, p, '3 contributions, 4 legs');
}
{
  const a = root({ holder: address('51'), terms: [ALL_MODULES, dim('capital', units(1_000_000))] });
  const b = root({ holder: address('52'), nonce: 1n, terms: [ALL_MODULES, dim('capital', units(1_000_000))] });
  const s = bootstrap(policy([global]), [a, b]);
  reservationCase('two-root global reservation', s, plan({ authority: b, contributions: [contribution(capital(units(10)))] }), 'root leg + policy leg');
}
{
  const { grants, leaf } = chain(5);
  const s = bootstrap(policy([global]), grants);
  reservationCase('5-deep reservation with global', s, plan({ authority: leaf, contributions: [contribution(capital(units(10)))] }), '6 legs');
}

// --- A long history: reserve → consume → close → restore, cycling capacity ---------------

function history(events: number): { batches: LedgerEvent[][]; state: LedgerState } {
  const agents = [0, 1, 2, 3].map((i) => address((0x60 + i).toString(16)));
  const top = root({ holder: address('5f'), terms: [ALL_MODULES, DELEGATE(1), dim('capital', units(1_000_000))] });
  const kids = agents.map((h, i) => child(top, { holder: h, nonce: BigInt(i), terms: [ALL_MODULES, dim('capital', units(500_000))] }));
  const batches: LedgerEvent[][] = [[{ kind: 'REGISTER_POLICY', at: T0, policy: policy([global]) }], [top, ...kids].map((g) => ({ kind: 'REGISTER_GRANT' as const, at: T0, grant: g }))];
  let s = must(replay(PRINCIPAL, batches));
  let n = batches.reduce((x, b) => x + b.length, 0);
  let i = 0;
  while (n < events) {
    const k = kids[i % kids.length] as AuthorityGrant;
    const p = plan({ authority: k, action: `h${i}`, contributions: [contribution(capital(units(10)))] });
    const e1 = reserveEvent(s, p);
    s = step(s, [e1]);
    const rec = s.reservations.get(reservationIdFor(p.action, p.generation));
    if (rec === undefined) throw new Error('missing');
    const e2 = consumeEvent(rec, [units(6)]);
    s = step(s, [e2]);
    const e3 = closeEvent({ ...rec, demands: rec.demands.map((d) => ({ ...d, consumed: units(6) })) });
    s = step(s, [e3]);
    const e4 = restoreEvent(s.reservations.get(rec.id) ?? rec, [units(6)]);
    s = step(s, [e4]);
    batches.push([e1], [e2], [e3], [e4]);
    n += 4;
    i += 1;
  }
  return { batches, state: s };
}

for (const size of [1_000, 10_000]) {
  const { batches, state } = history(size);
  const encoded: Uint8Array[] = [];
  {
    let s = must(replay(PRINCIPAL, []));
    for (const b of batches) {
      const r = must(applyBatch(s, b));
      encoded.push(r.encoded);
      s = r.state;
    }
  }
  const eventCount = batches.reduce((x, b) => x + b.length, 0);
  const logBytes = encoded.reduce((x, b) => x + b.length, 0);
  const stateBytes = encodeLedgerState(state).length;
  const replayed = must(replay(PRINCIPAL, batches));
  if (replayed.version !== state.version) throw new Error('replay diverged');
  rows.push({
    name: `replay ${eventCount.toLocaleString('en-US')} events (in memory)`,
    micros: medianMicros(1, () => void must(replay(PRINCIPAL, batches))),
    note: `log ${(logBytes / 1024).toFixed(0)} KiB encoded; state ${(stateBytes / 1024).toFixed(0)} KiB canonical encoding`,
  });
  rows.push({
    name: `replay ${eventCount.toLocaleString('en-US')} events (from stored bytes)`,
    micros: medianMicros(1, () => void must(replayEncoded(PRINCIPAL, encoded))),
    note: `${batches.length.toLocaleString('en-US')} batches, decode + verify chain`,
  });

  // The authorization path at this history size: must not grow with history.
  const top = batches[1]?.[1];
  if (top === undefined || top.kind !== 'REGISTER_GRANT') throw new Error('shape');
  const leafGrant = top.grant;
  const p = plan({ authority: leafGrant, action: 'probe', contributions: [contribution(capital(units(10)))] });
  reservationCase(`reservation after ${eventCount.toLocaleString('en-US')} events`, state, p, `${state.reservations.size.toLocaleString('en-US')} reservations in state`);
}

process.stdout.write(`Authority ledger benchmark: median of ${ROUNDS} rounds, Node ${process.version}\n\n`);
process.stdout.write('| Case | Median (µs) | Notes |\n| --- | ---: | --- |\n');
for (const r of rows) process.stdout.write(`| ${r.name} | ${r.micros < 10_000 ? r.micros.toFixed(1) : Math.round(r.micros).toLocaleString('en-US')} | ${r.note} |\n`);
