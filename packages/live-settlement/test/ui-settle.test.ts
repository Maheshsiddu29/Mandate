/**
 * The in-page V2 settlement bridge. `settle` is injected, so this does not
 * touch a chain, a key file or the registry. It still has to call that
 * function — the re-verify lives there — and it must not echo the domain keys.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LiveSession } from '@mandate/live-agents';
import { SEND_AUTHORIZATION_PHRASE } from '../src/send-gate.ts';
import type { GateExecutionRequest } from '../src/gate-authority.ts';
import type { SpineSettlementInput, SpineSettlementResult } from '../src/spine-settlement.ts';
import type { AttemptRecord } from '../src/journal.ts';
import { SpineUi, v3TechnicalProof, type SpineUiHost } from '../src/ui-settle.ts';
import { testDeployment } from './support/world.ts';

const SIG = `0x${'ab'.repeat(65)}`;
const DIGEST = `0x${'11'.repeat(32)}`;
const KEY_SENTINEL = '0xPRINCIPALKEY';

const request: GateExecutionRequest = {
  kind: 'MANDATE_AUTHORIZATION',
  principal: '0xwallet',
  agent: '0xagent',
  gate: '0xgate',
  chainId: '46630',
  mandateDigest: DIGEST,
  signingHash: `0x${'22'.repeat(32)}`,
  mandateExpiresAt: '90',
  debitAtoms: '1',
  quantityAtoms: '1',
  note: 'EIP-712 MandateAuthorization. Not a transaction.',
  typedData: { primaryType: 'MandateAuthorization', domain: { name: 'Mandate', version: '1', chainId: 46630, verifyingContract: '0xgate' }, message: { mandateDigest: DIGEST } },
};

const ready = { status: 'READY', outcome: { status: 'READY', wouldSend: { network: 'Robinhood Chain Testnet', chainId: '46630', tokenIn: { symbol: 'MDUSD', amount: '1' }, tokenOut: { symbol: 'MDEMO', amount: '2' } } }, principals: { portfolio: { method: 'WALLET_PRINCIPAL_V2', address: '0xwallet' }, protocolSigner: '0xwallet', domainSettlement: { kind: 'WALLET_GATE_EIP712', address: '0xwallet' }, delegation: 'GATE_EIP712_PER_EXECUTION' }, reports: [] } as unknown as SpineSettlementResult;

interface Harness {
  ui: SpineUi;
  readonly emitted: { readonly kind: string; readonly data: unknown }[];
  readonly calls: SpineSettlementInput[];
  ask: boolean;
  task: 'RUN' | 'POLICY_STRESS' | null;
  session: boolean;
  readonly timers: (() => void)[];
  closed: number;
  cleaned: number;
  reconciled: number;
}

function harness(): Harness {
  const emitted: { kind: string; data: unknown }[] = [];
  const calls: SpineSettlementInput[] = [];
  const timers: (() => void)[] = [];
  const h: Harness = { ui: null as unknown as SpineUi, emitted, calls, ask: false, task: null, session: true, timers, closed: 0, cleaned: 0, reconciled: 0 };
  const session = {
    id: 'lab-1',
    events: { emit: (kind: string, fields: { readonly data?: unknown }) => emitted.push({ kind, data: fields.data }), events: emitted },
  } as unknown as LiveSession;
  const host: SpineUiHost = {
    openSession: async () => (h.session ? session : null),
    taskOf: () => h.task,
    reconcile: async () => {
      h.reconciled += 1;
      return [];
    },
    settle: async (input) => {
      calls.push(input);
      if (h.ask) {
        const sig = (await input.resolveGateExecution?.(request)) ?? null;
        if (sig === null) return { status: 'INELIGIBLE', stage: 'GATE_AUTHORITY', reason: 'GATE_EXECUTION_AUTHORITY_REQUIRED', reports: [] };
        assert.equal(sig, SIG);
      }
      return ready;
    },
    deployment: { chainId: 46630n } as SpineUiHost['deployment'],
    rpc: {} as SpineUiHost['rpc'],
    keys: { principal: KEY_SENTINEL, agent: '0xAGENTKEY' },
    journalFor: () => ({ close: () => { h.closed += 1; } }) as unknown as ReturnType<SpineUiHost['journalFor']>,
    scratch: () => ({ path: '/tmp/scratch', cleanup: () => { h.cleaned += 1; } }),
    ledgerPath: () => '/tmp/durable',
    schedule: (_ms, fn) => {
      timers.push(fn);
      return () => undefined;
    },
    signatureWaitMs: 1_000,
  };
  h.ui = new SpineUi(host);
  return h;
}

const body = (r: { readonly body: { readonly [k: string]: unknown } }) => r.body;
const post = (h: Harness, value: unknown) => h.ui.handle('POST', '/api/live/sessions/lab-1/settle', value);

describe('V2 settlement bridge', () => {
  it('advertises the spine without a broadcast path for the wallet', async () => {
    const h = harness();
    const r = await h.ui.handle('GET', '/api/live/settlement', null);
    assert.equal(r?.status, 200);
    assert.equal(body(r as NonNullable<typeof r>)['spine'], 'V2');
    assert.equal(body(r as NonNullable<typeof r>)['walletBroadcasts'], false);
    assert.equal(body(r as NonNullable<typeof r>)['gasPayer'], 'DEPLOYER');
    assert.equal(body(r as NonNullable<typeof r>)['sendAuthorization'], SEND_AUTHORIZATION_PHRASE);
    assert.equal(body(r as NonNullable<typeof r>)['reverify'], 'EIP-712 PortfolioMandateV2');
    assert.equal(await h.ui.handle('GET', '/api/live/status', null), null);
  });

  it('dry-runs through the injected spine and does not echo keys', async () => {
    const h = harness();
    const r = await post(h, { mode: 'DRY_RUN' });
    assert.equal(r?.status, 200);
    assert.equal(body(r as NonNullable<typeof r>)['status'], 'READY');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.mode, 'DRY_RUN');
    assert.equal(h.calls[0]?.gate.state, 'LOCKED');
    assert.equal(h.calls[0]?.ledgerPath, '/tmp/scratch');
    assert.equal(h.emitted.at(-1)?.kind, 'SPINE_DRY_RUN_READY');
    const evidence = h.emitted.at(-1)?.data as { readonly broadcast: boolean; readonly evidenceClass: string; readonly transactions: number };
    assert.equal(evidence.broadcast, false);
    assert.equal(evidence.evidenceClass, 'DRY_RUN');
    assert.equal(evidence.transactions, 0);
    assert.equal(h.closed, 1);
    assert.equal(h.cleaned, 1);
    assert.doesNotMatch(JSON.stringify(r), new RegExp(KEY_SENTINEL));
    assert.doesNotMatch(JSON.stringify(h.emitted), new RegExp(KEY_SENTINEL));
  });

  it('parks for MandateAuthorization, then continues the same run with the wallet signature', async () => {
    const h = harness();
    h.ask = true;
    const first = await post(h, { mode: 'DRY_RUN' });
    assert.equal(first?.status, 200);
    assert.equal(body(first as NonNullable<typeof first>)['status'], 'GATE_SIGNATURE_REQUIRED');
    const gate = body(first as NonNullable<typeof first>)['gateExecution'] as { readonly typedData: { readonly primaryType: string }; readonly mandateDigest: string };
    assert.equal(gate.typedData.primaryType, 'MandateAuthorization');
    assert.equal(gate.mandateDigest, DIGEST);
    assert.equal(h.emitted[0]?.kind, 'GATE_EXECUTION_SIGNATURE_REQUIRED');
    assert.equal(h.closed, 0);
    const again = await post(h, { mode: 'DRY_RUN' });
    assert.equal(body(again as NonNullable<typeof again>)['status'], 'GATE_SIGNATURE_REQUIRED');
    const done = await post(h, { mode: 'DRY_RUN', gateSignature: SIG });
    assert.equal(done?.status, 200);
    assert.equal(body(done as NonNullable<typeof done>)['status'], 'READY');
    assert.equal(h.calls.length, 1);
    assert.equal(h.emitted.at(-1)?.kind, 'SPINE_DRY_RUN_READY');
    assert.equal(h.closed, 1);
    assert.doesNotMatch(JSON.stringify(h.emitted), new RegExp(SIG.slice(2, 12)));
  });

  it('a rejected signature cancels the parked run instead of holding it', async () => {
    const h = harness();
    h.ask = true;
    await post(h, { mode: 'DRY_RUN' });
    const cancelled = await post(h, { mode: 'DRY_RUN', cancel: true });
    assert.equal(cancelled?.status, 409);
    assert.equal(body(cancelled as NonNullable<typeof cancelled>)['error'], 'GATE_EXECUTION_AUTHORITY_REQUIRED');
    assert.equal(h.closed, 1);
    h.ask = false;
    const retry = await post(h, { mode: 'DRY_RUN' });
    assert.equal(body(retry as NonNullable<typeof retry>)['status'], 'READY');
  });

  it('the operator phrase is checked before a send, and the durable ledger is the one that would be broadcast', async () => {
    const h = harness();
    const refused = await post(h, { mode: 'SEND', sendAuthorization: 'send it' });
    assert.equal(refused?.status, 409);
    assert.equal(body(refused as NonNullable<typeof refused>)['error'], 'SEND_NOT_AUTHORIZED');
    assert.equal(h.calls.length, 0);
    assert.equal(h.emitted[0]?.kind, 'TESTNET_SEND_AUTHORIZATION_REFUSED');
    const sent = await post(h, { mode: 'SEND', sendAuthorization: SEND_AUTHORIZATION_PHRASE });
    assert.equal(sent?.status, 200);
    assert.equal(h.calls[0]?.mode, 'SEND');
    assert.equal(h.calls[0]?.gate.state, 'AUTHORIZED');
    assert.equal(h.calls[0]?.gate.source, 'OPERATOR_PHRASE');
    assert.equal(body(refused as NonNullable<typeof refused>)['transactions'], 0);
    assert.equal(h.calls[0]?.ledgerPath, '/tmp/durable');
    assert.equal(h.cleaned, 0);
  });

  it('a browser execute intent opens the same one-shot gate and rejects execution parameters', async () => {
    const h = harness();
    const extra = await post(h, { mode: 'SEND', intent: 'EXECUTE_ROBINHOOD_TESTNET', tokenIn: '0xabc', amount: '1' });
    assert.equal(extra?.status, 400);
    assert.match(String(body(extra as NonNullable<typeof extra>)['message']), /Unexpected field/);
    assert.equal(h.calls.length, 0);
    const notSend = await post(h, { mode: 'DRY_RUN', intent: 'EXECUTE_ROBINHOOD_TESTNET' });
    assert.equal(notSend?.status, 400);
    const sent = await post(h, { mode: 'SEND', intent: 'EXECUTE_ROBINHOOD_TESTNET' });
    assert.equal(sent?.status, 200);
    assert.equal(h.calls[0]?.mode, 'SEND');
    assert.equal(h.calls[0]?.gate.state, 'AUTHORIZED');
    assert.equal(h.calls[0]?.gate.source, 'BROWSER_INTENT');
    assert.equal(h.calls[0]?.ledgerPath, '/tmp/durable');
    assert.equal(h.cleaned, 0);
    const bare = await post(h, { mode: 'SEND' });
    assert.equal(bare?.status, 409);
    assert.equal(body(bare as NonNullable<typeof bare>)['error'], 'SEND_NOT_AUTHORIZED');
    assert.equal(body(bare as NonNullable<typeof bare>)['transactions'], 0);
    const wrong = await post(h, { mode: 'SEND', intent: 'SEND_IT' });
    assert.equal(wrong?.status, 400);
    for (const field of ['tokenIn', 'tokenOut', 'venue', 'adapter', 'recipient', 'calldata', 'candidate', 'gate', 'chainId', 'mandateDigest', 'executionCommitment', 'amount']) {
      const hostile = await post(h, { mode: 'SEND', intent: 'EXECUTE_ROBINHOOD_TESTNET', [field]: '0xabc' });
      assert.equal(hostile?.status, 400, field);
      assert.match(String(body(hostile as NonNullable<typeof hostile>)['message']), /Unexpected field/);
    }
  });

  it('a second browser execute while one is open does not start another settlement, and a restart does not keep the gate open', async () => {
    const h = harness();
    h.ask = true;
    const first = await post(h, { mode: 'SEND', intent: 'EXECUTE_ROBINHOOD_TESTNET' });
    assert.equal(body(first as NonNullable<typeof first>)['status'], 'GATE_SIGNATURE_REQUIRED');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.gate.source, 'BROWSER_INTENT');
    const again = await post(h, { mode: 'SEND', intent: 'EXECUTE_ROBINHOOD_TESTNET' });
    assert.equal(body(again as NonNullable<typeof again>)['status'], 'GATE_SIGNATURE_REQUIRED');
    assert.equal(h.calls.length, 1);
    const restarted = harness();
    const stale = await post(restarted, { mode: 'SEND' });
    assert.equal(body(stale as NonNullable<typeof stale>)['error'], 'SEND_NOT_AUTHORIZED');
    assert.equal(restarted.calls.length, 0);
    assert.equal(restarted.calls[0]?.gate.source, undefined);
  });

  it('C1.4: an RPC state-read refusal after the gate signature is a NOT SENT 409 with the exact reason and the hold, and one signature was asked for', async () => {
    const h = harness();
    const reason = 'GATE_STATE_UNKNOWN.MARKET.BLOCK_AHEAD_OF_NODE.RPC_-32000:unsupported block number 128270281';
    let asked = 0;
    const ui = new SpineUi({
      openSession: async () => ({ id: 'lab-1', events: { emit: () => 0, events: [] } }) as unknown as LiveSession,
      taskOf: () => null,
      reconcile: async () => [],
      settle: async (input) => {
        asked += (await input.resolveGateExecution?.(request)) === SIG ? 1 : 0;
        return { status: 'INELIGIBLE', stage: 'DOMAIN', reason, reports: [], held: { state: 'PREPARED', until: 1_790_814_765n } };
      },
      deployment: { chainId: 46630n } as SpineUiHost['deployment'],
      rpc: {} as SpineUiHost['rpc'],
      keys: { principal: KEY_SENTINEL, agent: '0xAGENTKEY' },
      journalFor: () => ({ close: () => undefined }) as unknown as ReturnType<SpineUiHost['journalFor']>,
      scratch: () => ({ path: '/tmp/scratch', cleanup: () => undefined }),
      ledgerPath: () => '/tmp/durable',
      schedule: () => () => undefined,
      signatureWaitMs: 1_000,
    });
    const parked = await ui.handle('POST', '/api/live/sessions/lab-1/settle', { mode: 'SEND', intent: 'EXECUTE_ROBINHOOD_TESTNET' });
    assert.equal(body(parked as NonNullable<typeof parked>)['status'], 'GATE_SIGNATURE_REQUIRED');
    const r = await ui.handle('POST', '/api/live/sessions/lab-1/settle', { mode: 'SEND', gateSignature: SIG });
    assert.equal(r?.status, 409);
    const b = body(r as NonNullable<typeof r>);
    assert.equal(b['error'], reason);
    assert.equal(b['stage'], 'DOMAIN');
    assert.equal(b['transactions'], 0);
    assert.equal(b['txHash'], null);
    assert.equal(b['held'], true);
    assert.equal(b['attemptState'], 'PREPARED');
    assert.equal(b['heldUntil'], '1790814765');
    assert.match(String(b['message']), /^Robinhood Chain testnet state could not be verified \(DOMAIN: GATE_STATE_UNKNOWN\.MARKET\.BLOCK_AHEAD_OF_NODE\.RPC_-32000:unsupported block number 128270281\)\. Nothing was sent\.$/);
    assert.equal(asked, 1);
    assert.doesNotMatch(JSON.stringify(b), new RegExp(`${KEY_SENTINEL}|${SIG.slice(2, 12)}`));
    // A refusal with no hold says so too.
    const plain = await h.ui.handle('POST', '/api/live/sessions/lab-1/settle', { mode: 'SEND', sendAuthorization: 'nope' });
    assert.equal(body(plain as NonNullable<typeof plain>)['held'], false);
    assert.equal(body(plain as NonNullable<typeof plain>)['heldUntil'], null);
  });

  it('C1.5: RECONCILE reconciles only — no gate, no settle, no signature — and is refused while a settle call is open or with any other field', async () => {
    const h = harness();
    for (const extra of [{ intent: 'EXECUTE_ROBINHOOD_TESTNET' }, { sendAuthorization: SEND_AUTHORIZATION_PHRASE }, { gateSignature: SIG }, { cancel: true }]) {
      const r = await post(h, { mode: 'RECONCILE', ...extra });
      assert.equal(r?.status, 400, JSON.stringify(extra));
    }
    const r = await post(h, { mode: 'RECONCILE' });
    assert.equal(r?.status, 200);
    const b = body(r as NonNullable<typeof r>);
    assert.equal(b['status'], 'RECONCILED');
    assert.equal(b['transactions'], 0);
    assert.equal(h.reconciled, 1);
    assert.equal(h.calls.length, 0);
    assert.equal(h.closed, 1);
    assert.equal((b['settlement'] as { readonly executable: boolean }).executable, false);
    h.ask = true;
    await post(h, { mode: 'SEND', intent: 'EXECUTE_ROBINHOOD_TESTNET' });
    const busy = await post(h, { mode: 'RECONCILE' });
    assert.equal(busy?.status, 409);
    assert.equal(body(busy as NonNullable<typeof busy>)['error'], 'SETTLEMENT_IN_PROGRESS');
    assert.equal(h.reconciled, 1);
  });

  it('C1.5: the lab’s session read carries the settlement state; other reads and failures pass through unchanged', async () => {
    const h = harness();
    const read = await h.ui.handle('GET', '/api/live/sessions/lab-1', null, async () => ({ status: 200, body: { sessionId: 'lab-1', events: 0 } }));
    assert.equal(read?.status, 200);
    const b = body(read as NonNullable<typeof read>);
    assert.equal(b['sessionId'], 'lab-1');
    const s = b['settlement'] as { readonly settlementStatus: string; readonly pending: string | null; readonly executable: boolean };
    assert.equal(s.settlementStatus, 'NO_ATTEMPT');
    assert.equal(s.pending, null);
    h.ask = true;
    await post(h, { mode: 'SEND', intent: 'EXECUTE_ROBINHOOD_TESTNET' });
    const parked = await h.ui.handle('GET', '/api/live/sessions/lab-1', null, async () => ({ status: 200, body: { sessionId: 'lab-1' } }));
    assert.equal((body(parked as NonNullable<typeof parked>)['settlement'] as { readonly settlementStatus: string }).settlementStatus, 'SIGNATURE_REQUIRED');
    const missing = await h.ui.handle('GET', '/api/live/sessions/nope', null, async () => ({ status: 404, body: { error: 'SESSION_NOT_FOUND', message: 'x' } }));
    assert.deepEqual(missing, { status: 404, body: { error: 'SESSION_NOT_FOUND', message: 'x' } });
    // Without the lab's own answer, the read is the lab's: nothing is invented.
    assert.equal(await h.ui.handle('GET', '/api/live/sessions/lab-1', null), null);
    assert.equal(await h.ui.handle('GET', '/api/live/sessions/lab-1/events', null, async () => ({ status: 200, body: {} })), null);
    assert.equal(h.calls.length, 1);
  });

  it('refuses a signature that was not just requested, a busy session, and an unknown session', async () => {
    const h = harness();
    const stale = await post(h, { mode: 'DRY_RUN', gateSignature: SIG });
    assert.equal(body(stale as NonNullable<typeof stale>)['error'], 'NO_PENDING_SIGNATURE');
    h.task = 'RUN';
    const busy = await post(h, { mode: 'DRY_RUN' });
    assert.equal(busy?.status, 409);
    assert.equal(body(busy as NonNullable<typeof busy>)['error'], 'BUSY');
    assert.equal(h.calls.length, 0);
    h.task = null;
    h.session = false;
    const missing = await post(h, { mode: 'DRY_RUN' });
    assert.equal(missing?.status, 404);
  });

  it('a timed-out signature releases the session', async () => {
    const h = harness();
    h.ask = true;
    await post(h, { mode: 'DRY_RUN' });
    assert.equal(h.timers.length, 1);
    h.timers[0]?.();
    for (let i = 0; i < 5 && h.closed === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.closed, 1);
    h.ask = false;
    const retry = await post(h, { mode: 'DRY_RUN' });
    assert.equal(body(retry as NonNullable<typeof retry>)['status'], 'READY');
  });
});

describe('V3 technical proof normalization', () => {
  it('hydrates an older confirmed journal plus signed V3 authority without inventing absent digests', () => {
    const principal = `0x${'11'.repeat(20)}`;
    const delegate = `0x${'22'.repeat(20)}`;
    const agent = `0x${'33'.repeat(20)}`;
    const gate = `0x${'44'.repeat(20)}`;
    const txHash = `0x${'55'.repeat(32)}`;
    const reservation = `0x${'66'.repeat(32)}`;
    const receiptDigest = `0x${'77'.repeat(32)}`;
    const session = {
      id: 'lab-v3-proof',
      events: { events: [{ kind: 'DOMAIN_EXECUTION_SETTLED', data: { spine: 'V3', txHash, evidence: 'LIVE_TESTNET', executionNonce: '1', remainingCapacity: '0' } }] },
      versions: {
        records: [{
          version: 1,
          digest: `0x${'88'.repeat(32)}`,
          authorization: {
            method: 'WALLET_PRINCIPAL_V3_DELEGATED', principal,
            wallet: {
              initialAllocationDigest: `0x${'99'.repeat(32)}`,
              sessionDigest: `0x${'aa'.repeat(32)}`,
              delegate, agent,
              representationIdHash: `0x${'bb'.repeat(32)}`,
              fundingToken: `0x${'cc'.repeat(20)}`,
              cumulativeDebitLimit: '64000000', validAfter: '1', validUntil: '100', generation: '1',
            },
          },
        }],
      },
    } as unknown as LiveSession;
    const attempt = {
      state: 'CONSUMED', principal, gate, reservation, chainId: '46630', evidenceClass: 'ROBINHOOD_TESTNET_RPC',
      tx: { hash: txHash, to: gate },
      receipt: { status: 'SUCCESS', blockNumber: '128655452', blockHash: `0x${'dd'.repeat(32)}`, gasUsed: '322661', effectiveGasPrice: '10000000' },
      observation: receiptDigest,
      v3Proof: null,
    } as unknown as AttemptRecord;
    const proof = v3TechnicalProof(session, attempt, 'nvda-note-a', 1, testDeployment());
    assert.ok(proof);
    assert.equal(proof.candidateId, 'nvda-note-a');
    assert.equal(proof.walletPrincipal, principal);
    assert.equal(proof.gate, gate);
    assert.equal(proof.delegate, delegate);
    assert.equal(proof.agent, agent);
    assert.equal(proof.executionNonce, '1');
    assert.equal(proof.initialCapacity, '64000000');
    assert.equal(proof.cumulativeDebit, '64000000');
    assert.equal(proof.remainingCapacity, '0');
    assert.equal(proof.blockNumber, '128655452');
    assert.equal(proof.gasUsed, '322661');
    assert.equal(proof.receiptDigest, receiptDigest);
    assert.equal(proof.evidence, 'LIVE_TESTNET');
    assert.equal(proof.gateMandateDigest, null);
    assert.equal(proof.executionApprovalDigest, null);
    assert.equal(proof.executionCommitment, null);
    assert.equal(proof.gasEstimate, null);
    assert.match(proof.delegationDigest, /^0x[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(proof), /privateKey|delegateSignature|agentSignature|principalSignature|"raw"|calldata/i);
    assert.equal(v3TechnicalProof(session, { ...attempt, state: 'CONFIRMED_REVERT' }, 'nvda-note-a', 1, testDeployment()), null);
    assert.equal(v3TechnicalProof(session, { ...attempt, tx: null }, 'nvda-note-a', 1, testDeployment()), null);
  });
});
