/** One judge demo run per test file, over the recorded Phase 7E.3 evidence. */

import { loadRobinhoodEvidence, runJudgeDemo, type JudgeDemo } from '../../src/index.ts';

export function judgeDemo(): Promise<JudgeDemo> {
  return runJudgeDemo({ evidence: loadRobinhoodEvidence() });
}
