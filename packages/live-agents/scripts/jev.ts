/**
 * Attaches Jev (TypeSafe's Score primitive, `@mandate/jev`) to the Live AI
 * Lab's Planning and Reallocation Rooms, when a credential is configured.
 *
 * The composition root, not the library: `src/` holds only the
 * `OpportunityScorer` interface and never imports the client. The key is
 * read by `@mandate/jev` alone and never printed. Without one there is no
 * scorer, and no score is invented (docs/v2/mandate-room-v2.md §6).
 */

import { TypeSafeJevClient, hasUsableApiKey, opportunityScorer } from '@mandate/jev';
import type { OpportunityScorer } from '../src/jev/scorer.ts';

export function configuredScorer(): OpportunityScorer | undefined {
  return hasUsableApiKey() ? opportunityScorer(new TypeSafeJevClient()) : undefined;
}
