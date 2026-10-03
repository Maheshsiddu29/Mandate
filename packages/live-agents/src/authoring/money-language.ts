/**
 * Deterministic money and share language for the C2.0 mandate compiler.
 *
 * Canonical money is USDC atoms via `parseUsdc` / `usdcText` — never a float.
 * Percentages and halves resolve only when a base total is known; otherwise
 * the caller records AMBIGUOUS and leaves the field unset.
 */

import { parseUsdc, usdcText } from '../types.ts';

const SCALE = 1_000_000n;

/** Words for whole US dollar amounts used in judge-style prompts. */
const WORD_AMOUNTS: { readonly [word: string]: bigint } = {
  zero: 0n,
  one: 1n,
  two: 2n,
  three: 3n,
  four: 4n,
  five: 5n,
  six: 6n,
  seven: 7n,
  eight: 8n,
  nine: 9n,
  ten: 10n,
  eleven: 11n,
  twelve: 12n,
  thirteen: 13n,
  fourteen: 14n,
  fifteen: 15n,
  twenty: 20n,
  thirty: 30n,
  forty: 40n,
  fifty: 50n,
  sixty: 60n,
  seventy: 70n,
  eighty: 80n,
  ninety: 90n,
  hundred: 100n,
  thousand: 1000n,
};

/**
 * Comma groups require at least one `,xxx` so "$2000" is not read as "$200".
 * A trailing comma after a bare integer is not part of the amount.
 */
export const MONEY_PATTERN = String.raw`\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k\b|thousand\b)?|(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k\b|thousand\b)?\s*(?:usd[c]?|dollars?)`;

/** Atoms from a MONEY_PATTERN match, or null. */
export function moneyFromMatch(m: RegExpExecArray, offset = 1): bigint | null {
  const digits = m[offset] ?? m[offset + 2];
  const k = m[offset + 1] ?? m[offset + 3];
  if (digits === undefined) return null;
  const atoms = parseUsdc(digits);
  if (atoms === null) return null;
  return k === undefined ? atoms : atoms * 1000n;
}

/** Decimal USDC text from a MONEY_PATTERN match. */
export function moneyTextFromMatch(m: RegExpExecArray, offset = 1): string | null {
  const atoms = moneyFromMatch(m, offset);
  return atoms === null ? null : usdcText(atoms);
}

/**
 * Parse a free money token such as "$800", "2k", "2500 dollars", "five hundred".
 * Scientific notation, negatives and unknown currencies return null.
 */
export function parseMoneyToken(raw: string): bigint | null {
  const t = raw.trim().toLowerCase().replace(/,/g, '');
  if (t === '' || t.includes('e') || t.startsWith('-')) return null;
  const direct = new RegExp(`^(?:${MONEY_PATTERN})$`, 'i').exec(t);
  if (direct !== null) return moneyFromMatch(direct);
  const bare = parseUsdc(t.replace(/^\$/, '').replace(/\s*(usd[c]?|dollars?)$/i, ''));
  if (bare !== null) return bare;
  const words = t.replace(/\$/g, '').replace(/\s*(usd[c]?|dollars?)\s*$/i, '').trim().split(/\s+/);
  if (words.length === 0 || words.some((w) => WORD_AMOUNTS[w] === undefined && w !== 'and')) return null;
  let total = 0n;
  let current = 0n;
  for (const w of words) {
    if (w === 'and') continue;
    const v = WORD_AMOUNTS[w] as bigint;
    if (v === 100n || v === 1000n) {
      current = (current === 0n ? 1n : current) * v;
      if (v === 1000n) {
        total += current;
        current = 0n;
      }
    } else current += v;
  }
  total += current;
  return total <= 0n ? null : total * SCALE;
}

export type ShareKind = { readonly kind: 'PERCENT'; readonly bps: bigint } | { readonly kind: 'HALF' } | { readonly kind: 'REMAINDER' };

/** "half", "25%", "the rest", "remaining capital", "everything left". */
export function parseShareLanguage(text: string): ShareKind | null {
  const t = text.toLowerCase();
  if (/\b(?:half|50\s*%|one half)\b/.test(t)) return { kind: 'HALF' };
  const pct = /\b(\d{1,2}(?:\.\d{1,2})?)\s*%/.exec(t);
  if (pct !== null) {
    const n = pct[1] as string;
    const [whole, frac = ''] = n.split('.') as [string, string | undefined];
    const fracPad = (frac + '00').slice(0, 2);
    const bps = BigInt(whole) * 100n + BigInt(fracPad);
    if (bps <= 0n || bps > 10_000n) return null;
    return { kind: 'PERCENT', bps };
  }
  if (/\b(?:the rest|remaining(?: capital)?|everything left|anything left|what(?:'s| is) left|remainder)\b/.test(t)) return { kind: 'REMAINDER' };
  return null;
}

/** Resolve a share against a known base in atoms; null when base missing or overflows. */
export function resolveShare(share: ShareKind, baseAtoms: bigint | null): bigint | null {
  if (baseAtoms === null || baseAtoms < 0n) return null;
  if (share.kind === 'HALF') return baseAtoms / 2n;
  if (share.kind === 'PERCENT') return (baseAtoms * share.bps) / 10_000n;
  return baseAtoms; // REMAINDER resolved by the caller against fixed sum
}

/** Exact USDC text, or null. */
export function atomsText(atoms: bigint | null): string | null {
  return atoms === null ? null : usdcText(atoms);
}
