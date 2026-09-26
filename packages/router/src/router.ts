import {
  Decision,
  compareAmounts,
  mandateDigest,
  parseAmount,
  parseAuthorizationEnvelope,
  parseClock,
  parseEip712Domain,
  parseMandate,
  parseTrustedState,
  trustedStateDigest,
  verify,
  type Amount,
  type AuthorizationEnvelope,
  type CanonicalMandate,
  type Clock,
  type Eip712Domain,
  type TrustedState,
  type UnixSeconds,
  type VerificationReceipt,
  type VerifyRequest,
} from '@mandate/kernel';
import {
  Admissibility,
  deriveRequirements,
  evaluateRepresentation,
  listRepresentations,
  openRegistry,
  registrySnapshotDigest,
  type Registry,
  type RepresentationDecision,
} from '@mandate/registry';
import { buildRoutingCandidate } from './candidate.ts';
import { parseTrustedRouteCosts } from './cost-state.ts';
import { routingReceiptDigest } from './encoding.ts';
import { parseProviderRouteSet } from './provider.ts';
import {
  ROUTER_VERSION,
  ROUTING_RECEIPT_SCHEMA_VERSION,
  type RouteExclusion,
  type RouteOutcome,
  type RouteQuality,
  type RoutingCandidate,
  type RoutingReceipt,
  type RoutingResult,
} from './types.ts';

export interface RouteRequest {
  readonly mandate: unknown;
  readonly authorization: unknown;
  /** Parsed again from its snapshot at this public boundary; indexes are never trusted. */
  readonly registry: Registry | unknown;
  readonly trustedMarketState: unknown;
  readonly requestedQuantity: unknown;
  readonly routes: unknown;
  readonly trustedCosts: unknown;
  readonly clock: unknown;
  readonly expectedDomain: unknown;
}

/**
 * Trusted state and time as they are at execution handoff.
 *
 * Mandatory and separate from the evaluation inputs (ADR 0016). Before Phase 5R
 * the handoff re-verification read the evaluation state, which made it a
 * tautology for a deterministic verifier — `FINAL_REVERIFICATION_FAILED` was
 * unreachable. A caller that genuinely has only one snapshot now says so by
 * passing it twice, which is a visible decision rather than an invisible
 * default.
 *
 * If fresh state cannot be obtained there is nothing to pass, and the call
 * fails rather than proceeding on stale state: **no fresh state, no handoff.**
 */
export interface HandoffInputs {
  readonly trustedMarketState: unknown;
  readonly clock: unknown;
}

type Verifier = (request: VerifyRequest) => VerificationReceipt;

// These brands separate values produced by this module's parsing/evaluation
// boundary from structurally similar plain objects. They are intentionally not
// exported: a caller can consume an evaluation, but cannot construct a trusted
// one by assertion-free ordinary TypeScript.
const VALIDATED_ROUTING_CONTEXT: unique symbol = Symbol('validated-routing-context');
const VALIDATED_ROUTING_EVALUATION: unique symbol = Symbol('validated-routing-evaluation');
const validatedRoutingContexts = new WeakSet<object>();
const validatedRoutingEvaluations = new WeakSet<object>();

/**
 * One kernel-PASS candidate, with the quality inputs its ranking position was
 * computed from and the receipt that admitted it.
 */
export interface AdmissibleRoute {
  readonly candidate: RoutingCandidate;
  readonly quality: RouteQuality;
  readonly verificationReceipt: VerificationReceipt;
}

/** The parsed, trusted inputs a routing decision was computed over. */
export interface RoutingContext {
  readonly [VALIDATED_ROUTING_CONTEXT]: true;
  readonly mandate: CanonicalMandate;
  readonly authorization: AuthorizationEnvelope;
  readonly registry: Registry;
  readonly trustedState: TrustedState;
  readonly clock: Clock;
  readonly expectedDomain: Eip712Domain;
  readonly requestedQuantity: Amount;
}

