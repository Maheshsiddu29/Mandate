import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/discovery.ts';
import { NoopJevAdvisor } from '../src/jev/noop-advisor.ts';
import { SequenceBook } from '../src/mandate/proposal-builder.ts';
import { runProtocol, ledgerView } from '../src/mandate/portfolio-adapter.ts';
import type { NegotiationRequest } from '../src/runtime/provider.ts';
import type { JsonObject } from '../src/runtime/strict-json.ts';
import { renderEvent } from '../src/telemetry/render.ts';
import { CONFLICTING, keep, propose, reduce, release, scriptedSession, type Negotiation } from './support/session.ts';

/** perps −200 (to 400), yield −200 (to 500), NFT releases 300, stock and swap keep: offers 700 against a need of 500. */
const cooperative: Negotiation = (r) => ({ text: r.role === 'perps' ? reduce(400) : r.role === 'yield' ? reduce(500) : r.role === 'nft' ? release : keep });

describe('the autonomous Mandate Room', () => {
  it('tests 20–23, 31: a resource conflict enters the Room; KEEP, REDUCE and RELEASE; the result is re-verified and reserved', async () => {
    const t = await scriptedSession(CONFLICTING, cooperative);
    const result = await t.session.run();
    const conflict = t.of('PORTFOLIO_CONFLICT')[0];
    assert.ok(conflict);
    assert.equal((conflict.data['portfolioNotionalRequiredReduction'] as { amount: string }).amount, '500');
    assert.equal(t.of('ROOM_OPENED').length, 1);
    assert.equal(t.of('ROOM_OPENED')[0]?.data['autonomous'], true);
    assert.deepEqual(t.of('ROOM_REDUCTION').map((e) => e.agent).sort(), ['perps', 'yield']);
    assert.deepEqual(t.of('ROOM_RELEASE').map((e) => e.agent), ['nft']);
    assert.ok(t.of('ROOM_KEEP').length >= 1);
    assert.equal(t.of('ROOM_PROPOSAL_CREATED').length, 1);
    // Test 31: the Room's output goes through the real Mandate path.
    const reverify = t.kinds().indexOf('MANDATE_REVERIFY_STARTED');
    assert.ok(reverify > t.kinds().indexOf('ROOM_FINALIZED'));
    assert.equal(result.status, 'AUTHORIZED');
    assert.equal(result.reservedAtoms, 1_800_000_000n);
    assert.deepEqual(result.final.map((f) => [f.role, f.outcome]).sort(), [['perps', 'RESERVED'], ['stock', 'RESERVED'], ['swap', 'RESERVED'], ['yield', 'RESERVED']]);
    const auth = t.of('PORTFOLIO_AUTHORIZED')[0];
    assert.equal(auth?.data['verification'], 'VERIFIED');
    assert.equal(auth?.data['transactions'], 0);
  });

  it('test 19: a security-invalid proposal stays outside the Room', async () => {
    const t = await scriptedSession({ ...CONFLICTING, swap: { text: propose('route-b', 300) } }, cooperative);
    await t.session.run();
    assert.equal(t.of('PROPOSAL_BLOCKED')[0]?.agent, 'swap');
    const participants = (t.of('ROOM_OPENED')[0]?.data['participants'] as { role: string }[]).map((p) => p.role);
    assert.ok(!participants.includes('swap'));
    assert.ok(t.provider.requests.filter((r) => r.kind === 'NEGOTIATION').every((r) => r.kind === 'NEGOTIATION' && r.role !== 'swap'));
    assert.deepEqual(t.of('PORTFOLIO_CONFLICT')[0]?.data['excludedAtScreening'], ['swap']);
  });

  it('no conflict, no Room: fitting requests go straight to re-verification', async () => {
    const t = await scriptedSession({ stock: { text: propose('nvda-note-a', 300) }, yield: { text: propose('alpha-usd-vault', 300) } });
    const result = await t.session.run();
    assert.equal(t.of('ROOM_OPENED').length, 0);
    assert.equal(result.status, 'AUTHORIZED');
    assert.equal(result.reservedAtoms, 600_000_000n);
  });

  it('test 24: when the offers do not cover the need, there is no feasible portfolio and nothing executes', async () => {
    // Agents collectively release only 100 against a need of 500.
    const t = await scriptedSession(CONFLICTING, (r) => ({ text: r.role === 'yield' ? reduce(600) : keep }), { maxGenerations: 2 });
    const before = await ledgerView(t.session.versions.active!.core);
    const result = await t.session.run();
    assert.equal(result.status, 'NO_FEASIBLE_PORTFOLIO');
    assert.equal(t.of('ROOM_NO_FEASIBLE_PORTFOLIO').length, 1);
    assert.equal(t.of('ROOM_NO_FEASIBLE_PORTFOLIO')[0]?.data['execution'], 'NONE');
    assert.equal(t.of('MANDATE_REVERIFY_STARTED').length, 0);
    assert.equal(t.of('ROOM_GENERATION_STARTED').length, 2);
    assert.equal(result.executorCalls, 0);
    assert.deepEqual(await ledgerView(t.session.versions.active!.core), before);
  });

  it('tests 25, 27: the Room finalizes without waiting for a slow agent, and its late reply is ignored', async () => {
    const slowStock: Negotiation = (r) => (r.role === 'stock' ? { text: reduce(100), delayMs: 300 } : { ...cooperative(r), delayMs: 10 });
    const t = await scriptedSession(CONFLICTING, slowStock);
    const result = await t.session.run();
    assert.equal(result.status, 'AUTHORIZED');
    // Stock never answered in time: unchanged, not forced, not treated as releasing.
    assert.equal(result.final.find((f) => f.role === 'stock')?.requested, 600_000_000n);
    await t.session.complete();
    const late = t.of('ROOM_AGENT_STALE_RESPONSE');
    assert.equal(late.length, 1);
    assert.equal(late[0]?.agent, 'stock');
    assert.equal(late[0]?.data['reason'], 'ROOM_FINALIZED');
    assert.equal(late[0]?.data['effect'], 'IGNORED');
    assert.ok(t.kinds().indexOf('ROOM_AGENT_STALE_RESPONSE') > t.kinds().indexOf('PORTFOLIO_AUTHORIZED'));
    // Its 100 never reached anything.
    assert.equal(result.reservedAtoms, 1_800_000_000n);
  });

  it('test 32: model unanimity cannot exceed authority', async () => {
    // Every agent "agrees" to keep everything: no feasible portfolio, nothing executes.
    const t = await scriptedSession(CONFLICTING, () => ({ text: keep }), { maxGenerations: 1 });
    assert.equal((await t.session.run()).status, 'NO_FEASIBLE_PORTFOLIO');
    // Handed to Mandate anyway, the agreed over-limit proposals stop at the principal's limit: the real Room and ledger decide.
    const u = await scriptedSession(CONFLICTING);
    const active = u.session.versions.active!;
    const deps = { provider: u.provider, jev: new NoopJevAdvisor(), clock: u.session.clock, events: u.session.events, signers: u.session.signers, sequences: new SequenceBook(), protocolNow: u.time.read, timeoutMs: 1_000, current: () => u.session.versions.active };
    const found = await discover(deps, active, ['stock', 'swap', 'nft', 'yield', 'perps']);
    const run = await runProtocol(active.core, active.signature, u.time.now, found.flatMap((o) => (o.signed === null ? [] : [o.signed])));
    assert.ok(run.run.reservations.filter((r) => r.status === 'RESERVED').length < 5);
    const reserved = run.run.after.reserved.find((x) => x.resource === 'portfolio-notional')?.atoms ?? 0n;
    assert.ok(reserved <= 2_000_000_000n, `reserved ${reserved}`);
    const derivative = run.run.after.reserved.find((x) => x.resource === 'derivative-notional')?.atoms ?? 0n;
    assert.ok(derivative <= 400_000_000n, `derivative ${derivative}`);
  });

  it('a negotiation answer that is malformed or speaks for another agent changes nothing', async () => {
    const t = await scriptedSession(CONFLICTING, (r: NegotiationRequest) => ({ text: r.role === 'perps' ? '{"action":"REDUCE","newRequestedAtoms":"400000000","rationale":"x","for":"stock"}' : r.role === 'yield' ? reduce(900) : keep }), { maxGenerations: 1 });
    const result = await t.session.run();
    assert.equal(result.status, 'NO_FEASIBLE_PORTFOLIO');
    const statuses = t.of('ROOM_AGENT_RESPONSE').filter((e) => e.data['status'] === 'INVALID_RESPONSE').map((e) => e.agent).sort();
    assert.deepEqual(statuses, ['perps', 'yield']);
  });
});

