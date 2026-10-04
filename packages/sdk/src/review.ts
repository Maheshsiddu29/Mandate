/**
 * Authority review gate — C2.1 fail-closed semantics via existing
 * `@mandate/live-agents` issue policy + draft validation + allocation view.
 *
 * Presentation for the web Approve stage stays in apps/web; this module
 * exposes only the authorization gate an external integrator needs.
 */

import {
  classifyAllocation,
  draftIssuesBlockAuthorize,
  isDangerousUnsupported,
  isSoftUnsupported,
  validateDraft,
  type MandateDraft,
} from '@mandate/live-agents';
import type { DomainBinding } from '@mandate/portfolio';
import type { MandateReview, ReviewBlocker, ReviewIssue } from './types.ts';

export interface ReviewInput {
  readonly draft: MandateDraft;
  readonly now: bigint;
  readonly bindings: readonly DomainBinding[];
  readonly version?: number;
}

function reviewIssues(draft: MandateDraft): readonly ReviewIssue[] {
  return draft.issues.map((issue, index) => ({
    index,
    kind: issue.kind,
    field: issue.field,
    text: issue.text,
    dangerous: isDangerousUnsupported(issue),
    softUnsupported: isSoftUnsupported(issue),
  }));
}

/**
 * Build the structured review gate for a compiled draft.
 * Same fail-closed rule as the Live Lab Authorize path:
 * unresolved issues, validation blockers, missing agent selection, or
 * required planning all refuse `signable`.
 */
export function reviewMandateDraft(input: ReviewInput): MandateReview {
  const allocation = classifyAllocation(input.draft);
  const validation = validateDraft(input.draft, {
    version: input.version ?? 1,
    protocolNow: input.now,
    bindings: input.bindings,
  });
  const issues = reviewIssues(input.draft);
  const blockers: ReviewBlocker[] = [];

  for (const issue of issues) {
    if (issue.kind === 'CONFLICT') blockers.push({ id: `conflict-${issue.index}`, text: issue.text });
    else if (issue.kind === 'AMBIGUOUS') blockers.push({ id: `ambiguous-${issue.index}`, text: issue.text });
    else if (issue.kind === 'NEEDS_CLARIFICATION') blockers.push({ id: `clarify-${issue.index}`, text: issue.text });
    else if (issue.kind === 'UNSUPPORTED') {
      blockers.push({
        id: `unsupported-${issue.index}`,
        text: issue.dangerous ? issue.text : `${issue.text} (not in the signed mandate until acknowledged or removed)`,
      });
    }
  }
  if (allocation.intent === 'NEEDS_AGENT_SELECTION') {
    blockers.push({ id: 'agents', text: 'Choose which agents may use this capital.' });
  }
  if (allocation.planning === 'REQUIRED') {
    const single = allocation.pool.length === 1;
    blockers.push({
      id: 'plan',
      text: single ? 'Review the agent plan before authorizing.' : 'Ask the Planning Room for a split before authorizing.',
    });
  }
  for (const issue of validation.issues) {
    if (issue.severity !== 'BLOCKING') continue;
    if (issue.code === 'INTERPRETATION_UNRESOLVED') continue;
    blockers.push({ id: `val-${issue.code}-${issue.field}`, text: issue.message });
  }

  const signable =
    validation.ok &&
    !draftIssuesBlockAuthorize(input.draft) &&
    allocation.intent !== 'NEEDS_AGENT_SELECTION' &&
    allocation.planning !== 'REQUIRED';

  return {
    draft: input.draft,
    allocation,
    validation,
    issues,
    blockers,
    signable,
    blockerSummary:
      blockers.length === 0 ? '' : `Resolve ${blockers.length} item${blockers.length === 1 ? '' : 's'} before authorizing`,
  };
}
