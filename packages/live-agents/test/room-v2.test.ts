/**
 * Room V2 authority and reallocation (docs/v2/mandate-room-v2.md §8).
 *
 * - a shared conflict opens a Room only when the principal authorized
 *   coordination; a fixed split never meets one;
 * - a Room can never add an agent, exceed the signed total or an agent's
 *   signed maximum;
 * - after authorization, unused capital moves only with signed permission,
 *   only from what the ledger says is free, only up to signed ceilings — and
 *   what nobody can use stays in the wallet.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPreset, withField, type MandateDraft } from '../src/authoring/draft-types.ts';
import { draftFromInterpretation, interpretLocally } from '../src/authoring/prompt-to-draft.ts';
import { ledgerView } from '../src/mandate/portfolio-adapter.ts';
import { classifyConflict } from '../src/room/classify.ts';
import type { Fit, Participant } from '../src/room/negotiation.ts';
import type { OpportunityRequest } from '../src/runtime/provider.ts';
import { LiveSession } from '../src/session.ts';
import type { Role } from '../src/types.ts';
import { DEMO_NOW } from '@mandate/portfolio/demo';
import { validateDraft } from '../src/authoring/draft-validator.ts';
import { sessionBindings } from '../src/mandate/portfolio-adapter.ts';
import { ScriptedProvider, json } from './support/providers.ts';
import { abstain, keep, propose } from './support/session.ts';
import { TestTime } from './support/world.ts';

const U = (whole: number) => BigInt(whole) * 1_000_000n;
const fromPrompt = (prompt: string): MandateDraft => applyPreset(draftFromInterpretation(interpretLocally(prompt)), 'balanced', true).draft;

/** The brief's example: budgets 700 / 350 / 650 / 300 of 2,000, ceilings 1,000 / 600 / 800 / 400. */
function envelope(auto: boolean, ceilings: { readonly [R in Role]?: string } = { stock: '1000', swap: '600', yield: '800', perps: '400' }): MandateDraft {
  let d = fromPrompt('$2,000. Stock $700, Swap $350, Yield $650, Perps $300.');
  d = withField(d, 'portfolio.autoReallocate', auto, 'USER');
  for (const [r, v] of Object.entries(ceilings)) d = withField(d, `agents.${r}.maxAllocation`, v, 'USER');
  if (ceilings.stock !== undefined) d = withField(d, 'agents.stock.maxExposure', ceilings.stock, 'USER');
  return d;
}

const MOVES: { readonly [R in Role]?: string } = { stock: propose('nvda-note-a', 700), swap: propose('route-a', 350), yield: abstain, perps: propose('btc-long-2x', 300) };
/** A reallocation card: the agent's own candidate, as much as it is offered. */
const takeAll = (r: OpportunityRequest) => {
  const c = r.candidates[0];
  return c === undefined ? json({ action: 'ABSTAIN', candidateId: null, requestedAtoms: null, minimumUsefulAtoms: null, maximumUsefulAtoms: null, opportunityQuality: 0, liquidity: 0, executionQuality: 0, downsideRisk: 4, dataConfidence: 0, marketRegime: 'UNKNOWN', rationale: 'none' }) : json({ action: 'PROPOSE', candidateId: c.id, requestedAtoms: c.maxAtoms, minimumUsefulAtoms: c.minAtoms, maximumUsefulAtoms: c.maxAtoms, opportunityQuality: 3, liquidity: 3, executionQuality: 3, downsideRisk: 1, dataConfidence: 2, marketRegime: 'NEUTRAL', rationale: 'can use more' });
};

async function session(draft: MandateDraft, moves: { readonly [R in Role]?: string } = MOVES, stateDir?: string) {
  const time = new TestTime();
  const provider = new ScriptedProvider({
    decide: (r) => ({ text: moves[r.role] ?? abstain }),
    negotiate: () => ({ text: keep }),
    opportunity: (r) => ({ text: takeAll(r) }),
  });
  const s = new LiveSession({ provider, sessionId: 'v2', agentTimeoutMs: 500, roomRoundTimeoutMs: 500, protocolNow: time.read, ...(stateDir === undefined ? {} : { stateDir }) });
  const a = await s.authorize(draft, 'AUTHORIZE MANDATE V1');
  if (!a.ok) throw new Error(`${a.code} ${a.issues.map((i) => i.code).join(',')}`);
  return { s, provider, time, of: (k: string) => s.events.events.filter((e) => e.kind === k) };
}

