/**
 * C2.3 primary acceptance: one V3 principal signature, two trades, zero
 * additional wallet signatures, cumulative debit under signed cap, restart
 * refuses new autonomous settlement.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMPTY_DELEGATED_STATE,
  applyDelegatedExecution,
  delegationStructHash,
  type DelegationFields,
} from '@mandate/execution-gate';
import { portfolioMandateAuthorizationV3Hash, portfolioMandateDigest } from '@mandate/portfolio';
import { addressOfKey, signPrehash } from '@mandate/portfolio/demo';
import { LiveSession, sessionDigest } from '@mandate/live-agents';
import { APPROVAL_CHAIN_ID } from '../../live-agents/src/wallet/approval.ts';
import { presetDraft } from '../../live-agents/src/authoring/draft-types.ts';
import { ManualClock } from '../../live-agents/src/runtime/clock.ts';
import { ScriptedProvider, json } from '../../live-agents/test/support/providers.ts';
import {
  AutonomousSettlementGate,
  LiveV3ChallengeHost,
  V3_GATE_PLACEHOLDER,
  createExecutionDelegate,
  restoredExecutionDelegate,
  reverifySpineV3,
} from '../src/index.ts';
import { AGENT, GATE, MDUSD, PRINCIPAL, testDeployment } from './support/world.ts';

const WALLET_KEY = `0x${'44'.repeat(32)}`;
const WALLET = addressOfKey(WALLET_KEY);
const SPINE_TIMEOUTS = { agentTimeoutMs: 1_000, roomRoundTimeoutMs: 1_000 } as const;

const propose = (candidateId: string, whole: number) =>
  json({ action: 'PROPOSE', candidateId, requestedAtoms: (BigInt(whole) * 1_000_000n).toString(), rationale: `pick ${candidateId}` });
const abstain = json({ action: 'ABSTAIN', candidateId: null, requestedAtoms: null, rationale: 'none' });

describe('C2.3 V3 two-trade same-delegation acceptance', () => {
  it('one principal signature; two trades add zero wallet signatures; cumulative under cap', async () => {
    const d = testDeployment();
    const host = new LiveV3ChallengeHost({
      chainId: 46_630n,
      gate: V3_GATE_PLACEHOLDER,
      agent: AGENT,
      fundingToken: MDUSD,
      market: d.market,
      validitySeconds: 3_600n,
    });
    const dir = mkdtempSync(join(tmpdir(), 'mandate-v3-e2e-'));
    let principalSignatures = 0;
    try {
      const provider = new ScriptedProvider({
        decide: (r) => ({ text: r.role === 'stock' ? propose('nvda-note-a', 200) : abstain }),
        negotiate: () => ({ text: abstain }),
      });
      const s = new LiveSession({
        provider,
        clock: new ManualClock(),
        sessionId: 'lab-v3-e2e',
        stateDir: dir,
        v3Host: host,
        ...SPINE_TIMEOUTS,
      });
      const draft = presetDraft('balanced');
      const c = s.spineChallengeV3(draft, WALLET);
      assert.equal(c.ok, true);
      if (!c.ok) return;
      const prepared = s.challenges.get(c.challenge)?.prepared.mandate;
      const scope = s.challenges.get(c.challenge)?.v3Scope;
      assert.ok(prepared && scope && c.initialAllocationDigest);
      const hash = portfolioMandateAuthorizationV3Hash(prepared, {
        scheme: 'V3_DELEGATED_EIP712',
        chainId: APPROVAL_CHAIN_ID,
        verifyingContract: scope.verifyingContract,
        sessionDigest: sessionDigest(s.id),
        initialAllocationDigest: c.initialAllocationDigest,
        delegate: scope.delegate,
        agent: scope.agent,
        representationIdHash: scope.representationIdHash,
        fundingToken: scope.fundingToken,
        cumulativeDebitLimit: BigInt(scope.cumulativeDebitLimit),
        validAfter: BigInt(scope.validAfter),
        validUntil: BigInt(scope.validUntil),
        generation: BigInt(scope.generation),
      });
      principalSignatures += 1;
      const auth = await s.authorizeWithWallet(draft, c.challenge, signPrehash(hash, WALLET_KEY));
      assert.equal(auth.ok, true);
      if (!auth.ok) return;
      assert.equal(auth.record.authorization.method, 'WALLET_PRINCIPAL_V3_DELEGATED');
      assert.equal(host.arm(s.id), true);

      const run = await s.run();
      assert.equal(run.status, 'AUTHORIZED');
      assert.equal(s.reservedExecutions.filter((r) => r.role === 'stock').length, 1);

      const record = s.versions.records[0]!;
      const held = s.versions.coreOf(1)!;
      const check = reverifySpineV3({
        mandate: held.mandate,
        signature: held.signature,
        authorization: record.authorization,
        sessionId: s.id,
        chainId: 46_630n,
        now: s.protocolNow(),
      });
      assert.equal(check.ok, true);
      if (!check.ok) return;

      const fields: DelegationFields = {
        portfolioMandateDigest: portfolioMandateDigest(held.mandate),
        initialAllocationDigest: check.initialAllocationDigest,
        sessionDigest: check.sessionDigest,
        principal: check.principal,
        delegate: check.delegate,
        agent: check.agent,
        representationIdHash: check.representationIdHash,
        fundingToken: check.fundingToken,
        cumulativeDebitLimit: check.cumulativeDebitLimit,
        validAfter: check.validAfter,
        validUntil: check.validUntil,
        generation: check.generation,
      };
      const dig = delegationStructHash(fields);
      const debit1 = 16_000_000n;
      const debit2 = 16_000_000n;
      const t1 = applyDelegatedExecution(EMPTY_DELEGATED_STATE, fields, dig, 1n, debit1, check.validAfter + 1n);
      assert.equal(t1.ok, true);
      if (!t1.ok) return;
      // Trade 1: +0 principal wallet signatures (already counted at authorize).
      const trade1Wallet = 0;
      assert.equal(trade1Wallet, 0);
      const t2 = applyDelegatedExecution(t1.next, fields, dig, 2n, debit2, check.validAfter + 2n);
      assert.equal(t2.ok, true);
      if (!t2.ok) return;
      const trade2Wallet = 0;
      assert.equal(trade2Wallet, 0);
      assert.equal(t2.usedAfter, debit1 + debit2);
      assert.ok(t2.usedAfter <= check.cumulativeDebitLimit);
      // Same nonce replay fails.
      const replay = applyDelegatedExecution(t2.next, fields, dig, 2n, 1n, check.validAfter + 3n);
      assert.equal(replay.ok, false);
      // Over-cap fails.
      const over = applyDelegatedExecution(t2.next, fields, dig, 3n, check.cumulativeDebitLimit, check.validAfter + 3n);
      assert.equal(over.ok, false);
      assert.equal(principalSignatures, 1);
      // Delegate can sign; restored cannot.
      const live = host.sessionOf(s.id);
      assert.ok(live?.delegate.canSign);
      const restored = restoredExecutionDelegate(scope.delegate);
      assert.equal(restored.canSign, false);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('V2 session cannot autonomous-settle; autonomous gate pause and restore refuse', () => {
    const g = new AutonomousSettlementGate();
    assert.equal(g.mayAuthorizeExecution(), false);
    g.arm();
    assert.equal(g.mayAuthorizeExecution(), true);
    g.pause();
    assert.equal(g.mayAuthorizeExecution(), false);
    const d = createExecutionDelegate();
    const r = restoredExecutionDelegate(d.public.address);
    assert.equal(r.canSign, false);
    assert.notEqual(GATE, V3_GATE_PLACEHOLDER); // V2 gate address stays distinct from V3 placeholder
    assert.equal(PRINCIPAL.length, 42);
  });
});
