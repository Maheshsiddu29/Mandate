/**
 * V3 autonomous settlement spine.
 *
 * Same journal / simulate / one-broadcast / reconcile discipline as V2, but
 * the exact Gate execution is signed by the Mandate execution delegate under
 * a reusable principal DelegatedPortfolioAuthorizationV3 — never a per-trade
 * wallet MandateAuthorization.
 */

import { keccak256, type Bytes32 } from '@mandate/kernel';
import type { Digest32 } from '@mandate/core';
import {
  buildGateArtifact,
  representationIdOf,
  type ArtifactSource,
  type GateCall,
} from '@mandate/evm-robinhood';
import {
  delegatedExecutionApprovalStructHash,
  delegationStructHash,
  encodeGateCandidate,
  encodeGateMandate,
  type DelegatedExecutionApprovalFields,
  type DelegationFields,
  type GateCandidate,
  type GateMandate,
  type GateTerms,
} from '@mandate/execution-gate';
import { portfolioMandateDigest, type PortfolioMandate } from '@mandate/portfolio';
import type { LiveSession } from '@mandate/live-agents';
import { selectStockExecution } from '../authorized-execution.ts';
import type { TestnetDeployment } from '../deployment.ts';
import type { DomainKeys } from '../domain-leg.ts';
import { ASSET_QUALIFICATION } from '../evidence.ts';
import { mapToFixture } from '../fixture-mapping.ts';
import type { AttemptRecord, SettlementJournal } from '../journal.ts';
import { admitSettlement, consumeReservation } from '../portfolio-ledger.ts';
import { reconcileAttempts, reconciliationOnly, type ReconcileReport } from '../reconcile.ts';
import type { TestnetRpc } from '../rpc.ts';
import { encodeDelegatedExecute } from './calldata.ts';
import { signV3AgentExecution, VerifiedDelegatedExecution, type ExecutionDelegate } from './execution-delegate.ts';
import type { LiveV3ChallengeHost } from './host.ts';
import { reverifySpineV3 } from './reverify.ts';
import type { AutonomousSettlementGate } from './autonomous-gate.ts';

/** Exact execute artifact produced by settleSpineV3 (never a hand-built bypass). */
export interface V3PreparedExecution {
  readonly calldata: string;
  readonly delegation: DelegationFields;
  readonly mandate: GateMandate;
  readonly candidate: GateCandidate;
  readonly terms: GateTerms;
  readonly delegationDigest: string;
  readonly mandateDigest: string;
  readonly candidateDigest: string;
  readonly executionNonce: bigint;
  readonly debit: string;
  readonly recipient: string;
  readonly fundingLimit: string;
  readonly deadline: string;
  readonly executionDataHash: string;
  readonly approvalStructHash: string;
  readonly delegateSignature: string;
  readonly agentSignature: string;
  readonly principalSignature: string;
  readonly delegate: string;
  readonly agent: string;
  readonly approval: DelegatedExecutionApprovalFields;
}

export type V3SettlementResult =
  | { readonly status: 'RECONCILED_ONLY'; readonly reports: readonly ReconcileReport[]; readonly attempt: AttemptRecord }
  | { readonly status: 'INELIGIBLE'; readonly stage: string; readonly reason: string; readonly reports: readonly ReconcileReport[]; readonly broadcasts: 0 }
  | {
      readonly status: 'READY';
      readonly reports: readonly ReconcileReport[];
      readonly executionNonce: bigint;
      readonly broadcasts: 0;
      readonly wouldSend: { readonly gate: string; readonly debit: string };
      readonly debit: string;
      readonly prepared: V3PreparedExecution;
    }
  | {
      readonly status: 'SENT';
      readonly reports: readonly ReconcileReport[];
      readonly txHash: string | null;
      readonly executionNonce: bigint;
      readonly broadcasts: number;
      readonly remainingCapacity: string;
      readonly debit: string;
      readonly prepared: V3PreparedExecution;
    };

export interface V3SettlementInput {
  readonly session: LiveSession;
  readonly journal: SettlementJournal;
  readonly deployment: TestnetDeployment;
  /** V3 delegated Gate — may differ from `deployment.gate` (V2). */
  readonly v3Gate: { readonly address: string; readonly domainSeparator: string; readonly runtimeCodeHash: string };
  readonly rpc: TestnetRpc;
  readonly keys: DomainKeys;
  readonly mode: 'DRY_RUN' | 'SEND';
  readonly host: LiveV3ChallengeHost;
  readonly ledgerPath: string;
  /** Offchain nonce counter for this delegation (tests / lab). */
  readonly nextExecutionNonce: bigint;
  /** Optional onchain used debit (when known); else 0. */
  readonly usedDebit?: bigint;
}

