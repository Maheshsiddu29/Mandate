import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { LiveEvent } from '../components/demo/live/live-client.ts';
import { deriveFlow, eventsAfter, PHASES, type FlowInput } from '../components/demo/live/live-flow.ts';
import { deriveRoomChat, deriveReview } from '../components/demo/live/live-model.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const lab = read('../components/demo/live/live-lab.tsx');
const css = read('../components/demo/live/live-workspace.css');
const run: LiveEvent[] = JSON.parse(read('./fixtures/live-stub-run.json'));
const base: FlowInput = { drafting: false, draftPresent: true, reviewing: false, activeVersion: 1, amending: false, runStarted: true, task: 'RUN', lastRunStatus: null, lastError: null, runEvents: [], paused: false };

test('one main panel: every phase renders exactly one stage inside one animated section', () => {
  assert.equal(PHASES.length, 13);
  for (const phase of PHASES) assert.match(lab, new RegExp(`case "${phase}":`), phase);
  assert.equal(lab.match(/<motion\.section/g)?.length, 1);
  assert.match(lab, /<AnimatePresence mode="wait" initial=\{false\}>/);
  // Agents working and Mandate review are one surface that keeps its rows mounted.
  assert.match(lab, /AGENTS_WORKING: "agents",\s*MANDATE_REVIEW: "agents",/);
});

test('the flow follows the real run in sequence order and never moves backwards on its own', () => {
  const order = PHASES as readonly string[];
  let last = -1;
  for (let sequence = 4; sequence <= 43; sequence += 1) {
    const phase = deriveFlow({ ...base, runEvents: eventsAfter(run.filter((item) => item.sequence <= sequence), 4) }).phase;
    const index = order.indexOf(phase);
    assert.ok(index >= last, `${sequence}: ${phase}`);
    last = index;
  }
});

test('amending an active mandate returns to the agent team without a new run', () => {
  assert.equal(deriveFlow({ ...base, amending: true }).phase, 'CONFIGURE');
  assert.equal(deriveFlow({ ...base, amending: true, reviewing: true }).phase, 'APPROVE');
  assert.match(lab, /call\("POST", "\/draft", \{ from: "active" \}\)/);
});

test('a run is sliced by the server event count, so a second run never reuses the first run\'s events', () => {
  assert.match(lab, /typeof body\.events === "number" \? body\.events - 1 : lastSequence\.current/);
  const second = eventsAfter(run, 43);
  assert.equal(second.length, 0);
  assert.equal(deriveReview(second).authorizedCount, 0);
  assert.equal(deriveRoomChat(second).length, 0);
});

test('the panel stays in view on phase changes without moving a page that already shows it', () => {
  assert.match(lab, /if \(top >= 72 && top <= window\.innerHeight \* 0\.5\) return;/);
  assert.match(lab, /behavior: reduced \? "auto" : "smooth"/);
  assert.match(css, /scroll-margin-top/);
});

test('menus close on selection and on Escape, and the phone bar stays one row', () => {
  assert.match(lab, /function closeMenu\(target: Element\)/);
  assert.equal(lab.match(/if \(event\.key === "Escape"\) closeMenu\(event\.currentTarget\)/g)?.length, 2);
  assert.match(css, /\.mw-bar \{ flex-wrap: nowrap;/);
  assert.match(css, /\.mw-menu__replay \{ display: grid; \}/);
});

test('the browser never sends a chaos spec or any development-only setting', () => {
  assert.match(lab, /api\(SERVER, "POST", "\/sessions", \{ provider: providerChoice \}\)/);
  assert.doesNotMatch(lab, /chaos/);
});

test('the Mandate Room is conditional: a run without a conflict never shows the Room phase or its chrome', () => {
  const e = (sequence: number, kind: string, agent: string | null = null): LiveEvent => ({ schema: 'MANDATE_LIVE_AI.V1', sessionId: 'lab-1', sequence, kind, at: '2026-10-02T00:00:00.000Z', elapsedMs: sequence * 100, protocolTime: '0', mandateVersion: 1, agent, roomId: null, generation: null, data: {} });
  const direct = [e(1, 'AGENT_REQUEST_STARTED', 'stock'), e(2, 'AGENT_DECISION_COMPLETED', 'stock'), e(3, 'PROPOSAL_ADMISSIBLE', 'stock'), e(4, 'MANDATE_REVERIFY_STARTED'), e(5, 'PORTFOLIO_AUTHORIZED')];
  const phases = direct.map((_, i) => deriveFlow({ ...base, runEvents: direct.slice(0, i + 1) }).phase);
  assert.ok(!phases.includes('ROOM'), phases.join(' → '));
  assert.equal(phases.at(-1), 'AUTHORIZED');
  // The Room sheet, its trail entry and the failure's Room link appear only once a ROOM_OPENED was seen.
  assert.match(lab, /const roomSeen = runEvents\.some\(\(event\) => event\.kind === "ROOM_OPENED"\);/);
  assert.match(lab, /roomSeen && phase !== "ROOM"/);
  // With a conflict, the Room opens automatically from the real event.
  const conflicted = [...direct.slice(0, 3), e(4, 'PORTFOLIO_CONFLICT'), e(5, 'ROOM_OPENED')];
  assert.equal(deriveFlow({ ...base, runEvents: conflicted }).phase, 'ROOM');
});
