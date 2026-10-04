/**
 * C2.3 Live Lab V3: one DelegatedPortfolioAuthorizationV3 wallet signature.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mandateSignedByPrincipalV3, portfolioMandateAuthorizationV3Hash, portfolioMandateDigest } from '@mandate/portfolio';
import { addressOfKey, signPrehash } from '@mandate/portfolio/demo';
import { presetDraft } from '../src/authoring/draft-types.ts';
import { LiveSession } from '../src/session.ts';
import { APPROVAL_CHAIN_ID, sessionDigest } from '../src/wallet/approval.ts';
import type { V3ChallengeHost, V3PublicScope } from '../src/wallet/v3-host.ts';
import { ManualClock } from '../src/runtime/clock.ts';
import { CountingEntropy } from '../src/runtime/entropy.ts';
import { StubProvider } from '../src/runtime/stub-provider.ts';
import { TestTime } from './support/world.ts';

const WALLET_KEY = `0x${'11'.repeat(32)}`;
const OTHER_KEY = `0x${'22'.repeat(32)}`;
const WALLET = addressOfKey(WALLET_KEY);
const DELEGATE = '0x88f9b82462f6c4bf4a0fb15e5c3971559a316e7f';
const AGENT = '0x63fac9201494f0bd17b9892b9fae4d52fe3bd377';
const GATE = '0xa0cb889707d426a7a386870a03bc70d1b0697598';
const FUNDING = '0x53b640b9a573e33c541de5a4917bc4d28d956abf';
const REP_HASH = '0xce0c192a14407b7fe100bc6b7d17452737f621c5113ff0d6ee9c57350d908623';

function host(scope?: Partial<V3PublicScope>): V3ChallengeHost {
  return {
    issueScope(input) {
      const now = input.now;
      return {
        ok: true,
        scope: {
          verifyingContract: GATE,
          delegate: DELEGATE,
          agent: AGENT,
          representationIdHash: REP_HASH,
          fundingToken: FUNDING,
          cumulativeDebitLimit: '64000000',
          validAfter: now.toString(),
          validUntil: (now + 3_600n).toString(),
          generation: input.generation.toString(),
          ...scope,
        },
      };
    },
    previewSettlementSetup() {
      return {
        ok: true,
        plan: {
          chainId: 46_630,
          gate: (scope?.verifyingContract ?? GATE).toLowerCase(),
          fundingToken: (scope?.fundingToken ?? FUNDING).toLowerCase(),
          requiredAllowanceAtoms: scope?.cumulativeDebitLimit ?? '64000000',
          basis: 'MAXIMUM',
        },
      };
    },
  };
}

function session(o: { id?: string; stateDir?: string; v3Host?: V3ChallengeHost } = {}): LiveSession {
  return new LiveSession({
    provider: new StubProvider(0),
    clock: new ManualClock(),
    sessionId: o.id ?? 'lab-spine-v3',
    agentTimeoutMs: 1_000,
    roomRoundTimeoutMs: 1_000,
    protocolNow: new TestTime().read,
    entropy: new CountingEntropy(7n),
    v3Host: o.v3Host ?? host(),
    ...(o.stateDir === undefined ? {} : { stateDir: o.stateDir }),
  });
}

describe('wallet principal V3 delegated', () => {
  it('previews bounded settlement setup from the connected wallet without a challenge', () => {
    const s = session();
    const draft = presetDraft('balanced');
    const preview = s.previewV3SettlementSetup(draft, WALLET);
    assert.equal(preview.ok, true);
    if (!preview.ok) return;
    assert.equal(preview.principal, WALLET);
    assert.equal(preview.plan.chainId, 46_630);
    assert.equal(preview.plan.gate, GATE);
    assert.equal(preview.plan.fundingToken, FUNDING);
    assert.equal(preview.plan.requiredAllowanceAtoms, '64000000');
    assert.notEqual(preview.plan.requiredAllowanceAtoms, ((1n << 256n) - 1n).toString());
  });

  it('issues typed data for DelegatedPortfolioAuthorizationV3 and activates with one signature', async () => {
    const s = session();
    const draft = presetDraft('balanced');
    const c = s.spineChallengeV3(draft, WALLET);
    assert.equal(c.ok, true);
    if (!c.ok) return;
    assert.equal(c.principal, WALLET);
    const typed = c.typedData as { primaryType: string; domain: { version: string; verifyingContract: string }; message: { [k: string]: string } };
    assert.equal(typed.primaryType, 'DelegatedPortfolioAuthorizationV3');
    assert.equal(typed.domain.version, '3');
    assert.equal(typed.domain.verifyingContract, GATE);
    assert.equal(typed.message['delegate'], DELEGATE);
    assert.equal(typed.message['cumulativeDebitLimit'], '64000000');

    const prepared = s.challenges.get(c.challenge)?.prepared.mandate;
    assert.ok(prepared);
    assert.equal(c.digest, portfolioMandateDigest(prepared));
    const challenge = s.challenges.get(c.challenge);
    assert.ok(challenge?.v3Scope);
    const hash = portfolioMandateAuthorizationV3Hash(prepared, {
      scheme: 'V3_DELEGATED_EIP712',
      chainId: APPROVAL_CHAIN_ID,
      verifyingContract: GATE,
      sessionDigest: sessionDigest(s.id),
      initialAllocationDigest: c.initialAllocationDigest as string,
      delegate: DELEGATE,
      agent: AGENT,
      representationIdHash: REP_HASH,
      fundingToken: FUNDING,
      cumulativeDebitLimit: 64_000_000n,
      validAfter: BigInt(challenge.v3Scope.validAfter),
      validUntil: BigInt(challenge.v3Scope.validUntil),
      generation: BigInt(challenge.v3Scope.generation),
    });
    const wrong = await s.authorizeWithWallet(draft, c.challenge, signPrehash(hash, OTHER_KEY));
    assert.equal(wrong.ok, false);

    const ok = await s.authorizeWithWallet(draft, c.challenge, signPrehash(hash, WALLET_KEY));
    assert.equal(ok.ok, true);
    if (!ok.ok) return;
    assert.equal(ok.record.authorization.method, 'WALLET_PRINCIPAL_V3_DELEGATED');
    assert.equal(ok.record.authorization.domainDelegation, 'BOUNDED_DELEGATE');
    assert.equal(ok.record.authorization.wallet?.delegate, DELEGATE);
    const active = s.versions.active;
    assert.ok(active);
    assert.equal(
      mandateSignedByPrincipalV3(active.mandate, active.signature, {
        scheme: 'V3_DELEGATED_EIP712',
        chainId: APPROVAL_CHAIN_ID,
        verifyingContract: GATE,
        sessionDigest: sessionDigest(s.id),
        initialAllocationDigest: c.initialAllocationDigest as string,
        delegate: DELEGATE,
        agent: AGENT,
        representationIdHash: REP_HASH,
        fundingToken: FUNDING,
        cumulativeDebitLimit: 64_000_000n,
        validAfter: BigInt(challenge.v3Scope.validAfter),
        validUntil: BigInt(challenge.v3Scope.validUntil),
        generation: BigInt(challenge.v3Scope.generation),
      }),
      true,
    );
  });

  it('refuses V3 without a host; restored session cannot authorize', async () => {
    const noHost = new LiveSession({
      provider: new StubProvider(0),
      clock: new ManualClock(),
      sessionId: 'lab-no-v3',
      agentTimeoutMs: 1_000,
      roomRoundTimeoutMs: 1_000,
      protocolNow: new TestTime().read,
      entropy: new CountingEntropy(1n),
    });
    const refused = noHost.spineChallengeV3(presetDraft('balanced'), WALLET);
    assert.equal(refused.ok, false);

    const dir = mkdtempSync(join(tmpdir(), 'mandate-v3-'));
    try {
      const s = session({ id: 'lab-v3-durable', stateDir: dir });
      const draft = presetDraft('balanced');
      const c = s.spineChallengeV3(draft, WALLET);
      assert.equal(c.ok, true);
      if (!c.ok) return;
      const prepared = s.challenges.get(c.challenge)?.prepared.mandate;
      const scope = s.challenges.get(c.challenge)?.v3Scope;
      assert.ok(prepared && scope);
      const hash = portfolioMandateAuthorizationV3Hash(prepared, {
        scheme: 'V3_DELEGATED_EIP712',
        chainId: APPROVAL_CHAIN_ID,
        verifyingContract: GATE,
        sessionDigest: sessionDigest(s.id),
        initialAllocationDigest: c.initialAllocationDigest as string,
        delegate: DELEGATE,
        agent: AGENT,
        representationIdHash: REP_HASH,
        fundingToken: FUNDING,
        cumulativeDebitLimit: 64_000_000n,
        validAfter: BigInt(scope.validAfter),
        validUntil: BigInt(scope.validUntil),
        generation: BigInt(scope.generation),
      });
      assert.equal((await s.authorizeWithWallet(draft, c.challenge, signPrehash(hash, WALLET_KEY))).ok, true);
      s.close();
      const restored = await LiveSession.restore(dir, 'lab-v3-durable', {
        agentTimeoutMs: 1_000,
        roomRoundTimeoutMs: 1_000,
        by: 'test',
        v3Host: host(),
      });
      assert.equal(restored.restored, true);
      assert.equal(restored.versions.records[0]?.authorization.method, 'WALLET_PRINCIPAL_V3_DELEGATED');
      assert.equal(restored.versions.records[0]?.authorization.wallet?.delegate, DELEGATE);
      const again = restored.spineChallengeV3(presetDraft('balanced'), WALLET);
      assert.equal(again.ok, false);
      if (!again.ok) assert.equal(again.code, 'SESSION_RESTORED');
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
