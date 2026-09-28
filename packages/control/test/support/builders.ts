/**
 * Deterministic builders for control tests: parties and times, synthetic
 * spot-like and perp-like module configurations, grants, policies,
 * invariants, state snapshots, evaluation contexts and actions. Nothing here
 * is random at run time, reads a clock or contacts anything, and none of it
 * describes a real venue or product.
 */

import {
  actionPayloadDigest,
  authorityId,
  validateActionEnvelope,
  validateAuthorityGrant,
  validatePrincipalPolicy,
  validateStateEnvelope,
  type ActionEnvelope,
  type AdapterRefInput,
  type AuthorityGrant,
  type AuthorityTermInput,
  type LedgerDimensionInput,
  type ObservationId,
  type PartyIdInput,
  type PrincipalPolicy,
  type PrincipalPolicyTermInput,
  type ResourceIdInput,
  type StateInvariantInput,
  type TrustClass,
} from '@mandate/core';
import type { RetryPolicy } from '@mandate/ledger';
import { AGGREGATE_INVARIANT_ID, encodeAggregateParams, statePayloadDigest, type EvaluationContextInput, type SuppliedState } from '../../src/index.ts';
import { validateModuleRef, type QuantityKind } from '@mandate/core';
import { T0, address, digestOf } from '../../../ledger/test/support/basics.ts';
import {
  BTC,
  CLOSE,
  ETH,
  FEED_SOURCE,
  INSTRUMENTS,
  MARK,
  accountLeverageId,
  maxExposureId,
  OPEN,
  POSITION,
  REGISTRY_SOURCE,
  VENUE_SOURCE,
  createSyntheticModule,
  encodeMark,
  encodeOrder,
  encodePosition,
  leverageParams,
  maxExposureParams,
  type Order,
  type SyntheticConfig,
  type SyntheticModule,
} from './synthetic.ts';

export { T0, address, digestOf, prng, ticks, int, pick } from '../../../ledger/test/support/basics.ts';
export * from './synthetic.ts';

// --- Results ---------------------------------------------------------------------

