/**
 * Retired for new use is not unavailable for historical verification (7D.1
 * ruling; catalog.ts). A ledger whose delegation was proven narrower by a
 * module's `noWeaker` replays to the same head while that exact module is
 * loaded — retired or not — and refuses to replay without it. Nothing else
 * can stand in for it: not a newer version, not another module, not another
 * digest under the same name.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ReferenceModuleRegistry, encodeLedgerState, replayEncoded, type ModuleStatus } from '@mandate/ledger';
import { ControlEngine, ModuleCatalog, controlRules, type DomainModule } from '../src/index.ts';
import {
  AGENT_A,
  AGENT_B,
  AGENT_C,
  ONCE,
  PERP_CFG,
  RETRY,
  T,
  T0,
  account,
  action,
  authorized,
  capitalDim,
  child,
  context,
  createSyntheticModule,
  marketStates,
  maxLeverage,
  must,
  policy,
  refused,
  request,
  root,
  setup,
  sizeFor,
  world,
  type SyntheticModule,
} from './support/world.ts';

function registryWith(m: DomainModule, status: ModuleStatus, extra: readonly DomainModule[] = []): ReferenceModuleRegistry {
  return must(ReferenceModuleRegistry.create([m, ...extra].map((x) => ({ module: x.ref, status: x === m ? status : 'ACTIVE', implementations: [x.implementation] }))));
}

/** Steps 1–3: M is registered, proves a 3x child under a 4x parent, and the ledger moves on. */
async function history() {
  const w = world({ modules: [createSyntheticModule(PERP_CFG)] });
  const m = w.modules[0] as SyntheticModule;
  const acct = account(m);
  const parent = root({ mods: [m], holder: AGENT_A, delegate: 1, terms: [capitalDim('capital', 100_000), maxLeverage(m, acct, 4n)] });
  await setup(w, policy(), [parent]);
  const c = child(parent, { mods: [m], holder: AGENT_B, terms: [capitalDim('capital', 50_000), maxLeverage(m, acct, 3n)] });
  const reg = await w.engine.registerDelegation(c, T0, ONCE);
  assert.equal(reg.status, 'REGISTERED');
  if (reg.status === 'REGISTERED') assert.deepEqual(reg.proofs[0]?.evaluator, { kind: 'MODULE', module: m.ref });
  const states = marketStates(m, [{ account: acct }]);
  const ctx = context([m], { accounts: [{ module: m, account: acct }] });
  authorized(await w.engine.authorizeAndReserve(request(action(m, { authority: c, size: sizeFor(1_000) }), states, ctx), RETRY));
  authorized(await w.engine.authorizeAndReserve(request(action(m, { authority: c, size: sizeFor(500), nonce: 1n }), states, ctx), RETRY));
  const principal = parent.principal;
  const batches = (await w.store.history(principal)).map((b) => b.encoded);
  const snap = await w.store.read(principal);
  return { w, m, acct, parent, c, states, ctx, principal, batches, head: snap.head, stateBytes: encodeLedgerState(snap.state) };
}

describe('module retirement and historical replay', () => {
  it('retired M refuses new use, and the history M proved replays to the same state and head under archived M', async () => {
    const h = await history();
    // 4. M is retired for new use: the registry now marks it RETIRING. Its exact implementation stays loaded.
    const retiredRegistry = registryWith(h.m, 'RETIRING');
    const archived = must(ModuleCatalog.create(retiredRegistry, [{ module: h.m, corpus: [] }]));
    const engine = new ControlEngine({ store: h.w.store, registry: retiredRegistry, catalog: archived });

    // 5. A new authorization under M is refused, and M cannot prove a new narrowing.
    const r = refused(await engine.authorizeAndReserve(request(action(h.m, { authority: h.c, size: sizeFor(100), nonce: 2n }), h.states, h.ctx), RETRY));
    assert.equal(`${r.code}/${r.reason}`, 'MODULE_NOT_FOUND/MODULE_RETIRING');
    const again = await engine.registerDelegation(child(h.parent, { mods: [h.m], holder: AGENT_C, nonce: 9n, terms: [maxLeverage(h.m, h.acct, 2n)] }), T, ONCE);
    assert.equal(again.status, 'REFUSED');
    if (again.status === 'REFUSED') assert.equal(again.refusal.reason, 'COMPARATOR_NOT_ACTIVE');

    // 6–7. Replay from genesis under archived M reproduces the ledger exactly.
    const replayed = replayEncoded(h.principal, h.batches, controlRules(archived));
    assert.ok(replayed.ok, replayed.ok ? '' : `${replayed.error.code} at ${replayed.error.path}`);
    if (replayed.ok) {
      assert.equal(replayed.value.head, h.head);
      assert.deepEqual(encodeLedgerState(replayed.value), h.stateBytes);
    }
  });

  it('with M removed from the historical verifier, replay refuses — it never accepts the narrowing unproven', async () => {
    const h = await history();
    const withoutM = must(ModuleCatalog.create(registryWith(h.m, 'RETIRING'), []));
    const replayed = replayEncoded(h.principal, h.batches, controlRules(withoutM));
    assert.ok(!replayed.ok);
    if (!replayed.ok) {
      assert.equal(replayed.error.code, 'DELEGATION_REFUSED');
      assert.ok(replayed.error.code === 'DELEGATION_REFUSED' && replayed.error.violations.some((v) => v.code === 'DELEGATION_NARROWING_UNPROVEN'));
    }
  });

  it('nothing substitutes for M: not a newer version, not another digest under M\'s name', async () => {
    const h = await history();
    const newer = createSyntheticModule({ ...PERP_CFG, moduleVersion: 2 });
    // A newer version claiming M's invariant definitions is not a conforming module.
    const claiming = { ...newer, invariants: h.m.invariants } as DomainModule;
    const refusedCatalog = ModuleCatalog.create(registryWith(h.m, 'RETIRING', [newer]), [{ module: claiming, corpus: [] }]);
    assert.ok(!refusedCatalog.ok && refusedCatalog.error.reason === 'INVARIANT_OUTSIDE_MODULE_NAMESPACE');
    // Loaded with its own definitions only, it does not own M's, and replay refuses.
    const newerOnly = must(ModuleCatalog.create(registryWith(h.m, 'RETIRING', [newer]), [{ module: newer, corpus: [] }]));
    assert.ok(!replayEncoded(h.principal, h.batches, controlRules(newerOnly)).ok);
    // Another digest under M's name and version is refused by the registry binding M's name to M's digest.
    const other = createSyntheticModule({ ...PERP_CFG, variant: 'PENDING_HALF' });
    const substituted = ModuleCatalog.create(registryWith(h.m, 'RETIRING'), [{ module: other, corpus: [] }]);
    assert.ok(!substituted.ok && substituted.error.reason === 'MODULE_DIGEST_MISMATCH');
  });
});
