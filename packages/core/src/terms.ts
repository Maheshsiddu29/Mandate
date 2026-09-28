/**
 * Authority terms (authority-model.md §3; authority-ledger.md §2–3).
 *
 * Seven kinds, as a closed discriminated union. They are separate because they
 * compose differently under delegation and are enforced by different
 * mechanisms; only `LEDGER_DIMENSION` is a counter.
 *
 * | kind               | enforced by (later phases)                  |
 * | ------------------ | ------------------------------------------- |
 * | `SET`              | coverage, per action                        |
 * | `RIGHT`            | coverage, per action                        |
 * | `BOUND`            | coverage, against the action's parameters   |
 * | `TIME_WINDOW`      | coverage, per domain                        |
 * | `LEDGER_DIMENSION` | ledger reservation on the charging path     |
 * | `STATE_INVARIANT`  | evaluation over projected state             |
 * | `STATE_POLICY`     | state admission                             |
 *
 * Every term's category is typed. Domain content appears only where the
 * specification makes it the module's: an invariant's parameters are opaque
 * canonical bytes whose schema is in the module manifest. Core never reads
 * them.
 *
 * Within one grant or policy each term is unique by its key (one set per
 * vocabulary, one right of each name, one bound per `(boundId, polarity)`, ...).
 * A second term with the same key is refused rather than merged: a meet or a
 * "no weaker" comparison is only defined when each constrained thing has
 * exactly one term. Terms are stored and encoded in canonical order, so the
 * order a caller lists them in never changes a digest.
 *
 * No subset, meet or comparison logic is implemented here. That is the
 * authority engine (7C onward).
 */

import { ok, type ByteWriter } from '@mandate/kernel';
import type { Tagged } from './brand.ts';
import { at, fail, type CoreResult } from './errors.ts';
import {
  ASSET_KINDS,
  RESOURCE_KINDS,
  readResourceIdInput,
  resourceIdInputOf,
  validateResourceId,
  writeResourceId,
  type AccountId,
  type ActionType,
  type AssetId,
  type BoundId,
  type DimensionId,
  type DomainId,
  type InvariantId,
  type InvariantVersion,
  type MarketId,
  type RecipientId,
  type ResourceId,
  type ResourceIdInput,
  type StateKind,
  type StateSourceId,
  type VenueId,
} from './identifiers.ts';
import {
  UINT32_MAX,
  checkArray,
  checkFields,
  parseEnum,
  parseIdentifierAs,
  parseIntegerInRange,
  parseOpaqueBytes,
  parseSmallUint,
  parseUnixSeconds,
  type IntegerInput,
  type OpaqueBytes,
} from './primitives.ts';
import {
  canonicalSet,
  compareBytes,
  encodeWith,
  readCode,
  readNullable,
  writeCode,
  writeList,
  writeNullable,
  writeOpaqueBytes,
  type CoreReader,
  type WireCodes,
} from './encoding.ts';
import {
  QUANTITY_KIND_RULES,
  quantityBoundInputOf,
  readQuantityBoundInput,
  readRatioInput,
  validateQuantityBound,
  validateRatio,
  writeQuantityBound,
  writeRatio,
  type QuantityBound,
  type QuantityBoundInput,
  type Ratio,
  type RatioInput,
} from './quantity.ts';
import {
  adapterRefInputOf,
  moduleRefInputOf,
  readAdapterRefInput,
  readModuleRefInput,
  validateAdapterRef,
  validateModuleRef,
  writeAdapterRef,
  writeModuleRef,
  type AdapterRef,
  type AdapterRefInput,
  type ModuleRef,
  type ModuleRefInput,
} from './module.ts';
import {
  readStateRequirementInput,
  stateRequirementInputOf,
  validateStateRequirement,
  writeStateRequirement,
  type StateRequirement,
  type StateRequirementInput,
} from './state.ts';
import { MAX_ADMITTED_SOURCES, MAX_DELEGATION_DEPTH, MAX_INVARIANT_PARAMS_BYTES, MAX_INVARIANT_SCOPE, MAX_SET_MEMBERS } from './limits.ts';

export const TermKind = {
  SET: 'SET',
  RIGHT: 'RIGHT',
  BOUND: 'BOUND',
  TIME_WINDOW: 'TIME_WINDOW',
  LEDGER_DIMENSION: 'LEDGER_DIMENSION',
  STATE_INVARIANT: 'STATE_INVARIANT',
  STATE_POLICY: 'STATE_POLICY',
} as const;
export type TermKind = (typeof TermKind)[keyof typeof TermKind];
export const TERM_KINDS: readonly TermKind[] = Object.values(TermKind);
const TERM_KIND_CODE: WireCodes<TermKind> = {
  SET: 1,
  RIGHT: 2,
  BOUND: 3,
  TIME_WINDOW: 4,
  LEDGER_DIMENSION: 5,
  STATE_INVARIANT: 6,
  STATE_POLICY: 7,
};

/** Terms that say what an action may do. The principal policy grants nothing, so it may hold none of them. */
export const GRANTING_TERM_KINDS: readonly TermKind[] = ['SET', 'RIGHT'];

// --- SET -------------------------------------------------------------------------

export interface ActionTypeRefInput {
  readonly domain: string;
  readonly actionType: string;
}

/** An action type is only meaningful within its domain's closed vocabulary. */
export type ActionTypeRef = Tagged<{ readonly domain: DomainId; readonly actionType: ActionType }, 'ActionTypeRef'>;

