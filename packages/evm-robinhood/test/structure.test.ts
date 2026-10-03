/**
 * Structural boundary of @mandate/evm-robinhood.
 *
 * - The domain module, reviewed markets, adapter descriptor, gate artifact and
 *   ABI encoding are pure: no I/O, clock, randomness or environment.
 * - Network access exists only in chain.ts, and only to Robinhood Chain's
 *   public testnet RPC (or a loopback node when explicitly enabled). No
 *   source reads a key file or the environment: keys are handed in by the
 *   operator's script.
 * - The package exports no generic signing operation and none of the internal
 *   issuance stages.
 * - Core, the ledger, the control engine, the SQLite store and the frozen
 *   execution gate do not depend on it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pkg from '../src/index.ts';
import { ChainClient, JsonRpcClient, RpcHostRefused, TESTNET_RPC_HOSTS, isQuickNodeHost } from '../src/index.ts';

const ROOT = new URL('../', import.meta.url);
const REPO = new URL('../../../', import.meta.url);
const SRC = fileURLToPath(new URL('src/', ROOT));
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SOURCES = readdirSync(SRC).filter((f) => f.endsWith('.ts')).map((f) => ({ file: f, text: strip(readFileSync(join(SRC, f), 'utf8')) }));
const PURE = ['vocabulary.ts', 'market.ts', 'policy.ts', 'adapter.ts', 'gate.ts', 'abi.ts', 'transaction.ts', 'custody.ts', 'issuance.ts', 'signer.ts', 'block-tag.ts'];

describe('evm-robinhood structural boundary', () => {
  it('depends only on Core, the kernel, the ledger, control, the SQLite store, the execution gate and the kernel’s pinned noble packages', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as { dependencies?: { [name: string]: string } };
    assert.deepEqual(manifest.dependencies, {
      '@mandate/control': '0.1.0',
      '@mandate/core': '0.1.0',
      '@mandate/execution-gate': '0.1.0',
      '@mandate/kernel': '0.1.0',
      '@mandate/ledger': '0.1.0',
      '@mandate/ledger-sqlite': '0.1.0',
      '@noble/curves': '2.4.0',
      '@noble/hashes': '2.4.0',
    });
  });

  it('keeps the module, the artifact and custody free of I/O, clocks, randomness and environment', () => {
    for (const { file, text } of SOURCES.filter((s) => PURE.includes(s.file))) {
      assert.doesNotMatch(text, /from\s+['"]node:/, file);
      assert.doesNotMatch(text, /\b(?:fetch|Date\.now|Math\.random|setTimeout|setInterval|performance\.now|getRandomValues|randomUUID)\s*\(|new\s+Date\s*\(|process\.env|process\.hrtime/, file);
    }
    const policy = SOURCES.find((s) => s.file === 'policy.ts')?.text ?? '';
    assert.doesNotMatch(policy, /:\s*any\b|<any>|\bas\s+any\b|\bunknown\b|\bparseFloat\b|\bNumber\s*\(|\bMath\./);
  });

  it('confines network access to chain.ts; nothing reads a key file or the environment', () => {
    for (const { file, text } of SOURCES) {
      if (file !== 'chain.ts') assert.doesNotMatch(text, /\bfetch\s*\(|WebSocket|node:https?|node:net/, file);
      assert.doesNotMatch(text, /readFile|node:fs|createReadStream|process\.env|node:child_process/, file);
    }
  });

  it('exports no generic signing operation and none of the internal issuance stages', () => {
    for (const name of Object.keys(pkg)) assert.doesNotMatch(name, /^sign|signBytes|signHash|privateKey|rawKey|^issue$|^construct$|^guard$|resolveIntent|^admit$|^submit$|readEvidence|signAdmitted|checkSlot/i, name);
    const custody = SOURCES.find((s) => s.file === 'custody.ts')?.text ?? '';
    // Custody's interface: whose key it is, and one typed signature over an admitted artifact.
    assert.match(custody, /interface GateKeyCustody \{\s*principal\(\): Address;\s*signMandate\([^)]*\): CustodyResult<string>;\s*\}/);
  });

  it('contacts Robinhood Chain testnet only, and refuses to act on any mainnet', async () => {
    assert.deepEqual(TESTNET_RPC_HOSTS, ['rpc.testnet.chain.robinhood.com']);
    for (const url of ['https://rpc.mainnet.chain.robinhood.com', 'https://rpc.robinhoodchain.com', 'http://rpc.testnet.chain.robinhood.com', 'https://evil.example/rpc.testnet.chain.robinhood.com', 'https://robinhood-testnet.g.alchemy.com/v2/x', 'http://127.0.0.1:8545']) {
      assert.throws(() => new JsonRpcClient(url), RpcHostRefused, url);
    }
    assert.doesNotThrow(() => new JsonRpcClient('https://rpc.testnet.chain.robinhood.com'));
    assert.doesNotThrow(() => new JsonRpcClient('http://127.0.0.1:8545', { allowLoopback: true }));
    for (const id of [1n, 42_161n, 42_170n, 4_663n]) assert.throws(() => new ChainClient(new JsonRpcClient('https://rpc.testnet.chain.robinhood.com'), id), RpcHostRefused);
  });

  it('accepts an operator QuickNode endpoint only when asked, only over https, and never reports its credential', () => {
    const qn = 'https://example-name.robinhood-testnet.quiknode.pro/0123456789abcdef0123456789abcdef/';
    assert.throws(() => new JsonRpcClient(qn), RpcHostRefused);
    const client = new JsonRpcClient(qn, { operatorEndpoint: 'QUICKNODE' });
    assert.equal(client.endpoint, 'QUICKNODE');
    assert.equal(JSON.stringify(client).includes('0123456789abcdef'), false);
    assert.equal(Object.values(client).some((v) => String(v).includes('0123456789abcdef')), false);
    for (const bad of ['http://x.quiknode.pro/t/', 'https://quiknode.pro/t/', 'https://x.quiknode.pro.evil.example/t/', 'https://user:pw@x.quiknode.pro/t/', 'https://x.quiknode.pro/t/?k=1', 'https://x.quiknode.pro:8443/t/', 'https://evil.example/x.quiknode.pro/']) {
      assert.throws(() => new JsonRpcClient(bad, { operatorEndpoint: 'QUICKNODE' }), (e: unknown) => e instanceof RpcHostRefused && !e.message.includes('/t/'), bad);
    }
    assert.equal(isQuickNodeHost('a.b.quiknode.pro'), true);
    assert.equal(isQuickNodeHost('quiknode.pro'), false);
    assert.equal(new JsonRpcClient('https://rpc.testnet.chain.robinhood.com').endpoint, 'ROBINHOOD_PUBLIC_TESTNET');
  });

  it('nothing below it depends on it: kernel, Core, the ledger, control, the store and the frozen gate stay venue-independent', () => {
    for (const p of ['kernel', 'core', 'ledger', 'control', 'ledger-sqlite', 'execution-gate']) {
      assert.doesNotMatch(readFileSync(new URL(`packages/${p}/package.json`, REPO), 'utf8'), /@mandate\/evm-robinhood/, p);
      for (const f of readdirSync(fileURLToPath(new URL(`packages/${p}/src/`, REPO)))) {
        if (f.endsWith('.ts')) assert.doesNotMatch(readFileSync(new URL(`packages/${p}/src/${f}`, REPO), 'utf8'), /evm-robinhood/, `${p}/${f}`);
      }
    }
  });
});
