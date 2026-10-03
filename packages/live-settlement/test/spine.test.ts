/**
 * Mandate authority V2 on the settlement path (docs/demo/authority-spine-v2.md).
 *
 * The wallet that signed the portfolio mandate is the protocol principal.
 * Settlement re-verifies that signature. When the wallet is the deployment
 * principal, the manifest key signs the gate mandate. When it is not, the
 * wallet must present MandateAuthorization; a missing or wrong signature
 * is refused before any broadcast, and the manifest key is not used.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesToHex, eip712SigningHash, type Bytes32 } from '@mandate/kernel';
import { portfolioMandateAuthorizationV2Hash, type PortfolioMandate } from '@mandate/portfolio';
import { addressOfKey, signPrehash } from '@mandate/portfolio/demo';
import { LiveSession, sessionDigest, sessionDir } from '@mandate/live-agents';
import { APPROVAL_CHAIN_ID } from '../../live-agents/src/wallet/approval.ts';
import { presetDraft } from '../../live-agents/src/authoring/draft-types.ts';
import { ManualClock } from '../../live-agents/src/runtime/clock.ts';
import { ScriptedProvider, json } from '../../live-agents/test/support/providers.ts';
import { SettlementJournal } from '../src/journal.ts';
import { LiveSettlement } from '../src/settlement.ts';
import { SendGate } from '../src/send-gate.ts';
import { settleSpine } from '../src/spine-settlement.ts';
import { acceptGateExecution, type GateExecutionRequest } from '../src/gate-authority.ts';
import { reverifySpine, type SpineFacts } from '../src/spine.ts';
import { ALL_TEST_KEYS, GATE, KEYS, MDUSD, PRINCIPAL, PRINCIPAL_KEY, ModelRpc, settlementWorld, testDeployment } from './support/world.ts';

const TIMEOUTS = { agentTimeoutMs: 1_000, roomRoundTimeoutMs: 1_000 } as const;
const OTHER_KEY = `0x${'44'.repeat(32)}`;
const propose = (candidateId: string, whole: number) => json({ action: 'PROPOSE', candidateId, requestedAtoms: (BigInt(whole) * 1_000_000n).toString(), rationale: `pick ${candidateId}` });
const abstain = json({ action: 'ABSTAIN', candidateId: null, requestedAtoms: null, rationale: 'none' });
const provider = () => new ScriptedProvider({ decide: (r) => ({ text: r.role === 'stock' ? propose('nvda-note-a', 400) : abstain }), negotiate: () => ({ text: abstain }) });

async function v2Session(dir: string, key: string, id: string): Promise<void> {
  const s = new LiveSession({ provider: provider(), clock: new ManualClock(), sessionId: id, stateDir: dir, ...TIMEOUTS });
  const draft = presetDraft('balanced');
  const wallet = addressOfKey(key);
  const c = s.spineChallenge(draft, wallet);
  assert.equal(c.ok, true);
  if (!c.ok) return;
  const mandate = s.challenges.get(c.challenge)?.prepared.mandate;
  assert.ok(mandate);
  assert.ok(c.initialAllocationDigest);
  const signature = signPrehash(portfolioMandateAuthorizationV2Hash(mandate, { chainId: APPROVAL_CHAIN_ID, sessionDigest: sessionDigest(s.id), initialAllocationDigest: c.initialAllocationDigest }), key);
  assert.equal((await s.authorizeWithWallet(draft, c.challenge, signature)).ok, true);
  assert.equal((await s.run()).status, 'AUTHORIZED');
  s.close();
}

async function restored(dir: string, id: string, rpc: ModelRpc) {
  const session = await LiveSession.restore(dir, id, { ...TIMEOUTS, by: 'spine-test', clock: new ManualClock() });
  const journal = SettlementJournal.open(join(sessionDir(dir, id), 'settlement.db'));
  const scratch = mkdtempSync(join(tmpdir(), 'mandate-spine-scratch-'));
  return {
    session,
    journal,
    rpc,
    deployment: testDeployment(),
    ledger: (name: string) => join(scratch, name),
    close: () => {
      journal.close();
      session.close();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

function factsOf(session: LiveSession): SpineFacts {
  const active = session.versions.active;
  const record = session.versions.records.find((r) => r.version === active?.version);
  if (active === null || record === undefined) throw new Error('no active version');
  return { mandate: active.mandate, signature: active.signature, authorization: record.authorization, sessionId: session.id, chainId: 46_630n, now: session.protocolNow() };
}

function signGate(req: GateExecutionRequest, key: string): string {
  const hash = eip712SigningHash({ name: 'Mandate', version: '1', chainId: BigInt(req.chainId), verifyingContract: req.gate }, req.mandateDigest as Bytes32);
  if (bytesToHex(hash) !== req.signingHash) throw new Error('signing hash is not the gate EIP-712 hash');
  return signPrehash(hash, key);
}

describe('V2 authority spine settlement', () => {
  it('re-verifies, dry-runs, then sends once when the wallet is the deployment principal', async () => {
    assert.equal(addressOfKey(PRINCIPAL_KEY), PRINCIPAL);
    const dir = mkdtempSync(join(tmpdir(), 'mandate-spine-happy-'));
    try {
      await v2Session(dir, PRINCIPAL_KEY, 'lab-spine-happy');
      const rpc = new ModelRpc();
      const world = await restored(dir, 'lab-spine-happy', rpc);
      try {
        const dry = await settleSpine({ session: world.session, journal: world.journal, deployment: world.deployment, rpc, keys: KEYS, mode: 'DRY_RUN', gate: new SendGate(), ledgerPath: world.ledger('dry.db') });
        assert.equal(dry.status, 'READY');
        if (dry.status !== 'READY') return;
        assert.equal(dry.principals.delegation, 'SAME_PRINCIPAL');
        assert.equal(dry.principals.domainSettlement.kind, 'SAME_PRINCIPAL');
        assert.equal(dry.principals.portfolio.address, PRINCIPAL);
        assert.equal(dry.principals.protocolSigner, PRINCIPAL);
        assert.equal(rpc.broadcasts, 0);
        assert.equal(world.session.events.events.some((e) => e.kind === 'TESTNET_READY_FOR_SEND'), false);
        assert.equal(world.session.events.events.some((e) => e.kind === 'MANDATE_REVERIFY_STARTED' && e.data['phase'] === 'SETTLEMENT' && e.data['ok'] === true), true);
        const text = JSON.stringify(world.session.events.events).toLowerCase();
        for (const k of ALL_TEST_KEYS) assert.equal(text.includes(k), false);

        const gate = new SendGate();
        assert.equal(gate.authorize('AUTHORIZE ROBINHOOD TESTNET SEND'), true);
        const sent = await settleSpine({ session: world.session, journal: world.journal, deployment: world.deployment, rpc, keys: KEYS, mode: 'SEND', gate, ledgerPath: world.ledger('send.db') });
        assert.equal(sent.status, 'SENT');
        if (sent.status !== 'SENT') return;
        assert.equal(sent.outcome.status, 'CONFIRMED');
        if (sent.outcome.status !== 'CONFIRMED') return;
        assert.equal(sent.outcome.evidence, 'REFERENCE_MODEL');
        assert.equal(rpc.broadcasts, 1);
        assert.equal(rpc.chain.txs.length, 1);
      } finally {
        world.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a wallet that is not the deployment principal on the V1 settlement command, before any signature or broadcast', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mandate-spine-mismatch-'));
    try {
      await v2Session(dir, OTHER_KEY, 'lab-spine-mismatch');
      const rpc = new ModelRpc();
      const world = await restored(dir, 'lab-spine-mismatch', rpc);
      try {
        const settlement = new LiveSettlement({ session: world.session, deployment: world.deployment, rpc, keys: KEYS });
        const p = await settlement.prepare();
        assert.equal('ineligible' in p, false);
        if ('ineligible' in p) return;
        const direct = await settlement.run(p, { mode: 'DRY_RUN', gate: new SendGate(), ledgerPath: world.ledger('direct.db'), journal: world.journal });
        assert.equal(direct.status, 'INELIGIBLE');
        if (direct.status !== 'INELIGIBLE') return;
        assert.equal(direct.reason, 'CUSTODY_PRINCIPAL_MISMATCH');
        assert.equal(direct.signatures, 0);
        assert.equal(direct.broadcasts, 0);
        assert.equal(rpc.broadcasts, 0);
        assert.equal(world.journal.get(p.execution.reservation), null);
      } finally {
        world.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dry-runs and sends when the wallet signs the gate mandate, and refuses a missing or wrong signature', async () => {
    const wallet = addressOfKey(OTHER_KEY);
    const dir = mkdtempSync(join(tmpdir(), 'mandate-spine-gate-'));
    try {
      await v2Session(dir, OTHER_KEY, 'lab-spine-gate');
      const rpc = new ModelRpc();
      rpc.chain.fund(MDUSD, wallet, 700_000_000n);
      rpc.chain.approve(MDUSD, wallet, GATE, 200_000_000n);
      const world = await restored(dir, 'lab-spine-gate', rpc);
      try {
        const missing = await settleSpine({ session: world.session, journal: world.journal, deployment: world.deployment, rpc, keys: KEYS, mode: 'DRY_RUN', gate: new SendGate(), ledgerPath: world.ledger('missing.db') });
        assert.equal(missing.status, 'INELIGIBLE');
        if (missing.status !== 'INELIGIBLE') return;
        assert.equal(missing.reason, 'GATE_EXECUTION_AUTHORITY_REQUIRED');
        assert.equal(rpc.broadcasts, 0);
        const asked = world.session.events.events.find((e) => e.kind === 'DOMAIN_EXECUTION_INELIGIBLE' && e.data['reason'] === 'GATE_EXECUTION_AUTHORITY_REQUIRED');
        assert.ok(asked);
        const request = asked.data['gateExecution'] as unknown as GateExecutionRequest;
        assert.equal(request.principal, wallet);
        assert.equal(request.kind, 'MANDATE_AUTHORIZATION');
        const absent = acceptGateExecution(request, null, wallet);
        assert.equal(absent.ok, false);
        if (!absent.ok) assert.equal(absent.reason, 'GATE_EXECUTION_AUTHORITY_REQUIRED');
        const malformed = acceptGateExecution(request, `0x${'ab'.repeat(65)}`, wallet);
        assert.equal(malformed.ok, false);
        if (!malformed.ok) assert.equal(malformed.reason, 'GATE_EXECUTION_SIGNATURE_INVALID');
        const wrong = await settleSpine({
          session: world.session,
          journal: world.journal,
          deployment: world.deployment,
          rpc,
          keys: KEYS,
          mode: 'DRY_RUN',
          gate: new SendGate(),
          ledgerPath: world.ledger('wrong.db'),
          resolveGateExecution: (req) => signGate(req, PRINCIPAL_KEY),
        });
        assert.equal(wrong.status, 'INELIGIBLE');
        if (wrong.status !== 'INELIGIBLE') return;
        assert.equal(wrong.reason, 'GATE_EXECUTION_SIGNER_MISMATCH');
        assert.equal(rpc.broadcasts, 0);

        const captured: { request: GateExecutionRequest | null } = { request: null };
        const dry = await settleSpine({
          session: world.session,
          journal: world.journal,
          deployment: world.deployment,
          rpc,
          keys: KEYS,
          mode: 'DRY_RUN',
          gate: new SendGate(),
          ledgerPath: world.ledger('dry.db'),
          resolveGateExecution: (req) => {
            captured.request = req;
            return signGate(req, OTHER_KEY);
          },
        });
        assert.equal(dry.status, 'READY');
        if (dry.status !== 'READY') return;
        const signed = captured.request;
        assert.ok(signed);
        assert.equal(dry.principals.delegation, 'GATE_EIP712_PER_EXECUTION');
        assert.equal(dry.principals.domainSettlement.kind, 'WALLET_GATE_EIP712');
        assert.equal(dry.principals.domainSettlement.address, wallet);
        assert.equal(dry.outcome.wouldSend.principal, wallet);
        assert.equal(dry.outcome.wouldSend.recipient, wallet);
        assert.equal(dry.outcome.wouldSend.mandateDigest, signed.mandateDigest);
        assert.equal(dry.outcome.signatures, 1);
        assert.equal(rpc.broadcasts, 0);
        const text = JSON.stringify(world.session.events.events).toLowerCase();
        for (const k of [...ALL_TEST_KEYS, OTHER_KEY.replace(/^0x/, '').toLowerCase()]) assert.equal(text.includes(k), false);

        const gate = new SendGate();
        assert.equal(gate.authorize('AUTHORIZE ROBINHOOD TESTNET SEND'), true);
        const sent = await settleSpine({
          session: world.session,
          journal: world.journal,
          deployment: world.deployment,
          rpc,
          keys: KEYS,
          mode: 'SEND',
          gate,
          ledgerPath: world.ledger('send.db'),
          resolveGateExecution: (req) => signGate(req, OTHER_KEY),
        });
        assert.equal(sent.status, 'SENT');
        if (sent.status !== 'SENT') return;
        assert.equal(sent.outcome.status, 'CONFIRMED');
        if (sent.outcome.status !== 'CONFIRMED') return;
        assert.equal(sent.outcome.evidence, 'REFERENCE_MODEL');
        assert.equal(sent.outcome.wouldSend.principal, wallet);
        assert.equal(sent.principals.delegation, 'GATE_EIP712_PER_EXECUTION');
        assert.equal(rpc.broadcasts, 1);
      } finally {
        world.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C1.4: a gate-market read the RPC node cannot serve, after the wallet signed, is refused at DOMAIN — nothing sent, no hash, one signature — and held for reconciliation, never resent', async () => {
    const wallet = addressOfKey(OTHER_KEY);
    const dir = mkdtempSync(join(tmpdir(), 'mandate-spine-rpc-'));
    const LIVE_REASON = 'MARKET.BLOCK_AHEAD_OF_NODE.RPC_-32000:unsupported block number 128270281';
    try {
      await v2Session(dir, OTHER_KEY, 'lab-spine-rpc');
      const rpc = new ModelRpc();
      rpc.chain.fund(MDUSD, wallet, 700_000_000n);
      rpc.chain.approve(MDUSD, wallet, GATE, 200_000_000n);
      const world = await restored(dir, 'lab-spine-rpc', rpc);
      try {
        const original = rpc.gateMarkets.bind(rpc);
        let reads = 0;
        // The live failure's shape: the second, post-signature read meets a node behind the pinned block.
        rpc.gateMarkets = async (policy) => ((reads += 1) === 2 ? { status: 'UNKNOWN', reason: LIVE_REASON } : original(policy));
        let requested = 0;
        const gate = new SendGate();
        assert.equal(gate.authorizeBrowserIntent(), true);
        const refused = await settleSpine({ session: world.session, journal: world.journal, deployment: world.deployment, rpc, keys: KEYS, mode: 'SEND', gate, ledgerPath: world.ledger('send.db'), resolveGateExecution: (req) => ((requested += 1), signGate(req, OTHER_KEY)) });
        assert.deepEqual({ status: refused.status, stage: refused.status === 'INELIGIBLE' ? refused.stage : null, reason: refused.status === 'INELIGIBLE' ? refused.reason : null }, { status: 'INELIGIBLE', stage: 'DOMAIN', reason: `GATE_STATE_UNKNOWN.${LIVE_REASON}` });
        assert.equal(requested, 1);
        assert.equal(rpc.prepared, 0);
        assert.equal(rpc.broadcasts, 0);
        assert.equal(rpc.chain.txs.length, 0);
        assert.equal(gate.state, 'AUTHORIZED');
        const events = world.session.events.events;
        const refusal = events.filter((e) => e.kind === 'DOMAIN_EXECUTION_INELIGIBLE').at(-1);
        assert.equal(refusal?.data['stage'], 'DOMAIN');
        assert.equal(refusal?.data['transactions'], 0);
        assert.equal(events.some((e) => /^TESTNET_TX_(SUBMISSION_STARTED|SUBMITTED|CONFIRMED)$/.test(e.kind) || e.data['txHash'] !== undefined), false);
        // The wallet's MandateAuthorization exists, so the attempt is held — reconciled, never resent — until it is dead.
        const attempt = world.journal.all().at(-1);
        assert.ok(attempt);
        assert.equal(attempt.state, 'PREPARED');
        assert.notEqual(attempt.domainOpenedAt, null);
        assert.deepEqual(refused.status === 'INELIGIBLE' ? refused.held : null, { state: 'PREPARED', until: BigInt(attempt.artifactDeadAfter ?? '0') });

        // The node caught up; another execute still asks for no signature and sends nothing.
        rpc.gateMarkets = original;
        const execute = async () => {
          const g = new SendGate();
          assert.equal(g.authorizeBrowserIntent(), true);
          return settleSpine({ session: world.session, journal: world.journal, deployment: world.deployment, rpc, keys: KEYS, mode: 'SEND', gate: g, ledgerPath: world.ledger('send.db'), resolveGateExecution: (req) => ((requested += 1), signGate(req, OTHER_KEY)) });
        };
        const held = await execute();
        assert.equal(held.status, 'RECONCILED_ONLY');
        assert.equal(held.status === 'RECONCILED_ONLY' && held.attempt.quarantine, 'AWAITING_DEADLINE');
        assert.equal(requested, 1);
        assert.equal(rpc.broadcasts, 0);

        // Past the artifact's deadline: released with no execution, still never resent.
        rpc.chain.time += 2_000n;
        const released = await execute();
        assert.equal(released.status, 'RECONCILED_ONLY');
        assert.equal(released.status === 'RECONCILED_ONLY' && released.attempt.state, 'RELEASED');
        assert.equal(requested, 1);
        assert.equal(rpc.broadcasts, 0);
        assert.equal(rpc.chain.txs.length, 0);
      } finally {
        world.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C1.4: the same refusal before the domain is bound asks for no signature, holds nothing, and the next execute signs once and sends once', async () => {
    const wallet = addressOfKey(OTHER_KEY);
    const dir = mkdtempSync(join(tmpdir(), 'mandate-spine-rpc-first-'));
    try {
      await v2Session(dir, OTHER_KEY, 'lab-spine-rpc-first');
      const rpc = new ModelRpc();
      rpc.chain.fund(MDUSD, wallet, 700_000_000n);
      rpc.chain.approve(MDUSD, wallet, GATE, 200_000_000n);
      const world = await restored(dir, 'lab-spine-rpc-first', rpc);
      try {
        const original = rpc.gateMarkets.bind(rpc);
        rpc.gateMarkets = async () => ({ status: 'UNKNOWN', reason: 'MARKET.BLOCK_AHEAD_OF_NODE.RPC_-32000:unsupported block number 128270281' });
        let requested = 0;
        const execute = async () => {
          const g = new SendGate();
          assert.equal(g.authorizeBrowserIntent(), true);
          return settleSpine({ session: world.session, journal: world.journal, deployment: world.deployment, rpc, keys: KEYS, mode: 'SEND', gate: g, ledgerPath: world.ledger('send.db'), resolveGateExecution: (req) => ((requested += 1), signGate(req, OTHER_KEY)) });
        };
        const refused = await execute();
        assert.equal(refused.status, 'INELIGIBLE');
        assert.equal(refused.status === 'INELIGIBLE' && refused.stage, 'DOMAIN');
        assert.equal(refused.status === 'INELIGIBLE' ? refused.held : 'x', undefined);
        assert.equal(requested, 0);
        assert.equal(rpc.prepared + rpc.broadcasts, 0);

        rpc.gateMarkets = original;
        const sent = await execute();
        assert.equal(sent.status, 'SENT');
        assert.equal(sent.status === 'SENT' && sent.outcome.status, 'CONFIRMED');
        assert.equal(requested, 1);
        assert.equal(rpc.broadcasts, 1);

        // Consumed: another execute reconciles only — no signature request, no second broadcast.
        const replay = await execute();
        assert.equal(replay.status, 'RECONCILED_ONLY');
        assert.equal(replay.status === 'RECONCILED_ONLY' && replay.attempt.state, 'CONSUMED');
        assert.equal(requested, 1);
        assert.equal(rpc.broadcasts, 1);
      } finally {
        world.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a demonstration-key session instead of settling it through custody', async () => {
    const world = await settlementWorld();
    try {
      const rpc = world.rpc;
      const refused = await settleSpine({ session: world.session, journal: world.journal, deployment: world.deployment, rpc, keys: KEYS, mode: 'DRY_RUN', gate: new SendGate(), ledgerPath: world.ledgerPath() });
      assert.equal(refused.status, 'INELIGIBLE');
      if (refused.status !== 'INELIGIBLE') return;
      assert.equal(refused.reason, 'SPINE_METHOD_REQUIRED');
      assert.equal(rpc.broadcasts, 0);
      const prepared = await world.settlement.prepare();
      assert.equal('ineligible' in prepared, false);
      if ('ineligible' in prepared) return;
      const dry = await world.settlement.run(prepared, { mode: 'DRY_RUN', gate: new SendGate(), ledgerPath: world.ledgerPath() });
      assert.equal(dry.status, 'READY');
      assert.equal(rpc.broadcasts, 0);
    } finally {
      world.close();
    }
  });

  it('fails closed on a split signer, a misstated delegation, a bad signature, expiry, and the wrong chain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mandate-spine-reasons-'));
    try {
      await v2Session(dir, PRINCIPAL_KEY, 'lab-spine-reasons');
      const session = await LiveSession.restore(dir, 'lab-spine-reasons', { ...TIMEOUTS, by: 'spine-test', clock: new ManualClock() });
      try {
        const base = factsOf(session);
        assert.equal(reverifySpine(base).ok, true);
        assert.equal(reverifySpine({ ...base, authorization: { ...base.authorization, method: 'DEMO_PRINCIPAL_KEY' } }).ok, false);
        assert.equal((reverifySpine({ ...base, authorization: { ...base.authorization, method: 'DEMO_PRINCIPAL_KEY' } }) as { reason: string }).reason, 'SPINE_METHOD_REQUIRED');
        assert.equal((reverifySpine({ ...base, authorization: { ...base.authorization, protocolSigner: addressOfKey(OTHER_KEY) } }) as { reason: string }).reason, 'SPINE_SIGNER_SPLIT');
        assert.equal((reverifySpine({ ...base, authorization: { ...base.authorization, domainDelegation: 'NOT_DELEGATED' } }) as { reason: string }).reason, 'SPINE_DELEGATION_MISSTATED');
        assert.equal((reverifySpine({ ...base, signature: `0x${'ab'.repeat(65)}` }) as { reason: string }).reason, 'SPINE_SIGNATURE_INVALID');
        assert.equal((reverifySpine({ ...base, now: base.mandate.expiresAt }) as { reason: string }).reason, 'SPINE_EXPIRED');
        assert.equal((reverifySpine({ ...base, chainId: 1n }) as { reason: string }).reason, 'SPINE_CHAIN_MISMATCH');
        const active = session.versions.active;
        assert.ok(active);
        const mandate = { ...active.mandate, principal: { ...active.mandate.principal, value: addressOfKey(OTHER_KEY) } } as PortfolioMandate;
        assert.equal((reverifySpine({ ...base, mandate }) as { reason: string }).reason, 'SPINE_MANDATE_PRINCIPAL_MISMATCH');
      } finally {
        session.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
