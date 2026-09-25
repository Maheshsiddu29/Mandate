/**
 * Multi-representation adversarial worlds.
 *
 * The architecture pressure test found (finding F-10) that every end-to-end
 * corpus world carried exactly one representation, and that the only adversarial
 * mutation across them was a cheapest route from an unapproved issuer. So
 * "zero unsafe handoffs" was true and was measured in a world where
 * representation substitution — the thing INV-14 is about, and the reason this
 * system separates canonical identity from token identity at all — could not
 * occur.
 *
 * These worlds fix that. One canonical asset, five registered representations
 * across two chains with different backing, issuers and operational states, plus
 * probes for contracts nobody registered. Every route is a real
 * `ProviderRouteQuote` through the real router, and the mandate is really
 * signed, so nothing here is checked by a shortcut the production path does not
 * take.
 *
 * Everything is a synthetic fixture and is labelled as one. No number here is
 * claimed to be observed market data.
 */

import {
  mandateDigest,
  parseMandate,
  parseTrustedState,
  trustedStateDigest,
  type CanonicalMandate,
  type TrustedState,
} from '@mandate/kernel';
import {
  deriveRequirements,
  getRepresentation,
  openRegistry,
  registrySnapshotDigest,
  toRepresentationState,
  type Registry,
} from '@mandate/registry';
import {
  FIXTURE_ADDRESS_BACKED,
  FIXTURE_ADDRESS_OTHER_CHAIN,
  FIXTURE_ADDRESS_SECOND_BACKED,
  FIXTURE_ADDRESS_SYNTHETIC,
  FIXTURE_ADDRESS_UNREGISTERED,
  FIXTURE_ASSET_NVDA,
  FIXTURE_CHAIN_ARBITRUM,
  FIXTURE_CHAIN_ETHEREUM,
  FIXTURE_ISSUER_APPROVED,
  FIXTURE_ISSUER_SECONDARY,
  FIXTURE_ISSUER_UNAPPROVED,
  FIXTURE_NOW,
  FIXTURE_SOURCE_CHAIN_READ,
  FIXTURE_SOURCE_ISSUER_DOCS,
  FIXTURE_SOURCE_THIRD_PARTY,
  FIXTURE_VENUE,
  backedRepresentation,
  fixtureClaim,
  fixtureRepresentationId,
  fixtureSnapshot,
  fixtureVerified,
  nvdaAsset,
  secondBackedRepresentation,
  syntheticRepresentation,
} from '@mandate/registry/testing';
import { envelopeFor, TEST_PRIVATE_KEY, addressOf } from '../../../kernel/test/support/signing.ts';
import type { ProviderRouteQuote, RouteRequest, TrustedRouteCost } from '../../src/index.ts';

export const ADVERSARIAL_DOMAIN = {
  name: 'Mandate',
  version: '1',
  chainId: 42161n,
  verifyingContract: `0x${'00'.repeat(19)}01`,
} as const;

export const ADVERSARIAL_NOW = FIXTURE_NOW;
export const AGENT = { kind: 'eip155-address', value: `0x${'22'.repeat(20)}` } as const;

/** A paused representation from the approved issuer, on the permitted chain. */
const PAUSED_ADDRESS = `0x${'e5'.repeat(20)}`;
/** Two sources that disagree about the issuer of one contract. */
const CONFLICTED_ADDRESS = `0x${'f6'.repeat(20)}`;

export const REPRESENTATIONS = {
  /** Fully backed, approved issuer, Arbitrum. The one a correct mandate wants. */
  BACKED: fixtureRepresentationId(FIXTURE_ADDRESS_BACKED),
  /** A second fully backed note from the same issuer, also admissible. */
  SECOND_BACKED: fixtureRepresentationId(FIXTURE_ADDRESS_SECOND_BACKED),
  /** Synthetic exposure on the same underlying, from another issuer. */
  SYNTHETIC: fixtureRepresentationId(FIXTURE_ADDRESS_SYNTHETIC),
  /** Fully backed, but deployed on a chain the mandate does not permit. */
  OTHER_CHAIN: fixtureRepresentationId(FIXTURE_ADDRESS_OTHER_CHAIN, FIXTURE_CHAIN_ETHEREUM),
  /** Registered, approved, and not currently operating. */
  PAUSED: fixtureRepresentationId(PAUSED_ADDRESS),
  /** Registered, with two verified sources naming different issuers. */
  CONFLICTED: fixtureRepresentationId(CONFLICTED_ADDRESS),
  /** The right symbol, the right claimed underlying, and no registry entry. */
  COUNTERFEIT: fixtureRepresentationId(FIXTURE_ADDRESS_UNREGISTERED),
} as const;