const ceiling = (s: LiveSession, role: Role) => s.versions.active?.mandate.agents.find((a) => a.label === role)?.hardMaxima.find((h) => h.resource === 'portfolio-notional')?.atoms ?? 0n;
const reservedOf = (s: LiveSession, role: Role) => s.reservedExecutions.filter((x) => x.role === role).reduce((t, x) => t + (x.signed.proposal.requested.find((a) => a.resource === 'portfolio-notional')?.atoms ?? 0n), 0n);

describe('Room V2: who may open a Room', () => {
  const p = (role: Role) => ({ role }) as unknown as Participant;
  const fit: Fit = { feasible: false, lines: [{ resource: 'portfolio-notional', authorityAtoms: '1000', demandAtoms: '1400', requiredReductionAtoms: '400' }], agentExcess: [], demandAtoms: 1400n, authorityAtoms: 1000n, requiredAtoms: 400n };
  const demandAt = () => [{ resource: 'portfolio-notional', atoms: 700n }] as never;

  it('test 10: two valid agents competing for one shared resource, with coordination authorized, may open a Room', () => {
    const c = classifyConflict(fit, [p('stock'), p('yield')], new Map([['stock', 700n], ['yield', 700n]]), demandAt, true);
    assert.deepEqual([c.kind, c.roomPurpose, c.handling], ['SHARED_CONFLICT', 'SHARED_RESOURCE_COORDINATION', 'ROOM']);
  });

  it('test 11: the same conflict without coordination authority opens no Room: the verifier refuses deterministically', () => {
    const c = classifyConflict(fit, [p('stock'), p('yield')], new Map([['stock', 700n], ['yield', 700n]]), demandAt, false);
    assert.deepEqual([c.kind, c.roomPurpose, c.handling], ['SHARED_CONFLICT', null, 'DETERMINISTIC_REFUSAL']);
    // And a fixed split that would collide can never be signed in the first place.
    const fixed = fromPrompt('$2,500. Stock $800, Swap $500, NFT $300, Yield $800, Perps $400.');
    const v = validateDraft(fixed, { version: 1, protocolNow: DEMO_NOW, bindings: sessionBindings() });
    assert.ok(v.issues.some((i) => i.code === 'ALLOCATION_EXCEEDS_TOTAL'));
  });

  it('test 9: valid proposals that fit go straight to the verifier, whatever the mode', () => {
    const fits: Fit = { ...fit, feasible: true };
    assert.equal(classifyConflict(fits, [p('stock'), p('yield')], new Map(), demandAt, true).handling, 'DIRECT');
  });

  it('a fixed split runs with no Room at all: each agent is bounded by its budget', async () => {
    const t = await session(envelope(false), { stock: propose('nvda-note-a', 800), swap: propose('route-a', 350), yield: propose('alpha-usd-vault', 650), perps: propose('btc-long-2x', 300) });
    const result = await t.s.run();
    for (const k of ['ROOM_OPENED', 'PORTFOLIO_CONFLICT']) assert.equal(t.of(k).length, 0, k);
    // The stock agent was offered at most its 700 budget, so its 800 answer was refused as outside bounds — never clamped.
    const stockRequest = t.provider.requests.find((r) => r.kind === 'DECISION' && r.role === 'stock');
    assert.ok(stockRequest?.kind === 'DECISION' && stockRequest.budgetAtoms === U(700).toString() && stockRequest.candidates.every((c) => BigInt(c.maxAtoms) <= U(700)));
    assert.equal(result.final.some((f) => f.role === 'stock'), false);
    assert.equal(ceiling(t.s, 'stock'), U(700), 'without reallocation the signed maximum is the budget');
  });
});

