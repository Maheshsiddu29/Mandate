/**
 * Representation requirements: the constraints a representation is evaluated
 * against.
 *
 * The Phase 1 mandate schema is frozen, and deliberately so: it carries canonical
 * asset, issuer allowlist, chain allowlist and synthetic policy, but not backing,
 * rights, redemption, settlement or jurisdiction constraints, which design
 * section 7.3 marks long-term. Adding them to the mandate would change the signed
 * digest and could widen the authority of mandates already issued.
 *
 * So requirements are split:
 *
 * ```
 * deriveRequirements(mandate)          exactly the signed mandate's constraints
 * narrowRequirements(base, extra)      institutional policy — can only tighten
 * ```
 *
 * **An additional requirement is not an authorization.** It can add an exclusion
 * and can never create one, and `narrowRequirements` returns an error rather than
 * silently ignoring an attempt to widen. The signed mandate is always the floor.
 * There is no exported way to build a requirements object from nothing, so
 * admissibility cannot be evaluated against constraints no principal signed.
 */

import {
  err,
  ok,
  parseIdentifier,
  SyntheticPolicy,
  TrustClass,
  type CanonicalMandate,
  type ChainId,
  type IssuerId,
  type Result,
  type UnixSeconds,
} from '@mandate/kernel';
import type { RegistryReasonCodeName } from './reason-codes.ts';
import { canonicalAssetKey, validateCanonicalAssetId, type ValidatedCanonicalAssetId } from './asset-id.ts';
import { EXECUTION_TRUST_FLOOR, meetsTrustFloor, type ClaimPolicy } from './claims.ts';
import {
  BackingModel,
  CorporateActionModel,
  InstrumentType,
  parseEnumFromVocabulary,
  parseJurisdiction,
  RedemptionModel,
  RightKind,
  RightState,
  SettlementModel,
  type Jurisdiction,
} from './semantics.ts';

/** A right the requirements demand, and the states that satisfy the demand. */
export interface RequiredRight {
  readonly kind: RightKind;
  /** Any of these satisfies it. An unestablished right never does. */
  readonly acceptable: readonly RightState[];
}

declare const RequirementsBrand: unique symbol;

/**
 * Constraints to evaluate a representation against.
 *
 * Two different meanings of "no constraint", and the difference matters:
 *
 * - **`null`** on an optional field means *this requirements object does not
 *   constrain that property*. Used where the signed mandate says nothing.
 * - **`[]`** means *nothing is permitted*, following the mandate schema's
 *   allowlist rule (design section 7.4, rule 2). An empty allowlist is never read
 *   as unconstrained.
 *
 * The mandate-derived allowlists carry the kernel's semantics exactly: empty
 * permits nothing.
 */
export interface RepresentationRequirements {
  readonly [RequirementsBrand]?: true;

  // --- from the signed mandate --------------------------------------------
  readonly canonicalAsset: ValidatedCanonicalAssetId;
  readonly allowedIssuers: readonly IssuerId[];
  readonly allowedChains: readonly ChainId[];
  readonly syntheticPolicy: SyntheticPolicy;

  // --- institutional policy: narrowing only, never authorization -----------
  readonly allowedInstrumentTypes: readonly InstrumentType[] | null;
  readonly allowedBackingModels: readonly BackingModel[] | null;
  readonly allowedRedemptionModels: readonly RedemptionModel[] | null;
  readonly requiredRights: readonly RequiredRight[];
  readonly allowedCorporateActionModels: readonly CorporateActionModel[] | null;
  readonly allowedSettlementModels: readonly SettlementModel[] | null;
  readonly holderJurisdiction: Jurisdiction | null;

  // --- evaluation context, not authority ----------------------------------
  readonly minimumTrust: TrustClass;
  readonly maxClaimAgeSeconds: bigint | null;
  readonly nowUnixSeconds: UnixSeconds;
}

/**
 * Evaluation context.
 *
 * Not authority: the mandate does not bound metadata freshness (it bounds price
 * and corporate-action freshness, which are state, not metadata — design
 * section 6.5), so the caller supplies the metadata bound it needs.
 */
export interface EvaluationContext {
  readonly nowUnixSeconds: UnixSeconds;
  readonly maxClaimAgeSeconds?: bigint | null;
  readonly minimumTrust?: TrustClass;
}

