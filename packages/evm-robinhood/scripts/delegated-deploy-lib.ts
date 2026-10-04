/**
 * Pure helpers for C2.3 MandateDelegatedExecutionGate Robinhood testnet deploy.
 * No I/O, no forge invocation, no secrets — unit-tested in isolation.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const ROBINHOOD_TESTNET_CHAIN_ID = 46_630;
export const REFUSED_MAINNET_CHAIN_IDS = [1, 42_161, 42_170, 4_663] as const;
export const DEFAULT_ROBINHOOD_TESTNET_RPC = 'https://rpc.testnet.chain.robinhood.com';
export const CONFIRM_TESTNET_FLAG = '--confirm-testnet-46630';
export const FORGE_SCRIPT = 'contracts/script/DeployDelegatedV3.s.sol:DeployDelegatedV3';
export const V3_CONFIG_PATH = join(REPO, 'contracts', 'deploy', 'robinhood-testnet-delegated.json');
export const V2_MANIFEST_PATH = join(REPO, 'contracts', 'deploy', 'robinhood-testnet.json');
export const V3_LIVE_MANIFEST_PATH = join(REPO, 'contracts', 'deploy', 'robinhood-testnet-delegated-live.json');

export const FIXTURE = {
  representation: '0x5d4c3618f996777baf0e0468884bb7a440f189e1',
  fundingToken: '0x53b640b9a573e33c541de5a4917bc4d28d956abf',
  canonicalAsset: { assetClass: 'fixture', idScheme: 'mandate-demo', value: 'MDEMO' },
  issuer: 'issuer.mandate-demo',
  venue: 'venue.mandate-fixture',
  quantityUnit: 'TOKEN',
  settlementUnit: 'MDUSD',
  synthetic: false,
  classification: 'FIXTURE',
  fixturePriceDecimals: 6,
  fixturePrice: '10000000',
  fixtureFeeBps: 0,
} as const;

export type DeployMode =
  | { readonly kind: 'DRY_RUN' }
  | { readonly kind: 'SEND' }
  | { readonly kind: 'REFUSED'; readonly reason: string; readonly exitCode: number };

export type ChainCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type ConfigCheck =
  | { readonly ok: true; readonly config: DelegatedDeployConfig }
  | { readonly ok: false; readonly reason: string };

export interface DelegatedDeployConfig {
  readonly label: string;
  readonly chainId: number;
  readonly gateKind: string;
  readonly markets: readonly {
    readonly representation: string;
    readonly fundingToken: string;
    readonly canonicalAsset: { readonly assetClass: string; readonly idScheme: string; readonly value: string };
    readonly issuer: string;
    readonly venue: string;
    readonly quantityUnit: string;
    readonly settlementUnit: string;
    readonly synthetic: boolean;
    readonly classification: string;
    readonly fixturePriceDecimals: number;
    readonly fixturePrice: string;
    readonly fixtureFeeBps: number;
  }[];
}

/** Resolve operator mode from argv. Default is dry-run (never broadcast). */
export function resolveDeployMode(argv: readonly string[]): DeployMode {
  const send = argv.includes('--send');
  const dryRun = argv.includes('--dry-run');
  const confirm = argv.includes(CONFIRM_TESTNET_FLAG);

  if (send && dryRun) {
    return { kind: 'REFUSED', reason: 'REFUSED: pass either --dry-run or --send, not both', exitCode: 2 };
  }
  if (send && !confirm) {
    return {
      kind: 'REFUSED',
      reason: `REFUSED: --send requires ${CONFIRM_TESTNET_FLAG} (double confirmation for chain 46630 broadcast)`,
      exitCode: 2,
    };
  }
  if (send && confirm) return { kind: 'SEND' };
  return { kind: 'DRY_RUN' };
}

/** Accept only Robinhood Chain testnet (46630). Refuse known mainnets and unknowns. */
export function assertAllowedChainId(chainId: number): ChainCheck {
  if ((REFUSED_MAINNET_CHAIN_IDS as readonly number[]).includes(chainId)) {
    return { ok: false, reason: `REFUSED: mainnet chainId ${chainId} is never a V3 deploy target` };
  }
  if (chainId !== ROBINHOOD_TESTNET_CHAIN_ID) {
    return {
      ok: false,
      reason: `REFUSED: chainId ${chainId} is not Robinhood Chain testnet (${ROBINHOOD_TESTNET_CHAIN_ID})`,
    };
  }
  return { ok: true };
}

