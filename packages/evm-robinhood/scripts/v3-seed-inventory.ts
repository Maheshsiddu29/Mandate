#!/usr/bin/env node
/**
 * Human-only bounded MDEMO transfer to the existing V3 FixtureVenue.
 * Default is a read-only plan. SEND requires both explicit flags and an
 * interactive private-key prompt controlled by `cast`; no key is persisted.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseVerifyGateArg, resolveRpcUrl } from './delegated-deploy-lib.ts';
import {
  V3_FIXTURE_DEPLOYER,
  V3_FIXTURE_INVENTORY_TARGET_MDEMO_ATOMS,
  V3_SEED_CONFIRM_FLAG,
  readV3Inventory,
  resolveSeedMode,
  seedCastArgs,
  seedTransferAtoms,
} from './v3-inventory-lib.ts';

const log = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

async function main(): Promise<void> {
  const mode = resolveSeedMode(process.argv.slice(2));
  if (mode.kind === 'REFUSED') {
    err(mode.reason);
    process.exit(2);
  }
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
  const transfer = seedTransferAtoms(v.mdemoBalance);
  log('C2.3 V3 fixture inventory seeding (HUMAN OPERATOR ONLY)');
  log(`  mode: ${mode.kind}`);
  log(`  RPC: ${rpc.label}`);
  log(`  chainId: ${v.chainId}`);
  log(`  Gate: ${v.gate}`);
  log(`  FixtureVenueAdapter: ${v.adapter}`);
  log(`  FixtureVenue: ${v.venue}`);
  log(`  token: MDEMO ${v.mdemo}`);
  log(`  source: original disposable fixture deployer ${V3_FIXTURE_DEPLOYER}`);
  log(`  current: ${v.mdemoBalance} atoms`);
  log(`  fixed target: ${V3_FIXTURE_INVENTORY_TARGET_MDEMO_ATOMS} atoms (64 MDEMO)`);
  log(`  bounded transfer: ${transfer} atoms`);
  log('  principal funds used: NO');
  log('  mint: NO (MandateDemoToken has no post-construction mint)');
  if (transfer === 0n) {
    log('FIXTURE_INVENTORY_ALREADY_AT_TARGET');
    log('  broadcasts: 0');
    return;
  }
  if (v.deployerMdemoBalance < transfer) {
    err('REFUSED: original fixture deployer lacks the bounded MDEMO transfer amount');
    process.exit(2);
  }
  if (mode.kind === 'PLAN') {
    log('PLAN ONLY — NO BROADCAST');
    log(`To send, rerun with --send ${V3_SEED_CONFIRM_FLAG}; cast will prompt interactively for the original fixture deployer key.`);
    log('  broadcasts: 0');
    return;
  }

  log(`SEND confirmed via ${V3_SEED_CONFIRM_FLAG}`);
  log('The key prompt is interactive; no private key is accepted on this command line or persisted by this tool.');
  execFileSync('cast', [...seedCastArgs(rpc.url, v, transfer)], { stdio: 'inherit' });
  log('SEND complete. Re-run the read-only inventory command before acceptance.');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: Error) => {
    err(`v3-seed-inventory failed: ${e.message}`);
    process.exitCode = 1;
  });
}
