import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/discovery.ts';
import { NoopJevAdvisor } from '../src/jev/noop-advisor.ts';
import { SequenceBook } from '../src/mandate/proposal-builder.ts';
import { runProtocol, ledgerView } from '../src/mandate/portfolio-adapter.ts';
import type { NegotiationRequest } from '../src/runtime/provider.ts';
import type { JsonObject } from '../src/runtime/strict-json.ts';
import { renderEvent } from '../src/telemetry/render.ts';
import { CONFLICTING, abstain, keep, propose, reduce, release, scriptedSession, type Negotiation } from './support/session.ts';
import { WIDE_PERPS, everyCandidate } from './support/world.ts';
import { presetDraft, withField } from '../src/authoring/draft-types.ts';

/** yield −200 (to 600) and perps −100 (to 300): together exactly the 300 needed; stock, swap and NFT keep. */
const cooperative: Negotiation = (r) => ({ text: r.role === 'yield' ? reduce(600) : r.role === 'perps' ? reduce(300) : keep });
/** The balanced preset with 2,000 deployable: four valid agents still compete for capital when a fifth is blocked. */
const TIGHT = withField(presetDraft('balanced'), 'portfolio.maxDeployed', '2000', 'USER');
const ROOM_KINDS = ['ROOM_OPENED', 'ROOM_GENERATION_STARTED', 'ROOM_AGENT_RESPONSE', 'ROOM_PROPOSAL_CREATED', 'ROOM_FINALIZED', 'ROOM_NO_FEASIBLE_PORTFOLIO'] as const;

describe('the autonomous Mandate Room', () => {
  it('tests 20–23, 31: a resource conflict enters the Room; KEEP, REDUCE and RELEASE; the result is re-verified and reserved', async () => {
    const t = await scriptedSession(CONFLICTING, cooperative);
    const result = await t.session.run();
    const conflict = t.of('PORTFOLIO_CONFLICT')[0];
    assert.ok(conflict);
    assert.equal((conflict.data['portfolioNotionalRequiredReduction'] as { amount: string }).amount, '300');
    assert.equal(conflict.data['classification'], 'SHARED_CONFLICT');
    assert.equal(conflict.data['roomPurpose'], 'SHARED_RESOURCE_COORDINATION');
    assert.equal(t.of('ROOM_OPENED').length, 1);
    assert.equal(t.of('ROOM_OPENED')[0]?.data['autonomous'], true);
    assert.equal(t.of('ROOM_OPENED')[0]?.data['roomPurpose'], 'SHARED_RESOURCE_COORDINATION');
    assert.deepEqual(t.of('ROOM_REDUCTION').map((e) => e.agent).sort(), ['perps', 'yield']);
    assert.ok(t.of('ROOM_KEEP').length >= 1);
    assert.equal(t.of('ROOM_PROPOSAL_CREATED').length, 1);
    // Test 31: the Room's output goes through the real Mandate path.
    const reverify = t.kinds().indexOf('MANDATE_REVERIFY_STARTED');
    assert.ok(reverify > t.kinds().indexOf('ROOM_FINALIZED'));
    assert.equal(result.status, 'AUTHORIZED');
    assert.equal(result.reservedAtoms, 2_500_000_000n);
    assert.deepEqual(result.final.map((f) => [f.role, f.outcome]).sort(), [['nft', 'RESERVED'], ['perps', 'RESERVED'], ['stock', 'RESERVED'], ['swap', 'RESERVED'], ['yield', 'RESERVED']]);
    const auth = t.of('PORTFOLIO_AUTHORIZED')[0];
    assert.equal(auth?.data['verification'], 'VERIFIED');
    assert.equal(auth?.data['transactions'], 0);
  });

  it('RELEASE: an agent may withdraw its whole request, and that alone can resolve the conflict', async () => {
    const t = await scriptedSession(CONFLICTING, (r) => ({ text: r.role === 'nft' ? release : keep }));
    const result = await t.session.run();
    assert.deepEqual(t.of('ROOM_RELEASE').map((e) => e.agent), ['nft']);
    assert.equal(result.reservedAtoms, 2_500_000_000n);
    assert.equal(result.final.some((f) => f.role === 'nft'), false);
  });

  it('test 12 / 19: a security-invalid proposal is blocked and stays outside the Room (eligibility bypassed, so it reaches Mandate)', async () => {
    const t = await scriptedSession({ ...CONFLICTING, swap: { text: propose('route-b', 300) } }, cooperative, { eligibility: everyCandidate, settlement: null, draft: TIGHT });
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
    // Agents collectively release only 100 against a need of 300.
    const t = await scriptedSession(CONFLICTING, (r) => ({ text: r.role === 'yield' ? reduce(700) : keep }), { maxGenerations: 2 });
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
    assert.equal(result.final.find((f) => f.role === 'stock')?.requested, 800_000_000n);
    await t.session.complete();
    const late = t.of('ROOM_AGENT_STALE_RESPONSE');
    assert.equal(late.length, 1);
    assert.equal(late[0]?.agent, 'stock');
    assert.equal(late[0]?.data['reason'], 'ROOM_FINALIZED');
    assert.equal(late[0]?.data['effect'], 'IGNORED');
    assert.ok(t.kinds().indexOf('ROOM_AGENT_STALE_RESPONSE') > t.kinds().indexOf('PORTFOLIO_AUTHORIZED'));
    // Its 100 never reached anything.
    assert.equal(result.reservedAtoms, 2_500_000_000n);
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
    assert.ok(reserved <= 2_500_000_000n, `reserved ${reserved}`);
    const derivative = run.run.after.reserved.find((x) => x.resource === 'derivative-notional')?.atoms ?? 0n;
    assert.ok(derivative <= 400_000_000n, `derivative ${derivative}`);
  });

  it('a negotiation answer that is malformed or speaks for another agent changes nothing', async () => {
    const t = await scriptedSession(CONFLICTING, (r: NegotiationRequest) => ({ text: r.role === 'perps' ? '{"action":"REDUCE","newRequestedAtoms":"300000000","rationale":"x","for":"stock"}' : r.role === 'yield' ? reduce(900) : keep }), { maxGenerations: 1 });
    const result = await t.session.run();
    assert.equal(result.status, 'NO_FEASIBLE_PORTFOLIO');
    const statuses = t.of('ROOM_AGENT_RESPONSE').filter((e) => e.data['status'] === 'INVALID_RESPONSE').map((e) => e.agent).sort();
    assert.deepEqual(statuses, ['perps', 'yield']);
  });
});