export type SetConstraintInput =
  | { readonly kind: 'SET'; readonly vocabulary: 'MODULES'; readonly members: readonly ModuleRefInput[] }
  | { readonly kind: 'SET'; readonly vocabulary: 'ADAPTERS'; readonly members: readonly AdapterRefInput[] }
  | { readonly kind: 'SET'; readonly vocabulary: 'MARKETS'; readonly members: readonly ResourceIdInput[] }
  | { readonly kind: 'SET'; readonly vocabulary: 'ASSETS'; readonly members: readonly ResourceIdInput[] }
  | { readonly kind: 'SET'; readonly vocabulary: 'VENUES'; readonly members: readonly ResourceIdInput[] }
  | { readonly kind: 'SET'; readonly vocabulary: 'RECIPIENTS'; readonly members: readonly ResourceIdInput[] }
  | { readonly kind: 'SET'; readonly vocabulary: 'ACTION_TYPES'; readonly members: readonly ActionTypeRefInput[] };

/**
 * Closed-world set membership. An absent vocabulary grants nothing, and an
 * empty set grants nothing; neither is read as "unconstrained". Modules and
 * adapters are allowed only as exact refs, digest included (DOM-2).
 */
export type SetConstraintTerm = Tagged<
  | { readonly kind: 'SET'; readonly vocabulary: 'MODULES'; readonly members: readonly ModuleRef[] }
  | { readonly kind: 'SET'; readonly vocabulary: 'ADAPTERS'; readonly members: readonly AdapterRef[] }
  | { readonly kind: 'SET'; readonly vocabulary: 'MARKETS'; readonly members: readonly MarketId[] }
  | { readonly kind: 'SET'; readonly vocabulary: 'ASSETS'; readonly members: readonly AssetId[] }
  | { readonly kind: 'SET'; readonly vocabulary: 'VENUES'; readonly members: readonly VenueId[] }
  | { readonly kind: 'SET'; readonly vocabulary: 'RECIPIENTS'; readonly members: readonly RecipientId[] }
  | { readonly kind: 'SET'; readonly vocabulary: 'ACTION_TYPES'; readonly members: readonly ActionTypeRef[] },
  'AuthorityTerm'
>;

export type SetVocabulary = SetConstraintInput['vocabulary'];
const SET_VOCABULARIES: readonly SetVocabulary[] = ['MODULES', 'ADAPTERS', 'MARKETS', 'ASSETS', 'VENUES', 'RECIPIENTS', 'ACTION_TYPES'];
const SET_VOCABULARY_CODE: WireCodes<SetVocabulary> = {
  MODULES: 1,
  ADAPTERS: 2,
  MARKETS: 3,
  ASSETS: 4,
  VENUES: 5,
  RECIPIENTS: 6,
  ACTION_TYPES: 7,
};

function validateActionTypeRef(input: ActionTypeRefInput, path: string): CoreResult<ActionTypeRef> {
  const shape = checkFields(input, ['domain', 'actionType'], path);
  if (!shape.ok) return shape;
  const domain = parseIdentifierAs<DomainId>(input.domain, at(path, 'domain'));
  if (!domain.ok) return domain;
  const actionType = parseIdentifierAs<ActionType>(input.actionType, at(path, 'actionType'));
  if (!actionType.ok) return actionType;
  return ok({ domain: domain.value, actionType: actionType.value } as ActionTypeRef);
}

function writeActionTypeRef(w: ByteWriter, a: ActionTypeRef): void {
  w.str(a.domain).str(a.actionType);
}

function readActionTypeRefInput(r: CoreReader): ActionTypeRefInput {
  const domain = r.str();
  const actionType = r.str();
  return { domain, actionType };
}

/** Validate each member, then canonicalize: sorted by encoded bytes, duplicates refused. */
function validateMembers<I, T>(
  inputs: readonly I[],
  validate: (input: I, path: string) => CoreResult<T>,
  write: (w: ByteWriter, item: T) => void,
  path: string,
): CoreResult<readonly T[]> {
  if (!Array.isArray(inputs)) return fail('WRONG_TYPE', path);
  if (inputs.length > MAX_SET_MEMBERS) return fail('COLLECTION_TOO_LARGE', path);
  const out: T[] = [];
  for (let i = 0; i < inputs.length; i += 1) {
    const v = validate(inputs[i] as I, at(path, i));
    if (!v.ok) return v;
    out.push(v.value);
  }
  return canonicalSet(out, write, path);
}

function resourceValidator<K extends ResourceId['kind']>(kinds: readonly K[]) {
  return (input: ResourceIdInput, path: string): CoreResult<ResourceId<K>> => validateResourceId(input, kinds, path);
}

function validateSetTerm(input: SetConstraintInput, path: string): CoreResult<SetConstraintTerm> {
  const shape = checkFields(input, ['kind', 'vocabulary', 'members'], path);
  if (!shape.ok) return shape;
  const vocabulary = parseEnum(input.vocabulary, SET_VOCABULARIES, at(path, 'vocabulary'));
  if (!vocabulary.ok) return vocabulary;
  const mp = at(path, 'members');
  switch (input.vocabulary) {
    case 'MODULES': {
      const m = validateMembers(input.members, validateModuleRef, writeModuleRef, mp);
      return m.ok ? ok({ kind: 'SET', vocabulary: 'MODULES', members: m.value } as SetConstraintTerm) : m;
    }
    case 'ADAPTERS': {
      const m = validateMembers(input.members, validateAdapterRef, writeAdapterRef, mp);
      return m.ok ? ok({ kind: 'SET', vocabulary: 'ADAPTERS', members: m.value } as SetConstraintTerm) : m;
    }
    case 'MARKETS': {
      const m = validateMembers(input.members, resourceValidator(['MARKET'] as const), writeResourceId, mp);
      return m.ok ? ok({ kind: 'SET', vocabulary: 'MARKETS', members: m.value } as SetConstraintTerm) : m;
    }
    case 'ASSETS': {
      const m = validateMembers(input.members, resourceValidator(ASSET_KINDS), writeResourceId, mp);
      return m.ok ? ok({ kind: 'SET', vocabulary: 'ASSETS', members: m.value } as SetConstraintTerm) : m;
    }
    case 'VENUES': {
      const m = validateMembers(input.members, resourceValidator(['VENUE'] as const), writeResourceId, mp);
      return m.ok ? ok({ kind: 'SET', vocabulary: 'VENUES', members: m.value } as SetConstraintTerm) : m;
    }
    case 'RECIPIENTS': {
      const m = validateMembers(input.members, resourceValidator(['RECIPIENT', 'ACCOUNT'] as const), writeResourceId, mp);
      return m.ok ? ok({ kind: 'SET', vocabulary: 'RECIPIENTS', members: m.value } as SetConstraintTerm) : m;
    }
    case 'ACTION_TYPES': {
      const m = validateMembers(input.members, validateActionTypeRef, writeActionTypeRef, mp);
      return m.ok ? ok({ kind: 'SET', vocabulary: 'ACTION_TYPES', members: m.value } as SetConstraintTerm) : m;
    }
  }
}

