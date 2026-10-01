/**
 * The bounded RPC abstraction (B.5.3, docs/demo/wallet-settlement-boundaries.md §6),
 * against loopback mock JSON-RPC nodes. CI never needs QuickNode.
 *
 * A read falls back to the public RPC only on a transport failure, and the
 * fallback proves its chain id first: it can never cross to another chain. A
 * send never falls back. No URL — a QuickNode URL is a credential — ever
 * appears in what the reader reports.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { ChainClient, JsonRpcClient } from '@mandate/evm-robinhood';
import { RobinhoodTestnetReader, RobinhoodTestnetRpc, isTransportFailure, type Endpoint, type PreparedTx } from '../src/rpc.ts';
import { readRpcConfig } from '../scripts/rpc-config.ts';
import { GATE, SUBMITTER_KEY } from './support/world.ts';

type Handler = (method: string, params: readonly unknown[]) => { result?: unknown; error?: { code: number; message: string } } | 'HTTP_503';

interface Node {
  readonly url: string;
  readonly calls: string[];
  close(): Promise<void>;
}

async function node(handler: Handler): Promise<Node> {
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const q = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      calls.push(q.method);
      const a = handler(q.method, q.params);
      if (a === 'HTTP_503') {
        res.writeHead(503);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, ...a }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const testnet = (extra: { [m: string]: unknown } = {}): Handler => (method) => {
  if (method === 'eth_chainId') return { result: '0xb626' };
  if (method === 'eth_blockNumber') return { result: '0x10' };
  if (method in extra) return { result: extra[method] };
  return { error: { code: -32601, message: 'not here' } };
};

const endpoint = (url: string, label: Endpoint['label']): Endpoint => ({ chain: new ChainClient(new JsonRpcClient(url, { allowLoopback: true }), 46_630n), label });

const RECEIPT = { status: '0x1', blockNumber: '0x10', blockHash: `0x${'ab'.repeat(32)}`, gasUsed: '0x5208', effectiveGasPrice: '0x1', contractAddress: null, logs: [] };

describe('ChainReader', () => {
  it('falls back to the public RPC on a transport failure only, and says so', async () => {
    const primary = await node(() => 'HTTP_503');
    const fallback = await node(testnet({ eth_getTransactionReceipt: RECEIPT }));
    try {
      const r = new RobinhoodTestnetReader(GATE, { primary: endpoint(primary.url, 'quicknode'), fallback: endpoint(fallback.url, 'public-fallback') });
      const receipt = await r.receiptOnce(`0x${'01'.repeat(32)}`);
      assert.ok(receipt.ok && receipt.value?.status === 'SUCCESS');
      assert.equal(r.provenance(), 'public-fallback');
      // The fallback proved its chain before its answer was used.
      assert.deepEqual(fallback.calls.slice(0, 2), ['eth_chainId', 'eth_getTransactionReceipt']);
    } finally {
      await primary.close();
      await fallback.close();
    }
  });

  it('never falls back across chains: a fallback serving another chain is refused, a mainnet above all', async () => {
    for (const chainId of ['0x1', '0x1237', '0xa4b1', '0xb627']) {
      const primary = await node(() => 'HTTP_503');
      const fallback = await node((m) => (m === 'eth_chainId' ? { result: chainId } : { result: RECEIPT }));
      try {
        const r = new RobinhoodTestnetReader(GATE, { primary: endpoint(primary.url, 'quicknode'), fallback: endpoint(fallback.url, 'public-fallback') });
        const receipt = await r.receiptOnce(`0x${'01'.repeat(32)}`);
        assert.equal(receipt.ok, false, chainId);
        assert.match(receipt.ok ? '' : receipt.error, /^(WRONG_CHAIN|MAINNET_REFUSED)_/);
        assert.equal(fallback.calls.includes('eth_getTransactionReceipt'), false, chainId);
      } finally {
        await primary.close();
        await fallback.close();
      }
    }
  });

  it('does not fall back on an answer: a wrong chain or an RPC error from the primary stands', async () => {
    const wrong = await node((m) => (m === 'eth_chainId' ? { result: '0x1' } : { result: RECEIPT }));
    const erroring = await node((m) => (m === 'eth_chainId' ? { result: '0xb626' } : { error: { code: -32000, message: 'execution reverted' } }));
    const fallback = await node(testnet({ eth_getTransactionReceipt: RECEIPT }));
    try {
      for (const primary of [wrong, erroring]) {
        const r = new RobinhoodTestnetReader(GATE, { primary: endpoint(primary.url, 'quicknode'), fallback: endpoint(fallback.url, 'public-fallback') });
        const receipt = await r.receiptOnce(`0x${'01'.repeat(32)}`);
        assert.equal(receipt.ok, false);
        assert.equal(r.provenance(), 'quicknode');
      }
      assert.deepEqual(fallback.calls, []);
    } finally {
      await wrong.close();
      await erroring.close();
      await fallback.close();
    }
  });

  it('reads one-shot: no receipt is null, not an error; nonces at latest and pending', async () => {
    const n = await node((m, p) => (m === 'eth_chainId' ? { result: '0xb626' } : m === 'eth_getTransactionReceipt' ? { result: null } : m === 'eth_getTransactionByHash' ? { result: null } : m === 'eth_getTransactionCount' ? { result: p[1] === 'pending' ? '0x8' : '0x7' } : { error: { code: -32601, message: 'x' } }));
    try {
      const r = new RobinhoodTestnetReader(GATE, { primary: endpoint(n.url, 'public'), fallback: null });
      assert.deepEqual(await r.receiptOnce(`0x${'02'.repeat(32)}`), { ok: true, value: null });
      assert.deepEqual(await r.transaction(`0x${'02'.repeat(32)}`), { ok: true, value: null });
      assert.deepEqual(await r.nonceAt(GATE, 'latest'), { ok: true, value: 7n });
      assert.deepEqual(await r.nonceAt(GATE, 'pending'), { ok: true, value: 8n });
    } finally {
      await n.close();
    }
  });

  it('classifies transport failures narrowly', () => {
    for (const e of ['NETWORK.TimeoutError', 'HTTP_502', 'HTTP_429', 'NOT_JSON', 'BLOCK.NETWORK.TypeError', 'MARKET.HTTP_503']) assert.equal(isTransportFailure(e), true, e);
    for (const e of ['WRONG_CHAIN_1', 'MAINNET_REFUSED_4663', 'RPC_-32000:execution reverted', 'HTTP_400', 'TARGET_NOT_THE_GATE']) assert.equal(isTransportFailure(e), false, e);
  });
});

describe('TransactionBroadcaster', () => {
  it('sends to the primary only: a failed send is an error, never retried on the fallback', async () => {
    const primary = await node((m) => (m === 'eth_chainId' ? { result: '0xb626' } : 'HTTP_503'));
    const fallback = await node(testnet({ eth_sendRawTransaction: `0x${'03'.repeat(32)}` }));
    try {
      const rpc = new RobinhoodTestnetRpc(SUBMITTER_KEY, GATE, { primary: endpoint(primary.url, 'quicknode'), fallback: endpoint(fallback.url, 'public-fallback') });
      const tx = { hash: `0x${'03'.repeat(32)}`, raw: '0x02', call: { calldata: '0x', attempt: null as never }, from: rpc.submitter, to: GATE, nonce: 0n, gasLimit: 1n, maxFeePerGas: 1n } as PreparedTx;
      const sent = await rpc.broadcast(tx);
      assert.deepEqual(sent, { kind: 'ERROR', error: 'HTTP_503' });
      assert.equal(fallback.calls.includes('eth_sendRawTransaction'), false);
      assert.deepEqual(await rpc.broadcast({ ...tx, to: '0x' + '99'.repeat(20) }), { kind: 'ERROR', error: 'NOT_A_PREPARED_GATE_EXECUTE' });
    } finally {
      await primary.close();
      await fallback.close();
    }
  });
});

describe('RPC configuration', () => {
  const QN = 'https://demo-name.robinhood-testnet.quiknode.pro/0123456789abcdef0123456789abcdef/';

  it('uses QuickNode only from the environment, with the public RPC as a read fallback, and never prints the URL', () => {
    const c = readRpcConfig({ ROBINHOOD_TESTNET_RPC_URL: QN });
    assert.ok(c.ok);
    assert.deepEqual(c.endpoints, { quicknode: QN, publicFallback: true });
    assert.equal(c.label.includes('0123456789abcdef'), false);
    const none = readRpcConfig({ ROBINHOOD_TESTNET_RPC_URL: QN, ROBINHOOD_TESTNET_RPC_FALLBACK: 'none' });
    assert.ok(none.ok && none.endpoints.publicFallback === false);
    const absent = readRpcConfig({});
    assert.ok(absent.ok && absent.endpoints.quicknode === null);
  });

  it('refuses any other host without echoing it, and ignores a mainnet URL', () => {
    for (const url of ['http://x.quiknode.pro/t/', 'https://evil.example/t/', 'https://rpc.mainnet.chain.robinhood.com', 'not a url']) {
      const c = readRpcConfig({ ROBINHOOD_TESTNET_RPC_URL: url });
      assert.equal(c.ok, false, url);
      assert.equal(!c.ok && c.error.includes(url), false);
    }
    const m = readRpcConfig({ ROBINHOOD_MAINNET_RPC_URL: 'https://x.quiknode.pro/secret/' });
    assert.ok(m.ok && m.endpoints.quicknode === null && m.notes.some((n) => /ignored/.test(n)));
    assert.equal(readRpcConfig({ ROBINHOOD_TESTNET_RPC_FALLBACK: 'mainnet' }).ok, false);
  });

  it('the reader holds no authority: rpc.ts reads nothing of Mandate, the session or eligibility', () => {
    const text = readFileSync(new URL('../src/rpc.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(text, /@mandate\/(portfolio|live-agents|control|ledger)|eligibility|authorized-execution|SendGate/);
  });
});
