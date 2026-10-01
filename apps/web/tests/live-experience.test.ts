import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { JsonRecord, LiveEvent } from '../components/demo/live/live-client.ts';
import {
  blockedInsideRoom,
  derivePresentation,
  formatDuration,
  groupEventsByElapsed,
  reasonLabel,
  resourceLines,
  type RoleName,
} from '../components/demo/live/live-model.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const ui = read('../components/demo/live/live-lab.tsx');
const css = read('../components/demo/live/live-lab.css');
const model = read('../components/demo/live/live-model.ts');
const prompt = read('../components/react-bits/prompt-bar.tsx');
const lattice = read('../components/react-bits/lattice-loader.tsx');
const latticeCss = read('../components/react-bits/lattice-loader.css');
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

test('the initial workspace prioritizes the principal prompt and collapses dense authority', () => {
  assert.match(ui, /Give your agents authority/);
  assert.match(ui, /<PromptBar/);
  assert.match(ui, /Prompt suggestions/);
  assert.match(ui, /View full authority/);
  assert.match(ui, /<dialog ref=\{authorityDialog\}/);
  assert.match(ui, /Advanced authority editing/);
  assert.match(ui, /Complete with balanced demo settings/);
  assert.match(ui, /Authorization stays closed until each is resolved/);
  assert.match(ui, /!props\.draftPresent && <>\s*<PromptBar/);
  assert.doesNotMatch(ui, /className="live-fields live-guard"/);
  assert.match(prompt, /What should your agents be allowed to do/);
});

test('draft authorization still requires the exact server phrase and active authoring collapses', () => {
  assert.match(ui, /confirmation === expected/);
  assert.match(ui, /disabled=\{!props\.phraseMatches\}/);
  assert.match(ui, /Activate mandate/);
  assert.match(ui, /NOT AUTHORIZED/);
  assert.match(ui, /Signed versions are not edited in place/);
  assert.match(ui, /!authoringExpanded/);
  assert.match(ui, /<ActiveMandateSummary/);
  assert.match(ui, /View authority/);
  assert.match(ui, /Adjust/);
  assert.match(ui, /PORTFOLIO_AUTHORIZED.*setOpenStage\(3\)/);
});

test('disabled agents remain visible and unambiguously mean no authority', () => {
  assert.match(ui, /NO AUTHORITY/);
  assert.match(ui, /No mandate entry\. No delegation\. This agent cannot propose/);
  assert.match(ui, /Disabled means no authority/);
  assert.match(ui, /ROLES\.map/);
  for (const role of ['stock', 'swap', 'nft', 'yield', 'perps']) assert.match(model, new RegExp(`"${role}"`));
});

test('five agent cards keep independent loading and terminal states', () => {
  const events = [
    event(1, 'AGENT_REQUEST_STARTED', {}, 'stock'),
    event(2, 'AGENT_DECISION_COMPLETED', { candidateId: 'nvda-note-a', candidate: 'NVIDIA-backed note', requested: usd('800'), rationale: 'Approved representation' }, 'swap'),
    event(3, 'PROPOSAL_BLOCKED', { reasons: ['VENUE_NOT_ALLOWED'] }, 'swap'),
    event(4, 'AGENT_TIMED_OUT', {}, 'nft'),
    event(5, 'AGENT_ABSTAINED', { rationale: 'No listing' }, 'yield'),
    event(6, 'AGENT_FAILED', {}, 'perps'),
  ];
  const agents = derivePresentation(events).agents;
  assert.equal(agents.length, 5);
  assert.deepEqual(agents.map((agent) => agent.phase), ['PENDING', 'BLOCKED', 'TIMED OUT', 'ABSTAINED', 'FAILED']);
  assert.equal(agents[1]?.candidate, 'NVIDIA-backed note');
  assert.match(ui, /LatticeLoader label=\{agent\.activity\} status="working"/);
  assert.match(ui, /status=\{failed \? "error" : "done"\}/);
  assert.match(lattice, /status\?: LatticeStatus/);
  assert.match(lattice, /elapsedMs\?: number \| null/);
});

