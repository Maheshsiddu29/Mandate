/**
 * Trusted state: the observed world the verifier decides against.
 *
 * The verifier fetches nothing (design section 10.4). State is injected as an
 * immutable value, every field carries provenance and an observation time
 * (INV-17), and `UNKNOWN` is a value that flows through the types and causes a
 * rejection — never an exception a caller can catch and ignore (INV-5).
 *
 * Nothing here is Robinhood-shaped or Arbitrum-shaped. Phase 3 adapters
 * translate external data into these types; inventing issuer-specific fields
 * now would bake an unverified guess about that environment into the kernel.
 */

import { type Result, ok, err } from './result.ts';
import type { ReasonCodeName } from './reason-codes.ts';
import {
  parseIdentifier,
  parseCanonicalAssetId,
  type CanonicalAssetId,
  type ChainId,
  type Identifier,
  type IssuerId,
  type RepresentationId,
} from './identifiers.ts';
import { parsePrice, type Price } from './units.ts';
import { parseBigInt } from './time.ts';
import { parseObserved, type Observed } from './trust.ts';
import { parseBytes32, type Bytes32 } from './bytes.ts';
import { UINT64_MAX } from './mandate.ts';

export const STATE_SCHEMA_VERSION = 2;

/**
 * Bound on the representation collection.
 *
 * Chosen to equal the `u16` count the encoder writes, and matched to the
 * registry's own `MAX_SNAPSHOT_ENTRIES`. Before this bound existed the parser
 * accepted a collection the encoder could not represent, so `verify` threw from
 * `trustedStateDigest` instead of returning a verdict — the totality defect the
 * architecture pressure test found. The limit belongs at the parser, where the
 * refusal is a typed reason code.
 */
export const MAX_STATE_REPRESENTATIONS = 65_535;

/** Three-valued, because "we could not establish it" is a distinct answer from yes or no. */
export const TriState = { YES: 'YES', NO: 'NO', UNKNOWN: 'UNKNOWN' } as const;
export type TriState = (typeof TriState)[keyof typeof TriState];

export const OperationalState = {
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  TRANSITION: 'TRANSITION',
  DEPRECATED: 'DEPRECATED',
  UNKNOWN: 'UNKNOWN',
} as const;
export type OperationalState = (typeof OperationalState)[keyof typeof OperationalState];

export const HaltStatus = { TRADING: 'TRADING', HALTED: 'HALTED', UNKNOWN: 'UNKNOWN' } as const;
export type HaltStatus = (typeof HaltStatus)[keyof typeof HaltStatus];

export const ReplayStatus = {
  UNUSED: 'UNUSED',
  /** Reserved by an in-flight execution attempt. Not yet consumed, and not available. */
  RESERVED: 'RESERVED',
  CONSUMED: 'CONSUMED',
  /**
   * A reservation whose outcome was never established.
   *
   * Terminal for this authorization: an attempt that submitted and then lost
   * track of its transaction may still settle, so restoring permission would
   * authorize a second execution of a trade that already happened. The
   * authorization stays unavailable until reconciliation proves what occurred,
   * and reconciliation moves it to CONSUMED or UNUSED — a timer never does.
   */
  QUARANTINED: 'QUARANTINED',
  UNKNOWN: 'UNKNOWN',
} as const;
export type ReplayStatus = (typeof ReplayStatus)[keyof typeof ReplayStatus];

/**
 * What a registry asserts about one tokenized representation.
 *
 * The membership claim is deliberately weak (design section 5.4): `canonicalAsset`
 * means "issued against that underlying", and nothing more. It does not assert
 * that two representations of one underlying are fungible, interchangeable or
 * equally safe. Admissibility is decided against the mandate, here in the
 * kernel, where it can be checked and refused.
 */
export interface RepresentationState {
  readonly representationId: RepresentationId;
  readonly canonicalAsset: CanonicalAssetId;
  readonly issuer: IssuerId;
  readonly chain: ChainId;
  readonly instrumentType: Identifier | null;
  readonly synthetic: TriState;
  readonly operationalState: OperationalState;
}

export interface MarketState {
  readonly canonicalAsset: CanonicalAssetId;
  /** Null when no reference price could be established. Null is UNKNOWN, not zero. */
  readonly referencePrice: Price | null;
  readonly haltStatus: HaltStatus;
}

