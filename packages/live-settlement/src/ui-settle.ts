/**
 * The Live Lab's in-page V2 settlement (docs/demo/authority-spine-v2.md).
 *
 * This is the same spine as `npm run agents:settle:v2`: re-verify the
 * wallet's PortfolioMandateV2 signature, then dry-run or send. It does not
 * skip re-verification and it does not substitute an asset. The browser
 * never broadcasts. When the wallet is not the manifest principal, this
 * returns the gate typed data and waits; the wallet signs
 * `MandateAuthorization` and a later request delivers that signature into
 * the run that is already open. `--send`'s operator phrase is checked here,
 * with the same SendGate, before that run starts. The deployer key still
 * pays gas. A signature is not reused across runs.
 *
 * No environment, file, clock or socket lives here. The composition script
 * opens those and passes them in.
 */

import type { LiveSession } from '@mandate/live-agents';
import { selectStockExecution } from './authorized-execution.ts';
import { ASSET_QUALIFICATION } from './evidence.ts';
import type { GateExecutionRequest } from './gate-authority.ts';
import type { SettlementJournal } from './journal.ts';
import type { TestnetRpc } from './rpc.ts';
import { SendGate, SEND_AUTHORIZATION_PHRASE } from './send-gate.ts';
import type { SpineSettlementInput, SpineSettlementResult } from './spine-settlement.ts';
import type { TestnetDeployment } from './deployment.ts';
import type { DomainKeys } from './domain-leg.ts';

type LabJson = string | number | boolean | null | readonly LabJson[] | { readonly [k: string]: LabJson };

export interface LabRouteResponse {
  readonly status: number;
  readonly body: { readonly [k: string]: LabJson };
}

export interface ScratchLedger {
  readonly path: string;
  readonly cleanup: () => void;
}

export interface SpineUiHost {
  readonly openSession: (id: string) => Promise<LiveSession | null>;
  readonly taskOf: (id: string) => 'RUN' | 'POLICY_STRESS' | 'PLAN' | null;
  readonly settle: (input: SpineSettlementInput) => Promise<SpineSettlementResult>;
  readonly deployment: TestnetDeployment;
  readonly rpc: TestnetRpc;
  readonly keys: DomainKeys;
  readonly journalFor: (session: LiveSession) => SettlementJournal;
  readonly scratch: () => ScratchLedger;
  readonly ledgerPath: (session: LiveSession) => string;
  /** Arm a timer. Return a function that cancels it. No timer lives in this module. */
  readonly schedule: (ms: number, fn: () => void) => () => void;
  readonly signatureWaitMs: number;
}

interface Job {
  readonly mode: 'DRY_RUN' | 'SEND';
  phase: 'RUNNING' | 'AWAITING_SIGNATURE';
  request: GateExecutionRequest | null;
  deliver: ((signature: string | null) => void) | null;
  done: Promise<SpineSettlementResult>;
}

const SETTLE_PATH = /^\/api\/live\/sessions\/([A-Za-z0-9-]{1,64})\/settle$/;
const SIG = /^0x[0-9a-fA-F]{130}$/;

const ok = (body: { readonly [k: string]: LabJson }, status = 200): LabRouteResponse => ({ status, body });
const refuse = (status: number, error: string, message: string): LabRouteResponse => ({ status, body: { error, message } });
/** A settle call that did not broadcast. Stage and transaction count are the server's, so the page can show them. */
const denied = (error: string, message: string, facts: { readonly stage: string | null; readonly transactions: number; readonly txHash: string | null }): LabRouteResponse => ({
  status: 409,
  body: { error, message, stage: facts.stage, transactions: facts.transactions, txHash: facts.txHash },
});

function asJson(value: unknown): LabJson {
  return JSON.parse(JSON.stringify(value, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x))) as LabJson;
}

/** The browser's explicit execute action. It is not an asset, an amount, or a calldata field. */
export const BROWSER_EXECUTE_INTENT = 'EXECUTE_ROBINHOOD_TESTNET';

