/**
 * Project a prefix of the judge-demo transcript into view models.
 *
 * Every amount, reason, digest, and count is read from events already shown.
 * Nothing in this module re-runs the protocol or invents a missing outcome.
 */

import {
  agentTitle,
  atomsOf,
  domainTitle,
  formatBps,
  jsonInteger,
  jsonRecord,
  jsonText,
  notional,
  storyRank,
} from './formatting.ts';
import { sceneTitle } from './timeline.ts';
import type {
  AgentView,
  AmountView,
  AttackView,
  BlockedProposalView,
  CompliantView,
  DemoEventView,
  DemoSummary,
  EvidenceView,
  FactView,
  ForgeryView,
  IsolationView,
  JudgeDemoEvent,
  JudgeTranscript,
  Json,
  PortfolioConflictView,
  Presentation,
  ReasonView,
  ReceiptView,
  ResourceSnapshot,
  RoomRoundView,
  RoomStepView,
  RoomView,
  VerificationView,
} from './types.ts';

const ROOM_STEP_KINDS = new Set([
  'AGENT_RELEASED_AUTHORITY',
  'AGENT_REDUCTION_REQUESTED',
  'AGENT_PROPOSAL_REDUCED',
  'AUTHORITY_REALLOCATED',
  'PROPOSAL_ACCEPTED',
]);

interface EnrolledAgent {
  readonly id: string;
  readonly label: string;
  readonly domain: string;
}

interface AgentState {
  state: string;
  detail: string;
  reasons: readonly ReasonView[];
  requested: AmountView | null;
  reserved: AmountView | null;
  compromised: boolean;
}

export function toEventView(event: JudgeDemoEvent): DemoEventView {
  return {
    sequence: event.sequence,
    scene: event.scene,
    kind: event.kind,
    status: event.status,
    run: event.run,
    round: event.round,
    message: event.message,
    agentLabel: event.agent?.label ?? null,
    agentId: event.agent?.id ?? null,
    reasons: event.reasons,
    evidence: event.evidence,
  };
}

function textList(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === 'string' ? [item] : []));
}

function amountList(value: Json | undefined): AmountView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = jsonRecord(item);
    if (record === null) return [];
    if (
      typeof record['resource'] !== 'string' ||
      typeof record['unit'] !== 'string' ||
      typeof record['decimals'] !== 'number' ||
      typeof record['atoms'] !== 'string' ||
      typeof record['amount'] !== 'string'
    ) {
      return [];
    }
    return [
      {
        resource: record['resource'],
        unit: record['unit'],
        decimals: record['decimals'],
        atoms: record['atoms'],
        amount: record['amount'],
      },
    ];
  });
}

function enrolledAgents(created: JudgeDemoEvent | undefined): EnrolledAgent[] {
  const agents = created?.data['agents'];
  if (!Array.isArray(agents)) return [];
  return agents.flatMap((item) => {
    const record = jsonRecord(item);
    if (record === null || typeof record['agent'] !== 'string' || typeof record['label'] !== 'string') return [];
    const scope = jsonRecord(record['scope']);
    const domains = scope === null ? [] : textList(scope['domains']);
    return [{ id: record['agent'], label: record['label'], domain: domains[0] ?? '' }];
  });
}

function createdAuthority(created: JudgeDemoEvent | undefined): AmountView | null {
  return notional(amountList(created?.data['globalAuthority']));
}

function runForScene(scene: number): string | null {
  if (scene >= 1 && scene <= 5) return 'initial';
  if (scene === 6 || scene === 7) return 'attack';
  if (scene === 8) return 'compliant';
  if (scene === 9) return 'conflict';
  return null;
}

function discoveredByProposal(events: readonly JudgeDemoEvent[]): Map<string, JudgeDemoEvent> {
  const found = new Map<string, JudgeDemoEvent>();
  for (const event of events) {
    if (event.kind === 'PROPOSAL_DISCOVERED' && event.proposal !== null) found.set(event.proposal, event);
  }
  return found;
}

