/**
 * The deterministic verifier — the only component in Mandate that authorizes an
 * execution (design section 10).
 *
 * `verify` is:
 *
 * - **pure** — no network, no filesystem, no clock, no randomness, no
 *   environment. Evaluation time arrives as a parameter.
 * - **total** — every input produces a receipt. It never throws to signal a
 *   financial outcome; malformed input is a REJECT with a reason code, not an
 *   exception a caller might catch and ignore.
 * - **fail-closed** — there is no path that returns PASS when a constraint
 *   could not be established. `UNKNOWN` is a value that rejects.
 * - **model-free** — nothing in this module's dependency graph can reach an
 *   inference client, and a structural test asserts it.
 * - **explaining** — a rejection names every violated constraint, not the first.
 * - **order-independent** — the verdict is the union of independent checks,
 *   and a test shuffles the check list to prove it.
 *
 * It takes `unknown` inputs deliberately. Parsing at the boundary is what makes
 * totality real: a caller cannot hand the verifier something unparseable and
 * receive a thrown error it might treat as a transport failure.
 */

import { type Result } from '../result.ts';
import type { ReasonCodeName } from '../reason-codes.ts';
import { reasonCode } from '../reason-codes.ts';
import { parseMandate } from '../mandate.ts';
import { parseCandidate } from '../candidate.ts';
import { parseTrustedState } from '../state.ts';
import { parseClock } from '../time.ts';
import { parseAuthorizationEnvelope } from '../authorization/envelope.ts';
import { parseEip712Domain, type Eip712Domain } from '../authorization/eip712.ts';
import { candidateDigest, mandateDigest, trustedStateDigest } from '../encoding/digest.ts';
import type { Bytes32 } from '../bytes.ts';
import { Decision, VERIFIER_VERSION, receiptDigest, type VerificationReceipt } from '../receipt.ts';
import { CHECKS, violation, type Check, type CheckContext, type Violation } from './checks.ts';

export interface VerifyRequest {
  readonly mandate: unknown;
  readonly authorization: unknown;
  readonly candidate: unknown;
  readonly trustedState: unknown;
  readonly clock: unknown;
  /**
   * The EIP-712 domain this deployment accepts, from the caller's configuration.
   * Required: the verifier never accepts whatever domain an envelope claims.
   */
  readonly expectedDomain: unknown;
  /** Test seam for order-independence. Defaults to `CHECKS`. */
  readonly checks?: readonly Check[];
}

function collect<T>(r: Result<T, ReasonCodeName>, into: Violation[], detail: Record<string, string>): T | undefined {
  if (r.ok) return r.value;
  into.push(violation(r.error, detail));
  return undefined;
}

/**
 * Sorted by reason-code id, then by the detail's canonical form.
 *
 * Sorting is what makes the receipt's violation order independent of the order
 * checks ran in. Deduplication removes the case where two checks independently
 * report the same missing input with the same detail.
 */
function canonicalize(violations: readonly Violation[]): Violation[] {
  const seen = new Map<string, Violation>();
  for (const v of violations) {
    const detailKey = Object.keys(v.detail)
      .sort()
      .map((k) => `${k}=${v.detail[k]}`)
      .join('\u0000');
    const key = `${reasonCode(v.code).id}\u0000${detailKey}`;
    if (!seen.has(key)) seen.set(key, v);
  }
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
}

