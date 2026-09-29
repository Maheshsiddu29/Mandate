/**
 * Shared operator code for the explicit Robinhood Chain testnet commands
 * (Phase 7E.3). Never run by `npm run check` or `npm test`.
 *
 * - keys come from `.robinhood-testnet/keys.json` (gitignored, 0600), holding
 *   three disposable testnet keys: deployer (also the gas-paying submitter),
 *   principal, agent. Private keys are never printed or written elsewhere.
 * - `--dry-run` runs the same flow against a local anvil **fork** of Robinhood
 *   Chain testnet (chain id 46630, loopback only, nothing broadcast to the
 *   network), with the deployer funded by `anvil_setBalance`.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  ChainClient,
  JsonRpcClient,
  ROBINHOOD_TESTNET_CHAIN_ID,
  TxSender,
  calldata,
  encodeArguments,
  type AbiType,
  type AbiValue,
  type Receipt,
  type ReviewedGate,
} from '../src/index.ts';
import { address, array, bool, hexBytes, string, toHex, tuple, uint } from '../src/abi.ts';

export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const PUBLIC_RPC = 'https://rpc.testnet.chain.robinhood.com';
export const EXPLORER = 'https://explorer.testnet.chain.robinhood.com';
export const KEYS_PATH = join(REPO, '.robinhood-testnet', 'keys.json');
export const MANIFEST_PATH = join(REPO, 'docs', 'phase-7e', 'deployment-manifest.json');
export const CONFIG_PATH = join(REPO, 'contracts', 'deploy', 'robinhood-testnet.json');

export const log = (s: string) => process.stdout.write(`${s}\n`);

export interface Keys {
  readonly deployer: { readonly address: string; readonly privateKey: string };
  readonly principal: { readonly address: string; readonly privateKey: string };
  readonly agent: { readonly address: string; readonly privateKey: string };
}

export function loadKeys(): Keys {
  const mode = statSync(KEYS_PATH).mode & 0o077;
  if (mode !== 0) throw new Error(`${KEYS_PATH} must not be readable by group or others`);
  const raw = JSON.parse(readFileSync(KEYS_PATH, 'utf8')) as { [role: string]: { address: string; private_key?: string; privateKey?: string } };
  const role = (r: string) => {
    const k = raw[r];
    if (k === undefined || typeof k.privateKey !== 'string' || !/^0x[0-9a-f]{64}$/.test(k.privateKey)) throw new Error(`key ${r} missing or malformed`);
    const s = new TxSender(k.privateKey, ROBINHOOD_TESTNET_CHAIN_ID);
    if (s.address !== k.address.toLowerCase()) throw new Error(`key ${r} does not control ${k.address}`);
    return { address: s.address, privateKey: k.privateKey };
  };
  return { deployer: role('deployer'), principal: role('principal'), agent: role('agent') };
}

// --- The network, or a local fork of it -----------------------------------------------------------

export interface Network {
  readonly chain: ChainClient;
  readonly rpcUrl: string;
  readonly dryRun: boolean;
  close(): void;
}

export async function openNetwork(dryRun: boolean, fund: readonly string[] = []): Promise<Network> {
  if (!dryRun) {
    const chain = new ChainClient(new JsonRpcClient(PUBLIC_RPC), ROBINHOOD_TESTNET_CHAIN_ID);
    const ok = await chain.ensureChain();
    if (!ok.ok) throw new Error(`testnet RPC refused: ${ok.error}`);
    return { chain, rpcUrl: PUBLIC_RPC, dryRun, close: () => {} };
  }
  const port = 18_546;
  const anvil: ChildProcess = spawn('anvil', ['--fork-url', PUBLIC_RPC, '--chain-id', '46630', '--port', String(port), '--silent'], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  const rpc = new JsonRpcClient(url, { allowLoopback: true });
  for (let i = 0; i < 60; i += 1) {
    const id = await rpc.request<string>('eth_chainId', []);
    if (id.ok) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  for (const a of fund) await rpc.request('anvil_setBalance', [a, '0x16345785D8A0000']); // 0.1 ETH, fork only
  const chain = new ChainClient(rpc, ROBINHOOD_TESTNET_CHAIN_ID);
  const ok = await chain.ensureChain();
  if (!ok.ok) {
    anvil.kill();
    throw new Error(`fork not ready: ${ok.error}`);
  }
  return { chain, rpcUrl: url, dryRun, close: () => anvil.kill() };
}

export async function mined(chain: ChainClient, sender: TxSender, to: string | null, data: string, label: string, o: { gasLimit?: bigint; value?: bigint } = {}): Promise<{ txHash: string; receipt: Receipt }> {
  const sent = await chain.send(sender, to, data, o);
  if (sent.kind !== 'SENT') throw new Error(`${label}: not sent: ${sent.error}`);
  const r = await chain.receipt(sent.txHash);
  if (!r.ok) throw new Error(`${label}: no receipt for ${sent.txHash}: ${r.error}`);
  log(`  ${label}: ${sent.txHash} ${r.value.status} block ${r.value.blockNumber} gas ${r.value.gasUsed}`);
  return { txHash: sent.txHash, receipt: r.value };
}

// --- Build artifacts --------------------------------------------------------------------------------

export interface Artifact {
  readonly creation: string;
  readonly runtime: string;
  readonly immutables: readonly { readonly start: number; readonly length: number }[];
  readonly compiler: string;
  readonly settings: { readonly optimizer: { readonly enabled: boolean; readonly runs: number }; readonly evmVersion: string; readonly viaIR: boolean; readonly bytecodeHash: string };
}

export function forgeBuild(): void {
  execFileSync('forge', ['build'], { cwd: REPO, stdio: 'ignore' });
}

export function artifact(file: string, contract: string): Artifact {
  const j = JSON.parse(readFileSync(join(REPO, 'contracts', 'out', file, `${contract}.json`), 'utf8')) as {
    bytecode: { object: string };
    deployedBytecode: { object: string; immutableReferences?: { [id: string]: { start: number; length: number }[] } };
    metadata: { compiler: { version: string }; settings: { optimizer: { enabled: boolean; runs: number }; evmVersion: string; viaIR?: boolean; metadata?: { bytecodeHash?: string } } };
  };
  const m = j.metadata;
  return {
    creation: j.bytecode.object.toLowerCase(),
    runtime: j.deployedBytecode.object.toLowerCase(),
    immutables: Object.values(j.deployedBytecode.immutableReferences ?? {}).flat(),
    compiler: m.compiler.version,
    settings: { optimizer: m.settings.optimizer, evmVersion: m.settings.evmVersion, viaIR: m.settings.viaIR === true, bytecodeHash: m.settings.metadata?.bytecodeHash ?? 'ipfs' },
  };
}

export const hashHex = (hex: string) => toHex(keccak_256(hexBytes(hex.toLowerCase())));

/** Whether deployed runtime code is the artifact's runtime code, the constructor-set immutables aside. */
export function runtimeMatches(onchain: string, a: Artifact): boolean {
  const x = hexBytes(onchain.toLowerCase());
  const y = hexBytes(a.runtime);
  if (x.length !== y.length) return false;
  for (const { start, length } of a.immutables) for (let i = start; i < start + length; i += 1) x[i] = y[i] = 0;
  return toHex(x) === toHex(y);
}

