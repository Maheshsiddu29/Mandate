/**
 * Shared vocabulary of the Live AI Lab (docs/demo/live-ai-lab.md).
 *
 * Nothing here carries authority. Roles name the five demonstration
 * agents; runtime states describe what a *model call* did, which is a
 * different question from what Mandate decided about the resulting
 * proposal — a timeout is never a refusal, and a refusal is never a
 * runtime failure.
 */

export const ROLES = ['stock', 'swap', 'nft', 'yield', 'perps'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: { readonly [R in Role]: string } = {
  stock: 'Stock Agent',
  swap: 'Swap Agent',
  nft: 'NFT Agent',
  yield: 'Yield Agent',
  perps: 'Perps Agent',
};

export function isRole(x: unknown): x is Role {
  return typeof x === 'string' && (ROLES as readonly string[]).includes(x);
}

/**
 * What an agent's model call and its proposal went through. `STALE` is a
 * reply that arrived for a context that no longer applies (a superseded
 * mandate, an earlier Room generation, a finalized Room).
 */
export const AGENT_RUNTIME_STATES = [
  'PENDING',
  'RESPONDING',
  'RESPONDED',
  'ABSTAINED',
  'TIMED_OUT',
  'FAILED',
  'INVALID_RESPONSE',
  'STALE',
  'SIGNED',
  'BLOCKED',
  'ADMISSIBLE',
] as const;
export type AgentRuntimeState = (typeof AGENT_RUNTIME_STATES)[number];

/** Six-decimal USDC atoms, the unit every portfolio resource in the demonstration uses. */
export const USDC_DECIMALS = 6;
const SCALE = 10n ** BigInt(USDC_DECIMALS);

/** Exact decimal text of USDC atoms: `1234500000n` → `"1234.5"`. Never a float. */
export function usdcText(atoms: bigint): string {
  const negative = atoms < 0n;
  const a = negative ? -atoms : atoms;
  const whole = a / SCALE;
  const frac = (a % SCALE).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac === '' ? '' : `.${frac}`}`;
}

/**
 * USDC atoms of a decimal amount such as `"2,000"`, `"$400"` or `"12.5"`;
 * `null` for anything else (negative, more than six decimals, not a number).
 */
export function parseUsdc(text: string): bigint | null {
  const t = text.trim().replace(/^\$/, '').replace(/,/g, '');
  const m = /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(t);
  if (m === null) return null;
  return BigInt(m[1] as string) * SCALE + BigInt((m[2] ?? '').padEnd(USDC_DECIMALS, '0'));
}

/** A small safe integer from decimal text, or `null`. */
export function parseCount(text: string, max: number): number | null {
  const t = text.trim();
  if (!/^\d{1,9}$/.test(t)) return null;
  const n = Number(t);
  return n <= max ? n : null;
}

/** An integer string of atoms, as models must return them. */
export const ATOMS_PATTERN = '^(0|[1-9][0-9]{0,30})$';
const ATOMS = new RegExp(ATOMS_PATTERN);

export function parseAtoms(text: unknown): bigint | null {
  return typeof text === 'string' && ATOMS.test(text) ? BigInt(text) : null;
}
