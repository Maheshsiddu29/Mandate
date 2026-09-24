/**
 * Synthetic registry worlds. **TEST / SYNTHETIC.**
 *
 * Deterministic builders for the registry situations Mandate has to get right. They
 * live in `src/testing` rather than a test directory because Phase 4's route and
 * simulation work needs them, and because a synthetic world and a real fixture must
 * flow through the same registry: there is no separate simulation engine
 * ([ADR 0004](../../../../docs/adr/0004-registry-package-boundary.md)).
 *
 * A builder produces a world and says what it is. It deliberately does **not**
 * carry expected outcomes: expectations are computed by running the implementation,
 * so a builder cannot quietly encode the answer it is supposed to be testing.
 *
 * Everything about representations is fictional. See `fixtures.ts` for exactly what
 * is real and what is not.
 */

import {
  amdAsset,
  backedRepresentation,
  colliderAsset,
  counterfeitRepresentation,
  deepMerge,
  fixtureClaim,
  fixtureMandate,
  fixtureRepresentationId,
  fixtureSnapshot,
  fixtureVerified,
  FIXTURE_ADDRESS_BACKED,
  FIXTURE_ADDRESS_OTHER_CHAIN,
  FIXTURE_ADDRESS_SYNTHETIC,
  FIXTURE_ADDRESS_UNREGISTERED,
  FIXTURE_ASSET_AMD,
  FIXTURE_CHAIN_ETHEREUM,
  FIXTURE_ISSUER_SECONDARY,
  FIXTURE_ISSUER_UNAPPROVED,
  FIXTURE_SOURCE_CHAIN_READ,
  FIXTURE_SOURCE_ISSUER_DOCS,
  FIXTURE_SOURCE_THIRD_PARTY,
  FIXTURE_SOURCE_ATTACKER,
  nvdaAsset,
  secondBackedRepresentation,
  syntheticRepresentation,
  twinNameAsset,
  type Json,
} from './fixtures.ts';

/** The situations a registry has to handle correctly. */
export const WorldKind = {
  ONE_BACKED: 'ONE_BACKED',
  BACKED_AND_SYNTHETIC: 'BACKED_AND_SYNTHETIC',
  MULTIPLE_VALID: 'MULTIPLE_VALID',
  TICKER_COLLISION: 'TICKER_COLLISION',
  DUPLICATE_NAMES: 'DUPLICATE_NAMES',
  ALIAS_COLLISION: 'ALIAS_COLLISION',
  WRONG_ISSUER: 'WRONG_ISSUER',
  WRONG_CHAIN: 'WRONG_CHAIN',
  WRONG_UNDERLYING: 'WRONG_UNDERLYING',
  UNKNOWN_BACKING: 'UNKNOWN_BACKING',
  ADVISORY_ONLY_BACKING: 'ADVISORY_ONLY_BACKING',
  CONFLICTING_PROVENANCE: 'CONFLICTING_PROVENANCE',
  STALE_METADATA: 'STALE_METADATA',
  INACTIVE_REPRESENTATION: 'INACTIVE_REPRESENTATION',
  DELISTED_ASSET: 'DELISTED_ASSET',
  UNREGISTERED_FAKE: 'UNREGISTERED_FAKE',
  CORPORATE_ACTION_MISMATCH: 'CORPORATE_ACTION_MISMATCH',
  INJECTED_UNTRUSTED_CLAIM: 'INJECTED_UNTRUSTED_CLAIM',
  MISSING_RIGHTS: 'MISSING_RIGHTS',
  JURISDICTION_RESTRICTED: 'JURISDICTION_RESTRICTED',
} as const;
export type WorldKind = (typeof WorldKind)[keyof typeof WorldKind];

export interface SyntheticWorld {
  readonly kind: WorldKind;
  /** What the world is. Documentation, never read by a decision or an assertion. */
  readonly description: string;
  /** Raw snapshot input, for `openRegistry`. */
  readonly snapshot: Json;
  /** Raw mandate input, for the kernel's `parseMandate`. */
  readonly mandate: Json;
  /** Institutional policy to layer on, if this world needs any. */
  readonly additionalRequirements: Json | null;
  /** Human references worth resolving against this world. */
  readonly references: readonly unknown[];
  /**
   * Representation identifiers to evaluate beyond those the snapshot lists —
   * unregistered contracts and malformed identifiers, so they are reported rather
   * than silently absent.
   */
  readonly probeRepresentationIds: readonly unknown[];
}