/**
 * Stock 600 and Perps 600 under WIDE_PERPS (perps may take 600 itself): 1,200
 * of 2,500 portfolio notional, but 600 of 400 derivative notional — a limit
 * only the perps agent's request uses. Nobody to negotiate with: a local
 * excess, never a Room (docs/v2/mandate-room-v2.md §8.1).
 */
const wide = { draft: WIDE_PERPS } as const;
const perpsReplans = (second: string) => (role: string, call: number) => (role === 'stock' ? { text: propose('nvda-note-a', 600) } : role === 'perps' ? { text: call === 0 ? propose('btc-long-2x', 600) : second } : { text: abstain });
const noRoom = () => {
  throw new Error('no negotiation may be asked for');
};
const conflictsIn = (data: JsonObject) => (data['conflicts'] as JsonObject[]).map((c) => ({ ...c }));
const amt = (v: unknown) => (v as { amount: string }).amount;

describe('Room V2: a single agent over its own limit is a local re-plan, never a Room', () => {
  it('test 7: one Perps request over the derivative limit: no Room, one bounded re-plan, re-screened, reserved', async () => {
    const t = await scriptedSession(perpsReplans(propose('btc-long-2x', 400)), noRoom, wide);
    const result = await t.session.run();
    for (const kind of [...ROOM_KINDS, 'PORTFOLIO_CONFLICT'] as const) assert.equal(t.of(kind).length, 0, kind);
    const replan = t.of('AGENT_LOCAL_REPLAN_REQUESTED');
    assert.equal(replan.length, 1);
    assert.equal(replan[0]?.agent, 'perps');
    const excess = (replan[0]?.data['excess'] as JsonObject[])[0];
    assert.equal(excess?.['resource'], 'derivative-notional');
    assert.ok(['OWN_LIMIT', 'SOLE_DEMANDER'].includes(String(excess?.['cause'])));
    assert.deepEqual([amt(excess?.['demand']), amt(excess?.['limit']), amt(replan[0]?.data['largestFitting'])], ['600', '400', '400']);
    assert.match(String(replan[0]?.data['room']), /NONE/);
    // The second decision saw its own constraint and a candidate bounded to what fits.
    const second = t.provider.requests.filter((r) => r.kind === 'DECISION' && r.role === 'perps')[1];
    assert.ok(second?.kind === 'DECISION' && second.localConstraint?.resource === 'derivative-notional');
    assert.ok(second?.kind === 'DECISION' && second.candidates.every((c) => BigInt(c.maxAtoms) <= 400_000_000n));
    assert.equal(t.of('PROPOSAL_ADMISSIBLE').filter((e) => e.agent === 'perps').length, 2, 'screened in full again');
    assert.equal(result.status, 'AUTHORIZED');
    assert.deepEqual(result.final.map((f) => [f.role, f.requested]).sort(), [['perps', 400_000_000n], ['stock', 600_000_000n]]);
  });

  it('a re-plan that abstains is refused locally; the others proceed; no Room', async () => {
    const t = await scriptedSession(perpsReplans(abstain), noRoom, wide);
    const result = await t.session.run();
    for (const kind of ROOM_KINDS) assert.equal(t.of(kind).length, 0, kind);
    assert.equal(t.of('AGENT_LOCAL_REFUSED')[0]?.data['reason'], 'ABSTAINED_ON_REPLAN');
    assert.deepEqual(result.final.map((f) => f.role), ['stock']);
  });

  it('a re-plan answered outside its bound is invalid and refused: never clamped, never a Room', async () => {
    const t = await scriptedSession(perpsReplans(propose('btc-long-2x', 600)), noRoom, wide);
    const result = await t.session.run();
    for (const kind of ROOM_KINDS) assert.equal(t.of(kind).length, 0, kind);
    assert.equal(t.of('AGENT_LOCAL_REFUSED')[0]?.data['reason'], 'REPLAN_INVALID_RESPONSE');
    assert.deepEqual(result.final.map((f) => f.role), ['stock']);
  });

  it('test 8: one valid agent alone never opens a coordination Room, whatever it asks', async () => {
    const t = await scriptedSession((role, call) => (role === 'perps' ? { text: propose('btc-long-2x', call === 0 ? 600 : 300) } : { text: abstain }), noRoom, wide);
    const result = await t.session.run();
    for (const kind of ROOM_KINDS) assert.equal(t.of(kind).length, 0, kind);
    assert.equal(result.status, 'AUTHORIZED');
  });
});

