/**
 * A READ-ONLY smoke check of the configured Robinhood Chain testnet RPC
 * (QuickNode when ROBINHOOD_TESTNET_RPC_URL is set). Explicit only; never
 * run by `npm test` or `npm run check`.
 *
 *   npm run agents:rpc:smoke [-- --tx 0x<historical B.5.2 transaction hash>]
 *
 * eth_chainId, eth_blockNumber, the gate's code hash against the deployment
 * manifest, and — given a hash — that transaction's receipt. No key is
 * loaded, nothing is signed, nothing is sent. The endpoint URL is never
 * printed: only which provider answered.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { MANIFEST_PATH } from '../../evm-robinhood/scripts/lib.ts';
import { RobinhoodTestnetReader, parseDeployment } from '../src/index.ts';
import { readRpcConfig } from './rpc-config.ts';

const { values } = parseArgs({ options: { tx: { type: 'string' } }, strict: true });
const out = (line: string) => process.stdout.write(`${line}\n`);
const config = readRpcConfig();
if (!config.ok) {
  process.stderr.write(`${config.error}\n`);
  process.exit(1);
}
for (const n of config.notes) out(`note: ${n}`);
const d = parseDeployment(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')));
if (!d.ok) {
  process.stderr.write(`deployment manifest refused: ${d.error}\n`);
  process.exit(1);
}
const reader = new RobinhoodTestnetReader(d.value.gate.address, config.endpoints);
out(`Read-only RPC smoke · ${config.label} · nothing is signed or sent`);
const id = await reader.chainId();
out(`eth_chainId        ${id.ok ? id.value.toString() : `unreadable (${id.error.slice(0, 40)})`} via ${reader.provenance()}${id.ok && id.value !== d.value.chainId ? '  ← NOT the manifest chain: refused' : ''}`);
const block = await reader.latest();
out(`eth_blockNumber    ${block.ok ? block.value.number.toString() : `unreadable (${block.error.slice(0, 40)})`} via ${reader.provenance()}`);
const code = await reader.codehash(d.value.gate.address);
out(`gate code hash     ${code.ok ? (code.value === d.value.gate.runtimeCodeHash ? 'matches the manifest' : 'DIFFERS from the manifest') : `unreadable (${code.error.slice(0, 40)})`} via ${reader.provenance()}`);
if (values.tx !== undefined) {
  if (!/^0x[0-9a-f]{64}$/.test(values.tx)) {
    process.stderr.write('--tx must be a 0x-prefixed 32-byte lowercase hash\n');
    process.exit(1);
  }
  const r = await reader.receiptOnce(values.tx);
  out(`receipt ${values.tx.slice(0, 10)}…  ${r.ok ? (r.value === null ? 'none' : `${r.value.status} in block ${r.value.blockNumber}, gas ${r.value.gasUsed}`) : `unreadable (${r.error.slice(0, 40)})`} via ${reader.provenance()}`);
}