function otherChainRepresentation(): Record<string, unknown> {
  return backedRepresentation({
    representationId: fixtureRepresentationId(FIXTURE_ADDRESS_OTHER_CHAIN, FIXTURE_CHAIN_ETHEREUM),
    display: { tokenSymbol: 'FXNVDE', tokenName: 'Fixture Backed NVDA Note (Ethereum)' },
  });
}

function pausedRepresentation(): Record<string, unknown> {
  return backedRepresentation({
    representationId: fixtureRepresentationId(PAUSED_ADDRESS),
    display: { tokenSymbol: 'FXNVDP', tokenName: 'Fixture Backed NVDA Note (paused)' },
    operationalStatus: fixtureVerified('PAUSED', FIXTURE_SOURCE_CHAIN_READ),
  });
}

/**
 * One contract, two sources at the trust floor naming different issuers.
 *
 * A conflict fails closed unconditionally — no most-recent-wins, no trust
 * precedence — which is what this world exists to demonstrate end to end rather
 * than only in a registry unit test.
 */
function conflictedRepresentation(): Record<string, unknown> {
  return backedRepresentation({
    representationId: fixtureRepresentationId(CONFLICTED_ADDRESS),
    display: { tokenSymbol: 'FXNVDC', tokenName: 'Fixture Backed NVDA Note (disputed)' },
    issuer: [
      ...fixtureVerified(FIXTURE_ISSUER_APPROVED, FIXTURE_SOURCE_ISSUER_DOCS),
      ...fixtureVerified(FIXTURE_ISSUER_SECONDARY, FIXTURE_SOURCE_CHAIN_READ),
    ],
  });
}

/**
 * A stale claim beside a fresh one, both at the trust floor and agreeing.
 *
 * Mixing ages is the case that distinguishes "the registry has old data" from
 * "the registry has wrong data": an old claim that agrees is not a conflict, and
 * a fresh claim that agrees still establishes the value.
 */
function staleAndFreshBacked(): Record<string, unknown> {
  return backedRepresentation({
    backing: [
      // A day old, from a third-party feed, and agreeing.
      fixtureClaim('FULLY_BACKED', 'VERIFIED', FIXTURE_SOURCE_THIRD_PARTY, 86_400n),
      ...fixtureVerified('FULLY_BACKED', FIXTURE_SOURCE_CHAIN_READ),
    ],
  });
}

export interface AdversarialWorldOptions {
  /** Replace the baseline backed note with one carrying mixed-age claims. */
  readonly mixedAgeClaims?: boolean;
}

export function adversarialRegistry(options: AdversarialWorldOptions = {}): Registry {
  const snapshot = fixtureSnapshot({
    snapshotId: 'fixture.snapshot.adversarial',
    assets: [nvdaAsset()],
    representations: [
      options.mixedAgeClaims === true ? staleAndFreshBacked() : backedRepresentation(),
      secondBackedRepresentation(),
      syntheticRepresentation(),
      otherChainRepresentation(),
      pausedRepresentation(),
      conflictedRepresentation(),
    ],
  });
  const opened = openRegistry(snapshot);
  if (!opened.ok) throw new Error(`adversarial registry did not open: ${opened.error}`);
  return opened.value;
}

/** 100.00 USD per share, at 2 decimals; 10 shares. */
export const REFERENCE_PRICE = { numeratorUnit: 'USD', denominatorUnit: 'SHARE', decimals: 2, atoms: 10_000n } as const;
export const QUANTITY = { unit: 'SHARE', decimals: 2, atoms: 1_000n } as const;
export const NOTIONAL = { unit: 'USD', decimals: 2, atoms: 100_000n } as const;

export interface MandateOptions {
  readonly side?: 'BUY' | 'SELL';
  /** BUY: maximum total debit. SELL: minimum total credit. */
  readonly economicLimitAtoms?: bigint;
  readonly syntheticPolicy?: 'FORBIDDEN' | 'ALLOWED';
  readonly allowedChains?: readonly string[];
  readonly allowedIssuers?: readonly string[];
  readonly requiredCorporateActionEpoch?: bigint;
  readonly maxDeviationBps?: bigint;
}

