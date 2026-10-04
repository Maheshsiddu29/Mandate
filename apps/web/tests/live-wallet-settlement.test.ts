import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import type { JsonRecord, LiveEvent } from '../components/demo/live/live-client.ts';
import { deriveFlow, eventsAfter, type FlowInput } from '../components/demo/live/live-flow.ts';
import { derivePresentation } from '../components/demo/live/live-model.ts';
import { executionRetry, holdNote, proofStatus, receiptHeading, settlementRefusal } from '../components/demo/live/settlement-refusal.ts';
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

test('the wallet adapter connects, reads, switches chain, signs typed data, and only sends bounded ERC-20 approve', async () => {
  assert.deepEqual([...WALLET_METHODS], [
    'eth_requestAccounts',
    'eth_accounts',
    'eth_chainId',
    'wallet_switchEthereumChain',
    'wallet_addEthereumChain',
    'eth_signTypedData_v4',
    'eth_sendTransaction',
    'eth_call',
    'eth_getTransactionReceipt',
  ]);
  assert.match(walletSource, /sendBoundedErc20Approve/);
  assert.doesNotMatch(walletSource, /eth_sendRawTransaction|eth_signTransaction|personal_sign|eth_sign"|eth_sign'/);
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

test('bounded V3 MDUSD approve refuses wrong chain and unlimited amounts', async () => {
  const principal = '0xabcdef0123456789abcdef0123456789abcdef01';
  const plan = {
    chainId: 46_630,
    gate: '0x5cf0621ab974d100fd5df225dab046bf35fa7519',
    fundingToken: '0x53b640b9a573e33c541de5a4917bc4d28d956abf',
    requiredAllowanceAtoms: '64000000',
    principal,
    basis: 'MAXIMUM' as const,
  };
  const wrongChain = fakeProvider({ eth_chainId: '0x1' });
  const wWrong = injectedWallet(wrongChain);
  assert.ok(wWrong !== null);
  const refused = await wWrong.sendBoundedErc20Approve(plan);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error.code, 'WRONG_CHAIN');

  const txHash = `0x${'cd'.repeat(32)}`;
  const p = fakeProvider({ eth_chainId: '0xb626', eth_sendTransaction: txHash });
  const w = injectedWallet(p);
  assert.ok(w !== null);
  const sent = await w.sendBoundedErc20Approve(plan);
  assert.deepEqual(sent, { ok: true, value: txHash });
  const send = p.calls.find((c) => c.method === 'eth_sendTransaction');
  const tx = send?.params[0] as { to: string; data: string; value: string; from: string };
  assert.equal(tx.to, plan.fundingToken);
  assert.equal(tx.from, principal);
  assert.equal(tx.value, '0x0');
  assert.match(tx.data, /^0x095ea7b3/);
  assert.ok(!tx.data.toLowerCase().endsWith('f'.repeat(64)));

  const unlimited = await w.sendBoundedErc20Approve({ ...plan, requiredAllowanceAtoms: ((1n << 256n) - 1n).toString() });
  assert.equal(unlimited.ok, false);
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
  assert.match(outcome, /Sign execution/);
  assert.match(outcome, /Sign execution authorization/);
  assert.match(outcome, /This signs execution authority\. It is not a transaction\./);
  assert.match(outcome, /Execute on Robinhood Testnet/);
  assert.match(outcome, /Technical proof/);
  assert.match(outcome, /Agent selected/);
  assert.match(lab, /Signature cancelled\. Nothing was sent\./);
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
  assert.match(read('../components/demo/live/settlement-refusal.ts'), /READY · NOT SENT/);
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

test('a settlement 409 does not enter Executing, and the signed total is not a hidden $2,500', () => {
  const refused = after(['TESTNET_SEND_AUTHORIZATION_REFUSED', { reason: 'SEND_NOT_AUTHORIZED' }]);
  assert.notEqual(deriveFlow(done(refused)).phase, 'SETTLING');
  assert.equal(derivePresentation(refused).settlement.stage, 'FAILED');
  const refusedCopy = settlementRefusal({ code: 'SEND_NOT_AUTHORIZED', message: 'Broadcast needs an explicit execution request. Nothing was sent.', stage: 'SEND_GATE', transactions: 0, txHash: null });
  assert.equal(refusedCopy.code, 'SEND_NOT_AUTHORIZED');
  assert.match(refusedCopy.summary, /Nothing was sent/);
  assert.equal(refusedCopy.transactions, 0);
  assert.equal(refusedCopy.txHash, null);
  assert.equal(receiptHeading({ settled: false, txHash: null, stage: 'FAILED', refused: true }).title, 'Not sent');
  assert.equal(receiptHeading({ settled: false, txHash: '0xabc', stage: 'FAILED', refused: false }).title, 'Settlement failed');
  assert.equal(proofStatus({ settled: false, stage: 'FAILED', txHash: null }), 'NOT SENT');
  assert.equal(proofStatus({ settled: false, stage: 'FAILED', txHash: '0xabc' }), 'FAILED');
  assert.equal(proofStatus({ settled: true, stage: 'SETTLED', txHash: '0xabc' }), 'CONFIRMED');
  assert.match(outcome, /No transaction was submitted/);
  assert.match(outcome, /settlement\.txHash !== null \? <p className="mw-fine">Failed receipt/);
  assert.equal(executionRetry('SPINE_EXPIRED'), false);
  assert.equal(executionRetry('SETTLEMENT_IN_PROGRESS'), false);
  assert.equal(executionRetry('BUSY'), false);
  assert.equal(executionRetry('NO_STOCK_RESERVATION'), false);
  assert.equal(executionRetry('SPINE_METHOD_REQUIRED'), false);
  assert.equal(executionRetry('CONSUMED'), false);
  assert.equal(executionRetry('GATE_EXECUTION_AUTHORITY_REQUIRED'), true);
  assert.equal(executionRetry('SEND_NOT_AUTHORIZED'), true);
  assert.doesNotMatch(outcome, /<p className="mw-notice mw-notice--bad"/);
  assert.match(outcome, /<div className="mw-notice mw-notice--bad"/);
  assert.match(outcome, /<dt>Reason<\/dt>/);
  assert.doesNotMatch(outcome, /Awaiting operator send authorization/);
  assert.doesNotMatch(outcome, /Ready · not sent/);
  assert.match(lab, /setSettleConflict/);
  assert.match(lab, /async function execute\(\)[\s\S]*postSettle\(\{ mode: "SEND", intent: "EXECUTE_ROBINHOOD_TESTNET" \}\);[\s\S]*setSigning\(false\);\s*\}/);
  const configure = read('../components/demo/live/stage-configure.tsx');
  assert.match(configure, /signed \? "authorized" : "draft"/);
  assert.match(configure, /allocated/);
  assert.doesNotMatch(configure, /2500|2,500/);
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

test('C1.4: an RPC state-read refusal is NOT SENT, shows the exact reason under Details, and a held attempt offers no Execute', () => {
  const reason = 'GATE_STATE_UNKNOWN.MARKET.BLOCK_AHEAD_OF_NODE.RPC_-32000:unsupported block number 128270281';
  const message = `Robinhood Chain testnet state could not be verified (DOMAIN: ${reason}). Nothing was sent.`;
  const refused = settlementRefusal({ code: reason, message, stage: 'DOMAIN', transactions: 0, txHash: null, held: true, heldUntil: '1790814765' });
  assert.equal(refused.summary, 'Robinhood Chain testnet state could not be verified. Nothing was sent.');
  assert.doesNotMatch(refused.summary, /fail|revert/i);
  assert.equal(refused.code, reason);
  assert.equal(refused.message, message);
  assert.equal(refused.stage, 'DOMAIN');
  assert.equal(refused.transactions, 0);
  assert.equal(refused.txHash, null);
  assert.equal(refused.held, true);
  assert.equal(holdNote(refused, (ms) => `t=${ms}`), 'This attempt is held until t=1790814765000, then released. It is never resent.');
  assert.equal(executionRetry(refused.code, refused.held), false);
  // The same read failing before anything was signed is not held: Execute stays.
  const early = settlementRefusal({ code: reason, message, stage: 'DOMAIN', transactions: 0, txHash: null, held: false, heldUntil: null });
  assert.equal(holdNote(early, String), null);
  assert.equal(executionRetry(early.code, early.held), true);
  assert.equal(settlementRefusal({ code: 'CHAIN_TIME_UNREADABLE.NETWORK.TimeoutError', message: '', stage: 'DOMAIN', transactions: 0, txHash: null }).summary, 'Robinhood Chain testnet state could not be verified. Nothing was sent.');
  // A malformed hold time is dropped, not shown.
  assert.equal(settlementRefusal({ code: reason, message, stage: 'DOMAIN', transactions: 0, txHash: null, held: true, heldUntil: 'soon' }).heldUntil, null);

  // The refusal event leaves the receipt NOT SENT: no hash, no failed receipt, not Executing.
  const events = after(['DOMAIN_EXECUTION_INELIGIBLE', { stage: 'DOMAIN', reason, transactions: 0 }]);
  const view = derivePresentation(events).settlement;
  assert.equal(view.stage, 'FAILED');
  assert.equal(view.txHash, null);
  assert.equal(view.gateSign, null);
  assert.notEqual(deriveFlow(done(events)).phase, 'SETTLING');
  assert.equal(proofStatus({ settled: false, stage: view.stage, txHash: view.txHash }), 'NOT SENT');
  assert.equal(receiptHeading({ settled: false, txHash: null, stage: view.stage, refused: true }).title, 'Not sent');

  // The page reads the hold from the server and renders it next to the exact reason.
  assert.match(lab, /held: result\.body\.held === true/);
  assert.match(lab, /executionRetry\(settleConflict\?\.code \?\? null, settleConflict\?\.held \?\? false\)/);
  assert.match(outcome, /holdNote\(conflict/);
  assert.match(outcome, /<dt>Attempt<\/dt>/);
});

test('C1.4 wallet audit: two Mandate signatures on the browser path, one execution signature per attempt, no dry-run signature before a send', () => {
  // Exactly two typed-data signing sites: the portfolio mandate and the gate MandateAuthorization.
  assert.equal(lab.match(/\.signTypedData\(/g)?.length, 2);
  assert.match(lab, /signTypedData\(address, challenge\.typedData\)/);
  assert.match(lab, /signTypedData\(address, gate\.typedData\)/);
  // Execute posts one SEND intent. The page never posts a dry run, so no dry-run signature precedes a send.
  assert.match(lab, /postSettle\(\{ mode: "SEND", intent: "EXECUTE_ROBINHOOD_TESTNET" \}\)/);
  assert.doesNotMatch(lab, /mode: "DRY_RUN"/);
  // Only typed data for the open SEND is signed; the button is disabled while a signature is open.
  assert.match(lab, /if \(gate\.mode !== "SEND"\)/);
  assert.match(outcome, /disabled=\{props\.signing\} onClick=\{props\.onSignStock\}/);
  // A refusal clears the open request, so the same typed data cannot be signed twice.
  const refused = derivePresentation(after(['GATE_EXECUTION_SIGNATURE_REQUIRED', { mode: 'SEND', typedData: { primaryType: 'MandateAuthorization' } }], ['DOMAIN_EXECUTION_INELIGIBLE', { stage: 'DOMAIN', reason: 'GATE_STATE_UNKNOWN.MARKET.X' }]));
  assert.equal(refused.settlement.gateSign, null);
});
