/**
 * The optional JEV seam (docs/demo/live-ai-lab.md §8).
 *
 * An advisor may rank the candidate ids an agent is about to see, or say
 * nothing. It receives the same untrusted-safe projection a model does and
 * returns ids only. It cannot authorize, sign, reserve, add or alter a
 * candidate, or widen anything: `applyAdvice` ignores any id not already in
 * the set and only annotates order.
 */

import type { CandidateView } from '../runtime/provider.ts';
import type { Role } from '../types.ts';

export interface JevRecommendation {
  /** Candidate ids, best first. */
  readonly ranking: readonly string[];
  readonly source: string;
}

export interface JevAdvisor {
  readonly name: string;
  rank(role: Role, candidates: readonly CandidateView[]): Promise<JevRecommendation | null>;
}

/** Annotate `candidates` with an advisory rank. Unknown ids are ignored; the set itself never changes. */
export function applyAdvice(candidates: readonly CandidateView[], rec: JevRecommendation | null): readonly CandidateView[] {
  if (rec === null) return candidates;
  const known = rec.ranking.filter((id, i) => candidates.some((c) => c.id === id) && rec.ranking.indexOf(id) === i);
  return candidates.map((c) => {
    const i = known.indexOf(c.id);
    return { ...c, advisoryRank: i < 0 ? null : i + 1 };
  });
}
