import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Json, JsonRecord, LiveEvent } from '../components/demo/live/live-client.ts';
import { deriveFlow, eventsAfter, type FlowInput } from '../components/demo/live/live-flow.ts';
import { derivePresentation } from '../components/demo/live/live-model.ts';
import { proofStatus, receiptHeading } from '../components/demo/live/settlement-refusal.ts';
import { executeOffered, heldCopy, parseRestored, reconcileOffered, restoreSettlement, type RestoredSettlement } from '../components/demo/live/settlement-restore.ts';

/*
 * C1.5: a reloaded page or a restarted agents:lab restores the settlement
 * state the server read from its journal and ledger
 * (docs/demo/c1-browser-complete-settlement.md §9). The page maps it; it never
 * decides that an attempt is held.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const LIVE = '../components/demo/live/';
const lab = read(`${LIVE}live-lab.tsx`);
const outcome = read(`${LIVE}stage-outcome.tsx`);
const restoreSource = read(`${LIVE}settlement-restore.ts`);
const run: LiveEvent[] = JSON.parse(read('./fixtures/live-stub-run.json'));

function event(sequence: number, kind: string, data: JsonRecord = {}): LiveEvent {
  return { schema: 'MANDATE_LIVE_AI.V1', sessionId: 'lab-1', sequence, kind, at: '2026-10-03T00:00:00.000Z', elapsedMs: sequence, protocolTime: '0', mandateVersion: 1, agent: 'stock', roomId: null, generation: null, data };
}
const idle: FlowInput = { drafting: false, draftPresent: false, reviewing: false, activeVersion: null, amending: false, runStarted: false, task: null, lastRunStatus: null, lastError: null, runEvents: [], paused: false };
const authorized = eventsAfter(run, 4);
const after = (...events: readonly [string, JsonRecord?][]) => [...authorized, ...events.map(([kind, data], i) => event(1_000 + i, kind, data ?? {}))];

const REASON = 'GATE_STATE_UNKNOWN.MARKET.BLOCK_AHEAD_OF_NODE.RPC_-32000:unsupported block number 128270281';
const HASH = `0x${'ab'.repeat(32)}`;
const SIGN: [string, JsonRecord] = ['GATE_EXECUTION_SIGNATURE_REQUIRED', { mode: 'SEND', typedData: { primaryType: 'MandateAuthorization' }, note: 'Sign execution' }];
const INELIGIBLE: [string, JsonRecord] = ['DOMAIN_EXECUTION_INELIGIBLE', { stage: 'DOMAIN', reason: REASON, transactions: 0 }];

/** The `settlement` object the server's session read carries (packages/live-settlement/src/settlement-state.ts). */
function wire(patch: { readonly [key: string]: Json }): JsonRecord {
  return {
    settlementStatus: 'NO_ATTEMPT',
    reservation: '0x01',
    reservationState: 'RESERVED',
    attemptState: null,
    quarantine: null,
    held: false,
    heldUntil: null,
    txHash: null,
    transactions: 0,
    receiptStatus: null,
    pending: null,
    executable: true,
    asOfEvents: 2_000,
    ...patch,
  };
}
const HELD = wire({ settlementStatus: 'HELD', attemptState: 'PREPARED', reservationState: 'ADMITTED', held: true, heldUntil: '1790814765', executable: false });

function restore(events: readonly LiveEvent[], value: JsonRecord | undefined) {
  const restored = parseRestored(value);
  const settlement = restoreSettlement(derivePresentation(events).settlement, events, restored);
  const flow = deriveFlow({ ...idle, draftPresent: true, activeVersion: 1, runStarted: true, runEvents: events, settlement });
  return { restored, settlement, flow, execute: executeOffered(restored, events) };
}

function assertHeld(result: ReturnType<typeof restore>): void {
  assert.equal(result.settlement.stage, 'HELD');
  assert.equal(result.settlement.txHash, null);
  assert.equal(result.settlement.gateSign, null, 'no gate signature is requested again');
  assert.equal(result.flow.phase, 'COMPLETE');
  assert.equal(result.execute, false, 'Execute is not offered for a held attempt');
  assert.equal(reconcileOffered(result.restored), true);
  const heading = receiptHeading({ settled: false, txHash: null, stage: result.settlement.stage, refused: false });
  assert.deepEqual(heading, { title: 'Execution held', pill: '! Held' });
  assert.equal(proofStatus({ settled: false, stage: result.settlement.stage, txHash: null }), 'HELD · NOT SENT');
}

