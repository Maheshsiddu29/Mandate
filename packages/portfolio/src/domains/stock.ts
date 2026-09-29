/**
 * The stock agent's domain: Robinhood Chain, through the Phase 7E.3 path
 * (portfolio-mandate.md §8).
 *
 * **Identity through the existing registry.** A `STOCK_BUY` names a registry
 * `RepresentationId`. The binding evaluates it with the registry's own
 * `evaluateRepresentation`, against requirements derived from the agent's
 * scope — canonical asset, issuers, chains, synthetic policy, required rights
 * — and carries the registry's verdict and reason codes verbatim. An
 * unregistered contract is `REPRESENTATION_UNKNOWN` whatever its ticker; a
 * registered look-alike from another issuer is `ISSUER_NOT_ALLOWED`. The
 * ticker, the display name and the agent's claimed issuer are never read as
 * identity. There is no second asset-identity implementation here.
 *
 * **Execution through GateSpotPolicy v1** over a reviewed gate, the
 * `robinhood-gate-signer` adapter and the frozen Phase 6 gate — the path
 * executed on Robinhood Chain testnet in Phase 7E.3. Demand is exactly what
 * that module demands: `CAPITAL` = `FixtureVenue.quoteBuy(quantity)` and
 * `NOTIONAL` = the gross cost, in the market's settlement unit.
 */

import { parseMandate, type CanonicalAssetId, type Identifier } from '@mandate/kernel';
import type { AuthorityTermInput, DomainId, ResourceIdInput, StateSourceId } from '@mandate/core';
import type { StateSourceConfigInput, SuppliedState } from '@mandate/control';
import {
  ACTION_GATE_BUY,
  DOMAIN_ID as ROBINHOOD_DOMAIN,
  STATE_GATE_MARKET,
  accountResource,
  buyCost,
  createGateSpotPolicy,
  encodeGateBuy,
  gateAdapterRefInput,
  gateMarketState,
  grossCost,
  marketResource,
  representationIdOf,
  reviewedMarketFor,
  reviewedSnapshot,
  type GateSpotPolicy,
  type ReviewedGate,
  type ReviewedMarket,
} from '@mandate/evm-robinhood';
import {
  claimPolicyOf,
  deriveRequirements,
  evaluateRepresentation,
  getRepresentation,
  identityKey,
  isSyntheticBacking,
  narrowRequirements,
  parseRepresentationId,
  resolveClaimSet,
  RightKind,
  type Registry,
  type RepresentationRequirements,
} from '@mandate/registry';
import type { ResolvedAction } from '../authority.ts';
import { type CoreAction, type CoreCoverage, type DomainBinding, type EvidenceClass, type RepresentationDecisionRecord, type Resolution, type ResolveContext } from '../binding.ts';
import type { ActionCandidate } from '../candidate.ts';
import { portfolioMandateDigest } from '../mandate.ts';
import { canonicalReasons, reason, type Reason } from '../reasons.ts';
import { demandOf } from '../resources.ts';
import { assetKey, type AuthorityScope } from '../scope.ts';

export interface StockBindingConfig {
  readonly gate: ReviewedGate;
  readonly gateCodehash: string;
  readonly domainSeparator: string;
  readonly registry: Registry;
  /** The principal's address on the gate's chain: the only account the gate buys for and pays out to. */
  readonly principalAddress: string;
  readonly source: StateSourceId;
  readonly maxMarketAgeSeconds: bigint;
  readonly lifetimeSeconds: bigint;
  readonly evidence: EvidenceClass;
  readonly integration: Identifier;
}

export interface StockBinding extends DomainBinding {
  readonly policy: GateSpotPolicy;
  readonly config: StockBindingConfig;
  /** The portfolio recipient identifier of the principal's account on the gate's chain. */
  readonly principalAccount: Identifier;
  /** The portfolio venue identifier of the reviewed gate. */
  readonly venue: Identifier;
}

function chainOf(g: ReviewedGate): string {
  return `eip155:${g.chainId.toString(10)}`;
}

/**
 * Registry requirements for the agent's scope and one canonical asset.
 *
 * The registry derives requirements only from a signed kernel mandate
 * (requirements.ts: "there is no exported way to build a requirements object
 * from nothing"). This kernel mandate is *projected* from the agent's scope
 * for that purpose alone: it is never signed, digested or executed, and the
 * registry reads only its canonical asset, issuers, chains and synthetic
 * policy. Required rights are then layered with `narrowRequirements`, which
 * can only tighten.
 */