export interface CorporateActionState {
  readonly canonicalAsset: CanonicalAssetId;
  /** Null when the epoch could not be established. */
  readonly epoch: bigint | null;
}

export interface ReplayState {
  readonly mandateDigest: Bytes32;
  readonly status: ReplayStatus;
}

export interface TrustedState {
  readonly version: number;
  /**
   * Opaque label for the observed state snapshot.
   *
   * It is provenance, not an equality binding. Candidate V3 commits to the
   * label for audit, while verification re-evaluates dynamic facts and compares
   * the separately declared registry snapshot digest for structural identity.
   */
  readonly stateId: Identifier;
  /**
   * Digest of the registry snapshot the representation entries below were
   * derived from, or null when none was declared.
   *
   * The kernel carries it, includes it in its own digest and never interprets
   * it — it cannot, since it has no registry types. The router compares it
   * against the snapshot it evaluated, which is what stops an admissibility
   * decision and a semantics check reading two different registries.
   */
  readonly registrySnapshotDigest: Bytes32 | null;
  readonly representations: readonly Observed<RepresentationState>[];
  readonly market: Observed<MarketState> | null;
  readonly corporateAction: Observed<CorporateActionState> | null;
  readonly replay: Observed<ReplayState> | null;
}

function parseEnumValue<T extends string>(raw: unknown, values: Record<string, T>): Result<T, ReasonCodeName> {
  if (typeof raw !== 'string' || !Object.prototype.hasOwnProperty.call(values, raw)) {
    return err('MALFORMED_TRUSTED_STATE');
  }
  return ok(values[raw] as T);
}

export function parseRepresentationState(raw: unknown): Result<RepresentationState, ReasonCodeName> {
  if (typeof raw !== 'object' || raw === null) return err('MALFORMED_TRUSTED_STATE');
  const r = raw as Record<string, unknown>;
  const representationId = parseIdentifier(r['representationId']);
  if (!representationId.ok) return err('MALFORMED_TRUSTED_STATE');
  const canonicalAsset = parseCanonicalAssetId(r['canonicalAsset']);
  if (!canonicalAsset.ok) return err('MALFORMED_TRUSTED_STATE');
  const issuer = parseIdentifier(r['issuer']);
  if (!issuer.ok) return err('MALFORMED_TRUSTED_STATE');
  const chain = parseIdentifier(r['chain']);
  if (!chain.ok) return err('MALFORMED_TRUSTED_STATE');
  const rawInstrument = r['instrumentType'];
  let instrumentType: Identifier | null = null;
  if (rawInstrument !== null && rawInstrument !== undefined) {
    const parsed = parseIdentifier(rawInstrument);
    if (!parsed.ok) return err('MALFORMED_TRUSTED_STATE');
    instrumentType = parsed.value;
  }
  const synthetic = parseEnumValue(r['synthetic'], TriState);
  if (!synthetic.ok) return synthetic;
  const operationalState = parseEnumValue(r['operationalState'], OperationalState);
  if (!operationalState.ok) return operationalState;
  return ok({
    representationId: representationId.value,
    canonicalAsset: canonicalAsset.value,
    issuer: issuer.value,
    chain: chain.value,
    instrumentType,
    synthetic: synthetic.value,
    operationalState: operationalState.value,
  });
}

export function parseMarketState(raw: unknown): Result<MarketState, ReasonCodeName> {
  if (typeof raw !== 'object' || raw === null) return err('MALFORMED_TRUSTED_STATE');
  const r = raw as Record<string, unknown>;
  const canonicalAsset = parseCanonicalAssetId(r['canonicalAsset']);
  if (!canonicalAsset.ok) return err('MALFORMED_TRUSTED_STATE');
  const rawPrice = r['referencePrice'];
  let referencePrice: Price | null = null;
  if (rawPrice !== null && rawPrice !== undefined) {
    const parsed = parsePrice(rawPrice);
    if (!parsed.ok) return err('MALFORMED_TRUSTED_STATE');
    referencePrice = parsed.value;
  }
  const haltStatus = parseEnumValue(r['haltStatus'], HaltStatus);
  if (!haltStatus.ok) return haltStatus;
  return ok({ canonicalAsset: canonicalAsset.value, referencePrice, haltStatus: haltStatus.value });
}

