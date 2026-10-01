/**
 * Deterministic draft validation, and the one place a draft becomes a
 * `PortfolioMandateInput`.
 *
 * ```text
 * draft ─▶ parse (unset → MISSING_VALUE; malformed → INVALID_VALUE)
 *       ─▶ unresolved interpretation issues (blocking until resolved)
 *       ─▶ the draft's own conflicts (conflicts.ts)
 *       ─▶ build the mandate input: catalog ids → reviewed identifiers,
 *          market guardrails intersected into every agent's reviewed scope
 *       ─▶ the protocol's own checks: validatePortfolioMandate,
 *          checkPortfolioMandate (CHILD ⊆ PARENT), compilePortfolio
 *       ─▶ canonical guardrails: exactly what will be enforced
 * ```
 *
 * Nothing here signs or registers. A validation with no blocking issue is
 * still only a draft until `MandateVersions.authorize`.
 */

import {
  checkPortfolioMandate,
  compilePortfolio,
  validatePortfolioMandate,
  type AgentPolicyInput,
  type AuthorityScopeInput,
  type CanonicalAssetInput,
  type DomainBinding,
  type PortfolioMandateInput,
  type ResourceAmountInput,
} from '@mandate/portfolio';
import { DEMO_RESOURCES, DEMO_T0, PRINCIPAL, demoParty } from '@mandate/portfolio/demo';
import { AGENT_DOMAINS, CATALOG, EXPOSURE_RESOURCE, REVIEWED_AGENT_SCOPES, REVIEWED_BOUNDS, REVIEWED_PORTFOLIO_SCOPE, assetInput, entryById, type CatalogSet } from './catalog.ts';
import { agentConflicts, deployable, issue, portfolioConflicts, type ValidationIssue } from './conflicts.ts';
import type { MandateDraft } from './draft-types.ts';
import { ROLES, ROLE_LABELS, parseCount, parseUsdc, usdcText, type Role } from '../types.ts';

export interface GuardrailRow {
  readonly level: 'PORTFOLIO' | 'AGENT' | 'MARKET' | 'EXECUTION';
  readonly guardrail: string;
  readonly enforced: string;
  /** The Mandate term that enforces it. */
  readonly term: string;
  /** ENFORCED: set from the draft. DERIVED: computed from other guardrails. EXISTING: an existing Mandate rule, not separately editable. NO_AUTHORITY: a disabled agent. */
  readonly status: 'ENFORCED' | 'DERIVED' | 'EXISTING' | 'NO_AUTHORITY';
}

export interface DraftValidation {
  /** No blocking issue: the draft may be put to the principal for explicit authorization. */
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly mandate: PortfolioMandateInput | null;
  readonly guardrails: readonly GuardrailRow[];
}

export interface ValidationContext {
  readonly version: number;
  /** Protocol time at which the mandate would start counting its validity. */
  readonly protocolNow: bigint;
  readonly bindings: readonly DomainBinding[];
  /**
   * Who the compiled mandate names as principal. Omitted: the demonstration
   * principal (V1 and the B.5.3 wallet approval). The V2 spine passes the
   * wallet address, which then is the protocol principal.
   */
  readonly principal?: { readonly kind: 'eip155-address'; readonly value: string };
}

const USDC = (atoms: bigint) => `${usdcText(atoms)} USDC`;
const partyRole = new Map<string, Role>(ROLES.map((r) => [demoParty(r).value, r]));

interface Ratio {
  readonly numerator: bigint;
  readonly scale: number;
}

function parseLeverage(text: string): Ratio | null {
  const m = /^(\d{1,2})(?:\.(\d))?$/.exec(text.trim());
  if (m === null) return null;
  return m[2] === undefined ? { numerator: BigInt(m[1] as string), scale: 0 } : { numerator: BigInt(`${m[1]}${m[2]}`), scale: 1 };
}

const ratioText = (r: Ratio) => (r.scale === 0 ? `${r.numerator}x` : `${r.numerator / 10n}.${r.numerator % 10n}x`);
const ratioAbove = (a: Ratio, b: Ratio) => a.numerator * 10n ** BigInt(b.scale) > b.numerator * 10n ** BigInt(a.scale);
const minRatio = (a: Ratio | null, b: Ratio | null): Ratio | null => (a === null || b === null ? null : ratioAbove(a, b) ? b : a);
const minNumber = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.min(a, b));
const minBig = (a: bigint | null, b: bigint | null) => (a === null || b === null ? null : a < b ? a : b);

