/**
 * Provider failures. A failure is a runtime fact about a model call — it
 * says nothing about whether an action is permitted, and it never carries a
 * credential: messages are built from status codes and fixed text only.
 */

export const PROVIDER_ERROR_CODES = ['HTTP', 'NETWORK', 'REFUSAL', 'INCOMPLETE', 'MALFORMED_STREAM', 'INJECTED_FAILURE', 'NOT_CONFIGURED'] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status: number | null;

  constructor(code: ProviderErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
  }
}

/** A safe one-line description of anything a provider threw. */
export function describeFailure(e: unknown): string {
  if (e instanceof ProviderError) return `${e.code}${e.status === null ? '' : ` ${e.status}`}: ${e.message}`;
  if (e instanceof Error) return e.name === 'Error' ? 'provider error' : e.name;
  return 'provider error';
}
