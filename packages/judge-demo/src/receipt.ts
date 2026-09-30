/**
 * Scene 10: the receipts and the evidence behind the claims.
 *
 * Every Portfolio run produced a real `PORTFOLIO_RECEIPT.V2` whose digest is
 * keccak-256 of its canonical binary encoding (`receiptDigest`). The
 * summary here is a presentation-safe rendering of that receipt: every
 * value is copied from it, nothing is added, and nothing reads it back.
 * **A receipt is evidence only; it is never authority.**
 */

import { PortfolioTag, receiptDigest, type EvidenceClass, type PortfolioReceipt, type ReceiptDigest } from '@mandate/portfolio';
import { grouped, type SceneContext } from './context.ts';
import { codesOf, jsonOf, type Json, type RunId } from './events.ts';
import { short } from './explain.ts';
import type { RobinhoodLiveEvidence } from './evidence.ts';
import { CONFLICT_TIME } from './scenario.ts';

export function receiptSummary(x: SceneContext, r: PortfolioReceipt, digest: ReceiptDigest): { readonly [key: string]: Json } {
  const lotFrom = new Map(r.allocationAfter.lots.map((l) => [l.id as string, l.from === null ? null : x.label(l.from.value)]));
  const lotResource = new Map(r.allocationAfter.lots.map((l) => [l.id as string, l.resource as string]));
  return {
    schema: PortfolioTag.RECEIPT,
    receiptDigest: digest,
    portfolioMandate: r.portfolioMandate,
    principal: r.principal,
    allocationMode: r.allocationMode,
    rounds: r.rounds,
    agents: r.agents.map((a) => ({ agent: a.agent, label: a.label, status: a.status })),
    proposals: r.proposals.map((p) => ({ proposal: p.proposal, agent: x.label(p.agent), round: p.round, kind: p.kind, domain: p.domain, representation: p.representation, venue: p.venue, requested: x.amounts(p.requested) })),
    blocked: r.decisions.filter((d) => d.outcome === 'REJECTED').map((d) => ({ proposal: d.proposal, round: d.round, codes: codesOf(d.reasons), refusal: d.refusal })),
    reductions: r.decisions.filter((d) => d.outcome === 'REDUCE_REQUESTED').map((d) => ({ proposal: d.proposal, round: d.round, codes: codesOf(d.reasons), target: x.amounts(d.target) })),
    releases: r.releases.map((y) => ({ release: y.release, agent: x.label(y.agent), round: y.round, amounts: x.amounts(y.amounts), applied: y.applied })),
    claims: r.allocationAfter.log.flatMap((op) => (op.kind === 'CLAIM' ? [{ agent: x.label(op.agent.value), claim: op.id, lot: op.lot, from: lotFrom.get(op.lot) ?? null, resource: lotResource.get(op.lot) ?? null, atoms: op.amount.toString() }] : [])),
    selectedActions: r.childAuthorizations.map((c) => ({ child: c.child, agent: x.label(c.agent), proposal: c.proposal, candidate: c.authorization.candidate, action: c.action, approved: x.amounts(c.approved) })),
    reservations: r.reservations.map((y) => ({ child: y.child, status: y.status, reservation: y.reservation, generation: y.generation?.toString() ?? null, ledgerVersion: y.ledgerVersion?.toString() ?? null, codes: codesOf(y.reasons) })),
    canonicalAssetDecisions: r.representationDecisions.map((d) => ({ proposal: d.proposal, representation: d.representation, status: d.status, asset: d.asset, codes: [...d.codes] })),
    executions: r.executions.map((e) => ({ child: e.child, status: e.status, evidence: e.evidence, integration: e.integration, integrationEvidence: e.integrationEvidence, transactions: e.transactions })),
    verification: { status: r.verification.status, codes: codesOf(r.verification.reasons) },
    reservedBefore: x.amounts(r.resourcesBefore.reserved.filter((a) => a.atoms > 0n)),
    reservedAfter: x.amounts(r.resourcesAfter.reserved.filter((a) => a.atoms > 0n)),
    transactions: r.transactions,
  };
}