function writeSetTerm(w: ByteWriter, t: SetConstraintTerm): void {
  writeCode(w, SET_VOCABULARY_CODE, t.vocabulary);
  switch (t.vocabulary) {
    case 'MODULES':
      writeList(w, t.members, writeModuleRef);
      break;
    case 'ADAPTERS':
      writeList(w, t.members, writeAdapterRef);
      break;
    case 'ACTION_TYPES':
      writeList(w, t.members, writeActionTypeRef);
      break;
    case 'MARKETS':
    case 'ASSETS':
    case 'VENUES':
    case 'RECIPIENTS':
      writeList<ResourceId>(w, t.members, writeResourceId);
      break;
  }
}

function readSetTermInput(r: CoreReader): SetConstraintInput {
  const vocabulary = readCode(r, SET_VOCABULARY_CODE);
  switch (vocabulary) {
    case 'MODULES':
      return { kind: 'SET', vocabulary, members: r.list(MAX_SET_MEMBERS, readModuleRefInput, true) };
    case 'ADAPTERS':
      return { kind: 'SET', vocabulary, members: r.list(MAX_SET_MEMBERS, readAdapterRefInput, true) };
    case 'ACTION_TYPES':
      return { kind: 'SET', vocabulary, members: r.list(MAX_SET_MEMBERS, readActionTypeRefInput, true) };
    case 'MARKETS':
    case 'ASSETS':
    case 'VENUES':
    case 'RECIPIENTS':
      return { kind: 'SET', vocabulary, members: r.list(MAX_SET_MEMBERS, readResourceIdInput, true) };
  }
}

function setTermInputOf(t: SetConstraintTerm): SetConstraintInput {
  switch (t.vocabulary) {
    case 'MODULES':
      return { kind: 'SET', vocabulary: 'MODULES', members: t.members.map(moduleRefInputOf) };
    case 'ADAPTERS':
      return { kind: 'SET', vocabulary: 'ADAPTERS', members: t.members.map(adapterRefInputOf) };
    case 'ACTION_TYPES':
      return { kind: 'SET', vocabulary: 'ACTION_TYPES', members: t.members.map((m) => ({ domain: m.domain, actionType: m.actionType })) };
    case 'MARKETS':
    case 'ASSETS':
    case 'VENUES':
    case 'RECIPIENTS':
      return { kind: 'SET', vocabulary: t.vocabulary, members: t.members.map((m: ResourceId) => resourceIdInputOf(m)) };
  }
}

// --- RIGHT -----------------------------------------------------------------------

export const Right = { OPEN_RISK: 'OPEN_RISK', REDUCE_RISK: 'REDUCE_RISK', TRANSFER_OUT: 'TRANSFER_OUT', DELEGATE: 'DELEGATE' } as const;
export type Right = (typeof Right)[keyof typeof Right];
const RIGHTS: readonly Right[] = Object.values(Right);
const RIGHT_CODE: WireCodes<Right> = { OPEN_RISK: 1, REDUCE_RISK: 2, TRANSFER_OUT: 3, DELEGATE: 4 };

export type RightTermInput =
  | { readonly kind: 'RIGHT'; readonly right: 'OPEN_RISK' | 'REDUCE_RISK' | 'TRANSFER_OUT' }
  | { readonly kind: 'RIGHT'; readonly right: 'DELEGATE'; readonly maxDepth: number };

/**
 * A boolean right. `DELEGATE` carries the delegation depth permitted below the
 * node, 1..`MAX_DELEGATION_DEPTH`; a `DELEGATE` of depth 0 is incoherent and
 * refused at parse (authority-model.md §3). Without `DELEGATE` the depth is 0.
 */
export type RightTerm = Tagged<
  | { readonly kind: 'RIGHT'; readonly right: 'OPEN_RISK' | 'REDUCE_RISK' | 'TRANSFER_OUT' }
  | { readonly kind: 'RIGHT'; readonly right: 'DELEGATE'; readonly maxDepth: number },
  'AuthorityTerm'
>;

function validateRightTerm(input: RightTermInput, path: string): CoreResult<RightTerm> {
  const right = parseEnum(input.right, RIGHTS, at(path, 'right'));
  if (!right.ok) return right;
  if (input.right === 'DELEGATE') {
    const shape = checkFields(input, ['kind', 'right', 'maxDepth'], path);
    if (!shape.ok) return shape;
    const depth = parseSmallUint(input.maxDepth, Number.MAX_SAFE_INTEGER, at(path, 'maxDepth'));
    if (!depth.ok) return depth;
    if (depth.value < 1 || depth.value > MAX_DELEGATION_DEPTH) return fail('DELEGATE_DEPTH_INVALID', at(path, 'maxDepth'));
    return ok({ kind: 'RIGHT', right: 'DELEGATE', maxDepth: depth.value } as RightTerm);
  }
  const shape = checkFields(input, ['kind', 'right'], path);
  if (!shape.ok) return shape;
  return ok({ kind: 'RIGHT', right: input.right } as RightTerm);
}

function writeRightTerm(w: ByteWriter, t: RightTerm): void {
  writeCode(w, RIGHT_CODE, t.right);
  if (t.right === 'DELEGATE') w.u8(t.maxDepth);
}