function candidateOf(event: JudgeDemoEvent | undefined): { readonly [key: string]: Json } | null {
  return jsonRecord(event?.data['candidate']);
}

function integerAtom(value: Json | undefined): bigint | null {
  const text = jsonText(value);
  if (text === null || !/^\d+$/.test(text)) return null;
  return BigInt(text);
}

function bpsBetween(larger: bigint, smaller: bigint): bigint | null {
  if (smaller <= 0n || larger <= smaller) return null;
  return ((larger - smaller) * 10_000n) / smaller;
}

function reasonFacts(reasons: readonly ReasonView[]): FactView[] {
  const labels: { readonly [code: string]: string } = {
    'REGISTRY:ISSUER_NOT_ALLOWED': 'Issuer',
    'REGISTRY:SYNTHETIC_NOT_ALLOWED': 'Synthetic',
    ISSUER_NOT_ALLOWED: 'Issuer',
    ASSET_NOT_ALLOWED: 'Asset',
    REPRESENTATION_NOT_ALLOWED: 'Representation',
    VENUE_NOT_ALLOWED: 'Venue',
    RECIPIENT_NOT_ALLOWED: 'Recipient',
  };
  return reasons.map((reason) => ({
    label: labels[reason.code] ?? reason.code,
    value: labels[reason.code] === undefined ? reason.code : 'NOT ALLOWED',
    tone: 'blocked' as const,
  }));
}

function blockedCards(events: readonly JudgeDemoEvent[]): BlockedProposalView[] {
  const discovered = discoveredByProposal(events);
  const cards: BlockedProposalView[] = [];
  for (const event of events) {
    if (event.kind !== 'PROPOSAL_BLOCKED' || event.proposal === null || event.agent === null) continue;
    const prior = discovered.get(event.proposal);
    const candidate = candidateOf(prior);
    const claims = jsonRecord(candidate?.['claims']);
    const facts: FactView[] = [];
    const ticker = claims === null ? null : jsonText(claims['ticker']);
    const displayName = claims === null ? null : jsonText(claims['displayName']);
    if (ticker !== null) facts.push({ label: 'Display ticker', value: ticker, tone: 'neutral' });
    if (displayName !== null) facts.push({ label: 'Display name', value: displayName, tone: 'neutral' });
    const lure = lureLine(events, event, candidate);
    if (lure !== null) facts.push({ label: lure.label, value: lure.value, tone: 'warning' });
    facts.push(...reasonFacts(event.reasons));
    cards.push({
      proposal: event.proposal,
      agentId: event.agent.id,
      agentLabel: event.agent.label,
      title: agentTitle(event.agent.label),
      reasons: event.reasons,
      requested: notional(event.requested),
      facts,
      lure: lure?.value ?? null,
      inRoom: false,
    });
  }
  return cards;
}

function lureLine(
  events: readonly JudgeDemoEvent[],
  blocked: JudgeDemoEvent,
  candidate: { readonly [key: string]: Json } | null,
): { readonly label: string; readonly value: string } | null {
  if (candidate === null || blocked.agent === null) return null;
  const kind = jsonText(candidate['kind']);
  const peers = events.filter(
    (event) =>
      event.kind === 'PROPOSAL_DISCOVERED' &&
      event.agent?.id === blocked.agent?.id &&
      event.proposal !== blocked.proposal,
  );
  if (kind === 'SWAP_EXACT_IN') {
    const quoted = integerAtom(candidate['quotedOut']);
    const amountIn = jsonText(candidate['amountIn']);
    const alternative = peers
      .map((event) => candidateOf(event))
      .find((other) => other !== null && jsonText(other['kind']) === 'SWAP_EXACT_IN' && jsonText(other['amountIn']) === amountIn);
    const otherOut = integerAtom(alternative?.['quotedOut']);
    if (quoted === null || otherOut === null) return null;
    const bps = bpsBetween(quoted, otherOut);
    return bps === null ? null : { label: 'Better quote', value: `+${formatBps(bps)}%` };
  }
  if (kind === 'YIELD_DEPOSIT') {
    const bps = integerAtom(jsonText(candidate['quotedApyBps']));
    if (bps === null) return null;
    return { label: 'Advertised APY', value: `${formatBps(bps)}%` };
  }
  return null;
}

