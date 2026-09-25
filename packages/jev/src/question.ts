/**
 * Construction of the request body.
 *
 * Every string in a Jev request originates here, in this module, as a constant
 * or as a numeric template. There is no code path that concatenates external
 * text into `instructions`, into a `criteria` description, or into the state.
 * That is what makes the prompt-injection boundary a structural property rather
 * than a review note.
 */

import type { CanonicalMandate } from '@mandate/kernel';
import type { ClosedChoiceSet } from './choices.ts';
import {
  ABSTAIN_CHOICE_ID,
  JEV_QUESTION_NAME,
  JEV_QUESTION_SCHEMA_VERSION,
  type JevCandidateView,
  type JevChoiceQuestion,
  type JevRequestPayload,
  type JevState,
} from './types.ts';

export const JEV_STATE_SCHEMA = `mandate.jev.routing/${JEV_QUESTION_SCHEMA_VERSION}`;

/**
 * The question text. A module constant, never assembled from inputs.
 *
 * It states the closed-set rule explicitly so that abstention is a real option
 * rather than an escape hatch the model has to infer.
 */
export const ROUTE_SELECTION_INSTRUCTIONS = [
  'Every option below is an execution route that has already passed every safety and',
  'authorization check. They are all permitted. Choose the one you judge to be the best',
  'execution, weighing all-in cost first and treating venue reliability, quote firmness,',
  'quote age and route complexity as secondary judgement. Choose ABSTAIN if you have no',
  'basis to prefer one over another; abstaining is a normal answer and has no penalty.',
].join(' ');

export const ABSTAIN_DESCRIPTION =
  'Decline to advise. The deterministic selection is used instead. Choose this whenever the options are equivalent on the information given.';

/**
 * Describe one option from its numeric projection.
 *
 * Deliberately a template over already-validated values. The only variable
 * parts are integers, a currency unit that came from the kernel's own amount
 * type, and members of two closed vocabularies.
 */
export function describeCandidate(view: JevCandidateView): string {
  return [
    `All-in cost ${view.allInCostAtoms} (unit ${view.costUnit}, ${view.costDecimals} decimals).`,
    `Explicit fees ${view.explicitFeeTotalAtoms}.`,
    `Execution deviation ${view.executionDeviationBps} bps from the reference price.`,
    `Quote age ${view.quoteAgeSeconds}s.`,
    `${view.routeStepCount} route step(s), fill policy ${view.fillPolicy}.`,
    `Venue reliability ${view.venueReliability}, quote firmness ${view.quoteFirmness}.`,
    `Route data class ${view.providerClass}.`,
  ].join(' ');
}

export function buildJevState(mandate: CanonicalMandate, set: ClosedChoiceSet): JevState {
  const first = set.views[0];
  return {
    schema: JEV_STATE_SCHEMA,
    side: mandate.side,
    costUnit: first?.costUnit ?? '',
    costDecimals: first?.costDecimals ?? 0,
    candidateCount: set.views.length,
    candidates: set.views,
  };
}

export function buildChoiceQuestion(set: ClosedChoiceSet): JevChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const view of set.views) criteria[view.choiceId] = describeCandidate(view);
  criteria[ABSTAIN_CHOICE_ID] = ABSTAIN_DESCRIPTION;
  return { type: 'choice', instructions: ROUTE_SELECTION_INSTRUCTIONS, criteria };
}

export function buildRequestPayload(mandate: CanonicalMandate, set: ClosedChoiceSet, model: string): JevRequestPayload {
  return {
    state: buildJevState(mandate, set),
    model,
    questions: { [JEV_QUESTION_NAME]: buildChoiceQuestion(set) },
  };
}
