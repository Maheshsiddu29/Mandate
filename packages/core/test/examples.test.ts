/**
 * The Phase 7A worked examples (docs/core-v1/examples.md), represented in Core
 * types.
 *
 * Nothing here executes an example: there is no ledger, no availability check
 * and no reconciliation in 7B. What these tests establish is that every
 * object each example needs — grants, policies, dimensions, quantities,
 * actions, snapshots, bindings, reservations and execution references — can be
 * constructed through the validators with its full meaning, with no untyped
 * escape hatch, and that the distinctions each example turns on are visible in
 * the types and digests. Where an example needs something 7B does not
 * represent, the test says so explicitly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  actionId,
  actionPayloadDigest,
  addQuantities,
  authorityId,
  bindState,
  bytesToHex,
  checkBindingMatchesAuthorization,
  compareQuantities,
  encodeWith,
  executionAuthorizationId,
  formatFixedDecimal,
  grantIdentity,
  moduleRefsEqual,
  partyIdsEqual,
  parseFixedDecimal,
  policyDimensions,
  policyInvariants,
  principalAsAgent,
  principalPolicyId,
  quantityMismatches,
  reservationIdOf,
  reservationRefDigest,
  resourceIdsEqual,
  stateBindingId,
  stateBindingIdsOf,
  stateBindingInputOf,
  stateId,
  subtractQuantities,
  validateActionEnvelope,
  validateAuthorityGrant,
  validateExecutionAuthorization,
  validateExecutionBindingRef,
  validateModuleRef,
  validatePrincipalPolicy,
  validateQuantity,
  validateQuantityBound,
  validateQuantityOf,
  validateRatio,
  validateReservationRef,
  validateStateEnvelope,
  writeQuantityBound,
  writeRatio,
  type ActionEnvelope,
  type ActionEnvelopeInput,
  type AuthorityGrant,
  type AuthorityGrantInput,
  type AuthorityTermInput,
  type EconomicQuantity,
  type EconomicQuantityInput,
  type LedgerDimensionTerm,
  type PartyIdInput,
  type PrincipalPolicyInput,
  type QuantityBoundInput,
  type ReservationRefInput,
  type ResourceIdInput,
  type StateEnvelopeInput,
} from '../src/index.ts';
import {
  ACCOUNT_REQUIREMENT,
  BTC,
  BTC_PERP_L,
  BTC_PERP_M,
  ETH_PERP_L,
  EVM_ACCOUNT,
  EVM_GATE,
  EVM_SPOT_IMPL,
  EVM_SPOT_V1,
  EXTERNAL_X,
  FAAPL,
  FAAPL_MARKET,
  L_SUB,
  MARK_REQUIREMENT,
  PERP_AGENT,
  PERP_V1,
  PERP_V1_IMPL,
  PERP_V2,
  PERP_V2_IMPL,
  PRINCIPAL,
  SOL_PERP_L,
  SPOT_AGENT,
  TRADING_AGENT,
  USDG,
  USDG_ON_L,
  VENUE_SIGNER_L,
  VENUE_SIGNER_M,
  digestOf,
  dimension,
  must,
  unvalued,
} from './support/fixtures.ts';

// --- Helpers ---------------------------------------------------------------------

const OCT_1 = 1_790_812_800n;
const DEC_1 = 1_796_083_200n;
const DEC_15 = 1_797_292_800n;
const JAN_1 = 1_798_761_600n;
const JAN_31 = 1_801_353_600n;

function amount(text: string, decimals: number): bigint {
  return must(parseFixedDecimal(text, decimals, 'amount'));
}

function usdg(text: string, asset: ResourceIdInput = USDG): EconomicQuantityInput {
  return unvalued('CAPITAL', 'USDG', 6, amount(text, 6), asset);
}

function quantity<K extends EconomicQuantity['kind']>(kind: K, input: EconomicQuantityInput): EconomicQuantity<K> {
  return must(validateQuantityOf(kind, input));
}

function price(text: string): { numeratorUnit: string; denominatorUnit: string; decimals: number; atoms: bigint } {
  return { numeratorUnit: 'USD', denominatorUnit: 'BTC', decimals: 2, atoms: amount(text, 2) };
}

/** Committed notional, in USD at 2 decimals, of canonical BTC, valued at an order's limit or a fill's price. */
function notional(text: string, at: string, source: { kind: 'ACTION'; actionId: string } | { kind: 'OBSERVATION'; observationId: string }, observedAt: bigint): EconomicQuantity<'NOTIONAL'> {
  return quantity('NOTIONAL', {
    kind: 'NOTIONAL',
    unit: 'USD',
    decimals: 2,
    atoms: amount(text, 2),
    asset: BTC,
    valuation: { price: price(at), basis: source.kind === 'ACTION' ? 'LIMIT' : 'EXECUTION', source, observedAt },
  });
}

