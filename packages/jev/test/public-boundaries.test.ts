/**
 * Cross-package public decision-boundary matrix (Phase 5R.3).
 *
 * This explicit inventory is the guard: adding an externally reachable decision
 * entrypoint requires classifying it here or in the validated-internal list in
 * docs/public-trust-boundaries.md. The same hostile corpus is then exercised at
 * every external entrypoint, so totality cannot silently become package-local.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import {
  applyTransition,
  isAvailable,
  isIdentifier,
  parseAmount,
  parseAuthorizationEnvelope,
  parseBigInt,
  parseBytes32,
  parseCandidate,
  parseCanonicalAssetId,
  parseClock,
  parseCorporateActionState,
  parseDurationSeconds,
  parseEip712Domain,
  parseExecutionObservation,
  parseIdentifier,
  parseMandate,
  parseMarketState,
  parsePartyId,
  parsePrice,
  parseProvenance,
  parseReconciledOutcome,
  parseReplayRecord,
  parseReplayState,
  parseReplayTransition,
  parseRepresentationState,
  parseTrustedState,
  parseUnixSeconds,
  verify,
} from '@mandate/kernel';
import {
  openRegistry,
  parseAdditionalRequirements,
  parseCanonicalAssetRecord,
  parseContractAddress,
  parseDisplayText,
  parseJurisdiction,
  parseMic,
  parseReference,
  parseRegistrySnapshot,
  parseRepresentationId,
  parseRepresentationRecord,
  parseTicker,
  validateCanonicalAssetId,
} from '@mandate/registry';
import {
  collectProviderRoutes,
  evaluateRoutes,
  parseProviderRouteQuote,
  parseProviderRouteSet,
  parseTrustedRouteCosts,
  resolveHandoff,
  route,
  selectEvaluated,
} from '@mandate/router';
import {
  parseAdvisoryContext,
  parseJevChoiceResponse,
  parseJevModels,
  selectWithJev,
} from '../src/index.ts';

/** The one hostile corpus every public boundary in this file is probed with. */
const ARBITRARY_STRING = 'not a valid request!';

const HOSTILE_PLAIN_VALUES: readonly unknown[] = [
  null,
  undefined,
  false,
  true,
  0,
  1,
  '',
  ARBITRARY_STRING,
  [],
  {},
  { malformed: { nested: true } },
];

interface BoundaryCase {
  readonly packageName: 'kernel' | 'registry' | 'router' | 'jev';
  readonly exportName: string;
  readonly invoke: (raw: unknown) => unknown | Promise<unknown>;
  readonly refuses: (result: unknown) => boolean;
}

export const EXTERNAL_DECISION_BOUNDARIES: readonly BoundaryCase[] = [
  {
    packageName: 'kernel', exportName: 'verify', invoke: (raw) => verify(raw),
    refuses: (result) => (result as { decision?: unknown }).decision === 'REJECT',
  },
  {
    packageName: 'kernel', exportName: 'applyTransition', invoke: (raw) => applyTransition(raw),
    refuses: (result) => (result as { ok?: unknown }).ok === false,
  },
  {
    packageName: 'kernel', exportName: 'isAvailable', invoke: (raw) => isAvailable(raw),
    refuses: (result) => result === false,
  },
  {
    packageName: 'registry', exportName: 'openRegistry', invoke: (raw) => openRegistry(raw),
    refuses: (result) => (result as { ok?: unknown }).ok === false,
  },
  {
    packageName: 'router', exportName: 'collectProviderRoutes', invoke: (raw) => collectProviderRoutes(raw),
    refuses: (result) => (result as { ok?: unknown }).ok === false,
  },
  {
    packageName: 'router', exportName: 'evaluateRoutes', invoke: (raw) => evaluateRoutes(raw),
    refuses: (result) => (result as { status?: unknown }).status === 'INVALID_INPUT',
  },
  {
    packageName: 'router', exportName: 'route', invoke: (raw) => route(raw, raw),
    refuses: (result) => (result as { status?: unknown }).status === 'INVALID_INPUT',
  },
  {
    packageName: 'router', exportName: 'selectEvaluated', invoke: (raw) => selectEvaluated(raw, 0, raw),
    refuses: (result) => (result as { status?: unknown }).status === 'INVALID_INPUT',
  },
  {
    packageName: 'router', exportName: 'resolveHandoff', invoke: (raw) => resolveHandoff(raw, raw),
    refuses: (result) => (result as { ok?: unknown }).ok === false,
  },
  {
    packageName: 'jev', exportName: 'selectWithJev', invoke: (raw) => selectWithJev(raw),
    refuses: (result) => (result as { status?: unknown }).status === 'INVALID_INPUT',
  },
] as const;

