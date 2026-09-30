/**
 * The advisor the lab ships: it never ranks. The existing `@mandate/jev`
 * ranks router routes over the Phase 5 closed-set projection; mapping
 * portfolio candidates onto it would need behaviour it does not document,
 * so it is not wired in (docs/demo/live-ai-lab.md §8).
 */

import type { CandidateView } from '../runtime/provider.ts';
import type { Role } from '../types.ts';
import type { JevAdvisor, JevRecommendation } from './advisor.ts';

export class NoopJevAdvisor implements JevAdvisor {
  readonly name = 'noop';

  rank(_role: Role, _candidates: readonly CandidateView[]): Promise<JevRecommendation | null> {
    return Promise.resolve(null);
  }
}