export function verify(request: unknown): VerificationReceipt;
export function verify(request: VerifyRequest): VerificationReceipt;
export function verify(request: unknown): VerificationReceipt {
  const parseViolations: Violation[] = [];
  // The function is a public runtime boundary. A TypeScript parameter type does
  // not make null, arrays or other parsed values impossible, so normalize only
  // plain object-shaped input before reading fields from it.
  const r: Record<string, unknown> =
    typeof request === 'object' && request !== null && !Array.isArray(request)
      ? request as Record<string, unknown>
      : {};

  // Every input is parsed independently, so a malformed candidate does not hide
  // a malformed state and the receipt reports both.
  const mandate = collect(parseMandate(r['mandate']), parseViolations, { input: 'mandate' });
  const authorization = collect(parseAuthorizationEnvelope(r['authorization']), parseViolations, { input: 'authorization' });
  const candidate = collect(parseCandidate(r['candidate']), parseViolations, { input: 'candidate' });
  const state = collect(parseTrustedState(r['trustedState']), parseViolations, { input: 'trustedState' });
  const clock = collect(parseClock(r['clock']), parseViolations, { input: 'clock' });
  const expectedDomain = collect(parseEip712Domain(r['expectedDomain']), parseViolations, { input: 'expectedDomain' });

  // Digests are computed outside the check loop, so this is the one place a
  // defect in the encoders could escape as a thrown error from a function
  // documented as total. Every externally sized collection the encoders write is
  // now bounded by its parser above, so reaching the catch means an internal
  // invariant failed rather than that a caller sent something oversized — which
  // is why it reports VERIFIER_INTERNAL_ERROR and names the input, instead of
  // being reported as invalid input. It is visible in the receipt and alertable,
  // and it rejects.
  const digest = <T>(input: T | undefined, of: (value: T) => Bytes32, name: string): Bytes32 | null => {
    if (input === undefined) return null;
    try {
      return of(input);
    } catch {
      parseViolations.push(violation('VERIFIER_INTERNAL_ERROR', { stage: 'digest', input: name }));
      return null;
    }
  };

  const digests = {
    mandateDigest: digest(mandate, mandateDigest, 'mandate'),
    candidateDigest: digest(candidate, candidateDigest, 'candidate'),
    trustedStateDigest: digest(state, trustedStateDigest, 'trustedState'),
    evaluatedAtUnixSeconds: clock === undefined ? null : clock.nowUnixSeconds,
  };

  // Semantic checks need every input. When one is missing the structural
  // violations already explain why, and inventing a partial context to squeeze
  // out more findings would mean checking against values that do not exist.
  if (
    mandate === undefined || authorization === undefined || candidate === undefined ||
    state === undefined || clock === undefined || expectedDomain === undefined ||
    digests.mandateDigest === null || digests.trustedStateDigest === null
  ) {
    return finish(digests, parseViolations);
  }

  const ctx: CheckContext = {
    mandate,
    authorization,
    candidate,
    state,
    clock,
    expectedDomain: expectedDomain as Eip712Domain,
    mandateDigest: digests.mandateDigest,
    trustedStateDigest: digests.trustedStateDigest,
  };

  const found: Violation[] = [...parseViolations];
  const rawChecks = r['checks'];
  const checks = rawChecks === undefined
    ? CHECKS
    : Array.isArray(rawChecks) && rawChecks.every((check) =>
      typeof check === 'object' && check !== null &&
      typeof (check as Record<string, unknown>)['name'] === 'string' &&
      typeof (check as Record<string, unknown>)['run'] === 'function')
      ? rawChecks as unknown as readonly Check[]
      : null;
  if (checks === null) {
    found.push(violation('VERIFIER_INTERNAL_ERROR', { stage: 'checks', input: 'checks' }));
    return finish(digests, found);
  }
  for (const check of checks) {
    // A check that threw would be a bug in this package, but a bug here must not
    // become a PASS. Convert it to a fail-closed violation rather than letting
    // it escape or be swallowed.
    try {
      found.push(...check.run(ctx));
    } catch {
      found.push(violation('VERIFIER_INTERNAL_ERROR', { check: check.name }));
    }
  }

  return finish(digests, found);
}

function finish(
  digests: Pick<VerificationReceipt, 'mandateDigest' | 'candidateDigest' | 'trustedStateDigest' | 'evaluatedAtUnixSeconds'>,
  violations: readonly Violation[],
): VerificationReceipt {
  const canonical = canonicalize(violations);
  const body = {
    verifierVersion: VERIFIER_VERSION,
    ...digests,
    decision: canonical.length === 0 ? Decision.PASS : Decision.REJECT,
    reasonCodes: [...new Set(canonical.map((v) => v.code))],
    violations: canonical,
  };
  return { ...body, receiptDigest: receiptDigest(body) };
}
