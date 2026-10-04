#!/usr/bin/env node
/**
 * Canonical operator command for C2.3 MandateDelegatedExecutionGate on
 * Robinhood Chain TESTNET (46630).
 *
 *   npm run robinhood:v3:testnet:deploy -- --dry-run
 *     → validate config, query eth_chainId, forge script simulation, NO broadcast
 *
 *   npm run robinhood:v3:testnet:deploy -- --send --confirm-testnet-46630
 *     → same guards, then forge script --broadcast --interactive
 *
 * Never run under `npm run check`. Never accepts a raw private key CLI arg.
 * Never overwrites contracts/deploy/robinhood-testnet.json (frozen V2).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CONFIRM_TESTNET_FLAG,
  FIXTURE,
  FORGE_SCRIPT,
  REPO,
  ROBINHOOD_TESTNET_CHAIN_ID,
  V2_MANIFEST_PATH,
  V3_CONFIG_PATH,
  V3_LIVE_MANIFEST_PATH,
  forgeArgsIncludeBroadcast,
  forgeScriptArgs,
  loadDelegatedConfig,
  parseChainIdHex,
  parseGateAddressFromForgeOutput,
  resolveDeployMode,
  resolveRpcUrl,
} from './delegated-deploy-lib.ts';

const log = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

async function ethChainId(rpcUrl: string): Promise<{ ok: true; chainId: number } | { ok: false; reason: string }> {
  let res: Response;
  try {
    res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return { ok: false, reason: `REFUSED: eth_chainId network error (${e instanceof Error ? e.name : 'Error'})` };
  }
  if (!res.ok) return { ok: false, reason: `REFUSED: eth_chainId HTTP_${res.status}` };
  let body: { result?: string; error?: { message?: string } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, reason: 'REFUSED: eth_chainId response not JSON' };
  }
  if (typeof body.result !== 'string') {
    return { ok: false, reason: `REFUSED: eth_chainId failed (${body.error?.message ?? 'no result'})` };
  }
  const parsed = parseChainIdHex(body.result);
  if (!parsed.ok) return parsed;
  return { ok: true, chainId: parsed.chainId as number };
}

function v2ManifestFingerprint(): string {
  if (!existsSync(V2_MANIFEST_PATH)) return 'MISSING';
  return `present bytes=${readFileSync(V2_MANIFEST_PATH).byteLength}`;
}

function writeLiveManifest(o: {
  readonly gate: string | null;
  readonly txHash: string | null;
  readonly blockNumber: string | null;
  readonly chainId: number;
  readonly runtimeCodeHash: string | null;
  readonly mode: 'SEND';
}): void {
  const body = {
    label: 'ROBINHOOD CHAIN TESTNET (46630) — live MandateDelegatedExecutionGate deployment evidence. Separate from frozen V2 robinhood-testnet.json. Valueless fixture.',
    chainId: o.chainId,
    gateKind: 'MandateDelegatedExecutionGate',
    gate: o.gate,
    deploymentTx: o.txHash,
    blockNumber: o.blockNumber,
    runtimeCodeHash: o.runtimeCodeHash,
    fixture: FIXTURE,
    writtenAt: new Date().toISOString(),
    note: 'Written only after an explicit human --send --confirm-testnet-46630 broadcast. Never overwrite V2.',
  };
  writeFileSync(V3_LIVE_MANIFEST_PATH, `${JSON.stringify(body, null, 2)}\n`);
  log(`V3 live manifest written: ${V3_LIVE_MANIFEST_PATH}`);
}

function readBroadcastLatest(): { txHash: string | null; gate: string | null; blockNumber: string | null } {
  const path = join(REPO, 'broadcast', 'DeployDelegatedV3.s.sol', String(ROBINHOOD_TESTNET_CHAIN_ID), 'run-latest.json');
  if (!existsSync(path)) return { txHash: null, gate: null, blockNumber: null };
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as {
      transactions?: readonly { hash?: string; contractAddress?: string; transactionType?: string }[];
      receipts?: readonly { transactionHash?: string; contractAddress?: string; blockNumber?: string | number }[];
    };
    const createTx = (j.transactions ?? []).find((t) => t.transactionType === 'CREATE' || t.contractAddress);
    const receipt = (j.receipts ?? [])[0];
    const gate = (createTx?.contractAddress ?? receipt?.contractAddress ?? null)?.toLowerCase() ?? null;
    const txHash = (createTx?.hash ?? receipt?.transactionHash ?? null)?.toLowerCase() ?? null;
    const blockNumber = receipt?.blockNumber === undefined || receipt.blockNumber === null ? null : String(receipt.blockNumber);
    return { txHash, gate, blockNumber };
  } catch {
    return { txHash: null, gate: null, blockNumber: null };
  }
}

async function main(): Promise<void> {
  const mode = resolveDeployMode(process.argv.slice(2));
  if (mode.kind === 'REFUSED') {
    err(mode.reason);
    process.exit(mode.exitCode);
  }

  const cfg = loadDelegatedConfig();
  if (!cfg.ok) {
    err(cfg.reason);
    process.exit(2);
  }

  const rpc = resolveRpcUrl();
  if (!rpc.ok) {
    err(rpc.reason);
    process.exit(2);
  }

  const v2Before = v2ManifestFingerprint();

  log('C2.3 MandateDelegatedExecutionGate deployment');
  log(`  script: ${FORGE_SCRIPT}`);
  log(`  config: ${V3_CONFIG_PATH}`);
  log(`  label: ${cfg.config.label}`);
  log(`  chainId (config): ${cfg.config.chainId}`);
  log(`  RPC: ${rpc.label}`);
  log(`  mode: ${mode.kind === 'DRY_RUN' ? 'DRY_RUN' : 'SEND'}`);
  log('  refuses: every known mainnet; unknown chain IDs');
  log(`  does not overwrite: ${V2_MANIFEST_PATH} (V2)`);
  log(`  V3 live manifest (SEND only): ${V3_LIVE_MANIFEST_PATH}`);
  log('  market: 1 FIXTURE — MDEMO / MDUSD @ 10 MDUSD per MDEMO, fee 0');
  log(`  MDEMO: ${FIXTURE.representation}`);
  log(`  MDUSD: ${FIXTURE.fundingToken}`);
  log('  allowance: NOT performed by this tool (principal setup tx separately)');
  log('  signer: Foundry --interactive (SEND); no PRIVATE_KEY in script');

  if (mode.kind === 'DRY_RUN') {
    log('DRY_RUN');
    log('NO BROADCAST');
  } else {
    log(`SEND confirmed via ${CONFIRM_TESTNET_FLAG}`);
  }

  const chain = await ethChainId(rpc.url);
  if (!chain.ok) {
    err(chain.reason);
    process.exit(2);
  }
  log(`  eth_chainId: ${chain.chainId} (accepted)`);

  const forgeArgs = forgeScriptArgs(mode.kind, rpc.url);
  if (mode.kind === 'DRY_RUN' && forgeArgsIncludeBroadcast(forgeArgs)) {
    err('REFUSED: internal error — dry-run forge args must not include --broadcast');
    process.exit(2);
  }
  if (mode.kind === 'SEND' && !forgeArgsIncludeBroadcast(forgeArgs)) {
    err('REFUSED: internal error — send forge args must include --broadcast');
    process.exit(2);
  }

  // Never log the RPC URL (may carry a QuickNode credential).
  log(`  invoking: forge ${forgeArgs.filter((a) => a !== rpc.url).join(' ')} <rpc>`);
  let out: string;
  try {
    out = execFileSync('forge', forgeArgs as string[], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
      env: process.env,
    });
  } catch (e) {
    const ex = e as { stdout?: string; stderr?: string; message?: string };
    if (ex.stdout) process.stdout.write(ex.stdout);
    if (ex.stderr) process.stderr.write(ex.stderr);
    err(`forge script failed: ${ex.message ?? 'error'}`);
    process.exit(1);
  }
  process.stdout.write(out);

  const gateFromOut = parseGateAddressFromForgeOutput(out);
  if (mode.kind === 'DRY_RUN') {
    log('---');
    log('DRY_RUN complete');
    log('NO BROADCAST');
    if (gateFromOut !== null) log(`  simulated MandateDelegatedExecutionGate: ${gateFromOut}`);
    log(`  V2 manifest unchanged check: ${v2Before} → ${v2ManifestFingerprint()}`);
    if (v2Before !== v2ManifestFingerprint()) {
      err('REFUSED: V2 manifest fingerprint changed during dry-run');
      process.exit(2);
    }
    log('Next (human only):');
    log(`  npm run robinhood:v3:testnet:deploy -- --send ${CONFIRM_TESTNET_FLAG}`);
    return;
  }

  // SEND path — only reached after --send + --confirm-testnet-46630 + chain 46630.
  const broadcast = readBroadcastLatest();
  const gate = broadcast.gate ?? gateFromOut;
  writeLiveManifest({
    gate,
    txHash: broadcast.txHash,
    blockNumber: broadcast.blockNumber,
    chainId: ROBINHOOD_TESTNET_CHAIN_ID,
    runtimeCodeHash: null,
    mode: 'SEND',
  });
  log('---');
  log('SEND complete (human-authorized broadcast)');
  log(`  chainId: ${ROBINHOOD_TESTNET_CHAIN_ID}`);
  log(`  V3 Gate: ${gate ?? '(capture from forge output / broadcast receipt)'}`);
  log(`  tx: ${broadcast.txHash ?? '(see forge broadcast/)'}`);
  log(`  block: ${broadcast.blockNumber ?? '(see forge broadcast/)'}`);
  log(`  V2 manifest untouched: ${v2ManifestFingerprint() === v2Before ? 'YES' : 'CHECK MANUALLY'}`);
  if (gate !== null) {
    log('Next:');
    log(`  npm run robinhood:v3:testnet:verify -- --gate ${gate}`);
    log('  then principal: one-time bounded MDUSD.approve(V3Gate, amount) — NOT unlimited');
    log('  then: npm run agents:lab');
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: Error) => {
    err(`deploy-delegated failed: ${e.message}`);
    process.exitCode = 1;
  });
}
