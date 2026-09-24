/**
 * Representation admissibility.
 *
 * ```
 * admissibility = f(mandate, representation semantics, trusted registry state)
 * ```
 *
 * Never stored. Two representations may both track one underlying; under a mandate
 * that allows synthetics both may be admissible, and under one that requires full
 * backing only one is. Same registry, same representations, different answer —
 * which is exactly why the answer cannot live in the registry (design section 5.4).
 *
 * Three structural properties, each mirroring the verifier's:
 *
 * - **Evaluation takes an identifier, not a record.** There is no signature by
 *   which a caller can hand over a record it invented and receive a verdict for
 *   it, so an unregistered contract can never be evaluated into admissibility
 *   (design section 5.3).
 * - **Every exclusion explains itself, and all independent reasons are
 *   collected.** Evaluation does not stop at the first failure, because "excluded"
 *   is not an actionable answer and "excluded: wrong issuer, wrong chain,
 *   synthetic" is (design section 9.4).
 * - **Fail closed.** `UNKNOWN` and `CONFLICT` reject. No path returns ADMISSIBLE
 *   for a property that could not be established.
 */

import { SyntheticPolicy } from '@mandate/kernel';
import { anyReasonCode, type RegistryReasonCode } from './reason-codes.ts';
import { canonicalAssetKey } from './asset-id.ts';
import { AssetStatus } from './asset.ts';
import { resolveClaimSet, type ClaimResolution, type ClaimSet, type UnknownReason } from './claims.ts';
import { eligibilityKey } from './representation.ts';
import { identityKey, isSyntheticBacking, type EligibilityProfile } from './semantics.ts';
import { parseRepresentationId, type RepresentationId } from './representation-id.ts';
import { getAsset, type Registry } from './registry.ts';
import { claimPolicyOf, type RepresentationRequirements } from './requirements.ts';

export const Admissibility = { ADMISSIBLE: 'ADMISSIBLE', EXCLUDED: 'EXCLUDED' } as const;
export type Admissibility = (typeof Admissibility)[keyof typeof Admissibility];

export interface RepresentationExclusion {
  readonly code: RegistryReasonCode;
  /** Machine-readable specifics. String values only, so a decision encodes canonically. */
  readonly detail: Readonly<Record<string, string>>;
}

export type RepresentationDecision =
  | {
      readonly status: 'ADMISSIBLE';
      readonly representationId: RepresentationId;
    }
  | {
      readonly status: 'EXCLUDED';
      /** Null when the identifier itself could not be parsed. */
      readonly representationId: RepresentationId | null;
      readonly reasonCodes: readonly RegistryReasonCode[];
      readonly exclusions: readonly RepresentationExclusion[];
    };

function exclusion(code: RegistryReasonCode, detail: Readonly<Record<string, string>> = {}): RepresentationExclusion {
  return { code, detail };
}

/**
 * Map an unestablished claim to its reason code.
 *
 * Four distinct causes get four distinct codes because they need different
 * remedies: missing data, data from the wrong kind of source, data that is too
 * old, and sources that disagree. Collapsing them would tell a caller to go
 * looking for the wrong fix.
 */
function unknownCode(reason: UnknownReason): RegistryReasonCode {
  switch (reason) {
    case 'NO_CLAIMS':
      return 'REPRESENTATION_METADATA_UNKNOWN';
    case 'BELOW_TRUST_FLOOR':
      return 'TRUST_REQUIREMENT_NOT_MET';
    case 'STALE':
      return 'REPRESENTATION_METADATA_STALE';
  }
}

/**
 * Resolve one property, recording an exclusion if it could not be established.
 *
 * Returns the value only when established, so a caller cannot accidentally read
 * through an unknown or conflicted property.
 */
function establish<T>(
  claims: ClaimSet<T>,
  requirements: RepresentationRequirements,
  keyOf: (v: T) => string,
  property: string,
  into: RepresentationExclusion[],
): T | undefined {
  const resolution: ClaimResolution<T> = resolveClaimSet(claims, claimPolicyOf(requirements), keyOf);
  if (resolution.state === 'ESTABLISHED') return resolution.value;
  if (resolution.state === 'CONFLICT') {
    into.push(
      exclusion('REPRESENTATION_METADATA_CONFLICT', {
        property,
        // The disagreeing values, sorted, so the detail is deterministic and a
        // curator can see what to adjudicate without re-reading the snapshot.
        values: [...new Set(resolution.claims.map((c) => keyOf(c.value)))].sort().join(','),
      }),
    );
    return undefined;
  }
  into.push(exclusion(unknownCode(resolution.reason), { property }));
  return undefined;
}

/**
 * Canonical order for exclusions: by reason-code id, then by detail.
 *
 * Sorting is what makes the decision independent of the order the checks ran in,
 * and deduplication removes the case where two checks report the same cause with
 * the same detail. Same reasoning as the verifier's receipt canonicalization.
 */
