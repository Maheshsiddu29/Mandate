/**
 * FIXTURE domains: swap, NFT and yield (portfolio-mandate.md §15).
 *
 * **Labelled FIXTURE. No live venue, contract or market stands behind any
 * of these.** They exist so the portfolio layer can be demonstrated across
 * five markets without pretending five live integrations exist. What is real
 * is the path: each fixture domain is an ordinary Core `DomainModule`
 * registered in the ordinary module registry, reserved through the unchanged
 * control engine, charged by the ordinary ledger, and issued behind the
 * ordinary `ADMIT_ATTEMPT`.
 *
 * One parameterised implementation serves the three domains. Its meaning is
 * a **reviewed catalog**: every instrument a reviewer has seen — including
 * known impostors, recorded with their true identity — with its chain,
 * canonical asset, issuer and the venues that trade it; the swap router's
 * reviewed pools; the recipients the fixture venue settles to. The catalog
 * is part of the module's digest (DOM-2), so a different catalog is a
 * different module.
 *
 * Identity is exact: a router, a collection contract, a vault is its
 * identifier, never a display name. Whether an agent may use one is the
 * portfolio scope's question (`permits`); the module independently refuses
 * anything its catalog has not reviewed.
 */

import { ByteWriter, type CanonicalAssetId, type Identifier } from '@mandate/kernel';
import {
  CoreReader,
  keccakDigest,
  validateModuleRef,
  validateResourceId,
  validateQuantity,
  validateStateEnvelope,
  validateStateRequirement,
  writeDigest,
  type ActionId,
  type AdapterRefInput,
  type AuthorityTermInput,
  type CoreResult,
  type Digest32,
  type DomainId,
  type FinalityLadderId,
  type FinalityLevel,
  type ImplementationDigest,
  type MarketId,
  type ModuleRef,
  type ModuleRefInput,
  type ResourceId,
  type ResourceIdInput,
  type StateId,
  type StateInvariantTerm,
  type StateKind,
  type StateRequirement,
  type StateSourceId,
  type UnitCode,
} from '@mandate/core';
import type { InvariantNarrowing } from '@mandate/ledger';
import {
  moduleFail,
  statePayloadDigest,
  type ActionAnalysis,
  type ActionContext,
  type AdmittedState,
  type DomainModule,
  type EconomicFact,
  type InvariantEvaluation,
  type LedgerDemand,
  type ModuleProjection,
  type ModuleResult,
  type ModuleScope,
  type StateNeed,
  type StateSourceConfigInput,
  type SuppliedState,
} from '@mandate/control';
import type { ResolvedAction } from '../authority.ts';
import { EvidenceClass, type CoreAction, type CoreCoverage, type DomainBinding, type Resolution, type ResolveContext } from '../binding.ts';
import type { ActionCandidate } from '../candidate.ts';
import { reason, type Reason } from '../reasons.ts';
import { demandOf } from '../resources.ts';
import { assetKey, type ActionKind, type AuthorityScope } from '../scope.ts';

export const FIXTURE_MODULE_VERSION = 1;
export const STATE_INSTRUMENT = 'fixture.instrument' as StateKind;
export const FIXTURE_LADDER = { ladder: 'fixture.catalog' as FinalityLadderId, levels: ['REVIEWED'] as FinalityLevel[] };
export const FIXTURE_ARTIFACT_KIND = 'portfolio.fixture-execution';

/** Worst-case assumptions bound into the module digest (PROJ-1). */
export const FIXTURE_ASSUMPTIONS = ['fixture.no-live-venue', 'fixture.committed-amount-is-worst-case', 'fixture.pending-full-amount', 'fixture.nothing-consumed-before-reconciliation'] as const;

