/**
 * Identity mutation tests: changing one semantically relevant field changes
 * the canonical digest.
 *
 * For each security-critical object, every field of its input is mutated at
 * least once (the test fails if a field is left uncovered), each mutant must
 * still be a valid object, and every mutant's digest must differ from the base
 * and from every other mutant's. A field that did not reach the digest would
 * let two different authorizations share one identity; this is what catches it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  actionId,
  adapterRefDigest,
  authorityId,
  executionAuthorizationId,
  executionBindingId,
  moduleRefDigest,
  principalPolicyId,
  quantityDigest,
  reservationRefDigest,
  stateBindingId,
  stateId,
  validateActionEnvelope,
  validateAdapterRef,
  validateAuthorityGrant,
  validateExecutionAuthorization,
  validateExecutionBindingRef,
  validateModuleRef,
  validatePrincipalPolicy,
  validateQuantity,
  validateReservationRef,
  validateStateBinding,
  validateStateEnvelope,
  type AuthorityTermInput,
  type CoreResult,
  type EconomicQuantityInput,
  type LedgerDimensionInput,
  type PrincipalPolicyTermInput,
} from '../src/index.ts';
import {
  BTC,
  EVM_GATE,
  ETH_PERP_L,
  L_SUB,
  PERP_AGENT,
  PERP_V1,
  PRINCIPAL,
  PRINCIPAL_2,
  SPOT_AGENT,
  USDG,
  USDG_ON_L,
  VENUE_SIGNER_L,
  digestOf,
  must,
  notionalAtLimit,
  sampleActionInput,
  sampleAuthorizationInput,
  sampleBindingInput,
  sampleExecutionBindingInput,
  sampleGrantInput,
  samplePolicyInput,
  sampleReservationInput,
  sampleStateInput,
  unvalued,
} from './support/fixtures.ts';

type Mutations<I> = { readonly [name: string]: (input: I) => I };

/** Curried so the input type is fixed by the validator before the mutation map is checked against it. */
function suite<I extends object, T>(validate: (input: I) => CoreResult<T>, digest: (value: T) => string) {
  return (name: string, base: I, mutations: Mutations<I>): void => run(name, base, validate, digest, mutations);
}

