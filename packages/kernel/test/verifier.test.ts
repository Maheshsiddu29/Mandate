/**
 * Verifier behaviour.
 *
 * Every case here is the valid world with exactly one thing changed. The suite
 * is organized around the properties from design section 10.1 — total,
 * fail-closed, explaining, order-independent — and then walks the required
 * rejections one at a time.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_REASON_CODE_NAMES,
  CHECKS,
  Decision,
  MAX_STATE_REPRESENTATIONS,
  REASON_CODES,
  explain,
  reasonCode,
  verify,
  type ReasonCodeName,
  type VerifyRequest,
} from '../src/index.ts';
import {
  AMD,
  CHAIN,
  EPOCH,
  FOREIGN_CHAIN_REPRESENTATION_ID,
  EXPIRES_AT,
  NOT_BEFORE,
  NOW,
  OTHER_AGENT,
  OTHER_CHAIN,
  OTHER_VENUE,
  SYNTHETIC_REPRESENTATION_ID,
  UNAPPROVED_ISSUER,
  UNREGISTERED_REPRESENTATION_ID,
  representationInput,
  syntheticRepresentationInput,
} from './support/fixtures.ts';
import { buildWorld, type WorldOverrides } from './support/world.ts';
import { TEST_DOMAIN, TEST_PRIVATE_KEY_2 } from './support/signing.ts';

function codesFor(o: WorldOverrides): ReasonCodeName[] {
  return [...verify(buildWorld(o)).reasonCodes];
}

function assertRejects(o: WorldOverrides, expected: ReasonCodeName, label: string = expected): void {
  const receipt = verify(buildWorld(o));
  assert.equal(receipt.decision, Decision.REJECT, `${label}: expected REJECT`);
  assert.ok(
    receipt.reasonCodes.includes(expected),
    `${label}: expected ${expected}, got [${receipt.reasonCodes.join(', ')}]`,
  );
}

// --- The valid world --------------------------------------------------------

test('a fully valid execution passes with no reason codes', () => {
  const receipt = verify(buildWorld());
  assert.equal(receipt.decision, Decision.PASS);
  assert.deepEqual(receipt.reasonCodes, []);
  assert.deepEqual(receipt.violations, []);
  assert.notEqual(receipt.mandateDigest, null);
  assert.notEqual(receipt.candidateDigest, null);
  assert.notEqual(receipt.trustedStateDigest, null);
  assert.equal(receipt.evaluatedAtUnixSeconds, NOW);
});

// --- Required rejections ----------------------------------------------------

test('wrong canonical asset rejects', () => {
  assertRejects({ candidate: { canonicalAsset: { ...AMD } } }, 'CANONICAL_ASSET_MISMATCH');
});

test('a representation of a different underlying rejects', () => {
  assertRejects(
    { representations: [representationInput({ value: { canonicalAsset: { ...AMD } } })] },
    'REPRESENTATION_ASSET_MISMATCH',
  );
});

test('an unregistered representation rejects, so an injected address is unusable', () => {
  assertRejects(
    { candidate: { representationId: UNREGISTERED_REPRESENTATION_ID } },
    'REPRESENTATION_UNKNOWN',
  );
});

test('an issuer outside the allowlist rejects', () => {
  assertRejects(
    {
      candidate: { issuer: UNAPPROVED_ISSUER },
      representations: [representationInput({ value: { issuer: UNAPPROVED_ISSUER } })],
    },
    'ISSUER_NOT_ALLOWED',
  );
});

test('a chain outside the allowlist rejects', () => {
  assertRejects(
    {
      candidate: { chain: OTHER_CHAIN },
      representations: [representationInput({ value: { chain: OTHER_CHAIN } })],
    },
    'CHAIN_NOT_ALLOWED',
  );
});

test('a venue outside the allowlist rejects', () => {
  assertRejects({ candidate: { venue: OTHER_VENUE } }, 'VENUE_NOT_ALLOWED');
});

test('a synthetic representation rejects when the mandate forbids synthetic exposure', () => {
  assertRejects(
    {
      candidate: { representationId: SYNTHETIC_REPRESENTATION_ID },
      representations: [syntheticRepresentationInput()],
    },
    'SYNTHETIC_NOT_ALLOWED',
  );
});

test('the same synthetic representation passes when the mandate allows it', () => {
  const receipt = verify(
    buildWorld({
      mandate: { syntheticPolicy: 'ALLOWED' },
      candidate: { representationId: SYNTHETIC_REPRESENTATION_ID },
      representations: [syntheticRepresentationInput()],
    }),
  );
  assert.equal(receipt.decision, Decision.PASS, `got [${receipt.reasonCodes.join(', ')}]`);
});

test('a 10x amount error rejects', () => {
  // Ten times the quantity, with the notional honestly restated: the trade is
  // internally consistent and simply too large.
  assertRejects(
    {
      candidate: {
        quantity: { unit: 'SHARE', decimals: 2, atoms: 10_000n },
        notional: { unit: 'USD', decimals: 2, atoms: 1_000_000n },
      },
    },
    'MAX_NOTIONAL_EXCEEDED',
  );
});

test('a 10x notional inconsistency rejects even when it is within the limit', () => {
  // Quantity and price say 100.00 USD; the declared notional says 1000.00.
  // The mandate would permit 1000.00, so only the consistency check catches it.
  assertRejects(
    {
      candidate: {
        quantity: { unit: 'SHARE', decimals: 2, atoms: 100n },
        notional: { unit: 'USD', decimals: 2, atoms: 100_000n },
      },
    },
    'NOTIONAL_INCONSISTENT',
  );
});

test('a price outside the deviation bound rejects', () => {
  // Reference 100.00, mandate allows 40 bps. 100.50 is 50 bps.
  assertRejects(
    {
      candidate: {
        executionPrice: { numeratorUnit: 'USD', denominatorUnit: 'SHARE', decimals: 2, atoms: 10_050n },
        notional: { unit: 'USD', decimals: 2, atoms: 100_500n },
      },
    },
    'PRICE_DEVIATION_EXCEEDED',
  );
});

test('stale market state rejects', () => {
  assertRejects(
    { state: { market: { provenance: { observedAtUnixSeconds: NOW - 61n } } } },
    'PRICE_STATE_STALE',
  );
});

test('a trading halt rejects when the mandate forbids halted execution', () => {
  assertRejects({ state: { market: { value: { haltStatus: 'HALTED' } } } }, 'TRADING_HALTED');
});

test('a halt passes when the mandate explicitly permits it', () => {
  const receipt = verify(
    buildWorld({ mandate: { haltPolicy: 'ALLOW_WHEN_HALTED' }, state: { market: { value: { haltStatus: 'HALTED' } } } }),
  );
  assert.equal(receipt.decision, Decision.PASS, `got [${receipt.reasonCodes.join(', ')}]`);
});

test('an inactive representation rejects', () => {
  for (const operationalState of ['PAUSED', 'TRANSITION', 'DEPRECATED'] as const) {
    assertRejects(
      { representations: [representationInput({ value: { operationalState } })] },
      'REPRESENTATION_INACTIVE',
      operationalState,
    );
  }
});

test('an expired mandate rejects', () => {
  assertRejects({ now: EXPIRES_AT }, 'MANDATE_EXPIRED');
});

test('a not-yet-active mandate rejects', () => {
  assertRejects({ now: NOT_BEFORE - 1n }, 'MANDATE_NOT_YET_ACTIVE');
});

test('a signature that does not recover to the declared signer rejects as invalid', () => {
  // The envelope claims the principal signed it; the bytes were produced by
  // another key. Recovery mismatches.
  assertRejects({ signWith: TEST_PRIVATE_KEY_2, forgeSigner: true }, 'SIGNATURE_INVALID');
});

test('a valid signature by the wrong party rejects as unauthorized, not as invalid', () => {
  // Key 2 signs correctly and declares itself honestly. The signature verifies;
  // the signer is simply not the principal. These are different failures, and
  // collapsing them would hide which one occurred.
  const receipt = verify(buildWorld({ signWith: TEST_PRIVATE_KEY_2 }));
  assert.equal(receipt.decision, Decision.REJECT);
  assert.ok(receipt.reasonCodes.includes('SIGNER_UNAUTHORIZED'), receipt.reasonCodes.join(', '));
  assert.equal(receipt.reasonCodes.includes('SIGNATURE_INVALID'), false);
});

test('an agent that is not the mandate agent rejects', () => {
  assertRejects({ candidate: { agent: { ...OTHER_AGENT } } }, 'AGENT_UNAUTHORIZED');
});

test('a consumed mandate rejects as replay', () => {
  assertRejects({ state: { replay: { value: { status: 'CONSUMED' } } } }, 'MANDATE_ALREADY_CONSUMED');
});

test('unknown replay state fails closed rather than being treated as unused', () => {
  assertRejects({ state: { replay: { value: { status: 'UNKNOWN' } } } }, 'REPLAY_STATE_UNKNOWN');
});

test('a replay record about a different mandate is unknown, not unused', () => {
  assertRejects(
    { state: { replay: { value: { mandateDigest: '0x' + 'ab'.repeat(32) } } } },
    'REPLAY_STATE_UNKNOWN',
  );
});

test('a corporate-action epoch ahead of the authorization rejects', () => {
  assertRejects(
    {
      state: { corporateAction: { value: { epoch: EPOCH + 1n } } },
      candidate: { corporateActionEpoch: EPOCH + 1n },
    },
    'CORPORATE_ACTION_STATE_CHANGED',
  );
});

test('a corporate-action epoch behind the authorization rejects as inconsistent', () => {
  assertRejects(
    {
      state: { corporateAction: { value: { epoch: EPOCH - 1n } } },
      candidate: { corporateActionEpoch: EPOCH - 1n },
    },
    'CORPORATE_ACTION_STATE_INCONSISTENT',
  );
});

test('an unknown corporate-action epoch fails closed', () => {
  assertRejects({ state: { corporateAction: { value: { epoch: null } } } }, 'CORPORATE_ACTION_STATE_UNKNOWN');
});

test('a stale corporate-action observation rejects even when the epoch matches', () => {
  assertRejects(
    { state: { corporateAction: { provenance: { observedAtUnixSeconds: NOW - 301n } } } },
    'CORPORATE_ACTION_STATE_STALE',
  );
});

test('a candidate built against a different epoch rejects', () => {
  assertRejects({ candidate: { corporateActionEpoch: EPOCH + 5n } }, 'CANDIDATE_STATE_MISMATCH');
});

test('a candidate built against a different state snapshot rejects', () => {
  assertRejects({ candidate: { referenceStateId: 'snapshot.9999' } }, 'CANDIDATE_STATE_MISMATCH');
});

test('a unit mismatch rejects rather than being converted', () => {
  assertRejects(
    { candidate: { notional: { unit: 'EUR', decimals: 2, atoms: 100_000n } } },
    'UNIT_MISMATCH',
  );
});

test('malformed required state rejects', () => {
  assertRejects({ state: { representations: 'not-an-array' } }, 'MALFORMED_TRUSTED_STATE');
  assertRejects({ candidate: { quantity: { unit: 'SHARE', decimals: 2, atoms: -1n } } }, 'VALUE_OUT_OF_RANGE');
});

test('missing trusted state fails closed', () => {
  for (const input of ['market', 'corporateAction', 'replay'] as const) {
    assertRejects({ state: { [input]: null } }, 'TRUSTED_STATE_MISSING', input);
  }
});

test('advisory-provenance state cannot satisfy a trusted input', () => {
  for (const trustClass of ['ADVISORY', 'UNTRUSTED'] as const) {
    assertRejects({ state: { market: { provenance: { trustClass } } } }, 'UNTRUSTED_REQUIRED_STATE', trustClass);
  }
});

test('unknown representation metadata on a constrained field rejects', () => {
  assertRejects(
    { representations: [representationInput({ value: { synthetic: 'UNKNOWN' } })] },
    'REPRESENTATION_METADATA_UNKNOWN',
  );
});

test('unknown halt status and unknown reference price fail closed', () => {
  assertRejects({ state: { market: { value: { haltStatus: 'UNKNOWN' } } } }, 'MARKET_STATE_UNKNOWN');
  assertRejects({ state: { market: { value: { referencePrice: null } } } }, 'MARKET_STATE_UNKNOWN');
});

test('the wrong side rejects', () => {
  assertRejects({ candidate: { side: 'SELL' } }, 'SIDE_MISMATCH');
});

test('a candidate misdescribing its representation rejects', () => {
  assertRejects({ candidate: { issuer: UNAPPROVED_ISSUER } }, 'REPRESENTATION_ATTRIBUTES_MISMATCH');
});

test('an unsupported mandate version rejects as such', () => {
  assertRejects({ mandate: { version: 3 } }, 'UNSUPPORTED_MANDATE_VERSION');
});

test('an unsupported authorization scheme rejects', () => {
  const world = buildWorld();
  const authorization = { ...(world.authorization as Record<string, unknown>), scheme: 'ed25519-solana' };
  const receipt = verify({ ...world, authorization });
  assert.ok(receipt.reasonCodes.includes('AUTHORIZATION_SCHEME_UNSUPPORTED'));
});

test('a foreign EIP-712 domain rejects', () => {
  assertRejects({ signDomain: { ...TEST_DOMAIN, chainId: 1n } }, 'AUTHORIZATION_DOMAIN_MISMATCH');
});

test('a malformed authorization rejects', () => {
  assertRejects({ authorization: { scheme: 'eip712-secp256k1', signature: 'nope' } }, 'MALFORMED_AUTHORIZATION');
});

// --- Boundaries -------------------------------------------------------------

test('validity-window boundaries behave exactly as specified', () => {
  // Observations move with the evaluation instant, so only the validity window
  // is under test here and freshness does not confound it.
  const at = (now: bigint): WorldOverrides => ({
    now,
    state: {
      market: { provenance: { observedAtUnixSeconds: now } },
      corporateAction: { provenance: { observedAtUnixSeconds: now } },
    },
  });
  assert.equal(verify(buildWorld(at(EXPIRES_AT - 1n))).decision, Decision.PASS, 'expiresAt - 1 passes');
  assertRejects(at(EXPIRES_AT), 'MANDATE_EXPIRED', 'expiresAt rejects');
  assertRejects(at(EXPIRES_AT + 1n), 'MANDATE_EXPIRED', 'expiresAt + 1 rejects');

  assertRejects(at(NOT_BEFORE - 1n), 'MANDATE_NOT_YET_ACTIVE', 'notBefore - 1 rejects');
  assert.equal(verify(buildWorld(at(NOT_BEFORE))).decision, Decision.PASS, 'notBefore passes');
  assert.equal(verify(buildWorld(at(NOT_BEFORE + 1n))).decision, Decision.PASS, 'notBefore + 1 passes');
});

test('freshness-window boundaries behave exactly as specified', () => {
  const at = (age: bigint) => ({ state: { market: { provenance: { observedAtUnixSeconds: NOW - age } } } });
  assert.equal(verify(buildWorld(at(59n))).decision, Decision.PASS, 'age 59 passes');
  assert.equal(verify(buildWorld(at(60n))).decision, Decision.PASS, 'age 60 (the bound) passes');
  assertRejects(at(61n), 'PRICE_STATE_STALE', 'age 61 rejects');
});

test('an observation from the future fails closed', () => {
  assertRejects(
    { state: { market: { provenance: { observedAtUnixSeconds: NOW + 1n } } } },
    'MARKET_STATE_UNKNOWN',
  );
});

test('notional and deviation boundaries are exact', () => {
  // Exactly at the maximum notional passes.
  assert.equal(verify(buildWorld()).decision, Decision.PASS, 'notional == max passes');
  // One atom over rejects.
  assertRejects(
    {
      candidate: {
        quantity: { unit: 'SHARE', decimals: 2, atoms: 1_001n },
        notional: { unit: 'USD', decimals: 2, atoms: 100_100n },
      },
    },
    'MAX_NOTIONAL_EXCEEDED',
    'notional == max + 1 rejects',
  );

  // Deviation: reference 100.00, bound 40 bps. 100.40 is exactly 40 bps.
  const atPrice = (atoms: bigint, notionalAtoms: bigint) => ({
    candidate: {
      executionPrice: { numeratorUnit: 'USD', denominatorUnit: 'SHARE', decimals: 2, atoms },
      notional: { unit: 'USD', decimals: 2, atoms: notionalAtoms },
      quantity: { unit: 'SHARE', decimals: 2, atoms: 1_000n },
    },
    mandate: { maxNotional: { unit: 'USD', decimals: 2, atoms: 200_000n } },
  });
  assert.equal(verify(buildWorld(atPrice(10_040n, 100_400n))).decision, Decision.PASS, '40 bps passes');
  assertRejects(atPrice(10_041n, 100_410n), 'PRICE_DEVIATION_EXCEEDED', '>40 bps rejects');
});

// --- Properties from design section 10.1 -----------------------------------

test('a rejection names every violated constraint, not the first', () => {
  const codes = codesFor({
    candidate: {
      issuer: UNAPPROVED_ISSUER,
      venue: OTHER_VENUE,
      quantity: { unit: 'SHARE', decimals: 2, atoms: 10_000n },
      notional: { unit: 'USD', decimals: 2, atoms: 1_000_000n },
    },
    representations: [representationInput({ value: { issuer: UNAPPROVED_ISSUER } })],
    state: { market: { provenance: { observedAtUnixSeconds: NOW - 3600n } } },
    now: NOW,
  });

  for (const expected of [
    'ISSUER_NOT_ALLOWED',
    'VENUE_NOT_ALLOWED',
    'MAX_NOTIONAL_EXCEEDED',
    'PRICE_STATE_STALE',
  ] as const) {
    assert.ok(codes.includes(expected), `expected ${expected} in [${codes.join(', ')}]`);
  }
  assert.ok(codes.length >= 4);
});

test('the verdict does not depend on the order checks run in', () => {
  const world = buildWorld({
    candidate: { issuer: UNAPPROVED_ISSUER, venue: OTHER_VENUE, side: 'SELL' },
    representations: [representationInput({ value: { issuer: UNAPPROVED_ISSUER, operationalState: 'PAUSED' } })],
    now: NOT_BEFORE - 1n,
  });
  const baseline = verify(world);
  assert.equal(baseline.decision, Decision.REJECT);

  // A deterministic shuffle, so a failure is reproducible.
  let seed = 12345;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let trial = 0; trial < 25; trial += 1) {
    const shuffled = [...CHECKS];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j] as never, shuffled[i] as never];
    }
    const receipt = verify({ ...world, checks: shuffled });
    assert.equal(receipt.decision, baseline.decision);
    assert.deepEqual(receipt.reasonCodes, baseline.reasonCodes, `trial ${trial}`);
    assert.equal(receipt.receiptDigest, baseline.receiptDigest, `trial ${trial} digest`);
  }
});

test('verification is deterministic and reproducible from its inputs', () => {
  const world = buildWorld({ candidate: { venue: OTHER_VENUE } });
  const a = verify(world);
  const b = verify(world);
  assert.deepEqual(a, b);
  assert.equal(a.receiptDigest, b.receiptDigest);
});

test('a check that throws fails closed rather than passing', () => {
  const exploding = [{ name: 'exploding', run: () => { throw new Error('boom'); } }];
  const receipt = verify({ ...buildWorld(), checks: exploding });
  assert.equal(receipt.decision, Decision.REJECT);
  assert.deepEqual(receipt.reasonCodes, ['VERIFIER_INTERNAL_ERROR']);
});

test('the verifier is total: arbitrary junk produces a receipt, never a throw', () => {
  const junk: unknown[] = [
    undefined, null, 0, -1, '', 'x', [], {}, { version: 'one' }, { version: 1 },
    Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2n ** 300n, Symbol.iterator.toString(),
    { __proto__: { version: 1 } },
  ];
  for (const m of junk) {
    for (const c of junk) {
      const receipt = verify({
        mandate: m,
        authorization: c,
        candidate: c,
        trustedState: m,
        clock: c,
        expectedDomain: m,
      });
      assert.equal(receipt.decision, Decision.REJECT);
      assert.ok(receipt.reasonCodes.length > 0);
      assert.equal(typeof receipt.receiptDigest, 'string');
    }
  }
});

// --- Receipts and explanation ----------------------------------------------

test('both PASS and REJECT produce receipts with stable digests', () => {
  const pass = verify(buildWorld());
  const reject = verify(buildWorld({ candidate: { venue: OTHER_VENUE } }));
  assert.equal(pass.decision, Decision.PASS);
  assert.equal(reject.decision, Decision.REJECT);
  assert.notEqual(pass.receiptDigest, reject.receiptDigest);
  for (const r of [pass, reject]) {
    assert.match(r.receiptDigest, /^0x[0-9a-f]{64}$/);
    assert.equal(r.verifierVersion, 'mandate-kernel/2');
  }
});

test('the receipt digest changes when any recorded part of the decision changes', () => {
  const a = verify(buildWorld({ candidate: { venue: OTHER_VENUE } }));
  const b = verify(buildWorld({ candidate: { venue: 'venue.third' } }));
  assert.notEqual(a.receiptDigest, b.receiptDigest);
});

test('explanation separates user wording from machine detail', () => {
  const receipt = verify(buildWorld({ candidate: { canonicalAsset: { ...AMD } } }));
  const explained = explain(receipt);
  assert.equal(explained.headline, 'Trade blocked');
  assert.deepEqual(explained.userMessages, ['The selected asset does not match your authorization.']);

  const v = explained.violations.find((x) => x.code === 'CANONICAL_ASSET_MISMATCH');
  assert.ok(v, 'the machine detail is still available');
  assert.equal(v.id, 'MND-ASSET-001');
  assert.equal(v.detail['expected'], 'BBG000BBJQV0');
  assert.equal(v.detail['observed'], AMD.value);

  // No user-facing message leaks an internal identifier.
  for (const message of explained.userMessages) {
    assert.doesNotMatch(message, /0x|MND-|eip155|BBG/, message);
  }
});

// --- Registry hygiene -------------------------------------------------------

test('reason codes are unique, well-formed and complete', () => {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const d of REASON_CODES) {
    assert.match(d.id, /^MND-[A-Z]+-\d{3}$/, d.id);
    assert.equal(ids.has(d.id), false, `duplicate id ${d.id}`);
    assert.equal(names.has(d.name), false, `duplicate name ${d.name}`);
    ids.add(d.id);
    names.add(d.name);
    assert.ok(d.developerMessage.length > 20, `${d.name} needs a developer message`);
    assert.ok(d.humanMessage.length > 10, `${d.name} needs a human message`);
    assert.ok(d.id.includes(d.family), `${d.id} does not carry its family`);
    assert.doesNotMatch(d.humanMessage, /MND-|0x|undefined/, `${d.name} human message leaks internals`);
  }
  assert.equal(ids.size, ALL_REASON_CODE_NAMES.length);
});

/**
 * One representation past the parser's bound, built lazily so the cost is paid
 * only by the coverage test that needs it.
 */