export function parseChainIdHex(hex: string): ChainCheck & { chainId?: number } {
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) return { ok: false, reason: `REFUSED: malformed eth_chainId response` };
  let chainId: number;
  try {
    chainId = Number(BigInt(hex));
  } catch {
    return { ok: false, reason: `REFUSED: unreadable eth_chainId response` };
  }
  if (!Number.isSafeInteger(chainId)) return { ok: false, reason: `REFUSED: chainId out of range` };
  const check = assertAllowedChainId(chainId);
  return check.ok ? { ok: true, chainId } : check;
}

/**
 * Build forge script argv. Dry-run never includes `--broadcast`.
 * SEND adds `--broadcast --interactive` (external signer; no raw key).
 */
export function forgeScriptArgs(mode: 'DRY_RUN' | 'SEND', rpcUrl: string): readonly string[] {
  const base = ['script', FORGE_SCRIPT, '--rpc-url', rpcUrl] as const;
  if (mode === 'SEND') return [...base, '--broadcast', '--interactive'];
  return [...base];
}

export function forgeArgsIncludeBroadcast(args: readonly string[]): boolean {
  return args.includes('--broadcast');
}

/** Validate the committed V3 deploy config (immutable fixture wiring). */
export function validateDelegatedConfig(raw: unknown): ConfigCheck {
  if (raw === null || typeof raw !== 'object') return { ok: false, reason: 'REFUSED: deploy config is not an object' };
  const cfg = raw as {
    label?: unknown;
    chainId?: unknown;
    gateKind?: unknown;
    markets?: unknown;
  };
  if (typeof cfg.label !== 'string' || cfg.label.length === 0) {
    return { ok: false, reason: 'REFUSED: deploy config label missing' };
  }
  if (typeof cfg.chainId !== 'number') return { ok: false, reason: 'REFUSED: deploy config chainId missing' };
  const chain = assertAllowedChainId(cfg.chainId);
  if (!chain.ok) return chain;
  if (cfg.gateKind !== 'MandateDelegatedExecutionGate') {
    return { ok: false, reason: `REFUSED: unexpected gateKind ${String(cfg.gateKind)}` };
  }
  if (!Array.isArray(cfg.markets) || cfg.markets.length !== 1) {
    return { ok: false, reason: 'REFUSED: deploy config must name exactly one market' };
  }
  const m = cfg.markets[0] as DelegatedDeployConfig['markets'][number];
  if (m === undefined || typeof m !== 'object') return { ok: false, reason: 'REFUSED: malformed market' };
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!eq(m.representation, FIXTURE.representation)) {
    return { ok: false, reason: 'REFUSED: representation is not the pinned MDEMO fixture' };
  }
  if (!eq(m.fundingToken, FIXTURE.fundingToken)) {
    return { ok: false, reason: 'REFUSED: fundingToken is not the pinned MDUSD fixture' };
  }
  if (
    m.canonicalAsset?.assetClass !== FIXTURE.canonicalAsset.assetClass
    || m.canonicalAsset?.idScheme !== FIXTURE.canonicalAsset.idScheme
    || m.canonicalAsset?.value !== FIXTURE.canonicalAsset.value
  ) {
    return { ok: false, reason: 'REFUSED: canonicalAsset is not the pinned MDEMO fixture' };
  }
  if (m.issuer !== FIXTURE.issuer || m.venue !== FIXTURE.venue) {
    return { ok: false, reason: 'REFUSED: issuer/venue mismatch' };
  }
  if (m.quantityUnit !== FIXTURE.quantityUnit || m.settlementUnit !== FIXTURE.settlementUnit) {
    return { ok: false, reason: 'REFUSED: unit mismatch' };
  }
  if (m.synthetic !== false || m.classification !== 'FIXTURE') {
    return { ok: false, reason: 'REFUSED: classification/synthetic mismatch' };
  }
  if (m.fixturePriceDecimals !== 6 || m.fixturePrice !== '10000000' || m.fixtureFeeBps !== 0) {
    return { ok: false, reason: 'REFUSED: fixture price/fee mismatch' };
  }
  return {
    ok: true,
    config: {
      label: cfg.label,
      chainId: cfg.chainId,
      gateKind: cfg.gateKind,
      markets: [m],
    },
  };
}

