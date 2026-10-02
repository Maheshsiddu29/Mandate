/**
 * The Planning Room (docs/v2/mandate-room-v2.md §5): before signing, the
 * agents the principal left the split to analyze opportunities, and a
 * deterministic allocator proposes budgets. It signs nothing; the principal
 * may edit; one signature authorizes the final budgets.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyPreset, withField, type MandateDraft } from '../src/authoring/draft-types.ts';
import { draftFromInterpretation, interpretLocally } from '../src/authoring/prompt-to-draft.ts';
import type { OpportunityScorer, JevScore } from '../src/jev/scorer.ts';
import type { OpportunityRequest } from '../src/runtime/provider.ts';
import { LiveSession } from '../src/session.ts';
import type { Role } from '../src/types.ts';
import { ScriptedProvider, json, type Scripted } from './support/providers.ts';
import { TestTime } from './support/world.ts';

const U = (whole: number) => (BigInt(whole) * 1_000_000n).toString();
const fromPrompt = (prompt: string): MandateDraft => applyPreset(draftFromInterpretation(interpretLocally(prompt)), 'balanced', true).draft;
const DYNAMIC = '$2,000 across Stock, Swap, Yield and Perps. Prefer balanced risk-adjusted opportunities.';
const HYBRID = 'Deploy $2,000. Stock $800. Let Swap, Yield and Perps decide how to use the rest.';

const propose = (id: string, req: number, min: number, max: number, q = 3, risk = 1, conf = 2) =>
  json({ action: 'PROPOSE', candidateId: id, requestedAtoms: U(req), minimumUsefulAtoms: U(min), maximumUsefulAtoms: U(max), opportunityQuality: q, liquidity: 3, executionQuality: 3, downsideRisk: risk, dataConfidence: conf, marketRegime: 'NEUTRAL', rationale: `card for ${id}` });
const abstain = json({ action: 'ABSTAIN', candidateId: null, requestedAtoms: null, minimumUsefulAtoms: null, maximumUsefulAtoms: null, opportunityQuality: 0, liquidity: 0, executionQuality: 0, downsideRisk: 4, dataConfidence: 0, marketRegime: 'STRESSED', rationale: 'nothing meets the bar' });

const CARDS: { readonly [R in Role]?: string } = {
  stock: propose('nvda-note-a', 750, 100, 800, 4),
  swap: propose('route-a', 350, 100, 400, 2),
  yield: propose('alpha-usd-vault', 650, 100, 800, 4),
  perps: propose('btc-long-2x', 250, 100, 300, 2, 3),
};

function session(cards: { readonly [R in Role]?: string | Scripted } = CARDS, scorer?: OpportunityScorer) {
  const time = new TestTime();
  const provider = new ScriptedProvider({
    opportunity: (r: OpportunityRequest) => {
      const c = cards[r.role];
      return c === undefined ? { text: abstain } : typeof c === 'string' ? { text: c } : c;
    },
  });
  const s = new LiveSession({ provider, sessionId: 'plan-test', agentTimeoutMs: 500, roomRoundTimeoutMs: 500, protocolNow: time.read, ...(scorer === undefined ? {} : { scorer }) });
  const of = (kind: string) => s.events.events.filter((e) => e.kind === kind);
  return { s, time, provider, of };
}

describe('Planning Room', () => {
  it('36. DYNAMIC opens a Planning Room before any authorization, and proposes a split inside the pool', async () => {
    const t = session();
    const r = await t.s.plan(fromPrompt(DYNAMIC));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(t.s.versions.active, null, 'nothing is authorized');
    assert.equal(t.of('MANDATE_VERSION_AUTHORIZED').length, 0);
    const opened = t.of('ROOM_OPENED');
    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.data['roomPurpose'], 'INITIAL_ALLOCATION');
    assert.equal(opened[0]?.data['stage'], 'PRE_AUTHORIZATION');
    assert.equal(t.of('OPPORTUNITY_CARD_CREATED').length, 4);
    assert.equal(t.of('ALLOCATION_PLAN_PROPOSED').length, 1);
    assert.equal(t.of('ROOM_FINALIZED')[0]?.data['result'], 'PLAN_PROPOSED');
    // No proposal was signed, nothing was screened or reserved.
    for (const k of ['PROPOSAL_SIGNED', 'PORTFOLIO_AUTHORIZED', 'MANDATE_REVERIFY_STARTED']) assert.equal(t.of(k).length, 0, k);
    const p = r.plan;
    assert.equal(p.poolAtoms, 2_000_000_000n);
    assert.ok(p.allocatedAtoms <= p.poolAtoms);
    assert.equal(p.allocatedAtoms + p.unallocatedAtoms, p.poolAtoms);
    const by = Object.fromEntries(p.allocations.map((a) => [a.role, a.atoms]));
    assert.ok((by['stock'] as bigint) > (by['swap'] as bigint), 'stronger cards receive more');
    assert.ok((by['perps'] as bigint) <= 300_000_000n, 'never above maximum useful');
  });

  it('35. FIXED never opens a Planning Room', async () => {
    const t = session();
    const r = await t.s.plan(fromPrompt('$2,000. Stock $800, Swap $400, Yield $500, Perps $300.'));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'NOTHING_TO_PLAN');
    assert.equal(t.of('ROOM_OPENED').length, 0);
    assert.equal(t.provider.requests.length, 0, 'no model was asked');
  });

  it('total-only drafts ask for agent selection instead of planning', async () => {
    const t = session();
    const r = await t.s.plan(fromPrompt('Manage $2,000'));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, /Choose which agents/);
  });

  it('an abstaining agent receives zero and its capital stays unallocated', async () => {
    const t = session({ ...CARDS, yield: abstain });
    const r = await t.s.plan(fromPrompt(DYNAMIC));
    assert.ok(r.ok);
    if (!r.ok) return;
    const yieldAlloc = r.plan.allocations.find((a) => a.role === 'yield');
    assert.equal(yieldAlloc?.atoms, 0n);
    assert.equal(yieldAlloc?.zero, 'ABSTAINED');
    assert.ok(r.plan.unallocatedAtoms > 0n);
    assert.match(r.plan.explanation, /stays unallocated/);
  });

  it('a model that times out or answers malformed abstains: nothing is guessed', async () => {
    const t = session({ ...CARDS, swap: { text: '{}', delayMs: 2_000 }, perps: '{"action":"PROPOSE"}' });
    const r = await t.s.plan(fromPrompt(DYNAMIC));
    assert.ok(r.ok);
    if (!r.ok) return;
    const runtime = Object.fromEntries(r.plan.cards.map((c) => [c.role, c.runtime]));
    assert.equal(runtime['swap'], 'TIMED_OUT');
    assert.equal(runtime['perps'], 'INVALID_RESPONSE');
    for (const role of ['swap', 'perps']) assert.equal(r.plan.allocations.find((a) => a.role === role)?.atoms, 0n);
  });

  it('41. planning offers only actionable, executable candidates: discovery-only ones are never a choice', async () => {
    const t = session();
    await t.s.plan(fromPrompt(DYNAMIC));
    const offered = t.provider.requests.filter((r): r is OpportunityRequest => r.kind === 'OPPORTUNITY').flatMap((r) => r.candidates.map((c) => c.id));
    for (const forbidden of ['nvda-token-b', 'route-b', 'high-yield-usd', 'btc-long-5x']) assert.equal(offered.includes(forbidden), false, forbidden);
    const research = t.provider.requests.filter((r): r is OpportunityRequest => r.kind === 'OPPORTUNITY').find((r) => r.role === 'stock')?.research ?? [];
    assert.ok(research.some((e) => e.kind === 'NEWS' && e.evidence === 'DATA_UNAVAILABLE'), 'unavailable research is declared, not invented');
  });

  it('22. HYBRID plans only the remainder and never touches the fixed budget', async () => {
    const t = session();
    const draft = fromPrompt(HYBRID);
    const r = await t.s.plan(draft);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(t.of('ROOM_OPENED')[0]?.data['roomPurpose'], 'HYBRID_ALLOCATION');
    assert.equal(r.plan.poolAtoms, 1_200_000_000n);
    assert.deepEqual(r.plan.allocations.map((a) => a.role), ['swap', 'yield', 'perps']);
    assert.equal(t.provider.requests.some((q) => q.kind === 'OPPORTUNITY' && q.role === 'stock'), false, 'the fixed agent is not asked');
    const applied = t.s.applyPlan(draft, r.plan.roomId);
    assert.ok(applied.ok);
    if (!applied.ok) return;
    assert.equal(applied.draft.agents.stock.budget, '800');
    assert.equal(applied.draft.provenance['agents.stock.budget'], 'INTERPRETED');
    assert.equal(t.s.validate(applied.draft).ok, true, JSON.stringify(t.s.validate(applied.draft).issues));
  });

  it('23 / 37 / 38. the principal edits the split; the edit wins, is validated, and is exactly what is signed', async () => {
    const t = session();
    const draft = fromPrompt(DYNAMIC);
    const r = await t.s.plan(draft);
    assert.ok(r.ok);
    if (!r.ok) return;
    // An invalid edit is caught by deterministic validation, before anything is signed.
    const over = t.s.applyPlan(draft, r.plan.roomId, { stock: '1900' });
    assert.ok(over.ok);
    if (over.ok) assert.ok(t.s.validate(over.draft).issues.some((i) => i.code === 'ALLOCATION_EXCEEDS_TOTAL' || i.code === 'ALLOCATION_EXCEEDS_AGENT_MAX'));
    const edited = t.s.applyPlan(draft, r.plan.roomId, { stock: '600', yield: '700' });
    assert.ok(edited.ok);
    if (!edited.ok) return;
    assert.equal(edited.draft.provenance['agents.stock.budget'], 'USER');
    assert.equal(edited.draft.provenance['agents.swap.budget'], 'PLANNED');
    assert.equal(t.of('ALLOCATION_PLAN_APPLIED').length, 2);
    const a = await t.s.authorize(edited.draft, 'AUTHORIZE MANDATE V1');
    assert.ok(a.ok, a.ok ? '' : `${a.code} ${JSON.stringify(a.issues)}`);
    const signed = (role: string) => t.s.versions.active?.mandate.agents.find((x) => x.label === role)?.hardMaxima.find((h) => h.resource === 'portfolio-notional')?.atoms;
    assert.equal(signed('stock'), 600_000_000n);
    assert.equal(signed('yield'), 700_000_000n);
    assert.equal(signed('swap'), BigInt(edited.draft.agents.swap.budget as string) * 1_000_000n);
  });

  it('a plan is refused when the draft changed or its evidence went stale', async () => {
    const t = session();
    const draft = fromPrompt(DYNAMIC);
    const r = await t.s.plan(draft);
    assert.ok(r.ok);
    if (!r.ok) return;
    const changed = t.s.applyPlan(withField(draft, 'portfolio.maxDerivative', '300', 'USER'), r.plan.roomId);
    assert.deepEqual(changed.ok ? null : changed.code, 'PLAN_STALE');
    t.time.now = r.plan.freshUntil + 1n;
    const stale = t.s.applyPlan(draft, r.plan.roomId);
    assert.deepEqual(stale.ok ? null : stale.code, 'PLAN_STALE');
    assert.deepEqual((() => {
      const x = t.s.applyPlan(draft, 'plan-9-9');
      return x.ok ? null : x.code;
    })(), 'PLAN_UNKNOWN');
  });

  it('a single delegated agent needs no Room: nobody to split with', async () => {
    const t = session();
    const r = await t.s.plan(fromPrompt('Deploy $2,000. Stock $800, Swap $400, Yield $500. Let Perps decide how to use the rest.'));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.plan.purpose, null);
    assert.equal(t.of('ROOM_OPENED').length, 0);
    assert.match(String(t.of('ALLOCATION_PLAN_PROPOSED')[0]?.data['note']), /SINGLE_AGENT_POOL/);
  });

  it('Jev scores are advisory: recorded, re-validated, and unable to lift a cap; a broken scorer is UNAVAILABLE', async () => {
    const scored = (score: number): JevScore => ({ status: 'SCORED', score, confidence: 0.9, probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 }, bps: 99_999, model: 'scripted-jev', latencyMs: 1 });
    const scorer: OpportunityScorer = { name: 'scripted', evidence: 'SCRIPTED', score: ({ card }) => Promise.resolve(card.role === 'perps' ? scored(4) : card.role === 'swap' ? scored(9) : scored(0)) };
    const t = session(CARDS, scorer);
    const r = await t.s.plan(fromPrompt(DYNAMIC));
    assert.ok(r.ok);
    if (!r.ok) return;
    const recorded = Object.fromEntries(t.of('JEV_SCORE_RECORDED').map((e) => [e.agent, e.data]));
    assert.equal(recorded['perps']?.['status'], 'SCORED');
    assert.equal(recorded['perps']?.['bps'], 10_000, 'basis points are recomputed, never taken from the scorer');
    assert.equal(recorded['swap']?.['status'], 'UNAVAILABLE', 'an out-of-range score is refused');
    assert.ok((r.plan.allocations.find((a) => a.role === 'perps')?.atoms as bigint) <= 300_000_000n, 'a top score cannot exceed maximum useful');
  });
});
