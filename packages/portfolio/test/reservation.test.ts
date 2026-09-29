/**
 * Compilation into Core and reservation through the unchanged control
 * engine: the ledger re-checks child ⊆ parent on its own, charges every leg
 * atomically, and the portfolio's precondition stands in front of any key.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authorityId, validateAuthorityGrant, type AuthorityTermInput } from '@mandate/core';
import {
  amountOf,
  availabilityFrom,
  checkBeforeSign,
  childAuthorizationDigest,
  compileAction,
  compilePortfolio,
  createPortfolioCore,
  executeFixtureChild,
  registerPortfolio,
  reservationPhase,
  reserveChild,
  type ChildAuthorizationDigest,
  type CompiledPortfolio,
} from '../src/index.ts';
import { DEMO_T0, USDC, demoBindings, demoMandate, demoParty } from '../src/demo/index.ts';
import { NOW, nftBuy, perpOpen, stockBuy, swap, yieldDeposit } from './support/candidates.ts';
import { childFor, world } from './support/world.ts';

const reserved = async (w: Awaited<ReturnType<typeof world>>, role: string, candidate: ReturnType<typeof stockBuy>) => {
  const child = childFor(w.m, role, candidate);
  const r = await reserveChild(w.core, child, candidate, NOW);
  if (r.status !== 'RESERVED') assert.fail(`reserve ${role}: ${JSON.stringify(r.reasons)}`);
  return { child, record: r.record };
};

describe('compilation into Core', () => {
  it('a valid mandate compiles to an empty principal policy, one root and one delegation per agent, and the ledger accepts them', async () => {
    const w = await world();
    assert.equal(w.compiled.policy.terms.length, 0);
    assert.equal(w.compiled.delegations.size, 5);
    const snap = await w.core.engine.read(w.compiled.mandate.principal);
    assert.equal(snap.state.nodes.size, 6);
    const root = w.compiled.root.terms.filter((t) => t.kind === 'LEDGER_DIMENSION').map((t) => (t.kind === 'LEDGER_DIMENSION' ? `${t.dimensionId}=${t.limit.atoms}` : ''));
    assert.deepEqual(root.sort(), ['derivative-notional=400000000', 'illiquid-notional=400000000', 'perp-margin=400000000', 'portfolio-notional=2000000000', 'spot-capital=800000000']);
  });

  it('an invalid mandate does not compile, with every reason', () => {
    const bad = demoMandate({ expiresAt: DEMO_T0 + 60n });
    const c = compilePortfolio(bad, demoBindings());
    assert.ok(!c.ok && c.error.every((r) => r.code === 'CHILD_WIDENS_WINDOW'));
  });

  it('independently of the portfolio layer, the ledger refuses a delegation wider than the root', async () => {
    const w = await world();
    const perps = w.compiled.delegations.get(demoParty('perps').value);
    assert.ok(perps !== undefined);
    const widen = (terms: AuthorityTermInput[]) =>
      validateAuthorityGrant({ lineage: { kind: 'DELEGATION', parent: authorityId(w.compiled.root), issuer: demoParty('principal') }, principal: demoParty('principal'), holder: demoParty('perps'), notBefore: DEMO_T0, expiresAt: DEMO_T0 + 86_400n, terms, nonce: 99n });
    const base = perps.terms.map((t) => JSON.parse(JSON.stringify(t, (_, v: bigint | string) => (typeof v === 'bigint' ? v.toString() : v))) as AuthorityTermInput);
    // A 2,500 hard maximum under a 2,000 root: DELEGATION_WIDENS_LIMIT.
    const bigger = base.map((t) => (t.kind === 'LEDGER_DIMENSION' && t.dimensionId === 'portfolio-notional' ? { ...t, limit: { ...t.limit, atoms: USDC(2_500n).toString() } } : t));
    const g1 = widen(bigger);
    assert.ok(g1.ok);
    const r1 = await w.core.engine.registerDelegation(g1.value, DEMO_T0, { maxAttempts: 1 });
    assert.equal(r1.status, 'REFUSED');
    assert.ok(r1.status === 'REFUSED' && r1.refusal.detail.kind === 'DELEGATION' && r1.refusal.detail.violations.some((v) => v.code === 'DELEGATION_WIDENS_LIMIT'));
    // A market the root never granted: DELEGATION_WIDENS_SET.
    const moreMarkets = base.map((t) => (t.kind === 'SET' && t.vocabulary === 'MARKETS' ? { ...t, members: [...t.members, { domain: 'lighter-perp', kind: 'MARKET', localId: 'lighter:300:market:9999' }] } : t)) as AuthorityTermInput[];
    const g2 = widen(moreMarkets);
    assert.ok(g2.ok);
    const r2 = await w.core.engine.registerDelegation(g2.value, DEMO_T0, { maxAttempts: 1 });
    assert.ok(r2.status === 'REFUSED' && r2.refusal.detail.kind === 'DELEGATION' && r2.refusal.detail.violations.some((v) => v.code === 'DELEGATION_WIDENS_SET'));
  });
});

describe('reservation through the control engine', () => {
  it('all five domains reserve through their real modules; the ledger holds exactly the approved demand', async () => {
    const w = await world();
    const cases = [
      ['stock', stockBuy({ tenths: 48n })],
      ['swap', swap()],
      ['nft', nftBuy({ price: USDC(250n) })],
      ['yield', yieldDeposit({ amount: USDC(450n) })],
      ['perps', perpOpen({ usdc: 400n })],
    ] as const;
    for (const [role, candidate] of cases) {
      const { child, record } = await reserved(w, role, candidate);
      assert.equal(record.lineage[0], authorityId(w.compiled.delegations.get(demoParty(role).value) as never), `${role}: charged under its own delegation`);
      assert.equal(record.lineage[1], authorityId(w.compiled.root));
      const snap = await w.core.engine.read(record.principal);
      assert.equal(reservationPhase(snap.state, record.reservation), 'RESERVED');
      assert.ok(child.approved.length > 0);
    }
    const snap = await w.core.engine.read(w.m.principal);
    const av = availabilityFrom(w.compiled, snap, NOW);
    // 600 + 300 + 250 + 450 + 400: the whole 2,000, held at the root's leg; each agent's own leg holds its part.
    assert.equal(amountOf(av.reserved, 'portfolio-notional'), USDC(2_000n));
    assert.equal(amountOf(av.portfolio, 'portfolio-notional'), 0n);
    assert.equal(amountOf(av.portfolio, 'derivative-notional'), USDC(0n));
    assert.equal(amountOf(av.agents.get(demoParty('stock').value) ?? [], 'portfolio-notional'), USDC(200n));
  });

  it('the portfolio-wide limit is the ledger’s: once 2,000 is reserved, any further notional is refused atomically', async () => {
    const w = await world();
    await reserved(w, 'stock', stockBuy({ tenths: 64n })); // 800
    await reserved(w, 'yield', yieldDeposit({ amount: USDC(800n) }));
    await reserved(w, 'perps', perpOpen({ usdc: 400n }));
    const child = childFor(w.m, 'swap', swap({ amount: USDC(1n) }));
    const r = await reserveChild(w.core, child, swap({ amount: USDC(1n) }), NOW);
    assert.deepEqual(r.status === 'REFUSED' ? r.reasons.map((x) => x.code) : r.status, ['LEDGER:AUTHORITY_UNAVAILABLE/LEDGER_LIMIT_EXCEEDED']);
    const snap = await w.core.engine.read(w.m.principal);
    assert.equal(amountOf(availabilityFrom(w.compiled, snap, NOW).reserved, 'portfolio-notional'), USDC(2_000n));
  });

  it('a mutated candidate is refused before the ledger: the child binds its candidate by digest', async () => {
    const w = await world();
    const child = childFor(w.m, 'swap', swap());
    const r = await reserveChild(w.core, child, swap({ recipient: 'eip155:421614/account:0x9999999999999999999999999999999999999999' }), NOW);
    assert.deepEqual(r.status === 'REFUSED' ? r.reasons.map((x) => x.code) : r.status, ['CHILD_ACTION_MUTATED']);
  });

  it('an agent that understates what its action consumes is refused: the module’s demand must equal the approved demand', async () => {
    const w = await world();
    // The agent claims a 40 % margin setting; the admitted account book says 50 %: Core's margin is larger than approved.
    const candidate = perpOpen({ usdc: 400n, imf: 4_000 });
    const child = childFor(w.m, 'perps', candidate);
    const r = await reserveChild(w.core, child, candidate, NOW);
    assert.deepEqual(r.status === 'REFUSED' ? r.reasons.map((x) => x.code) : r.status, ['RESERVATION_DEMAND_MISMATCH']);
  });

  it('replay: the same child reserves once; the second is refused by the ledger', async () => {
    const w = await world();
    const candidate = swap();
    const { child } = await reserved(w, 'swap', candidate);
    const again = await reserveChild(w.core, child, candidate, NOW);
    assert.equal(again.status, 'REFUSED');
    assert.ok(again.status === 'REFUSED' && again.reasons.some((x) => x.code.startsWith('LEDGER:') && x.code.includes('RESERVATION_EXISTS')), JSON.stringify(again.status === 'REFUSED' ? again.reasons : []));
  });

  it('the compiled action’s nonce commits to the child: two children never compile to one action', async () => {
    const w = await world();
    const a = childFor(w.m, 'swap', swap({ amount: USDC(100n) }));
    const b = childFor(w.m, 'swap', swap({ amount: USDC(101n) }));
    const ca = compileAction(w.compiled as CompiledPortfolio, a, swap({ amount: USDC(100n) }));
    const cb = compileAction(w.compiled as CompiledPortfolio, b, swap({ amount: USDC(101n) }));
    assert.ok(ca.ok && cb.ok);
    assert.notEqual(ca.value.envelope.nonce, cb.value.envelope.nonce);
  });
});

describe('before any key is used', () => {
  it('a fixture child: ADMIT_ATTEMPT is committed first, then checkBeforeSign passes, then the simulated venue settles', async () => {
    const w = await world();
    const candidate = yieldDeposit({ amount: USDC(600n) });
    const { child, record } = await reserved(w, 'yield', candidate);
    const verified = new Set<ChildAuthorizationDigest>([childAuthorizationDigest(child)]);
    let snap = await w.core.engine.read(record.principal);
    const claim = { agent: child.agent, child, candidate, reservation: record.reservation, action: record.actionId };
    assert.deepEqual(checkBeforeSign(w.core, verified, claim, snap.state).map((r) => r.code), ['ATTEMPT_NOT_COMMITTED']);
    const x = await executeFixtureChild(w.core, verified, child, candidate, record, NOW + 5n);
    assert.ok(x.ok, x.ok ? '' : JSON.stringify(x.error));
    assert.equal(x.value.evidence, 'SIMULATED');
    snap = await w.core.engine.read(record.principal);
    assert.equal(reservationPhase(snap.state, record.reservation), 'ADMITTED');
    assert.deepEqual(checkBeforeSign(w.core, verified, claim, snap.state), []);
    // Nothing was consumed or released: reconciliation is not built.
    assert.equal(snap.state.reservations.get(record.reservation)?.status, 'ACTIVE');
  });

  it('one child cannot use another child’s reservation, and an unverified child is refused', async () => {
    const w = await world();
    const swapC = swap();
    const yieldC = yieldDeposit({ amount: USDC(600n) });
    const s = await reserved(w, 'swap', swapC);
    const y = await reserved(w, 'yield', yieldC);
    const verified = new Set<ChildAuthorizationDigest>([childAuthorizationDigest(s.child), childAuthorizationDigest(y.child)]);
    await executeFixtureChild(w.core, verified, y.child, yieldC, y.record, NOW + 5n);
    const snap = await w.core.engine.read(w.m.principal);
    // The swap agent presents its own child against the yield agent's admitted reservation.
    const stolen = checkBeforeSign(w.core, verified, { agent: s.child.agent, child: s.child, candidate: swapC, reservation: y.record.reservation, action: s.record.actionId }, snap.state);
    assert.ok(stolen.some((r) => r.code === 'RESERVATION_MISSING'));
    // The swap agent presents the yield child itself.
    const impersonated = checkBeforeSign(w.core, verified, { agent: s.child.agent, child: y.child, candidate: yieldC, reservation: y.record.reservation, action: y.record.actionId }, snap.state);
    assert.deepEqual(impersonated.map((r) => r.code), ['CHILD_AGENT_MISMATCH']);
    const unverified = checkBeforeSign(w.core, new Set(), { agent: y.child.agent, child: y.child, candidate: yieldC, reservation: y.record.reservation, action: y.record.actionId }, snap.state);
    assert.deepEqual(unverified.map((r) => r.code), ['CHILD_AUTHORIZATION_UNKNOWN']);
  });

  it('the fixture issuer refuses to issue for a domain that is not a fixture', async () => {
    const w = await world();
    const candidate = stockBuy();
    const { child, record } = await reserved(w, 'stock', candidate);
    const x = await executeFixtureChild(w.core, new Set([childAuthorizationDigest(child)]), child, candidate, record, NOW + 5n);
    assert.ok(!x.ok && x.error.some((r) => r.subject === 'not-a-fixture:robinhood-evm'));
  });

  it('a durable store works the same: the compiled portfolio registers and reserves in the SQLite reference store', async () => {
    const { SqliteLedgerStore } = await import('@mandate/ledger-sqlite');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'mandate-portfolio-'));
    try {
      const m = demoMandate();
      const compiled = compilePortfolio(m, demoBindings());
      assert.ok(compiled.ok);
      let store: ReturnType<typeof SqliteLedgerStore.open> | null = null;
      const core = createPortfolioCore(compiled.value, { storeOf: (rules) => (store = SqliteLedgerStore.open({ path: join(dir, 'ledger.db'), rules })) });
      assert.ok((await registerPortfolio(core, DEMO_T0)).ok);
      const candidate = swap();
      const r = await reserveChild(core, childFor(m, 'swap', candidate), candidate, NOW);
      assert.equal(r.status, 'RESERVED');
      (store as ReturnType<typeof SqliteLedgerStore.open> | null)?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
