/**
 * Trust levels for state inputs (design section 8.3).
 *
 * The rule that does the work: an address, an amount, or a constraint value
 * never originates from an untrusted or advisory source. This module makes that
 * checkable rather than aspirational — every observed state value carries the
 * class of the source it came from and the instant it was observed (INV-17),
 * and the verifier refuses to read an authoritative or verified input from an
 * advisory or untrusted one (INV-4).
 *
 * The `Observed<T>` brand is a compile-time aid. TypeScript types are erased at
 * run time and a hostile or careless caller can hand the verifier a plain
 * object shaped like one (ADR 0003). The verifier therefore re-checks
 * provenance at run time on every input it reads; the brand catches the mistake
 * early, the runtime check is the actual boundary.
 */

import { type Result, ok, err } from './result.ts';
import type { ReasonCodeName } from './reason-codes.ts';
import { parseIdentifier, type Identifier } from './identifiers.ts';
import { parseUnixSeconds, type UnixSeconds } from './time.ts';

export const TrustClass = {
  /** The signed mandate; on-chain state read at execution. May influence anything. */
  AUTHORITATIVE: 'AUTHORITATIVE',
  /** Registry entries under change control; configured providers with provenance. May influence admissibility, subject to freshness. */
  VERIFIED: 'VERIFIED',
  /** Model output; heuristic rankings. May influence ordering within an admissible set, and nothing else. */
  ADVISORY: 'ADVISORY',
  /** Model-authored text, tool responses, external content, free text. May influence nothing. */
  UNTRUSTED: 'UNTRUSTED',
} as const;
export type TrustClass = (typeof TrustClass)[keyof typeof TrustClass];

/** The classes that may satisfy a state input the verifier reads. */
const TRUSTED_FOR_AUTHORIZATION: ReadonlySet<TrustClass> = new Set<TrustClass>([
  TrustClass.AUTHORITATIVE,
  TrustClass.VERIFIED,
]);

export function isTrustedForAuthorization(c: TrustClass): boolean {
  return TRUSTED_FOR_AUTHORIZATION.has(c);
}

export interface Provenance {
  readonly trustClass: TrustClass;
  /** Which configured source produced this. An identifier, resolved by the caller's configuration, never free text. */
  readonly sourceId: Identifier;
  /** When the value was observed. Distinct from evaluation time; freshness is the difference. */
  readonly observedAtUnixSeconds: UnixSeconds;
}

declare const ObservedBrand: unique symbol;

/** A value together with where it came from and when. */
export interface Observed<T> {
  readonly value: T;
  readonly provenance: Provenance;
  readonly [ObservedBrand]?: true;
}

export function parseProvenance(raw: unknown): Result<Provenance, ReasonCodeName> {
  if (typeof raw !== 'object' || raw === null) return err('MALFORMED_TRUSTED_STATE');
  const r = raw as Record<string, unknown>;
  const tc = r['trustClass'];
  if (typeof tc !== 'string' || !(tc in TrustClass)) return err('MALFORMED_TRUSTED_STATE');
  const sourceId = parseIdentifier(r['sourceId']);
  if (!sourceId.ok) return err('MALFORMED_TRUSTED_STATE');
  const observedAt = parseUnixSeconds(r['observedAtUnixSeconds'], 'MALFORMED_TRUSTED_STATE');
  if (!observedAt.ok) return observedAt;
  return ok({
    trustClass: tc as TrustClass,
    sourceId: sourceId.value,
    observedAtUnixSeconds: observedAt.value,
  });
}

/**
 * Parse an observed value and refuse it outright if its provenance is advisory
 * or untrusted.
 *
 * This is the fail-closed construction path: `UNTRUSTED_REQUIRED_STATE` is a
 * verdict-bearing reason code, not an exception, so an advisory value reaching
 * a trusted slot is reported in the receipt rather than thrown away.
 */
export function parseObserved<T>(
  raw: unknown,
  parseValue: (v: unknown) => Result<T, ReasonCodeName>,
): Result<Observed<T>, ReasonCodeName> {
  if (typeof raw !== 'object' || raw === null) return err('MALFORMED_TRUSTED_STATE');
  const r = raw as Record<string, unknown>;
  const provenance = parseProvenance(r['provenance']);
  if (!provenance.ok) return provenance;
  if (!isTrustedForAuthorization(provenance.value.trustClass)) return err('UNTRUSTED_REQUIRED_STATE');
  const value = parseValue(r['value']);
  if (!value.ok) return value;
  return ok({ value: value.value, provenance: provenance.value });
}

/** Age in seconds at `now`. Negative when the observation claims to be from the future. */
export function ageSeconds(p: Provenance, now: UnixSeconds): bigint {
  return now - p.observedAtUnixSeconds;
}
