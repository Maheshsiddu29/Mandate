/**
 * The human-readable form of a transcript: `npm run demo:judge`. One line
 * per event, grouped by scene; the verifier checklist of the first run is
 * spelled out. Pure: it renders what the transcript says.
 */

import { SCENES, type JudgeEvent } from './events.ts';
import type { JudgeTranscript } from './orchestrator.ts';

const MARK: { readonly [status: string]: string } = { BLOCKED: '✗', REFUSED: '✗', CONFLICT: '!', NEGOTIATING: '~', REDUCED: '~', RELEASED: '~', REALLOCATED: '~', ACCEPTED: '✓', VERIFIED: '✓', RESERVED: '✓', AUTHORIZED: '✓', ADMISSIBLE: '✓', ACTIVE: '✓', COMPROMISED: '!' };

function checklist(e: JudgeEvent): string[] {
  const items = e.data['checklist'];
  if (!Array.isArray(items)) return [];
  return items.map((i) => {
    const o = i as { readonly result?: unknown; readonly check?: unknown; readonly source?: unknown };
    return `        ${o.result === 'PASS' ? '✓' : '✗'} ${String(o.check)}  [${String(o.source)}]`;
  });
}

export function renderText(t: JudgeTranscript): string {
  const out: string[] = [];
  out.push('Mandate — judge demo (MANDATE_JUDGE_DEMO.V1). Offline, deterministic, no transaction.');
  out.push('Agents propose. Agents negotiate. Mandate authorizes. Markets settle.   VALID AGENT != VALID ACTION');
  let scene = 0;
  let checklistShown = false;
  for (const e of t.events) {
    if (e.scene !== scene) {
      scene = e.scene;
      out.push('');
      out.push(`— Scene ${scene}: ${SCENES.find((s) => s.scene === scene)?.title ?? ''} —`);
    }
    out.push(`  ${String(e.sequence).padStart(3)} ${MARK[e.status] ?? '·'} ${e.kind.padEnd(31)} ${e.message}`);
    if (e.kind === 'VERIFIER_CHECKLIST' && !checklistShown) {
      out.push(...checklist(e));
      checklistShown = true;
    }
  }
  out.push('');
  out.push(`${t.events.length} events · presentation digest ${t.presentationDigest} (presentation only; the protocol commitments are the receipt digests above)`);
  return `${out.join('\n')}\n`;
}
