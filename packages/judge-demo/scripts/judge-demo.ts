/**
 * `npm run demo:judge` — the judge demo, human-readable.
 * `npm run demo:judge:json` — the complete MANDATE_JUDGE_DEMO.V1 transcript a UI plays back.
 *
 * Offline and deterministic: the real Mandate code runs once against an
 * in-memory ledger; the recorded Phase 7E.3 evidence is read from the
 * repository. No network, no deployment, no transaction, no key printed.
 */

import { loadRobinhoodEvidence, renderText, runJudgeDemo } from '../src/index.ts';

const { transcript } = await runJudgeDemo({ evidence: loadRobinhoodEvidence() });
process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify(transcript, null, 2)}\n` : renderText(transcript));
