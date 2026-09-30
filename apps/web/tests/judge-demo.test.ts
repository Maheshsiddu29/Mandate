import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DemoPlayback } from '../../../packages/judge-demo/src/playback.ts';
import { notional } from '../lib/mandate/formatting.ts';
import { JudgeDemoProvider } from '../lib/mandate/judge-demo-provider.ts';
import { derivePresentation } from '../lib/mandate/normalize.ts';
import { PresentationPlayback } from '../lib/mandate/playback.ts';
import { presentationDigestOf, validateTranscript } from '../lib/mandate/transcript.ts';
import type { AmountView, JudgeDemoEvent } from '../lib/mandate/types.ts';

const EXPECTED_DIGEST = '0xf8776a5a7753465d292f4402966529aadc01c58ba3a82575ed75b97298f8b05b';
const EXPECTED_EVENTS = 89;
const assetUrl = new URL('../generated/judge-demo.v1.json', import.meta.url);
const raw = JSON.parse(readFileSync(assetUrl, 'utf8')) as unknown;
const transcript = validateTranscript(raw);
const provider = new JudgeDemoProvider(transcript);

function notionalOf(value: unknown): AmountView | null {
  return Array.isArray(value) ? notional(value as readonly AmountView[]) : null;
}

function kind(name: string, run?: string): JudgeDemoEvent {
  const event = transcript.events.find((item) => item.kind === name && (run === undefined || item.run === run));
  assert.ok(event, name);
  return event;
}

test('generated transcript validates, with the canonical schema, version, count, and digest', () => {
  assert.equal(transcript.schema, 'MANDATE_JUDGE_DEMO.V1');
  assert.equal(transcript.version, 1);
  assert.equal(transcript.presentationOnly, true);
  assert.equal(transcript.events.length, EXPECTED_EVENTS);
  assert.equal(transcript.presentationDigest, EXPECTED_DIGEST);
  assert.equal(presentationDigestOf(transcript.events), EXPECTED_DIGEST);
});

test('summary authority, request, and five agents come from the transcript', async () => {
  const summary = await provider.getSummary();
  const created = kind('PORTFOLIO_CREATED');
  const conflict = kind('RESOURCE_CONFLICT');
  assert.equal(summary.agentCount, 5);
  assert.equal((await provider.getAgents()).length, 5);
  assert.equal(summary.authority.atoms, notionalOf(created.data['globalAuthority'])?.atoms);
  assert.equal(summary.initialRequested?.atoms, notionalOf(conflict.data['initialRequested'])?.atoms);
  assert.equal(summary.admissibleDemand?.atoms, notional(conflict.requested)?.atoms);
  assert.ok(BigInt(summary.admissibleDemand?.atoms ?? '0') > BigInt(summary.authority.atoms));
});

test('security-invalid proposals stay out of the three initial Room rounds', async () => {
  const rounds = (await provider.getRoomRounds()).filter((round) => round.run === 'initial');
  assert.deepEqual(
    rounds.map((round) => round.round),
    [1, 2, 3],
  );
  const blocked = transcript.events.filter((event) => event.kind === 'PROPOSAL_BLOCKED').map((event) => event.proposal);
  assert.ok(blocked.length > 0);
  const opened = kind('MANDATE_ROOM_OPENED', 'initial');
  const excluded = opened.data['excludedAtScreening'];
  assert.ok(Array.isArray(excluded));
  for (const proposal of blocked) {
    assert.equal(typeof proposal, 'string');
    assert.ok(excluded.includes(proposal));
    for (const round of rounds) {
      assert.equal(
        round.steps.some((step) => step.proposal === proposal),
        false,
      );
    }
  }
  const view = derivePresentation(transcript, transcript.events);
  assert.equal(view.blocked.every((card) => card.inRoom === false), true);
});

