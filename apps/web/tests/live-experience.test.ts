import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { JsonRecord, LiveEvent } from '../components/demo/live/live-client.ts';
import { blockedInsideRoom, derivePresentation, resourceLines, type RoleName } from '../components/demo/live/live-model.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const ui = read('../components/demo/live/live-lab.tsx');
const css = read('../components/demo/live/live-lab.css');
const model = read('../components/demo/live/live-model.ts');
const replay = read('../app/demo/page.tsx');

const usd = (amount: string): JsonRecord => ({ atoms: `${amount}000000`, amount });

function event(sequence: number, kind: string, data: JsonRecord = {}, agent: string | null = null, extra: Partial<LiveEvent> = {}): LiveEvent {
  return {
    schema: 'MANDATE_LIVE_AI.V1',
    sessionId: 'lab-1',
    sequence,
    kind,
    at: '2026-09-30T00:00:00.000Z',
    elapsedMs: sequence * 1000,
    protocolTime: '0',
    mandateVersion: 1,
    agent,
    roomId: extra.roomId ?? null,
    generation: extra.generation ?? null,
    data,
    ...extra,
  };
}

test('a draft is labeled not authorized until the exact phrase is submitted', () => {
  assert.match(ui, /Draft — not authorized/);
  assert.match(ui, /confirmation === expected/);
  assert.match(ui, /disabled=\{!props\.phraseMatches\}/);
  assert.match(ui, /Authority needs review/);
  assert.doesNotMatch(ui, /Looks Good|Start Agents/);
});

test('a disabled agent stays visible and means no authority', () => {
  assert.match(ui, /NO AUTHORITY/);
  assert.match(ui, /no mandate entry and no delegation/);
  assert.match(ui, /ROLES\.map/);
  for (const role of ['stock', 'swap', 'nft', 'yield', 'perps']) assert.match(model, new RegExp(`"${role}"`));
});

test('five agents keep independent states, and the model result stays separate from the Mandate result', () => {
  const events = [
    event(1, 'AGENT_REQUEST_STARTED', {}, 'stock'),
    event(2, 'AGENT_DECISION_COMPLETED', { candidateId: 'nvda-note-a', requested: usd('800'), rationale: 'Approved representation' }, 'stock'),
    event(3, 'PROPOSAL_ADMISSIBLE', { portfolioValid: true, reasons: [] }, 'stock'),
    event(4, 'AGENT_DECISION_COMPLETED', { candidateId: 'route-b', requested: usd('500'), rationale: 'Higher quoted output' }, 'swap'),
    event(5, 'PROPOSAL_BLOCKED', { reasons: ['VENUE_NOT_ALLOWED'] }, 'swap'),
    event(6, 'AGENT_TIMED_OUT', {}, 'nft'),
    event(7, 'AGENT_ABSTAINED', { rationale: 'No listing' }, 'yield'),
    event(8, 'AGENT_FAILED', {}, 'perps'),
  ];
  const agents = derivePresentation(events).agents;
  assert.deepEqual(agents.map((agent) => agent.phase), ['ADMISSIBLE', 'BLOCKED', 'TIMED OUT', 'ABSTAINED', 'FAILED']);
  assert.equal(agents[0]?.candidate, 'nvda-note-a');
  assert.equal(agents[1]?.mandateLabel, 'BLOCKED');
  assert.match(ui, /Model decision/);
  assert.match(ui, /Mandate check/);
});

test('a hard block stays out of the Room; a portfolio conflict may enter', () => {
  const events = [
    event(1, 'PROPOSAL_BLOCKED', { reasons: ['VENUE_NOT_ALLOWED'] }, 'swap'),
    event(2, 'PROPOSAL_ADMISSIBLE', { portfolioValid: false, reasons: [] }, 'perps'),
    event(3, 'ROOM_OPENED', { participants: ['perps'] }, null, { roomId: 'room-1', generation: 1 }),
    event(4, 'PORTFOLIO_CONFLICT', {
      participants: ['perps'],
      excludedAtScreening: ['swap'],
      constraints: [
        { resource: 'portfolio-notional', authorityAtoms: '2000000000', demandAtoms: '1400000000', requiredReductionAtoms: '0' },
        { resource: 'derivative-notional', authorityAtoms: '400000000', demandAtoms: '600000000', requiredReductionAtoms: '200000000' },
        { resource: 'spot-capital', authorityAtoms: '2000000000', demandAtoms: '800000000', requiredReductionAtoms: '0' },
      ],
      conflicts: [{ resource: 'derivative-notional', authority: usd('400'), demand: usd('600'), requiredReduction: usd('200') }],
    }),
  ];
  const view = derivePresentation(events);
  assert.equal(blockedInsideRoom(events), false);
  assert.equal(view.agents.find((agent) => agent.role === 'swap')?.inRoom, false);
  assert.equal(view.agents.find((agent) => agent.role === 'perps')?.inRoom, true);
  assert.equal(view.agents.find((agent) => agent.role === 'perps')?.portfolioConflict, true);
  const lines = resourceLines(events);
  assert.deepEqual(lines.map((line) => line.resource), ['portfolio-notional', 'derivative-notional', 'spot-capital']);
  assert.equal(lines.find((line) => line.resource === 'derivative-notional')?.status, 'CONFLICT');
  assert.equal(lines.find((line) => line.resource === 'derivative-notional')?.reduction, '200');
  assert.equal(lines.find((line) => line.resource === 'portfolio-notional')?.status, 'OK');
  assert.equal(lines.some((line) => line.resource === 'total'), false);
  assert.doesNotMatch(model, /data\.requiredReduction/);
  assert.match(ui, /Reductions are not added together/);
});

