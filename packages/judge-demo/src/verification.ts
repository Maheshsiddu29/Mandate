/**
 * Independent reverification, reservation and handoff, narrated (scene 5,
 * and again for every later run).
 *
 * The checklist is not a list of claims: each line is the result of calling
 * a public Mandate function on the run's own inputs — the same functions the
 * verifier composes — so the judge sees *what* was checked and that it
 * passed. The verdict itself is `verifyPortfolio`'s, and the reservations
 * are the control engine's.
 */

import { actionId } from '@mandate/core';
import {
  agentPolicyOf,
  amountOf,
  assetKey,
  candidateDigest,
  checkBookInvariant,
  checkChildAuthorization,
  compileAction,
  headroom,
  mandateReasons,
  portfolioMandateDigest,
  proposalDigest,
  proposalSignedByAgent,
  releaseDigest,
  releaseSignedByAgent,
  replayAllocation,
  screenProposal,
  type PortfolioRun,
  type ResourceVector,
  type SignedProposal,
} from '@mandate/portfolio';
import type { SceneContext } from './context.ts';
import { codesOf, jsonOf, reasonViews, type Json, type RunId } from './events.ts';
import { because } from './explain.ts';
import type { LedgerSnapshot, ReplayProbe, RoomForgery } from './protocol.ts';
import { EXECUTE_AFTER } from './scenario.ts';

export interface CheckItem {
  readonly id: string;
  readonly check: string;
  /** The public function whose result this line reports. */
  readonly source: string;
  readonly result: 'PASS' | 'FAIL';
  readonly detail: Json;
}

const DIMENSIONS: readonly { readonly id: string; readonly check: string; readonly codes: (code: string) => boolean }[] = [
  { id: 'identity', check: 'canonical asset, exact representation and issuer', codes: (c) => c.startsWith('REGISTRY:') || ['INSTRUMENT_UNKNOWN', 'IDENTITY_CLAIM_MISMATCH', 'ASSET_NOT_ALLOWED', 'REPRESENTATION_NOT_ALLOWED', 'ISSUER_NOT_ALLOWED', 'SYNTHETIC_NOT_ALLOWED', 'REQUIRED_RIGHT_MISSING'].includes(c) },
  { id: 'venue-recipient', check: 'domain, action, chain, venue, route and recipient', codes: (c) => ['DOMAIN_NOT_ALLOWED', 'ACTION_NOT_ALLOWED', 'CHAIN_NOT_ALLOWED', 'VENUE_NOT_ALLOWED', 'ROUTE_NOT_ALLOWED', 'RECIPIENT_NOT_ALLOWED', 'LEVERAGE_NOT_ALLOWED', 'SLIPPAGE_NOT_ALLOWED'].includes(c) },
  { id: 'quote-freshness', check: 'quote freshness, windows and expiry', codes: (c) => ['QUOTE_STALE', 'QUOTE_NOT_ALLOWED', 'PROPOSAL_EXPIRED', 'PROPOSAL_NOT_YET_VALID', 'AGENT_EXPIRED', 'AGENT_NOT_YET_VALID'].includes(c) },
  { id: 'resources', check: 'declared demand = derived demand, within the agent’s and the portfolio’s limits', codes: (c) => ['PROPOSAL_RESOURCES_MISDECLARED', 'AGENT_LIMIT_EXCEEDED', 'PORTFOLIO_LIMIT_EXCEEDED', 'RESOURCE_UNDECLARED', 'RESOURCE_INCOMPARABLE'].includes(c) },
];

const pass = (ok: boolean): 'PASS' | 'FAIL' => (ok ? 'PASS' : 'FAIL');