function roomFor(events: readonly JudgeDemoEvent[], run: string | null): RoomView | null {
  if (run === null) return null;
  const opened = events.find((event) => event.kind === 'MANDATE_ROOM_OPENED' && event.run === run);
  if (opened === undefined) return null;
  const steps = events.filter(
    (event) => event.run === run && event.round !== null && ROOM_STEP_KINDS.has(event.kind),
  );
  const rounds = new Map<number, RoomStepView[]>();
  for (const event of steps) {
    const round = event.round ?? 0;
    const list = rounds.get(round) ?? [];
    const from = jsonText(event.data['from']);
    list.push({
      sequence: event.sequence,
      round,
      kind: event.kind,
      status: event.status,
      agentLabel: event.agent?.label ?? null,
      message: event.message,
      requested: notional(event.requested),
      approved: notional(event.approved),
      from,
      reasons: event.reasons,
      proposal: event.proposal,
    });
    rounds.set(round, list);
  }
  const proposedEvent = [...events].reverse().find((event) => event.kind === 'MANDATE_ROOM_PROPOSED_PORTFOLIO' && event.run === run);
  const authorized = events.some((event) => event.kind === 'PORTFOLIO_AUTHORIZED' && event.run === run && event.status === 'AUTHORIZED');
  return {
    run,
    participants: textList(opened.data['participants']),
    excludedProposals: textList(opened.data['excludedAtScreening']),
    rounds: [...rounds.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([round, roundSteps]) => ({ run, round, steps: roundSteps })),
    proposed: proposedEvent === undefined ? null : notional(proposedEvent.approved),
    authorized,
    cannot: textList(opened.data['cannot']),
  };
}

function allRoomRounds(events: readonly JudgeDemoEvent[]): RoomRoundView[] {
  const runs = ['initial', 'compliant', 'conflict'];
  return runs.flatMap((run) => roomFor(events, run)?.rounds ?? []);
}

function verificationFor(events: readonly JudgeDemoEvent[], run: string | null): VerificationView | null {
  if (run === null) return null;
  const checklist = [...events].reverse().find((event) => event.kind === 'VERIFIER_CHECKLIST' && event.run === run);
  if (checklist === undefined || !Array.isArray(checklist.data['checklist'])) return null;
  const items = checklist.data['checklist'].flatMap((item) => {
    const record = jsonRecord(item);
    if (record === null) return [];
    const id = jsonText(record['id']);
    const check = jsonText(record['check']);
    const result = jsonText(record['result']);
    if (id === null || check === null || result === null) return [];
    return [{ id, check, result }];
  });
  const passed = items.filter((item) => item.result === 'PASS').length;
  const authorized = events.some((event) => event.kind === 'PORTFOLIO_AUTHORIZED' && event.run === run && event.status === 'AUTHORIZED');
  return {
    run,
    passed,
    total: items.length,
    status: checklist.status,
    items,
    awaitingAuthorization: !authorized,
  };
}

function forgeryFor(events: readonly JudgeDemoEvent[]): ForgeryView | null {
  const event = events.find((item) => item.kind === 'ROOM_FORGERY_REFUSED');
  if (event === undefined) return null;
  return {
    message: event.message,
    verdict: jsonText(event.data['verdict']) ?? event.status,
    reasons: event.reasons,
  };
}

function displayValue(value: Json | undefined): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => displayValue(item)).filter((item) => item.length > 0).join(', ');
  return '—';
}

