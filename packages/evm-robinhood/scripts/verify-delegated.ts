#!/usr/bin/env node
/**
 * Post-deploy verification for a live MandateDelegatedExecutionGate on
 * Robinhood Chain testnet (46630).
 *
 *   npm run robinhood:v3:testnet:verify -- --gate 0x...
 *
 * Read-only. Never broadcasts. Never approves MDUSD. Never overwrites V2.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ChainClient, JsonRpcClient, ROBINHOOD_TESTNET_CHAIN_ID, representationIdOf } from '../src/index.ts';
import { calldata, hexBytes, toHex } from '../src/abi.ts';
import {
  FIXTURE,
  FORGE_SCRIPT,
  REPO,
  V2_MANIFEST_PATH,
  assertAllowedChainId,
  parseChainIdHex,
  resolveRpcUrl,
} from './delegated-deploy-lib.ts';

const log = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

function parseGateArg(argv: readonly string[]): string | null {
  const i = argv.indexOf('--gate');
  if (i < 0) return null;
  const v = argv[i + 1];
  if (v === undefined || !/^0x[0-9a-fA-F]{40}$/.test(v)) return null;
  return v.toLowerCase();
}

async function main(): Promise<void> {
  const gate = parseGateArg(process.argv.slice(2));
  if (gate === null) {
    err('REFUSED: require --gate 0x… (40 hex chars)');
    process.exit(2);
  }

  const rpc = resolveRpcUrl();
  if (!rpc.ok) {
    err(rpc.reason);
    process.exit(2);
  }

  log('C2.3 MandateDelegatedExecutionGate verification');
  log(`  gate: ${gate}`);
  log(`  RPC: ${rpc.label}`);
  log(`  does not overwrite: ${V2_MANIFEST_PATH}`);

  const client = new JsonRpcClient(rpc.url, rpc.isQuickNode ? { operatorEndpoint: 'QUICKNODE' } : {});
  const chain = new ChainClient(client, ROBINHOOD_TESTNET_CHAIN_ID);
  const ensured = await chain.ensureChain();
  if (!ensured.ok) {
    err(`REFUSED: ${ensured.error}`);
    process.exit(2);
  }

  const id = await client.request<string>('eth_chainId', []);
  if (!id.ok) {
    err(`REFUSED: eth_chainId ${id.error}`);
    process.exit(2);
  }
  const parsed = parseChainIdHex(id.value);
  if (!parsed.ok) {
    err(parsed.reason);
    process.exit(2);
  }
  const chainOk = assertAllowedChainId(parsed.chainId as number);
  if (!chainOk.ok) {
    err(chainOk.reason);
    process.exit(2);
  }
  log(`  [PASS] chainId == ${ROBINHOOD_TESTNET_CHAIN_ID}`);

  const code = await chain.code(gate);
  if (!code.ok || code.value === '0x') {
    err('REFUSED: no contract code at gate');
    process.exit(2);
  }
  const runtimeCodeHash = toHex(keccak_256(hexBytes(code.value.toLowerCase())));
  log(`  [PASS] contract code exists (runtimeCodeHash ${runtimeCodeHash})`);

  const chainIdCall = await chain.call(gate, calldata('CHAIN_ID()', [], []));
  if (!chainIdCall.ok) {
    err(`REFUSED: CHAIN_ID() failed: ${chainIdCall.revert}`);
    process.exit(2);
  }
  const onchainChainId = Number(BigInt(chainIdCall.returnData));
  if (onchainChainId !== Number(ROBINHOOD_TESTNET_CHAIN_ID)) {
    err(`REFUSED: CHAIN_ID() returned ${onchainChainId}`);
    process.exit(2);
  }
  log(`  [PASS] CHAIN_ID() == ${ROBINHOOD_TESTNET_CHAIN_ID}`);

  const domain = await chain.domainSeparator(gate);
  if (!domain.ok || domain.value === '0x0000000000000000000000000000000000000000000000000000000000000000') {
    err('REFUSED: domainSeparator() missing or zero');
    process.exit(2);
  }
  log(`  [PASS] domainSeparator() nonzero (${domain.value})`);

  const block = await chain.block('latest');
  if (!block.ok) {
    err(`REFUSED: latest block unreadable: ${block.error}`);
    process.exit(2);
  }
  const snap = await chain.gateMarket(gate, representationIdOf(ROBINHOOD_TESTNET_CHAIN_ID, FIXTURE.representation), block.value.number);
  if (!snap.ok) {
    err(`REFUSED: marketOf fixture failed: ${snap.error}`);
    process.exit(2);
  }
  const m = snap.value;
  if (m.representation.toLowerCase() !== FIXTURE.representation) {
    err(`REFUSED: representation ${m.representation} != MDEMO`);
    process.exit(2);
  }
  log(`  [PASS] fixture representation == MDEMO (${FIXTURE.representation})`);
  if (m.fundingToken.toLowerCase() !== FIXTURE.fundingToken) {
    err(`REFUSED: fundingToken ${m.fundingToken} != MDUSD`);
    process.exit(2);
  }
  log(`  [PASS] funding token == MDUSD (${FIXTURE.fundingToken})`);
  if (m.classification !== 1) {
    err(`REFUSED: classification ${m.classification} != MARKET_FIXTURE(1)`);
    process.exit(2);
  }
  log('  [PASS] classification == MARKET_FIXTURE (1)');
  if (m.fixturePriceDecimals !== 6 || m.fixturePriceAtoms !== 10_000_000n) {
    err(`REFUSED: fixture price ${m.fixturePriceAtoms}@${m.fixturePriceDecimals} != 10000000@6`);
    process.exit(2);
  }
  log('  [PASS] fixture price == 10_000_000 atoms @ 6 decimals (10 MDUSD / MDEMO)');
  if (m.synthetic) {
    err('REFUSED: synthetic flag unexpected');
    process.exit(2);
  }
  log('  [PASS] synthetic == false');
  log(`  [INFO] canonicalAssetHash (constructor-pinned; string fields not readable onchain): ${m.canonicalAssetHash}`);
  log(`  [INFO] issuerHash: ${m.issuerHash}`);
  log(`  [INFO] venueHash: ${m.venueHash}`);
  log(`  [INFO] adapter: ${m.adapter}`);
  log(`  [INFO] venue: ${m.venue}`);
  log(`  [INFO] feeBps: ${m.feeBps}`);

  log('  running Solidity DeployDelegatedV3.verify(gate)…');
  try {
    execFileSync(
      'forge',
      ['script', FORGE_SCRIPT, '--sig', 'verify(address)', gate, '--rpc-url', rpc.url],
      { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
    );
    log('  [PASS] DeployDelegatedV3.verify(gate)');
  } catch (e) {
    const ex = e as { stderr?: string; stdout?: string };
    err(ex.stdout ?? '');
    err(ex.stderr ?? '');
    err('REFUSED: DeployDelegatedV3.verify(gate) failed');
    process.exit(2);
  }

  log('---');
  log('VERIFICATION PASS');
  log(`  gate: ${gate}`);
  log(`  chainId: ${ROBINHOOD_TESTNET_CHAIN_ID}`);
  log(`  domainSeparator: ${domain.value}`);
  log(`  runtimeCodeHash: ${runtimeCodeHash}`);
  log('Next (human, separate setup tx — NOT performed by this tool):');
  log('  principal performs one-time bounded MDUSD.approve(V3Gate, amount)');
  log('  Do NOT use unlimited allowance.');
  log('  then: npm run agents:lab');
  log('  then: fresh V3 browser session');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: Error) => {
    err(`verify-delegated failed: ${e.message}`);
    process.exitCode = 1;
  });
}
