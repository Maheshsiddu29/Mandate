/**
 * Development fixture data. **TEST / SYNTHETIC.**
 *
 * ## What is real and what is not
 *
 * **Real:** the canonical asset identifiers of real securities (NVIDIA, AMD). A
 * FIGI that identifies NVIDIA identifies NVIDIA, and inventing a different one
 * would be modelling the problem wrongly.
 *
 * **Fictional:** everything else. Every issuer, contract address, token symbol,
 * token name, backing claim, redemption model, rights profile, corporate-action
 * model, settlement model and eligibility profile below is invented for exercising
 * semantics.
 *
 * Nothing here is real Robinhood, xStocks, Ondo or any other issuer's data, and
 * nothing here is real market data. No claim in this file was observed from any
 * live source. Real market data begins in Phase 3
 * ([roadmap](../../../../docs/roadmap.md)).
 *
 * The fictional canonical assets use `ZZ`/`QQ` FIGI prefixes with valid check
 * digits. They are constructed so the identifier validator accepts them and are
 * not claimed to identify any real security.
 *
 * Every snapshot built here declares `dataClass: SYNTHETIC_FIXTURE`, which is the
 * machine-readable form of this notice. No decision reads that field: there is one
 * decision engine, not a real one and a simulated one.
 */

import { TrustClass } from '@mandate/kernel';

