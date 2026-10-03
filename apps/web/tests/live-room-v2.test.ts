import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { JsonRecord, LiveEvent } from '../components/demo/live/live-client.ts';
import { allocationState, authorizedStockTrade, budgetRows, canAskForPlan, checkBudgets, planView, planningCards, roomCopy, serverCompatible, ROOM_PURPOSE_COPY } from '../components/demo/live/allocation-model.ts';
import { deriveFlow, type FlowInput } from '../components/demo/live/live-flow.ts';
import { deriveAgents, deriveRoomChat } from '../components/demo/live/live-model.ts';

/*
 * Mandate Room V2 in the browser (docs/v2/mandate-room-v2.md §15–17, §24–25):
 * exact budgets bypass planning, a delegated split is proposed before signing,
 * the principal's edit wins, settlement follows reservations only, and every
 * Room says why it exists.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const LIVE = '../components/demo/live/';
const outcome = read(`${LIVE}stage-outcome.tsx`);
const lab = read(`${LIVE}live-lab.tsx`);
const room = read(`${LIVE}live-model.ts`);
const planning = read(`${LIVE}stage-planning.tsx`);

let seq = 0;
function event(kind: string, data: JsonRecord = {}, agent: string | null = null, roomId: string | null = null): LiveEvent {
  seq += 1;
  return { schema: 'MANDATE_LIVE_AI.V1', sessionId: 'lab-1', sequence: seq, kind, at: '2026-10-02T00:00:00.000Z', elapsedMs: seq, protocolTime: '0', mandateVersion: 1, agent, roomId, generation: null, data };
}
const pre: FlowInput = { drafting: false, draftPresent: true, reviewing: false, activeVersion: null, amending: false, runStarted: false, task: null, lastRunStatus: null, lastError: null, runEvents: [], paused: false };
const allocation = (a: JsonRecord): JsonRecord => ({ allocation: a });
const FIXED = allocation({ intent: 'FIXED', planning: 'NONE', enabled: ['stock', 'swap', 'yield', 'perps'], undecided: [], fixed: ['stock', 'swap', 'yield', 'perps'], pool: [], autoReallocate: false, deployableAtoms: '2000000000', poolAtoms: '0' });
const DYNAMIC = allocation({ intent: 'DYNAMIC', planning: 'REQUIRED', enabled: ['stock', 'swap', 'yield', 'perps'], undecided: [], fixed: [], pool: ['stock', 'swap', 'yield', 'perps'], autoReallocate: false, deployableAtoms: '2000000000', poolAtoms: '2000000000' });

test('35. a FIXED allocation never offers or enters a Planning Room', () => {
  const s = allocationState(FIXED);
  assert.equal(s?.intent, 'FIXED');
  assert.equal(canAskForPlan(s), false);
  assert.equal(deriveFlow({ ...pre, planning: false }).phase, 'CONFIGURE');
});

test('36. a DYNAMIC allocation shows the Planning Room before wallet authorization', () => {
  const s = allocationState(DYNAMIC);
  assert.equal(canAskForPlan(s), true);
  assert.equal(deriveFlow({ ...pre, planning: true }).phase, 'PLANNING');
  // Planning is a pre-authorization phase: it never appears once a mandate is active and running.
  assert.notEqual(deriveFlow({ ...pre, planning: true, activeVersion: 1, runStarted: true, task: 'RUN' }).phase, 'PLANNING');
  // Review (wallet signing) comes only when the principal leaves planning and presses Trade.
  assert.equal(deriveFlow({ ...pre, planning: true, reviewing: true }).phase, 'APPROVE');
  const cards = planningCards([event('ROOM_OPENED', { stage: 'PRE_AUTHORIZATION', roomPurpose: 'INITIAL_ALLOCATION' }, null, 'plan-1-1'), event('OPPORTUNITY_CARD_CREATED', { action: 'PROPOSE', candidate: 'NVDA', rationale: 'strong execution', runtime: 'RESPONDED' }, 'stock', 'plan-1-1')], null);
  assert.deepEqual(cards.map((c) => [c.role, c.action]), [['stock', 'PROPOSE']]);
});

test('37. an edited allocation is validated immediately', () => {
  const base = { enabled: ['stock', 'swap', 'yield', 'perps'] as const, deployable: '2000', ceilings: { stock: '800', swap: '500', yield: '800', perps: '400' }, derivativeCap: '400', illiquidCap: '400' };
  assert.equal(checkBudgets({ ...base, budgets: { stock: '650', swap: '350', yield: '750', perps: '250' } }).ok, true);
  assert.equal(checkBudgets({ ...base, budgets: { stock: '650', swap: '350', yield: '750', perps: '250' } }).kept, 0);
  assert.match(checkBudgets({ ...base, budgets: { stock: '800', swap: '500', yield: '800', perps: '400' } }).issues.join(' '), /add up to \$2500/);
  assert.match(checkBudgets({ ...base, budgets: { stock: '900' } }).issues.join(' '), /at most \$800/);
  assert.match(checkBudgets({ ...base, budgets: { perps: '450' }, ceilings: {} }).issues.join(' '), /derivative limit/);
  assert.match(checkBudgets({ ...base, budgets: { nft: '100' } }).issues.join(' '), /not enabled/);
  assert.match(checkBudgets({ ...base, budgets: { stock: 'lots' } }).issues.join(' '), /not a USDC amount/);
  const plan = planView({ roomId: 'plan-1-1', roomPurpose: 'INITIAL_ALLOCATION', pool: { amount: '2000' }, fixed: [], budgets: [{ role: 'stock', budget: { amount: '750' }, zero: null, rationale: 'r', candidate: 'NVDA', action: 'PROPOSE' }], allocated: { amount: '750' }, unallocated: { amount: '1250' }, explanation: 'why' });
  assert.equal(plan?.budgets[0]?.amount, '750');
  assert.equal(plan?.unallocated, '1250');
});

test('38. the signed review shows the budgets the draft holds after editing, with who set them', () => {
  const draft: JsonRecord = { agents: { stock: { budget: '650' }, swap: { budget: '350' }, yield: { budget: '750' }, perps: { budget: '250' } }, provenance: { 'agents.stock.budget': 'USER', 'agents.swap.budget': 'PLANNED', 'agents.yield.budget': 'USER', 'agents.perps.budget': 'PLANNED' } };
  assert.deepEqual(budgetRows(draft, ['stock', 'swap', 'yield', 'perps']).map((r) => [r.role, r.amount, r.source]), [['stock', '650', 'YOU'], ['swap', '350', 'AGENTS'], ['yield', '750', 'YOU'], ['perps', '250', 'AGENTS']]);
  assert.match(lab, /budgets=\{budgetRows\(draft, enabledRoles\)\}/);
});

test('39 / 40. a blocked Stock proposal is never a trade decision, and offers no settlement control', () => {
  const blocked = [
    event('AGENT_DECISION_COMPLETED', { candidateId: 'nvda-token-b', candidate: 'NVDA · NVIDIA Stock Token' }, 'stock'),
    event('PROPOSAL_BLOCKED', { reasons: ['REGISTRY:ISSUER_NOT_ALLOWED:x'] }, 'stock'),
    event('PORTFOLIO_AUTHORIZED', { proposals: [{ role: 'swap', outcome: 'RESERVED', requested: '350' }] }),
  ];
  assert.deepEqual(authorizedStockTrade(blocked), { authorized: false, candidate: null, candidateId: null, amount: null, settlementCapable: false, hold: 'BLOCKED' });
  const abstained = [event('AGENT_DECISION_COMPLETED', { action: 'ABSTAIN', candidateId: null }, 'stock'), event('PORTFOLIO_AUTHORIZED', { proposals: [{ role: 'swap', outcome: 'RESERVED', requested: '350' }] })];
  assert.deepEqual(authorizedStockTrade(abstained), { authorized: false, candidate: null, candidateId: null, amount: null, settlementCapable: false, hold: 'ABSTAINED' }, 'an abstaining Stock agent has no trade to settle');
  const reserved = [event('AGENT_DECISION_COMPLETED', { candidateId: 'nvda-note-a', candidate: 'NVDA · Fixture Backed NVIDIA Note' }, 'stock'), event('PORTFOLIO_AUTHORIZED', { proposals: [{ role: 'stock', outcome: 'RESERVED', requested: '700' }] })];
  assert.deepEqual(authorizedStockTrade(reserved), { authorized: true, candidate: 'NVDA · Fixture Backed NVIDIA Note', candidateId: 'nvda-note-a', amount: '700', settlementCapable: true, hold: 'NONE' });
  const unsupported = [...reserved, event('AGENT_CANDIDATES_EVALUATED', { executable: ['nvda-note-c'], capability: [{ candidateId: 'nvda-note-a', status: 'SETTLEMENT_UNSUPPORTED' }] }, 'stock')];
  assert.equal(authorizedStockTrade(unsupported).settlementCapable, false);
  assert.equal(authorizedStockTrade(unsupported).hold, 'UNSUPPORTED');
  assert.match(outcome, /this testnet connector cannot execute this candidate/);
  // The proof panel returns before any settlement control when there is no Stock reservation.
  assert.match(outcome, /if \(!stockTrade\.authorized && !settlement\.present\) \{[\s\S]*?No authorized Stock trade[\s\S]*?did not receive execution authority[\s\S]*?\n  \}/);
  const guard = outcome.indexOf('if (!stockTrade.authorized && !settlement.present)');
  assert.ok(guard > 0 && guard < outcome.indexOf('<SettleActions settlement={settlement}'));
  assert.doesNotMatch(outcome, /stock\.candidate/);
});

test('41. a discovery-only candidate is never shown as the agent\'s choice, and a stale server is refused', () => {
  const events = [
    event('AGENT_CANDIDATES_EVALUATED', { discovered: ['nvda-note-a', 'nvda-token-b'], actionable: ['nvda-note-a'], excluded: [{ candidateId: 'nvda-token-b', candidate: 'NVDA · NVIDIA Stock Token', reasons: ['REGISTRY:ISSUER_NOT_ALLOWED'] }], executable: ['nvda-note-a'] }, 'stock'),
    event('AGENT_DECISION_COMPLETED', { candidateId: 'nvda-note-a', candidate: 'NVDA · Fixture Backed NVIDIA Note', requested: { amount: '700' } }, 'stock'),
  ];
  const stock = deriveAgents(events).find((a) => a.role === 'stock');
  assert.equal(stock?.candidate, 'NVDA · Fixture Backed NVIDIA Note');
  assert.equal(serverCompatible({ candidatePipeline: 'DISCOVERED>ACTIONABLE>EXECUTABLE>MODEL', roomSemantics: 'MANDATE_ROOM_V2_PLAN_BOUND' }), true);
  assert.equal(serverCompatible({}), false);
  assert.match(lab, /if \(!compatible\) \{\s*setError\(STALE_SERVER\);/);
});

test('42. every Room says why it exists; the generic conflict text is gone', () => {
  assert.doesNotMatch(room, /resolving a shared authority conflict/);
  for (const [purpose, copy] of Object.entries(ROOM_PURPOSE_COPY)) {
    const chat = deriveRoomChat([event('ROOM_OPENED', { roomPurpose: purpose, participants: [{ role: 'stock' }, { role: 'yield' }] })]);
    assert.ok(chat[0]?.detail.startsWith(copy), purpose);
  }
  assert.equal(roomCopy('INITIAL_ALLOCATION'), 'Agents are proposing how to allocate your capital.');
  assert.equal(roomCopy('REALLOCATION'), 'Agents are deciding how released capital should be reassigned.');
  assert.equal(roomCopy('SHARED_RESOURCE_COORDINATION'), 'Valid proposals are competing for shared authority.');
});

test('43. Start over leaves a restored evidence-only session before building again', () => {
  assert.match(lab, /if \(!amending\) \{\s*rememberSession\(null\);\s*setSessionId\(null\)/, 'an amendment keeps its signed session');
});

test('44. a single-agent proposal is not labelled as a Mandate Room', () => {
  assert.match(planning, /singleAgent \? "Allocation proposal" : "Mandate Room"/);
  assert.match(planning, /One agent is proposing how much/);
  assert.match(lab, /stageStatus[\s\S]*?"Allocation proposal"/);
});

test('45. a single-agent plan shows its own card: no Room was opened to name it', () => {
  const multi = [event('ROOM_OPENED', { stage: 'PRE_AUTHORIZATION' }, null, 'plan-1-1'), event('OPPORTUNITY_CARD_CREATED', { roomPurpose: 'INITIAL_ALLOCATION', action: 'PROPOSE' }, 'stock', 'plan-1-1')];
  const single = event('OPPORTUNITY_CARD_CREATED', { roomPurpose: null, action: 'PROPOSE' }, 'perps', 'plan-1-2');
  assert.deepEqual(planningCards([single], null).map((c) => c.role), ['perps']);
  assert.deepEqual(planningCards([...multi, single], null).map((c) => c.role), ['perps'], 'the later plan wins over an earlier Room');
  assert.deepEqual(planningCards([...multi, single, event('OPPORTUNITY_CARD_CREATED', { roomPurpose: 'REALLOCATION' }, 'yield', 'realloc-1')], null).map((c) => c.role), ['perps'], 'a post-sign reallocation card is not a planning card');
});