function readRightTermInput(r: CoreReader): RightTermInput {
  const right = readCode(r, RIGHT_CODE);
  return right === 'DELEGATE' ? { kind: 'RIGHT', right, maxDepth: r.u8() } : { kind: 'RIGHT', right };
}

// --- BOUND -----------------------------------------------------------------------

export const BoundPolarity = { MAX: 'MAX', MIN: 'MIN' } as const;
export type BoundPolarity = (typeof BoundPolarity)[keyof typeof BoundPolarity];
const POLARITIES: readonly BoundPolarity[] = Object.values(BoundPolarity);
const POLARITY_CODE: WireCodes<BoundPolarity> = { MAX: 1, MIN: 2 };

export type BoundValueInput =
  | { readonly type: 'QUANTITY'; readonly quantity: QuantityBoundInput }
  | { readonly type: 'RATIO'; readonly ratio: RatioInput };

export type BoundValue = { readonly type: 'QUANTITY'; readonly quantity: QuantityBound } | { readonly type: 'RATIO'; readonly ratio: Ratio };
const BOUND_VALUE_CODE: WireCodes<BoundValue['type']> = { QUANTITY: 1, RATIO: 2 };
const BOUND_VALUE_TYPES: readonly BoundValue['type'][] = ['QUANTITY', 'RATIO'];

export interface PerActionBoundInput {
  readonly kind: 'BOUND';
  readonly boundId: string;
  readonly polarity: BoundPolarity;
  readonly value: BoundValueInput;
}

/**
 * A ceiling (`MAX`) or floor (`MIN`) on one parameter of the action itself:
 * max order notional, max order leverage, max slippage, min credit. Not a
 * state invariant: "leverage ≤ 3x" as a bound limits the order's leverage
 * parameter, not the account's resulting leverage.
 */
export type PerActionBoundTerm = Tagged<
  { readonly kind: 'BOUND'; readonly boundId: BoundId; readonly polarity: BoundPolarity; readonly value: BoundValue },
  'AuthorityTerm'
>;

function validateBoundTerm(input: PerActionBoundInput, path: string): CoreResult<PerActionBoundTerm> {
  const shape = checkFields(input, ['kind', 'boundId', 'polarity', 'value'], path);
  if (!shape.ok) return shape;
  const boundId = parseIdentifierAs<BoundId>(input.boundId, at(path, 'boundId'));
  if (!boundId.ok) return boundId;
  const polarity = parseEnum(input.polarity, POLARITIES, at(path, 'polarity'));
  if (!polarity.ok) return polarity;
  const vp = at(path, 'value');
  if (typeof input.value !== 'object' || input.value === null) return fail('WRONG_TYPE', vp);
  const type = parseEnum(input.value.type, BOUND_VALUE_TYPES, at(vp, 'type'));
  if (!type.ok) return type;
  let value: BoundValue;
  if (input.value.type === 'QUANTITY') {
    const vs = checkFields(input.value, ['type', 'quantity'], vp);
    if (!vs.ok) return vs;
    const q = validateQuantityBound(input.value.quantity, at(vp, 'quantity'));
    if (!q.ok) return q;
    value = { type: 'QUANTITY', quantity: q.value };
  } else {
    const vs = checkFields(input.value, ['type', 'ratio'], vp);
    if (!vs.ok) return vs;
    const ratio = validateRatio(input.value.ratio, at(vp, 'ratio'));
    if (!ratio.ok) return ratio;
    value = { type: 'RATIO', ratio: ratio.value };
  }
  return ok({ kind: 'BOUND', boundId: boundId.value, polarity: polarity.value, value } as PerActionBoundTerm);
}

function writeBoundTerm(w: ByteWriter, t: PerActionBoundTerm): void {
  w.str(t.boundId);
  writeCode(w, POLARITY_CODE, t.polarity);
  writeCode(w, BOUND_VALUE_CODE, t.value.type);
  if (t.value.type === 'QUANTITY') writeQuantityBound(w, t.value.quantity);
  else writeRatio(w, t.value.ratio);
}

function readBoundTermInput(r: CoreReader): PerActionBoundInput {
  const boundId = r.str();
  const polarity = readCode(r, POLARITY_CODE);
  const type = readCode(r, BOUND_VALUE_CODE);
  const value: BoundValueInput =
    type === 'QUANTITY' ? { type, quantity: readQuantityBoundInput(r) } : { type, ratio: readRatioInput(r) };
  return { kind: 'BOUND', boundId, polarity, value };
}

// --- TIME_WINDOW -----------------------------------------------------------------

export interface TimeWindowInput {
  readonly kind: 'TIME_WINDOW';
  readonly domain: string;
  readonly notBefore: IntegerInput;
  readonly expiresAt: IntegerInput;
}

/**
 * A per-domain trading window `[notBefore, expiresAt)`, in addition to the
 * grant's own mandatory validity. Absolute only: recurring schedules are not
 * specified and are not representable.
 */
export type TimeWindowTerm = Tagged<
  { readonly kind: 'TIME_WINDOW'; readonly domain: DomainId; readonly notBefore: bigint; readonly expiresAt: bigint },
  'AuthorityTerm'
>;

export function validateWindow(
  notBefore: IntegerInput,
  expiresAt: IntegerInput,
  path: string,
  startField = 'notBefore',
): CoreResult<{ notBefore: bigint; expiresAt: bigint }> {
  const nb = parseUnixSeconds(notBefore, at(path, startField));
  if (!nb.ok) return nb;
  const ea = parseUnixSeconds(expiresAt, at(path, 'expiresAt'));
  if (!ea.ok) return ea;
  // `notBefore ≤ t < expiresAt` must be satisfiable.
  if (nb.value >= ea.value) return fail('INVALID_TIME_WINDOW', path);
  return ok({ notBefore: nb.value, expiresAt: ea.value });
}