/**
 * A closed admissible set and the inputs that produced it.
 *
 * `admissible` is already in the deterministic ranking order of ADR 0010 —
 * index 0 is the deterministic preferred candidate. Nothing outside this array
 * may become an execution handoff, and the array is complete: every route the
 * registry and the kernel admitted appears in it exactly once.
 */
export interface RoutingEvaluation {
  readonly [VALIDATED_ROUTING_EVALUATION]: true;
  readonly context: RoutingContext;
  readonly admissible: readonly AdmissibleRoute[];
  readonly outcomes: readonly RouteOutcome[];
}

export type RoutingEvaluationResult =
  | { readonly status: 'EVALUATED'; readonly evaluation: RoutingEvaluation }
  | { readonly status: 'INVALID_INPUT'; readonly errors: readonly RouteExclusion[] };

function isValidatedRoutingContext(raw: unknown): raw is RoutingContext {
  return typeof raw === 'object'
    && raw !== null
    && !Array.isArray(raw)
    && validatedRoutingContexts.has(raw);
}

function isValidatedRoutingEvaluation(raw: unknown): raw is RoutingEvaluation {
  return typeof raw === 'object'
    && raw !== null
    && !Array.isArray(raw)
    && validatedRoutingEvaluations.has(raw);
}

function validatedContext(value: Omit<RoutingContext, typeof VALIDATED_ROUTING_CONTEXT>): RoutingContext {
  Object.defineProperty(value, VALIDATED_ROUTING_CONTEXT, { value: true });
  validatedRoutingContexts.add(value);
  return value as RoutingContext;
}

function validatedEvaluation(value: Omit<RoutingEvaluation, typeof VALIDATED_ROUTING_EVALUATION>): RoutingEvaluation {
  Object.defineProperty(value, VALIDATED_ROUTING_EVALUATION, { value: true });
  validatedRoutingEvaluations.add(value);
  return value as RoutingEvaluation;
}

/**
 * Stage one: parse, filter and rank. No selection and no final verification.
 *
 * Splitting evaluation from selection exists so an advisory selector can be
 * offered the already-closed admissible set without a second ranking
 * implementation. The ranking here is the only ranking in the system.
 */