function canonicalize(exclusions: readonly RepresentationExclusion[]): RepresentationExclusion[] {
  const seen = new Map<string, RepresentationExclusion>();
  for (const e of exclusions) {
    const detailKey = Object.keys(e.detail)
      .sort()
      .map((k) => `${k}=${e.detail[k]}`)
      .join('\u0000');
    const key = `${anyReasonCode(e.code).id}\u0000${detailKey}`;
    if (!seen.has(key)) seen.set(key, e);
  }
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, e]) => e);
}

/**
 * Evaluate one representation against one set of requirements.
 *
 * `representationIdInput` is an identifier, in string or structured form. It is
 * resolved through the snapshot: that is the structural expression of
 * "unregistered contract is not a valid representation".
 */
export function evaluateRepresentation(
  registry: Registry,
  requirements: RepresentationRequirements,
  representationIdInput: unknown,
): RepresentationDecision {
  const parsedId = parseRepresentationId(representationIdInput);
  if (!parsedId.ok) {
    return {
      status: Admissibility.EXCLUDED,
      representationId: null,
      reasonCodes: [parsedId.error],
      exclusions: [exclusion(parsedId.error, {})],
    };
  }
  const id = parsedId.value;

  const record = registry.byRepresentationId.get(id.value);
  if (record === undefined) {
    // The invariant this whole layer exists to hold: a contract nobody registered
    // is never admissible, whatever its ticker, symbol or token metadata claims,
    // and whatever an agent or tool asserts about it.
    return {
      status: Admissibility.EXCLUDED,
      representationId: id,
      reasonCodes: ['REPRESENTATION_UNKNOWN'],
      exclusions: [exclusion('REPRESENTATION_UNKNOWN', { representationId: id.value })],
    };
  }

  const found: RepresentationExclusion[] = [];

  // --- the canonical underlying -------------------------------------------
  const underlying = establish(record.underlying, requirements, canonicalAssetKey, 'underlying', found);
  if (underlying !== undefined) {
    if (canonicalAssetKey(underlying) !== canonicalAssetKey(requirements.canonicalAsset)) {
      found.push(
        exclusion('REPRESENTATION_ASSET_MISMATCH', {
          expected: requirements.canonicalAsset.value,
          observed: underlying.value,
        }),
      );
    } else {
      // The asset must itself be registered and active. A representation issued
      // against an asset this snapshot does not carry has no established identity
      // to check the rest against.
      const asset = getAsset(registry, requirements.canonicalAsset);
      if (asset === undefined) {
        found.push(exclusion('CANONICAL_ASSET_UNKNOWN', { canonicalAsset: requirements.canonicalAsset.value }));
      } else if (asset.status !== AssetStatus.ACTIVE) {
        found.push(exclusion('CANONICAL_ASSET_INACTIVE', { observed: asset.status }));
      }
    }
  }

  // --- issuer --------------------------------------------------------------
  const issuer = establish(record.issuer, requirements, identityKey, 'issuer', found);
  if (issuer !== undefined && !requirements.allowedIssuers.includes(issuer)) {
    found.push(exclusion('ISSUER_NOT_ALLOWED', { observed: issuer }));
  }

  // --- chain: structural, straight off the identity -------------------------
  if (!requirements.allowedChains.includes(id.chain)) {
    found.push(exclusion('CHAIN_NOT_ALLOWED', { observed: id.chain }));
  }

  // --- backing, and the synthetic status derived from it -------------------
  // Backing is required to be established unconditionally, because synthetic
  // status derives from it and the kernel requires synthetic status on every
  // representation it reads, whatever the mandate's policy. Keeping the two layers
  // aligned here is what stops the registry admitting something the verifier will
  // then refuse.
  const backing = establish(record.backing, requirements, identityKey, 'backing', found);
  if (backing !== undefined) {
    if (isSyntheticBacking(backing) && requirements.syntheticPolicy === SyntheticPolicy.FORBIDDEN) {
      found.push(exclusion('SYNTHETIC_NOT_ALLOWED', { observed: backing }));
    }
    if (requirements.allowedBackingModels !== null && !requirements.allowedBackingModels.includes(backing)) {
      // Separate from the synthetic check: partially backed, collateralized and
      // debt-linked instruments are not synthetic and still fail a full-backing
      // requirement.
      found.push(exclusion('BACKING_REQUIREMENT_NOT_MET', { observed: backing }));
    }
  }

  // --- operational status: required unconditionally, as in the kernel -------
  const operational = establish(record.operationalStatus, requirements, identityKey, 'operationalStatus', found);
  if (operational !== undefined && operational !== 'ACTIVE') {
    found.push(exclusion('REPRESENTATION_INACTIVE', { observed: operational }));
  }

  // --- properties checked only when the requirements constrain them ---------
  if (requirements.allowedInstrumentTypes !== null) {
    const instrument = establish(record.instrumentType, requirements, identityKey, 'instrumentType', found);
    if (instrument !== undefined && !requirements.allowedInstrumentTypes.includes(instrument)) {
      found.push(exclusion('INSTRUMENT_TYPE_NOT_ALLOWED', { observed: instrument }));
    }
  }

  if (requirements.allowedRedemptionModels !== null) {
    const redemption = establish(record.redemption, requirements, identityKey, 'redemption', found);
    if (redemption !== undefined && !requirements.allowedRedemptionModels.includes(redemption)) {
      found.push(exclusion('REDEMPTION_REQUIREMENT_NOT_MET', { observed: redemption }));
    }
  }

  if (requirements.allowedCorporateActionModels !== null) {
    const model = establish(record.corporateActionHandling, requirements, identityKey, 'corporateActionHandling', found);
    if (model !== undefined && !requirements.allowedCorporateActionModels.includes(model)) {
      found.push(exclusion('CORPORATE_ACTION_MODEL_NOT_ALLOWED', { observed: model }));
    }
  }

  if (requirements.allowedSettlementModels !== null) {
    const settlement = establish(record.settlement, requirements, identityKey, 'settlement', found);
    if (settlement !== undefined && !requirements.allowedSettlementModels.includes(settlement)) {
      found.push(exclusion('SETTLEMENT_MODEL_NOT_ALLOWED', { observed: settlement }));
    }
  }

  for (const required of requirements.requiredRights) {
    const claims = record.rights[required.kind] ?? [];
    // A right with no claims is UNKNOWN, and an unestablished right never
    // satisfies a demand for it: this is the fail-closed rule applied per right.
    const state = establish(claims, requirements, identityKey, `rights.${required.kind}`, found);
    if (state !== undefined && !required.acceptable.includes(state)) {
      found.push(exclusion('RIGHTS_REQUIREMENT_NOT_MET', { right: required.kind, observed: state }));
    }
  }

  if (requirements.holderJurisdiction !== null) {
    const holder = requirements.holderJurisdiction;
    const profile = establish<EligibilityProfile>(record.eligibility, requirements, eligibilityKey, 'eligibility', found);
    if (profile !== undefined) {
      // Prohibition and omission are both refusals, following the allowlist rule:
      // an undeclared jurisdiction is not permitted.
      if (profile.prohibited.includes(holder)) {
        found.push(exclusion('JURISDICTION_NOT_ELIGIBLE', { holder, reason: 'prohibited' }));
      } else if (!profile.permitted.includes(holder)) {
        found.push(exclusion('JURISDICTION_NOT_ELIGIBLE', { holder, reason: 'not-permitted' }));
      }
    }
  }

  if (found.length === 0) return { status: Admissibility.ADMISSIBLE, representationId: id };

  const canonical = canonicalize(found);
  return {
    status: Admissibility.EXCLUDED,
    representationId: id,
    reasonCodes: [...new Set(canonical.map((e) => e.code))],
    exclusions: canonical,
  };
}

