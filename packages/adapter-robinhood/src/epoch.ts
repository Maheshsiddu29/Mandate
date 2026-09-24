import {
  parseCorporateActionState,
  parseObserved,
  TrustClass,
  type Identifier,
  type Observed,
  type CorporateActionState,
} from '@mandate/kernel';
import { parseContractAddress, type ValidatedCanonicalAssetId } from '@mandate/registry';
import type { NormalizedOnchainToken } from './onchain.ts';
import { AdapterErrorCode, adapterErr, adapterOk, type AdapterResult } from './result.ts';

export const UI_MULTIPLIER_UPDATED_TOPIC = '0x2205df4534432b2f60654a3fdb48737ffdaf3e9edb1a498bd985bc026b15b055';
export const CORPORATE_ACTION_EPOCH_SOURCE = 'robinhood-erc8056-epoch' as Identifier;
export const INITIAL_MULTIPLIER = 1_000_000_000_000_000_000n;

export interface MultiplierEvent {
  readonly contractAddress: string;
  readonly blockNumber: bigint;
  readonly logIndex: bigint;
  readonly transactionHash: string;
  readonly oldMultiplier: bigint;
  readonly newMultiplier: bigint;
  readonly effectiveAtUnixSeconds: bigint;
}

export interface RawMultiplierEventLog {
  readonly address: unknown;
  readonly topics: unknown;
  readonly data: unknown;
  readonly blockNumber: unknown;
  readonly transactionHash: unknown;
  readonly logIndex: unknown;
  readonly removed: unknown;
}

function quantity(raw: unknown, path: string): AdapterResult<bigint> {
  if (typeof raw !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(raw)) {
    return adapterErr(AdapterErrorCode.RPC_ERROR, path, 'invalid JSON-RPC quantity');
  }
  return adapterOk(BigInt(raw));
}

export function parseMultiplierEvent(raw: RawMultiplierEventLog, path = 'log'): AdapterResult<MultiplierEvent> {
  const address = parseContractAddress(raw.address);
  if (!address.ok) return adapterErr(AdapterErrorCode.INVALID_ADDRESS, `${path}.address`, 'invalid event address');
  if (!Array.isArray(raw.topics) || raw.topics.length !== 1 || raw.topics[0] !== UI_MULTIPLIER_UPDATED_TOPIC) {
    return adapterErr(AdapterErrorCode.RPC_ERROR, `${path}.topics`, 'unexpected multiplier event topic');
  }
  if (typeof raw.data !== 'string' || !/^0x[0-9a-fA-F]{192}$/.test(raw.data)) {
    return adapterErr(AdapterErrorCode.RPC_ERROR, `${path}.data`, 'invalid multiplier event data');
  }
  if (raw.removed !== false) return adapterErr(AdapterErrorCode.RPC_ERROR, `${path}.removed`, 'removed or unknown log cannot establish state');
  const blockNumber = quantity(raw.blockNumber, `${path}.blockNumber`);
  if (!blockNumber.ok) return blockNumber;
  const logIndex = quantity(raw.logIndex, `${path}.logIndex`);
  if (!logIndex.ok) return logIndex;
  if (typeof raw.transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw.transactionHash)) {
    return adapterErr(AdapterErrorCode.RPC_ERROR, `${path}.transactionHash`, 'invalid transaction hash');
  }
  const body = raw.data.slice(2);
  const oldMultiplier = BigInt(`0x${body.slice(0, 64)}`);
  const newMultiplier = BigInt(`0x${body.slice(64, 128)}`);
  const effectiveAtUnixSeconds = BigInt(`0x${body.slice(128, 192)}`);
  if (oldMultiplier === 0n || newMultiplier === 0n) return adapterErr(AdapterErrorCode.INVALID_DECIMAL, `${path}.data`, 'multiplier must be positive');
  return adapterOk({
    contractAddress: address.value, blockNumber: blockNumber.value, logIndex: logIndex.value,
    transactionHash: raw.transactionHash.toLowerCase(), oldMultiplier, newMultiplier, effectiveAtUnixSeconds,
  });
}

export function deriveCorporateActionEpoch(
  token: NormalizedOnchainToken,
  events: readonly MultiplierEvent[],
): AdapterResult<bigint> {
  const relevant = events.filter((event) => event.contractAddress === token.contractAddress.value);
  if (relevant.length !== events.length) {
    return adapterErr(AdapterErrorCode.DEPLOYMENT_MISMATCH, 'events', 'event address differs from token contract');
  }
  const effective = relevant.filter((event) => event.effectiveAtUnixSeconds <= token.blockTimestamp);
  if (effective.length === 0) {
    if (token.currentMultiplier.value.atoms === INITIAL_MULTIPLIER) return adapterOk(0n);
    return adapterErr(AdapterErrorCode.CROSS_SURFACE_MISMATCH, 'events', 'non-initial multiplier has no effective event');
  }
  const byTime = new Map<string, Set<string>>();
  for (const event of effective) {
    const key = String(event.effectiveAtUnixSeconds);
    const values = byTime.get(key) ?? new Set<string>();
    values.add(String(event.newMultiplier));
    byTime.set(key, values);
  }
  for (const [time, values] of byTime) {
    if (values.size > 1) return adapterErr(AdapterErrorCode.CROSS_SURFACE_MISMATCH, 'events', `conflicting multiplier results at ${time}`);
  }
  const latest = [...effective].sort((left, right) => {
    if (left.effectiveAtUnixSeconds !== right.effectiveAtUnixSeconds) return left.effectiveAtUnixSeconds < right.effectiveAtUnixSeconds ? -1 : 1;
    if (left.blockNumber !== right.blockNumber) return left.blockNumber < right.blockNumber ? -1 : 1;
    return left.logIndex < right.logIndex ? -1 : left.logIndex > right.logIndex ? 1 : 0;
  }).at(-1) as MultiplierEvent;
  if (latest.newMultiplier !== token.currentMultiplier.value.atoms) {
    return adapterErr(AdapterErrorCode.CROSS_SURFACE_MISMATCH, 'events', 'latest effective event does not match current multiplier');
  }
  return adapterOk(latest.effectiveAtUnixSeconds);
}

export function toCorporateActionState(
  canonicalAsset: ValidatedCanonicalAssetId,
  token: NormalizedOnchainToken,
  events: readonly MultiplierEvent[],
): AdapterResult<Observed<CorporateActionState>> {
  const epoch = deriveCorporateActionEpoch(token, events);
  if (!epoch.ok) return epoch;
  const state = parseCorporateActionState({ canonicalAsset, epoch: epoch.value });
  if (!state.ok) return adapterErr(AdapterErrorCode.VALUE_OUT_OF_RANGE, 'epoch', 'epoch does not fit kernel state');
  const observed = parseObserved({
    value: state.value,
    provenance: {
      trustClass: TrustClass.VERIFIED,
      sourceId: CORPORATE_ACTION_EPOCH_SOURCE,
      observedAtUnixSeconds: token.blockTimestamp,
    },
  }, parseCorporateActionState);
  if (!observed.ok) return adapterErr(AdapterErrorCode.MALFORMED_RESPONSE, 'epoch', 'cannot construct trusted corporate-action state');
  return adapterOk(observed.value);
}
