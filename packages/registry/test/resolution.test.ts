/**
 * Reference resolution (ADR 0005).
 *
 * The cases that matter most are the refusals. A resolver that returns something
 * plausible for `NVDA` when two securities list `NVDA` is the bug this layer
 * exists to prevent, so most of this file is about proving that symbol equality
 * cannot stand in for canonical asset equality.
 *
 * Canonical identifiers here are genuine public identifiers. The second `NVDA`
 * asset is a constructed, check-digit-valid FIGI on a fictional venue: it is not
 * claimed to identify any real security, and it exists to make the collision
 * case real rather than hypothetical.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAssetIndex,
  parseCanonicalAssetRecord,
  resolveReference,
  ResolutionStatus,
  type CanonicalAssetRecord,
} from '../src/index.ts';

type Json = Record<string, unknown>;

function record(patch: Json): CanonicalAssetRecord {
  const base: Json = {
    identity: { assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBJQV0' },
    status: 'ACTIVE',
    display: {
      primaryName: 'NVIDIA Corporation',
      displayTicker: 'NVDA',
      primaryMarketIdentifier: 'XNAS',
      listings: [{ mic: 'XNAS', ticker: 'NVDA' }],
      aliases: [],
    },
  };
  const merged: Json = { ...base, ...patch };
  if (patch['display'] !== undefined) {
    merged['display'] = { ...(base['display'] as Json), ...(patch['display'] as Json) };
  }
  const r = parseCanonicalAssetRecord(merged);
  if (!r.ok) throw new Error(`fixture asset failed to parse: ${r.error}`);
  return r.value;
}

const NVDA = record({});

/** A different security that also lists the ticker NVDA, on a different venue. */
const NVDA_COLLIDER = record({
  identity: { assetClass: 'equity', idScheme: 'figi', value: 'BBG000BPH459' },
  display: {
    primaryName: 'Nividia Holdings PLC',
    displayTicker: 'NVDA',
    primaryMarketIdentifier: 'XLON',
    listings: [{ mic: 'XLON', ticker: 'NVDA' }],
    aliases: [],
  },
});

