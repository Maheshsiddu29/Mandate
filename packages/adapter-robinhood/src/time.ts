import type { UnixSeconds } from '@mandate/kernel';
import { AdapterErrorCode, adapterErr, adapterOk, type AdapterResult } from './result.ts';

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function parseRfc3339Seconds(raw: unknown, path: string): AdapterResult<UnixSeconds> {
  if (typeof raw !== 'string' || !RFC3339.test(raw)) {
    return adapterErr(AdapterErrorCode.INVALID_TIMESTAMP, path, 'expected an RFC-3339 UTC timestamp');
  }
  const milliseconds = Date.parse(raw);
  if (!Number.isFinite(milliseconds)) return adapterErr(AdapterErrorCode.INVALID_TIMESTAMP, path, 'timestamp is invalid');
  return adapterOk(BigInt(Math.trunc(milliseconds / 1000)) as UnixSeconds);
}
