/**
 * Every editable draft field and the JSON type it takes.
 *
 * An edit from outside the process (the local API, the browser) names a
 * path from this table and a value of its type, or `null` to unset it; a
 * set field takes only ids of its reviewed catalog set. Anything else is
 * refused here. Whether an accepted value makes sense — is "2,000" an
 * amount, does a reserve exceed capital — is still the validator's
 * question, and an edit never authorizes anything.
 */

import { CATALOG_SETS, catalogIds, type CatalogSet } from './catalog.ts';
import type { MandateDraft } from './draft-types.ts';
import { resolveIssueSafe } from './issue-policy.ts';
import { ROLES } from '../types.ts';

export type FieldType = 'text' | 'boolean' | 'ids';

export interface DraftFieldPath {
  readonly path: string;
  readonly type: FieldType;
  /** For `ids`: the catalog set its members come from. */
  readonly set?: CatalogSet;
}

const text = (path: string): DraftFieldPath => ({ path, type: 'text' });

export const DRAFT_FIELD_PATHS: readonly DraftFieldPath[] = [
  ...['totalCapital', 'minUnallocated', 'maxDeployed'].map((f) => text(`portfolio.${f}`)),
  { path: 'portfolio.deployAll', type: 'boolean' },
  ...['maxDerivative', 'maxIlliquid', 'validityMinutes'].map((f) => text(`portfolio.${f}`)),
  { path: 'portfolio.autoReallocate', type: 'boolean' },
  ...ROLES.flatMap((r) => [{ path: `agents.${r}.enabled`, type: 'boolean' as const }, text(`agents.${r}.maxAllocation`), text(`agents.${r}.maxExposure`), text(`agents.${r}.budget`)]),
  ...CATALOG_SETS.filter((s) => s !== 'recipients').map((s) => ({ path: `market.${s}`, type: 'ids' as const, set: s })),
  ...['maxLeverage', 'maxSlippageBps', 'maxQuoteAgeSeconds'].map((f) => text(`market.${f}`)),
  { path: 'execution.recipients', type: 'ids', set: 'recipients' },
];

const MAX_TEXT = 64;
const MAX_IDS = 32;

type FieldValue = string | boolean | readonly string[] | null;

/** The value for `path` if `raw` has its type (or is null); otherwise an error. */
export function parseFieldValue(path: unknown, raw: unknown): { readonly ok: true; readonly path: string; readonly value: FieldValue } | { readonly ok: false; readonly error: string } {
  const field = DRAFT_FIELD_PATHS.find((f) => f.path === path);
  if (field === undefined) return { ok: false, error: 'unknown draft field' };
  if (raw === null) return { ok: true, path: field.path, value: null };
  switch (field.type) {
    case 'boolean':
      return typeof raw === 'boolean' ? { ok: true, path: field.path, value: raw } : { ok: false, error: `${field.path} takes true, false or null` };
    case 'text':
      return typeof raw === 'string' && raw.length <= MAX_TEXT && !/[\u0000-\u001f\u007f]/.test(raw) ? { ok: true, path: field.path, value: raw.trim() } : { ok: false, error: `${field.path} takes a short string or null` };
    case 'ids': {
      const known = field.set === undefined ? [] : catalogIds(field.set);
      return Array.isArray(raw) && raw.length <= MAX_IDS && raw.every((x): x is string => typeof x === 'string' && known.includes(x))
        ? { ok: true, path: field.path, value: [...new Set(raw)] }
        : { ok: false, error: `${field.path} takes a list of ids from the reviewed ${field.set ?? ''} catalog, or null` };
    }
  }
}

/** Paths as the versioning diff lists them. */
export const draftPaths = (): readonly string[] => DRAFT_FIELD_PATHS.map((f) => f.path);

/**
 * A draft with interpretation issue `index` removed when dismissal is safe
 * (docs/demo/c2-1-authority-review.md §3). Soft unsupported requires
 * `acknowledgeSoftUnsupported`. Dangerous / conflict / ambiguous return null.
 */
export function resolveIssue(d: MandateDraft, index: number, acknowledgeSoftUnsupported = false): MandateDraft | null {
  const r = resolveIssueSafe(d, index, { acknowledgeSoftUnsupported });
  return r.ok ? r.draft : null;
}

/** Resolve with a structured refusal code for the API. */
export function resolveIssueWithPolicy(d: MandateDraft, index: number, acknowledgeSoftUnsupported = false): ReturnType<typeof resolveIssueSafe> {
  return resolveIssueSafe(d, index, { acknowledgeSoftUnsupported });
}
