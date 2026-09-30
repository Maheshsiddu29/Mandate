/**
 * The browser singleton. Next bundles the generated JSON at build time.
 * Node tests construct `JudgeDemoProvider` from the file directly so they
 * do not depend on a JSON import attribute.
 */

import asset from '../../generated/judge-demo.v1.json';
import { JudgeDemoProvider } from './judge-demo-provider.ts';
import { validateTranscript } from './transcript.ts';

export const judgeDemoProvider = new JudgeDemoProvider(validateTranscript(asset));