/** Stock 600 and Perps 600: 1,200 of 2,000 portfolio notional, but 600 of 400 derivative notional. */
const DERIVATIVE_ONLY = { stock: { text: propose('nvda-note-a', 600) }, perps: { text: propose('btc-long-2x', 600) } };
const perpsTo400: Negotiation = (r) => ({ text: r.role === 'perps' ? reduce(400) : keep });
const conflictsIn = (data: JsonObject) => (data['conflicts'] as JsonObject[]).map((c) => ({ ...c }));
const amt = (v: unknown) => (v as { amount: string }).amount;

describe('B.5.1: typed-resource conflicts in MANDATE_LIVE_AI.V1', () => {
  it('total capital under its limit, derivative notional over: consumers see a 200 USDC derivative conflict, not $0', async () => {
    const t = await scriptedSession(DERIVATIVE_ONLY, perpsTo400);
    await t.session.run();
    for (const kind of ['PORTFOLIO_CONFLICT', 'ROOM_OPENED', 'ROOM_GENERATION_STARTED'] as const) {
      const data = t.of(kind)[0]?.data;
      assert.ok(data, kind);
      // Portfolio notional is under its limit, and says so under its own name.
      assert.equal(amt(data['admissibleDemand']), '1200', kind);
      assert.equal(amt(data['authority'] ?? { amount: '2000' }), '2000', kind);
      assert.equal(amt(data['portfolioNotionalRequiredReduction']), '0', kind);
      // No generic scalar that would read as "required reduction: 0".
      assert.equal(data['requiredReduction'], undefined, kind);
      const cs = conflictsIn(data);
      assert.equal(cs.length, 1, kind);
      assert.equal(cs[0]?.['resource'], 'derivative-notional', kind);
      assert.deepEqual([amt(cs[0]?.['demand']), amt(cs[0]?.['authority']), amt(cs[0]?.['requiredReduction'])], ['600', '400', '200'], kind);
      // Taken from the constraint list, not recomputed.
      const line = (data['constraints'] as JsonObject[]).find((l) => l['resource'] === 'derivative-notional');
      assert.equal((cs[0]?.['requiredReduction'] as JsonObject)['atoms'], line?.['requiredReductionAtoms'], kind);
      assert.match(renderEvent(t.of(kind)[0]!), /derivative-notional 600 > 400 USDC \(reduce 200\)/, kind);
    }
  });

  it('after Perps reduces 600 → 400 the derivative conflict is SATISFIED in ROOM_PROPOSAL_CREATED', async () => {
    const t = await scriptedSession(DERIVATIVE_ONLY, perpsTo400);
    const result = await t.session.run();
    assert.equal(result.status, 'AUTHORIZED');
    const created = t.of('ROOM_PROPOSAL_CREATED')[0];
    assert.ok(created);
    assert.equal(created.data['requiredReduction'], undefined);
    const perps = (created.data['requests'] as JsonObject[]).find((r) => r['role'] === 'perps');
    assert.deepEqual([amt(perps?.['from']), amt(perps?.['to'])], ['600', '400']);
    const cs = conflictsIn(created.data);
    assert.equal(cs.length, 1);
    assert.equal(cs[0]?.['resource'], 'derivative-notional');
    assert.deepEqual([amt(cs[0]?.['demand']), amt(cs[0]?.['requiredReduction']), amt(cs[0]?.['demandAfter']), amt(cs[0]?.['remainingReduction'])], ['600', '200', '400', '0']);
    assert.equal(cs[0]?.['status'], 'SATISFIED');
    assert.match(renderEvent(created), /perps 600 USDC→400 USDC.*derivative-notional 600 → 400 ≤ 400 USDC SATISFIED/);
  });

  it('conflicts in incomparable resources are listed separately, never summed', async () => {
    // CONFLICTING: portfolio notional 2,500 of 2,000 (reduce 500) and derivative notional 600 of 400 (reduce 200).
    const t = await scriptedSession(CONFLICTING, cooperative);
    await t.session.run();
    for (const kind of ['PORTFOLIO_CONFLICT', 'ROOM_OPENED', 'ROOM_GENERATION_STARTED', 'ROOM_PROPOSAL_CREATED'] as const) {
      const data = t.of(kind)[0]!.data;
      const cs = conflictsIn(data);
      assert.deepEqual(cs.map((c) => [c['resource'], amt(c['requiredReduction'])]).sort(), [['derivative-notional', '200'], ['portfolio-notional', '500']], kind);
      assert.equal(amt(data['portfolioNotionalRequiredReduction']), '500', kind);
      assert.equal(data['requiredReduction'], undefined, kind);
      // The only top-level required reduction is portfolio notional's, by name; there is no 700 aggregate.
      assert.deepEqual(Object.keys(data).filter((k) => /required/i.test(k)), ['portfolioNotionalRequiredReduction'], kind);
    }
    assert.ok(conflictsIn(t.of('ROOM_PROPOSAL_CREATED')[0]!.data).every((c) => c['status'] === 'SATISFIED'));
  });

  it('a Room that cannot resolve a conflict reports it UNRESOLVED, by resource', async () => {
    const t = await scriptedSession(DERIVATIVE_ONLY, () => ({ text: keep }), { maxGenerations: 1 });
    const result = await t.session.run();
    assert.equal(result.status, 'NO_FEASIBLE_PORTFOLIO');
    const nf = t.of('ROOM_NO_FEASIBLE_PORTFOLIO')[0]!;
    const cs = conflictsIn(nf.data);
    assert.deepEqual(cs.map((c) => [c['resource'], amt(c['remainingReduction']), c['status']]), [['derivative-notional', '200', 'UNRESOLVED']]);
    assert.match(renderEvent(nf), /still over: derivative-notional 600 > 400 USDC \(reduce 200\)/);
  });
});
