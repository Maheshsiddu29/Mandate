/**
 * Deterministic indexes over canonical asset records, and the resolver.
 *
 * Indexes exist for two reasons. The obvious one is that a linear scan per
 * lookup is the wrong shape even at small sizes (design-adjacent: Phase 2 avoids
 * O(n) scans where simple indexing solves the problem, without pretending to
 * need a database). The less obvious one is that building the indexes is where
 * *ambiguity becomes visible*: a key that maps to more than one asset is
 * recorded as such at build time, so resolution never has to decide anything.
 *
 * Every candidate list is sorted by canonical asset key, so a result does not
 * depend on the order assets were supplied in.
 */

import { err, ok, type Result } from '@mandate/kernel';
import type { RegistryReasonCodeName } from './reason-codes.ts';
import { canonicalAssetKey, type ValidatedCanonicalAssetId } from './asset-id.ts';
import { AliasKind, type CanonicalAssetRecord } from './asset.ts';
import { normalizeLookupKey, parseReference, ReferenceKind, type ParsedReference } from './reference.ts';

export const ResolutionStatus = {
  RESOLVED: 'RESOLVED',
  AMBIGUOUS: 'AMBIGUOUS',
  UNKNOWN: 'UNKNOWN',
  INVALID: 'INVALID',
} as const;
export type ResolutionStatus = (typeof ResolutionStatus)[keyof typeof ResolutionStatus];

/**
 * The outcome of resolving a reference.
 *
 * Four named cases rather than a nullable result, because `null` conflates "I do
 * not know this", "I know several" and "you gave me nonsense", and a caller must
 * respond differently to each. `AMBIGUOUS` reports every candidate and chooses
 * none: a tie-break would be a guess about financial identity.
 */
export type ReferenceResolution =
  | {
      readonly status: 'RESOLVED';
      readonly matchedBy: ReferenceKind;
      readonly asset: CanonicalAssetRecord;
    }
  | {
      readonly status: 'AMBIGUOUS';
      readonly matchedBy: ReferenceKind;
      readonly candidates: readonly CanonicalAssetRecord[];
      readonly reasonCode: 'REFERENCE_AMBIGUOUS';
    }
  | { readonly status: 'UNKNOWN'; readonly reasonCode: 'REFERENCE_UNKNOWN' }
  | { readonly status: 'INVALID'; readonly reasonCode: RegistryReasonCodeName };

export interface AssetIndex {
  readonly assets: readonly CanonicalAssetRecord[];
  readonly byCanonicalKey: ReadonlyMap<string, CanonicalAssetRecord>;
  /** Keys that map to more than one asset are retained in full; nothing is dropped. */
  readonly bySchemeValue: ReadonlyMap<string, readonly CanonicalAssetRecord[]>;
  readonly byQualified: ReadonlyMap<string, readonly CanonicalAssetRecord[]>;
  readonly byPlain: ReadonlyMap<string, readonly CanonicalAssetRecord[]>;
}

function push(map: Map<string, CanonicalAssetRecord[]>, key: string, record: CanonicalAssetRecord): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [record]);
  else if (!existing.includes(record)) existing.push(record);
}

