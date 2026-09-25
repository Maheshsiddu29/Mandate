/**
 * Shared test fixtures.
 *
 * One coherent, valid world — a backed NVDA representation from an approved
 * issuer, trading normally, quoted at the reference price — plus small typed
 * overrides. Every negative case in the suite is this world with exactly one
 * thing changed, so a test names the difference rather than restating the world.
 *
 * Values here are illustrative test data. The canonical asset identifier and
 * the representation identifier are plausible in shape and are not claimed to
 * be real registry entries; Phase 2 builds the registry.
 */

import {
  parseCandidate,
  parseMandate,
  parseTrustedState,
  type CanonicalMandate,
  type ExecutionCandidate,
  type TrustedState,
} from '../../src/index.ts';

export const NVDA = {
  assetClass: 'equity',
  idScheme: 'figi',
  value: 'BBG000BBJQV0',
} as const;

/** A different canonical asset, for wrong-asset cases. */
export const AMD = {
  assetClass: 'equity',
  idScheme: 'figi',
  value: 'BBG000BBQCY0',
} as const;

export const PRINCIPAL = { kind: 'eip155-address', value: '0x1111111111111111111111111111111111111111' } as const;
export const AGENT = { kind: 'eip155-address', value: '0x2222222222222222222222222222222222222222' } as const;
export const OTHER_AGENT = { kind: 'eip155-address', value: '0x3333333333333333333333333333333333333333' } as const;

export const REPRESENTATION_ID = 'eip155:42161/erc20:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const SYNTHETIC_REPRESENTATION_ID = 'eip155:42161/erc20:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
export const UNREGISTERED_REPRESENTATION_ID = 'eip155:42161/erc20:0xcccccccccccccccccccccccccccccccccccccccc';
/**
 * A contract on a chain the mandate does not allow, presented with the allowed
 * chain in the `chain` field beside it. Before Phase 5R this passed.
 */
export const FOREIGN_CHAIN_REPRESENTATION_ID = 'eip155:1/erc20:0xdddddddddddddddddddddddddddddddddddddddd';

export const ISSUER = 'issuer.alpha';
export const UNAPPROVED_ISSUER = 'issuer.omega';
export const CHAIN = 'eip155:42161';
export const OTHER_CHAIN = 'eip155:1';
export const VENUE = 'venue.alpha';
export const OTHER_VENUE = 'venue.omega';
export const STATE_ID = 'snapshot.0001';

export const MANDATE_ID = '0x' + '11'.repeat(32);

/**
 * Stand-in for the trusted-state digest in a raw candidate.
 *
 * `buildWorld` replaces it with the digest of the state it actually assembled,
 * so a test that does not care about the binding gets a correct one and a test
 * that does can override it. It is never a valid digest by accident.
 */
export const PLACEHOLDER_STATE_DIGEST = '0x' + '00'.repeat(32);

/** Evaluation instant used by the valid world. */
export const NOW = 1_800_000_000n;
export const NOT_BEFORE = NOW - 600n;
export const EXPIRES_AT = NOW + 600n;
export const OBSERVED_AT = NOW - 5n;
export const EPOCH = 7n;

export const PROVENANCE = {
  trustClass: 'VERIFIED',
  sourceId: 'adapter.test',
  observedAtUnixSeconds: OBSERVED_AT,
} as const;

/** 100.00 USD per share, at 2 decimals. */
export const REFERENCE_PRICE = {
  numeratorUnit: 'USD',
  denominatorUnit: 'SHARE',
  decimals: 2,
  atoms: 10_000n,
} as const;

/** 10 shares at 100.00 USD = 1000.00 USD. */
export const QUANTITY = { unit: 'SHARE', decimals: 2, atoms: 1_000n } as const;
export const NOTIONAL = { unit: 'USD', decimals: 2, atoms: 100_000n } as const;
export const MAX_NOTIONAL = { unit: 'USD', decimals: 2, atoms: 100_000n } as const;
/** 2.50 USD of explicit route cost on a 1000.00 USD notional. */
export const FEE_TOTAL = { unit: 'USD', decimals: 2, atoms: 250n } as const;
/**
 * BUY: the most the principal may be debited, fees included. 1006.50 USD.
 *
 * Set to the widest debit the rest of the valid world can reach — the notional
 * at the maximum permitted 40 bps deviation, plus the fee — so that the bound is
 * live without silently gating the price and notional boundary tests. The
 * economic-limit tests set their own.
 */