/**
 * Construction boundaries are probed with the same corpus as decision
 * boundaries, not a weaker one.
 *
 * It used to be a separate nine-value list with no `''` and no arbitrary
 * string, which left the single most likely wrong-type input for a parser whose
 * valid domain *is* a string unprobed at 41 of the 43 entrypoints. Aliasing the
 * one corpus rather than restating it means the two cannot drift apart again.
 */
const HOSTILE_CONSTRUCTION_VALUES: readonly unknown[] = HOSTILE_PLAIN_VALUES;

/**
 * The corpus minus the values a particular parser legitimately *accepts*.
 *
 * A few entrypoints have a valid domain that the shared corpus intersects: an
 * empty route set is a real empty set, absent requirements are real absence,
 * and an arbitrary printable string is a real display name or lookup key.
 * Asserting a refusal there would assert a bug. Subtracting by value keeps each
 * exception visible and keeps every other corpus value in force, so a new
 * corpus value reaches these boundaries automatically.
 */
const acceptsInstead = (...accepted: readonly unknown[]): readonly unknown[] =>
  HOSTILE_PLAIN_VALUES.filter((value) => !accepted.some((item) => isDeepStrictEqual(item, value)));

interface ConstructionBoundaryCase {
  readonly packageName: BoundaryCase['packageName'];
  readonly exportName: string;
  readonly invoke: (raw: unknown) => unknown;
  readonly refuses: (result: unknown) => boolean;
  readonly values?: readonly unknown[];
}

const resultRefusal = (result: unknown): boolean => (result as { ok?: unknown }).ok === false;

