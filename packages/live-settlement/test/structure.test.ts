/**
 * Structural boundary of @mandate/live-settlement and of what may reach it.
 *
 * - Only this package has RPC or signing capability in the Live AI Lab, and
 *   inside it: the RPC client and the gas payer's key live in rpc.ts; the
 *   7E.3 principal and agent keys are handed to custody in domain-leg.ts.
 * - Nothing depends on it: not the Live AI package (so no model provider,
 *   Room, policy-stress agent or local API can reach a signer or an RPC),
 *   not the browser app, not the frozen protocol, not the judge demo.
 * - The default Live AI commands never run it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pkg from '../src/index.ts';

const ROOT = new URL('../', import.meta.url);
const REPO = new URL('../../../', import.meta.url);
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
function sources(base: string): readonly { readonly file: string; readonly text: string }[] {
  return readdirSync(base, { recursive: true })
    .map(String)
    .filter((f) => /\.(ts|tsx|mjs)$/.test(f))
    .map((f) => ({ file: f.split('\\').join('/'), text: strip(readFileSync(join(base, f), 'utf8')) }));
}
const SRC = sources(fileURLToPath(new URL('src/', ROOT)));
const SCRIPTS = sources(fileURLToPath(new URL('scripts/', ROOT)));
const only = (pattern: RegExp, allowed: readonly string[], set = SRC) => {
  for (const { file, text } of set) if (!allowed.includes(file)) assert.doesNotMatch(text, pattern, file);
};
const DEPS = ['@mandate/control', '@mandate/core', '@mandate/evm-robinhood', '@mandate/execution-gate', '@mandate/kernel', '@mandate/ledger', '@mandate/ledger-sqlite', '@mandate/live-agents', '@mandate/portfolio'];

describe('live-settlement structural boundary', () => {
  it('depends only on the packages it uses', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as { dependencies?: { [name: string]: string } };
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}), DEPS);
    for (const { file, text } of SRC) for (const m of text.matchAll(/from\s+'(@[^/']+\/[^/']+)/g)) assert.ok(DEPS.includes(m[1] as string), `${file}: ${m[1]}`);
    // The source has no model in it. The runner selects the Live AI provider exactly as agents:live does.
    for (const { file, text } of SRC) assert.doesNotMatch(text, /openai|anthropic|typesafe|@mandate\/jev|judge-demo/i, file);
    for (const { file, text } of SCRIPTS) assert.doesNotMatch(text, /anthropic|typesafe|@mandate\/jev|judge-demo|api\.openai\.com|OPENAI_API_KEY\s*=/i, file);
  });

  it('holds the RPC client and the gas payer’s key in rpc.ts, and the principal and agent keys only on their way to custody in domain-leg.ts', () => {
    only(/\b(ChainClient|JsonRpcClient|TxSender|readGateMarkets)\b/, ['rpc.ts']);
    only(/\b(LocalGateCustody|LocalAgentSigner|keyAddress|GateSigner)\b/, ['domain-leg.ts']);
    only(/secp256k1|signTransaction|signPrehash|demoKey/, ['rpc.ts']);
    only(/\bfetch\s*\(|WebSocket|node:https?|node:net/, []);
    only(/\bfetch\s*\(|WebSocket|node:https?|node:net/, [], SCRIPTS);
  });

  it('reads no environment, file, clock or randomness in its source; scripts read files but no environment and start no process', () => {
    only(/process\.env|node:fs|node:child_process|Date\.now|new Date\s*\(|performance\.now|setTimeout|setInterval|Math\.random|randomBytes/, []);
    only(/process\.env|\bspawn(Sync)?\s*\(|\bexec(File)?(Sync)?\s*\(/, [], SCRIPTS);
  });

  it('exports no key and no generic signing or sending function', () => {
    for (const name of Object.keys(pkg)) assert.doesNotMatch(name, /key|secret|private|sign(?!ificant)|sendRaw|broadcast/i, name);
    const rpc = SRC.find((s) => s.file === 'rpc.ts')?.text ?? '';
    // The client's only write is execute on the gate it was built for.
    assert.doesNotMatch(rpc, /^\s+(call|prepare|send)\s*\(/m);
    assert.match(rpc, /TARGET_NOT_THE_GATE/);
  });

  it('the Live AI package — model providers, Room, policy-stress agent, local API — cannot reach a signer, an RPC or this package', () => {
    const live = sources(fileURLToPath(new URL('packages/live-agents/', REPO))).filter((s) => s.file.startsWith('src/') || s.file.startsWith('scripts/'));
    for (const { file, text } of live) assert.doesNotMatch(text, /@mandate\/(live-settlement|evm-robinhood|execution-gate)|live-settlement\/|ChainClient|JsonRpcClient|TxSender|eth_sendRawTransaction|IssuanceJournal|LocalGateCustody/, `live-agents/${file}`);
    // B.5.3: live-agents keeps its durable session and portfolio ledger in the reference SQLite store — one module, no chain.
    for (const { file, text } of live) if (file !== 'src/persistence/session-store.ts') assert.doesNotMatch(text, /@mandate\/ledger-sqlite/, `live-agents/${file}`);
    assert.doesNotMatch(readFileSync(new URL('packages/live-agents/package.json', REPO), 'utf8'), /live-settlement|evm-robinhood/);
    for (const f of ['src/runtime/openai-provider.ts', 'src/room/coordinator.ts', 'src/policy-stress/runner.ts', 'src/server/app.ts']) assert.ok(live.some((s) => s.file === f), f);
  });

  it('nothing depends on it: not the protocol, the portfolio layer, the judge demo, the Live AI package or the browser app', () => {
    for (const p of ['kernel', 'core', 'registry', 'ledger', 'control', 'ledger-sqlite', 'execution-gate', 'evm-robinhood', 'perp-lighter', 'portfolio', 'judge-demo', 'live-agents', 'router', 'jev', 'adapter-robinhood']) {
      assert.doesNotMatch(readFileSync(new URL(`packages/${p}/package.json`, REPO), 'utf8'), /@mandate\/live-settlement/, p);
      for (const { file, text } of sources(fileURLToPath(new URL(`packages/${p}/src/`, REPO)))) assert.doesNotMatch(text, /live-settlement/, `${p}/${file}`);
    }
    const web = fileURLToPath(new URL('apps/web/', REPO));
    for (const d of ['app', 'components', 'lib']) for (const { file, text } of sources(join(web, d))) assert.doesNotMatch(text, /live-settlement|evm-robinhood|ledger-sqlite|eth_sendRawTransaction|privateKey/, `web/${d}/${file}`);
  });

  it('the default Live AI commands never settle; the testnet commands are separate and explicit', () => {
    const scripts = (JSON.parse(readFileSync(new URL('package.json', REPO), 'utf8')) as { scripts: { [k: string]: string } }).scripts;
    for (const name of ['agents:stub', 'agents:live', 'agents:live:json', 'agents:serve']) assert.doesNotMatch(scripts[name] ?? '', /live-settlement|testnet|dry-run/, name);
    assert.match(scripts['agents:live:testnet:dry-run'] ?? '', /live-settlement\/scripts\/testnet\.ts .*--dry-run$/);
    assert.match(scripts['agents:live:testnet'] ?? '', /live-settlement\/scripts\/testnet\.ts --provider=openai$/);
    // A send needs the operator's phrase on stdin; model-provider choice is a separate control.
    const runner = SCRIPTS.find((s) => s.file === 'testnet.ts')?.text ?? '';
    assert.match(runner, /gate\.authorize\(input\.line\)/);
    assert.match(runner, /A stub decision is never settled/);
  });

  it('declares no any and parses no float', () => {
    for (const { file, text } of [...SRC, ...SCRIPTS]) assert.doesNotMatch(text, /(?<!\?):\s*any\b|<any>|\bas\s+any\b|\bparseFloat\b/, file);
  });
});
