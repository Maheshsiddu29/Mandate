/**
 * Mandate-constrained representation admissibility.
 *
 * The central case is the one that proves equivalence is derived rather than
 * stored: the *same* registry, the *same* two representations, and a different
 * answer depending only on the mandate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMandate, TrustClass, type CanonicalMandate } from '@mandate/kernel';
import {
  Admissibility,
  deriveRequirements,
  evaluateRepresentation,
  filterForMandate,
  narrowRequirements,
  openRegistry,
  type RepresentationDecision,
  type RepresentationRequirements,
  type Registry,
} from '../src/index.ts';
import {
  ADDRESS_A,
  ADDRESS_B,
  ADDRESS_FAKE,
  AMD,
  ARBITRUM,
  ETHEREUM,
  ISSUER_OMEGA,
  NOW,
  amdAssetInput,
  assetInput,
  claim,
  mandateInput,
  repId,
  representationInput,
  snapshotInput,
  syntheticRepresentationInput,
  verified,
  type Json,
} from './support/worlds.ts';

function mandate(overrides: Json = {}): CanonicalMandate {
  const r = parseMandate(mandateInput(overrides));
  if (!r.ok) throw new Error(`fixture mandate failed to parse: ${r.error}`);
  return r.value;
}

function requirements(m: CanonicalMandate = mandate(), context: Json = {}): RepresentationRequirements {
  const r = deriveRequirements(m, { nowUnixSeconds: NOW, ...context });
  if (!r.ok) throw new Error(`deriveRequirements failed: ${r.error}`);
  return r.value;
}

function open(overrides: Json = {}): Registry {
  const r = openRegistry(snapshotInput(overrides));
  if (!r.ok) throw new Error(`openRegistry failed: ${r.error}`);
  return r.value;
}

function codes(decision: RepresentationDecision): readonly string[] {
  return decision.status === 'EXCLUDED' ? decision.reasonCodes : [];
}

const BACKED_AND_SYNTHETIC = { representations: [representationInput(), syntheticRepresentationInput()] };

// --- the valid path ---------------------------------------------------------

test('a backed representation from an approved issuer is admissible', () => {
  const d = evaluateRepresentation(open(), requirements(), repId(ADDRESS_A));
  assert.equal(d.status, Admissibility.ADMISSIBLE, JSON.stringify(codes(d)));
});

// --- equivalence is derived, not stored -------------------------------------

test('the same two representations give different answers under different mandates', () => {
  // The property that makes storing equivalence impossible. Nothing about the
  // registry changes between these two assertions.
  const registry = open(BACKED_AND_SYNTHETIC);
  const bothIssuers = { allowedIssuers: ['issuer.fixture.alpha', 'issuer.fixture.beta'] };

  const backedOnly = requirements(mandate({ ...bothIssuers, syntheticPolicy: 'FORBIDDEN' }));
  const syntheticsOk = requirements(mandate({ ...bothIssuers, syntheticPolicy: 'ALLOWED' }));

  assert.deepEqual(
    filterForMandate(registry, backedOnly).admissible.map((i) => i.contractAddress),
    [ADDRESS_A],
    'a backed-only mandate admits one',
  );
  assert.deepEqual(
    filterForMandate(registry, syntheticsOk).admissible.map((i) => i.contractAddress),
    [ADDRESS_A, ADDRESS_B],
    'a mandate that allows synthetics admits both',
  );
});

test('same underlying does not imply admissibility', () => {
  // Both representations are issued against NVDA. Membership got them into the
  // list; the mandate decided what happened next.
  const registry = open(BACKED_AND_SYNTHETIC);
  const result = filterForMandate(registry, requirements());
  assert.equal(result.decisions.length, 2);
  assert.equal(result.admissible.length, 1);
  assert.equal(result.excluded.length, 1);
});

// --- individual exclusions --------------------------------------------------

test('a synthetic representation fails a backed-only mandate', () => {
  const registry = open({ representations: [syntheticRepresentationInput()] });
  const d = evaluateRepresentation(
    registry,
    requirements(mandate({ allowedIssuers: ['issuer.fixture.beta'] })),
    repId(ADDRESS_B),
  );
  assert.equal(d.status, Admissibility.EXCLUDED);
  assert.ok(codes(d).includes('SYNTHETIC_NOT_ALLOWED'));
});

test('a synthetic representation passes when the mandate allows it', () => {
  const registry = open({ representations: [syntheticRepresentationInput()] });
  const d = evaluateRepresentation(
    registry,
    requirements(mandate({ allowedIssuers: ['issuer.fixture.beta'], syntheticPolicy: 'ALLOWED' })),
    repId(ADDRESS_B),
  );
  assert.equal(d.status, Admissibility.ADMISSIBLE, JSON.stringify(codes(d)));
});

test('the wrong issuer is excluded', () => {
  const registry = open({ representations: [representationInput({ issuer: verified(ISSUER_OMEGA) })] });
  const d = evaluateRepresentation(registry, requirements(), repId(ADDRESS_A));
  assert.deepEqual(codes(d), ['ISSUER_NOT_ALLOWED']);
});

test('the wrong chain is excluded', () => {
  const registry = open({
    representations: [representationInput({ representationId: repId(ADDRESS_A, ETHEREUM) })],
  });
  const d = evaluateRepresentation(registry, requirements(), repId(ADDRESS_A, ETHEREUM));
  assert.deepEqual(codes(d), ['CHAIN_NOT_ALLOWED']);
});

test('an inactive representation is excluded, with the state reported', () => {
  for (const status of ['PAUSED', 'DEPRECATED', 'TRANSITION']) {
    const registry = open({ representations: [representationInput({ operationalStatus: verified(status) })] });
    const d = evaluateRepresentation(registry, requirements(), repId(ADDRESS_A));
    assert.deepEqual(codes(d), ['REPRESENTATION_INACTIVE'], status);
    assert.equal(d.status === 'EXCLUDED' ? d.exclusions[0]?.detail['observed'] : '', status);
  }
});

test('a representation issued against another underlying is excluded', () => {
  const registry = open({
    assets: [assetInput(), amdAssetInput()],
    representations: [representationInput({ underlying: verified({ ...AMD }) })],
  });
  const d = evaluateRepresentation(registry, requirements(), repId(ADDRESS_A));
  assert.ok(codes(d).includes('REPRESENTATION_ASSET_MISMATCH'));
});

test('a delisted canonical asset yields no admissible representation', () => {
  const registry = open({ assets: [assetInput({ status: 'DELISTED' })] });
  const d = evaluateRepresentation(registry, requirements(), repId(ADDRESS_A));
  assert.deepEqual(codes(d), ['CANONICAL_ASSET_INACTIVE']);
});

// --- unknown contracts ------------------------------------------------------

test('an unregistered contract is never admissible', () => {
  const d = evaluateRepresentation(open(), requirements(), repId(ADDRESS_FAKE));
  assert.deepEqual(codes(d), ['REPRESENTATION_UNKNOWN']);
});

test('a fake token cannot become admissible by claiming the right symbol', () => {
  // The counterfeit is not in the snapshot. Its symbol, name and claimed
  // underlying are irrelevant, because nothing outside the snapshot is evaluated.
  const registry = open();
  const d = evaluateRepresentation(registry, requirements(), repId(ADDRESS_FAKE));
  assert.equal(d.status, Admissibility.EXCLUDED);
  assert.deepEqual(codes(d), ['REPRESENTATION_UNKNOWN']);
});

test('a named unregistered contract is reported, not silently omitted', () => {
  // A caller offered a contract from somewhere needs to be told it is unknown.
  const result = filterForMandate(open(), requirements(), [repId(ADDRESS_FAKE)]);
  assert.equal(result.admissible.length, 1);
  assert.equal(result.excluded.length, 1);
  assert.deepEqual(codes(result.excluded[0] as RepresentationDecision), ['REPRESENTATION_UNKNOWN']);
});

test('a malformed representation id is excluded with its own code', () => {
  const d = evaluateRepresentation(open(), requirements(), 'not-a-representation-id');
  assert.deepEqual(codes(d), ['REPRESENTATION_ID_MALFORMED']);
  assert.equal(d.status === 'EXCLUDED' ? d.representationId : 'x', null);
});

// --- unknown and conflicting metadata fail closed ---------------------------

test('unknown backing fails closed', () => {
  const registry = open({ representations: [representationInput({ backing: [] })] });
  const d = evaluateRepresentation(registry, requirements(), repId(ADDRESS_A));
  assert.deepEqual(codes(d), ['REPRESENTATION_METADATA_UNKNOWN']);
  assert.equal(d.status === 'EXCLUDED' ? d.exclusions[0]?.detail['property'] : '', 'backing');
});

test('backing known only from advisory data fails closed as a trust failure', () => {
  const registry = open({
    representations: [representationInput({ backing: [claim('FULLY_BACKED', TrustClass.ADVISORY)] })],
  });
  const d = evaluateRepresentation(registry, requirements(), repId(ADDRESS_A));
  assert.deepEqual(codes(d), ['TRUST_REQUIREMENT_NOT_MET']);
});

test('conflicting provenance fails closed, and names the disagreeing values', () => {
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
  const d = evaluateRepresentation(registry, requirements(), repId(ADDRESS_A));
  assert.deepEqual(codes(d), ['REPRESENTATION_METADATA_CONFLICT']);
  assert.equal(
    d.status === 'EXCLUDED' ? d.exclusions[0]?.detail['values'] : '',
    'FULLY_BACKED,SYNTHETIC',
  );
});

test('stale metadata is distinguished from missing metadata', () => {
  const registry = open({
    representations: [representationInput({ backing: [claim('FULLY_BACKED', TrustClass.VERIFIED, 90_000n)] })],
  });
  // The caller supplies the bound; a day-old backing claim is stale against an
  // hour-long one.
  const bounded = requirements(mandate(), { maxClaimAgeSeconds: 3_600n });
  const d = evaluateRepresentation(registry, bounded, repId(ADDRESS_A));
  assert.deepEqual(codes(d), ['REPRESENTATION_METADATA_STALE']);
});

test('a stale claim only matters when the caller sets a bound', () => {
  const registry = open({
    representations: [representationInput({ backing: [claim('FULLY_BACKED', TrustClass.VERIFIED, 90_000n)] })],
  });
  const unbounded = evaluateRepresentation(registry, requirements(), repId(ADDRESS_A));
  assert.equal(unbounded.status, Admissibility.ADMISSIBLE, 'no bound supplied, so age does not exclude');
});

// --- multiple independent reasons -------------------------------------------

test('every independent exclusion is collected, not just the first', () => {
  const registry = open({
    representations: [
      representationInput({
        representationId: repId(ADDRESS_A, ETHEREUM),
        issuer: verified(ISSUER_OMEGA),
        backing: verified('SYNTHETIC'),
        operationalStatus: verified('PAUSED'),
      }),
    ],
  });
  const d = evaluateRepresentation(registry, requirements(), repId(ADDRESS_A, ETHEREUM));
  assert.equal(d.status, Admissibility.EXCLUDED);
  for (const expected of [
    'ISSUER_NOT_ALLOWED',
    'CHAIN_NOT_ALLOWED',
    'SYNTHETIC_NOT_ALLOWED',
    'REPRESENTATION_INACTIVE',
  ]) {
    assert.ok(codes(d).includes(expected), `missing ${expected} in ${JSON.stringify(codes(d))}`);
  }
});

// --- narrowing can only narrow ---------------------------------------------

test('a narrowed requirement adds an exclusion', () => {
  const registry = open();
  const base = requirements();
  assert.equal(evaluateRepresentation(registry, base, repId(ADDRESS_A)).status, Admissibility.ADMISSIBLE);

  const narrowed = narrowRequirements(base, { allowedBackingModels: ['PARTIALLY_BACKED'] });
  assert.ok(narrowed.ok);
  const d = evaluateRepresentation(registry, narrowed.value, repId(ADDRESS_A));
  assert.deepEqual(codes(d), ['BACKING_REQUIREMENT_NOT_MET']);
});

test('narrowing cannot relax the mandate synthetic policy', () => {
  // There is no field on AdditionalRequirements that permits synthetics; the only
  // synthetic control is one-way.
  const base = requirements(mandate({ syntheticPolicy: 'FORBIDDEN' }));
  const narrowed = narrowRequirements(base, { forbidSynthetic: false });
  assert.ok(narrowed.ok);
  assert.equal(narrowed.value.syntheticPolicy, 'FORBIDDEN');
});

test('narrowing cannot widen an issuer or chain allowlist', () => {
  const base = requirements();
  const narrowed = narrowRequirements(base, {
    allowedIssuers: ['issuer.fixture.omega'],
    allowedChains: ['eip155:1'],
  });
  assert.ok(narrowed.ok);
  // Intersection with the mandate's allowlist, so adding an outside name empties it
  // rather than extending it.
  assert.deepEqual(narrowed.value.allowedIssuers, []);
  assert.deepEqual(narrowed.value.allowedChains, []);
});

test('narrowing cannot lower the trust floor or extend the claim age', () => {
  const base = requirements(mandate(), { maxClaimAgeSeconds: 600n });
  assert.equal(narrowRequirements(base, { minimumTrust: TrustClass.ADVISORY }).ok, false);

  const longer = narrowRequirements(base, { maxClaimAgeSeconds: 100_000n });
  assert.ok(longer.ok);
  assert.equal(longer.value.maxClaimAgeSeconds, 600n, 'the tighter bound is kept');
});

test('a trust floor below the execution floor is refused at derivation', () => {
  const r = deriveRequirements(mandate(), { nowUnixSeconds: NOW, minimumTrust: TrustClass.ADVISORY });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false ? r.error : '', 'TRUST_REQUIREMENT_NOT_MET');
});

// --- rights, jurisdiction and the other constrained dimensions --------------

test('a required right that is absent excludes', () => {
  const base = requirements();
  const narrowed = narrowRequirements(base, {
    requiredRights: [{ kind: 'VOTING_RIGHTS', acceptable: ['PRESENT'] }],
  });
  assert.ok(narrowed.ok);
  const d = evaluateRepresentation(open(), narrowed.value, repId(ADDRESS_A));
  assert.deepEqual(codes(d), ['RIGHTS_REQUIREMENT_NOT_MET']);
});

test('an unestablished right fails closed when the right is required', () => {
  // BENEFICIAL_OWNERSHIP has no claims in the fixture, so it is UNKNOWN rather
  // than absent, and it refuses with a different code.
  const narrowed = narrowRequirements(requirements(), {
    requiredRights: [{ kind: 'BENEFICIAL_OWNERSHIP', acceptable: ['PRESENT'] }],
  });
  assert.ok(narrowed.ok);
  const d = evaluateRepresentation(open(), narrowed.value, repId(ADDRESS_A));
  assert.deepEqual(codes(d), ['REPRESENTATION_METADATA_UNKNOWN']);
});

test('a dividend reflected in the price does not satisfy a demand for a paid dividend', () => {
  // The distinction a single boolean could not express.
  const narrowed = narrowRequirements(requirements(mandate({ allowedIssuers: ['issuer.fixture.beta'], syntheticPolicy: 'ALLOWED' })), {
    requiredRights: [{ kind: 'DIVIDEND_TREATMENT', acceptable: ['PRESENT'] }],
  });
  assert.ok(narrowed.ok);
  const registry = open({ representations: [syntheticRepresentationInput()] });
  const d = evaluateRepresentation(registry, narrowed.value, repId(ADDRESS_B));
  assert.deepEqual(codes(d), ['RIGHTS_REQUIREMENT_NOT_MET']);
  assert.equal(d.status === 'EXCLUDED' ? d.exclusions[0]?.detail['observed'] : '', 'PRICE_ADJUSTED');
});

test('a prohibited jurisdiction and an undeclared one both refuse', () => {
  const prohibited = narrowRequirements(requirements(), { holderJurisdiction: 'KP' });
  assert.ok(prohibited.ok);
  let d = evaluateRepresentation(open(), prohibited.value, repId(ADDRESS_A));
  assert.deepEqual(codes(d), ['JURISDICTION_NOT_ELIGIBLE']);
  assert.equal(d.status === 'EXCLUDED' ? d.exclusions[0]?.detail['reason'] : '', 'prohibited');

  const undeclared = narrowRequirements(requirements(), { holderJurisdiction: 'DE' });
  assert.ok(undeclared.ok);
  d = evaluateRepresentation(open(), undeclared.value, repId(ADDRESS_A));
  assert.deepEqual(codes(d), ['JURISDICTION_NOT_ELIGIBLE']);
  assert.equal(d.status === 'EXCLUDED' ? d.exclusions[0]?.detail['reason'] : '', 'not-permitted');

  const permitted = narrowRequirements(requirements(), { holderJurisdiction: 'US' });
  assert.ok(permitted.ok);
  assert.equal(evaluateRepresentation(open(), permitted.value, repId(ADDRESS_A)).status, Admissibility.ADMISSIBLE);
});

test('instrument type, redemption, settlement and corporate-action handling each exclude', () => {
  const cases: readonly [Json, string][] = [
    [{ allowedInstrumentTypes: ['FUND_SHARE'] }, 'INSTRUMENT_TYPE_NOT_ALLOWED'],
    [{ allowedRedemptionModels: ['OPEN_REDEMPTION'] }, 'REDEMPTION_REQUIREMENT_NOT_MET'],
    [{ allowedSettlementModels: ['ISSUER_CONFIRMED'] }, 'SETTLEMENT_MODEL_NOT_ALLOWED'],
    [{ allowedCorporateActionModels: ['SUPPLY_REBASE'] }, 'CORPORATE_ACTION_MODEL_NOT_ALLOWED'],
  ];
  for (const [additional, expected] of cases) {
    const narrowed = narrowRequirements(requirements(), additional as never);
    assert.ok(narrowed.ok, expected);
    const d = evaluateRepresentation(open(), narrowed.value, repId(ADDRESS_A));
    assert.deepEqual(codes(d), [expected]);
  }
});

// --- determinism ------------------------------------------------------------

test('filtering does not depend on snapshot order', () => {
  const forward = open({ representations: [representationInput(), syntheticRepresentationInput()] });
  const reverse = open({ representations: [syntheticRepresentationInput(), representationInput()] });
  const req = requirements(mandate({ allowedIssuers: ['issuer.fixture.alpha', 'issuer.fixture.beta'] }));
  assert.deepEqual(filterForMandate(forward, req), filterForMandate(reverse, req));
});

test('exclusion order does not depend on which check produced it', () => {
  const registry = open({
    representations: [
      representationInput({ issuer: verified(ISSUER_OMEGA), operationalStatus: verified('PAUSED') }),
    ],
  });
  const a = evaluateRepresentation(registry, requirements(), repId(ADDRESS_A));
  const b = evaluateRepresentation(registry, requirements(), repId(ADDRESS_A));
  assert.deepEqual(a, b);
  // Sorted by reason-code id, so the order is a property of the codes rather than
  // of the evaluation sequence.
  // MND-REPR-001 before MND-REPR-003.
  assert.deepEqual(codes(a), ['ISSUER_NOT_ALLOWED', 'REPRESENTATION_INACTIVE']);
});