// --- Constructor arguments ---------------------------------------------------------------------------

export const MARKET_CONFIG: AbiType = tuple(
  ['representation', address],
  ['fundingToken', address],
  ['canonicalAsset', tuple(['assetClass', string], ['idScheme', string], ['value', string])],
  ['issuer', string],
  ['venue', string],
  ['quantityUnit', string],
  ['settlementUnit', string],
  ['synthetic', bool],
  ['classification', uint(8)],
  ['fixturePrice', tuple(['numeratorUnit', string], ['denominatorUnit', string], ['decimals', uint(8)], ['atoms', uint(256)])],
  ['fixtureFeeBps', uint(16)],
);

export interface DemoMarketConfig {
  readonly representation: string;
  readonly fundingToken: string;
  readonly canonicalAsset: { readonly assetClass: string; readonly idScheme: string; readonly value: string };
  readonly issuer: string;
  readonly venue: string;
  readonly quantityUnit: string;
  readonly settlementUnit: string;
  readonly synthetic: boolean;
  readonly fixturePriceDecimals: number;
  readonly fixturePrice: string;
  readonly fixtureFeeBps: number;
}

export function gateConstructorArgs(markets: readonly DemoMarketConfig[]): string {
  const values: AbiValue[] = markets.map((m) => ({
    representation: m.representation,
    fundingToken: m.fundingToken,
    canonicalAsset: { ...m.canonicalAsset },
    issuer: m.issuer,
    venue: m.venue,
    quantityUnit: m.quantityUnit,
    settlementUnit: m.settlementUnit,
    synthetic: m.synthetic,
    classification: 1n,
    fixturePrice: { numeratorUnit: m.settlementUnit, denominatorUnit: m.quantityUnit, decimals: BigInt(m.fixturePriceDecimals), atoms: BigInt(m.fixturePrice) },
    fixtureFeeBps: BigInt(m.fixtureFeeBps),
  }));
  return toHex(encodeArguments([array(MARKET_CONFIG)], [values]));
}