test('C1.5: a reload restores HELD from the server: no Execute, no new gate signature, the exact reason kept', () => {
  // Parked on the gate signature when the page went away: events end at SIGN_GATE.
  const parked = restore(after(SIGN), HELD);
  assertHeld(parked);
  // The refusal that held it, then a stale Execute that only reconciled.
  const refused = restore(after(SIGN, INELIGIBLE, ['SETTLEMENT_RECONCILIATION_STARTED'], ['SETTLEMENT_RECONCILED', { state: 'RECONCILIATION_REQUIRED' }]), wire({ ...HELD, attemptState: 'RECONCILIATION_REQUIRED', quarantine: 'AWAITING_DEADLINE' }));
  assertHeld(refused);
  assert.equal(refused.settlement.detail, REASON);
  // Events alone (no durable state) would have offered Execute again: that is the bug this closes.
  assert.equal(derivePresentation(after(SIGN, INELIGIBLE)).settlement.stage, 'FAILED');
});

test('C1.5: a restarted server restores HELD the same way; a call still open restores its own stage', () => {
  // A restart has no open call, so the server reports HELD for an attempt parked on its signature.
  assertHeld(restore(after(SIGN), HELD));
  // Same process, the signature still awaited: the page keeps the open request (the server says SIGNATURE_REQUIRED).
  const open = restore(after(SIGN), wire({ settlementStatus: 'SIGNATURE_REQUIRED', attemptState: 'PREPARED', reservationState: 'ADMITTED', pending: 'AWAITING_SIGNATURE', executable: false }));
  assert.equal(open.settlement.stage, 'SIGN_GATE');
  assert.notEqual(open.settlement.gateSign, null);
  assert.equal(open.flow.phase, 'SETTLING');
  assert.equal(open.execute, false);
  assert.equal(reconcileOffered(open.restored), false, 'never while a settle call is open');
});

test('C1.5: the held notice says nothing was sent, names the hold time, and never says failed or reverted', () => {
  const format = (ms: number) => `t=${ms}`;
  const held = heldCopy({ reason: REASON, heldUntil: '1790814765' }, format);
  assert.equal(held.title, 'Execution held');
  assert.equal(held.line, 'Mandate signed the exact execution, but chain state could not be verified. Nothing was sent.');
  assert.equal(held.until, 'Reconciliation hold ends after t=1790814765000. It is never resent.');
  const unknown = heldCopy({ reason: '', heldUntil: null }, format);
  assert.match(unknown.until, /^This authorization remains quarantined until every artifact it signed has expired\./);
  for (const copy of [held, unknown]) assert.doesNotMatch(`${copy.title} ${copy.line} ${copy.until}`, /fail|revert/i);
  assert.match(outcome, /<div><dt>Transaction<\/dt><dd>None<\/dd><\/div>/);
  assert.match(outcome, /<div><dt>Broadcasts<\/dt><dd>0<\/dd><\/div>/);
  assert.doesNotMatch(outcome, /Failed transaction|Settlement reverted/);
  // The hold notice replaces the in-memory refusal notice, so it is not shown twice.
  assert.match(outcome, /props\.conflict === null \|\| settlement\.stage === "HELD" \? null : <RefusalNotice/);
});

test('C1.5: a submitted transaction restores SUBMITTED with its hash and offers only a status check', () => {
  const submitted = wire({ settlementStatus: 'SUBMITTED', attemptState: 'SUBMITTED', reservationState: 'ADMITTED', held: true, txHash: HASH, transactions: 1, executable: false });
  // The server died before the TESTNET_TX_SUBMITTED event reached the page: the journal's hash is shown.
  const restarted = restore(after(SIGN), submitted);
  assert.equal(restarted.settlement.stage, 'SUBMITTED');
  assert.equal(restarted.settlement.txHash, HASH);
  assert.equal(restarted.settlement.settled, false);
  assert.equal(restarted.flow.phase, 'SETTLING');
  assert.equal(restarted.execute, false);
  assert.equal(reconcileOffered(restarted.restored), true);
  // The event already carried it: unchanged.
  const seen = restore(after(SIGN, ['TESTNET_TX_SUBMITTED', { txHash: HASH }]), submitted);
  assert.equal(seen.settlement.stage, 'SUBMITTED');
  assert.equal(seen.settlement.txHash, HASH);
});

