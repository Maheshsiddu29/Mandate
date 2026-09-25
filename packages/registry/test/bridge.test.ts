/**
 * The registry-to-kernel seam.
 *
 * Two things are established here. First, that the bridge refuses to emit trusted
 * state for anything it could not establish — because emitting `synthetic: NO` for
 * a representation whose backing is unknown would convert a registry gap into an
 * execution. Second, that the two layers agree: a representation the registry
 * excludes is one the verifier also rejects, for every constraint both layers know
 * about. Two components that are supposed to agree about a safety decision and do
 * not is a vulnerability, not an inconsistency.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Decision,
  parseMandate,
  TrustClass,
  verify,
  type CanonicalMandate,
  parseTrustedState,
  trustedStateDigest,
} from '@mandate/kernel';
import {
  deriveRequirements,
  evaluateRepresentation,
  openRegistry,
  registrySnapshotDigest,
  toRepresentationState,
  type Registry,
  type RepresentationRequirements,
} from '../src/index.ts';
import {
  ADDRESS_A,
  ARBITRUM,
  ETHEREUM,
  ISSUER_ALPHA,
  ISSUER_OMEGA,
  NOW,
  claim,
  mandateInput,
  repId,
  representationInput,
  snapshotInput,
  verified,
  type Json,
} from './support/worlds.ts';

function mandate(overrides: Json = {}): CanonicalMandate {
  const r = parseMandate(mandateInput(overrides));
  if (!r.ok) throw new Error(`fixture mandate failed to parse: ${r.error}`);
  return r.value;
}

function requirements(m: CanonicalMandate = mandate()): RepresentationRequirements {
  const r = deriveRequirements(m, { nowUnixSeconds: NOW });
  if (!r.ok) throw new Error(`deriveRequirements failed: ${r.error}`);
  return r.value;
}

function open(overrides: Json = {}): Registry {
  const r = openRegistry(snapshotInput(overrides));
  if (!r.ok) throw new Error(`openRegistry failed: ${r.error}`);
  return r.value;
}

function recordOf(registry: Registry, address = ADDRESS_A, chain = ARBITRUM) {
  const record = registry.byRepresentationId.get(repId(address, chain));
  if (record === undefined) throw new Error('fixture representation missing');
  return record;
}

// --- the bridge emits only what it established ------------------------------

test('an established representation becomes kernel trusted state', () => {
  const r = toRepresentationState(recordOf(open()), requirements());
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.equal(r.value.value.representationId, repId(ADDRESS_A));
  assert.equal(r.value.value.issuer, ISSUER_ALPHA);
  assert.equal(r.value.value.chain, ARBITRUM);
  // Derived from the backing model, never carried as its own claim.
  assert.equal(r.value.value.synthetic, 'NO');
  assert.equal(r.value.value.operationalState, 'ACTIVE');
});

test('a synthetic backing model becomes synthetic: YES', () => {
  const registry = open({ representations: [representationInput({ backing: verified('SYNTHETIC') })] });
  const r = toRepresentationState(recordOf(registry), requirements());
  assert.ok(r.ok);
  assert.equal(r.value.value.synthetic, 'YES');
});

test('a backing model that is neither fully backed nor synthetic is not reported synthetic', () => {
  // PARTIALLY_BACKED is not synthetic and does not satisfy a full-backing
  // requirement. The kernel only asks the synthetic question, so the registry
  // answers only that, and the backing requirement is the registry's own check.
  const registry = open({ representations: [representationInput({ backing: verified('PARTIALLY_BACKED') })] });
  const r = toRepresentationState(recordOf(registry), requirements());
  assert.ok(r.ok);
  assert.equal(r.value.value.synthetic, 'NO');
});

test('unknown backing emits nothing rather than a permissive default', () => {
  // The failure this function exists to prevent. There is no path that turns an
  // unestablished property into a favourable value.
  const registry = open({ representations: [representationInput({ backing: [] })] });
  const r = toRepresentationState(recordOf(registry), requirements());
  assert.equal(r.ok, false);
  assert.equal(r.ok === false ? r.error : '', 'REPRESENTATION_METADATA_UNKNOWN');
});

test('advisory-only metadata emits nothing', () => {
  const registry = open({
    representations: [representationInput({ backing: [claim('FULLY_BACKED', TrustClass.ADVISORY)] })],
  });
  const r = toRepresentationState(recordOf(registry), requirements());
  assert.equal(r.ok, false);
  assert.equal(r.ok === false ? r.error : '', 'TRUST_REQUIREMENT_NOT_MET');
});

test('conflicting metadata emits nothing', () => {
  const registry = open({
    representations: [
      representationInput({
        backing: [
          claim('FULLY_BACKED', TrustClass.VERIFIED, 0n, 'fixture.source.a'),
          claim('SYNTHETIC', TrustClass.VERIFIED, 0n, 'fixture.source.b'),
        ],
      }),
    ],
  });
  const r = toRepresentationState(recordOf(registry), requirements());
  assert.equal(r.ok, false);
  assert.equal(r.ok === false ? r.error : '', 'REPRESENTATION_METADATA_CONFLICT');
});

test('the weakest evidence sets the provenance the kernel checks', () => {
  // The kernel applies its freshness bound to whatever this says, so it must be
  // the oldest and least-trusted of the properties the state rests on, not the
  // most flattering.
  const registry = open({
    representations: [
      representationInput({
        underlying: [claim({ assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBJQV0' }, TrustClass.AUTHORITATIVE, 0n)],
        backing: [claim('FULLY_BACKED', TrustClass.VERIFIED, 500n)],
      }),
    ],
  });
  const r = toRepresentationState(recordOf(registry), requirements());
  assert.ok(r.ok);
  assert.equal(r.value.provenance.observedAtUnixSeconds, NOW - 500n);
  assert.equal(r.value.provenance.trustClass, 'VERIFIED');
});

// --- the two layers agree ---------------------------------------------------

/**
 * Run the kernel verifier over a candidate built from registry-derived state.
 *
 * The authorization is deliberately left unsigned: this test is about the
 * representation checks, and an unsigned envelope adds a signature violation that
 * is filtered out below rather than interfering with what is being compared.
 */
