/**
 * Representative inputs for every canonical Core object, and the state
 * requirements and quantity helpers the examples use. Builds on `basics.ts`.
 */

import {
  type ActionEnvelopeInput,
  type AuthorityGrantInput,
  type AuthorityTermInput,
  type EconomicQuantityInput,
  type ExecutionAuthorizationInput,
  type ExecutionBindingRefInput,
  type LedgerDimensionInput,
  type PrincipalPolicyInput,
  type QuantityKind,
  type ReceiptHeaderInput,
  type ReceiptReferencesInput,
  type ReservationRefInput,
  type ResourceIdInput,
  type StateBindingInput,
  type StateEnvelopeInput,
  type StateRequirementInput,
} from '../../src/index.ts';
import {
  BTC,
  BTC_PERP_L,
  ETH_PERP_L,
  EVM_ACCOUNT,
  EVM_GATE,
  EVM_SPOT_V1,
  FAAPL_MARKET,
  L_SUB,
  PERP_AGENT,
  PERP_V1,
  PERP_V1_IMPL,
  PRINCIPAL,
  TRADING_AGENT,
  USDG,
  USDG_ON_L,
  VENUE_SIGNER_L,
  digestOf,
} from './basics.ts';

export * from './basics.ts';

// --- State requirements ----------------------------------------------------------

export const MARK_REQUIREMENT: StateRequirementInput = {
  freshness: { kind: 'AGE', maxAgeSeconds: 5n },
  minTrust: 'VERIFIED',
  minFinality: { ladder: 'venue-l.market-data', level: 'PUBLISHED' },
  atIssue: 'RECHECK',
  atExecution: { kind: 'ENFORCED_BY_ARTIFACT', field: 'limitPrice' },
};

export const ACCOUNT_REQUIREMENT: StateRequirementInput = {
  freshness: { kind: 'SEQUENCE' },
  minTrust: 'VERIFIED',
  minFinality: { ladder: 'venue-l.account', level: 'ACKNOWLEDGED' },
  atIssue: 'WITHIN_POLICY',
  atExecution: { kind: 'NOT_REQUIRED' },
};

// --- Quantities ------------------------------------------------------------------

export function unvalued(kind: QuantityKind, unit: string, decimals: number, atoms: bigint, asset: ResourceIdInput | null): EconomicQuantityInput {
  return { kind, unit, decimals, atoms, asset, valuation: null };
}

export function notionalAtLimit(atoms: bigint, priceAtoms: bigint, action: string, observedAt: bigint): EconomicQuantityInput {
  return {
    kind: 'NOTIONAL',
    unit: 'USD',
    decimals: 2,
    atoms,
    asset: BTC,
    valuation: {
      price: { numeratorUnit: 'USD', denominatorUnit: 'BTC', decimals: 2, atoms: priceAtoms },
      basis: 'LIMIT',
      source: { kind: 'ACTION', actionId: action },
      observedAt,
    },
  };
}

export function dimension(
  dimensionId: string,
  kind: QuantityKind,
  unit: string,
  decimals: number,
  limitAtoms: bigint,
  scope: Partial<LedgerDimensionInput['scope']> = {},
  restoration: LedgerDimensionInput['restoration'] = 'AS_CHARGED',
): LedgerDimensionInput {
  const accounting = restoration === 'NONE' || restoration === 'EPOCH' ? 'BUDGET' : 'CAPACITY';
  return {
    kind: 'LEDGER_DIMENSION',
    dimensionId,
    limit: { kind, unit, decimals, atoms: limitAtoms },
    accounting,
    restoration,
    epoch: restoration === 'EPOCH' ? { anchor: 1_790_812_800n, lengthSeconds: 86_400n } : null,
    sign: 'UNSIGNED',
    scope: { asset: null, market: null, domain: null, account: null, ...scope },
  };
}

// --- Samples: one representative input per canonical object ----------------------

export const T0 = 1_790_812_800n; // 2026-10-01T00:00:00Z
export const T_END = 1_798_761_600n; // 2027-01-01T00:00:00Z

export function sampleTerms(): AuthorityTermInput[] {
  return [
    { kind: 'SET', vocabulary: 'MODULES', members: [PERP_V1, EVM_SPOT_V1] },
    { kind: 'SET', vocabulary: 'ADAPTERS', members: [VENUE_SIGNER_L, EVM_GATE] },
    { kind: 'SET', vocabulary: 'MARKETS', members: [BTC_PERP_L, ETH_PERP_L, FAAPL_MARKET] },
    { kind: 'SET', vocabulary: 'RECIPIENTS', members: [EVM_ACCOUNT, L_SUB] },
    { kind: 'RIGHT', right: 'OPEN_RISK' },
    { kind: 'RIGHT', right: 'REDUCE_RISK' },
    { kind: 'RIGHT', right: 'DELEGATE', maxDepth: 2 },
    { kind: 'BOUND', boundId: 'perp.orderLeverage', polarity: 'MAX', value: { type: 'RATIO', ratio: { numerator: 5n, scale: 0 } } },
    {
      kind: 'STATE_INVARIANT',
      invariantId: 'perp.accountLeverage',
      version: 1,
      scope: [L_SUB],
      params: '0x0400', // module-owned canonical parameter bytes: ≤ 4x
    },
    { kind: 'STATE_POLICY', domain: 'perp', stateKind: 'perp.markPrice', admittedSources: ['venue-l-api'], requirement: { ...MARK_REQUIREMENT, freshness: { kind: 'AGE', maxAgeSeconds: 10n } } },
    dimension('capital', 'CAPITAL', 'USDG', 6, 10_000_000_000n),
  ];
}

