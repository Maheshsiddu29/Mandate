/**
 * Registry encoding and digests (ADR 0007).
 *
 * The properties worth pinning are the ones a future reimplementation or a future
 * audit depends on: that ordering cannot reach a digest, that identity and display
 * are separable by digest, and that registry tags cannot collide with kernel tags.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DomainTag, INT64_MAX, INT64_MIN } from '@mandate/kernel';
import {
  canonicalAssetIdentityDigest,
  canonicalAssetRecordDigest,
  parseCanonicalAssetRecord,
  parseRegistrySnapshot,
  RegistryDomainTag,
  registrySnapshotDigest,
  representationRecordDigest,
  type CanonicalAssetRecord,
  type RegistrySnapshot,
} from '../src/index.ts';
import {
  ADDRESS_A,
  ADDRESS_B,
  assetInput,
  amdAssetInput,
  claim,
  repId,
  representationInput,
  snapshotInput,
  syntheticRepresentationInput,
  verified,
  type Json,
} from './support/worlds.ts';

function snapshot(overrides: Json = {}): RegistrySnapshot {
  const r = parseRegistrySnapshot(snapshotInput(overrides));
  if (!r.ok) throw new Error(`snapshot failed to parse: ${r.error}`);
  return r.value;
}

function asset(overrides: Json = {}): CanonicalAssetRecord {
  const r = parseCanonicalAssetRecord(assetInput(overrides));
  if (!r.ok) throw new Error(`asset failed to parse: ${r.error}`);
  return r.value;
}

// --- domain separation ------------------------------------------------------

test('no registry tag equals or prefixes a kernel tag, or vice versa', () => {
  // Tags are unterminated, so a prefix relationship would break domain
  // separation between two object types.
  const registryTags = Object.values(RegistryDomainTag);
  const kernelTags = Object.values(DomainTag);
  for (const r of registryTags) {
    for (const k of kernelTags) {
      assert.notEqual(r, k, `tag collision: ${r}`);
      assert.equal(r.startsWith(k), false, `${r} is prefixed by kernel tag ${k}`);
      assert.equal(k.startsWith(r), false, `${k} is prefixed by registry tag ${r}`);
    }
  }
  // And registry tags must be mutually non-prefixing too.
  for (const a of registryTags) {
    for (const b of registryTags) {
      if (a === b) continue;
      assert.equal(a.startsWith(b), false, `${a} is prefixed by ${b}`);
    }
  }
});

test('a digest over one registry object type cannot be replayed as another', () => {
  const record = asset();
  assert.notEqual(canonicalAssetIdentityDigest(record.identity), canonicalAssetRecordDigest(record));
});

// --- determinism ------------------------------------------------------------

test('the snapshot digest is stable across repeated computation', () => {
  const s = snapshot();
  assert.equal(registrySnapshotDigest(s), registrySnapshotDigest(s));
  assert.match(registrySnapshotDigest(s), /^0x[0-9a-f]{64}$/);
});

test('every parsed snapshot creation time is encodable as signed i64', () => {
  for (const value of [INT64_MIN, INT64_MAX]) {
    const parsed = parseRegistrySnapshot(snapshotInput({ createdAtUnixSeconds: value }));
    assert.ok(parsed.ok);
    assert.doesNotThrow(() => registrySnapshotDigest(parsed.value));
  }

  for (const value of [INT64_MIN - 1n, INT64_MAX + 1n, 2n ** 63n, 10n ** 1_000n, `1${'0'.repeat(1_000)}`]) {
    const parsed = parseRegistrySnapshot(snapshotInput({ createdAtUnixSeconds: value }));
    assert.equal(parsed.ok, false, `${value} must reject before encoding`);
    assert.equal(parsed.ok ? '' : parsed.error, 'SNAPSHOT_MALFORMED');
  }

  for (const value of [0, 1.5, true, null, {}, []]) {
    const parsed = parseRegistrySnapshot(snapshotInput({ createdAtUnixSeconds: value }));
    assert.equal(parsed.ok, false, `${String(value)} must reject before encoding`);
    assert.equal(parsed.ok ? '' : parsed.error, 'SNAPSHOT_MALFORMED');
  }
});

test('asset and representation order cannot reach the snapshot digest', () => {
  const forward = snapshot({
    assets: [assetInput(), amdAssetInput()],
    representations: [representationInput(), syntheticRepresentationInput()],
  });
  const reverse = snapshot({
    assets: [amdAssetInput(), assetInput()],
    representations: [syntheticRepresentationInput(), representationInput()],
  });
  assert.equal(registrySnapshotDigest(forward), registrySnapshotDigest(reverse));
});

test('claim order cannot reach a record digest', () => {
  const a = representationInput({
    backing: [claim('FULLY_BACKED', 'VERIFIED', 0n, 'source.a'), claim('FULLY_BACKED', 'VERIFIED', 5n, 'source.b')],
  });
  const b = representationInput({
    backing: [claim('FULLY_BACKED', 'VERIFIED', 5n, 'source.b'), claim('FULLY_BACKED', 'VERIFIED', 0n, 'source.a')],
  });
  assert.equal(
    registrySnapshotDigest(snapshot({ representations: [a] })),
    registrySnapshotDigest(snapshot({ representations: [b] })),
  );
});

test('listing, alias and jurisdiction order cannot reach a digest', () => {
  const forward = snapshot({
    assets: [
      assetInput({
        display: {
          listings: [{ mic: 'XNAS', ticker: 'NVDA' }, { mic: 'XETR', ticker: 'NVD' }],
          aliases: [{ kind: 'NAME', value: 'Nvidia' }, { kind: 'LEGACY_TICKER', value: 'NVDAOLD' }],
        },
      }),
    ],
    representations: [representationInput({ eligibility: verified({ permitted: ['US', 'GB'], prohibited: [] }) })],
  });
  const reverse = snapshot({
    assets: [
      assetInput({
        display: {
          listings: [{ mic: 'XETR', ticker: 'NVD' }, { mic: 'XNAS', ticker: 'NVDA' }],
          aliases: [{ kind: 'LEGACY_TICKER', value: 'NVDAOLD' }, { kind: 'NAME', value: 'Nvidia' }],
        },
      }),
    ],
    representations: [representationInput({ eligibility: verified({ permitted: ['GB', 'US'], prohibited: [] }) })],
  });
  assert.equal(registrySnapshotDigest(forward), registrySnapshotDigest(reverse));
});

test('rights authoring order cannot reach a digest', () => {
  const a = representationInput({
    rights: { VOTING_RIGHTS: verified('ABSENT'), ECONOMIC_EXPOSURE: verified('PRESENT') },
  });
  const b = representationInput({
    rights: { ECONOMIC_EXPOSURE: verified('PRESENT'), VOTING_RIGHTS: verified('ABSENT') },
  });
  assert.equal(
    registrySnapshotDigest(snapshot({ representations: [a] })),
    registrySnapshotDigest(snapshot({ representations: [b] })),
  );
});

// --- the digest covers what it claims to ------------------------------------

test('changing display metadata changes the record digest but not the identity digest', () => {
  // ADR 0007's reason for two digests: this is the demonstration that display
  // metadata does not reach financial identity.
  const original = asset();
  const renamed = asset({
    display: {
      primaryName: 'Nvidia Corp (renamed)',
      displayTicker: 'NVDA2',
      primaryMarketIdentifier: 'XNYS',
      listings: [{ mic: 'XNYS', ticker: 'NVDA2' }],
      aliases: [{ kind: 'LEGACY_TICKER', value: 'NVDA' }],
    },
  });
  assert.notEqual(canonicalAssetRecordDigest(original), canonicalAssetRecordDigest(renamed));
  assert.equal(canonicalAssetIdentityDigest(original.identity), canonicalAssetIdentityDigest(renamed.identity));
});

test('a different canonical asset has a different identity digest', () => {
  const amd = parseCanonicalAssetRecord(amdAssetInput());
  assert.ok(amd.ok);
  assert.notEqual(
    canonicalAssetIdentityDigest(asset().identity),
    canonicalAssetIdentityDigest(amd.value.identity),
  );
});

test('every security-relevant change moves the snapshot digest', () => {
  const base = registrySnapshotDigest(snapshot());
  const mutations: readonly [string, Json][] = [
    ['snapshot id', { snapshotId: 'fixture.snapshot.0002' }],
    ['creation time', { createdAtUnixSeconds: '1800000001' }],
    ['data class', { dataClass: 'OBSERVED' }],
    ['source version', { sourceVersions: [{ sourceId: 'fixture.source.a', version: '2' }] }],
    ['asset status', { assets: [assetInput({ status: 'DELISTED' })] }],
    ['display name', { assets: [assetInput({ display: { primaryName: 'Something Else' } })] }],
    ['contract address', { representations: [representationInput({ representationId: repId(ADDRESS_B) })] }],
    ['issuer claim', { representations: [representationInput({ issuer: verified('issuer.fixture.beta') })] }],
    ['backing claim', { representations: [representationInput({ backing: verified('SYNTHETIC') })] }],
    ['operational status', { representations: [representationInput({ operationalStatus: verified('PAUSED') })] }],
    ['claim trust class', { representations: [representationInput({ backing: [claim('FULLY_BACKED', 'AUTHORITATIVE')] })] }],
    ['claim source', { representations: [representationInput({ backing: verified('FULLY_BACKED', 'source.other') })] }],
    ['claim observation time', { representations: [representationInput({ backing: [claim('FULLY_BACKED', 'VERIFIED', 1n)] })] }],
    ['token symbol', { representations: [representationInput({ display: { tokenSymbol: 'OTHER' } })] }],
    ['a right', { representations: [representationInput({ rights: { VOTING_RIGHTS: verified('PRESENT') } })] }],
    ['eligibility', { representations: [representationInput({ eligibility: verified({ permitted: ['US'], prohibited: [] }) })] }],
  ];
  const seen = new Map<string, string>([[base, 'base']]);
  for (const [label, mutation] of mutations) {
    const digest = registrySnapshotDigest(snapshot(mutation));
    assert.notEqual(digest, base, `${label} did not change the snapshot digest`);
    const collision = seen.get(digest);
    assert.equal(collision, undefined, `${label} collides with ${collision}`);
    seen.set(digest, label);
  }
});

test('an advisory claim changes the snapshot digest', () => {
  // The digest names the state, not the decision. That adding such a claim changes
  // no decision is a separate property, tested with the decision logic.
  const withAdvisory = snapshot({
    representations: [
      representationInput({
        backing: [claim('FULLY_BACKED', 'VERIFIED'), claim('SYNTHETIC', 'ADVISORY', 0n, 'feed.x')],
      }),
    ],
  });
  assert.notEqual(registrySnapshotDigest(withAdvisory), registrySnapshotDigest(snapshot()));
});

test('two representations differing only in chain have different record digests', () => {
  const arb = representationInput({ representationId: repId(ADDRESS_A, 'eip155:42161') });
  const eth = representationInput({ representationId: repId(ADDRESS_A, 'eip155:1') });
  assert.notEqual(
    registrySnapshotDigest(snapshot({ representations: [arb] })),
    registrySnapshotDigest(snapshot({ representations: [eth] })),
  );
});

test('a record digest is meaningful on its own', () => {
  const s = snapshot();
  const record = s.representations[0];
  assert.ok(record !== undefined);
  assert.match(representationRecordDigest(record), /^0x[0-9a-f]{64}$/);
});
