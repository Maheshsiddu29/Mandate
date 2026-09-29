/**
 * The perps agent's domain: Lighter, through PerpPolicy v1 (Phase 7E.1;
 * portfolio-mandate.md §8, §15).
 *
 * **OFFCHAIN_ONLY.** Authorization and the exact order are derived offchain
 * over the reviewed testnet market claims; no funded Lighter testnet account
 * exists (testnet-evidence.md §2), so nothing here executes on Lighter.
 *
 * The binding adds no perp semantics of its own. Demand is exactly what
 * PerpPolicy demands — notional = size × limit price (exact in USDC because
 * the claim fixes size + price decimals = 6), margin = ⌈notional × IMF /
 * 10,000⌉ + ⌈notional × fee headroom / 10⁶⌉, position size in the market's
 * units — and the agent's leverage bound is compiled into its Core delegation
 * as PerpPolicy's own `perp.max-leverage` invariant, so Core enforces it over
 * the admitted account state whatever the portfolio layer computed.
 */

import type { CanonicalAssetId, Identifier } from '@mandate/kernel';
import { validateRatio, validateStateEnvelope, type AuthorityTermInput, type DomainId, type Ratio, type ResourceIdInput, type StateSourceId } from '@mandate/core';
import { statePayloadDigest, type StateSourceConfigInput, type SuppliedState } from '@mandate/control';
import {
  ACTION_CREATE_ORDER,
  DOMAIN_ID as LIGHTER_DOMAIN,
  MAX_LEVERAGE,
  MARGIN_FRACTION_TICK,
  FEE_TICK,
  PRICE_LADDER,
  STATE_ACCOUNT,
  STATE_ASSET_PRICE,
  STATE_LADDER,
  STATE_MARKET,
  USDC_DECIMALS,
  accountResource,
  ceilDiv,
  createPerpPolicy,
  encodeAccountBook,
  encodeAssetPrice,
  encodeMarketStatic,
  encodeOrder,
  lighterAdapterRefInput,
  marketResource,
  maxLeverageParams,
  type AccountBook,
  type CheckedClaim,
  type PerpPolicy,
  type PerpPolicyConfig,
} from '@mandate/perp-lighter';
import type { ResolvedAction } from '../authority.ts';
import type { CoreAction, CoreCoverage, DomainBinding, EvidenceClass, Resolution, ResolveContext } from '../binding.ts';
import type { ActionCandidate, PerpOpen } from '../candidate.ts';
import { reason, type Reason } from '../reasons.ts';
import { demandOf } from '../resources.ts';
import { assetKey, type AuthorityScope } from '../scope.ts';

/** Trusted state for a decision: supplied by a live state adapter in production, by labelled fixtures in the demonstration. */
export interface PerpStateSource {
  /** USD price at 2 decimals per canonical-asset resource `localId`, observed at `at`. */
  prices(at: bigint): ReadonlyMap<string, bigint>;
  book(at: bigint): AccountBook;
}

export interface PerpsBindingConfig {
  readonly policy: PerpPolicyConfig;
  /** The principal's Lighter sub-account: the only account the binding opens positions for. */
  readonly subAccount: bigint;
  readonly state: PerpStateSource;
  readonly evidence: EvidenceClass;
  readonly integration: Identifier;
}

export interface PerpsBinding extends DomainBinding {
  readonly policy: PerpPolicy;
  readonly account: Identifier;
  readonly venue: Identifier;
  marketId(c: CheckedClaim): Identifier;
  assetOf(c: CheckedClaim): CanonicalAssetId;
}

/** Leverage at an initial margin fraction, rounded up at 2 decimals — against the actor, as PerpPolicy rounds it. */
export function leverageAt(initialMarginFraction: number): Ratio {
  const r = validateRatio({ numerator: ceilDiv(MARGIN_FRACTION_TICK * 100n, BigInt(initialMarginFraction)), scale: 2 }, 'leverage');
  if (!r.ok) throw new Error('leverage ratio invalid');
  return r.value;
}

