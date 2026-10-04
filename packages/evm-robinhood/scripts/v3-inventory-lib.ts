/**
 * C2.3 V3 testnet fixture-inventory inspection and human-only seeding helpers.
 *
 * Inventory is operational test-fixture readiness, never principal authority.
 * The only supported seed is a bounded transfer of the already-minted,
 * valueless MDEMO fixture from its original disposable deployer.
 */

import {
  ChainClient,
  JsonRpcClient,
  ROBINHOOD_TESTNET_CHAIN_ID,
  representationIdOf,
  type Address,
} from '../src/index.ts';
import { FIXTURE, assertAllowedChainId, parseChainIdHex } from './delegated-deploy-lib.ts';

export const V3_CANONICAL_REQUIRED_MDEMO_ATOMS = 6_400_000_000_000_000_000n;
export const V3_FIXTURE_INVENTORY_TARGET_MDEMO_ATOMS = 64_000_000_000_000_000_000n;
export const V3_FIXTURE_DEPLOYER = '0x8b7cdd2e3f9d2102eccb018969cfb4589fac0ff2' as Address;
export const V3_SEED_CONFIRM_FLAG = '--confirm-testnet-46630';

export type SeedMode =
  | { readonly kind: 'PLAN' }
  | { readonly kind: 'SEND' }
  | { readonly kind: 'REFUSED'; readonly reason: string };

export interface V3InventorySnapshot {
  readonly chainId: bigint;
  readonly gate: Address;
  readonly adapter: Address;
  readonly venue: Address;
  readonly mdemo: Address;
  readonly mdusd: Address;
  readonly mdemoBalance: bigint;
  readonly mdusdBalance: bigint;
  readonly deployerMdemoBalance: bigint;
  readonly fixturePriceAtoms: bigint;
  readonly fixturePriceDecimals: number;
  readonly feeBps: number;
}

export type InventoryRead =
  | { readonly ok: true; readonly value: V3InventorySnapshot }
  | { readonly ok: false; readonly reason: string };

export function resolveSeedMode(args: readonly string[]): SeedMode {
  const send = args.includes('--send');
  const confirm = args.includes(V3_SEED_CONFIRM_FLAG);
  const dry = args.includes('--dry-run');
  if (send && dry) return { kind: 'REFUSED', reason: 'REFUSED: choose --dry-run or --send, not both' };
  if (!send) return { kind: 'PLAN' };
  if (!confirm) return { kind: 'REFUSED', reason: `REFUSED: --send requires ${V3_SEED_CONFIRM_FLAG}` };
  return { kind: 'SEND' };
}

export function inventoryReady(balance: bigint, required: bigint = V3_CANONICAL_REQUIRED_MDEMO_ATOMS): boolean {
  return balance >= required;
}

/** Top up to the fixed 64 MDEMO target; repeated runs cannot add beyond it. */
export function seedTransferAtoms(current: bigint): bigint {
  if (current >= V3_FIXTURE_INVENTORY_TARGET_MDEMO_ATOMS) return 0n;
  return V3_FIXTURE_INVENTORY_TARGET_MDEMO_ATOMS - current;
}

/** `cast send` arguments. The private key is entered interactively and never appears here. */
export function seedCastArgs(rpcUrl: string, snapshot: V3InventorySnapshot, transferAtoms: bigint): readonly string[] {
  if (snapshot.chainId !== ROBINHOOD_TESTNET_CHAIN_ID) throw new Error('REFUSED: seed chain must be 46630');
  if (transferAtoms <= 0n || transferAtoms > V3_FIXTURE_INVENTORY_TARGET_MDEMO_ATOMS) {
    throw new Error('REFUSED: seed transfer is outside the bounded 64 MDEMO target');
  }
  return [
    'send',
    '--rpc-url', rpcUrl,
    '--chain', ROBINHOOD_TESTNET_CHAIN_ID.toString(),
    '--from', V3_FIXTURE_DEPLOYER,
    '--interactive',
    snapshot.mdemo,
    'transfer(address,uint256)',
    snapshot.venue,
    transferAtoms.toString(),
  ];
}

export async function readV3Inventory(rpcUrl: string, gate: Address): Promise<InventoryRead> {
  const rpc = new JsonRpcClient(rpcUrl, rpcUrl.includes('.quiknode.pro') ? { operatorEndpoint: 'QUICKNODE' } : {});
  const rawChain = await rpc.request<string>('eth_chainId', []);
  if (!rawChain.ok) return { ok: false, reason: `REFUSED: eth_chainId ${rawChain.error}` };
  const parsed = parseChainIdHex(rawChain.value);
  if (!parsed.ok) return parsed;
  const allowed = assertAllowedChainId(parsed.chainId as number);
  if (!allowed.ok) return allowed;

  const chain = new ChainClient(rpc, ROBINHOOD_TESTNET_CHAIN_ID);
  const code = await chain.code(gate, 'latest');
  if (!code.ok || code.value === '0x') return { ok: false, reason: 'REFUSED: V3 Gate has no code' };
  const market = await chain.gateMarket(
    gate,
    representationIdOf(ROBINHOOD_TESTNET_CHAIN_ID, FIXTURE.representation),
    'latest',
  );
  if (!market.ok) return { ok: false, reason: `REFUSED: V3 fixture market unreadable (${market.error})` };
  const m = market.value;
  if (m.representation !== FIXTURE.representation || m.fundingToken !== FIXTURE.fundingToken) {
    return { ok: false, reason: 'REFUSED: V3 Gate fixture is not the committed MDEMO/MDUSD market' };
  }
  if (m.fixturePriceAtoms !== 10_000_000n || m.fixturePriceDecimals !== 6 || m.feeBps !== 0) {
    return { ok: false, reason: 'REFUSED: V3 Gate fixture price or fee differs from the committed fixture' };
  }
  const [mdemo, mdusd, deployer] = await Promise.all([
    chain.erc20Balance(FIXTURE.representation, m.venue, 'latest'),
    chain.erc20Balance(FIXTURE.fundingToken, m.venue, 'latest'),
    chain.erc20Balance(FIXTURE.representation, V3_FIXTURE_DEPLOYER, 'latest'),
  ]);
  if (!mdemo.ok) return { ok: false, reason: `REFUSED: venue MDEMO balance unreadable (${mdemo.error})` };
  if (!mdusd.ok) return { ok: false, reason: `REFUSED: venue MDUSD balance unreadable (${mdusd.error})` };
  if (!deployer.ok) return { ok: false, reason: `REFUSED: fixture deployer MDEMO balance unreadable (${deployer.error})` };
  return {
    ok: true,
    value: {
      chainId: ROBINHOOD_TESTNET_CHAIN_ID,
      gate,
      adapter: m.adapter,
      venue: m.venue,
      mdemo: m.representation,
      mdusd: m.fundingToken,
      mdemoBalance: mdemo.value,
      mdusdBalance: mdusd.value,
      deployerMdemoBalance: deployer.value,
      fixturePriceAtoms: m.fixturePriceAtoms,
      fixturePriceDecimals: m.fixturePriceDecimals,
      feeBps: m.feeBps,
    },
  };
}
