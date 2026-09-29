/**
 * Mutation testing for the issuance boundary (Phase 7E.1 §50). Each mutant
 * changes one thing — an ordering, an omitted check, an ignored refusal —
 * built here from the same internal stages production composes. The probes
 * are the safety properties:
 *
 * - KEY_USE_BOUND: at the instant of every signature, the committed ledger
 *   binds that exact hash to exactly one attempt, of the reservation issued;
 * - ONE_SIGNATURE_PER_GENERATION;
 * - SIGNED_IS_AUTHORIZED: every signed order carries the authorized fields;
 * - ALLOWLIST: nothing outside CREATE_ORDER / CANCEL_ORDER reaches custody;
 * - HELD_AFTER_ADMIT: once admitted, the reservation is not released;
 * - NOTHING_UNDER_DISABLED: no signature when the module or adapter is disabled.
 *
 * Production violates none; every mutant violates at least one (killed).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keccakDigest, writeDigest, type ObservationId } from '@mandate/core';
import { attemptIdFor, type LedgerEvent } from '@mandate/ledger';
import type { AuthorizationRecord } from '@mandate/control';
import { ARTIFACT_KIND, decodeAction, slotScope, type AttemptClaim, type CustodyTx } from '../src/index.ts';
import { admit, construct, guard, hashTx, issue, readPreExecution, resolveIntent, signAdmitted, submit, type IssueRequest, type SignerDeps } from '../src/issuance.ts';
import { authorizeOrder, issuanceWorld, type FakeVenue, type IssuanceWorld } from './support/signer-world.ts';
import { ByteWriter } from '@mandate/kernel';

type Violation = 'KEY_USE_BOUND' | 'ONE_SIGNATURE_PER_GENERATION' | 'SIGNED_IS_AUTHORIZED' | 'ALLOWLIST' | 'HELD_AFTER_ADMIT' | 'NOTHING_UNDER_DISABLED';

function probes(x: IssuanceWorld, issued: readonly { rec: AuthorizationRecord; payload: Uint8Array }[], o: { disabled?: boolean } = {}): Set<Violation> {
  const v = new Set<Violation>();
  const perReservation = new Map<string, number>();
  for (const s of x.custody.signs) {
    const mine = issued.find((i) => s.boundTo.length === 1 && s.boundTo[0]?.reservation === i.rec.reservation);
    if (s.boundTo.length !== 1 || mine === undefined) v.add('KEY_USE_BOUND');
    const key = s.boundTo[0]?.reservation ?? `unbound:${s.hash}`;
    perReservation.set(key, (perReservation.get(key) ?? 0) + 1);
    if (s.tx.type === 'CREATE_ORDER') {
      const target = mine ?? issued[0];
      const a = target === undefined ? null : decodeAction(target.payload);
      if (a === null || a.kind !== 'ORDER' || s.tx.baseAmount !== a.baseAmount || s.tx.price !== a.price || s.tx.isAsk !== (a.side === 'SELL' ? 1 : 0) || String(s.tx.marketIndex) !== a.market.localId.split(':')[3]) v.add('SIGNED_IS_AUTHORIZED');
    }
  }
  if ([...perReservation.values()].some((n) => n > 1)) v.add('ONE_SIGNATURE_PER_GENERATION');
  for (const t of [...x.custody.hashes, ...x.custody.signs.map((s) => s.tx)]) if (t.type !== 'CREATE_ORDER' && t.type !== 'CANCEL_ORDER') v.add('ALLOWLIST');
  const state = x.store.readCommitted(x.deps.config.principal).state;
  for (const i of issued) {
    const r = state.reservations.get(i.rec.reservation);
    if ((state.reservationAttempts.get(i.rec.reservation)?.length ?? 0) > 0 && r?.status !== 'ACTIVE') v.add('HELD_AFTER_ADMIT');
  }
  if (o.disabled === true && x.custody.signs.length > 0) v.add('NOTHING_UNDER_DISABLED');
  return v;
}

async function scenario(run: (x: IssuanceWorld, rec: AuthorizationRecord, request: IssueRequest) => Promise<void>, o: { second?: boolean; disabled?: 'MODULE' | 'ADAPTER' } = {}): Promise<Set<Violation>> {
  const x = await issuanceWorld();
  try {
    const first = await authorizeOrder(x);
    let target: IssuanceWorld = x;
    if (o.disabled !== undefined) {
      x.store.close();
      target = await issuanceWorld({ path: x.path, reopen: true, clockMs: x.clock.ms, ...(o.disabled === 'MODULE' ? { moduleStatus: 'DISABLED' as const } : { adapterStatus: 'DISABLED' as const }) });
    }
    try {
      await run(target, first.rec, first.issue);
      return probes(target, [{ rec: first.rec, payload: first.a.payload }], { disabled: o.disabled !== undefined });
    } finally {
      if (target !== x) target.store.close();
    }
  } finally {
    x.close();
  }
}

function claimFor(rec: AuthorizationRecord, attempt: string): AttemptClaim {
  return { attempt, reservation: rec.reservation, generation: rec.generation, action: rec.actionId };
}

function existingAttempt(d: SignerDeps, rec: AuthorizationRecord): string {
  return (d.store.readCommitted(rec.principal).state.reservationAttempts.get(rec.reservation) ?? [])[0] ?? '';
}

// --- Mutants, from production's own stages ----------------------------------------------

type Composition = (deps: SignerDeps, rec: AuthorizationRecord, request: IssueRequest) => Promise<void>;

/** Production, for the baseline. */
const PRODUCTION: Composition = async (d, rec, req) => {
  await issue(d, 'ORDER', rec, req);
};

