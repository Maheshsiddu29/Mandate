/**
 * Authority scope (portfolio-mandate.md §4, §7).
 *
 * The shape of an authority: which domains, actions, chains, venues,
 * canonical assets, exact representations, issuers and recipients it covers,
 * and which per-action bounds apply. The portfolio has one; every agent has
 * one that must be a subset of it.
 *
 * **Closed world.** An empty set permits nothing, and an absent bound permits
 * nothing that needs it: `maxLeverage: null` forbids every leveraged action,
 * `maxSlippageBps: null` every slippage-bearing one, `maxQuoteAgeSeconds:
 * null` every quote-dependent one. Adding a field in a later version can
 * therefore never widen a scope signed under this one.
 *
 * Nothing here is inferred from a label, ticker, symbol or display name.
 * "Representation" is the exact instrument identity: a registry
 * `RepresentationId` for a token, a collection contract for an NFT, a vault
 * for a yield product, a market for a perpetual.
 */

import { ok, type ByteWriter, type CanonicalAssetId, type Identifier } from '@mandate/kernel';
import {
  UINT64_MAX,
  at,
  canonicalSet,
  checkArray,
  checkFields,
  fail,
  parseEnum,
  parseIdentifierAs,
  parseIntegerInRange,
  parseSmallUint,
  readCode,
  readNullable,
  readRatioInput,
  validateRatio,
  writeCode,
  writeNullable,
  writeRatio,
  type CoreReader,
  type CoreResult,
  type DomainId,
  type IntegerInput,
  type Ratio,
  type RatioInput,
  type Tagged,
  type WireCodes,
} from '@mandate/core';
import { RightKind } from '@mandate/registry';

/** The most members any one set of a scope may hold. */
export const MAX_SCOPE_MEMBERS = 64;

export const ActionKind = {
  STOCK_BUY: 'STOCK_BUY',
  SWAP_EXACT_IN: 'SWAP_EXACT_IN',
  NFT_BUY: 'NFT_BUY',
  YIELD_DEPOSIT: 'YIELD_DEPOSIT',
  PERP_OPEN: 'PERP_OPEN',
} as const;
export type ActionKind = (typeof ActionKind)[keyof typeof ActionKind];
export const ACTION_KINDS: readonly ActionKind[] = Object.values(ActionKind);
export const ACTION_KIND_CODE: WireCodes<ActionKind> = { STOCK_BUY: 1, SWAP_EXACT_IN: 2, NFT_BUY: 3, YIELD_DEPOSIT: 4, PERP_OPEN: 5 };

export const SyntheticPolicy = { FORBIDDEN: 'FORBIDDEN', ALLOWED: 'ALLOWED' } as const;
export type SyntheticPolicy = (typeof SyntheticPolicy)[keyof typeof SyntheticPolicy];
const SYNTHETIC_POLICIES: readonly SyntheticPolicy[] = ['FORBIDDEN', 'ALLOWED'];
const SYNTHETIC_CODE: WireCodes<SyntheticPolicy> = { FORBIDDEN: 1, ALLOWED: 2 };

const RIGHT_KINDS: readonly RightKind[] = Object.values(RightKind);

export interface CanonicalAssetInput {
  readonly assetClass: string;
  readonly idScheme: string;
  readonly value: string;
}

export interface AuthorityScopeInput {
  readonly domains: readonly string[];
  readonly actions: readonly string[];
  readonly chains: readonly string[];
  readonly venues: readonly string[];
  readonly assets: readonly CanonicalAssetInput[];
  readonly representations: readonly string[];
  readonly issuers: readonly string[];
  readonly recipients: readonly string[];
  readonly syntheticPolicy: string;
  readonly requiredRights: readonly string[];
  readonly maxLeverage: RatioInput | null;
  readonly maxSlippageBps: number | null;
  readonly maxQuoteAgeSeconds: IntegerInput | null;
}

export type AuthorityScope = Tagged<
  {
    readonly domains: readonly DomainId[];
    readonly actions: readonly ActionKind[];
    readonly chains: readonly Identifier[];
    readonly venues: readonly Identifier[];
    /** The kernel's canonical asset reference, never a ticker. */
    readonly assets: readonly CanonicalAssetId[];
    readonly representations: readonly Identifier[];
    readonly issuers: readonly Identifier[];
    readonly recipients: readonly Identifier[];
    readonly syntheticPolicy: SyntheticPolicy;
    /** Registry right kinds that must be established `PRESENT`. */
    readonly requiredRights: readonly RightKind[];
    readonly maxLeverage: Ratio | null;
    readonly maxSlippageBps: number | null;
    readonly maxQuoteAgeSeconds: bigint | null;
  },
  'AuthorityScope'
>;

/** The eight set vocabularies, in encoding order. */
export const SCOPE_SETS = ['domains', 'actions', 'chains', 'venues', 'assets', 'representations', 'issuers', 'recipients'] as const;
export type ScopeSet = (typeof SCOPE_SETS)[number];

// --- Validation ----------------------------------------------------------------------