function run<I extends object, T>(name: string, base: I, validate: (input: I) => CoreResult<T>, digest: (value: T) => string, mutations: Mutations<I>): void {
  describe(name, () => {
    const baseDigest = digest(must(validate(base)));

    it('every input field is mutated at least once', () => {
      const covered = new Set(Object.keys(mutations).map((m) => m.split(/[.[]/)[0]));
      for (const field of Object.keys(base)) assert.ok(covered.has(field), `${name}.${field} has no mutation`);
    });

    it('every single-field mutation is valid and changes the digest, and no two mutations collide', () => {
      const seen = new Map<string, string>([[baseDigest, '(base)']]);
      for (const [mutation, apply] of Object.entries(mutations)) {
        const r = validate(apply(base));
        assert.ok(r.ok, `${mutation}: ${r.ok ? '' : `${r.error.code} at ${r.error.path}`}`);
        const d = digest(r.value);
        assert.ok(!seen.has(d), `${mutation} collides with ${seen.get(d)}`);
        seen.set(d, mutation);
      }
    });
  });
}

const other = (label: string): string => digestOf(`mutation:${label}`);

// --- ActionEnvelope --------------------------------------------------------------

suite(validateActionEnvelope, actionId)('ActionEnvelope', sampleActionInput(), {
  principal: (a) => ({ ...a, principal: PRINCIPAL_2 }),
  authority: (a) => ({ ...a, authority: other('authority') }),
  actor: (a) => ({ ...a, actor: SPOT_AGENT }),
  'module.domainId': (a) => ({ ...a, module: { ...a.module, domainId: 'perp-x' } }),
  'module.moduleId': (a) => ({ ...a, module: { ...a.module, moduleId: 'perp-policy-x' } }),
  'module.moduleVersion': (a) => ({ ...a, module: { ...a.module, moduleVersion: 2 } }),
  'module.moduleDigest': (a) => ({ ...a, module: { ...a.module, moduleDigest: other('module') } }),
  actionType: (a) => ({ ...a, actionType: 'perp.cancel' }),
  'adapter.adapterId': (a) => ({ ...a, adapter: { ...a.adapter, adapterId: 'venue-signer-x' } }),
  'adapter.adapterVersion': (a) => ({ ...a, adapter: { ...a.adapter, adapterVersion: 2 } }),
  'adapter.adapterDigest': (a) => ({ ...a, adapter: { ...a.adapter, adapterDigest: other('adapter') } }),
  target: (a) => ({ ...a, target: ETH_PERP_L }),
  'resources.add': (a) => ({ ...a, resources: [...a.resources, USDG] }),
  'resources.remove': (a) => ({ ...a, resources: a.resources.slice(1) }),
  payloadDigest: (a) => ({ ...a, payloadDigest: other('payload') }),
  validFrom: (a) => ({ ...a, validFrom: BigInt(a.validFrom) + 1n }),
  expiresAt: (a) => ({ ...a, expiresAt: BigInt(a.expiresAt) + 1n }),
  nonce: (a) => ({ ...a, nonce: BigInt(a.nonce) + 1n }),
});

// --- StateEnvelope and StateBinding ----------------------------------------------

suite(validateStateEnvelope, stateId)('StateEnvelope', sampleStateInput(), {
  domain: (s) => ({ ...s, domain: 'perp-x' }),
  stateKind: (s) => ({ ...s, stateKind: 'perp.indexPrice' }),
  subject: (s) => ({ ...s, subject: ETH_PERP_L }),
  sourceId: (s) => ({ ...s, sourceId: 'venue-l-ws' }),
  trustClass: (s) => ({ ...s, trustClass: 'AUTHORITATIVE' }),
  observedAt: (s) => ({ ...s, observedAt: BigInt(s.observedAt) + 1n }),
  'sequence.value': (s) => ({ ...s, sequence: { kind: 'VENUE_SEQUENCE', value: 1041n } }),
  'sequence.kind': (s) => ({ ...s, sequence: { kind: 'BLOCK', value: 1040n } }),
  validUntil: (s) => ({ ...s, validUntil: BigInt(s.observedAt) + 30n }),
  'finality.level': (s) => ({ ...s, finality: { ...s.finality, level: 'FINAL' } }),
  'finality.ladder': (s) => ({ ...s, finality: { ...s.finality, ladder: 'venue-l.other' } }),
  payloadDigest: (s) => ({ ...s, payloadDigest: other('state-payload') }),
});

suite(validateStateBinding, stateBindingId)('StateBinding', sampleBindingInput(digestOf('sample:state')), {
  stateKind: (b) => ({ ...b, stateKind: 'perp.indexPrice' }),
  subject: (b) => ({ ...b, subject: ETH_PERP_L }),
  sourceId: (b) => ({ ...b, sourceId: 'venue-l-ws' }),
  trustClass: (b) => ({ ...b, trustClass: 'AUTHORITATIVE' }),
  'sequence.value': (b) => ({ ...b, sequence: { kind: 'VENUE_SEQUENCE', value: 1041n } }),
  'sequence.kind': (b) => ({ ...b, sequence: { kind: 'NONE' } }),
  observedAt: (b) => ({ ...b, observedAt: BigInt(b.observedAt) + 1n }),
  validUntil: (b) => ({ ...b, validUntil: BigInt(b.observedAt) + 30n }),
  'finality.level': (b) => ({ ...b, finality: { ...b.finality, level: 'FINAL' } }),
  'finality.ladder': (b) => ({ ...b, finality: { ...b.finality, ladder: 'venue-l.other' } }),
  stateDigest: (b) => ({ ...b, stateDigest: other('state') }),
  'requirement.freshness.maxAge': (b) => ({ ...b, requirement: { ...b.requirement, freshness: { kind: 'AGE', maxAgeSeconds: 6n } } }),
  'requirement.freshness.kind': (b) => ({ ...b, requirement: { ...b.requirement, freshness: { kind: 'VERSION', pinnedDigest: other('pin'), maxAgeSeconds: 5n } } }),
  'requirement.minTrust': (b) => ({ ...b, requirement: { ...b.requirement, minTrust: 'AUTHORITATIVE' } }),
  'requirement.minFinality': (b) => ({ ...b, requirement: { ...b.requirement, minFinality: { ladder: 'venue-l.market-data', level: 'FINAL' } } }),
  'requirement.atIssue': (b) => ({ ...b, requirement: { ...b.requirement, atIssue: 'WITHIN_POLICY' } }),
  'requirement.atExecution.kind': (b) => ({ ...b, requirement: { ...b.requirement, atExecution: { kind: 'BOUNDED_BY_FRESHNESS' } } }),
  'requirement.atExecution.field': (b) => ({ ...b, requirement: { ...b.requirement, atExecution: { kind: 'ENFORCED_BY_ARTIFACT', field: 'orderExpiry' } } }),
});

// --- ModuleRef, AdapterRef --------------------------------------------------------

suite(validateModuleRef, moduleRefDigest)('ModuleRef', PERP_V1, {
  domainId: (m) => ({ ...m, domainId: 'perp-x' }),
  moduleId: (m) => ({ ...m, moduleId: 'perp-policy-x' }),
  moduleVersion: (m) => ({ ...m, moduleVersion: m.moduleVersion + 1 }),
  moduleDigest: (m) => ({ ...m, moduleDigest: other('module') }),
});

suite(validateAdapterRef, adapterRefDigest)('AdapterRef', EVM_GATE, {
  adapterId: (a) => ({ ...a, adapterId: 'evm-gate-x' }),
  adapterVersion: (a) => ({ ...a, adapterVersion: a.adapterVersion + 1 }),
  adapterDigest: (a) => ({ ...a, adapterDigest: other('adapter') }),
});

// --- EconomicQuantity ------------------------------------------------------------

suite(validateQuantity, quantityDigest)('EconomicQuantity (unvalued)', unvalued('CAPITAL', 'USDG', 6, 600_000_000n, USDG), {
  kind: (q) => ({ ...q, kind: 'MARGIN' }),
  unit: (q) => ({ ...q, unit: 'USDC' }),
  decimals: (q) => ({ ...q, decimals: 7 }),
  atoms: (q) => ({ ...q, atoms: 600_000_001n }),
  asset: (q) => ({ ...q, asset: USDG_ON_L }),
  valuation: (q): EconomicQuantityInput => ({ ...q, kind: 'NOTIONAL', unit: 'USD', decimals: 2, asset: BTC, valuation: notionalAtLimit(1n, 1n, other('a'), 1n).valuation }),
});

const NOTIONAL = notionalAtLimit(400_000n, 10_000_000n, digestOf('sample:action'), 1_000n);
const valuation = NOTIONAL.valuation as NonNullable<EconomicQuantityInput['valuation']>;

suite(validateQuantity, quantityDigest)('EconomicQuantity (valued)', NOTIONAL, {
  kind: (q) => ({ ...q, kind: 'GROSS_EXPOSURE', valuation: { ...valuation, basis: 'MARK', source: { kind: 'STATE', stateId: other('mark') } } }),
  unit: (q) => ({ ...q, unit: 'USDC', valuation: { ...valuation, price: { ...valuation.price, numeratorUnit: 'USDC' } } }),
  decimals: (q) => ({ ...q, decimals: 3 }),
  atoms: (q) => ({ ...q, atoms: 400_001n }),
  asset: (q) => ({ ...q, asset: { ...BTC, localId: 'crypto:eth' } }),
  'valuation.price': (q) => ({ ...q, valuation: { ...valuation, price: { ...valuation.price, atoms: 10_000_001n } } }),
  'valuation.price.denominator': (q) => ({ ...q, valuation: { ...valuation, price: { ...valuation.price, denominatorUnit: 'XBT' } } }),
  'valuation.basis': (q) => ({ ...q, valuation: { ...valuation, basis: 'EXECUTION' } }),
  'valuation.source.kind': (q) => ({ ...q, valuation: { ...valuation, source: { kind: 'OBSERVATION', observationId: digestOf('sample:action') } } }),
  'valuation.source.id': (q) => ({ ...q, valuation: { ...valuation, source: { kind: 'ACTION', actionId: other('action') } } }),
  'valuation.observedAt': (q) => ({ ...q, valuation: { ...valuation, observedAt: 1_001n } }),
});

// --- Grants and policies ---------------------------------------------------------

function replaceTerm(terms: readonly AuthorityTermInput[], kind: string, next: AuthorityTermInput): AuthorityTermInput[] {
  return terms.map((t) => (t.kind === kind ? next : t));
}

const grantDimension = (limit: bigint): LedgerDimensionInput => ({
  kind: 'LEDGER_DIMENSION',
  dimensionId: 'capital',
  limit: { kind: 'CAPITAL', unit: 'USDG', decimals: 6, atoms: limit },
  accounting: 'CAPACITY',
  restoration: 'AS_CHARGED',
  epoch: null,
  sign: 'UNSIGNED',
  scope: { asset: null, market: null, domain: null, account: null },
});

suite(validateAuthorityGrant, authorityId)('AuthorityGrant', sampleGrantInput(), {
  'lineage.kind': (g) => ({ ...g, lineage: { kind: 'DELEGATION', parent: other('parent'), issuer: PERP_AGENT } }),
  'lineage.issuer': (g) => ({ ...g, principal: PRINCIPAL_2, lineage: { kind: 'ROOT', issuer: PRINCIPAL_2 } }),
  principal: (g) => ({ ...g, principal: PRINCIPAL_2, lineage: { kind: 'ROOT', issuer: PRINCIPAL_2 }, holder: PERP_AGENT }),
  holder: (g) => ({ ...g, holder: PERP_AGENT }),
  notBefore: (g) => ({ ...g, notBefore: BigInt(g.notBefore) + 1n }),
  expiresAt: (g) => ({ ...g, expiresAt: BigInt(g.expiresAt) - 1n }),
  'terms.limit': (g) => ({ ...g, terms: replaceTerm(g.terms, 'LEDGER_DIMENSION', grantDimension(10_000_000_001n)) }),
  'terms.moduleDigest': (g) => ({
    ...g,
    terms: g.terms.map((t) => (t.kind === 'SET' && t.vocabulary === 'MODULES' ? { ...t, members: [{ ...PERP_V1, moduleDigest: other('module') }] } : t)),
  }),
  'terms.adapterDigest': (g) => ({
    ...g,
    terms: g.terms.map((t) => (t.kind === 'SET' && t.vocabulary === 'ADAPTERS' ? { ...t, members: [{ ...VENUE_SIGNER_L, adapterDigest: other('adapter') }] } : t)),
  }),
  'terms.delegateDepth': (g) => ({ ...g, terms: g.terms.map((t) => (t.kind === 'RIGHT' && t.right === 'DELEGATE' ? { ...t, maxDepth: 1 } : t)) }),
  'terms.add': (g) => ({ ...g, terms: [...g.terms, { kind: 'RIGHT', right: 'TRANSFER_OUT' }] }),
  'terms.remove': (g) => ({ ...g, terms: g.terms.filter((t) => t.kind !== 'BOUND') }),
  'terms.invariantParams': (g) => ({ ...g, terms: g.terms.map((t) => (t.kind === 'STATE_INVARIANT' ? { ...t, params: '0x0300' } : t)) }),
  'terms.invariantScope': (g) => ({ ...g, terms: g.terms.map((t) => (t.kind === 'STATE_INVARIANT' ? { ...t, scope: [L_SUB, { ...L_SUB, localId: 'venue-l:sub-2' }] } : t)) }),
  'terms.statePolicyFreshness': (g) => ({
    ...g,
    terms: g.terms.map((t) => (t.kind === 'STATE_POLICY' ? { ...t, requirement: { ...t.requirement, freshness: { kind: 'AGE', maxAgeSeconds: 9n } } } : t)),
  }),
  nonce: (g) => ({ ...g, nonce: BigInt(g.nonce) + 1n }),
});

suite(validatePrincipalPolicy, principalPolicyId)('PrincipalPolicy', samplePolicyInput(), {
  principal: (p) => ({ ...p, principal: PRINCIPAL_2 }),
  sequence: (p) => ({ ...p, sequence: BigInt(p.sequence) + 1n }),
  'terms.limit': (p) => ({
    ...p,
    terms: p.terms.map((t): PrincipalPolicyTermInput => (t.kind === 'LEDGER_DIMENSION' ? { ...t, limit: { ...t.limit, atoms: BigInt(t.limit.atoms) - 1n } } : t)),
  }),
  'terms.dimensionScope': (p) => ({
    ...p,
    terms: p.terms.map((t): PrincipalPolicyTermInput => (t.kind === 'LEDGER_DIMENSION' ? { ...t, scope: { ...t.scope, domain: 'perp' } } : t)),
  }),
  'terms.freshness': (p) => ({
    ...p,
    terms: p.terms.map((t): PrincipalPolicyTermInput =>
      t.kind === 'STATE_POLICY' ? { ...t, requirement: { ...t.requirement, freshness: { kind: 'AGE', maxAgeSeconds: 4n } } } : t,
    ),
  }),
  'terms.sources': (p) => ({ ...p, terms: p.terms.map((t): PrincipalPolicyTermInput => (t.kind === 'STATE_POLICY' ? { ...t, admittedSources: ['venue-l-api'] } : t)) }),
  'terms.remove': (p) => ({ ...p, terms: p.terms.filter((t) => t.kind !== 'STATE_INVARIANT') }),
  nonce: (p) => ({ ...p, nonce: BigInt(p.nonce) + 1n }),
});

// --- Reservation and execution references ----------------------------------------

const ACTION = digestOf('sample:action');

suite(validateReservationRef, reservationRefDigest)('ReservationRef', sampleReservationInput(ACTION), {
  action: (r) => ({ ...r, action: other('action') }),
  generation: (r) => ({ ...r, generation: 2n }),
  principal: (r) => ({ ...r, principal: PRINCIPAL_2 }),
  lineage: (r) => ({ ...r, lineage: r.lineage.slice(1) }),
  policy: (r) => ({ ...r, policy: other('policy') }),
  'module.moduleDigest': (r) => ({ ...r, module: { ...r.module, moduleDigest: other('module') } }),
  implementation: (r) => ({ ...r, implementation: other('implementation') }),
  'adapter.adapterDigest': (r) => ({ ...r, adapter: { ...r.adapter, adapterDigest: other('adapter') } }),
  ledgerVersion: (r) => ({ ...r, ledgerVersion: 59n }),
});

const BINDING = sampleBindingInput(digestOf('sample:state'));

suite(validateExecutionAuthorization, executionAuthorizationId)('ExecutionAuthorization', sampleAuthorizationInput(ACTION, [BINDING]), {
  'reservation.generation': (a) => ({ ...a, reservation: { ...a.reservation, generation: 2n } }),
  'reservation.module': (a) => ({ ...a, reservation: { ...a.reservation, module: { ...a.reservation.module, moduleDigest: other('module') } } }),
  'reservation.ledgerVersion': (a) => ({ ...a, reservation: { ...a.reservation, ledgerVersion: 59n } }),
  'stateBindings.stateDigest': (a) => ({ ...a, stateBindings: [{ ...BINDING, stateDigest: other('state') }] }),
  'stateBindings.freshness': (a) => ({ ...a, stateBindings: [{ ...BINDING, requirement: { ...BINDING.requirement, freshness: { kind: 'AGE', maxAgeSeconds: 6n } } }] }),
  'stateBindings.none': (a) => ({ ...a, stateBindings: [] }),
  attemptCeiling: (a) => ({ ...a, attemptCeiling: BigInt(a.attemptCeiling) - 1n }),
});

suite(validateExecutionBindingRef, executionBindingId)(
  'ExecutionBindingRef',
  sampleExecutionBindingInput(digestOf('sample:authorization'), ACTION, [digestOf('sample:binding')]),
  {
    authorization: (b) => ({ ...b, authorization: other('authorization') }),
    action: (b) => ({ ...b, action: other('action') }),
    generation: (b) => ({ ...b, generation: 2n }),
    'module.moduleDigest': (b) => ({ ...b, module: { ...b.module, moduleDigest: other('module') } }),
    'module.moduleVersion': (b) => ({ ...b, module: { ...b.module, moduleVersion: 2 } }),
    'adapter.adapterDigest': (b) => ({ ...b, adapter: { ...b.adapter, adapterDigest: other('adapter') } }),
    'stateBindings.replace': (b) => ({ ...b, stateBindings: [other('binding')] }),
    'stateBindings.add': (b) => ({ ...b, stateBindings: [...b.stateBindings, other('binding')] }),
    parameters: (b) => ({ ...b, parameters: other('parameters') }),
  },
);