const SETTLEMENT_FIELDS = new Set(['mode', 'gateSignature', 'sendAuthorization', 'cancel', 'intent']);

interface ParsedBody {
  readonly mode: 'DRY_RUN' | 'SEND';
  readonly gateSignature: string | null;
  readonly sendAuthorization: string | null;
  readonly cancel: boolean;
  /** Present only when the browser asked to execute. The CLI uses the operator phrase instead. */
  readonly browserExecute: boolean;
}

function parseBody(body: unknown): { readonly ok: true; readonly value: ParsedBody } | { readonly ok: false; readonly response: LabRouteResponse } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, response: refuse(400, 'BAD_REQUEST', 'POST body must be a JSON object.') };
  const rec = body as { readonly [k: string]: unknown };
  for (const key of Object.keys(rec)) {
    if (!SETTLEMENT_FIELDS.has(key)) return { ok: false, response: refuse(400, 'BAD_REQUEST', `Unexpected field "${key}". Execution parameters are not accepted from the browser.`) };
  }
  const mode = rec['mode'];
  if (mode !== 'DRY_RUN' && mode !== 'SEND') return { ok: false, response: refuse(400, 'BAD_REQUEST', 'mode must be "DRY_RUN" or "SEND".') };
  const gateSignature = rec['gateSignature'];
  if (gateSignature !== undefined && gateSignature !== null && typeof gateSignature !== 'string') return { ok: false, response: refuse(400, 'BAD_REQUEST', 'gateSignature must be the wallet signature.') };
  if (typeof gateSignature === 'string' && (gateSignature.length > 140 || !SIG.test(gateSignature))) return { ok: false, response: refuse(400, 'BAD_REQUEST', 'gateSignature must be a 65-byte hex signature.') };
  const sendAuthorization = rec['sendAuthorization'];
  if (sendAuthorization !== undefined && sendAuthorization !== null && typeof sendAuthorization !== 'string') return { ok: false, response: refuse(400, 'BAD_REQUEST', 'sendAuthorization must be the operator phrase.') };
  if (typeof sendAuthorization === 'string' && sendAuthorization.length > 80) return { ok: false, response: refuse(400, 'BAD_REQUEST', 'sendAuthorization is not the operator phrase.') };
  if (rec['cancel'] !== undefined && rec['cancel'] !== true) return { ok: false, response: refuse(400, 'BAD_REQUEST', 'cancel must be true.') };
  const intent = rec['intent'];
  if (intent !== undefined && intent !== BROWSER_EXECUTE_INTENT) return { ok: false, response: refuse(400, 'BAD_REQUEST', 'intent is not an execution request.') };
  if (intent === BROWSER_EXECUTE_INTENT && mode !== 'SEND') return { ok: false, response: refuse(400, 'BAD_REQUEST', 'An execution request must use mode "SEND".') };
  return {
    ok: true,
    value: {
      mode,
      gateSignature: typeof gateSignature === 'string' ? gateSignature : null,
      sendAuthorization: typeof sendAuthorization === 'string' ? sendAuthorization : null,
      cancel: rec['cancel'] === true,
      browserExecute: intent === BROWSER_EXECUTE_INTENT,
    },
  };
}

/**
 * Proof fields for READY · NOT SENT. Read off the reserved Stock child and
 * the signed allocation. A session that has neither (a test double) adds
 * nothing. No signature and no signed transaction.
 */
