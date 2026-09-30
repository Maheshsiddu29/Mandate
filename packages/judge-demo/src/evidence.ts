/**
 * Historical LIVE_TESTNET evidence: the Phase 7E.3 Robinhood Chain testnet
 * run, as recorded. **Read-only. Nothing is re-executed, deployed or sent.**
 *
 * The facts come from the two committed, sanitized records —
 * `docs/phase-7e/deployment-manifest.json` and
 * `docs/phase-7e/robinhood-demo-receipt.json` — parsed here strictly. The
 * parser fails closed: a missing field, a malformed hash, a chain or gate
 * the two files disagree on, a dry run, or an execution that did not
 * succeed means there is no LIVE_TESTNET evidence to show, and the demo
 * refuses to claim any.
 *
 * The seam is part of the evidence: the 7E.3 market is the deployed MDEMO /
 * MDUSD fixture market; the judge demo's stock market is the offline Phase
 * 7F gate configuration engineered to settle USDC. The integration path is
 * the same; the market and this run are not live.
 */

import { err, ok, type Result } from '@mandate/kernel';

export interface RecordedTransaction {
  readonly transaction: string;
  readonly status: 'SUCCESS' | 'REVERTED';
  readonly gasUsed: string;
  readonly revert: string | null;
}

export interface RobinhoodLiveEvidence {
  readonly evidenceClass: 'LIVE_TESTNET';
  readonly phase: '7E.3';
  readonly network: string;
  readonly chainId: number;
  /** The CAIP-2 chain the portfolio's stock binding names for the same network. */
  readonly chain: string;
  readonly explorer: string;
  readonly gate: { readonly address: string; readonly deploymentTx: string; readonly block: string; readonly runtimeCodeHash: string; readonly domainSeparator: string };
  readonly fixtureTokens: readonly { readonly symbol: string; readonly name: string; readonly address: string; readonly decimals: number }[];
  readonly principal: string;
  readonly agent: string;
  readonly buy: RecordedTransaction & { readonly block: string; readonly quantity: string; readonly action: string; readonly reservation: string; readonly generation: string; readonly executionCommitment: string; readonly principalFundingBefore: string; readonly principalFundingAfter: string };
  readonly replay: RecordedTransaction;
  readonly amountMutation: RecordedTransaction;
  readonly recipientMutationByEthCall: string;
  readonly targetMutationByEthCall: string;
  readonly overBudget: { readonly quantity: string; readonly projectedCapital: string; readonly refusal: string; readonly transactions: number };
  readonly seam: string;
}

type Obj = { readonly [key: string]: unknown };

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const DECIMAL = /^[0-9]+$/;

class Reader {
  readonly #file: string;
  readonly problems: string[] = [];
  constructor(file: string) {
    this.#file = file;
  }
  obj(o: unknown, path: string): Obj {
    if (typeof o === 'object' && o !== null && !Array.isArray(o)) return o as Obj;
    this.problems.push(`${this.#file}: ${path} is not an object`);
    return {};
  }
  at(o: Obj, path: string): unknown {
    let cur: unknown = o;
    for (const k of path.split('.')) cur = typeof cur === 'object' && cur !== null ? (cur as Obj)[k] : undefined;
    return cur;
  }
  text(o: Obj, path: string, shape?: RegExp): string {
    const v = this.at(o, path);
    if (typeof v !== 'string' || (shape !== undefined && !shape.test(v))) {
      this.problems.push(`${this.#file}: ${path} is missing or malformed`);
      return '';
    }
    return v;
  }
  int(o: Obj, path: string): number {
    const v = this.at(o, path);
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
      this.problems.push(`${this.#file}: ${path} is not an integer`);
      return -1;
    }
    return v;
  }
}

function tx(r: Reader, o: Obj, path: string, status: 'SUCCESS' | 'REVERTED'): RecordedTransaction {
  const got = r.text(o, `${path}.${status === 'SUCCESS' ? 'result' : 'status'}`);
  if (got !== status) r.problems.push(`receipt: ${path} is ${got}, not ${status}`);
  return { transaction: r.text(o, `${path}.transaction`, HASH), status, gasUsed: r.text(o, `${path}.gasUsed`, DECIMAL), revert: status === 'REVERTED' ? r.text(o, `${path}.revert`) : null };
}

