/**
 * Registry snapshots: immutable registry state, nameable and replayable (ADR 0007).
 *
 * A snapshot is a value. The registry neither reads nor writes storage, so
 * "what did Mandate know at time X" is answered by holding the snapshot from X
 * and re-running — not by querying a history. That is what makes a registry
 * decision expressible as a permanent decision vector.
 *
 * `dataClass` is the honesty field. It records whether the state was observed or
 * is a synthetic fixture, and **no decision reads it**: there is one decision
 * engine, not a real one and a simulated one (ADR 0004). A structural test
 * asserts no decision path reads it, so it can never quietly become a behaviour
 * switch.
 */

import { err, ok, parseIdentifier, type Identifier, type Result, type UnixSeconds } from '@mandate/kernel';
import type { RegistryReasonCodeName } from './reason-codes.ts';
import { MAX_SNAPSHOT_ENTRIES } from './limits.ts';
import { parseCanonicalAssetRecord, type CanonicalAssetRecord } from './asset.ts';
import { parseRepresentationRecord, type RepresentationRecord } from './representation.ts';

/** Registry schema version, independent of the mandate schema version (ADR 0007). */
export const REGISTRY_SCHEMA_VERSION = 1;

/**
 * Where the state came from.
 *
 * Phase 2 ships only `SYNTHETIC_FIXTURE` data. Real market data begins in Phase 3,
 * and this field is how a snapshot cannot be presented as live when it is not
 * (AGENTS.md section 5).
 */
export const DataClass = {
  SYNTHETIC_FIXTURE: 'SYNTHETIC_FIXTURE',
  OBSERVED: 'OBSERVED',
} as const;
export type DataClass = (typeof DataClass)[keyof typeof DataClass];

/**
 * A declared source version.
 *
 * Recorded so a snapshot digest names not just the data but the provenance
 * pipeline that produced it: two snapshots with identical records but different
 * source versions were produced by different code and are not interchangeable
 * for audit.
 */
export interface SourceVersion {
  readonly sourceId: Identifier;
  readonly version: Identifier;
}

export interface RegistrySnapshot {
  readonly registrySchemaVersion: number;
  /** Caller-chosen label for this snapshot. Not the digest; the digest is derived. */
  readonly snapshotId: Identifier;
  readonly createdAtUnixSeconds: UnixSeconds;
  readonly dataClass: DataClass;
  readonly sourceVersions: readonly SourceVersion[];
  readonly assets: readonly CanonicalAssetRecord[];
  readonly representations: readonly RepresentationRecord[];
}

const SNAPSHOT_FIELDS = [
  'registrySchemaVersion',
  'snapshotId',
  'createdAtUnixSeconds',
  'dataClass',
  'sourceVersions',
  'assets',
  'representations',
] as const;

export { MAX_SNAPSHOT_ENTRIES };

function parseUnix(raw: unknown): Result<UnixSeconds, RegistryReasonCodeName> {
  if (typeof raw === 'bigint') return ok(raw);
  if (typeof raw === 'string' && /^-?(0|[1-9][0-9]*)$/.test(raw)) return ok(BigInt(raw));
  // A `number` is refused even when integral, matching the kernel: accepting one
  // would make the safe/unsafe boundary depend on magnitude.
  return err('SNAPSHOT_MALFORMED');
}

function parseSourceVersions(raw: unknown): Result<readonly SourceVersion[], RegistryReasonCodeName> {
  if (!Array.isArray(raw)) return err('SNAPSHOT_MALFORMED');
  if (raw.length > MAX_SNAPSHOT_ENTRIES) return err('SNAPSHOT_RESOURCE_LIMIT_EXCEEDED');
  const out: SourceVersion[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return err('SNAPSHOT_MALFORMED');
    const e = entry as Record<string, unknown>;
    for (const k of Object.keys(e)) if (k !== 'sourceId' && k !== 'version') return err('SNAPSHOT_MALFORMED');
    const sourceId = parseIdentifier(e['sourceId']);
    if (!sourceId.ok) return err('SNAPSHOT_MALFORMED');
    const version = parseIdentifier(e['version']);
    if (!version.ok) return err('SNAPSHOT_MALFORMED');
    // Two versions declared for one source is an ambiguity about what produced
    // this snapshot, so it rejects rather than one silently winning.
    if (seen.has(sourceId.value)) return err('SNAPSHOT_MALFORMED');
    seen.add(sourceId.value);
    out.push({ sourceId: sourceId.value, version: version.value });
  }
  return ok(
    [...out].sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0)),
  );
}

/**
 * Strict structural parse. Total: every input yields a `Result`, never a throw.
 *
 * Unknown top-level keys reject, following the mandate parser's rule: ignoring an
 * unrecognized field would let a caller attach meaning nothing enforces.
 */
export function parseRegistrySnapshot(raw: unknown): Result<RegistrySnapshot, RegistryReasonCodeName> {
  if (typeof raw !== 'object' || raw === null) return err('SNAPSHOT_MALFORMED');
  const r = raw as Record<string, unknown>;
  const known = new Set<string>(SNAPSHOT_FIELDS);
  for (const k of Object.keys(r)) if (!known.has(k)) return err('SNAPSHOT_MALFORMED');

  const version = r['registrySchemaVersion'];
  if (typeof version !== 'number' || version !== REGISTRY_SCHEMA_VERSION) return err('SNAPSHOT_MALFORMED');

  const snapshotId = parseIdentifier(r['snapshotId']);
  if (!snapshotId.ok) return err('SNAPSHOT_MALFORMED');

  const createdAt = parseUnix(r['createdAtUnixSeconds']);
  if (!createdAt.ok) return createdAt;

  const dataClass = r['dataClass'];
  if (typeof dataClass !== 'string' || !Object.prototype.hasOwnProperty.call(DataClass, dataClass)) {
    return err('SNAPSHOT_MALFORMED');
  }

  const sourceVersions = parseSourceVersions(r['sourceVersions']);
  if (!sourceVersions.ok) return sourceVersions;

  const rawAssets = r['assets'];
  if (!Array.isArray(rawAssets)) return err('SNAPSHOT_MALFORMED');
  if (rawAssets.length > MAX_SNAPSHOT_ENTRIES) return err('SNAPSHOT_RESOURCE_LIMIT_EXCEEDED');
  const assets: CanonicalAssetRecord[] = [];
  for (const entry of rawAssets) {
    const parsed = parseCanonicalAssetRecord(entry);
    if (!parsed.ok) return parsed;
    assets.push(parsed.value);
  }

  const rawReps = r['representations'];
  if (!Array.isArray(rawReps)) return err('SNAPSHOT_MALFORMED');
  if (rawReps.length > MAX_SNAPSHOT_ENTRIES) return err('SNAPSHOT_RESOURCE_LIMIT_EXCEEDED');
  const representations: RepresentationRecord[] = [];
  for (const entry of rawReps) {
    const parsed = parseRepresentationRecord(entry);
    if (!parsed.ok) return parsed;
    representations.push(parsed.value);
  }

  return ok({
    registrySchemaVersion: version,
    snapshotId: snapshotId.value,
    createdAtUnixSeconds: createdAt.value,
    dataClass: dataClass as DataClass,
    sourceVersions: sourceVersions.value,
    assets,
    representations,
  });
}
