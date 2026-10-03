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
import { SpineUi, type SpineUiHost } from '../src/ui-settle.ts';

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
}

function harness(): Harness {
  const emitted: { kind: string; data: unknown }[] = [];
  const calls: SpineSettlementInput[] = [];
  const timers: (() => void)[] = [];
  const h: Harness = { ui: null as unknown as SpineUi, emitted, calls, ask: false, task: null, session: true, timers, closed: 0, cleaned: 0 };
  const session = {
    id: 'lab-1',
    events: { emit: (kind: string, fields: { readonly data?: unknown }) => emitted.push({ kind, data: fields.data }) },
  } as unknown as LiveSession;
  const host: SpineUiHost = {
    openSession: async () => (h.session ? session : null),
    taskOf: () => h.task,
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