function validateTimeWindowTerm(input: TimeWindowInput, path: string): CoreResult<TimeWindowTerm> {
  const shape = checkFields(input, ['kind', 'domain', 'notBefore', 'expiresAt'], path);
  if (!shape.ok) return shape;
  const domain = parseIdentifierAs<DomainId>(input.domain, at(path, 'domain'));
  if (!domain.ok) return domain;
  const window = validateWindow(input.notBefore, input.expiresAt, path);
  if (!window.ok) return window;
  return ok({ kind: 'TIME_WINDOW', domain: domain.value, ...window.value } as TimeWindowTerm);
}

function writeTimeWindowTerm(w: ByteWriter, t: TimeWindowTerm): void {
  w.str(t.domain).i64(t.notBefore).i64(t.expiresAt);
}

function readTimeWindowTermInput(r: CoreReader): TimeWindowInput {
  const domain = r.str();
  const notBefore = r.i64();
  const expiresAt = r.i64();
  return { kind: 'TIME_WINDOW', domain, notBefore, expiresAt };
}

// --- LEDGER_DIMENSION ------------------------------------------------------------

export const Accounting = { BUDGET: 'BUDGET', CAPACITY: 'CAPACITY' } as const;
export type Accounting = (typeof Accounting)[keyof typeof Accounting];
const ACCOUNTING_VALUES: readonly Accounting[] = Object.values(Accounting);
const ACCOUNTING_CODE: WireCodes<Accounting> = { BUDGET: 1, CAPACITY: 2 };

/**
 * Restoration modes (decision 11). `NONE` and `EPOCH` belong to `BUDGET`;
 * `AS_CHARGED` and `UNITS` to `CAPACITY`. The type records the mode; the
 * accounting that applies it is the ledger's (7C).
 */
export const Restoration = { NONE: 'NONE', EPOCH: 'EPOCH', AS_CHARGED: 'AS_CHARGED', UNITS: 'UNITS' } as const;
export type Restoration = (typeof Restoration)[keyof typeof Restoration];
const RESTORATION_VALUES: readonly Restoration[] = Object.values(Restoration);
const RESTORATION_CODE: WireCodes<Restoration> = { NONE: 1, EPOCH: 2, AS_CHARGED: 3, UNITS: 4 };
const RESTORATION_FAMILY: { readonly [R in Restoration]: Accounting } = {
  NONE: 'BUDGET',
  EPOCH: 'BUDGET',
  AS_CHARGED: 'CAPACITY',
  UNITS: 'CAPACITY',
};

export const SignMode = { UNSIGNED: 'UNSIGNED', NET: 'NET' } as const;
export type SignMode = (typeof SignMode)[keyof typeof SignMode];
const SIGN_MODES: readonly SignMode[] = Object.values(SignMode);
const SIGN_MODE_CODE: WireCodes<SignMode> = { UNSIGNED: 1, NET: 2 };

export interface EpochInput {
  readonly anchor: IntegerInput;
  readonly lengthSeconds: IntegerInput;
}

/** The minimum an `EPOCH` budget needs: where windows start and how long each is. No scheduling logic. */
export type Epoch = Tagged<{ readonly anchor: bigint; readonly lengthSeconds: bigint }, 'Epoch'>;

export interface DimensionScopeInput {
  readonly asset: ResourceIdInput | null;
  readonly market: ResourceIdInput | null;
  readonly domain: string | null;
  readonly account: ResourceIdInput | null;
}

/** Which contributions a dimension receives. An empty scope receives every contribution of its kind and unit. */
export type DimensionScope = Tagged<
  {
    readonly asset: AssetId | null;
    readonly market: MarketId | null;
    readonly domain: DomainId | null;
    readonly account: AccountId | null;
  },
  'DimensionScope'
>;

export interface LedgerDimensionInput {
  readonly kind: 'LEDGER_DIMENSION';
  readonly dimensionId: string;
  readonly limit: QuantityBoundInput;
  readonly accounting: Accounting;
  readonly restoration: Restoration;
  readonly epoch: EpochInput | null;
  readonly sign: SignMode;
  readonly scope: DimensionScopeInput;
}

/**
 * The specification's `DimensionGrant` (authority-ledger.md §3). The
 * dimension's kind and unit are its limit's: one measure, written once, so a
 * dimension cannot declare one kind and limit another.
 */
export type LedgerDimensionTerm = Tagged<
  {
    readonly kind: 'LEDGER_DIMENSION';
    readonly dimensionId: DimensionId;
    readonly limit: QuantityBound;
    readonly accounting: Accounting;
    readonly restoration: Restoration;
    readonly epoch: Epoch | null;
    readonly sign: SignMode;
    readonly scope: DimensionScope;
  },
  'AuthorityTerm'
>;

function validateScope(input: DimensionScopeInput, path: string): CoreResult<DimensionScope> {
  const shape = checkFields(input, ['asset', 'market', 'domain', 'account'], path);
  if (!shape.ok) return shape;
  let asset: AssetId | null = null;
  if (input.asset !== null) {
    const a = validateResourceId(input.asset, ASSET_KINDS, at(path, 'asset'));
    if (!a.ok) return a;
    asset = a.value;
  }
  let market: MarketId | null = null;
  if (input.market !== null) {
    const m = validateResourceId(input.market, ['MARKET'] as const, at(path, 'market'));
    if (!m.ok) return m;
    market = m.value;
  }
  let domain: DomainId | null = null;
  if (input.domain !== null) {
    const d = parseIdentifierAs<DomainId>(input.domain, at(path, 'domain'));
    if (!d.ok) return d;
    domain = d.value;
  }
  let account: AccountId | null = null;
  if (input.account !== null) {
    const a = validateResourceId(input.account, ['ACCOUNT'] as const, at(path, 'account'));
    if (!a.ok) return a;
    account = a.value;
  }
  return ok({ asset, market, domain, account } as DimensionScope);
}

