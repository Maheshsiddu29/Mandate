/**
 * Pre-execution requirements (Phase 7E.1 F-4; signer-architecture.md §7).
 *
 * Issue-time revalidation of market state is one condition among several that
 * must hold immediately before an artifact may exist. The issuance boundary
 * evaluates a list of typed requirements — all before `ADMIT_ATTEMPT` — and
 * binds the ordered results into the attempt, so the attempt names exactly
 * what was checked.
 *
 * The vocabulary is closed and versioned with this package, and has three
 * kinds of member:
 *
 * - **Control-evaluated** — `STATE_REVALIDATION`, `MODULE_TRUST`,
 *   `ADAPTER_TRUST`. The engine computes these itself; a caller can never
 *   supply a verdict for one.
 * - **Adapter-evaluated** — `CREDENTIAL_SCOPE`, `NONCE_SLOT`. A pure rule the
 *   adapter ran over evidence it read (a venue's key listing, its next nonce);
 *   the adapter supplies the result with a digest of that evidence.
 * - **Reserved** — `RUNTIME_PROVENANCE`, `RUNTIME_CERTIFICATION`,
 *   `HARNESS_ATTESTATION`. They exist so that adding their evaluators later is
 *   an evaluator, not a new signer contract. No evaluator exists yet, so a
 *   requirement of a reserved kind is `UNKNOWN` and refuses every issuance,
 *   and a caller-supplied result for one is refused as a claim of a check
 *   that did not run.
 *
 * Every required requirement must have exactly one result, and every result
 * must be `PASS`. `FAIL` and `UNKNOWN` both refuse: there is no "proceed
 * anyway".
 */

import { ok, type Identifier } from '@mandate/kernel';
import { keccakDigest, parseIdentifierAs, parseNonZeroDigest, writeDigest, type Digest32, type Tagged } from '@mandate/core';
import { ControlTag, controlWriter } from './encoding.ts';
import { refuse, type ControlResult } from './errors.ts';

export const PRE_EXECUTION_KINDS = [
  'STATE_REVALIDATION',
  'MODULE_TRUST',
  'ADAPTER_TRUST',
  'CREDENTIAL_SCOPE',
  'NONCE_SLOT',
  'RUNTIME_PROVENANCE',
  'RUNTIME_CERTIFICATION',
  'HARNESS_ATTESTATION',
] as const;
export type PreExecutionKind = (typeof PRE_EXECUTION_KINDS)[number];

/** Evaluated by the control engine itself; never accepted from a caller. */
export const CONTROL_EVALUATED: readonly PreExecutionKind[] = ['STATE_REVALIDATION', 'MODULE_TRUST', 'ADAPTER_TRUST'];
/** Evaluated by the enforcement adapter over evidence it read, and supplied with that evidence's digest. */
export const ADAPTER_EVALUATED: readonly PreExecutionKind[] = ['CREDENTIAL_SCOPE', 'NONCE_SLOT'];
/** Reserved for runtime provenance work; no evaluator exists, so requiring one refuses. */
export const RESERVED_KINDS: readonly PreExecutionKind[] = ['RUNTIME_PROVENANCE', 'RUNTIME_CERTIFICATION', 'HARNESS_ATTESTATION'];

export type PreExecutionOutcome = 'PASS' | 'FAIL' | 'UNKNOWN';

export interface PreExecutionRequirement {
  readonly kind: PreExecutionKind;
  /** What it is about, as an identifier in the requiring party's vocabulary: an account, a key, a runtime. */
  readonly subject: string;
}

export interface PreExecutionResult {
  readonly kind: PreExecutionKind;
  readonly subject: string;
  readonly outcome: PreExecutionOutcome;
  /** An identifier; for anything but `PASS`, what failed or was missing. */
  readonly reason: string;
  /** Digest of the evidence the result was computed from. */
  readonly evidence: Digest32;
}

export type PreExecutionDigest = Tagged<Digest32, 'PreExecutionDigest'>;
type PreExecutionText = Tagged<Identifier, 'PreExecutionText'>;

function key(kind: string, subject: string): string {
  return JSON.stringify([kind, subject]);
}

function writeResult(w: ReturnType<typeof controlWriter>, r: PreExecutionResult): void {
  w.str(r.kind).str(r.subject).str(r.outcome).str(r.reason);
  writeDigest(w, r.evidence);
}

/** Results in canonical order: by kind, in vocabulary order, then subject. */
export function canonicalResults(results: readonly PreExecutionResult[]): readonly PreExecutionResult[] {
  return [...results].sort((a, b) => {
    const k = PRE_EXECUTION_KINDS.indexOf(a.kind) - PRE_EXECUTION_KINDS.indexOf(b.kind);
    return k !== 0 ? k : a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0;
  });
}