function btc(text: string): EconomicQuantity<'POSITION_SIZE'> {
  return quantity('POSITION_SIZE', unvalued('POSITION_SIZE', 'BTC', 8, amount(text, 8), BTC));
}

/** Module-owned invariant parameters, canonically encoded with Core's own writers. Core carries them opaquely. */
function ratioParams(numerator: bigint, scale = 0): string {
  return bytesToHex(encodeWith(writeRatio, must(validateRatio({ numerator, scale }, 'params'))));
}

function boundParams(bound: QuantityBoundInput): string {
  return bytesToHex(encodeWith(writeQuantityBound, must(validateQuantityBound(bound, 'params'))));
}

const usd = (text: string): QuantityBoundInput => ({ kind: 'NOTIONAL', unit: 'USD', decimals: 2, atoms: amount(text, 2) });

function grant(input: Partial<AuthorityGrantInput> & { holder: PartyIdInput; terms: AuthorityTermInput[] }): AuthorityGrant {
  return must(
    validateAuthorityGrant({
      lineage: { kind: 'ROOT', issuer: PRINCIPAL },
      principal: PRINCIPAL,
      notBefore: OCT_1,
      expiresAt: JAN_1,
      nonce: 1n,
      ...input,
    }),
  );
}

function delegation(parent: AuthorityGrant, holder: PartyIdInput, terms: AuthorityTermInput[], expiresAt: bigint): AuthorityGrant {
  return grant({ lineage: { kind: 'DELEGATION', parent: authorityId(parent), issuer: { kind: parent.holder.kind, value: parent.holder.value } }, holder, terms, expiresAt });
}

function action(input: Partial<ActionEnvelopeInput> & { authority: string; actor: PartyIdInput; target: ResourceIdInput }): ActionEnvelope {
  return must(
    validateActionEnvelope({
      principal: PRINCIPAL,
      module: PERP_V1,
      actionType: 'perp.order',
      adapter: VENUE_SIGNER_L,
      resources: [],
      payloadDigest: digestOf(`payload:${input.target.localId}`),
      validFrom: OCT_1 + 1_000n,
      expiresAt: OCT_1 + 1_300n,
      nonce: 1n,
      ...input,
    }),
  );
}

function reservation(actionDigest: string, lineage: string[], policy: string, overrides: Partial<ReservationRefInput> = {}): ReservationRefInput {
  return {
    action: actionDigest,
    generation: 1n,
    principal: PRINCIPAL,
    lineage,
    policy,
    module: PERP_V1,
    implementation: PERP_V1_IMPL,
    adapter: VENUE_SIGNER_L,
    ledgerVersion: 1n,
    ...overrides,
  };
}

const EMPTY_POLICY = must(validatePrincipalPolicy({ principal: PRINCIPAL, sequence: 1n, terms: [], nonce: 1n }));
const EMPTY_POLICY_ID = principalPolicyId(EMPTY_POLICY);

// --- A ---------------------------------------------------------------------------

