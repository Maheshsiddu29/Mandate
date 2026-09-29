/**
 * Parent → child authority (portfolio-mandate.md §7).
 *
 * **CHILD AUTHORITY ⊆ PARENT PORTFOLIO AUTHORITY**, enforced by one function
 * at every level:
 *
 * ```text
 * portfolio scope ⊇ agent scope ⊇ execution scope
 *        checkChildScope      checkChildScope
 * ```
 *
 * An execution is represented as the **singleton scope** of its one resolved
 * action — `{domain}`, `{kind}`, `{chain}`, `{venue}`, `{asset}`,
 * `{representation}`, `{issuer}`, `{recipient}`, the synthetic policy its
 * instrument needs, the rights it establishes, and its own leverage, slippage
 * and quote age as bounds. "Is this action permitted?" is then literally "is
 * its singleton scope a subset?", so `permits` cannot drift from the
 * derivation rule, and two properties follow from the subset relation itself
 * (and are property-tested):
 *
 * - **subset soundness**: `checkChildScope(P, C) = ∅ ∧ permits(C, a) ⇒
 *   permits(P, a)` — ⊆ is transitive;
 * - **monotonic tightening**: shrinking a set, lowering a bound, forbidding
 *   synthetics or requiring another right can only add violations.
 *
 * A quote's age is the one bound that moves with time. `permits` compares
 * the age at `now` (a freshness predicate); the child commits to the static
 * policy bound and a window ending at the quote's expiry
 * (`authorizedScope`, `quoteExpiresAt`), so time decides only whether a
 * child is admissible, never which child it is.
 *
 * Every violation is reported, not only the first. Nothing here reads a
 * label, a ticker or a claim.
 */

import type { CanonicalAssetId, Identifier } from '@mandate/kernel';
import { compareRatios, type DomainId, type Ratio } from '@mandate/core';
import type { RightKind } from '@mandate/registry';
import type { AgentPolicy, PortfolioMandate } from './mandate.ts';
import { canonicalReasons, reason, type Reason, type ReasonCode } from './reasons.ts';
import { amountOf, exceeding, exceedingListed, resourceTable, undeclared, type ResourceVector } from './resources.ts';
import { SCOPE_SETS, assetKey, setKeys, validateAuthorityScope, type ActionKind, type AuthorityScope, type ScopeSet } from './scope.ts';

const WIDENS: { readonly [S in ScopeSet]: ReasonCode } = {
  domains: 'CHILD_WIDENS_DOMAINS',
  actions: 'CHILD_WIDENS_ACTIONS',
  chains: 'CHILD_WIDENS_CHAINS',
  venues: 'CHILD_WIDENS_VENUES',
  assets: 'CHILD_WIDENS_ASSETS',
  representations: 'CHILD_WIDENS_REPRESENTATIONS',
  issuers: 'CHILD_WIDENS_ISSUERS',
  recipients: 'CHILD_WIDENS_RECIPIENTS',
};

/** Each member's comparable key and the text a reason names it by. */
function members(s: AuthorityScope, set: ScopeSet): readonly (readonly [string, string])[] {
  if (set === 'assets') return s.assets.map((a) => [assetKey(a), `${a.assetClass}:${a.idScheme}:${a.value}`] as const);
  return setKeys(s, set).map((k) => [k, k] as const);
}