/** Every line derived from a real call on the run's own inputs. */
export function verifierChecklist(x: SceneContext, run: PortfolioRun, time: bigint): readonly CheckItem[] {
  const m = x.m;
  const bindings = x.p.core.compiled.bindings;
  const sig = x.p.signature;
  const accepted: SignedProposal[] = run.room.proposals.filter((s) => run.room.candidate.accepted.includes(proposalDigest(s.proposal)));
  const screenings = accepted.map((s) => ({ s, r: screenProposal(m, bindings, s, time) }));
  const children = run.verification.status === 'VERIFIED' ? run.verification.children : [];
  const items: CheckItem[] = [];

  const mandate = mandateReasons(m, sig, time);
  items.push({ id: 'mandate', check: 'principal signature, mandate validity and window', source: 'mandateReasons', result: pass(mandate.length === 0), detail: codesOf(mandate) });
  items.push({ id: 'candidate-mandate', check: 'the Room output names this Portfolio Mandate', source: 'portfolioMandateDigest', result: pass(run.room.candidate.portfolioMandate === portfolioMandateDigest(m)), detail: run.room.candidate.portfolioMandate });
  items.push({
    id: 'authentication',
    check: 'every accepted proposal is signed by an agent the mandate names',
    source: 'proposalSignedByAgent, agentPolicyOf',
    result: pass(accepted.every((s) => proposalSignedByAgent(s.proposal, s.signature) && agentPolicyOf(m, s.proposal.agent) !== null)),
    detail: accepted.map((s) => x.label(s.proposal.agent.value)),
  });
  for (const d of DIMENSIONS) {
    const failing = screenings.filter(({ r }) => r.child === null || r.reasons.some((y) => d.codes(y.code)));
    items.push({
      id: d.id,
      check: d.check,
      source: 'screenProposal (resolveCandidate, permits under the agent’s and the portfolio’s scope)',
      result: pass(failing.length === 0),
      detail: screenings.map(({ s, r }) => ({
        agent: x.label(s.proposal.agent.value),
        asset: r.action === null ? null : assetKey(r.action.asset),
        representation: r.action?.representation ?? null,
        issuer: r.action?.issuer ?? null,
        venue: r.action?.venue ?? null,
        recipient: r.action?.recipient ?? null,
        registry: r.registry === null ? null : r.registry.status,
        codes: codesOf(r.reasons.filter((y) => d.codes(y.code))),
      })),
    });
  }
  items.push({
    id: 'child-subset',
    check: 'every child authorization ⊆ its agent ⊆ the portfolio',
    source: 'checkChildAuthorization',
    result: pass(children.length === accepted.length && children.every((v) => checkChildAuthorization(m, v.child).length === 0)),
    detail: children.map((v) => ({ agent: x.label(v.child.agent.value), child: v.digest, notBefore: v.child.notBefore.toString(), expiresAt: v.child.expiresAt.toString(), maxQuoteAgeSeconds: v.child.scope.maxQuoteAgeSeconds?.toString() ?? null })),
  });
  items.push({
    id: 'candidate-binding',
    check: 'each child binds the exact candidate its agent signed',
    source: 'candidateDigest',
    result: pass(children.every((v) => v.child.candidate === candidateDigest(v.candidate) && v.child.proposal === v.proposal)),
    detail: children.map((v) => ({ child: v.digest, candidate: v.child.candidate })),
  });
  const replay = replayAllocation(m, run.room.candidate.allocationLog);
  items.push({
    id: 'allocation-replay',
    check: 'the allocation log replays from the mandate’s initial book, conserving every limit',
    source: 'replayAllocation, checkBookInvariant',
    result: pass(replay.ok && checkBookInvariant(m, replay.value).length === 0),
    detail: { operations: run.room.candidate.allocationLog.length },
  });
  const releaseOps = run.room.candidate.allocationLog.filter((op) => op.kind === 'RELEASE');
  items.push({
    id: 'releases-signed',
    check: 'every release in the log is one its agent signed',
    source: 'releaseSignedByAgent',
    result: pass(releaseOps.every((op) => run.room.signedReleases.some((s) => `release/${releaseDigest(s.release)}` === op.id && releaseSignedByAgent(s.release, s.signature)))),
    detail: { releases: releaseOps.length },
  });
  const claimOps = run.room.candidate.allocationLog.filter((op) => op.kind === 'CLAIM');
  items.push({
    id: 'claims-exact',
    check: 'released authority is reassigned at most once',
    source: 'replayAllocation (lot accounting)',
    result: pass(replay.ok && new Set(claimOps.map((c) => c.id)).size === claimOps.length && replay.value.lots.every((l) => l.remaining >= 0n && l.remaining <= l.amount)),
    detail: { claims: claimOps.length },
  });
  const approved: ResourceVector = run.verification.status === 'VERIFIED' ? run.verification.approved : [];
  items.push({
    id: 'global-limits',
    check: 'what is approved fits what the ledger still has, per resource',
    source: 'availabilityFrom (ledger)',
    result: pass(approved.every((a) => a.atoms <= amountOf(run.before.portfolio, a.resource))),
    detail: approved.map((a) => ({ resource: a.resource, approved: a.atoms.toString(), available: amountOf(run.before.portfolio, a.resource).toString() })),
  });
  items.push({
    id: 'agent-limits',
    check: 'and per agent, within its own ledger headroom',
    source: 'headroom (ledger)',
    result: pass(children.every((v) => v.child.approved.every((a) => a.atoms <= headroom(run.before, v.child.agent.value, a.resource)))),
    detail: children.map((v) => x.label(v.child.agent.value)),
  });
  const actions = children.map((v) => {
    const c = compileAction(x.p.core.compiled, v.child, v.candidate);
    return c.ok ? actionId(c.value.envelope) : null;
  });
  items.push({
    id: 'replay-identity',
    check: 'one signed proposal compiles to exactly one Core action',
    source: 'compileAction, actionId',
    result: pass(actions.every((a) => a !== null) && new Set(actions).size === actions.length && children.every((v, i) => run.records.get(v.digest)?.actionId === actions[i])),
    detail: actions,
  });
  items.push({ id: 'verdict', check: 'the Portfolio Verifier’s verdict', source: 'verifyPortfolio', result: pass(run.verification.status === 'VERIFIED'), detail: run.verification.status === 'VERIFIED' ? 'VERIFIED' : codesOf(run.verification.reasons) });
  items.push({
    id: 'reservation-eligibility',
    check: 'the control engine reserved every verified child atomically',
    source: 'reserveChild (ControlEngine.authorizeAndReserve)',
    result: pass(run.reservations.length === children.length && run.reservations.every((r) => r.status === 'RESERVED')),
    detail: run.reservations.map((r) => r.status),
  });
  return items;
}