describe('A — cross-domain capital', () => {
  const root = grant({
    holder: TRADING_AGENT,
    terms: [
      dimension('capital', 'CAPITAL', 'USDG', 6, amount('1200.000000', 6)),
      dimension('perp-margin', 'MARGIN', 'USDG', 6, amount('1000.000000', 6), { domain: 'perp', asset: USDG_ON_L, account: L_SUB }),
      dimension('btc-notional', 'NOTIONAL', 'USD', 2, amount('5000.00', 2), { asset: BTC }),
      { kind: 'BOUND', boundId: 'perp.orderLeverage', polarity: 'MAX', value: { type: 'RATIO', ratio: { numerator: 5n, scale: 0 } } },
    ],
  });
  const dims = root.terms.filter((t): t is LedgerDimensionTerm => t.kind === 'LEDGER_DIMENSION');
  const order = action({ authority: authorityId(root), actor: TRADING_AGENT, target: BTC_PERP_L, resources: [L_SUB, USDG_ON_L] });
  const spotCapital = quantity('CAPITAL', usdg('800.000000'));
  const perpCapital = quantity('CAPITAL', usdg('600.000000'));
  const perpMargin = quantity('MARGIN', unvalued('MARGIN', 'USDG', 6, amount('600.000000', 6), USDG_ON_L));
  const perpNotional = notional('3000.00', '100000.00', { kind: 'ACTION', actionId: actionId(order) }, OCT_1 + 1_000n);

  it('three dimensions of three different measures, each with exactly one kind and unit', () => {
    assert.deepEqual(
      dims.map((d) => [d.dimensionId, d.limit.kind, d.limit.unit]),
      [
        ['capital', 'CAPITAL', 'USDG'],
        ['perp-margin', 'MARGIN', 'USDG'],
        ['btc-notional', 'NOTIONAL', 'USD'],
      ],
    );
  });

  it('spot and perp capital are the same measure and add exactly: 800 + 600 = 1,400 against a 1,200 limit', () => {
    const projected = must(addQuantities(spotCapital, perpCapital));
    assert.equal(formatFixedDecimal(projected.atoms, projected.decimals), '1400.000000');
    const capitalDimension = dims.find((d) => d.dimensionId === 'capital');
    assert.ok(capitalDimension !== undefined);
    assert.equal(projected.kind, capitalDimension.limit.kind);
    assert.equal(projected.unit, capitalDimension.limit.unit);
    assert.ok(projected.atoms > capitalDimension.limit.atoms, 'the ledger (7C) refuses this; 7B only represents it');
  });

  it('perp margin is not capital, and perp notional is not margin: the category error is unrepresentable', () => {
    assert.ok(quantityMismatches(perpCapital, perpMargin).includes('KIND'));
    assert.equal((addQuantities(perpCapital as EconomicQuantity, perpMargin as EconomicQuantity) as { ok: false; error: { code: string } }).error.code, 'QUANTITY_KIND_MISMATCH');
    assert.deepEqual(quantityMismatches(perpNotional, perpMargin).slice(0, 2), ['KIND', 'UNIT']);
  });

  it('leverage moves margin and not notional: the same notional at 5x, 2x and 10x', () => {
    const margins = ['400.000000', '1000.000000', '200.000000'].map((m) => quantity('MARGIN', unvalued('MARGIN', 'USDG', 6, amount(m, 6), USDG_ON_L)));
    const notionals = [0, 1, 2].map(() => notional('2000.00', '100000.00', { kind: 'ACTION', actionId: actionId(order) }, OCT_1 + 1_000n));
    assert.equal(must(compareQuantities(notionals[0] as EconomicQuantity<'NOTIONAL'>, notionals[1] as EconomicQuantity<'NOTIONAL'>)), 0);
    assert.equal(must(compareQuantities(margins[0] as EconomicQuantity<'MARGIN'>, margins[1] as EconomicQuantity<'MARGIN'>)), -1);
  });

  it('a USD capital limit and USDG capital are incomparable without a declared settlement assumption (UNIT-3)', () => {
    const usdCapital = quantity('CAPITAL', unvalued('CAPITAL', 'USD', 2, 120_000n, { domain: 'registry', kind: 'CANONICAL_ASSET', localId: 'fiat:usd' }));
    assert.ok(quantityMismatches(usdCapital, perpCapital).includes('UNIT'));
  });
});

// --- B ---------------------------------------------------------------------------

describe('B — cross-venue pending exposure', () => {
  const root = grant({ holder: PERP_AGENT, terms: [dimension('btc-notional', 'NOTIONAL', 'USD', 2, amount('5000.00', 2), { asset: BTC })] });
  const o1 = action({ authority: authorityId(root), actor: PERP_AGENT, target: BTC_PERP_L, resources: [L_SUB] });
  const o2 = action({ authority: authorityId(root), actor: PERP_AGENT, target: BTC_PERP_M, adapter: VENUE_SIGNER_M, resources: [] });

  it('the two venues are two markets, and both orders are exposure to one canonical asset', () => {
    assert.ok(!resourceIdsEqual(o1.target, o2.target));
    const w1 = notional('4000.00', '100000.00', { kind: 'ACTION', actionId: actionId(o1) }, OCT_1 + 1_000n);
    const w2 = notional('3000.00', '100000.00', { kind: 'ACTION', actionId: actionId(o2) }, OCT_1 + 1_003n);
    // Same kind, unit and exposure asset: both match the BTC-scoped dimension. They differ only in valuation.
    assert.deepEqual(quantityMismatches(w1, w2), ['VALUATION']);
    const dim = root.terms[0] as LedgerDimensionTerm;
    assert.ok(dim.scope.asset !== null && resourceIdsEqual(dim.scope.asset, w1.asset as NonNullable<typeof w1.asset>));
  });

  it('a partial fill and a price-improved fill are valued at their execution prices, from observations', () => {
    const f1 = notional('1500.00', '100000.00', { kind: 'OBSERVATION', observationId: digestOf('L:fill:f1') }, OCT_1 + 1_001n);
    const settled = notional('2997.00', '99900.00', { kind: 'OBSERVATION', observationId: digestOf('M:fill:o2') }, OCT_1 + 1_006n);
    assert.equal(f1.valuation?.basis, 'EXECUTION');
    assert.equal(formatFixedDecimal(settled.atoms, 2), '2997.00');
  });

  it('the rejected O2 reserved nothing: resubmitting the same signed intent is the same ActionId, reserved at generation 1', () => {
    const resubmitted = action({ authority: authorityId(root), actor: PERP_AGENT, target: BTC_PERP_M, adapter: VENUE_SIGNER_M, resources: [] });
    assert.equal(actionId(resubmitted), actionId(o2));
    const r = must(validateReservationRef(reservation(actionId(o2), [authorityId(root)], EMPTY_POLICY_ID, { adapter: VENUE_SIGNER_M })));
    assert.equal(r.generation, 1n);
  });

  it('SCOPE-1: a notional with no resolved exposure asset cannot be represented', () => {
    const r = validateQuantity({ ...unvalued('NOTIONAL', 'USD', 2, 300_000n, null), valuation: { price: price('100000.00'), basis: 'LIMIT', source: { kind: 'ACTION', actionId: actionId(o2) }, observedAt: 1n } });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'ASSET_REQUIRED');
  });
});

