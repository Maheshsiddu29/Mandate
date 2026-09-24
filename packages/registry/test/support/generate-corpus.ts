/**
 * Registry decision-vector corpus generator.
 *
 * The corpus is a compatibility contract, not a convenience for these tests. Any
 * future implementation — another SDK, a simulation harness, a Solidity-adjacent
 * policy check, a real-data replay — must reproduce every field of `expected` for
 * every vector, which is how two implementations of one decision are kept from
 * drifting apart (design section 10.5).
 *
 * Vectors are **self-contained**: each carries a complete registry snapshot, a
 * complete mandate, and the institutional policy to layer on. Nothing is inherited
 * from another vector or from a fixture file, so a reimplementer needs this file
 * and the specification, not this repository.
 *
 * Expectations are computed by running the implementation, exactly as the kernel's
 * corpus is. The world builders deliberately carry no expected outcomes, so a
 * vector cannot encode an answer that was never derived.
 *
 * Run: `npm run registry-corpus:generate`. The output is committed, and
 * `corpus.test.ts` fails if the committed file does not match what this generator
 * produces.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

import { parseMandate } from '@mandate/kernel';
import {
  deriveRequirements,
  filterForMandate,
  narrowRequirements,
  openRegistry,
  parseAdditionalRequirements,
  registrySnapshotDigest,
  representationDecisionDigest,
  resolve,
  type Registry,
  type RepresentationDecision,
  type RepresentationRequirements,
} from '../../src/index.ts';
import {
  ALL_WORLD_KINDS,
  buildWorld,
  FIXTURE_NOW,
  type SyntheticWorld,
} from '../../src/testing/index.ts';

export const REGISTRY_CORPUS_VERSION = 1;

/**
 * References applied to every world, on top of the world's own.
 *
 * These are the resolution failure modes, and they are universal rather than
 * per-world because their behaviour must not depend on registry contents: a
 * malformed reference is malformed against every snapshot.
 */
const UNIVERSAL_REFERENCES: readonly unknown[] = [
  'mandate:asset:equity:figi:BBG000BBJQV0',
  { assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBJQV0' },
  'nvda',
  '  NVDA  ',
  'ZZZZ',
  'NVIDIA Corp',
  'NASDAQ:',
  ':NVDA',
  'XNAS:NVDA:EXTRA',
  'mandate:asset:equity:figi',
  'figi:BBG000BBJQV1',
  'figi:bbg000bbjqv0',
  'sedol:B0YBKJ7',
  // An unsupported scheme and an unsupported asset class, reachable only through
  // the canonical-id forms: in `scheme:value` form an unrecognized left segment is
  // indistinguishable from an exchange name, so it is a lookup rather than a
  // scheme error.
  'mandate:asset:equity:sedol:B0YBKJ7',
  { assetClass: 'crypto', idScheme: 'figi', value: 'BBG000BBJQV0' },
  'NVIDIA Corporation',
  '',
  42,
  null,
];

function openWorld(world: SyntheticWorld): Registry {
  const r = openRegistry(world.snapshot);
  if (!r.ok) throw new Error(`${world.kind}: openRegistry failed: ${r.error}`);
  return r.value;
}

function requirementsFor(world: SyntheticWorld): RepresentationRequirements {
  const m = parseMandate(world.mandate);
  if (!m.ok) throw new Error(`${world.kind}: mandate failed to parse: ${m.error}`);
  const base = deriveRequirements(m.value, { nowUnixSeconds: FIXTURE_NOW });
  if (!base.ok) throw new Error(`${world.kind}: deriveRequirements failed: ${base.error}`);
  if (world.additionalRequirements === null) return base.value;
  const additional = parseAdditionalRequirements(world.additionalRequirements);
  if (!additional.ok) throw new Error(`${world.kind}: additional requirements failed: ${additional.error}`);
  const narrowed = narrowRequirements(base.value, additional.value);
  if (!narrowed.ok) throw new Error(`${world.kind}: narrowRequirements failed: ${narrowed.error}`);
  return narrowed.value;
}

/** JSON cannot hold a bigint, and object key order is an accident of construction. */
function toJson(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, toJson(v)]),
    );
  }
  return value;
}

function resolutionExpectation(registry: Registry, reference: unknown): Record<string, unknown> {
  const outcome = resolve(registry, reference);
  switch (outcome.status) {
    case 'RESOLVED':
      return {
        status: outcome.status,
        matchedBy: outcome.matchedBy,
        canonicalAssetIds: [outcome.asset.identity],
      };
    case 'AMBIGUOUS':
      return {
        status: outcome.status,
        matchedBy: outcome.matchedBy,
        // Every candidate, in the resolver's deterministic order. A reimplementation
        // that picked one would fail this field, which is the point of recording it.
        canonicalAssetIds: outcome.candidates.map((c) => c.identity),
        reasonCode: outcome.reasonCode,
      };
    default:
      return { status: outcome.status, reasonCode: outcome.reasonCode };
  }
}

function decisionExpectation(decision: RepresentationDecision): Record<string, unknown> {
  return {
    representationId: decision.representationId === null ? null : decision.representationId.value,
    status: decision.status,
    reasonCodes: decision.status === 'EXCLUDED' ? [...decision.reasonCodes].sort() : [],
    exclusions:
      decision.status === 'EXCLUDED'
        ? decision.exclusions.map((e) => ({ code: e.code, detail: e.detail }))
        : [],
    decisionDigest: representationDecisionDigest(decision),
  };
}

export function buildRegistryCorpus(): Record<string, unknown> {
  const vectors = ALL_WORLD_KINDS.map((kind, index) => {
    const world = buildWorld(kind);
    const registry = openWorld(world);
    const requirements = requirementsFor(world);
    const filtered = filterForMandate(registry, requirements, world.probeRepresentationIds);

    const references = [...world.references, ...UNIVERSAL_REFERENCES];

    return {
      id: `registry-${String(index + 1).padStart(3, '0')}`,
      family: kind,
      description: world.description,
      input: toJson({
        snapshot: world.snapshot,
        mandate: world.mandate,
        additionalRequirements: world.additionalRequirements,
        references,
        probeRepresentationIds: world.probeRepresentationIds,
      }),
      expected: toJson({
        snapshotDigest: registrySnapshotDigest(registry.snapshot),
        resolutions: references.map((reference) => ({
          reference,
          ...resolutionExpectation(registry, reference),
        })),
        admissibleRepresentationIds: filtered.admissible.map((id) => id.value),
        decisions: filtered.decisions.map(decisionExpectation),
      }),
    };
  });

  const ids = vectors.map((v) => v.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate vector id');

  return {
    corpusVersion: REGISTRY_CORPUS_VERSION,
    registryVersion: 'mandate-registry/1',
    registrySchemaVersion: 1,
    encoding: 'Registry encoding v1, keccak-256 (docs/adr/0007-registry-snapshot-encoding-and-digest.md)',
    note: 'Integers are decimal strings because JSON has no integer type wide enough. Vectors are self-contained: each carries a complete snapshot, mandate and policy. All data is SYNTHETIC_FIXTURE; see corpus/registry-v1/README.md.',
    vectorCount: vectors.length,
    vectors,
  };
}

export const REGISTRY_CORPUS_PATH = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../corpus/registry-v1/vectors.json',
);

export function serializeRegistryCorpus(): string {
  return `${JSON.stringify(buildRegistryCorpus(), null, 2)}\n`;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\u0000')) {
  writeFileSync(REGISTRY_CORPUS_PATH, serializeRegistryCorpus(), 'utf8');
  process.stdout.write(`wrote ${REGISTRY_CORPUS_PATH}\n`);
}