test('C1.5: a consumed reservation restores SETTLED; a released one restores Not executed; neither offers Execute', () => {
  const events = after(SIGN, ['TESTNET_TX_SUBMITTED', { txHash: HASH }], ['DOMAIN_EXECUTION_SETTLED', { evidence: 'LIVE_TESTNET', txHash: HASH, status: 'SUCCESS', block: '42' }]);
  const settled = restore(events, wire({ settlementStatus: 'SETTLED', attemptState: 'CONSUMED', reservationState: 'CONSUMED', txHash: HASH, transactions: 1, receiptStatus: 'SUCCESS', executable: false }));
  assert.equal(settled.settlement.stage, 'SETTLED');
  assert.equal(settled.settlement.settled, true);
  assert.equal(settled.settlement.consumed, true);
  assert.equal(settled.flow.phase, 'COMPLETE');
  assert.equal(settled.execute, false);
  assert.equal(receiptHeading({ settled: true, txHash: HASH, stage: 'SETTLED', refused: false }).title, 'Settled');

  const released = restore(after(SIGN, INELIGIBLE), wire({ settlementStatus: 'RELEASED', attemptState: 'RELEASED', reservationState: 'RELEASED', executable: false }));
  assert.equal(released.settlement.stage, 'RELEASED');
  assert.equal(released.settlement.txHash, null);
  assert.equal(released.flow.phase, 'COMPLETE');
  assert.equal(released.execute, false, 'a released reservation is never executed; the old signature is never reused');
  assert.equal(reconcileOffered(released.restored), false);
  assert.deepEqual(receiptHeading({ settled: false, txHash: null, stage: 'RELEASED', refused: false }), { title: 'Not executed', pill: '✕ Not executed' });
  assert.equal(proofStatus({ settled: false, stage: 'RELEASED', txHash: null }), 'NOT EXECUTED');
});

test('C1.5: the READY path is unchanged — no attempt and an open reservation offers Execute', () => {
  const ready = restore(authorized, wire({}));
  assert.deepEqual(ready.settlement, derivePresentation(authorized).settlement);
  assert.equal(ready.flow.phase, 'COMPLETE');
  assert.equal(ready.execute, true);
  assert.equal(reconcileOffered(ready.restored), false);
  // A settle call that died with the server before anything was signed: not Executing, nothing sent, Execute stays.
  const interrupted = restore(after(['TESTNET_PREFLIGHT_STARTED']), wire({}));
  assert.equal(interrupted.settlement.stage, 'FAILED');
  assert.equal(interrupted.settlement.detail, 'SETTLEMENT_INTERRUPTED');
  assert.equal(interrupted.flow.phase, 'COMPLETE');
  assert.equal(interrupted.execute, true);
  assert.equal(proofStatus({ settled: false, stage: 'FAILED', txHash: null }), 'NOT SENT');
});

test('C1.5: without current durable state there is no Execute — absent, malformed, or older than the events', () => {
  assert.equal(executeOffered(null, authorized), false);
  assert.equal(parseRestored(undefined), null);
  assert.equal(parseRestored(wire({ settlementStatus: 'MAYBE' })), null);
  assert.equal(parseRestored(wire({ executable: 'yes' })), null);
  assert.equal(parseRestored(wire({ heldUntil: 'soon' })), null);
  assert.equal(parseRestored(wire({ pending: 'LATER' })), null);
  assert.equal(parseRestored(wire({ asOfEvents: -1 })), null);
  const { executable: _omitted, ...missing } = wire({});
  assert.equal(parseRestored(missing), null);
  // A settlement event the read had not seen: the events win and Execute waits for the next read.
  const events = after(SIGN, ['TESTNET_TX_SUBMITTED', { txHash: HASH }]);
  const stale: RestoredSettlement | null = parseRestored(wire({ asOfEvents: 1_001 }));
  assert.notEqual(stale, null);
  assert.equal(restoreSettlement(derivePresentation(events).settlement, events, stale).stage, 'SUBMITTED');
  assert.equal(executeOffered(stale, events), false);
});

test('C1.5: the page reads the hold only from the session read, re-reads it as settlement moves, and stores none of it', () => {
  assert.match(lab, /parseRestored\(view\.settlement\)/);
  assert.match(lab, /restoreSettlement\(presentation\.settlement, runEvents, restored\)/);
  assert.match(lab, /executionRetry\(settleConflict\?\.code \?\? null, settleConflict\?\.held \?\? false\) && executeOffered\(restored, runEvents\)/);
  assert.match(lab, /const gate = settlement\.gateSign;/);
  assert.match(lab, /postSettle\(\{ mode: "RECONCILE" \}\);\s*await refresh\(\);/);
  assert.match(lab, /postSettle\(\{ mode: "SEND", intent: "EXECUTE_ROBINHOOD_TESTNET" \}\);\s*await refresh\(\);/);
  for (const kind of ['DOMAIN_EXECUTION_INELIGIBLE', 'SETTLEMENT_RECONCILED', 'RESERVATION_RELEASED', 'RESERVATION_CONSUMED', 'TESTNET_TX_SUBMITTED']) assert.match(lab, new RegExp(`"${kind}",`));
  // No clock, timer or storage decides a hold.
  assert.doesNotMatch(restoreSource, /localStorage|sessionStorage|Date\.now|new Date|setTimeout|setInterval/);
  assert.doesNotMatch(lab, /(localStorage|sessionStorage)\.setItem\([^)]*(settle|held|hold|attempt)/i);
});