export interface FilterResult {
  readonly admissible: readonly RepresentationId[];
  readonly excluded: readonly RepresentationDecision[];
  /** Every decision, admissible and excluded alike, in deterministic order. */
  readonly decisions: readonly RepresentationDecision[];
}

/**
 * Evaluate every representation issued against the requirements' canonical asset,
 * plus any extra identifiers the caller names.
 *
 * Naming an extra identifier is how an unregistered contract gets evaluated and
 * reported as `REPRESENTATION_UNKNOWN` rather than silently omitted — a caller
 * that was offered a contract from somewhere needs to be told it is unknown, not
 * handed a list that quietly lacks it.
 *
 * Deterministic: results are ordered by representation identifier, so the output
 * does not depend on snapshot order or on the order extras were supplied.
 */
export function filterForMandate(
  registry: Registry,
  requirements: RepresentationRequirements,
  extraRepresentationIds: readonly unknown[] = [],
): FilterResult {
  const listed = registry.byUnderlying.get(canonicalAssetKey(requirements.canonicalAsset)) ?? [];
  const ids: unknown[] = listed.map((r) => r.representationId.value);
  const seen = new Set<string>(ids as string[]);
  for (const extra of extraRepresentationIds) {
    const parsed = parseRepresentationId(extra);
    // An unparseable extra is still evaluated, so it is reported rather than
    // dropped; a duplicate of something already listed is not evaluated twice.
    if (!parsed.ok) {
      ids.push(extra);
      continue;
    }
    if (seen.has(parsed.value.value)) continue;
    seen.add(parsed.value.value);
    ids.push(parsed.value.value);
  }

  const decisions = ids
    .map((id) => evaluateRepresentation(registry, requirements, id))
    .sort((a, b) => {
      const x = a.representationId?.value ?? '';
      const y = b.representationId?.value ?? '';
      if (x.length !== y.length) return x.length < y.length ? -1 : 1;
      return x < y ? -1 : x > y ? 1 : 0;
    });

  return {
    admissible: decisions.flatMap((d) => (d.status === 'ADMISSIBLE' ? [d.representationId] : [])),
    excluded: decisions.filter((d) => d.status === 'EXCLUDED'),
    decisions,
  };
}