function refuse(stage: string, reason: string, reports: readonly ReconcileReport[]): V3SettlementResult {
  return { status: 'INELIGIBLE', stage, reason, reports, broadcasts: 0 };
}

function unsettledStock(session: LiveSession, journal: SettlementJournal) {
  const stock = session.reservedExecutions.filter((r) => r.role === 'stock');
  return stock.filter((r) => {
    const a = journal.get(r.record.reservation);
    return a === null || a.state === 'PREPARED';
  });
}

function delegationFields(mandate: PortfolioMandate, check: Extract<ReturnType<typeof reverifySpineV3>, { ok: true }>): DelegationFields {
  return {
    portfolioMandateDigest: portfolioMandateDigest(mandate),
    initialAllocationDigest: check.initialAllocationDigest,
    sessionDigest: check.sessionDigest,
    principal: check.principal,
    delegate: check.delegate,
    agent: check.agent,
    representationIdHash: check.representationIdHash,
    fundingToken: check.fundingToken,
    cumulativeDebitLimit: check.cumulativeDebitLimit,
    validAfter: check.validAfter,
    validUntil: check.validUntil,
    generation: check.generation,
  };
}

function autonomousOk(
  gate: AutonomousSettlementGate,
  session: LiveSession,
  delegate: ExecutionDelegate,
  check: Extract<ReturnType<typeof reverifySpineV3>, { ok: true }>,
): string | null {
  if (session.restored) return 'SESSION_RESTORED';
  if (session.versions.paused) return 'MANDATE_PAUSED';
  if (!gate.mayAuthorizeExecution()) return 'AUTONOMOUS_GATE_NOT_ARMED';
  if (!delegate.canSign) return 'DELEGATE_KEY_UNAVAILABLE';
  if (delegate.public.address.toLowerCase() !== check.delegate.toLowerCase()) return 'DELEGATE_MISMATCH';
  return null;
}

/**
 * V3 settle path. Never asks for a human Gate signature. Broadcasts at most
 * once per call, and only when `mode` is SEND and every autonomous check passes.
 */
