/**
 * The explicit send gate.
 *
 * Building, signing for a simulation, `eth_call` and `estimateGas` need no
 * permission. Broadcasting does. A `SendGate` starts locked and opens for
 * one broadcast only, from exactly one of two surfaces:
 *
 * - the CLI operator phrase `AUTHORIZE ROBINHOOD TESTNET SEND`
 * - a server-validated browser intent, after the settle route has already
 *   rejected every execution-defining field
 *
 * The browser path does not supply the operator phrase. Model-provider
 * choice never opens the gate. The chain it can reach is fixed below it
 * (rpc.ts refuses any other host and any chain id but 46630).
 */

export const SEND_AUTHORIZATION_PHRASE = 'AUTHORIZE ROBINHOOD TESTNET SEND';

export type SendGateState = 'LOCKED' | 'AUTHORIZED' | 'CONSUMED';
export type SendAuthorizationSource = 'OPERATOR_PHRASE' | 'BROWSER_INTENT';

/**
 * Whether one line of operator input is the authorization phrase. Exactly
 * one terminating line ending (LF, CRLF or CR) is removed and nothing else:
 * no trimming, no case folding, no prefix, substring or extra word.
 */
export function isSendAuthorization(input: string): boolean {
  return input.replace(/(?:\r\n|\n|\r)$/, '') === SEND_AUTHORIZATION_PHRASE;
}

export class SendGate {
  #state: SendGateState = 'LOCKED';
  #source: SendAuthorizationSource | null = null;

  /** Opens the gate for one broadcast if `phrase` is exactly the authorization phrase. A line ending is not part of it. */
  authorize(phrase: string): boolean {
    if (this.#state !== 'LOCKED') return false;
    if (!isSendAuthorization(phrase)) return false;
    this.#state = 'AUTHORIZED';
    this.#source = 'OPERATOR_PHRASE';
    return true;
  }

  /**
   * Opens the gate for one broadcast because this request already passed the
   * browser intent schema. It does not read a phrase and it does not accept
   * a token, amount, or target.
   */
  authorizeBrowserIntent(): boolean {
    if (this.#state !== 'LOCKED') return false;
    this.#state = 'AUTHORIZED';
    this.#source = 'BROWSER_INTENT';
    return true;
  }

  get state(): SendGateState {
    return this.#state;
  }

  /** Which explicit surface opened this gate, or null while it is locked. */
  get source(): SendAuthorizationSource | null {
    return this.#source;
  }

  /** Takes the one broadcast the authorization allows. `false` means: do not broadcast. */
  consume(): boolean {
    if (this.#state !== 'AUTHORIZED') return false;
    this.#state = 'CONSUMED';
    return true;
  }
}