export const EXTERNAL_CONSTRUCTION_BOUNDARIES: readonly ConstructionBoundaryCase[] = [
  { packageName: 'kernel', exportName: 'parseIdentifier', invoke: parseIdentifier, refuses: resultRefusal },
  { packageName: 'kernel', exportName: 'isIdentifier', invoke: isIdentifier, refuses: (result) => result === false },
  { packageName: 'kernel', exportName: 'parseCanonicalAssetId', invoke: parseCanonicalAssetId, refuses: resultRefusal },
  { packageName: 'kernel', exportName: 'parsePartyId', invoke: (raw) => parsePartyId(raw, 'MALFORMED_MANDATE'), refuses: resultRefusal },
  { packageName: 'kernel', exportName: 'parseMandate', invoke: parseMandate, refuses: resultRefusal },
  { packageName: 'kernel', exportName: 'parseCandidate', invoke: parseCandidate, refuses: resultRefusal },
  { packageName: 'kernel', exportName: 'parseRepresentationState', invoke: parseRepresentationState, refuses: resultRefusal },
  { packageName: 'kernel', exportName: 'parseMarketState', invoke: parseMarketState, refuses: resultRefusal },
  { packageName: 'kernel', exportName: 'parseCorporateActionState', invoke: parseCorporateActionState, refuses: resultRefusal },
  { packageName: 'kernel', exportName: 'parseReplayState', invoke: parseReplayState, refuses: resultRefusal },
  { packageName: 'kernel', exportName: 'parseTrustedState', invoke: parseTrustedState, refuses: resultRefusal },
  { packageName: 'kernel', exportName: 'parseAmount', invoke: parseAmount, refuses: resultRefusal },
  { packageName: 'kernel', exportName: 'parsePrice', invoke: parsePrice, refuses: resultRefusal },
  { packageName: 'kernel', exportName: 'parseProvenance', invoke: parseProvenance, refuses: resultRefusal },
  { packageName: 'kernel', exportName: 'parseBytes32', invoke: (raw) => parseBytes32(raw, 'MALFORMED_MANDATE'), refuses: resultRefusal },
  { packageName: 'kernel', exportName: 'parseUnixSeconds', invoke: (raw) => parseUnixSeconds(raw, 'MALFORMED_TRUSTED_STATE'), refuses: resultRefusal },
  { packageName: 'kernel', exportName: 'parseDurationSeconds', invoke: (raw) => parseDurationSeconds(raw, 'MALFORMED_MANDATE'), refuses: resultRefusal },
  { packageName: 'kernel', exportName: 'parseBigInt', invoke: parseBigInt, refuses: (result) => result === undefined },
  { packageName: 'kernel', exportName: 'parseClock', invoke: parseClock, refuses: resultRefusal },
  { packageName: 'kernel', exportName: 'parseEip712Domain', invoke: parseEip712Domain, refuses: resultRefusal },
  { packageName: 'kernel', exportName: 'parseAuthorizationEnvelope', invoke: parseAuthorizationEnvelope, refuses: resultRefusal },
  { packageName: 'kernel', exportName: 'parseReplayTransition', invoke: parseReplayTransition, refuses: resultRefusal },
  { packageName: 'kernel', exportName: 'parseReconciledOutcome', invoke: parseReconciledOutcome, refuses: resultRefusal },
  { packageName: 'kernel', exportName: 'parseExecutionObservation', invoke: parseExecutionObservation, refuses: resultRefusal },
  { packageName: 'kernel', exportName: 'parseReplayRecord', invoke: parseReplayRecord, refuses: resultRefusal },
  { packageName: 'registry', exportName: 'validateCanonicalAssetId', invoke: validateCanonicalAssetId, refuses: resultRefusal },
  {
    packageName: 'registry', exportName: 'parseDisplayText', invoke: parseDisplayText, refuses: resultRefusal,
    // Printable ASCII within the length bound is what display text *is*.
    values: acceptsInstead(ARBITRARY_STRING),
  },
  { packageName: 'registry', exportName: 'parseMic', invoke: parseMic, refuses: resultRefusal },
  { packageName: 'registry', exportName: 'parseTicker', invoke: parseTicker, refuses: resultRefusal },
  { packageName: 'registry', exportName: 'parseCanonicalAssetRecord', invoke: parseCanonicalAssetRecord, refuses: resultRefusal },
  {
    packageName: 'registry', exportName: 'parseReference', invoke: parseReference, refuses: resultRefusal,
    // Any bounded string is a valid PLAIN reference; resolution, not parsing, decides it is unknown.
    values: acceptsInstead(ARBITRARY_STRING),
  },
  { packageName: 'registry', exportName: 'parseContractAddress', invoke: parseContractAddress, refuses: resultRefusal },
  { packageName: 'registry', exportName: 'parseRepresentationId', invoke: parseRepresentationId, refuses: resultRefusal },
  { packageName: 'registry', exportName: 'parseRepresentationRecord', invoke: parseRepresentationRecord, refuses: resultRefusal },
  { packageName: 'registry', exportName: 'parseRegistrySnapshot', invoke: parseRegistrySnapshot, refuses: resultRefusal },
  {
    packageName: 'registry', exportName: 'parseAdditionalRequirements', invoke: parseAdditionalRequirements, refuses: resultRefusal,
    // Absent requirements and empty requirements are both legitimately empty.
    values: acceptsInstead(null, undefined, {}),
  },
  { packageName: 'registry', exportName: 'parseJurisdiction', invoke: parseJurisdiction, refuses: resultRefusal },
  { packageName: 'router', exportName: 'parseProviderRouteQuote', invoke: parseProviderRouteQuote, refuses: resultRefusal },
  {
    packageName: 'router', exportName: 'parseProviderRouteSet', invoke: parseProviderRouteSet, refuses: resultRefusal,
    // An empty route set is a real empty set, not a malformed one.
    values: acceptsInstead([]),
  },
  {
    packageName: 'router', exportName: 'parseTrustedRouteCosts', invoke: parseTrustedRouteCosts, refuses: resultRefusal,
    // An empty cost set is a real empty set, not a malformed one.
    values: acceptsInstead([]),
  },
  { packageName: 'jev', exportName: 'parseJevChoiceResponse', invoke: (raw) => parseJevChoiceResponse(raw, 'route_selection'), refuses: resultRefusal },
  { packageName: 'jev', exportName: 'parseJevModels', invoke: parseJevModels, refuses: resultRefusal },
  {
    packageName: 'jev', exportName: 'parseAdvisoryContext', invoke: parseAdvisoryContext,
    refuses: (result) => {
      const value = result as { venueReliability?: unknown; quoteFirmness?: unknown };
      return value.venueReliability === 'UNKNOWN' && value.quoteFirmness === 'UNKNOWN';
    },
  },
] as const;