export interface VerificationNarration {
  readonly run: RunId;
  readonly time: bigint;
  readonly result: PortfolioRun;
  /** What the agents asked for in this run, for the headline. */
  readonly requested: ResourceVector;
  readonly ledgerBefore: LedgerSnapshot | null;
  readonly ledgerAfter: LedgerSnapshot;
  readonly forgery: RoomForgery | null;
}

export function emitVerification(x: SceneContext, n: VerificationNarration): void {
  const r = n.result;
  const time = n.time.toString();
  x.log.emit({
    kind: 'PORTFOLIO_REVERIFY_STARTED',
    status: 'VERIFYING',
    run: n.run,
    protocolTime: time,
    message: 'The Portfolio Verifier re-derives everything from the principal’s signed mandate and the agents’ signed messages; it trusts nothing the Room computed',
    data: { accepted: [...r.room.candidate.accepted], signedProposals: r.room.proposals.length, signedReleases: r.room.signedReleases.length },
  });
  const checklist = verifierChecklist(x, r, n.time);
  const failed = checklist.filter((c) => c.result === 'FAIL');
  x.log.emit({
    kind: 'VERIFIER_CHECKLIST',
    status: failed.length === 0 && r.verification.status === 'VERIFIED' ? 'VERIFIED' : 'REFUSED',
    run: n.run,
    protocolTime: time,
    reasons: r.verification.status === 'VERIFIED' ? [] : reasonViews(r.verification.reasons),
    message: `${checklist.length - failed.length} of ${checklist.length} independent checks pass; verdict ${r.verification.status}`,
    data: { checklist: checklist.map((c) => ({ id: c.id, check: c.check, source: c.source, result: c.result, detail: c.detail })) },
  });

  if (n.forgery !== null) {
    const f = n.forgery;
    const refused = f.result.status === 'REFUSED';
    x.log.emit({
      kind: 'ROOM_FORGERY_REFUSED',
      status: refused ? 'REFUSED' : 'VERIFIED',
      run: n.run,
      protocolTime: time,
      proposal: f.proposal,
      reasons: f.result.status === 'REFUSED' ? reasonViews(f.result.reasons) : [],
      message: refused
        ? `A forged Room output that also "accepts" the blocked look-alike is REFUSED by the verifier: ${because(codesOf(f.result.status === 'REFUSED' ? f.result.reasons : []))}. The Room cannot create authority`
        : 'A forged Room output was VERIFIED — the verifier did not refuse it',
      data: { forgedAcceptance: f.proposal, verdict: f.result.status },
    });
  }

  const children = r.verification.status === 'VERIFIED' ? r.verification.children : [];
  for (const v of children) {
    const action = r.records.get(v.digest)?.actionId ?? null;
    x.log.emit({
      kind: 'CHILD_AUTHORIZATION_CREATED',
      status: 'CREATED',
      run: n.run,
      protocolTime: time,
      agent: x.agent(v.child.agent.value),
      domain: x.domainOf(v.candidate.kind),
      proposal: v.proposal,
      candidate: v.child.candidate,
      approved: x.amounts(v.child.approved),
      artifacts: [{ name: 'childAuthorizationDigest', value: v.digest }, ...(action === null ? [] : [{ name: 'coreAction', value: action }])],
      message: `${x.label(v.child.agent.value)}: child execution authorization for exactly ${x.money(v.child.approved)} — one candidate, one asset, one venue, one recipient, a window ending ${v.child.expiresAt}`,
      data: { scope: jsonOf(v.child.scope), notBefore: v.child.notBefore.toString(), expiresAt: v.child.expiresAt.toString(), registry: v.registry === null ? null : { status: v.registry.status, codes: [...v.registry.codes] } },
    });
  }
  for (const res of r.reservations) {
    const v = children.find((c) => c.digest === res.child);
    const agent = v?.child.agent.value ?? null;
    x.log.emit({
      kind: 'RESOURCE_RESERVED',
      status: res.status === 'RESERVED' ? 'RESERVED' : 'REFUSED',
      run: n.run,
      protocolTime: time,
      agent: agent === null ? null : x.agent(agent),
      domain: v === undefined ? null : x.domainOf(v.candidate.kind),
      proposal: v?.proposal ?? null,
      approved: v === undefined || res.status !== 'RESERVED' ? [] : x.amounts(v.child.approved),
      reasons: reasonViews(res.reasons),
      artifacts: [
        { name: 'childAuthorizationDigest', value: res.child },
        ...(res.reservation === null ? [] : [{ name: 'reservation', value: res.reservation }]),
        ...(res.executionAuthorization === null ? [] : [{ name: 'executionAuthorization', value: res.executionAuthorization }]),
        ...(res.action === null ? [] : [{ name: 'coreAction', value: res.action }]),
      ],
      message:
        res.status === 'RESERVED'
          ? `Ledger reserves ${v === undefined ? '' : x.money(v.child.approved)} for ${agent === null ? 'the child' : x.label(agent)} atomically (generation ${res.generation}, ledger version ${res.ledgerVersion})`
          : `Ledger refuses the reservation: ${because(codesOf(res.reasons))}`,
      data: { generation: res.generation?.toString() ?? null, ledgerVersion: res.ledgerVersion?.toString() ?? null },
    });
  }

  const decisions = r.room.decisions;
  const authorized = r.verification.status === 'VERIFIED' && r.reservations.every((y) => y.status === 'RESERVED');
  const reservedAfter = r.after.reserved.filter((a) => a.atoms > 0n);
  x.log.emit({
    kind: 'PORTFOLIO_AUTHORIZED',
    status: authorized ? 'AUTHORIZED' : 'REFUSED',
    run: n.run,
    protocolTime: time,
    requested: x.amounts(n.requested),
    approved: x.amounts(r.verification.status === 'VERIFIED' ? r.verification.approved : []),
    message: authorized
      ? `Portfolio AUTHORIZED: ${children.length} child${children.length === 1 ? '' : 'ren'} reserved; ${x.money(r.after.reserved)} of ${x.money(x.m.limits)} portfolio-notional now reserved, ${x.money(r.after.portfolio)} still available`
      : `Portfolio NOT authorized: ${because(codesOf(r.verification.status === 'REFUSED' ? r.verification.reasons : r.reservations.flatMap((y) => y.reasons)))}`,
    data: {
      requested: x.amounts(n.requested),
      reservedAfter: x.amounts(reservedAfter),
      availableAfter: x.amounts(r.after.portfolio),
      children: children.length,
      rejected: decisions.filter((d) => d.outcome === 'REJECTED').length,
      adjusted: decisions.filter((d) => d.outcome === 'REDUCE_REQUESTED').length,
      ledgerVersionBefore: n.ledgerBefore === null ? r.before.ledgerVersion.toString() : n.ledgerBefore.version.toString(),
      ledgerVersionAfter: n.ledgerAfter.version.toString(),
      transactions: r.receipt.transactions,
    },
  });

  for (const e of r.executions) {
    const v = children.find((c) => c.digest === e.child);
    const agent = v?.child.agent.value ?? null;
    const who = agent === null ? 'child' : `${x.label(agent)} child`;
    x.log.emit({
      kind: 'EXECUTION_HANDOFF',
      status: e.status === 'FAILED' ? 'REFUSED' : 'RECORDED',
      run: n.run,
      protocolTime: (n.time + EXECUTE_AFTER).toString(),
      agent: agent === null ? null : x.agent(agent),
      domain: v === undefined ? null : x.domainOf(v.candidate.kind),
      proposal: v?.proposal ?? null,
      evidence: e.evidence,
      reasons: reasonViews(e.reasons),
      artifacts: [{ name: 'childAuthorizationDigest', value: e.child }, ...(e.attempt === null ? [] : [{ name: 'attempt', value: e.attempt }]), ...(e.artifact === null ? [] : [{ name: 'artifact', value: e.artifact }])],
      message:
        e.status === 'SETTLED'
          ? `${who}: ADMIT_ATTEMPT committed and checkBeforeSign passed; settlement ${e.evidence} by the ${e.integration} venue (integration ${e.integrationEvidence}); ${e.transactions} transactions`
          : e.status === 'AWAITING_DOMAIN_SIGNER'
            ? `${who}: handed to ${e.integration}, AWAITING_DOMAIN_SIGNER; this run is ${e.evidence} and executes nothing (integration evidence ${e.integrationEvidence}); ${e.transactions} transactions`
            : `${who}: execution FAILED before any key: ${because(codesOf(e.reasons))}; ${e.transactions} transactions`,
      data: { executionStatus: e.status, integration: e.integration, integrationEvidence: e.integrationEvidence, transactions: e.transactions },
    });
  }
}

/** Scene 5's replay probe: the ledger's own refusal of every reserved child presented again. */
export function emitReplayProbe(x: SceneContext, probes: readonly ReplayProbe[], time: bigint, before: LedgerSnapshot, after: LedgerSnapshot): void {
  if (probes.length === 0) return;
  const refused = probes.every((p) => p.outcome === 'REFUSED');
  x.log.emit({
    kind: 'REPLAY_REFUSED',
    status: refused ? 'REFUSED' : 'RESERVED',
    run: 'initial',
    protocolTime: time.toString(),
    reasons: reasonViews(probes.flatMap((p) => p.reasons)),
    message: refused
      ? `Replay: all ${probes.length} verified children presented again are refused by the ledger (${codesOf(probes.flatMap((p) => p.reasons)).join(', ')}); ledger version ${before.version} → ${after.version}`
      : 'Replay: a verified child was reserved a second time',
    data: {
      probes: probes.map((p) => ({ agent: x.label(p.agent), child: p.child, outcome: p.outcome, codes: codesOf(p.reasons) })),
      ledgerVersionBefore: before.version.toString(),
      ledgerVersionAfter: after.version.toString(),
    },
  });
}
