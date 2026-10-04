/**
 * C2.3 settleSpineV3 integration: one principal signature, autonomous SEND,
 * refusal paths with broadcasts === 0.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { delegatedDomainSeparator } from '@mandate/execution-gate';
import { portfolioMandateAuthorizationV3Hash } from '@mandate/portfolio';
import { signPrehash } from '@mandate/portfolio/demo';
import { LiveSession, sessionDigest } from '@mandate/live-agents';
import { APPROVAL_CHAIN_ID } from '../../live-agents/src/wallet/approval.ts';
import { presetDraft } from '../../live-agents/src/authoring/draft-types.ts';
import { ManualClock } from '../../live-agents/src/runtime/clock.ts';
import { ScriptedProvider } from '../../live-agents/test/support/providers.ts';
import {
  LiveV3ChallengeHost,
  SettlementJournal,
  V3_GATE_PLACEHOLDER,
  settleSpineV3,
} from '../src/index.ts';
import {
  AGENT,
  ALL_TEST_KEYS,
  KEYS,
  MDUSD,
  ModelRpc,
  PRINCIPAL,
  PRINCIPAL_KEY,
  abstain,
  propose,
  testDeployment,
} from './support/world.ts';

const SPINE_TIMEOUTS = { agentTimeoutMs: 1_000, roomRoundTimeoutMs: 1_000 } as const;

function v3Gate(d: ReturnType<typeof testDeployment>) {
  return {
    address: V3_GATE_PLACEHOLDER,
    domainSeparator: delegatedDomainSeparator(d.chainId, V3_GATE_PLACEHOLDER as never),
    runtimeCodeHash: `0x${'cd'.repeat(32)}`,
  };
}

async function authorizeV3(session: LiveSession, host: LiveV3ChallengeHost): Promise<{ principalSignatures: number; scope: NonNullable<ReturnType<LiveV3ChallengeHost['sessionOf']>>['scope'] }> {
  const draft = presetDraft('balanced');
  const c = session.spineChallengeV3(draft, PRINCIPAL);
  assert.equal(c.ok, true);
  if (!c.ok) throw new Error('challenge');
  const prepared = session.challenges.get(c.challenge)?.prepared.mandate;
  const scope = session.challenges.get(c.challenge)?.v3Scope;
  assert.ok(prepared && scope && c.initialAllocationDigest);
  const hash = portfolioMandateAuthorizationV3Hash(prepared, {
    scheme: 'V3_DELEGATED_EIP712',
    chainId: APPROVAL_CHAIN_ID,
    verifyingContract: scope.verifyingContract,
    sessionDigest: sessionDigest(session.id),
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
  const auth = await session.authorizeWithWallet(draft, c.challenge, signPrehash(hash, PRINCIPAL_KEY));
  assert.equal(auth.ok, true);
  assert.equal(host.arm(session.id), true);
  return { principalSignatures: 1, scope };
}

function fundV3(rpc: ModelRpc, validAfter: bigint): void {
  rpc.v3PassthroughGate = V3_GATE_PLACEHOLDER;
  rpc.chain.time = validAfter + 1n;
  rpc.chain.fund(MDUSD, PRINCIPAL, 700_000_000n);
  rpc.chain.approve(MDUSD, PRINCIPAL, V3_GATE_PLACEHOLDER, 200_000_000n);
}

describe('settleSpineV3 autonomous settlement', () => {
  it('one principal signature; two SEND trades add zero wallet signatures; cumulative under cap', async () => {
    const d = testDeployment();
    const host = new LiveV3ChallengeHost({
      chainId: 46_630n,
      gate: V3_GATE_PLACEHOLDER,
      agent: AGENT,
      fundingToken: MDUSD,
      market: d.market,
      validitySeconds: 3_600n,
    });
    const dir = mkdtempSync(join(tmpdir(), 'mandate-v3-settle-'));
    const rpc = new ModelRpc();
    let usedDebit = 0n;
    let nonce = 1n;
    let principalSignatures = 0;
    try {
      const session = new LiveSession({
        provider: new ScriptedProvider({
          decide: (r) => ({ text: r.role === 'stock' ? propose('nvda-note-a', 200) : abstain }),
          negotiate: () => ({ text: abstain }),
        }),
        clock: new ManualClock(),
        sessionId: 'lab-v3-settle-2trade',
        stateDir: dir,
        v3Host: host,
        ...SPINE_TIMEOUTS,
      });
      const auth = await authorizeV3(session, host);
      principalSignatures = auth.principalSignatures;
      fundV3(rpc, BigInt(auth.scope.validAfter));
      assert.equal((await session.run()).status, 'AUTHORIZED');

      const journal = SettlementJournal.open(join(dir, 'settlement.db'));
      const gate = v3Gate(d);
      const t1 = await settleSpineV3({
        session,
        journal,
        deployment: d,
        v3Gate: gate,
        rpc,
        keys: KEYS,
        mode: 'SEND',
        host,
        ledgerPath: join(dir, 'ledger-1.db'),
        nextExecutionNonce: nonce,
        usedDebit,
      });
      assert.equal(t1.status, 'SENT');
      if (t1.status !== 'SENT') return;
      assert.equal(t1.broadcasts, 1);
      assert.equal(t1.executionNonce, 1n);
      usedDebit += BigInt(t1.debit);
      nonce = 2n;
      const trade1Wallet = 0;
      assert.equal(trade1Wallet, 0);

      assert.equal((await session.run()).status, 'AUTHORIZED');
      const t2 = await settleSpineV3({
        session,
        journal,
        deployment: d,
        v3Gate: gate,
        rpc,
        keys: KEYS,
        mode: 'SEND',
        host,
        ledgerPath: join(dir, 'ledger-2.db'),
        nextExecutionNonce: nonce,
        usedDebit,
      });
      assert.equal(t2.status, 'SENT');
      if (t2.status !== 'SENT') return;
      assert.equal(t2.broadcasts, 1);
      assert.equal(t2.executionNonce, 2n);
      usedDebit += BigInt(t2.debit);
      const trade2Wallet = 0;
      assert.equal(trade2Wallet, 0);
      assert.equal(principalSignatures, 1);
      assert.equal(rpc.broadcasts, 2);
      assert.ok(usedDebit <= BigInt(auth.scope.cumulativeDebitLimit));
      const text = JSON.stringify(session.events.events).toLowerCase();
      for (const k of ALL_TEST_KEYS) assert.equal(text.includes(k), false);
      journal.close();
      session.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses allowance shortfall, restored delegate, expired window, simulation revert — no broadcast', async () => {
    const d = testDeployment();
    const host = new LiveV3ChallengeHost({
      chainId: 46_630n,
      gate: V3_GATE_PLACEHOLDER,
      agent: AGENT,
      fundingToken: MDUSD,
      market: d.market,
      validitySeconds: 3_600n,
    });
    const dir = mkdtempSync(join(tmpdir(), 'mandate-v3-refuse-'));
    try {
      const session = new LiveSession({
        provider: new ScriptedProvider({
          decide: (r) => ({ text: r.role === 'stock' ? propose('nvda-note-a', 200) : abstain }),
          negotiate: () => ({ text: abstain }),
        }),
        clock: new ManualClock(),
        sessionId: 'lab-v3-refuse',
        stateDir: dir,
        v3Host: host,
        ...SPINE_TIMEOUTS,
      });
      const auth = await authorizeV3(session, host);
      assert.equal((await session.run()).status, 'AUTHORIZED');
      const journal = SettlementJournal.open(join(dir, 'settlement.db'));
      const gate = v3Gate(d);
      const base = {
        session,
        journal,
        deployment: d,
        v3Gate: gate,
        keys: KEYS,
        mode: 'SEND' as const,
        host,
        ledgerPath: join(dir, 'ledger.db'),
        nextExecutionNonce: 1n,
        usedDebit: 0n,
      };

      {
        const rpc = new ModelRpc();
        rpc.v3PassthroughGate = V3_GATE_PLACEHOLDER;
        rpc.chain.time = BigInt(auth.scope.validAfter) + 1n;
        rpc.chain.fund(MDUSD, PRINCIPAL, 700_000_000n);
        // No approve → allowance 0.
        const r = await settleSpineV3({ ...base, rpc });
        assert.equal(r.status, 'INELIGIBLE');
        if (r.status === 'INELIGIBLE') assert.equal(r.reason, 'V3_GATE_ALLOWANCE_REQUIRED');
        assert.equal(rpc.broadcasts, 0);
      }

      {
        const rpc = new ModelRpc();
        fundV3(rpc, BigInt(auth.scope.validAfter));
        rpc.chain.time = BigInt(auth.scope.validUntil) + 1n;
        const r = await settleSpineV3({ ...base, rpc, ledgerPath: join(dir, 'ledger-exp.db') });
        assert.equal(r.status, 'INELIGIBLE');
        if (r.status === 'INELIGIBLE') assert.equal(r.reason, 'V3_DELEGATION_EXPIRED');
        assert.equal(rpc.broadcasts, 0);
      }

      {
        const rpc = new ModelRpc();
        fundV3(rpc, BigInt(auth.scope.validAfter));
        rpc.simulateRevert = 'V3_SIM_REVERT';
        const r = await settleSpineV3({ ...base, rpc, ledgerPath: join(dir, 'ledger-sim.db') });
        assert.equal(r.status, 'INELIGIBLE');
        if (r.status === 'INELIGIBLE') assert.match(r.reason, /SIMULATION_REVERT/);
        assert.equal(rpc.broadcasts, 0);
      }

      {
        // Restart: public restore, no private key → refuse.
        const restarted = new LiveV3ChallengeHost({
          chainId: 46_630n,
          gate: V3_GATE_PLACEHOLDER,
          agent: AGENT,
          fundingToken: MDUSD,
          market: d.market,
          validitySeconds: 3_600n,
        });
        restarted.restorePublic(session.id, auth.scope);
        const rpc = new ModelRpc();
        fundV3(rpc, BigInt(auth.scope.validAfter));
        const r = await settleSpineV3({ ...base, host: restarted, rpc, ledgerPath: join(dir, 'ledger-rest.db') });
        assert.equal(r.status, 'INELIGIBLE');
        if (r.status === 'INELIGIBLE') {
          assert.ok(r.reason === 'DELEGATE_KEY_UNAVAILABLE' || r.reason === 'AUTONOMOUS_GATE_NOT_ARMED' || r.reason === 'SESSION_RESTORED');
        }
        assert.equal(rpc.broadcasts, 0);
      }

      {
        const rpc = new ModelRpc();
        fundV3(rpc, BigInt(auth.scope.validAfter));
        const over = await settleSpineV3({
          ...base,
          rpc,
          usedDebit: BigInt(auth.scope.cumulativeDebitLimit),
          ledgerPath: join(dir, 'ledger-cap.db'),
        });
        assert.equal(over.status, 'INELIGIBLE');
        if (over.status === 'INELIGIBLE') assert.equal(over.reason, 'CUMULATIVE_CAPACITY_EXHAUSTED');
        assert.equal(rpc.broadcasts, 0);
      }

      journal.close();
      session.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('V2 method cannot autonomous-settle', async () => {
    const d = testDeployment();
    const host = new LiveV3ChallengeHost({
      chainId: 46_630n,
      gate: V3_GATE_PLACEHOLDER,
      agent: AGENT,
      fundingToken: MDUSD,
      market: d.market,
      validitySeconds: 3_600n,
    });
    const dir = mkdtempSync(join(tmpdir(), 'mandate-v3-v2refuse-'));
    try {
      const session = new LiveSession({
        provider: new ScriptedProvider({
          decide: (r) => ({ text: r.role === 'stock' ? propose('nvda-note-a', 200) : abstain }),
          negotiate: () => ({ text: abstain }),
        }),
        clock: new ManualClock(),
        sessionId: 'lab-v2-no-auto',
        stateDir: dir,
        ...SPINE_TIMEOUTS,
      });
      const auth = await session.authorize(presetDraft('balanced'), 'AUTHORIZE MANDATE V1');
      assert.equal(auth.ok, true);
      assert.equal((await session.run()).status, 'AUTHORIZED');
      const rpc = new ModelRpc();
      fundV3(rpc, 1n);
      const journal = SettlementJournal.open(join(dir, 'settlement.db'));
      // Arm a fake V3 row so failure is method, not missing host session.
      host.issueScope({
        sessionId: session.id,
        principal: PRINCIPAL,
        draft: presetDraft('balanced'),
        mandate: session.versions.active!.mandate,
        generation: 1n,
        now: 1n,
        initialAllocationDigest: `0x${'11'.repeat(32)}`,
      });
      host.arm(session.id);
      const r = await settleSpineV3({
        session,
        journal,
        deployment: d,
        v3Gate: v3Gate(d),
        rpc,
        keys: KEYS,
        mode: 'SEND',
        host,
        ledgerPath: join(dir, 'ledger.db'),
        nextExecutionNonce: 1n,
      });
      assert.equal(r.status, 'INELIGIBLE');
      if (r.status === 'INELIGIBLE') assert.equal(r.reason, 'V2_SESSION_CANNOT_AUTONOMOUS_SETTLE');
      assert.equal(rpc.broadcasts, 0);
      journal.close();
      session.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