/** One instrument a reviewer has seen, with its true identity. Impostors are recorded too: that is how they are refused by name. */
export interface FixtureInstrument {
  /** The exact identity: a token, collection contract or vault. */
  readonly instrument: Identifier;
  readonly chain: Identifier;
  readonly asset: CanonicalAssetId;
  /** The same canonical asset as a Core resource: what a `NOTIONAL` demand is scoped to. */
  readonly coreAsset: ResourceIdInput;
  readonly issuer: Identifier | null;
  readonly synthetic: boolean;
  /** Venues that trade it. A swap router, a marketplace, a vault's own protocol. */
  readonly venues: readonly Identifier[];
  /** Display text a reviewer recorded. No decision reads it. */
  readonly displayName: Identifier;
}

export interface FixtureDomainConfig {
  readonly domain: DomainId;
  readonly kind: Extract<ActionKind, 'SWAP_EXACT_IN' | 'NFT_BUY' | 'YIELD_DEPOSIT'>;
  readonly actionType: Identifier;
  /** The one funding token this domain spends: a swap's `tokenIn` must be exactly it. */
  readonly fundingToken: Identifier;
  readonly settlementUnit: UnitCode;
  readonly settlementDecimals: number;
  readonly instruments: readonly FixtureInstrument[];
  /** Reviewed swap pools, each under the router that routes through it. Empty for other kinds. */
  readonly pools: readonly { readonly router: Identifier; readonly pool: Identifier }[];
  /** Recipients the fixture venue settles to: the principal's own accounts. */
  readonly recipients: readonly Identifier[];
  readonly source: StateSourceId;
  readonly maxAgeSeconds: bigint;
  readonly lifetimeSeconds: bigint;
  /** Display identifier for receipts: which fixture this is. */
  readonly integration: Identifier;
}

// --- Canonical bytes ------------------------------------------------------------------------

export interface FixtureAction {
  /** The child execution authorization this action carries out: the payload names it. */
  readonly child: Digest32;
  readonly instrument: string;
  readonly venue: string;
  readonly route: readonly string[];
  readonly recipient: string;
  /** In settlement-unit atoms: the most the artifact may spend. */
  readonly notional: bigint;
}

const ACTION_TAG = 'mandate-portfolio/fixture-action';
const INSTRUMENT_TAG = 'mandate-portfolio/fixture-instrument';

export function encodeFixtureAction(a: FixtureAction): Uint8Array {
  const w = new ByteWriter().str(ACTION_TAG).u16(1);
  writeDigest(w, a.child);
  w.str(a.instrument).str(a.venue).u16(a.route.length);
  for (const hop of a.route) w.str(hop);
  w.str(a.recipient).u256(a.notional);
  return w.finish();
}

/** A reader failure of any kind is a malformed payload, never an exception. */
function decodeWith<T>(bytes: Uint8Array, read: (r: CoreReader) => T): T | null {
  const r = new CoreReader(bytes);
  try {
    const v = read(r);
    r.finish();
    return v;
  } catch {
    return null;
  }
}

export function decodeFixtureAction(bytes: Uint8Array): FixtureAction | null {
  return decodeWith(bytes, (r) => {
    if (r.str() !== ACTION_TAG || r.u16() !== 1) throw new Error('tag');
    const child = r.digest() as Digest32;
    const instrument = r.str();
    const venue = r.str();
    const route = r.list(8, (x) => x.str(), false);
    const recipient = r.str();
    const notional = r.u256();
    return { child, instrument, venue, route, recipient, notional };
  });
}

export function encodeFixtureInstrument(i: FixtureInstrument): Uint8Array {
  const w = new ByteWriter().str(INSTRUMENT_TAG).u16(1);
  w.str(i.instrument).str(i.chain).str(i.asset.assetClass).str(i.asset.idScheme).str(i.asset.value);
  w.str(i.coreAsset.domain).str(i.coreAsset.kind).str(i.coreAsset.localId);
  w.u8(i.issuer === null ? 0 : 1);
  if (i.issuer !== null) w.str(i.issuer);
  w.u8(i.synthetic ? 1 : 0).u16(i.venues.length);
  for (const v of [...i.venues].sort()) w.str(v);
  w.str(i.displayName);
  return w.finish();
}

// --- Identity ---------------------------------------------------------------------------------