function stockEvidence(session: LiveSession): { readonly [k: string]: LabJson } {
  if (!Array.isArray(session.reservedExecutions)) return {};
  const selected = selectStockExecution(session.reservedExecutions);
  if (!selected.ok) return {};
  const x = selected.execution;
  const version = session.versions?.records.find((record) => record.version === x.version);
  const initial = version?.authorization.wallet?.initialAllocationDigest ?? null;
  const current = session.reallocationRecords?.filter((record) => record.mandateVersion === x.version).at(-1)?.nextPlanDigest ?? initial;
  return {
    candidateId: x.candidateId,
    proposalDigest: x.proposal,
    candidateDigest: x.candidateDigest,
    childAuthorizationDigest: x.child,
    reservation: x.reservation,
    authorizedNotionalAtoms: x.notionalAtoms.toString(),
    mandateVersion: x.version,
    initialAllocationDigest: initial,
    currentPlanDigest: current,
  };
}

function signResponse(sessionId: string, mode: 'DRY_RUN' | 'SEND', request: GateExecutionRequest): LabRouteResponse {
  return ok({
    status: 'GATE_SIGNATURE_REQUIRED',
    sessionId,
    mode,
    message: 'The wallet must sign MandateAuthorization for this execution. This signs execution authority. It is not a transaction. Nothing has been broadcast.',
    gateExecution: asJson({
      kind: request.kind,
      principal: request.principal,
      agent: request.agent,
      gate: request.gate,
      chainId: request.chainId,
      mandateDigest: request.mandateDigest,
      signingHash: request.signingHash,
      mandateExpiresAt: request.mandateExpiresAt,
      note: request.note,
      typedData: request.typedData,
    }),
  });
}

/**
 * One settlement job per session. A dry run or send that needs a gate
 * signature parks inside `settleSpine` until the next request delivers it,
 * or until the timer delivers null and the run stops with nothing broadcast.
 */
export class SpineUi {
  readonly #host: SpineUiHost;
  readonly #jobs = new Map<string, Job>();

  constructor(host: SpineUiHost) {
    this.#host = host;
  }