/** Keep only the reviewed members the principal selected, preserving the reviewed order. */
function intersect(reviewed: readonly string[], selected: ReadonlySet<string>): string[] {
  return reviewed.filter((v) => selected.has(v));
}

function intersectAssets(reviewed: readonly CanonicalAssetInput[], selected: ReadonlySet<string>): CanonicalAssetInput[] {
  return reviewed.filter((a) => selected.has(a.value));
}

interface Selection {
  readonly sets: { readonly [S in CatalogSet]: ReadonlySet<string> };
  readonly leverage: Ratio | null;
  readonly slippage: number | null;
  readonly quoteAge: bigint | null;
}

function scopeFor(reviewed: AuthorityScopeInput, s: Selection): AuthorityScopeInput {
  return {
    ...reviewed,
    chains: intersect(reviewed.chains, s.sets.chains),
    venues: intersect(reviewed.venues, s.sets.venues),
    assets: intersectAssets(reviewed.assets, s.sets.assets),
    representations: intersect(reviewed.representations, s.sets.representations),
    issuers: intersect(reviewed.issuers, s.sets.issuers),
    recipients: intersect(reviewed.recipients, s.sets.recipients),
    // A bound the reviewed scope does not have stays absent: the market guardrail can only tighten one that exists.
    maxLeverage: reviewed.maxLeverage === null ? null : minRatio(reviewed.maxLeverage as Ratio, s.leverage),
    maxSlippageBps: minNumber(reviewed.maxSlippageBps, s.slippage),
    maxQuoteAgeSeconds: reviewed.maxQuoteAgeSeconds === null ? null : minBig(BigInt(reviewed.maxQuoteAgeSeconds), s.quoteAge),
  };
}

/** Sets an enabled agent needs at least one member of, to be able to act at all. */
const ESSENTIAL: readonly (keyof AuthorityScopeInput & CatalogSet)[] = ['chains', 'venues', 'assets', 'representations', 'recipients'];

function protocolIssue(code: string, subject: string): ValidationIssue {
  const [agent, resource] = subject.split('/');
  const role = agent === undefined ? undefined : partyRole.get(agent);
  if (code === 'CHILD_WIDENS_RESOURCE_LIMIT' && role !== undefined) {
    return issue('CHILD_AUTHORITY_EXCEEDS_PARENT', `agents.${role}`, `Child authority exceeds parent authority: the ${ROLE_LABELS[role]}'s ${resource ?? 'limit'} is above the portfolio's.`, { code, subject });
  }
  const who = role === undefined ? '' : ` (${ROLE_LABELS[role]})`;
  return issue('PROTOCOL_REFUSED', role === undefined ? null : `agents.${role}`, `Mandate refuses this draft: ${code}${who}${resource === undefined ? '' : ` at ${resource}`}.`, { code, subject });
}