function attackFor(events: readonly JudgeDemoEvent[]): AttackView | null {
  const blocked = events.find((event) => event.kind === 'MALICIOUS_PROPOSAL_BLOCKED');
  const signed = events.find((event) => event.kind === 'MALICIOUS_PROPOSAL_SIGNED');
  if (blocked === undefined || blocked.agent === null) return null;
  const changes = Array.isArray(signed?.data['changedFields']) ? signed.data['changedFields'] : blocked.data['changedFields'];
  const parsed = Array.isArray(changes)
    ? changes.flatMap((item) => {
        const record = jsonRecord(item);
        if (record === null) return [];
        const field = jsonText(record['field']);
        if (field === null) return [];
        return [{ field, expected: displayValue(record['expected']), attempted: displayValue(record['attempted']) }];
      })
    : [];
  const backstop = jsonRecord(blocked.data['verifierBackstop']);
  return {
    agentId: blocked.agent.id,
    agentLabel: blocked.agent.label,
    sameIdentity: signed?.data['sameIdentityAsEarlierProposals'] === true,
    signatureValid: signed?.data['signatureValid'] === true,
    capability: jsonText(blocked.data['capability']) ?? '',
    action: jsonText(blocked.data['action']) ?? '',
    reasons: blocked.reasons,
    changes: parsed,
    reservationsWritten: jsonInteger(blocked.data['reservationsWritten']) ?? 0,
    attemptsWritten: jsonInteger(blocked.data['attemptsWritten']) ?? 0,
    executorCalls: jsonInteger(blocked.data['executionsReachingASigner']) ?? 0,
    transactions: jsonInteger(blocked.data['transactions']) ?? 0,
    verifierRefused: backstop?.['verdict'] === 'REFUSED',
  };
}

function isolationFor(events: readonly JudgeDemoEvent[]): IsolationView | null {
  const event = events.find((item) => item.kind === 'HEALTHY_AGENTS_UNAFFECTED');
  if (event === undefined) return null;
  const reservations = Array.isArray(event.data['reservations'])
    ? event.data['reservations'].flatMap((item) => {
        const record = jsonRecord(item);
        if (record === null) return [];
        const agent = jsonText(record['agent']);
        const phase = jsonText(record['phase']);
        if (agent === null || phase === null) return [];
        return [{ agent, phase, execution: jsonText(record['execution']), evidence: jsonText(record['evidence']) }];
      })
    : [];
  const agents = Array.isArray(event.data['agents'])
    ? event.data['agents'].flatMap((item) => {
        const record = jsonRecord(item);
        if (record === null) return [];
        const agent = jsonText(record['agent']);
        const status = jsonText(record['status']);
        if (agent === null || status === null) return [];
        return [{ agent, compromised: record['compromised'] === true, status, headroomUnchanged: record['headroomUnchanged'] === true }];
      })
    : [];
  return {
    reserved: notional(amountList(event.data['reservedAfter'])),
    available: notional(amountList(event.data['availableAfter'])),
    ledgerUnchanged: jsonText(event.data['ledgerVersionBefore']) === jsonText(event.data['ledgerVersionAfter']),
    reservations,
    agents,
  };
}

function compliantFor(events: readonly JudgeDemoEvent[]): CompliantView | null {
  const authorized = events.find((event) => event.kind === 'COMPLIANT_PROPOSAL_AUTHORIZED');
  const signed = events.find((event) => event.kind === 'COMPLIANT_PROPOSAL_SIGNED');
  if (authorized === undefined || authorized.agent === null) return null;
  const differs = Array.isArray(signed?.data['differsFromBlockedAttempt']) ? signed.data['differsFromBlockedAttempt'] : [];
  const recipient = differs.flatMap((item) => {
    const record = jsonRecord(item);
    if (record === null || record['field'] !== 'recipient') return [];
    return [displayValue(record['now'])];
  })[0] ?? null;
  return {
    agentId: authorized.agent.id,
    agentLabel: authorized.agent.label,
    sameIdentity: signed?.data['sameIdentityAsAttack'] === true,
    requested: notional(signed?.requested ?? authorized.approved),
    reserved: notional(amountList(authorized.data['reservedAfter'])),
    availableAtoms: jsonText(authorized.data['availableAfter']),
    evidence: authorized.evidence,
    integrationEvidence: jsonText(authorized.data['integrationEvidence']),
    executionStatus: jsonText(authorized.data['executionStatus']),
    transactions: jsonInteger(authorized.data['transactions']) ?? 0,
    recipient,
  };
}

