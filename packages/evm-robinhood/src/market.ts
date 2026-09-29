/**
 * Reviewed gate markets (Phase 7E.3).
 *
 * A `ReviewedMarket` is what a deployment review recorded about one market of
 * one deployed `MandateExecutionGate`: the constructor configuration it was
 * built from, the pinned decimals it read, and the venue and adapter it
 * created. GateSpotPolicy's meaning — which token, at which immutable price,
 * settling which unit — is exactly this record, so it is part of the module's
 * digest (DOM-2), and the chain's view of the market must reproduce it byte
 * for byte before any decision relies on it (`reviewedSnapshot`).
 *
 * Nothing here is inferred from a ticker or a symbol. The canonical asset is
 * the one the gate pins, and a fixture market says so in its canonical asset.
 */

import { ByteWriter, bytesToHex, keccak256 } from '@mandate/kernel';
import { keccak_256 } from '@noble/hashes/sha3.js';
import type { GateAsset, GateDeployment, GateMarket } from '@mandate/execution-gate';
import { ADDRESS, ceilDiv, marketResource, type Address, type GateMarketSnapshot } from './vocabulary.ts';
import type { ResourceIdInput } from '@mandate/core';

export interface ReviewedMarket {
  readonly representation: Address;
  readonly fundingToken: Address;
  /** The `FixtureVenueAdapter` the gate's constructor created. */
  readonly adapter: Address;
  /** The `FixtureVenue` the gate's constructor created. */
  readonly venue: Address;
  readonly representationDecimals: number;
  readonly fundingDecimals: number;
  readonly canonicalAsset: GateAsset;
  readonly issuer: string;
  /** The market's venue identifier (the gate's `venue` string), not the venue contract. */
  readonly venueId: string;
  readonly quantityUnit: string;
  /** The unit the funding token is declared to settle (execution-gate.md §6): a declared assumption. */
  readonly settlementUnit: string;
  readonly synthetic: boolean;
  /** `settlementUnit` per whole `quantityUnit`, at `decimals`. */
  readonly fixturePrice: { readonly decimals: number; readonly atoms: bigint };
  readonly feeBps: number;
}

export interface ReviewedGate {
  readonly chainId: bigint;
  readonly gate: Address;
  readonly markets: readonly ReviewedMarket[];
}

const IDENT = /^[A-Za-z0-9](?:[A-Za-z0-9._\-:/]{0,126}[A-Za-z0-9])?$/;

/** Why a reviewed record cannot describe a market the frozen gate would have built, or `null`. */
export function checkReviewedMarket(m: ReviewedMarket): string | null {
  for (const a of [m.representation, m.fundingToken, m.adapter, m.venue]) if (!ADDRESS.test(a)) return 'ADDRESS_NOT_LOWERCASE';
  if (m.representation === m.fundingToken) return 'REPRESENTATION_IS_FUNDING';
  for (const s of [m.canonicalAsset.assetClass, m.canonicalAsset.idScheme, m.canonicalAsset.value, m.issuer, m.venueId, m.quantityUnit, m.settlementUnit]) if (!IDENT.test(s)) return 'IDENTIFIER_INVALID';
  for (const d of [m.representationDecimals, m.fundingDecimals, m.fixturePrice.decimals]) if (!Number.isInteger(d) || d < 0 || d > 38) return 'DECIMALS_OUT_OF_RANGE';
  if (m.fixturePrice.atoms <= 0n) return 'PRICE_NOT_POSITIVE';
  if (!Number.isInteger(m.feeBps) || m.feeBps < 0 || m.feeBps >= 10_000) return 'FEE_OUT_OF_RANGE';
  // The gate refuses a typed price its funding token cannot express exactly (FixturePriceNotRepresentable).
  if (venuePrice(m) === null) return 'PRICE_NOT_REPRESENTABLE';
  return null;
}

