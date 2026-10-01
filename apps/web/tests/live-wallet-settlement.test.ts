import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import type { JsonRecord, LiveEvent } from '../components/demo/live/live-client.ts';
import { deriveFlow, eventsAfter, type FlowInput } from '../components/demo/live/live-flow.ts';
import { derivePresentation } from '../components/demo/live/live-model.ts';
import { acceptsLiveDemoChallenge, APPROVAL_CHAIN, LIVE_DEMO_WALLET_PRIMARY_TYPE, LIVE_DEMO_WALLET_SPINE, WALLET_METHODS, injectedWallet, liveDemoWalletChallengeBody } from '../components/demo/live/wallet.ts';

/*
 * B.5.3: the browser's wallet path and the settlement evidence it receives
 * for its own durable session (docs/demo/wallet-settlement-boundaries.md).
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const LIVE = '../components/demo/live/';
const lab = read(`${LIVE}live-lab.tsx`);
const walletSource = read(`${LIVE}wallet.ts`);
const outcome = read(`${LIVE}stage-outcome.tsx`);
const liveDir = new URL(LIVE, import.meta.url);
const browserSources = readdirSync(liveDir).filter((file) => /\.(ts|tsx)$/.test(file)).map((file) => readFileSync(new URL(file, liveDir), 'utf8')).join('\n');
const run: LiveEvent[] = JSON.parse(read('./fixtures/live-stub-run.json'));

function event(sequence: number, kind: string, data: JsonRecord = {}): LiveEvent {
  return { schema: 'MANDATE_LIVE_AI.V1', sessionId: 'lab-1', sequence, kind, at: '2026-09-30T00:00:00.000Z', elapsedMs: sequence, protocolTime: '0', mandateVersion: 1, agent: 'stock', roomId: null, generation: null, data };
}
const idle: FlowInput = { drafting: false, draftPresent: false, reviewing: false, activeVersion: null, amending: false, runStarted: false, task: null, lastRunStatus: null, lastError: null, runEvents: [], paused: false };
const done = (runEvents: readonly LiveEvent[]): FlowInput => ({ ...idle, draftPresent: true, activeVersion: 1, runStarted: true, task: null, runEvents });
const authorized = eventsAfter(run, 4);
const after = (...events: readonly [string, JsonRecord?][]) => [...authorized, ...events.map(([kind, data], i) => event(1_000 + i, kind, data ?? {}))];
const principals = { portfolio: { method: 'WALLET_EIP712', address: '0x1234567890abcdef1234567890abcdef12345678' }, protocolSigner: '0xdemo', domainSettlement: { kind: 'TESTNET_FIXTURE_CUSTODY', address: '0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed' }, delegation: 'NOT_DELEGATED' };

function fakeProvider(answers: { readonly [method: string]: unknown } = {}) {
  const calls: { method: string; params: readonly unknown[] }[] = [];
  return {
    calls,
    request: async ({ method, params = [] }: { readonly method: string; readonly params?: readonly unknown[] }) => {
      calls.push({ method, params });
      const a = answers[method];
      if (a instanceof Error) throw a;
      return a;
    },
  };
}

test('the Live demo challenge requests spine V2 and refuses a V1 approval', () => {
  assert.equal(LIVE_DEMO_WALLET_SPINE, 'V2');
  assert.equal(LIVE_DEMO_WALLET_PRIMARY_TYPE, 'PortfolioMandateV2');
  assert.deepEqual(liveDemoWalletChallengeBody('0xabcdef0123456789abcdef0123456789abcdef01'), { address: '0xabcdef0123456789abcdef0123456789abcdef01', spine: 'V2' });
  const v2 = { spine: 'V2', typedData: { primaryType: 'PortfolioMandateV2', domain: { name: 'Mandate', version: '2', chainId: 46630 } } };
  assert.equal(acceptsLiveDemoChallenge(v2), true);
  assert.equal(acceptsLiveDemoChallenge({ spine: 'V1', typedData: { primaryType: 'PortfolioMandateApproval' } }), false);
  assert.equal(acceptsLiveDemoChallenge({ typedData: { primaryType: 'PortfolioMandateApproval' } }), false);
  assert.equal(acceptsLiveDemoChallenge({ spine: 'V2', typedData: { primaryType: 'PortfolioMandateApproval' } }), false);
  assert.equal(acceptsLiveDemoChallenge({ spine: 'V2' }), false);
  assert.equal(acceptsLiveDemoChallenge({ spine: 'V2', typedData: null }), false);
  assert.match(lab, /liveDemoWalletChallengeBody\(address\)/);
  assert.match(lab, /WALLET_PRINCIPAL_V2/);
  assert.match(read(`${LIVE}stage-configure.tsx`), /PortfolioMandateV2/);
  assert.match(read(`${LIVE}stage-configure.tsx`), /WALLET_PRINCIPAL_V2/);
});

test('the wallet adapter can connect, read, switch chain and sign typed data — and nothing that sends or signs a transaction', async () => {
  assert.deepEqual([...WALLET_METHODS], ['eth_requestAccounts', 'eth_accounts', 'eth_chainId', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'eth_signTypedData_v4']);
  assert.doesNotMatch(walletSource, /eth_sendTransaction|eth_sendRawTransaction|eth_signTransaction|personal_sign|eth_sign"|eth_sign'/);
  const sig = `0x${'ab'.repeat(65)}`;
  const p = fakeProvider({ eth_requestAccounts: ['0xABCDEF0123456789abcdef0123456789ABCDEF01'], eth_chainId: '0xb626', eth_signTypedData_v4: sig });
  const w = injectedWallet(p);
  assert.ok(w !== null);
  assert.deepEqual(await w.connect(), { ok: true, value: '0xabcdef0123456789abcdef0123456789abcdef01' });
  assert.deepEqual(await w.getChainId(), { ok: true, value: APPROVAL_CHAIN.chainId });
  const typed = { types: {}, primaryType: 'PortfolioMandateApproval', domain: { chainId: 46630 }, message: {} };
  assert.deepEqual(await w.signTypedData('0xabcdef0123456789abcdef0123456789abcdef01', typed), { ok: true, value: sig });
  const signCall = p.calls.find((c) => c.method === 'eth_signTypedData_v4');
  assert.deepEqual(signCall?.params, ['0xabcdef0123456789abcdef0123456789abcdef01', JSON.stringify(typed)]);
  for (const c of p.calls) assert.ok((WALLET_METHODS as readonly string[]).includes(c.method), c.method);
});

test('a rejected or unknown-chain request fails closed, and adding the chain offers only the public testnet RPC', async () => {
  const rejected = Object.assign(new Error('User rejected'), { code: 4001 });
  const p = fakeProvider({ eth_signTypedData_v4: rejected, wallet_switchEthereumChain: Object.assign(new Error('unknown chain'), { code: 4902 }), wallet_addEthereumChain: null });
  const w = injectedWallet(p);
  assert.ok(w !== null);
  const signed = await w.signTypedData('0xabcdef0123456789abcdef0123456789abcdef01', {});
  assert.equal(!signed.ok && signed.error.code, 'REJECTED');
  assert.deepEqual(await w.switchChain(), { ok: true, value: true });
  const add = p.calls.find((c) => c.method === 'wallet_addEthereumChain');
  assert.deepEqual((add?.params[0] as { rpcUrls: string[] }).rpcUrls, ['https://rpc.testnet.chain.robinhood.com']);
  assert.equal(injectedWallet(null), null);
  const bad = injectedWallet(fakeProvider({ eth_signTypedData_v4: '0x1234' }));
  assert.equal((await bad?.signTypedData('0xabcdef0123456789abcdef0123456789abcdef01', {}))?.ok, false);
});

test('a V2 principal is labelled as the wallet, and same-address settlement is not described as separate custody', () => {
  assert.match(lab, /WALLET_PRINCIPAL_V2/);
  assert.match(lab, /wallet principal/);
  assert.match(outcome, /WALLET_PRINCIPAL_V2/);
  assert.match(outcome, /Same address as the wallet/);
  assert.match(outcome, /Separate testnet custody/);
  assert.match(outcome, /Wallet gate signature, per execution/);
  assert.match(read(`${LIVE}sheets.tsx`), /Wallet gate signature, per execution/);
});

test('a session-bound dry run ends READY · NOT SENT: complete, never settled, both principals shown', () => {
  const events = after(['TESTNET_PREFLIGHT_STARTED', { network: 'Robinhood Chain Testnet' }], ['TESTNET_SIMULATION_PASSED', { gasEstimate: '321000', principals }], ['TESTNET_READY_FOR_SEND', { broadcast: 'DISABLED_IN_B.5.3', principals, rpcProvider: 'public' }]);
  const s = derivePresentation(events).settlement;
  assert.equal(s.stage, 'READY_FOR_SEND');
  assert.equal(s.settled, false);
  assert.equal(s.principals?.portfolioMethod, 'WALLET_EIP712');
  assert.equal(s.principals?.domainKind, 'TESTNET_FIXTURE_CUSTODY');
  assert.equal(deriveFlow(done(events)).phase, 'COMPLETE');
  assert.match(outcome, /READY · NOT SENT/);
  assert.match(outcome, /Broadcast is disabled in this milestone: nothing was sent\./);
  assert.match(outcome, /Portfolio authorization/);
  assert.match(outcome, /Domain settlement authority/);
  assert.match(outcome, /Separate testnet custody/);
});

test('an uncertain execution reads "Checking settlement status…", not Failed; quarantine reads "needs review"; released reads failed', () => {
  const checking = after(['TESTNET_TX_SUBMITTED', { txHash: '0xabc' }], ['SETTLEMENT_RECONCILED', { state: 'RECONCILIATION_REQUIRED', quarantine: 'AWAITING_DEADLINE', txHash: '0xabc' }]);
  assert.equal(derivePresentation(checking).settlement.stage, 'RECONCILING');
  assert.equal(deriveFlow(done(checking)).phase, 'SETTLING');
  assert.match(outcome, /Checking settlement status…/);
  const review = after(['TESTNET_TX_SUBMITTED', { txHash: '0xabc' }], ['SETTLEMENT_RECONCILED', { state: 'RECONCILIATION_REQUIRED', quarantine: 'POSTCONDITION_ANOMALY' }]);
  assert.equal(derivePresentation(review).settlement.stage, 'NEEDS_REVIEW');
  assert.equal(deriveFlow(done(review)).phase, 'COMPLETE');
  assert.match(outcome, /Settlement needs review\. No retry was sent\./);
  const released = after(['TESTNET_TX_FAILED', { txHash: '0xabc', status: 'REVERTED', evidence: 'FAILED' }], ['RESERVATION_RELEASED', { reservation: '0xr' }]);
  assert.equal(derivePresentation(released).settlement.stage, 'RELEASED');
  assert.equal(derivePresentation(released).settlement.settled, false);
});

test('a durable confirmed settlement after a reload: settled only with LIVE_TESTNET, consumed only from the ledger event', () => {
  const settled = after(['DOMAIN_EXECUTION_SETTLED', { evidence: 'LIVE_TESTNET', txHash: '0xabc', block: 9, status: 'SUCCESS', recoveredBy: 'reconciliation' }], ['RESERVATION_CONSUMED', { reservation: '0xr' }]);
  const s = derivePresentation(settled).settlement;
  assert.equal(s.settled, true);
  assert.equal(s.consumed, true);
  // The same events delivered twice (a reconnect) change nothing.
  assert.deepEqual(derivePresentation([...settled]).settlement, s);
  const hashOnly = after(['TESTNET_TX_SUBMITTED', { txHash: '0xabc' }]);
  assert.equal(derivePresentation(hashOnly).settlement.settled, false);
  const reference = after(['DOMAIN_EXECUTION_SETTLED', { evidence: 'REFERENCE_MODEL', txHash: '0xabc' }]);
  assert.equal(derivePresentation(reference).settlement.settled, false);
});

test('a reload returns to the same durable session and replays its events; duplicates never apply twice', () => {
  assert.match(lab, /new URLSearchParams\(window\.location\.search\)\.get\("session"\)/);
  assert.match(lab, /rememberSession\(id\);/);
  assert.match(lab, /previous\.some\(\(item\) => item\.sequence === event\.sequence\) \? previous/);
  assert.match(lab, /find\(\(event\) => event\.kind === "MANDATE_VERSION_AUTHORIZED"\)\?\.sequence/);
  assert.match(lab, /restored after a server restart\. It is evidence only/);
  // The browser never logs, stores or displays a signature.
  assert.doesNotMatch(browserSources, /console\.(log|info|debug)|setItem\([^)]*signed/);
});
