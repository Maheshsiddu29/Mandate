/**
 * The principal's wallet approval (B.5.3, docs/demo/wallet-settlement-boundaries.md §3).
 *
 * A test wallet signs exactly what `eth_signTypedData_v4` signs — the
 * EIP-712 digest of the typed data the server returned — with a test key.
 * Every mutation of what was signed, and every replay of a challenge, must
 * fail closed; the demonstration key path stays available and labelled.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eip712SigningHash, type Bytes32 } from '@mandate/kernel';
import { portfolioMandateDigest } from '@mandate/portfolio';
import { addressOfKey, signPrehash } from '@mandate/portfolio/demo';
import { presetDraft, withField, type MandateDraft } from '../src/authoring/draft-types.ts';
import { ManualClock } from '../src/runtime/clock.ts';
import { CountingEntropy } from '../src/runtime/entropy.ts';
import { StubProvider } from '../src/runtime/stub-provider.ts';
import { LiveLab } from '../src/server/app.ts';
import { LiveSession } from '../src/session.ts';
import { APPROVAL_TYPE, approvalHash, approvalMessage, sessionDigest, type ApprovalMessage } from '../src/wallet/approval.ts';
import { hex, recoverAddress, typedDataHash } from '../src/wallet/eip712.ts';
import { TestTime } from './support/world.ts';

const WALLET_KEY = '0x' + '11'.repeat(32);
const OTHER_KEY = '0x' + '22'.repeat(32);
const WALLET = addressOfKey(WALLET_KEY);
const OTHER = addressOfKey(OTHER_KEY);

function session(o: { clock?: ManualClock; id?: string } = {}): { readonly s: LiveSession; readonly time: TestTime; readonly clock: ManualClock } {
  const time = new TestTime();
  const clock = o.clock ?? new ManualClock();
  const s = new LiveSession({ provider: new StubProvider(0), clock, sessionId: o.id ?? 'lab-wallet-test', agentTimeoutMs: 1_000, roomRoundTimeoutMs: 1_000, protocolNow: time.read, entropy: new CountingEntropy(o.id === undefined ? 0n : 7n) });
  return { s, time, clock };
}

/** What the server says to sign, as a message object (the typed data's message, read back). */
function issued(s: LiveSession, draft: MandateDraft, address = WALLET): { readonly challenge: string; readonly message: ApprovalMessage } {
  const r = s.walletChallenge(draft, address);
  if (!r.ok) throw new Error(`challenge refused: ${r.code}`);
  const m = (r.typedData as { message: { [k: string]: string } }).message;
  return {
    challenge: r.challenge,
    message: {
      statement: m['statement'] as string,
      environment: m['environment'] as string,
      mandateDigest: m['mandateDigest'] as string,
      mandateVersion: BigInt(m['mandateVersion'] as string),
      principal: m['principal'] as string,
      protocolSigner: m['protocolSigner'] as string,
      validAfter: BigInt(m['validAfter'] as string),
      validUntil: BigInt(m['validUntil'] as string),
      sessionDigest: m['sessionDigest'] as string,
      challenge: m['challenge'] as string,
    },
  };
}

const sign = (m: ApprovalMessage, key = WALLET_KEY): string => signPrehash(approvalHash(m), key);
const signOnChain = (m: ApprovalMessage, chainId: bigint, key = WALLET_KEY): string => signPrehash(typedDataHash({ name: 'Mandate', version: '1', chainId }, 'PortfolioMandateApproval', [
  { name: 'statement', type: 'string' },
  { name: 'environment', type: 'string' },
  { name: 'mandateDigest', type: 'bytes32' },
  { name: 'mandateVersion', type: 'uint64' },
  { name: 'principal', type: 'address' },
  { name: 'protocolSigner', type: 'address' },
  { name: 'validAfter', type: 'uint64' },
  { name: 'validUntil', type: 'uint64' },
  { name: 'sessionDigest', type: 'bytes32' },
  { name: 'challenge', type: 'bytes32' },
], { ...m }), key);

