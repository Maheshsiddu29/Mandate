/**
 * The admission rules and requirement tightening, directly
 * (action-state-model.md §5.3–5.5; STATE-1, STATE-3): each freshness mode on
 * both sides of its boundary, and the combination of requirements.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateStateRequirement, type StateRequirementInput } from '@mandate/core';
import { assessObservation, tightenRequirement, type Observed } from '../src/admission.ts';
import { validateEvaluationContext } from '../src/index.ts';
import { T, must } from './support/builders.ts';
import { LADDERS } from './support/synthetic.ts';

describe('the admission rules directly', () => {
  const ctx = must(validateEvaluationContext({ evaluationTime: T, sources: [{ sourceId: 'chain', trustClass: 'AUTHORITATIVE', kinds: [{ domain: 'd', stateKind: 'k' }] }], blockHeads: [{ sourceId: 'chain', block: 1_000n }], sequenceWatermarks: [] }));
  const req = (freshness: StateRequirementInput['freshness'], atExecution: StateRequirementInput['atExecution'] = { kind: 'NOT_REQUIRED' }) =>
    must(validateStateRequirement({ freshness, minTrust: 'AUTHORITATIVE', minFinality: { ladder: 'synth.feed', level: 'OBSERVED' }, atIssue: 'WITHIN_POLICY', atExecution }, 'r'));
  const obs = (o: Partial<Observed>): Observed => ({
    domain: 'd' as Observed['domain'],
    stateKind: 'k' as Observed['stateKind'],
    subject: { domain: 'd', kind: 'ACCOUNT', localId: 'a' } as Observed['subject'],
    sourceId: 'chain' as Observed['sourceId'],
    trustClass: 'AUTHORITATIVE',
    observedAt: T,
    validUntil: null,
    sequence: { kind: 'BLOCK', value: 990n },
    finality: { ladder: 'synth.feed', level: 'PUBLISHED' } as Observed['finality'],
    payloadDigest: null,
    ...o,
  });
  const assess = (o: Partial<Observed>, r = req({ kind: 'BLOCKS', maxBlocksBehind: 10n })) => assessObservation(obs(o), r, ['chain' as Observed['sourceId']], LADDERS, ctx)?.reason ?? null;

  it('BLOCKS: at the bound admits, one past refuses, ahead of head and unknown head refuse', () => {
    assert.equal(assess({}), null);
    assert.equal(assess({ sequence: { kind: 'BLOCK', value: 989n } }), 'BLOCKS_BEHIND_EXCEEDED');
    assert.equal(assess({ sequence: { kind: 'BLOCK', value: 1_001n } }), 'BLOCK_AHEAD_OF_HEAD');
    assert.equal(assess({ sequence: { kind: 'VENUE_SEQUENCE', value: 990n } }), 'SEQUENCE_KIND_MISMATCH');
    assert.equal(assess({ sourceId: 'chain2' as Observed['sourceId'] }), 'SOURCE_NOT_CONFIGURED');
  });

  it('AGE: exactly maxAge old admits, one second more refuses', () => {
    const r = req({ kind: 'AGE', maxAgeSeconds: 30n });
    assert.equal(assess({ observedAt: T - 30n }, r), null);
    assert.equal(assess({ observedAt: T - 31n }, r), 'AGE_EXCEEDED');
  });

});

describe('tightening', () => {
  const r = (i: Partial<StateRequirementInput>) =>
    must(
      validateStateRequirement(
        { freshness: { kind: 'AGE', maxAgeSeconds: 30n }, minTrust: 'VERIFIED', minFinality: { ladder: 'synth.venue', level: 'ACKNOWLEDGED' }, atIssue: 'WITHIN_POLICY', atExecution: { kind: 'NOT_REQUIRED' }, ...i },
        'r',
      ),
    );

  it('takes the tighter of every component, on the declaring module\'s own ladder', () => {
    const t = tightenRequirement(LADDERS, r({}), r({ freshness: { kind: 'AGE', maxAgeSeconds: 10n }, minTrust: 'AUTHORITATIVE', minFinality: { ladder: 'synth.venue', level: 'FINAL' }, atIssue: 'RECHECK', atExecution: { kind: 'ENFORCED_BY_ARTIFACT', field: 'limitPrice' } }));
    assert.ok(t.ok);
    if (t.ok) {
      assert.deepEqual(t.value.freshness, { kind: 'AGE', maxAgeSeconds: 10n });
      assert.equal(t.value.minTrust, 'AUTHORITATIVE');
      assert.equal(t.value.minFinality.level, 'FINAL');
      assert.equal(t.value.atIssue, 'RECHECK');
      assert.deepEqual(t.value.atExecution, { kind: 'ENFORCED_BY_ARTIFACT', field: 'limitPrice' });
    }
    // Symmetric.
    const u = tightenRequirement(LADDERS, r({ freshness: { kind: 'AGE', maxAgeSeconds: 10n } }), r({}));
    assert.ok(u.ok && u.value.freshness.kind === 'AGE' && u.value.freshness.maxAgeSeconds === 10n);
  });

  it('refuses to combine what has no common order', () => {
    const reason = (a: Partial<StateRequirementInput>, b: Partial<StateRequirementInput>) => {
      const t = tightenRequirement(LADDERS, r(a), r(b));
      return t.ok ? 'OK' : t.reason;
    };
    assert.equal(reason({}, { freshness: { kind: 'BLOCKS', maxBlocksBehind: 3n } }), 'FRESHNESS_INCOMPARABLE');
    assert.equal(reason({ freshness: { kind: 'VERSION', pinnedDigest: `0x${'01'.repeat(32)}`, maxAgeSeconds: 5n } }, { freshness: { kind: 'VERSION', pinnedDigest: `0x${'02'.repeat(32)}`, maxAgeSeconds: 5n } }), 'FRESHNESS_INCOMPARABLE');
    assert.equal(reason({}, { minFinality: { ladder: 'synth.feed', level: 'PUBLISHED' } }), 'FINALITY_LADDER_INCOMPARABLE');
    assert.equal(reason({}, { minFinality: { ladder: 'synth.venue', level: 'UNHEARD_OF' } }), 'FINALITY_LEVEL_UNDECLARED');
    assert.equal(reason({ atExecution: { kind: 'BOUNDED_BY_FRESHNESS' } }, { atExecution: { kind: 'ENFORCED_BY_ARTIFACT', field: 'x' } }), 'EXECUTION_DEPENDENCE_INCOMPARABLE');
    assert.equal(reason({ atExecution: { kind: 'NOT_REQUIRED' } }, { atExecution: { kind: 'BOUNDED_BY_FRESHNESS' } }), 'OK');
  });
});
