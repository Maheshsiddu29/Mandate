/**
 * C2.1 issue policy (docs/demo/c2-1-authority-review.md §3, §6).
 *
 * Dangerous unsupported instructions can never be dismissed into a signable
 * draft. Soft unsupported items may be acknowledged after the principal has
 * seen that they will not be in the signed mandate. Conflicts and ambiguities
 * clear only when the draft fields change.
 */

import { withField, type DraftIssue, type MandateDraft } from './draft-types.ts';
import { parseUsdc, usdcText } from '../types.ts';

const DANGEROUS = [
  /recipient/i,
  /send (?:funds|profits|output|money)/i,
  /0x[a-f0-9]{40}/i,
  /calldata/i,
  /raw hex/i,
  /ignore (?:previous|all)/i,
  /any venue/i,
  /unbounded leverage/i,
  /whatever leverage/i,
] as const;

/** Authority-sensitive unsupported text that must never be waved through. */
export function isDangerousUnsupported(issue: DraftIssue): boolean {
  if (issue.kind !== 'UNSUPPORTED') return false;
  return DANGEROUS.some((re) => re.test(issue.text));
}

/** Unsupported restrictions that are not enforceable but not execution-toxic. */
export function isSoftUnsupported(issue: DraftIssue): boolean {
  if (issue.kind !== 'UNSUPPORTED') return false;
  return !isDangerousUnsupported(issue);
}

export type ResolveRefusal =
  | 'DANGEROUS_UNSUPPORTED'
  | 'CONFLICT_NEEDS_EDIT'
  | 'AMBIGUOUS_NEEDS_EDIT'
  | 'UNSUPPORTED_NEEDS_ACK'
  | 'BAD_INDEX';

/**
 * Remove an issue only when dismissal is safe. Dangerous unsupported and
 * unresolved conflicts/ambiguities refuse — the principal must edit instead.
 * Soft unsupported requires `acknowledgeSoftUnsupported: true`.
 * NEEDS_CLARIFICATION may be cleared after the principal has edited.
 */
export function resolveIssueSafe(d: MandateDraft, index: number, opts: { readonly acknowledgeSoftUnsupported?: boolean } = {}): { readonly ok: true; readonly draft: MandateDraft } | { readonly ok: false; readonly code: ResolveRefusal; readonly message: string } {
  if (!Number.isSafeInteger(index) || index < 0 || index >= d.issues.length) {
    return { ok: false, code: 'BAD_INDEX', message: 'index must name an open issue.' };
  }
  const issue = d.issues[index] as DraftIssue;
  if (isDangerousUnsupported(issue)) {
    return { ok: false, code: 'DANGEROUS_UNSUPPORTED', message: 'This instruction is refused and cannot be authorized. Change the prompt or remove the request; Mandate will not add a trusted recipient, calldata, or unbounded venue from language.' };
  }
  if (issue.kind === 'CONFLICT') {
    return { ok: false, code: 'CONFLICT_NEEDS_EDIT', message: 'Resolve the conflict by choosing a value or editing the draft; it cannot be dismissed.' };
  }
  if (issue.kind === 'AMBIGUOUS') {
    return { ok: false, code: 'AMBIGUOUS_NEEDS_EDIT', message: 'Supply the missing value; an ambiguous authority field cannot be dismissed.' };
  }
  if (issue.kind === 'UNSUPPORTED' && !opts.acknowledgeSoftUnsupported) {
    return { ok: false, code: 'UNSUPPORTED_NEEDS_ACK', message: 'Acknowledge that this restriction will not be in the signed mandate, or edit to a supported equivalent.' };
  }
  return { ok: true, draft: { ...d, issues: d.issues.filter((_, i) => i !== index) } };
}

/**
 * Resolve a form-vs-prompt capital conflict by writing the chosen total as USER
 * and dropping matching CONFLICT issues on portfolio.totalCapital.
 */
export function choosePortfolioTotal(d: MandateDraft, totalUsdc: string): { readonly ok: true; readonly draft: MandateDraft } | { readonly ok: false; readonly message: string } {
  const atoms = parseUsdc(totalUsdc);
  if (atoms === null || atoms < 0n) return { ok: false, message: 'total must be a non-negative USDC amount.' };
  const text = usdcText(atoms);
  let out = withField(d, 'portfolio.totalCapital', text, 'USER');
  // Keep deployable coherent when it was mirroring the prompt total.
  if (out.portfolio.maxDeployed !== null) {
    const max = parseUsdc(out.portfolio.maxDeployed);
    if (max === null || max > atoms) out = withField(out, 'portfolio.maxDeployed', text, 'USER');
  } else {
    out = withField(out, 'portfolio.maxDeployed', text, 'USER');
  }
  out = {
    ...out,
    issues: out.issues.filter((i) => !(i.kind === 'CONFLICT' && (i.field === 'portfolio.totalCapital' || /which total/i.test(i.text) || /portfolio capital conflict/i.test(i.text)))),
  };
  return { ok: true, draft: out };
}

/** Whether the draft's own issues still block authorization under C2.1 policy. */
export function draftIssuesBlockAuthorize(d: MandateDraft): boolean {
  return d.issues.some((i) => i.kind === 'CONFLICT' || i.kind === 'AMBIGUOUS' || i.kind === 'NEEDS_CLARIFICATION' || i.kind === 'UNSUPPORTED');
}