// --- C ---------------------------------------------------------------------------

describe('C — two agents sharing one parent\'s authority', () => {
  const root = grant({ holder: TRADING_AGENT, terms: [dimension('capital', 'CAPITAL', 'USDG', 6, amount('1200.000000', 6)), { kind: 'RIGHT', right: 'DELEGATE', maxDepth: 1 }] });
  const s1 = delegation(root, SPOT_AGENT, [dimension('capital', 'CAPITAL', 'USDG', 6, amount('1000.000000', 6))], JAN_1);
  const q1 = delegation(root, PERP_AGENT, [dimension('capital', 'CAPITAL', 'USDG', 6, amount('1000.000000', 6))], JAN_1);

  it('sibling ceilings may sum past the parent\'s: ceilings, not partitions', () => {
    const sum = (d: AuthorityGrant): bigint => (d.terms.find((t) => t.kind === 'LEDGER_DIMENSION') as LedgerDimensionTerm).limit.atoms;
    assert.ok(sum(s1) + sum(q1) > sum(root));
    assert.equal(grantIdentity(s1).kind, 'DELEGATION');
    assert.notEqual(authorityId(s1), authorityId(q1));
  });

  it('both decisions read version 41; each reservation names its own lineage and records the version it committed at', () => {
    const spot = action({ authority: authorityId(s1), actor: SPOT_AGENT, module: EVM_SPOT_V1, adapter: EVM_GATE, actionType: 'evm-spot.buy', target: FAAPL_MARKET, resources: [FAAPL, USDG] });
    const perp = action({ authority: authorityId(q1), actor: PERP_AGENT, target: BTC_PERP_L });
    const spotReservation = must(
      validateReservationRef(reservation(actionId(spot), [authorityId(s1), authorityId(root)], EMPTY_POLICY_ID, { module: EVM_SPOT_V1, implementation: EVM_SPOT_IMPL, adapter: EVM_GATE, ledgerVersion: 42n })),
    );
    const perpLineage = [authorityId(q1), authorityId(root)];
    assert.equal(spotReservation.lineage[1], perpLineage[1], 'both paths charge the shared parent');
    assert.notEqual(actionId(spot), actionId(perp));
  });
});

// --- D ---------------------------------------------------------------------------

