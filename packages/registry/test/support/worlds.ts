/**
 * Shared builders for registry test worlds.
 *
 * One coherent snapshot — a fictional fully-backed representation of a real
 * canonical asset, from a fictional approved issuer, trading normally — plus small
 * typed patches, so a test names the difference rather than restating the world.
 * The same approach the kernel's fixtures take.
 *
 * Canonical asset identifiers are genuine public identifiers, because the
 * identifier of NVIDIA is the identifier of NVIDIA. **Everything about
 * representations is fictional**: issuers, contracts, token symbols and every
 * metadata claim. Nothing here is real Robinhood, xStocks or Ondo data, and
 * nothing here is real market data.
 */

import { TrustClass, type CanonicalMandate } from '@mandate/kernel';

export const NOW = 1_800_000_000n;

/** Real canonical identifiers of real securities. */
export const NVDA = { assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBJQV0' } as const;
export const AMD = { assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBQCY0' } as const;

/** Fictional issuers. */
export const ISSUER_ALPHA = 'issuer.fixture.alpha';
export const ISSUER_BETA = 'issuer.fixture.beta';
export const ISSUER_OMEGA = 'issuer.fixture.omega';

export const ARBITRUM = 'eip155:42161';
export const ETHEREUM = 'eip155:1';

/** Fictional contract addresses. */
export const ADDRESS_A = '0x' + 'aa'.repeat(20);
export const ADDRESS_B = '0x' + 'bb'.repeat(20);
export const ADDRESS_C = '0x' + 'cc'.repeat(20);
export const ADDRESS_FAKE = '0x' + 'fe'.repeat(20);

export type Json = Record<string, unknown>;

export function repId(address: string, chain = ARBITRUM): string {
  return `${chain}/erc20:${address}`;
}

/** One claim, at a chosen trust class and age. */
export function claim(
  value: unknown,
  trustClass: TrustClass = TrustClass.VERIFIED,
  ageSeconds = 0n,
  sourceId = 'fixture.source.a',
): Json {
  return {
    value,
    provenance: {
      trustClass,
      sourceId,
      observedAtUnixSeconds: String(NOW - ageSeconds),
    },
  };
}

export function verified(value: unknown, sourceId = 'fixture.source.a'): Json[] {
  return [claim(value, TrustClass.VERIFIED, 0n, sourceId)];
}

function deepMerge(base: Json, patch: Json): Json {
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

export function assetInput(overrides: Json = {}): Json {
  return deepMerge(
    {
      identity: { ...NVDA },
      status: 'ACTIVE',
      display: {
        primaryName: 'NVIDIA Corporation',
        displayTicker: 'NVDA',
        primaryMarketIdentifier: 'XNAS',
        listings: [{ mic: 'XNAS', ticker: 'NVDA' }],
        aliases: [],
      },
    },
    overrides,
  );
}

export function amdAssetInput(overrides: Json = {}): Json {
  return assetInput(
    deepMerge(
      {
        identity: { ...AMD },
        display: {
          primaryName: 'Advanced Micro Devices Inc',
          displayTicker: 'AMD',
          listings: [{ mic: 'XNAS', ticker: 'AMD' }],
        },
      },
      overrides,
    ),
  );
}

/** A fully-backed, active, approved-issuer representation. The valid world. */
export function representationInput(overrides: Json = {}): Json {
  return deepMerge(
    {
      representationId: repId(ADDRESS_A),
      display: { tokenSymbol: 'NVDAX', tokenName: 'Fixture Backed NVDA Note' },
      underlying: verified({ ...NVDA }),
      issuer: verified(ISSUER_ALPHA),
      instrumentType: verified('BACKED_NOTE'),
      backing: verified('FULLY_BACKED'),
      redemption: verified('QUALIFIED_HOLDERS_ONLY'),
      rights: {
        ECONOMIC_EXPOSURE: verified('PRESENT'),
        DIVIDEND_TREATMENT: verified('PRESENT'),
        VOTING_RIGHTS: verified('ABSENT'),
        TRANSFERABILITY: verified('PRESENT'),
      },
      corporateActionHandling: verified('ON_CHAIN_MULTIPLIER'),
      settlement: verified('ATOMIC_ON_CHAIN'),
      operationalStatus: verified('ACTIVE'),
      eligibility: verified({ permitted: ['US', 'GB'], prohibited: ['KP'] }),
    },
    overrides,
  );
}

/** A synthetic representation of the same underlying, from another issuer. */
export function syntheticRepresentationInput(overrides: Json = {}): Json {
  return representationInput(
    deepMerge(
      {
        representationId: repId(ADDRESS_B),
        display: { tokenSymbol: 'NVDAS', tokenName: 'Fixture Synthetic NVDA Exposure' },
        issuer: verified(ISSUER_BETA),
        instrumentType: verified('SYNTHETIC_EXPOSURE'),
        backing: verified('SYNTHETIC'),
        redemption: verified('NONE'),
        rights: {
          ECONOMIC_EXPOSURE: verified('PRESENT'),
          DIVIDEND_TREATMENT: verified('PRICE_ADJUSTED'),
          VOTING_RIGHTS: verified('ABSENT'),
          TRANSFERABILITY: verified('PRESENT'),
        },
        corporateActionHandling: verified('ISSUER_ACCOUNTING_ADJUSTMENT'),
        settlement: verified('DEFERRED'),
      },
      overrides,
    ),
  );
}

export function snapshotInput(overrides: Json = {}): Json {
  return deepMerge(
    {
      registrySchemaVersion: 1,
      snapshotId: 'fixture.snapshot.0001',
      createdAtUnixSeconds: String(NOW),
      dataClass: 'SYNTHETIC_FIXTURE',
      sourceVersions: [{ sourceId: 'fixture.source.a', version: '1' }],
      assets: [assetInput()],
      representations: [representationInput()],
    },
    overrides,
  );
}

/**
 * A mandate matching the valid world: NVDA, backed only, issuer alpha, Arbitrum.
 *
 * Parsed through the kernel's own `parseMandate` at the call site, so the registry
 * is always tested against a mandate the kernel accepts.
 */
export function mandateInput(overrides: Json = {}): Json {
  return deepMerge(
    {
      version: 2,
      mandateId: '0x' + '11'.repeat(32),
      nonce: '1',
      principal: { kind: 'eip155-address', value: '0x1111111111111111111111111111111111111111' },
      agent: { kind: 'eip155-address', value: '0x2222222222222222222222222222222222222222' },
      canonicalAsset: { ...NVDA },
      side: 'BUY',
      maxNotional: { unit: 'USD', decimals: 2, atoms: '100000' },
      economicLimit: { unit: 'USD', decimals: 2, atoms: '100650' },
      maxDeviationBps: '40',
      syntheticPolicy: 'FORBIDDEN',
      allowedIssuers: [ISSUER_ALPHA],
      allowedChains: [ARBITRUM],
      allowedVenues: ['venue.fixture.alpha'],
      requiredCorporateActionEpoch: '7',
      maxPriceAgeSeconds: '60',
      maxCorporateActionAgeSeconds: '300',
      haltPolicy: 'FORBID_WHEN_HALTED',
      createdAtUnixSeconds: String(NOW - 600n),
      notBeforeUnixSeconds: String(NOW - 600n),
      expiresAtUnixSeconds: String(NOW + 600n),
    },
    overrides,
  );
}

export type { CanonicalMandate };