export const ECONOMIC_LIMIT = { unit: 'USD', decimals: 2, atoms: 100_650n } as const;

type Json = Record<string, unknown>;

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

export function mandateInput(overrides: Json = {}): Json {
  return deepMerge(
    {
      version: 2,
      mandateId: MANDATE_ID,
      nonce: 1n,
      principal: { ...PRINCIPAL },
      agent: { ...AGENT },
      canonicalAsset: { ...NVDA },
      side: 'BUY',
      maxNotional: { ...MAX_NOTIONAL },
      economicLimit: { ...ECONOMIC_LIMIT },
      maxDeviationBps: 40n,
      syntheticPolicy: 'FORBIDDEN',
      allowedIssuers: [ISSUER],
      allowedChains: [CHAIN],
      allowedVenues: [VENUE],
      requiredCorporateActionEpoch: EPOCH,
      maxPriceAgeSeconds: 60n,
      maxCorporateActionAgeSeconds: 300n,
      haltPolicy: 'FORBID_WHEN_HALTED',
      createdAtUnixSeconds: NOT_BEFORE,
      notBeforeUnixSeconds: NOT_BEFORE,
      expiresAtUnixSeconds: EXPIRES_AT,
    },
    overrides,
  );
}

export function candidateInput(overrides: Json = {}): Json {
  return deepMerge(
    {
      version: 2,
      representationId: REPRESENTATION_ID,
      canonicalAsset: { ...NVDA },
      issuer: ISSUER,
      chain: CHAIN,
      venue: VENUE,
      side: 'BUY',
      agent: { ...AGENT },
      quantity: { ...QUANTITY },
      executionPrice: { ...REFERENCE_PRICE },
      notional: { ...NOTIONAL },
      feeTotal: { ...FEE_TOTAL },
      referenceStateId: STATE_ID,
      referenceStateDigest: PLACEHOLDER_STATE_DIGEST,
      corporateActionEpoch: EPOCH,
    },
    overrides,
  );
}

export function representationInput(overrides: Json = {}): Json {
  return deepMerge(
    {
      provenance: { ...PROVENANCE },
      value: {
        representationId: REPRESENTATION_ID,
        canonicalAsset: { ...NVDA },
        issuer: ISSUER,
        chain: CHAIN,
        instrumentType: 'backed.note',
        synthetic: 'NO',
        operationalState: 'ACTIVE',
      },
    },
    overrides,
  );
}

export function syntheticRepresentationInput(overrides: Json = {}): Json {
  return representationInput(
    deepMerge(
      {
        value: {
          representationId: SYNTHETIC_REPRESENTATION_ID,
          instrumentType: 'synthetic.exposure',
          synthetic: 'YES',
        },
      },
      overrides,
    ),
  );
}

export function stateInput(overrides: Json = {}, representations?: Json[]): Json {
  return deepMerge(
    {
      version: 2,
      stateId: STATE_ID,
      registrySnapshotDigest: null,
      representations: representations ?? [representationInput()],
      market: {
        provenance: { ...PROVENANCE },
        value: { canonicalAsset: { ...NVDA }, referencePrice: { ...REFERENCE_PRICE }, haltStatus: 'TRADING' },
      },
      corporateAction: {
        provenance: { ...PROVENANCE },
        value: { canonicalAsset: { ...NVDA }, epoch: EPOCH },
      },
      replay: {
        provenance: { ...PROVENANCE },
        value: { mandateDigest: '0x' + '00'.repeat(32), status: 'UNUSED' },
      },
    },
    overrides,
  );
}

function expectOk<T>(r: { ok: true; value: T } | { ok: false; error: string }, what: string): T {
  if (!r.ok) throw new Error(`fixture ${what} failed to parse: ${r.error}`);
  return r.value;
}

export function validMandate(overrides: Json = {}): CanonicalMandate {
  return expectOk(parseMandate(mandateInput(overrides)), 'mandate');
}

export function validCandidate(overrides: Json = {}): ExecutionCandidate {
  return expectOk(parseCandidate(candidateInput(overrides)), 'candidate');
}

export function validState(overrides: Json = {}, representations?: Json[]): TrustedState {
  return expectOk(parseTrustedState(stateInput(overrides, representations)), 'state');
}