/** Every way `child` is not a subset of `parent`. Empty: the child is valid. */
export function checkChildScope(parent: AuthorityScope, child: AuthorityScope): readonly Reason[] {
  const found: Reason[] = [];
  for (const set of SCOPE_SETS) {
    const allowed = new Set(setKeys(parent, set));
    for (const [k, shown] of members(child, set)) if (!allowed.has(k)) found.push(reason(WIDENS[set], `${set}:${shown}`));
  }
  if (parent.syntheticPolicy === 'FORBIDDEN' && child.syntheticPolicy !== 'FORBIDDEN') found.push(reason('CHILD_WIDENS_SYNTHETIC_POLICY', 'syntheticPolicy'));
  // More required rights is narrower; a right the parent requires may never be dropped.
  for (const right of parent.requiredRights) if (!child.requiredRights.includes(right)) found.push(reason('CHILD_DROPS_REQUIRED_RIGHT', `requiredRights:${right}`));
  // A null bound permits nothing that needs it; a child may keep it null or add one only where the parent has one.
  const pl = parent.maxLeverage;
  const cl = child.maxLeverage;
  if (cl !== null && (pl === null || compareRatios(cl, pl) > 0)) found.push(reason('CHILD_WIDENS_LEVERAGE', 'maxLeverage'));
  const ps = parent.maxSlippageBps;
  const cs = child.maxSlippageBps;
  if (cs !== null && (ps === null || cs > ps)) found.push(reason('CHILD_WIDENS_SLIPPAGE', 'maxSlippageBps'));
  const pq = parent.maxQuoteAgeSeconds;
  const cq = child.maxQuoteAgeSeconds;
  if (cq !== null && (pq === null || cq > pq)) found.push(reason('CHILD_WIDENS_QUOTE_AGE', 'maxQuoteAgeSeconds'));
  return canonicalReasons(found);
}

export interface Window {
  readonly notBefore: bigint;
  readonly expiresAt: bigint;
}

export function checkChildWindow(parent: Window, child: Window): readonly Reason[] {
  return child.notBefore < parent.notBefore || child.expiresAt > parent.expiresAt ? [reason('CHILD_WIDENS_WINDOW', 'window')] : [];
}

/**
 * A child's resource limits against its parent's. Against the portfolio the
 * parent is closed-world (`closed`): a resource the portfolio does not limit
 * has limit zero, so any positive child limit in it widens. Against an agent
 * only the ceilings the agent lists apply: the portfolio's closed-world
 * limits still bound the rest.
 */
export function checkChildLimits(parentLimits: ResourceVector, childLimits: ResourceVector, declared: ReadonlySet<string>, closed = true): readonly Reason[] {
  const found: Reason[] = [];
  for (const a of childLimits) if (!declared.has(a.resource)) found.push(reason('CHILD_RESOURCE_UNDECLARED', a.resource));
  for (const r of closed ? exceeding(childLimits, parentLimits) : exceedingListed(childLimits, parentLimits)) if (declared.has(r)) found.push(reason('CHILD_WIDENS_RESOURCE_LIMIT', r));
  return found;
}

// --- Level 1: portfolio → agent -----------------------------------------------------------

function prefixed(subject: string, reasons: readonly Reason[]): Reason[] {
  return reasons.map((r) => reason(r.code, r.subject === '' ? subject : `${subject}/${r.subject}`));
}

/** One agent's policy against its portfolio: scope, window and hard maxima. */
export function checkAgentPolicy(m: PortfolioMandate, a: AgentPolicy): readonly Reason[] {
  const declared = new Set<string>(m.resources.map((d) => d.resource));
  return canonicalReasons(prefixed(a.agent.value, [...checkChildScope(m.scope, a.scope), ...checkChildWindow(m, a), ...checkChildLimits(m.limits, a.hardMaxima, declared)]));
}

/**
 * Whether a structurally valid mandate is *valid*: every limit names a
 * declared resource; every agent is a subset of the portfolio; preferred
 * allocations are declared, within each agent's hard maximum and together
 * within the portfolio limit; and `DYNAMIC` has no preferred allocation.
 * Every violation, canonical order.
 */
export function checkPortfolioMandate(m: PortfolioMandate): readonly Reason[] {
  const table = resourceTable(m.resources);
  const found: Reason[] = [...undeclared(m.limits, table)];
  for (const a of m.agents) {
    found.push(...checkAgentPolicy(m, a));
    found.push(...prefixed(a.agent.value, undeclared(a.preferred, table)));
    for (const r of exceedingListed(a.preferred, a.hardMaxima)) found.push(reason('PREFERRED_EXCEEDS_HARD_MAXIMUM', `${a.agent.value}/${r}`));
    if (m.allocationMode === 'DYNAMIC' && a.preferred.length > 0) found.push(reason('ALLOCATION_MODE_VIOLATION', `${a.agent.value}/preferred`));
  }
  for (const d of m.resources) {
    const total = m.agents.reduce((s, a) => s + amountOf(a.preferred, d.resource), 0n);
    if (total > amountOf(m.limits, d.resource)) found.push(reason('PREFERRED_EXCEEDS_PORTFOLIO_LIMIT', d.resource));
  }
  return canonicalReasons(found);
}