describe('EIP-712 encoding', () => {
  it('reproduces the kernel’s gate-verified EIP-712 digest for MandateAuthorization(bytes32)', () => {
    const digest = ('0x' + 'ab'.repeat(32)) as Bytes32;
    const domain = { name: 'Mandate', version: '1', chainId: 46_630n, verifyingContract: '0x' + '42'.repeat(20) };
    const ours = typedDataHash(domain, 'MandateAuthorization', [{ name: 'mandateDigest', type: 'bytes32' }], { mandateDigest: digest });
    assert.equal(hex(ours), hex(eip712SigningHash(domain, digest)));
  });

  it('names the approval type exactly', () => {
    assert.equal(APPROVAL_TYPE, 'PortfolioMandateApproval(string statement,string environment,bytes32 mandateDigest,uint64 mandateVersion,address principal,address protocolSigner,uint64 validAfter,uint64 validUntil,bytes32 sessionDigest,bytes32 challenge)');
  });

  it('recovers 27/28 and 0/1 forms to the same signer, refuses high-s and malformed signatures', () => {
    const h = new Uint8Array(32).fill(7);
    const sig = signPrehash(h, WALLET_KEY);
    assert.deepEqual(recoverAddress(h, sig), { ok: true, address: WALLET, normalized: sig });
    const v = Number.parseInt(sig.slice(-2), 16) - 27;
    const zeroOne = `${sig.slice(0, -2)}0${v}`;
    const r = recoverAddress(h, zeroOne);
    assert.ok(r.ok && r.address === WALLET && r.normalized === sig);
    const s = BigInt(`0x${sig.slice(66, 130)}`);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const high = `${sig.slice(0, 66)}${(n - s).toString(16).padStart(64, '0')}${(55 - Number.parseInt(sig.slice(-2), 16)).toString(16)}`;
    assert.deepEqual(recoverAddress(h, high), { ok: false, reason: 'SIGNATURE_HIGH_S' });
    for (const bad of ['', '0x', '0x1234', `${sig}00`, sig.replace(/^0x/, ''), `${sig.slice(0, -2)}1d`]) assert.equal(recoverAddress(h, bad).ok, false, bad);
  });
});

