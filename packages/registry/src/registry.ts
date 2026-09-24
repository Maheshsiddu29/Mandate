/**
 * The registry view: an opened snapshot with immutable indexes.
 *
 * `openRegistry` is the only way to get one, and it takes a snapshot value. There
 * is no mutable global state, no cache and no loader, so a decision made through a
 * `Registry` is a function of the snapshot it was opened from — which is what
 * makes it reproducible from a recorded snapshot (ADR 0004).
 *
 * Indexes exist so lookups are not linear scans, and also because building them is
 * where ambiguity and duplication become visible: a duplicate representation
 * rejects at open time rather than making a later lookup order-dependent.
 */

import { err, ok, type Result } from '@mandate/kernel';
import type { RegistryReasonCodeName } from './reason-codes.ts';
import { canonicalAssetKey, type ValidatedCanonicalAssetId } from './asset-id.ts';
import type { CanonicalAssetRecord } from './asset.ts';
import {
  buildAssetIndex,
  getCanonicalAsset,
  resolveReference,
  type AssetIndex,
  type ReferenceResolution,
} from './asset-index.ts';
import { compareRepresentationIds, parseRepresentationId, type RepresentationId } from './representation-id.ts';
import type { RepresentationRecord } from './representation.ts';
import { parseRegistrySnapshot, type RegistrySnapshot } from './snapshot.ts';
import { EXECUTION_TRUST_FLOOR, resolveClaimSet, type ClaimPolicy } from './claims.ts';

export interface Registry {
  readonly snapshot: RegistrySnapshot;
  readonly assetIndex: AssetIndex;
  readonly byRepresentationId: ReadonlyMap<string, RepresentationRecord>;
  /**
   * Representations grouped by the canonical underlying their claims establish.
   *
   * Built with the *structural* trust floor: a representation whose underlying is
   * unknown or conflicted appears under no asset, so it can never be reached by
   * `listRepresentations`. It remains reachable by its own id, where evaluating it
   * reports exactly why it is inadmissible rather than pretending it does not
   * exist.
   */
  readonly byUnderlying: ReadonlyMap<string, readonly RepresentationRecord[]>;
}

/**
 * The claim policy used to build the underlying index.
 *
 * Deliberately has no freshness bound: staleness is the caller's decision at
 * evaluation time, and applying a bound here would bake one snapshot's notion of
 * "recent" into the index. Trust and agreement are structural and are applied.
 */
function indexPolicy(snapshot: RegistrySnapshot): ClaimPolicy {
  return {
    minimumTrust: EXECUTION_TRUST_FLOOR,
    nowUnixSeconds: snapshot.createdAtUnixSeconds,
    maxClaimAgeSeconds: null,
  };
}

/**
 * Open a snapshot.
 *
 * Accepts either a parsed snapshot or raw input, and re-parses raw input through
 * the same strict parser, so there is no second, weaker path into the registry.
 */
export function openRegistry(raw: unknown): Result<Registry, RegistryReasonCodeName> {
  const parsed = parseRegistrySnapshot(raw);
  if (!parsed.ok) return parsed;
  const snapshot = parsed.value;

  const assetIndex = buildAssetIndex(snapshot.assets);
  if (!assetIndex.ok) return assetIndex;

  const byRepresentationId = new Map<string, RepresentationRecord>();
  for (const record of snapshot.representations) {
    const key = record.representationId.value;
    // Two records for one representation would make admissibility depend on
    // lookup order, exactly as the kernel refuses for trusted state.
    if (byRepresentationId.has(key)) return err('SNAPSHOT_MALFORMED');
    byRepresentationId.set(key, record);
  }

  const policy = indexPolicy(snapshot);
  const grouped = new Map<string, RepresentationRecord[]>();
  for (const record of snapshot.representations) {
    const underlying = resolveClaimSet(record.underlying, policy, canonicalAssetKey);
    // An unestablished or conflicted underlying means the edge to the asset was
    // never established, so the representation is not listed under any asset.
    if (underlying.state !== 'ESTABLISHED') continue;
    const key = canonicalAssetKey(underlying.value);
    const list = grouped.get(key);
    if (list === undefined) grouped.set(key, [record]);
    else list.push(record);
  }

  const byUnderlying = new Map<string, readonly RepresentationRecord[]>();
  for (const [key, list] of grouped) {
    byUnderlying.set(
      key,
      [...list].sort((a, b) => compareRepresentationIds(a.representationId, b.representationId)),
    );
  }

  return ok({ snapshot, assetIndex: assetIndex.value, byRepresentationId, byUnderlying });
}

/** Resolve a human reference. See `asset-index.ts` for the outcome vocabulary. */
export function resolve(registry: Registry, reference: unknown): ReferenceResolution {
  return resolveReference(registry.assetIndex, reference);
}

export function getAsset(
  registry: Registry,
  id: ValidatedCanonicalAssetId,
): CanonicalAssetRecord | undefined {
  return getCanonicalAsset(registry.assetIndex, id);
}

/**
 * Look up a representation by identifier.
 *
 * Returns `undefined` for an unregistered contract. That is not an oversight and
 * not a nullable-result design smell: the *admissibility* API takes an id and
 * reports `REPRESENTATION_UNKNOWN`, so a caller never has to turn this absence
 * into a verdict itself (design section 5.3).
 */
export function getRepresentation(
  registry: Registry,
  id: unknown,
): RepresentationRecord | undefined {
  const parsed = parseRepresentationId(id);
  if (!parsed.ok) return undefined;
  return registry.byRepresentationId.get(parsed.value.value);
}

/**
 * Every representation whose claims establish this canonical asset as its
 * underlying, in deterministic order.
 *
 * Membership in this list is the weakest useful claim: *issued against that
 * underlying*, and nothing more (design section 5.4). It does not mean admissible,
 * interchangeable, or equally safe. Admissibility is decided against a mandate by
 * `evaluateRepresentation`.
 */
export function listRepresentations(
  registry: Registry,
  id: ValidatedCanonicalAssetId,
): readonly RepresentationRecord[] {
  return registry.byUnderlying.get(canonicalAssetKey(id)) ?? [];
}

export function hasRepresentation(registry: Registry, id: RepresentationId): boolean {
  return registry.byRepresentationId.has(id.value);
}
