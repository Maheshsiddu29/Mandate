/**
 * C2.0 natural-language mandate compiler
 * (docs/demo/c2-natural-language-mandate-compiler.md).
 *
 * ```text
 * prompt (+ optional form + optional model interpretation)
 *   → deterministic local extract
 *   → model fill only where local left null
 *   → form merge with explicit-vs-explicit conflict detection
 *   → deterministic derivations + over-allocation conflicts
 *   → MandateDraft (still not authority)
 * ```
 *
 * Extraction is outside the execution trust boundary. Signing still
 * requires `MandateVersions.authorize` / wallet V2.
 */

import { classifyAllocation, draftDeployable } from '../allocation/intent.ts';
import { ROLES, parseUsdc, usdcText, type Role } from '../types.ts';
import { fieldAt, withField, type DraftIssue, type FieldSource, type MandateDraft } from './draft-types.ts';
import { draftFromInterpretation, interpretLocally, preferExplicitPrompt, type DraftInterpretation } from './prompt-to-draft.ts';

const EXPLICIT: ReadonlySet<FieldSource> = new Set(['USER', 'EXPLICIT_PROMPT']);

export interface CompileInput {
  readonly prompt: string;
  /** Existing form/draft values the principal already set (USER provenance preferred). */
  readonly form?: MandateDraft | null;
  /** Parsed model interpretation, when a model answered in schema. */
  readonly modelInterpretation?: DraftInterpretation | null;
}

export interface CompileResult {
  readonly draft: MandateDraft;
  /** Allocation view after compilation (for clarifications / UI). */
  readonly allocationIntent: ReturnType<typeof classifyAllocation>;
}

function valuesEqual(a: string | boolean | readonly string[] | null | undefined, b: string | boolean | readonly string[] | null | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  if (typeof a === 'string' && typeof b === 'string') {
    const aa = parseUsdc(a);
    const bb = parseUsdc(b);
    if (aa !== null && bb !== null) return aa === bb;
  }
  return false;
}

/** Paths that grant or bound authority and must conflict rather than silently prefer. */
const AUTHORITY_PATHS: readonly string[] = [
  'portfolio.totalCapital',
  'portfolio.maxDeployed',
  'portfolio.minUnallocated',
  'portfolio.deployAll',
  'portfolio.maxDerivative',
  'portfolio.maxIlliquid',
  'portfolio.autoReallocate',
  'market.maxLeverage',
  ...ROLES.flatMap((r) => [`agents.${r}.enabled`, `agents.${r}.maxAllocation`, `agents.${r}.budget`] as const),
];

/**
 * Merge a form draft onto a prompt-derived draft.
 * Explicit form vs explicit prompt disagreement → CONFLICT, both values kept
 * from the form for display, with the prompt value named in the issue.
 */
export function mergeFormOntoPrompt(promptDraft: MandateDraft, form: MandateDraft): MandateDraft {
  let out = promptDraft;
  const issues: DraftIssue[] = [...promptDraft.issues];
  for (const path of AUTHORITY_PATHS) {
    const formValue = fieldAt(form, path);
    const promptValue = fieldAt(promptDraft, path);
    const formSource = form.provenance[path];
    const promptSource = promptDraft.provenance[path];
    if (formValue === null || formValue === undefined || formSource === undefined) continue;
    if (promptValue === null || promptValue === undefined || promptSource === undefined) {
      out = withField(out, path, formValue, formSource, form.evidence[path]?.sourceText);
      continue;
    }
    if (valuesEqual(formValue, promptValue)) {
      out = withField(out, path, formValue, formSource === 'USER' ? 'USER' : promptSource, form.evidence[path]?.sourceText ?? promptDraft.evidence[path]?.sourceText);
      continue;
    }
    if (EXPLICIT.has(formSource) && EXPLICIT.has(promptSource)) {
      issues.push({
        kind: 'CONFLICT',
        field: path,
        text: `You entered ${stringify(formValue)}, but your prompt says ${stringify(promptValue)}. Which should Mandate authorize?`,
      });
      // Keep the form value visible; do not hide the conflict.
      out = withField(out, path, formValue, 'USER', form.evidence[path]?.sourceText);
      continue;
    }
    if (formSource === 'USER' || (EXPLICIT.has(formSource) && !EXPLICIT.has(promptSource))) {
      out = withField(out, path, formValue, formSource, form.evidence[path]?.sourceText);
    }
  }
  // Carry non-authority form fills (markets, etc.) when prompt left them unset.
  for (const [path, source] of Object.entries(form.provenance)) {
    if (AUTHORITY_PATHS.includes(path)) continue;
    if (fieldAt(out, path) !== null && fieldAt(out, path) !== undefined) continue;
    const v = fieldAt(form, path);
    if (v === null || v === undefined) continue;
    out = withField(out, path, v, source, form.evidence[path]?.sourceText);
  }
  return { ...out, issues: dedupeIssues([...issues, ...out.issues]).slice(0, 12) };
}

function stringify(v: string | boolean | readonly string[]): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return /^[\d.]+$/.test(v) ? `$${v}` : v;
  return v.join(', ');
}

