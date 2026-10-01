/**
 * One Live AI Stock decision, settled on Robinhood Chain testnet — or not.
 *
 * ```text
 * LiveSession.reservedExecutions ─▶ the one reserved Stock child (AuthorizedExecution)
 *   ─▶ eligibility (12 conditions, re-derived) ─▶ testnet settlement fixture (quantity-preserving)
 *   ─▶ journal PREPARED (B.5.3) ─▶ portfolio ADMIT_ATTEMPT naming the settlement binding (B.5.3)
 *   ─▶ preflight (chain id 46630 from the RPC, code hashes = manifest, balances, allowance, gas)
 *   ─▶ domain leg: GateSpotPolicy authorization of exactly this BUY in the 7E.3 domain ledger
 *   ─▶ existing GateSigner: ADMIT_ATTEMPT ─▶ guarded custody (eligibility again) ─▶ agent signature
 *   ─▶ simulate: exact-call check, journal the artifact, eth_call, estimateGas
 *        DRY_RUN: stop — nothing is broadcast
 *        SEND:    only through an open SendGate, only with a durable journal, never for a wallet-approved
 *                 version ─▶ journal hash + envelope ─▶ one broadcast ─▶ journal SUBMITTED ─▶ receipt
 *                 ─▶ journal CONFIRMED_* ─▶ postconditions ─▶ journal SETTLED ─▶ portfolio CONSUME + CLOSE
 *                 ─▶ journal CONSUMED
 * ```
 *
 * The journal (journal.ts) is written ahead of every point where something
 * could leave the process, so a crash anywhere leaves a record a restart can
 * reconcile (reconcile.ts) without guessing. It has no authority: the
 * portfolio ledger's attempt and consumption, and the gate's replay key, do.
 *
 * Model output never reaches this module except as the closed-set candidate
 * id and amount Mandate already reserved. Every event it emits is safe: no
 * key, no raw transaction, no calldata.
 */

import { ByteWriter } from '@mandate/kernel';
import { keccakDigest, type Digest32 } from '@mandate/core';
import type { LedgerState } from '@mandate/ledger';
import type { IssueOutcome, Receipt } from '@mandate/evm-robinhood';
import type { PrincipalAuthorization } from '@mandate/live-agents';
import { GATE_ERRORS, errorSignature, selectorOf } from '@mandate/execution-gate';
import { usdcText, type LiveEventKind, type LiveSession } from '@mandate/live-agents';
import { selectStockExecution, type AuthorizedExecution } from './authorized-execution.ts';
import { explorerTxUrl, type TestnetDeployment } from './deployment.ts';
import { DOMAIN_AUTHORITY_SECONDS, openDomainLeg, domainPolicy, type DomainKeys } from './domain-leg.ts';
import { checkEligibility, type Eligibility, type LiveAuthorityView } from './eligibility.ts';
import { ASSET_QUALIFICATION, settlementEvidence, type SettlementEvidence } from './evidence.ts';
import { mapToFixture, settlementBindingDigest, TESTNET_SETTLEMENT_FIXTURE, type FixtureSettlement } from './fixture-mapping.ts';
import { JournalRefusal, type AttemptRecord, type SettlementJournal } from './journal.ts';
import { admitSettlement, admittedFor, consumeReservation } from './portfolio-ledger.ts';
import { preflight, type PreflightReport } from './preflight.ts';
import type { ChainReader, TestnetRpc } from './rpc.ts';
import { SEND_AUTHORIZATION_PHRASE, type SendGate } from './send-gate.ts';
import { DRY_RUN_HALT, SEND_NOT_AUTHORIZED, SettlementGateChain, type SettlementMode, type SimulationRecord } from './settlement-chain.ts';

const MDUSD_DECIMALS = 6n;
const MDEMO_DECIMALS = 18n;
const decimal = (atoms: bigint, decimals: bigint): string => {
  const scale = 10n ** decimals;
  const frac = (atoms % scale).toString().padStart(Number(decimals), '0').replace(/0+$/, '');
  return `${atoms / scale}${frac === '' ? '' : `.${frac}`}`;
};

const ERRORS = new Map(Object.entries(GATE_ERRORS).map(([name, types]) => [selectorOf(errorSignature(name, types)), name]));
ERRORS.set(selectorOf('ERC20InsufficientAllowance(address,uint256,uint256)'), 'ERC20InsufficientAllowance');
ERRORS.set(selectorOf('ERC20InsufficientBalance(address,uint256,uint256)'), 'ERC20InsufficientBalance');
/** A revert or refusal, decoded to a name where the gate's error table knows it; never more than a short code. */
export function safeReason(r: string): string {
  const m = /(0x[0-9a-f]{8})[0-9a-f]*$/i.exec(r);
  const named = m === null ? undefined : ERRORS.get((m[1] as string).toLowerCase());
  const prefix = r.replace(/0x[0-9a-fA-F]{9,}/g, '').slice(0, 96);
  return named === undefined ? prefix : `${prefix}${named}`;
}