function sortCandidates(records: readonly CanonicalAssetRecord[]): readonly CanonicalAssetRecord[] {
  return [...records].sort((a, b) => {
    const x = canonicalAssetKey(a.identity);
    const y = canonicalAssetKey(b.identity);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/**
 * Build the indexes.
 *
 * A duplicate canonical identity rejects: two records for one asset would make
 * every lookup order-dependent. A shared *lookup key* does not reject — a ticker
 * used by two securities is legitimate registry content, and the honest response
 * is to resolve it as ambiguous rather than to refuse the snapshot.
 */
export function buildAssetIndex(
  assets: readonly CanonicalAssetRecord[],
): Result<AssetIndex, RegistryReasonCodeName> {
  const byCanonicalKey = new Map<string, CanonicalAssetRecord>();
  const bySchemeValue = new Map<string, CanonicalAssetRecord[]>();
  const byQualified = new Map<string, CanonicalAssetRecord[]>();
  const byPlain = new Map<string, CanonicalAssetRecord[]>();

  for (const asset of assets) {
    const key = canonicalAssetKey(asset.identity);
    if (byCanonicalKey.has(key)) return err('SNAPSHOT_MALFORMED');
    byCanonicalKey.set(key, asset);

    // Scheme and value without the asset class: two asset classes could in
    // principle carry one scheme value, so this is a lookup, not an identity.
    push(bySchemeValue, `${asset.identity.idScheme}\u0000${asset.identity.value}`, asset);

    for (const listing of asset.display.listings) {
      push(byQualified, `${listing.mic}:${listing.ticker}`, asset);
      // A listing's ticker is also a bare-ticker lookup key.
      push(byPlain, normalizeLookupKey(listing.ticker), asset);
    }
    if (asset.display.displayTicker !== null) {
      push(byPlain, normalizeLookupKey(asset.display.displayTicker), asset);
    }
    push(byPlain, normalizeLookupKey(asset.display.primaryName), asset);

    for (const alias of asset.display.aliases) {
      if (alias.kind === AliasKind.EXCHANGE_QUALIFIED) {
        const parts = alias.value.split(':');
        push(byQualified, `${normalizeLookupKey(parts[0] ?? '')}:${normalizeLookupKey(parts[1] ?? '')}`, asset);
      } else {
        push(byPlain, normalizeLookupKey(alias.value), asset);
      }
    }
  }

  const freeze = (m: Map<string, CanonicalAssetRecord[]>): ReadonlyMap<string, readonly CanonicalAssetRecord[]> => {
    const out = new Map<string, readonly CanonicalAssetRecord[]>();
    for (const [k, v] of m) out.set(k, sortCandidates(v));
    return out;
  };

  return ok({
    assets: sortCandidates(assets),
    byCanonicalKey,
    bySchemeValue: freeze(bySchemeValue),
    byQualified: freeze(byQualified),
    byPlain: freeze(byPlain),
  });
}

function candidatesFor(index: AssetIndex, ref: ParsedReference): readonly CanonicalAssetRecord[] {
  switch (ref.kind) {
    case ReferenceKind.CANONICAL_ID: {
      const hit = index.byCanonicalKey.get(canonicalAssetKey(ref.id));
      return hit === undefined ? [] : [hit];
    }
    case ReferenceKind.SCHEME_VALUE:
      return index.bySchemeValue.get(`${ref.scheme}\u0000${ref.value}`) ?? [];
    case ReferenceKind.QUALIFIED:
      return index.byQualified.get(ref.key) ?? [];
    case ReferenceKind.PLAIN:
      return index.byPlain.get(ref.key) ?? [];
  }
}

/**
 * Resolve a human reference to a canonical asset.
 *
 * Deterministic: the same index and the same reference produce the same outcome,
 * which is what lets resolution be pinned as a decision vector.
 */
export function resolveReference(index: AssetIndex, raw: unknown): ReferenceResolution {
  const parsed = parseReference(raw);
  if (!parsed.ok) return { status: ResolutionStatus.INVALID, reasonCode: parsed.error };

  const candidates = candidatesFor(index, parsed.value);
  if (candidates.length === 0) {
    return { status: ResolutionStatus.UNKNOWN, reasonCode: 'REFERENCE_UNKNOWN' };
  }
  if (candidates.length > 1) {
    return {
      status: ResolutionStatus.AMBIGUOUS,
      matchedBy: parsed.value.kind,
      candidates: sortCandidates(candidates),
      reasonCode: 'REFERENCE_AMBIGUOUS',
    };
  }
  return {
    status: ResolutionStatus.RESOLVED,
    matchedBy: parsed.value.kind,
    asset: candidates[0] as CanonicalAssetRecord,
  };
}

export function getCanonicalAsset(
  index: AssetIndex,
  id: ValidatedCanonicalAssetId,
): CanonicalAssetRecord | undefined {
  return index.byCanonicalKey.get(canonicalAssetKey(id));
}