export function evaluateRoutes(request: RouteRequest | unknown, verifier: Verifier = verify): RoutingEvaluationResult {
  const r: Record<string, unknown> =
    typeof request === 'object' && request !== null && !Array.isArray(request)
      ? request as Record<string, unknown>
      : {};
  const mandate = parseMandate(r['mandate']);
  const authorization = parseAuthorizationEnvelope(r['authorization']);
  const trustedState = parseTrustedState(r['trustedMarketState']);
  const clock = parseClock(r['clock']);
  const domain = parseEip712Domain(r['expectedDomain']);
  const requestedQuantity = parseAmount(r['requestedQuantity']);
  const quotes = parseProviderRouteSet(r['routes']);
  const costs = parseTrustedRouteCosts(r['trustedCosts']);
  // Re-open the snapshot rather than trusting caller-supplied Map indexes. This
  // both totalizes malformed registry inputs and leaves one strict parser as the
  // only path to a registry used for a decision.
  const rawRegistry = r['registry'];
  const registry = openRegistry(
    typeof rawRegistry === 'object' && rawRegistry !== null && !Array.isArray(rawRegistry)
      ? (rawRegistry as Record<string, unknown>)['snapshot']
      : undefined,
  );
  const inputErrors: RouteExclusion[] = [];
  if (!mandate.ok) inputErrors.push(inputError('mandate', mandate.error));
  if (!authorization.ok) inputErrors.push(inputError('authorization', authorization.error));
  if (!trustedState.ok) inputErrors.push(inputError('trustedMarketState', trustedState.error));
  if (!clock.ok) inputErrors.push(inputError('clock', clock.error));
  if (!domain.ok) inputErrors.push(inputError('expectedDomain', domain.error));
  if (!requestedQuantity.ok) inputErrors.push(inputError('requestedQuantity', requestedQuantity.error));
  if (!quotes.ok) inputErrors.push(quotes.error);
  if (!costs.ok) inputErrors.push(costs.error);
  if (!registry.ok) inputErrors.push(inputError('registry', registry.error));
  if (inputErrors.length > 0 || !mandate.ok || !authorization.ok || !trustedState.ok || !clock.ok || !domain.ok || !requestedQuantity.ok || !quotes.ok || !costs.ok || !registry.ok) {
    return { status: 'INVALID_INPUT', errors: inputErrors };
  }

  // The registry and the trusted state are two independent Verified-class
  // inputs describing the same representations, and before Phase 5R nothing
  // required them to have come from the same snapshot (finding F-7). The
  // admissibility pass and the kernel's semantics checks could therefore read
  // two different registries.
  //
  // The binding is no longer opt-in (Phase 5R.1, finding N-8). It used to accept
  // a state that declared no snapshot, on the grounds that the whole-state digest
  // on the candidate covered it incidentally. Removing that digest equality
  // (ADR 0017) removed the incidental cover, so an undeclared snapshot is now an
  // unestablished binding, and unestablished fails closed.
  const snapshotDigest = registrySnapshotDigest(registry.value.snapshot);
  const declared = trustedState.value.registrySnapshotDigest;
  if (declared === null) {
    return {
      status: 'INVALID_INPUT',
      errors: [{ code: 'REGISTRY_SNAPSHOT_UNKNOWN', detail: { input: 'trustedMarketState', evaluated: snapshotDigest } }],
    };
  }
  if (declared !== snapshotDigest) {
    return {
      status: 'INVALID_INPUT',
      errors: [{ code: 'REGISTRY_SNAPSHOT_MISMATCH', detail: { declared, evaluated: snapshotDigest } }],
    };
  }

  const requirements = deriveRequirements(mandate.value, { nowUnixSeconds: clock.value.nowUnixSeconds });
  if (!requirements.ok) return { status: 'INVALID_INPUT', errors: [inputError('requirements', requirements.error)] };
  const discovered = listRepresentations(registry.value, requirements.value.canonicalAsset);
  const decisions = new Map<string, RepresentationDecision>();
  for (const representation of discovered) {
    decisions.set(representation.representationId.value, evaluateRepresentation(registry.value, requirements.value, representation.representationId.value));
  }

  const outcomes: RouteOutcome[] = [];
  const ranked: AdmissibleRoute[] = [];
  const candidateDigests = new Set<string>();
  for (const quote of quotes.value) {
    const registryDecision = decisions.get(quote.representationId);
    if (registryDecision === undefined) {
      outcomes.push(excluded(quote.routeId, [{ code: 'REPRESENTATION_NOT_DISCOVERABLE', detail: { representationId: quote.representationId } }]));
      continue;
    }
    if (registryDecision.status === Admissibility.EXCLUDED) {
      outcomes.push(excluded(quote.routeId, registryDecision.exclusions));
      continue;
    }
    const built = buildRoutingCandidate({
      mandate: mandate.value,
      quote,
      trustedState: trustedState.value,
      trustedCost: costs.value.get(quote.routeId),
      requestedQuantity: requestedQuantity.value,
      nowUnixSeconds: clock.value.nowUnixSeconds,
      registrySnapshotDigest: snapshotDigest,
    });
    if (!built.ok) {
      outcomes.push(excluded(quote.routeId, built.exclusions));
      continue;
    }
    if (candidateDigests.has(built.candidate.candidateDigest)) {
      return { status: 'INVALID_INPUT', errors: [{ code: 'DUPLICATE_CANDIDATE', detail: { candidateDigest: built.candidate.candidateDigest } }] };
    }
    candidateDigests.add(built.candidate.candidateDigest);
    const verification = verifier({
      mandate: mandate.value,
      authorization: authorization.value,
      candidate: built.candidate.executionCandidate,
      trustedState: trustedState.value,
      clock: clock.value,
      expectedDomain: domain.value,
    });
    if (verification.decision === Decision.REJECT) {
      outcomes.push(excluded(quote.routeId, verification.violations.map((violation) => ({ code: violation.code, detail: violation.detail })), built.candidate.candidateDigest, verification));
      continue;
    }
    outcomes.push({
      routeId: quote.routeId,
      status: 'ADMISSIBLE',
      candidateDigest: built.candidate.candidateDigest,
      quality: built.quality,
      verificationReceipt: verification,
    });
    ranked.push({ candidate: built.candidate, quality: built.quality, verificationReceipt: verification });
  }

  ranked.sort((left, right) => compareRanked(left, right, mandate.value.side));
  const sortedOutcomes = [...outcomes].sort((left, right) => left.routeId < right.routeId ? -1 : left.routeId > right.routeId ? 1 : 0);
  const context = validatedContext({
    mandate: mandate.value,
    authorization: authorization.value,
    registry: registry.value,
    trustedState: trustedState.value,
    clock: clock.value,
    expectedDomain: domain.value,
    requestedQuantity: requestedQuantity.value,
  });
  return {
    status: 'EVALUATED',
    evaluation: validatedEvaluation({ context, admissible: ranked, outcomes: sortedOutcomes }),
  };
}

