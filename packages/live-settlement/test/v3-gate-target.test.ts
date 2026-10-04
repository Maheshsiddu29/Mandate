/**
 * V3 simulation / broadcast target must be the live MandateDelegatedExecutionGate.
 * Regression for SIMULATION_REVERT.TARGET_NOT_THE_GATE when the lab RPC was
 * still bound to the frozen V2 Gate.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { delegatedDomainSeparator } from '@mandate/execution-gate';
import { portfolioMandateAuthorizationV3Hash } from '@mandate/portfolio';
import { signPrehash } from '@mandate/portfolio/demo';
import { LiveSession, sessionDigest } from '@mandate/live-agents';
import type { Address } from '@mandate/evm-robinhood';
import { APPROVAL_CHAIN_ID } from '../../live-agents/src/wallet/approval.ts';
import { presetDraft } from '../../live-agents/src/authoring/draft-types.ts';
import { ManualClock } from '../../live-agents/src/runtime/clock.ts';
import { ScriptedProvider } from '../../live-agents/test/support/providers.ts';
import {
  LiveV3ChallengeHost,
  RobinhoodTestnetRpc,
  SettlementJournal,
  V3_GATE_PLACEHOLDER,
  settleSpineV3,
} from '../src/index.ts';
import { loadLiveV3Gate } from '../scripts/live-gate.ts';
import {
  AGENT,
  GATE,
  KEYS,
  MDUSD,
  ModelRpc,
  PRINCIPAL,
  PRINCIPAL_KEY,
  SUBMITTER_KEY,
  abstain,
  propose,
  testDeployment,
} from './support/world.ts';

const LIVE_V3 = '0x5cf0621ab974d100fd5df225dab046bf35fa7519';
const FROZEN_V2 = '0xb03c1e072192a82ba68604841a0e42f32609aa3e';
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const LIVE_MANIFEST = join(REPO, 'contracts/deploy/robinhood-testnet-delegated-live.json');
const LAB = readFileSync(join(REPO, 'packages/live-settlement/scripts/lab.ts'), 'utf8');
const UI = readFileSync(join(REPO, 'packages/live-settlement/src/ui-settle.ts'), 'utf8');
const SETTLE = readFileSync(join(REPO, 'packages/live-settlement/src/v3/settlement.ts'), 'utf8');
const SPINE_TIMEOUTS = { agentTimeoutMs: 1_000, roomRoundTimeoutMs: 1_000 } as const;

function v3Gate(d: ReturnType<typeof testDeployment>, address: string = V3_GATE_PLACEHOLDER) {
  return {
    address,
    domainSeparator: delegatedDomainSeparator(d.chainId, address as never),
    runtimeCodeHash: `0x${'cd'.repeat(32)}`,
  };
}

async function authorizeV3(session: LiveSession, host: LiveV3ChallengeHost) {
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
  return scope;
}

describe('V3 Gate target propagation', () => {
  it('live manifest Gate is the committed V3 Gate, distinct from frozen V2', () => {
    const live = loadLiveV3Gate(LIVE_MANIFEST);
    assert.equal(live.ok, true);
    if (!live.ok) return;
    assert.equal(live.gate, LIVE_V3);
    assert.equal(live.chainId, 46_630);
    assert.notEqual(live.gate, FROZEN_V2);
    assert.notEqual(live.gate, GATE.toLowerCase());
    const raw = JSON.parse(readFileSync(LIVE_MANIFEST, 'utf8')) as { gate: string; gateKind: string };
    assert.equal(raw.gateKind, 'MandateDelegatedExecutionGate');
    assert.equal(raw.gate.toLowerCase(), LIVE_V3);
  });

  it('lab binds a separate V3 RPC to the live Gate; settle uses v3.rpc not host V2 rpc', () => {
    assert.match(LAB, /new RobinhoodTestnetRpc\(keys\.deployer\.privateKey, d\.gate\.address/);
    assert.match(LAB, /new RobinhoodTestnetRpc\(submitterKey, gate as Address, endpoints\)/);
    assert.match(LAB, /must not share the frozen V2 Gate/);
    assert.match(UI, /rpc: v3\.rpc/);
    assert.match(UI, /V3_RPC_GATE_MISMATCH/);
    const settleV3 = UI.slice(UI.indexOf('async #settleV3'));
    assert.ok(settleV3.startsWith('async #settleV3'));
    assert.match(settleV3.slice(0, 3_500), /rpc: v3\.rpc/);
    assert.doesNotMatch(settleV3.slice(0, 3_500), /rpc: this\.#host\.rpc/);
    assert.match(SETTLE, /simulationExpectedGate !== planGate/);
    assert.match(SETTLE, /rpc\.allowance\(d\.mdusd\.address, check\.principal, i\.v3Gate\.address\)/);
    assert.match(SETTLE, /rpc\.simulateExecute\(i\.v3Gate\.address/);
    assert.match(SETTLE, /rpc\.prepareExecute\(i\.v3Gate\.address/);
    assert.match(SETTLE, /to: planGate/);
  });

  it('RobinhoodTestnetRpc: V2-bound client refuses V3 Gate; adapter/venue/V2 targets refused on V3-bound client', async () => {
    const v2 = new RobinhoodTestnetRpc(SUBMITTER_KEY, FROZEN_V2 as Address, { quicknode: null, publicFallback: false });
    assert.equal(v2.boundGate.toLowerCase(), FROZEN_V2);
    const leak = await v2.simulateExecute(LIVE_V3 as Address, { calldata: '0x', attempt: null as never });
    assert.equal(leak.ok, false);
    if (!leak.ok) assert.equal(leak.revert, 'TARGET_NOT_THE_GATE');

    const v3 = new RobinhoodTestnetRpc(SUBMITTER_KEY, LIVE_V3 as Address, { quicknode: null, publicFallback: false });
    assert.equal(v3.boundGate.toLowerCase(), LIVE_V3);
    for (const bad of [FROZEN_V2, '0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222']) {
      const r = await v3.simulateExecute(bad as Address, { calldata: '0x', attempt: null as never });
      assert.equal(r.ok, false, bad);
      if (!r.ok) assert.equal(r.revert, 'TARGET_NOT_THE_GATE');
    }
  });

  it('V2-bound ModelRpc makes settleSpineV3 fail TARGET_NOT_THE_GATE before broadcast', async () => {
    const d = testDeployment();
    const host = new LiveV3ChallengeHost({
      chainId: 46_630n,
      gate: V3_GATE_PLACEHOLDER,
      agent: AGENT,
      fundingToken: MDUSD,
      market: d.market,
      validitySeconds: 3_600n,
    });
    const dir = mkdtempSync(join(tmpdir(), 'mandate-v3-v2rpc-'));
    try {
      const session = new LiveSession({
        provider: new ScriptedProvider({
          decide: (r) => ({ text: r.role === 'stock' ? propose('nvda-note-a', 200) : abstain }),
          negotiate: () => ({ text: abstain }),
        }),
        clock: new ManualClock(),
        sessionId: 'lab-v3-v2rpc',
        stateDir: dir,
        v3Host: host,
        ...SPINE_TIMEOUTS,
      });
      const scope = await authorizeV3(session, host);
      assert.equal((await session.run()).status, 'AUTHORIZED');
      const rpc = new ModelRpc();
      // Bug reproduced: allowance spender is V3, but RPC expected Gate is V2.
      rpc.boundGate = FROZEN_V2 as Address;
      rpc.v3PassthroughGate = V3_GATE_PLACEHOLDER;
      rpc.chain.time = BigInt(scope.validAfter) + 1n;
      rpc.chain.fund(MDUSD, PRINCIPAL, 700_000_000n);
      rpc.chain.approve(MDUSD, PRINCIPAL, V3_GATE_PLACEHOLDER, 200_000_000n);
      const journal = SettlementJournal.open(join(dir, 'settlement.db'));
      const r = await settleSpineV3({
        session,
        journal,
        deployment: d,
        v3Gate: v3Gate(d),
        rpc,
        keys: KEYS,
        mode: 'DRY_RUN',
        host,
        ledgerPath: join(dir, 'ledger.db'),
        nextExecutionNonce: 1n,
      });
      assert.equal(r.status, 'INELIGIBLE');
      if (r.status === 'INELIGIBLE') {
        assert.equal(r.stage, 'SIMULATION');
        assert.equal(r.reason, 'SIMULATION_REVERT.TARGET_NOT_THE_GATE');
      }
      assert.equal(rpc.broadcasts, 0);
      journal.close();
      session.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('V3-bound ModelRpc: prepared.to == plan Gate == allowance spender; not V2/adapter/venue', async () => {
    const d = testDeployment();
    const host = new LiveV3ChallengeHost({
      chainId: 46_630n,
      gate: V3_GATE_PLACEHOLDER,
      agent: AGENT,
      fundingToken: MDUSD,
      market: d.market,
      validitySeconds: 3_600n,
    });
    const dir = mkdtempSync(join(tmpdir(), 'mandate-v3-okrpc-'));
    try {
      const session = new LiveSession({
        provider: new ScriptedProvider({
          decide: (r) => ({ text: r.role === 'stock' ? propose('nvda-note-a', 200) : abstain }),
          negotiate: () => ({ text: abstain }),
        }),
        clock: new ManualClock(),
        sessionId: 'lab-v3-okrpc',
        stateDir: dir,
        v3Host: host,
        ...SPINE_TIMEOUTS,
      });
      const scope = await authorizeV3(session, host);
      assert.equal(scope.verifyingContract.toLowerCase(), V3_GATE_PLACEHOLDER.toLowerCase());
      assert.equal((await session.run()).status, 'AUTHORIZED');
      const rpc = new ModelRpc();
      rpc.boundGate = V3_GATE_PLACEHOLDER as Address;
      rpc.v3PassthroughGate = V3_GATE_PLACEHOLDER;
      rpc.chain.time = BigInt(scope.validAfter) + 1n;
      rpc.chain.fund(MDUSD, PRINCIPAL, 700_000_000n);
      rpc.chain.approve(MDUSD, PRINCIPAL, V3_GATE_PLACEHOLDER, 200_000_000n);
      const journal = SettlementJournal.open(join(dir, 'settlement.db'));
      const gate = v3Gate(d);
      const r = await settleSpineV3({
        session,
        journal,
        deployment: d,
        v3Gate: gate,
        rpc,
        keys: KEYS,
        mode: 'DRY_RUN',
        host,
        ledgerPath: join(dir, 'ledger.db'),
        nextExecutionNonce: 1n,
      });
      assert.equal(r.status, 'READY', r.status === 'INELIGIBLE' ? `${r.stage}:${r.reason}` : r.status);
      if (r.status !== 'READY') return;
      assert.equal(r.prepared.to.toLowerCase(), gate.address.toLowerCase());
      assert.equal(r.wouldSend.gate.toLowerCase(), gate.address.toLowerCase());
      assert.equal(rpc.boundGate.toLowerCase(), gate.address.toLowerCase());
      assert.notEqual(r.prepared.to.toLowerCase(), FROZEN_V2);
      assert.notEqual(r.prepared.to.toLowerCase(), GATE.toLowerCase());
      assert.equal(rpc.executeTargets.every((t) => t.toLowerCase() === gate.address.toLowerCase()), true);
      assert.equal(rpc.broadcasts, 0);
      journal.close();
      session.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('live V3 Gate address is what settlement setup / plan paths document for lab', () => {
    assert.match(LAB, /loadLiveV3Gate/);
    assert.match(LAB, /V3 Gate \$\{v3\.ui\.gate\.address\}/);
    const live = JSON.parse(readFileSync(LIVE_MANIFEST, 'utf8')) as { gate: string };
    assert.equal(live.gate.toLowerCase(), LIVE_V3);
  });
});
