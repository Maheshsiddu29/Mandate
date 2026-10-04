/**
 * C3.5 — V3 delegated authorization preparation parity.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LiveSession,
  presetDraft,
  spineAuthorityV3,
  spineTypedDataV3,
  StubProvider,
  type V3ChallengeHost,
  type V3PublicScope,
} from '@mandate/live-agents';
import { PORTFOLIO_AUTHORITY_V3, portfolioMandateAuthorizationV3Hash } from '@mandate/portfolio';
import { ManualClock } from '../../live-agents/src/runtime/clock.ts';
import { CountingEntropy } from '../../live-agents/src/runtime/entropy.ts';
import { TestTime } from '../../live-agents/test/support/world.ts';
import { addressOfKey, signPrehash } from '@mandate/portfolio/demo';
import { createMandateClient, liveLabDomainBindings } from '../src/index.ts';

const WALLET_KEY = `0x${'11'.repeat(32)}`;
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
          gate: GATE,
          fundingToken: FUNDING,
          requiredAllowanceAtoms: '64000000',
          basis: 'MAXIMUM',
        },
      };
    },
  };
}

describe('sdk V3 authorization preparation', () => {
  it('prepared typed data matches direct spineChallengeV3 / spineTypedDataV3', async () => {
    const time = new TestTime();
    const session = new LiveSession({
      provider: new StubProvider(0),
      clock: new ManualClock(),
      sessionId: 'sdk-v3',
      agentTimeoutMs: 1_000,
      roomRoundTimeoutMs: 1_000,
      protocolNow: time.read,
      entropy: new CountingEntropy(9n),
      v3Host: host(),
    });
    const draft = presetDraft('balanced');
    const client = createMandateClient({
      principal: WALLET,
      chainId: 46_630,
      now: () => time.now,
      bindings: liveLabDomainBindings(),
      session,
    });
    const review = client.review(draft);
    assert.equal(review.signable, true, review.blockerSummary);

    const viaSdk = await client.prepareDelegatedAuthorization(review);
    assert.equal(viaSdk.ok, true);
    if (!viaSdk.ok) return;

    const challenge = session.challenges.get(viaSdk.prepared.challengeId);
    assert.ok(challenge?.v3Scope != null);
    assert.ok(challenge.initialAllocationDigest !== null);
    const expected = spineTypedDataV3(
      challenge.prepared.mandate,
      session.id,
      challenge.initialAllocationDigest,
      challenge.v3Scope,
    );
    assert.deepEqual(viaSdk.prepared.typedData, expected);
    assert.equal(viaSdk.prepared.verifyingContract, GATE);
    assert.equal(viaSdk.prepared.delegate, DELEGATE);
    assert.equal(viaSdk.prepared.cumulativeDebitLimit, '64000000');
  });

  it('acceptAuthorization verifies wallet signature without SDK holding the key', async () => {
    const time = new TestTime();
    const session = new LiveSession({
      provider: new StubProvider(0),
      clock: new ManualClock(),
      sessionId: 'sdk-v3-accept',
      agentTimeoutMs: 1_000,
      roomRoundTimeoutMs: 1_000,
      protocolNow: time.read,
      entropy: new CountingEntropy(11n),
      v3Host: host(),
    });
    const draft = presetDraft('balanced');
    const client = createMandateClient({
      principal: WALLET,
      chainId: 46_630,
      now: () => time.now,
      bindings: liveLabDomainBindings(),
      session,
    });
    const review = client.review(draft);
    const prepared = await client.prepareDelegatedAuthorization(review);
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;

    const challenge = session.challenges.get(prepared.prepared.challengeId);
    assert.ok(challenge?.v3Scope != null);
    assert.ok(challenge.initialAllocationDigest !== null);
    const bound = spineAuthorityV3(session.id, challenge.initialAllocationDigest, challenge.v3Scope);
    assert.equal(bound.scheme, PORTFOLIO_AUTHORITY_V3);
    const signature = signPrehash(portfolioMandateAuthorizationV3Hash(challenge.prepared.mandate, bound), WALLET_KEY);

    const accepted = await client.acceptAuthorization({
      prepared: prepared.prepared,
      signature,
      draft,
    });
    assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.message);
  });

  it('prepareDelegatedAuthorization refuses non-signable reviews', async () => {
    const time = new TestTime();
    const session = new LiveSession({
      provider: new StubProvider(0),
      clock: new ManualClock(),
      sessionId: 'sdk-v3-block',
      agentTimeoutMs: 1_000,
      roomRoundTimeoutMs: 1_000,
      protocolNow: time.read,
      entropy: new CountingEntropy(13n),
      v3Host: host(),
    });
    const client = createMandateClient({
      principal: WALLET,
      chainId: 46_630,
      now: () => time.now,
      bindings: liveLabDomainBindings(),
      session,
    });
    const { draft } = await client.compile({
      instruction: 'I have $5k. Stock $2k, Yield $1k, no perps, Swap remainder, no trade above $500, approved venues only',
    });
    const review = client.review(draft);
    assert.equal(review.signable, false);
    const prepared = await client.prepareDelegatedAuthorization(review);
    assert.equal(prepared.ok, false);
    if (!prepared.ok) assert.equal(prepared.code, 'NOT_SIGNABLE');
  });
});
