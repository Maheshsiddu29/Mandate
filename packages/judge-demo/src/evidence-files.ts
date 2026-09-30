/**
 * The only filesystem access in this package: reading the committed Phase
 * 7E.3 records, read-only. No network, no key file, no environment.
 */

import { readFileSync } from 'node:fs';
import { robinhoodEvidenceFrom, type RobinhoodLiveEvidence } from './evidence.ts';

/** Repository-relative paths of the recorded evidence. */
export const ROBINHOOD_EVIDENCE_FILES = {
  manifest: 'docs/phase-7e/deployment-manifest.json',
  receipt: 'docs/phase-7e/robinhood-demo-receipt.json',
} as const;

const REPOSITORY = new URL('../../../', import.meta.url);

/** The recorded Phase 7E.3 evidence; throws, naming every problem, if it cannot be shown as LIVE_TESTNET. */
export function loadRobinhoodEvidence(root: URL = REPOSITORY): RobinhoodLiveEvidence {
  const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
  const r = robinhoodEvidenceFrom(read(ROBINHOOD_EVIDENCE_FILES.manifest), read(ROBINHOOD_EVIDENCE_FILES.receipt));
  if (!r.ok) throw new Error(`recorded Phase 7E.3 evidence refused:\n${r.error.join('\n')}`);
  return r.value;
}