test('React Bits primitives use real state without artificial delays', () => {
  assert.match(prompt, /Adapted from React Bits Prompt Bar/);
  assert.match(lattice, /Adapted from React Bits Lattice Loader/);
  assert.match(prompt, /autosizing composer and send\/working glyph/);
  assert.match(lattice, /authoritative elapsed telemetry/);
  assert.doesNotMatch(ui, /setTimeout\(|Math\.random\(/);
  assert.doesNotMatch(prompt, /setTimeout\(|Math\.random\(/);
  assert.doesNotMatch(lattice, /setTimeout\(|Math\.random\(/);
  assert.match(latticeCss, /prefers-reduced-motion/);
});

test('model choice and Mandate verdict are presented as separate layers with human and raw reasons', () => {
  assert.match(ui, /Model decision/);
  assert.match(ui, /Mandate check/);
  assert.match(ui, /Why\?/);
  assert.match(ui, /Human meaning/);
  assert.equal(reasonLabel('VENUE_NOT_ALLOWED:venues:eip155:1/router:x'), 'Venue not allowed');
  assert.equal(reasonLabel('INSTRUMENT_UNKNOWN'), 'Unknown instrument');
  assert.match(model, /Web-only copy\. Protocol reason codes remain unchanged/);
});

test('a hard block stays out of the Room while a portfolio conflict enters it', () => {
  const events = [
    event(1, 'PROPOSAL_BLOCKED', { reasons: ['VENUE_NOT_ALLOWED'] }, 'swap'),
    event(2, 'PROPOSAL_ADMISSIBLE', { portfolioValid: false, reasons: ['PORTFOLIO_LIMIT_EXCEEDED'] }, 'perps'),
    event(3, 'ROOM_OPENED', { participants: ['perps'] }, null, { roomId: 'room-1', generation: 1 }),
  ];
  const view = derivePresentation(events);
  assert.equal(blockedInsideRoom(events), false);
  assert.equal(view.agents.find((agent) => agent.role === 'swap')?.inRoom, false);
  assert.equal(view.agents.find((agent) => agent.role === 'perps')?.inRoom, true);
  assert.equal(view.agents.find((agent) => agent.role === 'perps')?.portfolioConflict, true);
  assert.match(ui, /Enters Mandate Room/);
});

test('typed resources remain separate and incomparable reductions are never summed', () => {
  const events = [event(1, 'PORTFOLIO_CONFLICT', {
    constraints: [
      { resource: 'portfolio-notional', authorityAtoms: '2000000000', demandAtoms: '2500000000', requiredReductionAtoms: '500000000' },
      { resource: 'derivative-notional', authorityAtoms: '400000000', demandAtoms: '600000000', requiredReductionAtoms: '200000000' },
      { resource: 'spot-capital', authorityAtoms: '2000000000', demandAtoms: '800000000', requiredReductionAtoms: '0' },
    ],
  })];
  const lines = resourceLines(events);
  assert.deepEqual(lines.map((line) => line.resource), ['portfolio-notional', 'derivative-notional', 'spot-capital']);
  assert.equal(lines[0]?.reduction, '500');
  assert.equal(lines[1]?.reduction, '200');
  assert.equal(lines.some((line) => line.resource === 'total'), false);
  assert.match(ui, /Incomparable reductions are not added together/);
  assert.doesNotMatch(model, /requiredReductionTotal|totalReduction/);
});

test('the Room has zero authority and authorization waits for final protocol evidence', () => {
  const opened = [
    event(1, 'ROOM_OPENED', { participants: ['stock', 'perps'] }, null, { roomId: 'room-1', generation: 1 }),
    event(2, 'ROOM_AGENT_RESPONSE', { action: 'KEEP', from: usd('800'), to: usd('800'), rationale: 'No derivative use.' }, 'stock', { roomId: 'room-1', generation: 1 }),
    event(3, 'ROOM_AGENT_RESPONSE', { action: 'REDUCE', from: usd('600'), to: usd('400'), rationale: 'Fits the derivative limit.' }, 'perps', { roomId: 'room-1', generation: 1 }),
    event(4, 'ROOM_PROPOSAL_CREATED', { conflicts: [{ resource: 'derivative-notional', authority: usd('400'), demand: usd('600'), demandAfter: usd('400'), requiredReduction: usd('200'), remainingReduction: usd('0'), status: 'SATISFIED' }] }),
    event(5, 'MANDATE_REVERIFY_STARTED', { phase: 'reverify' }),
  ];
  const before = derivePresentation(opened);
  assert.equal(before.room.proposal, true);
  assert.equal(before.room.reverify, true);
  assert.equal(before.room.authorized, false);
  assert.deepEqual(before.room.activity.map((item) => item.action), ['KEEP', 'REDUCE', 'RE-VERIFYING']);
  assert.match(ui, /ROOM AUTHORITY/);
  assert.match(ui, /NONE/);
  assert.match(ui, /Not yet authorized/);
  assert.match(ui, /Mandate re-verifying/);
  const after = derivePresentation([...opened, event(6, 'PORTFOLIO_AUTHORIZED', { reserved: usd('1200'), proposals: [{ role: 'stock', outcome: 'RESERVED', requested: usd('800') }, { role: 'perps', outcome: 'RESERVED', requested: usd('400') }] })]);
  assert.equal(after.room.authorized, true);
  assert.equal(after.room.reserved, '1200 USDC');
  assert.equal(after.agents.find((agent) => agent.role === 'stock')?.finalOutcome, 'RESERVED');
});

test('late, stale, timeout, and no-feasible outcomes never manufacture consent', () => {
  const events = [
    event(1, 'ROOM_AGENT_TIMEOUT', { effect: 'UNCHANGED' }, 'yield', { generation: 1 }),
    event(2, 'ROOM_AGENT_STALE_RESPONSE', { reason: 'ANSWERED_AFTER_TIMEOUT', action: 'KEEP', effect: 'IGNORED' }, 'stock', { generation: 1 }),
    event(3, 'ROOM_AGENT_STALE_RESPONSE', { reason: 'LATER_GENERATION_STARTED', action: 'REDUCE', effect: 'IGNORED' }, 'perps', { generation: 1 }),
    event(4, 'ROOM_NO_FEASIBLE_PORTFOLIO', { conflicts: [{ resource: 'derivative-notional', authority: usd('400'), demand: usd('600'), demandAfter: usd('500'), requiredReduction: usd('200'), remainingReduction: usd('100'), status: 'UNRESOLVED' }] }),
  ];
  const view = derivePresentation(events);
  assert.equal(view.agents.find((agent) => agent.role === 'stock')?.ignored, 'LATE');
  assert.equal(view.agents.find((agent) => agent.role === 'perps')?.ignored, 'STALE');
  assert.equal(view.agents.find((agent) => agent.role === 'yield')?.timedOut, true);
  assert.equal(view.room.noFeasible, true);
  assert.equal(view.room.authorized, false);
  assert.equal(view.room.lines[0]?.reduction, '100');
  assert.match(ui, /No allocation change recorded/);
  assert.match(ui, /Nothing was authorized/);
});

test('policy stress preserves identity, actual order, and a compliant control', () => {
  const identity = { agentIdentity: 'VALID', membership: 'VALID', delegation: 'ACTIVE', signature: 'VALID', sameSignerAsSwapAgent: true };
  const events = [
    event(1, 'POLICY_STRESS_STARTED'),
    event(2, 'POLICY_STRESS_CASE_SELECTED', { attempt: 1, caseId: 'RECIPIENT_MISMATCH', rationale: 'test recipient' }),
    event(3, 'POLICY_STRESS_PROPOSAL_SIGNED', { attempt: 1, identity }),
    event(4, 'POLICY_STRESS_PROPOSAL_BLOCKED', { attempt: 1, reasons: ['RECIPIENT_NOT_ALLOWED'], screening: { verdict: 'BLOCKED' } }),
    event(5, 'POLICY_STRESS_CASE_SELECTED', { attempt: 2, caseId: 'COMPLIANT_CONTROL', rationale: 'inside authority' }),
    event(6, 'POLICY_STRESS_PROPOSAL_SIGNED', { attempt: 2, identity }),
    event(7, 'POLICY_STRESS_PROPOSAL_AUTHORIZED', { attempt: 2, screening: { verdict: 'ADMISSIBLE' }, sameIdentityAsRefusedAttempts: true }),
  ];
  const attempts = derivePresentation(events).stress.attempts;
  assert.deepEqual(attempts.map((attempt) => attempt.caseId), ['RECIPIENT_MISMATCH', 'COMPLIANT_CONTROL']);
  assert.deepEqual(attempts.map((attempt) => attempt.outcome), ['REFUSED', 'AUTHORIZED']);
  assert.equal(attempts.every((attempt) => attempt.sameSigner), true);
  assert.match(ui, /Valid agent ≠ valid action/i);
  assert.match(ui, /SAME AGENT/);
  assert.doesNotMatch(ui, /evil AI|hacker AI|rogue bot|defeated the AI/i);
});

test('reserved, submitted, confirmed, and failed settlement states stay distinct', () => {
  const submitted = derivePresentation([event(1, 'TESTNET_TX_SUBMITTED', { txHash: '0xabc', evidence: 'SUBMITTED_UNCONFIRMED' })]);
  assert.equal(submitted.settlement.stage, 'SUBMITTED');
  assert.equal(submitted.settlement.settled, false);
  const failed = derivePresentation([event(1, 'TESTNET_TX_FAILED', { txHash: '0xabc', status: 'REVERTED', evidence: 'FAILED', reason: 'MINED_REVERTED' })]);
  assert.equal(failed.settlement.stage, 'FAILED');
  assert.equal(failed.settlement.settled, false);
  const confirmed = derivePresentation([event(1, 'TESTNET_TX_CONFIRMED', {
    evidence: 'LIVE_TESTNET', txHash: '0xabc', explorerUrl: 'https://explorer.example/tx/0xabc', block: 10, gasUsed: 20, status: 'SUCCESS', network: 'Robinhood Chain Testnet', chainId: 46630,
    authorized: { notionalUsdc: '800', debit: '64', quantity: '6.4' }, tokenIn: { symbol: 'MDUSD', amount: '64' }, tokenOut: { symbol: 'MDEMO', amount: '6.4' },
  })]);
  assert.equal(confirmed.settlement.settled, true);
  assert.equal(confirmed.settlement.evidence, 'LIVE_TESTNET');
  assert.match(confirmed.settlement.fixtureIn ?? '', /MDUSD/);
  assert.match(ui, /Reserved is not settled/);
  assert.match(ui, /A transaction hash is not settlement/);
  assert.match(ui, /Valueless demo assets/);
  assert.match(ui, /Not an NVDA trade/);
  assert.match(ui, /No browser transaction sending exists/);
  assert.match(ui, /href=\{settlement\.explorerUrl\}/);
  assert.doesNotMatch(ui, /\$800 USDC → 6\.4 MDEMO/);
});

test('equal event timestamps are grouped without changing order or time', () => {
  const events = [
    event(0, 'PORTFOLIO_CONFLICT', {}, null, { elapsedMs: 41660 }),
    event(1, 'ROOM_OPENED', {}, null, { elapsedMs: 41660 }),
    event(2, 'ROOM_GENERATION_STARTED', {}, null, { elapsedMs: 41660 }),
    event(3, 'ROOM_AGENT_RESPONSE', {}, 'stock', { elapsedMs: 41661 }),
  ];
  const groups = groupEventsByElapsed(events);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.elapsedMs, 41660);
  assert.deepEqual(groups[0]?.events.map((item) => item.sequence), [0, 1, 2]);
  assert.equal(groups[1]?.elapsedMs, 41661);
  assert.equal(formatDuration(41660), '41.660s');
  assert.equal(formatDuration(41661), '41.661s');
  assert.match(ui, /Equal real timestamps stay equal and are grouped/);
  assert.match(ui, /Step \{event\.sequence \+ 1\}/);
  assert.match(ui, /JSON\.stringify\(event\.data, null, 2\)/);
  assert.doesNotMatch(ui, /random.*time|synthetic.*time/i);
});

test('responsive, reduced-motion, keyboard, and dialog affordances are explicit', () => {
  assert.match(css, /@media \(max-width: 390px\)/);
  assert.match(css, /overflow-x: clip/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /:focus-visible/);
  assert.match(ui, /aria-live="polite"/);
  assert.match(ui, /showModal\(\)/);
  assert.match(ui, /aria-labelledby="authority-title"/);
  assert.match(ui, /aria-label="Close authority"/);
  assert.match(prompt, /onKeyDown/);
  assert.match(prompt, /Shift\+Enter/);
});

test('browser security boundary and Protocol Replay remain unchanged', () => {
  const sources = [ui, model, read('../components/demo/live/live-client.ts'), prompt, lattice].join('\n');
  assert.doesNotMatch(sources, /@mandate\/live-settlement|packages\/live-settlement|privateKey|OPENAI_API_KEY|NEXT_PUBLIC_OPENAI|sk-[A-Za-z0-9]{8}/);
  assert.doesNotMatch(sources, /sendTransaction|signTransaction|eth_sign/i);
  assert.match(replay, /<JudgeExperience\s*\/>/);
  assert.equal(derivePresentation([]).agents.length, 5);
  const roles: RoleName[] = ['stock', 'swap', 'nft', 'yield', 'perps'];
  assert.deepEqual(derivePresentation([]).agents.map((agent) => agent.role), roles);
});