/**
 * Derive requirements from a signed mandate.
 *
 * Nothing is inferred and nothing is defaulted in a permissive direction: every
 * field either comes from the mandate or is `null`, meaning this object does not
 * constrain it.
 */
export function deriveRequirements(
  mandate: CanonicalMandate,
  context: EvaluationContext,
): Result<RepresentationRequirements, RegistryReasonCodeName> {
  const canonicalAsset = validateCanonicalAssetId(mandate.canonicalAsset);
  if (!canonicalAsset.ok) return canonicalAsset;
  const minimumTrust = context.minimumTrust ?? EXECUTION_TRUST_FLOOR;
  // A floor below the execution floor would let advisory data establish a property
  // that gates an execution, which is the rule ADR 0006 exists to enforce.
  if (!meetsTrustFloor(minimumTrust, EXECUTION_TRUST_FLOOR)) return err('TRUST_REQUIREMENT_NOT_MET');
  const maxClaimAgeSeconds = context.maxClaimAgeSeconds ?? null;
  if (maxClaimAgeSeconds !== null && maxClaimAgeSeconds < 0n) return err('SNAPSHOT_MALFORMED');

  return ok({
    canonicalAsset: canonicalAsset.value,
    allowedIssuers: mandate.allowedIssuers,
    allowedChains: mandate.allowedChains,
    syntheticPolicy: mandate.syntheticPolicy,
    allowedInstrumentTypes: null,
    allowedBackingModels: null,
    allowedRedemptionModels: null,
    requiredRights: [],
    allowedCorporateActionModels: null,
    allowedSettlementModels: null,
    holderJurisdiction: null,
    minimumTrust,
    maxClaimAgeSeconds,
    nowUnixSeconds: context.nowUnixSeconds,
  });
}

/**
 * Institutional policy to layer on top of a mandate.
 *
 * Every field is optional, and supplying one can only add exclusions.
 */
export interface AdditionalRequirements {
  readonly allowedIssuers?: readonly string[];
  readonly allowedChains?: readonly string[];
  readonly forbidSynthetic?: boolean;
  readonly allowedInstrumentTypes?: readonly InstrumentType[];
  readonly allowedBackingModels?: readonly BackingModel[];
  readonly allowedRedemptionModels?: readonly RedemptionModel[];
  readonly requiredRights?: readonly RequiredRight[];
  readonly allowedCorporateActionModels?: readonly CorporateActionModel[];
  readonly allowedSettlementModels?: readonly SettlementModel[];
  /**
   * A plain string, validated by `narrowRequirements`. Not the branded
   * `Jurisdiction`: a caller has no way to construct a branded value, and an API
   * that demands one it cannot produce is not an API.
   */
  readonly holderJurisdiction?: string;
  readonly minimumTrust?: TrustClass;
  readonly maxClaimAgeSeconds?: bigint;
}

function intersectOrAdopt<T>(base: readonly T[] | null, extra: readonly T[] | undefined): readonly T[] | null {
  if (extra === undefined) return base;
  if (base === null) return [...extra];
  // Intersection: a value must satisfy both, so the result is never wider than
  // either side.
  return base.filter((v) => extra.includes(v));
}

/**
 * Narrow a requirements object.
 *
 * Every operation is an intersection, a maximum, a minimum or a one-way policy
 * flip, so the admissible set can only shrink. An attempt to *change* rather than
 * tighten — a different canonical asset, a different holder jurisdiction, a lower
 * trust floor, a longer claim age — is an error, because silently ignoring it
 * would let a caller believe a constraint had been applied when it had not.
 */
