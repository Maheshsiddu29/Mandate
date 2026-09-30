/**
 * The chain as the existing `GateSigner` sees it during a settlement.
 *
 * `GateSigner` (Phase 7E.3) drives issuance: `ADMIT_ATTEMPT`, custody, the
 * agent's signature, journal, `simulate`, `submit`, `receipt`. This
 * `GateChain` adds the settlement's own checks at the two points where a
 * call could leave the process:
 *
 * - **simulate** — the call must be exactly the fixture settlement's (target
 *   the manifest's gate, the `execute` selector, the calldata re-encodes the
 *   attempt, recipient, tokens, quantity, debit, agent, empty execution data,
 *   deadline ahead, mandate id derived from the domain authorization);
 *   chain id 46630 fresh from the RPC; `eth_call` passes; `estimateGas`
 *   passes. A dry run halts here (`DRY_RUN_HALT`), and so does a send whose
 *   gate is not open: the signer then journals the attempt as not
 *   broadcast.
 * - **submit** — only in SEND mode, only through an open `SendGate` (which
 *   it consumes), only for the exact call it simulated, only after a fresh
 *   chain-id check. It signs once, reports the hash before sending, sends
 *   once, and on an ambiguous answer asks the chain about that hash. It
 *   never sends twice.
 */

import { EXECUTE_SELECTOR, executeCalldata, gateMandateId, reviewedMarketDigest, type BlockRef, type GateCall, type GateChain, type Read, type Receipt, type Simulation, type Submission } from '@mandate/evm-robinhood';
import type { AdapterRef, ExecutionAuthorizationId, ReservationGeneration, ReservationId } from '@mandate/core';
import { keccak256 } from '@mandate/kernel';
import { encodeGateCandidate, encodeGateMandate, executionCommitment } from '@mandate/execution-gate';
import { ROBINHOOD_TESTNET, type TestnetDeployment } from './deployment.ts';
import { fixtureRepresentationId, type FixtureSettlement } from './fixture-mapping.ts';
import type { PreparedTx, TestnetRpc } from './rpc.ts';
import type { SendGate } from './send-gate.ts';

export type SettlementMode = 'DRY_RUN' | 'SEND';

/** The halt a dry run (or an unopened send gate) returns in place of a successful preflight. */
export const DRY_RUN_HALT = 'DRY_RUN_HALT';
export const SEND_NOT_AUTHORIZED = 'SEND_NOT_AUTHORIZED';

export interface SimulationRecord {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly gasEstimate: bigint | null;
  readonly deadline: bigint;
  readonly mandateDigest: string;
  readonly commitment: string;
  readonly calldataBytes: number;
}

export interface SubmissionHooks {
  onSimulationStarted(): void;
  onSimulated(r: SimulationRecord): void;
  /** Called with the signed transaction's hash before it is sent. */
  onSubmissionStarted(tx: { readonly hash: string; readonly nonce: bigint; readonly gasLimit: bigint; readonly maxFeePerGas: bigint; readonly from: string; readonly to: string }): void;
  onBroadcast(r: { readonly hash: string; readonly outcome: 'ACCEPTED' | 'AMBIGUOUS_KNOWN' | 'AMBIGUOUS_UNKNOWN' | 'REJECTED'; readonly detail: string }): void;
  /** Balances immediately before the broadcast, for the postconditions. */
  onBefore(b: { readonly block: bigint; readonly tokenIn: bigint; readonly tokenOut: bigint; readonly agentTokenOut: bigint }): void;
}

/** The domain authorization the gate mandate must name (gate.ts `gateMandateId`). */
export interface DomainAuthorizationRef {
  readonly executionId: ExecutionAuthorizationId;
  readonly reservation: ReservationId;
  readonly generation: ReservationGeneration;
  readonly adapter: AdapterRef;
}