function conflictFor(events: readonly JudgeDemoEvent[]): PortfolioConflictView | null {
  const event = events.find((item) => item.kind === 'PORTFOLIO_RESOURCE_CONFLICT');
  if (event === undefined || event.agent === null) return null;
  const authorized = [...events].reverse().find((item) => item.kind === 'PORTFOLIO_AUTHORIZED' && item.run === 'conflict');
  const screening = event.data['screeningCodes'];
  return {
    agentLabel: event.agent.label,
    individuallyValid: event.data['individuallyValid'] === true,
    portfolioValid: event.data['portfolioValid'] === true,
    screeningCodes: Array.isArray(screening) ? screening.flatMap((item) => (typeof item === 'string' ? [item] : [])) : [],
    requested: notional(event.requested),
    headroom: notional(amountList(event.data['agentHeadroom'])),
    available: notional(amountList(event.data['availableBefore'])),
    target: notional(amountList(event.data['target'])) ?? notional(event.approved),
    reasons: event.reasons,
    reservedAfter: authorized === undefined ? null : notional(amountList(authorized.data['reservedAfter'])),
    authorized: authorized?.status === 'AUTHORIZED',
  };
}

function receiptsFor(events: readonly JudgeDemoEvent[]): ReceiptView[] {
  return events.flatMap((event) => {
    if (event.kind !== 'PORTFOLIO_RECEIPT_CREATED' || event.run === null) return [];
    const digest = event.artifacts.find((artifact) => artifact.name === 'receiptDigest')?.value;
    const mandate = event.artifacts.find((artifact) => artifact.name === 'portfolioMandateDigest')?.value;
    if (digest === undefined || mandate === undefined) return [];
    return [
      {
        run: event.run,
        digest,
        mandateDigest: mandate,
        transactions: jsonInteger(event.data['transactions']) ?? 0,
        message: event.message,
        reserved: notional(amountList(event.data['reservedAfter'])),
      },
    ];
  });
}

function evidenceFor(events: readonly JudgeDemoEvent[]): EvidenceView[] {
  const created = events.find((event) => event.kind === 'PORTFOLIO_CREATED');
  const domains = Array.isArray(created?.data['domains']) ? created.data['domains'] : [];
  const live = events.find((event) => event.kind === 'LIVE_TESTNET_EVIDENCE');
  const liveData = live?.data;
  const completed = [...events].reverse().find((event) => event.kind === 'DEMO_COMPLETED');
  const completedEvidence = Array.isArray(completed?.data['evidence']) ? completed.data['evidence'] : [];
  const byDomain = new Map<string, { readonly [key: string]: Json }>();
  for (const item of completedEvidence) {
    const record = jsonRecord(item);
    const domain = record === null ? null : jsonText(record['domain']);
    if (record !== null && domain !== null) byDomain.set(domain, record);
  }
  return domains.flatMap((item) => {
    const record = jsonRecord(item);
    if (record === null) return [];
    const domain = jsonText(record['domain']);
    if (domain === null) return [];
    const completedRecord = byDomain.get(domain) ?? null;
    const integrationEvidence =
      (completedRecord === null ? null : jsonText(completedRecord['integrationEvidence'])) ?? jsonText(record['evidence']) ?? '';
    const thisRun = completedRecord === null ? [] : textList(completedRecord['thisRun']);
    const historicalLive = integrationEvidence === 'LIVE_TESTNET' && live !== undefined && live.evidence === 'LIVE_TESTNET';
    const buy = historicalLive ? jsonRecord(liveData?.['buy']) : null;
    const replay = historicalLive ? jsonRecord(liveData?.['replay']) : null;
    const mutation = historicalLive ? jsonRecord(liveData?.['amountMutation']) : null;
    const over = historicalLive ? jsonRecord(liveData?.['overBudget']) : null;
    const gate = historicalLive ? jsonRecord(liveData?.['gate']) : null;
    return [
      {
        domain,
        title: domainTitle(domain, domain),
        integration: jsonText(record['integration']) ?? '',
        integrationEvidence,
        thisRun,
        historicalLive,
        chainName: historicalLive ? jsonText(liveData?.['network']) : null,
        chainId: historicalLive ? jsonText(liveData?.['chainId']) : null,
        gate: gate === null ? null : jsonText(gate['address']),
        explorer: historicalLive ? jsonText(liveData?.['explorer']) : null,
        buyAction: buy === null ? null : jsonText(buy['action']),
        buyQuantity: buy === null ? null : jsonText(buy['quantity']),
        buyGas: buy === null ? null : jsonText(buy['gasUsed']),
        buyTransaction: buy === null ? null : jsonText(buy['transaction']),
        replayRevert: replay === null ? null : jsonText(replay['revert']),
        mutationRevert: mutation === null ? null : jsonText(mutation['revert']),
        overBudgetTransactions: over === null ? null : jsonInteger(over['transactions']),
      },
    ];
  });
}