// --- Level 2: agent → execution ---------------------------------------------------------------

/**
 * One action after identity resolution (resolve.ts): every fact derived from
 * trusted data, never from the agent's claims, plus the derived demand.
 */
export interface ResolvedAction {
  readonly kind: ActionKind;
  readonly domain: DomainId;
  readonly chain: Identifier;
  readonly venue: Identifier;
  /** Ordered pools of a swap route; empty for every other kind. */
  readonly route: readonly Identifier[];
  readonly asset: CanonicalAssetId;
  readonly representation: Identifier;
  /** `null` where the instrument has no issuer (a perp market, a crypto asset). */
  readonly issuer: Identifier | null;
  readonly recipient: Identifier;
  readonly synthetic: boolean;
  /** Rights the trusted source establishes `PRESENT`. */
  readonly rights: readonly RightKind[];
  /** Present for every leveraged or derivative action. */
  readonly leverage: Ratio | null;
  readonly slippageBps: number | null;
  readonly quoteObservedAt: bigint | null;
  readonly demand: ResourceVector;
}

/**
 * A quote's age at `now`, exactly; `null` for a quote observed after `now`,
 * which has no age and is never fresh. Not a sentinel age: any age is ≤ some
 * valid bound (a `UINT64_MAX` bound admitted the old one), so `permits`
 * refuses a future quote explicitly instead (7F.2 audit INFO-2).
 */
export function quoteAge(observedAt: bigint, now: bigint): bigint | null {
  return observedAt > now ? null : now - observedAt;
}

/**
 * The tightest quote-age bound of `scopes`; `null` when any of them has none,
 * in which case no quote-bearing action is permitted (`permits` says
 * `QUOTE_NOT_ALLOWED`). Static policy: it never depends on the time.
 */
export function quoteAgeBound(...scopes: readonly AuthorityScope[]): bigint | null {
  let bound: bigint | null = null;
  for (const s of scopes) {
    if (s.maxQuoteAgeSeconds === null) return null;
    if (bound === null || s.maxQuoteAgeSeconds < bound) bound = s.maxQuoteAgeSeconds;
  }
  return bound;
}

/**
 * The first instant a quote observed at `observedAt` is stale under `bound`:
 * fresh ⇔ `now − observedAt ≤ bound` ⇔ `now < observedAt + bound + 1`, the
 * same exclusive end as every `expiresAt`. A function of signed and policy
 * facts only, so it is the same whenever it is computed. Exact bigint
 * arithmetic cannot overflow; a caller narrows the result by a valid window.
 */
export function quoteExpiresAt(observedAt: bigint, bound: bigint): bigint {
  return observedAt + bound + 1n;
}

function singletonScope(a: ResolvedAction, maxQuoteAgeSeconds: bigint | null): AuthorityScope {
  const scope = validateAuthorityScope(
    {
      domains: [a.domain],
      actions: [a.kind],
      chains: [a.chain],
      venues: [a.venue],
      assets: [{ assetClass: a.asset.assetClass, idScheme: a.asset.idScheme, value: a.asset.value }],
      representations: [a.representation],
      issuers: a.issuer === null ? [] : [a.issuer],
      recipients: [a.recipient],
      syntheticPolicy: a.synthetic ? 'ALLOWED' : 'FORBIDDEN',
      requiredRights: [...new Set(a.rights)],
      maxLeverage: a.leverage === null ? null : { numerator: a.leverage.numerator, scale: a.leverage.scale },
      maxSlippageBps: a.slippageBps,
      maxQuoteAgeSeconds: a.quoteObservedAt === null ? null : maxQuoteAgeSeconds,
    },
    'action',
  );
  // Every field came from a validated candidate or a reviewed table, so this cannot fail; if it did, that is a bug.
  if (!scope.ok) throw new Error(`resolved action has no valid scope: ${scope.error.code} at ${scope.error.path}`);
  return scope.value;
}