describe('wallet-signed mandate activation', () => {
  it('a valid signature activates exactly the mandate it signed, under the recovered wallet', async () => {
    const { s } = session();
    const draft = presetDraft('balanced');
    const { challenge, message } = issued(s, draft);
    assert.equal(message.principal, WALLET);
    assert.equal(message.environment, 'robinhood-chain-testnet');
    assert.equal(message.sessionDigest, sessionDigest('lab-wallet-test'));
    assert.match(message.statement, /not a blockchain transaction/);
    const r = await s.authorizeWithWallet(draft, challenge, sign(message));
    assert.ok(r.ok, r.ok ? '' : r.code);
    const active = s.versions.active;
    assert.ok(active !== null);
    assert.equal(portfolioMandateDigest(active.mandate), message.mandateDigest);
    assert.equal(r.record.digest, message.mandateDigest);
    assert.equal(r.record.authorization.method, 'WALLET_EIP712');
    assert.equal(r.record.authorization.principal, WALLET);
    assert.equal(r.record.authorization.domainDelegation, 'NOT_DELEGATED');
    assert.equal(r.record.authorization.protocolSigner, s.versions.protocolSigner);
    assert.notEqual(r.record.authorization.principal, r.record.authorization.protocolSigner);
    assert.equal(r.record.authorization.wallet?.chainId, '46630');
  });

  it('refuses a signature over an altered mandate digest, version, expiry, session, address or challenge', async () => {
    const { s } = session();
    const draft = presetDraft('balanced');
    const mutations: readonly ((m: ApprovalMessage) => Partial<ApprovalMessage>)[] = [
      () => ({ mandateDigest: '0x' + 'cd'.repeat(32) }),
      () => ({ mandateVersion: 2n }),
      (m) => ({ validUntil: m.validUntil + 3_600n }),
      (m) => ({ validAfter: m.validAfter - 1n }),
      () => ({ sessionDigest: sessionDigest('lab-another-session') }),
      () => ({ principal: OTHER }),
      () => ({ challenge: '0x' + 'ee'.repeat(32) }),
      (m) => ({ statement: `${m.statement} Unlimited.` }),
      () => ({ environment: 'robinhood-chain-mainnet' }),
    ];
    for (const m of mutations) {
      // A fresh challenge each time: five bad signatures lock one.
      const { challenge, message } = issued(s, draft);
      const r = await s.authorizeWithWallet(draft, challenge, sign({ ...message, ...m(message) }));
      assert.equal(r.ok, false, String(m));
      assert.equal(!r.ok && r.code, 'WALLET_SIGNER_MISMATCH');
    }
    assert.equal(s.versions.active, null);
  });

  it('refuses a signature for another mandate amount or another set of enabled agents', async () => {
    const { s } = session();
    const draft = presetDraft('balanced');
    const { challenge, message } = issued(s, draft);
    for (const other of [withField(draft, 'portfolio.maxDeployed', '1500', 'USER'), withField(draft, 'agents.perps.enabled', false, 'USER')]) {
      const p = s.versions.prepare(other, s.protocolNow());
      assert.ok(p.ok);
      const forged = approvalMessage({ mandate: p.prepared.mandate, version: 1, principal: WALLET, protocolSigner: message.protocolSigner, validAfter: message.validAfter, sessionId: s.id, challenge });
      assert.notEqual(forged.mandateDigest, message.mandateDigest);
      const r = await s.authorizeWithWallet(draft, challenge, sign(forged));
      assert.equal(!r.ok && r.code, 'WALLET_SIGNER_MISMATCH');
      // Changing the server-side draft after the challenge is refused before any signature is read.
      const changed = await s.authorizeWithWallet(other, challenge, sign(message));
      assert.equal(!changed.ok && changed.code, 'WALLET_DRAFT_CHANGED');
    }
    assert.equal(s.versions.active, null);
  });

  it('refuses a signature made on another chain, by another key, or for a claimed address it does not recover to', async () => {
    const { s } = session();
    const draft = presetDraft('balanced');
    const { challenge, message } = issued(s, draft);
    for (const sig of [signOnChain(message, 1n), signOnChain(message, 4_663n), signOnChain(message, 42_161n), sign(message, OTHER_KEY)]) {
      const r = await s.authorizeWithWallet(draft, challenge, sig);
      assert.equal(!r.ok && r.code, 'WALLET_SIGNER_MISMATCH');
    }
    // The claimed address is the challenge's; a signature by any other wallet never activates it.
    const claimed = issued(s, draft, OTHER);
    const r = await s.authorizeWithWallet(draft, claimed.challenge, sign(claimed.message, WALLET_KEY));
    assert.equal(!r.ok && r.code, 'WALLET_SIGNER_MISMATCH');
    assert.equal(s.walletChallenge(draft, 'not-an-address').ok, false);
    assert.equal(s.versions.active, null);
  });

  it('refuses a malformed signature, and locks a challenge after five bad ones', async () => {
    const { s } = session();
    const draft = presetDraft('balanced');
    const { challenge, message } = issued(s, draft);
    const malformed = await s.authorizeWithWallet(draft, challenge, '0xdeadbeef');
    assert.equal(!malformed.ok && malformed.code, 'WALLET_SIGNATURE_MALFORMED');
    for (let i = 0; i < 4; i += 1) await s.authorizeWithWallet(draft, challenge, sign(message, OTHER_KEY));
    const locked = await s.authorizeWithWallet(draft, challenge, sign(message));
    assert.equal(!locked.ok && locked.code, 'WALLET_CHALLENGE_LOCKED');
    assert.equal(s.versions.active, null);
  });

  it('refuses an expired challenge, a reused one, one from another session and an unknown one', async () => {
    const { s, clock } = session();
    const draft = presetDraft('balanced');
    const late = issued(s, draft);
    await clock.advance(300_000);
    const expired = await s.authorizeWithWallet(draft, late.challenge, sign(late.message));
    assert.equal(!expired.ok && expired.code, 'WALLET_CHALLENGE_EXPIRED');

    const fresh = issued(s, draft);
    assert.ok((await s.authorizeWithWallet(draft, fresh.challenge, sign(fresh.message))).ok);
    const reused = await s.authorizeWithWallet(draft, fresh.challenge, sign(fresh.message));
    assert.equal(!reused.ok && reused.code, 'WALLET_CHALLENGE_REUSED');

    const other = session({ id: 'lab-other-session' });
    const foreign = await other.s.authorizeWithWallet(draft, fresh.challenge, sign(fresh.message));
    assert.equal(!foreign.ok && foreign.code, 'WALLET_CHALLENGE_UNKNOWN');
    const unknown = await s.authorizeWithWallet(draft, '0x' + '00'.repeat(32), sign(fresh.message));
    assert.equal(!unknown.ok && unknown.code, 'WALLET_CHALLENGE_UNKNOWN');
  });

  it('a challenge for V1 cannot authorize V2; a wallet amendment supersedes V1 through the ledger', async () => {
    const { s, time } = session();
    const draft = presetDraft('balanced');
    const v1 = issued(s, draft);
    const stale = issued(s, draft);
    assert.ok((await s.authorizeWithWallet(draft, v1.challenge, sign(v1.message))).ok);
    const r = await s.authorizeWithWallet(draft, stale.challenge, sign(stale.message));
    assert.equal(!r.ok && r.code, 'WALLET_CHALLENGE_STALE');
    time.now += 1n;
    const amended = withField(draft, 'agents.nft.enabled', false, 'USER');
    const v2 = issued(s, amended);
    assert.equal(v2.message.mandateVersion, 2n);
    const a = await s.authorizeWithWallet(amended, v2.challenge, sign(v2.message));
    assert.ok(a.ok);
    assert.equal(a.superseded?.version, 1);
    assert.deepEqual(s.versions.records.map((x) => [x.version, x.status, x.authorization.method]), [[1, 'SUPERSEDED', 'WALLET_EIP712'], [2, 'ACTIVE', 'WALLET_EIP712']]);
  });

  it('keeps pause and the no-amendment-after-reservation rule exactly as before', async () => {
    const { s, time } = session();
    const draft = presetDraft('balanced');
    const v1 = issued(s, draft);
    assert.ok((await s.authorizeWithWallet(draft, v1.challenge, sign(v1.message))).ok);
    const pending = issued(s, withField(draft, 'agents.nft.enabled', false, 'USER'));
    s.versions.markReserved();
    const blocked = s.walletChallenge(withField(draft, 'agents.nft.enabled', false, 'USER'), WALLET);
    assert.equal(!blocked.ok && blocked.code, 'AMENDMENT_AFTER_RESERVATION');
    const late = await s.authorizeWithWallet(withField(draft, 'agents.nft.enabled', false, 'USER'), pending.challenge, sign(pending.message));
    assert.equal(!late.ok && late.code, 'AMENDMENT_AFTER_RESERVATION');
    time.now += 1n;
    assert.ok(await s.pause('PAUSE MANDATE'));
    const paused = s.walletChallenge(draft, WALLET);
    assert.equal(!paused.ok && paused.code, 'MANDATE_PAUSED');
    assert.equal(s.versions.active, null);
  });

  it('keeps the demonstration key fallback, labelled as such and never as a wallet', async () => {
    const { s } = session();
    const r = await s.authorize(presetDraft('balanced'), 'AUTHORIZE MANDATE V1');
    assert.ok(r.ok);
    assert.equal(r.record.authorization.method, 'DEMO_PRINCIPAL_KEY');
    assert.equal(r.record.authorization.wallet, null);
    assert.match(r.record.authorization.label, /Not a wallet signature/);
    assert.equal(r.record.authorization.principal, s.versions.protocolSigner);
    assert.equal(r.record.authorization.domainDelegation, 'NOT_DELEGATED');
  });

  it('never puts the signature in an event or in what the browser is sent', async () => {
    const lab = new LiveLab({ live: null, clock: new ManualClock(), agentTimeoutMs: 1_000, roomRoundTimeoutMs: 1_000, allowChaos: false });
    const created = await lab.handle({ method: 'POST', path: '/api/live/sessions', query: new URLSearchParams(), body: { provider: 'stub' } });
    const id = (created.body as { sessionId: string }).sessionId;
    assert.match(id, /^lab-[0-9a-f]{32}$/);
    await lab.handle({ method: 'POST', path: `/api/live/sessions/${id}/draft`, query: new URLSearchParams(), body: { preset: 'balanced' } });
    const c = await lab.handle({ method: 'POST', path: `/api/live/sessions/${id}/wallet/challenge`, query: new URLSearchParams(), body: { address: WALLET } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const typed = (c.body as { typedData: { message: { [k: string]: string } }; challenge: string });
    const m = typed.typedData.message;
    const message: ApprovalMessage = { statement: m['statement'] as string, environment: m['environment'] as string, mandateDigest: m['mandateDigest'] as string, mandateVersion: BigInt(m['mandateVersion'] as string), principal: m['principal'] as string, protocolSigner: m['protocolSigner'] as string, validAfter: BigInt(m['validAfter'] as string), validUntil: BigInt(m['validUntil'] as string), sessionDigest: m['sessionDigest'] as string, challenge: m['challenge'] as string };
    const signature = sign(message);
    const a = await lab.handle({ method: 'POST', path: `/api/live/sessions/${id}/wallet/authorize`, query: new URLSearchParams(), body: { challenge: typed.challenge, signature } });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const view = await lab.handle({ method: 'GET', path: `/api/live/sessions/${id}`, query: new URLSearchParams(), body: null });
    const events: unknown[] = [];
    lab.subscribe(id, -1, (e) => events.push(e))?.();
    const everything = JSON.stringify([a.body, view.body, events]).toLowerCase();
    assert.equal(everything.includes(signature.slice(2).toLowerCase()), false);
    assert.equal(everything.includes(signature.slice(2, 66).toLowerCase()), false);
    assert.match(everything, /wallet_eip712/);
  });
});