export function narrowRequirements(
  base: RepresentationRequirements,
  additional: AdditionalRequirements,
): Result<RepresentationRequirements, RegistryReasonCodeName> {
  let allowedIssuers = base.allowedIssuers;
  if (additional.allowedIssuers !== undefined) {
    const parsed: IssuerId[] = [];
    for (const raw of additional.allowedIssuers) {
      const id = parseIdentifier(raw);
      if (!id.ok) return err('SNAPSHOT_MALFORMED');
      parsed.push(id.value);
    }
    allowedIssuers = allowedIssuers.filter((i) => parsed.includes(i));
  }

  let allowedChains = base.allowedChains;
  if (additional.allowedChains !== undefined) {
    const parsed: ChainId[] = [];
    for (const raw of additional.allowedChains) {
      const id = parseIdentifier(raw);
      if (!id.ok) return err('SNAPSHOT_MALFORMED');
      parsed.push(id.value);
    }
    allowedChains = allowedChains.filter((c) => parsed.includes(c));
  }

  // One-way: a mandate that forbids synthetics can never be relaxed to allow them.
  const syntheticPolicy =
    additional.forbidSynthetic === true ? SyntheticPolicy.FORBIDDEN : base.syntheticPolicy;

  let minimumTrust = base.minimumTrust;
  if (additional.minimumTrust !== undefined) {
    if (!meetsTrustFloor(additional.minimumTrust, base.minimumTrust)) {
      return err('TRUST_REQUIREMENT_NOT_MET');
    }
    minimumTrust = additional.minimumTrust;
  }

  let maxClaimAgeSeconds = base.maxClaimAgeSeconds;
  if (additional.maxClaimAgeSeconds !== undefined) {
    if (additional.maxClaimAgeSeconds < 0n) return err('SNAPSHOT_MALFORMED');
    // null is unbounded, so any explicit bound tightens it; otherwise take the
    // smaller of the two.
    maxClaimAgeSeconds =
      maxClaimAgeSeconds === null
        ? additional.maxClaimAgeSeconds
        : additional.maxClaimAgeSeconds < maxClaimAgeSeconds
          ? additional.maxClaimAgeSeconds
          : maxClaimAgeSeconds;
  }

  let holderJurisdiction = base.holderJurisdiction;
  if (additional.holderJurisdiction !== undefined) {
    const j = parseJurisdiction(additional.holderJurisdiction);
    if (!j.ok) return j;
    // Replacing one jurisdiction with another is neither narrower nor wider; it
    // is a different question, and answering it silently would be wrong.
    if (holderJurisdiction !== null && holderJurisdiction !== j.value) {
      return err('JURISDICTION_NOT_ELIGIBLE');
    }
    holderJurisdiction = j.value;
  }

  // More required rights is narrower, so rights union rather than intersect.
  const requiredRights: RequiredRight[] = [...base.requiredRights];
  for (const right of additional.requiredRights ?? []) {
    const existing = requiredRights.findIndex((r) => r.kind === right.kind);
    if (existing < 0) {
      requiredRights.push(right);
    } else {
      const previous = requiredRights[existing] as RequiredRight;
      // Both demands must hold, so the acceptable set intersects.
      requiredRights[existing] = {
        kind: right.kind,
        acceptable: previous.acceptable.filter((s) => right.acceptable.includes(s)),
      };
    }
  }
  requiredRights.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

  return ok({
    canonicalAsset: base.canonicalAsset,
    allowedIssuers,
    allowedChains,
    syntheticPolicy,
    allowedInstrumentTypes: intersectOrAdopt(base.allowedInstrumentTypes, additional.allowedInstrumentTypes),
    allowedBackingModels: intersectOrAdopt(base.allowedBackingModels, additional.allowedBackingModels),
    allowedRedemptionModels: intersectOrAdopt(base.allowedRedemptionModels, additional.allowedRedemptionModels),
    requiredRights,
    allowedCorporateActionModels: intersectOrAdopt(
      base.allowedCorporateActionModels,
      additional.allowedCorporateActionModels,
    ),
    allowedSettlementModels: intersectOrAdopt(base.allowedSettlementModels, additional.allowedSettlementModels),
    holderJurisdiction,
    minimumTrust,
    maxClaimAgeSeconds,
    nowUnixSeconds: base.nowUnixSeconds,
  });
}

/** The claim policy these requirements imply. */
export function claimPolicyOf(requirements: RepresentationRequirements): ClaimPolicy {
  return {
    minimumTrust: requirements.minimumTrust,
    nowUnixSeconds: requirements.nowUnixSeconds,
    maxClaimAgeSeconds: requirements.maxClaimAgeSeconds,
  };
}

/**
 * Parse an `AdditionalRequirements` from untrusted input.
 *
 * Exists so a decision vector can carry institutional policy as data. It produces
 * only the *additional* half — there is deliberately no parser that produces a
 * whole requirements object, because that would be a way to evaluate
 * admissibility against constraints no mandate authorized.
 */