test('the Room is not authorization, and a stale or late reply is ignored', () => {
  const opened = [
    event(1, 'ROOM_OPENED', {}, null, { roomId: 'room-1', generation: 1 }),
    event(2, 'ROOM_PROPOSAL_CREATED', { conflicts: [{ resource: 'derivative-notional', authority: usd('400'), demand: usd('600'), demandAfter: usd('400'), requiredReduction: usd('200'), remainingReduction: usd('0'), status: 'SATISFIED' }] }),
    event(3, 'MANDATE_REVERIFY_STARTED', { phase: 'reverify' }),
  ];
  const before = derivePresentation(opened);
  assert.equal(before.room.proposal, true);
  assert.equal(before.room.reverify, true);
  assert.equal(before.room.authorized, false);
  assert.match(ui, /Not yet authorized/);
  assert.match(ui, /The Room cannot create authority/);
  assert.match(model, /MANDATE_REVERIFY_STARTED/);
  const after = derivePresentation([...opened, event(4, 'PORTFOLIO_AUTHORIZED', { proposals: [{ role: 'stock', outcome: 'RESERVED', requested: usd('800'), reasons: [] }, { role: 'perps', outcome: 'RESERVED', requested: usd('400'), reasons: [] }] })]);
  assert.equal(after.room.authorized, true);
  assert.equal(after.agents.find((agent) => agent.role === 'stock')?.finalOutcome, 'RESERVED');
  const late = derivePresentation([
    event(1, 'ROOM_AGENT_STALE_RESPONSE', { reason: 'ANSWERED_AFTER_TIMEOUT', action: 'KEEP', effect: 'IGNORED' }, 'stock'),
    event(2, 'ROOM_AGENT_STALE_RESPONSE', { reason: 'LATER_GENERATION_STARTED', action: 'REDUCE', effect: 'IGNORED' }, 'perps'),
  ]);
  assert.equal(late.agents.find((agent) => agent.role === 'stock')?.ignored, 'LATE');
  assert.equal(late.agents.find((agent) => agent.role === 'perps')?.ignored, 'STALE');
  assert.match(ui, /LATE — IGNORED|\$\{agent\.ignored\} — IGNORED/);
  assert.match(ui, /did not change the portfolio/);
});

test('a timeout records no release, and no feasible portfolio authorizes nothing', () => {
  const timed = derivePresentation([event(1, 'ROOM_AGENT_TIMEOUT', { effect: 'UNCHANGED' }, 'nft'), event(2, 'AGENT_TIMED_OUT', {}, 'nft')]);
  const nft = timed.agents.find((agent) => agent.role === 'nft');
  assert.equal(nft?.timedOut, true);
  assert.match(nft?.roomNote ?? '', /no allocation change/);
  assert.equal(nft?.finalOutcome, '');
  assert.match(ui, /not consent, a release, or a crash/);
  const stuck = derivePresentation([event(1, 'ROOM_NO_FEASIBLE_PORTFOLIO', { conflicts: [{ resource: 'derivative-notional', authority: usd('400'), demand: usd('600'), demandAfter: usd('500'), requiredReduction: usd('200'), remainingReduction: usd('100'), status: 'UNRESOLVED' }] })]);
  assert.equal(stuck.room.noFeasible, true);
  assert.equal(stuck.room.authorized, false);
  assert.equal(stuck.room.lines[0]?.reduction, '100');
  assert.match(ui, /No feasible portfolio/);
  assert.match(ui, /Nothing was authorized/);
});