/** Real canonical identifiers of real securities. */
export const FIXTURE_ASSET_NVDA = { assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBJQV0' } as const;
export const FIXTURE_ASSET_AMD = { assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBQCY0' } as const;

/**
 * Fictional canonical assets, for collision and ambiguity cases.
 *
 * `ZZG000TSTFX6` deliberately lists the ticker `NVDA` on a different venue, so a
 * bare-ticker lookup is genuinely ambiguous rather than hypothetically so.
 */
export const FIXTURE_ASSET_COLLIDER = { assetClass: 'equity', idScheme: 'figi', value: 'ZZG000TSTFX6' } as const;
export const FIXTURE_ASSET_TWIN = { assetClass: 'equity', idScheme: 'figi', value: 'QQG000QQQQ17' } as const;

/** Fictional issuers. */
export const FIXTURE_ISSUER_APPROVED = 'issuer.fixture.alpha';
export const FIXTURE_ISSUER_SECONDARY = 'issuer.fixture.beta';
export const FIXTURE_ISSUER_UNAPPROVED = 'issuer.fixture.omega';

/** Fictional data sources. */
export const FIXTURE_SOURCE_ISSUER_DOCS = 'fixture.source.issuer-docs';
export const FIXTURE_SOURCE_CHAIN_READ = 'fixture.source.chain-read';
export const FIXTURE_SOURCE_THIRD_PARTY = 'fixture.source.third-party-feed';
export const FIXTURE_SOURCE_ATTACKER = 'fixture.source.unverified-submission';

export const FIXTURE_CHAIN_ARBITRUM = 'eip155:42161';
export const FIXTURE_CHAIN_ETHEREUM = 'eip155:1';

/** Fictional contract addresses. Recognizable as fixtures at a glance. */
export const FIXTURE_ADDRESS_BACKED = '0x' + 'a1'.repeat(20);
export const FIXTURE_ADDRESS_SYNTHETIC = '0x' + 'b2'.repeat(20);
export const FIXTURE_ADDRESS_SECOND_BACKED = '0x' + 'c3'.repeat(20);
export const FIXTURE_ADDRESS_OTHER_CHAIN = '0x' + 'd4'.repeat(20);
/** Never registered in any fixture snapshot. The counterfeit. */
export const FIXTURE_ADDRESS_UNREGISTERED = '0x' + 'fe'.repeat(20);

/** The instant fixture worlds are built around. Fixed, so nothing depends on a clock. */
export const FIXTURE_NOW = 1_800_000_000n;

export const FIXTURE_VENUE = 'venue.fixture.alpha';

export type Json = Record<string, unknown>;

/** One claim, at a chosen trust class, source and age. */
export function fixtureClaim(
  value: unknown,
  trustClass: TrustClass = TrustClass.VERIFIED,
  sourceId: string = FIXTURE_SOURCE_ISSUER_DOCS,
  ageSeconds = 0n,
): Json {
  return {
    value,
    provenance: { trustClass, sourceId, observedAtUnixSeconds: String(FIXTURE_NOW - ageSeconds) },
  };
}

/** A single verified claim — the common case. */
export function fixtureVerified(value: unknown, sourceId: string = FIXTURE_SOURCE_ISSUER_DOCS): Json[] {
  return [fixtureClaim(value, TrustClass.VERIFIED, sourceId)];
}

export function fixtureRepresentationId(address: string, chain: string = FIXTURE_CHAIN_ARBITRUM): string {
  return `${chain}/erc20:${address}`;
}

export function deepMerge(base: Json, patch: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const existing = out[k];
    if (
      v !== null && typeof v === 'object' && !Array.isArray(v) &&
      existing !== null && typeof existing === 'object' && !Array.isArray(existing)
    ) {
      out[k] = deepMerge(existing as Json, v as Json);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// --- Asset inputs -----------------------------------------------------------

export function nvdaAsset(overrides: Json = {}): Json {
  return deepMerge(
    {
      identity: { ...FIXTURE_ASSET_NVDA },
      status: 'ACTIVE',
      display: {
        primaryName: 'NVIDIA Corporation',
        displayTicker: 'NVDA',
        primaryMarketIdentifier: 'XNAS',
        listings: [{ mic: 'XNAS', ticker: 'NVDA' }],
        aliases: [
          { kind: 'NAME', value: 'NVIDIA' },
          { kind: 'EXCHANGE_QUALIFIED', value: 'NASDAQ:NVDA' },
        ],
      },
    },
    overrides,
  );
}

export function amdAsset(overrides: Json = {}): Json {
  return deepMerge(
    {
      identity: { ...FIXTURE_ASSET_AMD },
      status: 'ACTIVE',
      display: {
        primaryName: 'Advanced Micro Devices Inc',
        displayTicker: 'AMD',
        primaryMarketIdentifier: 'XNAS',
        listings: [{ mic: 'XNAS', ticker: 'AMD' }],
        aliases: [{ kind: 'NAME', value: 'AMD' }],
      },
    },
    overrides,
  );
}

/**
 * A fictional security that also lists the ticker `NVDA`, on a different venue.
 *
 * This is what makes ticker collision a real case in the fixtures rather than a
 * hypothetical one.
 */
export function colliderAsset(overrides: Json = {}): Json {
  return deepMerge(
    {
      identity: { ...FIXTURE_ASSET_COLLIDER },
      status: 'ACTIVE',
      display: {
        primaryName: 'Nvidia Holdings PLC (fixture, unrelated)',
        displayTicker: 'NVDA',
        primaryMarketIdentifier: 'XLON',
        listings: [{ mic: 'XLON', ticker: 'NVDA' }],
        aliases: [],
      },
    },
    overrides,
  );
}

/** A fictional security sharing a display name with another, for name ambiguity. */
export function twinNameAsset(overrides: Json = {}): Json {
  return deepMerge(
    {
      identity: { ...FIXTURE_ASSET_TWIN },
      status: 'ACTIVE',
      display: {
        primaryName: 'NVIDIA Corporation',
        displayTicker: 'NVDX',
        primaryMarketIdentifier: 'XETR',
        listings: [{ mic: 'XETR', ticker: 'NVDX' }],
        aliases: [],
      },
    },
    overrides,
  );
}

// --- Representation inputs --------------------------------------------------

/**
 * The baseline: a fictional fully-backed note on a real underlying, from the
 * approved fictional issuer, active and unrestricted.
 */
export function backedRepresentation(overrides: Json = {}): Json {
  return deepMerge(
    {
      representationId: fixtureRepresentationId(FIXTURE_ADDRESS_BACKED),
      display: { tokenSymbol: 'FXNVDA', tokenName: 'Fixture Backed NVDA Note' },
      underlying: fixtureVerified({ ...FIXTURE_ASSET_NVDA }),
      issuer: fixtureVerified(FIXTURE_ISSUER_APPROVED),
      instrumentType: fixtureVerified('BACKED_NOTE'),
      backing: fixtureVerified('FULLY_BACKED', FIXTURE_SOURCE_CHAIN_READ),
      redemption: fixtureVerified('QUALIFIED_HOLDERS_ONLY'),
      rights: {
        ECONOMIC_EXPOSURE: fixtureVerified('PRESENT'),
        DIVIDEND_TREATMENT: fixtureVerified('PRESENT'),
        VOTING_RIGHTS: fixtureVerified('ABSENT'),
        REDEMPTION_RIGHTS: fixtureVerified('RESTRICTED'),
        TRANSFERABILITY: fixtureVerified('PRESENT'),
      },
      corporateActionHandling: fixtureVerified('ON_CHAIN_MULTIPLIER', FIXTURE_SOURCE_CHAIN_READ),
      settlement: fixtureVerified('ATOMIC_ON_CHAIN'),
      operationalStatus: fixtureVerified('ACTIVE', FIXTURE_SOURCE_CHAIN_READ),
      eligibility: fixtureVerified({ permitted: ['US', 'GB'], prohibited: ['KP'] }),
    },
    overrides,
  );
}

/** A fictional synthetic exposure on the same underlying, from another issuer. */
export function syntheticRepresentation(overrides: Json = {}): Json {
  return backedRepresentation(
    deepMerge(
      {
        representationId: fixtureRepresentationId(FIXTURE_ADDRESS_SYNTHETIC),
        display: { tokenSymbol: 'FXNVDS', tokenName: 'Fixture Synthetic NVDA Exposure' },
        issuer: fixtureVerified(FIXTURE_ISSUER_SECONDARY),
        instrumentType: fixtureVerified('SYNTHETIC_EXPOSURE'),
        backing: fixtureVerified('SYNTHETIC', FIXTURE_SOURCE_CHAIN_READ),
        redemption: fixtureVerified('NONE'),
        rights: {
          ECONOMIC_EXPOSURE: fixtureVerified('PRESENT'),
          // The distinction a single boolean loses: the price tracks, nothing is paid.
          DIVIDEND_TREATMENT: fixtureVerified('PRICE_ADJUSTED'),
          VOTING_RIGHTS: fixtureVerified('ABSENT'),
          REDEMPTION_RIGHTS: fixtureVerified('ABSENT'),
          TRANSFERABILITY: fixtureVerified('PRESENT'),
        },
        corporateActionHandling: fixtureVerified('ISSUER_ACCOUNTING_ADJUSTMENT'),
        settlement: fixtureVerified('DEFERRED'),
      },
      overrides,
    ),
  );
}

/** A second fictional fully-backed representation, from the approved issuer. */
export function secondBackedRepresentation(overrides: Json = {}): Json {
  return backedRepresentation(
    deepMerge(
      {
        representationId: fixtureRepresentationId(FIXTURE_ADDRESS_SECOND_BACKED),
        display: { tokenSymbol: 'FXNVDB', tokenName: 'Fixture Backed NVDA Note Series B' },
        redemption: fixtureVerified('OPEN_REDEMPTION'),
      },
      overrides,
    ),
  );
}

/**
 * A counterfeit: the right symbol, the right name, the right claimed underlying,
 * and a contract no curator ever registered.
 *
 * Only ever used as a *probe* — it is deliberately never placed in a snapshot, so
 * that evaluating it exercises the unregistered-contract invariant.
 */
export function counterfeitRepresentation(overrides: Json = {}): Json {
  return backedRepresentation(
    deepMerge(
      {
        representationId: fixtureRepresentationId(FIXTURE_ADDRESS_UNREGISTERED),
        display: { tokenSymbol: 'FXNVDA', tokenName: 'Fixture Backed NVDA Note' },
      },
      overrides,
    ),
  );
}

// --- Snapshot and mandate ---------------------------------------------------

export function fixtureSnapshot(overrides: Json = {}): Json {
  return deepMerge(
    {
      registrySchemaVersion: 1,
      snapshotId: 'fixture.snapshot.dev',
      createdAtUnixSeconds: String(FIXTURE_NOW),
      // The machine-readable form of this file's notice.
      dataClass: 'SYNTHETIC_FIXTURE',
      sourceVersions: [
        { sourceId: FIXTURE_SOURCE_ISSUER_DOCS, version: 'fixture-1' },
        { sourceId: FIXTURE_SOURCE_CHAIN_READ, version: 'fixture-1' },
      ],
      assets: [nvdaAsset()],
      representations: [backedRepresentation()],
    },
    overrides,
  );
}

/**
 * A mandate matching the baseline world: NVDA, backed only, approved issuer,
 * Arbitrum.
 *
 * Shaped for the kernel's `parseMandate`, so registry behaviour is always
 * exercised against a mandate the kernel accepts.
 */
export function fixtureMandate(overrides: Json = {}): Json {
  return deepMerge(
    {
      version: 2,
      mandateId: '0x' + '11'.repeat(32),
      nonce: '1',
      principal: { kind: 'eip155-address', value: '0x1111111111111111111111111111111111111111' },
      agent: { kind: 'eip155-address', value: '0x2222222222222222222222222222222222222222' },
      canonicalAsset: { ...FIXTURE_ASSET_NVDA },
      side: 'BUY',
      maxNotional: { unit: 'USD', decimals: 2, atoms: '100000' },
      economicLimit: { unit: 'USD', decimals: 2, atoms: '100650' },
      maxDeviationBps: '40',
      syntheticPolicy: 'FORBIDDEN',
      allowedIssuers: [FIXTURE_ISSUER_APPROVED],
      allowedChains: [FIXTURE_CHAIN_ARBITRUM],
      allowedVenues: [FIXTURE_VENUE],
      requiredCorporateActionEpoch: '7',
      maxPriceAgeSeconds: '60',
      maxCorporateActionAgeSeconds: '300',
      haltPolicy: 'FORBID_WHEN_HALTED',
      createdAtUnixSeconds: String(FIXTURE_NOW - 600n),
      notBeforeUnixSeconds: String(FIXTURE_NOW - 600n),
      expiresAtUnixSeconds: String(FIXTURE_NOW + 600n),
    },
    overrides,
  );
}