/** The recorded evidence, or every reason it cannot be shown as LIVE_TESTNET. */
export function robinhoodEvidenceFrom(manifestJson: unknown, receiptJson: unknown): Result<RobinhoodLiveEvidence, readonly string[]> {
  const rm = new Reader('deployment-manifest.json');
  const rr = new Reader('robinhood-demo-receipt.json');
  const m = rm.obj(manifestJson, '$');
  const r = rr.obj(receiptJson, '$');

  const chainId = rm.int(m, 'network.chainId');
  if (rr.int(r, 'chainId') !== chainId) rr.problems.push('receipt: chainId differs from the manifest');
  if (rr.at(r, 'dryRun') !== false) rr.problems.push('receipt: not a live run (dryRun is not false)');
  const gate = rm.text(m, 'contracts.mandateExecutionGate.address', ADDRESS);
  if (rr.text(r, 'gate', ADDRESS) !== gate) rr.problems.push('receipt: gate differs from the manifest');
  const principal = rm.text(m, 'principal', ADDRESS);
  if (rr.text(r, 'principal', ADDRESS) !== principal) rr.problems.push('receipt: principal differs from the manifest');
  const agent = rm.text(m, 'agent', ADDRESS);
  if (rr.text(r, 'agent', ADDRESS) !== agent) rr.problems.push('receipt: agent differs from the manifest');
  if (rr.text(r, 'authorizedAction.commitmentRecordedOnchain', HASH) !== rr.text(r, 'authorizedAction.executionCommitment', HASH)) rr.problems.push('receipt: the onchain commitment differs from the execution commitment');

  const token = (key: string) => ({ symbol: rm.text(m, `contracts.${key}.symbol`), name: rm.text(m, `contracts.${key}.name`), address: rm.text(m, `contracts.${key}.address`, ADDRESS), decimals: rm.int(m, `contracts.${key}.decimals`) });
  const buy = tx(rr, r, 'authorizedAction', 'SUCCESS');
  const evidence: RobinhoodLiveEvidence = {
    evidenceClass: 'LIVE_TESTNET',
    phase: '7E.3',
    network: rm.text(m, 'network.name'),
    chainId,
    chain: `eip155:${chainId}`,
    explorer: rm.text(m, 'network.explorer'),
    gate: {
      address: gate,
      deploymentTx: rm.text(m, 'contracts.mandateExecutionGate.deploymentTx', HASH),
      block: rm.text(m, 'contracts.mandateExecutionGate.block', DECIMAL),
      runtimeCodeHash: rm.text(m, 'contracts.mandateExecutionGate.runtimeCodeHash', HASH),
      domainSeparator: rm.text(m, 'contracts.mandateExecutionGate.domainSeparator', HASH),
    },
    fixtureTokens: [token('mdemo'), token('mdusd')],
    principal,
    agent,
    buy: {
      ...buy,
      block: rr.text(r, 'authorizedAction.block', DECIMAL),
      quantity: rr.text(r, 'authorizedAction.quantity'),
      action: rr.text(r, 'authorizedAction.action', HASH),
      reservation: rr.text(r, 'authorizedAction.reservation', HASH),
      generation: rr.text(r, 'authorizedAction.generation', DECIMAL),
      executionCommitment: rr.text(r, 'authorizedAction.executionCommitment', HASH),
      principalFundingBefore: rr.text(r, 'authorizedAction.principalMDUSD.before', DECIMAL),
      principalFundingAfter: rr.text(r, 'authorizedAction.principalMDUSD.after', DECIMAL),
    },
    replay: tx(rr, r, 'replay', 'REVERTED'),
    amountMutation: tx(rr, r, 'mutation.amount', 'REVERTED'),
    recipientMutationByEthCall: rr.text(r, 'mutation.recipientByEthCall'),
    targetMutationByEthCall: rr.text(r, 'mutation.targetByEthCall'),
    overBudget: {
      quantity: rr.text(r, 'refusedBeforeTransaction.quantity'),
      projectedCapital: rr.text(r, 'refusedBeforeTransaction.projectedCapital'),
      refusal: rr.text(r, 'refusedBeforeTransaction.refusal'),
      transactions: rr.int(r, 'refusedBeforeTransaction.transactions'),
    },
    seam: 'Phase 7E.3 executed on the deployed gate against the MDEMO/MDUSD testnet fixture market. The judge demo’s stock market is the offline Phase 7F gate configuration engineered to settle USDC; its stock child is handed to the same signer path but nothing is executed in this run.',
  };
  if (evidence.overBudget.transactions !== 0) rr.problems.push('receipt: the over-budget refusal records transactions');
  const problems = [...rm.problems, ...rr.problems];
  return problems.length > 0 ? err(problems) : ok(evidence);
}
