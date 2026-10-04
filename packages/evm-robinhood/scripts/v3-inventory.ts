#!/usr/bin/env node
/** Read-only readiness check for an already-deployed V3 fixture venue. */

import { pathToFileURL } from 'node:url';
import { parseVerifyGateArg, resolveRpcUrl } from './delegated-deploy-lib.ts';
import {
  V3_CANONICAL_REQUIRED_MDEMO_ATOMS,
  V3_FIXTURE_INVENTORY_TARGET_MDEMO_ATOMS,
  inventoryReady,
  readV3Inventory,
} from './v3-inventory-lib.ts';

const log = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

async function main(): Promise<void> {
  const gate = parseVerifyGateArg(process.argv.slice(2));
  if (!gate.ok) {
    err(gate.reason);
    process.exit(2);
  }
  const rpc = resolveRpcUrl();
  if (!rpc.ok) {
    err(rpc.reason);
    process.exit(2);
  }
  const read = await readV3Inventory(rpc.url, gate.gate);
  if (!read.ok) {
    err(read.reason);
    process.exit(2);
  }
  const v = read.value;
  log('C2.3 V3 fixture inventory readiness (READ ONLY)');
  log(`  RPC: ${rpc.label}`);
  log(`  chainId: ${v.chainId}`);
  log(`  Gate: ${v.gate}`);
  log(`  FixtureVenueAdapter: ${v.adapter}`);
  log(`  FixtureVenue: ${v.venue}`);
  log(`  MDEMO: ${v.mdemo}`);
  log(`  MDUSD: ${v.mdusd}`);
  log(`  MDEMO balance: ${v.mdemoBalance} atoms`);
  log(`  MDUSD balance: ${v.mdusdBalance} atoms`);
  log(`  fixture price: ${v.fixturePriceAtoms} @ ${v.fixturePriceDecimals} decimals (10 MDUSD / MDEMO)`);
  log(`  canonical minimum: ${V3_CANONICAL_REQUIRED_MDEMO_ATOMS} atoms (6.4 MDEMO)`);
  log(`  bounded operator target: ${V3_FIXTURE_INVENTORY_TARGET_MDEMO_ATOMS} atoms (64 MDEMO)`);
  log('  transactions: 0');
  log('  broadcasts: 0');
  if (!inventoryReady(v.mdemoBalance)) {
    err('INSUFFICIENT_FIXTURE_INVENTORY');
    process.exitCode = 2;
    return;
  }
  log('FIXTURE_INVENTORY_READY');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: Error) => {
    err(`v3-inventory failed: ${e.message}`);
    process.exitCode = 1;
  });
}