/** Funding-token atoms per whole representation token: the one price the gate writes into its venue. */
export function venuePrice(m: ReviewedMarket): bigint | null {
  const p = m.fixturePrice;
  if (m.fundingDecimals >= p.decimals) return p.atoms * 10n ** BigInt(m.fundingDecimals - p.decimals);
  const d = 10n ** BigInt(p.decimals - m.fundingDecimals);
  return p.atoms % d === 0n ? p.atoms / d : null;
}

/** Gross funding atoms for `quantity` at the venue price, rounded up — `FixtureVenue.quoteBuy` before its fee. */
export function grossCost(m: ReviewedMarket, quantity: bigint): bigint {
  return ceilDiv(quantity * (venuePrice(m) as bigint), 10n ** BigInt(m.representationDecimals));
}

/** The venue's fee on a gross cost, rounded up. */
export function feeOn(m: ReviewedMarket, gross: bigint): bigint {
  return ceilDiv(gross * BigInt(m.feeBps), 10_000n);
}

/** Exactly what `FixtureVenue.quoteBuy(quantity)` returns: the principal's worst-case debit. */
export function buyCost(m: ReviewedMarket, quantity: bigint): bigint {
  const gross = grossCost(m, quantity);
  return gross + feeOn(m, gross);
}

export function assetHash(a: GateAsset): string {
  return keccak256(new ByteWriter().str(a.assetClass).str(a.idScheme).str(a.value).finish());
}

function textHash(s: string): string {
  return bytesToHex(keccak_256(new TextEncoder().encode(s)));
}

/** What the chain must report for this market: the payload the policy pins by digest. */
export function reviewedSnapshot(chainId: bigint, gate: Address, m: ReviewedMarket): GateMarketSnapshot {
  return {
    chainId,
    gate,
    representation: m.representation,
    fundingToken: m.fundingToken,
    adapter: m.adapter,
    venue: m.venue,
    representationDecimals: m.representationDecimals,
    fundingDecimals: m.fundingDecimals,
    synthetic: m.synthetic,
    classification: 1,
    canonicalAssetHash: assetHash(m.canonicalAsset),
    issuerHash: textHash(m.issuer),
    venueHash: textHash(m.venueId),
    quantityUnitHash: textHash(m.quantityUnit),
    settlementUnitHash: textHash(m.settlementUnit),
    fixturePriceDecimals: m.fixturePrice.decimals,
    fixturePriceAtoms: m.fixturePrice.atoms,
    feeBps: m.feeBps,
  };
}

/** The canonical asset as a Core resource: `<assetClass>:<idScheme>:<value>` in the registry domain. */
export function canonicalAssetResource(a: GateAsset): ResourceIdInput {
  return { domain: 'registry', kind: 'CANONICAL_ASSET', localId: `${a.assetClass}:${a.idScheme}:${a.value}` };
}

/** The reviewed gate in the execution-gate reference model's shape. */
export function gateDeploymentOf(g: ReviewedGate): GateDeployment {
  return {
    chainId: g.chainId,
    gate: g.gate,
    markets: g.markets.map(
      (m): GateMarket => ({
        representation: m.representation,
        fundingToken: m.fundingToken,
        adapter: m.adapter,
        representationDecimals: m.representationDecimals,
        fundingDecimals: m.fundingDecimals,
        canonicalAsset: m.canonicalAsset,
        issuer: m.issuer,
        venue: m.venueId,
        quantityUnit: m.quantityUnit,
        settlementUnit: m.settlementUnit,
        synthetic: m.synthetic,
        classification: 'FIXTURE',
        fixturePrice: { numeratorUnit: m.settlementUnit, denominatorUnit: m.quantityUnit, decimals: m.fixturePrice.decimals, atoms: m.fixturePrice.atoms },
      }),
    ),
  };
}

export function reviewedMarketFor(g: ReviewedGate, representation: Address): ReviewedMarket | null {
  return g.markets.find((m) => m.representation === representation) ?? null;
}

export { marketResource };
