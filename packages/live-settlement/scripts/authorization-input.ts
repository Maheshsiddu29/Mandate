/**
 * Reads the operator's one line of send authorization from a stream.
 *
 * Parser and reader only: it imports no settlement, RPC or signing code
 * and cannot broadcast anything. It settles exactly once — with the first
 * line, at end of input, or at the timeout, whichever comes first — and
 * settles *before* it closes the reader, because closing emits `close`
 * synchronously (B.5.2 bug: the `close` handler used to win and turn the
 * exact phrase into "nothing").
 */

import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

export type AuthorizationInput = { readonly kind: 'LINE'; readonly line: string } | { readonly kind: 'EOF' } | { readonly kind: 'TIMEOUT' };

export function readAuthorizationLine(input: Readable, timeoutMs: number): Promise<AuthorizationInput> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, terminal: false, crlfDelay: Infinity });
    let settled = false;
    const settle = (r: AuthorizationInput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
      rl.close();
    };
    const timer = setTimeout(() => settle({ kind: 'TIMEOUT' }), timeoutMs);
    rl.once('line', (line) => settle({ kind: 'LINE', line }));
    rl.once('close', () => settle({ kind: 'EOF' }));
  });
}