export function adversarialMandate(options: MandateOptions = {}): CanonicalMandate {
  const side = options.side ?? 'BUY';
  const raw = {
    version: 2,
    mandateId: `0x${'33'.repeat(32)}`,
    nonce: 1n,
    principal: { kind: 'eip155-address', value: addressOf(TEST_PRIVATE_KEY) },
    agent: { ...AGENT },
    canonicalAsset: { ...FIXTURE_ASSET_NVDA },
    side,
    maxNotional: { unit: 'USD', decimals: 2, atoms: 200_000n },
    economicLimit: {
      unit: 'USD',
      decimals: 2,
      atoms: options.economicLimitAtoms ?? (side === 'BUY' ? 101_000n : 99_000n),
    },
    maxDeviationBps: options.maxDeviationBps ?? 50n,
    syntheticPolicy: options.syntheticPolicy ?? 'FORBIDDEN',
    allowedIssuers: options.allowedIssuers ?? [FIXTURE_ISSUER_APPROVED],
    allowedChains: options.allowedChains ?? [FIXTURE_CHAIN_ARBITRUM],
    allowedVenues: [FIXTURE_VENUE],
    requiredCorporateActionEpoch: options.requiredCorporateActionEpoch ?? 7n,
    maxPriceAgeSeconds: 60n,
    maxCorporateActionAgeSeconds: 300n,
    haltPolicy: 'FORBID_WHEN_HALTED',
    createdAtUnixSeconds: ADVERSARIAL_NOW - 600n,
    notBeforeUnixSeconds: ADVERSARIAL_NOW - 600n,
    expiresAtUnixSeconds: ADVERSARIAL_NOW + 600n,
  };
  const parsed = parseMandate(raw);
  if (!parsed.ok) throw new Error(`adversarial mandate failed to parse: ${parsed.error}`);
  return parsed.value;
}

export interface StateOptions {
  readonly haltStatus?: 'TRADING' | 'HALTED' | 'UNKNOWN';
  readonly epoch?: bigint;
  readonly referencePriceAtoms?: bigint;
  readonly observedAtUnixSeconds?: bigint;
  /** Omit the registry binding, for worlds about the binding itself. */
  readonly unbound?: boolean;
}

/**
 * Kernel trusted state for every representation the registry can establish.
 *
 * Built through `toRepresentationState`, so a representation the registry
 * refuses to translate — the conflicted one — is simply absent, exactly as it
 * would be in production.
 */
export function adversarialState(
  registry: Registry,
  mandate: CanonicalMandate,
  options: StateOptions = {},
): TrustedState {
  const requirements = deriveRequirements(mandate, { nowUnixSeconds: ADVERSARIAL_NOW });
  if (!requirements.ok) throw new Error(`requirements failed: ${requirements.error}`);

  const observedAt = options.observedAtUnixSeconds ?? ADVERSARIAL_NOW - 5n;
  const provenance = { trustClass: 'VERIFIED', sourceId: 'fixture.adversarial', observedAtUnixSeconds: observedAt };
  const representations: unknown[] = [];
  for (const record of registry.snapshot.representations) {
    const found = getRepresentation(registry, record.representationId.value);
    if (found === undefined) continue;
    const state = toRepresentationState(found, requirements.value);
    // A representation whose metadata the registry cannot establish never
    // reaches the kernel. That is the behaviour, not an omission.
    if (state.ok) representations.push(state.value);
  }

  const raw = {
    version: 2,
    stateId: 'fixture.adversarial.state',
    registrySnapshotDigest: options.unbound === true ? null : registrySnapshotDigest(registry.snapshot),
    representations,
    market: {
      provenance,
      value: {
        canonicalAsset: { ...FIXTURE_ASSET_NVDA },
        referencePrice: { ...REFERENCE_PRICE, atoms: options.referencePriceAtoms ?? REFERENCE_PRICE.atoms },
        haltStatus: options.haltStatus ?? 'TRADING',
      },
    },
    corporateAction: {
      provenance,
      value: { canonicalAsset: { ...FIXTURE_ASSET_NVDA }, epoch: options.epoch ?? 7n },
    },
    replay: {
      provenance,
      value: { mandateDigest: mandateDigest(mandate), status: 'UNUSED' },
    },
  };
  const parsed = parseTrustedState(raw);
  if (!parsed.ok) throw new Error(`adversarial state failed to parse: ${parsed.error}`);
  return parsed.value;
}