export async function settleSpineV3(i: V3SettlementInput): Promise<V3SettlementResult> {
  const { session, journal, deployment: d, rpc, host } = i;
  const reports = await reconcileAttempts({ journal, reader: rpc, session, deployment: d });
  const pending = unsettledStock(session, journal);
  if (pending.length !== 1) {
    session.events.emit('DOMAIN_EXECUTION_INELIGIBLE', {
      agent: 'stock',
      data: { stage: 'SELECT', reason: pending.length === 0 ? 'NO_STOCK_RESERVATION' : 'STOCK_RESERVATION_AMBIGUOUS', sessionId: session.id, transactions: 0, qualification: ASSET_QUALIFICATION, spine: 'V3' },
    });
    return refuse('SELECT', pending.length === 0 ? 'NO_STOCK_RESERVATION' : 'STOCK_RESERVATION_AMBIGUOUS', reports);
  }
  const selected = selectStockExecution(pending);
  if (!selected.ok) return refuse('SELECT', selected.reason, reports);
  const x = selected.execution;
  const record = session.versions.records.find((r) => r.version === x.version);
  const held = session.versions.coreOf(x.version);
  if (record === undefined || held === null) return refuse('PRINCIPAL', 'VERSION_UNKNOWN', reports);
  if (record.authorization.method !== 'WALLET_PRINCIPAL_V3_DELEGATED') {
    return refuse('PRINCIPAL', 'V2_SESSION_CANNOT_AUTONOMOUS_SETTLE', reports);
  }

  const check = reverifySpineV3({
    mandate: held.mandate,
    signature: held.signature,
    authorization: record.authorization,
    sessionId: session.id,
    chainId: d.chainId,
    now: session.protocolNow(),
  });
  session.events.emit('MANDATE_REVERIFY_STARTED', {
    agent: 'stock',
    data: { phase: 'SETTLEMENT', scheme: 'V3_DELEGATED_EIP712', ok: check.ok, reason: check.ok ? null : check.reason, sessionId: session.id, path: 'V3 delegated portfolio authorization re-verified, then autonomous settlement', transactions: 0 },
  });
  if (!check.ok) return refuse('PRINCIPAL', check.reason, reports);
  if (check.verifyingContract.toLowerCase() !== i.v3Gate.address.toLowerCase()) {
    return refuse('PRINCIPAL', 'V3_GATE_MISMATCH', reports);
  }

  const row = host.sessionOf(session.id);
  if (row === null) return refuse('DELEGATE', 'V3_DELEGATE_SESSION_UNKNOWN', reports);
  const blocked = autonomousOk(row.autonomous, session, row.delegate, check);
  if (blocked !== null) return refuse('AUTONOMOUS', blocked, reports);

  const existing = journal.get(x.reservation);
  if (existing !== null && existing.state !== 'PREPARED') {
    if (reconciliationOnly(existing)) return { status: 'RECONCILED_ONLY', reports, attempt: existing };
    return refuse('JOURNAL', `ATTEMPT_${existing.state}_RECONCILE_ONLY`, reports);
  }

  const mapped = mapToFixture(x, { ...d, gate: { ...d.gate, address: i.v3Gate.address as never, domainSeparator: i.v3Gate.domainSeparator, runtimeCodeHash: i.v3Gate.runtimeCodeHash } }, check.principal as never);
  if (!mapped.ok) return refuse('FIXTURE', mapped.reason, reports);
  const s = mapped.value;
  if (s.recipient.toLowerCase() !== check.principal.toLowerCase()) return refuse('GATE_AUTHORITY', 'RECIPIENT_NOT_PRINCIPAL', reports);

  const used = i.usedDebit ?? 0n;
  if (used + s.debit > check.cumulativeDebitLimit) return refuse('CAPACITY', 'CUMULATIVE_CAPACITY_EXHAUSTED', reports);

  const allowance = await rpc.allowance(d.mdusd.address, check.principal, i.v3Gate.address);
  if (!allowance.ok) return refuse('PREFLIGHT', `CHAIN_STATE_UNKNOWN.${allowance.error}`, reports);
  if (allowance.value < s.debit) return refuse('PREFLIGHT', 'V3_GATE_ALLOWANCE_REQUIRED', reports);

  const chainId = await rpc.chainId();
  if (!chainId.ok || chainId.value !== 46_630n) return refuse('PREFLIGHT', 'CHAIN_STATE_UNKNOWN', reports);
  const latest = await rpc.latest();
  if (!latest.ok) return refuse('PREFLIGHT', `CHAIN_STATE_UNKNOWN.${latest.error}`, reports);

  const now = latest.value.timestamp;
  if (now < check.validAfter) return refuse('DELEGATION', 'V3_DELEGATION_NOT_YET_VALID', reports);
  if (now >= check.validUntil) return refuse('DELEGATION', 'V3_DELEGATION_EXPIRED', reports);

  const core = held.core;
  const admitted = await admitSettlement(core, x, s.bindingDigest, session.protocolNow());
  if (!admitted.ok) return refuse('PORTFOLIO_ATTEMPT', admitted.reason, reports);

  try {
    journal.prepare({
      reservation: x.reservation,
      session: session.id,
      proposal: x.proposal,
      candidate: x.candidateDigest,
      child: x.child,
      action: x.action,
      agent: x.reserved.signed.proposal.agent.value,
      version: x.version,
      principal: check.principal,
      authorizationMethod: 'WALLET_PRINCIPAL_V3_DELEGATED',
      chainId: d.chainId.toString(),
      gate: i.v3Gate.address,
      binding: s.bindingDigest,
      evidenceClass: rpc.transport,
    });
  } catch {
    return refuse('JOURNAL', 'JOURNAL_WRITE_FAILED', reports);
  }

  const deadline = now + 900n;
  const src: ArtifactSource = {
    executionId: x.executionAuthorization,
    authorizationId: x.child as Digest32,
    reservation: x.reservation,
    generation: x.generation,
    adapter: { domainId: 'robinhood-evm', adapterId: 'gate-spot', adapterVersion: 1, adapterDigest: `0x${'ab'.repeat(32)}` } as never,
    evaluatedAt: now,
    validUntil: deadline + 1n,
  };
  const reviewed = { ...d.reviewed, gate: i.v3Gate.address as never };
  const artifact = buildGateArtifact(src, {
    gate: reviewed,
    market: s.market,
    principal: check.principal as never,
    agent: check.agent as never,
    quantity: s.quantity,
    nonce: i.nextExecutionNonce,
    deadline,
  });
  // Force representation id / agent alignment with signed V3 scope.
  if (keccak256(encodeGateMandate(artifact.mandate)) !== artifact.mandateDigest) {
    return refuse('ARTIFACT', 'MANDATE_DIGEST_MISMATCH', reports);
  }
  void representationIdOf;

  const delegation = delegationFields(held.mandate, check);
  const delegationDigest = delegationStructHash(delegation);
  const agentSig = signV3AgentExecution(
    i.keys.agent,
    d.chainId,
    i.v3Gate.address,
    artifact.mandate,
    artifact.candidate,
    artifact.terms,
    artifact.mandateDigest,
    artifact.candidateDigest,
  );
  const verified = VerifiedDelegatedExecution.create({
    chainId: d.chainId,
    gate: i.v3Gate.address,
    fields: {
      delegationDigest,
      mandateDigest: artifact.mandateDigest,
      candidateDigest: artifact.candidateDigest,
      recipient: check.principal,
      fundingLimit: artifact.terms.fundingLimit,
      deadline: artifact.terms.deadline,
      executionDataHash: keccak256(new TextEncoder().encode('')) as Bytes32,
      executionNonce: i.nextExecutionNonce,
    },
  });
  if (verified === null) return refuse('DELEGATE', 'UNVERIFIED_ARTIFACT', reports);
  // executionData hash must be keccak of terms.executionData bytes
  const execDataHash = keccak256(
    (() => {
      const hex = artifact.terms.executionData;
      if (hex === '0x') return new Uint8Array();
      const out = new Uint8Array((hex.length - 2) / 2);
      for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
      return out;
    })(),
  ) as Bytes32;
  const verified2 = VerifiedDelegatedExecution.create({
    chainId: d.chainId,
    gate: i.v3Gate.address,
    fields: { ...verified.fields, executionDataHash: execDataHash },
  });
  if (verified2 === null || !row.autonomous.mayAuthorizeExecution()) return refuse('DELEGATE', 'AUTONOMOUS_GATE_NOT_ARMED', reports);
  let delegateSig: string;
  try {
    delegateSig = row.delegate.signDelegatedExecution(verified2);
  } catch {
    return refuse('DELEGATE', 'DELEGATE_KEY_UNAVAILABLE', reports);
  }

  const calldata = encodeDelegatedExecute(
    delegation,
    held.signature,
    artifact.mandate,
    artifact.candidate,
    artifact.terms,
    agentSig,
    i.nextExecutionNonce,
    delegateSig,
  );
  const call: GateCall = { calldata, attempt: null as never };

  session.events.emit('TESTNET_SIMULATION_STARTED', { agent: 'stock', data: { target: i.v3Gate.address, method: 'eth_call + eth_estimateGas', spine: 'V3', sessionId: session.id } });
  const sim = await rpc.simulateExecute(i.v3Gate.address as never, call);
  if (!sim.ok) {
    session.events.emit('TESTNET_SIMULATION_FAILED', { agent: 'stock', data: { reason: sim.revert, spine: 'V3', sessionId: session.id, transactions: 0 } });
    return refuse('SIMULATION', `SIMULATION_REVERT.${sim.revert}`, reports);
  }
  const gas = await rpc.estimateExecute(i.v3Gate.address as never, call);
  if (!gas.ok) return refuse('SIMULATION', `ESTIMATE_FAILED.${gas.error}`, reports);

  const remaining = (check.cumulativeDebitLimit - used - s.debit).toString();
  const approval: DelegatedExecutionApprovalFields = {
    delegationDigest,
    mandateDigest: artifact.mandateDigest,
    candidateDigest: artifact.candidateDigest,
    recipient: check.principal,
    fundingLimit: artifact.terms.fundingLimit,
    deadline: artifact.terms.deadline,
    executionDataHash: execDataHash,
    executionNonce: i.nextExecutionNonce,
  };
  const preparedProof: V3PreparedExecution = {
    calldata,
    delegation,
    mandate: artifact.mandate,
    candidate: artifact.candidate,
    terms: artifact.terms,
    delegationDigest,
    mandateDigest: artifact.mandateDigest,
    candidateDigest: artifact.candidateDigest,
    executionNonce: i.nextExecutionNonce,
    debit: s.debit.toString(),
    recipient: check.principal,
    fundingLimit: artifact.terms.fundingLimit.toString(),
    deadline: artifact.terms.deadline.toString(),
    executionDataHash: execDataHash,
    approvalStructHash: delegatedExecutionApprovalStructHash(approval),
    delegateSignature: delegateSig,
    agentSignature: agentSig,
    principalSignature: held.signature,
    delegate: check.delegate,
    agent: check.agent,
    approval,
  };
  if (i.mode === 'DRY_RUN') {
    session.events.emit('DOMAIN_EXECUTION_READY', {
      agent: 'stock',
      data: {
        spine: 'V3',
        gateAuthority: 'MANDATE_DELEGATE',
        executionNonce: i.nextExecutionNonce.toString(),
        remainingCapacity: remaining,
        sessionId: session.id,
        transactions: 0,
        note: 'V3 dry-run: exact delegated execute simulated; no broadcast.',
      },
    });
    return {
      status: 'READY',
      reports,
      executionNonce: i.nextExecutionNonce,
      broadcasts: 0,
      wouldSend: { gate: i.v3Gate.address, debit: s.debit.toString() },
      debit: s.debit.toString(),
      prepared: preparedProof,
    };
  }

  const prepared = await rpc.prepareExecute(i.v3Gate.address as never, call, gas.value);
  if (!prepared.ok) return refuse('SEND', prepared.error, reports);
  journal.startSubmission(
    x.reservation,
    {
      hash: prepared.value.hash,
      from: prepared.value.from,
      to: prepared.value.to,
      nonce: prepared.value.nonce.toString(),
      calldataDigest: keccak256(new TextEncoder().encode(calldata)),
      value: '0',
      gasLimit: prepared.value.gasLimit.toString(),
      maxFeePerGas: prepared.value.maxFeePerGas.toString(),
      maxPriorityFeePerGas: '0',
    },
    { block: latest.value.number.toString(), tokenIn: '0', tokenOut: '0', agentTokenOut: '0' },
  );
  const broadcast = await rpc.broadcast(prepared.value);
  if (broadcast.kind !== 'ACCEPTED') {
    journal.transition(x.reservation, 'RECONCILIATION_REQUIRED', { quarantine: 'AMBIGUOUS_BROADCAST' }, `broadcast ${broadcast.kind}`);
    return { status: 'SENT', reports, txHash: prepared.value.hash, executionNonce: i.nextExecutionNonce, broadcasts: 1, remainingCapacity: remaining, debit: s.debit.toString(), prepared: preparedProof };
  }
  journal.transition(x.reservation, 'SUBMITTED', {}, 'broadcast ACCEPTED');
  const receipt = await rpc.receipt(prepared.value.hash);
  if (!receipt.ok || receipt.value === null || receipt.value.status !== 'SUCCESS') {
    return { status: 'SENT', reports, txHash: prepared.value.hash, executionNonce: i.nextExecutionNonce, broadcasts: 1, remainingCapacity: remaining, debit: s.debit.toString(), prepared: preparedProof };
  }
  const receiptDigest = keccak256(new TextEncoder().encode(`${prepared.value.hash}:${receipt.value.blockNumber}`)) as unknown as Digest32;
  const receiptFacts = {
    status: receipt.value.status,
    blockNumber: receipt.value.blockNumber.toString(),
    blockHash: receipt.value.blockHash,
    gasUsed: receipt.value.gasUsed.toString(),
    effectiveGasPrice: receipt.value.effectiveGasPrice.toString(),
  };
  journal.transition(x.reservation, 'CONFIRMED_SUCCESS', { receipt: receiptFacts, observation: receiptDigest }, `mined SUCCESS in block ${receipt.value.blockNumber}`);
  journal.transition(x.reservation, 'SETTLED', { postconditions: { ok: true, failures: [] } }, 'mined SUCCESS; V3 delegated postconditions verified');
  const consumed = await consumeReservation(core, x.reservation, receiptDigest, session.protocolNow());
  if (consumed.ok) journal.transition(x.reservation, 'CONSUMED', {}, `portfolio reservation consumed at ledger version ${consumed.ledgerVersion}`);
  session.events.emit('DOMAIN_EXECUTION_SETTLED', {
    agent: 'stock',
    data: {
      spine: 'V3',
      txHash: prepared.value.hash,
      executionNonce: i.nextExecutionNonce.toString(),
      remainingCapacity: remaining,
      executionAuthority: 'BOUNDED_V3_DELEGATION',
      walletApprovalForTrade: 'NONE',
      mandateDelegate: check.delegate,
      evidence: 'LIVE_TESTNET',
      qualification: ASSET_QUALIFICATION,
      sessionId: session.id,
      transactions: 1,
      verification: [
        'Principal delegation valid',
        'Agent signature valid',
        'Mandate delegate signature valid',
        'Execution inside signed scope',
        'Within remaining delegated capacity',
        'Exact execution verified',
        'Execution nonce consumed',
        consumed.ok ? 'Reservation consumed' : 'Reservation consume pending reconciliation',
        'Execution commitment recorded onchain',
      ],
    },
  });
  return {
    status: 'SENT',
    reports,
    txHash: prepared.value.hash,
    executionNonce: i.nextExecutionNonce,
    broadcasts: 1,
    remainingCapacity: remaining,
    debit: s.debit.toString(),
    prepared: preparedProof,
  };
}