test('first authorization, attack, continuation, and final limit follow the transcript', async () => {
  const full = derivePresentation(transcript, transcript.events);
  const initial = kind('PORTFOLIO_AUTHORIZED', 'initial');
  const compliant = kind('PORTFOLIO_AUTHORIZED', 'compliant');
  const conflictAuthorized = kind('PORTFOLIO_AUTHORIZED', 'conflict');
  const attack = kind('MALICIOUS_PROPOSAL_BLOCKED');
  const signed = kind('COMPLIANT_PROPOSAL_SIGNED');
  const healthy = kind('HEALTHY_AGENTS_UNAFFECTED');
  const portfolioConflict = kind('PORTFOLIO_RESOURCE_CONFLICT');
  assert.equal(full.firstReserved?.atoms, notionalOf(initial.data['reservedAfter'])?.atoms);
  assert.equal(full.compliantReserved?.atoms, notionalOf(compliant.data['reservedAfter'])?.atoms);
  assert.equal(notionalOf(conflictAuthorized.data['reservedAfter'])?.atoms, full.summary.authority.atoms);
  assert.equal(full.resources.reserved?.atoms, full.summary.authority.atoms);
  assert.equal(attack.agent?.id, signed.agent?.id);
  assert.equal(attack.reasons.some((reason) => reason.code === 'RECIPIENT_NOT_ALLOWED'), true);
  assert.equal(attack.data['reservationsWritten'], 0);
  assert.equal(attack.data['attemptsWritten'], 0);
  assert.equal(attack.data['executionsReachingASigner'], 0);
  assert.equal(attack.data['transactions'], 0);
  const reservations = healthy.data['reservations'];
  assert.ok(Array.isArray(reservations));
  assert.ok(reservations.length > 0);
  for (const reservation of reservations) {
    assert.equal(typeof reservation, 'object');
    assert.ok(reservation !== null);
    const phase = (reservation as { phase?: string }).phase;
    assert.ok(phase === 'RESERVED' || phase === 'ADMITTED');
  }
  assert.equal(reservations.some((reservation) => (reservation as { agent?: string }).agent === attack.agent?.label), true);
  assert.equal(portfolioConflict.data['individuallyValid'], true);
  assert.equal(portfolioConflict.data['portfolioValid'], false);
  const available = notionalOf(healthy.data['availableAfter']);
  assert.equal(available?.atoms, full.summary.authority.atoms && full.firstReserved ? (BigInt(full.summary.authority.atoms) - BigInt(full.firstReserved.atoms)).toString() : '');
});

test('evidence labels do not mark fixture execution as LIVE_TESTNET, and receipts match', async () => {
  const evidence = await provider.getEvidence();
  const stock = evidence.find((item) => item.domain === 'robinhood-evm');
  assert.ok(stock);
  assert.equal(stock.integrationEvidence, 'LIVE_TESTNET');
  assert.equal(stock.historicalLive, true);
  assert.deepEqual([...stock.thisRun], ['OFFCHAIN_ONLY']);
  assert.equal(stock.chainId, '46630');
  for (const item of evidence) {
    if (item.domain !== 'robinhood-evm') assert.equal(item.historicalLive, false);
    assert.equal(item.thisRun.includes('LIVE_TESTNET'), false);
  }
  for (const event of transcript.events) {
    if (event.kind === 'EXECUTION_HANDOFF') assert.notEqual(event.evidence, 'LIVE_TESTNET');
    if (event.kind !== 'LIVE_TESTNET_EVIDENCE') assert.notEqual(event.evidence, 'LIVE_TESTNET');
  }
  const receipts = await provider.getReceipts();
  const completed = kind('DEMO_COMPLETED');
  const listed = completed.data['receipts'];
  assert.ok(Array.isArray(listed));
  for (const item of listed) {
    assert.equal(typeof item, 'object');
    assert.ok(item !== null);
    const run = (item as { run?: string }).run;
    const digest = (item as { receiptDigest?: string }).receiptDigest;
    assert.equal(receipts.find((receipt) => receipt.run === run)?.digest, digest);
  }
});

test('restart replays the same presentation state as DemoPlayback', () => {
  const events = transcript.events;
  const cursor = new PresentationPlayback(events);
  const canonical = new DemoPlayback(events);
  cursor.start();
  canonical.start();
  for (let step = 0; step < 17; step += 1) {
    assert.equal(cursor.next()?.sequence, canonical.next()?.sequence);
    assert.equal(cursor.state, canonical.state);
  }
  const first = derivePresentation(transcript, cursor.shown);
  cursor.restart();
  canonical.restart();
  assert.equal(cursor.state, 'IDLE');
  assert.equal(canonical.state, 'IDLE');
  cursor.start();
  for (let step = 0; step < 17; step += 1) cursor.next();
  const second = derivePresentation(transcript, cursor.shown);
  assert.deepEqual(second.agents.map((agent) => [agent.id, agent.state]), first.agents.map((agent) => [agent.id, agent.state]));
  assert.equal(second.resources.reserved?.atoms, first.resources.reserved?.atoms);
  assert.equal(second.scene, first.scene);
});

test('reduced motion keeps the same events and disables decorative motion', () => {
  const css = readFileSync(new URL('../components/demo/judge/judge-demo.css', import.meta.url), 'utf8');
  const experience = readFileSync(new URL('../components/demo/judge/judge-experience.tsx', import.meta.url), 'utf8');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(experience, /useReducedMotion/);
  assert.match(experience, /judge-demo--motion/);
  const reduced = derivePresentation(transcript, transcript.events);
  const still = derivePresentation(transcript, transcript.events);
  assert.equal(reduced.eventCount, still.eventCount);
  assert.equal(reduced.resources.reserved?.atoms, still.resources.reserved?.atoms);
});

test('committed transcript is not stale against the canonical runner', () => {
  const root = new URL('../../../', import.meta.url);
  execFileSync(process.execPath, ['scripts/check-judge-demo-asset.ts'], {
    cwd: root,
    stdio: 'pipe',
  });
});
