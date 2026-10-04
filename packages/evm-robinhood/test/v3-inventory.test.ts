/** C2.3 V3 fixture inventory tooling guards. No network and no broadcast. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  V3_CANONICAL_REQUIRED_MDEMO_ATOMS,
  V3_FIXTURE_DEPLOYER,
  V3_FIXTURE_INVENTORY_TARGET_MDEMO_ATOMS,
  V3_SEED_CONFIRM_FLAG,
  inventoryReady,
  resolveSeedMode,
  seedCastArgs,
  seedTransferAtoms,
  type V3InventorySnapshot,
} from '../scripts/v3-inventory-lib.ts';

const SNAPSHOT: V3InventorySnapshot = {
  chainId: 46_630n,
  gate: '0x5cf0621ab974d100fd5df225dab046bf35fa7519',
  adapter: '0xa805946d9dede44a5d3c9e7c5427aeed8e0e3037',
  venue: '0xfb6d93beb3e800f44d4253a0805af257ca0e9855',
  mdemo: '0x5d4c3618f996777baf0e0468884bb7a440f189e1',
  mdusd: '0x53b640b9a573e33c541de5a4917bc4d28d956abf',
  mdemoBalance: 0n,
  mdusdBalance: 0n,
  deployerMdemoBalance: 999_000n * 10n ** 18n,
  fixturePriceAtoms: 10_000_000n,
  fixturePriceDecimals: 6,
  feeBps: 0,
};

describe('C2.3 V3 fixture inventory tooling', () => {
  it('uses the canonical 6.4 MDEMO requirement and fixed 64 MDEMO target', () => {
    assert.equal(V3_CANONICAL_REQUIRED_MDEMO_ATOMS, 6_400_000_000_000_000_000n);
    assert.equal(V3_FIXTURE_INVENTORY_TARGET_MDEMO_ATOMS, 10n * V3_CANONICAL_REQUIRED_MDEMO_ATOMS);
    assert.equal(inventoryReady(0n), false);
    assert.equal(inventoryReady(V3_CANONICAL_REQUIRED_MDEMO_ATOMS - 1n), false);
    assert.equal(inventoryReady(V3_CANONICAL_REQUIRED_MDEMO_ATOMS), true);
  });

  it('tops up to the bounded target and never adds beyond it', () => {
    assert.equal(seedTransferAtoms(0n), V3_FIXTURE_INVENTORY_TARGET_MDEMO_ATOMS);
    assert.equal(seedTransferAtoms(V3_CANONICAL_REQUIRED_MDEMO_ATOMS), 57_600_000_000_000_000_000n);
    assert.equal(seedTransferAtoms(V3_FIXTURE_INVENTORY_TARGET_MDEMO_ATOMS), 0n);
    assert.equal(seedTransferAtoms(V3_FIXTURE_INVENTORY_TARGET_MDEMO_ATOMS + 1n), 0n);
  });

  it('is read-only by default and SEND requires the exact confirmation', () => {
    assert.equal(resolveSeedMode([]).kind, 'PLAN');
    assert.equal(resolveSeedMode(['--dry-run']).kind, 'PLAN');
    assert.equal(resolveSeedMode([V3_SEED_CONFIRM_FLAG]).kind, 'PLAN');
    assert.equal(resolveSeedMode(['--send']).kind, 'REFUSED');
    assert.equal(resolveSeedMode(['--send', V3_SEED_CONFIRM_FLAG]).kind, 'SEND');
    assert.equal(resolveSeedMode(['--dry-run', '--send', V3_SEED_CONFIRM_FLAG]).kind, 'REFUSED');
  });

  it('builds only a bounded interactive transfer from the fixture deployer', () => {
    const args = seedCastArgs('https://rpc.testnet.chain.robinhood.com', SNAPSHOT, 64n * 10n ** 18n);
    assert.equal(args[0], 'send');
    assert.ok(args.includes('--interactive'));
    assert.ok(args.includes('--from'));
    assert.ok(args.includes(V3_FIXTURE_DEPLOYER));
    assert.ok(args.includes(SNAPSHOT.venue));
    assert.ok(args.includes('64000000000000000000'));
    assert.ok(!args.includes('--private-key'));
    assert.ok(!args.some((a) => /^0x[0-9a-f]{64}$/.test(a)));
    assert.throws(() => seedCastArgs('https://rpc.testnet.chain.robinhood.com', { ...SNAPSHOT, chainId: 1n }, 1n), /46630/);
    assert.throws(() => seedCastArgs('https://rpc.testnet.chain.robinhood.com', SNAPSHOT, 65n * 10n ** 18n), /bounded/);
    assert.throws(() => seedCastArgs('https://rpc.testnet.chain.robinhood.com', SNAPSHOT, 0n), /bounded/);
  });

  it('keeps inventory separate from principal allowance and leaves V2/Solidity untouched', () => {
    const inventory = readFileSync(fileURLToPath(new URL('../scripts/v3-inventory.ts', import.meta.url)), 'utf8');
    const seed = readFileSync(fileURLToPath(new URL('../scripts/v3-seed-inventory.ts', import.meta.url)), 'utf8');
    assert.doesNotMatch(inventory, /approve\s*\(/);
    assert.doesNotMatch(seed, /approve\s*\(/);
    assert.doesNotMatch(seed, /principal.*transfer|transfer.*principal/i);
    assert.match(seed, /principal funds used: NO/);
    assert.match(seed, /execFileSync\('cast'/);
    assert.doesNotMatch(seed, /PRIVATE_KEY|--private-key/);
    assert.doesNotMatch(seed, /MandateExecutionGate\.sol|MandateDelegatedExecutionGate\.sol/);
  });
});