/**
 * Stage two: re-verify one member of the closed set and build the receipt.
 *
 * `index` must address `evaluation.admissible`. An out-of-range index is a
 * caller defect rather than a financial decision, so it refuses the whole
 * evaluation instead of silently choosing something else.
 */
export function selectEvaluated(
  evaluation: RoutingEvaluation | unknown,
  index: number | unknown,
  handoff: HandoffInputs | unknown,
  verifier: Verifier = verify,
): RoutingResult {
  if (!isValidatedRoutingEvaluation(evaluation)) {
    return { status: 'INVALID_INPUT', errors: [inputError('evaluation', 'UNVALIDATED_ROUTING_EVALUATION')] };
  }
  return selectValidatedEvaluation(evaluation, index, handoff, verifier);
}

function selectValidatedEvaluation(
  evaluation: RoutingEvaluation,
  index: number | unknown,
  handoff: HandoffInputs | unknown,
  verifier: Verifier,
): RoutingResult {
  const { context, admissible, outcomes } = evaluation;

  // Parsed before anything else: a handoff that cannot be established is not a
  // reason to fall back on evaluation state, it is a reason not to hand off.
  const resolved = resolveValidatedHandoff(handoff, context);
  if (!resolved.ok) return { status: 'INVALID_INPUT', errors: resolved.errors };
  const { trustedState: handoffState, clock: handoffClock } = resolved;
  const handoffDigest = trustedStateDigest(handoffState);

  if (admissible.length === 0) {
    return { status: 'NO_VALID_ROUTE', finalVerificationReceipt: null, receipt: finishReceipt(context, outcomes, [], null, null, handoffDigest, handoffClock.nowUnixSeconds) };
  }
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= admissible.length) {
    return { status: 'INVALID_INPUT', errors: [{ code: 'INPUT_INVALID', detail: { input: 'selectedIndex', cause: String(index) } }] };
  }

  const selected = admissible[index] as AdmissibleRoute;
  const finalVerification = verifier({
    mandate: context.mandate,
    authorization: context.authorization,
    candidate: selected.candidate.executionCandidate,
    trustedState: handoffState,
    clock: handoffClock,
    expectedDomain: context.expectedDomain,
  });
  const rankedDigests = admissible.map((item) => item.candidate.candidateDigest);
  if (finalVerification.decision !== Decision.PASS) {
    const revised = outcomes.map((outcome) => outcome.candidateDigest === selected.candidate.candidateDigest
      ? excluded(outcome.routeId, [{ code: 'FINAL_REVERIFICATION_FAILED', detail: { receiptDigest: finalVerification.receiptDigest } }], outcome.candidateDigest, finalVerification)
      : outcome);
    return { status: 'NO_VALID_ROUTE', finalVerificationReceipt: finalVerification, receipt: finishReceipt(context, revised, rankedDigests, null, finalVerification.receiptDigest, handoffDigest, handoffClock.nowUnixSeconds) };
  }
  return {
    status: 'SELECTED',
    selected: selected.candidate,
    finalVerificationReceipt: finalVerification,
    receipt: finishReceipt(context, outcomes, rankedDigests, selected.candidate.candidateDigest, finalVerification.receiptDigest, handoffDigest, handoffClock.nowUnixSeconds),
  };
}

