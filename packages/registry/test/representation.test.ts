/**
 * Representation identity and registry lookups.
 *
 * The invariant this file exists for is the one in design section 5.3:
 *
 *     unregistered contract  !=  valid representation
 *
 * and the corollary that a contract address is the identity, so changing it makes
 * a different representation no matter how much metadata stays the same.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  compareRepresentationIds,
  getRepresentation,
  hasRepresentation,
  listRepresentations,
  openRegistry,
  parseContractAddress,
  parseRepresentationId,
  parseRepresentationRecord,
  validateCanonicalAssetId,
  type Registry,
} from '../src/index.ts';

const NVDA = { assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBJQV0' };
const AMD = { assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBQCY0' };
const A = '0x' + 'aa'.repeat(20);
const B = '0x' + 'bb'.repeat(20);
const UNREGISTERED = '0x' + 'cc'.repeat(20);

function verified(value: unknown, sourceId = 'fixture.issuer.docs') {
  return [{ value, provenance: { trustClass: 'VERIFIED', sourceId, observedAtUnixSeconds: '1800000000' } }];
}

function repInput(address: string, patch: Record<string, unknown> = {}) {
  return {
    representationId: `eip155:42161/erc20:${address}`,
    display: { tokenSymbol: 'NVDAX', tokenName: 'Fixture Backed NVDA Note' },
    underlying: verified(NVDA),
    issuer: verified('issuer.fixture.alpha'),
    instrumentType: verified('BACKED_NOTE'),
    backing: verified('FULLY_BACKED'),
    redemption: verified('QUALIFIED_HOLDERS_ONLY'),
    rights: { ECONOMIC_EXPOSURE: verified('PRESENT') },
    corporateActionHandling: verified('ON_CHAIN_MULTIPLIER'),
    settlement: verified('ATOMIC_ON_CHAIN'),
    operationalStatus: verified('ACTIVE'),
    eligibility: verified({ permitted: ['US'], prohibited: [] }),
    ...patch,
  };
}

function assetInput(identity: Record<string, unknown>, name: string, ticker: string) {
  return {
    identity,
    status: 'ACTIVE',
    display: {
      primaryName: name,
      displayTicker: ticker,
      primaryMarketIdentifier: 'XNAS',
      listings: [{ mic: 'XNAS', ticker }],
      aliases: [],
    },
  };
}

function snapshot(representations: readonly unknown[], assets: readonly unknown[] = [assetInput(NVDA, 'NVIDIA Corporation', 'NVDA')]) {
  return {
    registrySchemaVersion: 1,
    snapshotId: 'fixture.snapshot.0001',
    createdAtUnixSeconds: '1800000000',
    dataClass: 'SYNTHETIC_FIXTURE',
    sourceVersions: [{ sourceId: 'fixture.issuer.docs', version: '1' }],
    assets,
    representations,
  };
}

function open(raw: unknown): Registry {
  const r = openRegistry(raw);
  if (!r.ok) throw new Error(`openRegistry failed: ${r.error}`);
  return r.value;
}

const nvdaId = (() => {
  const r = validateCanonicalAssetId(NVDA);
  if (!r.ok) throw new Error('bad fixture');
  return r.value;
})();

// --- identity ---------------------------------------------------------------

test('a representation id round-trips through its canonical string form', () => {
  const r = parseRepresentationId(`eip155:42161/erc20:${A}`);
  assert.ok(r.ok);
  assert.equal(r.value.chain, 'eip155:42161');
  assert.equal(r.value.contractAddress, A);
  assert.equal(r.value.value, `eip155:42161/erc20:${A}`);
});

test('the structured and string forms agree', () => {
  const fromString = parseRepresentationId(`eip155:42161/erc20:${A}`);
  const fromObject = parseRepresentationId({
    chainNamespace: 'eip155',
    chainReference: '42161',
    assetNamespace: 'erc20',
    contractAddress: A,
  });
  assert.ok(fromString.ok && fromObject.ok);
  assert.deepEqual(fromString.value, fromObject.value);
});

test('changing the contract address changes representation identity', () => {
  const a = parseRepresentationId(`eip155:42161/erc20:${A}`);
  const b = parseRepresentationId(`eip155:42161/erc20:${B}`);
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.value.value, b.value.value);
});

test('the same contract on a different chain is a different representation', () => {
  const arb = parseRepresentationId(`eip155:42161/erc20:${A}`);
  const eth = parseRepresentationId(`eip155:1/erc20:${A}`);
  assert.ok(arb.ok && eth.ok);
  assert.notEqual(arb.value.value, eth.value.value);
});

test('a malformed representation id rejects rather than being coerced', () => {
  for (const bad of [
    `eip155:42161/erc20:0x123`,
    `eip155:42161/erc721:${A}`,
    `solana:mainnet/spl:${A}`,
    `eip155:42161:${A}`,
    `eip155:42161/erc20:${A}/extra`,
    `eip155:042161/erc20:${A}`,
    `eip155:0/erc20:${A}`,
    A,
    '',
    42,
    null,
  ]) {
    const r = parseRepresentationId(bad);
    assert.equal(r.ok, false, String(bad));
  }
});

test('a checksummed address is accepted and canonicalized; a broken checksum rejects', () => {
  // A real EIP-55 checksummed address. Accepted, lowercased for the canonical form.
  const checksummed = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  const good = parseContractAddress(checksummed);
  assert.ok(good.ok, 'valid EIP-55 should be accepted');
  assert.equal(good.value, checksummed.toLowerCase());

  // One case flip breaks the checksum. Rejected, never repaired by lowercasing.
  const broken = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1Beaed';
  assert.equal(parseContractAddress(broken).ok, false);
});

test('an all-lowercase address is accepted as already canonical', () => {
  const r = parseContractAddress(A);
  assert.ok(r.ok);
  assert.equal(r.value, A);
});

// --- unregistered contracts -------------------------------------------------

test('an unregistered contract is not in the registry, whatever its metadata says', () => {
  const registry = open(snapshot([repInput(A)]));
  assert.notEqual(getRepresentation(registry, `eip155:42161/erc20:${A}`), undefined);
  assert.equal(getRepresentation(registry, `eip155:42161/erc20:${UNREGISTERED}`), undefined);
});

test('a fake token carrying a trusted-looking symbol is still unregistered', () => {
  // The counterfeit claims the right symbol, the right name and the right
  // underlying. It is not in the snapshot, so none of that reaches a decision.
  const registry = open(snapshot([repInput(A)]));
  const counterfeit = parseRepresentationRecord(
    repInput(UNREGISTERED, { display: { tokenSymbol: 'NVDAX', tokenName: 'Fixture Backed NVDA Note' } }),
  );
  assert.ok(counterfeit.ok, 'the counterfeit is a structurally valid record');
  assert.equal(hasRepresentation(registry, counterfeit.value.representationId), false);
  assert.equal(
    listRepresentations(registry, nvdaId).some(
      (r) => r.representationId.value === counterfeit.value.representationId.value,
    ),
    false,
    'and it is not reachable through the asset it claims',
  );
});

// --- listing by underlying --------------------------------------------------

test('a canonical asset maps to the representations issued against it', () => {
  const registry = open(snapshot([repInput(A), repInput(B)]));
  assert.deepEqual(
    listRepresentations(registry, nvdaId).map((r) => r.representationId.contractAddress),
    [A, B],
  );
});

test('a representation issued against another underlying is not listed', () => {
  const registry = open(
    snapshot(
      [repInput(A), repInput(B, { underlying: verified(AMD) })],
      [assetInput(NVDA, 'NVIDIA Corporation', 'NVDA'), assetInput(AMD, 'Advanced Micro Devices Inc', 'AMD')],
    ),
  );
  assert.deepEqual(listRepresentations(registry, nvdaId).map((r) => r.representationId.contractAddress), [A]);
});

test('a representation whose underlying is unestablished is listed under no asset', () => {
  // Reachable by its own id, so evaluating it can explain why. Not reachable
  // through the asset, so it can never be picked up as a candidate.
  const advisoryOnly = [{ value: NVDA, provenance: { trustClass: 'ADVISORY', sourceId: 'feed.x', observedAtUnixSeconds: '1800000000' } }];
  const registry = open(snapshot([repInput(A), repInput(B, { underlying: advisoryOnly })]));
  assert.deepEqual(listRepresentations(registry, nvdaId).map((r) => r.representationId.contractAddress), [A]);
  assert.notEqual(getRepresentation(registry, `eip155:42161/erc20:${B}`), undefined);
});

test('a representation with a conflicting underlying is listed under no asset', () => {
  const conflicting = [
    { value: NVDA, provenance: { trustClass: 'VERIFIED', sourceId: 'source.a', observedAtUnixSeconds: '1800000000' } },
    { value: AMD, provenance: { trustClass: 'VERIFIED', sourceId: 'source.b', observedAtUnixSeconds: '1800000000' } },
  ];
  const registry = open(
    snapshot(
      [repInput(A), repInput(B, { underlying: conflicting })],
      [assetInput(NVDA, 'NVIDIA Corporation', 'NVDA'), assetInput(AMD, 'Advanced Micro Devices Inc', 'AMD')],
    ),
  );
  assert.deepEqual(listRepresentations(registry, nvdaId).map((r) => r.representationId.contractAddress), [A]);
});

// --- determinism and structural rejections ----------------------------------

test('listing order does not depend on snapshot order', () => {
  const forward = open(snapshot([repInput(A), repInput(B)]));
  const reverse = open(snapshot([repInput(B), repInput(A)]));
  assert.deepEqual(
    listRepresentations(forward, nvdaId).map((r) => r.representationId.value),
    listRepresentations(reverse, nvdaId).map((r) => r.representationId.value),
  );
});

test('two records for one representation reject the snapshot', () => {
  const r = openRegistry(snapshot([repInput(A), repInput(A, { issuer: verified('issuer.fixture.beta') })]));
  assert.equal(r.ok, false);
  assert.equal(r.ok === false ? r.error : '', 'SNAPSHOT_MALFORMED');
});

test('an unknown snapshot field rejects rather than being ignored', () => {
  const r = openRegistry({ ...snapshot([repInput(A)]), futureField: 'x' });
  assert.equal(r.ok, false);
});

test('a wrong registry schema version rejects', () => {
  const r = openRegistry({ ...snapshot([repInput(A)]), registrySchemaVersion: 2 });
  assert.equal(r.ok, false);
});

test('a numeric timestamp is refused, as in the kernel', () => {
  const r = openRegistry({ ...snapshot([repInput(A)]), createdAtUnixSeconds: 1800000000 });
  assert.equal(r.ok, false);
});

test('an unknown representation field rejects', () => {
  const r = openRegistry(snapshot([repInput(A, { extra: 1 })]));
  assert.equal(r.ok, false);
});

test('a jurisdiction both permitted and prohibited rejects the claim', () => {
  const r = openRegistry(snapshot([repInput(A, { eligibility: verified({ permitted: ['US'], prohibited: ['US'] }) })]));
  assert.equal(r.ok, false);
});

test('an unknown right name rejects', () => {
  const r = openRegistry(snapshot([repInput(A, { rights: { TELEPATHY: verified('PRESENT') } })]));
  assert.equal(r.ok, false);
});

test('representation ids sort by encoded byte order', () => {
  const short = parseRepresentationId(`eip155:1/erc20:${A}`);
  const long = parseRepresentationId(`eip155:42161/erc20:${A}`);
  assert.ok(short.ok && long.ok);
  // Length first, then content — matching the kernel's compareIdentifierBytes, so
  // registry and kernel orderings cannot disagree about canonical order.
  assert.ok(compareRepresentationIds(short.value, long.value) < 0);
});