/** Balances immediately before the broadcast. */
export interface Before {
  readonly block: bigint;
  readonly tokenIn: bigint;
  readonly tokenOut: bigint;
  readonly agentTokenOut: bigint;
}

/** Public, redistributable facts only. */
export interface SettlementRecord {
  readonly state: 'SUBMISSION_STARTED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN';
  readonly txHash: string;
  readonly chainId: string;
  readonly gate: string;
  readonly reservation: string;
  readonly proposal: string;
  readonly bindingDigest: string;
  readonly detail: string;
}

export interface Postconditions {
  readonly ok: boolean;
  readonly commitmentRecordedOnchain: boolean;
  readonly principalMdusdDelta: string | null;
  readonly principalMdemoDelta: string | null;
  readonly agentMdemoDelta: string | null;
  readonly failures: readonly string[];
}

export type SettlementOutcome =
  | { readonly status: 'INELIGIBLE'; readonly stage: string; readonly reason: string; readonly signatures: 0; readonly broadcasts: 0 }
  | { readonly status: 'PREFLIGHT_FAILED'; readonly preflight: PreflightReport; readonly signatures: 0; readonly broadcasts: 0 }
  | { readonly status: 'REFUSED'; readonly stage: string; readonly reason: string; readonly signatures: number; readonly broadcasts: 0; readonly simulation: SimulationRecord | null }
  | { readonly status: 'READY'; readonly preflight: PreflightReport; readonly simulation: SimulationRecord; readonly wouldSend: WouldSend; readonly signatures: number; readonly broadcasts: 0 }
  | { readonly status: 'SUBMITTED_UNCONFIRMED'; readonly txHash: string; readonly detail: string; readonly signatures: number; readonly broadcasts: 1; readonly evidence: SettlementEvidence }
  | { readonly status: 'CONFIRMED'; readonly txHash: string; readonly receipt: Receipt; readonly receiptDigest: string; readonly postconditions: Postconditions; readonly evidence: SettlementEvidence; readonly signatures: number; readonly broadcasts: 1; readonly wouldSend: WouldSend; readonly explorerUrl: string | null }
  | { readonly status: 'FAILED'; readonly txHash: string | null; readonly reason: string; readonly receipt: Receipt | null; readonly evidence: SettlementEvidence; readonly signatures: number; readonly broadcasts: 0 | 1 };

/** The transaction the settlement would send (or sent), described safely. */
export interface WouldSend {
  readonly network: string;
  readonly chainId: string;
  readonly to: string;
  readonly function: 'MandateExecutionGate.execute';
  readonly from: string;
  readonly principal: string;
  readonly agent: string;
  readonly recipient: string;
  readonly tokenIn: { readonly symbol: 'MDUSD'; readonly address: string; readonly atoms: string; readonly amount: string };
  readonly tokenOut: { readonly symbol: 'MDEMO'; readonly address: string; readonly atoms: string; readonly amount: string };
  readonly gasEstimate: string | null;
  readonly deadline: string;
  readonly mandateDigest: string;
  readonly executionCommitment: string;
  readonly qualification: string;
}

export interface SettlementEnv {
  readonly session: LiveSession;
  readonly deployment: TestnetDeployment;
  readonly rpc: TestnetRpc;
  readonly keys: DomainKeys;
}

/**
 * Points a crash test may stop the process at (`fault`): each is just after
 * the named durable write, before the next one.
 */
export const FAULT_POINTS = ['AFTER_PREPARED', 'AFTER_PORTFOLIO_ATTEMPT', 'AFTER_DOMAIN_BOUND', 'AFTER_ARTIFACT_JOURNALED', 'AFTER_TX_HASH_PERSISTED', 'AFTER_BROADCAST_ACCEPTED', 'AFTER_SUBMITTED', 'AFTER_RECEIPT', 'AFTER_CONFIRMED', 'AFTER_SETTLED', 'AFTER_CONSUMED'] as const;
export type FaultPoint = (typeof FAULT_POINTS)[number];

export interface RunOptions {
  readonly mode: SettlementMode;
  readonly gate: SendGate;
  /** The SQLite file for this attempt's domain ledger (durable for a send; scratch for a dry run). */
  readonly ledgerPath: string;
  /** Legacy B.5.2 public record of a submission (settlement.json); the journal is the durable one. */
  readonly record?: (r: SettlementRecord) => void;
  /** The durable settlement journal. Required for a send. */
  readonly journal?: SettlementJournal;
  /** Crash tests: called at each fault point. */
  readonly fault?: (p: FaultPoint) => void;
}

/** Who authorized what, as every settlement event states it: the portfolio principal is never presented as the domain signer. */
export interface PrincipalBinding {
  readonly portfolio: { readonly method: string; readonly address: string };
  readonly protocolSigner: string;
  readonly domainSettlement: { readonly kind: 'TESTNET_FIXTURE_CUSTODY'; readonly address: string };
  readonly delegation: 'NOT_DELEGATED';
}