describe('D — hierarchical delegation', () => {
  const statePolicy = (maxAge: bigint): AuthorityTermInput => ({
    kind: 'STATE_POLICY',
    domain: 'perp',
    stateKind: 'perp.markPrice',
    admittedSources: ['venue-l-api'],
    requirement: { ...MARK_REQUIREMENT, freshness: { kind: 'AGE', maxAgeSeconds: maxAge } },
  });
  const leverageBound = (x: bigint): AuthorityTermInput => ({ kind: 'BOUND', boundId: 'perp.orderLeverage', polarity: 'MAX', value: { type: 'RATIO', ratio: { numerator: x, scale: 0 } } });
  const accountLeverage = (x: bigint): AuthorityTermInput => ({ kind: 'STATE_INVARIANT', invariantId: 'perp.accountLeverage', version: 1, scope: [L_SUB], params: ratioParams(x) });
  const markedExposure: AuthorityTermInput = { kind: 'STATE_INVARIANT', invariantId: 'core.markedExposure', version: 1, scope: [BTC], params: boundParams(usd('20000.00')) };
  const capital = (text: string): AuthorityTermInput => dimension('capital', 'CAPITAL', 'USDG', 6, amount(text, 6));

  const r0 = grant({
    holder: PRINCIPAL,
    terms: [
      { kind: 'SET', vocabulary: 'MODULES', members: [PERP_V1, EVM_SPOT_V1] },
      { kind: 'SET', vocabulary: 'ADAPTERS', members: [VENUE_SIGNER_L, EVM_GATE] },
      { kind: 'SET', vocabulary: 'MARKETS', members: [BTC_PERP_L, ETH_PERP_L, FAAPL_MARKET] },
      { kind: 'SET', vocabulary: 'RECIPIENTS', members: [EVM_ACCOUNT, L_SUB] },
      { kind: 'RIGHT', right: 'OPEN_RISK' },
      { kind: 'RIGHT', right: 'REDUCE_RISK' },
      { kind: 'RIGHT', right: 'DELEGATE', maxDepth: 2 },
      leverageBound(5n),
      accountLeverage(4n),
      statePolicy(10n),
      capital('10000.000000'),
    ],
  });
  const d1 = delegation(
    r0,
    TRADING_AGENT,
    [
      { kind: 'SET', vocabulary: 'MODULES', members: [PERP_V1, EVM_SPOT_V1] },
      { kind: 'SET', vocabulary: 'ADAPTERS', members: [VENUE_SIGNER_L, EVM_GATE] },
      { kind: 'SET', vocabulary: 'MARKETS', members: [BTC_PERP_L, ETH_PERP_L, FAAPL_MARKET] },
      { kind: 'SET', vocabulary: 'RECIPIENTS', members: [EVM_ACCOUNT, L_SUB] },
      { kind: 'RIGHT', right: 'OPEN_RISK' },
      { kind: 'RIGHT', right: 'REDUCE_RISK' },
      { kind: 'RIGHT', right: 'DELEGATE', maxDepth: 1 },
      leverageBound(5n),
      accountLeverage(4n),
      markedExposure,
      statePolicy(10n),
      capital('6000.000000'),
    ],
    DEC_15,
  );

  it('the root is held by the institution itself: as holder it is in the agent role, reached by the explicit conversion', () => {
    assert.ok(partyIdsEqual(r0.holder, principalAsAgent(r0.principal)));
    assert.equal(grantIdentity(r0).kind, 'ROOT');
  });

  it('D1 restates every bound, invariant and state policy of R0 and adds one: all representable', () => {
    const kinds = (g: AuthorityGrant): string[] => g.terms.map((t) => t.kind);
    assert.equal(kinds(d1).filter((k) => k === 'STATE_INVARIANT').length, 2);
    assert.equal(grantIdentity(d1).kind, 'DELEGATION');
  });

  it('D2 (bad) is a well-formed object: widening is refused by the authority engine (7C), which needs exactly these fields', () => {
    const bad = delegation(
      d1,
      PERP_AGENT,
      [
        { kind: 'SET', vocabulary: 'MARKETS', members: [BTC_PERP_L, SOL_PERP_L] },
        { kind: 'SET', vocabulary: 'RECIPIENTS', members: [L_SUB, EXTERNAL_X] },
        { kind: 'RIGHT', right: 'TRANSFER_OUT' },
        { kind: 'RIGHT', right: 'DELEGATE', maxDepth: 1 },
        leverageBound(10n),
        accountLeverage(6n),
        capital('8000.000000'),
      ],
      JAN_31,
    );
    // Every attempted widening is present, typed, and inside the grant's digest.
    assert.equal(bad.expiresAt, JAN_31);
    assert.ok(bad.terms.some((t) => t.kind === 'RIGHT' && t.right === 'TRANSFER_OUT'));
    assert.ok(!bad.terms.some((t) => t.kind === 'STATE_INVARIANT' && t.invariantId === 'core.markedExposure'), 'the dropped invariant is visibly absent');
  });

  it('D2 (good) narrows everything; its depth is 0 because it carries no DELEGATE right', () => {
    const good = delegation(
      d1,
      PERP_AGENT,
      [
        { kind: 'SET', vocabulary: 'MODULES', members: [PERP_V1] },
        { kind: 'SET', vocabulary: 'ADAPTERS', members: [VENUE_SIGNER_L] },
        { kind: 'SET', vocabulary: 'MARKETS', members: [BTC_PERP_L] },
        { kind: 'SET', vocabulary: 'RECIPIENTS', members: [L_SUB] },
        { kind: 'RIGHT', right: 'OPEN_RISK' },
        { kind: 'RIGHT', right: 'REDUCE_RISK' },
        leverageBound(3n),
        accountLeverage(3n),
        markedExposure,
        statePolicy(5n),
        capital('4000.000000'),
      ],
      DEC_1,
    );
    assert.ok(!good.terms.some((t) => t.kind === 'RIGHT' && t.right === 'DELEGATE'));
    // An ETH-PERP proposal under P is representable; coverage (the meet) refuses it in 7C.
    const eth = action({ authority: authorityId(good), actor: PERP_AGENT, target: ETH_PERP_L });
    assert.equal(eth.authority, authorityId(good));
  });
});

// --- E ---------------------------------------------------------------------------

