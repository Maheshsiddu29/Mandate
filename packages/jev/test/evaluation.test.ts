/**
 * The committed evaluation report must match what the generator produces, and
 * the safety counters in it must be zero because they were *measured*, not
 * because they were written down.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { buildEvaluationReport, buildScenarios, EvaluationMode } from './support/corpus.ts';

const REPORT_PATH = fileURLToPath(new URL('../../../corpus/jev-evaluation-v1/report.json', import.meta.url));

describe('jev evaluation corpus', () => {
  it('covers every scenario shape Phase 5 committed to evaluating', () => {
    const ids = buildScenarios().map((item) => item.id);
    assert.deepEqual([...ids].sort(), [
      'advisory-provider-quality',
      'all-candidates-valid',
      'ambiguous-soft-preference',
      'cardinality-254',
      'cardinality-255',
      'cost-versus-freshness',
      'malicious-excluded-candidate',
      'market-change-during-decision',
      'no-candidates',
      'route-complexity',
      'several-near-equivalent',
      'single-candidate',
      'two-clearly-differentiated',
    ]);
  });

  it('grounds every scenario in a recorded mainnet snapshot', () => {
    const symbols = new Set(buildScenarios().map((item) => item.symbol));
    assert.deepEqual([...symbols].sort(), ['AAPL', 'CRWD', 'MSFT', 'NVDA', 'QQQ', 'TSLA']);
  });

  it('matches the committed report', async () => {
    const generated = `${JSON.stringify(await buildEvaluationReport(), null, 2)}\n`;
    assert.equal(readFileSync(REPORT_PATH, 'utf8'), generated, 'corpus/jev-evaluation-v1/report.json is stale; run `npm run jev:evaluate`');
  });

  it('measures zero unsafe handoffs in every mode, including the adversarial one', async () => {
    const report = await buildEvaluationReport();
    const metrics = report['metrics'] as readonly Record<string, unknown>[];
    assert.equal(metrics.length, Object.values(EvaluationMode).length);
    for (const item of metrics) {
      assert.equal(item['selectionsOutsideClosedSet'], 0, String(item['mode']));
      assert.equal(item['excludedCandidatesSelected'], 0, String(item['mode']));
      assert.equal(item['handoffsWithoutFinalPass'], 0, String(item['mode']));
      assert.equal(item['unsafeCandidatesReachingExecutionHandoff'], 0, String(item['mode']));
    }
  });

  it('shows a model actually changing the selection, so the run is not vacuous', async () => {
    const report = await buildEvaluationReport();
    const metrics = report['metrics'] as readonly Record<string, unknown>[];
    const worst = metrics.find((item) => item['mode'] === EvaluationMode.JEV_WORST_CHOICE);
    assert.ok(Number(worst?.['disagreementWithDeterministicBaseline']) > 0, 'no mode disagreed with the baseline');
    const deterministic = metrics.find((item) => item['mode'] === EvaluationMode.DETERMINISTIC_ONLY);
    assert.equal(deterministic?.['disagreementWithDeterministicBaseline'], 0);
  });

  it('records no latency figure, because a stub cannot measure a service', async () => {
    const report = await buildEvaluationReport();
    assert.equal(JSON.stringify(report['metrics']).toLowerCase().includes('latency'), false);
    assert.match(String(report['note']), /simulated by stubs/);
  });
});