export function tokenConstructorArgs(name: string, symbol: string, decimals: number, holder: string, supply: bigint): string {
  return toHex(encodeArguments([string, string, uint(8), address, uint(256)], [name, symbol, BigInt(decimals), holder, supply]));
}

export const erc20 = {
  transfer: (to: string, amount: bigint) => calldata('transfer(address,uint256)', [address, uint(256)], [to, amount]),
  approve: (spender: string, amount: bigint) => calldata('approve(address,uint256)', [address, uint(256)], [spender, amount]),
};

// --- The manifest ------------------------------------------------------------------------------------

export interface ContractRecord {
  readonly address: string;
  readonly deploymentTx: string | null;
  readonly block: string | null;
  readonly createdBy: string;
  readonly runtimeCodeHash: string;
  readonly runtimeSizeBytes: number;
  readonly creationCodeHash: string | null;
  readonly deploymentGasUsed: string | null;
}

export interface Manifest {
  readonly label: string;
  readonly network: { readonly name: string; readonly chainId: number; readonly rpc: string; readonly explorer: string; readonly nativeGasToken: string; readonly arbOsVersion: number | null; readonly source: string };
  readonly deployer: string;
  readonly principal: string;
  readonly agent: string;
  readonly compiler: { readonly solc: string; readonly optimizer: boolean; readonly optimizerRuns: number; readonly viaIr: boolean; readonly evmVersion: string; readonly bytecodeHash: string };
  readonly gitCommit: string;
  readonly frozenPhase6Source: string;
  readonly timestamp: string;
  readonly contracts: {
    readonly mandateExecutionGate: ContractRecord & { readonly domainSeparator: string; readonly runtimeMatchesArtifactExceptImmutables: boolean };
    readonly fixtureVenue: ContractRecord;
    readonly fixtureVenueAdapter: ContractRecord;
    readonly mdemo: ContractRecord & { readonly name: string; readonly symbol: string; readonly decimals: number; readonly supply: string };
    readonly mdusd: ContractRecord & { readonly name: string; readonly symbol: string; readonly decimals: number; readonly supply: string };
  };
  readonly market: DemoMarketConfig;
  readonly setup: readonly { readonly step: string; readonly tx: string; readonly gasUsed: string }[];
  readonly verification: { readonly deployScriptVerify: string; readonly explorerSourceVerification: string };
}

/** The reviewed gate the adapter serves, from a manifest. */
export function reviewedGateOf(m: Manifest): ReviewedGate {
  const c = m.contracts;
  return {
    chainId: BigInt(m.network.chainId),
    gate: c.mandateExecutionGate.address,
    markets: [
      {
        representation: c.mdemo.address,
        fundingToken: c.mdusd.address,
        adapter: c.fixtureVenueAdapter.address,
        venue: c.fixtureVenue.address,
        representationDecimals: c.mdemo.decimals,
        fundingDecimals: c.mdusd.decimals,
        canonicalAsset: m.market.canonicalAsset,
        issuer: m.market.issuer,
        venueId: m.market.venue,
        quantityUnit: m.market.quantityUnit,
        settlementUnit: m.market.settlementUnit,
        synthetic: m.market.synthetic,
        fixturePrice: { decimals: m.market.fixturePriceDecimals, atoms: BigInt(m.market.fixturePrice) },
        feeBps: m.market.fixtureFeeBps,
      },
    ],
  };
}

export function gitCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
}

export const json = (v: object) => JSON.stringify(v, (_k, x: bigint | string) => (typeof x === 'bigint' ? x.toString() : x), 2);