function validateDimensionTerm(input: LedgerDimensionInput, path: string): CoreResult<LedgerDimensionTerm> {
  const shape = checkFields(input, ['kind', 'dimensionId', 'limit', 'accounting', 'restoration', 'epoch', 'sign', 'scope'], path);
  if (!shape.ok) return shape;
  const dimensionId = parseIdentifierAs<DimensionId>(input.dimensionId, at(path, 'dimensionId'));
  if (!dimensionId.ok) return dimensionId;
  const limit = validateQuantityBound(input.limit, at(path, 'limit'));
  if (!limit.ok) return limit;
  const rule = QUANTITY_KIND_RULES[limit.value.kind];
  // Decision 10: a value that floats with price is not a counter.
  if (!rule.ledgerTrackable) return fail('DIMENSION_KIND_NOT_LEDGER_TRACKABLE', at(path, 'limit.kind'));
  const accounting = parseEnum(input.accounting, ACCOUNTING_VALUES, at(path, 'accounting'));
  if (!accounting.ok) return accounting;
  const restoration = parseEnum(input.restoration, RESTORATION_VALUES, at(path, 'restoration'));
  if (!restoration.ok) return restoration;
  if (RESTORATION_FAMILY[restoration.value] !== accounting.value) return fail('RESTORATION_ACCOUNTING_MISMATCH', at(path, 'restoration'));
  let epoch: Epoch | null = null;
  if (restoration.value === 'EPOCH') {
    if (input.epoch === null) return fail('EPOCH_REQUIRED', at(path, 'epoch'));
    const ep = at(path, 'epoch');
    const es = checkFields(input.epoch, ['anchor', 'lengthSeconds'], ep);
    if (!es.ok) return es;
    const anchor = parseUnixSeconds(input.epoch.anchor, at(ep, 'anchor'));
    if (!anchor.ok) return anchor;
    const length = parseIntegerInRange(input.epoch.lengthSeconds, 0n, BigInt(UINT32_MAX), at(ep, 'lengthSeconds'));
    if (!length.ok) return length;
    if (length.value === 0n) return fail('EPOCH_INVALID', at(ep, 'lengthSeconds'));
    epoch = { anchor: anchor.value, lengthSeconds: length.value } as Epoch;
  } else if (input.epoch !== null) {
    return fail('EPOCH_FORBIDDEN', at(path, 'epoch'));
  }
  const sign = parseEnum(input.sign, SIGN_MODES, at(path, 'sign'));
  if (!sign.ok) return sign;
  if (sign.value === 'NET' && !rule.signed) return fail('NET_SIGN_REQUIRES_SIGNED_KIND', at(path, 'sign'));
  const scope = validateScope(input.scope, at(path, 'scope'));
  if (!scope.ok) return scope;
  return ok({
    kind: 'LEDGER_DIMENSION',
    dimensionId: dimensionId.value,
    limit: limit.value,
    accounting: accounting.value,
    restoration: restoration.value,
    epoch,
    sign: sign.value,
    scope: scope.value,
  } as LedgerDimensionTerm);
}

function writeEpoch(w: ByteWriter, e: Epoch): void {
  w.i64(e.anchor).u32(e.lengthSeconds);
}

function readEpochInput(r: CoreReader): EpochInput {
  const anchor = r.i64();
  const lengthSeconds = BigInt(r.u32());
  return { anchor, lengthSeconds };
}

function writeDomain(w: ByteWriter, d: DomainId): void {
  w.str(d);
}

function readString(r: CoreReader): string {
  return r.str();
}

function writeDimensionTerm(w: ByteWriter, t: LedgerDimensionTerm): void {
  w.str(t.dimensionId);
  writeQuantityBound(w, t.limit);
  writeCode(w, ACCOUNTING_CODE, t.accounting);
  writeCode(w, RESTORATION_CODE, t.restoration);
  writeNullable(w, t.epoch, writeEpoch);
  writeCode(w, SIGN_MODE_CODE, t.sign);
  writeNullable<ResourceId>(w, t.scope.asset, writeResourceId);
  writeNullable<ResourceId>(w, t.scope.market, writeResourceId);
  writeNullable(w, t.scope.domain, writeDomain);
  writeNullable<ResourceId>(w, t.scope.account, writeResourceId);
}

function readDimensionTermInput(r: CoreReader): LedgerDimensionInput {
  const dimensionId = r.str();
  const limit = readQuantityBoundInput(r);
  const accounting = readCode(r, ACCOUNTING_CODE);
  const restoration = readCode(r, RESTORATION_CODE);
  const epoch = readNullable(r, readEpochInput);
  const sign = readCode(r, SIGN_MODE_CODE);
  const asset = readNullable(r, readResourceIdInput);
  const market = readNullable(r, readResourceIdInput);
  const domain = readNullable(r, readString);
  const account = readNullable(r, readResourceIdInput);
  return { kind: 'LEDGER_DIMENSION', dimensionId, limit, accounting, restoration, epoch, sign, scope: { asset, market, domain, account } };
}

function dimensionTermInputOf(t: LedgerDimensionTerm): LedgerDimensionInput {
  const s = t.scope;
  return {
    kind: 'LEDGER_DIMENSION',
    dimensionId: t.dimensionId,
    limit: quantityBoundInputOf(t.limit),
    accounting: t.accounting,
    restoration: t.restoration,
    epoch: t.epoch === null ? null : { anchor: t.epoch.anchor, lengthSeconds: t.epoch.lengthSeconds },
    sign: t.sign,
    scope: {
      asset: s.asset === null ? null : resourceIdInputOf(s.asset),
      market: s.market === null ? null : resourceIdInputOf(s.market),
      domain: s.domain,
      account: s.account === null ? null : resourceIdInputOf(s.account),
    },
  };
}

// --- STATE_INVARIANT -------------------------------------------------------------

export interface StateInvariantInput {
  readonly kind: 'STATE_INVARIANT';
  readonly invariantId: string;
  readonly version: number;
  readonly scope: readonly ResourceIdInput[];
  readonly params: string;
}