describe('E — retry at a new generation, and a stale observation', () => {
  const root = grant({ holder: SPOT_AGENT, terms: [] });
  const i1 = action({ authority: authorityId(root), actor: SPOT_AGENT, module: EVM_SPOT_V1, adapter: EVM_GATE, actionType: 'evm-spot.buy', target: FAAPL_MARKET });

  it('generations 1 and 2 of one intent are two reservations, two authorizations, two bindings', () => {
    const base = reservation(actionId(i1), [authorityId(root)], EMPTY_POLICY_ID, { module: EVM_SPOT_V1, implementation: EVM_SPOT_IMPL, adapter: EVM_GATE });
    const g1 = must(validateExecutionAuthorization({ reservation: base, stateBindings: [], attemptCeiling: OCT_1 + 1_100n }));
    const g2 = must(validateExecutionAuthorization({ reservation: { ...base, generation: 2n, ledgerVersion: 3n }, stateBindings: [], attemptCeiling: OCT_1 + 1_250n }));
    assert.notEqual(reservationIdOf(g1.reservation), reservationIdOf(g2.reservation));
    // A binding (or observation) naming generation 1 cannot be attributed to generation 2.
    const staleBinding = must(
      validateExecutionBindingRef({ authorization: executionAuthorizationId(g1), action: actionId(i1), generation: 1n, module: EVM_SPOT_V1, adapter: EVM_GATE, stateBindings: [], parameters: digestOf('M_1') }),
    );
    const check = checkBindingMatchesAuthorization(staleBinding, g2);
    assert.ok(!check.ok);
    assert.equal(check.error.code, 'EXECUTION_BINDING_INCONSISTENT');
  });
});

// --- F ---------------------------------------------------------------------------

describe('F — external state changes after the ledger CAS', () => {
  const policy = must(
    validatePrincipalPolicy({
      principal: PRINCIPAL,
      sequence: 1n,
      terms: [{ kind: 'STATE_INVARIANT', invariantId: 'core.markedExposure', version: 1, scope: [BTC], params: boundParams(usd('20000.00')) }],
      nonce: 1n,
    }),
  );
  const root = grant({ holder: PERP_AGENT, terms: [] });
  const order = action({ authority: authorityId(root), actor: PERP_AGENT, target: BTC_PERP_L, resources: [L_SUB] });

  const snapshot = (kind: 'perp.markPrice' | 'perp.account', subject: ResourceIdInput, observedAt: bigint, sequence: bigint, payload: string): StateEnvelopeInput => ({
    domain: 'perp',
    stateKind: kind,
    subject,
    sourceId: 'venue-l-api',
    trustClass: 'VERIFIED',
    observedAt,
    sequence: { kind: 'VENUE_SEQUENCE', value: sequence },
    validUntil: null,
    finality: { ladder: kind === 'perp.markPrice' ? 'venue-l.market-data' : 'venue-l.account', level: kind === 'perp.markPrice' ? 'PUBLISHED' : 'ACKNOWLEDGED' },
    payloadDigest: digestOf(payload),
  });

  const account = must(validateStateEnvelope(snapshot('perp.account', L_SUB, 1_000n, 1_040n, 'account:0.15BTC')));
  const mark0 = must(validateStateEnvelope(snapshot('perp.markPrice', BTC_PERP_L, 1_000n, 7_001n, 'mark:100000.00')));
  const mark1 = must(validateStateEnvelope(snapshot('perp.markPrice', BTC_PERP_L, 1_004n, 7_009n, 'mark:106000.00')));
  const accountBinding = must(bindState(account, ACCOUNT_REQUIREMENT));
  const markBinding = must(bindState(mark0, MARK_REQUIREMENT));

  it('the decision binds each snapshot with its own requirement: RECHECK for the mark, WITHIN_POLICY for the account', () => {
    assert.equal(markBinding.requirement.atIssue, 'RECHECK');
    assert.deepEqual(markBinding.requirement.atExecution, { kind: 'ENFORCED_BY_ARTIFACT', field: 'limitPrice' });
    assert.equal(accountBinding.requirement.freshness.kind, 'SEQUENCE');
    assert.equal(policyInvariants(policy).length, 1);
  });

  it('the authorization at v58 commits to the T0 bindings; the revalidated mark is a different snapshot and binding', () => {
    const authorization = must(
      validateExecutionAuthorization({
        reservation: reservation(actionId(order), [authorityId(root)], principalPolicyId(policy), { ledgerVersion: 58n }),
        stateBindings: [stateBindingInputOf(accountBinding), stateBindingInputOf(markBinding)],
        attemptCeiling: 1_030n,
      }),
    );
    const fresh = must(bindState(mark1, MARK_REQUIREMENT));
    assert.notEqual(stateId(mark1), stateId(mark0));
    assert.notEqual(stateBindingId(fresh), stateBindingId(markBinding));
    // Had revalidation passed at 104,000.00, the attempt would carry the replaced mark binding; it still names this authorization.
    const revalidated = must(
      validateExecutionBindingRef({
        authorization: executionAuthorizationId(authorization),
        action: actionId(order),
        generation: 1n,
        module: PERP_V1,
        adapter: VENUE_SIGNER_L,
        stateBindings: [stateBindingId(accountBinding), stateBindingId(fresh)],
        parameters: digestOf('order:limit:101000.00'),
      }),
    );
    assert.ok(checkBindingMatchesAuthorization(revalidated, authorization).ok);
    assert.notDeepEqual([...revalidated.stateBindings].sort(), [...stateBindingIdsOf(authorization)].sort());
  });
});