/** Why `call` is not exactly the fixture settlement's call, or `null`. */
export function checkCall(call: GateCall, s: FixtureSettlement, d: TestnetDeployment, authorization: DomainAuthorizationRef, chainNow: bigint): string | null {
  const a = call.attempt;
  if (!call.calldata.startsWith(EXECUTE_SELECTOR)) return 'SELECTOR_NOT_EXECUTE';
  if (call.calldata !== executeCalldata(a.mandate, a.principalSignature, a.candidate, a.terms, a.agentSignature)) return 'CALLDATA_NOT_THE_ATTEMPT';
  if (s.gate !== d.gate.address || s.chainId !== ROBINHOOD_TESTNET) return 'TARGET_NOT_MANIFEST_GATE';
  if (a.terms.recipient !== s.recipient || a.mandate.principal !== s.recipient || s.recipient !== d.principal) return 'RECIPIENT_MISMATCH';
  if (a.mandate.agent !== s.agent || a.candidate.agent !== s.agent) return 'AGENT_MISMATCH';
  if (a.candidate.representationId !== fixtureRepresentationId(s) || s.tokenOut !== d.mdemo.address || s.tokenIn !== d.mdusd.address) return 'TOKEN_MISMATCH';
  if (a.candidate.registrySnapshotDigest !== reviewedMarketDigest(d.reviewed, d.market)) return 'MARKET_NOT_REVIEWED';
  if (a.candidate.quantity.atoms !== s.quantity || a.candidate.quantity.decimals !== d.mdemo.decimals) return 'AMOUNT_MISMATCH';
  if (a.terms.fundingLimit !== s.debit || a.mandate.economicLimit.atoms !== s.debit || a.mandate.economicLimit.unit !== d.market.settlementUnit) return 'AMOUNT_MISMATCH';
  if (a.terms.executionData !== '0x') return 'EXECUTION_DATA_NOT_EMPTY';
  if (a.mandate.mandateId !== gateMandateId(authorization)) return 'MANDATE_NOT_DOMAIN_AUTHORIZATION';
  if (a.terms.deadline <= chainNow) return 'DEADLINE_PASSED';
  return null;
}

export class SettlementGateChain implements GateChain {
  readonly #rpc: TestnetRpc;
  readonly #s: FixtureSettlement;
  readonly #d: TestnetDeployment;
  readonly #mode: SettlementMode;
  readonly #gate: SendGate;
  readonly #hooks: SubmissionHooks;
  #authorization: DomainAuthorizationRef | null = null;
  #simulated: { readonly calldata: string; readonly gas: bigint } | null = null;
  #prepared: PreparedTx | null = null;
  #broadcasts = 0;

  constructor(rpc: TestnetRpc, s: FixtureSettlement, d: TestnetDeployment, mode: SettlementMode, gate: SendGate, hooks: SubmissionHooks) {
    this.#rpc = rpc;
    this.#s = s;
    this.#d = d;
    this.#mode = mode;
    this.#gate = gate;
    this.#hooks = hooks;
  }