async function prepared(d: SignerDeps, rec: AuthorizationRecord, req: IssueRequest, mutate: (tx: CustodyTx) => CustodyTx = (t) => t, skipGuard = false) {
  const intent = resolveIntent(d, 'ORDER', rec, req.payload);
  if (!intent.ok) throw new Error(intent.reason);
  const ev = await readPreExecution(d);
  if (!ev.ok) throw new Error(ev.reason);
  const built = construct(d, intent.value, ev.value.nonce);
  if (!built.ok) throw new Error(built.reason);
  const tx = mutate(built.value);
  if (!skipGuard) {
    const g = guard(d, intent.value, tx, ev.value.nonce);
    if (!g.ok) throw new Error(g.reason);
  }
  const h = await hashTx(d, tx);
  return { intent: intent.value, ev: ev.value, tx, h };
}

const SIGN_BEFORE_ADMIT: Composition = async (d, rec, req) => {
  const p = await prepared(d, rec, req);
  if (!p.h.ok) return;
  await d.custody.sign(p.tx, claimFor(rec, attemptIdFor({ reservation: rec.reservation, generation: rec.generation, action: rec.actionId, module: rec.module, adapter: rec.adapter, authorization: rec.executionId, ordinal: 1 })));
  await admit(d, p.intent, req, p.tx, p.h.value, p.ev.scope, p.ev.results);
};

/** Production issuance, then the reservation closed NEVER_ISSUED without the "no attempt admitted" precondition. */
const NEVER_ISSUED_AFTER_ADMIT: Composition = async (d, rec, req) => {
  await issue(d, 'ORDER', rec, req);
  const expired = rec.validUntil + 1n;
  const reval = await d.engine.revalidate(rec, { payload: req.payload, states: req.states, context: { ...req.context, evaluationTime: expired } });
  if (!reval.ok || reval.value.status !== 'FAILED') return;
  const snap = d.store.readCommitted(rec.principal);
  const r = snap.state.reservations.get(rec.reservation);
  if (r === undefined) return;
  const w = new ByteWriter().str('mutant/never-issued');
  writeDigest(w, rec.reservation);
  const event: LedgerEvent = { kind: 'CLOSE', at: expired, reservation: rec.reservation, generation: rec.generation, evidence: keccakDigest<ObservationId>(w.finish()), amounts: r.demands.map((x) => x.reserved - x.consumed) };
  await d.store.compareAndAppend(rec.principal, snap.version, snap.head, [event]);
};

/** On EXISTING, issue a fresh transaction anyway. */
const TWO_ATTEMPTS: Composition = async (d, rec, req) => {
  await issue(d, 'ORDER', rec, req);
  const p = await prepared(d, rec, req, (t) => ({ ...t, nonce: t.nonce + 1n }), true);
  if (p.h.ok) await d.custody.sign(p.tx, claimFor(rec, existingAttempt(d, rec)));
};

function mutateAfterAuthorization(mutate: (t: CustodyTx) => CustodyTx): Composition {
  return async (d, rec, req) => {
    const p = await prepared(d, rec, req, mutate, true);
    if (!p.h.ok) return;
    const a = await admit(d, p.intent, req, p.tx, p.h.value, p.ev.scope, p.ev.results);
    if (a.status !== 'ADMITTED') return;
    const s = await signAdmitted(d, p.tx, p.h.value.hash, a.attempt);
    if (s.ok) await submit(d, a.attempt, s.value);
  };
}

function permitType(type: string): Composition {
  return async (d, rec, req) => {
    const p = await prepared(d, rec, req, (t) => ({ ...t, type }), true);
    if (!p.h.ok) return;
    const a = await admit(d, p.intent, req, p.tx, p.h.value, p.ev.scope, p.ev.results);
    if (a.status === 'ADMITTED') await d.custody.sign(p.tx, claimFor(rec, a.attempt.attempt));
  };
}

/** A second reservation's issuance that reuses the first's transaction, and signs despite the ledger's refusal. */
const REUSE_HASH: Composition = async (d, rec, req) => {
  const p = await prepared(d, rec, req);
  if (!p.h.ok) return;
  const a = await admit(d, p.intent, req, p.tx, p.h.value, p.ev.scope, p.ev.results);
  if (a.status !== 'ADMITTED') return;
  await d.custody.sign(p.tx, claimFor(rec, a.attempt.attempt));
  // "Another reservation": the same bytes, asked for again under another claim, with the ledger's refusal ignored.
  await d.custody.sign(p.tx, { attempt: a.attempt.attempt, reservation: ('0x' + '5'.repeat(64)) as never, generation: 1n, action: rec.actionId });
};