function requirementsFor(scope: AuthorityScope, asset: CanonicalAssetId, ctx: ResolveContext): RepresentationRequirements | null {
  const mandate = parseMandate({
    version: 2,
    mandateId: portfolioMandateDigest(ctx.mandate),
    nonce: '0',
    principal: { kind: ctx.mandate.principal.kind, value: ctx.mandate.principal.value },
    agent: { kind: ctx.agent.agent.kind, value: ctx.agent.agent.value },
    canonicalAsset: { assetClass: asset.assetClass, idScheme: asset.idScheme, value: asset.value },
    side: 'BUY',
    maxNotional: { unit: 'USDC', decimals: 6, atoms: '1' },
    economicLimit: { unit: 'USDC', decimals: 6, atoms: '1' },
    maxDeviationBps: '0',
    syntheticPolicy: scope.syntheticPolicy,
    allowedIssuers: [...scope.issuers],
    allowedChains: [...scope.chains],
    allowedVenues: [],
    requiredCorporateActionEpoch: '0',
    maxPriceAgeSeconds: '60',
    maxCorporateActionAgeSeconds: '60',
    haltPolicy: 'FORBID_WHEN_HALTED',
    createdAtUnixSeconds: ctx.now.toString(),
    notBeforeUnixSeconds: ctx.now.toString(),
    expiresAtUnixSeconds: (ctx.now + 1n).toString(),
  });
  if (!mandate.ok) return null;
  const base = deriveRequirements(mandate.value, { nowUnixSeconds: ctx.now });
  if (!base.ok) return null;
  const narrowed = narrowRequirements(base.value, { requiredRights: scope.requiredRights.map((kind) => ({ kind, acceptable: ['PRESENT'] })) });
  return narrowed.ok ? narrowed.value : null;
}