export interface QuoteOptions {
  readonly routeId: string;
  readonly representationId: string;
  readonly chain?: string;
  readonly issuer?: string;
  readonly side?: 'BUY' | 'SELL';
  readonly feeAtoms?: bigint;
  readonly priceAtoms?: bigint;
  readonly venue?: string;
  readonly corporateActionEpoch?: bigint;
  readonly quantityAtoms?: bigint;
}

export function adversarialQuote(state: TrustedState, options: QuoteOptions): ProviderRouteQuote {
  const priceAtoms = options.priceAtoms ?? REFERENCE_PRICE.atoms;
  const quantityAtoms = options.quantityAtoms ?? QUANTITY.atoms;
  const chain = options.chain ?? FIXTURE_CHAIN_ARBITRUM;
  const zero = { unit: 'USD', decimals: 2, atoms: 0n };
  const fee = { unit: 'USD', decimals: 2, atoms: options.feeAtoms ?? 0n };
  return {
    version: 1,
    routeId: options.routeId,
    providerId: 'provider.adversarial',
    providerClass: 'SYNTHETIC_TEST',
    canonicalAsset: { ...FIXTURE_ASSET_NVDA },
    representationId: options.representationId,
    issuer: options.issuer ?? FIXTURE_ISSUER_APPROVED,
    chain,
    venue: options.venue ?? FIXTURE_VENUE,
    side: options.side ?? 'BUY',
    agent: { ...AGENT },
    quantity: { ...QUANTITY, atoms: quantityAtoms },
    executionPrice: { ...REFERENCE_PRICE, atoms: priceAtoms },
    notional: { ...NOTIONAL, atoms: (quantityAtoms * priceAtoms) / 100n },
    quoteObservedAtUnixSeconds: ADVERSARIAL_NOW,
    fillPolicy: 'FILL_OR_KILL',
    costs: { venueFee: fee, executionFee: zero, settlementFee: zero, routeFee: zero },
    steps: [{ kind: 'TRADE', venue: options.venue ?? FIXTURE_VENUE, chain, representationId: options.representationId }],
    referenceStateId: state.stateId,
    corporateActionEpoch: options.corporateActionEpoch ?? 7n,
  } as unknown as ProviderRouteQuote;
}

export function trustedCostFor(quote: ProviderRouteQuote): TrustedRouteCost {
  return {
    routeId: quote.routeId,
    costs: quote.costs,
    provenanceSourceId: 'fixture.adversarial.costs',
    observedAtUnixSeconds: ADVERSARIAL_NOW,
  };
}

export interface WorldRequest {
  readonly request: RouteRequest;
  readonly handoff: { readonly trustedMarketState: unknown; readonly clock: unknown };
  readonly mandate: CanonicalMandate;
  readonly state: TrustedState;
  readonly registry: Registry;
}

export function adversarialRequest(input: {
  readonly mandate?: CanonicalMandate;
  readonly registry?: Registry;
  readonly state?: TrustedState;
  readonly quotes: (state: TrustedState) => readonly ProviderRouteQuote[];
  readonly handoffState?: TrustedState;
  readonly handoffAtUnixSeconds?: bigint;
  readonly quantityAtoms?: bigint;
}): WorldRequest {
  const registry = input.registry ?? adversarialRegistry();
  const mandate = input.mandate ?? adversarialMandate();
  const state = input.state ?? adversarialState(registry, mandate);
  const quotes = input.quotes(state);
  return {
    registry,
    mandate,
    state,
    request: {
      mandate,
      authorization: envelopeFor(mandateDigest(mandate), TEST_PRIVATE_KEY, ADVERSARIAL_DOMAIN),
      registry,
      trustedMarketState: state,
      requestedQuantity: { ...QUANTITY, atoms: input.quantityAtoms ?? QUANTITY.atoms },
      routes: quotes,
      trustedCosts: quotes.map(trustedCostFor),
      clock: { nowUnixSeconds: ADVERSARIAL_NOW },
      expectedDomain: ADVERSARIAL_DOMAIN,
    },
    handoff: {
      trustedMarketState: input.handoffState ?? state,
      clock: { nowUnixSeconds: input.handoffAtUnixSeconds ?? ADVERSARIAL_NOW },
    },
  };
}

export { FIXTURE_CHAIN_ETHEREUM, FIXTURE_ISSUER_UNAPPROVED, FIXTURE_ISSUER_SECONDARY, trustedStateDigest };
