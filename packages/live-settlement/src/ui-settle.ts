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
 * The lab's own session read (`GET /api/live/sessions/:id`) is returned with
 * the durable settlement state under `settlement` (settlement-state.ts), so
 * a reload or a restart restores a held attempt from the journal rather
 * than from page memory. `{ "mode": "RECONCILE" }` runs the same restart
 * reconciliation `settleSpine` starts with, and nothing else: no gate, no
 * signature, no send.
 *
 * No environment, file, clock or socket lives here. The composition script
 * opens those and passes them in.
 */

import type { LiveSession } from '@mandate/live-agents';
import { selectStockExecution } from './authorized-execution.ts';
import { ASSET_QUALIFICATION } from './evidence.ts';
import type { GateExecutionRequest } from './gate-authority.ts';
import type { SettlementJournal } from './journal.ts';
import { reservationStatus, type ReservationStatus } from './portfolio-ledger.ts';
import type { ReconcileDeps, ReconcileReport } from './reconcile.ts';
import type { TestnetRpc } from './rpc.ts';
import { SendGate, SEND_AUTHORIZATION_PHRASE } from './send-gate.ts';
import { durableSettlement, unreadableSettlement, type DurableSettlement, type PendingSettlement } from './settlement-state.ts';
import type { SpineHold, SpineSettlementInput, SpineSettlementResult } from './spine-settlement.ts';
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

export interface V3UiHost {
  readonly host: import('./v3/host.ts').LiveV3ChallengeHost;
  readonly settle: (input: import('./v3/settlement.ts').V3SettlementInput) => Promise<import('./v3/settlement.ts').V3SettlementResult>;
  readonly gate: { readonly address: string; readonly domainSeparator: string; readonly runtimeCodeHash: string };
  /** Next execution nonce per session (starts at 1). */
  readonly nextNonce: (sessionId: string) => bigint;
  readonly markNonceUsed: (sessionId: string, nonce: bigint) => void;
  readonly usedDebit: (sessionId: string) => bigint;
  readonly addDebit: (sessionId: string, debit: bigint) => void;
}

export interface SpineUiHost {
  readonly openSession: (id: string) => Promise<LiveSession | null>;
  readonly taskOf: (id: string) => 'RUN' | 'POLICY_STRESS' | 'PLAN' | null;
  readonly settle: (input: SpineSettlementInput) => Promise<SpineSettlementResult>;
  /** Restart reconciliation over a reader: it cannot send. */
  readonly reconcile: (deps: ReconcileDeps) => Promise<readonly ReconcileReport[]>;
  readonly deployment: TestnetDeployment;
  readonly rpc: TestnetRpc;
  readonly keys: DomainKeys;
  readonly journalFor: (session: LiveSession) => SettlementJournal;
  readonly scratch: () => ScratchLedger;
  readonly ledgerPath: (session: LiveSession) => string;
  /** Arm a timer. Return a function that cancels it. No timer lives in this module. */
  readonly schedule: (ms: number, fn: () => void) => () => void;
  readonly signatureWaitMs: number;
  /** When set, V3 sessions settle autonomously through this host. */
  readonly v3?: V3UiHost;
}

interface Job {
  readonly mode: 'DRY_RUN' | 'SEND';
  phase: 'RUNNING' | 'AWAITING_SIGNATURE';
  request: GateExecutionRequest | null;
  deliver: ((signature: string | null) => void) | null;
  done: Promise<SpineSettlementResult>;
}

const SETTLE_PATH = /^\/api\/live\/sessions\/([A-Za-z0-9-]{1,64})\/settle$/;
const SESSION_READ = /^\/api\/live\/sessions\/([A-Za-z0-9-]{1,64})$/;
const SIG = /^0x[0-9a-fA-F]{130}$/;

const ok = (body: { readonly [k: string]: LabJson }, status = 200): LabRouteResponse => ({ status, body });
const refuse = (status: number, error: string, message: string): LabRouteResponse => ({ status, body: { error, message } });
/** A settle call that did not broadcast. Stage and transaction count are the server's, so the page can show them. */
const denied = (error: string, message: string, facts: { readonly stage: string | null; readonly transactions: number; readonly txHash: string | null; readonly held?: SpineHold }): LabRouteResponse => ({
  status: 409,
  body: {
    error,
    message,
    stage: facts.stage,
    transactions: facts.transactions,
    txHash: facts.txHash,
    // Whether another execute can start: a held attempt is reconciled, never resent.
    held: facts.held !== undefined,
    attemptState: facts.held?.state ?? null,
    heldUntil: facts.held?.until?.toString() ?? null,
  },
});