test('amendment and pause copy do not rewrite a signed version or erase a reservation', () => {
  assert.match(ui, /does not edit the previous version in place/);
  assert.match(ui, /SUPERSEDED/);
  assert.match(ui, /Amendment refused/);
  const paused = derivePresentation([event(1, 'MANDATE_PAUSED', {}), event(2, 'MANDATE_AMENDMENT_REFUSED', { code: 'RESERVED', message: 'Amendments are refused after a reservation.' })]);
  assert.equal(paused.paused, true);
  assert.match(paused.amendmentRefused ?? '', /refused after a reservation/);
  assert.match(ui, /Existing reservations stay recorded/);
  assert.match(ui, /New actions cannot be authorized/);
});

test('policy stress keeps one Swap identity and the real reason codes', () => {
  const identity = { agentIdentity: 'VALID', membership: 'VALID', delegation: 'ACTIVE', signature: 'VALID', sameSignerAsSwapAgent: true };
  const events = [
    event(1, 'POLICY_STRESS_STARTED', {}),
    event(2, 'POLICY_STRESS_CASE_SELECTED', { attempt: 1, caseId: 'RECIPIENT_MISMATCH', rationale: 'wrong recipient' }),
    event(3, 'POLICY_STRESS_PROPOSAL_SIGNED', { attempt: 1, identity }),
    event(4, 'POLICY_STRESS_PROPOSAL_BLOCKED', { attempt: 1, reasons: ['RECIPIENT_NOT_ALLOWED'], screening: { verdict: 'BLOCKED' } }),
    event(5, 'POLICY_STRESS_CASE_SELECTED', { attempt: 2, caseId: 'UNAPPROVED_VENUE', rationale: 'other venue' }),
    event(6, 'POLICY_STRESS_PROPOSAL_SIGNED', { attempt: 2, identity }),
    event(7, 'POLICY_STRESS_PROPOSAL_BLOCKED', { attempt: 2, reasons: ['VENUE_NOT_ALLOWED'], screening: { verdict: 'BLOCKED' } }),
    event(8, 'POLICY_STRESS_CASE_SELECTED', { attempt: 3, caseId: 'REPRESENTATION_MISMATCH', rationale: 'other note' }),
    event(9, 'POLICY_STRESS_PROPOSAL_SIGNED', { attempt: 3, identity }),
    event(10, 'POLICY_STRESS_PROPOSAL_BLOCKED', { attempt: 3, reasons: ['INSTRUMENT_UNKNOWN'], screening: { verdict: 'BLOCKED' } }),
    event(11, 'POLICY_STRESS_CASE_SELECTED', { attempt: 4, caseId: 'OVER_LIMIT', rationale: 'too large' }),
    event(12, 'POLICY_STRESS_PROPOSAL_SIGNED', { attempt: 4, identity }),
    event(13, 'POLICY_STRESS_PROPOSAL_BLOCKED', { attempt: 4, reasons: ['AGENT_LIMIT_EXCEEDED', 'ALLOCATION_INSUFFICIENT'], screening: { verdict: 'ADMISSIBLE' } }),
    event(14, 'POLICY_STRESS_CASE_SELECTED', { attempt: 5, caseId: 'COMPLIANT_CONTROL', rationale: 'inside authority' }),
    event(15, 'POLICY_STRESS_PROPOSAL_SIGNED', { attempt: 5, identity }),
    event(16, 'POLICY_STRESS_PROPOSAL_AUTHORIZED', { attempt: 5, screening: { verdict: 'ADMISSIBLE' }, sameIdentityAsRefusedAttempts: true, note: 'The same agent identity, evaluated again.' }),
  ];
  const attempts = derivePresentation(events).stress.attempts;
  assert.equal(attempts.every((attempt) => attempt.sameSigner), true);
  assert.deepEqual(attempts.map((attempt) => attempt.caseId), ['RECIPIENT_MISMATCH', 'UNAPPROVED_VENUE', 'REPRESENTATION_MISMATCH', 'OVER_LIMIT', 'COMPLIANT_CONTROL']);
  assert.deepEqual(attempts.map((attempt) => attempt.outcome), ['REFUSED', 'REFUSED', 'REFUSED', 'REFUSED', 'AUTHORIZED']);
  assert.deepEqual(attempts[0]?.reasons, ['RECIPIENT_NOT_ALLOWED']);
  assert.deepEqual(attempts[1]?.reasons, ['VENUE_NOT_ALLOWED']);
  assert.deepEqual(attempts[2]?.reasons, ['INSTRUMENT_UNKNOWN']);
  assert.equal(attempts[3]?.screening, 'ADMISSIBLE');
  assert.equal(attempts[3]?.outcome, 'REFUSED');
  assert.equal(attempts[4]?.outcome, 'AUTHORIZED');
  assert.match(ui, /Same agent\. Same identity\. Compliant action\. Authorized/);
  assert.match(ui, /VALID AGENT ≠ VALID ACTION/);
  assert.doesNotMatch(ui, /defeated the AI|Hacker blocked|Rogue AI/i);
});

