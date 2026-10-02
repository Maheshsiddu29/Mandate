/**
 * The Mandate draft: what the principal is *about to* authorize.
 *
 * **A draft is not authority.** It is plain, editable data with no
 * signature, no digest and no path to the ledger except
 * `MandateVersions.authorize`, which requires the principal's explicit
 * confirmation. Every field that no one has set is `null` — *unset* — and
 * blocks authorization: a missing value is never replaced by a permissive
 * default. Amounts are decimal USDC text; sets are catalog ids
 * (catalog.ts).
 */

import { CATALOG, catalogIds } from './catalog.ts';
import { ROLES, parseUsdc, usdcText, type Role } from '../types.ts';

export interface PortfolioDraft {
  readonly totalCapital: string | null;
  readonly minUnallocated: string | null;
  readonly maxDeployed: string | null;
  /** "Deploy everything": the maximum deployed must equal total capital. */
  readonly deployAll: boolean | null;
  readonly maxDerivative: string | null;
  readonly maxIlliquid: string | null;
  readonly validityMinutes: string | null;
  /**
   * Whether capital an agent leaves unused may be reassigned to other agents
   * after signing, inside the signed maxima (docs/v2/mandate-room-v2.md §3.3).
   * `null` is `false`. It is authority: a fill never sets it.
   */
  readonly autoReallocate: boolean | null;
}

export interface AgentDraft {
  /** `false` is NO AUTHORITY: the agent gets no entry in the mandate and no delegation. */
  readonly enabled: boolean | null;
  readonly maxAllocation: string | null;
  /** The agent's own ceiling in its domain resource; `null` leaves it bounded by the portfolio limit alone. */
  readonly maxExposure: string | null;
  /**
   * The agent's budget: the most capital it may use in this plan — a maximum,
   * never an obligation. Set by the principal (FIXED, or the fixed part of
   * HYBRID) or by accepting a Planning Room proposal (`PLANNED`).
   */
  readonly budget: string | null;
}

export interface MarketDraft {
  readonly assets: readonly string[] | null;
  readonly issuers: readonly string[] | null;
  readonly representations: readonly string[] | null;
  readonly venues: readonly string[] | null;
  readonly chains: readonly string[] | null;
  /** Integer or one-decimal leverage, e.g. `"2"` or `"2.5"`. */
  readonly maxLeverage: string | null;
  readonly maxSlippageBps: string | null;
  readonly maxQuoteAgeSeconds: string | null;
}

export interface ExecutionDraft {
  readonly recipients: readonly string[] | null;
}

export const ISSUE_KINDS = ['AMBIGUOUS', 'CONFLICT', 'NEEDS_CLARIFICATION', 'UNSUPPORTED'] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

/** Something the interpreter could not turn into a field without guessing. Blocks authorization until the principal resolves it. */
export interface DraftIssue {
  readonly kind: IssueKind;
  readonly field: string | null;
  readonly text: string;
}

/** `PLANNED`: a budget the principal accepted from a Planning Room proposal. */
export type FieldSource = 'PRESET' | 'INTERPRETED' | 'USER' | 'PLANNED';

export interface MandateDraft {
  readonly portfolio: PortfolioDraft;
  readonly agents: { readonly [R in Role]: AgentDraft };
  readonly market: MarketDraft;
  readonly execution: ExecutionDraft;
  readonly issues: readonly DraftIssue[];
  /** Short explanations from the interpreter; display only. */
  readonly notes: readonly string[];
  /** Where each set field came from, by path (`portfolio.totalCapital`, `agents.perps.enabled`, …). */
  readonly provenance: { readonly [path: string]: FieldSource };
}

const UNSET_AGENT: AgentDraft = { enabled: null, maxAllocation: null, maxExposure: null, budget: null };

export function emptyDraft(): MandateDraft {
  return {
    portfolio: { totalCapital: null, minUnallocated: null, maxDeployed: null, deployAll: null, maxDerivative: null, maxIlliquid: null, validityMinutes: null, autoReallocate: null },
    agents: { stock: UNSET_AGENT, swap: UNSET_AGENT, nft: UNSET_AGENT, yield: UNSET_AGENT, perps: UNSET_AGENT },
    market: { assets: null, issuers: null, representations: null, venues: null, chains: null, maxLeverage: null, maxSlippageBps: null, maxQuoteAgeSeconds: null },
    execution: { recipients: null },
    issues: [],
    notes: [],
    provenance: {},
  };
}

