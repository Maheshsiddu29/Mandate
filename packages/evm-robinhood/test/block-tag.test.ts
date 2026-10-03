/**
 * The one block identifier encoder and the pinned gate-market snapshot
 * (C1.4), against a loopback mock JSON-RPC node.
 *
 * A live refusal read `GATE_STATE_UNKNOWN.MARKET.CALL_REVERTED.RPC_-32000:
 * unsupported block number 128270281`. The block was already sent as a hex
 * quantity: Robinhood Chain's public testnet RPC answers exactly that error
 * when the pinned block is ahead of the node serving the read (characterized
 * read-only against rpc.testnet.chain.robinhood.com). These tests pin the
 * encoding, that the answer is classified as the endpoint's and not the
 * contract's, and that the snapshot only ever waits at the same block.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@mandate/kernel';
import { ChainClient, JsonRpcClient, MAX_BLOCK_NUMBER, PINNED_REREADS, createGateSpotPolicy, encodeBlockTag, pinnedBlockUnavailable, readGateMarkets, type BlockTag } from '../src/index.ts';
import { CHAIN, GATE, MARKET, policyConfig } from './support/world.ts';

interface Request {
  readonly method: string;
  readonly params: readonly unknown[];
  readonly body: string;
}
type Answer = { readonly result?: unknown; readonly error?: { readonly code: number; readonly message: string } };

interface Node {
  readonly url: string;
  readonly requests: Request[];
  close(): Promise<void>;
}

async function node(handler: (q: Request) => Answer): Promise<Node> {
  const requests: Request[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const q = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      const r: Request = { method: q.method, params: q.params, body };
      requests.push(r);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, ...handler(r) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const client = (url: string) => new ChainClient(new JsonRpcClient(url, { allowLoopback: true }), CHAIN);
const selector = (sig: string) => bytesToHex(keccak_256(new TextEncoder().encode(sig))).slice(0, 10);
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const addr = (a: string) => a.slice(2).toLowerCase().padStart(64, '0');

/** The live failure's block. */
const LIVE_BLOCK = 128_270_281n;
const HEAD = { number: '0x7a53fc9', hash: `0x${'4b'.repeat(32)}`, timestamp: '0x6a5b0000' };

const MARKET_WORDS = `0x${[addr(MARKET.representation), addr(MARKET.fundingToken), addr(MARKET.adapter), word(18n), word(6n), word(0n), word(1n), ...Array.from({ length: 5 }, () => word(7n)), word(6n), word(10_000_000n)].join('')}`;

/** A gate that serves its one market at any block the node has reached. */
function gateNode(o: { readonly ahead?: () => boolean; readonly error?: Answer['error'] } = {}) {
  return (q: Request): Answer => {
    if (q.method === 'eth_chainId') return { result: '0xb626' };
    if (q.method === 'eth_getBlockByNumber') return { result: HEAD };
    if (q.method !== 'eth_call' && q.method !== 'eth_getCode') return { error: { code: -32601, message: 'not here' } };
    const block = q.params[1] as string;
    if (q.method === 'eth_getCode') return o.ahead?.() === true ? { error: { code: -32000, message: `unsupported block number ${BigInt(block)}` } } : { result: '0x6080' };
    if (o.ahead?.() === true) return { error: { code: -32000, message: `unsupported block number ${BigInt(block)}` } };
    if (o.error !== undefined) return { error: o.error };
    const data = (q.params[0] as { data: string }).data;
    if (data.startsWith(selector('marketOf(bytes32)'))) return { result: MARKET_WORDS };
    if (data.startsWith(selector('fixtureVenueOf(bytes32)'))) return { result: `0x${addr(MARKET.venue)}` };
    if (data.startsWith(selector('FEE_BPS()'))) return { result: `0x${word(0n)}` };
    return { error: { code: -32000, message: 'execution reverted' } };
  };
}

