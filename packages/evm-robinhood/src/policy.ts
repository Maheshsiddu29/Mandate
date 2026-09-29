/**
 * GateSpotPolicy v1 — the Robinhood Chain EVM `DomainModule` (Phase 7E.3).
 *
 * Pure: no network, clock, key or ledger. It gives an `evm.gate-buy` action
 * its economic meaning over one deployed, reviewed `MandateExecutionGate`
 * (frozen Phase 6) and returns typed facts and ledger demands. It cannot
 * authorize anything; the control engine decides, and the gate enforces the
 * exact artifact onchain.
 *
 * **Scope.** BUY only, of a reviewed FIXTURE market, for the principal's own
 * account. The frozen gate also settles SELL; v1 does not offer it because
 * the demonstration needs one economic direction and every action type is
 * a surface.
 *
 * **Quantities, never "risk".**
 *
 * | Quantity        | Kind       | Unit, decimals                         | Asset               | Demand            |
 * | --------------- | ---------- | -------------------------------------- | ------------------- | ----------------- |
 * | capital spent   | `CAPITAL`  | the settlement unit, funding decimals  | the funding token   | required          |
 * | committed notional | `NOTIONAL` | the settlement unit, funding decimals | the canonical asset | if granted        |
 * | actions         | `COUNT`    | `COUNT`, 0                             | —                   | if granted        |
 *
 * Notional is valued on the `LIMIT` basis: before execution the fixture price
 * is a committed worst case, not an observed fill (Core reserves `EXECUTION`
 * for an observation).
 *
 * Capital is the worst-case debit — exactly `FixtureVenue.quoteBuy(quantity)`,
 * fee included, rounded up — and it is the only amount the gate can pull: the
 * signed `MAX_TOTAL_DEBIT` and the agent's `fundingLimit` are set to it
 * (gate.ts). Notional is quantity × the immutable fixture price, rounded up,
 * before fee. `CAPITAL` is **required**: an EVM spend under a lineage that
 * grants no capital dimension in this unit refuses (LEDGER-5) rather than
 * running unbudgeted.
 *
 * **State.** One snapshot per market, `evm.gate-market`: the gate's market
 * table entry and its venue's fee, read from the chain, pinned by digest to
 * the reviewed record. Chain state that disagrees with the review — another
 * price, another token, another adapter — is refused at admission.
 *
 * **Pending.** Unresolved reservations under this module are projected in
 * full: nothing is credited until reconciliation (7F) establishes what the
 * gate settled.
 */

import { ByteWriter } from '@mandate/kernel';
import {
  keccakDigest,
  validateModuleRef,
  validateQuantity,
  validateQuantityBound,
  validateStateRequirement,
  writeDigest,
  type AccountId,
  type ActionId,
  type BoundId,
  type FinalityLadderId,
  type FinalityLevel,
  type ImplementationDigest,
  type MarketId,
  type ModuleRef,
  type ModuleRefInput,
  type ResourceId,
  type StateId,
  type StateInvariantTerm,
  type StateRequirement,
  type UnitCode,
} from '@mandate/core';
import type { InvariantNarrowing } from '@mandate/ledger';
import {
  moduleFail,
  statePayloadDigest,
  type ActionAnalysis,
  type ActionContext,
  type AdmittedState,
  type DemandMeasure,
  type DomainModule,
  type EconomicFact,
  type InvariantEvaluation,
  type LedgerDemand,
  type ModuleProjection,
  type ModuleResult,
  type ModuleScope,
  type StateNeed,
} from '@mandate/control';
import { buyCost, canonicalAssetResource, checkReviewedMarket, grossCost, reviewedSnapshot, type ReviewedGate, type ReviewedMarket } from './market.ts';
import {
  ACTION_GATE_BUY,
  DOMAIN_ID,
  MODULE_ID,
  MODULE_VERSION,
  STATE_GATE_MARKET,
  accountAddressOf,
  decodeGateBuy,
  decodeGateMarket,
  encodeGateMarket,
  fundingResource,
  marketResource,
  marketTokenOf,
  type DecodedBuy,
  type SourceConfig,
} from './vocabulary.ts';

export const ORDER_DEBIT_BOUND = `${MODULE_ID}.order-debit` as BoundId;
export const BLOCK_LADDER = { ladder: 'evm.block' as FinalityLadderId, levels: ['LATEST', 'SAFE', 'FINALIZED'] as FinalityLevel[] };

