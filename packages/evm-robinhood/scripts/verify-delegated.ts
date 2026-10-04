#!/usr/bin/env node
/**
 * Post-deploy verification for a live MandateDelegatedExecutionGate on
 * Robinhood Chain testnet (46630).
 *
 *   npm run robinhood:v3:testnet:verify -- --gate 0x...
 *
 * Read-only. Never broadcasts. Never approves MDUSD. Never overwrites V2.
 *
 * All immutable checks run against JSON-RPC `"latest"` state. This path does
 * NOT invoke `forge script`: Foundry forks at a numeric block height, which
 * fails on Robinhood's non-archive load-balanced public RPC. Solidity
 * `DeployDelegatedV3.verify(address)` remains available for archive/local use
 * via `forgeVerifyScriptArgs` (no `--fork-block-number`, no `--broadcast`).
 */

import { pathToFileURL } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ChainClient, JsonRpcClient, ROBINHOOD_TESTNET_CHAIN_ID, representationIdOf } from '../src/index.ts';
import { calldata, hexBytes, toHex } from '../src/abi.ts';
import {
  FIXTURE,
  V2_MANIFEST_PATH,
  assertAllowedChainId,
  assertContractCodePresent,
  parseChainIdHex,
  parseVerifyGateArg,
  resolveRpcUrl,
} from './delegated-deploy-lib.ts';

const log = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);
const ZERO32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

async function main(): Promise<void> {
  const gateArg = parseVerifyGateArg(process.argv.slice(2));
  if (!gateArg.ok) {
    err(gateArg.reason);
    process.exit(2);
  }
  const gate = gateArg.gate;

  const rpc = resolveRpcUrl();
  if (!rpc.ok) {
    err(rpc.reason);
    process.exit(2);
  }

  log('C2.3 MandateDelegatedExecutionGate verification');
  log(`  gate: ${gate}`);
  log(`  RPC: ${rpc.label}`);
  log('  state: latest (immutable deployment checks; no historical fork pin)');
  log('  Solidity script verify: skipped on public RPC (non-archive)');
  log(`  does not overwrite: ${V2_MANIFEST_PATH}`);
  log('  broadcasts: none');

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
  log(`  [PASS] eth_chainId == ${ROBINHOOD_TESTNET_CHAIN_ID}`);

  const code = await chain.code(gate, 'latest');
  if (!code.ok) {
    err(`REFUSED: eth_getCode failed: ${code.error}`);
    process.exit(2);
  }
  const codeOk = assertContractCodePresent(code.value);
  if (!codeOk.ok) {
    err(codeOk.reason);
    process.exit(2);
  }
  const runtimeCodeHash = toHex(keccak_256(hexBytes(code.value.toLowerCase())));
  const runtimeBytes = (code.value.length - 2) / 2;
  log(`  [PASS] eth_getCode(gate, latest) present (${runtimeBytes} bytes, runtimeCodeHash ${runtimeCodeHash})`);

  const chainIdCall = await chain.call(gate, calldata('CHAIN_ID()', [], []), 'latest');
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

  const domain = await chain.domainSeparator(gate, 'latest');
  if (!domain.ok || domain.value === ZERO32) {
    err('REFUSED: domainSeparator() missing or zero');
    process.exit(2);
  }
  log(`  [PASS] domainSeparator() nonzero (${domain.value})`);

  // Immutable market config: read at "latest". Do not pin a numeric block —
  // Robinhood's public RPC is load-balanced / non-archive for historical state.
  const snap = await chain.gateMarket(
    gate,
    representationIdOf(ROBINHOOD_TESTNET_CHAIN_ID, FIXTURE.representation),
    'latest',
  );
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
  if (m.feeBps !== 0) {
    err(`REFUSED: fixture feeBps ${m.feeBps} != 0`);
    process.exit(2);
  }
  log('  [PASS] fixture feeBps == 0');
  if (m.synthetic) {
    err('REFUSED: synthetic flag unexpected');
    process.exit(2);
  }
  log('  [PASS] synthetic == false');
  if (m.venue === '0x0000000000000000000000000000000000000000') {
    err('REFUSED: fixture venue missing');
    process.exit(2);
  }
  log(`  [PASS] fixture venue present (${m.venue})`);
  log(`  [INFO] adapter: ${m.adapter}`);
  log(`  [INFO] canonicalAssetHash (constructor-pinned; string fields not readable onchain): ${m.canonicalAssetHash}`);
  log(`  [INFO] issuerHash: ${m.issuerHash}`);
  log(`  [INFO] venueHash: ${m.venueHash}`);

  log('---');
  log('VERIFICATION PASS');
  log(`  gate: ${gate}`);
  log(`  chainId: ${ROBINHOOD_TESTNET_CHAIN_ID}`);
  log(`  domainSeparator: ${domain.value}`);
  log(`  runtimeBytes: ${runtimeBytes}`);
  log(`  runtimeCodeHash: ${runtimeCodeHash}`);
  log(`  representation: ${m.representation}`);
  log(`  fundingToken: ${m.fundingToken}`);
  log(`  classification: MARKET_FIXTURE (${m.classification})`);
  log(`  fixturePriceAtoms: ${m.fixturePriceAtoms.toString()}`);
  log(`  fixturePriceDecimals: ${m.fixturePriceDecimals}`);
  log(`  feeBps: ${m.feeBps}`);
  log('  transactions: 0');
  log('  broadcasts: 0');
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