export function principalBinding(a: PrincipalAuthorization | undefined, d: TestnetDeployment): PrincipalBinding {
  return {
    portfolio: { method: a?.method ?? 'UNKNOWN', address: a?.principal ?? 'UNKNOWN' },
    protocolSigner: a?.protocolSigner ?? 'UNKNOWN',
    domainSettlement: { kind: 'TESTNET_FIXTURE_CUSTODY', address: d.principal },
    delegation: 'NOT_DELEGATED',
  };
}

/** Each lifecycle event of a send is appended at most once per reservation, however often it is reconciled. */
export function lifecycleDedupe(reservation: string, kind: string): string {
  return `settlement:${reservation}:${kind}`;
}

export interface Prepared {
  readonly execution: AuthorizedExecution;
  readonly settlement: FixtureSettlement;
}

/** The settlement path for one Live AI session. At most one broadcast per instance, ever. */
export class LiveSettlement {
  readonly #env: SettlementEnv;
  #submitted = false;
  #ledger: LedgerState | null = null;

  constructor(env: SettlementEnv) {
    this.#env = env;
  }

  #emit(kind: LiveEventKind, data: { readonly [k: string]: unknown }, dedupe?: string): void {
    this.#env.session.events.emit(kind, { agent: 'stock', data: { ...data, rpcProvider: this.#env.rpc.provenance(), qualification: ASSET_QUALIFICATION }, ...(dedupe === undefined ? {} : { dedupe }) });
  }

  /** Re-read the committed portfolio ledger the reservation lives in. */
  async #refresh(version: number): Promise<void> {
    const v = this.#env.session.versions.coreOf(version);
    this.#ledger = v === null ? null : (await v.core.engine.read(v.mandate.principal)).state;
  }

  /** Eligibility as of now: the session's version state is read live; the ledger as of the last refresh. */
  #eligibility(x: AuthorizedExecution, continuing?: string): Eligibility {
    const s = this.#env.session;
    if (this.#ledger === null) return { eligible: false, condition: 6, reason: 'LEDGER_UNREADABLE' };
    const view: LiveAuthorityView = { active: s.versions.active, paused: s.versions.paused, ledger: this.#ledger, now: s.protocolNow(), ...(continuing === undefined ? {} : { continuing }) };
    return checkEligibility(view, x);
  }

  /** Select, check and map. Emits `DOMAIN_EXECUTION_INELIGIBLE` and returns `null` when there is nothing to settle. */
  async prepare(): Promise<Prepared | { readonly ineligible: string; readonly stage: string }> {
    const sel = selectStockExecution(this.#env.session.reservedExecutions);
    const refuse = (stage: string, reason: string, extra: { readonly [k: string]: unknown } = {}) => {
      this.#emit('DOMAIN_EXECUTION_INELIGIBLE', { stage, reason, transactions: 0, ...extra });
      return { ineligible: reason, stage };
    };
    if (!sel.ok) return refuse('SELECT', sel.reason);
    const x = sel.execution;
    await this.#refresh(x.version);
    const m = mapToFixture(x, this.#env.deployment);
    if (!m.ok) return refuse('FIXTURE', m.reason, { proposal: x.proposal });
    // An attempt this settlement admitted (an earlier dry run, or a crash) is its own: eligibility accepts that one only.
    const e = this.#eligibility(x, m.value.bindingDigest);
    if (!e.eligible) return refuse('ELIGIBILITY', e.reason, { condition: e.condition, proposal: x.proposal });
    return { execution: x, settlement: m.value };
  }

  /** The preflight report for a prepared settlement, emitted as TESTNET_PREFLIGHT_*. */
  async preflight(p: Prepared | null): Promise<PreflightReport> {
    this.#emit('TESTNET_PREFLIGHT_STARTED', { network: this.#env.deployment.networkName, expectedChainId: this.#env.deployment.chainId });
    const r = await preflight(this.#env.rpc, this.#env.deployment, p === null ? null : { debit: p.settlement.debit, quantity: p.settlement.quantity });
    this.#emit(r.ok ? 'TESTNET_PREFLIGHT_PASSED' : 'TESTNET_PREFLIGHT_FAILED', { ...r });
    return r;
  }

  #wouldSend(s: FixtureSettlement, sim: SimulationRecord | null): WouldSend {
    const d = this.#env.deployment;
    return {
      network: d.networkName,
      chainId: d.chainId.toString(),
      to: s.gate,
      function: 'MandateExecutionGate.execute',
      from: this.#env.rpc.submitter,
      principal: d.principal,
      agent: d.agent,
      recipient: s.recipient,
      tokenIn: { symbol: 'MDUSD', address: s.tokenIn, atoms: s.debit.toString(), amount: decimal(s.debit, MDUSD_DECIMALS) },
      tokenOut: { symbol: 'MDEMO', address: s.tokenOut, atoms: s.quantity.toString(), amount: decimal(s.quantity, MDEMO_DECIMALS) },
      gasEstimate: sim?.gasEstimate?.toString() ?? null,
      deadline: sim?.deadline.toString() ?? '',
      mandateDigest: sim?.mandateDigest ?? '',
      executionCommitment: sim?.commitment ?? '',
      qualification: ASSET_QUALIFICATION,
    };
  }

  /**
   * Run the settlement in `mode`. A DRY_RUN never broadcasts. A SEND
   * refuses before building anything unless the gate is already open, and
   * never sends more than once for this session.
   */
  async run(p: Prepared, o: RunOptions): Promise<SettlementOutcome> {
    const { session, deployment: d, rpc } = this.#env;
    const s = p.settlement;
    const x = p.execution;
    const j = o.journal ?? null;
    const fault = (f: FaultPoint) => o.fault?.(f);
    const authorization = session.versions.records.find((r) => r.version === x.version)?.authorization;
    const principals = principalBinding(authorization, d);
    const ids = { proposal: x.proposal, candidate: x.candidateDigest, child: x.child, reservation: x.reservation, receiptDigest: x.receiptDigest, bindingDigest: s.bindingDigest, fixture: TESTNET_SETTLEMENT_FIXTURE.id, mode: o.mode, sessionId: session.id, principals };
    const ineligible = (stage: string, reason: string): SettlementOutcome => {
      this.#emit('DOMAIN_EXECUTION_INELIGIBLE', { ...ids, stage, reason, transactions: 0 });
      return { status: 'INELIGIBLE', stage, reason, signatures: 0, broadcasts: 0 };
    };
    if (o.mode === 'SEND') {
      if (this.#submitted) return ineligible('SEND_GATE', 'ALREADY_SUBMITTED_IN_THIS_SESSION');
      if (j === null) return ineligible('JOURNAL', 'DURABLE_JOURNAL_REQUIRED_FOR_SEND');
      // A wallet approval authorizes the portfolio mandate, not the 7E.3 custody: settling under it would misstate the binding.
      if (authorization?.method !== 'DEMO_PRINCIPAL_KEY') return ineligible('PRINCIPAL', 'WALLET_PRINCIPAL_NOT_DELEGATED_TO_DOMAIN');
      if (o.gate.state !== 'AUTHORIZED') {
        this.#emit('TESTNET_SEND_AUTHORIZATION_REFUSED', { ...ids, required: SEND_AUTHORIZATION_PHRASE, transactions: 0 });
        return ineligible('SEND_GATE', SEND_NOT_AUTHORIZED);
      }
      // A stub or scripted decision is never settled on the live network.
      if (rpc.transport === 'ROBINHOOD_TESTNET_RPC' && session.provider.kind !== 'LIVE') return ineligible('SEND_GATE', 'LIVE_MODEL_REQUIRED_FOR_TESTNET_SEND');
    }
    let existing: AttemptRecord | null;
    try {
      existing = j?.get(x.reservation) ?? null;
    } catch {
      return ineligible('JOURNAL', 'JOURNAL_CORRUPT');
    }
    // Past PREPARED, or with a send leg already opened, an attempt is only ever reconciled, never run again.
    if (existing !== null && existing.state !== 'PREPARED') return ineligible('JOURNAL', `ATTEMPT_${existing.state}_RECONCILE_ONLY`);
    if (existing !== null && existing.domainOpenedAt !== null) return ineligible('JOURNAL', 'SEND_LEG_ALREADY_OPENED_RECONCILE_ONLY');
    await this.#refresh(x.version);
    const e = this.#eligibility(x, s.bindingDigest);
    if (!e.eligible) return ineligible('ELIGIBILITY', `${e.condition}.${e.reason}`);
    // The portfolio ledger holds an attempt this journal never recorded: whoever made it may have signed. Reconcile, never send.
    if (o.mode === 'SEND' && existing === null && this.#ledger !== null && admittedFor(this.#ledger, x.reservation) !== null) return ineligible('JOURNAL', 'PORTFOLIO_ATTEMPT_WITHOUT_JOURNAL_RECORD');
    // The settlement must be exactly the fixture's derivation from this execution: nothing is taken on trust, nothing rebuilt.
    const again = mapToFixture(x, d);
    if (!again.ok || again.value.bindingDigest !== s.bindingDigest || settlementBindingDigest(s) !== s.bindingDigest || again.value.actionNonce !== s.actionNonce) return ineligible('FIXTURE', 'SETTLEMENT_NOT_DERIVED_FROM_EXECUTION');

    if (j !== null) {
      try {
        j.prepare({ reservation: x.reservation, session: session.id, proposal: x.proposal, candidate: x.candidateDigest, child: x.child, action: x.action, agent: x.reserved.signed.proposal.agent.value, version: x.version, principal: principals.portfolio.address, authorizationMethod: principals.portfolio.method, chainId: d.chainId.toString(), gate: s.gate, binding: s.bindingDigest, evidenceClass: rpc.transport });
      } catch (err) {
        return ineligible('JOURNAL', err instanceof JournalRefusal ? err.code : 'JOURNAL_WRITE_FAILED');
      }
      fault('AFTER_PREPARED');
    }
    // The portfolio ledger's own one-attempt-per-reservation, before any domain key is used.
    const core = session.versions.coreOf(x.version)?.core;
    if (core === undefined) return ineligible('PORTFOLIO_ATTEMPT', 'VERSION_UNKNOWN');
    const admitted = await admitSettlement(core, x, s.bindingDigest, session.protocolNow());
    if (!admitted.ok) return ineligible('PORTFOLIO_ATTEMPT', admitted.reason);
    fault('AFTER_PORTFOLIO_ATTEMPT');
    this.#emit('SETTLEMENT_ATTEMPT_PREPARED', { ...ids, portfolioAttempt: admitted.fresh ? 'ADMITTED' : 'EXISTING', journal: j === null ? 'NONE' : 'PREPARED', note: 'The portfolio ledger now records one settlement attempt for this reservation: no second, independent attempt can be admitted.' });

    const pre = await this.preflight(p);
    if (!pre.ok) return { status: 'PREFLIGHT_FAILED', preflight: pre, signatures: 0, broadcasts: 0 };

    // Filled by the chain's hooks while the signer runs.
    const seen: { simulation: SimulationRecord | null; before: Before | null } = { simulation: null, before: null };
    const record = (state: SettlementRecord['state'], txHash: string, detail: string) =>
      o.record?.({ state, txHash, chainId: d.chainId.toString(), gate: s.gate, reservation: x.reservation, proposal: x.proposal, bindingDigest: s.bindingDigest, detail });
    const chain = new SettlementGateChain(rpc, s, d, o.mode, o.gate, {
      onSimulationStarted: () => this.#emit('TESTNET_SIMULATION_STARTED', { ...ids, target: s.gate, method: 'eth_call + eth_estimateGas' }),
      onArtifact: (a) => {
        j?.recordArtifact({ reservation: x.reservation, mandateDigest: a.mandateDigest, commitment: a.commitment, deadline: a.deadline.toString(), mode: o.mode });
        fault('AFTER_ARTIFACT_JOURNALED');
      },
      onSimulated: (r) => {
        seen.simulation = r;
        this.#emit(r.ok ? 'TESTNET_SIMULATION_PASSED' : 'TESTNET_SIMULATION_FAILED', { ...ids, target: s.gate, gasEstimate: r.gasEstimate, reason: r.reason === null ? null : safeReason(r.reason), deadline: r.deadline, mandateDigest: r.mandateDigest, executionCommitment: r.commitment });
      },
      onBefore: (b) => {
        seen.before = b;
      },
      onSubmissionStarted: (t) => {
        this.#submitted = true;
        const b = seen.before;
        // Write-ahead: the hash and envelope are on disk before the one broadcast.
        j?.startSubmission(x.reservation, { hash: t.hash, from: t.from, to: t.to, nonce: t.nonce.toString(), calldataDigest: t.calldataDigest, value: '0', gasLimit: t.gasLimit.toString(), maxFeePerGas: t.maxFeePerGas.toString(), maxPriorityFeePerGas: '0' }, { block: (b?.block ?? 0n).toString(), tokenIn: (b?.tokenIn ?? 0n).toString(), tokenOut: (b?.tokenOut ?? 0n).toString(), agentTokenOut: (b?.agentTokenOut ?? 0n).toString() });
        record('SUBMISSION_STARTED', t.hash, 'signed; broadcasting once');
        this.#emit('TESTNET_TX_SUBMISSION_STARTED', { ...ids, txHash: t.hash, from: t.from, to: t.to, nonce: t.nonce, gasLimit: t.gasLimit, maxFeePerGas: t.maxFeePerGas, journal: 'SUBMISSION_STARTED' }, lifecycleDedupe(x.reservation, 'TESTNET_TX_SUBMISSION_STARTED'));
        fault('AFTER_TX_HASH_PERSISTED');
      },
      onBroadcast: (b) => {
        const known = b.outcome === 'ACCEPTED' || b.outcome === 'AMBIGUOUS_KNOWN';
        if (known) fault('AFTER_BROADCAST_ACCEPTED');
        record(known ? 'SUBMITTED' : 'UNKNOWN', b.hash, b.outcome);
        if (known) j?.transition(x.reservation, 'SUBMITTED', {}, `broadcast ${b.outcome}`);
        else j?.transition(x.reservation, 'RECONCILIATION_REQUIRED', { quarantine: b.outcome === 'REJECTED' ? 'BROADCAST_REJECTED' : 'AMBIGUOUS_BROADCAST' }, `broadcast ${b.outcome}: ${b.detail}`);
        if (known) {
          this.#emit('TESTNET_TX_SUBMITTED', { ...ids, txHash: b.hash, broadcast: b.outcome, settled: false, note: 'A transaction hash is not settlement: only a mined receipt with status 1 and verified postconditions is.' }, lifecycleDedupe(x.reservation, 'TESTNET_TX_SUBMITTED'));
          fault('AFTER_SUBMITTED');
        }
      },
    });

    const block = await rpc.latest();
    if (!block.ok) return ineligible('DOMAIN', `CHAIN_TIME_UNREADABLE.${block.error}`);
    const policy = domainPolicy(d);
    const states = await rpc.gateMarkets(policy);
    if (states.status !== 'OK') return ineligible('DOMAIN', `GATE_STATE_UNKNOWN.${states.reason}`);
    if (o.mode === 'SEND' && j !== null) {
      // From here a gate artifact may exist; whatever happens, it is dead once the domain authority expires.
      j.bindDomain(x.reservation, states.block.timestamp, states.block.timestamp + DOMAIN_AUTHORITY_SECONDS + 60n);
      fault('AFTER_DOMAIN_BOUND');
    }
    const opened = await openDomainLeg({ deployment: d, settlement: s, keys: this.#env.keys, ledgerPath: o.ledgerPath, states: states.states, at: states.block.timestamp, chain, eligibleNow: () => this.#eligibility(x, s.bindingDigest) });
    if (!opened.ok) return ineligible(opened.stage, opened.reason);
    const leg = opened.leg;
    try {
      this.#emit('DOMAIN_EXECUTION_READY', {
        ...ids,
        domain: 'robinhood-evm/gate-spot v1',
        adapter: 'robinhood-gate-signer v1',
        domainReservation: leg.record.reservation,
        domainExecutionAuthorization: leg.record.executionId,
        mapping: TESTNET_SETTLEMENT_FIXTURE.rule,
        authorized: { notionalUsdc: usdcText(x.notionalAtoms), quantityMdemoAtoms: s.quantity, debitMdusdAtoms: s.debit },
      });
      await this.#refresh(x.version);
      const fresh = await rpc.gateMarkets(leg.policy);
      if (fresh.status !== 'OK') return ineligible('DOMAIN', `GATE_STATE_UNKNOWN.${fresh.reason}`);
      const issued: IssueOutcome = await leg.signer.issueAuthorizedBuy(leg.record, leg.issueContext(fresh.states, fresh.block.timestamp));
      const signatures = leg.custody.signatures();
      const simulation = seen.simulation;
      const would = this.#wouldSend(s, simulation);

      if (issued.status === 'REFUSED') {
        if (issued.stage === 'PREFLIGHT' && issued.reason === DRY_RUN_HALT && o.mode === 'DRY_RUN' && simulation !== null && simulation.ok) {
          return { status: 'READY', preflight: pre, simulation, wouldSend: would, signatures, broadcasts: 0 };
        }
        const reason = safeReason(issued.reason);
        if (issued.reason === SEND_NOT_AUTHORIZED) this.#emit('TESTNET_SEND_AUTHORIZATION_REFUSED', { ...ids, required: SEND_AUTHORIZATION_PHRASE, transactions: 0 });
        this.#emit('DOMAIN_EXECUTION_FAILED', { ...ids, stage: issued.stage, reason, attemptAdmitted: issued.attemptAdmitted, custodyRefusals: leg.custody.refusals(), transactions: 0 });
        return { status: 'REFUSED', stage: issued.stage, reason, signatures, broadcasts: 0, simulation };
      }
      if (issued.status === 'EXISTING') return ineligible('DOMAIN', 'ATTEMPT_ALREADY_EXISTS');
      return await this.#finish(p, o, chain, issued, seen.before, would, signatures, ids, record);
    } finally {
      leg.close();
    }
  }

  async #finish(
    p: Prepared,
    o: RunOptions,
    chain: SettlementGateChain,
    issued: Extract<IssueOutcome, { status: 'ISSUED' }>,
    before: Before | null,
    would: WouldSend,
    signatures: number,
    ids: { readonly [k: string]: unknown },
    record: (state: SettlementRecord['state'], txHash: string, detail: string) => void,
  ): Promise<SettlementOutcome> {
    const { session, deployment: d, rpc } = this.#env;
    const s = p.settlement;
    const x = p.execution;
    const j = o.journal ?? null;
    const fault = (f: FaultPoint) => o.fault?.(f);
    const broadcast = chain.broadcasts > 0;
    const hash = issued.txHash !== '' ? issued.txHash : chain.preparedHash;
    const evidenceOf = (receipt: 'SUCCESS' | 'REVERTED' | null, post: boolean, chainId: bigint | null) =>
      settlementEvidence({ transport: rpc.transport, verifiedChainId: chainId, provider: session.provider.kind, dryRun: o.mode === 'DRY_RUN', broadcast, receipt, postconditions: post });
    if (!broadcast || hash === null) {
      this.#emit('DOMAIN_EXECUTION_FAILED', { ...ids, stage: 'SUBMIT', reason: safeReason(issued.detail), transactions: 0 });
      return { status: 'FAILED', txHash: null, reason: safeReason(issued.detail), receipt: null, evidence: evidenceOf(null, false, null), signatures, broadcasts: 0 };
    }
    // Whatever the signer's journal says, the chain is asked about this exact hash; nothing is ever resent.
    const r = await rpc.receipt(hash);
    const receipt: Receipt | null = r.ok ? r.value : null;
    if (receipt === null) {
      record('UNKNOWN', hash, 'no receipt: submitted, not settled; do not resend');
      this.#emit('DOMAIN_EXECUTION_FAILED', { ...ids, stage: 'RECEIPT', txHash: hash, reason: 'NO_RECEIPT', settled: false, next: 'Reconcile this hash: the reservation stays held, nothing is resent.' });
      return { status: 'SUBMITTED_UNCONFIRMED', txHash: hash, detail: safeReason(issued.detail), signatures, broadcasts: 1, evidence: evidenceOf(null, false, null) };
    }
    fault('AFTER_RECEIPT');
    const id = await rpc.chainId();
    const chainId = id.ok ? id.value : null;
    const receiptDigest = digestReceipt(d, hash, receipt, issued.mandateDigest, issued.commitment, s.bindingDigest);
    const explorerUrl = explorerTxUrl(d, hash);
    const receiptFacts = { status: receipt.status, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice.toString() };
    j?.transition(x.reservation, receipt.status === 'SUCCESS' ? 'CONFIRMED_SUCCESS' : 'CONFIRMED_REVERT', { receipt: receiptFacts, observation: receiptDigest }, `mined ${receipt.status} in block ${receipt.blockNumber}`);
    fault('AFTER_CONFIRMED');
    if (receipt.status !== 'SUCCESS') {
      record('FAILED', hash, 'mined REVERTED');
      const evidence = evidenceOf('REVERTED', false, chainId);
      this.#emit('TESTNET_TX_FAILED', { ...ids, txHash: hash, block: receipt.blockNumber, status: 'REVERTED', gasUsed: receipt.gasUsed, receiptDigest, evidence, explorerUrl, reservation: x.reservation, next: 'Held until the gate deadline passes with no execution recorded; then released by reconciliation.' }, lifecycleDedupe(x.reservation, 'TESTNET_TX_FAILED'));
      this.#emit('DOMAIN_EXECUTION_FAILED', { ...ids, stage: 'RECEIPT', txHash: hash, reason: 'MINED_REVERTED', evidence });
      return { status: 'FAILED', txHash: hash, reason: 'MINED_REVERTED', receipt, evidence, signatures, broadcasts: 1 };
    }
    const post = await checkPostconditions(rpc, s, receipt, issued.mandateDigest, issued.commitment, before);
    const evidence = evidenceOf('SUCCESS', post.ok, chainId);
    const confirmed = {
      ...ids,
      network: d.networkName,
      chainId,
      txHash: hash,
      block: receipt.blockNumber,
      status: 'SUCCESS',
      target: s.gate,
      signer: rpc.submitter,
      principal: d.principal,
      agent: d.agent,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      assets: 'MDUSD → MDEMO',
      authorized: { notionalUsdc: usdcText(x.notionalAtoms), debit: `${would.tokenIn.amount} MDUSD`, quantity: `${would.tokenOut.amount} MDEMO` },
      mandateDigest: issued.mandateDigest,
      executionCommitment: issued.commitment,
      receiptDigest,
      postconditions: post,
      evidence,
      explorerUrl,
    };
    if (!post.ok) {
      // Economic execution may have happened: quarantined, never released, never resent.
      j?.transition(x.reservation, 'RECONCILIATION_REQUIRED', { quarantine: 'POSTCONDITION_ANOMALY', postconditions: { ok: false, failures: post.failures } }, `mined SUCCESS but postconditions failed: ${post.failures.join(',')}`);
      record('FAILED', hash, `mined SUCCESS but postconditions failed: ${post.failures.join(',')}`);
      this.#emit('TESTNET_TX_CONFIRMED', confirmed, lifecycleDedupe(x.reservation, 'TESTNET_TX_CONFIRMED'));
      this.#emit('DOMAIN_EXECUTION_FAILED', { ...ids, stage: 'POSTCONDITIONS', txHash: hash, reason: post.failures.join(','), evidence, reservationStatus: 'QUARANTINED', next: 'Settlement needs review. No retry was sent and the reservation is not released.' }, lifecycleDedupe(x.reservation, 'POSTCONDITION_ANOMALY'));
      return { status: 'CONFIRMED', txHash: hash, receipt, receiptDigest, postconditions: post, evidence, signatures, broadcasts: 1, wouldSend: would, explorerUrl };
    }
    j?.transition(x.reservation, 'SETTLED', { postconditions: { ok: true, failures: [] } }, `mined SUCCESS; postconditions verified; ${evidence}`);
    record('CONFIRMED', hash, `mined SUCCESS; postconditions verified; ${evidence}`);
    fault('AFTER_SETTLED');
    const core = session.versions.coreOf(x.version)?.core;
    const consumed = core === undefined ? ({ ok: false, reason: 'VERSION_UNKNOWN' } as const) : await consumeReservation(core, x.reservation, receiptDigest as Digest32, session.protocolNow());
    if (consumed.ok) {
      j?.transition(x.reservation, 'CONSUMED', {}, `portfolio reservation consumed at ledger version ${consumed.ledgerVersion}`);
      fault('AFTER_CONSUMED');
    }
    this.#emit('TESTNET_TX_CONFIRMED', confirmed, lifecycleDedupe(x.reservation, 'TESTNET_TX_CONFIRMED'));
    this.#emit('DOMAIN_EXECUTION_SETTLED', { ...confirmed, lifecycle: 'RESERVED → SUBMISSION_STARTED → SUBMITTED → CONFIRMED_SUCCESS → SETTLED → CONSUMED' }, lifecycleDedupe(x.reservation, 'DOMAIN_EXECUTION_SETTLED'));
    if (consumed.ok) this.#emit('RESERVATION_CONSUMED', { ...ids, txHash: hash, receiptDigest, ledgerVersion: consumed.ledgerVersion, effect: 'The portfolio reservation is consumed and closed in the durable ledger: it can never authorize another execution.' }, lifecycleDedupe(x.reservation, 'RESERVATION_CONSUMED'));
    else this.#emit('DOMAIN_EXECUTION_FAILED', { ...ids, stage: 'CONSUME', txHash: hash, reason: consumed.reason, next: 'Settled onchain; the consumption is retried by reconciliation. The reservation is never released.' });
    return { status: 'CONFIRMED', txHash: hash, receipt, receiptDigest, postconditions: post, evidence, signatures, broadcasts: 1, wouldSend: would, explorerUrl };
  }

}

/**
 * What the gate promised, observed on chain at the receipt's block: the
 * commitment recorded for exactly this gate mandate, the principal debited
 * exactly the fixture debit and credited exactly the quantity, the agent
 * credited nothing. Deltas are measured from the balances journaled just
 * before the broadcast; anything else moving them is an anomaly, never
 * explained away.
 */
export async function checkPostconditions(reader: ChainReader, s: FixtureSettlement, receipt: Receipt, mandateDigest: string, commitment: string, before: Before | null): Promise<Postconditions> {
  const failures: string[] = [];
  const at = receipt.blockNumber;
  const [commit, tin, tout, agentOut] = await Promise.all([reader.executionCommitmentOf(s.gate, mandateDigest, at), reader.tokenBalance(s.tokenIn, s.recipient, at), reader.tokenBalance(s.tokenOut, s.recipient, at), reader.tokenBalance(s.tokenOut, s.agent, at)]);
  const recorded = commit.ok && commit.value === commitment;
  if (!recorded) failures.push('COMMITMENT_NOT_RECORDED');
  const delta = (after: { ok: true; value: bigint } | { ok: false; error: string }, b: bigint | null) => (after.ok && b !== null ? after.value - b : null);
  const dIn = delta(tin, before?.tokenIn ?? null);
  const dOut = delta(tout, before?.tokenOut ?? null);
  const dAgent = delta(agentOut, before?.agentTokenOut ?? null);
  if (dIn === null || dIn !== -s.debit) failures.push('PRINCIPAL_MDUSD_DELTA_NOT_DEBIT');
  if (dOut === null || dOut !== s.quantity) failures.push('PRINCIPAL_MDEMO_DELTA_NOT_QUANTITY');
  if (dAgent === null || dAgent !== 0n) failures.push('UNEXPECTED_RECIPIENT');
  return { ok: failures.length === 0, commitmentRecordedOnchain: recorded, principalMdusdDelta: dIn?.toString() ?? null, principalMdemoDelta: dOut?.toString() ?? null, agentMdemoDelta: dAgent?.toString() ?? null, failures };
}

/** keccak over the receipt facts the settlement relies on, bound to the gate artifact and the settlement. */
export function digestReceipt(d: TestnetDeployment, txHash: string, r: Receipt, mandateDigest: string, commitment: string, binding: Digest32): string {
  const w = new ByteWriter().str('mandate/live-settlement/testnet-receipt').u16(1);
  w.u64(d.chainId).str(txHash).u64(r.blockNumber).str(r.blockHash).str(r.status).u256(r.gasUsed).u256(r.effectiveGasPrice).str(d.gate.address).str(mandateDigest).str(commitment).str(binding);
  return keccakDigest<Digest32>(w.finish());
}
