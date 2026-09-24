/**
 * Synthetic world builders.
 *
 * Two things matter about a world builder: that it is deterministic, because a
 * world that shifts between runs cannot pin a decision vector; and that each world
 * actually exhibits the situation it claims to, because a builder whose
 * CONFLICTING_PROVENANCE world contains no conflict would make every test using it
 * silently vacuous.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMandate } from '@mandate/kernel';
import {
  Admissibility,
  deriveRequirements,
  evaluateRepresentation,
  filterForMandate,
  narrowRequirements,
  openRegistry,
  parseAdditionalRequirements,
  registrySnapshotDigest,
  resolve,
  ResolutionStatus,
  type Registry,
  type RepresentationRequirements,
} from '../src/index.ts';
import {
  ALL_WORLD_KINDS,
  buildAllWorlds,
  buildWorld,
  counterfeitRepresentation,
  FIXTURE_NOW,
  fixtureSnapshot,
  generateWorld,
  WorldKind,
  type SyntheticWorld,
} from '../src/testing/index.ts';

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

function codesFor(world: SyntheticWorld): readonly string[] {
  const registry = openWorld(world);
  const result = filterForMandate(registry, requirementsFor(world), world.probeRepresentationIds);
  return result.excluded.flatMap((d) => (d.status === 'EXCLUDED' ? d.reasonCodes : []));
}

// --- determinism ------------------------------------------------------------

test('every world builder is deterministic', () => {
  for (const kind of ALL_WORLD_KINDS) {
    const a = openWorld(buildWorld(kind));
    const b = openWorld(buildWorld(kind));
    assert.equal(
      registrySnapshotDigest(a.snapshot),
      registrySnapshotDigest(b.snapshot),
      `${kind} is not deterministic`,
    );
  }
});

test('every world opens and every mandate parses', () => {
  for (const world of buildAllWorlds()) {
    const registry = openWorld(world);
    assert.ok(registry.snapshot.representations.length >= 0);
    // A world's requirements must be constructible, or the world cannot be used.
    assert.ok(requirementsFor(world));
    // Phase 2 ships only synthetic data, and says so in the snapshot itself.
    assert.equal(registry.snapshot.dataClass, 'SYNTHETIC_FIXTURE', world.kind);
  }
});

test('the seeded generator is deterministic and varies with its seed', () => {
  const digests = new Set<string>();
  for (const seed of [1, 2, 3, 7, 11, 42, 99, 1234]) {
    const a = openWorld(generateWorld(seed));
    const b = openWorld(generateWorld(seed));
    assert.equal(registrySnapshotDigest(a.snapshot), registrySnapshotDigest(b.snapshot), `seed ${seed}`);
    digests.add(registrySnapshotDigest(a.snapshot));
  }
  // Not a strict requirement of correctness, but a generator that produced one
  // world for every seed would make the property tests meaningless.
  assert.ok(digests.size >= 4, `expected varied worlds, got ${digests.size}`);
});

// --- each world exhibits what it claims -------------------------------------

test('ONE_BACKED admits exactly one representation', () => {
  const world = buildWorld(WorldKind.ONE_BACKED);
  const result = filterForMandate(openWorld(world), requirementsFor(world), world.probeRepresentationIds);
  assert.equal(result.admissible.length, 1);
  assert.equal(result.excluded.length, 0);
});

test('BACKED_AND_SYNTHETIC admits the backed one and refuses the synthetic one', () => {
  const world = buildWorld(WorldKind.BACKED_AND_SYNTHETIC);
  const result = filterForMandate(openWorld(world), requirementsFor(world), world.probeRepresentationIds);
  assert.equal(result.admissible.length, 1);
  assert.equal(result.excluded.length, 1);
  assert.ok(codesFor(world).includes('SYNTHETIC_NOT_ALLOWED'));
});

test('MULTIPLE_VALID admits both', () => {
  const world = buildWorld(WorldKind.MULTIPLE_VALID);
  const result = filterForMandate(openWorld(world), requirementsFor(world), world.probeRepresentationIds);
  assert.equal(result.admissible.length, 2);
  assert.equal(result.excluded.length, 0);
});

test('TICKER_COLLISION makes a bare ticker ambiguous and a qualified one exact', () => {
  const world = buildWorld(WorldKind.TICKER_COLLISION);
  const registry = openWorld(world);
  assert.equal(resolve(registry, 'NVDA').status, ResolutionStatus.AMBIGUOUS);
  assert.equal(resolve(registry, 'XNAS:NVDA').status, ResolutionStatus.RESOLVED);
  assert.equal(resolve(registry, 'XLON:NVDA').status, ResolutionStatus.RESOLVED);
  // And the two are genuinely different assets.
  const a = resolve(registry, 'XNAS:NVDA');
  const b = resolve(registry, 'XLON:NVDA');
  assert.notEqual(
    a.status === 'RESOLVED' ? a.asset.identity.value : '',
    b.status === 'RESOLVED' ? b.asset.identity.value : 'x',
  );
});

test('DUPLICATE_NAMES and ALIAS_COLLISION both resolve ambiguous', () => {
  const names = openWorld(buildWorld(WorldKind.DUPLICATE_NAMES));
  assert.equal(resolve(names, 'NVIDIA Corporation').status, ResolutionStatus.AMBIGUOUS);

  const aliases = openWorld(buildWorld(WorldKind.ALIAS_COLLISION));
  assert.equal(resolve(aliases, 'Chip Leader').status, ResolutionStatus.AMBIGUOUS);
});

test('each refusal world produces the reason code it exists to produce', () => {
  const expectations: readonly [WorldKind, string][] = [
    [WorldKind.WRONG_ISSUER, 'ISSUER_NOT_ALLOWED'],
    [WorldKind.WRONG_CHAIN, 'CHAIN_NOT_ALLOWED'],
    [WorldKind.WRONG_UNDERLYING, 'REPRESENTATION_ASSET_MISMATCH'],
    [WorldKind.UNKNOWN_BACKING, 'REPRESENTATION_METADATA_UNKNOWN'],
    [WorldKind.ADVISORY_ONLY_BACKING, 'TRUST_REQUIREMENT_NOT_MET'],
    [WorldKind.CONFLICTING_PROVENANCE, 'REPRESENTATION_METADATA_CONFLICT'],
    [WorldKind.STALE_METADATA, 'REPRESENTATION_METADATA_STALE'],
    [WorldKind.INACTIVE_REPRESENTATION, 'REPRESENTATION_INACTIVE'],
    [WorldKind.DELISTED_ASSET, 'CANONICAL_ASSET_INACTIVE'],
    [WorldKind.UNREGISTERED_FAKE, 'REPRESENTATION_UNKNOWN'],
    [WorldKind.CORPORATE_ACTION_MISMATCH, 'CORPORATE_ACTION_MODEL_NOT_ALLOWED'],
    [WorldKind.MISSING_RIGHTS, 'REPRESENTATION_METADATA_UNKNOWN'],
    [WorldKind.JURISDICTION_RESTRICTED, 'JURISDICTION_NOT_ELIGIBLE'],
  ];
  for (const [kind, code] of expectations) {
    const codes = codesFor(buildWorld(kind));
    assert.ok(codes.includes(code), `${kind} did not produce ${code}; got ${JSON.stringify(codes)}`);
  }
});

test('UNREGISTERED_FAKE also reports a malformed identifier rather than dropping it', () => {
  assert.ok(codesFor(buildWorld(WorldKind.UNREGISTERED_FAKE)).includes('REPRESENTATION_ID_MALFORMED'));
});

test('INJECTED_UNTRUSTED_CLAIM stays admissible', () => {
  // The security property, at world level: an injected untrusted claim changes
  // nothing about an honest representation.
  const world = buildWorld(WorldKind.INJECTED_UNTRUSTED_CLAIM);
  const result = filterForMandate(openWorld(world), requirementsFor(world), world.probeRepresentationIds);
  assert.equal(result.admissible.length, 1, JSON.stringify(codesFor(world)));
});

test('the counterfeit is a valid record and is in no world snapshot', () => {
  // It parses — that is the point. Being well-formed is not being registered.
  const registry = openRegistry(fixtureSnapshot());
  assert.ok(registry.ok);
  const counterfeit = counterfeitRepresentation();
  const world = buildWorld(WorldKind.UNREGISTERED_FAKE);
  const decision = evaluateRepresentation(
    openWorld(world),
    requirementsFor(world),
    counterfeit['representationId'],
  );
  assert.equal(decision.status, Admissibility.EXCLUDED);
  assert.ok(decision.status === 'EXCLUDED' && decision.reasonCodes.includes('REPRESENTATION_UNKNOWN'));

  for (const w of buildAllWorlds()) {
    const snapshot = openWorld(w).snapshot;
    assert.equal(
      snapshot.representations.some((r) => r.representationId.value === counterfeit['representationId']),
      false,
      `${w.kind} contains the counterfeit`,
    );
  }
});