function identifierSet<T extends Identifier>(inputs: readonly string[], path: string): CoreResult<readonly T[]> {
  const arr = checkArray(inputs, MAX_SCOPE_MEMBERS, path);
  if (!arr.ok) return arr;
  const out: T[] = [];
  for (let i = 0; i < inputs.length; i += 1) {
    const v = parseIdentifierAs<T>(inputs[i] as string, at(path, i));
    if (!v.ok) return v;
    out.push(v.value);
  }
  return canonicalSet(out, (w, v) => w.str(v), path);
}

function enumSet<T extends string>(inputs: readonly string[], values: readonly T[], codes: WireCodes<T>, path: string): CoreResult<readonly T[]> {
  const arr = checkArray(inputs, MAX_SCOPE_MEMBERS, path);
  if (!arr.ok) return arr;
  const out: T[] = [];
  for (let i = 0; i < inputs.length; i += 1) {
    const v = parseEnum(inputs[i] as string, values, at(path, i));
    if (!v.ok) return v;
    out.push(v.value);
  }
  return canonicalSet(out, (w, v) => writeCode(w, codes, v), path);
}

export function validateCanonicalAsset(input: CanonicalAssetInput, path: string): CoreResult<CanonicalAssetId> {
  const shape = checkFields(input, ['assetClass', 'idScheme', 'value'], path);
  if (!shape.ok) return shape;
  const assetClass = parseIdentifierAs(input.assetClass, at(path, 'assetClass'));
  if (!assetClass.ok) return assetClass;
  const idScheme = parseIdentifierAs(input.idScheme, at(path, 'idScheme'));
  if (!idScheme.ok) return idScheme;
  const value = parseIdentifierAs(input.value, at(path, 'value'));
  if (!value.ok) return value;
  return ok({ assetClass: assetClass.value, idScheme: idScheme.value, value: value.value });
}

export function writeCanonicalAsset(w: ByteWriter, a: CanonicalAssetId): void {
  w.str(a.assetClass).str(a.idScheme).str(a.value);
}

export function readCanonicalAssetInput(r: CoreReader): CanonicalAssetInput {
  const assetClass = r.str();
  const idScheme = r.str();
  const value = r.str();
  return { assetClass, idScheme, value };
}

/** One text key per canonical asset, for set membership. Never parsed. */
export function assetKey(a: CanonicalAssetId): string {
  return `${a.assetClass}\u0000${a.idScheme}\u0000${a.value}`;
}

const RIGHT_CODE: WireCodes<RightKind> = { ECONOMIC_EXPOSURE: 1, DIVIDEND_TREATMENT: 2, VOTING_RIGHTS: 3, REDEMPTION_RIGHTS: 4, BENEFICIAL_OWNERSHIP: 5, TRANSFERABILITY: 6 };

export function validateAuthorityScope(input: AuthorityScopeInput, path: string): CoreResult<AuthorityScope> {
  const shape = checkFields(input, ['domains', 'actions', 'chains', 'venues', 'assets', 'representations', 'issuers', 'recipients', 'syntheticPolicy', 'requiredRights', 'maxLeverage', 'maxSlippageBps', 'maxQuoteAgeSeconds'], path);
  if (!shape.ok) return shape;
  const domains = identifierSet<DomainId>(input.domains, at(path, 'domains'));
  if (!domains.ok) return domains;
  const actions = enumSet(input.actions, ACTION_KINDS, ACTION_KIND_CODE, at(path, 'actions'));
  if (!actions.ok) return actions;
  const chains = identifierSet(input.chains, at(path, 'chains'));
  if (!chains.ok) return chains;
  const venues = identifierSet(input.venues, at(path, 'venues'));
  if (!venues.ok) return venues;
  const assetsArr = checkArray(input.assets, MAX_SCOPE_MEMBERS, at(path, 'assets'));
  if (!assetsArr.ok) return assetsArr;
  const assetList: CanonicalAssetId[] = [];
  for (let i = 0; i < input.assets.length; i += 1) {
    const a = validateCanonicalAsset(input.assets[i] as CanonicalAssetInput, at(at(path, 'assets'), i));
    if (!a.ok) return a;
    assetList.push(a.value);
  }
  const assets = canonicalSet(assetList, writeCanonicalAsset, at(path, 'assets'));
  if (!assets.ok) return assets;
  const representations = identifierSet(input.representations, at(path, 'representations'));
  if (!representations.ok) return representations;
  const issuers = identifierSet(input.issuers, at(path, 'issuers'));
  if (!issuers.ok) return issuers;
  const recipients = identifierSet(input.recipients, at(path, 'recipients'));
  if (!recipients.ok) return recipients;
  const syntheticPolicy = parseEnum(input.syntheticPolicy, SYNTHETIC_POLICIES, at(path, 'syntheticPolicy'));
  if (!syntheticPolicy.ok) return syntheticPolicy;
  const requiredRights = enumSet(input.requiredRights, RIGHT_KINDS, RIGHT_CODE, at(path, 'requiredRights'));
  if (!requiredRights.ok) return requiredRights;
  let maxLeverage: Ratio | null = null;
  if (input.maxLeverage !== null) {
    const r = validateRatio(input.maxLeverage, at(path, 'maxLeverage'));
    if (!r.ok) return r;
    maxLeverage = r.value;
  }
  let maxSlippageBps: number | null = null;
  if (input.maxSlippageBps !== null) {
    const s = parseSmallUint(input.maxSlippageBps, 10_000, at(path, 'maxSlippageBps'));
    if (!s.ok) return s;
    maxSlippageBps = s.value;
  }
  let maxQuoteAgeSeconds: bigint | null = null;
  if (input.maxQuoteAgeSeconds !== null) {
    const q = parseIntegerInRange(input.maxQuoteAgeSeconds, 0n, UINT64_MAX, at(path, 'maxQuoteAgeSeconds'));
    if (!q.ok) return q;
    maxQuoteAgeSeconds = q.value;
  }
  return ok({
    domains: domains.value,
    actions: actions.value,
    chains: chains.value,
    venues: venues.value,
    assets: assets.value,
    representations: representations.value,
    issuers: issuers.value,
    recipients: recipients.value,
    syntheticPolicy: syntheticPolicy.value,
    requiredRights: requiredRights.value,
    maxLeverage,
    maxSlippageBps,
    maxQuoteAgeSeconds,
  } as AuthorityScope);
}