describe('encodeBlockTag', () => {
  it('encodes a block number as a canonical hex quantity', () => {
    const cases: readonly (readonly [bigint, string])[] = [
      [0n, '0x0'],
      [1n, '0x1'],
      [15n, '0xf'],
      [16n, '0x10'],
      [LIVE_BLOCK, '0x7a53fc9'],
      [127_958_756n, '0x7a07ee4'],
      [2n ** 53n + 1n, '0x20000000000001'],
      [MAX_BLOCK_NUMBER, '0x7fffffffffffffff'],
    ];
    for (const [n, hex] of cases) assert.deepEqual(encodeBlockTag(n), { ok: true, value: hex }, n.toString());
  });

  it('passes the named tags through unchanged', () => {
    for (const t of ['latest', 'pending', 'safe', 'finalized'] as const) assert.deepEqual(encodeBlockTag(t), { ok: true, value: t });
  });

  it('refuses negatives, values past int64, JS numbers and every string that is not a named tag', () => {
    const bad: readonly unknown[] = [-1n, MAX_BLOCK_NUMBER + 1n, 2n ** 64n, 0, 1, 128_270_281, Number.MAX_SAFE_INTEGER + 2, Number.NaN, '128270281', '0x7a53fc9', '0x', 'earliest', 'Latest', '', null, undefined, {}];
    for (const t of bad) assert.deepEqual(encodeBlockTag(t as BlockTag), { ok: false, error: 'BLOCK_TAG_INVALID' }, String(t));
  });

  it('is the only block encoder in the chain client', () => {
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const chain = strip(readFileSync(new URL('../src/chain.ts', import.meta.url), 'utf8'));
    assert.doesNotMatch(chain, /toString\(16\)|hexQ/);
    assert.equal(chain.match(/encodeBlockTag\(/g)?.length, 3);
  });
});

describe('pinned reads over JSON-RPC', () => {
  it('serializes an explicit-block eth_call, eth_getCode and eth_getBlockByNumber as hex quantities, never decimal', async () => {
    const n = await node((q) => (q.method === 'eth_chainId' ? { result: '0xb626' } : q.method === 'eth_getBlockByNumber' ? { result: HEAD } : q.method === 'eth_getCode' ? { result: '0x6080' } : { result: `0x${word(1n)}` }));
    try {
      const c = client(n.url);
      assert.ok((await c.call(GATE, '0xf698da25', LIVE_BLOCK)).ok);
      assert.ok((await c.code(GATE, LIVE_BLOCK)).ok);
      assert.ok((await c.block(LIVE_BLOCK)).ok);
      assert.ok((await c.erc20Balance(MARKET.fundingToken, GATE, LIVE_BLOCK)).ok);
      const byMethod = (m: string) => n.requests.filter((r) => r.method === m);
      assert.deepEqual(byMethod('eth_call').map((r) => r.params[1]), ['0x7a53fc9', '0x7a53fc9']);
      assert.deepEqual(byMethod('eth_getCode')[0]?.params, [GATE, '0x7a53fc9']);
      assert.deepEqual(byMethod('eth_getBlockByNumber')[0]?.params, ['0x7a53fc9', false]);
      for (const r of n.requests) {
        assert.equal(r.body.includes(LIVE_BLOCK.toString()), false, r.body);
        for (const p of r.params) assert.notEqual(typeof p, 'number', r.body);
      }
    } finally {
      await n.close();
    }
  });

  it('sends nothing for an invalid block identifier', async () => {
    const n = await node(gateNode());
    try {
      const c = client(n.url);
      assert.deepEqual(await c.call(GATE, '0x', -1n), { ok: false, revert: 'BLOCK_TAG_INVALID' });
      assert.deepEqual(await c.code(GATE, MAX_BLOCK_NUMBER + 1n), { ok: false, error: 'BLOCK_TAG_INVALID' });
      assert.deepEqual(await c.block(-5n), { ok: false, error: 'BLOCK_TAG_INVALID' });
      assert.deepEqual(n.requests, []);
    } finally {
      await n.close();
    }
  });

  it('classifies a pinned block the node has not reached, and pruned state, as the endpoint’s answer — not a revert', async () => {
    assert.equal(pinnedBlockUnavailable(`RPC_-32000:unsupported block number ${LIVE_BLOCK}`, LIVE_BLOCK), 'AHEAD_OF_NODE');
    // A number that is not the one asked for is not this condition.
    assert.equal(pinnedBlockUnavailable(`RPC_-32000:unsupported block number ${LIVE_BLOCK + 1n}`, LIVE_BLOCK), null);
    assert.equal(pinnedBlockUnavailable('RPC_-32000:historical state 32065818a5b26a6753c5a5a8da33bc9a5fd88f7c11f3717be9e21df13d95515c is not available', LIVE_BLOCK), 'STATE_PRUNED');
    for (const e of ['RPC_-32000:execution reverted', 'RPC_-32602:invalid argument 1: hex string without 0x prefix', 'NETWORK.TimeoutError', `unsupported block number ${LIVE_BLOCK}`]) assert.equal(pinnedBlockUnavailable(e, LIVE_BLOCK), null, e);

    const ahead = await node(gateNode({ ahead: () => true }));
    const pruned = await node(gateNode({ error: { code: -32000, message: `historical state ${'ab'.repeat(32)} is not available` } }));
    try {
      assert.deepEqual(await client(ahead.url).domainSeparator(GATE, LIVE_BLOCK), { ok: false, error: `BLOCK_AHEAD_OF_NODE.RPC_-32000:unsupported block number ${LIVE_BLOCK}` });
      assert.deepEqual(await client(ahead.url).code(GATE, LIVE_BLOCK), { ok: false, error: `BLOCK_AHEAD_OF_NODE.RPC_-32000:unsupported block number ${LIVE_BLOCK}` });
      assert.deepEqual(await client(pruned.url).domainSeparator(GATE, LIVE_BLOCK), { ok: false, error: `HISTORICAL_STATE_UNAVAILABLE.RPC_-32000:historical state ${'ab'.repeat(32)} is not available` });
    } finally {
      await ahead.close();
      await pruned.close();
    }
  });
});

describe('readGateMarkets: one block, waited for boundedly', () => {
  const policy = createGateSpotPolicy(policyConfig());
  const noPause = async () => {};
  const callBlocks = (n: Node) => n.requests.filter((r) => r.method === 'eth_call').map((r) => r.params[1]);

  it('re-reads the whole snapshot at the same pinned block while the serving node catches up', async () => {
    let lagging = 2;
    const n = await node(gateNode({ ahead: () => lagging-- > 0 }));
    try {
      const pauses: number[] = [];
      const r = await readGateMarkets(client(n.url), policy, { pause: async (ms) => void pauses.push(ms) });
      assert.equal(r.status, 'OK');
      assert.equal(r.status === 'OK' && r.block.number, BigInt(HEAD.number));
      assert.equal(pauses.length, 2);
      // `latest` is read once; every market read, first and re-read, is at that one block.
      assert.equal(n.requests.filter((q) => q.method === 'eth_getBlockByNumber').length, 1);
      assert.deepEqual(new Set(callBlocks(n)), new Set([HEAD.number]));
      assert.equal(callBlocks(n).includes('latest'), false);
    } finally {
      await n.close();
    }
  });

  it('fails closed after the bound, with the endpoint’s exact answer', async () => {
    const n = await node(gateNode({ ahead: () => true }));
    try {
      const r = await readGateMarkets(client(n.url), policy, { pause: noPause });
      assert.deepEqual(r, { status: 'UNKNOWN', reason: `MARKET.BLOCK_AHEAD_OF_NODE.RPC_-32000:unsupported block number ${BigInt(HEAD.number)}` });
      assert.equal(callBlocks(n).length, 1 + PINNED_REREADS);
      assert.deepEqual(new Set(callBlocks(n)), new Set([HEAD.number]));
    } finally {
      await n.close();
    }
  });

  it('does not wait on any other failure: pruned state, a revert or an unlisted market stand at once', async () => {
    for (const error of [{ code: -32000, message: `historical state ${'ab'.repeat(32)} is not available` }, { code: -32000, message: 'execution reverted' }]) {
      const n = await node(gateNode({ error }));
      try {
        const r = await readGateMarkets(client(n.url), policy, { pause: () => assert.fail('no wait') });
        assert.equal(r.status, 'UNKNOWN');
        assert.match(r.status === 'UNKNOWN' ? r.reason : '', /^MARKET\.(HISTORICAL_STATE_UNAVAILABLE|CALL_REVERTED)\./);
        assert.equal(callBlocks(n).length, 1);
      } finally {
        await n.close();
      }
    }
  });
});
