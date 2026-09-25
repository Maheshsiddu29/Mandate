/**
 * The closed choice set: local identifiers, and the lookup that resolves one
 * back to a candidate.
 *
 * This is the module ADR 0012 is about. Jev returns a string; the only thing
 * this system will ever do with that string is look it up here. A name that is
 * not in the set resolves to nothing — there is no parsing path, no
 * normalization, no nearest match and no construction.
 */

import type { AdmissibleRoute } from '@mandate/router';
import {
  ABSTAIN_CHOICE_ID,
  JEV_MAX_CANDIDATES,
  JEV_MIN_CANDIDATES,
  type JevCandidateView,
} from './types.ts';
import { parseAdvisoryContext, projectCandidate, type RouteAdvisoryContext } from './view.ts';

export interface ClosedChoiceSet {
  /** Candidate choice identifiers in deterministic ranking order. */
  readonly candidateIds: readonly string[];
  readonly views: readonly JevCandidateView[];
  /** The candidates themselves. Never sent anywhere; the lookup target. */
  readonly routes: readonly AdmissibleRoute[];
}

export const ChoiceSetStatus = {
  /** Two or more candidates: advice is meaningful and the API can express it. */
  ELIGIBLE: 'ELIGIBLE',
  /** Zero or one candidate: there is nothing to advise on. */
  BELOW_MINIMUM: 'BELOW_MINIMUM',
  /** More candidates than the choice primitive accepts. */
  UNSUPPORTED: 'UNSUPPORTED',
} as const;
export type ChoiceSetStatus = (typeof ChoiceSetStatus)[keyof typeof ChoiceSetStatus];

/**
 * Positional identifier for a candidate.
 *
 * Zero-padded to three digits so the identifiers sort in index order and the
 * set has a uniform shape at any size up to the 254 the API allows.
 */
export function choiceIdForIndex(index: number): string {
  return `route_${String(index).padStart(3, '0')}`;
}

/**
 * Classify an admissible set against the API's cardinality.
 *
 * The bound is a property of TypeSafe's `choice` primitive, not of Mandate. An
 * admissible set is never truncated to fit it: above the limit the advisory
 * layer is skipped and the deterministic result stands, because letting a
 * vendor limit drop a valid candidate would let that vendor change which
 * executions Mandate is willing to consider.
 */
export function classifyCardinality(count: number): ChoiceSetStatus {
  if (count < JEV_MIN_CANDIDATES) return ChoiceSetStatus.BELOW_MINIMUM;
  if (count > JEV_MAX_CANDIDATES) return ChoiceSetStatus.UNSUPPORTED;
  return ChoiceSetStatus.ELIGIBLE;
}

/**
 * Build the closed set from the router's already-ranked admissible array.
 *
 * `advisoryByRouteId` is looked up by the *local* route identifier, which never
 * leaves this process; the identifier is not part of the projection.
 */
export function buildClosedChoiceSet(
  routes: readonly AdmissibleRoute[],
  advisoryByRouteId: Readonly<Record<string, RouteAdvisoryContext>> = {},
): ClosedChoiceSet {
  const candidateIds: string[] = [];
  const views: JevCandidateView[] = [];
  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index] as AdmissibleRoute;
    const choiceId = choiceIdForIndex(index);
    candidateIds.push(choiceId);
    views.push(projectCandidate(route, choiceId, parseAdvisoryContext(advisoryByRouteId[route.candidate.routeId])));
  }
  return { candidateIds, views, routes };
}

/**
 * Resolve a returned name to an index into the closed set.
 *
 * Returns `null` for `ABSTAIN` and for anything not in the set. The comparison
 * is exact: no trimming, no case folding, no prefix matching. A model that
 * returns `Route_001`, ` route_001` or `route_001 ` has returned something that
 * is not in the set, and treating it as though it were would be inventing an
 * answer the model did not give.
 */
export function resolveChoice(set: ClosedChoiceSet, choice: string): { readonly kind: 'CANDIDATE'; readonly index: number } | { readonly kind: 'ABSTAIN' } | { readonly kind: 'OUT_OF_SET' } {
  if (choice === ABSTAIN_CHOICE_ID) return { kind: 'ABSTAIN' };
  const index = set.candidateIds.indexOf(choice);
  if (index === -1) return { kind: 'OUT_OF_SET' };
  return { kind: 'CANDIDATE', index };
}
