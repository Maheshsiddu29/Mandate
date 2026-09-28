/**
 * Invariant results and their evidence (action-state-model.md §7; FAIL-1;
 * brief §16, §44).
 *
 * Every applicable invariant is evaluated — each lineage node's (the union,
 * authority-model.md §4) and every principal-global one — and every result is
 * kept, not only the first failure, so a refusal explains itself completely.
 * The action passes only if every result `HOLDS`: `VIOLATED` refuses as
 * `INVARIANT_FAILED`, and `UNKNOWN` — missing input, an unresolvable
 * definition, a module that could not account for part of its domain —
 * refuses as `INVARIANT_UNKNOWN`. An invariant that cannot be evaluated has
 * not held.
 *
 * A result is evidence for a later receipt (7H): which invariant (the whole
 * term, parameters included), whose semantics evaluated it (Core, or an exact
 * `ModuleRef`), the observed value and the bound, which admitted snapshots and
 * which unresolved reservations it rested on, the projection digest and the
 * ledger version whose pending set was projected. References, not copies.
 */

import type { ByteWriter } from '@mandate/kernel';
import {
  keccakDigest,
  writeDigest,
  writeModuleRef,
  writeTerm,
  type Digest32,
  type LedgerVersion,
  type ReservationId,
  type StateId,
  type StateInvariantTerm,
  type Tagged,
} from '@mandate/core';
import { ok } from '@mandate/kernel';
import type { Evaluator } from './catalog.ts';
import { ControlTag, controlWriter, sortCanonical, writeDigestList, writeNullableMeasure } from './encoding.ts';
import { refuse, type ControlResult } from './errors.ts';
import type { InvariantOutcome, Measure } from './module.ts';
import type { ProjectionDigest } from './projection.ts';

export type InvariantResultsDigest = Tagged<Digest32, 'InvariantResultsDigest'>;

/** Root-local (from a grant on the lineage) or principal-global (from the principal policy). */
export type InvariantOrigin = 'LINEAGE' | 'POLICY';

export interface InvariantResult {
  readonly origin: InvariantOrigin;
  readonly term: StateInvariantTerm;
  readonly evaluator: Evaluator;
  readonly outcome: InvariantOutcome;
  readonly reason: string;
  readonly observed: Measure | null;
  readonly bound: Measure | null;
  readonly states: readonly StateId[];
  readonly reservations: readonly ReservationId[];
  readonly projection: ProjectionDigest;
  readonly ledgerVersion: LedgerVersion;
}

const ORIGIN_CODE = { LINEAGE: 1, POLICY: 2 } as const;
const OUTCOME_CODE = { HOLDS: 1, VIOLATED: 2, UNKNOWN: 3 } as const;

function writeEvaluator(w: ByteWriter, e: Evaluator): void {
  switch (e.kind) {
    case 'NONE':
      w.u8(0);
      break;
    case 'CORE':
      w.u8(1);
      break;
    case 'MODULE':
      w.u8(2);
      writeModuleRef(w, e.module);
      break;
  }
}

export function writeInvariantResult(w: ByteWriter, r: InvariantResult): void {
  w.u8(ORIGIN_CODE[r.origin]);
  writeTerm(w, r.term);
  writeEvaluator(w, r.evaluator);
  w.u8(OUTCOME_CODE[r.outcome]).str(r.reason);
  writeNullableMeasure(w, r.observed);
  writeNullableMeasure(w, r.bound);
  writeDigestList(w, r.states);
  writeDigestList(w, r.reservations);
  writeDigest(w, r.projection);
  w.u64(r.ledgerVersion);
}

/** Results in canonical order: the order they were evaluated in never changes the digest. */
export function canonicalResults(results: readonly InvariantResult[]): InvariantResult[] {
  return sortCanonical(results, writeInvariantResult);
}

export function invariantResultsDigest(results: readonly InvariantResult[]): InvariantResultsDigest {
  const w = controlWriter(ControlTag.INVARIANT_RESULTS);
  const sorted = canonicalResults(results);
  w.u32(sorted.length);
  for (const r of sorted) writeInvariantResult(w, r);
  return keccakDigest<InvariantResultsDigest>(w.finish());
}

/** PASS only if every result holds. Any violation refuses as such; otherwise any unknown refuses as unknown. */
export function invariantVerdict(results: readonly InvariantResult[], path = 'invariants'): ControlResult<true> {
  const sorted = canonicalResults(results);
  const detail = { kind: 'INVARIANTS', results: sorted } as const;
  const violated = sorted.find((r) => r.outcome === 'VIOLATED');
  if (violated !== undefined) return refuse('INVARIANT_FAILED', violated.reason, `${path}.${violated.term.invariantId}`, { module: violated.evaluator.kind === 'MODULE' ? violated.evaluator.module : null, detail });
  const open = sorted.find((r) => r.outcome === 'UNKNOWN');
  if (open !== undefined) return refuse('INVARIANT_UNKNOWN', open.reason, `${path}.${open.term.invariantId}`, { module: open.evaluator.kind === 'MODULE' ? open.evaluator.module : null, detail });
  return ok(true);
}