export function validateDraft(d: MandateDraft, ctx: ValidationContext): DraftValidation {
  const issues: ValidationIssue[] = [];
  const amount = (field: string, raw: string | null, required: boolean): bigint | null => {
    if (raw === null) {
      if (required) issues.push(issue('MISSING_VALUE', field, `${field} is not set.`));
      return null;
    }
    const v = parseUsdc(raw);
    if (v === null) issues.push(issue('INVALID_VALUE', field, `${field}: "${raw}" is not a USDC amount.`));
    return v;
  };

  for (const i of d.issues) issues.push(issue('INTERPRETATION_UNRESOLVED', i.field, `${i.kind}: ${i.text}`));

  // Portfolio.
  const total = amount('portfolio.totalCapital', d.portfolio.totalCapital, true);
  const minUnallocated = amount('portfolio.minUnallocated', d.portfolio.minUnallocated, true);
  const deployAll = d.portfolio.deployAll === true;
  const maxDeployed = amount('portfolio.maxDeployed', d.portfolio.maxDeployed, !deployAll);
  const validityRaw = d.portfolio.validityMinutes;
  const validity = validityRaw === null ? null : parseCount(validityRaw, 100_000_000);
  if (validityRaw === null) issues.push(issue('MISSING_VALUE', 'portfolio.validityMinutes', 'portfolio.validityMinutes is not set.'));
  else if (validity === null) issues.push(issue('INVALID_VALUE', 'portfolio.validityMinutes', `"${validityRaw}" is not a whole number of minutes.`));

  // Agents.
  const enabledRoles: Role[] = [];
  const maxAllocation = new Map<Role, bigint>();
  const maxExposure = new Map<Role, bigint>();
  for (const r of ROLES) {
    const a = d.agents[r];
    if (a.enabled === null) {
      issues.push(issue('MISSING_VALUE', `agents.${r}.enabled`, `Choose whether the ${ROLE_LABELS[r]} is enabled.`));
      continue;
    }
    if (!a.enabled) continue;
    enabledRoles.push(r);
    const max = amount(`agents.${r}.maxAllocation`, a.maxAllocation, true);
    if (max !== null) maxAllocation.set(r, max);
    if (EXPOSURE_RESOURCE[r] === null) continue;
    const exposure = amount(`agents.${r}.maxExposure`, a.maxExposure, false);
    if (exposure !== null) maxExposure.set(r, exposure);
  }
  const enabled = (r: Role) => enabledRoles.includes(r);
  const maxDerivative = amount('portfolio.maxDerivative', d.portfolio.maxDerivative, enabled('perps')) ?? 0n;
  const maxIlliquid = amount('portfolio.maxIlliquid', d.portfolio.maxIlliquid, enabled('nft')) ?? 0n;

  // Market and execution.
  const sets = {} as { [S in CatalogSet]: ReadonlySet<string> };
  const setPaths: { readonly [S in CatalogSet]: string } = { assets: 'market.assets', issuers: 'market.issuers', representations: 'market.representations', venues: 'market.venues', chains: 'market.chains', recipients: 'execution.recipients' };
  for (const s of Object.keys(setPaths) as CatalogSet[]) {
    const ids = s === 'recipients' ? d.execution.recipients : d.market[s];
    if (ids === null) {
      issues.push(issue('MISSING_VALUE', setPaths[s], `Choose the approved ${s}.`));
      sets[s] = new Set();
      continue;
    }
    const values: string[] = [];
    for (const id of ids) {
      const e = entryById(s, id);
      if (e === null) issues.push(issue('INVALID_VALUE', setPaths[s], `"${id}" is not in the reviewed catalog.`));
      else values.push(e.value);
    }
    sets[s] = new Set(values);
  }
  let leverage: Ratio | null = null;
  if (d.market.maxLeverage === null) {
    if (enabled('perps')) issues.push(issue('MISSING_VALUE', 'market.maxLeverage', 'Set the maximum leverage (the perps agent is enabled).'));
  } else {
    leverage = parseLeverage(d.market.maxLeverage);
    if (leverage === null || leverage.numerator === 0n) issues.push(issue('INVALID_VALUE', 'market.maxLeverage', `"${d.market.maxLeverage}" is not a leverage multiple.`));
    else if (ratioAbove(leverage, { numerator: REVIEWED_BOUNDS.maxLeverage, scale: 0 })) issues.push(issue('EXCEEDS_REVIEWED_BOUND', 'market.maxLeverage', `Leverage above ${REVIEWED_BOUNDS.maxLeverage}x exceeds the reviewed catalog.`));
  }
  const bound = (field: 'maxSlippageBps' | 'maxQuoteAgeSeconds', needed: boolean, max: number, label: string): number | null => {
    const raw = d.market[field];
    if (raw === null) {
      if (needed) issues.push(issue('MISSING_VALUE', `market.${field}`, `Set the ${label}.`));
      return null;
    }
    const n = parseCount(raw, 10_000_000);
    if (n === null || n < 1) {
      issues.push(issue('INVALID_VALUE', `market.${field}`, `"${raw}" is not a valid ${label}.`));
      return null;
    }
    if (n > max) issues.push(issue('EXCEEDS_REVIEWED_BOUND', `market.${field}`, `A ${label} above ${max} exceeds the reviewed catalog.`));
    return n;
  };
  const slippage = bound('maxSlippageBps', enabled('swap'), REVIEWED_BOUNDS.maxSlippageBps, 'slippage limit (bps)');
  const quoteAgeN = bound('maxQuoteAgeSeconds', enabled('swap') || enabled('yield'), REVIEWED_BOUNDS.maxQuoteAgeSeconds, 'quote freshness limit (seconds)');
  const quoteAge = quoteAgeN === null ? null : BigInt(quoteAgeN);

  const numbers = total !== null && minUnallocated !== null && validity !== null && (deployAll || maxDeployed !== null) ? { total, minUnallocated, maxDeployed, deployAll, validityMinutes: validity } : null;
  if (numbers !== null) issues.push(...portfolioConflicts(numbers));
  issues.push(...agentConflicts(enabledRoles.filter((r) => maxAllocation.has(r)).map((r) => ({ role: r, maxAllocation: maxAllocation.get(r) as bigint }))));

  const selection: Selection = { sets, leverage, slippage, quoteAge };
  const portfolioScope = scopeFor(REVIEWED_PORTFOLIO_SCOPE, selection);
  const agentScopes = new Map<Role, AuthorityScopeInput>();
  for (const r of enabledRoles) {
    const s = scopeFor(REVIEWED_AGENT_SCOPES[r], selection);
    agentScopes.set(r, s);
    const empty = ESSENTIAL.filter((k) => (s[k] as readonly unknown[]).length === 0);
    if (REVIEWED_AGENT_SCOPES[r].issuers.length > 0 && s.issuers.length === 0) empty.push('issuers');
    if (empty.length > 0) issues.push(issue('AGENT_SCOPE_EMPTY', `agents.${r}`, `The ${ROLE_LABELS[r]} is enabled but no approved ${empty.join(', ')} remain for it: enable one or disable the agent.`));
  }

  const blocking = () => issues.some((i) => i.severity === 'BLOCKING');
  const guardrails: GuardrailRow[] = [];
  const cap = numbers === null ? null : deployable(numbers);
  if (cap === null || issues.some((i) => i.code === 'MISSING_VALUE' || i.code === 'INVALID_VALUE')) return { ok: false, issues, mandate: null, guardrails };

  // Build the mandate input exactly as it would be signed.
  const limits: ResourceAmountInput[] = [
    { resource: 'portfolio-notional', atoms: cap },
    { resource: 'derivative-notional', atoms: maxDerivative },
    { resource: 'illiquid-notional', atoms: maxIlliquid },
    { resource: 'spot-capital', atoms: cap },
    { resource: 'perp-margin', atoms: maxDerivative },
  ];
  const expiresAt = ctx.protocolNow + BigInt(validity as number) * 60n;
  const agents: AgentPolicyInput[] = enabledRoles.map((r) => {
    const hard: ResourceAmountInput[] = [{ resource: 'portfolio-notional', atoms: maxAllocation.get(r) ?? 0n }];
    const exposureResource = EXPOSURE_RESOURCE[r];
    const exposure = maxExposure.get(r);
    if (exposureResource !== null && exposure !== undefined) hard.push({ resource: exposureResource, atoms: exposure });
    return { agent: demoParty(r), label: r, scope: agentScopes.get(r) as AuthorityScopeInput, notBefore: DEMO_T0, expiresAt, hardMaxima: hard, preferred: [] };
  });
  const mandate: PortfolioMandateInput = {
    principal: ctx.principal ?? PRINCIPAL,
    policyVersion: BigInt(ctx.version),
    nonce: BigInt(ctx.version),
    notBefore: DEMO_T0,
    expiresAt,
    allocationMode: 'DYNAMIC',
    resources: DEMO_RESOURCES,
    scope: portfolioScope,
    limits,
    agents,
  };

  // The protocol's own verdict.
  const structural = validatePortfolioMandate(mandate);
  if (!structural.ok) issues.push(issue('PROTOCOL_REFUSED', null, `Mandate refuses this draft: ${structural.error.code} at ${structural.error.path}.`, { code: structural.error.code, subject: structural.error.path }));
  else {
    for (const r of checkPortfolioMandate(structural.value)) issues.push(protocolIssue(r.code, r.subject));
    if (!issues.some((i) => i.code === 'CHILD_AUTHORITY_EXCEEDS_PARENT' || i.code === 'PROTOCOL_REFUSED')) {
      const compiled = compilePortfolio(structural.value, ctx.bindings);
      if (!compiled.ok) for (const r of compiled.error) issues.push(protocolIssue(r.code, r.subject));
    }
  }

  // What will be enforced, in words.
  const row = (level: GuardrailRow['level'], guardrail: string, enforced: string, term: string, status: GuardrailRow['status'] = 'ENFORCED') => guardrails.push({ level, guardrail, enforced, term, status });
  row('PORTFOLIO', 'Total capital', USDC(total as bigint), 'not a Mandate term (used to derive the deployable limit)', 'DERIVED');
  row('PORTFOLIO', 'Maximum deployed', `≤ ${USDC(cap)} (after keeping ${USDC(minUnallocated as bigint)} unallocated)`, 'limits[portfolio-notional]');
  row('PORTFOLIO', 'Derivative exposure', `≤ ${USDC(maxDerivative)}`, 'limits[derivative-notional], limits[perp-margin]');
  row('PORTFOLIO', 'Illiquid exposure', `≤ ${USDC(maxIlliquid)}`, 'limits[illiquid-notional]');
  row('PORTFOLIO', 'Stock spot capital', `≤ ${USDC(cap)}`, 'limits[spot-capital]', 'DERIVED');
  row('PORTFOLIO', 'Validity', `${validity} minutes from authorization`, 'expiresAt');
  row('PORTFOLIO', 'Allocation', 'DYNAMIC: nothing preallocated; agents claim from one pool inside their own maxima', 'allocationMode', 'EXISTING');
  for (const r of ROLES) {
    if (!enabled(r)) {
      row('AGENT', ROLE_LABELS[r], 'NO AUTHORITY: no mandate entry, no delegation, no child authority', 'agents[] (absent)', 'NO_AUTHORITY');
      continue;
    }
    const exposureResource = EXPOSURE_RESOURCE[r];
    const exposure = maxExposure.get(r);
    const s = agentScopes.get(r) as AuthorityScopeInput;
    row('AGENT', ROLE_LABELS[r], `≤ ${USDC(maxAllocation.get(r) ?? 0n)} · ${AGENT_DOMAINS[r]}`, `agents[${r}].hardMaxima[portfolio-notional]`);
    if (exposureResource !== null) {
      row('AGENT', `${ROLE_LABELS[r]} exposure`, exposure === undefined ? `not listed — bounded by the portfolio's ${exposureResource} limit` : `≤ ${USDC(exposure)}`, `agents[${r}].hardMaxima[${exposureResource}]`, exposure === undefined ? 'DERIVED' : 'ENFORCED');
    }
    const bounds = [s.maxLeverage === null ? null : `leverage ≤ ${ratioText(s.maxLeverage as Ratio)}`, s.maxSlippageBps === null ? null : `slippage ≤ ${s.maxSlippageBps} bps`, s.maxQuoteAgeSeconds === null ? null : `quotes ≤ ${s.maxQuoteAgeSeconds} s old`].filter((x) => x !== null);
    if (bounds.length > 0) row('AGENT', `${ROLE_LABELS[r]} bounds`, bounds.join(' · '), `agents[${r}].scope`, 'DERIVED');
  }
  const labels = (s: CatalogSet) => CATALOG[s].filter((e) => sets[s].has(e.value)).map((e) => e.label);
  for (const s of ['assets', 'issuers', 'representations', 'venues', 'chains'] as const) row('MARKET', `Approved ${s}`, labels(s).join('; ') || 'none', `scope.${s}`);
  row('MARKET', 'Synthetic exposure', 'FORBIDDEN', 'scope.syntheticPolicy', 'EXISTING');
  row('MARKET', 'Leverage', leverage === null ? 'none permitted' : `≤ ${ratioText(leverage)}`, 'scope.maxLeverage');
  row('MARKET', 'Slippage', slippage === null ? 'none permitted' : `≤ ${slippage} bps`, 'scope.maxSlippageBps');
  row('MARKET', 'Quote freshness', quoteAge === null ? 'no quote-bearing action permitted' : `≤ ${quoteAge} s`, 'scope.maxQuoteAgeSeconds');
  row('EXECUTION', 'Allowed recipients', labels('recipients').join('; ') || 'none', 'scope.recipients');
  row('EXECUTION', 'Maximum spend', "each agent's maximum allocation", 'hardMaxima (no separate per-action term)', 'EXISTING');
  row('EXECUTION', 'Minimum receive', 'minOut within the slippage bound of the quoted output', 'scope.maxSlippageBps', 'EXISTING');
  row('EXECUTION', 'Execution deadline', "the child window ends at the quote's expiry", 'child window (Phase 7F.2)', 'EXISTING');
  row('EXECUTION', 'Adapter / venue identity', 'exact compiled modules, adapters and venues', 'Core MODULES / ADAPTERS / VENUES', 'EXISTING');
  row('EXECUTION', 'Replay', 'one signed proposal is one Core action; a second reservation is refused', 'ledger RESERVATION_EXISTS', 'EXISTING');

  return { ok: !blocking(), issues, mandate: blocking() ? null : mandate, guardrails };
}
