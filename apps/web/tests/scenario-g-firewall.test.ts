/**
 * Scenario G — expose existing Policy Stress from the V3 receipt.
 * Offchain authorization evidence only; never settlement / LIVE_TESTNET.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { LiveEvent } from '../components/demo/live/live-client.ts';
import { derivePresentation, deriveStress, explainReasons } from '../components/demo/live/live-model.ts';
import { executeOffered, parseRestored } from '../components/demo/live/settlement-restore.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const outcome = readFileSync(`${root}/components/demo/live/stage-outcome.tsx`, 'utf8');
const lab = readFileSync(`${root}/components/demo/live/live-lab.tsx`, 'utf8');
const sheets = readFileSync(`${root}/components/demo/live/sheets.tsx`, 'utf8');
const wallet = readFileSync(`${root}/components/demo/live/wallet.ts`, 'utf8');

function event(sequence: number, kind: string, data: Record<string, unknown> = {}, agent: string | null = 'swap'): LiveEvent {
  return {
    schema: 'MANDATE_LIVE_AI.V1',
    sessionId: 'lab-scenario-g',
    sequence,
    kind,
    at: '2026-10-04T00:00:00.000Z',
    elapsedMs: sequence,
    protocolTime: String(sequence),
    mandateVersion: 1,
    agent,
    roomId: null,
    generation: null,
    data,
  };
}

const identity = {
  agentIdentity: 'VALID',
  membership: 'VALID',
  delegation: 'ACTIVE',
  signature: 'VALID',
  sameSignerAsSwapAgent: true,
};

function blocked(sequence: number, attempt: number, caseId: string, reasons: readonly string[]): LiveEvent[] {
  return [
    event(sequence, 'POLICY_STRESS_CASE_SELECTED', { attempt, caseId, rationale: `probe ${caseId}` }),
    event(sequence + 1, 'POLICY_STRESS_PROPOSAL_SIGNED', { attempt, caseId, identity }),
    event(sequence + 2, 'POLICY_STRESS_PROPOSAL_BLOCKED', {
      attempt,
      caseId,
      reasons,
      screening: { verdict: 'BLOCKED' },
      ledgerUnchanged: true,
      ledger: { versionBefore: '1', versionAfter: '1', reservationsBefore: 1, reservationsAfter: 1 },
    }),
  ];
}

describe('Scenario G — Test the firewall on V3 receipt', () => {
  it('settled V3 receipt exposes Test the firewall near Review details', () => {
    assert.match(outcome, /Test the firewall/);
    assert.match(outcome, /onFirewall/);
    assert.match(outcome, /firewallAvailable/);
    const firewallAt = outcome.indexOf('Test the firewall');
    const detailsAt = outcome.indexOf('Review details');
    assert.ok(detailsAt >= 0 && firewallAt > detailsAt, 'firewall CTA sits with receipt post-trade actions');
    assert.match(lab, /onFirewall=\{\(\) => \{\s*setSheet\("stress"\)/);
    assert.match(lab, /POST", "\/policy-stress"/);
    assert.match(lab, /title="Security test"/);
    assert.match(lab, /kicker="VALID AGENT ≠ VALID ACTION"/);
    assert.doesNotMatch(lab, /setSheet\("events"\).*Test the firewall|Developer[\s\S]*Test the firewall/);
  });

  it('Policy Stress panel keeps VALID AGENT ≠ VALID ACTION and same-signer proof', () => {
    assert.match(sheets, /VALID AGENT ≠ VALID ACTION/);
    assert.match(sheets, /The agent identity and signature remain valid/);
    assert.match(sheets, /A valid agent signature proves who proposed the action/);
    assert.match(sheets, /It does not prove the action is authorized/);
    assert.match(sheets, /Same valid agent/);
    assert.match(sheets, /Same signer as Swap agent/);
    assert.match(sheets, /Try an unauthorized action/);
  });

  it('existing harness refuses attack cases and authorizes the compliant control', () => {
    const events = [
      event(1, 'POLICY_STRESS_STARTED', { headline: 'VALID AGENT ≠ VALID ACTION', title: 'POLICY STRESS TEST' }),
      ...blocked(2, 1, 'RECIPIENT_MISMATCH', ['RECIPIENT_NOT_ALLOWED']),
      ...blocked(5, 2, 'UNAPPROVED_VENUE', ['VENUE_NOT_ALLOWED']),
      ...blocked(8, 3, 'REPRESENTATION_MISMATCH', ['INSTRUMENT_UNKNOWN']),
      ...blocked(11, 4, 'OVER_LIMIT', ['AGENT_LIMIT_EXCEEDED']),
      event(14, 'POLICY_STRESS_CASE_SELECTED', { attempt: 5, caseId: 'COMPLIANT_CONTROL', rationale: 'inside authority' }),
      event(15, 'POLICY_STRESS_PROPOSAL_SIGNED', { attempt: 5, caseId: 'COMPLIANT_CONTROL', identity }),
      event(16, 'POLICY_STRESS_PROPOSAL_AUTHORIZED', {
        attempt: 5,
        caseId: 'COMPLIANT_CONTROL',
        screening: { verdict: 'ADMISSIBLE' },
        sameIdentityAsRefusedAttempts: true,
        note: 'The same agent identity, evaluated again under the same authorization system: this proposal is inside its authority.',
      }),
      event(17, 'POLICY_STRESS_COMPLETED', { endedBy: 'MAX_ATTEMPTS' }),
    ];
    const stress = deriveStress(events);
    assert.equal(stress.started, true);
    assert.deepEqual(stress.attempts.map((a) => a.caseId), [
      'RECIPIENT_MISMATCH',
      'UNAPPROVED_VENUE',
      'REPRESENTATION_MISMATCH',
      'OVER_LIMIT',
      'COMPLIANT_CONTROL',
    ]);
    assert.deepEqual(stress.attempts.map((a) => a.outcome), ['REFUSED', 'REFUSED', 'REFUSED', 'REFUSED', 'AUTHORIZED']);
    assert.equal(explainReasons(['RECIPIENT_NOT_ALLOWED']).headline, 'Recipient not allowed');
    assert.equal(explainReasons(['VENUE_NOT_ALLOWED']).headline, 'Venue not allowed');
    assert.equal(explainReasons(['INSTRUMENT_UNKNOWN']).headline, 'Unknown instrument');
    assert.equal(explainReasons(['AGENT_LIMIT_EXCEEDED']).headline, 'Agent limit exceeded');
    for (const refused of stress.attempts.filter((a) => a.outcome === 'REFUSED')) {
      assert.equal(refused.ledgerUnchanged, true);
      assert.equal(refused.sameSigner, true);
      assert.equal(refused.identity.sameSignerAsSwapAgent, true);
    }
    assert.equal(stress.attempts[4]?.sameSigner, true);
    assert.match(sheets, /Settlement[\s\S]*NOT STARTED/);
    assert.match(sheets, /Broadcasts[\s\S]*0/);
    assert.match(sheets, /Ledger unchanged/);
    assert.match(sheets, /not LIVE_TESTNET/);
    assert.doesNotMatch(sheets, /evidence:\s*"LIVE_TESTNET"|LIVE_TESTNET settlement/);
  });

  it('Policy Stress never opens settlement or reseeds Execute on restore', () => {
    assert.match(lab, /POST", "\/policy-stress"/);
    assert.doesNotMatch(lab, /policy-stress[\s\S]{0,200}mode:\s*"SEND"/);
    assert.doesNotMatch(sheets, /eth_sendTransaction|Execute on Robinhood/);
    const restored = parseRestored({
      settlementStatus: 'SETTLED',
      reservation: '0x01',
      reservationState: 'CONSUMED',
      attemptState: 'SETTLED',
      quarantine: null,
      held: false,
      heldUntil: null,
      txHash: `0x${'ab'.repeat(32)}`,
      transactions: 1,
      receiptStatus: 'SUCCESS',
      pending: null,
      executable: false,
      asOfEvents: 100,
    });
    assert.ok(restored);
    assert.equal(executeOffered(restored, []), false);
    assert.match(lab, /firewallAvailable=\{activeVersion !== null && view\.paused !== true\}/);
    // V2 Execute path remains for non-V3 receipts.
    assert.match(outcome, /Execute on Robinhood Testnet/);
    assert.match(wallet, /eth_signTypedData_v4/);
  });

  it('successful settlement receipt fields stay separate from Policy Stress', () => {
    const settled = derivePresentation([
      event(1, 'DOMAIN_EXECUTION_SETTLED', {
        spine: 'V3',
        evidence: 'LIVE_TESTNET',
        txHash: `0x${'cd'.repeat(32)}`,
        status: 'SUCCESS',
        transactions: 1,
      }, 'stock'),
      event(2, 'POLICY_STRESS_STARTED', { headline: 'VALID AGENT ≠ VALID ACTION' }),
      ...blocked(3, 1, 'RECIPIENT_MISMATCH', ['RECIPIENT_NOT_ALLOWED']),
    ]);
    assert.equal(settled.settlement.settled, true);
    assert.equal(settled.settlement.evidence, 'LIVE_TESTNET');
    assert.equal(settled.stress.attempts[0]?.outcome, 'REFUSED');
    assert.notEqual(settled.stress.attempts[0]?.outcome, 'SETTLED');
    assert.match(outcome, /Per-trade wallet approval: None/);
    assert.match(outcome, /FIXTURE_QUALIFICATION/);
  });
});
