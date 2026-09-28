/**
 * The state model: envelopes, freshness policies, finality, requirements and
 * bindings (action-state-model.md §5). Structural validation only; nothing is
 * admitted or evaluated here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  bindState,
  stateBindingId,
  stateId,
  validateFreshnessPolicy,
  validateStateBinding,
  validateStateEnvelope,
  validateStateRequirement,
  type CoreResult,
  type FreshnessPolicyInput,
  type StateBindingInput,
  type StateEnvelopeInput,
  type StateRequirementInput,
} from '../src/index.ts';
import { BTC_PERP_L, PERP_V1, PERP_V2, digestOf, must } from './support/basics.ts';

function code<T>(r: CoreResult<T>): string {
  return r.ok ? 'OK' : r.error.code;
}

const MARK: StateEnvelopeInput = {
  module: PERP_V1,
  stateKind: 'perp.markPrice',
  subject: BTC_PERP_L,
  sourceId: 'venue-l-api',
  trustClass: 'VERIFIED',
  observedAt: 1_000n,
  sequence: { kind: 'VENUE_SEQUENCE', value: 1_040n },
  validUntil: null,
  finality: { ladder: 'venue-l.market-data', level: 'PUBLISHED' },
  payloadDigest: digestOf('mark:100000.00'),
};

const RECHECK_MARK: StateRequirementInput = {
  freshness: { kind: 'AGE', maxAgeSeconds: 5n },
  minTrust: 'VERIFIED',
  minFinality: { ladder: 'venue-l.market-data', level: 'PUBLISHED' },
  atIssue: 'RECHECK',
  atExecution: { kind: 'ENFORCED_BY_ARTIFACT', field: 'limitPrice' },
};

describe('StateEnvelope', () => {
  it('records provenance, sequence, validity, finality and a payload digest; no payload', () => {
    const s = must(validateStateEnvelope(MARK));
    assert.deepEqual(Object.keys(s).sort(), [
      'finality',
      'module',
      'observedAt',
      'payloadDigest',
      'sequence',
      'sourceId',
      'stateKind',
      'subject',
      'trustClass',
      'validUntil',
    ]);
  });

  it('is interpreted under one exact ModuleRef: changing moduleVersion changes its identity', () => {
    const base = stateId(must(validateStateEnvelope(MARK)));
    const nextVersion = stateId(must(validateStateEnvelope({ ...MARK, module: { ...PERP_V1, moduleVersion: PERP_V1.moduleVersion + 1 } })));
    assert.notEqual(nextVersion, base);
  });

  it('changing moduleDigest alone changes its identity', () => {
    const base = stateId(must(validateStateEnvelope(MARK)));
    const otherDigest = stateId(must(validateStateEnvelope({ ...MARK, module: { ...PERP_V1, moduleDigest: digestOf('manifest:perp-policy:1:other') } })));
    assert.notEqual(otherDigest, base);
  });

  it('the same observation in the same domain under two different modules is two states', () => {
    const underV1 = must(validateStateEnvelope(MARK));
    const underV2 = must(validateStateEnvelope({ ...MARK, module: PERP_V2 }));
    const otherModule = must(validateStateEnvelope({ ...MARK, module: { ...PERP_V1, moduleId: 'perp-risk', moduleDigest: digestOf('manifest:perp-risk:1') } }));
    assert.equal(underV1.module.domainId, underV2.module.domainId);
    assert.equal(underV1.module.domainId, otherModule.module.domainId);
    assert.equal(new Set([stateId(underV1), stateId(underV2), stateId(otherModule)]).size, 3);
    // And so are their bindings, whose stateDigest names the envelope.
    assert.notEqual(stateBindingId(must(bindState(underV1, RECHECK_MARK))), stateBindingId(must(bindState(underV2, RECHECK_MARK))));
  });

  it('refuses a bare domain, a module name, or a module without its digest', () => {
    const { module: _m, ...noModule } = MARK;
    assert.deepEqual(validateStateEnvelope({ ...noModule, domain: 'perp' } as never), { ok: false, error: { code: 'UNKNOWN_FIELD', path: 'state.domain' } });
    assert.deepEqual(validateStateEnvelope(noModule as never), { ok: false, error: { code: 'MISSING_FIELD', path: 'state.module' } });
    assert.deepEqual(validateStateEnvelope({ ...MARK, module: 'perp-policy@1' as never }), { ok: false, error: { code: 'WRONG_TYPE', path: 'state.module' } });
    const { moduleDigest: _d, ...noDigest } = PERP_V1;
    assert.deepEqual(validateStateEnvelope({ ...MARK, module: noDigest as never }), { ok: false, error: { code: 'MISSING_FIELD', path: 'state.module.moduleDigest' } });
  });

  it('records any trust class: admission, not the envelope, refuses advisory state', () => {
    assert.equal(code(validateStateEnvelope({ ...MARK, trustClass: 'ADVISORY' })), 'OK');
    assert.equal(code(validateStateEnvelope({ ...MARK, trustClass: 'MODEL' as never })), 'UNKNOWN_ENUM_VALUE');
  });

  it('refuses a missing source and a source-declared validity that admits nothing', () => {
    const { sourceId: _s, ...noSource } = MARK;
    assert.deepEqual(validateStateEnvelope(noSource as StateEnvelopeInput), { ok: false, error: { code: 'MISSING_FIELD', path: 'state.sourceId' } });
    assert.equal(code(validateStateEnvelope({ ...MARK, validUntil: 1_000n })), 'STATE_VALIDITY_INVALID');
    assert.equal(code(validateStateEnvelope({ ...MARK, validUntil: 1_001n })), 'OK');
  });

  it('carries a sequence only where the source has one, and refuses a value on NONE', () => {
    assert.equal(code(validateStateEnvelope({ ...MARK, sequence: { kind: 'NONE' } })), 'OK');
    assert.equal(code(validateStateEnvelope({ ...MARK, sequence: { kind: 'NONE', value: 1n } as never })), 'UNKNOWN_FIELD');
    assert.equal(code(validateStateEnvelope({ ...MARK, sequence: { kind: 'BLOCK', value: -1n } })), 'INTEGER_OUT_OF_RANGE');
  });

  it('names finality as a level on a declared ladder, not only a chain block', () => {
    for (const finality of [
      { ladder: 'evm.block', level: 'FINALIZED' },
      { ladder: 'venue-l.order', level: 'ACKNOWLEDGED' },
      { ladder: 'venue-l.order', level: 'VENUE_FINAL' },
      { ladder: 'core.observation', level: 'OBSERVED' },
    ]) {
      assert.equal(code(validateStateEnvelope({ ...MARK, finality })), 'OK');
    }
    assert.equal(code(validateStateEnvelope({ ...MARK, finality: { ladder: 'evm.block', level: '' } })), 'MALFORMED_IDENTIFIER');
  });
});

describe('freshness policies', () => {
  it('are one of AGE, BLOCKS, SEQUENCE and VERSION, each with exactly its own parameters', () => {
    const valid: FreshnessPolicyInput[] = [
      { kind: 'AGE', maxAgeSeconds: 5n },
      { kind: 'BLOCKS', maxBlocksBehind: 12n },
      { kind: 'SEQUENCE' },
      { kind: 'VERSION', pinnedDigest: digestOf('registry-snapshot'), maxAgeSeconds: 7_200n },
    ];
    for (const f of valid) assert.equal(code(validateFreshnessPolicy(f, 'f')), 'OK', f.kind);
  });

  it('refuse an unknown mode, a missing or extra parameter, and an out-of-range bound', () => {
    assert.equal(code(validateFreshnessPolicy({ kind: 'INTERVAL' } as never, 'f')), 'UNKNOWN_ENUM_VALUE');
    assert.equal(code(validateFreshnessPolicy({ kind: 'AGE' } as never, 'f')), 'MISSING_FIELD');
    assert.equal(code(validateFreshnessPolicy({ kind: 'SEQUENCE', maxDistance: 3n } as never, 'f')), 'UNKNOWN_FIELD');
    assert.equal(code(validateFreshnessPolicy({ kind: 'AGE', maxAgeSeconds: 2n ** 32n }, 'f')), 'INTEGER_OUT_OF_RANGE');
    assert.equal(code(validateFreshnessPolicy({ kind: 'AGE', maxAgeSeconds: 5 as never }, 'f')), 'NUMBER_NOT_PERMITTED');
    assert.equal(code(validateFreshnessPolicy({ kind: 'VERSION', pinnedDigest: 'v1', maxAgeSeconds: 1n }, 'f')), 'MALFORMED_DIGEST');
  });
});

describe('freshness modes do not share a representation (Phase 7B.1 ruling 4)', () => {
  it('BLOCKS is a block count and cannot accept an AGE duration', () => {
    assert.deepEqual(validateFreshnessPolicy({ kind: 'BLOCKS', maxAgeSeconds: 12n } as never, 'f'), { ok: false, error: { code: 'UNKNOWN_FIELD', path: 'f.maxAgeSeconds' } });
    assert.equal(code(validateFreshnessPolicy({ kind: 'BLOCKS', maxBlocksBehind: 12n, maxAgeSeconds: 12n } as never, 'f')), 'UNKNOWN_FIELD');
    assert.deepEqual(validateFreshnessPolicy({ kind: 'AGE', maxBlocksBehind: 12n } as never, 'f'), { ok: false, error: { code: 'UNKNOWN_FIELD', path: 'f.maxBlocksBehind' } });
  });

  it('SEQUENCE is bounded by the ledger watermark and cannot accept an AGE duration or a BLOCKS count', () => {
    assert.deepEqual(validateFreshnessPolicy({ kind: 'SEQUENCE', maxAgeSeconds: 5n } as never, 'f'), { ok: false, error: { code: 'UNKNOWN_FIELD', path: 'f.maxAgeSeconds' } });
    assert.deepEqual(validateFreshnessPolicy({ kind: 'SEQUENCE', maxBlocksBehind: 5n } as never, 'f'), { ok: false, error: { code: 'UNKNOWN_FIELD', path: 'f.maxBlocksBehind' } });
  });

  it('a pinned VERSION is a digest identity and cannot be represented as elapsed time', () => {
    assert.equal(code(validateFreshnessPolicy({ kind: 'VERSION', pinnedDigest: '3600', maxAgeSeconds: 60n }, 'f')), 'MALFORMED_DIGEST');
    assert.equal(code(validateFreshnessPolicy({ kind: 'VERSION', pinnedDigest: 3600n as never, maxAgeSeconds: 60n }, 'f')), 'WRONG_TYPE');
    assert.deepEqual(validateFreshnessPolicy({ kind: 'VERSION', maxAgeSeconds: 3_600n } as never, 'f'), { ok: false, error: { code: 'MISSING_FIELD', path: 'f.pinnedDigest' } });
    assert.equal(code(validateFreshnessPolicy({ kind: 'AGE', maxAgeSeconds: 60n, pinnedDigest: digestOf('v') } as never, 'f')), 'UNKNOWN_FIELD');
  });

  it('the same number under two modes is two different canonical requirements', () => {
    const requirement = (freshness: FreshnessPolicyInput): string =>
      stateBindingId(must(bindState(must(validateStateEnvelope(MARK)), { ...RECHECK_MARK, atExecution: { kind: 'NOT_REQUIRED' }, freshness })));
    assert.notEqual(requirement({ kind: 'AGE', maxAgeSeconds: 12n }), requirement({ kind: 'BLOCKS', maxBlocksBehind: 12n }));
  });
});

describe('state requirements', () => {
  it('admit only AUTHORITATIVE or VERIFIED as a minimum trust', () => {
    assert.equal(code(validateStateRequirement(RECHECK_MARK, 'r')), 'OK');
    assert.equal(code(validateStateRequirement({ ...RECHECK_MARK, minTrust: 'ADVISORY' as never }, 'r')), 'MIN_TRUST_NOT_ADMISSIBLE');
  });

  it('allow BOUNDED_BY_FRESHNESS only with AGE or VERSION: block and sequence distance have no fixed time', () => {
    const bounded = { kind: 'BOUNDED_BY_FRESHNESS' } as const;
    assert.equal(code(validateStateRequirement({ ...RECHECK_MARK, atExecution: bounded }, 'r')), 'OK');
    assert.equal(
      code(validateStateRequirement({ ...RECHECK_MARK, freshness: { kind: 'VERSION', pinnedDigest: digestOf('v'), maxAgeSeconds: 60n }, atExecution: bounded }, 'r')),
      'OK',
    );
    assert.equal(code(validateStateRequirement({ ...RECHECK_MARK, freshness: { kind: 'BLOCKS', maxBlocksBehind: 3n }, atExecution: bounded }, 'r')), 'EXECUTION_DEPENDENCE_INCOMPATIBLE');
    assert.equal(code(validateStateRequirement({ ...RECHECK_MARK, freshness: { kind: 'SEQUENCE' }, atExecution: bounded }, 'r')), 'EXECUTION_DEPENDENCE_INCOMPATIBLE');
  });

  it('name the artifact field that enforces a dependency', () => {
    assert.equal(code(validateStateRequirement({ ...RECHECK_MARK, atExecution: { kind: 'ENFORCED_BY_ARTIFACT' } as never }, 'r')), 'MISSING_FIELD');
  });
});

describe('StateBinding', () => {
  it('is built from an envelope with every provenance field copied and its digest computed', () => {
    const envelope = must(validateStateEnvelope(MARK));
    const binding = must(bindState(envelope, RECHECK_MARK));
    assert.equal(binding.stateDigest, stateId(envelope));
    assert.equal(binding.sourceId, envelope.sourceId);
    assert.deepEqual(binding.sequence, envelope.sequence);
    assert.equal(binding.observedAt, envelope.observedAt);
    assert.deepEqual(binding.finality, envelope.finality);
    assert.equal(binding.requirement.atIssue, 'RECHECK');
  });

  it('cannot bind state that was never admissible', () => {
    const advisory = must(validateStateEnvelope({ ...MARK, trustClass: 'ADVISORY' }));
    assert.equal(code(bindState(advisory, RECHECK_MARK)), 'TRUST_CLASS_NOT_ADMISSIBLE');
  });

  it('cannot omit source, digest, finality or requirement', () => {
    const base: StateBindingInput = {
      stateKind: 'perp.markPrice',
      subject: BTC_PERP_L,
      sourceId: 'venue-l-api',
      trustClass: 'VERIFIED',
      sequence: { kind: 'VENUE_SEQUENCE', value: 1_040n },
      observedAt: 1_000n,
      validUntil: null,
      finality: MARK.finality,
      stateDigest: digestOf('s'),
      requirement: RECHECK_MARK,
    };
    assert.equal(code(validateStateBinding(base)), 'OK');
    for (const field of ['sourceId', 'stateDigest', 'finality', 'requirement', 'trustClass', 'sequence'] as const) {
      const { [field]: _dropped, ...rest } = base;
      assert.deepEqual(validateStateBinding(rest as StateBindingInput), { ok: false, error: { code: 'MISSING_FIELD', path: `binding.${field}` } }, field);
    }
    assert.equal(code(validateStateBinding({ ...base, trustClass: 'UNTRUSTED' as never })), 'TRUST_CLASS_NOT_ADMISSIBLE');
  });

  it('two observations of one subject are two bindings', () => {
    const a = must(bindState(must(validateStateEnvelope(MARK)), RECHECK_MARK));
    const b = must(bindState(must(validateStateEnvelope({ ...MARK, observedAt: 1_004n, sequence: { kind: 'VENUE_SEQUENCE', value: 1_041n }, payloadDigest: digestOf('mark:106000.00') })), RECHECK_MARK));
    assert.notEqual(stateBindingId(a), stateBindingId(b));
  });
});
