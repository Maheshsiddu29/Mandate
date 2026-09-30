/**
 * `npm run web:demo:generate` — write the static judge-demo transcript.
 */

import { writeJudgeDemoAsset, JUDGE_DEMO_ASSET } from './judge-demo-asset.ts';

const transcript = writeJudgeDemoAsset();
process.stdout.write(
  `wrote ${JUDGE_DEMO_ASSET}\n${transcript.eventCount} events\n${transcript.presentationDigest}\n`,
);