export function parseCorporateActionState(raw: unknown): Result<CorporateActionState, ReasonCodeName> {
  if (typeof raw !== 'object' || raw === null) return err('MALFORMED_TRUSTED_STATE');
  const r = raw as Record<string, unknown>;
  const canonicalAsset = parseCanonicalAssetId(r['canonicalAsset']);
  if (!canonicalAsset.ok) return err('MALFORMED_TRUSTED_STATE');
  const rawEpoch = r['epoch'];
  let epoch: bigint | null = null;
  if (rawEpoch !== null && rawEpoch !== undefined) {
    const parsed = parseBigInt(rawEpoch);
    if (parsed === undefined) return err('MALFORMED_TRUSTED_STATE');
    if (parsed < 0n || parsed > UINT64_MAX) return err('VALUE_OUT_OF_RANGE');
    epoch = parsed;
  }
  return ok({ canonicalAsset: canonicalAsset.value, epoch });
}

export function parseReplayState(raw: unknown): Result<ReplayState, ReasonCodeName> {
  if (typeof raw !== 'object' || raw === null) return err('MALFORMED_TRUSTED_STATE');
  const r = raw as Record<string, unknown>;
  const mandateDigest = parseBytes32(r['mandateDigest'], 'MALFORMED_TRUSTED_STATE');
  if (!mandateDigest.ok) return mandateDigest;
  const status = parseEnumValue(r['status'], ReplayStatus);
  if (!status.ok) return status;
  return ok({ mandateDigest: mandateDigest.value, status: status.value });
}

export function parseTrustedState(raw: unknown): Result<TrustedState, ReasonCodeName> {
  if (typeof raw !== 'object' || raw === null) return err('MALFORMED_TRUSTED_STATE');
  const r = raw as Record<string, unknown>;

  const version = r['version'];
  if (typeof version !== 'number' || version !== STATE_SCHEMA_VERSION) return err('MALFORMED_TRUSTED_STATE');
  const stateId = parseIdentifier(r['stateId']);
  if (!stateId.ok) return err('MALFORMED_TRUSTED_STATE');

  const rawRegistryDigest = r['registrySnapshotDigest'];
  let registrySnapshotDigest: Bytes32 | null = null;
  if (rawRegistryDigest !== null && rawRegistryDigest !== undefined) {
    const parsed = parseBytes32(rawRegistryDigest, 'MALFORMED_TRUSTED_STATE');
    if (!parsed.ok) return parsed;
    registrySnapshotDigest = parsed.value;
  }

  const rawReps = r['representations'];
  if (!Array.isArray(rawReps)) return err('MALFORMED_TRUSTED_STATE');
  // Bounded before iteration: an oversized collection is refused rather than
  // parsed and then discovered to be unencodable.
  if (rawReps.length > MAX_STATE_REPRESENTATIONS) return err('RESOURCE_LIMIT_EXCEEDED');
  const representations: Observed<RepresentationState>[] = [];
  for (const entry of rawReps) {
    const parsed = parseObserved(entry, parseRepresentationState);
    if (!parsed.ok) return parsed;
    representations.push(parsed.value);
  }
  // Two entries for one representation would make admissibility depend on lookup
  // order. Reject rather than pick.
  const ids = representations.map((o) => o.value.representationId);
  if (new Set(ids).size !== ids.length) return err('MALFORMED_TRUSTED_STATE');

  const market = r['market'] == null ? null : parseObserved(r['market'], parseMarketState);
  if (market !== null && !market.ok) return market;
  const corporateAction = r['corporateAction'] == null ? null : parseObserved(r['corporateAction'], parseCorporateActionState);
  if (corporateAction !== null && !corporateAction.ok) return corporateAction;
  const replay = r['replay'] == null ? null : parseObserved(r['replay'], parseReplayState);
  if (replay !== null && !replay.ok) return replay;

  return ok({
    version,
    stateId: stateId.value,
    registrySnapshotDigest,
    representations,
    market: market === null ? null : market.value,
    corporateAction: corporateAction === null ? null : corporateAction.value,
    replay: replay === null ? null : replay.value,
  });
}

export function findRepresentation(
  state: TrustedState,
  id: RepresentationId,
): Observed<RepresentationState> | undefined {
  return state.representations.find((o) => o.value.representationId === id);
}