const NO_EXTRA: readonly unknown[] = [];

/**
 * Build one world.
 *
 * Total over `WorldKind` and fully deterministic: the same kind always produces a
 * byte-identical snapshot, which is what lets a world be pinned as a decision
 * vector.
 */
export function buildWorld(kind: WorldKind): SyntheticWorld {
  const base = {
    kind,
    mandate: fixtureMandate(),
    additionalRequirements: null,
    references: ['NVDA', 'XNAS:NVDA', 'figi:BBG000BBJQV0', 'NVIDIA Corporation'],
    probeRepresentationIds: NO_EXTRA,
  } as const;

  switch (kind) {
    case WorldKind.ONE_BACKED:
      return {
        ...base,
        description: 'One canonical asset, one fully-backed representation from the approved issuer.',
        snapshot: fixtureSnapshot(),
      };

    case WorldKind.BACKED_AND_SYNTHETIC:
      return {
        ...base,
        description: 'One canonical asset with both a backed and a synthetic representation, from different issuers.',
        snapshot: fixtureSnapshot({ representations: [backedRepresentation(), syntheticRepresentation()] }),
        // Both issuers permitted, so the synthetic is excluded on its semantics
        // rather than on its issuer — which is the distinction being tested.
        mandate: fixtureMandate({ allowedIssuers: ['issuer.fixture.alpha', 'issuer.fixture.beta'] }),
      };

    case WorldKind.MULTIPLE_VALID:
      return {
        ...base,
        description: 'Two equally admissible fully-backed representations of one canonical asset.',
        snapshot: fixtureSnapshot({ representations: [backedRepresentation(), secondBackedRepresentation()] }),
      };

    case WorldKind.TICKER_COLLISION:
      return {
        ...base,
        description: 'Two unrelated canonical assets both listing the ticker NVDA, on different venues.',
        snapshot: fixtureSnapshot({ assets: [nvdaAsset(), colliderAsset()] }),
        references: ['NVDA', 'XNAS:NVDA', 'XLON:NVDA', 'figi:ZZG000TSTFX6'],
      };

    case WorldKind.DUPLICATE_NAMES:
      return {
        ...base,
        description: 'Two unrelated canonical assets sharing one display name.',
        snapshot: fixtureSnapshot({ assets: [nvdaAsset(), twinNameAsset()] }),
        references: ['NVIDIA Corporation', 'NVDA', 'NVDX'],
      };

    case WorldKind.ALIAS_COLLISION:
      return {
        ...base,
        description: 'One alias a curator pointed at two different canonical assets.',
        snapshot: fixtureSnapshot({
          assets: [
            nvdaAsset({ display: { aliases: [{ kind: 'NAME', value: 'Chip Leader' }] } }),
            amdAsset({ display: { aliases: [{ kind: 'NAME', value: 'Chip Leader' }] } }),
          ],
        }),
        references: ['Chip Leader', 'NVDA', 'AMD'],
      };

    case WorldKind.WRONG_ISSUER:
      return {
        ...base,
        description: 'Correct underlying, issuer outside the mandate allowlist.',
        snapshot: fixtureSnapshot({
          representations: [backedRepresentation({ issuer: fixtureVerified(FIXTURE_ISSUER_UNAPPROVED) })],
        }),
      };

    case WorldKind.WRONG_CHAIN:
      return {
        ...base,
        description: 'Correct underlying, deployed on a chain the mandate does not permit.',
        snapshot: fixtureSnapshot({
          representations: [
            backedRepresentation({
              representationId: fixtureRepresentationId(FIXTURE_ADDRESS_OTHER_CHAIN, FIXTURE_CHAIN_ETHEREUM),
            }),
          ],
        }),
        probeRepresentationIds: [fixtureRepresentationId(FIXTURE_ADDRESS_OTHER_CHAIN, FIXTURE_CHAIN_ETHEREUM)],
      };

    case WorldKind.WRONG_UNDERLYING:
      return {
        ...base,
        description: 'A representation issued against a different canonical asset than the mandate names.',
        snapshot: fixtureSnapshot({
          assets: [nvdaAsset(), amdAsset()],
          representations: [backedRepresentation({ underlying: fixtureVerified({ ...FIXTURE_ASSET_AMD }) })],
        }),
        probeRepresentationIds: [fixtureRepresentationId(FIXTURE_ADDRESS_BACKED)],
      };

    case WorldKind.UNKNOWN_BACKING:
      return {
        ...base,
        description: 'Correct underlying, no claim at all about the backing model.',
        snapshot: fixtureSnapshot({ representations: [backedRepresentation({ backing: [] })] }),
        probeRepresentationIds: [fixtureRepresentationId(FIXTURE_ADDRESS_BACKED)],
      };

    case WorldKind.ADVISORY_ONLY_BACKING:
      return {
        ...base,
        description: 'Backing asserted only by an advisory source, which cannot establish a property that gates execution.',
        snapshot: fixtureSnapshot({
          representations: [
            backedRepresentation({
              backing: [fixtureClaim('FULLY_BACKED', 'ADVISORY', FIXTURE_SOURCE_THIRD_PARTY)],
            }),
          ],
        }),
        probeRepresentationIds: [fixtureRepresentationId(FIXTURE_ADDRESS_BACKED)],
      };

    case WorldKind.CONFLICTING_PROVENANCE:
      return {
        ...base,
        description: 'Two sources at the trust floor disagreeing about the backing model: one says backed, one says synthetic.',
        snapshot: fixtureSnapshot({
          representations: [
            backedRepresentation({
              backing: [
                fixtureClaim('FULLY_BACKED', 'VERIFIED', FIXTURE_SOURCE_ISSUER_DOCS),
                fixtureClaim('SYNTHETIC', 'VERIFIED', FIXTURE_SOURCE_CHAIN_READ),
              ],
            }),
          ],
        }),
        probeRepresentationIds: [fixtureRepresentationId(FIXTURE_ADDRESS_BACKED)],
      };

    case WorldKind.STALE_METADATA:
      return {
        ...base,
        description: 'Backing established by a trusted source, observed a day ago, against an hour-long claim-age bound.',
        snapshot: fixtureSnapshot({
          representations: [
            backedRepresentation({
              backing: [fixtureClaim('FULLY_BACKED', 'VERIFIED', FIXTURE_SOURCE_CHAIN_READ, 86_400n)],
            }),
          ],
        }),
        additionalRequirements: { maxClaimAgeSeconds: '3600' },
        probeRepresentationIds: [fixtureRepresentationId(FIXTURE_ADDRESS_BACKED)],
      };

    case WorldKind.INACTIVE_REPRESENTATION:
      return {
        ...base,
        description: 'Correct underlying and issuer, but the representation is issuer-paused.',
        snapshot: fixtureSnapshot({
          representations: [backedRepresentation({ operationalStatus: fixtureVerified('PAUSED') })],
        }),
      };

    case WorldKind.DELISTED_ASSET:
      return {
        ...base,
        description: 'A registered representation of a canonical asset that is no longer active.',
        snapshot: fixtureSnapshot({ assets: [nvdaAsset({ status: 'DELISTED' })] }),
      };

    case WorldKind.UNREGISTERED_FAKE:
      return {
        ...base,
        description:
          'A counterfeit carrying the right symbol, name and claimed underlying, on a contract no curator registered. Never placed in the snapshot.',
        snapshot: fixtureSnapshot(),
        probeRepresentationIds: [
          fixtureRepresentationId(FIXTURE_ADDRESS_UNREGISTERED),
          // A malformed identifier too, so it is reported rather than dropped.
          'eip155:42161/erc20:0xnot-an-address',
        ],
      };

    case WorldKind.CORPORATE_ACTION_MISMATCH:
      return {
        ...base,
        description:
          'A representation that applies corporate actions by issuer accounting adjustment, against a policy accepting only on-chain mechanisms.',
        snapshot: fixtureSnapshot({
          representations: [
            backedRepresentation({ corporateActionHandling: fixtureVerified('ISSUER_ACCOUNTING_ADJUSTMENT') }),
          ],
        }),
        additionalRequirements: { allowedCorporateActionModels: ['SUPPLY_REBASE', 'ON_CHAIN_MULTIPLIER'] },
      };

    case WorldKind.INJECTED_UNTRUSTED_CLAIM:
      return {
        ...base,
        description:
          'An honest backed representation with an untrusted claim injected against it. The injected claim must change nothing.',
        snapshot: fixtureSnapshot({
          representations: [
            backedRepresentation({
              backing: [
                fixtureClaim('FULLY_BACKED', 'VERIFIED', FIXTURE_SOURCE_CHAIN_READ),
                fixtureClaim('SYNTHETIC', 'UNTRUSTED', FIXTURE_SOURCE_ATTACKER),
              ],
            }),
          ],
        }),
      };

    case WorldKind.MISSING_RIGHTS:
      return {
        ...base,
        description: 'A representation with no beneficial-ownership claim, against a policy that requires one.',
        snapshot: fixtureSnapshot(),
        additionalRequirements: {
          requiredRights: [{ kind: 'BENEFICIAL_OWNERSHIP', acceptable: ['PRESENT'] }],
        },
      };

    case WorldKind.JURISDICTION_RESTRICTED:
      return {
        ...base,
        description: 'A holder in a jurisdiction the representation prohibits.',
        snapshot: fixtureSnapshot(),
        additionalRequirements: { holderJurisdiction: 'KP' },
      };
  }
}