/**
 * The singleton scope of one resolved action *at `now`*: its quote bound is
 * the quote's age then (none for a future quote, which `permits` refuses on
 * its own). A runtime predicate's operand only (`permits`) — never an
 * authorization identity, because it changes with `now`.
 */
export function actionScope(a: ResolvedAction, now: bigint): AuthorityScope {
  return singletonScope(a, a.quoteObservedAt === null ? null : quoteAge(a.quoteObservedAt, now));
}

/**
 * The singleton scope a child authorization commits to (F7F1-01): every
 * fact of the action, and — for a quote-bearing action — the static policy
 * bound `maxQuoteAgeSeconds` instead of the quote's current age. With the
 * quote's observation time committed by the candidate digest, and the
 * child's window ending at `quoteExpiresAt`, this is independent of when it
 * is derived: one signed proposal has one child.
 */
export function authorizedScope(a: ResolvedAction, maxQuoteAgeSeconds: bigint | null): AuthorityScope {
  return singletonScope(a, maxQuoteAgeSeconds);
}

const ACTION_CODE: { readonly [K in ReasonCode]?: ReasonCode } = {
  CHILD_WIDENS_DOMAINS: 'DOMAIN_NOT_ALLOWED',
  CHILD_WIDENS_ACTIONS: 'ACTION_NOT_ALLOWED',
  CHILD_WIDENS_CHAINS: 'CHAIN_NOT_ALLOWED',
  CHILD_WIDENS_VENUES: 'VENUE_NOT_ALLOWED',
  CHILD_WIDENS_ASSETS: 'ASSET_NOT_ALLOWED',
  CHILD_WIDENS_REPRESENTATIONS: 'REPRESENTATION_NOT_ALLOWED',
  CHILD_WIDENS_ISSUERS: 'ISSUER_NOT_ALLOWED',
  CHILD_WIDENS_RECIPIENTS: 'RECIPIENT_NOT_ALLOWED',
  CHILD_WIDENS_SYNTHETIC_POLICY: 'SYNTHETIC_NOT_ALLOWED',
  CHILD_DROPS_REQUIRED_RIGHT: 'REQUIRED_RIGHT_MISSING',
  CHILD_WIDENS_LEVERAGE: 'LEVERAGE_NOT_ALLOWED',
  CHILD_WIDENS_SLIPPAGE: 'SLIPPAGE_NOT_ALLOWED',
};

/**
 * Every reason `scope` does not permit action `a` at `now`: the singleton
 * scope's subset violations under their action-level names, each route pool
 * that is not an allowed venue, and a quote observed after `now` — refused
 * whatever the bound, `QUOTE_NOT_ALLOWED` where the scope permits no quote.
 * Empty: permitted.
 */
export function permits(scope: AuthorityScope, a: ResolvedAction, now: bigint): readonly Reason[] {
  const found: Reason[] = [];
  if (a.quoteObservedAt !== null && a.quoteObservedAt > now) found.push(reason(scope.maxQuoteAgeSeconds === null ? 'QUOTE_NOT_ALLOWED' : 'QUOTE_STALE', 'quote'));
  for (const r of checkChildScope(scope, actionScope(a, now))) {
    if (r.code === 'CHILD_WIDENS_QUOTE_AGE') found.push(reason(scope.maxQuoteAgeSeconds === null ? 'QUOTE_NOT_ALLOWED' : 'QUOTE_STALE', 'quote'));
    else found.push(reason(ACTION_CODE[r.code] ?? r.code, r.subject));
  }
  const venues = new Set<string>(scope.venues);
  for (const hop of a.route) if (!venues.has(hop)) found.push(reason('ROUTE_NOT_ALLOWED', `route:${hop}`));
  return canonicalReasons(found);
}

