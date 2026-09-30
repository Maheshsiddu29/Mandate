/**
 * `npm run web:demo:check` — fail if the committed transcript is stale.
 *
 * Regenerates through the canonical runner and compares bytes. It does not
 * update the asset.
 */

import { committedJudgeDemoAsset, runCanonicalTranscript } from './judge-demo-asset.ts';

const fresh = runCanonicalTranscript();
let committed: string;
try {
  committed = committedJudgeDemoAsset();
} catch {
  process.stderr.write('judge demo asset is missing; run npm run web:demo:generate\n');
  process.exit(1);
}
if (committed !== fresh.text) {
  process.stderr.write(
    `judge demo asset is stale\ncommitted digest check failed against a fresh run (${fresh.eventCount} events, ${fresh.presentationDigest})\nrun npm run web:demo:generate\n`,
  );
  process.exit(1);
}
process.stdout.write(`judge demo asset matches the runner (${fresh.eventCount} events, ${fresh.presentationDigest})\n`);