export function parseAdditionalRequirements(
  raw: unknown,
): Result<AdditionalRequirements, RegistryReasonCodeName> {
  if (raw === undefined || raw === null) return ok({});
  if (typeof raw !== 'object' || Array.isArray(raw)) return err('SNAPSHOT_MALFORMED');
  const r = raw as Record<string, unknown>;
  const known = [
    'allowedIssuers', 'allowedChains', 'forbidSynthetic', 'allowedInstrumentTypes',
    'allowedBackingModels', 'allowedRedemptionModels', 'requiredRights',
    'allowedCorporateActionModels', 'allowedSettlementModels', 'holderJurisdiction',
    'minimumTrust', 'maxClaimAgeSeconds',
  ];
  for (const k of Object.keys(r)) if (!known.includes(k)) return err('SNAPSHOT_MALFORMED');

  const out: Record<string, unknown> = {};

  for (const field of ['allowedIssuers', 'allowedChains'] as const) {
    const v = r[field];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return err('SNAPSHOT_MALFORMED');
    out[field] = v;
  }

  if (r['forbidSynthetic'] !== undefined) {
    if (typeof r['forbidSynthetic'] !== 'boolean') return err('SNAPSHOT_MALFORMED');
    out['forbidSynthetic'] = r['forbidSynthetic'];
  }

  const enumLists: readonly [string, Record<string, string>][] = [
    ['allowedInstrumentTypes', InstrumentType],
    ['allowedBackingModels', BackingModel],
    ['allowedRedemptionModels', RedemptionModel],
    ['allowedCorporateActionModels', CorporateActionModel],
    ['allowedSettlementModels', SettlementModel],
  ];
  for (const [field, vocabulary] of enumLists) {
    const v = r[field];
    if (v === undefined) continue;
    if (!Array.isArray(v)) return err('SNAPSHOT_MALFORMED');
    const parsed: string[] = [];
    for (const entry of v) {
      const e = parseEnumFromVocabulary(entry, vocabulary);
      if (!e.ok) return e;
      parsed.push(e.value);
    }
    out[field] = parsed;
  }

  if (r['requiredRights'] !== undefined) {
    const v = r['requiredRights'];
    if (!Array.isArray(v)) return err('SNAPSHOT_MALFORMED');
    const rights: RequiredRight[] = [];
    for (const entry of v) {
      if (typeof entry !== 'object' || entry === null) return err('SNAPSHOT_MALFORMED');
      const e = entry as Record<string, unknown>;
      for (const k of Object.keys(e)) if (k !== 'kind' && k !== 'acceptable') return err('SNAPSHOT_MALFORMED');
      const kind = parseEnumFromVocabulary(e['kind'], RightKind);
      if (!kind.ok) return kind;
      const acceptableRaw = e['acceptable'];
      if (!Array.isArray(acceptableRaw)) return err('SNAPSHOT_MALFORMED');
      const acceptable: RightState[] = [];
      for (const s of acceptableRaw) {
        const parsedState = parseEnumFromVocabulary(s, RightState);
        if (!parsedState.ok) return parsedState;
        acceptable.push(parsedState.value);
      }
      rights.push({ kind: kind.value, acceptable });
    }
    out['requiredRights'] = rights;
  }

  if (r['holderJurisdiction'] !== undefined) {
    const j = parseJurisdiction(r['holderJurisdiction']);
    if (!j.ok) return j;
    out['holderJurisdiction'] = j.value;
  }

  if (r['minimumTrust'] !== undefined) {
    const t = r['minimumTrust'];
    if (typeof t !== 'string' || !Object.prototype.hasOwnProperty.call(TrustClass, t)) {
      return err('SNAPSHOT_MALFORMED');
    }
    out['minimumTrust'] = t;
  }

  if (r['maxClaimAgeSeconds'] !== undefined) {
    const v = r['maxClaimAgeSeconds'];
    if (typeof v === 'bigint') out['maxClaimAgeSeconds'] = v;
    else if (typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)) out['maxClaimAgeSeconds'] = BigInt(v);
    else return err('SNAPSHOT_MALFORMED');
  }

  return ok(out as AdditionalRequirements);
}

export { canonicalAssetKey };