export const ALL_WORLD_KINDS: readonly WorldKind[] = Object.values(WorldKind);

export function buildAllWorlds(): readonly SyntheticWorld[] {
  return ALL_WORLD_KINDS.map(buildWorld);
}

/**
 * A seeded pseudo-random world, for property testing over many registries.
 *
 * The generator is a plain LCG over `bigint`, so it uses no floating point and no
 * `Math` — the same arithmetic constraints the rest of this package holds to — and
 * the same seed always produces the same world.
 */
export function generateWorld(seed: number): SyntheticWorld {
  let state = BigInt(seed) & 0xffffffffn;
  const next = (): bigint => {
    state = (state * 1_664_525n + 1_013_904_223n) & 0xffffffffn;
    return state;
  };
  const pick = <T>(options: readonly T[]): T => options[Number(next() % BigInt(options.length))] as T;
  const chance = (percent: number): boolean => next() % 100n < BigInt(percent);

  const representations: Json[] = [];
  const assets: Json[] = [nvdaAsset()];

  // A backed representation, present most of the time, sometimes degraded.
  if (chance(85)) {
    const patch: Json = {};
    if (chance(25)) patch['issuer'] = fixtureVerified(pick([FIXTURE_ISSUER_UNAPPROVED, FIXTURE_ISSUER_SECONDARY]));
    if (chance(20)) patch['operationalStatus'] = fixtureVerified(pick(['PAUSED', 'DEPRECATED', 'TRANSITION']));
    if (chance(20)) {
      patch['backing'] = pick([
        [],
        [fixtureClaim('FULLY_BACKED', 'ADVISORY', FIXTURE_SOURCE_THIRD_PARTY)],
        [
          fixtureClaim('FULLY_BACKED', 'VERIFIED', FIXTURE_SOURCE_ISSUER_DOCS),
          fixtureClaim('SYNTHETIC', 'VERIFIED', FIXTURE_SOURCE_CHAIN_READ),
        ],
      ]);
    }
    if (chance(15)) {
      patch['representationId'] = fixtureRepresentationId(FIXTURE_ADDRESS_BACKED, FIXTURE_CHAIN_ETHEREUM);
    }
    representations.push(backedRepresentation(patch));
  }

  if (chance(50)) representations.push(syntheticRepresentation());
  if (chance(35)) representations.push(secondBackedRepresentation());
  if (chance(30)) assets.push(colliderAsset());
  if (chance(20)) assets.push(amdAsset());

  const mandate = fixtureMandate(
    chance(40)
      ? { syntheticPolicy: 'ALLOWED', allowedIssuers: ['issuer.fixture.alpha', 'issuer.fixture.beta'] }
      : {},
  );

  return {
    kind: WorldKind.ONE_BACKED,
    description: `Generated world, seed ${seed}.`,
    snapshot: fixtureSnapshot({ snapshotId: `fixture.snapshot.generated.${seed}`, assets, representations }),
    mandate,
    additionalRequirements: null,
    references: ['NVDA', 'XNAS:NVDA', 'NVIDIA Corporation', 'figi:BBG000BBJQV0'],
    probeRepresentationIds: [fixtureRepresentationId(FIXTURE_ADDRESS_UNREGISTERED)],
  };
}

export { counterfeitRepresentation, deepMerge, FIXTURE_ADDRESS_SYNTHETIC };