  /** Null when this request is not a settlement route, so the lab handles it. */
  async handle(method: string, path: string, body: unknown): Promise<LabRouteResponse | null> {
    if (method === 'GET' && path === '/api/live/settlement') {
      return ok({
        available: true,
        spine: 'V2',
        chainId: this.#host.deployment.chainId.toString(),
        sendAuthorization: SEND_AUTHORIZATION_PHRASE,
        reverify: 'EIP-712 PortfolioMandateV2',
        gasPayer: 'DEPLOYER',
        walletBroadcasts: false,
      });
    }
    const match = SETTLE_PATH.exec(path);
    if (match === null) return null;
    if (method !== 'POST') return refuse(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
    const id = match[1];
    if (id === undefined) return refuse(400, 'BAD_REQUEST', 'Missing session id.');
    const parsed = parseBody(body);
    if (!parsed.ok) return parsed.response;
    return this.#settle(id, parsed.value);
  }

  async #settle(id: string, body: ParsedBody): Promise<LabRouteResponse> {
    const pending = this.#jobs.get(id);
    if (pending !== undefined && pending.phase === 'AWAITING_SIGNATURE') {
      if (body.mode !== pending.mode) return refuse(409, 'SETTLEMENT_IN_PROGRESS', 'This session is waiting on a signature for a different settlement mode.');
      if (body.cancel) return this.#deliver(id, pending, null);
      if (body.gateSignature === null) {
        const request = pending.request;
        return request === null ? refuse(409, 'SETTLEMENT_IN_PROGRESS', 'Settlement is still preparing the gate typed data.') : signResponse(id, pending.mode, request);
      }
      return this.#deliver(id, pending, body.gateSignature);
    }
    if (pending !== undefined) return refuse(409, 'SETTLEMENT_IN_PROGRESS', 'A settlement is already running for this session.');
    if (body.gateSignature !== null || body.cancel) return refuse(409, 'NO_PENDING_SIGNATURE', 'No gate signature was requested. Start a dry run or send first. A signature from an earlier run is not accepted.');
    if (this.#host.taskOf(id) !== null) return refuse(409, 'BUSY', 'A run is still in progress. Settlement starts after it finishes.');
    const session = await this.#host.openSession(id);
    if (session === null) return refuse(404, 'SESSION_NOT_FOUND', 'No such session.');

    const gate = new SendGate();
    // The CLI phrase and the browser's explicit intent each open the same one-shot gate. The body still cannot name an asset.
    const opened = body.mode === 'SEND' && (body.browserExecute ? gate.authorize(`${SEND_AUTHORIZATION_PHRASE}\n`) : gate.authorize(body.sendAuthorization ?? ''));
    if (body.mode === 'SEND' && !opened) {
      session.events.emit('TESTNET_SEND_AUTHORIZATION_REFUSED', { agent: 'stock', data: { required: SEND_AUTHORIZATION_PHRASE, received: 'another text', transactions: 0 } });
      return denied('SEND_NOT_AUTHORIZED', 'Broadcast needs an explicit execution request. Nothing was sent.', { stage: 'SEND_GATE', transactions: 0, txHash: null });
    }

    const journal = this.#host.journalFor(session);
    const scratch = body.mode === 'DRY_RUN' ? this.#host.scratch() : null;
    const job: Job = { mode: body.mode, phase: 'RUNNING', request: null, deliver: null, done: Promise.resolve({ status: 'INELIGIBLE', stage: 'INTERNAL', reason: 'NOT_STARTED', reports: [] }) };
    let cancelTimer: (() => void) | null = null;
    let deliverSignature: ((signature: string | null) => void) | null = null;
    const signature = new Promise<string | null>((resolve) => {
      deliverSignature = (value) => {
        cancelTimer?.();
        cancelTimer = null;
        resolve(value);
      };
    });
    job.deliver = (value) => deliverSignature?.(value);
    let asked: ((request: GateExecutionRequest) => void) | null = null;
    const askedPromise = new Promise<GateExecutionRequest>((resolve) => {
      asked = resolve;
    });

    let done: Promise<SpineSettlementResult>;
    try {
      done = this.#host.settle({
        session,
        journal,
        deployment: this.#host.deployment,
        rpc: this.#host.rpc,
        keys: this.#host.keys,
        mode: body.mode,
        gate,
        ledgerPath: scratch === null ? this.#host.ledgerPath(session) : scratch.path,
        resolveGateExecution: (request) => {
          job.phase = 'AWAITING_SIGNATURE';
          job.request = request;
          session.events.emit('GATE_EXECUTION_SIGNATURE_REQUIRED', {
            agent: 'stock',
            data: {
              sessionId: session.id,
              mode: body.mode,
              principal: request.principal,
              agentAddress: request.agent,
              gate: request.gate,
              chainId: request.chainId,
              mandateDigest: request.mandateDigest,
              signingHash: request.signingHash,
              note: request.note,
              typedData: request.typedData,
              transactions: 0,
              qualification: ASSET_QUALIFICATION,
            },
          });
          cancelTimer = this.#host.schedule(this.#host.signatureWaitMs, () => deliverSignature?.(null));
          asked?.(request);
          return signature;
        },
      });
    } catch {
      journal.close();
      scratch?.cleanup();
      return refuse(500, 'INTERNAL', 'The settlement could not be started. Nothing was broadcast.');
    }
    job.done = done.finally(() => {
      cancelTimer?.();
      journal.close();
      scratch?.cleanup();
      if (this.#jobs.get(id) === job) this.#jobs.delete(id);
    });
    // A rejection after the HTTP response has already returned must not surface as unhandled.
    void job.done.then(
      () => undefined,
      () => undefined,
    );
    this.#jobs.set(id, job);

    try {
      const first = await Promise.race([
        done.then((result) => ({ kind: 'DONE' as const, result })),
        askedPromise.then((request) => ({ kind: 'SIGN' as const, request })),
      ]);
      if (first.kind === 'SIGN') return signResponse(session.id, body.mode, first.request);
      return this.#finish(session, first.result);
    } catch {
      return refuse(500, 'INTERNAL', 'The settlement could not be completed. Nothing further was broadcast.');
    }
  }

