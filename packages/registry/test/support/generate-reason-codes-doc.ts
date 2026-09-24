/**
 * Generates `docs/registry-reason-codes.md` from the registry's code registry.
 *
 * Reason codes are a public interface (design section 10.3). A hand-maintained
 * table would drift from the code, and a drifted public interface is worse than
 * none, so the document is generated and `docs.test.ts` fails if the committed file
 * differs.
 *
 * Run: `npm run docs:generate`.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  REGISTRY_REASON_CODES,
  RegistryReasonFamily,
  type RegistryReasonCodeDefinition,
} from '../../src/index.ts';

export const REGISTRY_DOC_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/registry-reason-codes.md',
);

const FAMILY_TITLES: Record<string, string> = {
  REF: 'REF — human reference to canonical financial identity',
  REG: 'REG — registry state and representation admissibility',
};

function escape(s: string): string {
  return s.replace(/\|/g, '\\|');
}

export function renderRegistryReasonCodesDoc(): string {
  const byFamily = new Map<string, RegistryReasonCodeDefinition[]>();
  for (const d of REGISTRY_REASON_CODES) {
    const list = byFamily.get(d.family) ?? [];
    list.push(d);
    byFamily.set(d.family, list);
  }

  const lines: string[] = [];
  lines.push('# Registry reason-code registry');
  lines.push('');
  lines.push('> **Generated from `packages/registry/src/reason-codes.ts`. Do not edit by hand.**');
  lines.push('> Run `npm run docs:generate` after changing the registry;');
  lines.push('> `packages/registry/test/docs.test.ts` fails if this file drifts.');
  lines.push('');
  lines.push('Registry-layer causes: turning a human reference into a canonical financial');
  lines.push('identity, and deciding whether a tokenized representation may satisfy a mandate.');
  lines.push('');
  lines.push('## One vocabulary, two registries');
  lines.push('');
  lines.push('The kernel already names many of the causes a registry decision produces, and');
  lines.push('two overlapping vocabularies would be worse than one longer one. So:');
  lines.push('');
  lines.push('- where the kernel has a code with exactly this meaning, the registry emits');
  lines.push('  **the kernel\'s** code. Those live in [reason-codes.md](reason-codes.md) and are');
  lines.push('  listed below under [Reused kernel codes](#reused-kernel-codes).');
  lines.push('- causes that exist only at the registry layer get the codes in this document,');
  lines.push('  under their own `MND-REF-*` and `MND-REG-*` namespaces.');
  lines.push('- a test asserts the two registries share no id and no name, so "one vocabulary"');
  lines.push('  is a checked property rather than an intention.');
  lines.push('');
  lines.push('The same rules apply as in the kernel\'s registry: ids and names are permanent,');
  lines.push('one code per distinct cause, no generic `INVALID`, and `humanMessage` is safe to');
  lines.push('show an end user.');
  lines.push('');
  lines.push('`enforcementPoint` names the registry pipeline stage that produces the code, so');
  lines.push('this table doubles as a coverage map. The stages are the registry\'s own; the');
  lines.push('kernel\'s A–G families describe verification, not resolution.');
  lines.push('');
  lines.push(`**${REGISTRY_REASON_CODES.length} registry codes across ${byFamily.size} families**, plus the reused kernel codes below.`);
  lines.push('');

  for (const family of Object.values(RegistryReasonFamily)) {
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

  lines.push('## Reused kernel codes');
  lines.push('');
  lines.push('Emitted by registry decisions with their kernel meaning unchanged. Defined in');
  lines.push('[reason-codes.md](reason-codes.md).');
  lines.push('');
  lines.push('| Name | Registry meaning |');
  lines.push('| --- | --- |');
  for (const [name, meaning] of REUSED_KERNEL_CODES) {
    // Asserted against the kernel registry by the docs test, so this list cannot
    // name a code the kernel does not define.
    lines.push(`| \`${name}\` | ${escape(meaning)} |`);
  }
  lines.push('');

  lines.push('## User-facing wording');
  lines.push('');
  lines.push('What an end user sees for each registry code. A registry decision returns codes');
  lines.push('and machine-readable detail, never a rendered string.');
  lines.push('');
  lines.push('| Name | Message |');
  lines.push('| --- | --- |');
  for (const d of [...REGISTRY_REASON_CODES].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    lines.push(`| \`${d.name}\` | ${escape(d.humanMessage)} |`);
  }
  lines.push('');

  return `${lines.join('\n')}`;
}

/** Kernel codes a registry decision emits, and what they mean at this layer. */
export const REUSED_KERNEL_CODES: readonly [string, string][] = [
  ['REPRESENTATION_UNKNOWN', 'The representation is not in this registry snapshot. An unregistered contract is never admissible, whatever its ticker, symbol or token metadata claims.'],
  ['REPRESENTATION_ASSET_MISMATCH', 'The representation establishes a different canonical underlying than the requirements name.'],
  ['ISSUER_NOT_ALLOWED', 'The established issuer is not in the permitted issuer set.'],
  ['CHAIN_NOT_ALLOWED', 'The representation chain, read from its identity, is not in the permitted chain set.'],
  ['SYNTHETIC_NOT_ALLOWED', 'The established backing model is synthetic and the mandate forbids synthetic exposure.'],
  ['REPRESENTATION_INACTIVE', 'The established operational status is not ACTIVE.'],
  ['REPRESENTATION_METADATA_UNKNOWN', 'A constrained property has no claims at all. Distinct from a property whose only claims are below the trust floor, which is TRUST_REQUIREMENT_NOT_MET.'],
];

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\u0000')) {
  writeFileSync(REGISTRY_DOC_PATH, renderRegistryReasonCodesDoc(), 'utf8');
  process.stdout.write(`wrote ${REGISTRY_DOC_PATH}\n`);
}