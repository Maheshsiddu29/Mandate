import { keccak256, parsePrice, type Identifier, type Price, type UnixSeconds } from '@mandate/kernel';
import { parseContractAddress } from '@mandate/registry';
import { authoritativeHttpEvidence, ObservationClock, type Evidence } from './evidence.ts';
import { AdapterErrorCode, adapterErr, adapterOk, type AdapterResult } from './result.ts';

export const CHAINLINK_ROBINHOOD_FEED_SOURCE = 'chainlink-robinhood-feed' as Identifier;

export interface RawOracleObservation {
  readonly chainId: unknown;
  readonly blockNumber: unknown;
  readonly blockTimestamp: unknown;
  readonly feedAddress: unknown;
  readonly code: unknown;
  readonly decimalsResult: unknown;
  readonly latestRoundDataResult: unknown;
}

export interface NormalizedOraclePrice {
  readonly chainId: Evidence<bigint>;
  readonly blockNumber: Evidence<bigint>;
  readonly blockTimestamp: UnixSeconds;
  readonly feedAddress: Evidence<string>;
  readonly codeHash: Evidence<string>;
  readonly codeBytes: number;
  readonly roundId: bigint;
  readonly answeredInRound: bigint;
  readonly updatedAtUnixSeconds: UnixSeconds;
  readonly tokenPrice: Evidence<Price>;
}

function quantity(raw: unknown, path: string): AdapterResult<bigint> {
  if (typeof raw !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(raw)) {
    return adapterErr(AdapterErrorCode.RPC_ERROR, path, 'invalid JSON-RPC quantity');
  }
  return adapterOk(BigInt(raw));
}

function word(raw: unknown, path: string): AdapterResult<bigint> {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    return adapterErr(AdapterErrorCode.RPC_ERROR, path, 'invalid ABI uint word');
  }
  return adapterOk(BigInt(raw));
}

/** Normalize a Chainlink Robinhood tokenized-equity feed at one fixed block.
 * The price denominator is TOKEN: these feeds already include uiMultiplier. */
export function parseOracleObservation(raw: RawOracleObservation): AdapterResult<NormalizedOraclePrice> {
  const chainId = quantity(raw.chainId, 'oracle.chainId');
  if (!chainId.ok) return chainId;
  const blockNumber = quantity(raw.blockNumber, 'oracle.blockNumber');
  if (!blockNumber.ok) return blockNumber;
  const blockTimestamp = quantity(raw.blockTimestamp, 'oracle.blockTimestamp');
  if (!blockTimestamp.ok) return blockTimestamp;
  const address = parseContractAddress(raw.feedAddress);
  if (!address.ok) return adapterErr(AdapterErrorCode.INVALID_ADDRESS, 'oracle.feedAddress', 'invalid feed address');
  if (typeof raw.code !== 'string' || !/^0x[0-9a-fA-F]*$/.test(raw.code) || raw.code.length % 2 !== 0) {
    return adapterErr(AdapterErrorCode.RPC_ERROR, 'oracle.code', 'invalid bytecode response');
  }
  if (raw.code === '0x') return adapterErr(AdapterErrorCode.CONTRACT_CODE_MISSING, 'oracle.code', 'feed has no code');
  const decimals = word(raw.decimalsResult, 'oracle.decimals');
  if (!decimals.ok) return decimals;
  if (decimals.value > 38n) return adapterErr(AdapterErrorCode.INVALID_DECIMAL, 'oracle.decimals', 'feed decimals exceed supported bound');
  if (typeof raw.latestRoundDataResult !== 'string' || !/^0x[0-9a-fA-F]{320}$/.test(raw.latestRoundDataResult)) {
    return adapterErr(AdapterErrorCode.RPC_ERROR, 'oracle.latestRoundData', 'expected five ABI words');
  }
  const body = raw.latestRoundDataResult.slice(2);
  const words = Array.from({ length: 5 }, (_, index) => BigInt(`0x${body.slice(index * 64, (index + 1) * 64)}`));
  const [roundId, unsignedAnswer, , updatedAt, answeredInRound] = words as [bigint, bigint, bigint, bigint, bigint];
  const answer = unsignedAnswer >= (1n << 255n) ? unsignedAnswer - (1n << 256n) : unsignedAnswer;
  if (answer <= 0n) return adapterErr(AdapterErrorCode.INVALID_DECIMAL, 'oracle.answer', 'oracle answer must be positive');
  if (updatedAt === 0n || updatedAt > blockTimestamp.value) {
    return adapterErr(AdapterErrorCode.INVALID_TIMESTAMP, 'oracle.updatedAt', 'oracle time is zero or after block time');
  }
  if (answeredInRound < roundId) return adapterErr(AdapterErrorCode.RPC_ERROR, 'oracle.answeredInRound', 'stale round answer');
  const parsedPrice = parsePrice({
    numeratorUnit: 'USD', denominatorUnit: 'TOKEN', decimals: Number(decimals.value), atoms: answer,
  });
  if (!parsedPrice.ok) return adapterErr(AdapterErrorCode.INVALID_DECIMAL, 'oracle.answer', 'invalid price units');
  const timestamp = updatedAt as UnixSeconds;
  const ev = <T>(value: T): Evidence<T> => authoritativeHttpEvidence(
    value, CHAINLINK_ROBINHOOD_FEED_SOURCE, timestamp, ObservationClock.BLOCK_TIMESTAMP,
  );
  return adapterOk({
    chainId: ev(chainId.value), blockNumber: ev(blockNumber.value), blockTimestamp: blockTimestamp.value as UnixSeconds,
    feedAddress: ev(address.value),
    codeHash: ev(keccak256(Uint8Array.from(Buffer.from(raw.code.slice(2), 'hex')))),
    codeBytes: (raw.code.length - 2) / 2,
    roundId, answeredInRound, updatedAtUnixSeconds: timestamp,
    tokenPrice: ev(parsedPrice.value),
  });
}