export function emitLiveEvidence(x: SceneContext, e: RobinhoodLiveEvidence): void {
  const stock = x.p.core.compiled.bindings.find((b) => b.evidence === 'LIVE_TESTNET');
  x.log.emit({
    kind: 'LIVE_TESTNET_EVIDENCE',
    status: 'RECORDED',
    domain: stock?.domain ?? null,
    evidence: 'LIVE_TESTNET',
    artifacts: [
      { name: 'gate', value: e.gate.address },
      { name: 'buyTransaction', value: e.buy.transaction },
      { name: 'replayTransaction', value: e.replay.transaction },
      { name: 'mutationTransaction', value: e.amountMutation.transaction },
    ],
    message: `Historical Phase 7E.3 evidence, read from the recorded files (nothing re-executed): on ${e.network} (${e.chainId}) the gate ${short(e.gate.address)} executed BUY ${e.buy.quantity} (tx ${short(e.buy.transaction)}, ${grouped(e.buy.gasUsed)} gas); its replay reverted ${e.replay.revert}; an amount mutation reverted ${e.amountMutation.revert}; an over-budget request was refused offchain with ${e.overBudget.transactions} transactions`,
    data: {
      ...(jsonOf(e) as { readonly [key: string]: Json }),
      integration: stock?.integration ?? null,
      thisRun: 'no testnet transaction; the stock child is handed to the signer and awaits it',
    },
  });
}

export interface ReceiptRun {
  readonly run: RunId;
  readonly time: bigint;
  readonly receipt: PortfolioReceipt;
  readonly digest: ReceiptDigest;
}

export function emitReceipts(x: SceneContext, runs: readonly ReceiptRun[]): void {
  for (const r of runs) {
    const recomputed = receiptDigest(r.receipt);
    if (recomputed !== r.digest) throw new Error(`receipt of the ${r.run} run does not reproduce its digest`);
    const summary = receiptSummary(x, r.receipt, r.digest);
    x.log.emit({
      kind: 'PORTFOLIO_RECEIPT_CREATED',
      status: 'RECORDED',
      run: r.run,
      protocolTime: r.time.toString(),
      artifacts: [
        { name: 'receiptDigest', value: r.digest },
        { name: 'portfolioMandateDigest', value: r.receipt.portfolioMandate },
      ],
      message: `${PortfolioTag.RECEIPT} for the ${r.run} run: ${r.receipt.proposals.length} proposal${r.receipt.proposals.length === 1 ? '' : 's'}, ${r.receipt.decisions.filter((d) => d.outcome === 'REJECTED').length} refused and ${r.receipt.decisions.filter((d) => d.outcome === 'REDUCE_REQUESTED').length} asked to reduce offchain, ${r.receipt.childAuthorizations.length} authorized, ${r.receipt.transactions} transactions — digest ${short(r.digest)}. Evidence, never authority`,
      data: summary,
    });
  }
}

export function emitCompleted(x: SceneContext, runs: readonly ReceiptRun[], evidence: RobinhoodLiveEvidence): void {
  const bindings = x.p.core.compiled.bindings;
  const thisRun = new Map<string, Set<EvidenceClass>>();
  for (const r of runs) {
    for (const e of r.receipt.executions) {
      const child = r.receipt.childAuthorizations.find((c) => c.child === e.child);
      const domain = r.receipt.proposals.find((p) => p.proposal === child?.proposal)?.domain ?? null;
      if (domain !== null) thisRun.set(domain, new Set([...(thisRun.get(domain) ?? []), e.evidence]));
    }
  }
  const final = runs[runs.length - 1]?.receipt;
  x.log.emit({
    kind: 'DEMO_COMPLETED',
    status: 'COMPLETE',
    protocolTime: CONFLICT_TIME.toString(),
    approved: final === undefined ? [] : x.amounts(final.resourcesAfter.reserved.filter((a) => a.atoms > 0n)),
    message: `Agents proposed. Agents negotiated. Mandate authorized. ${runs.length} Portfolio runs, ${runs.reduce((s, r) => s + r.receipt.decisions.filter((d) => d.outcome === 'REJECTED').length, 0)} proposals refused offchain, ${runs.reduce((s, r) => s + r.receipt.childAuthorizations.length, 0)} authorized children, ${runs.reduce((s, r) => s + r.receipt.transactions, 0)} transactions sent. VALID AGENT != VALID ACTION`,
    data: {
      receipts: runs.map((r) => ({ run: r.run, receiptDigest: r.digest })),
      transactions: runs.reduce((s, r) => s + r.receipt.transactions, 0),
      evidence: bindings.map((b) => ({ domain: b.domain, integration: b.integration, integrationEvidence: b.evidence, thisRun: [...(thisRun.get(b.domain) ?? [])].sort(), historicalLiveEvidence: b.evidence === 'LIVE_TESTNET' ? evidence.buy.transaction : null })),
      notClaimed: ['five live integrations', 'five live executions', 'a new testnet transaction in this run', 'a real asset traded', 'a guaranteed return'],
    },
  });
}