test('settlement is LIVE_TESTNET only after a confirmed receipt, and the fixture is not an NVDA trade', () => {
  const submitted = derivePresentation([event(1, 'TESTNET_TX_SUBMITTED', { txHash: '0xabc', evidence: 'SUBMITTED_UNCONFIRMED' })]);
  assert.equal(submitted.settlement.settled, false);
  assert.equal(submitted.settlement.stage, 'SUBMITTED');
  assert.notEqual(submitted.settlement.evidence, 'LIVE_TESTNET');
  const reverted = derivePresentation([event(1, 'TESTNET_TX_SUBMITTED', { txHash: '0xabc' }), event(2, 'TESTNET_TX_FAILED', { txHash: '0xabc', status: 'REVERTED', evidence: 'FAILED', reason: 'MINED_REVERTED' })]);
  assert.equal(reverted.settlement.stage, 'FAILED');
  assert.equal(reverted.settlement.settled, false);
  const confirmed = derivePresentation([
    event(1, 'TESTNET_TX_CONFIRMED', {
      evidence: 'LIVE_TESTNET',
      txHash: '0xabc',
      explorerUrl: 'https://explorer.example/tx/0xabc',
      block: 10,
      gasUsed: 20,
      status: 'SUCCESS',
      network: 'Robinhood Chain Testnet',
      chainId: 46630,
      authorized: { notionalUsdc: '800', debit: '64', quantity: '6.4' },
      tokenIn: { symbol: 'MDUSD', amount: '64' },
      tokenOut: { symbol: 'MDEMO', amount: '6.4' },
    }),
  ]);
  assert.equal(confirmed.settlement.settled, true);
  assert.equal(confirmed.settlement.evidence, 'LIVE_TESTNET');
  assert.equal(confirmed.settlement.explorerUrl, 'https://explorer.example/tx/0xabc');
  assert.equal(confirmed.settlement.decisionNotional, '800');
  assert.match(confirmed.settlement.fixtureIn ?? '', /MDUSD/);
  assert.match(confirmed.settlement.fixtureOut ?? '', /MDEMO/);
  assert.match(confirmed.settlement.qualification, /Not an NVDA trade/);
  assert.match(confirmed.settlement.qualification, /Not a Robinhood Stock Token/);
  assert.match(ui, /Agent decision/);
  assert.match(ui, /Testnet settlement proof/);
  assert.match(ui, /Valueless demo assets/);
  assert.doesNotMatch(ui, /\$800 USDC → 6\.4 MDEMO|0x87a5aa1bd4414ba7548fae408ee52fbe5a1f221b09da8f0f1a4fbf87ee67c0fa/);
  assert.match(ui, /href=\{settlement\.explorerUrl\}/);
  assert.doesNotMatch(ui, /explorer\.testnet\.chain\.robinhood\.com/);
  assert.match(ui, /OFFCHAIN_ONLY/);
  assert.match(ui, /agent\.role === "stock" \? \(settled \? "LIVE_TESTNET"/);
  assert.match(ui, /Reserved is not settled/);
  assert.match(ui, /This page does not send a transaction/);
});

test('the browser does not import settlement, render a key, or invent wait time', () => {
  const sources = [ui, model, read('../components/demo/live/live-client.ts')].join('\n');
  assert.doesNotMatch(sources, /live-settlement|privateKey|OPENAI_API_KEY|NEXT_PUBLIC_OPENAI|sk-[A-Za-z0-9]{8}/);
  assert.doesNotMatch(ui, /setTimeout\(/);
  assert.match(ui, /events\.map/);
  assert.match(css, /@media \(max-width: 390px\)/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(ui, /useReducedMotion/);
  assert.match(replay, /<JudgeExperience\s*\/>/);
  assert.equal(derivePresentation([]).agents.length, 5);
  const roles: RoleName[] = ['stock', 'swap', 'nft', 'yield', 'perps'];
  assert.deepEqual(derivePresentation([]).agents.map((agent) => agent.role), roles);
});
