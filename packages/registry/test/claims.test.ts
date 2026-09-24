/**
 * Claim resolution, trust floors and conflict policy (ADR 0006).
 *
 * The two asymmetries are what this file is really for: a sub-floor claim can
 * neither establish a value nor refuse one. The second half is the security
 * property — if an advisory claim could raise CONFLICT, injecting one would be a
 * denial-of-service against every honest representation it touched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TrustClass } from '@mandate/kernel';
import {
  BackingModel,
  ClaimState,
  EXECUTION_TRUST_FLOOR,
  identityKey,
  isSyntheticBacking,
  meetsTrustFloor,
  parseClaimSet,
  resolveClaimSet,
  UnknownReason,
  type Claim,
  type ClaimPolicy,
} from '../src/index.ts';

const NOW = 1_800_000_000n;

const POLICY: ClaimPolicy = {
  minimumTrust: EXECUTION_TRUST_FLOOR,
  nowUnixSeconds: NOW,
  maxClaimAgeSeconds: 86_400n,
};

function claim(value: BackingModel, trustClass: TrustClass, ageSeconds = 0n, sourceId = 'source.a'): Claim<BackingModel> {
  return {
    value,
    provenance: { trustClass, sourceId: sourceId as never, observedAtUnixSeconds: NOW - ageSeconds },
  };
}

const resolve = (claims: readonly Claim<BackingModel>[], policy: ClaimPolicy = POLICY) =>
  resolveClaimSet(claims, policy, identityKey);

// --- establishment ----------------------------------------------------------

test('a single verified claim establishes the value', () => {
  const r = resolve([claim(BackingModel.FULLY_BACKED, TrustClass.VERIFIED)]);
  assert.equal(r.state, ClaimState.ESTABLISHED);
  assert.equal(r.state === 'ESTABLISHED' ? r.value : '', BackingModel.FULLY_BACKED);
});

test('agreeing claims from several sources establish, and are not a conflict', () => {
  const r = resolve([
    claim(BackingModel.FULLY_BACKED, TrustClass.VERIFIED, 0n, 'source.a'),
    claim(BackingModel.FULLY_BACKED, TrustClass.AUTHORITATIVE, 10n, 'source.b'),
  ]);
  assert.equal(r.state, ClaimState.ESTABLISHED);
});

test('the trust floor is met by authoritative and verified, and by nothing else', () => {
  assert.ok(meetsTrustFloor(TrustClass.AUTHORITATIVE, EXECUTION_TRUST_FLOOR));
  assert.ok(meetsTrustFloor(TrustClass.VERIFIED, EXECUTION_TRUST_FLOOR));
  assert.equal(meetsTrustFloor(TrustClass.ADVISORY, EXECUTION_TRUST_FLOOR), false);
  assert.equal(meetsTrustFloor(TrustClass.UNTRUSTED, EXECUTION_TRUST_FLOOR), false);
});

// --- the three ways a property stays unknown --------------------------------

test('no claims at all is UNKNOWN / NO_CLAIMS', () => {
  const r = resolve([]);
  assert.equal(r.state, ClaimState.UNKNOWN);
  assert.equal(r.state === 'UNKNOWN' ? r.reason : '', UnknownReason.NO_CLAIMS);
});

test('only sub-floor claims is UNKNOWN / BELOW_TRUST_FLOOR, not established', () => {
  // A favourable property must never be promoted out of advisory data.
  const r = resolve([
    claim(BackingModel.FULLY_BACKED, TrustClass.ADVISORY),
    claim(BackingModel.FULLY_BACKED, TrustClass.UNTRUSTED, 0n, 'source.b'),
  ]);
  assert.equal(r.state, ClaimState.UNKNOWN);
  assert.equal(r.state === 'UNKNOWN' ? r.reason : '', UnknownReason.BELOW_TRUST_FLOOR);
});

test('only stale claims is UNKNOWN / STALE, distinct from having no data', () => {
  const r = resolve([claim(BackingModel.FULLY_BACKED, TrustClass.VERIFIED, 86_401n)]);
  assert.equal(r.state, ClaimState.UNKNOWN);
  assert.equal(r.state === 'UNKNOWN' ? r.reason : '', UnknownReason.STALE);
});

test('the freshness bound is inclusive at its edge', () => {
  assert.equal(resolve([claim(BackingModel.FULLY_BACKED, TrustClass.VERIFIED, 86_400n)]).state, ClaimState.ESTABLISHED);
  assert.equal(resolve([claim(BackingModel.FULLY_BACKED, TrustClass.VERIFIED, 86_401n)]).state, ClaimState.UNKNOWN);
});

test('a claim observed after the evaluation instant fails closed', () => {
  // A broken clock or a broken source. Freshness cannot be established, so it is
  // not treated as maximally fresh.
  const r = resolve([claim(BackingModel.FULLY_BACKED, TrustClass.VERIFIED, -1n)]);
  assert.equal(r.state, ClaimState.UNKNOWN);
  assert.equal(r.state === 'UNKNOWN' ? r.reason : '', UnknownReason.STALE);
});

test('a null freshness bound accepts any age but still refuses the future', () => {
  const unbounded: ClaimPolicy = { ...POLICY, maxClaimAgeSeconds: null };
  assert.equal(resolve([claim(BackingModel.FULLY_BACKED, TrustClass.VERIFIED, 10n ** 9n)], unbounded).state, ClaimState.ESTABLISHED);
  assert.equal(resolve([claim(BackingModel.FULLY_BACKED, TrustClass.VERIFIED, -1n)], unbounded).state, ClaimState.UNKNOWN);
});

// --- conflict ---------------------------------------------------------------

test('two disagreeing claims at the floor fail closed as CONFLICT', () => {
  const r = resolve([
    claim(BackingModel.FULLY_BACKED, TrustClass.VERIFIED, 0n, 'source.a'),
    claim(BackingModel.SYNTHETIC, TrustClass.VERIFIED, 0n, 'source.b'),
  ]);
  assert.equal(r.state, ClaimState.CONFLICT);
});

test('a conflict is not resolved by recency', () => {
  // The fresher claim does not win. A compromised source would only have to be
  // fast to override a curated entry.
  const r = resolve([
    claim(BackingModel.FULLY_BACKED, TrustClass.VERIFIED, 1000n, 'source.a'),
    claim(BackingModel.SYNTHETIC, TrustClass.VERIFIED, 0n, 'source.b'),
  ]);
  assert.equal(r.state, ClaimState.CONFLICT);
});

test('a conflict is not resolved by trust precedence', () => {
  // AUTHORITATIVE does not beat VERIFIED. Trust class says what a source may
  // influence, and using it as a priority order would let one mis-tagged source
  // silently override the curated registry.
  const r = resolve([
    claim(BackingModel.FULLY_BACKED, TrustClass.AUTHORITATIVE, 0n, 'source.a'),
    claim(BackingModel.SYNTHETIC, TrustClass.VERIFIED, 0n, 'source.b'),
  ]);
  assert.equal(r.state, ClaimState.CONFLICT);
});

test('a conflict is not resolved by majority', () => {
  const r = resolve([
    claim(BackingModel.FULLY_BACKED, TrustClass.VERIFIED, 0n, 'source.a'),
    claim(BackingModel.FULLY_BACKED, TrustClass.VERIFIED, 0n, 'source.b'),
    claim(BackingModel.SYNTHETIC, TrustClass.VERIFIED, 0n, 'source.c'),
  ]);
  assert.equal(r.state, ClaimState.CONFLICT);
});

// --- the security asymmetry -------------------------------------------------

test('a sub-floor claim cannot create a conflict', () => {
  // The security property. If it could, anyone able to inject an advisory claim
  // could make any representation inadmissible.
  const honest = claim(BackingModel.FULLY_BACKED, TrustClass.VERIFIED, 0n, 'source.a');
  const injected = claim(BackingModel.SYNTHETIC, TrustClass.UNTRUSTED, 0n, 'attacker');
  const advisory = claim(BackingModel.SYNTHETIC, TrustClass.ADVISORY, 0n, 'attacker');

  assert.equal(resolve([honest]).state, ClaimState.ESTABLISHED);
  assert.equal(resolve([honest, injected]).state, ClaimState.ESTABLISHED);
  assert.equal(resolve([honest, advisory]).state, ClaimState.ESTABLISHED);
  assert.deepEqual(resolve([honest, injected, advisory]), resolve([honest]));
});

test('a stale at-floor claim cannot create a conflict either', () => {
  const fresh = claim(BackingModel.FULLY_BACKED, TrustClass.VERIFIED, 0n, 'source.a');
  const stale = claim(BackingModel.SYNTHETIC, TrustClass.VERIFIED, 90_000n, 'source.b');
  assert.equal(resolve([fresh, stale]).state, ClaimState.ESTABLISHED);
});

test('replacing authoritative provenance with untrusted cannot improve anything', () => {
  const established = resolve([claim(BackingModel.FULLY_BACKED, TrustClass.AUTHORITATIVE)]);
  const downgraded = resolve([claim(BackingModel.FULLY_BACKED, TrustClass.UNTRUSTED)]);
  assert.equal(established.state, ClaimState.ESTABLISHED);
  assert.equal(downgraded.state, ClaimState.UNKNOWN);
});

// --- determinism ------------------------------------------------------------

test('resolution does not depend on claim order', () => {
  const claims = [
    claim(BackingModel.FULLY_BACKED, TrustClass.VERIFIED, 5n, 'source.b'),
    claim(BackingModel.FULLY_BACKED, TrustClass.AUTHORITATIVE, 0n, 'source.a'),
    claim(BackingModel.SYNTHETIC, TrustClass.ADVISORY, 0n, 'source.c'),
  ];
  assert.deepEqual(resolve(claims), resolve([...claims].reverse()));
});

// --- parsing ----------------------------------------------------------------

test('parseClaimSet accepts any trust class, unlike the kernel observed parser', () => {
  // The deliberate difference: the registry records what a source said, including
  // sources it will not act on, so refusing to act on them is auditable.
  const r = parseClaimSet(
    [{ value: 'SYNTHETIC', provenance: { trustClass: 'UNTRUSTED', sourceId: 'attacker', observedAtUnixSeconds: '1800000000' } }],
    (v) => (v === 'SYNTHETIC' ? { ok: true, value: BackingModel.SYNTHETIC } : { ok: false, error: 'SNAPSHOT_MALFORMED' }),
    identityKey,
  );
  assert.ok(r.ok);
  assert.equal(r.value.length, 1);
});

test('a duplicate claim rejects rather than being collapsed', () => {
  const entry = { value: 'SYNTHETIC', provenance: { trustClass: 'VERIFIED', sourceId: 'source.a', observedAtUnixSeconds: '1800000000' } };
  const r = parseClaimSet(
    [entry, { ...entry }],
    (v) => (v === 'SYNTHETIC' ? { ok: true, value: BackingModel.SYNTHETIC } : { ok: false, error: 'SNAPSHOT_MALFORMED' }),
    identityKey,
  );
  assert.equal(r.ok, false);
});

// --- derived synthetic status ----------------------------------------------

test('synthetic status is derived from backing, and the middle cases are not synthetic', () => {
  assert.ok(isSyntheticBacking(BackingModel.SYNTHETIC));
  assert.ok(isSyntheticBacking(BackingModel.UNBACKED));
  assert.equal(isSyntheticBacking(BackingModel.FULLY_BACKED), false);
  // Not synthetic, and also not fully backed. The distinction a single boolean
  // could not express.
  assert.equal(isSyntheticBacking(BackingModel.PARTIALLY_BACKED), false);
  assert.equal(isSyntheticBacking(BackingModel.COLLATERALIZED), false);
  assert.equal(isSyntheticBacking(BackingModel.DEBT_LINKED), false);
});