function kernelReasonCodes(registry: Registry, m: CanonicalMandate, address: string, chain: string): readonly string[] {
  const state = toRepresentationState(recordOf(registry, address, chain), requirements(m));
  const representations = state.ok ? [state.value] : [];
  // Schema v3 requires the state to declare which registry snapshot its
  // representations came from, and the candidate to commit to the same one
  // (ADR 0017). This harness declares the snapshot it actually derived from.
  const snapshotDigest = registrySnapshotDigest(registry.snapshot);
  const trustedState = {
    version: 2,
    stateId: 'fixture.snapshot.0001',
    registrySnapshotDigest: snapshotDigest,
    representations,
    market: {
      provenance: { trustClass: 'VERIFIED', sourceId: 'fixture.source.a', observedAtUnixSeconds: String(NOW) },
      value: {
        canonicalAsset: { assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBJQV0' },
        referencePrice: { numeratorUnit: 'USD', denominatorUnit: 'SHARE', decimals: 2, atoms: '10000' },
        haltStatus: 'TRADING',
      },
    },
    corporateAction: {
      provenance: { trustClass: 'VERIFIED', sourceId: 'fixture.source.a', observedAtUnixSeconds: String(NOW) },
      value: { canonicalAsset: { assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBJQV0' }, epoch: '7' },
    },
    replay: {
      provenance: { trustClass: 'VERIFIED', sourceId: 'fixture.source.a', observedAtUnixSeconds: String(NOW) },
      value: { mandateDigest: '0x' + '00'.repeat(32), status: 'UNUSED' },
    },
  };
  const parsedState = parseTrustedState(trustedState);
  const stateDigest = parsedState.ok ? trustedStateDigest(parsedState.value) : ('0x' + '00'.repeat(32));
  const receipt = verify({
    mandate: mandateInput(),
    authorization: {
      scheme: 'eip712-secp256k1',
      signer: { kind: 'eip155-address', value: '0x1111111111111111111111111111111111111111' },
      signature: '0x' + '00'.repeat(65),
      domain: { name: 'Mandate', version: '1', chainId: '42161', verifyingContract: '0x' + '00'.repeat(19) + '01' },
    },
    candidate: {
      version: 3,
      representationId: repId(address, chain),
      canonicalAsset: { assetClass: 'equity', idScheme: 'figi', value: 'BBG000BBJQV0' },
      issuer: state.ok ? state.value.value.issuer : ISSUER_ALPHA,
      chain,
      venue: 'venue.fixture.alpha',
      side: 'BUY',
      agent: { kind: 'eip155-address', value: '0x2222222222222222222222222222222222222222' },
      quantity: { unit: 'SHARE', decimals: 2, atoms: '1000' },
      executionPrice: { numeratorUnit: 'USD', denominatorUnit: 'SHARE', decimals: 2, atoms: '10000' },
      notional: { unit: 'USD', decimals: 2, atoms: '100000' },
      feeTotal: { unit: 'USD', decimals: 2, atoms: '250' },
      evaluationStateId: 'fixture.snapshot.0001',
      evaluationStateDigest: stateDigest,
      registrySnapshotDigest: snapshotDigest,
      corporateActionEpoch: '7',
    },
    trustedState,
    clock: { nowUnixSeconds: String(NOW) },
    expectedDomain: { name: 'Mandate', version: '1', chainId: '42161', verifyingContract: '0x' + '00'.repeat(19) + '01' },
  });
  assert.equal(receipt.decision, Decision.REJECT, 'the unsigned envelope always rejects');
  // Drop the authorization-layer codes; this test compares representation checks.
  const authCodes = new Set(['SIGNATURE_INVALID', 'SIGNER_UNAUTHORIZED', 'REPLAY_STATE_UNKNOWN']);
  return receipt.reasonCodes.filter((c) => !authCodes.has(c));
}

test('a registry exclusion is also a verifier rejection, per constraint', () => {
  const cases: readonly { readonly label: string; readonly world: Json; readonly address: string; readonly chain: string; readonly code: string }[] = [
    {
      label: 'wrong issuer',
      world: { representations: [representationInput({ issuer: verified(ISSUER_OMEGA) })] },
      address: ADDRESS_A,
      chain: ARBITRUM,
      code: 'ISSUER_NOT_ALLOWED',
    },
    {
      label: 'wrong chain',
      world: { representations: [representationInput({ representationId: repId(ADDRESS_A, ETHEREUM) })] },
      address: ADDRESS_A,
      chain: ETHEREUM,
      code: 'CHAIN_NOT_ALLOWED',
    },
    {
      label: 'synthetic against a backed-only mandate',
      world: { representations: [representationInput({ backing: verified('SYNTHETIC') })] },
      address: ADDRESS_A,
      chain: ARBITRUM,
      code: 'SYNTHETIC_NOT_ALLOWED',
    },
    {
      label: 'inactive',
      world: { representations: [representationInput({ operationalStatus: verified('PAUSED') })] },
      address: ADDRESS_A,
      chain: ARBITRUM,
      code: 'REPRESENTATION_INACTIVE',
    },
  ];

  for (const c of cases) {
    const registry = open(c.world);
    const decision = evaluateRepresentation(registry, requirements(), repId(c.address, c.chain));
    assert.equal(decision.status, 'EXCLUDED', c.label);
    assert.ok(
      decision.status === 'EXCLUDED' && decision.reasonCodes.includes(c.code as never),
      `registry missed ${c.code} for ${c.label}`,
    );
    assert.ok(
      kernelReasonCodes(registry, mandate(), c.address, c.chain).includes(c.code),
      `verifier missed ${c.code} for ${c.label}`,
    );
  }
});

test('unestablished metadata makes the verifier report an unknown representation', () => {
  // The bridge emits nothing, so the candidate names a representation the verifier
  // has no trusted state for. Both layers refuse; neither invents a value.
  const registry = open({ representations: [representationInput({ backing: [] })] });
  const decision = evaluateRepresentation(registry, requirements(), repId(ADDRESS_A));
  assert.equal(decision.status, 'EXCLUDED');
  assert.ok(kernelReasonCodes(registry, mandate(), ADDRESS_A, ARBITRUM).includes('REPRESENTATION_UNKNOWN'));
});

test('an admissible representation produces no representation-level verifier rejection', () => {
  const registry = open();
  assert.equal(evaluateRepresentation(registry, requirements(), repId(ADDRESS_A)).status, 'ADMISSIBLE');
  assert.deepEqual(kernelReasonCodes(registry, mandate(), ADDRESS_A, ARBITRUM), []);
});