export function sampleGrantInput(): AuthorityGrantInput {
  return {
    lineage: { kind: 'ROOT', issuer: PRINCIPAL },
    principal: PRINCIPAL,
    holder: TRADING_AGENT,
    notBefore: T0,
    expiresAt: T_END,
    terms: sampleTerms(),
    nonce: 1n,
  };
}

export function samplePolicyInput(): PrincipalPolicyInput {
  return {
    principal: PRINCIPAL,
    sequence: 1n,
    terms: [
      dimension('btc-notional-global', 'NOTIONAL', 'USD', 2, 1_000_000n, { asset: BTC }),
      { kind: 'STATE_INVARIANT', invariantId: 'core.markedExposure', version: 1, scope: [BTC], params: '0x01' },
      { kind: 'STATE_POLICY', domain: 'perp', stateKind: 'perp.markPrice', admittedSources: ['venue-l-api', 'venue-m-api'], requirement: MARK_REQUIREMENT },
    ],
    nonce: 1n,
  };
}

export const SAMPLE_AUTHORITY = digestOf('sample:authority:leaf');
export const SAMPLE_PAYLOAD = digestOf('sample:payload');

export function sampleActionInput(): ActionEnvelopeInput {
  return {
    principal: PRINCIPAL,
    authority: SAMPLE_AUTHORITY,
    actor: PERP_AGENT,
    module: PERP_V1,
    actionType: 'perp.order',
    adapter: VENUE_SIGNER_L,
    target: BTC_PERP_L,
    resources: [L_SUB, USDG_ON_L],
    payloadDigest: SAMPLE_PAYLOAD,
    validFrom: T0 + 1000n,
    expiresAt: T0 + 1300n,
    nonce: 7n,
  };
}

export function sampleStateInput(): StateEnvelopeInput {
  return {
    module: PERP_V1,
    stateKind: 'perp.markPrice',
    subject: BTC_PERP_L,
    sourceId: 'venue-l-api',
    trustClass: 'VERIFIED',
    observedAt: T0 + 1000n,
    sequence: { kind: 'VENUE_SEQUENCE', value: 1040n },
    validUntil: null,
    finality: { ladder: 'venue-l.market-data', level: 'PUBLISHED' },
    payloadDigest: digestOf('sample:state-payload:mark:100000.00'),
  };
}

export function sampleBindingInput(stateDigest: string): StateBindingInput {
  const s = sampleStateInput();
  return {
    stateKind: s.stateKind,
    subject: s.subject,
    sourceId: s.sourceId,
    trustClass: 'VERIFIED',
    sequence: s.sequence,
    observedAt: s.observedAt,
    validUntil: s.validUntil,
    finality: s.finality,
    stateDigest,
    requirement: MARK_REQUIREMENT,
  };
}

export function sampleQuantityInput(): EconomicQuantityInput {
  return unvalued('CAPITAL', 'USDG', 6, 600_000_000n, USDG);
}

export function sampleReservationInput(action: string): ReservationRefInput {
  return {
    action,
    generation: 1n,
    principal: PRINCIPAL,
    lineage: [digestOf('sample:authority:leaf'), digestOf('sample:authority:parent'), digestOf('sample:authority:root')],
    policy: digestOf('sample:policy'),
    module: PERP_V1,
    implementation: PERP_V1_IMPL,
    adapter: VENUE_SIGNER_L,
    ledgerVersion: 58n,
  };
}

export function sampleAuthorizationInput(action: string, bindings: StateBindingInput[]): ExecutionAuthorizationInput {
  return { reservation: sampleReservationInput(action), stateBindings: bindings, attemptCeiling: T0 + 1200n };
}

export function sampleExecutionBindingInput(authorization: string, action: string, bindingIds: string[]): ExecutionBindingRefInput {
  return {
    authorization,
    action,
    generation: 1n,
    module: PERP_V1,
    adapter: VENUE_SIGNER_L,
    stateBindings: bindingIds,
    parameters: digestOf('sample:venue-order-parameters'),
  };
}

export function sampleReceiptHeaderInput(): ReceiptHeaderInput {
  return {
    kind: 'DECISION',
    coreVersion: 'mandate-core-1',
    principal: PRINCIPAL,
    ledgerBefore: { version: 57n, headDigest: digestOf('ledger:57') },
    ledgerAfter: { version: 58n, headDigest: digestOf('ledger:58') },
    previousReceipt: null,
    evaluatedAt: T0 + 1001n,
  };
}

export function sampleReceiptReferencesInput(action: string, reservationId: string, bindingIds: string[], executionBinding: string): ReceiptReferencesInput {
  return {
    lineage: [digestOf('sample:authority:leaf'), digestOf('sample:authority:parent'), digestOf('sample:authority:root')],
    policy: digestOf('sample:policy'),
    action,
    module: PERP_V1,
    implementation: PERP_V1_IMPL,
    adapter: VENUE_SIGNER_L,
    stateBindings: bindingIds,
    reservation: { reservationId, generation: 1n },
    executionBinding,
    observation: digestOf('sample:observation'),
  };
}
