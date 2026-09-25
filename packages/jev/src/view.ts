/**
 * Projection of an admissible candidate into the only shape Jev ever sees.
 *
 * The rule this module exists to enforce: a view is **built field by field**
 * from verified values. It is never produced by spreading an internal object,
 * because a spread silently exports whatever a future field happens to be.
 *
 * Nothing here can carry a contract address, a representation, an issuer, a
 * chain, a venue name, a route or provider identifier, a state identifier, an
 * agent or principal identity, an authorization envelope, a signature, or any
 * string a route provider authored.
 */

import type { AdmissibleRoute } from '@mandate/router';
import {
  QuoteFirmness,
  VenueReliability,
  type JevCandidateView,
} from './types.ts';

/**
 * Advisory context a caller may attach to a route, by route identifier.
 *
 * This is the one place a soft signal enters the decision, and it is a closed
 * vocabulary on purpose. Values arrive from local policy — a venue allowlist, a
 * health check, an operator classification — never from a route provider's
 * response.
 */
export interface RouteAdvisoryContext {
  readonly venueReliability?: string;
  readonly quoteFirmness?: string;
}

export interface NormalizedAdvisoryContext {
  readonly venueReliability: VenueReliability;
  readonly quoteFirmness: QuoteFirmness;
}

const NO_SIGNAL: NormalizedAdvisoryContext = {
  venueReliability: VenueReliability.UNKNOWN,
  quoteFirmness: QuoteFirmness.UNKNOWN,
};

function member<T extends string>(raw: unknown, vocabulary: Readonly<Record<string, T>>, fallback: T): T {
  if (typeof raw !== 'string') return fallback;
  if (!Object.prototype.hasOwnProperty.call(vocabulary, raw)) return fallback;
  return vocabulary[raw] as T;
}

/**
 * Normalize caller-supplied advisory context against the closed vocabularies.
 *
 * Anything unrecognized becomes `UNKNOWN`, which carries no signal. That is the
 * fail-closed direction: a hostile or malformed value cannot express a
 * preference, and in particular a string containing an instruction normalizes
 * to the same value as a missing field.
 */
export function parseAdvisoryContext(raw: unknown): NormalizedAdvisoryContext {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return NO_SIGNAL;
  const value = raw as Record<string, unknown>;
  return {
    venueReliability: member(value['venueReliability'], VenueReliability, VenueReliability.UNKNOWN),
    quoteFirmness: member(value['quoteFirmness'], QuoteFirmness, QuoteFirmness.UNKNOWN),
  };
}

/**
 * Build the outbound view of one admissible route.
 *
 * `choiceId` is supplied by the caller from the candidate's position in the
 * closed set. It is a local label: it is not derived from any candidate field
 * and means nothing outside the evaluation that produced it.
 */
export function projectCandidate(route: AdmissibleRoute, choiceId: string, advisory: NormalizedAdvisoryContext = NO_SIGNAL): JevCandidateView {
  const quality = route.quality;
  return {
    choiceId,
    allInCostAtoms: quality.economicValue.atoms.toString(10),
    costUnit: quality.economicValue.unit,
    costDecimals: quality.economicValue.decimals,
    explicitFeeTotalAtoms: quality.explicitFeeTotal.atoms.toString(10),
    executionDeviationBps: quality.executionDeviationBps.toString(10),
    quoteAgeSeconds: quality.quoteAgeSeconds.toString(10),
    routeStepCount: quality.routeSteps,
    providerClass: route.candidate.providerClass,
    venueReliability: advisory.venueReliability,
    quoteFirmness: advisory.quoteFirmness,
    fillPolicy: route.candidate.fillPolicy,
  };
}

/** Every field name a view may carry. A structural test asserts the set. */
export const JEV_CANDIDATE_VIEW_FIELDS: readonly string[] = [
  'choiceId',
  'allInCostAtoms',
  'costUnit',
  'costDecimals',
  'explicitFeeTotalAtoms',
  'executionDeviationBps',
  'quoteAgeSeconds',
  'routeStepCount',
  'providerClass',
  'venueReliability',
  'quoteFirmness',
  'fillPolicy',
];