function authorizedReserved(events: readonly JudgeDemoEvent[], run: string): AmountView | null {
  const event = events.find((item) => item.kind === 'PORTFOLIO_AUTHORIZED' && item.run === run && item.status === 'AUTHORIZED');
  return event === undefined ? null : notional(amountList(event.data['reservedAfter']));
}

function reservedChildren(events: readonly JudgeDemoEvent[], run: string | null): number | null {
  if (run === null) return null;
  const event = [...events].reverse().find((item) => item.kind === 'PORTFOLIO_AUTHORIZED' && item.run === run);
  return event === undefined ? null : jsonInteger(event.data['children']);
}

function resourcesFor(events: readonly JudgeDemoEvent[], authority: AmountView | null): ResourceSnapshot {
  let requested: AmountView | null = null;
  let proposed: AmountView | null = null;
  let reserved: AmountView | null = null;
  let available: AmountView | null = null;
  for (const event of events) {
    if (event.kind === 'RESOURCE_CONFLICT') requested = notional(event.requested);
    if (event.kind === 'MANDATE_ROOM_PROPOSED_PORTFOLIO') proposed = notional(event.approved);
    if (event.kind === 'PORTFOLIO_AUTHORIZED' || event.kind === 'HEALTHY_AGENTS_UNAFFECTED' || event.kind === 'COMPLIANT_PROPOSAL_AUTHORIZED') {
      const nextReserved = notional(amountList(event.data['reservedAfter']));
      if (nextReserved !== null) reserved = nextReserved;
      const nextAvailable = notional(amountList(event.data['availableAfter']));
      if (nextAvailable !== null) available = nextAvailable;
    }
    if (event.kind === 'DEMO_COMPLETED') {
      const nextReserved = notional(event.approved);
      if (nextReserved !== null) reserved = nextReserved;
    }
  }
  return { requested, authority, proposed, reserved, available };
}