/** A chain read that could not establish the gate's state or chain time: nothing about the trade was decided. */
const STATE_UNVERIFIED = /^(GATE_STATE_UNKNOWN|CHAIN_TIME_UNREADABLE)\./;

function asJson(value: unknown): LabJson {
  return JSON.parse(JSON.stringify(value, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x))) as LabJson;
}

/** The browser's explicit execute action. It is not an asset, an amount, or a calldata field. */
export const BROWSER_EXECUTE_INTENT = 'EXECUTE_ROBINHOOD_TESTNET';

const SETTLEMENT_FIELDS = new Set(['mode', 'gateSignature', 'sendAuthorization', 'cancel', 'intent']);

interface ParsedBody {
  readonly mode: 'DRY_RUN' | 'SEND' | 'RECONCILE';
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
  if (mode !== 'DRY_RUN' && mode !== 'SEND' && mode !== 'RECONCILE') return { ok: false, response: refuse(400, 'BAD_REQUEST', 'mode must be "DRY_RUN", "SEND" or "RECONCILE".') };
  if (mode === 'RECONCILE' && Object.keys(rec).length !== 1) return { ok: false, response: refuse(400, 'BAD_REQUEST', 'A reconciliation takes no signature, phrase, intent or cancel.') };
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
  readonly #reconciling = new Set<string>();

  constructor(host: SpineUiHost) {
    this.#host = host;
  }

