/**
 * A deterministic offline world for PerpPolicy and the Lighter signer: the
 * policy over the reviewed testnet claims, registries, a store (in-memory or
 * the SQLite reference store), the control engine, grants, typed states and
 * actions. No network, no clock, no key.
 */

import assert from 'node:assert/strict';
import {
  actionPayloadDigest,
  authorityId,
  reservationIdFor,
  validateActionEnvelope,
  validateAdapterRef,
  validateAuthorityGrant,
  validateModuleRef,
  validatePrincipalPolicy,
  validateStateEnvelope,
  type ActionEnvelope,
  type AdapterRefInput,
  type AuthorityGrant,
  type AuthorityTermInput,
  type LedgerDimensionInput,
  type PrincipalPolicy,
  type PrincipalPolicyTermInput,
  type ResourceIdInput,
  type StateSourceId,
} from '@mandate/core';
import {
  InMemoryLedgerStore,
  ReferenceAdapterRegistry,
  ReferenceModuleRegistry,
  type AdapterStatus,
  type InMemoryStoreHooks,
  type LedgerStore,
  type ModuleStatus,
  type ReducerRules,
  type RetryPolicy,
} from '@mandate/ledger';
import { ControlEngine, ModuleCatalog, controlRules, statePayloadDigest, type AuthorizationOutcome, type AuthorizationRecord, type DomainModule, type EvaluationContextInput, type SuppliedState } from '@mandate/control';
import {
  ACTION_CANCEL_ORDER,
  ACTION_CREATE_ORDER,
  DOMAIN_ID,
  LIGHTER_TESTNET_CHAIN_ID,
  LIGHTER_TESTNET_CLAIMS,
  STATE_ACCOUNT,
  STATE_ASSET_PRICE,
  STATE_MARKET,
  accountResource,
  collateralResource,
  createPerpPolicy,
  encodeAccountBook,
  encodeAssetPrice,
  encodeCancel,
  encodeMarketStatic,
  encodeOrder,
  lighterAdapterRef,
  lighterAdapterRefInput,
  marketResource,
  type AccountBook,
  type CheckedClaim,
  type PerpCancel,
  type PerpOrder,
  type PerpPolicy,
  type PerpPolicyConfig,
} from '../../src/index.ts';
import { T0, address, digestOf } from '../../../ledger/test/support/basics.ts';

export { T0, address, digestOf };