export function createStockBinding(config: StockBindingConfig): StockBinding {
  const g = config.gate;
  const policy = createGateSpotPolicy({ gate: g, sources: { gateMarket: config.source }, maxMarketAgeSeconds: config.maxMarketAgeSeconds, lifetimeSeconds: config.lifetimeSeconds });
  const adapter = gateAdapterRefInput({ gate: g, gateCodehash: config.gateCodehash, domainSeparator: config.domainSeparator });
  const principalAccount = `${chainOf(g)}/account:${config.principalAddress}` as Identifier;
  const venue = `${chainOf(g)}/gate:${g.gate}` as Identifier;

  /** The reviewed market of a representation id, only if it is this gate's chain and lists that exact token. */
  function marketOf(representation: string): ReviewedMarket | null {
    const id = parseRepresentationId(representation);
    if (!id.ok || id.value.chain !== chainOf(g)) return null;
    return reviewedMarketFor(g, id.value.contractAddress);
  }

  function registryVerdict(candidate: Extract<ActionCandidate, { kind: 'STOCK_BUY' }>, ctx: ResolveContext): { record: RepresentationDecisionRecord; admissibleFor: CanonicalAssetId | null; requirements: RepresentationRequirements | null; reasons: Reason[] } {
    const scope = ctx.agent.scope;
    const codes = new Set<string>();
    for (const asset of scope.assets) {
      const req = requirementsFor(scope, asset, ctx);
      if (req === null) {
        codes.add('REQUIREMENTS_UNDERIVABLE');
        continue;
      }
      const d = evaluateRepresentation(config.registry, req, candidate.representation);
      if (d.status === 'ADMISSIBLE') return { record: { representation: candidate.representation, status: 'ADMISSIBLE', codes: [] }, admissibleFor: asset, requirements: req, reasons: [] };
      for (const c of d.reasonCodes) codes.add(c);
    }
    // A scope with no canonical asset admits no representation: closed world.
    if (scope.assets.length === 0) codes.add('CANONICAL_ASSET_NOT_IN_SCOPE');
    const sorted = [...codes].sort();
    return {
      record: { representation: candidate.representation, status: 'EXCLUDED', codes: sorted },
      admissibleFor: null,
      requirements: null,
      reasons: sorted.map((c) => reason(`REGISTRY:${c}`, candidate.representation)),
    };
  }

  const binding: StockBinding = {
    domain: ROBINHOOD_DOMAIN as DomainId,
    kind: 'STOCK_BUY',
    module: policy,
    adapter,
    actionTypes: [ACTION_GATE_BUY],
    evidence: config.evidence,
    integration: config.integration,
    policy,
    config,
    principalAccount,
    venue,

    resolve(candidate: ActionCandidate, ctx: ResolveContext): Resolution {
      if (candidate.kind !== 'STOCK_BUY') return { ok: false, reasons: [reason('ACTION_NOT_ALLOWED', candidate.kind)], registry: null };
      const verdict = registryVerdict(candidate, ctx);
      if (verdict.admissibleFor === null || verdict.requirements === null) return { ok: false, reasons: canonicalReasons(verdict.reasons), registry: verdict.record };
      const record = getRepresentation(config.registry, candidate.representation);
      const id = parseRepresentationId(candidate.representation);
      if (record === undefined || !id.ok) return { ok: false, reasons: [reason('REGISTRY:REPRESENTATION_UNKNOWN', candidate.representation)], registry: verdict.record };
      const policyOfClaims = claimPolicyOf(verdict.requirements);
      const issuer = resolveClaimSet(record.issuer, policyOfClaims, identityKey);
      const backing = resolveClaimSet(record.backing, policyOfClaims, identityKey);
      // Admissible means both were established; anything else is a registry that changed under us — refuse.
      if (issuer.state !== 'ESTABLISHED' || backing.state !== 'ESTABLISHED') return { ok: false, reasons: [reason('REGISTRY:REPRESENTATION_METADATA_UNKNOWN', candidate.representation)], registry: verdict.record };
      const rights: RightKind[] = [];
      for (const kind of Object.values(RightKind)) {
        const state = resolveClaimSet(record.rights[kind] ?? [], policyOfClaims, identityKey);
        if (state.state === 'ESTABLISHED' && state.value === 'PRESENT') rights.push(kind);
      }
      const asset = verdict.admissibleFor;
      const found: Reason[] = [];
      if (candidate.claims.issuer !== null && candidate.claims.issuer !== issuer.value) found.push(reason('IDENTITY_CLAIM_MISMATCH', 'issuer'));
      if (candidate.claims.asset !== null && assetKey(candidate.claims.asset) !== assetKey(asset)) found.push(reason('IDENTITY_CLAIM_MISMATCH', 'asset'));
      // The registry says what the token is; the reviewed gate must list exactly that token as that asset, or it cannot be bought here.
      const market = marketOf(candidate.representation);
      if (market === null || assetKey(market.canonicalAsset) !== assetKey(asset)) found.push(reason('INSTRUMENT_UNKNOWN', `gate-market:${candidate.representation}`));
      if (found.length > 0 || market === null) return { ok: false, reasons: canonicalReasons(found), registry: verdict.record };
      const demand = demandOf(ctx.table, [
        { kind: 'CAPITAL', unit: market.settlementUnit, decimals: market.fundingDecimals, atoms: buyCost(market, candidate.quantity), domain: ROBINHOOD_DOMAIN },
        { kind: 'NOTIONAL', unit: market.settlementUnit, decimals: market.fundingDecimals, atoms: grossCost(market, candidate.quantity), domain: ROBINHOOD_DOMAIN },
      ]);
      if (!demand.ok) return { ok: false, reasons: [demand.error], registry: verdict.record };
      const action: ResolvedAction = {
        kind: 'STOCK_BUY',
        domain: ROBINHOOD_DOMAIN as DomainId,
        chain: id.value.chain,
        venue,
        route: [],
        asset,
        representation: candidate.representation,
        issuer: issuer.value as Identifier,
        recipient: candidate.account,
        synthetic: isSyntheticBacking(backing.value as never),
        rights,
        leverage: null,
        slippageBps: null,
        quoteObservedAt: null,
        demand: demand.value,
      };
      return { ok: true, action, registry: verdict.record };
    },

    coverage(scope: AuthorityScope): CoreCoverage {
      const markets: ResourceIdInput[] = [];
      for (const m of g.markets) {
        if (scope.representations.includes(representationIdOf(g.chainId, m.representation) as Identifier)) {
          const r = marketResource(g.chainId, m.representation);
          markets.push({ domain: r.domain, kind: r.kind, localId: r.localId });
        }
      }
      return { markets, venues: [], recipients: [] };
    },

    delegationTerms(_scope: AuthorityScope): readonly AuthorityTermInput[] {
      return [];
    },

    coreAction(candidate: ActionCandidate): CoreAction | null {
      if (candidate.kind !== 'STOCK_BUY' || candidate.account !== principalAccount) return null;
      const market = marketOf(candidate.representation);
      if (market === null) return null;
      const account = accountResource(g.chainId, config.principalAddress);
      const target = marketResource(g.chainId, market.representation);
      return {
        actionType: ACTION_GATE_BUY,
        target: { domain: target.domain, kind: target.kind, localId: target.localId },
        resources: [{ domain: account.domain, kind: account.kind, localId: account.localId }],
        payload: encodeGateBuy({ account, market: target, quantity: candidate.quantity }),
      };
    },

    states(candidate: ActionCandidate, at: bigint): readonly SuppliedState[] {
      if (candidate.kind !== 'STOCK_BUY') return [];
      const market = marketOf(candidate.representation);
      return market === null ? [] : [gateMarketState(policy, reviewedSnapshot(g.chainId, g.gate, market), at)];
    },

    sources(): readonly StateSourceConfigInput[] {
      return [{ sourceId: config.source, trustClass: 'VERIFIED', kinds: [{ domain: ROBINHOOD_DOMAIN, stateKind: STATE_GATE_MARKET }] }];
    },
  };
  return binding;
}