// --- Encoding --------------------------------------------------------------------------

function writeStrings(w: ByteWriter, values: readonly string[]): void {
  w.u16(values.length);
  for (const v of values) w.str(v);
}

function readStrings(r: CoreReader): string[] {
  return r.list(MAX_SCOPE_MEMBERS, (x) => x.str(), true);
}

export function writeAuthorityScope(w: ByteWriter, s: AuthorityScope): void {
  writeStrings(w, s.domains);
  w.u16(s.actions.length);
  for (const a of s.actions) writeCode(w, ACTION_KIND_CODE, a);
  writeStrings(w, s.chains);
  writeStrings(w, s.venues);
  w.u16(s.assets.length);
  for (const a of s.assets) writeCanonicalAsset(w, a);
  writeStrings(w, s.representations);
  writeStrings(w, s.issuers);
  writeStrings(w, s.recipients);
  writeCode(w, SYNTHETIC_CODE, s.syntheticPolicy);
  w.u16(s.requiredRights.length);
  for (const k of s.requiredRights) writeCode(w, RIGHT_CODE, k);
  writeNullable(w, s.maxLeverage, writeRatio);
  writeNullable(w, s.maxSlippageBps, (x, v) => x.u32(v));
  writeNullable(w, s.maxQuoteAgeSeconds, (x, v) => x.u64(v));
}

export function readAuthorityScopeInput(r: CoreReader): AuthorityScopeInput {
  const domains = readStrings(r);
  const actions = r.list(MAX_SCOPE_MEMBERS, (x) => readCode(x, ACTION_KIND_CODE), true);
  const chains = readStrings(r);
  const venues = readStrings(r);
  const assets = r.list(MAX_SCOPE_MEMBERS, readCanonicalAssetInput, true);
  const representations = readStrings(r);
  const issuers = readStrings(r);
  const recipients = readStrings(r);
  const syntheticPolicy = readCode(r, SYNTHETIC_CODE);
  const requiredRights = r.list(MAX_SCOPE_MEMBERS, (x) => readCode(x, RIGHT_CODE), true);
  const maxLeverage = readNullable(r, readRatioInput);
  // Any u32 decodes; the validator then refuses one above 10,000 bps by name.
  const maxSlippageBps = readNullable(r, (x) => x.u32());
  const maxQuoteAgeSeconds = readNullable(r, (x) => x.u64());
  return { domains, actions, chains, venues, assets, representations, issuers, recipients, syntheticPolicy, requiredRights, maxLeverage, maxSlippageBps, maxQuoteAgeSeconds };
}

export function authorityScopeInputOf(s: AuthorityScope): AuthorityScopeInput {
  return {
    domains: [...s.domains],
    actions: [...s.actions],
    chains: [...s.chains],
    venues: [...s.venues],
    assets: s.assets.map((a) => ({ assetClass: a.assetClass, idScheme: a.idScheme, value: a.value })),
    representations: [...s.representations],
    issuers: [...s.issuers],
    recipients: [...s.recipients],
    syntheticPolicy: s.syntheticPolicy,
    requiredRights: [...s.requiredRights],
    maxLeverage: s.maxLeverage === null ? null : { numerator: s.maxLeverage.numerator, scale: s.maxLeverage.scale },
    maxSlippageBps: s.maxSlippageBps,
    maxQuoteAgeSeconds: s.maxQuoteAgeSeconds,
  };
}

/** The members of one set vocabulary as comparable text keys. */
export function setKeys(s: AuthorityScope, set: ScopeSet): readonly string[] {
  return set === 'assets' ? s.assets.map(assetKey) : (s[set] as readonly string[]);
}