test('the public external-boundary inventory has the documented package coverage', () => {
  assert.deepEqual(
    EXTERNAL_DECISION_BOUNDARIES.map((item) => `${item.packageName}:${item.exportName}`),
    [
      'kernel:verify',
      'kernel:applyTransition',
      'kernel:isAvailable',
      'registry:openRegistry',
      'router:collectProviderRoutes',
      'router:evaluateRoutes',
      'router:route',
      'router:selectEvaluated',
      'router:resolveHandoff',
      'jev:selectWithJev',
    ],
  );
});

test('10 public decision boundaries refuse 11 hostile plain values without throw or mutation', async () => {
  let assertions = 0;
  for (const boundary of EXTERNAL_DECISION_BOUNDARIES) {
    for (const raw of HOSTILE_PLAIN_VALUES) {
      const before = structuredClone(raw);
      let result: unknown;
      await assert.doesNotReject(async () => {
        result = await boundary.invoke(raw);
      }, `${boundary.packageName}:${boundary.exportName} threw for ${String(raw)}`);
      assert.equal(
        boundary.refuses(result),
        true,
        `${boundary.packageName}:${boundary.exportName} did not fail closed for ${String(raw)}`,
      );
      assert.deepEqual(raw, before, `${boundary.packageName}:${boundary.exportName} mutated refused input`);
      assertions += 1;
    }
  }
  assert.equal(assertions, 110);
});

test('43 exported construction boundaries fail closed over the shared hostile corpus', () => {
  let assertions = 0;
  for (const boundary of EXTERNAL_CONSTRUCTION_BOUNDARIES) {
    for (const raw of boundary.values ?? HOSTILE_CONSTRUCTION_VALUES) {
      const before = structuredClone(raw);
      let result: unknown;
      assert.doesNotThrow(() => {
        result = boundary.invoke(raw);
      }, `${boundary.packageName}:${boundary.exportName} threw for ${String(raw)}`);
      assert.equal(boundary.refuses(result), true, `${boundary.packageName}:${boundary.exportName} did not refuse ${String(raw)}`);
      assert.deepEqual(raw, before, `${boundary.packageName}:${boundary.exportName} mutated refused input`);
      assertions += 1;
    }
  }
  // 38 boundaries take the full 11-value corpus; five subtract the corpus
  // values their own valid domain contains. 38 * 11 + 10 + 10 + 8 + 10 + 10.
  assert.equal(assertions, 466);
});