const AMD = record({
  identity: { assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBQCY0' },
  display: {
    primaryName: 'Advanced Micro Devices Inc',
    displayTicker: 'AMD',
    primaryMarketIdentifier: 'XNAS',
    listings: [{ mic: 'XNAS', ticker: 'AMD' }],
    aliases: [
      { kind: 'NAME', value: 'AMD Inc' },
      { kind: 'EXCHANGE_QUALIFIED', value: 'NASDAQ:AMD' },
    ],
  },
});

function index(assets: readonly CanonicalAssetRecord[]) {
  const r = buildAssetIndex(assets);
  if (!r.ok) throw new Error(`index build failed: ${r.error}`);
  return r.value;
}

const SINGLE = index([NVDA, AMD]);
const COLLIDING = index([NVDA, NVDA_COLLIDER, AMD]);

function resolvedValue(resolution: ReturnType<typeof resolveReference>): string {
  assert.equal(resolution.status, ResolutionStatus.RESOLVED, JSON.stringify(resolution));
  return resolution.status === 'RESOLVED' ? resolution.asset.identity.value : '';
}

// --- resolution that succeeds ----------------------------------------------

test('an exact structured canonical id resolves', () => {
  const r = resolveReference(SINGLE, { assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBJQV0' });
  assert.equal(resolvedValue(r), 'BBG000BBJQV0');
  assert.equal(r.status === 'RESOLVED' ? r.matchedBy : '', 'CANONICAL_ID');
});

test('the full canonical id string resolves', () => {
  const r = resolveReference(SINGLE, 'mandate:asset:equity:figi:BBG000BBJQV0');
  assert.equal(resolvedValue(r), 'BBG000BBJQV0');
});

test('a scheme-qualified value resolves', () => {
  assert.equal(resolvedValue(resolveReference(SINGLE, 'figi:BBG000BBJQV0')), 'BBG000BBJQV0');
  // The scheme name is matched case-insensitively; the value is not, because
  // case-folding a scheme value would be repairing an identifier.
  assert.equal(resolvedValue(resolveReference(SINGLE, 'FIGI:BBG000BBJQV0')), 'BBG000BBJQV0');
  assert.equal(resolveReference(SINGLE, 'figi:bbg000bbjqv0').status, ResolutionStatus.INVALID);
});

test('a bare ticker resolves when only one asset lists it', () => {
  assert.equal(resolvedValue(resolveReference(SINGLE, 'NVDA')), 'BBG000BBJQV0');
  assert.equal(resolvedValue(resolveReference(SINGLE, 'nvda')), 'BBG000BBJQV0');
  assert.equal(resolvedValue(resolveReference(SINGLE, '  NVDA  ')), 'BBG000BBJQV0');
});

test('a registered company name and alias resolve', () => {
  assert.equal(resolvedValue(resolveReference(SINGLE, 'NVIDIA Corporation')), 'BBG000BBJQV0');
  assert.equal(resolvedValue(resolveReference(SINGLE, 'advanced   micro  devices inc')), 'BBG000BBQCY0');
  assert.equal(resolvedValue(resolveReference(SINGLE, 'AMD Inc')), 'BBG000BBQCY0');
});

test('a MIC-qualified ticker resolves, and disambiguates a collision', () => {
  assert.equal(resolvedValue(resolveReference(COLLIDING, 'XNAS:NVDA')), 'BBG000BBJQV0');
  assert.equal(resolvedValue(resolveReference(COLLIDING, 'XLON:NVDA')), 'BBG000BPH459');
});

test('an exchange-name-qualified alias resolves only where a curator registered it', () => {
  // ADR 0005: NASDAQ is an exchange name, not a MIC. It works because AMD carries
  // the alias explicitly, and not otherwise.
  assert.equal(resolvedValue(resolveReference(SINGLE, 'NASDAQ:AMD')), 'BBG000BBQCY0');
  assert.equal(resolveReference(SINGLE, 'NASDAQ:NVDA').status, ResolutionStatus.UNKNOWN);
});

// --- resolution that refuses ------------------------------------------------

test('a ticker used by two assets is ambiguous and chooses neither', () => {
  const r = resolveReference(COLLIDING, 'NVDA');
  assert.equal(r.status, ResolutionStatus.AMBIGUOUS);
  if (r.status !== 'AMBIGUOUS') return;
  assert.equal(r.reasonCode, 'REFERENCE_AMBIGUOUS');
  assert.deepEqual(
    r.candidates.map((c) => c.identity.value),
    ['BBG000BBJQV0', 'BBG000BPH459'],
  );
});

test('symbol equality cannot satisfy canonical asset equality', () => {
  // The two colliding assets share a ticker and share nothing else. Neither
  // resolution nor identity treats them as the same asset.
  const r = resolveReference(COLLIDING, 'NVDA');
  assert.equal(r.status, ResolutionStatus.AMBIGUOUS);
  assert.notEqual(NVDA.identity.value, NVDA_COLLIDER.identity.value);
  assert.equal(NVDA.display.displayTicker, NVDA_COLLIDER.display.displayTicker);
});

test('duplicate human-readable company names are ambiguous', () => {
  const twin = record({
    identity: { assetClass: 'equity', idScheme: 'figi', value: 'BBG000B9XRY4' },
    display: {
      primaryName: 'NVIDIA Corporation',
      displayTicker: 'NVDX',
      primaryMarketIdentifier: 'XETR',
      listings: [{ mic: 'XETR', ticker: 'NVDX' }],
      aliases: [],
    },
  });
  const r = resolveReference(index([NVDA, twin]), 'NVIDIA Corporation');
  assert.equal(r.status, ResolutionStatus.AMBIGUOUS);
});

test('an alias pointing at two canonical assets is ambiguous', () => {
  const a = record({ display: { aliases: [{ kind: 'NAME', value: 'Chip Leader' }] } });
  const b = record({
    identity: { assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBQCY0' },
    display: {
      primaryName: 'Advanced Micro Devices Inc',
      displayTicker: 'AMD',
      primaryMarketIdentifier: 'XNAS',
      listings: [{ mic: 'XNAS', ticker: 'AMD' }],
      aliases: [{ kind: 'NAME', value: 'Chip Leader' }],
    },
  });
  const r = resolveReference(index([a, b]), 'chip leader');
  assert.equal(r.status, ResolutionStatus.AMBIGUOUS);
  if (r.status !== 'AMBIGUOUS') return;
  assert.equal(r.candidates.length, 2);
});

test('an unknown reference rejects rather than matching something similar', () => {
  for (const ref of ['NVDAA', 'NVID', 'NVIDIA Corp', 'ZZZZ', 'XNAS:ZZZZ', 'figi:BBG000BPH459']) {
    assert.equal(resolveReference(SINGLE, ref).status, ResolutionStatus.UNKNOWN, ref);
  }
});

test('a malformed reference is INVALID, distinct from unknown', () => {
  const cases: readonly [unknown, string][] = [
    ['NASDAQ:', 'empty right segment'],
    [':NVDA', 'empty left segment'],
    ['XNAS:NVDA:EXTRA', 'excess segment'],
    ['mandate:asset:equity:figi', 'incomplete canonical id'],
    ['mandate:asset:equity:figi:BBG000BBJQV0:X', 'excess canonical id segment'],
    ['NVIDIA Corporation', 'non-ASCII'],
    ['', 'empty'],
    ['   ', 'whitespace only'],
    ['x'.repeat(129), 'over the length bound'],
    [42, 'not a string or structured id'],
    [null, 'null'],
  ];
  for (const [ref, label] of cases) {
    assert.equal(resolveReference(SINGLE, ref).status, ResolutionStatus.INVALID, label);
  }
});

test('a scheme-qualified value with a bad check digit is INVALID, not unknown', () => {
  const r = resolveReference(SINGLE, 'figi:BBG000BBJQV1');
  assert.equal(r.status, ResolutionStatus.INVALID);
  assert.equal(r.status === 'INVALID' ? r.reasonCode : '', 'ASSET_IDENTIFIER_INVALID');
});

// --- determinism and identity -----------------------------------------------

test('resolution does not depend on the order assets were supplied', () => {
  const a = resolveReference(index([NVDA, NVDA_COLLIDER, AMD]), 'NVDA');
  const b = resolveReference(index([AMD, NVDA_COLLIDER, NVDA]), 'NVDA');
  assert.deepEqual(a, b);
});

test('two records for one canonical identity reject the snapshot', () => {
  // Two entries for one asset would make every lookup order-dependent, so it is
  // refused. A shared lookup *key* is legitimate and resolves ambiguous instead.
  const r = buildAssetIndex([NVDA, record({ display: { primaryName: 'NVIDIA Corp' } })]);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false ? r.error : '', 'SNAPSHOT_MALFORMED');
});

test('changing display metadata does not change canonical identity', () => {
  const renamed = record({
    display: {
      primaryName: 'Nvidia Corp (renamed)',
      displayTicker: 'NVDA2',
      primaryMarketIdentifier: 'XNYS',
      listings: [{ mic: 'XNYS', ticker: 'NVDA2' }],
      aliases: [{ kind: 'LEGACY_TICKER', value: 'NVDA' }],
    },
  });
  assert.deepEqual(renamed.identity, NVDA.identity);
  // And it still resolves by its unchanged canonical identity.
  const r = resolveReference(index([renamed]), { assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBJQV0' });
  assert.equal(resolvedValue(r), 'BBG000BBJQV0');
});

test('an alias carrying a colon must be declared exchange-qualified', () => {
  const bad = parseCanonicalAssetRecord({
    identity: { assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBJQV0' },
    status: 'ACTIVE',
    display: {
      primaryName: 'NVIDIA Corporation',
      displayTicker: 'NVDA',
      primaryMarketIdentifier: 'XNAS',
      listings: [],
      aliases: [{ kind: 'NAME', value: 'NASDAQ:NVDA' }],
    },
  });
  assert.equal(bad.ok, false);
});

test('display text is rejected rather than trimmed', () => {
  const bad = parseCanonicalAssetRecord({
    identity: { assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBJQV0' },
    status: 'ACTIVE',
    display: {
      primaryName: ' NVIDIA Corporation ',
      displayTicker: null,
      primaryMarketIdentifier: null,
      listings: [],
      aliases: [],
    },
  });
  assert.equal(bad.ok, false);
});