export function loadDelegatedConfig(path: string = V3_CONFIG_PATH): ConfigCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return { ok: false, reason: `REFUSED: cannot read deploy config at ${path}` };
  }
  return validateDelegatedConfig(raw);
}

export function resolveRpcUrl(env: { readonly [k: string]: string | undefined } = process.env): {
  readonly ok: true;
  readonly url: string;
  readonly label: string;
  readonly isQuickNode: boolean;
} | { readonly ok: false; readonly reason: string } {
  const raw = (env['ROBINHOOD_TESTNET_RPC_URL'] ?? '').trim();
  if (raw === '') {
    return { ok: true, url: DEFAULT_ROBINHOOD_TESTNET_RPC, label: 'public Robinhood Chain testnet RPC', isQuickNode: false };
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'REFUSED: ROBINHOOD_TESTNET_RPC_URL is not a URL (value not printed)' };
  }
  if (u.protocol === 'https:' && u.hostname === 'rpc.testnet.chain.robinhood.com' && u.pathname === '/' && u.search === '') {
    return { ok: true, url: DEFAULT_ROBINHOOD_TESTNET_RPC, label: 'public Robinhood Chain testnet RPC', isQuickNode: false };
  }
  if (u.protocol === 'https:' && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.quiknode\.pro$/.test(u.hostname) && u.search === '' && u.hash === '') {
    return { ok: true, url: u.toString(), label: 'QuickNode (operator endpoint)', isQuickNode: true };
  }
  return {
    ok: false,
    reason: 'REFUSED: ROBINHOOD_TESTNET_RPC_URL must be the public testnet RPC or an https QuickNode endpoint (value not printed)',
  };
}

/** Extract a deployed contract address from forge script stdout when present. */
export function parseGateAddressFromForgeOutput(out: string): string | null {
  const m = /MandateDelegatedExecutionGate\s+(0x[0-9a-fA-F]{40})/.exec(out);
  return m?.[1]?.toLowerCase() ?? null;
}

/**
 * Optional archive/local Solidity verify argv. Never includes `--fork-block-number`
 * or `--broadcast`. The public-RPC Node verifier does not invoke forge: Foundry
 * still forks at a numeric height internally, which fails on Robinhood's
 * non-archive load-balanced endpoints.
 */
export function forgeVerifyScriptArgs(gate: string, rpcUrl: string): readonly string[] {
  if (!/^0x[0-9a-fA-F]{40}$/.test(gate)) {
    throw new Error('REFUSED: forge verify requires a 20-byte gate address');
  }
  return ['script', FORGE_SCRIPT, '--sig', 'verify(address)', gate, '--rpc-url', rpcUrl];
}

export function forgeArgsIncludeForkBlockNumber(args: readonly string[]): boolean {
  return args.includes('--fork-block-number');
}

/** Parse `--gate 0x…` from verify argv. */
export function parseVerifyGateArg(argv: readonly string[]): { readonly ok: true; readonly gate: string } | { readonly ok: false; readonly reason: string } {
  const i = argv.indexOf('--gate');
  if (i < 0) return { ok: false, reason: 'REFUSED: require --gate 0x… (40 hex chars)' };
  const v = argv[i + 1];
  if (v === undefined || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
    return { ok: false, reason: 'REFUSED: require --gate 0x… (40 hex chars)' };
  }
  return { ok: true, gate: v.toLowerCase() };
}

/** Refuse empty runtime code (eth_getCode == 0x). */
export function assertContractCodePresent(code: string | null | undefined): ChainCheck {
  if (code === undefined || code === null || code === '' || code === '0x') {
    return { ok: false, reason: 'REFUSED: no contract code at gate' };
  }
  if (!/^0x[0-9a-fA-F]*$/.test(code) || code.length % 2 !== 0) {
    return { ok: false, reason: 'REFUSED: malformed contract code at gate' };
  }
  return { ok: true };
}

/** True when forge/RPC error text is the non-archive historical fork race. */
export function isNonArchiveForkError(text: string): boolean {
  return /fork from an older block with a non-archive node/i.test(text)
    || /historical state .* is not available/i.test(text)
    || /failed to get block number/i.test(text);
}
