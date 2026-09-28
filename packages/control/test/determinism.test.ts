/**
 * Determinism (brief §46): identical action, authority, policy, state,
 * pending reservations, module implementation and context give a
 * byte-identical result, whatever order the caller supplied state in, in a
 * fresh process-independent world each time. Nothing depends on a clock,
 * map iteration order, randomness or timing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAuthorizationRecord, encodeProjectionRecord, invariantResultsDigest, type AuthorizationOutcome, type SuppliedState } from '../src/index.ts';
import {
  AGENT_A,
  AGENT_B,
  ONCE,
  account,
  action,
  aggregate,
  capitalDim,
  child,
  context,
  int,
  marketStates,
  maxExposure,
  policy,
  prng,
  request,
  root,
  setup,
  sizeFor,
  assetValuedModules,
  world,
  type SyntheticModule,
} from './support/world.ts';

function shuffle<T>(xs: readonly T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** A canonical byte rendering of an outcome. */
function render(o: AuthorizationOutcome): string {
  if (o.status === 'AUTHORIZED') return `A:${Buffer.from(encodeAuthorizationRecord(o.authorization)).toString('hex')}:${Buffer.from(encodeProjectionRecord(o.decision.projection)).toString('hex')}`;
  const r = o.refusal;
  const inv = r.detail.kind === 'INVARIANTS' ? invariantResultsDigest(r.detail.results) : '';
  return `${o.status}:${r.code}:${r.reason}:${r.path}:${inv}`;
}

async function scenario(seed: number, order: number): Promise<string[]> {
  const rand = prng(seed);
  const w = world({ modules: assetValuedModules() });
  const perp = w.modules[0] as SyntheticModule;
  const spot = w.modules[1] as SyntheticModule;
  const acctS = account(spot);
  const acctP = account(perp);
  const limit = int(rand, 20, 80) * 100;
  const r0 = root({ mods: [perp, spot], delegate: 1, terms: [capitalDim('capital', 100_000)] });
  const a = child(r0, { mods: [spot], holder: AGENT_A, terms: [capitalDim('capital', 50_000)] });
  const b = child(r0, { mods: [perp], holder: AGENT_B, terms: [capitalDim('capital', 50_000), maxExposure(perp, acctP, limit)] });
  await setup(w, policy([aggregate({ whole: limit, contributors: [spot, perp], accounts: [acctS, acctP] })]), [r0, a, b]);
  const states: SuppliedState[] = [
    ...marketStates(spot, [{ account: acctS, positions: [{ localId: 'x:BTC-SPOT', size: sizeFor(int(rand, 0, 10) * 100) }] }]),
    ...marketStates(perp, [{ account: acctP, positions: [{ localId: 'x:BTC-PERP', size: sizeFor(int(rand, 0, 10) * 100) }] }]),
  ];
  const ctx = context([perp, spot], { accounts: [{ module: spot, account: acctS }, { module: perp, account: acctP }] });
  const out: string[] = [];
  const shuffler = prng(order);
  for (let i = 0; i < 6; i += 1) {
    const agent = i % 2 === 0 ? { m: spot, g: a } : { m: perp, g: b };
    const size = sizeFor(int(rand, 1, 20) * 100);
    // Only the order of the supplied snapshots differs between runs.
    out.push(render(await w.engine.authorizeAndReserve(request(action(agent.m, { authority: agent.g, size, nonce: BigInt(i) }), order === 0 ? states : shuffle(states, shuffler), ctx), ONCE)));
  }
  return out;
}

describe('determinism', () => {
  it('byte-identical outcomes across fresh worlds and any supplied-state order', async () => {
    let authorizedSeen = 0;
    let refusedSeen = 0;
    for (let seed = 1; seed <= 12; seed += 1) {
      const reference = await scenario(seed, 0);
      for (const order of [1, 2]) assert.deepEqual(await scenario(seed, order), reference, `seed ${seed}, order ${order}`);
      authorizedSeen += reference.filter((x) => x.startsWith('A:')).length;
      refusedSeen += reference.filter((x) => x.startsWith('REFUSED:')).length;
    }
    assert.ok(authorizedSeen > 0 && refusedSeen > 0, 'both authorizations and refusals were compared');
  });

  it('the pure decision is the same function of the same snapshot, called twice', async () => {
    const w = world();
    const perp = w.modules[0] as SyntheticModule;
    const acct = account(perp);
    const r0 = root({ mods: [perp], holder: AGENT_A, terms: [capitalDim('capital', 100_000), maxExposure(perp, acct, 10_000)] });
    await setup(w, policy(), [r0]);
    const req = request(action(perp, { authority: r0, size: sizeFor(1_000) }), marketStates(perp, [{ account: acct }]), context([perp], { accounts: [{ module: perp, account: acct }] }));
    const x = await w.engine.decide(req);
    const y = await w.engine.decide(req);
    assert.ok(x.ok && y.ok);
    if (x.ok && y.ok) {
      assert.equal(x.value.projectionDigest, y.value.projectionDigest);
      assert.equal(x.value.invariantResultsDigest, y.value.invariantResultsDigest);
      assert.equal(x.value.planDigest, y.value.planDigest);
      assert.deepEqual(x.value.event, y.value.event);
    }
  });
});
