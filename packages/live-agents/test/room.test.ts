import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/discovery.ts';
import { NoopJevAdvisor } from '../src/jev/noop-advisor.ts';
import { SequenceBook } from '../src/mandate/proposal-builder.ts';
import { runProtocol, ledgerView } from '../src/mandate/portfolio-adapter.ts';
import type { NegotiationRequest } from '../src/runtime/provider.ts';
import { CONFLICTING, keep, propose, reduce, release, scriptedSession, type Negotiation } from './support/session.ts';

/** perps −200 (to 400), yield −200 (to 500), NFT releases 300, stock and swap keep: offers 700 against a need of 500. */
const cooperative: Negotiation = (r) => ({ text: r.role === 'perps' ? reduce(400) : r.role === 'yield' ? reduce(500) : r.role === 'nft' ? release : keep });

describe('the autonomous Mandate Room', () => {
  it('tests 20–23, 31: a resource conflict enters the Room; KEEP, REDUCE and RELEASE; the result is re-verified and reserved', async () => {
    const t = await scriptedSession(CONFLICTING, cooperative);
    const result = await t.session.run();
    const conflict = t.of('PORTFOLIO_CONFLICT')[0];
    assert.ok(conflict);
    assert.equal((conflict.data['requiredReduction'] as { amount: string }).amount, '500');
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
