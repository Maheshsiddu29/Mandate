/**
 * Mandate authority V2 on the settlement path (docs/demo/authority-spine-v2.md).
 *
 * The wallet that signed the portfolio mandate is the protocol principal.
 * Settlement re-verifies that signature and signs the gate mandate only when
 * that address is the deployment principal. A different wallet, and the
 * demonstration-key path, are refused before any custody signature.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { portfolioMandateV2Hash, type PortfolioMandate } from '@mandate/portfolio';
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
import { reverifySpine, type SpineFacts } from '../src/spine.ts';
import { ALL_TEST_KEYS, KEYS, PRINCIPAL, PRINCIPAL_KEY, ModelRpc, settlementWorld, testDeployment } from './support/world.ts';

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
  const signature = signPrehash(portfolioMandateV2Hash(mandate, { chainId: APPROVAL_CHAIN_ID, sessionDigest: sessionDigest(s.id) }), key);
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

function factsOf(session: LiveSession, domainPrincipal: string): SpineFacts {
  const active = session.versions.active;
  const record = session.versions.records.find((r) => r.version === active?.version);
  if (active === null || record === undefined) throw new Error('no active version');
  return { mandate: active.mandate, signature: active.signature, authorization: record.authorization, sessionId: session.id, chainId: 46_630n, domainPrincipal, now: session.protocolNow() };
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

  it('refuses a wallet that is not the deployment principal before any custody signature or broadcast', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mandate-spine-mismatch-'));
    try {
      await v2Session(dir, OTHER_KEY, 'lab-spine-mismatch');
      const rpc = new ModelRpc();
      const world = await restored(dir, 'lab-spine-mismatch', rpc);
      try {
        const refused = await settleSpine({ session: world.session, journal: world.journal, deployment: world.deployment, rpc, keys: KEYS, mode: 'DRY_RUN', gate: new SendGate(), ledgerPath: world.ledger('dry.db') });
        assert.equal(refused.status, 'INELIGIBLE');
        if (refused.status !== 'INELIGIBLE') return;
        assert.equal(refused.reason, 'CUSTODY_PRINCIPAL_MISMATCH');
        assert.equal(rpc.broadcasts, 0);
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
        const base = factsOf(session, PRINCIPAL);
        assert.equal(reverifySpine(base).ok, true);
        assert.equal(reverifySpine({ ...base, authorization: { ...base.authorization, method: 'DEMO_PRINCIPAL_KEY' } }).ok, false);
        assert.equal((reverifySpine({ ...base, authorization: { ...base.authorization, method: 'DEMO_PRINCIPAL_KEY' } }) as { reason: string }).reason, 'SPINE_METHOD_REQUIRED');
        assert.equal((reverifySpine({ ...base, authorization: { ...base.authorization, protocolSigner: addressOfKey(OTHER_KEY) } }) as { reason: string }).reason, 'SPINE_SIGNER_SPLIT');
        assert.equal((reverifySpine({ ...base, authorization: { ...base.authorization, domainDelegation: 'NOT_DELEGATED' } }) as { reason: string }).reason, 'SPINE_DELEGATION_MISSTATED');
        assert.equal((reverifySpine({ ...base, signature: `0x${'ab'.repeat(65)}` }) as { reason: string }).reason, 'SPINE_SIGNATURE_INVALID');
        assert.equal((reverifySpine({ ...base, now: base.mandate.expiresAt }) as { reason: string }).reason, 'SPINE_EXPIRED');
        assert.equal((reverifySpine({ ...base, chainId: 1n }) as { reason: string }).reason, 'SPINE_CHAIN_MISMATCH');
        assert.equal((reverifySpine({ ...base, domainPrincipal: addressOfKey(OTHER_KEY) }) as { reason: string }).reason, 'CUSTODY_PRINCIPAL_MISMATCH');
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