// --- G ---------------------------------------------------------------------------

describe('G — multiple roots, one principal-global limit', () => {
  const policyInput: PrincipalPolicyInput = {
    principal: PRINCIPAL,
    sequence: 1n,
    terms: [dimension('btc-notional-global', 'NOTIONAL', 'USD', 2, amount('10000.00', 2), { asset: BTC })],
    nonce: 1n,
  };
  const policy = must(validatePrincipalPolicy(policyInput));
  const rootA = grant({ holder: SPOT_AGENT, terms: [dimension('btc-notional', 'NOTIONAL', 'USD', 2, amount('7000.00', 2), { asset: BTC })], nonce: 1n });
  const rootB = grant({ holder: PERP_AGENT, terms: [dimension('btc-notional', 'NOTIONAL', 'USD', 2, amount('5000.00', 2), { asset: BTC })], nonce: 2n });

  it('two independent roots and one policy that grants nothing and is the last node of every path', () => {
    assert.notEqual(authorityId(rootA), authorityId(rootB));
    assert.equal(policyDimensions(policy)[0]?.dimensionId, 'btc-notional-global');
    const perpOrder = action({ authority: authorityId(rootB), actor: PERP_AGENT, target: BTC_PERP_L });
    const r = must(validateReservationRef(reservation(actionId(perpOrder), [authorityId(rootB)], principalPolicyId(policy))));
    assert.equal(r.policy, principalPolicyId(policy));
  });

  it('an empty policy is an explicit, distinct statement; no policy at all is not a policy', () => {
    assert.notEqual(principalPolicyId(policy), EMPTY_POLICY_ID);
    assert.equal(validatePrincipalPolicy({ ...policyInput, terms: undefined } as never).ok, false);
  });
});

// --- H ---------------------------------------------------------------------------

describe('H — profit does not mint authority', () => {
  const root = grant({
    holder: SPOT_AGENT,
    terms: [
      dimension('capital', 'CAPITAL', 'USDG', 6, amount('10000.000000', 6)),
      dimension('realized-loss', 'PNL', 'USDG', 6, amount('500.000000', 6), {}, 'NONE'),
      dimension('position', 'POSITION_SIZE', 'BTC', 8, amount('1.00000000', 8), {}, 'UNITS'),
      dimension('actions', 'COUNT', 'COUNT', 0, 50n, {}, 'NONE'),
      dimension('daily-spend', 'CAPITAL', 'USDG', 6, amount('2000.000000', 6), { domain: 'evm-spot' }, 'EPOCH'),
    ],
  });

  it('every restoration mode is representable, paired with its accounting family', () => {
    const modes = root.terms.filter((t): t is LedgerDimensionTerm => t.kind === 'LEDGER_DIMENSION').map((d) => [d.dimensionId, d.accounting, d.restoration]);
    assert.deepEqual(modes, [
      ['actions', 'BUDGET', 'NONE'],
      ['capital', 'CAPACITY', 'AS_CHARGED'],
      ['position', 'CAPACITY', 'UNITS'],
      ['daily-spend', 'BUDGET', 'EPOCH'],
      ['realized-loss', 'BUDGET', 'NONE'],
    ]);
  });

  it('cost basis, proceeds and profit are three different quantities; profit cannot be added to capital', () => {
    const costBasis = quantity('CAPITAL', usdg('4000.000000'));
    const proceeds = quantity('TOKEN_AMOUNT', unvalued('TOKEN_AMOUNT', 'USDG', 6, amount('5200.000000', 6), USDG));
    const profit = quantity('PNL', unvalued('PNL', 'USDG', 6, amount('1200.000000', 6), null));
    assert.ok(quantityMismatches(costBasis, profit).includes('KIND'));
    assert.ok(quantityMismatches(costBasis, proceeds).includes('KIND'));
    const r = addQuantities(costBasis as EconomicQuantity, profit as EconomicQuantity);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'QUANTITY_KIND_MISMATCH');
  });

  it('GRANTED is the signed limit: nothing in Core writes it, and a larger limit is a different grant', () => {
    const capital = root.terms.find((t): t is LedgerDimensionTerm => t.kind === 'LEDGER_DIMENSION' && t.dimensionId === 'capital');
    assert.equal(capital?.limit.atoms, amount('10000.000000', 6));
    const bigger = grant({ holder: SPOT_AGENT, terms: [dimension('capital', 'CAPITAL', 'USDG', 6, amount('11200.000000', 6))] });
    assert.notEqual(authorityId(bigger), authorityId(root));
  });
});

// --- I ---------------------------------------------------------------------------