export function must<T>(r: { ok: true; value: T } | { ok: false; error: object }): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error, (_, v: bigint | string) => (typeof v === 'bigint' ? v.toString() : v))}`);
  return r.value;
}

// --- Parties, time, modules ------------------------------------------------------

export const P = address('11');
export const AGENT_A = address('31');
export const AGENT_B = address('32');
export const AGENT_C = address('33');
export const T = T0 + 1_000n;
export const T_END = T0 + 90n * 86_400n;

export const PERP_CFG: SyntheticConfig = { domainId: 'synth-perp', moduleId: 'perp-like', moduleVersion: 1, markets: [{ localId: 'x:BTC-PERP', asset: BTC }] };
export const SPOT_CFG: SyntheticConfig = {
  domainId: 'synth-spot',
  moduleId: 'spot-like',
  moduleVersion: 1,
  markets: [
    { localId: 'x:BTC-SPOT', asset: BTC },
    { localId: 'x:ETH-SPOT', asset: ETH },
  ],
};

export const ADAPTER: AdapterRefInput = { adapterId: 'synthetic-signer', adapterVersion: 1, adapterDigest: digestOf('adapter:synthetic-signer:1') };
export const ONCE: RetryPolicy = { maxAttempts: 1 };
export const RETRY: RetryPolicy = { maxAttempts: 16 };

/** 100,000.00 USD per unit. */
export const PRICE = 10_000_000n;
/** Size (4 decimals) worth `usd` whole dollars at `price`. */
export function sizeFor(usd: number, price: bigint = PRICE): bigint {
  return (BigInt(usd) * 100n * 10_000n) / price;
}
export function usd(n: number): bigint {
  return BigInt(n) * 100n;
}

export function refInput(m: SyntheticModule): { domainId: string; moduleId: string; moduleVersion: number; moduleDigest: string } {
  return { domainId: m.ref.domainId, moduleId: m.ref.moduleId, moduleVersion: m.ref.moduleVersion, moduleDigest: m.ref.moduleDigest };
}

export function account(m: SyntheticModule, id = 'acct-1'): ResourceIdInput {
  return { domain: m.ref.domainId, kind: 'ACCOUNT', localId: id };
}

// --- Terms -----------------------------------------------------------------------

function distinct<T extends object>(xs: readonly T[]): T[] {
  return [...new Map(xs.map((x) => [JSON.stringify(x), x])).values()];
}

/** Everything an agent needs to be covered for synthetic open/close orders under `mods`. */
export function coverage(mods: readonly SyntheticModule[]): AuthorityTermInput[] {
  return [
    { kind: 'SET', vocabulary: 'MODULES', members: mods.map(refInput) },
    { kind: 'SET', vocabulary: 'ADAPTERS', members: [ADAPTER] },
    { kind: 'SET', vocabulary: 'ACTION_TYPES', members: distinct(mods.flatMap((m) => [OPEN, CLOSE].map((actionType) => ({ domain: m.ref.domainId, actionType })))) },
    { kind: 'SET', vocabulary: 'MARKETS', members: distinct(mods.flatMap((m) => m.config.markets.map((x) => m.market(x.localId)))) },
    { kind: 'RIGHT', right: 'OPEN_RISK' },
    { kind: 'RIGHT', right: 'REDUCE_RISK' },
  ];
}

export function capitalDim(dimensionId: string, whole: number): LedgerDimensionInput {
  return {
    kind: 'LEDGER_DIMENSION',
    dimensionId,
    limit: { kind: 'CAPITAL', unit: 'USDG', decimals: 2, atoms: usd(whole) },
    accounting: 'CAPACITY',
    restoration: 'AS_CHARGED',
    epoch: null,
    sign: 'UNSIGNED',
    scope: { asset: null, market: null, domain: null, account: null },
  };
}

export function notionalDim(dimensionId: string, whole: number): LedgerDimensionInput {
  return { ...capitalDim(dimensionId, whole), limit: { kind: 'NOTIONAL', unit: 'USD', decimals: 2, atoms: usd(whole) }, scope: { asset: BTC, market: null, domain: null, account: null } };
}

export function maxExposure(m: SyntheticModule, acct: ResourceIdInput, whole: number): StateInvariantInput {
  return { kind: 'STATE_INVARIANT', invariantId: maxExposureId(m.ref.moduleId), version: m.ref.moduleVersion, scope: [acct], params: maxExposureParams(usd(whole)) };
}

export function maxLeverage(m: SyntheticModule, acct: ResourceIdInput, numerator: bigint, scale = 0): StateInvariantInput {
  return { kind: 'STATE_INVARIANT', invariantId: accountLeverageId(m.ref.moduleId), version: m.ref.moduleVersion, scope: [acct], params: leverageParams(numerator, scale) };
}

export function aggregate(o: { whole: number; contributors: readonly SyntheticModule[]; accounts: readonly ResourceIdInput[]; kind?: QuantityKind; asset?: ResourceIdInput }): StateInvariantInput {
  return {
    kind: 'STATE_INVARIANT',
    invariantId: AGGREGATE_INVARIANT_ID,
    version: 1,
    scope: [o.asset ?? BTC, ...o.accounts],
    params: encodeAggregateParams({
      kind: o.kind ?? 'GROSS_EXPOSURE',
      unit: 'USD' as never,
      decimals: 2,
      limit: usd(o.whole),
      contributors: o.contributors.map((m) => must(validateModuleRef(refInput(m)))),
    }),
  };
}

export function policy(terms: readonly PrincipalPolicyTermInput[] = [], sequence = 1n): PrincipalPolicy {
  return must(validatePrincipalPolicy({ principal: P, sequence, terms, nonce: 0n }));
}

export interface GrantOptions {
  readonly holder?: PartyIdInput;
  readonly mods: readonly SyntheticModule[];
  readonly terms?: readonly AuthorityTermInput[];
  readonly delegate?: number;
  readonly nonce?: bigint;
  readonly expiresAt?: bigint;
}

function depthTerm(depth: number | undefined): AuthorityTermInput[] {
  return depth === undefined || depth === 0 ? [] : [{ kind: 'RIGHT', right: 'DELEGATE', maxDepth: depth }];
}

export function root(o: GrantOptions): AuthorityGrant {
  return must(
    validateAuthorityGrant({
      lineage: { kind: 'ROOT', issuer: P },
      principal: P,
      holder: o.holder ?? P,
      notBefore: T0,
      expiresAt: o.expiresAt ?? T_END,
      terms: [...coverage(o.mods), ...depthTerm(o.delegate), ...(o.terms ?? [])],
      nonce: o.nonce ?? 0n,
    }),
  );
}

export function child(parent: AuthorityGrant, o: GrantOptions): AuthorityGrant {
  return must(
    validateAuthorityGrant({
      lineage: { kind: 'DELEGATION', parent: authorityId(parent), issuer: { kind: parent.holder.kind, value: parent.holder.value } },
      principal: P,
      holder: o.holder ?? AGENT_A,
      notBefore: T0,
      expiresAt: o.expiresAt ?? parent.expiresAt,
      terms: [...coverage(o.mods), ...depthTerm(o.delegate), ...(o.terms ?? [])],
      nonce: o.nonce ?? 0n,
    }),
  );
}

// --- State -----------------------------------------------------------------------

export interface StateOptions {
  readonly observedAt?: bigint;
  readonly trustClass?: TrustClass;
  readonly sourceId?: string;
  readonly sequence?: { kind: 'NONE' } | { kind: 'BLOCK' | 'VENUE_SEQUENCE' | 'VERSION'; value: bigint };
  readonly finality?: { ladder: string; level: string };
  readonly validUntil?: bigint | null;
  /** Normalize under another module's ref (the "wrong ModuleRef" case). */
  readonly under?: SyntheticModule;
  /** Claim this payload digest instead of the payload's own. */
  readonly payloadDigest?: string;
}

function envelope(m: SyntheticModule, stateKind: string, subject: ResourceIdInput, payload: Uint8Array, o: StateOptions, defaults: { sourceId: string; trustClass: TrustClass; finality: { ladder: string; level: string }; sequence: StateOptions['sequence'] }): SuppliedState {
  const under = o.under ?? m;
  return {
    envelope: must(
      validateStateEnvelope({
        module: refInput(under),
        stateKind,
        subject,
        sourceId: o.sourceId ?? defaults.sourceId,
        trustClass: o.trustClass ?? defaults.trustClass,
        observedAt: o.observedAt ?? T,
        sequence: o.sequence ?? defaults.sequence ?? { kind: 'NONE' },
        validUntil: o.validUntil ?? null,
        finality: o.finality ?? defaults.finality,
        payloadDigest: o.payloadDigest ?? statePayloadDigest(under.ref, payload),
      }),
    ),
    payload,
  };
}

export function markState(m: SyntheticModule, localId: string, price: bigint = PRICE, o: StateOptions = {}): SuppliedState {
  const market = m.market(localId);
  return envelope(m, MARK, market, encodeMark(market, price), o, { sourceId: FEED_SOURCE, trustClass: 'VERIFIED', finality: { ladder: 'synth.feed', level: 'PUBLISHED' }, sequence: { kind: 'NONE' } });
}

export function positionState(m: SyntheticModule, acct: ResourceIdInput, positions: readonly { localId: string; size: bigint }[] = [], collateral: bigint = usd(100_000), o: StateOptions = {}): SuppliedState {
  const payload = encodePosition({ account: acct, collateral, positions: positions.map((p) => ({ market: m.market(p.localId), size: p.size })) });
  return envelope(m, POSITION, acct, payload, o, {
    sourceId: VENUE_SOURCE,
    trustClass: 'VERIFIED',
    finality: { ladder: 'synth.venue', level: 'ACKNOWLEDGED' },
    sequence: { kind: 'VENUE_SEQUENCE', value: 10n },
  });
}

export function instrumentsState(m: SyntheticModule, o: StateOptions = {}): SuppliedState {
  return envelope(m, INSTRUMENTS, { domain: m.venue.domain, kind: 'VENUE', localId: m.venue.localId }, m.instrumentsPayload, o, {
    sourceId: REGISTRY_SOURCE,
    trustClass: 'AUTHORITATIVE',
    finality: { ladder: 'synth.registry', level: 'PUBLISHED' },
    sequence: { kind: 'VERSION', value: 1n },
  });
}

/** Every mark of `m` at `price`, its instruments, and a position book for each account. */
export function marketStates(m: SyntheticModule, books: readonly { account: ResourceIdInput; positions?: readonly { localId: string; size: bigint }[]; collateral?: bigint }[], price: bigint = PRICE, o: StateOptions = {}): SuppliedState[] {
  return [
    ...m.config.markets.map((x) => markState(m, x.localId, price, o)),
    instrumentsState(m, o.observedAt === undefined ? {} : { observedAt: o.observedAt }),
    ...books.map((b) => positionState(m, b.account, b.positions ?? [], b.collateral ?? usd(100_000), o.observedAt === undefined ? {} : { observedAt: o.observedAt })),
  ];
}

export interface ContextOptions {
  readonly at?: bigint;
  /** Watermarks per account; default 0 for every listed account. */
  readonly accounts?: readonly { module: SyntheticModule; account: ResourceIdInput; watermark?: bigint }[];
  readonly sources?: EvaluationContextInput['sources'];
  readonly blockHeads?: EvaluationContextInput['blockHeads'];
}

export function context(mods: readonly SyntheticModule[], o: ContextOptions = {}): EvaluationContextInput {
  const domains = [...new Set(mods.map((m) => m.ref.domainId))];
  return {
    evaluationTime: o.at ?? T,
    sources: o.sources ?? [
      { sourceId: FEED_SOURCE, trustClass: 'VERIFIED', kinds: domains.map((domain) => ({ domain, stateKind: MARK })) },
      { sourceId: VENUE_SOURCE, trustClass: 'VERIFIED', kinds: domains.map((domain) => ({ domain, stateKind: POSITION })) },
      { sourceId: REGISTRY_SOURCE, trustClass: 'AUTHORITATIVE', kinds: domains.map((domain) => ({ domain, stateKind: INSTRUMENTS })) },
    ],
    blockHeads: o.blockHeads ?? [],
    sequenceWatermarks: (o.accounts ?? []).map((a) => ({ sourceId: VENUE_SOURCE, stateKind: POSITION, subject: a.account, sequence: a.watermark ?? 0n })),
  };
}

// --- Actions ---------------------------------------------------------------------

export interface ActionOptions {
  readonly authority: AuthorityGrant;
  readonly actor?: PartyIdInput;
  readonly market?: string;
  readonly account?: ResourceIdInput;
  readonly size: bigint;
  readonly limitPrice?: bigint;
  readonly leverage?: { numerator: bigint; scale: number };
  readonly side?: Order['side'];
  readonly nonce?: bigint;
  readonly validFrom?: bigint;
  readonly expiresAt?: bigint;
  /** Override the envelope's module ref (the payload digest follows it). */
  readonly module?: { domainId: string; moduleId: string; moduleVersion: number; moduleDigest: string };
}

export function action(m: SyntheticModule, o: ActionOptions): { envelope: ActionEnvelope; payload: Uint8Array } {
  const market = m.market(o.market ?? (m.config.markets[0] as { localId: string }).localId);
  const acct = o.account ?? account(m);
  const side = o.side ?? 'OPEN';
  const payload = encodeOrder({ side, market, account: acct, size: o.size, limitPrice: o.limitPrice ?? PRICE, leverage: o.leverage ?? { numerator: 1n, scale: 0 } });
  const moduleInput = o.module ?? refInput(m);
  const moduleRef = must(validateModuleRef(moduleInput));
  const holder = o.actor ?? { kind: o.authority.holder.kind, value: o.authority.holder.value };
  return {
    envelope: must(
      validateActionEnvelope({
        principal: P,
        authority: authorityId(o.authority),
        actor: holder,
        module: moduleInput,
        actionType: side === 'OPEN' ? OPEN : CLOSE,
        adapter: ADAPTER,
        target: market,
        resources: [acct],
        payloadDigest: must(actionPayloadDigest(moduleRef, payload)),
        validFrom: o.validFrom ?? T0,
        expiresAt: o.expiresAt ?? T_END,
        nonce: o.nonce ?? 0n,
      }),
    ),
    payload,
  };
}

/** A test-only evidence identity for the ledger's raw accounting effects (infrastructure, never an agent path). */
export function evidenceFor(label: string): ObservationId {
  return digestOf(`observation:${label}`) as ObservationId;
}