export function must<T>(r: { ok: true; value: T } | { ok: false; error: object }): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error, (_, v: bigint | string) => (typeof v === 'bigint' ? v.toString() : v))}`);
  return r.value;
}

export const P = address('11');
export const AGENT = address('31');
export const T = T0 + 1_000n;
export const T_END = T0 + 90n * 86_400n;
export const ONCE: RetryPolicy = { maxAttempts: 1 };
export const RETRY: RetryPolicy = { maxAttempts: 32 };

export const CHAIN = LIGHTER_TESTNET_CHAIN_ID;
export const SUB_ACCOUNT = 281_474_976_710_700n;
export const API_KEY_INDEX = 5;
export const MARKET_SOURCE = 'lighter.api' as StateSourceId;
export const PRICE_SOURCE = 'synth.feed' as StateSourceId;

export const CONFIG: PerpPolicyConfig = {
  chainId: CHAIN,
  claims: LIGHTER_TESTNET_CLAIMS,
  // The canonical-asset price source is shared with any spot module valued at the same observation (7D.1 R1).
  sources: { market: MARKET_SOURCE, assetPrice: PRICE_SOURCE, account: MARKET_SOURCE },
  maxAge: { assetPrice: 30n, account: 15n, market: 86_400n },
  lifetimeSeconds: 3_600n,
};

export const ADAPTER = lighterAdapterRefInput({ chainId: CHAIN });
export const ACCOUNT: ResourceIdInput = accountResource(CHAIN, SUB_ACCOUNT);
export const BTC_MARKET: ResourceIdInput = marketResource(CHAIN, 4096);
export const ETH_MARKET: ResourceIdInput = marketResource(CHAIN, 4095);
export const COLLATERAL = collateralResource(CHAIN);
/** 83,625.0 USD per BTC at Lighter's 1 price decimal; 83,625.00 at the 2-decimal asset valuation. */
export const BTC_PRICE_LIGHTER = 836_250n;
export const BTC_PRICE_USD = 8_362_500n;
export const ETH_PRICE_USD = 269_100n;
export const SOL_PRICE_USD = 11_891n;

export interface PerpWorld {
  readonly policy: PerpPolicy;
  readonly modules: readonly DomainModule[];
  readonly registry: ReferenceModuleRegistry;
  readonly adapters: ReferenceAdapterRegistry;
  readonly catalog: ModuleCatalog;
  readonly store: LedgerStore;
  readonly engine: ControlEngine;
}

export interface WorldOptions {
  readonly extra?: readonly DomainModule[];
  readonly moduleStatus?: ModuleStatus;
  readonly adapterStatus?: AdapterStatus;
  readonly store?: LedgerStore;
  /** Build the store with this world's reducer rules (e.g. the SQLite reference store). */
  readonly storeOf?: (rules: ReducerRules) => LedgerStore;
  readonly hooks?: InMemoryStoreHooks;
  readonly policy?: PerpPolicy;
  /** Other adapters the registry knows, as ACTIVE (the cross-domain tests' spot adapter). */
  readonly extraAdapters?: readonly AdapterRefInput[];
}

export function perpWorld(o: WorldOptions = {}): PerpWorld {
  const policy = o.policy ?? createPerpPolicy(CONFIG);
  const modules: DomainModule[] = [policy, ...(o.extra ?? [])];
  const registry = must(ReferenceModuleRegistry.create(modules.map((m) => ({ module: m.ref, status: m === policy ? (o.moduleStatus ?? 'ACTIVE') : 'ACTIVE', implementations: [m.implementation] }))));
  const adapters = must(ReferenceAdapterRegistry.create([{ adapter: lighterAdapterRef({ chainId: CHAIN }), status: o.adapterStatus ?? 'ACTIVE' }, ...(o.extraAdapters ?? []).map((a) => ({ adapter: must(validateAdapterRef(a)), status: 'ACTIVE' as const }))]));
  const catalog = must(ModuleCatalog.create(registry, modules.map((module) => ({ module, corpus: [] }))));
  const store = o.store ?? o.storeOf?.(controlRules(catalog)) ?? new InMemoryLedgerStore(o.hooks ?? {}, controlRules(catalog));
  return { policy, modules, registry, adapters, catalog, store, engine: new ControlEngine({ store, registry, catalog, adapters }) };
}

// --- Terms ----------------------------------------------------------------------------

export function coverage(w: PerpWorld, markets: readonly ResourceIdInput[] = [BTC_MARKET, ETH_MARKET], extra: readonly DomainModule[] = [], actionTypes: readonly { domain: string; actionType: string }[] = [], adapters: readonly AdapterRefInput[] = []): AuthorityTermInput[] {
  const ref = w.policy.ref;
  return [
    { kind: 'SET', vocabulary: 'MODULES', members: [{ domainId: ref.domainId, moduleId: ref.moduleId, moduleVersion: ref.moduleVersion, moduleDigest: ref.moduleDigest }, ...extra.map((m) => ({ domainId: m.ref.domainId, moduleId: m.ref.moduleId, moduleVersion: m.ref.moduleVersion, moduleDigest: m.ref.moduleDigest }))] },
    { kind: 'SET', vocabulary: 'ADAPTERS', members: [ADAPTER, ...adapters] },
    { kind: 'SET', vocabulary: 'ACTION_TYPES', members: [{ domain: DOMAIN_ID, actionType: ACTION_CREATE_ORDER }, { domain: DOMAIN_ID, actionType: ACTION_CANCEL_ORDER }, ...actionTypes] },
    { kind: 'SET', vocabulary: 'MARKETS', members: [...markets] },
    { kind: 'RIGHT', right: 'OPEN_RISK' },
    { kind: 'RIGHT', right: 'REDUCE_RISK' },
  ];
}

function capacity(dimensionId: string, limit: LedgerDimensionInput['limit'], scope: Partial<LedgerDimensionInput['scope']> = {}): LedgerDimensionInput {
  return { kind: 'LEDGER_DIMENSION', dimensionId, limit, accounting: 'CAPACITY', restoration: 'AS_CHARGED', epoch: null, sign: 'UNSIGNED', scope: { asset: null, market: null, domain: null, account: null, ...scope } };
}

/** BTC position size, in BTC at 5 decimals. */
export const btcSizeDim = (btc5: bigint): LedgerDimensionInput => ({ ...capacity('btc-size', { kind: 'POSITION_SIZE', unit: 'UNIT', decimals: 5, atoms: btc5 }, { asset: BTC_ASSET }), restoration: 'UNITS' });
/** Committed BTC notional, USDC at 6 decimals. */
export const btcNotionalDim = (usdc6: bigint): LedgerDimensionInput => capacity('btc-notional', { kind: 'NOTIONAL', unit: 'USDC', decimals: 6, atoms: usdc6 }, { asset: BTC_ASSET });
/** Margin committed on the sub-account, USDC at 6 decimals. */
export const marginDim = (usdc6: bigint): LedgerDimensionInput => capacity('margin', { kind: 'MARGIN', unit: 'USDC', decimals: 6, atoms: usdc6 }, { account: ACCOUNT });

export const BTC_ASSET: ResourceIdInput = { domain: 'registry', kind: 'CANONICAL_ASSET', localId: 'crypto:btc' };

export function policy(terms: readonly PrincipalPolicyTermInput[] = []): PrincipalPolicy {
  return must(validatePrincipalPolicy({ principal: P, sequence: 1n, terms, nonce: 0n }));
}

export function root(w: PerpWorld, terms: readonly AuthorityTermInput[] = [], o: { extra?: readonly DomainModule[]; delegate?: number; markets?: readonly ResourceIdInput[]; actionTypes?: readonly { domain: string; actionType: string }[]; adapters?: readonly AdapterRefInput[] } = {}): AuthorityGrant {
  return must(
    validateAuthorityGrant({
      lineage: { kind: 'ROOT', issuer: P },
      principal: P,
      holder: o.delegate === undefined ? AGENT : P,
      notBefore: T0,
      expiresAt: T_END,
      terms: [...coverage(w, [BTC_MARKET, ETH_MARKET, ...(o.markets ?? [])], o.extra ?? [], o.actionTypes ?? [], o.adapters ?? []), ...(o.delegate === undefined ? [] : [{ kind: 'RIGHT' as const, right: 'DELEGATE' as const, maxDepth: o.delegate }]), ...terms],
      nonce: 0n,
    }),
  );
}

export async function setup(w: PerpWorld, p: PrincipalPolicy, grants: readonly AuthorityGrant[]): Promise<void> {
  const r = await w.engine.registerPolicy(p, T0, ONCE);
  if (r.status !== 'REGISTERED') assert.fail(`policy: ${r.refusal.code}/${r.refusal.reason}`);
  for (const g of grants) {
    const x = await w.engine.registerDelegation(g, T0, ONCE);
    if (x.status !== 'REGISTERED') assert.fail(`grant: ${x.refusal.code}/${x.refusal.reason} at ${x.refusal.path}`);
  }
}

// --- State ----------------------------------------------------------------------------

function envelope(w: PerpWorld, stateKind: string, subject: ResourceIdInput, payload: Uint8Array, sourceId: string, finality: { ladder: string; level: string }, observedAt: bigint): SuppliedState {
  const ref = w.policy.ref;
  return {
    envelope: must(
      validateStateEnvelope({
        module: { domainId: ref.domainId, moduleId: ref.moduleId, moduleVersion: ref.moduleVersion, moduleDigest: ref.moduleDigest },
        stateKind,
        subject,
        sourceId,
        trustClass: 'VERIFIED',
        observedAt,
        sequence: { kind: 'NONE' },
        validUntil: null,
        finality,
        payloadDigest: statePayloadDigest(ref, payload),
      }),
    ),
    payload,
  };
}

export function marketState(w: PerpWorld, c: CheckedClaim, observedAt = T): SuppliedState {
  return envelope(w, STATE_MARKET, marketResource(CHAIN, c.static.marketIndex), encodeMarketStatic(c.static), MARKET_SOURCE, { ladder: 'lighter.state', level: 'SEQUENCED' }, observedAt);
}

export function priceState(w: PerpWorld, asset: ResourceIdInput, price: bigint, observedAt = T): SuppliedState {
  return envelope(w, STATE_ASSET_PRICE, asset, encodeAssetPrice(asset, price), PRICE_SOURCE, { ladder: 'perp.price', level: 'PUBLISHED' }, observedAt);
}

export function accountState(w: PerpWorld, book: Partial<AccountBook> = {}, observedAt = T): SuppliedState {
  const full: AccountBook = {
    account: ACCOUNT,
    collateral: 10_000_000_000n,
    availableBalance: 10_000_000_000n,
    positions: [{ marketIndex: 4096, size: 0n, marginMode: 'ISOLATED', initialMarginFraction: 500, allocatedMargin: 0n }],
    openOrders: [],
    ...book,
  };
  return envelope(w, STATE_ACCOUNT, full.account, encodeAccountBook(full), MARKET_SOURCE, { ladder: 'lighter.state', level: 'SEQUENCED' }, observedAt);
}

/** Every market, every price and the account book: what a decision under this policy reads. */
export function states(w: PerpWorld, o: { book?: Partial<AccountBook>; btc?: bigint; at?: bigint } = {}): SuppliedState[] {
  const at = o.at ?? T;
  const [btc, eth, sol] = w.policy.claims.map((c) => c.asset);
  return [
    ...w.policy.claims.map((c) => marketState(w, c, at)),
    priceState(w, btc as ResourceIdInput, o.btc ?? BTC_PRICE_USD, at),
    priceState(w, eth as ResourceIdInput, ETH_PRICE_USD, at),
    priceState(w, sol as ResourceIdInput, SOL_PRICE_USD, at),
    accountState(w, o.book ?? {}, at),
  ];
}

export function context(at: bigint = T, extraSources: EvaluationContextInput['sources'] = []): EvaluationContextInput {
  return {
    evaluationTime: at,
    sources: [
      { sourceId: MARKET_SOURCE, trustClass: 'VERIFIED', kinds: [{ domain: DOMAIN_ID, stateKind: STATE_MARKET }, { domain: DOMAIN_ID, stateKind: STATE_ACCOUNT }] },
      { sourceId: PRICE_SOURCE, trustClass: 'VERIFIED', kinds: [{ domain: DOMAIN_ID, stateKind: STATE_ASSET_PRICE }] },
      ...extraSources,
    ],
    blockHeads: [],
    sequenceWatermarks: [],
  };
}

// --- Actions ----------------------------------------------------------------------------

export function order(w: PerpWorld, authority: AuthorityGrant, o: Partial<PerpOrder> & { nonce?: bigint; validFrom?: bigint; expiresAt?: bigint } = {}): { envelope: ActionEnvelope; payload: Uint8Array } {
  const body: PerpOrder = { account: ACCOUNT, market: BTC_MARKET, side: 'BUY', baseAmount: 100n, price: BTC_PRICE_LIGHTER, execution: 'LIMIT_IOC', reduceOnly: false, orderExpiryMs: 0n, ...o };
  return actionOf(w, authority, ACTION_CREATE_ORDER, body.market, encodeOrder(body), o);
}

export function cancel(w: PerpWorld, authority: AuthorityGrant, c: Partial<PerpCancel> & { target: PerpCancel['target']; nonce?: bigint; validFrom?: bigint }): { envelope: ActionEnvelope; payload: Uint8Array } {
  const body: PerpCancel = { account: ACCOUNT, market: BTC_MARKET, ...c };
  return actionOf(w, authority, ACTION_CANCEL_ORDER, body.market, encodeCancel(body), c);
}

function actionOf(w: PerpWorld, authority: AuthorityGrant, actionType: string, market: ResourceIdInput, payload: Uint8Array, o: { nonce?: bigint; validFrom?: bigint; expiresAt?: bigint }): { envelope: ActionEnvelope; payload: Uint8Array } {
  const ref = w.policy.ref;
  const moduleInput = { domainId: ref.domainId, moduleId: ref.moduleId, moduleVersion: ref.moduleVersion, moduleDigest: ref.moduleDigest };
  return {
    envelope: must(
      validateActionEnvelope({
        principal: P,
        authority: authorityId(authority),
        actor: { kind: authority.holder.kind, value: authority.holder.value },
        module: moduleInput,
        actionType,
        adapter: ADAPTER,
        target: market,
        resources: [ACCOUNT],
        payloadDigest: must(actionPayloadDigest(must(validateModuleRef(moduleInput)), payload)),
        validFrom: o.validFrom ?? T0,
        expiresAt: o.expiresAt ?? T_END,
        nonce: o.nonce ?? 0n,
      }),
    ),
    payload,
  };
}

export function request(a: { envelope: ActionEnvelope; payload: Uint8Array }, s: readonly SuppliedState[], ctx: EvaluationContextInput = context()) {
  return { action: a.envelope, payload: a.payload, generation: 1n, states: s, context: ctx };
}

export function authorized(o: AuthorizationOutcome): AuthorizationRecord {
  if (o.status !== 'AUTHORIZED') assert.fail(`expected AUTHORIZED, got ${o.status} ${o.refusal.code}/${o.refusal.reason} at ${o.refusal.path}`);
  return o.authorization;
}

export function refusedWith(o: AuthorizationOutcome): { code: string; reason: string } {
  if (o.status !== 'REFUSED') assert.fail(`expected REFUSED, got ${o.status}`);
  return { code: o.refusal.code, reason: o.refusal.reason };
}

export { reservationIdFor, COLLATERAL as COLLATERAL_ASSET };
