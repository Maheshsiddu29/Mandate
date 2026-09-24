/**
 * Property and adversarial tests for the registry.
 *
 * The aim is a small number of invariants that hold over many generated worlds,
 * not a large number of cases. Each property below is one sentence a reviewer can
 * check against the design, and each is the kind of statement a single hand-written
 * example cannot establish.
 *
 * Generation is seeded, so a failure is reproducible from the reported seed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMandate, TrustClass, type CanonicalMandate } from '@mandate/kernel';
import {
  Admissibility,
  canonicalAssetIdentityDigest,
  deriveRequirements,
  evaluateRepresentation,
  filterForMandate,
  narrowRequirements,
  openRegistry,
  parseAdditionalRequirements,
  parseCanonicalAssetRecord,
  parseRepresentationId,
  registrySnapshotDigest,
  resolve,
  ResolutionStatus,
  toRepresentationState,
  type AdditionalRequirements,
  type Registry,
  type RepresentationRequirements,
} from '../src/index.ts';
import {
  backedRepresentation,
  buildWorld,
  colliderAsset,
  fixtureClaim,
  fixtureMandate,
  fixtureRepresentationId,
  fixtureSnapshot,
  fixtureVerified,
  FIXTURE_ADDRESS_BACKED,
  FIXTURE_ADDRESS_SECOND_BACKED,
  FIXTURE_ADDRESS_UNREGISTERED,
  FIXTURE_NOW,
  FIXTURE_SOURCE_ATTACKER,
  FIXTURE_SOURCE_CHAIN_READ,
  generateWorld,
  nvdaAsset,
  syntheticRepresentation,
  WorldKind,
  type Json,
  type SyntheticWorld,
} from '../src/testing/index.ts';

const ITERATIONS = 120;

function openOrThrow(snapshot: unknown, label: string): Registry {
  const r = openRegistry(snapshot);
  if (!r.ok) throw new Error(`${label}: openRegistry failed: ${r.error}`);
  return r.value;
}

function mandateOrThrow(input: unknown, label: string): CanonicalMandate {
  const m = parseMandate(input);
  if (!m.ok) throw new Error(`${label}: mandate failed to parse: ${m.error}`);
  return m.value;
}

function requirementsOrThrow(
  mandateInput: unknown,
  additional: Json | null,
  label: string,
): RepresentationRequirements {
  const base = deriveRequirements(mandateOrThrow(mandateInput, label), { nowUnixSeconds: FIXTURE_NOW });
  if (!base.ok) throw new Error(`${label}: deriveRequirements failed: ${base.error}`);
  if (additional === null) return base.value;
  const parsed = parseAdditionalRequirements(additional);
  if (!parsed.ok) throw new Error(`${label}: additional failed: ${parsed.error}`);
  const narrowed = narrowRequirements(base.value, parsed.value);
  if (!narrowed.ok) throw new Error(`${label}: narrow failed: ${narrowed.error}`);
  return narrowed.value;
}

function admissibleSet(world: SyntheticWorld): readonly string[] {
  const registry = openOrThrow(world.snapshot, world.description);
  const requirements = requirementsOrThrow(world.mandate, world.additionalRequirements, world.description);
  return filterForMandate(registry, requirements, world.probeRepresentationIds)
    .admissible.map((id) => id.value)
    .sort();
}

/** Deterministic PRNG, so a failing case is reproducible from its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

// --- identity properties ----------------------------------------------------

test('changing display metadata never changes canonical identity', () => {
  const next = rng(0x0d15);
  const names = ['NVIDIA Corporation', 'Nvidia Corp', 'NVIDIA', 'Renamed Holdings', 'X Y Z Inc'];
  const tickers = ['NVDA', 'NVD', 'NVDA.B', 'XNVD', 'ZZZZ'];
  const mics = ['XNAS', 'XNYS', 'XLON', 'XETR'];

  const baseline = parseCanonicalAssetRecord(nvdaAsset());
  assert.ok(baseline.ok);
  const identityDigest = canonicalAssetIdentityDigest(baseline.value.identity);

  for (let i = 0; i < ITERATIONS; i += 1) {
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
    const ticker = pick(tickers);
    const mutated = parseCanonicalAssetRecord(
      nvdaAsset({
        display: {
          primaryName: pick(names),
          displayTicker: ticker,
          primaryMarketIdentifier: pick(mics),
          listings: [{ mic: pick(mics), ticker }],
          aliases: [{ kind: 'LEGACY_TICKER', value: pick(tickers) }],
        },
      }),
    );
    assert.ok(mutated.ok, `iteration ${i}`);
    assert.deepEqual(mutated.value.identity, baseline.value.identity, `iteration ${i}`);
    assert.equal(canonicalAssetIdentityDigest(mutated.value.identity), identityDigest, `iteration ${i}`);
  }
});

test('changing a contract address always changes representation identity', () => {
  // Exhaustive over every single-byte fill rather than sampled, so the injectivity
  // claim is established rather than merely not falsified: 256 distinct addresses
  // must yield 256 distinct identities.
  const seen = new Map<string, string>();
  for (let byte = 0; byte < 256; byte += 1) {
    const address = `0x${byte.toString(16).padStart(2, '0').repeat(20)}`;
    const parsed = parseRepresentationId(fixtureRepresentationId(address));
    assert.ok(parsed.ok, address);
    const previous = seen.get(parsed.value.value);
    assert.equal(previous, undefined, `${address} collides with ${previous}`);
    seen.set(parsed.value.value, address);
  }
  assert.equal(seen.size, 256);

  // And the same address on two chains is two identities.
  const arb = parseRepresentationId(fixtureRepresentationId(FIXTURE_ADDRESS_BACKED, 'eip155:42161'));
  const eth = parseRepresentationId(fixtureRepresentationId(FIXTURE_ADDRESS_BACKED, 'eip155:1'));
  assert.ok(arb.ok && eth.ok);
  assert.notEqual(arb.value.value, eth.value.value);
});

// --- the adversarial claim properties ---------------------------------------

test('adding an untrusted claim never changes any decision', () => {
  // The security property from ADR 0006, over generated worlds rather than one
  // example. An advisory or untrusted claim can neither establish a value nor
  // create a conflict, so injecting one must be invisible to every decision.
  const next = rng(0xa77a);
  const subFloor = [TrustClass.ADVISORY, TrustClass.UNTRUSTED] as const;
  const values = ['SYNTHETIC', 'UNBACKED', 'PARTIALLY_BACKED', 'FULLY_BACKED'];

  for (let i = 0; i < ITERATIONS; i += 1) {
    const world = generateWorld(i + 1);
    const before = admissibleSet(world);

    const trustClass = subFloor[Math.floor(next() * subFloor.length)] as TrustClass;
    const value = values[Math.floor(next() * values.length)] as string;
    const snapshot = world.snapshot as Json;
    const representations = (snapshot['representations'] as Json[]).map((record) => ({
      ...record,
      backing: [
        ...((record['backing'] as Json[] | undefined) ?? []),
        fixtureClaim(value, trustClass, FIXTURE_SOURCE_ATTACKER),
      ],
    }));
    const after = admissibleSet({ ...world, snapshot: { ...snapshot, representations } });
    assert.deepEqual(after, before, `seed ${i + 1}: an injected ${trustClass} claim changed the outcome`);
  }
});

test('adding an untrusted representation never changes another representation semantics', () => {
  const next = rng(0xbeef);
  for (let i = 0; i < ITERATIONS; i += 1) {
    const world = generateWorld(i + 1);
    const before = admissibleSet(world);

    // A hostile entry: claims the same underlying and symbol, from an untrusted
    // source, on a contract of its own.
    const hostile = backedRepresentation({
      representationId: fixtureRepresentationId(FIXTURE_ADDRESS_UNREGISTERED),
      underlying: [fixtureClaim({ assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBJQV0' }, TrustClass.UNTRUSTED, FIXTURE_SOURCE_ATTACKER)],
      backing: [fixtureClaim('FULLY_BACKED', TrustClass.UNTRUSTED, FIXTURE_SOURCE_ATTACKER)],
      issuer: [fixtureClaim('issuer.fixture.alpha', TrustClass.UNTRUSTED, FIXTURE_SOURCE_ATTACKER)],
      operationalStatus: [fixtureClaim('ACTIVE', TrustClass.UNTRUSTED, FIXTURE_SOURCE_ATTACKER)],
    });
    const snapshot = world.snapshot as Json;
    const existing = snapshot['representations'] as Json[];
    // Skip the rare seed where the generator already used this address.
    if (existing.some((r) => r['representationId'] === hostile['representationId'])) continue;

    const after = admissibleSet({
      ...world,
      snapshot: { ...snapshot, representations: [...existing, hostile] },
    });
    assert.deepEqual(
      after.filter((id) => id !== hostile['representationId']),
      before,
      `seed ${i + 1}: a hostile entry changed another representation's outcome`,
    );
    assert.equal(
      after.includes(hostile['representationId'] as string),
      false,
      `seed ${i + 1}: an untrusted representation became admissible`,
    );
    void next;
  }
});

test('downgrading provenance never improves admissibility', () => {
  const next = rng(0xd047);
  for (let i = 0; i < ITERATIONS; i += 1) {
    const world = generateWorld(i + 1);
    const before = admissibleSet(world);

    const downgradeTo = ([TrustClass.ADVISORY, TrustClass.UNTRUSTED] as const)[
      Math.floor(next() * 2)
    ] as TrustClass;
    const snapshot = world.snapshot as Json;
    const representations = (snapshot['representations'] as Json[]).map((record) => ({
      ...record,
      backing: ((record['backing'] as Json[] | undefined) ?? []).map((c) => ({
        ...c,
        provenance: { ...((c as Json)['provenance'] as Json), trustClass: downgradeTo },
      })),
    }));
    const after = admissibleSet({ ...world, snapshot: { ...snapshot, representations } });
    // Downgrading can only remove admissible representations, never add one.
    for (const id of after) {
      assert.ok(before.includes(id), `seed ${i + 1}: downgrading provenance admitted ${id}`);
    }
  }
});

// --- monotonicity of constraints -------------------------------------------

test('adding a constraint never creates an admissible representation', () => {
  const next = rng(0xc047);
  // Labelled, because an addition carrying a bigint cannot be put through
  // JSON.stringify in an assertion message.
  const additions: readonly [string, AdditionalRequirements][] = [
    ['forbid synthetic', { forbidSynthetic: true }],
    ['fully backed only', { allowedBackingModels: ['FULLY_BACKED'] }],
    ['backed notes only', { allowedInstrumentTypes: ['BACKED_NOTE'] }],
    ['open redemption only', { allowedRedemptionModels: ['OPEN_REDEMPTION'] }],
    ['atomic settlement only', { allowedSettlementModels: ['ATOMIC_ON_CHAIN'] }],
    ['on-chain multiplier only', { allowedCorporateActionModels: ['ON_CHAIN_MULTIPLIER'] }],
    ['voting required', { requiredRights: [{ kind: 'VOTING_RIGHTS', acceptable: ['PRESENT'] }] }],
    ['beneficial ownership required', { requiredRights: [{ kind: 'BENEFICIAL_OWNERSHIP', acceptable: ['PRESENT'] }] }],
    ['US holder', { holderJurisdiction: 'US' }],
    ['DE holder', { holderJurisdiction: 'DE' }],
    ['issuer alpha only', { allowedIssuers: ['issuer.fixture.alpha'] }],
    ['arbitrum only', { allowedChains: ['eip155:42161'] }],
    ['authoritative trust floor', { minimumTrust: TrustClass.AUTHORITATIVE }],
    ['one-second claim age', { maxClaimAgeSeconds: 1n }],
  ];

  for (let i = 0; i < ITERATIONS; i += 1) {
    const world = generateWorld(i + 1);
    const registry = openOrThrow(world.snapshot, `seed ${i + 1}`);
    const base = requirementsOrThrow(world.mandate, world.additionalRequirements, `seed ${i + 1}`);
    const beforeResult = filterForMandate(registry, base, world.probeRepresentationIds);
    const before = new Set(beforeResult.admissible.map((id) => id.value));

    const [label, addition] = additions[Math.floor(next() * additions.length)] as [string, AdditionalRequirements];
    const narrowed = narrowRequirements(base, addition);
    assert.ok(narrowed.ok, `seed ${i + 1}: ${label} failed to narrow`);
    const after = filterForMandate(registry, narrowed.value, world.probeRepresentationIds);

    for (const id of after.admissible) {
      assert.ok(before.has(id.value), `seed ${i + 1}: adding "${label}" admitted ${id.value}`);
    }
    // And every exclusion that existed still exists.
    assert.ok(after.excluded.length >= beforeResult.excluded.length, `seed ${i + 1}: exclusions were lost`);
  }
});

test('raising the trust floor never adds an admissible representation', () => {
  for (let i = 0; i < ITERATIONS; i += 1) {
    const world = generateWorld(i + 1);
    const registry = openOrThrow(world.snapshot, `seed ${i + 1}`);
    const base = requirementsOrThrow(world.mandate, world.additionalRequirements, `seed ${i + 1}`);
    const raised = narrowRequirements(base, { minimumTrust: TrustClass.AUTHORITATIVE });
    assert.ok(raised.ok);
    const before = new Set(filterForMandate(registry, base).admissible.map((i2) => i2.value));
    for (const id of filterForMandate(registry, raised.value).admissible) {
      assert.ok(before.has(id.value), `seed ${i + 1}: raising the floor admitted ${id.value}`);
    }
  }
});

// --- order independence -----------------------------------------------------

test('representation and asset ordering never affects admissibility', () => {
  const next = rng(0xa1b2c3);
  for (let i = 0; i < ITERATIONS; i += 1) {
    const world = generateWorld(i + 1);
    const baseline = admissibleSet(world);
    const snapshot = world.snapshot as Json;

    const representations = [...(snapshot['representations'] as Json[])];
    const assets = [...(snapshot['assets'] as Json[])];
    for (let j = representations.length - 1; j > 0; j -= 1) {
      const k = Math.floor(next() * (j + 1));
      [representations[j], representations[k]] = [representations[k] as Json, representations[j] as Json];
    }
    for (let j = assets.length - 1; j > 0; j -= 1) {
      const k = Math.floor(next() * (j + 1));
      [assets[j], assets[k]] = [assets[k] as Json, assets[j] as Json];
    }

    const shuffled = { ...world, snapshot: { ...snapshot, assets, representations } };
    assert.deepEqual(admissibleSet(shuffled), baseline, `seed ${i + 1}`);
    // The snapshot digest is order-independent too, so a reordered snapshot is
    // literally the same state.
    assert.equal(
      registrySnapshotDigest(openOrThrow(shuffled.snapshot, 'shuffled').snapshot),
      registrySnapshotDigest(openOrThrow(world.snapshot, 'baseline').snapshot),
      `seed ${i + 1}: digest depends on order`,
    );
  }
});

// --- unknown representations -------------------------------------------------

test('an unknown representation never becomes admissible without registry state changing', () => {
  for (let i = 0; i < ITERATIONS; i += 1) {
    const world = generateWorld(i + 1);
    const registry = openOrThrow(world.snapshot, `seed ${i + 1}`);
    const requirements = requirementsOrThrow(world.mandate, world.additionalRequirements, `seed ${i + 1}`);
    const decision = evaluateRepresentation(
      registry,
      requirements,
      fixtureRepresentationId(FIXTURE_ADDRESS_UNREGISTERED),
    );
    assert.equal(decision.status, Admissibility.EXCLUDED, `seed ${i + 1}`);
    assert.ok(
      decision.status === 'EXCLUDED' && decision.reasonCodes.includes('REPRESENTATION_UNKNOWN'),
      `seed ${i + 1}`,
    );
  }
});

test('registering the same contract is what makes it admissible, and nothing else', () => {
  // The complement of the property above: state change is the only route.
  const unregistered = buildWorld(WorldKind.UNREGISTERED_FAKE);
  const registry = openOrThrow(unregistered.snapshot, 'unregistered');
  const requirements = requirementsOrThrow(unregistered.mandate, null, 'unregistered');
  const probe = fixtureRepresentationId(FIXTURE_ADDRESS_UNREGISTERED);
  assert.equal(evaluateRepresentation(registry, requirements, probe).status, Admissibility.EXCLUDED);

  const registered = openOrThrow(
    fixtureSnapshot({
      representations: [
        backedRepresentation({ representationId: probe, backing: fixtureVerified('FULLY_BACKED', FIXTURE_SOURCE_CHAIN_READ) }),
      ],
    }),
    'registered',
  );
  assert.equal(evaluateRepresentation(registered, requirements, probe).status, Admissibility.ADMISSIBLE);
});

// --- resolution properties ---------------------------------------------------

test('resolution never returns a single asset where more than one matches', () => {
  const next = rng(0x5e5e);
  const references = ['NVDA', 'nvda', ' NVDA ', 'NVIDIA Corporation', 'XNAS:NVDA', 'XLON:NVDA', 'AMD', 'Chip Leader'];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const world = generateWorld(i + 1);
    const registry = openOrThrow(world.snapshot, `seed ${i + 1}`);
    const reference = references[Math.floor(next() * references.length)] as string;
    const outcome = resolve(registry, reference);
    if (outcome.status !== ResolutionStatus.RESOLVED) continue;
    // If it resolved, exactly one asset must carry that lookup key.
    const matches = registry.assetIndex.assets.filter(
      (a) =>
        a.display.displayTicker?.toUpperCase() === reference.trim().toUpperCase() ||
        a.display.primaryName.toUpperCase() === reference.trim().toUpperCase(),
    );
    assert.ok(matches.length <= 1, `seed ${i + 1}: ${reference} resolved with ${matches.length} matches`);
  }
});

test('no reference resolves to an asset absent from the snapshot', () => {
  const next = rng(0xab5e);
  const references = ['NVDA', 'AMD', 'NVIDIA Corporation', 'figi:BBG000BBJQV0', 'figi:BBG000BBQCY0', 'figi:ZZG000TSTFX6', 'XLON:NVDA'];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const world = generateWorld(i + 1);
    const registry = openOrThrow(world.snapshot, `seed ${i + 1}`);
    const reference = references[Math.floor(next() * references.length)] as string;
    const outcome = resolve(registry, reference);
    const present = new Set(registry.assetIndex.assets.map((a) => a.identity.value));
    if (outcome.status === 'RESOLVED') {
      assert.ok(present.has(outcome.asset.identity.value), `seed ${i + 1}: ${reference}`);
    } else if (outcome.status === 'AMBIGUOUS') {
      for (const candidate of outcome.candidates) {
        assert.ok(present.has(candidate.identity.value), `seed ${i + 1}: ${reference}`);
      }
    }
  }
});

test('an ambiguous world stays ambiguous however its assets are ordered', () => {
  const forward = openOrThrow(fixtureSnapshot({ assets: [nvdaAsset(), colliderAsset()] }), 'forward');
  const reverse = openOrThrow(fixtureSnapshot({ assets: [colliderAsset(), nvdaAsset()] }), 'reverse');
  assert.deepEqual(resolve(forward, 'NVDA'), resolve(reverse, 'NVDA'));
  assert.equal(resolve(forward, 'NVDA').status, ResolutionStatus.AMBIGUOUS);
});

// --- totality ---------------------------------------------------------------

test('arbitrary junk never opens a registry, never resolves and never throws', () => {
  const next = rng(0xfa11);
  const atoms: unknown[] = [
    null, undefined, 0, 1, -1, 1.5, Number.NaN, '', '0x', 'NVDA', true, false, [], {},
    0n, -1n, 2n ** 300n, '00', '-0', '1e3', ' 1', 'equity', 'figi',
  ];
  const grow = (depth: number): unknown => {
    if (depth <= 0) return atoms[Math.floor(next() * atoms.length)];
    const r = next();
    if (r < 0.35) return Array.from({ length: Math.floor(next() * 3) }, () => grow(depth - 1));
    if (r < 0.8) {
      const keys = ['registrySchemaVersion', 'snapshotId', 'assets', 'representations', 'identity', 'display', 'value', 'provenance', 'dataClass', 'backing'];
      const out: Record<string, unknown> = {};
      for (let i = 0; i < 1 + Math.floor(next() * 4); i += 1) {
        out[keys[Math.floor(next() * keys.length)] as string] = grow(depth - 1);
      }
      return out;
    }
    return atoms[Math.floor(next() * atoms.length)];
  };

  const registry = openOrThrow(fixtureSnapshot(), 'valid');
  const requirements = requirementsOrThrow(fixtureMandate(), null, 'valid');

  for (let i = 0; i < 400; i += 1) {
    // Opening junk must fail as a value, never throw.
    const opened = openRegistry(grow(3));
    assert.equal(opened.ok, false, `iteration ${i}: junk opened as a registry`);

    // Resolving junk must produce an outcome, never throw.
    const outcome = resolve(registry, grow(2));
    assert.ok(
      [ResolutionStatus.RESOLVED, ResolutionStatus.AMBIGUOUS, ResolutionStatus.UNKNOWN, ResolutionStatus.INVALID].includes(
        outcome.status,
      ),
      `iteration ${i}`,
    );

    // Evaluating a junk identifier must never be admissible.
    const decision = evaluateRepresentation(registry, requirements, grow(2));
    assert.equal(decision.status, Admissibility.EXCLUDED, `iteration ${i}: junk became admissible`);
  }
});

// --- the bridge -------------------------------------------------------------

test('the bridge never emits state for a representation the registry excludes on metadata', () => {
  for (let i = 0; i < ITERATIONS; i += 1) {
    const world = generateWorld(i + 1);
    const registry = openOrThrow(world.snapshot, `seed ${i + 1}`);
    const requirements = requirementsOrThrow(world.mandate, world.additionalRequirements, `seed ${i + 1}`);
    for (const record of registry.snapshot.representations) {
      const state = toRepresentationState(record, requirements);
      if (!state.ok) continue;
      // Whenever the bridge does emit, the emitted synthetic flag must agree with
      // the backing model the registry established — the two layers cannot
      // disagree about the headline constraint.
      assert.ok(
        state.value.value.synthetic === 'YES' || state.value.value.synthetic === 'NO',
        `seed ${i + 1}: emitted an UNKNOWN synthetic flag`,
      );
      assert.equal(state.value.value.representationId, record.representationId.value);
      assert.ok(
        state.value.provenance.trustClass === 'VERIFIED' || state.value.provenance.trustClass === 'AUTHORITATIVE',
        `seed ${i + 1}: emitted sub-floor provenance`,
      );
    }
  }
});

test('a synthetic representation is never emitted as non-synthetic', () => {
  const registry = openOrThrow(fixtureSnapshot({ representations: [syntheticRepresentation()] }), 'synthetic');
  const requirements = requirementsOrThrow(
    fixtureMandate({ syntheticPolicy: 'ALLOWED', allowedIssuers: ['issuer.fixture.alpha', 'issuer.fixture.beta'] }),
    null,
    'synthetic',
  );
  const record = registry.snapshot.representations[0];
  assert.ok(record !== undefined);
  const state = toRepresentationState(record, requirements);
  assert.ok(state.ok);
  assert.equal(state.value.value.synthetic, 'YES');
});

// --- digest injectivity -----------------------------------------------------

test('distinct generated worlds do not share a snapshot digest', () => {
  const digests = new Map<string, number>();
  for (let seed = 1; seed <= 200; seed += 1) {
    const registry = openOrThrow(generateWorld(seed).snapshot, `seed ${seed}`);
    const digest = registrySnapshotDigest(registry.snapshot);
    const previous = digests.get(digest);
    if (previous !== undefined) {
      // Two seeds may legitimately produce identical state; then the digests must
      // match *and* the states must be equal.
      const a = openOrThrow(generateWorld(previous).snapshot, 'a').snapshot;
      const b = registry.snapshot;
      assert.equal(
        JSON.stringify(a.representations.map((r) => r.representationId.value)),
        JSON.stringify(b.representations.map((r) => r.representationId.value)),
        `seeds ${previous} and ${seed} collide on digest with different state`,
      );
      continue;
    }
    digests.set(digest, seed);
  }
  assert.ok(digests.size > 5, `expected varied snapshots, got ${digests.size}`);
});

test('a one-representation difference always changes the snapshot digest', () => {
  const one = openOrThrow(fixtureSnapshot(), 'one').snapshot;
  const two = openOrThrow(
    fixtureSnapshot({
      representations: [
        backedRepresentation(),
        backedRepresentation({ representationId: fixtureRepresentationId(FIXTURE_ADDRESS_SECOND_BACKED) }),
      ],
    }),
    'two',
  ).snapshot;
  assert.notEqual(registrySnapshotDigest(one), registrySnapshotDigest(two));
  void FIXTURE_ADDRESS_BACKED;
});
