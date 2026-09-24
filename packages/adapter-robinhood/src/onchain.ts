import { keccak256, type Identifier, type UnixSeconds } from '@mandate/kernel';
import { parseContractAddress } from '@mandate/registry';
import { authoritativeHttpEvidence, ObservationClock, type Evidence } from './evidence.ts';
import type { FixedDecimal } from './decimal.ts';
import type { NormalizedRobinhoodAsset } from './asset.ts';
import { AdapterErrorCode, adapterErr, adapterOk, type AdapterResult } from './result.ts';

export const ROBINHOOD_CHAIN_SOURCE = 'robinhood-chain-mainnet' as Identifier;

export interface RawOnchainTokenObservation {
  readonly chainId: unknown;
  readonly blockNumber: unknown;
  readonly blockTimestamp: unknown;
  readonly contractAddress: unknown;
  readonly code: unknown;
  readonly symbolResult: unknown;
  readonly nameResult: unknown;
  readonly decimalsResult: unknown;
  readonly uidResult: unknown;
  readonly uiMultiplierResult: unknown;
  readonly newUIMultiplierResult: unknown;
  readonly effectiveAtResult: unknown;
  readonly oraclePausedResult: unknown;
}

export interface NormalizedOnchainToken {
  readonly chainId: Evidence<bigint>;
  readonly blockNumber: Evidence<bigint>;
  readonly blockTimestamp: UnixSeconds;
  readonly contractAddress: Evidence<string>;
  readonly codeHash: Evidence<string>;
  readonly codeBytes: number;
  readonly symbol: Evidence<string>;
  readonly name: Evidence<string>;
  readonly decimals: Evidence<number>;
  readonly uid: Evidence<string>;
  readonly currentMultiplier: Evidence<FixedDecimal>;
  readonly pendingMultiplier: Evidence<FixedDecimal | null>;
  readonly pendingMultiplierEffectiveAt: Evidence<UnixSeconds | null>;
  readonly lastOrPendingEffectiveAt: Evidence<UnixSeconds>;
  readonly oraclePaused: Evidence<boolean>;
}

const HEX = /^0x[0-9a-fA-F]*$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;

function hexQuantity(raw: unknown, path: string): AdapterResult<bigint> {
  if (typeof raw !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(raw)) {
    return adapterErr(AdapterErrorCode.RPC_ERROR, path, 'invalid JSON-RPC quantity');
  }
  return adapterOk(BigInt(raw));
}

function wordUint(raw: unknown, path: string): AdapterResult<bigint> {
  if (typeof raw !== 'string' || !WORD.test(raw)) return adapterErr(AdapterErrorCode.RPC_ERROR, path, 'invalid ABI uint word');
  return adapterOk(BigInt(raw));
}

function abiBool(raw: unknown, path: string): AdapterResult<boolean> {
  const parsed = wordUint(raw, path);
  if (!parsed.ok) return parsed;
  if (parsed.value === 0n) return adapterOk(false);
  if (parsed.value === 1n) return adapterOk(true);
  return adapterErr(AdapterErrorCode.RPC_ERROR, path, 'ABI bool is not zero or one');
}