function stateFor(kind: string, status: string): string | null {
  if (kind === 'AGENT_SEARCH_STARTED') return 'SEARCHING';
  if (kind === 'PROPOSAL_DISCOVERED' || kind === 'COMPLIANT_PROPOSAL_SIGNED' || kind === 'MALICIOUS_PROPOSAL_SIGNED') return 'PROPOSING';
  if (kind === 'PROPOSAL_BLOCKED' || kind === 'MALICIOUS_PROPOSAL_BLOCKED') return 'BLOCKED';
  if (kind === 'PROPOSAL_ADMISSIBLE') return status === 'CONFLICT' ? 'CONFLICT' : 'VALID';
  if (kind === 'AGENT_NO_COMPLIANT_OPPORTUNITY') return 'NO COMPLIANT OPPORTUNITY';
  if (kind === 'AGENT_RELEASED_AUTHORITY') return 'RELEASING';
  if (kind === 'AGENT_REDUCTION_REQUESTED' || kind === 'AGENT_PROPOSAL_REDUCED' || kind === 'AUTHORITY_REALLOCATED' || kind === 'PROPOSAL_ACCEPTED') {
    return 'NEGOTIATING';
  }
  if (kind === 'RESOURCE_RESERVED' && status === 'RESERVED') return 'AUTHORIZED';
  if (kind === 'EXECUTION_HANDOFF' || kind === 'COMPLIANT_PROPOSAL_AUTHORIZED') return 'AUTHORIZED';
  if (kind === 'AGENT_COMPROMISED') return 'COMPROMISED';
  if (kind === 'PORTFOLIO_RESOURCE_CONFLICT') return 'CONFLICT';
  return null;
}

function agentsFor(events: readonly JudgeDemoEvent[], enrolled: readonly EnrolledAgent[], room: RoomView | null, scene: number): AgentView[] {
  const states = new Map<string, AgentState>();
  for (const agent of enrolled) {
    states.set(agent.id, {
      state: 'ENROLLED',
      detail: 'Named by the Portfolio Mandate',
      reasons: [],
      requested: null,
      reserved: null,
      compromised: false,
    });
  }
  for (const event of events) {
    if (event.kind === 'HEALTHY_AGENTS_UNAFFECTED') {
      for (const current of states.values()) {
        current.state = 'ACTIVE';
        current.detail = current.compromised
          ? 'Bad action blocked. Earlier reservation still intact.'
          : 'Portfolio remains active.';
      }
    }
    const id = event.agent?.id;
    if (id === undefined) continue;
    const current = states.get(id);
    if (current === undefined) continue;
    const next = stateFor(event.kind, event.status);
    if (next !== null) current.state = next;
    if (event.kind === 'AGENT_COMPROMISED') current.compromised = true;
    if (event.reasons.length > 0) current.reasons = event.reasons;
    const requested = notional(event.requested);
    if (requested !== null && (event.kind === 'PROPOSAL_DISCOVERED' || event.kind === 'PROPOSAL_ADMISSIBLE' || event.kind === 'PROPOSAL_BLOCKED' || event.kind === 'COMPLIANT_PROPOSAL_SIGNED' || event.kind === 'PORTFOLIO_RESOURCE_CONFLICT' || event.kind === 'MALICIOUS_PROPOSAL_SIGNED')) {
      current.requested = requested;
    }
    if (event.kind === 'RESOURCE_RESERVED' && event.status === 'RESERVED') current.reserved = notional(event.approved);
    if (event.kind === 'COMPLIANT_PROPOSAL_AUTHORIZED') current.reserved = notional(event.approved);
    if (event.message.length > 0 && next !== null) current.detail = event.message;
  }
  const roomScenes = scene === 4 || scene === 8 || scene === 9;
  return [...enrolled]
    .sort((a, b) => storyRank(a.label) - storyRank(b.label))
    .map((agent) => {
      const current = states.get(agent.id);
      return {
        id: agent.id,
        label: agent.label,
        domain: agent.domain,
        title: agentTitle(agent.label),
        state: current?.state ?? 'ENROLLED',
        detail: current?.detail ?? '',
        inRoom: roomScenes && (room?.participants.includes(agent.label) ?? false),
        compromised: current?.compromised ?? false,
        revoked: false as const,
        reasons: current?.reasons ?? [],
        requested: current?.requested ?? null,
        reserved: current?.reserved ?? null,
      };
    });
}