  async #deliver(id: string, job: Job, signature: string | null): Promise<LabRouteResponse> {
    const session = await this.#host.openSession(id);
    if (session === null) return refuse(404, 'SESSION_NOT_FOUND', 'No such session.');
    job.deliver?.(signature);
    try {
      return this.#finish(session, await job.done);
    } catch {
      return refuse(500, 'INTERNAL', 'The settlement could not be completed. Nothing further was broadcast.');
    }
  }

  #finish(session: LiveSession, result: SpineSettlementResult): LabRouteResponse {
    if (result.status === 'READY') {
      const would = result.outcome.wouldSend;
      session.events.emit('SPINE_DRY_RUN_READY', {
        agent: 'stock',
        data: {
          sessionId: session.id,
          spine: 'V2',
          evidenceClass: 'DRY_RUN',
          broadcast: false,
          transactions: 0,
          note: 'Re-verified. Dry run READY. Nothing was broadcast.',
          principals: result.principals,
          network: would.network,
          chainId: would.chainId,
          gate: would.to ?? null,
          principal: would.principal ?? null,
          recipient: would.recipient ?? null,
          mandateDigest: would.mandateDigest ?? null,
          gasEstimate: would.gasEstimate ?? null,
          simulationDeadline: would.deadline ?? null,
          tokenIn: would.tokenIn,
          tokenOut: would.tokenOut,
          qualification: ASSET_QUALIFICATION,
          ...stockEvidence(session),
        },
      });
      return ok({ status: 'READY', sessionId: session.id, transactions: 0, broadcast: false, message: 'Re-verified. Dry run READY. Nothing was broadcast.' });
    }
    if (result.status === 'RECONCILED_ONLY') {
      return ok({
        status: 'RECONCILED_ONLY',
        sessionId: session.id,
        attemptState: result.attempt.state,
        message: result.attempt.state === 'CONSUMED' ? 'Already settled. Reconciliation only; nothing is resent.' : `The reservation's attempt is ${result.attempt.state}. Reconciliation only; nothing is resent.`,
      });
    }
    if (result.status === 'INELIGIBLE') {
      const message = result.reason === 'GATE_EXECUTION_AUTHORITY_REQUIRED' ? 'No gate signature was provided. Nothing was broadcast. Dry-run again to request a new MandateAuthorization.' : `${result.stage}: ${result.reason}. Nothing was broadcast.`;
      return denied(result.reason, message, { stage: result.stage, transactions: 0, txHash: null });
    }
    if (result.status === 'NOT_READY') return denied('NOT_READY', `The dry run did not reach READY (${result.outcome.status}). Nothing was broadcast.`, { stage: result.outcome.status, transactions: 0, txHash: null });
    const outcome = result.outcome;
    if (outcome.status === 'CONFIRMED') {
      return ok({
        status: 'SENT',
        sessionId: session.id,
        outcome: 'CONFIRMED',
        evidence: outcome.evidence,
        txHash: outcome.txHash,
        explorerUrl: outcome.explorerUrl,
        transactions: 1,
        message: outcome.evidence === 'LIVE_TESTNET' ? 'Confirmed on Robinhood Chain testnet.' : 'The transaction was mined. It is not labelled LIVE_TESTNET.',
      });
    }
    if (outcome.status === 'SUBMITTED_UNCONFIRMED') return ok({ status: 'SENT', sessionId: session.id, outcome: outcome.status, txHash: outcome.txHash, evidence: outcome.evidence, transactions: 1, message: 'Submitted. A transaction hash is not settlement.' });
    if (outcome.status === 'FAILED') return denied(outcome.reason, `${outcome.evidence}: ${outcome.reason}`, { stage: null, transactions: outcome.broadcasts, txHash: outcome.txHash });
    return denied(outcome.status, `Settlement ended ${outcome.status}. Nothing further was broadcast.`, { stage: outcome.status, transactions: 0, txHash: null });
  }
}
