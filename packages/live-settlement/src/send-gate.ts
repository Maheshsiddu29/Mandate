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

export class SendGate {
  #state: SendGateState = 'LOCKED';

  /** Opens the gate for one broadcast if `phrase` is exactly the authorization phrase. A line ending is not part of it. */
  authorize(phrase: string): boolean {
    if (this.#state !== 'LOCKED') return false;
    if (phrase.replace(/\r?\n$/, '') !== SEND_AUTHORIZATION_PHRASE) return false;
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
