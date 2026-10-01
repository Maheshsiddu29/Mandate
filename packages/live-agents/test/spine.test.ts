/**
 * Mandate authority V2: the wallet is the protocol principal. The B.5.3
 * approval, which the demonstration key countersigns, is unchanged.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mandateSignedByPrincipal, mandateSignedByPrincipalV2, portfolioMandateDigest, portfolioMandateV2Hash } from '@mandate/portfolio';
import { addressOfKey, signPrehash } from '@mandate/portfolio/demo';
import { presetDraft } from '../src/authoring/draft-types.ts';
import { LiveSession } from '../src/session.ts';
import { APPROVAL_CHAIN_ID, sessionDigest } from '../src/wallet/approval.ts';
import { hex, typedDataHash, type TypedField } from '../src/wallet/eip712.ts';
import { spineTypedData } from '../src/wallet/spine.ts';
import { ManualClock } from '../src/runtime/clock.ts';
import { CountingEntropy } from '../src/runtime/entropy.ts';
import { StubProvider } from '../src/runtime/stub-provider.ts';
import { TestTime } from './support/world.ts';

const WALLET_KEY = `0x${'11'.repeat(32)}`;
const OTHER_KEY = `0x${'22'.repeat(32)}`;
const WALLET = addressOfKey(WALLET_KEY);
const FIELDS: readonly TypedField[] = [
  { name: 'statement', type: 'string' },
  { name: 'mandateDigest', type: 'bytes32' },
  { name: 'principal', type: 'address' },
  { name: 'sessionDigest', type: 'bytes32' },
];

function session(o: { id?: string; stateDir?: string } = {}): LiveSession {
  return new LiveSession({
    provider: new StubProvider(0),
    clock: new ManualClock(),
    sessionId: o.id ?? 'lab-spine',
    agentTimeoutMs: 1_000,
    roomRoundTimeoutMs: 1_000,
    protocolNow: new TestTime().read,
    entropy: new CountingEntropy(3n),
    ...(o.stateDir === undefined ? {} : { stateDir: o.stateDir }),
  });
}

describe('wallet principal V2', () => {
  it('the typed data is the portfolio V2 hash, and the wallet — not the demonstration key — is the protocol signer', async () => {
    const s = session();
    const draft = presetDraft('balanced');
    const c = s.spineChallenge(draft, WALLET);
    assert.equal(c.ok, true);
    if (!c.ok) return;
    assert.equal(c.principal, WALLET);
    const prepared = s.challenges.get(c.challenge)?.prepared.mandate;
    assert.ok(prepared);
    assert.equal(c.digest, portfolioMandateDigest(prepared));
    const typed = c.typedData as { primaryType: string; domain: { version: string; chainId: number }; message: { [k: string]: string } };
    assert.equal(typed.primaryType, 'PortfolioMandateV2');
    assert.equal(typed.domain.version, '2');
    assert.equal(typed.domain.chainId, Number(APPROVAL_CHAIN_ID));
    const message = typed.message;
    const fromWallet = typedDataHash({ name: 'Mandate', version: '2', chainId: APPROVAL_CHAIN_ID }, 'PortfolioMandateV2', FIELDS, message);
    const activeMandate = prepared;
    assert.equal(hex(fromWallet), hex(portfolioMandateV2Hash(activeMandate, { chainId: APPROVAL_CHAIN_ID, sessionDigest: sessionDigest(s.id) })));
    assert.equal(hex(fromWallet), hex(portfolioMandateV2Hash(activeMandate, { chainId: APPROVAL_CHAIN_ID, sessionDigest: message['sessionDigest'] as string })));

    const signature = signPrehash(fromWallet, WALLET_KEY);
    const wrong = await s.authorizeWithWallet(draft, c.challenge, signPrehash(fromWallet, OTHER_KEY));
    assert.equal(wrong.ok, false);
    if (wrong.ok) return;
    assert.equal(wrong.code, 'WALLET_SIGNER_MISMATCH');

    const ok = await s.authorizeWithWallet(draft, c.challenge, signature);
    assert.equal(ok.ok, true);
    if (!ok.ok) return;
    const active = s.versions.active;
    assert.ok(active);
    assert.equal(active.mandate.principal.value, WALLET);
    assert.equal(ok.record.authorization.method, 'WALLET_PRINCIPAL_V2');
    assert.equal(ok.record.authorization.principal, WALLET);
    assert.equal(ok.record.authorization.protocolSigner, WALLET);
    assert.equal(ok.record.authorization.domainDelegation, 'SAME_PRINCIPAL');
    assert.equal(mandateSignedByPrincipal(active.mandate, active.signature), false);
    assert.equal(mandateSignedByPrincipalV2(active.mandate, active.signature, { chainId: APPROVAL_CHAIN_ID, sessionDigest: sessionDigest(s.id) }), true);
    assert.equal(s.versions.protocolSigner === WALLET, false);
    const replay = await s.authorizeWithWallet(draft, c.challenge, signature);
    assert.equal(replay.ok, false);
    if (replay.ok) return;
    assert.equal(replay.code, 'WALLET_CHALLENGE_REUSED');
  });

  it('a V2 version runs through the real Mandate path, and a restored session still verifies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mandate-spine-'));
    try {
      const s = session({ id: 'lab-spine-durable', stateDir: dir });
      const draft = presetDraft('balanced');
      const c = s.spineChallenge(draft, WALLET);
      assert.equal(c.ok, true);
      if (!c.ok) return;
      const mandate = s.challenges.get(c.challenge)?.prepared.mandate;
      assert.ok(mandate);
      const signature = signPrehash(portfolioMandateV2Hash(mandate, { chainId: APPROVAL_CHAIN_ID, sessionDigest: sessionDigest(s.id) }), WALLET_KEY);
      assert.equal((await s.authorizeWithWallet(draft, c.challenge, signature)).ok, true);
      const run = await s.run();
      assert.equal(run.status, 'AUTHORIZED');
      assert.ok(run.transactions === 0);
      const id = s.id;
      s.close();

      const restored = await LiveSession.restore(dir, id, { agentTimeoutMs: 1_000, roomRoundTimeoutMs: 1_000, by: 'test', clock: new ManualClock() });
      const active = restored.versions.active;
      assert.ok(active);
      assert.equal(active.mandate.principal.value, WALLET);
      assert.equal(mandateSignedByPrincipalV2(active.mandate, active.signature, { chainId: APPROVAL_CHAIN_ID, sessionDigest: sessionDigest(id) }), true);
      assert.equal(restored.versions.records[0]?.authorization.method, 'WALLET_PRINCIPAL_V2');
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the typed-data builder matches what the challenge returns', () => {
    const s = session({ id: 'lab-spine-typed' });
    const c = s.spineChallenge(presetDraft('balanced'), WALLET);
    assert.equal(c.ok, true);
    if (!c.ok) return;
    const mandate = s.challenges.get(c.challenge)?.prepared.mandate;
    assert.ok(mandate);
    assert.deepEqual(c.typedData, spineTypedData(mandate, s.id));
  });
});
