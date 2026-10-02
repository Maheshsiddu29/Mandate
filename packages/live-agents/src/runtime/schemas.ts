/**
 * What a model may answer, and the strict local check of every answer.
 *
 * Each schema is sent to the provider (strict structured output) *and*
 * enforced here, because a provider's enforcement is never relied on. The
 * shapes are closed: a domain agent can name a candidate id from its list,
 * an amount inside that candidate's bounds, and a short rationale — there
 * is no field for an address, a venue, a recipient, a tool or calldata, so
 * none can be returned. Hidden reasoning is never requested.
 */

import { ATOMS_PATTERN, parseAtoms } from '../types.ts';
import type { DecisionRequest, ModelRequest, NegotiationAction, NegotiationRequest, OpportunityRequest, PolicyStressRequest } from './provider.ts';
import { NEGOTIATION_ACTIONS } from './provider.ts';
import { DRAFT_SCHEMA } from '../authoring/prompt-to-draft.ts';
import { MAX_RATIONALE, bad, boundedText, enumSchema, exactKeys, good, nullableText, objectSchema, oneOf, parseJsonObject, type JsonObject, type Parsed } from './strict-json.ts';

const rationale: JsonObject = { type: 'string', maxLength: MAX_RATIONALE };
const nullableAtoms: JsonObject = { type: ['string', 'null'], pattern: ATOMS_PATTERN };

// --- Discovery ------------------------------------------------------------------------------

export const DECISION_ACTIONS = ['PROPOSE', 'ABSTAIN'] as const;

export interface AgentDecision {
  readonly action: (typeof DECISION_ACTIONS)[number];
  readonly candidateId: string | null;
  readonly requestedAtoms: bigint | null;
  readonly rationale: string;
}

export function decisionSchema(r: DecisionRequest): JsonObject {
  return objectSchema({
    action: enumSchema(DECISION_ACTIONS),
    candidateId: enumSchema(r.candidates.map((c) => c.id), true),
    requestedAtoms: nullableAtoms,
    rationale,
  });
}

export function parseDecision(text: string, r: DecisionRequest): Parsed<AgentDecision> {
  const o = parseJsonObject(text);
  if (!o.ok) return o;
  const k = exactKeys(o.value, ['action', 'candidateId', 'requestedAtoms', 'rationale'], 'decision');
  if (!k.ok) return k;
  const action = oneOf(o.value['action'], DECISION_ACTIONS, 'action');
  if (!action.ok) return action;
  const why = boundedText(o.value['rationale'], MAX_RATIONALE, 'rationale');
  if (!why.ok) return why;
  if (action.value === 'ABSTAIN') {
    if (o.value['candidateId'] !== null || o.value['requestedAtoms'] !== null) return bad('ABSTAIN names no candidate and no amount');
    return good({ action: 'ABSTAIN', candidateId: null, requestedAtoms: null, rationale: why.value });
  }
  const id = nullableText(o.value['candidateId'], 64, 'candidateId');
  if (!id.ok) return id;
  const candidate = r.candidates.find((c) => c.id === id.value);
  if (candidate === undefined) return bad('candidateId: not one of the supplied candidates');
  const atoms = parseAtoms(o.value['requestedAtoms']);
  if (atoms === null) return bad('requestedAtoms: not an integer string');
  if (atoms < BigInt(candidate.minAtoms) || atoms > BigInt(candidate.maxAtoms)) return bad('requestedAtoms: outside the candidate’s allowed bounds');
  return good({ action: 'PROPOSE', candidateId: candidate.id, requestedAtoms: atoms, rationale: why.value });
}

// --- The Mandate Room -----------------------------------------------------------------------

export interface NegotiationDecision {
  readonly action: NegotiationAction;
  /** The agent's request after this answer: unchanged for KEEP and ABSTAIN, 0 for RELEASE. */
  readonly newAtoms: bigint;
  readonly rationale: string;
}

export function negotiationSchema(r: NegotiationRequest): JsonObject {
  return objectSchema({ action: enumSchema(r.permittedActions), newRequestedAtoms: nullableAtoms, rationale });
}

/**
 * KEEP: unchanged. REDUCE: minimum ≤ new < current, and only for a
 * resizable candidate. RELEASE: new = 0. ABSTAIN: no change this generation.
 */
