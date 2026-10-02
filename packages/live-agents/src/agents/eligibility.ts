/**
 * Candidate eligibility: which **discovered** candidates are **actionable**.
 *
 * ```text
 * discovered (every candidate the agent meets)
 *   ─▶ eligibility (this module: deterministic, from the active mandate and the reviewed tables)
 *   ─▶ actionable (the only candidates the model is offered)
 *   ─▶ model choice ─▶ trusted proposal builder ─▶ FULL Mandate screening (discovery.ts)
 * ```
 *
 * A candidate is actionable when nothing *static* about it — its identity
 * and the scope facts of the action it resolves to — puts it outside the
 * agent's authority or the portfolio's. That is decided by the portfolio's
 * own rules, not a copy of them: the domain binding's `resolveCandidate`
 * (for the stock agent, the registry's `evaluateRepresentation`) and
 * `permits` under the agent's scope and the portfolio's — exactly what
 * `screenProposal` runs. There is no second policy here, and no candidate
 * is named: whichever candidates the mandate admits are actionable.
 *
 * **Eligibility is advisory, never authorization.** It decides what the
 * model is asked to optimize over, so a capable model spends its choice on
 * actions that could actually be authorized. The proposal the model then
 * makes is built, signed and screened in full exactly as before — asset,
 * issuer, representation, venue, recipient, amount, agent authority,
 * freshness, portfolio resources. A compromised model, a bug here, a stale
 * client or a fabricated id changes what is *asked for*, never what
 * Mandate permits.
 *
 * Checks that depend on the amount, on time or on other agents — agent and
 * portfolio limits, shared resources, quote age and slippage, windows,
 * replay — are **not** evaluated here; they stay with the final screening,
 * the Room and the verifier. Eligibility fails closed: a candidate that
 * cannot be built, validated or resolved is not actionable.
 */

import { agentPolicyOf, canonicalReasons, permits, reason, resolveCandidate, validateActionCandidate, type Reason } from '@mandate/portfolio';
import { demoParty } from '@mandate/portfolio/demo';
import type { ActiveMandate } from '../authoring/mandate-versioning.ts';
import type { Role } from '../types.ts';
import type { TrustedCandidate } from './spec.ts';

/**
 * Scope codes that are facts of the candidate itself, the same at every size
 * and every moment: a candidate refused for one of them can never be
 * authorized under this mandate. Everything else `permits` can say (quote
 * age, slippage) depends on the quote and is left to the final screening.
 */
export const STATIC_SCOPE_CODES: ReadonlySet<string> = new Set([
  'DOMAIN_NOT_ALLOWED',
  'ACTION_NOT_ALLOWED',
  'CHAIN_NOT_ALLOWED',
  'VENUE_NOT_ALLOWED',
  'ROUTE_NOT_ALLOWED',
  'ASSET_NOT_ALLOWED',
  'REPRESENTATION_NOT_ALLOWED',
  'ISSUER_NOT_ALLOWED',
  'RECIPIENT_NOT_ALLOWED',
  'SYNTHETIC_NOT_ALLOWED',
  'REQUIRED_RIGHT_MISSING',
  'LEVERAGE_NOT_ALLOWED',
]);

export interface CandidateEligibility {
  /** The candidate itself, never a copy: filtering changes visibility, not meaning. */
  readonly candidate: TrustedCandidate;
  readonly actionable: boolean;
  /** Why it is not actionable, canonical; empty when it is. */
  readonly reasons: readonly Reason[];
}

export interface CandidateUniverse {
  /** Every candidate the agent met, in its original order. */
  readonly discovered: readonly TrustedCandidate[];
  /** The subset the model may choose from, in the same order. */
  readonly actionable: readonly TrustedCandidate[];
  /** Discovery only: kept as evidence, never offered as a choice. */
  readonly excluded: readonly CandidateEligibility[];
}

/**
 * Partitions discovered candidates. Replaceable in `DiscoveryDeps` only so
 * adversarial tests can simulate a broken or bypassed filter and show that
 * Mandate's screening still refuses on its own.
 */
export type EligibilityFilter = (active: ActiveMandate, role: Role, candidates: readonly TrustedCandidate[], now: bigint) => CandidateUniverse;

const excluded = (candidate: TrustedCandidate, reasons: readonly Reason[]): CandidateEligibility => ({ candidate, actionable: false, reasons: canonicalReasons(reasons) });

/** One candidate, probed at its minimum size and observed `now`: identity and static scope only. */
export function assessCandidate(active: ActiveMandate, role: Role, candidate: TrustedCandidate, now: bigint): CandidateEligibility {
  const policy = agentPolicyOf(active.mandate, demoParty(role));
  if (policy === null) return excluded(candidate, [reason('AGENT_UNKNOWN', role)]);
  let built;
  try {
    built = validateActionCandidate(candidate.build(candidate.minAtoms, now));
  } catch {
    return excluded(candidate, [reason('INSTRUMENT_UNKNOWN', `candidate:${candidate.id}`)]);
  }
  if (!built.ok) return excluded(candidate, [reason('INSTRUMENT_UNKNOWN', `candidate:${built.error.code}`)]);
  // Identity that does not resolve stops screening for every size: never actionable.
  const resolution = resolveCandidate(active.compiled.bindings, active.mandate, policy, built.value, now);
  if (!resolution.ok) return excluded(candidate, resolution.reasons.length > 0 ? resolution.reasons : [reason('INSTRUMENT_UNKNOWN', `candidate:${candidate.id}`)]);
  const scope = [...permits(policy.scope, resolution.action, now), ...permits(active.mandate.scope, resolution.action, now)].filter((r) => STATIC_SCOPE_CODES.has(r.code));
  return scope.length === 0 ? { candidate, actionable: true, reasons: [] } : excluded(candidate, scope);
}

/** The deterministic filter every normal discovery uses. */
export const actionableCandidates: EligibilityFilter = (active, role, candidates, now) => {
  const assessed = candidates.map((c) => assessCandidate(active, role, c, now));
  return {
    discovered: candidates,
    actionable: assessed.filter((a) => a.actionable).map((a) => a.candidate),
    excluded: assessed.filter((a) => !a.actionable),
  };
};

