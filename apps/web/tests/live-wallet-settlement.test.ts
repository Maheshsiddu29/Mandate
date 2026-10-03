import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import type { JsonRecord, LiveEvent } from '../components/demo/live/live-client.ts';
import { deriveFlow, eventsAfter, type FlowInput } from '../components/demo/live/live-flow.ts';
import { derivePresentation } from '../components/demo/live/live-model.ts';
import { APPROVAL_CHAIN, WALLET_METHODS, injectedWallet } from '../components/demo/live/wallet.ts';

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

test('a V2 dry run ends READY · NOT SENT, and the gate signature is a step before simulation', () => {
  const typed = { primaryType: 'MandateAuthorization', domain: { chainId: 46630 }, message: {} };
  const waiting = after(['GATE_EXECUTION_SIGNATURE_REQUIRED', { mode: 'DRY_RUN', note: 'sign this execution', typedData: typed }]);
  const waitingView = derivePresentation(waiting).settlement;
  assert.equal(waitingView.stage, 'SIGN_GATE');
  assert.equal(waitingView.settled, false);
  assert.equal(waitingView.gateSign?.mode, 'DRY_RUN');
  assert.equal(deriveFlow(done(waiting)).phase, 'SETTLING');
  const simulating = after(['TESTNET_SIMULATION_PASSED', { gasEstimate: '1' }]);
  assert.equal(derivePresentation(simulating).settlement.stage, 'SIMULATION');
  assert.equal(deriveFlow(done(simulating)).phase, 'SETTLING');
  const ready = after(['SPINE_DRY_RUN_READY', { broadcast: 'NOT_SENT', network: 'Robinhood Chain Testnet', chainId: '46630', note: 'Re-verified. Dry run READY. Nothing was broadcast. The deployer pays gas.', tokenIn: { symbol: 'MDUSD', amount: '32' }, tokenOut: { symbol: 'MDEMO', amount: '3.2' }, principals }]);
  const readyView = derivePresentation(ready).settlement;
  assert.equal(readyView.stage, 'SPINE_READY');
  assert.equal(readyView.settled, false);
  assert.equal(readyView.evidence, 'DRY_RUN');
  assert.equal(readyView.fixtureIn, '32 MDUSD');
  assert.equal(readyView.gateSign, null);
  assert.equal(deriveFlow(done(ready)).phase, 'COMPLETE');
  const refused = after(['DOMAIN_EXECUTION_INELIGIBLE', { reason: 'GATE_EXECUTION_AUTHORITY_REQUIRED' }]);
  assert.equal(derivePresentation(refused).settlement.stage, 'FAILED');
  assert.equal(derivePresentation(refused).settlement.detail, 'GATE_EXECUTION_AUTHORITY_REQUIRED');
  assert.match(outcome, /Sign stock authorization/);
  assert.match(outcome, /Sign execution authorization/);
  assert.match(outcome, /This signs execution authority\. It is not a transaction\./);
  assert.match(outcome, /Broadcast is unavailable in this milestone\. Nothing was broadcast\./);
  assert.match(outcome, /This simulation has expired/);
  assert.match(outcome, /Technical details/);
  assert.doesNotMatch(outcome, /Send testnet transaction/);
  const proved = after(['SPINE_DRY_RUN_READY', { broadcast: false, evidenceClass: 'DRY_RUN', candidateId: 'nvda-note-a', mandateDigest: '0xabc', gasEstimate: '21000', simulationDeadline: '90', reservation: '0xres', initialAllocationDigest: '0xalloc', principal: '0xwallet', gate: '0xgate' }]);
  const proof = derivePresentation(proved).settlement;
  assert.equal(proof.candidateId, 'nvda-note-a');
  assert.equal(proof.mandateDigest, '0xabc');
  assert.equal(proof.gasEstimate, '21000');
  assert.equal(proof.simulationDeadline, '90');
  assert.equal(proof.reservationId, '0xres');
  assert.equal(proof.initialAllocationDigest, '0xalloc');
  assert.equal(proof.walletPrincipal, '0xwallet');
  assert.equal(proof.settled, false);
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