  /**
   * Null when this request is not a settlement route, so the lab handles it.
   * `lab` is the lab's own answer to this request: the session read is that
   * answer with the durable settlement state added.
   */
  async handle(method: string, path: string, body: unknown, lab?: () => Promise<{ readonly status: number; readonly body: unknown }>): Promise<LabRouteResponse | null> {
    const read = SESSION_READ.exec(path);
    if (method === 'GET' && read !== null && lab !== undefined) return this.#sessionRead(read[1] as string, await lab());
    if (method === 'GET' && path === '/api/live/settlement') {
      const v3 = this.#host.v3 !== undefined;
      return ok({
        available: true,
        spine: v3 ? 'V3' : 'V2',
        spines: v3 ? ['V2', 'V3'] : ['V2'],
        chainId: this.#host.deployment.chainId.toString(),
        sendAuthorization: SEND_AUTHORIZATION_PHRASE,
        reverify: v3 ? 'EIP-712 DelegatedPortfolioAuthorizationV3 or PortfolioMandateV2' : 'EIP-712 PortfolioMandateV2',
        gasPayer: 'DEPLOYER',
        walletBroadcasts: false,
        autonomousV3: v3,
        v3Gate: v3 ? this.#host.v3!.gate.address : null,
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
    if (pending !== undefined || this.#reconciling.has(id)) return refuse(409, 'SETTLEMENT_IN_PROGRESS', 'A settlement is already running for this session.');
    if (body.gateSignature !== null || body.cancel) return refuse(409, 'NO_PENDING_SIGNATURE', 'No gate signature was requested. Start a dry run or send first. A signature from an earlier run is not accepted.');
    if (this.#host.taskOf(id) !== null) return refuse(409, 'BUSY', 'A run is still in progress. Settlement starts after it finishes.');
    const session = await this.#host.openSession(id);
    if (session === null) return refuse(404, 'SESSION_NOT_FOUND', 'No such session.');
    if (body.mode === 'RECONCILE') return this.#reconcile(session);

    const versions = session.versions;
    const activeAuth = versions === undefined || versions.active === null
      ? null
      : versions.records.find((r) => r.version === versions.active!.version)?.authorization.method ?? null;
    if (activeAuth === 'WALLET_PRINCIPAL_V3_DELEGATED') {
      return this.#settleV3(session, body);
    }

    const gate = new SendGate();
    // The phrase and the browser intent are different surfaces. The browser path never types the phrase.
    const opened = body.mode === 'SEND' && (body.browserExecute ? gate.authorizeBrowserIntent() : gate.authorize(body.sendAuthorization ?? ''));
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

  /**
   * V3 autonomous path: no SendGate, no browser Gate signature, no Execute
   * intent. Authority is the reusable DelegatedPortfolioAuthorizationV3.
   */
  async #settleV3(session: LiveSession, body: ParsedBody): Promise<LabRouteResponse> {
    const v3 = this.#host.v3;
    if (v3 === undefined) return refuse(409, 'V3_UNAVAILABLE', 'V3 autonomous settlement is not configured on this lab.');
    if (body.mode !== 'DRY_RUN' && body.mode !== 'SEND') {
      return refuse(409, 'BAD_REQUEST', 'V3 settlement mode must be DRY_RUN or SEND.');
    }
    const mode = body.mode;
    if (body.browserExecute) {
      return refuse(409, 'V3_NO_BROWSER_EXECUTE', 'V3 does not use Execute on Robinhood Testnet. Settlement proceeds under the signed delegated authority.');
    }
    if (body.gateSignature !== null) {
      return refuse(409, 'V3_NO_GATE_SIGNATURE', 'V3 does not accept a per-trade wallet Gate signature.');
    }
    if (session.restored) return refuse(409, 'SESSION_RESTORED', 'A restored session is evidence only. Start a fresh V3 mandate.');
    if (session.versions.paused) return refuse(409, 'MANDATE_PAUSED', 'The mandate is paused. Autonomous settlement is stopped.');

    // Restore public delegate evidence if the process restarted mid-session.
    const auth = session.versions.records.find((r) => r.version === session.versions.active?.version)?.authorization;
    const w = auth?.wallet;
    if (auth?.method === 'WALLET_PRINCIPAL_V3_DELEGATED' && w?.delegate !== undefined && w.domain.verifyingContract !== undefined
      && w.agent !== undefined && w.representationIdHash !== undefined && w.fundingToken !== undefined
      && w.cumulativeDebitLimit !== undefined && w.generation !== undefined && w.initialAllocationDigest !== undefined) {
      if (v3.host.sessionOf(session.id) === null) {
        v3.host.restorePublic(session.id, {
          verifyingContract: w.domain.verifyingContract,
          delegate: w.delegate,
          agent: w.agent,
          representationIdHash: w.representationIdHash,
          fundingToken: w.fundingToken,
          cumulativeDebitLimit: w.cumulativeDebitLimit,
          validAfter: w.validAfter,
          validUntil: w.validUntil,
          generation: w.generation,
        });
      }
    }
    v3.host.arm(session.id);

    let journal: SettlementJournal;
    try {
      journal = this.#host.journalFor(session);
    } catch {
      return refuse(500, 'INTERNAL', 'The settlement journal could not be opened. Nothing was broadcast.');
    }
    const scratch = mode === 'DRY_RUN' ? this.#host.scratch() : null;
    try {
      const nonce = v3.nextNonce(session.id);
      const result = await v3.settle({
        session,
        journal,
        deployment: this.#host.deployment,
        v3Gate: v3.gate,
        rpc: this.#host.rpc,
        keys: this.#host.keys,
        mode,
        host: v3.host,
        ledgerPath: scratch === null ? this.#host.ledgerPath(session) : scratch.path,
        nextExecutionNonce: nonce,
        usedDebit: v3.usedDebit(session.id),
      });
      if (result.status === 'INELIGIBLE') {
        return denied(result.reason, `V3 autonomous settlement refused at ${result.stage}.`, {
          stage: result.stage,
          transactions: 0,
          txHash: null,
        });
      }
      if (result.status === 'READY') {
        // Dry-run advances lab nonce/debit so a second trade cannot reuse nonce 1 offline.
        v3.markNonceUsed(session.id, result.executionNonce);
        v3.addDebit(session.id, BigInt(result.debit));
        return ok({
          status: 'READY',
          sessionId: session.id,
          mode,
          spine: 'V3',
          executionNonce: result.executionNonce.toString(),
          wouldSend: asJson(result.wouldSend),
          transactions: 0,
          message: 'V3 dry-run complete. Exact delegated execute simulated. Nothing was broadcast.',
          ...stockEvidence(session),
        });
      }
      if (result.status === 'SENT') {
        v3.markNonceUsed(session.id, result.executionNonce);
        v3.addDebit(session.id, BigInt(result.debit));
        return ok({
          status: 'SENT',
          sessionId: session.id,
          spine: 'V3',
          executionNonce: result.executionNonce.toString(),
          txHash: result.txHash,
          transactions: result.broadcasts,
          remainingCapacity: result.remainingCapacity,
          executionAuthority: 'BOUNDED_V3_DELEGATION',
          walletApprovalForTrade: 'NONE',
          message: result.broadcasts === 0 ? 'Nothing was broadcast.' : 'V3 autonomous settlement submitted under the signed delegation.',
        });
      }
      return ok({ status: result.status, sessionId: session.id, spine: 'V3', transactions: 0, attempt: asJson(result.attempt) });
    } catch {
      return refuse(500, 'INTERNAL', 'V3 settlement could not be completed. Nothing further was broadcast.');
    } finally {
      journal.close();
      scratch?.cleanup();
    }
  }

  /** Chain evidence only, over the reader: the same pass `settleSpine` opens with. No gate is opened, so nothing can be sent. */
  async #reconcile(session: LiveSession): Promise<LabRouteResponse> {
    let journal: SettlementJournal;
    try {
      journal = this.#host.journalFor(session);
    } catch {
      return refuse(500, 'INTERNAL', 'The settlement journal could not be opened. Nothing was sent.');
    }
    this.#reconciling.add(session.id);
    try {
      const reports = await this.#host.reconcile({ journal, reader: this.#host.rpc, session, deployment: this.#host.deployment });
      this.#reconciling.delete(session.id);
      const state = await this.#durable(session, journal);
      return ok({
        status: 'RECONCILED',
        sessionId: session.id,
        transactions: 0,
        attempts: reports.length,
        settlement: asJson(state),
        message: 'Reconciled from chain evidence only. Nothing was sent.',
      });
    } catch {
      return refuse(500, 'INTERNAL', 'Reconciliation could not be completed. Nothing was sent.');
    } finally {
      this.#reconciling.delete(session.id);
      journal.close();
    }
  }

  #pending(id: string): PendingSettlement {
    if (this.#reconciling.has(id)) return 'RUNNING';
    const job = this.#jobs.get(id);
    return job === undefined ? null : job.phase === 'AWAITING_SIGNATURE' ? 'AWAITING_SIGNATURE' : 'RUNNING';
  }

  /** The journal's attempt for the one reserved Stock child, the ledger's word on it, and whether a settle call is open. */
  async #durable(session: LiveSession, journal: SettlementJournal): Promise<DurableSettlement> {
    const asOf = session.events.events.length;
    const pending = this.#pending(session.id);
    const stock = Array.isArray(session.reservedExecutions) ? session.reservedExecutions.filter((r) => r.role === 'stock') : [];
    const only = stock.length === 1 ? stock[0] : undefined;
    if (only === undefined) return durableSettlement({ reservation: null, reservationState: null, attempt: null, artifacts: [], pending, asOfEvents: asOf });
    const reservation = only.record.reservation;
    try {
      const core = session.versions.coreOf(only.version)?.core;
      const reservationState: ReservationStatus = core === undefined ? 'UNKNOWN' : reservationStatus((await core.engine.read(core.compiled.mandate.principal)).state, reservation);
      return durableSettlement({ reservation, reservationState, attempt: journal.get(reservation), artifacts: journal.artifacts(reservation), pending, asOfEvents: asOf });
    } catch {
      return unreadableSettlement(reservation, pending, asOf);
    }
  }

  async #sessionRead(id: string, base: { readonly status: number; readonly body: unknown }): Promise<LabRouteResponse> {
    const fields = typeof base.body === 'object' && base.body !== null && !Array.isArray(base.body) ? (asJson(base.body) as { readonly [k: string]: LabJson }) : { error: 'INTERNAL', message: 'The session read was not an object.' };
    if (base.status !== 200) return { status: base.status, body: fields };
    const session = await this.#host.openSession(id);
    if (session === null) return { status: base.status, body: fields };
    let state: DurableSettlement;
    try {
      const journal = this.#host.journalFor(session);
      try {
        state = await this.#durable(session, journal);
      } finally {
        journal.close();
      }
    } catch {
      state = unreadableSettlement(null, this.#pending(id), session.events.events.length);
    }
    return { status: base.status, body: { ...fields, settlement: asJson(state) } };
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
      const message =
        result.reason === 'GATE_EXECUTION_AUTHORITY_REQUIRED'
          ? 'No gate signature was provided. Nothing was broadcast. Dry-run again to request a new MandateAuthorization.'
          : STATE_UNVERIFIED.test(result.reason)
            ? `Robinhood Chain testnet state could not be verified (${result.stage}: ${result.reason}). Nothing was sent.`
            : `${result.stage}: ${result.reason}. Nothing was broadcast.`;
      return denied(result.reason, message, { stage: result.stage, transactions: 0, txHash: null, ...(result.held === undefined ? {} : { held: result.held }) });
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