export const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;
export type Preset = (typeof PRESETS)[number];

type AgentPreset = readonly [enabled: boolean, maxAllocation: string, maxExposure: string | null];

interface PresetValues {
  readonly portfolio: readonly [total: string, minUnallocated: string, maxDeployed: string, maxDerivative: string, maxIlliquid: string, validityMinutes: string];
  readonly agents: { readonly [R in Role]: AgentPreset };
  readonly bounds: readonly [leverage: string, slippageBps: string, quoteAgeSeconds: string];
}

/**
 * Starting points, not recommendations.
 *
 * Balanced has a genuine feasible region on both sides. 2,500 deployable
 * sits between conservative (1,500) and aggressive (3,000). The agents'
 * maxima sum to 2,900, so agents that all ask for their maximum still
 * conflict on capital and meet in the Mandate Room, while more modest
 * combinations fit and are authorized directly. The perps agent's
 * allocation equals the portfolio's derivative limit (400): an agent whose
 * own maximum exceeds the only resource its domain can use would collide
 * with that limit on every request above it. A perps request above 400 is
 * still possible (its market goes to 1,000) and is then a real derivative
 * conflict.
 */
const PRESET_VALUES: { readonly [P in Preset]: PresetValues } = {
  conservative: {
    portfolio: ['2000', '500', '1500', '200', '200', '60'],
    agents: { stock: [true, '600', '600'], swap: [true, '300', null], nft: [true, '200', '200'], yield: [true, '600', null], perps: [true, '300', null] },
    bounds: ['2', '30', '120'],
  },
  balanced: {
    portfolio: ['2500', '0', '2500', '400', '400', '60'],
    agents: { stock: [true, '800', '800'], swap: [true, '500', null], nft: [true, '400', '400'], yield: [true, '800', null], perps: [true, '400', null] },
    bounds: ['3', '100', '300'],
  },
  aggressive: {
    portfolio: ['3000', '0', '3000', '800', '600', '60'],
    agents: { stock: [true, '1200', null], swap: [true, '800', null], nft: [true, '600', null], yield: [true, '1200', null], perps: [true, '1000', null] },
    bounds: ['3', '100', '300'],
  },
};

/** Every field a preset sets, by path. */
export function presetFields(p: Preset): { readonly [path: string]: string | boolean | readonly string[] } {
  const v = PRESET_VALUES[p];
  const out: { [path: string]: string | boolean | readonly string[] } = {
    'portfolio.totalCapital': v.portfolio[0],
    'portfolio.minUnallocated': v.portfolio[1],
    'portfolio.maxDeployed': v.portfolio[2],
    'portfolio.deployAll': false,
    'portfolio.maxDerivative': v.portfolio[3],
    'portfolio.maxIlliquid': v.portfolio[4],
    'portfolio.validityMinutes': v.portfolio[5],
    // A preset is an explicit envelope: agents coordinate inside the signed maxima, without a fixed split.
    'portfolio.autoReallocate': true,
    'market.maxLeverage': v.bounds[0],
    'market.maxSlippageBps': v.bounds[1],
    'market.maxQuoteAgeSeconds': v.bounds[2],
    'execution.recipients': catalogIds('recipients'),
  };
  for (const set of ['assets', 'issuers', 'representations', 'venues', 'chains'] as const) out[`market.${set}`] = CATALOG[set].map((e) => e.id);
  for (const r of ROLES) {
    const [enabled, max, exposure] = v.agents[r];
    out[`agents.${r}.enabled`] = enabled;
    out[`agents.${r}.maxAllocation`] = max;
    if (exposure !== null) out[`agents.${r}.maxExposure`] = exposure;
  }
  return out;
}

