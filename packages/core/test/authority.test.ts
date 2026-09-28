/**
 * Authority terms, grants and the principal policy (authority-model.md §2–3,
 * §8; authority-ledger.md §3). Structural rules only: widening, restatement
 * and the meet are the authority engine's (7C onward).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CoreTag,
  MAX_DELEGATION_DEPTH,
  MAX_GRANT_TERMS,
  authorityId,
  decodeAuthorityGrant,
  decodePrincipalPolicy,
  encodePrincipalPolicy,
  grantIdentity,
  policyDimensions,
  policyInvariants,
  policyStatePolicy,
  principalPolicyId,
  taggedWriter,
  validateAuthorityGrant,
  validatePrincipalPolicy,
  validateTerm,
  writeList,
  writeParty,
  writeTerm,
  type AuthorityGrantInput,
  type AuthorityTermInput,
  type CoreResult,
  type LedgerDimensionInput,
  type PrincipalPolicyInput,
  type PrincipalPolicyTermInput,
  type StateRequirementInput,
} from '../src/index.ts';
import {
  AAPL,
  BTC,
  BTC_PERP_L,
  EVM_GATE,
  EVM_SPOT_V1,
  FAAPL,
  L_SUB,
  PERP_V1,
  PRINCIPAL,
  PRINCIPAL_2,
  TRADING_AGENT,
  USDG,
  must,
} from './support/basics.ts';

function code<T>(r: CoreResult<T>): string {
  return r.ok ? 'OK' : r.error.code;
}

const REQUIREMENT: StateRequirementInput = {
  freshness: { kind: 'AGE', maxAgeSeconds: 10n },
  minTrust: 'VERIFIED',
  minFinality: { ladder: 'venue-l.market-data', level: 'PUBLISHED' },
  atIssue: 'RECHECK',
  atExecution: { kind: 'BOUNDED_BY_FRESHNESS' },
};

function dimension(overrides: Partial<LedgerDimensionInput> = {}): LedgerDimensionInput {
  return {
    kind: 'LEDGER_DIMENSION',
    dimensionId: 'capital',
    limit: { kind: 'CAPITAL', unit: 'USDG', decimals: 6, atoms: 1_200_000_000n },
    accounting: 'CAPACITY',
    restoration: 'AS_CHARGED',
    epoch: null,
    sign: 'UNSIGNED',
    scope: { asset: null, market: null, domain: null, account: null },
    ...overrides,
  };
}

function root(terms: AuthorityTermInput[], overrides: Partial<AuthorityGrantInput> = {}): AuthorityGrantInput {
  return {
    lineage: { kind: 'ROOT', issuer: PRINCIPAL },
    principal: PRINCIPAL,
    holder: TRADING_AGENT,
    notBefore: 1_000n,
    expiresAt: 2_000n,
    terms,
    nonce: 1n,
    ...overrides,
  };
}

function term(t: AuthorityTermInput): string {
  return code(validateTerm(t, 'term'));
}

describe('the seven term kinds', () => {
  it('each validate in their typed form', () => {
    const terms: AuthorityTermInput[] = [
      { kind: 'SET', vocabulary: 'MODULES', members: [PERP_V1] },
      { kind: 'RIGHT', right: 'OPEN_RISK' },
      { kind: 'BOUND', boundId: 'perp.orderLeverage', polarity: 'MAX', value: { type: 'RATIO', ratio: { numerator: 5n, scale: 0 } } },
      { kind: 'TIME_WINDOW', domain: 'perp', notBefore: 1_000n, expiresAt: 1_500n },
      dimension(),
      { kind: 'STATE_INVARIANT', invariantId: 'perp.accountLeverage', version: 1, scope: [L_SUB], params: '0x0400' },
      { kind: 'STATE_POLICY', domain: 'perp', stateKind: 'perp.markPrice', admittedSources: ['venue-l-api'], requirement: REQUIREMENT },
    ];
    for (const t of terms) assert.equal(term(t), 'OK', t.kind);
    assert.equal(term({ kind: 'SCRIPT' } as never), 'UNKNOWN_ENUM_VALUE');
  });
});

describe('SET', () => {
  it('holds members of its vocabulary\'s type only', () => {
    assert.equal(term({ kind: 'SET', vocabulary: 'MARKETS', members: [BTC] }), 'RESOURCE_KIND_MISMATCH');
    assert.equal(term({ kind: 'SET', vocabulary: 'ASSETS', members: [BTC, USDG, FAAPL, AAPL] }), 'OK');
    assert.equal(term({ kind: 'SET', vocabulary: 'RECIPIENTS', members: [L_SUB] }), 'OK');
    assert.equal(term({ kind: 'SET', vocabulary: 'ADAPTERS', members: [EVM_GATE] }), 'OK');
    assert.equal(term({ kind: 'SET', vocabulary: 'ACTION_TYPES', members: [{ domain: 'perp', actionType: 'perp.order' }] }), 'OK');
  });

  it('allows modules only as exact refs, never by name', () => {
    assert.equal(term({ kind: 'SET', vocabulary: 'MODULES', members: ['perp-policy@1' as never] }), 'WRONG_TYPE');
  });

  it('refuses duplicates rather than collapsing them, and permits the empty set (which grants nothing)', () => {
    assert.equal(term({ kind: 'SET', vocabulary: 'MODULES', members: [PERP_V1, EVM_SPOT_V1, PERP_V1] }), 'DUPLICATE_SET_MEMBER');
    assert.equal(term({ kind: 'SET', vocabulary: 'MARKETS', members: [] }), 'OK');
  });
});

describe('RIGHT and delegation depth', () => {
  it('DELEGATE carries a depth of 1..MAX_DELEGATION_DEPTH; depth 0 is incoherent', () => {
    assert.equal(term({ kind: 'RIGHT', right: 'DELEGATE', maxDepth: 1 }), 'OK');
    assert.equal(term({ kind: 'RIGHT', right: 'DELEGATE', maxDepth: MAX_DELEGATION_DEPTH }), 'OK');
    assert.equal(term({ kind: 'RIGHT', right: 'DELEGATE', maxDepth: 0 }), 'DELEGATE_DEPTH_INVALID');
    assert.equal(term({ kind: 'RIGHT', right: 'DELEGATE', maxDepth: MAX_DELEGATION_DEPTH + 1 }), 'DELEGATE_DEPTH_INVALID');
    assert.equal(term({ kind: 'RIGHT', right: 'DELEGATE' } as never), 'MISSING_FIELD');
    assert.equal(term({ kind: 'RIGHT', right: 'OPEN_RISK', maxDepth: 1 } as never), 'UNKNOWN_FIELD');
    assert.equal(term({ kind: 'RIGHT', right: 'MINT' } as never), 'UNKNOWN_ENUM_VALUE');
  });
});

describe('BOUND and TIME_WINDOW', () => {
  it('a bound is a quantity or a ratio, with a polarity', () => {
    assert.equal(
      term({ kind: 'BOUND', boundId: 'perp.orderNotional', polarity: 'MAX', value: { type: 'QUANTITY', quantity: { kind: 'NOTIONAL', unit: 'USD', decimals: 2, atoms: 500_000n } } }),
      'OK',
    );
    assert.equal(term({ kind: 'BOUND', boundId: 'x', polarity: 'AT_MOST' as never, value: { type: 'RATIO', ratio: { numerator: 1n, scale: 0 } } }), 'UNKNOWN_ENUM_VALUE');
    assert.equal(term({ kind: 'BOUND', boundId: 'x', polarity: 'MAX', value: { type: 'RATIO', ratio: { numerator: -1n, scale: 0 } } }), 'INTEGER_OUT_OF_RANGE');
  });

  it('a window must be satisfiable: notBefore < expiresAt', () => {
    assert.equal(term({ kind: 'TIME_WINDOW', domain: 'perp', notBefore: 1_500n, expiresAt: 1_500n }), 'INVALID_TIME_WINDOW');
    assert.equal(term({ kind: 'TIME_WINDOW', domain: 'perp', notBefore: 1_600n, expiresAt: 1_500n }), 'INVALID_TIME_WINDOW');
  });
});

describe('LEDGER_DIMENSION', () => {
  it('records the restoration mode, paired with its accounting family', () => {
    assert.equal(term(dimension({ accounting: 'CAPACITY', restoration: 'AS_CHARGED' })), 'OK');
    assert.equal(term(dimension({ limit: { kind: 'POSITION_SIZE', unit: 'BTC', decimals: 8, atoms: 50_000_000n }, restoration: 'UNITS', sign: 'NET' })), 'OK');
    assert.equal(term(dimension({ limit: { kind: 'COUNT', unit: 'COUNT', decimals: 0, atoms: 50n }, accounting: 'BUDGET', restoration: 'NONE' })), 'OK');
    assert.equal(term(dimension({ accounting: 'BUDGET', restoration: 'AS_CHARGED' })), 'RESTORATION_ACCOUNTING_MISMATCH');
    assert.equal(term(dimension({ accounting: 'CAPACITY', restoration: 'NONE' })), 'RESTORATION_ACCOUNTING_MISMATCH');
  });

  it('EPOCH needs exactly its anchor and a non-zero length, and nothing else carries one', () => {
    assert.equal(term(dimension({ accounting: 'BUDGET', restoration: 'EPOCH', epoch: { anchor: 0n, lengthSeconds: 86_400n } })), 'OK');
    assert.equal(term(dimension({ accounting: 'BUDGET', restoration: 'EPOCH', epoch: null })), 'EPOCH_REQUIRED');
    assert.equal(term(dimension({ accounting: 'BUDGET', restoration: 'EPOCH', epoch: { anchor: 0n, lengthSeconds: 0n } })), 'EPOCH_INVALID');
    assert.equal(term(dimension({ epoch: { anchor: 0n, lengthSeconds: 86_400n } })), 'EPOCH_FORBIDDEN');
  });

  it('refuses a floating measure as a counter: marked exposure is an invariant (decision 10)', () => {
    assert.equal(term(dimension({ limit: { kind: 'GROSS_EXPOSURE', unit: 'USD', decimals: 2, atoms: 2_000_000n } })), 'DIMENSION_KIND_NOT_LEDGER_TRACKABLE');
    assert.equal(term(dimension({ limit: { kind: 'NET_EXPOSURE', unit: 'USD', decimals: 2, atoms: 2_000_000n } })), 'DIMENSION_KIND_NOT_LEDGER_TRACKABLE');
  });

  it('allows NET only for signed kinds', () => {
    assert.equal(term(dimension({ sign: 'NET' })), 'NET_SIGN_REQUIRES_SIGNED_KIND');
  });

  it('scopes by typed resources', () => {
    assert.equal(term(dimension({ scope: { asset: BTC, market: BTC_PERP_L, domain: 'perp', account: L_SUB } })), 'OK');
    assert.equal(term(dimension({ scope: { asset: null, market: BTC, domain: null, account: null } })), 'RESOURCE_KIND_MISMATCH');
    assert.equal(term(dimension({ scope: { asset: null, market: null, domain: null } as never })), 'MISSING_FIELD');
  });
});

describe('term lists', () => {
  it('refuse a second term with the same key', () => {
    const duplicates: AuthorityTermInput[][] = [
      [{ kind: 'SET', vocabulary: 'MARKETS', members: [BTC_PERP_L] }, { kind: 'SET', vocabulary: 'MARKETS', members: [] }],
      [{ kind: 'RIGHT', right: 'OPEN_RISK' }, { kind: 'RIGHT', right: 'OPEN_RISK' }],
      [{ kind: 'RIGHT', right: 'DELEGATE', maxDepth: 1 }, { kind: 'RIGHT', right: 'DELEGATE', maxDepth: 2 }],
      [dimension(), dimension({ limit: { kind: 'CAPITAL', unit: 'USDG', decimals: 6, atoms: 1n } })],
      [
        { kind: 'BOUND', boundId: 'lev', polarity: 'MAX', value: { type: 'RATIO', ratio: { numerator: 5n, scale: 0 } } },
        { kind: 'BOUND', boundId: 'lev', polarity: 'MAX', value: { type: 'RATIO', ratio: { numerator: 3n, scale: 0 } } },
      ],
      [
        { kind: 'STATE_POLICY', domain: 'perp', stateKind: 'perp.markPrice', admittedSources: ['a'], requirement: REQUIREMENT },
        { kind: 'STATE_POLICY', domain: 'perp', stateKind: 'perp.markPrice', admittedSources: ['b'], requirement: REQUIREMENT },
      ],
      [
        { kind: 'STATE_INVARIANT', invariantId: 'perp.accountLeverage', version: 1, scope: [L_SUB], params: '0x04' },
        { kind: 'STATE_INVARIANT', invariantId: 'perp.accountLeverage', version: 1, scope: [L_SUB], params: '0x03' },
      ],
    ];
    for (const terms of duplicates) {
      const r = validateAuthorityGrant(root(terms));
      assert.ok(!r.ok);
      assert.equal(r.error.code, 'DUPLICATE_TERM', terms[0]?.kind);
      assert.equal(r.error.path, 'grant.terms[1]');
    }
  });

  it('keep distinct keys: a MIN and a MAX bound, or one invariant over two scopes', () => {
    const r = validateAuthorityGrant(
      root([
        { kind: 'BOUND', boundId: 'credit', polarity: 'MAX', value: { type: 'RATIO', ratio: { numerator: 5n, scale: 0 } } },
        { kind: 'BOUND', boundId: 'credit', polarity: 'MIN', value: { type: 'RATIO', ratio: { numerator: 1n, scale: 0 } } },
        { kind: 'STATE_INVARIANT', invariantId: 'core.markedExposure', version: 1, scope: [BTC], params: '0x' },
        { kind: 'STATE_INVARIANT', invariantId: 'core.markedExposure', version: 1, scope: [AAPL], params: '0x' },
      ]),
    );
    assert.equal(code(r), 'OK');
  });

  it('are bounded', () => {
    const many: AuthorityTermInput[] = Array.from({ length: MAX_GRANT_TERMS + 1 }, (_, i) => dimension({ dimensionId: `d${i}` }));
    assert.equal(code(validateAuthorityGrant(root(many))), 'COLLECTION_TOO_LARGE');
  });
});

describe('AuthorityGrant', () => {
  it('requires a satisfiable validity window; there is no "until revoked" grant', () => {
    assert.equal(code(validateAuthorityGrant(root([], { notBefore: 2_000n, expiresAt: 2_000n }))), 'INVALID_TIME_WINDOW');
    const { expiresAt: _e, ...noExpiry } = root([]);
    assert.deepEqual(validateAuthorityGrant(noExpiry as never), { ok: false, error: { code: 'MISSING_FIELD', path: 'grant.expiresAt' } });
    assert.equal(code(validateAuthorityGrant({ ...root([]), expiresAt: null } as never)), 'WRONG_TYPE');
  });

  it('a root is issued by its principal', () => {
    assert.deepEqual(validateAuthorityGrant(root([], { lineage: { kind: 'ROOT', issuer: TRADING_AGENT } })), {
      ok: false,
      error: { code: 'ROOT_ISSUER_NOT_PRINCIPAL', path: 'grant.lineage.issuer' },
    });
  });

  it('a root\'s AuthorityId is a MandateId and a delegation\'s a DelegationId', () => {
    const r = must(validateAuthorityGrant(root([])));
    const identity = grantIdentity(r);
    assert.equal(identity.kind, 'ROOT');
    const child = must(
      validateAuthorityGrant(root([], { lineage: { kind: 'DELEGATION', parent: identity.id, issuer: TRADING_AGENT }, holder: PRINCIPAL_2 })),
    );
    const childIdentity = grantIdentity(child);
    assert.equal(childIdentity.kind, 'DELEGATION');
    assert.notEqual(childIdentity.id, identity.id);
  });

  it('two grants identical but for the nonce are two nodes', () => {
    assert.notEqual(authorityId(must(validateAuthorityGrant(root([])))), authorityId(must(validateAuthorityGrant(root([], { nonce: 2n })))));
  });

  it('refuses unknown fields: a grant carries exactly its specified fields', () => {
    assert.deepEqual(validateAuthorityGrant({ ...root([]), label: 'desk A' } as never), { ok: false, error: { code: 'UNKNOWN_FIELD', path: 'grant.label' } });
  });
});

describe('PrincipalPolicy', () => {
  const policy = (terms: PrincipalPolicyTermInput[]): PrincipalPolicyInput => ({ principal: PRINCIPAL, sequence: 1n, terms, nonce: 1n });

  it('may be explicitly empty, and the empty policy has its own identity', () => {
    const empty = must(validatePrincipalPolicy(policy([])));
    const other = must(validatePrincipalPolicy(policy([dimension()])));
    assert.notEqual(principalPolicyId(empty), principalPolicyId(other));
  });

  it('carries global dimensions, global invariants and global state policy as three distinct mechanisms', () => {
    const p = must(
      validatePrincipalPolicy(
        policy([
          dimension({ dimensionId: 'btc-notional-global', limit: { kind: 'NOTIONAL', unit: 'USD', decimals: 2, atoms: 1_000_000n }, scope: { asset: BTC, market: null, domain: null, account: null } }),
          { kind: 'STATE_INVARIANT', invariantId: 'core.markedExposure', version: 1, scope: [BTC], params: '0x01' },
          { kind: 'STATE_POLICY', domain: 'perp', stateKind: 'perp.markPrice', admittedSources: ['venue-l-api'], requirement: REQUIREMENT },
        ]),
      ),
    );
    assert.equal(policyDimensions(p).length, 1);
    assert.equal(policyInvariants(p).length, 1);
    assert.equal(policyStatePolicy(p).length, 1);
  });

  it('refuses a right: the policy grants nothing', () => {
    const r = validatePrincipalPolicy(policy([{ kind: 'RIGHT', right: 'OPEN_RISK' } as never]));
    assert.deepEqual(r, { ok: false, error: { code: 'PRINCIPAL_POLICY_GRANTS_AUTHORITY', path: 'policy.terms[0].kind' } });
    // Named as a grant even when it is also malformed.
    assert.equal(code(validatePrincipalPolicy(policy([{ kind: 'RIGHT', right: 'DELEGATE' } as never]))), 'PRINCIPAL_POLICY_GRANTS_AUTHORITY');
    assert.equal(code(validatePrincipalPolicy(policy([{ kind: 'SET', vocabulary: 'MARKETS', members: [] } as never]))), 'PRINCIPAL_POLICY_GRANTS_AUTHORITY');
  });

  it('refuses per-action bounds and windows, which the specification does not place in it', () => {
    assert.equal(
      code(validatePrincipalPolicy(policy([{ kind: 'BOUND', boundId: 'x', polarity: 'MAX', value: { type: 'RATIO', ratio: { numerator: 1n, scale: 0 } } } as never]))),
      'PRINCIPAL_POLICY_TERM_NOT_PERMITTED',
    );
    assert.equal(code(validatePrincipalPolicy(policy([{ kind: 'TIME_WINDOW', domain: 'perp', notBefore: 1n, expiresAt: 2n } as never]))), 'PRINCIPAL_POLICY_TERM_NOT_PERMITTED');
  });

  it('refuses a right smuggled in through its canonical bytes', () => {
    const right = must(validateTerm({ kind: 'RIGHT', right: 'OPEN_RISK' }, 't'));
    const principal = must(validatePrincipalPolicy(policy([]))).principal;
    const w = taggedWriter(CoreTag.PRINCIPAL_POLICY);
    writeParty(w, principal);
    w.u64(1n);
    writeList(w, [right], writeTerm);
    w.u64(1n);
    const r = decodePrincipalPolicy(w.finish());
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'PRINCIPAL_POLICY_GRANTS_AUTHORITY');
  });

  it('is domain-separated from grants: its bytes never decode as one', () => {
    const bytes = encodePrincipalPolicy(must(validatePrincipalPolicy(policy([]))));
    assert.equal(code(decodeAuthorityGrant(bytes)), 'ENCODING_WRONG_TAG');
  });
});