export type ResolvedHandoff =
  | { readonly ok: true; readonly trustedState: TrustedState; readonly clock: Clock }
  | { readonly ok: false; readonly errors: readonly RouteExclusion[] };

/**
 * Parse the handoff inputs and enforce the two pipeline invariants the router can
 * enforce: **time does not run backwards between stages**, and **the registry
 * snapshot does not change under an already-ranked candidate**.
 *
 * The kernel stays pure and accepts whatever instant it is given, which is what
 * makes a verdict reproducible. It sees one instant per call and cannot know it
 * is the second of two, so the monotonicity check belongs here, in the component
 * that is the pipeline (ADR 0016).
 *
 * A caller that rewinds both instants consistently still defeats every age
 * bound. No off-chain component can detect that; `block.timestamp` at the
 * Phase 6 gate closes it, and until then the orchestrator's clock is a named
 * member of the trusted computing base.
 */
export function resolveHandoff(handoff: HandoffInputs | unknown, context: RoutingContext | unknown): ResolvedHandoff {
  if (!isValidatedRoutingContext(context)) {
    return { ok: false, errors: [inputError('evaluation.context', 'UNVALIDATED_ROUTING_CONTEXT')] };
  }
  return resolveValidatedHandoff(handoff, context);
}

function resolveValidatedHandoff(handoff: HandoffInputs | unknown, context: RoutingContext): ResolvedHandoff {
  if (typeof handoff !== 'object' || handoff === null || Array.isArray(handoff)) {
    return { ok: false, errors: [{ code: 'HANDOFF_STATE_MISSING', detail: { input: 'handoff' } }] };
  }
  const h = handoff as Record<string, unknown>;
  const state = parseTrustedState(h['trustedMarketState']);
  const clock = parseClock(h['clock']);
  const errors: RouteExclusion[] = [];
  if (!state.ok) errors.push(inputError('handoff.trustedMarketState', state.error));
  if (!clock.ok) errors.push(inputError('handoff.clock', clock.error));
  if (errors.length > 0 || !state.ok || !clock.ok) return { ok: false, errors };

  if (clock.value.nowUnixSeconds < context.clock.nowUnixSeconds) {
    return {
      ok: false,
      errors: [{
        code: 'HANDOFF_TIME_REGRESSED',
        detail: { evaluatedAt: String(context.clock.nowUnixSeconds), handoffAt: String(clock.value.nowUnixSeconds) },
      }],
    };
  }

  // The second pipeline invariant, and the one the removal of whole-state digest
  // equality made load-bearing (finding N-8): **the registry does not change
  // under a candidate.** Fresh dynamic state is the point of the handoff; a fresh
  // *registry* is not, because the admissible set was computed against the old
  // one. The kernel repeats this comparison against the candidate's own
  // commitment; the router states it here as well so the refusal says "reroute"
  // rather than arriving as one rejected candidate among several.
  //
  // There is no compatibility proof in this phase, so this fails closed. A later
  // phase may add one — a proof that the entries a candidate depends on are
  // unchanged across two snapshots — and this is where it would go.
  const evaluatedSnapshot = registrySnapshotDigest(context.registry.snapshot);
  const declaredSnapshot = state.value.registrySnapshotDigest;
  if (declaredSnapshot === null) {
    return {
      ok: false,
      errors: [{ code: 'REGISTRY_SNAPSHOT_UNKNOWN', detail: { input: 'handoff.trustedMarketState', evaluated: evaluatedSnapshot } }],
    };
  }
  if (declaredSnapshot !== evaluatedSnapshot) {
    return {
      ok: false,
      errors: [{
        code: 'REGISTRY_SNAPSHOT_MISMATCH',
        detail: { input: 'handoff.trustedMarketState', declared: declaredSnapshot, evaluated: evaluatedSnapshot },
      }],
    };
  }

  return { ok: true, trustedState: state.value, clock: clock.value };
}

