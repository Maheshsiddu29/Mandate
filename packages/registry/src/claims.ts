/**
 * Claims: a security-relevant property together with where it came from (ADR 0006).
 *
 * The registry is the most security-critical component Mandate has after the
 * verifier, because the verifier is only as correct as the metadata it is handed
 * (design section 17.6). So the question this module answers is not "what is the
 * value" but "under what evidence is a value allowed to influence an execution".
 *
 * A property is therefore a *set* of claims, not a value. The kernel's
 * `Observed<T>` carries one value from one source and its parser refuses advisory
 * and untrusted provenance outright; a registry has to be able to *hold* a claim
 * it will refuse to act on, so that refusing to act on it is visible and
 * auditable rather than implicit in what was never stored.
 *
 * Two rules here decide security outcomes, and one of them is easy to get
 * backwards:
 *
 * - **A claim below the trust floor cannot establish a value.** Obvious, and it
 *   is what stops a favourable property being promoted out of advisory data.
 * - **A claim below the trust floor also cannot create a conflict.** Less
 *   obvious, and getting it wrong introduces a vulnerability: if an advisory
 *   claim could raise `CONFLICT`, anyone able to inject one could make any
 *   representation inadmissible — denial of service achieved with exactly the
 *   class of input the trust model exists to neutralize. "May influence nothing"
 *   has to include the refusal, not only the permission.
 */

import { err, ok, parseProvenance, TrustClass, type Provenance, type Result, type UnixSeconds } from '@mandate/kernel';
import type { RegistryReasonCodeName } from './reason-codes.ts';
import { MAX_CLAIMS_PER_PROPERTY } from './limits.ts';

/** One assertion about one property, by one source, at one time. */
export interface Claim<T> {
  readonly value: T;
  readonly provenance: Provenance;
}

/**
 * Zero or more claims about one property.
 *
 * Zero is a meaningful state and is distinct from a claim nobody trusts: the
 * first is missing data, the second is data from the wrong kind of source, and
 * they get different reason codes because they need different remedies.
 */
export type ClaimSet<T> = readonly Claim<T>[];

export const ClaimState = {
  ESTABLISHED: 'ESTABLISHED',
  UNKNOWN: 'UNKNOWN',
  CONFLICT: 'CONFLICT',
} as const;
export type ClaimState = (typeof ClaimState)[keyof typeof ClaimState];

/** Why a property could not be established. Each maps to its own reason code. */
export const UnknownReason = {
  /** No source has said anything about this property. */
  NO_CLAIMS: 'NO_CLAIMS',
  /** Claims exist, and every one is below the trust floor. */
  BELOW_TRUST_FLOOR: 'BELOW_TRUST_FLOOR',
  /** Claims exist at or above the floor, and every one is older than the caller's bound. */
  STALE: 'STALE',
} as const;
export type UnknownReason = (typeof UnknownReason)[keyof typeof UnknownReason];

export type ClaimResolution<T> =
  | { readonly state: 'ESTABLISHED'; readonly value: T; readonly provenance: Provenance }
  | { readonly state: 'UNKNOWN'; readonly reason: UnknownReason }
  | { readonly state: 'CONFLICT'; readonly claims: ClaimSet<T> };

/**
 * Trust ranking.
 *
 * Used **only** to test a claim against a floor. It is deliberately not used as a
 * precedence order for resolving disagreements: ADR 0006 rejects
 * authoritative-beats-verified, because that quietly converts a statement about
 * what a source may influence into a priority it was never validated as.
 */
const TRUST_RANK: Record<TrustClass, number> = {
  [TrustClass.UNTRUSTED]: 0,
  [TrustClass.ADVISORY]: 1,
  [TrustClass.VERIFIED]: 2,
  [TrustClass.AUTHORITATIVE]: 3,
};

export function meetsTrustFloor(actual: TrustClass, floor: TrustClass): boolean {
  return (TRUST_RANK[actual] ?? -1) >= (TRUST_RANK[floor] ?? 0);
}

/**
 * The floor for anything that gates an execution.
 *
 * `VERIFIED`, matching the kernel's `isTrustedForAuthorization`, so a property
 * the registry is willing to establish is one the kernel is willing to read.
 */
export const EXECUTION_TRUST_FLOOR: TrustClass = TrustClass.VERIFIED;


export interface ClaimPolicy {
  readonly minimumTrust: TrustClass;
  /** Evaluation instant. The registry never reads a clock; time arrives as a value. */
  readonly nowUnixSeconds: UnixSeconds;
  /**
   * Maximum claim age, or null for no bound.
   *
   * Metadata staleness and state staleness are different problems with different
   * tolerances (design section 6.5), so the registry embeds no freshness constant
   * and the caller supplies the bound it needs.
   */
  readonly maxClaimAgeSeconds: bigint | null;
}

/**
 * Resolve a claim set to a single state.
 *
 * `keyOf` renders a value as a comparison key, because values here range from
 * enum strings to structured canonical asset identifiers, and using `===` would
 * silently treat two equal identifiers as a conflict.
 *
 * Deterministic: with the same claims and the same policy the result is identical,
 * including which claim's provenance is reported, so a decision is reproducible.
 */
