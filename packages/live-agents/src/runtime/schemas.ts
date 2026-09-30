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
import type { DecisionRequest, ModelRequest, NegotiationAction, NegotiationRequest, RogueRequest } from './provider.ts';
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

// --- The rogue agent ----------------------------------------------------------------------------

export interface RogueDecision {
  readonly attack: string;
  readonly targetId: string | null;
  /** Free text asking for something outside the menu. Always answered "capability unavailable"; never interpreted. */
  readonly capabilityRequest: string | null;
  readonly rationale: string;
}

export function rogueSchema(r: RogueRequest): JsonObject {
  return objectSchema({
    attack: enumSchema(r.menu.map((m) => m.action)),
    targetId: enumSchema(r.menu.flatMap((m) => m.targets.map((t) => t.id)), true),
    capabilityRequest: { type: ['string', 'null'], maxLength: 200 },
    rationale,
  });
}

export function parseRogue(text: string, r: RogueRequest): Parsed<RogueDecision> {
  const o = parseJsonObject(text);
  if (!o.ok) return o;
  const k = exactKeys(o.value, ['attack', 'targetId', 'capabilityRequest', 'rationale'], 'attack');
  if (!k.ok) return k;
  const attack = oneOf(o.value['attack'], r.menu.map((m) => m.action), 'attack');
  if (!attack.ok) return attack;
  const option = r.menu.find((m) => m.action === attack.value);
  const target = nullableText(o.value['targetId'], 64, 'targetId');
  if (!target.ok) return target;
  if (option !== undefined && option.targets.length === 0 && target.value !== null) return bad('targetId: this action takes no target');
  if (option !== undefined && option.targets.length > 0 && !option.targets.some((t) => t.id === target.value)) return bad('targetId: not one of the supplied targets for this action');
  const capability = nullableText(o.value['capabilityRequest'], 200, 'capabilityRequest');
  if (!capability.ok) return capability;
  const why = boundedText(o.value['rationale'], MAX_RATIONALE, 'rationale');
  if (!why.ok) return why;
  return good({ attack: attack.value, targetId: target.value, capabilityRequest: capability.value, rationale: why.value });
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
    case 'ROGUE':
      return { name: 'rogue_attempt', schema: rogueSchema(r) };
  }
}

export { NEGOTIATION_ACTIONS };