export function parseNegotiation(text: string, r: NegotiationRequest): Parsed<NegotiationDecision> {
  const o = parseJsonObject(text);
  if (!o.ok) return o;
  const k = exactKeys(o.value, ['action', 'newRequestedAtoms', 'rationale'], 'negotiation');
  if (!k.ok) return k;
  const action = oneOf(o.value['action'], r.permittedActions, 'action');
  if (!action.ok) return action;
  const why = boundedText(o.value['rationale'], MAX_RATIONALE, 'rationale');
  if (!why.ok) return why;
  const current = BigInt(r.yourCurrentAtoms);
  const raw = o.value['newRequestedAtoms'];
  const atoms = raw === null ? null : parseAtoms(raw);
  if (raw !== null && atoms === null) return bad('newRequestedAtoms: not an integer string');
  switch (action.value) {
    case 'KEEP':
      if (atoms !== null && atoms !== current) return bad('KEEP must leave the request unchanged');
      return good({ action: 'KEEP', newAtoms: current, rationale: why.value });
    case 'ABSTAIN':
      if (atoms !== null) return bad('ABSTAIN changes nothing this generation');
      return good({ action: 'ABSTAIN', newAtoms: current, rationale: why.value });
    case 'RELEASE':
      if (atoms !== null && atoms !== 0n) return bad('RELEASE withdraws the request: new = 0');
      return good({ action: 'RELEASE', newAtoms: 0n, rationale: why.value });
    case 'REDUCE':
      if (atoms === null) return bad('REDUCE needs newRequestedAtoms');
      if (atoms <= 0n || atoms >= current) return bad('REDUCE needs 0 < new < current');
      if (atoms < BigInt(r.yourMinimumAtoms)) return bad('REDUCE below your minimum valid request');
      return good({ action: 'REDUCE', newAtoms: atoms, rationale: why.value });
  }
}

// --- The policy-stress agent -----------------------------------------------------------------

export interface PolicyCaseSelection {
  readonly caseId: string;
  readonly rationale: string;
}

/** A supplied case identifier and a rationale. Nothing else exists to return: no address, amount, tool or calldata. */
export function policyStressSchema(r: PolicyStressRequest): JsonObject {
  return objectSchema({ caseId: enumSchema(r.cases.map((c) => c.caseId)), rationale });
}

export function parsePolicyStress(text: string, r: PolicyStressRequest): Parsed<PolicyCaseSelection> {
  const o = parseJsonObject(text);
  if (!o.ok) return o;
  const k = exactKeys(o.value, ['caseId', 'rationale'], 'policy case');
  if (!k.ok) return k;
  const caseId = oneOf(o.value['caseId'], r.cases.map((c) => c.caseId), 'caseId');
  if (!caseId.ok) return caseId;
  const why = boundedText(o.value['rationale'], MAX_RATIONALE, 'rationale');
  if (!why.ok) return why;
  return good({ caseId: caseId.value, rationale: why.value });
}

// --- Opportunity analysis (Planning and Reallocation Rooms) ---------------------------------------

/** Ordinal judgements on a fixed 0–4 scale. The agent judges them from the supplied facts; trusted code never reads them as dollars. */
export const OPPORTUNITY_METRICS = ['opportunityQuality', 'liquidity', 'executionQuality', 'downsideRisk', 'dataConfidence'] as const;
export type OpportunityMetric = (typeof OPPORTUNITY_METRICS)[number];
export type OpportunityMetrics = { readonly [M in OpportunityMetric]: number };
export const MARKET_REGIMES = ['CONSTRUCTIVE', 'NEUTRAL', 'STRESSED', 'UNKNOWN'] as const;
export type MarketRegime = (typeof MARKET_REGIMES)[number];
export const METRIC_MAX = 4;

export interface OpportunityAnswer {
  readonly action: (typeof DECISION_ACTIONS)[number];
  readonly candidateId: string | null;
  readonly requestedAtoms: bigint;
  readonly minimumUsefulAtoms: bigint;
  readonly maximumUsefulAtoms: bigint;
  readonly metrics: OpportunityMetrics;
  readonly marketRegime: MarketRegime;
  readonly rationale: string;
}

const metric: JsonObject = { type: 'integer', enum: [0, 1, 2, 3, 4] };