describe('B.5.1: typed-resource conflicts in MANDATE_LIVE_AI.V1', () => {
  it('conflicts are listed per resource, never summed, with no generic required reduction', async () => {
    const t = await scriptedSession(CONFLICTING, cooperative);
    await t.session.run();
    for (const kind of ['PORTFOLIO_CONFLICT', 'ROOM_OPENED', 'ROOM_GENERATION_STARTED', 'ROOM_PROPOSAL_CREATED'] as const) {
      const data = t.of(kind)[0]!.data;
      const cs = conflictsIn(data);
      assert.deepEqual(cs.map((c) => [c['resource'], amt(c['requiredReduction'])]), [['portfolio-notional', '300']], kind);
      assert.equal(amt(data['portfolioNotionalRequiredReduction']), '300', kind);
      assert.equal(data['requiredReduction'], undefined, kind);
      assert.deepEqual(Object.keys(data).filter((k) => /required/i.test(k)), ['portfolioNotionalRequiredReduction'], kind);
    }
    assert.match(renderEvent(t.of('PORTFOLIO_CONFLICT')[0]!), /portfolio-notional 2800 > 2500 USDC \(reduce 300\)/);
    assert.ok(conflictsIn(t.of('ROOM_PROPOSAL_CREATED')[0]!.data).every((c) => c['status'] === 'SATISFIED'));
  });

  it('a Room that cannot resolve a conflict reports it UNRESOLVED, by resource', async () => {
    const t = await scriptedSession(CONFLICTING, () => ({ text: keep }), { maxGenerations: 1 });
    const result = await t.session.run();
    assert.equal(result.status, 'NO_FEASIBLE_PORTFOLIO');
    const nf = t.of('ROOM_NO_FEASIBLE_PORTFOLIO')[0]!;
    const cs = conflictsIn(nf.data);
    assert.deepEqual(cs.map((c) => [c['resource'], amt(c['remainingReduction']), c['status']]), [['portfolio-notional', '300', 'UNRESOLVED']]);
    assert.match(renderEvent(nf), /still over: portfolio-notional 2800 > 2500 USDC \(reduce 300\)/);
  });
});
