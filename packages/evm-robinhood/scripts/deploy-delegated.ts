#!/usr/bin/env node
/**
 * C2.3 V3 delegated Gate deployment scaffolding.
 *
 * Refuses mainnet. Requires chain 46630. Never runs under `npm run check`.
 * Agent broadcasts: none — this script prints the plan and exits unless the
 * human later authorizes a real deploy outside this milestone's agent work.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CONFIG = `${ROOT}/contracts/deploy/robinhood-testnet-delegated.json`;
const dryRun = process.argv.includes('--dry-run') || !process.argv.includes('--send');

const cfg = JSON.parse(readFileSync(CONFIG, 'utf8')) as { chainId: number; label: string; gateKind: string };

if (cfg.chainId !== 46_630) {
  console.error('REFUSED: V3 deploy config must name chain 46630');
  process.exit(2);
}
if (cfg.gateKind !== 'MandateDelegatedExecutionGate') {
  console.error('REFUSED: unexpected gate kind');
  process.exit(2);
}

console.log('C2.3 MandateDelegatedExecutionGate deployment plan');
console.log(`  config: ${CONFIG}`);
console.log(`  label: ${cfg.label}`);
console.log(`  chainId: ${cfg.chainId}`);
console.log(`  mode: ${dryRun ? 'DRY_RUN (no broadcast)' : 'SEND'}`);
console.log('  refuses: every known mainnet');
console.log('  does not overwrite: contracts/deploy/robinhood-testnet.json (V2)');

if (dryRun) {
  console.log('DRY_RUN complete. No transaction was broadcast.');
  process.exit(0);
}

console.error('SEND mode is intentionally unimplemented in the agent milestone.');
console.error('The repository owner runs the Foundry deploy manually after review.');
process.exit(2);