/**
 * The deterministic baseline: evaluate, take the top-ranked candidate, and
 * re-verify it. This is the only selection policy in the system; anything
 * advisory reuses these two stages rather than re-implementing either.
 */
export function route(request: RouteRequest | unknown, handoff: HandoffInputs | unknown, verifier: Verifier = verify): RoutingResult {
  const evaluated = evaluateRoutes(request, verifier);
  if (evaluated.status === 'INVALID_INPUT') return evaluated;
  return selectEvaluated(evaluated.evaluation, 0, handoff, verifier);
}

function compareRanked(left: AdmissibleRoute, right: AdmissibleRoute, side: 'BUY' | 'SELL'): number {
  const economic = compareAmounts(left.quality.economicValue, right.quality.economicValue);
  if (economic.ok && economic.value !== 0) return side === 'BUY' ? economic.value : -economic.value;
  if (left.quality.executionDeviationBps !== right.quality.executionDeviationBps) return left.quality.executionDeviationBps < right.quality.executionDeviationBps ? -1 : 1;
  if (left.quality.quoteAgeSeconds !== right.quality.quoteAgeSeconds) return left.quality.quoteAgeSeconds < right.quality.quoteAgeSeconds ? -1 : 1;
  if (left.quality.routeSteps !== right.quality.routeSteps) return left.quality.routeSteps - right.quality.routeSteps;
  return left.candidate.candidateDigest < right.candidate.candidateDigest ? -1 : left.candidate.candidateDigest > right.candidate.candidateDigest ? 1 : 0;
}

function excluded(routeId: string, exclusions: readonly RouteExclusion[], candidateDigest: RouteOutcome['candidateDigest'] = null, verificationReceipt: VerificationReceipt | null = null): RouteOutcome {
  return { routeId, status: 'EXCLUDED', candidateDigest, exclusions: canonicalExclusions(exclusions), verificationReceipt };
}

function canonicalExclusions(exclusions: readonly RouteExclusion[]): RouteExclusion[] {
  const keyed = new Map<string, RouteExclusion>();
  for (const item of exclusions) {
    const key = `${item.code}:${Object.entries(item.detail).sort().map(([name, value]) => `${name}=${value}`).join('|')}`;
    if (!keyed.has(key)) keyed.set(key, item);
  }
  return [...keyed.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, item]) => item);
}

function inputError(input: string, cause: string): RouteExclusion {
  return { code: 'INPUT_INVALID', detail: { input, cause } };
}

function finishReceipt(
  context: RoutingContext,
  outcomes: readonly RouteOutcome[],
  rankedCandidateDigests: RoutingReceipt['rankedCandidateDigests'],
  selectedCandidateDigest: RoutingReceipt['selectedCandidateDigest'],
  finalVerificationReceiptDigest: RoutingReceipt['finalVerificationReceiptDigest'],
  handoffStateDigest: RoutingReceipt['handoffStateDigest'] = null,
  handoffAtUnixSeconds: RoutingReceipt['handoffAtUnixSeconds'] = null,
): RoutingReceipt {
  const unsigned = {
    version: ROUTING_RECEIPT_SCHEMA_VERSION,
    routerVersion: ROUTER_VERSION,
    mandateDigest: mandateDigest(context.mandate),
    registrySnapshotDigest: registrySnapshotDigest(context.registry.snapshot),
    marketStateDigest: trustedStateDigest(context.trustedState),
    requestedQuantity: context.requestedQuantity,
    outcomes,
    rankedCandidateDigests,
    selectedCandidateDigest,
    finalVerificationReceiptDigest,
    evaluatedAtUnixSeconds: context.clock.nowUnixSeconds as UnixSeconds,
    handoffStateDigest,
    handoffAtUnixSeconds,
  };
  return { ...unsigned, receiptDigest: routingReceiptDigest(unsigned) };
}
