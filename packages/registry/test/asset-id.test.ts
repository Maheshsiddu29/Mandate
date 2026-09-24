/**
 * Canonical asset identifier validation (ADR 0005).
 *
 * The real-world identifiers used as positive cases are genuine public
 * identifiers of real securities, and are used because a check-digit
 * implementation is only worth anything if it agrees with the authorities that
 * issue them. Everything about *representations* in this package's fixtures is
 * fictional; canonical identifiers are not, because an identifier of NVIDIA is
 * the identifier of NVIDIA.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AssetClass,
  AssetIdScheme,
  canonicalAssetKey,
  isValidSchemeValue,
  validateCanonicalAssetId,
} from '../src/index.ts';

const VALID_FIGIS = ['BBG000BBJQV0', 'BBG000BBQCY0', 'BBG000B9XRY4', 'BBG000BPH459'];
const VALID_ISINS = ['US67066G1040', 'US0378331005', 'US5949181045', 'US0231351067', 'GB0002634946'];
const VALID_CUSIPS = ['037833100', '594918104', '023135106', '912828U81'];

test('real FIGIs validate', () => {
  for (const figi of VALID_FIGIS) {
    assert.ok(isValidSchemeValue(AssetIdScheme.FIGI, figi), figi);
  }
});

test('real ISINs validate', () => {
  for (const isin of VALID_ISINS) {
    assert.ok(isValidSchemeValue(AssetIdScheme.ISIN, isin), isin);
  }
});

test('real CUSIPs validate', () => {
  for (const cusip of VALID_CUSIPS) {
    assert.ok(isValidSchemeValue(AssetIdScheme.CUSIP, cusip), cusip);
  }
});

test('a single-character typo in a FIGI does not validate', () => {
  // This is the whole reason the check digit is verified rather than stored: a
  // typo must not become a different canonical asset.
  assert.equal(isValidSchemeValue(AssetIdScheme.FIGI, 'BBG000BBJQV1'), false, 'check digit');
  assert.equal(isValidSchemeValue(AssetIdScheme.FIGI, 'BBG000BBJQW0'), false, 'body character');
});

test('every single-digit mutation of a check digit is caught', () => {
  for (const figi of VALID_FIGIS) {
    const body = figi.slice(0, 11);
    const actual = figi[11] as string;
    for (const d of '0123456789') {
      if (d === actual) continue;
      assert.equal(isValidSchemeValue(AssetIdScheme.FIGI, body + d), false, `${body}${d}`);
    }
  }
});

test('FIGI structural rules reject non-FIGIs that would otherwise checksum', () => {
  assert.equal(isValidSchemeValue(AssetIdScheme.FIGI, 'BBX000BBJQV0'), false, 'position 3 must be G');
  assert.equal(isValidSchemeValue(AssetIdScheme.FIGI, 'BBG000BBJQV'), false, 'too short');
  assert.equal(isValidSchemeValue(AssetIdScheme.FIGI, 'BBG000BBJQV00'), false, 'too long');
  assert.equal(isValidSchemeValue(AssetIdScheme.FIGI, 'BBG000BBJAV0'), false, 'vowel in the body');
  // Reserved prefixes exist so a FIGI is not confused with a country-coded id.
  assert.equal(isValidSchemeValue(AssetIdScheme.FIGI, 'BSG000BBJQV0'), false, 'reserved prefix');
  assert.equal(isValidSchemeValue(AssetIdScheme.FIGI, 'bbg000bbjqv0'), false, 'lower case');
});

test('ISIN rejects a wrong country-code shape and a wrong check digit', () => {
  assert.equal(isValidSchemeValue(AssetIdScheme.ISIN, 'U567066G1040'), false, 'country code');
  assert.equal(isValidSchemeValue(AssetIdScheme.ISIN, 'US67066G1041'), false, 'check digit');
  assert.equal(isValidSchemeValue(AssetIdScheme.ISIN, 'US67066G104'), false, 'length');
});

test('CUSIP rejects a wrong check digit', () => {
  assert.equal(isValidSchemeValue(AssetIdScheme.CUSIP, '037833101'), false);
  // The design document previously carried 912797GN2, whose check digit does not
  // verify; the correct digit for that body is 1. Pinned so the corrected example
  // cannot drift back.
  assert.equal(isValidSchemeValue(AssetIdScheme.CUSIP, '912797GN2'), false);
  assert.ok(isValidSchemeValue(AssetIdScheme.CUSIP, '912797GN1'));
});

test('a valid canonical asset id validates and keys consistently', () => {
  const r = validateCanonicalAssetId({ assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBJQV0' });
  assert.ok(r.ok);
  assert.equal(r.value.assetClass, AssetClass.EQUITY);
  assert.equal(
    canonicalAssetKey(r.value),
    canonicalAssetKey({ assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBJQV0' } as never),
  );
});

test('an unsupported scheme and an unsupported asset class each have their own code', () => {
  const scheme = validateCanonicalAssetId({ assetClass: 'equity', idScheme: 'sedol', value: 'B0YBKJ7' });
  assert.equal(scheme.ok, false);
  assert.equal(scheme.ok === false ? scheme.error : '', 'ASSET_IDENTIFIER_SCHEME_UNSUPPORTED');

  const cls = validateCanonicalAssetId({ assetClass: 'crypto', idScheme: 'figi', value: 'BBG000BBJQV0' });
  assert.equal(cls.ok, false);
  assert.equal(cls.ok === false ? cls.error : '', 'ASSET_CLASS_UNSUPPORTED');
});

test('an identifier outside the kernel charset is invalid, not repaired', () => {
  for (const bad of [
    { assetClass: 'equity', idScheme: 'figi', value: 'BBG000 BJQV0' },
    { assetClass: 'equity', idScheme: 'figi', value: '' },
    { assetClass: '', idScheme: 'figi', value: 'BBG000BBJQV0' },
    { assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBJQV0 ' },
    'not-an-object',
    null,
    42,
  ]) {
    const r = validateCanonicalAssetId(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});

test('the key separator cannot be forged from segment contents', () => {
  // The kernel identifier charset excludes NUL, so no combination of segments can
  // produce another id's key. Pinned because the index depends on it.
  const a = canonicalAssetKey({ assetClass: 'equity', idScheme: 'figi', value: 'AB' } as never);
  const b = canonicalAssetKey({ assetClass: 'equity', idScheme: 'figiAB', value: '' } as never);
  assert.notEqual(a, b);
});