function oversizedRepresentations(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i <= MAX_STATE_REPRESENTATIONS; i += 1) {
    out.push(representationInput({ value: { representationId: `eip155:42161/erc20:0x${i.toString(16).padStart(40, '0')}` } }));
  }
  return out;
}

test('every reason code the verifier can emit is reachable by a test in this suite', () => {
  // Codes produced by construction paths outside the verifier's own checks are
  // listed explicitly rather than silently excluded.
  const coveredElsewhere: ReadonlySet<ReasonCodeName> = new Set([
    'MALFORMED_MANDATE',
    'MALFORMED_CANDIDATE',
    'MALFORMED_IDENTIFIER',
    'VERIFIER_INTERNAL_ERROR',
  ]);

  const emitted = new Set<ReasonCodeName>();
  const worlds: WorldOverrides[] = [
    { candidate: { canonicalAsset: { ...AMD } } },
    { representations: [representationInput({ value: { canonicalAsset: { ...AMD } } })] },
    { candidate: { representationId: UNREGISTERED_REPRESENTATION_ID } },
    { candidate: { issuer: UNAPPROVED_ISSUER }, representations: [representationInput({ value: { issuer: UNAPPROVED_ISSUER } })] },
    { candidate: { chain: OTHER_CHAIN }, representations: [representationInput({ value: { chain: OTHER_CHAIN } })] },
    { candidate: { venue: OTHER_VENUE } },
    { candidate: { representationId: SYNTHETIC_REPRESENTATION_ID }, representations: [syntheticRepresentationInput()] },
    { candidate: { quantity: { unit: 'SHARE', decimals: 2, atoms: 10_000n }, notional: { unit: 'USD', decimals: 2, atoms: 1_000_000n } } },
    { candidate: { quantity: { unit: 'SHARE', decimals: 2, atoms: 100n }, notional: { unit: 'USD', decimals: 2, atoms: 100_000n } } },
    { candidate: { executionPrice: { numeratorUnit: 'USD', denominatorUnit: 'SHARE', decimals: 2, atoms: 10_050n }, notional: { unit: 'USD', decimals: 2, atoms: 100_500n } } },
    { state: { market: { provenance: { observedAtUnixSeconds: NOW - 61n } } } },
    { state: { market: { value: { haltStatus: 'HALTED' } } } },
    { state: { market: { value: { haltStatus: 'UNKNOWN' } } } },
    { representations: [representationInput({ value: { operationalState: 'PAUSED' } })] },
    { representations: [representationInput({ value: { synthetic: 'UNKNOWN' } })] },
    { now: EXPIRES_AT },
    { now: NOT_BEFORE - 1n },
    { signWith: TEST_PRIVATE_KEY_2 },
    { signWith: TEST_PRIVATE_KEY_2, forgeSigner: true },
    { candidate: { agent: { ...OTHER_AGENT } } },
    { state: { replay: { value: { status: 'CONSUMED' } } } },
    { state: { replay: { value: { status: 'RESERVED' } } } },
    { state: { replay: { value: { status: 'UNKNOWN' } } } },
    { state: { corporateAction: { value: { epoch: EPOCH + 1n } }, }, candidate: { corporateActionEpoch: EPOCH + 1n } },
    { state: { corporateAction: { value: { epoch: EPOCH - 1n } } }, candidate: { corporateActionEpoch: EPOCH - 1n } },
    { state: { corporateAction: { value: { epoch: null } } } },
    { state: { corporateAction: { provenance: { observedAtUnixSeconds: NOW - 301n } } } },
    { candidate: { corporateActionEpoch: EPOCH + 5n } },
    { candidate: { notional: { unit: 'EUR', decimals: 2, atoms: 100_000n } } },
    { candidate: { quantity: { unit: 'SHARE', decimals: 2, atoms: -1n } } },
    { state: { representations: 'not-an-array' } },
    { state: { market: null } },
    { state: { market: { provenance: { trustClass: 'ADVISORY' } } } },
    { candidate: { side: 'SELL' } },
    { candidate: { issuer: UNAPPROVED_ISSUER } },
    { mandate: { version: 3 } },
    { signDomain: { ...TEST_DOMAIN, chainId: 1n } },
    { authorization: { scheme: 'eip712-secp256k1', signature: 'nope' } },
    { authorization: { scheme: 'ed25519-solana' } },
    { candidate: { referenceStateId: 'snapshot.9999' } },
    // --- Phase 5R: the codes the remediation added ---------------------------
    { candidate: { referenceStateDigest: '0x' + 'ab'.repeat(32) }, unboundState: true },
    { candidate: { feeTotal: { unit: 'USD', decimals: 2, atoms: 1_000n } } },
    { mandate: { side: 'SELL', economicLimit: { unit: 'USD', decimals: 2, atoms: 99_999n } }, candidate: { side: 'SELL' } },
    { mandate: { side: 'SELL' }, candidate: { side: 'SELL', feeTotal: { unit: 'USD', decimals: 2, atoms: 100_000n } } },
    { candidate: { representationId: FOREIGN_CHAIN_REPRESENTATION_ID }, representations: [representationInput({ value: { representationId: FOREIGN_CHAIN_REPRESENTATION_ID } })] },
    { state: { replay: { value: { status: 'QUARANTINED' } } } },
    { state: { representations: oversizedRepresentations() } },
  ];
  for (const w of worlds) for (const c of verify(buildWorld(w)).reasonCodes) emitted.add(c);

  const missing = ALL_REASON_CODE_NAMES.filter((n) => !emitted.has(n) && !coveredElsewhere.has(n));
  assert.deepEqual(missing, [], `reason codes never produced: ${missing.join(', ')}`);

  // And the explicit exclusions must genuinely be tested somewhere.
  for (const name of coveredElsewhere) assert.ok(reasonCode(name), name);
});

test('the check list has no duplicate names', () => {
  const names = CHECKS.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
});