export function opportunitySchema(r: OpportunityRequest): JsonObject {
  return objectSchema({
    action: enumSchema(DECISION_ACTIONS),
    candidateId: enumSchema(r.candidates.map((c) => c.id), true),
    requestedAtoms: nullableAtoms,
    minimumUsefulAtoms: nullableAtoms,
    maximumUsefulAtoms: nullableAtoms,
    ...Object.fromEntries(OPPORTUNITY_METRICS.map((m) => [m, metric])),
    marketRegime: enumSchema(MARKET_REGIMES),
    rationale,
  });
}

/**
 * PROPOSE: a supplied candidate, and candidate minimum ≤ minimumUseful ≤
 * requested ≤ maximumUseful ≤ candidate maximum. ABSTAIN: no candidate and
 * no amounts. Every metric an integer 0–4.
 */
export function parseOpportunity(text: string, r: OpportunityRequest): Parsed<OpportunityAnswer> {
  const o = parseJsonObject(text);
  if (!o.ok) return o;
  const k = exactKeys(o.value, ['action', 'candidateId', 'requestedAtoms', 'minimumUsefulAtoms', 'maximumUsefulAtoms', ...OPPORTUNITY_METRICS, 'marketRegime', 'rationale'], 'opportunity');
  if (!k.ok) return k;
  const action = oneOf(o.value['action'], DECISION_ACTIONS, 'action');
  if (!action.ok) return action;
  const why = boundedText(o.value['rationale'], MAX_RATIONALE, 'rationale');
  if (!why.ok) return why;
  const regime = oneOf(o.value['marketRegime'], MARKET_REGIMES, 'marketRegime');
  if (!regime.ok) return regime;
  const metrics: { [M in OpportunityMetric]?: number } = {};
  for (const m of OPPORTUNITY_METRICS) {
    const v = o.value[m];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > METRIC_MAX) return bad(`${m}: not an integer 0–${METRIC_MAX}`);
    metrics[m] = v;
  }
  const common = { metrics: metrics as OpportunityMetrics, marketRegime: regime.value, rationale: why.value };
  if (action.value === 'ABSTAIN') {
    if (o.value['candidateId'] !== null || o.value['requestedAtoms'] !== null || o.value['minimumUsefulAtoms'] !== null || o.value['maximumUsefulAtoms'] !== null) return bad('ABSTAIN names no candidate and no amount');
    return good({ action: 'ABSTAIN', candidateId: null, requestedAtoms: 0n, minimumUsefulAtoms: 0n, maximumUsefulAtoms: 0n, ...common });
  }
  const id = nullableText(o.value['candidateId'], 64, 'candidateId');
  if (!id.ok) return id;
  const candidate = r.candidates.find((c) => c.id === id.value);
  if (candidate === undefined) return bad('candidateId: not one of the supplied candidates');
  const requested = parseAtoms(o.value['requestedAtoms']);
  const min = parseAtoms(o.value['minimumUsefulAtoms']);
  const max = parseAtoms(o.value['maximumUsefulAtoms']);
  if (requested === null || min === null || max === null) return bad('PROPOSE needs requestedAtoms, minimumUsefulAtoms and maximumUsefulAtoms as integer strings');
  const lo = BigInt(candidate.minAtoms);
  const hi = BigInt(candidate.maxAtoms);
  if (!(lo <= min && min <= requested && requested <= max && max <= hi)) return bad('amounts: need candidate minimum ≤ minimumUseful ≤ requested ≤ maximumUseful ≤ candidate maximum');
  return good({ action: 'PROPOSE', candidateId: candidate.id, requestedAtoms: requested, minimumUsefulAtoms: min, maximumUsefulAtoms: max, ...common });
}

// --- Dispatch ------------------------------------------------------------------------------------

export function schemaFor(r: ModelRequest): { readonly name: string; readonly schema: JsonObject } {
  switch (r.kind) {
    case 'DECISION':
      return { name: 'agent_decision', schema: decisionSchema(r) };
    case 'NEGOTIATION':
      return { name: 'room_negotiation', schema: negotiationSchema(r) };
    case 'DRAFT':
      return { name: 'mandate_draft', schema: DRAFT_SCHEMA };
    case 'POLICY_STRESS':
      return { name: 'policy_case_selection', schema: policyStressSchema(r) };
    case 'OPPORTUNITY':
      return { name: 'opportunity_card', schema: opportunitySchema(r) };
  }
}

export { NEGOTIATION_ACTIONS };