function sorted<T>(xs: readonly T[], key: (x: T) => string): T[] {
  return [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

function checkConfig(c: FixtureDomainConfig): void {
  const seen = new Set<string>();
  for (const i of c.instruments) {
    if (seen.has(i.instrument)) throw new Error(`instrument ${i.instrument} reviewed twice`);
    seen.add(i.instrument);
    if (i.venues.length === 0) throw new Error(`instrument ${i.instrument} has no venue`);
    if (i.coreAsset.kind !== 'CANONICAL_ASSET') throw new Error(`instrument ${i.instrument}: core asset is not canonical`);
  }
  if (c.instruments.length === 0) throw new Error('no reviewed instrument');
  if (c.kind !== 'SWAP_EXACT_IN' && c.pools.length > 0) throw new Error('pools are a swap concept');
}

export function fixtureManifest(c: FixtureDomainConfig): Uint8Array {
  checkConfig(c);
  const w = new ByteWriter().str('mandate-portfolio/fixture-manifest').u16(1);
  w.str(c.domain).str(c.kind).str(c.actionType).u32(FIXTURE_MODULE_VERSION).str(c.fundingToken).str(c.settlementUnit).u8(c.settlementDecimals);
  const instruments = sorted(c.instruments, (i) => i.instrument);
  w.u16(instruments.length);
  for (const i of instruments) writeDigest(w, keccakDigest(encodeFixtureInstrument(i)));
  const pools = sorted(c.pools, (p) => `${p.router} ${p.pool}`);
  w.u16(pools.length);
  for (const p of pools) w.str(p.router).str(p.pool);
  const recipients = [...c.recipients].sort();
  w.u16(recipients.length);
  for (const r of recipients) w.str(r);
  w.str(c.source).u64(c.maxAgeSeconds).u64(c.lifetimeSeconds);
  for (const a of FIXTURE_ASSUMPTIONS) w.str(a);
  w.str('evidence:FIXTURE');
  return w.finish();
}

export function fixtureModuleRef(c: FixtureDomainConfig): ModuleRefInput {
  return { domainId: c.domain, moduleId: 'fixture', moduleVersion: FIXTURE_MODULE_VERSION, moduleDigest: keccakDigest(fixtureManifest(c)) };
}

export function fixtureAdapterRefInput(c: FixtureDomainConfig): AdapterRefInput {
  const w = new ByteWriter().str('mandate-portfolio/fixture-adapter-manifest').u16(1);
  w.str(c.domain).str(`artifact:${FIXTURE_ARTIFACT_KIND}`).str('slot:none').str('submission:simulated').str('evidence:FIXTURE');
  writeDigest(w, keccakDigest(fixtureManifest(c)));
  return { adapterId: `${c.domain}-signer`, adapterVersion: 1, adapterDigest: keccakDigest(w.finish()) };
}

function must<T>(r: { ok: true; value: T } | { ok: false; error: { code: string; path: string } }): T {
  if (!r.ok) throw new Error(`fixture constant invalid: ${r.error.code} at ${r.error.path}`);
  return r.value;
}

export function marketOf(c: FixtureDomainConfig, instrument: string): ResourceIdInput {
  return { domain: c.domain, kind: 'MARKET', localId: instrument };
}

// --- The module ---------------------------------------------------------------------------------

export interface FixtureModule extends DomainModule {
  readonly config: FixtureDomainConfig;
  instrumentFor(instrument: string): FixtureInstrument | null;
}

export function createFixtureModule(c: FixtureDomainConfig): FixtureModule {
  checkConfig(c);
  const ref: ModuleRef = must(validateModuleRef(fixtureModuleRef(c)));
  const implementation = keccakDigest<ImplementationDigest>(new TextEncoder().encode(`mandate-portfolio/fixture/implementation/v1:${ref.moduleDigest}`));
  const instrumentFor = (id: string): FixtureInstrument | null => c.instruments.find((i) => i.instrument === id) ?? null;
  const byMarket = (m: ResourceId): FixtureInstrument | null => (m.domain === c.domain && m.kind === 'MARKET' ? instrumentFor(m.localId) : null);
  const need = (i: FixtureInstrument): StateNeed => ({
    stateKind: STATE_INSTRUMENT,
    subject: must(validateMarket(c, i.instrument)),
    admittedSources: [c.source],
    requirement: must(
      validateStateRequirement(
        {
          // Pinned to the reviewed record: a catalog that reports another issuer, asset or venue set is not this instrument.
          freshness: { kind: 'VERSION', pinnedDigest: statePayloadDigest(ref, encodeFixtureInstrument(i)), maxAgeSeconds: c.maxAgeSeconds },
          minTrust: 'VERIFIED',
          minFinality: { ladder: FIXTURE_LADDER.ladder, level: 'REVIEWED' },
          atIssue: 'RECHECK',
          atExecution: { kind: 'ENFORCED_BY_ARTIFACT', field: 'instrument' },
        },
        'requirement',
      ),
    ) as StateRequirement,
  });

  function analyse(ctx: ActionContext): ModuleResult<{ action: FixtureAction; instrument: FixtureInstrument }> {
    const action = decodeFixtureAction(ctx.payload);
    if (action === null) return moduleFail('PAYLOAD_MALFORMED', 'payload');
    if (ctx.envelope.actionType !== c.actionType) return moduleFail('ACTION_TYPE_MISMATCH', 'actionType');
    const instrument = instrumentFor(action.instrument);
    if (instrument === null) return moduleFail('INSTRUMENT_NOT_REVIEWED', 'instrument');
    if (!instrument.venues.includes(action.venue as Identifier)) return moduleFail('VENUE_NOT_REVIEWED', 'venue');
    for (const hop of action.route) if (!c.pools.some((p) => p.router === action.venue && p.pool === hop)) return moduleFail('ROUTE_NOT_REVIEWED', 'route');
    if (!c.recipients.includes(action.recipient as Identifier)) return moduleFail('RECIPIENT_NOT_SERVED', 'recipient');
    if (action.notional <= 0n || action.notional >= 1n << 128n) return moduleFail('AMOUNT_OUT_OF_RANGE', 'notional');
    return { ok: true, value: { action, instrument } };
  }

  const notional = (i: FixtureInstrument, atoms: bigint, action: ActionId, observedAt: bigint) =>
    must(
      validateQuantity({
        kind: 'NOTIONAL',
        unit: c.settlementUnit,
        decimals: c.settlementDecimals,
        atoms,
        asset: i.coreAsset,
        // The committed amount is its own worst case: one settlement unit per unit committed.
        valuation: { price: { numeratorUnit: c.settlementUnit, denominatorUnit: 'UNIT', decimals: c.settlementDecimals, atoms: 10n ** BigInt(c.settlementDecimals) }, basis: 'LIMIT', source: { kind: 'ACTION', actionId: action }, observedAt },
      }),
    );

  const module: FixtureModule = {
    ref,
    implementation,
    config: c,
    instrumentFor,
    invariants: [],
    finalityLadders: [FIXTURE_LADDER],
    demandMeasures: [{ kind: 'NOTIONAL', unit: c.settlementUnit }],

    validateAction(ctx: ActionContext): ModuleResult<ActionAnalysis> {
      const a = analyse(ctx);
      if (!a.ok) return a;
      const { action } = a.value;
      return {
        ok: true,
        value: {
          target: must(validateMarket(c, action.instrument)),
          resources: coreResources(c, action),
          riskDirection: 'INCREASING',
          requiredRights: ['OPEN_RISK'],
          bounds: [],
          validUntil: ctx.envelope.validFrom + c.lifetimeSeconds,
        },
      };
    },

    stateRequirements(scope: ModuleScope): ModuleResult<readonly StateNeed[]> {
      const touched = new Map<string, FixtureInstrument>();
      if (scope.action !== null) {
        const a = analyse(scope.action);
        if (!a.ok) return a;
        touched.set(a.value.instrument.instrument, a.value.instrument);
      }
      for (const f of scope.reservations) {
        for (const e of f.effects) {
          if (e.market === null) continue;
          const i = byMarket(e.market);
          if (i === null) return moduleFail('PENDING_INSTRUMENT_NOT_REVIEWED');
          touched.set(i.instrument, i);
        }
      }
      return { ok: true, value: [...touched.keys()].sort().map((k) => need(touched.get(k) as FixtureInstrument)) };
    },

    validateStatePayload(state: AdmittedState): ModuleResult<true> {
      if (state.envelope.stateKind !== STATE_INSTRUMENT) return moduleFail('STATE_KIND_UNKNOWN');
      const i = byMarket(state.envelope.subject);
      if (i === null) return moduleFail('INSTRUMENT_NOT_REVIEWED');
      const expected = encodeFixtureInstrument(i);
      const same = expected.length === state.payload.length && expected.every((b, k) => b === state.payload[k]);
      return same ? { ok: true, value: true } : moduleFail('INSTRUMENT_PAYLOAD_INVALID');
    },

    project(scope: ModuleScope, states: readonly AdmittedState[]): ModuleResult<ModuleProjection> {
      const stateOf = new Map<string, StateId>();
      for (const s of states) stateOf.set(s.envelope.subject.localId, s.stateId);
      const facts: EconomicFact[] = [];
      const resources = new Map<string, ResourceId>();
      // PENDING: every unresolved reservation in full; nothing is credited until reconciliation.
      for (const f of scope.reservations) {
        for (const e of f.effects) {
          if (e.quantity.kind !== 'NOTIONAL') continue;
          const remaining = e.quantity.atoms - e.consumed;
          if (remaining <= 0n) continue;
          const quantity = must(validateQuantity({ kind: 'NOTIONAL', unit: e.quantity.unit, decimals: e.quantity.decimals, atoms: remaining, asset: e.quantity.asset, valuation: e.quantity.valuation }));
          facts.push({ component: 'PENDING', quantity, market: e.market, account: null, states: [], reservations: [f.reservation] });
          if (e.market !== null) resources.set(e.market.localId, e.market);
        }
      }
      const payload = new ByteWriter().str('mandate-portfolio/fixture-projection');
      if (scope.action !== null) {
        const a = analyse(scope.action);
        if (!a.ok) return a;
        const { action, instrument } = a.value;
        const state = stateOf.get(instrument.instrument);
        if (state === undefined) return moduleFail('INSTRUMENT_STATE_MISSING');
        const market: MarketId = must(validateMarket(c, instrument.instrument));
        resources.set(market.localId, market);
        payload.str(instrument.instrument).u256(action.notional);
        if (scope.action.mode === 'PROPOSE') {
          facts.push({ component: 'PROPOSED', quantity: notional(instrument, action.notional, scope.action.actionId, scope.action.envelope.validFrom), market, account: null, states: [state], reservations: [] });
        }
      }
      const keys = [...resources.keys()].sort();
      return { ok: true, value: { facts, invariantFacts: [], resources: keys.map((k) => resources.get(k) as ResourceId), assumptions: [...FIXTURE_ASSUMPTIONS], payload: payload.finish() } };
    },

    evaluateInvariant(_term: StateInvariantTerm, _projection: ModuleProjection): ModuleResult<InvariantEvaluation> {
      // A fixture owns no state invariant: its authority is the ledger's notional dimensions.
      return moduleFail('INVARIANT_UNKNOWN');
    },

    deriveLedgerDemands(ctx: ActionContext, _projection: ModuleProjection): ModuleResult<readonly LedgerDemand[]> {
      const a = analyse(ctx);
      if (!a.ok) return a;
      const { action, instrument } = a.value;
      // Required: a fixture spend under a lineage that grants no notional dimension refuses rather than running unbudgeted.
      return { ok: true, value: [{ quantity: notional(instrument, action.notional, ctx.actionId, ctx.envelope.validFrom), market: must(validateMarket(c, instrument.instrument)), account: null, required: true }] };
    },

    noWeaker(_parent: StateInvariantTerm, _child: StateInvariantTerm): ModuleResult<InvariantNarrowing> {
      return { ok: true, value: 'UNPROVABLE' };
    },
  };
  return module;
}

function validateMarket(c: FixtureDomainConfig, instrument: string): CoreResult<MarketId> {
  return validateResourceId(marketOf(c, instrument), ['MARKET'] as const, 'market');
}

function coreResources(c: FixtureDomainConfig, a: FixtureAction): ResourceId[] {
  const out = new Map<string, ResourceIdInput>();
  out.set(`v ${a.venue}`, { domain: c.domain, kind: 'VENUE', localId: a.venue });
  for (const hop of a.route) out.set(`v ${hop}`, { domain: c.domain, kind: 'VENUE', localId: hop });
  out.set(`r ${a.recipient}`, { domain: c.domain, kind: 'RECIPIENT', localId: a.recipient });
  return [...out.values()].map((r) => must(validateResourceId(r, ['VENUE', 'RECIPIENT'] as const, 'resource')) as ResourceId);
}

/** The state a decision reads: the reviewed record of the instrument, as the catalog reports it at `at`. */
export function fixtureInstrumentState(m: FixtureModule, instrument: FixtureInstrument, at: bigint): SuppliedState {
  const payload = encodeFixtureInstrument(instrument);
  const ref = m.ref;
  const env = validateStateEnvelope({
    module: { domainId: ref.domainId, moduleId: ref.moduleId, moduleVersion: ref.moduleVersion, moduleDigest: ref.moduleDigest },
    stateKind: STATE_INSTRUMENT,
    subject: marketOf(m.config, instrument.instrument),
    sourceId: m.config.source,
    trustClass: 'VERIFIED',
    observedAt: at,
    sequence: { kind: 'NONE' },
    validUntil: null,
    finality: { ladder: FIXTURE_LADDER.ladder, level: 'REVIEWED' },
    payloadDigest: statePayloadDigest(ref, payload),
  });
  if (!env.ok) throw new Error(`fixture state envelope invalid: ${env.error.code} at ${env.error.path}`);
  return { envelope: env.value, payload };
}

// --- The binding --------------------------------------------------------------------------------

function claimMismatches(candidate: ActionCandidate, i: FixtureInstrument): Reason[] {
  const found: Reason[] = [];
  const cl = candidate.claims;
  if (cl.asset !== null && assetKey(cl.asset) !== assetKey(i.asset)) found.push(reason('IDENTITY_CLAIM_MISMATCH', 'asset'));
  if (cl.issuer !== null && cl.issuer !== i.issuer) found.push(reason('IDENTITY_CLAIM_MISMATCH', 'issuer'));
  return found;
}

/** Slippage the artifact tolerates, rounded up: `ceil((quoted − minimum) × 10,000 / quoted)`. */
export function slippageBps(quotedOut: bigint, minOut: bigint): number {
  const gap = quotedOut - minOut;
  return Number((gap * 10_000n + quotedOut - 1n) / quotedOut);
}

export function createFixtureBinding(m: FixtureModule): DomainBinding {
  const c = m.config;
  const adapter = fixtureAdapterRefInput(c);

  function facts(candidate: ActionCandidate): { instrument: string; venue: string; route: readonly Identifier[]; recipient: Identifier; amount: bigint; slippage: number | null; quoteObservedAt: bigint | null } | null {
    switch (candidate.kind) {
      case 'SWAP_EXACT_IN':
        return { instrument: candidate.tokenOut, venue: candidate.router, route: candidate.route, recipient: candidate.recipient, amount: candidate.amountIn, slippage: slippageBps(candidate.quotedOut, candidate.minOut), quoteObservedAt: candidate.quoteObservedAt };
      case 'NFT_BUY':
        return { instrument: candidate.collection, venue: candidate.marketplace, route: [], recipient: candidate.recipient, amount: candidate.maxPrice, slippage: null, quoteObservedAt: null };
      case 'YIELD_DEPOSIT': {
        const i = m.instrumentFor(candidate.product);
        // A vault is traded on its own protocol: the reviewed record names it, the agent does not.
        return { instrument: candidate.product, venue: i?.venues[0] ?? candidate.product, route: [], recipient: candidate.recipient, amount: candidate.amount, slippage: null, quoteObservedAt: candidate.quoteObservedAt };
      }
      default:
        return null;
    }
  }

  return {
    domain: c.domain,
    kind: c.kind,
    module: m,
    adapter,
    actionTypes: [c.actionType],
    evidence: EvidenceClass.FIXTURE,
    integration: c.integration,

    resolve(candidate: ActionCandidate, ctx: ResolveContext): Resolution {
      if (candidate.kind !== c.kind) return { ok: false, reasons: [reason('ACTION_NOT_ALLOWED', candidate.kind)], registry: null };
      const f = facts(candidate) as NonNullable<ReturnType<typeof facts>>;
      if (candidate.kind === 'SWAP_EXACT_IN' && candidate.tokenIn !== c.fundingToken) return { ok: false, reasons: [reason('INSTRUMENT_UNKNOWN', `tokenIn:${candidate.tokenIn}`)], registry: null };
      const i = m.instrumentFor(f.instrument);
      if (i === null) return { ok: false, reasons: [reason('INSTRUMENT_UNKNOWN', f.instrument)], registry: null };
      const mismatch = claimMismatches(candidate, i);
      if (mismatch.length > 0) return { ok: false, reasons: mismatch, registry: null };
      const demand = demandOf(ctx.table, [{ kind: 'NOTIONAL', unit: c.settlementUnit, decimals: c.settlementDecimals, atoms: f.amount, domain: c.domain }]);
      if (!demand.ok) return { ok: false, reasons: [demand.error], registry: null };
      const action: ResolvedAction = {
        kind: c.kind,
        domain: c.domain,
        chain: i.chain,
        venue: f.venue as Identifier,
        route: f.route,
        asset: i.asset,
        representation: i.instrument,
        issuer: i.issuer,
        recipient: f.recipient,
        synthetic: i.synthetic,
        rights: [],
        leverage: null,
        slippageBps: f.slippage,
        quoteObservedAt: f.quoteObservedAt,
        demand: demand.value,
      };
      return { ok: true, action, registry: null };
    },

    coverage(scope: AuthorityScope): CoreCoverage {
      const reviewed = c.instruments.filter((i) => scope.representations.includes(i.instrument));
      const venues = new Set<string>();
      for (const i of reviewed) for (const v of i.venues) if (scope.venues.includes(v)) venues.add(v);
      for (const p of c.pools) if (scope.venues.includes(p.router) && scope.venues.includes(p.pool)) venues.add(p.pool);
      return {
        markets: reviewed.map((i) => marketOf(c, i.instrument)),
        venues: [...venues].sort().map((v) => ({ domain: c.domain, kind: 'VENUE', localId: v })),
        recipients: c.recipients.filter((r) => scope.recipients.includes(r)).map((r) => ({ domain: c.domain, kind: 'RECIPIENT', localId: r })),
      };
    },

    delegationTerms(_scope: AuthorityScope): readonly AuthorityTermInput[] {
      return [];
    },

    coreAction(candidate: ActionCandidate, childDigest: Digest32): CoreAction | null {
      const f = facts(candidate);
      if (f === null || m.instrumentFor(f.instrument) === null) return null;
      const action: FixtureAction = { child: childDigest, instrument: f.instrument, venue: f.venue, route: f.route, recipient: f.recipient, notional: f.amount };
      return { actionType: c.actionType, target: marketOf(c, f.instrument), resources: coreResources(c, action).map((r) => ({ domain: r.domain, kind: r.kind, localId: r.localId })), payload: encodeFixtureAction(action) };
    },

    states(candidate: ActionCandidate, at: bigint): readonly SuppliedState[] {
      const f = facts(candidate);
      const i = f === null ? null : m.instrumentFor(f.instrument);
      return i === null ? [] : [fixtureInstrumentState(m, i, at)];
    },

    sources(): readonly StateSourceConfigInput[] {
      return [{ sourceId: c.source, trustClass: 'VERIFIED', kinds: [{ domain: c.domain, stateKind: STATE_INSTRUMENT }] }];
    },
  };
}