export function createPerpsBinding(config: PerpsBindingConfig): PerpsBinding {
  const policy = createPerpPolicy(config.policy);
  const chain = config.policy.chainId;
  const adapter = lighterAdapterRefInput({ chainId: chain });
  const account = `lighter:${chain}/account:${config.subAccount.toString(10)}` as Identifier;
  const venue = `lighter:${chain}/exchange` as Identifier;
  const marketId = (c: CheckedClaim) => `lighter:${chain}/perp:${c.static.marketIndex}` as Identifier;
  // The portfolio names the Core canonical-asset resource exactly, under a scheme that says so; nothing parses it.
  const assetOf = (c: CheckedClaim): CanonicalAssetId => ({ assetClass: 'crypto' as Identifier, idScheme: 'mandate-core' as Identifier, value: c.asset.localId as Identifier });
  const claimOf = (market: string): CheckedClaim | null => policy.claims.find((c) => marketId(c) === market) ?? null;
  const coreAccount = accountResource(chain, config.subAccount);

  function envelope(stateKind: string, subject: ResourceIdInput, payload: Uint8Array, sourceId: StateSourceId, finality: { ladder: string; level: string }, at: bigint): SuppliedState {
    const ref = policy.ref;
    const env = validateStateEnvelope({
      module: { domainId: ref.domainId, moduleId: ref.moduleId, moduleVersion: ref.moduleVersion, moduleDigest: ref.moduleDigest },
      stateKind,
      subject,
      sourceId,
      trustClass: 'VERIFIED',
      observedAt: at,
      sequence: { kind: 'NONE' },
      validUntil: null,
      finality,
      payloadDigest: statePayloadDigest(ref, payload),
    });
    if (!env.ok) throw new Error(`perp state envelope invalid: ${env.error.code} at ${env.error.path}`);
    return { envelope: env.value, payload };
  }

  function economics(c: PerpOpen, claim: CheckedClaim): { notional: bigint; margin: bigint } {
    const notional = c.size * c.price;
    const margin = ceilDiv(notional * BigInt(c.initialMarginFraction), MARGIN_FRACTION_TICK) + ceilDiv(notional * claim.maxTakerFeeRate, FEE_TICK);
    return { notional, margin };
  }

  const binding: PerpsBinding = {
    domain: LIGHTER_DOMAIN as DomainId,
    kind: 'PERP_OPEN',
    module: policy,
    adapter,
    actionTypes: [ACTION_CREATE_ORDER],
    evidence: config.evidence,
    integration: config.integration,
    policy,
    account,
    venue,
    marketId,
    assetOf,

    resolve(candidate: ActionCandidate, ctx: ResolveContext): Resolution {
      if (candidate.kind !== 'PERP_OPEN') return { ok: false, reasons: [reason('ACTION_NOT_ALLOWED', candidate.kind)], registry: null };
      const claim = claimOf(candidate.market);
      if (claim === null) return { ok: false, reasons: [reason('INSTRUMENT_UNKNOWN', candidate.market)], registry: null };
      const asset = assetOf(claim);
      const found: Reason[] = [];
      if (candidate.claims.asset !== null && assetKey(candidate.claims.asset) !== assetKey(asset)) found.push(reason('IDENTITY_CLAIM_MISMATCH', 'asset'));
      if (candidate.claims.issuer !== null) found.push(reason('IDENTITY_CLAIM_MISMATCH', 'issuer'));
      if (found.length > 0) return { ok: false, reasons: found, registry: null };
      const { notional, margin } = economics(candidate, claim);
      const demand = demandOf(ctx.table, [
        { kind: 'NOTIONAL', unit: 'USDC', decimals: USDC_DECIMALS, atoms: notional, domain: LIGHTER_DOMAIN },
        { kind: 'MARGIN', unit: 'USDC', decimals: USDC_DECIMALS, atoms: margin, domain: LIGHTER_DOMAIN },
        { kind: 'POSITION_SIZE', unit: 'UNIT', decimals: claim.static.sizeDecimals, atoms: candidate.size, domain: LIGHTER_DOMAIN },
      ]);
      if (!demand.ok) return { ok: false, reasons: [demand.error], registry: null };
      const action: ResolvedAction = {
        kind: 'PERP_OPEN',
        domain: LIGHTER_DOMAIN as DomainId,
        chain: `lighter:${chain}` as Identifier,
        venue,
        route: [],
        asset,
        representation: candidate.market,
        issuer: null,
        recipient: candidate.account,
        synthetic: false,
        rights: [],
        // A derivative always carries its leverage, so it is always checked against an explicit bound.
        leverage: leverageAt(candidate.initialMarginFraction),
        slippageBps: null,
        quoteObservedAt: null,
        demand: demand.value,
      };
      return { ok: true, action, registry: null };
    },

    coverage(scope: AuthorityScope): CoreCoverage {
      const markets: ResourceIdInput[] = [];
      for (const c of policy.claims) {
        if (!scope.representations.includes(marketId(c))) continue;
        const m = marketResource(chain, c.static.marketIndex);
        markets.push({ domain: m.domain, kind: m.kind, localId: m.localId });
      }
      return { markets, venues: [], recipients: [] };
    },

    delegationTerms(scope: AuthorityScope): readonly AuthorityTermInput[] {
      if (scope.maxLeverage === null || !scope.domains.includes(LIGHTER_DOMAIN as DomainId)) return [];
      // PerpPolicy's own invariant, over the principal's sub-account: Core re-derives leverage from the admitted margin setting.
      return [
        {
          kind: 'STATE_INVARIANT',
          invariantId: MAX_LEVERAGE,
          version: policy.ref.moduleVersion,
          scope: [{ domain: coreAccount.domain, kind: coreAccount.kind, localId: coreAccount.localId }],
          params: maxLeverageParams(scope.maxLeverage.numerator, scope.maxLeverage.scale),
        },
      ];
    },

    coreAction(candidate: ActionCandidate): CoreAction | null {
      if (candidate.kind !== 'PERP_OPEN' || candidate.account !== account) return null;
      const claim = claimOf(candidate.market);
      if (claim === null) return null;
      const market = marketResource(chain, claim.static.marketIndex);
      const acct = { domain: coreAccount.domain, kind: coreAccount.kind, localId: coreAccount.localId };
      return {
        actionType: ACTION_CREATE_ORDER,
        target: { domain: market.domain, kind: market.kind, localId: market.localId },
        resources: [acct],
        payload: encodeOrder({ account: acct, market, side: candidate.side === 'LONG' ? 'BUY' : 'SELL', baseAmount: candidate.size, price: candidate.price, execution: 'LIMIT_IOC', reduceOnly: false, orderExpiryMs: 0n }),
      };
    },

    states(_candidate: ActionCandidate, at: bigint): readonly SuppliedState[] {
      const src = config.policy.sources;
      const out: SuppliedState[] = [];
      for (const c of policy.claims) {
        const m = marketResource(chain, c.static.marketIndex);
        out.push(envelope(STATE_MARKET, { domain: m.domain, kind: m.kind, localId: m.localId }, encodeMarketStatic(c.static), src.market, { ladder: STATE_LADDER.ladder, level: 'SEQUENCED' }, at));
      }
      const prices = config.state.prices(at);
      const assets = new Map<string, CheckedClaim>();
      for (const c of policy.claims) assets.set(c.asset.localId, c);
      for (const k of [...assets.keys()].sort()) {
        const a = (assets.get(k) as CheckedClaim).asset;
        const price = prices.get(k);
        if (price === undefined) continue; // an absent price is an absent state: Core refuses STATE_MISSING
        const subject = { domain: a.domain, kind: a.kind, localId: a.localId };
        out.push(envelope(STATE_ASSET_PRICE, subject, encodeAssetPrice(subject, price), src.assetPrice, { ladder: PRICE_LADDER.ladder, level: 'PUBLISHED' }, at));
      }
      const book = config.state.book(at);
      out.push(envelope(STATE_ACCOUNT, book.account, encodeAccountBook(book), src.account, { ladder: STATE_LADDER.ladder, level: 'SEQUENCED' }, at));
      return out;
    },

    sources(): readonly StateSourceConfigInput[] {
      const src = config.policy.sources;
      const kinds = new Map<string, { domain: string; stateKind: string }[]>();
      const add = (id: string, stateKind: string) => kinds.set(id, [...(kinds.get(id) ?? []), { domain: LIGHTER_DOMAIN, stateKind }]);
      add(src.market, STATE_MARKET);
      add(src.account, STATE_ACCOUNT);
      add(src.assetPrice, STATE_ASSET_PRICE);
      return [...kinds.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([sourceId, k]) => ({ sourceId, trustClass: 'VERIFIED' as const, kinds: k }));
    },
  };
  return binding;
}