function abiString(raw: unknown, path: string): AdapterResult<string> {
  if (typeof raw !== 'string' || !HEX.test(raw) || raw.length < 2 + 64 * 2 || (raw.length - 2) % 64 !== 0) {
    return adapterErr(AdapterErrorCode.RPC_ERROR, path, 'invalid ABI string response');
  }
  const body = raw.slice(2);
  const offsetBytes = BigInt(`0x${body.slice(0, 64)}`);
  if (offsetBytes > BigInt(Number.MAX_SAFE_INTEGER)) return adapterErr(AdapterErrorCode.VALUE_OUT_OF_RANGE, path, 'ABI offset too large');
  const offset = Number(offsetBytes) * 2;
  if (offset + 64 > body.length) return adapterErr(AdapterErrorCode.RPC_ERROR, path, 'ABI string offset is outside response');
  const lengthBytes = BigInt(`0x${body.slice(offset, offset + 64)}`);
  if (lengthBytes > 128n) return adapterErr(AdapterErrorCode.VALUE_OUT_OF_RANGE, path, 'ABI string exceeds adapter bound');
  const length = Number(lengthBytes) * 2;
  if (offset + 64 + length > body.length) return adapterErr(AdapterErrorCode.RPC_ERROR, path, 'ABI string is truncated');
  const bytes = Buffer.from(body.slice(offset + 64, offset + 64 + length), 'hex');
  try {
    return adapterOk(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return adapterErr(AdapterErrorCode.RPC_ERROR, path, 'ABI string is not valid UTF-8');
  }
}

export function parseOnchainTokenObservation(raw: RawOnchainTokenObservation): AdapterResult<NormalizedOnchainToken> {
  const chainId = hexQuantity(raw.chainId, 'rpc.chainId');
  if (!chainId.ok) return chainId;
  const blockNumber = hexQuantity(raw.blockNumber, 'rpc.blockNumber');
  if (!blockNumber.ok) return blockNumber;
  const blockTimestamp = hexQuantity(raw.blockTimestamp, 'rpc.blockTimestamp');
  if (!blockTimestamp.ok) return blockTimestamp;
  const address = parseContractAddress(raw.contractAddress);
  if (!address.ok) return adapterErr(AdapterErrorCode.INVALID_ADDRESS, 'rpc.contractAddress', 'invalid contract address');
  if (typeof raw.code !== 'string' || !HEX.test(raw.code) || raw.code.length % 2 !== 0) {
    return adapterErr(AdapterErrorCode.RPC_ERROR, 'rpc.code', 'invalid bytecode response');
  }
  if (raw.code === '0x') return adapterErr(AdapterErrorCode.CONTRACT_CODE_MISSING, 'rpc.code', 'contract has no code');
  const symbol = abiString(raw.symbolResult, 'rpc.symbol');
  if (!symbol.ok) return symbol;
  const name = abiString(raw.nameResult, 'rpc.name');
  if (!name.ok) return name;
  const decimals = wordUint(raw.decimalsResult, 'rpc.decimals');
  if (!decimals.ok) return decimals;
  if (decimals.value > 38n) return adapterErr(AdapterErrorCode.INVALID_DECIMAL, 'rpc.decimals', 'token decimals exceed supported bound');
  if (typeof raw.uidResult !== 'string' || !WORD.test(raw.uidResult)) {
    return adapterErr(AdapterErrorCode.INVALID_IDENTITY, 'rpc.uid', 'UID must be bytes32');
  }
  const current = wordUint(raw.uiMultiplierResult, 'rpc.uiMultiplier');
  if (!current.ok) return current;
  const next = wordUint(raw.newUIMultiplierResult, 'rpc.newUIMultiplier');
  if (!next.ok) return next;
  const effectiveAt = wordUint(raw.effectiveAtResult, 'rpc.effectiveAt');
  if (!effectiveAt.ok) return effectiveAt;
  const paused = abiBool(raw.oraclePausedResult, 'rpc.oraclePaused');
  if (!paused.ok) return paused;
  if (current.value === 0n || next.value === 0n) {
    return adapterErr(AdapterErrorCode.INVALID_DECIMAL, 'rpc.multiplier', 'multiplier must be positive');
  }
  const timestamp = blockTimestamp.value as UnixSeconds;
  const hasPending = next.value !== current.value && effectiveAt.value > blockTimestamp.value;
  if (next.value !== current.value && !hasPending) {
    return adapterErr(AdapterErrorCode.CROSS_SURFACE_MISMATCH, 'rpc.multiplier', 'different next multiplier is not scheduled in the future');
  }
  const ev = <T>(value: T): Evidence<T> => authoritativeHttpEvidence(
    value, ROBINHOOD_CHAIN_SOURCE, timestamp, ObservationClock.BLOCK_TIMESTAMP,
  );
  return adapterOk({
    chainId: ev(chainId.value), blockNumber: ev(blockNumber.value), blockTimestamp: timestamp,
    contractAddress: ev(address.value),
    codeHash: ev(keccak256(Uint8Array.from(Buffer.from(raw.code.slice(2), 'hex')))),
    codeBytes: (raw.code.length - 2) / 2,
    symbol: ev(symbol.value), name: ev(name.value), decimals: ev(Number(decimals.value)),
    uid: ev(raw.uidResult.toLowerCase()),
    currentMultiplier: ev({ atoms: current.value, decimals: 18 }),
    pendingMultiplier: ev(hasPending ? { atoms: next.value, decimals: 18 } : null),
    pendingMultiplierEffectiveAt: ev(hasPending ? effectiveAt.value as UnixSeconds : null),
    lastOrPendingEffectiveAt: ev(effectiveAt.value as UnixSeconds),
    oraclePaused: ev(paused.value),
  });
}

export function verifyContractIdentity(
  asset: NormalizedRobinhoodAsset,
  onchain: NormalizedOnchainToken,
): AdapterResult<NormalizedOnchainToken> {
  const deployment = asset.deployments.value.find((candidate) =>
    candidate.chainId === onchain.chainId.value && candidate.contractAddress === onchain.contractAddress.value);
  if (deployment === undefined) return adapterErr(AdapterErrorCode.DEPLOYMENT_MISMATCH, 'contract', 'chain and address are not an authoritative deployment');
  const mismatches: string[] = [];
  if (onchain.uid.value !== asset.uid.value) mismatches.push('uid');
  if (onchain.symbol.value !== asset.tokenSymbol.value) mismatches.push('symbol');
  if (onchain.name.value !== asset.tokenName.value) mismatches.push('name');
  if (onchain.decimals.value !== asset.tokenDecimals.value) mismatches.push('decimals');
  if (onchain.currentMultiplier.value.atoms !== asset.currentMultiplier.value.atoms) mismatches.push('currentMultiplier');
  const apiPending = asset.pendingMultiplier.value?.atoms ?? null;
  const chainPending = onchain.pendingMultiplier.value?.atoms ?? null;
  if (apiPending !== chainPending) mismatches.push('pendingMultiplier');
  if (asset.pendingMultiplierEffectiveAt.value !== onchain.pendingMultiplierEffectiveAt.value) mismatches.push('pendingMultiplierEffectiveAt');
  if (mismatches.length > 0) {
    return adapterErr(AdapterErrorCode.CONTRACT_METADATA_MISMATCH, 'contract', `mismatched fields: ${mismatches.join(',')}`);
  }
  return adapterOk(onchain);
}