describe('I — domain-module version binding', () => {
  const v1 = must(validateModuleRef(PERP_V1));
  const v2 = must(validateModuleRef(PERP_V2));
  const patchedV2 = must(validateModuleRef({ ...PERP_V2, moduleDigest: digestOf('manifest:perp-policy:2:patched') }));
  const root = grant({ holder: PERP_AGENT, terms: [{ kind: 'SET', vocabulary: 'MODULES', members: [PERP_V1] }] });

  it('the same order under v1 and v2 is two actions, with two payload digests', () => {
    const payload = new TextEncoder().encode('buy 0.04 BTC-PERP @ 100000.00');
    const underV1 = action({ authority: authorityId(root), actor: PERP_AGENT, target: BTC_PERP_L, module: PERP_V1, payloadDigest: must(actionPayloadDigest(v1, payload)) });
    const underV2 = action({ authority: authorityId(root), actor: PERP_AGENT, target: BTC_PERP_L, module: PERP_V2, payloadDigest: must(actionPayloadDigest(v2, payload)) });
    assert.notEqual(actionId(underV1), actionId(underV2));
    assert.notEqual(underV1.payloadDigest, underV2.payloadDigest);
  });

  it('a grant allowing only v1 names v1 exactly; neither v2 nor a patched v2 is a member', () => {
    const set = root.terms[0];
    assert.ok(set?.kind === 'SET' && set.vocabulary === 'MODULES');
    assert.ok(set.members.some((m) => moduleRefsEqual(m, v1)));
    assert.ok(!set.members.some((m) => moduleRefsEqual(m, v2)));
    assert.ok(!moduleRefsEqual(v2, patchedV2));
  });

  it('the reservation fixes module and implementation: a patched implementation is a different reservation identity', () => {
    const base = reservation(digestOf('action:I'), [authorityId(root)], EMPTY_POLICY_ID, { module: PERP_V2, implementation: PERP_V2_IMPL });
    const patched = { ...base, implementation: digestOf('implementation:perp-policy:2:patched') };
    assert.notEqual(reservationRefDigest(must(validateReservationRef(base))), reservationRefDigest(must(validateReservationRef(patched))));
  });

  it('the two modules\' contributions for one order are ordinary typed quantities: 4,000.00 under v1, 3,000.00 under v2', () => {
    const a = digestOf('action:I');
    const c1 = notional('4000.00', '100000.00', { kind: 'ACTION', actionId: a }, 1n);
    const c2 = notional('3000.00', '100000.00', { kind: 'ACTION', actionId: a }, 1n);
    assert.equal(must(compareQuantities(c2, c1)), -1);
  });
});

// --- J ---------------------------------------------------------------------------

describe('J — drift', () => {
  const snapshot = must(
    validateStateEnvelope({
      domain: 'perp',
      stateKind: 'perp.account',
      subject: L_SUB,
      sourceId: 'venue-l-api',
      trustClass: 'VERIFIED',
      observedAt: 2_000n,
      sequence: { kind: 'VENUE_SEQUENCE', value: 2_210n },
      validUntil: null,
      finality: { ladder: 'venue-l.account', level: 'ACKNOWLEDGED' },
      payloadDigest: digestOf('account:0.06BTC'),
    }),
  );

  it('adverse drift: the evidence and the native discrepancy are representable exactly', () => {
    const binding = must(bindState(snapshot, ACCOUNT_REQUIREMENT));
    assert.equal(binding.sequence.kind === 'VENUE_SEQUENCE' ? binding.sequence.value : 0n, 2_210n);
    const diff = must(subtractQuantities(btc('0.06000000'), btc('0.05000000')));
    assert.equal(formatFixedDecimal(diff.atoms, 8), '0.01000000');
  });

  it('favorable drift: a signed discrepancy, representable without implying any restoration', () => {
    const diff = must(subtractQuantities(btc('0.03000000'), btc('0.05000000')));
    assert.equal(formatFixedDecimal(diff.atoms, 8), '-0.02000000');
  });

  it('GAP: the drift charge "+0.01 BTC valued at the admitted mark → +1,000.00" on a NOTIONAL dimension needs a MARK-valued NOTIONAL, which §3.2 does not permit', () => {
    // action-state-model.md §3.2 allows NOTIONAL only at EXECUTION or LIMIT; examples.md §J charges a NOTIONAL
    // dimension with an amount valued at the mark. 7B does not relax the kind rule; the drift event's
    // quantity type is left to 7C with this conflict reported (implementation-7b.md, open questions).
    const r = validateQuantity({
      kind: 'NOTIONAL',
      unit: 'USD',
      decimals: 2,
      atoms: amount('1000.00', 2),
      asset: BTC,
      valuation: { price: price('100000.00'), basis: 'MARK', source: { kind: 'STATE', stateId: stateId(snapshot) }, observedAt: 2_000n },
    });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'VALUATION_BASIS_INVALID');
  });
});