/** The value at a draft path, or `undefined` for a path that does not exist. */
export function fieldAt(d: MandateDraft, path: string): string | boolean | readonly string[] | null | undefined {
  const [section, a, b] = path.split('.');
  if (section === 'agents' && a !== undefined && b !== undefined) {
    const agent = (d.agents as { readonly [k: string]: AgentDraft })[a];
    return agent === undefined ? undefined : (agent as unknown as { readonly [k: string]: string | boolean | null })[b];
  }
  const s = (d as unknown as { readonly [k: string]: { readonly [k: string]: string | boolean | readonly string[] | null } | undefined })[section ?? ''];
  return s === undefined || a === undefined ? undefined : s[a];
}

/** A copy of `d` with `path` set, recorded with its source. Unknown paths are refused. */
export function withField(d: MandateDraft, path: string, value: string | boolean | readonly string[] | null, source: FieldSource): MandateDraft {
  if (fieldAt(d, path) === undefined) throw new Error(`unknown draft field ${path}`);
  const [section, a, b] = path.split('.') as [string, string, string | undefined];
  const provenance = { ...d.provenance };
  if (value === null) delete provenance[path];
  else provenance[path] = source;
  if (section === 'agents' && b !== undefined) {
    const role = a as Role;
    return { ...d, agents: { ...d.agents, [role]: { ...d.agents[role], [b]: value } }, provenance };
  }
  const current = (d as unknown as { readonly [k: string]: object })[section];
  return { ...d, [section]: { ...current, [a]: value }, provenance } as MandateDraft;
}

/**
 * Fields that grant authority by choice, not by default: which agents may act
 * at all, and whether capital may move between them after signing. Filling
 * unset fields from a preset never sets them: a button must not grant an
 * agent a domain the principal did not name.
 */
export const AUTHORITY_CHOICES: readonly string[] = [...ROLES.map((r) => `agents.${r}.enabled`), 'portfolio.autoReallocate'];

/**
 * Apply a preset: to every field (`onlyUnset = false`, an explicit choice of
 * the whole preset) or only to fields no one has set — never to an
 * authority choice (AUTHORITY_CHOICES).
 */
export function applyPreset(d: MandateDraft, p: Preset, onlyUnset: boolean): { readonly draft: MandateDraft; readonly filled: readonly string[] } {
  let out = d;
  const filled: string[] = [];
  for (const [path, value] of Object.entries(presetFields(p))) {
    if (onlyUnset && (fieldAt(out, path) !== null || AUTHORITY_CHOICES.includes(path))) continue;
    out = withField(out, path, onlyUnset ? withinStatedCapital(out, path, value) : value, 'PRESET');
    filled.push(path);
  }
  // An agent the preset enables but whose exposure it leaves open stays open: that is a choice, recorded as such.
  return { draft: out, filled };
}

/**
 * A filled maximum deployed never exceeds what the principal said they have:
 * "$2,000 across …" with a preset of 2,500 deploys at most the 2,000, less
 * any reserve. Every other value is the preset's own.
 */
function withinStatedCapital(d: MandateDraft, path: string, value: string | boolean | readonly string[]): string | boolean | readonly string[] {
  if (path !== 'portfolio.maxDeployed' || typeof value !== 'string' || d.portfolio.deployAll === true) return value;
  const total = d.portfolio.totalCapital === null ? null : parseUsdc(d.portfolio.totalCapital);
  const reserve = d.portfolio.minUnallocated === null ? 0n : parseUsdc(d.portfolio.minUnallocated);
  const preset = parseUsdc(value);
  if (total === null || reserve === null || preset === null || reserve > total) return value;
  return preset > total - reserve ? usdcText(total - reserve) : value;
}

export function presetDraft(p: Preset): MandateDraft {
  return applyPreset(emptyDraft(), p, false).draft;
}

/** A draft recorded before Room V2 has no budgets or reallocation choice: read them as unset. */
export function normalizeDraft(d: MandateDraft): MandateDraft {
  const agents = Object.fromEntries(ROLES.map((r) => [r, { ...d.agents[r], budget: d.agents[r].budget ?? null }])) as unknown as MandateDraft['agents'];
  return { ...d, portfolio: { ...d.portfolio, autoReallocate: d.portfolio.autoReallocate ?? null }, agents };
}