/**
 * An `InvariantRef` (action-state-model.md §7): which invariant definition, at
 * which version, over which resources, with which parameters. The parameters
 * are opaque canonical bytes in the definition's `paramsSchema`; Core carries
 * and digests them and never interprets them.
 */
export type StateInvariantTerm = Tagged<
  {
    readonly kind: 'STATE_INVARIANT';
    readonly invariantId: InvariantId;
    readonly version: InvariantVersion;
    readonly scope: readonly ResourceId[];
    readonly params: OpaqueBytes;
  },
  'AuthorityTerm'
>;

function validateInvariantTerm(input: StateInvariantInput, path: string): CoreResult<StateInvariantTerm> {
  const shape = checkFields(input, ['kind', 'invariantId', 'version', 'scope', 'params'], path);
  if (!shape.ok) return shape;
  const invariantId = parseIdentifierAs<InvariantId>(input.invariantId, at(path, 'invariantId'));
  if (!invariantId.ok) return invariantId;
  const version = parseSmallUint(input.version, UINT32_MAX, at(path, 'version'));
  if (!version.ok) return version;
  const sp = at(path, 'scope');
  const arr = checkArray(input.scope, MAX_INVARIANT_SCOPE, sp);
  if (!arr.ok) return arr;
  const scope = validateMembers(input.scope, resourceValidator(RESOURCE_KINDS), writeResourceId, sp);
  if (!scope.ok) return scope;
  const params = parseOpaqueBytes(input.params, MAX_INVARIANT_PARAMS_BYTES, at(path, 'params'));
  if (!params.ok) return params;
  return ok({
    kind: 'STATE_INVARIANT',
    invariantId: invariantId.value,
    version: version.value as InvariantVersion,
    scope: scope.value,
    params: params.value,
  } as StateInvariantTerm);
}

function writeInvariantTerm(w: ByteWriter, t: StateInvariantTerm): void {
  w.str(t.invariantId).u32(t.version);
  writeList(w, t.scope, writeResourceId);
  writeOpaqueBytes(w, t.params);
}

function readInvariantTermInput(r: CoreReader): StateInvariantInput {
  const invariantId = r.str();
  const version = r.u32();
  const scope = r.list(MAX_INVARIANT_SCOPE, readResourceIdInput, true);
  const params = r.opaqueBytes();
  return { kind: 'STATE_INVARIANT', invariantId, version, scope, params };
}

// --- STATE_POLICY ----------------------------------------------------------------

export interface StatePolicyInput {
  readonly kind: 'STATE_POLICY';
  readonly domain: string;
  readonly stateKind: string;
  readonly admittedSources: readonly string[];
  readonly requirement: StateRequirementInput;
}

/**
 * The state policy for one `(domain, stateKind)`: which configured sources may
 * supply it, and the requirement (freshness, minimum trust and finality, and
 * what must hold at issue and at execution) it is admitted under. An empty
 * source set admits nothing.
 */
export type StatePolicyTerm = Tagged<
  {
    readonly kind: 'STATE_POLICY';
    readonly domain: DomainId;
    readonly stateKind: StateKind;
    readonly admittedSources: readonly StateSourceId[];
    readonly requirement: StateRequirement;
  },
  'AuthorityTerm'
>;

function writeSourceId(w: ByteWriter, s: string): void {
  w.str(s);
}

function validateStatePolicyTerm(input: StatePolicyInput, path: string): CoreResult<StatePolicyTerm> {
  const shape = checkFields(input, ['kind', 'domain', 'stateKind', 'admittedSources', 'requirement'], path);
  if (!shape.ok) return shape;
  const domain = parseIdentifierAs<DomainId>(input.domain, at(path, 'domain'));
  if (!domain.ok) return domain;
  const stateKind = parseIdentifierAs<StateKind>(input.stateKind, at(path, 'stateKind'));
  if (!stateKind.ok) return stateKind;
  const sp = at(path, 'admittedSources');
  const arr = checkArray(input.admittedSources, MAX_ADMITTED_SOURCES, sp);
  if (!arr.ok) return arr;
  const sources = validateMembers(input.admittedSources, (raw: string, p: string) => parseIdentifierAs<StateSourceId>(raw, p), writeSourceId, sp);
  if (!sources.ok) return sources;
  const requirement = validateStateRequirement(input.requirement, at(path, 'requirement'));
  if (!requirement.ok) return requirement;
  return ok({
    kind: 'STATE_POLICY',
    domain: domain.value,
    stateKind: stateKind.value,
    admittedSources: sources.value,
    requirement: requirement.value,
  } as StatePolicyTerm);
}

function writeStatePolicyTerm(w: ByteWriter, t: StatePolicyTerm): void {
  w.str(t.domain).str(t.stateKind);
  writeList(w, t.admittedSources, writeSourceId);
  writeStateRequirement(w, t.requirement);
}

function readStatePolicyTermInput(r: CoreReader): StatePolicyInput {
  const domain = r.str();
  const stateKind = r.str();
  const admittedSources = r.list(MAX_ADMITTED_SOURCES, readString, true);
  const requirement = readStateRequirementInput(r);
  return { kind: 'STATE_POLICY', domain, stateKind, admittedSources, requirement };
}

// --- The union -------------------------------------------------------------------

export type AuthorityTermInput =
  | SetConstraintInput
  | RightTermInput
  | PerActionBoundInput
  | TimeWindowInput
  | LedgerDimensionInput
  | StateInvariantInput
  | StatePolicyInput;

export type AuthorityTerm =
  | SetConstraintTerm
  | RightTerm
  | PerActionBoundTerm
  | TimeWindowTerm
  | LedgerDimensionTerm
  | StateInvariantTerm
  | StatePolicyTerm;

/** The three kinds a principal policy may carry: constraints that grant nothing. */
export type PrincipalPolicyTermInput = LedgerDimensionInput | StateInvariantInput | StatePolicyInput;
export type PrincipalPolicyTerm = LedgerDimensionTerm | StateInvariantTerm | StatePolicyTerm;