/** Commit ADMIT_ATTEMPT directly, bypassing the control engine's module and adapter checks. */
const BYPASS_TRUST: Composition = async (d, rec, req) => {
  const p = await prepared(d, rec, req);
  if (!p.h.ok) return;
  const snap = d.store.readCommitted(rec.principal);
  const base = { reservation: rec.reservation, generation: rec.generation, action: rec.actionId, module: rec.module, adapter: rec.adapter, authorization: rec.executionId, ordinal: 1 };
  const event: LedgerEvent = {
    kind: 'ADMIT_ATTEMPT',
    at: p.intent.nowMs / 1_000n,
    admission: { attempt: attemptIdFor(base), ...base, venueAccount: p.intent.action.account, artifact: { kind: ARTIFACT_KIND as never, id: p.h.value.bytes }, slot: { scope: slotScope(d.config.chainId, d.config.accountIndex, d.config.apiKeyIndex) as never, sequence: p.tx.nonce }, validUntil: p.intent.validUntil, requirements: rec.executionId as never, revalidation: rec.executionId as never },
  };
  const out = await d.store.compareAndAppend(rec.principal, snap.version, snap.head, [event]);
  if (out.status === 'COMMITTED') await d.custody.sign(p.tx, claimFor(rec, attemptIdFor(base)));
};

/** After an unknown submission, retry at once with a fresh order. */
const RETRY_UNKNOWN_FRESH: Composition = async (d, rec, req) => {
  (d.venue as FakeVenue).send = 'UNKNOWN';
  const out = await issue(d, 'ORDER', rec, req);
  if (out.status === 'ISSUED' && out.issuance === 'OUTCOME_UNKNOWN') {
    const p = await prepared(d, rec, req, (t) => ({ ...t, nonce: t.nonce + 1n }), true);
    if (p.h.ok) await d.custody.sign(p.tx, claimFor(rec, existingAttempt(d, rec)));
  }
};

const MUTANTS: readonly { name: string; run: Composition; disabled?: 'MODULE' | 'ADAPTER'; kills: Violation }[] = [
  { name: 'sign before ADMIT_ATTEMPT', run: SIGN_BEFORE_ADMIT, kills: 'KEY_USE_BOUND' },
  { name: 'allow NEVER_ISSUED after ADMIT_ATTEMPT', run: NEVER_ISSUED_AFTER_ADMIT, kills: 'HELD_AFTER_ADMIT' },
  // The second signature is for a hash no attempt binds.
  { name: 'issue two attempts for one generation', run: TWO_ATTEMPTS, kills: 'KEY_USE_BOUND' },
  { name: 'mutate quantity after authorization', run: mutateAfterAuthorization((t) => ({ ...t, baseAmount: t.baseAmount + 1n })), kills: 'SIGNED_IS_AUTHORIZED' },
  { name: 'mutate market after authorization', run: mutateAfterAuthorization((t) => ({ ...t, marketIndex: 4095 })), kills: 'SIGNED_IS_AUTHORIZED' },
  { name: 'permit withdrawal tx type', run: permitType('WITHDRAW'), kills: 'ALLOWLIST' },
  { name: 'permit transfer tx type', run: permitType('TRANSFER'), kills: 'ALLOWLIST' },
  // The one bound hash is signed twice.
  { name: 'reuse transaction hash for another reservation', run: REUSE_HASH, kills: 'ONE_SIGNATURE_PER_GENERATION' },
  { name: 'use disabled module', run: BYPASS_TRUST, disabled: 'MODULE', kills: 'NOTHING_UNDER_DISABLED' },
  { name: 'use disabled adapter', run: BYPASS_TRUST, disabled: 'ADAPTER', kills: 'NOTHING_UNDER_DISABLED' },
  { name: 'retry unknown attempt as fresh order', run: RETRY_UNKNOWN_FRESH, kills: 'KEY_USE_BOUND' },
];

describe('issuance mutants', () => {
  it('production violates no probe — including under a disabled module or adapter', async () => {
    assert.deepEqual([...(await scenario((x, rec, req) => PRODUCTION(x.deps, rec, req)))], []);
    for (const disabled of ['MODULE', 'ADAPTER'] as const) assert.deepEqual([...(await scenario((x, rec, req) => PRODUCTION(x.deps, rec, req), { disabled }))], [], disabled);
    // Production's own reaction to an unknown submission is to stop.
    assert.deepEqual([...(await scenario(async (x, rec, req) => {
      x.venue.send = 'UNKNOWN';
      await issue(x.deps, 'ORDER', rec, req);
      await issue(x.deps, 'ORDER', rec, req);
    }))], []);
  });

  for (const m of MUTANTS) {
    it(`killed: ${m.name}`, async () => {
      const v = await scenario((x, rec, req) => m.run(x.deps, rec, req), m.disabled === undefined ? {} : { disabled: m.disabled });
      assert.ok(v.has(m.kills), `${m.name} survived: violations ${[...v].join(', ') || 'none'}`);
    });
  }
});
