import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseMandate, verify } from '@mandate/kernel';
import { deriveRequirements, evaluateRepresentation, openRegistry, registrySnapshotDigest } from '@mandate/registry';
import {
  MAINNET_CORPUS_PATH,
  MAINNET_REPORT_PATH,
  serializeMainnetCorpus,
  serializeMainnetReport,
} from '../scripts/generate-mainnet-replay.ts';

interface ReplayVector {
  readonly id: string;
  readonly stateClass: string;
  readonly registrySnapshot: unknown;
  readonly registryExpected: { readonly status: string; readonly reasonCodes: readonly string[]; readonly snapshotDigest: string };
  readonly input: Record<string, unknown>;
  readonly expected: { readonly decision: string; readonly reasonCodes: readonly string[]; readonly receiptDigest: string };
}

const corpus = JSON.parse(readFileSync(MAINNET_CORPUS_PATH, 'utf8')) as { vectorCount: number; vectors: ReplayVector[] };

describe('mainnet replay corpus', () => {
  it('matches the deterministic generator and report', () => {
    assert.equal(readFileSync(MAINNET_CORPUS_PATH, 'utf8'), serializeMainnetCorpus());
    assert.equal(readFileSync(MAINNET_REPORT_PATH, 'utf8'), serializeMainnetReport());
    assert.equal(corpus.vectorCount, 11);
  });

  it('runs every case through registry and unchanged kernel', () => {
    for (const vector of corpus.vectors) {
      const registry = openRegistry(vector.registrySnapshot);
      assert.ok(registry.ok, vector.id);
      assert.equal(registrySnapshotDigest(registry.value.snapshot), vector.registryExpected.snapshotDigest, `${vector.id}: snapshot digest`);
      const mandate = parseMandate(vector.input['mandate']);
      assert.ok(mandate.ok, vector.id);
      const clock = vector.input['clock'] as Record<string, unknown>;
      const nowRaw = clock['nowUnixSeconds'];
      assert.equal(typeof nowRaw, 'string');
      const requirements = deriveRequirements(mandate.value, { nowUnixSeconds: BigInt(nowRaw as string) });
      assert.ok(requirements.ok, vector.id);
      const candidate = vector.input['candidate'] as Record<string, unknown>;
      const decision = evaluateRepresentation(registry.value, requirements.value, candidate['representationId']);
      assert.equal(decision.status, vector.registryExpected.status, `${vector.id}: registry status`);
      assert.deepEqual(decision.status === 'EXCLUDED' ? decision.reasonCodes : [], vector.registryExpected.reasonCodes, `${vector.id}: registry reasons`);
      const receipt = verify(vector.input as never);
      assert.equal(receipt.decision, vector.expected.decision, `${vector.id}: decision`);
      assert.deepEqual([...receipt.reasonCodes].sort(), vector.expected.reasonCodes, `${vector.id}: reasons`);
      assert.equal(receipt.receiptDigest, vector.expected.receiptDigest, `${vector.id}: receipt`);
      assert.equal(verify(vector.input as never).receiptDigest, receipt.receiptDigest, `${vector.id}: deterministic replay`);
    }
  });

  it('labels every synthetic market mutation', () => {
    for (const vector of corpus.vectors) {
      if (vector.id.startsWith('synthetic-') || vector.id.startsWith('adversarial-')) {
        assert.equal(vector.stateClass, 'RECORDED_MAINNET_WITH_SYNTHETIC_MUTATION');
      }
    }
  });
});
