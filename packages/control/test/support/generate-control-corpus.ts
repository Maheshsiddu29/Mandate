/**
 * Generates `corpus/control-v1/vectors.json`: deterministic authorization
 * vectors for the Phase 7D engine over the synthetic reference module
 * (brief §60). Each vector records its scenario, the exact module, the
 * outcome, and the digests the outcome commits to — authorization record,
 * projection, invariant results, charge plan, ledger head — so a second
 * implementation of the same semantics must reproduce them byte for byte.
 *
 * Run: `npm run control-corpus:generate`. Offline and deterministic.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invariantResultsDigest, type AuthorizationOutcome, type ControlRefusal } from '../../src/index.ts';
import {
  AGENT_A,
  AGENT_B,
  ONCE,
  PRICE,
  RETRY,
  T,
  T0,
  account,
  action,
  aggregate,
  capitalDim,
  child,
  context,
  instrumentsState,
  markState,
  marketStates,
  maxExposure,
  maxLeverage,
  policy,
  positionState,
  request,
  root,
  setup,
  sizeFor,
  world,
  type SyntheticModule,
} from './world.ts';
import type { InMemoryStoreHooks } from '@mandate/ledger';

export const CONTROL_CORPUS_PATH = fileURLToPath(new URL('../../../../corpus/control-v1/vectors.json', import.meta.url));
export const CONTROL_CORPUS_VERSION = 1;

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function refusalJson(r: ControlRefusal): Json {
  return {
    code: r.code,
    reason: r.reason,
    origin: r.origin,
    path: r.path,
    invariantResults: r.detail.kind === 'INVARIANTS' ? invariantResultsDigest(r.detail.results) : null,
    violations: r.detail.kind === 'DELEGATION' ? r.detail.violations.map((v) => v.code) : null,
  };
}

function outcomeJson(o: AuthorizationOutcome): Json {
  if (o.status === 'AUTHORIZED') {
    const a = o.authorization;
    return {
      status: 'AUTHORIZED',
      authorization: a.id,
      executionAuthorization: a.executionId,
      reservation: a.reservation,
      generation: a.generation.toString(),
      projection: a.projectionDigest,
      invariantResults: a.invariantResultsDigest,
      chargePlan: a.planDigest,
      ledgerVersionRead: a.ledgerVersionRead.toString(),
      ledgerVersionCommitted: a.ledgerVersionCommitted.toString(),
      ledgerHead: a.ledgerHeadCommitted,
      validUntil: a.validUntil.toString(),
      stateBindings: a.stateBindings.length,
    };
  }
  return { status: o.status, attempts: o.attempts, refusal: refusalJson(o.refusal) };
}

function moduleJson(m: SyntheticModule): Json {
  return { domainId: m.ref.domainId, moduleId: m.ref.moduleId, moduleVersion: m.ref.moduleVersion, moduleDigest: m.ref.moduleDigest, implementation: m.implementation };
}

async function single(limit: number, hooks: InMemoryStoreHooks = {}) {
  const w = world({ hooks });
  const m = w.modules[0] as SyntheticModule;
  const acct = account(m);
  const r0 = root({ mods: [m], delegate: 1, terms: [capitalDim('capital', 1_000_000), maxExposure(m, acct, limit)] });
  const a = child(r0, { mods: [m], holder: AGENT_A, terms: [maxExposure(m, acct, limit)] });
  const b = child(r0, { mods: [m], holder: AGENT_B, nonce: 1n, terms: [maxExposure(m, acct, limit)] });
  await setup(w, policy(), [r0, a, b]);
  const ctx = context([m], { accounts: [{ module: m, account: acct }] });
  return { w, m, acct, r0, a, b, ctx };
}

interface Vector {
  readonly id: string;
  readonly description: string;
  readonly module: Json;
  readonly outcome: Json;
  readonly extra?: Json;
}

async function vectors(): Promise<Vector[]> {
  const out: Vector[] = [];

  {
    const f = await single(10_000);
    const o = await f.w.engine.authorizeAndReserve(request(action(f.m, { authority: f.a, size: sizeFor(2_000) }), marketStates(f.m, [{ account: f.acct }]), f.ctx), ONCE);
    out.push({ id: 'valid-authorization', description: 'a 2,000 order under a 10,000 marked-exposure limit, fresh state, generous capital', module: moduleJson(f.m), outcome: outcomeJson(o) });
  }
  {
    const f = await single(10_000);
    const o = await f.w.engine.authorizeAndReserve(request(action(f.m, { authority: f.a, size: sizeFor(2_000) }), [instrumentsState(f.m), positionState(f.m, f.acct)], f.ctx), ONCE);
    out.push({ id: 'missing-state', description: 'the mark the module requires is not supplied', module: moduleJson(f.m), outcome: outcomeJson(o) });
  }
  {
    const f = await single(10_000);
    const o = await f.w.engine.authorizeAndReserve(request(action(f.m, { authority: f.a, size: sizeFor(2_000) }), [markState(f.m, 'x:BTC-PERP', PRICE, { observedAt: T - 31n }), instrumentsState(f.m), positionState(f.m, f.acct)], f.ctx), ONCE);
    out.push({ id: 'stale-state', description: 'the mark is 31 s old under a 30 s AGE requirement', module: moduleJson(f.m), outcome: outcomeJson(o) });
  }
  {
    const f = await single(5_000);
    const held = marketStates(f.m, [{ account: f.acct, positions: [{ localId: 'x:BTC-PERP', size: sizeFor(2_000) }] }]);
    const first = await f.w.engine.authorizeAndReserve(request(action(f.m, { authority: f.a, size: sizeFor(2_000) }), held, f.ctx), ONCE);
    const o = await f.w.engine.authorizeAndReserve(request(action(f.m, { authority: f.b, size: sizeFor(2_000), nonce: 1n }), held, f.ctx), ONCE);
    out.push({ id: 'pending-reservation-refusal', description: 'held 2,000 + pending 2,000 + proposed 2,000 > 5,000 (brief §12)', module: moduleJson(f.m), outcome: outcomeJson(o), extra: { pending: outcomeJson(first) } });
  }
  {
    const w = world();
    const perp = w.modules[0] as SyntheticModule;
    const spot = w.modules[1] as SyntheticModule;
    const acctS = account(spot);
    const acctP = account(perp);
    const ra = root({ mods: [spot], holder: AGENT_A, terms: [capitalDim('capital', 100_000)] });
    const rb = root({ mods: [perp], holder: AGENT_B, nonce: 1n, terms: [capitalDim('capital', 100_000)] });
    await setup(w, policy([aggregate({ whole: 5_000, contributors: [spot, perp], accounts: [acctS, acctP] })]), [ra, rb]);
    const states = [...marketStates(spot, [{ account: acctS, positions: [{ localId: 'x:BTC-SPOT', size: sizeFor(1_500) }] }]), ...marketStates(perp, [{ account: acctP }])];
    const ctx = context([perp, spot], { accounts: [{ module: spot, account: acctS }, { module: perp, account: acctP }] });
    const pending = await w.engine.authorizeAndReserve(request(action(spot, { authority: ra, size: sizeFor(2_500) }), states, ctx), ONCE);
    const o = await w.engine.authorizeAndReserve(request(action(perp, { authority: rb, size: sizeFor(2_000) }), states, ctx), ONCE);
    out.push({ id: 'global-invariant-refusal', description: 'two roots: 1,500 held + 2,500 pending + 2,000 proposed > principal-global 5,000 (brief §65)', module: moduleJson(perp), outcome: outcomeJson(o), extra: { pending: outcomeJson(pending) } });
  }
  for (const [id, numerator] of [
    ['semantic-narrowing-pass', 3n],
    ['semantic-widening-refusal', 5n],
  ] as const) {
    const w = world();
    const m = w.modules[0] as SyntheticModule;
    const acct = account(m);
    const parent = root({ mods: [m], holder: AGENT_A, delegate: 1, terms: [capitalDim('capital', 100_000), maxLeverage(m, acct, 4n)] });
    await setup(w, policy(), [parent]);
    const r = await w.engine.registerDelegation(child(parent, { mods: [m], holder: AGENT_B, terms: [maxLeverage(m, acct, numerator)] }), T0, ONCE);
    out.push({
      id,
      description: `a child restating account leverage ≤ ${numerator}x under a parent's ≤ 4x`,
      module: moduleJson(m),
      outcome:
        r.status === 'REGISTERED'
          ? { status: 'REGISTERED', ledgerHead: r.snapshot.head, proofs: r.proofs.map((p) => ({ term: p.term, verdict: p.verdict, evaluator: p.evaluator.kind === 'MODULE' ? p.evaluator.module.moduleDigest : p.evaluator.kind })) }
          : { status: r.status, refusal: refusalJson(r.refusal) },
    });
  }
  {
    // Two decisions from one snapshot; the loser loses the CAS, re-projects with the winner pending, and is refused.
    let armed = false;
    let reads = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const hooks: InMemoryStoreHooks = {
      delay: async (point) => {
        if (point !== 'READ' || !armed || reads >= 2) return;
        reads += 1;
        if (reads === 2) release();
        await gate;
      },
    };
    const f = await single(5_000, hooks);
    const held = marketStates(f.m, [{ account: f.acct, positions: [{ localId: 'x:BTC-PERP', size: sizeFor(1_000) }] }]);
    armed = true;
    const [x, y] = await Promise.all([
      f.w.engine.authorizeAndReserve(request(action(f.m, { authority: f.a, size: sizeFor(2_500) }), held, f.ctx), RETRY),
      f.w.engine.authorizeAndReserve(request(action(f.m, { authority: f.b, size: sizeFor(2_500), nonce: 1n }), held, f.ctx), RETRY),
    ]);
    out.push({
      id: 'cas-conflict-reprojection',
      description: 'held 1,000; two 2,500 orders read one snapshot against 5,000: one reserves, the other re-projects after the CAS conflict and is refused',
      module: moduleJson(f.m),
      outcome: { first: outcomeJson(x as AuthorizationOutcome), second: outcomeJson(y as AuthorizationOutcome) },
      extra: { conflicts: [(x as AuthorizationOutcome).conflicts.length, (y as AuthorizationOutcome).conflicts.length] },
    });
  }
  {
    const f = await single(20_000);
    const buy = action(f.m, { authority: f.a, size: 400n, limitPrice: 10_100_000n });
    const states = (mark: bigint, at: bigint) => [markState(f.m, 'x:BTC-PERP', mark, { observedAt: at }), instrumentsState(f.m), positionState(f.m, f.acct, [{ localId: 'x:BTC-PERP', size: 1_500n }])];
    const reserved = await f.w.engine.authorizeAndReserve(request(buy, states(PRICE, T), f.ctx), ONCE);
    const rec = reserved.status === 'AUTHORIZED' ? reserved.authorization : (null as never);
    const moved = { payload: buy.payload, states: states(10_600_000n, T + 3n), context: context([f.m], { at: T + 3n, accounts: [{ module: f.m, account: f.acct }] }) };
    const c = await f.w.engine.closeNeverIssued(rec, moved, ONCE);
    out.push({
      id: 'never-issued-closure',
      description: 'examples.md §F: reserved at mark 100,000; the mark moves to 106,000; revalidation fails; nothing was issued; the reservation closes NEVER_ISSUED',
      module: moduleJson(f.m),
      outcome:
        c.status === 'CLOSED'
          ? { status: 'CLOSED', evidence: c.evidence, revalidation: c.revalidation.id, reason: c.revalidation.status === 'FAILED' ? c.revalidation.refusal.reason : null, ledgerHead: c.snapshot.head }
          : { status: c.status },
      extra: { reserved: outcomeJson(reserved) },
    });
  }
  return out;
}

export async function buildCorpus(): Promise<Json> {
  const v = await vectors();
  return {
    corpusVersion: CONTROL_CORPUS_VERSION,
    engine: 'Mandate Core v1 control engine (Phase 7D), synthetic reference module, in-memory reference store',
    note: 'Integers are decimal strings. Digests are keccak-256 of the canonical encodings in docs/core-v1/implementation-7d.md. The synthetic module is test-only and names no real venue.',
    vectorCount: v.length,
    vectors: v.map((x) => ({ id: x.id, description: x.description, module: x.module, outcome: x.outcome, extra: x.extra ?? null })),
  };
}

export async function serializeCorpus(): Promise<string> {
  return `${JSON.stringify(await buildCorpus(), null, 2)}\n`;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(dirname(CONTROL_CORPUS_PATH), { recursive: true });
  writeFileSync(CONTROL_CORPUS_PATH, await serializeCorpus(), 'utf8');
  process.stdout.write(`wrote ${CONTROL_CORPUS_PATH}\n`);
}