describe('Room V2: reallocation after authorization', () => {
  it('test 24: reallocation not authorized — released capital stays unallocated, no Room', async () => {
    const t = await session(envelope(false));
    const before = (await ledgerView(t.s.versions.active!.core)).reservations.length;
    const result = await t.s.run();
    assert.equal(t.of('ROOM_OPENED').length, 0);
    const unused = t.of('CAPITAL_UNUSED')[0];
    assert.equal(unused?.data['reallocation'], 'NOT_AUTHORIZED');
    assert.equal((unused?.data['total'] as { amount: string }).amount, '650');
    assert.match(String(unused?.data['effect']), /wallet/);
    assert.doesNotMatch(String(unused?.data['effect']), /was refunded|refund issued/);
    assert.deepEqual(result.reallocated, []);
    assert.equal(t.s.reallocationRecords.length, 0);
    assert.equal((await ledgerView(t.s.versions.active!.core)).reservations.length, before + 3);
  });

  it('test 25 / 28: reallocation authorized — released capital is reassigned inside every signed maximum and re-verified', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mandate-lineage-'));
    const t = await session(envelope(true), MOVES, dir);
    const result = await t.s.run();
    const opened = t.of('ROOM_OPENED');
    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.data['roomPurpose'], 'REALLOCATION');
    assert.equal((opened[0]?.data['pool'] as { amount: string }).amount, '650');
    assert.deepEqual((opened[0]?.data['released'] as { role: string }[]).map((x) => x.role), ['yield']);
    // Only agents holding a reservation are asked; the abstainer is never given capital.
    const asked = t.provider.requests.filter((r) => r.kind === 'OPPORTUNITY').map((r) => r.role).sort();
    assert.deepEqual(asked, ['perps', 'stock', 'swap']);
    assert.ok(result.reallocated.length > 0);
    assert.ok(result.reallocated.every((p) => p.outcome === 'RESERVED'), JSON.stringify(result.reallocated.map((p) => [p.role, p.outcome, p.reasons])));
    assert.ok(t.s.events.events.findIndex((e) => e.kind === 'MANDATE_REVERIFY_STARTED' && e.data['phase'] === 'REALLOCATION') > t.s.events.events.findIndex((e) => e.kind === 'ALLOCATION_PLAN_PROPOSED'));
    for (const r of ['stock', 'swap', 'perps'] as const) assert.ok(reservedOf(t.s, r) <= ceiling(t.s, r), r);
    assert.equal(reservedOf(t.s, 'yield'), 0n);
    const total = (['stock', 'swap', 'perps', 'yield'] as const).reduce((s, r) => s + reservedOf(t.s, r), 0n);
    assert.ok(total <= U(2000));
    // Stock: 700 reserved, its candidate's depth leaves 100; swap: 150 of route-a's depth; perps: 100 under the derivative limit.
    assert.deepEqual(result.reallocated.map((p) => [p.role, p.requested]).sort(), [['perps', U(100)], ['stock', U(100)], ['swap', U(150)]]);
    const leftover = t.of('CAPITAL_UNUSED').at(-1);
    assert.equal(leftover?.data['reallocation'], 'AUTHORIZED');
    const lineage = t.s.reallocationRecords[0];
    assert.ok(lineage !== undefined);
    assert.equal(lineage.initialAllocationDigest, t.s.planningRecords[0]?.initialAllocationDigest);
    assert.equal(lineage.previousPlanDigest, lineage.initialAllocationDigest);
    assert.notEqual(lineage.nextPlanDigest, lineage.previousPlanDigest);
    assert.deepEqual(lineage.released, [{ role: 'yield', atoms: U(650) }]);
    assert.deepEqual(lineage.assigned.map((x) => [x.role, x.atoms]).sort(), [['perps', U(100)], ['stock', U(100)], ['swap', U(150)]]);
    assert.equal(t.s.planningRecords[0]?.initialAllocationDigest, lineage.initialAllocationDigest, 'the signed initial digest is immutable');
    const repeat = await session(envelope(true));
    await repeat.s.run();
    assert.equal(repeat.s.reallocationRecords[0]?.nextPlanDigest, lineage.nextPlanDigest, 'the next plan digest is deterministic');
    t.s.close();
    const restored = await LiveSession.restore(dir, 'v2', { agentTimeoutMs: 500, roomRoundTimeoutMs: 500, by: 'test' });
    assert.deepEqual(restored.reallocationRecords, t.s.reallocationRecords, 'lineage is durable evidence');
    assert.equal(restored.planningRecords[0]?.initialAllocationDigest, lineage.initialAllocationDigest);
    restored.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('tests 26 / 27: capital already reserved (pending, unsettled) is never reassigned: only the ledger\'s free capital is', async () => {
    const moves: { [R in Role]?: string } = { ...MOVES };
    const t = await session(envelope(true), moves);
    await t.s.run();
    const firstRun = (await ledgerView(t.s.versions.active!.core)).reservations.map((r) => [r.id, r.status]);
    assert.ok(firstRun.length > 0);
    assert.ok(firstRun.every(([, status]) => status === 'ACTIVE' || status === 'RESERVED'), JSON.stringify(firstRun));
    // Run again under the same mandate: only stock proposes; the first run's reservations are still unresolved.
    for (const r of ['swap', 'yield', 'perps'] as const) moves[r] = abstain;
    moves.stock = propose('nvda-note-a', 100);
    await t.s.run();
    const realloc = t.of('ROOM_OPENED').filter((e) => e.data['roomPurpose'] === 'REALLOCATION').at(-1);
    // 1,300 of budgets went unused this run, but the ledger had only 200 free: the reserved 1,700 was never offered.
    assert.equal((realloc?.data['pool'] as { amount: string }).amount, '200');
    const after = new Map((await ledgerView(t.s.versions.active!.core)).reservations.map((r) => [r.id, r.status]));
    for (const [id, status] of firstRun) assert.equal(after.get(id as string), status, 'an earlier reservation is untouched');
    const total = (['stock', 'swap', 'yield', 'perps'] as const).reduce((s, r) => s + reservedOf(t.s, r), 0n);
    assert.ok(total <= U(2000));
  });

  it('test 29: when no agent can use the remainder, it stays in the wallet', async () => {
    const t = await session(envelope(true, { stock: '700', swap: '350', yield: '800', perps: '300' }));
    const result = await t.s.run();
    assert.equal(t.of('ROOM_OPENED').length, 0);
    assert.equal(t.of('REALLOCATION_SKIPPED')[0]?.data['reason'], 'NO_AGENT_CAN_USE_IT');
    assert.match(String(t.of('REALLOCATION_SKIPPED')[0]?.data['effect']), /wallet/);
    assert.deepEqual(result.reallocated, []);
  });

  it('tests 13–15: a Room cannot add an agent, exceed the signed total, or exceed an agent\'s signed maximum', async () => {
    const t = await session(envelope(true));
    await t.s.run();
    // 13: NFT has no authority in this mandate and is never asked, given, or reserved anything.
    assert.equal(t.provider.requests.some((r) => 'role' in r && r.role === 'nft'), false);
    assert.equal(t.s.reservedExecutions.some((x) => x.role === 'nft'), false);
    // 14: never above the signed total.
    const reserved = (await ledgerView(t.s.versions.active!.core)).reservations.length;
    assert.ok(reserved > 0);
    const after = t.s.versions.active!.mandate.limits.find((l) => l.resource === 'portfolio-notional')?.atoms ?? 0n;
    const all = (['stock', 'swap', 'yield', 'perps'] as const).reduce((s, r) => s + reservedOf(t.s, r), 0n);
    assert.ok(all <= after);
    // 15: never above an agent's own signed maximum (and the derivative limit for perps).
    for (const r of ['stock', 'swap', 'perps'] as const) assert.ok(reservedOf(t.s, r) <= ceiling(t.s, r), r);
    assert.ok(reservedOf(t.s, 'perps') <= U(400));
  });
});