export function resolveClaimSet<T>(
  claims: ClaimSet<T>,
  policy: ClaimPolicy,
  keyOf: (value: T) => string,
): ClaimResolution<T> {
  if (claims.length === 0) return { state: ClaimState.UNKNOWN, reason: UnknownReason.NO_CLAIMS };

  const atFloor = claims.filter((c) => meetsTrustFloor(c.provenance.trustClass, policy.minimumTrust));
  // Sub-floor claims stop here, for both establishment and conflict. See the
  // module comment: excluding them from conflict detection is what stops an
  // injected advisory claim from being able to refuse an honest representation.
  if (atFloor.length === 0) return { state: ClaimState.UNKNOWN, reason: UnknownReason.BELOW_TRUST_FLOOR };

  const fresh = atFloor.filter((c) => {
    const age = policy.nowUnixSeconds - c.provenance.observedAtUnixSeconds;
    // A claim observed after the evaluation instant means a broken clock or a
    // broken source, so its freshness cannot be established. It fails closed
    // rather than counting as maximally fresh, matching the kernel's rule.
    if (age < 0n) return false;
    return policy.maxClaimAgeSeconds === null ? true : age <= policy.maxClaimAgeSeconds;
  });
  if (fresh.length === 0) return { state: ClaimState.UNKNOWN, reason: UnknownReason.STALE };

  const distinct = new Set(fresh.map((c) => keyOf(c.value)));
  if (distinct.size > 1) {
    // Fails closed unconditionally. No most-recent-wins, no trust precedence, no
    // majority: each is a way for one bad source to override curation, and a
    // conflict is information a curator must act on rather than launder.
    return { state: ClaimState.CONFLICT, claims: sortClaims(fresh, keyOf) };
  }

  // Which claim's provenance to report is a presentation choice, not a decision:
  // every claim here agrees on the value. Ordered so the answer is stable.
  const best = sortClaims(fresh, keyOf)[fresh.length - 1] as Claim<T>;
  return { state: ClaimState.ESTABLISHED, value: best.value, provenance: best.provenance };
}

/**
 * Total order over claims: trust rank, then observation time, then source, then
 * value. Used for deterministic reporting and for the snapshot digest's ordering.
 */
export function sortClaims<T>(claims: ClaimSet<T>, keyOf: (value: T) => string): ClaimSet<T> {
  return [...claims].sort((a, b) => {
    const ra = TRUST_RANK[a.provenance.trustClass] ?? -1;
    const rb = TRUST_RANK[b.provenance.trustClass] ?? -1;
    if (ra !== rb) return ra - rb;
    if (a.provenance.observedAtUnixSeconds !== b.provenance.observedAtUnixSeconds) {
      return a.provenance.observedAtUnixSeconds < b.provenance.observedAtUnixSeconds ? -1 : 1;
    }
    if (a.provenance.sourceId !== b.provenance.sourceId) {
      return a.provenance.sourceId < b.provenance.sourceId ? -1 : 1;
    }
    const ka = keyOf(a.value);
    const kb = keyOf(b.value);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * Parse a claim set.
 *
 * Unlike the kernel's `parseObserved`, this accepts **any** trust class. That is
 * the deliberate difference: the registry records what each source said,
 * including sources it will not act on, so that declining to act on them is an
 * auditable fact rather than an absence. The trust floor is applied at resolution
 * time by `resolveClaimSet`, not here.
 */
export function parseClaimSet<T>(
  raw: unknown,
  parseValue: (v: unknown) => Result<T, RegistryReasonCodeName>,
  keyOf: (value: T) => string,
): Result<ClaimSet<T>, RegistryReasonCodeName> {
  if (!Array.isArray(raw)) return err('SNAPSHOT_MALFORMED');
  // The encoder counts claims as a u16, so a set past that bound is refused
  // here rather than discovered when a digest is computed over it.
  if (raw.length > MAX_CLAIMS_PER_PROPERTY) return err('SNAPSHOT_RESOURCE_LIMIT_EXCEEDED');
  const out: Claim<T>[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return err('SNAPSHOT_MALFORMED');
    const e = entry as Record<string, unknown>;
    for (const k of Object.keys(e)) {
      if (k !== 'value' && k !== 'provenance') return err('SNAPSHOT_MALFORMED');
    }
    const provenance = parseProvenance(e['provenance']);
    if (!provenance.ok) return err('SNAPSHOT_MALFORMED');
    const value = parseValue(e['value']);
    if (!value.ok) return value;
    // One source asserting one value twice at one instant is a duplicate, and a
    // caller that submitted it did not build the record it believed it built.
    const key = `${provenance.value.trustClass}\u0000${provenance.value.sourceId}\u0000${provenance.value.observedAtUnixSeconds}\u0000${keyOf(value.value)}`;
    if (seen.has(key)) return err('SNAPSHOT_MALFORMED');
    seen.add(key);
    out.push({ value: value.value, provenance: provenance.value });
  }
  return ok(sortClaims(out, keyOf));
}