/** Worst-case assumptions bound into the module's digest (PROJ-1). */
export const ASSUMPTIONS = [
  'gate-spot.buy-only',
  'gate-spot.fixture-price-immutable',
  'gate-spot.funding-settles-declared-unit',
  'gate-spot.debit-is-venue-quote-with-fee',
  'gate-spot.pending-full-debit',
  'gate-spot.nothing-consumed-before-reconciliation',
] as const;

/** A representation quantity this large cannot be priced inside the gate's uint256 arithmetic with room to spare. */
const MAX_QUANTITY = (1n << 128n) - 1n;

export interface GateSpotConfig {
  readonly gate: ReviewedGate;
  readonly sources: SourceConfig;
  /** Default snapshot age limit, tightenable by every grant and the principal policy. */
  readonly maxMarketAgeSeconds: bigint;
  /** Module cap on an authorization's lifetime, from the action's `validFrom`. */
  readonly lifetimeSeconds: bigint;
}

export interface GateSpotPolicy extends DomainModule {
  readonly config: GateSpotConfig;
  marketFor(market: ResourceId): ReviewedMarket | null;
}

function must<T>(r: { ok: true; value: T } | { ok: false; error: { code: string; path: string } }): T {
  if (!r.ok) throw new Error(`gate-spot constant invalid: ${r.error.code} at ${r.error.path}`);
  return r.value;
}

function checkConfig(config: GateSpotConfig): void {
  const seen = new Set<string>();
  for (const m of config.gate.markets) {
    const bad = checkReviewedMarket(m);
    if (bad !== null) throw new Error(`reviewed market ${m.representation} refused: ${bad}`);
    if (seen.has(m.representation)) throw new Error(`market ${m.representation} reviewed twice`);
    seen.add(m.representation);
  }
  if (config.gate.markets.length === 0) throw new Error('no reviewed market');
}

/** Every semantic constant the module's meaning depends on: its digest is the module's identity (DOM-2). */
export function gateSpotManifest(config: GateSpotConfig): Uint8Array {
  checkConfig(config);
  const g = config.gate;
  const w = new ByteWriter().str('mandate/evm-robinhood/policy-manifest').u16(1);
  w.str(DOMAIN_ID).str(MODULE_ID).u32(MODULE_VERSION).u64(g.chainId).str(g.gate);
  const markets = [...g.markets].sort((a, b) => (a.representation < b.representation ? -1 : 1));
  w.u16(markets.length);
  for (const m of markets) writeDigest(w, keccakDigest(encodeGateMarket(reviewedSnapshot(g.chainId, g.gate, m))));
  w.str(config.sources.gateMarket).u64(config.maxMarketAgeSeconds).u64(config.lifetimeSeconds);
  for (const a of ASSUMPTIONS) w.str(a);
  w.str(ACTION_GATE_BUY).str(ORDER_DEBIT_BOUND);
  return w.finish();
}

export function gateSpotModuleRef(config: GateSpotConfig): ModuleRefInput {
  return { domainId: DOMAIN_ID, moduleId: MODULE_ID, moduleVersion: MODULE_VERSION, moduleDigest: keccakDigest(gateSpotManifest(config)) };
}

export function gateSpotImplementation(config: GateSpotConfig): ImplementationDigest {
  return keccakDigest<ImplementationDigest>(new TextEncoder().encode(`mandate/evm-robinhood/implementation/v1:${gateSpotModuleRef(config).moduleDigest}`));
}