function dedupeIssues(xs: readonly DraftIssue[]): DraftIssue[] {
  return [...new Map(xs.map((i) => [`${i.kind}|${i.field}|${i.text}`, i])).values()];
}

/** Fixed budgets that exceed deployable capital → CONFLICT. */
export function overAllocationIssues(d: MandateDraft): readonly DraftIssue[] {
  const view = classifyAllocation(d);
  if (view.deployableAtoms === null) return [];
  if (view.fixedAtoms <= view.deployableAtoms) return [];
  const over = view.fixedAtoms - view.deployableAtoms;
  return [{
    kind: 'CONFLICT',
    field: 'portfolio.totalCapital',
    text: `Requested fixed allocations exceed portfolio authority by ${usdcText(over)} USDC. Edit the budgets or the total; Mandate will not silently reduce either.`,
  }];
}

/** Tag local evidence spans onto an admitted draft. */
function withPromptEvidence(d: MandateDraft, prompt: string): MandateDraft {
  const evidence = { ...d.evidence };
  const clip = (s: string) => s.trim().slice(0, 120);
  const lower = prompt.toLowerCase();
  for (const [path, source] of Object.entries(d.provenance)) {
    if (source !== 'EXPLICIT_PROMPT' && source !== 'DETERMINISTIC_DERIVED') continue;
    if (evidence[path] !== undefined) continue;
    if (path.startsWith('agents.')) {
      const role = path.split('.')[1] as Role;
      const hit = new RegExp(String.raw`.{0,40}${role}.{0,40}`, 'i').exec(prompt) ?? new RegExp(String.raw`.{0,40}${role === 'perps' ? 'perp' : role}.{0,40}`, 'i').exec(lower);
      if (hit !== null) evidence[path] = { sourceText: clip(hit[0]) };
    } else if (path.includes('totalCapital') || path.includes('maxDeployed')) {
      const hit = /\$\s?[\d,]+(?:\.\d+)?\s*k?|\d[\d,]*(?:\.\d+)?\s*(?:k|usd|dollars?)/i.exec(prompt);
      if (hit !== null) evidence[path] = { sourceText: clip(hit[0]) };
    }
  }
  return { ...d, evidence };
}

/**
 * Compile a natural-language prompt (and optional form / model output) into
 * a MandateDraft. Never authority.
 */
export function compileMandateDraft(input: CompileInput): CompileResult {
  const local = interpretLocally(input.prompt);
  let draft: MandateDraft;
  if (input.modelInterpretation !== null && input.modelInterpretation !== undefined) {
    const merged = preferExplicitPrompt(input.modelInterpretation, input.prompt);
    draft = overlayPromptWins(draftFromInterpretation(local, 'EXPLICIT_PROMPT'), draftFromInterpretation(merged, 'MODEL_EXTRACTED'), local);
  } else {
    draft = draftFromInterpretation(local, 'EXPLICIT_PROMPT');
  }
  draft = withPromptEvidence(draft, input.prompt);
  if (input.form !== null && input.form !== undefined) draft = mergeFormOntoPrompt(draft, input.form);
  const overs = overAllocationIssues(draft);
  if (overs.length > 0) draft = { ...draft, issues: dedupeIssues([...draft.issues, ...overs]).slice(0, 12) };
  return { draft, allocationIntent: classifyAllocation(draft) };
}

/**
 * Start from the model draft, then force every field the local parser set.
 * Preserves MODEL_EXTRACTED on fields only the model supplied.
 */
function overlayPromptWins(localDraft: MandateDraft, modelDraft: MandateDraft, local: DraftInterpretation): MandateDraft {
  let out = modelDraft;
  const issues = dedupeIssues([...localDraft.issues, ...modelDraft.issues]);
  const notes = [...localDraft.notes, ...modelDraft.notes].filter((n, i, arr) => arr.indexOf(n) === i).slice(0, 8);
  for (const path of Object.keys(localDraft.provenance)) {
    const v = fieldAt(localDraft, path);
    if (v === null || v === undefined) continue;
    out = withField(out, path, v, 'EXPLICIT_PROMPT', localDraft.evidence[path]?.sourceText);
  }
  // Local agent enablements for roles the local parser mentioned.
  for (const a of local.agents) {
    if (a.enabled !== null) out = withField(out, `agents.${a.role}.enabled`, a.enabled, 'EXPLICIT_PROMPT');
    if (a.maxAllocation !== null) out = withField(out, `agents.${a.role}.maxAllocation`, a.maxAllocation, 'EXPLICIT_PROMPT');
    if (a.budget !== null) out = withField(out, `agents.${a.role}.budget`, a.budget, 'EXPLICIT_PROMPT');
    if (a.maxExposure !== null) out = withField(out, `agents.${a.role}.maxExposure`, a.maxExposure, 'EXPLICIT_PROMPT');
  }
  return { ...out, issues: issues.slice(0, 12), notes };
}

/** Local-only compile (tests / offline). */
export function compileLocalPrompt(prompt: string, form?: MandateDraft | null): CompileResult {
  return compileMandateDraft({ prompt, form: form ?? null, modelInterpretation: null });
}

export { draftDeployable };
