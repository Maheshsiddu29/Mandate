/** Closed adapter failures. Network clients add transport context without
 * turning unavailable external state into a value. */
export const AdapterErrorCode = {
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  INVALID_ADDRESS: 'INVALID_ADDRESS',
  INVALID_CHAIN_ID: 'INVALID_CHAIN_ID',
  INVALID_DECIMAL: 'INVALID_DECIMAL',
  INVALID_TIMESTAMP: 'INVALID_TIMESTAMP',
  INVALID_IDENTITY: 'INVALID_IDENTITY',
  UNKNOWN_ENUM: 'UNKNOWN_ENUM',
  VALUE_OUT_OF_RANGE: 'VALUE_OUT_OF_RANGE',
  ASSET_NOT_FOUND: 'ASSET_NOT_FOUND',
  DEPLOYMENT_MISMATCH: 'DEPLOYMENT_MISMATCH',
  CHAIN_MISMATCH: 'CHAIN_MISMATCH',
  CONTRACT_CODE_MISSING: 'CONTRACT_CODE_MISSING',
  CONTRACT_METADATA_MISMATCH: 'CONTRACT_METADATA_MISMATCH',
  CROSS_SURFACE_MISMATCH: 'CROSS_SURFACE_MISMATCH',
  STALE_OBSERVATION: 'STALE_OBSERVATION',
  HTTP_ERROR: 'HTTP_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  RPC_ERROR: 'RPC_ERROR',
} as const;
export type AdapterErrorCode = (typeof AdapterErrorCode)[keyof typeof AdapterErrorCode];

export interface AdapterError {
  readonly code: AdapterErrorCode;
  readonly path: string;
  readonly message: string;
}

export type AdapterResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AdapterError };

export function adapterOk<T>(value: T): AdapterResult<T> {
  return { ok: true, value };
}

export function adapterErr(code: AdapterErrorCode, path: string, message: string): AdapterResult<never> {
  return { ok: false, error: { code, path, message } };
}