export function validateTerm(input: AuthorityTermInput, path: string): CoreResult<AuthorityTerm> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail('WRONG_TYPE', path);
  const kind = parseEnum(input.kind, TERM_KINDS, at(path, 'kind'));
  if (!kind.ok) return kind;
  switch (input.kind) {
    case 'SET':
      return validateSetTerm(input, path);
    case 'RIGHT':
      return validateRightTerm(input, path);
    case 'BOUND':
      return validateBoundTerm(input, path);
    case 'TIME_WINDOW':
      return validateTimeWindowTerm(input, path);
    case 'LEDGER_DIMENSION':
      return validateDimensionTerm(input, path);
    case 'STATE_INVARIANT':
      return validateInvariantTerm(input, path);
    case 'STATE_POLICY':
      return validateStatePolicyTerm(input, path);
  }
}

export function writeTerm(w: ByteWriter, t: AuthorityTerm): void {
  writeCode(w, TERM_KIND_CODE, t.kind);
  switch (t.kind) {
    case 'SET':
      writeSetTerm(w, t);
      break;
    case 'RIGHT':
      writeRightTerm(w, t);
      break;
    case 'BOUND':
      writeBoundTerm(w, t);
      break;
    case 'TIME_WINDOW':
      writeTimeWindowTerm(w, t);
      break;
    case 'LEDGER_DIMENSION':
      writeDimensionTerm(w, t);
      break;
    case 'STATE_INVARIANT':
      writeInvariantTerm(w, t);
      break;
    case 'STATE_POLICY':
      writeStatePolicyTerm(w, t);
      break;
  }
}

export function readTermInput(r: CoreReader): AuthorityTermInput {
  const kind = readCode(r, TERM_KIND_CODE);
  switch (kind) {
    case 'SET':
      return readSetTermInput(r);
    case 'RIGHT':
      return readRightTermInput(r);
    case 'BOUND':
      return readBoundTermInput(r);
    case 'TIME_WINDOW':
      return readTimeWindowTermInput(r);
    case 'LEDGER_DIMENSION':
      return readDimensionTermInput(r);
    case 'STATE_INVARIANT':
      return readInvariantTermInput(r);
    case 'STATE_POLICY':
      return readStatePolicyTermInput(r);
  }
}

export function termInputOf(t: AuthorityTerm): AuthorityTermInput {
  switch (t.kind) {
    case 'SET':
      return setTermInputOf(t);
    case 'RIGHT':
      return t.right === 'DELEGATE' ? { kind: 'RIGHT', right: 'DELEGATE', maxDepth: t.maxDepth } : { kind: 'RIGHT', right: t.right };
    case 'BOUND':
      return {
        kind: 'BOUND',
        boundId: t.boundId,
        polarity: t.polarity,
        value:
          t.value.type === 'QUANTITY'
            ? { type: 'QUANTITY', quantity: quantityBoundInputOf(t.value.quantity) }
            : { type: 'RATIO', ratio: { numerator: t.value.ratio.numerator, scale: t.value.ratio.scale } },
      };
    case 'TIME_WINDOW':
      return { kind: 'TIME_WINDOW', domain: t.domain, notBefore: t.notBefore, expiresAt: t.expiresAt };
    case 'LEDGER_DIMENSION':
      return dimensionTermInputOf(t);
    case 'STATE_INVARIANT':
      return { kind: 'STATE_INVARIANT', invariantId: t.invariantId, version: t.version, scope: t.scope.map((s) => resourceIdInputOf(s)), params: t.params };
    case 'STATE_POLICY':
      return {
        kind: 'STATE_POLICY',
        domain: t.domain,
        stateKind: t.stateKind,
        admittedSources: [...t.admittedSources],
        requirement: stateRequirementInputOf(t.requirement),
      };
  }
}

/**
 * The uniqueness key of a term within one grant or policy. Built as a JSON
 * array so identifier text containing `:` cannot make two keys collide.
 */
export function termKey(t: AuthorityTerm): string {
  switch (t.kind) {
    case 'SET':
      return JSON.stringify([t.kind, t.vocabulary]);
    case 'RIGHT':
      return JSON.stringify([t.kind, t.right]);
    case 'BOUND':
      return JSON.stringify([t.kind, t.boundId, t.polarity]);
    case 'TIME_WINDOW':
      return JSON.stringify([t.kind, t.domain]);
    case 'LEDGER_DIMENSION':
      return JSON.stringify([t.kind, t.dimensionId]);
    case 'STATE_INVARIANT':
      return JSON.stringify([t.kind, t.invariantId, t.version, t.scope.map((s) => [s.domain, s.kind, s.localId])]);
    case 'STATE_POLICY':
      return JSON.stringify([t.kind, t.domain, t.stateKind]);
  }
}

/**
 * Validate a term list, refuse duplicate keys, and put it in canonical order
 * (ascending by encoded bytes, which groups terms by kind).
 */
export function validateTermList<T extends AuthorityTerm>(
  inputs: readonly AuthorityTermInput[],
  max: number,
  path: string,
  validate: (input: AuthorityTermInput, path: string) => CoreResult<T>,
): CoreResult<readonly T[]> {
  const arr = checkArray(inputs, max, path);
  if (!arr.ok) return arr;
  const keyed: { term: T; bytes: Uint8Array; key: string; index: number }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < inputs.length; i += 1) {
    const t = validate(inputs[i] as AuthorityTermInput, at(path, i));
    if (!t.ok) return t;
    const key = termKey(t.value);
    if (seen.has(key)) return fail('DUPLICATE_TERM', at(path, i));
    seen.add(key);
    keyed.push({ term: t.value, bytes: encodeWith(writeTerm, t.value), key, index: i });
  }
  keyed.sort((a, b) => compareBytes(a.bytes, b.bytes));
  return ok(keyed.map((k) => k.term));
}