  /** The domain authorization this chain serves calls for; set once, before issuance. */
  bind(authorization: DomainAuthorizationRef): void {
    if (this.#authorization !== null) throw new Error('settlement chain already bound');
    this.#authorization = authorization;
  }

  /** `eth_sendRawTransaction` calls made: 0 or 1. */
  get broadcasts(): number {
    return this.#broadcasts;
  }

  /** The signed transaction's hash, once one exists — whether or not the broadcast's answer was clear. */
  get preparedHash(): string | null {
    return this.#prepared?.hash ?? null;
  }

  latest(): Promise<Read<BlockRef>> {
    return this.#rpc.latest();
  }

  async gateIdentity(): Promise<Read<{ readonly codehash: string; readonly domainSeparator: string }>> {
    const [codehash, domainSeparator] = await Promise.all([this.#rpc.codehash(this.#s.gate), this.#rpc.domainSeparator(this.#s.gate)]);
    if (!codehash.ok) return codehash;
    if (!domainSeparator.ok) return domainSeparator;
    return { ok: true, value: { codehash: codehash.value, domainSeparator: domainSeparator.value } };
  }

  async funding(token: string, owner: string, spender: string): Promise<Read<{ readonly balance: bigint; readonly allowance: bigint }>> {
    const [balance, allowance] = await Promise.all([this.#rpc.tokenBalance(token, owner), this.#rpc.allowance(token, owner, spender)]);
    if (!balance.ok) return balance;
    if (!allowance.ok) return allowance;
    return { ok: true, value: { balance: balance.value, allowance: allowance.value } };
  }

  executionCommitmentOf(mandateDigest: string): Promise<Read<string>> {
    return this.#rpc.executionCommitmentOf(this.#s.gate, mandateDigest);
  }

  async simulate(call: GateCall): Promise<Simulation> {
    this.#hooks.onSimulationStarted();
    const a = call.attempt;
    const mandateDigest = keccak256(encodeGateMandate(a.mandate));
    const commitment = executionCommitment({ mandateDigest, candidateDigest: keccak256(encodeGateCandidate(a.candidate)), terms: a.terms });
    const record = (ok: boolean, reason: string | null, gasEstimate: bigint | null) =>
      this.#hooks.onSimulated({ ok, reason, gasEstimate, deadline: a.terms.deadline, mandateDigest, commitment, calldataBytes: (call.calldata.length - 2) / 2 });
    const fail = (reason: string): Simulation => {
      record(false, reason, null);
      return { ok: false, revert: reason };
    };
    if (this.#authorization === null) return fail('CHAIN_NOT_BOUND');
    const now = await this.#rpc.latest();
    if (!now.ok) return fail(`CHAIN_TIME_UNREADABLE.${now.error}`);
    const bad = checkCall(call, this.#s, this.#d, this.#authorization, now.value.timestamp);
    if (bad !== null) return fail(`CALL_NOT_BOUND.${bad}`);
    const id = await this.#rpc.chainId();
    if (!id.ok || id.value !== ROBINHOOD_TESTNET) return fail(id.ok ? `WRONG_CHAIN.${id.value}` : `CHAIN_ID_UNREADABLE.${id.error}`);
    const sim = await this.#rpc.simulateExecute(this.#s.gate, call);
    if (!sim.ok) return fail(`ETH_CALL_REVERTED.${sim.revert}`);
    const gas = await this.#rpc.estimateExecute(this.#s.gate, call);
    if (!gas.ok) return fail(`ESTIMATE_FAILED.${gas.error}`);
    this.#simulated = { calldata: call.calldata, gas: gas.value };
    record(true, null, gas.value);
    if (this.#mode === 'DRY_RUN') return { ok: false, revert: DRY_RUN_HALT };
    if (this.#gate.state !== 'AUTHORIZED') return { ok: false, revert: SEND_NOT_AUTHORIZED };
    return sim;
  }

  async submit(call: GateCall): Promise<Submission> {
    if (this.#mode !== 'SEND' || this.#simulated === null || this.#simulated.calldata !== call.calldata) return { kind: 'UNKNOWN', error: 'CALL_NOT_THE_SIMULATED_CALL' };
    // One broadcast per authorization phrase, ever: a second call finds the gate consumed.
    if (!this.#gate.consume()) return { kind: 'UNKNOWN', error: SEND_NOT_AUTHORIZED };
    const id = await this.#rpc.chainId();
    if (!id.ok || id.value !== ROBINHOOD_TESTNET) return { kind: 'UNKNOWN', error: id.ok ? `WRONG_CHAIN.${id.value}` : `CHAIN_ID_UNREADABLE.${id.error}` };
    const s = this.#s;
    const block = await this.#rpc.latest();
    const [tin, tout, agentOut] = await Promise.all([this.#rpc.tokenBalance(s.tokenIn, s.recipient), this.#rpc.tokenBalance(s.tokenOut, s.recipient), this.#rpc.tokenBalance(s.tokenOut, s.agent)]);
    if (!block.ok || !tin.ok || !tout.ok || !agentOut.ok) return { kind: 'UNKNOWN', error: 'PRE_BROADCAST_BALANCES_UNREADABLE' };
    this.#hooks.onBefore({ block: block.value.number, tokenIn: tin.value, tokenOut: tout.value, agentTokenOut: agentOut.value });
    const prepared = await this.#rpc.prepareExecute(s.gate, call, (this.#simulated.gas * 13n) / 10n);
    if (!prepared.ok) return { kind: 'UNKNOWN', error: `PREPARE.${prepared.error}` };
    if (prepared.value.to !== s.gate) return { kind: 'UNKNOWN', error: 'PREPARED_TARGET_NOT_GATE' };
    this.#prepared = prepared.value;
    const p = prepared.value;
    this.#hooks.onSubmissionStarted({ hash: p.hash, nonce: p.nonce, gasLimit: p.gasLimit, maxFeePerGas: p.maxFeePerGas, from: p.from, to: p.to });
    this.#broadcasts += 1;
    const sent = await this.#rpc.broadcast(p);
    if (sent.kind === 'ACCEPTED' && sent.hash === p.hash) {
      this.#hooks.onBroadcast({ hash: p.hash, outcome: 'ACCEPTED', detail: 'ACCEPTED' });
      return { kind: 'SENT', txHash: p.hash };
    }
    // Ambiguous: the node may have taken it. Ask about this exact hash; never sign or send another.
    const detail = sent.kind === 'ERROR' ? sent.error.slice(0, 120) : 'RETURNED_OTHER_HASH';
    for (let i = 0; i < 3; i += 1) {
      const known = await this.#rpc.transactionKnown(p.hash);
      if (known.ok && known.value) {
        this.#hooks.onBroadcast({ hash: p.hash, outcome: 'AMBIGUOUS_KNOWN', detail });
        return { kind: 'SENT', txHash: p.hash };
      }
    }
    this.#hooks.onBroadcast({ hash: p.hash, outcome: sent.kind === 'ERROR' && /^RPC_/.test(sent.error) ? 'REJECTED' : 'AMBIGUOUS_UNKNOWN', detail });
    return { kind: 'UNKNOWN', error: `BROADCAST_UNCONFIRMED:${p.hash}` };
  }

  receipt(txHash: string): Promise<Read<Receipt>> {
    return this.#rpc.receipt(txHash);
  }
}
