/**
 * Generates `docs/reason-codes.md` from the registry.
 *
 * Reason codes are a public interface (design section 10.3). A hand-maintained
 * table would drift from the code, and a drifted public interface is worse than
 * none, so the document is generated and `docs.test.ts` fails if the committed
 * file differs.
 *
 * Run: `npm run docs:generate`.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { REASON_CODES, ReasonFamily, type ReasonCodeDefinition } from '../../src/index.ts';

export const DOC_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/reason-codes.md');

const FAMILY_TITLES: Record<string, string> = {
  INPUT: 'INPUT — structural well-formedness',
  AUTH: 'AUTH — authorization scope',
  ASSET: 'ASSET — financial identity',
  REPR: 'REPR — representation semantics',
  ECON: 'ECON — economic bounds',
  STATE: 'STATE — observed market and corporate-action state',
  NET: 'NET — network and venue',
  TRUST: 'TRUST — trust-level violations',
};

function escape(s: string): string {
  return s.replace(/\|/g, '\\|');
}

export function renderReasonCodesDoc(): string {
  const byFamily = new Map<string, ReasonCodeDefinition[]>();
  for (const d of REASON_CODES) {
    const list = byFamily.get(d.family) ?? [];
    list.push(d);
    byFamily.set(d.family, list);
  }

  const lines: string[] = [];
  lines.push('# Reason-code registry');
  lines.push('');
  lines.push('> **Generated from `packages/kernel/src/reason-codes.ts`. Do not edit by hand.**');
  lines.push('> Run `npm run docs:generate` after changing the registry;');
  lines.push('> `packages/kernel/test/docs.test.ts` fails if this file drifts.');
  lines.push('');
  lines.push('Reason codes are a public interface: they appear in receipts, in integrator');
  lines.push('error handling, in the demo and in audit records');
  lines.push('([design §10.3](mandate-design.md#103-reason-codes)).');
  lines.push('');
  lines.push('## Rules');
  lines.push('');
  lines.push('- **Stable.** `id` and `name` are permanent. A retired code stays retired and');
  lines.push('  its id is never reused for a different meaning.');
  lines.push('- **One code per distinct cause.** There is no generic `INVALID`.');
  lines.push('- **Two messages.** `humanMessage` is safe to show an end user and leaks no');
  lines.push('  identifier, address or internal structure. `developerMessage` states the');
  lines.push('  condition precisely.');
  lines.push('- **Data, not strings built at a call site.** The verifier returns codes and');
  lines.push('  machine-readable detail; rendering is a separate layer (`explain.ts`), so it');
  lines.push('  can be replaced or localized without touching a safety decision.');
  lines.push('- **Every code is reachable.** A test asserts each one is actually produced by');
  lines.push('  some verification, so the registry cannot accumulate dead entries.');
  lines.push('');
  lines.push('`enforcementPoint` names the check family from');
  lines.push('[design §10.2](mandate-design.md#102-check-families) that produces the code,');
  lines.push('so this table doubles as a coverage map.');
  lines.push('');
  lines.push(`**${REASON_CODES.length} codes across ${byFamily.size} families.**`);
  lines.push('');

  for (const family of Object.values(ReasonFamily)) {
    const codes = byFamily.get(family);
    if (codes === undefined) continue;
    lines.push(`## ${FAMILY_TITLES[family] ?? family}`);
    lines.push('');
    lines.push('| ID | Name | Enforcement point | Condition |');
    lines.push('| --- | --- | --- | --- |');
    for (const d of [...codes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      lines.push(`| \`${d.id}\` | \`${d.name}\` | ${d.enforcementPoint} | ${escape(d.developerMessage)} |`);
    }
    lines.push('');
  }

  lines.push('## User-facing wording');
  lines.push('');
  lines.push('What an end user sees for each code. Produced by `explain()`, never by the');
  lines.push('verifier itself.');
  lines.push('');
  lines.push('| Name | Message |');
  lines.push('| --- | --- |');
  for (const d of [...REASON_CODES].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    lines.push(`| \`${d.name}\` | ${escape(d.humanMessage)} |`);
  }
  lines.push('');

  return `${lines.join('\n')}`;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\u0000')) {
  writeFileSync(DOC_PATH, renderReasonCodesDoc(), 'utf8');
  process.stdout.write(`wrote ${DOC_PATH}\n`);
}
