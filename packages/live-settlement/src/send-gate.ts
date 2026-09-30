/**
 * The explicit send gate.
 *
 * Building, signing for a simulation, `eth_call` and `estimateGas` need no
 * permission. Broadcasting does: a `SendGate` is locked until the operator
 * supplies exactly `AUTHORIZE ROBINHOOD TESTNET SEND`, and it opens for one
 * broadcast only. Model-provider choice never opens it — `--provider=openai`
 * is a different control. The phrase authorizes valueless Robinhood Chain
 * testnet assets and nothing else; the chain it can reach is fixed below it
 * (rpc.ts refuses any other host and any chain id but 46630).
 */

export const SEND_AUTHORIZATION_PHRASE = 'AUTHORIZE ROBINHOOD TESTNET SEND';

export type SendGateState = 'LOCKED' | 'AUTHORIZED' | 'CONSUMED';

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

  /** Opens the gate for one broadcast if `phrase` is exactly the authorization phrase. A line ending is not part of it. */
  authorize(phrase: string): boolean {
    if (this.#state !== 'LOCKED') return false;
    if (!isSendAuthorization(phrase)) return false;
    this.#state = 'AUTHORIZED';
    return true;
  }

  get state(): SendGateState {
    return this.#state;
  }

  /** Takes the one broadcast the authorization allows. `false` means: do not broadcast. */
  consume(): boolean {
    if (this.#state !== 'AUTHORIZED') return false;
    this.#state = 'CONSUMED';
    return true;
  }
}