/** The digest an attempt commits to: every result, in canonical order. */
export function preExecutionDigest(results: readonly PreExecutionResult[]): PreExecutionDigest {
  const w = controlWriter(ControlTag.PRE_EXECUTION);
  const ordered = canonicalResults(results);
  w.u16(ordered.length);
  for (const r of ordered) writeResult(w, r);
  return keccakDigest<PreExecutionDigest>(w.finish());
}

/** A control-evaluated result's evidence digest: the tagged subject and what it was computed from. */
export function evidenceDigest(kind: PreExecutionKind, subject: string, digests: readonly Digest32[]): Digest32 {
  const w = controlWriter(ControlTag.PRE_EXECUTION_EVIDENCE).str(kind).str(subject);
  w.u16(digests.length);
  for (const d of digests) writeDigest(w, d);
  return keccakDigest<Digest32>(w.finish());
}

function checkShape(r: PreExecutionResult | PreExecutionRequirement, path: string): ControlResult<true> {
  if (!PRE_EXECUTION_KINDS.includes(r.kind)) return refuse('REQUEST_INVALID', 'PRE_EXECUTION_KIND_UNKNOWN', `${path}.kind`);
  if (!parseIdentifierAs<PreExecutionText>(r.subject, `${path}.subject`).ok) return refuse('REQUEST_INVALID', 'PRE_EXECUTION_SUBJECT_INVALID', `${path}.subject`);
  if ('outcome' in r) {
    if (r.outcome !== 'PASS' && r.outcome !== 'FAIL' && r.outcome !== 'UNKNOWN') return refuse('REQUEST_INVALID', 'PRE_EXECUTION_OUTCOME_INVALID', `${path}.outcome`);
    if (!parseIdentifierAs<PreExecutionText>(r.reason, `${path}.reason`).ok) return refuse('REQUEST_INVALID', 'PRE_EXECUTION_REASON_INVALID', `${path}.reason`);
    if (!parseNonZeroDigest(r.evidence, `${path}.evidence`).ok) return refuse('REQUEST_INVALID', 'PRE_EXECUTION_EVIDENCE_INVALID', `${path}.evidence`);
  }
  return ok(true);
}

/**
 * Combine the control-evaluated results with the adapter-supplied ones under
 * `required`, and refuse unless every requirement has exactly one `PASS`.
 * Returns every result, in canonical order, for the attempt to commit.
 */
export function checkPreExecution(required: readonly PreExecutionRequirement[], control: readonly PreExecutionResult[], supplied: readonly PreExecutionResult[]): ControlResult<readonly PreExecutionResult[]> {
  const byKey = new Map<string, PreExecutionResult>();
  for (let i = 0; i < supplied.length; i += 1) {
    const r = supplied[i] as PreExecutionResult;
    const path = `request.results[${i}]`;
    const shape = checkShape(r, path);
    if (!shape.ok) return shape;
    // The engine's own verdicts cannot be supplied, and reserved kinds have no evaluator to have produced one.
    if (CONTROL_EVALUATED.includes(r.kind)) return refuse('REQUEST_INVALID', 'PRE_EXECUTION_CONTROL_RESULT_SUPPLIED', `${path}.kind`);
    if (RESERVED_KINDS.includes(r.kind)) return refuse('REQUEST_INVALID', 'PRE_EXECUTION_NO_EVALUATOR', `${path}.kind`);
    const k = key(r.kind, r.subject);
    if (byKey.has(k)) return refuse('REQUEST_INVALID', 'PRE_EXECUTION_RESULT_DUPLICATED', path);
    byKey.set(k, r);
  }
  for (const r of control) byKey.set(key(r.kind, r.subject), r);

  const requiredKeys = new Set<string>();
  const results: PreExecutionResult[] = [];
  for (let i = 0; i < required.length; i += 1) {
    const q = required[i] as PreExecutionRequirement;
    const path = `request.requirements[${i}]`;
    const shape = checkShape(q, path);
    if (!shape.ok) return shape;
    const k = key(q.kind, q.subject);
    if (requiredKeys.has(k)) return refuse('REQUEST_INVALID', 'PRE_EXECUTION_REQUIREMENT_DUPLICATED', path);
    requiredKeys.add(k);
    const r = byKey.get(k);
    if (r === undefined) {
      const reason = RESERVED_KINDS.includes(q.kind) ? 'NO_EVALUATOR' : 'RESULT_MISSING';
      return refuse('PRE_EXECUTION_FAILED', `${q.kind}.UNKNOWN.${reason}`, path);
    }
    if (r.outcome !== 'PASS') return refuse('PRE_EXECUTION_FAILED', `${q.kind}.${r.outcome}.${r.reason}`, path);
    results.push(r);
  }
  // A result nobody required is noise that would change the digest without meaning anything.
  for (const k of byKey.keys()) if (!requiredKeys.has(k)) return refuse('REQUEST_INVALID', 'PRE_EXECUTION_RESULT_UNREQUIRED', 'request.results');
  return ok(canonicalResults(results));
}