export function summaryOf(transcript: JudgeTranscript): DemoSummary {
  const created = transcript.events.find((event) => event.kind === 'PORTFOLIO_CREATED');
  const conflict = transcript.events.find((event) => event.kind === 'RESOURCE_CONFLICT');
  const authority = createdAuthority(created);
  if (created === undefined || authority === null) throw new Error('transcript has no portfolio authority');
  const mandateDigest = created.artifacts.find((artifact) => artifact.name === 'portfolioMandateDigest')?.value ?? '';
  return {
    schema: transcript.schema,
    version: transcript.version,
    presentationDigest: transcript.presentationDigest,
    eventCount: transcript.events.length,
    principal: jsonText(created.data['principal']) ?? '',
    allocationMode: jsonText(created.data['allocationMode']) ?? '',
    mandateDigest,
    authority,
    agentCount: enrolledAgents(created).length,
    initialRequested: notional(amountList(conflict?.data['initialRequested'])),
    admissibleDemand: conflict === undefined ? null : notional(conflict.requested),
  };
}

export function derivePresentation(transcript: JudgeTranscript, shown: readonly JudgeDemoEvent[]): Presentation {
  const summary = summaryOf(transcript);
  const latest = shown.length === 0 ? null : toEventView(shown[shown.length - 1] as JudgeDemoEvent);
  const scene = latest?.scene ?? 1;
  const run = runForScene(scene);
  const created = shown.find((event) => event.kind === 'PORTFOLIO_CREATED') ?? transcript.events.find((event) => event.kind === 'PORTFOLIO_CREATED');
  const enrolled = enrolledAgents(created);
  const room = roomFor(shown, run);
  const conflictEvent = shown.find((event) => event.kind === 'RESOURCE_CONFLICT');
  return {
    scene,
    sceneTitle: sceneTitle(scene),
    position: shown.length,
    eventCount: transcript.events.length,
    latest,
    recent: shown.slice(-4).map(toEventView),
    summary,
    resources: resourcesFor(shown, summary.authority),
    agents: agentsFor(shown, enrolled, room, shown.length === 0 ? 1 : scene),
    blocked: blockedCards(shown),
    admissible: (shown.filter((event) => event.kind === 'PROPOSAL_ADMISSIBLE' && event.run === 'initial') ?? []).map((event) => ({
      agentLabel: event.agent?.label ?? '',
      requested: notional(event.requested),
      conflict: event.status === 'CONFLICT',
    })),
    conflictOpen: conflictEvent !== undefined && scene === 3,
    room,
    verification: verificationFor(shown, run),
    forgery: forgeryFor(shown),
    attack: attackFor(shown),
    isolation: isolationFor(shown),
    compliant: compliantFor(shown),
    portfolioConflict: conflictFor(shown),
    receipts: receiptsFor(shown),
    evidence: evidenceFor(shown),
    securityInvalidCount: shown.filter((event) => event.kind === 'PROPOSAL_BLOCKED').length,
    adjustmentCount: shown.filter((event) => event.kind === 'AGENT_PROPOSAL_REDUCED').length,
    maliciousTransactions: attackFor(shown)?.transactions ?? 0,
    reservedChildren: reservedChildren(shown, run),
    firstReserved: authorizedReserved(shown, 'initial'),
    compliantReserved: authorizedReserved(shown, 'compliant'),
  };
}

export function finalAgents(transcript: JudgeTranscript): readonly AgentView[] {
  return derivePresentation(transcript, transcript.events).agents;
}

export function finalRoomRounds(transcript: JudgeTranscript): readonly RoomRoundView[] {
  return allRoomRounds(transcript.events);
}

export function finalReceipts(transcript: JudgeTranscript): readonly ReceiptView[] {
  return receiptsFor(transcript.events);
}

export function finalEvidence(transcript: JudgeTranscript): readonly EvidenceView[] {
  return evidenceFor(transcript.events);
}

export function initialAuthorityAtoms(transcript: JudgeTranscript): bigint {
  return atomsOf(summaryOf(transcript).authority);
}

export function eventByKind(events: readonly JudgeDemoEvent[], kind: string, run?: string): JudgeDemoEvent | undefined {
  return events.find((event) => event.kind === kind && (run === undefined || event.run === run));
}