export function createGateSpotPolicy(config: GateSpotConfig): GateSpotPolicy {
  checkConfig(config);
  const g = config.gate;
  const ref: ModuleRef = must(validateModuleRef(gateSpotModuleRef(config)));
  const implementation = gateSpotImplementation(config);
  const marketFor = (market: ResourceId): ReviewedMarket | null => {
    const token = marketTokenOf(market, g.chainId);
    return token === null ? null : (g.markets.find((m) => m.representation === token) ?? null);
  };
  const requirement = (input: Parameters<typeof validateStateRequirement>[0]): StateRequirement => must(validateStateRequirement(input, 'requirement'));
  const marketNeed = (m: ReviewedMarket): StateNeed => ({
    stateKind: STATE_GATE_MARKET,
    subject: marketResource(g.chainId, m.representation),
    admittedSources: [config.sources.gateMarket],
    requirement: requirement({
      // Pinned to the reviewed record: a chain that reports another price, token, adapter or fee is not this market.
      freshness: { kind: 'VERSION', pinnedDigest: statePayloadDigest(ref, encodeGateMarket(reviewedSnapshot(g.chainId, g.gate, m))), maxAgeSeconds: config.maxMarketAgeSeconds },
      minTrust: 'VERIFIED',
      // The market table is written once, by the constructor: a reorg can only remove the gate, which fails the execution.
      minFinality: { ladder: BLOCK_LADDER.ladder, level: 'LATEST' },
      atIssue: 'RECHECK',
      // The gate derives token, adapter, price and units from the candidate's representation id itself.
      atExecution: { kind: 'ENFORCED_BY_ARTIFACT', field: 'market' },
    }),
  });

  function analyse(ctx: ActionContext): ModuleResult<{ action: DecodedBuy; market: ReviewedMarket }> {
    const action = decodeGateBuy(ctx.payload);
    if (action === null) return moduleFail('PAYLOAD_MALFORMED', 'payload');
    if (ctx.envelope.actionType !== ACTION_GATE_BUY) return moduleFail('ACTION_TYPE_MISMATCH', 'actionType');
    if (accountAddressOf(action.account, g.chainId) === null) return moduleFail('ACCOUNT_NOT_ON_CHAIN', 'account');
    const market = marketFor(action.market);
    if (market === null) return moduleFail('MARKET_NOT_REVIEWED', 'market');
    if (action.quantity <= 0n || action.quantity > MAX_QUANTITY) return moduleFail('QUANTITY_OUT_OF_RANGE', 'quantity');
    if (grossCost(market, action.quantity) === 0n) return moduleFail('COST_ROUNDS_TO_ZERO', 'quantity');
    return { ok: true, value: { action, market } };
  }

  const capital = (m: ReviewedMarket, atoms: bigint) =>
    must(validateQuantity({ kind: 'CAPITAL', unit: m.settlementUnit, decimals: m.fundingDecimals, atoms, asset: fundingResource(g.chainId, m.fundingToken), valuation: null }));
  const notional = (m: ReviewedMarket, atoms: bigint, action: ActionId, observedAt: bigint) =>
    must(
      validateQuantity({
        kind: 'NOTIONAL',
        unit: m.settlementUnit,
        decimals: m.fundingDecimals,
        atoms,
        asset: canonicalAssetResource(m.canonicalAsset),
        valuation: { price: { numeratorUnit: m.settlementUnit, denominatorUnit: m.quantityUnit, decimals: m.fixturePrice.decimals, atoms: m.fixturePrice.atoms }, basis: 'LIMIT', source: { kind: 'ACTION', actionId: action }, observedAt },
      }),
    );

  const module: GateSpotPolicy = {
    ref,
    implementation,
    config,
    marketFor,
    invariants: [],
    finalityLadders: [BLOCK_LADDER],
    demandMeasures: [
      ...[...new Set(g.markets.map((m) => m.settlementUnit))].sort().flatMap((unit): DemandMeasure[] => [
        { kind: 'CAPITAL', unit: unit as UnitCode },
        { kind: 'NOTIONAL', unit: unit as UnitCode },
      ]),
      { kind: 'COUNT', unit: 'COUNT' as UnitCode },
    ],

    validateAction(ctx: ActionContext): ModuleResult<ActionAnalysis> {
      const a = analyse(ctx);
      if (!a.ok) return a;
      const { action, market } = a.value;
      return {
        ok: true,
        value: {
          target: action.market,
          resources: [action.account],
          riskDirection: 'INCREASING',
          requiredRights: ['OPEN_RISK'],
          bounds: [{ boundId: ORDER_DEBIT_BOUND, value: { type: 'QUANTITY', quantity: must(validateQuantityBound({ kind: 'CAPITAL', unit: market.settlementUnit, decimals: market.fundingDecimals, atoms: buyCost(market, action.quantity) }, 'bound')) } }],
          validUntil: ctx.envelope.validFrom + config.lifetimeSeconds,
        },
      };
    },

    stateRequirements(scope: ModuleScope): ModuleResult<readonly StateNeed[]> {
      const markets = new Map<string, ReviewedMarket>();
      if (scope.action !== null) {
        const a = analyse(scope.action);
        if (!a.ok) return a;
        markets.set(a.value.market.representation, a.value.market);
      }
      for (const f of scope.reservations) {
        for (const e of f.effects) {
          if (e.market === null) continue;
          const m = marketFor(e.market);
          if (m === null) return moduleFail('PENDING_MARKET_NOT_REVIEWED');
          markets.set(m.representation, m);
        }
      }
      return { ok: true, value: [...markets.keys()].sort().map((k) => marketNeed(markets.get(k) as ReviewedMarket)) };
    },

    validateStatePayload(state: AdmittedState): ModuleResult<true> {
      const e = state.envelope;
      if (e.stateKind !== STATE_GATE_MARKET) return moduleFail('STATE_KIND_UNKNOWN');
      const s = decodeGateMarket(state.payload);
      const m = marketFor(e.subject);
      return s !== null && m !== null && s.chainId === g.chainId && s.gate === g.gate && s.representation === m.representation ? { ok: true, value: true } : moduleFail('GATE_MARKET_PAYLOAD_INVALID');
    },

    project(scope: ModuleScope, states: readonly AdmittedState[]): ModuleResult<ModuleProjection> {
      const marketStates = new Map<string, StateId>();
      for (const s of states) {
        const snap = decodeGateMarket(s.payload);
        if (snap === null) return moduleFail('GATE_MARKET_PAYLOAD_INVALID');
        marketStates.set(snap.representation, s.stateId);
      }
      const facts: EconomicFact[] = [];
      const resources = new Map<string, ResourceId>();
      // PENDING: every unresolved reservation in full, less only what reconciliation has consumed.
      for (const f of scope.reservations) {
        for (const e of f.effects) {
          if (e.quantity.kind !== 'CAPITAL' && e.quantity.kind !== 'NOTIONAL') continue;
          const remaining = e.quantity.atoms - e.consumed;
          if (remaining <= 0n) continue;
          const quantity = must(validateQuantity({ kind: e.quantity.kind, unit: e.quantity.unit, decimals: e.quantity.decimals, atoms: remaining, asset: e.quantity.asset, valuation: e.quantity.valuation }));
          facts.push({ component: 'PENDING', quantity, market: e.market, account: e.account, states: [], reservations: [f.reservation] });
          if (e.market !== null) resources.set(`m:${e.market.localId}`, e.market);
          if (e.account !== null) resources.set(`a:${e.account.localId}`, e.account);
        }
      }
      const payload = new ByteWriter().str('robinhood-evm/v1/projection');
      if (scope.action !== null) {
        const a = analyse(scope.action);
        if (!a.ok) return a;
        const { action, market } = a.value;
        const state = marketStates.get(market.representation);
        if (state === undefined) return moduleFail('GATE_MARKET_STATE_MISSING');
        const marketId: MarketId = action.market;
        const account: AccountId = action.account;
        resources.set(`m:${marketId.localId}`, marketId);
        resources.set(`a:${account.localId}`, account);
        const cost = buyCost(market, action.quantity);
        const gross = grossCost(market, action.quantity);
        payload.str(market.representation).u256(action.quantity).u256(gross).u256(cost);
        if (scope.action.mode === 'PROPOSE') {
          facts.push({ component: 'PROPOSED', quantity: capital(market, cost), market: marketId, account, states: [state], reservations: [] });
          facts.push({ component: 'PROPOSED', quantity: notional(market, gross, scope.action.actionId, scope.action.envelope.validFrom), market: marketId, account, states: [state], reservations: [] });
        }
      }
      const keys = [...resources.keys()].sort();
      return { ok: true, value: { facts, invariantFacts: [], resources: keys.map((k) => resources.get(k) as ResourceId), assumptions: [...ASSUMPTIONS], payload: payload.finish() } };
    },

    evaluateInvariant(_term: StateInvariantTerm, _projection: ModuleProjection): ModuleResult<InvariantEvaluation> {
      // v1 owns no state invariant: its authority is the ledger's capital and notional dimensions.
      return moduleFail('INVARIANT_UNKNOWN');
    },

    deriveLedgerDemands(ctx: ActionContext, _projection: ModuleProjection): ModuleResult<readonly LedgerDemand[]> {
      const a = analyse(ctx);
      if (!a.ok) return a;
      const { action, market } = a.value;
      const cost = buyCost(market, action.quantity);
      const gross = grossCost(market, action.quantity);
      return {
        ok: true,
        value: [
          { quantity: capital(market, cost), market: action.market, account: action.account, required: true },
          { quantity: notional(market, gross, ctx.actionId, ctx.envelope.validFrom), market: action.market, account: null, required: false },
          { quantity: must(validateQuantity({ kind: 'COUNT', unit: 'COUNT', decimals: 0, atoms: 1n, asset: null, valuation: null })), market: null, account: null, required: false },
        ],
      };
    },

    noWeaker(_parent: StateInvariantTerm, _child: StateInvariantTerm): ModuleResult<InvariantNarrowing> {
      return { ok: true, value: 'UNPROVABLE' };
    },
  };
  return module;
}

