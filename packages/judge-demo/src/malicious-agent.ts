/**
 * The compromised agent's two actions (scenes 6 and 8).
 *
 * The attacker holds the swap agent's real key. Its strongest move that the
 * frozen swap domain can express is to keep everything about an approved
 * swap — router, pool, tokens, amount, quote, slippage — and change only who
 * is paid: the recipient becomes the attacker's account. Later the same key
 * signs the same swap paying the principal. Nothing here marks either
 * action as malicious or compliant: the Mandate code decides that.
 */

import type { ActionCandidate, ActionCandidateInput, AgentPolicy } from '@mandate/portfolio';
import { APPROVED_POOL, APPROVED_ROUTER, FIXTURE_USDC, PRINCIPAL_ON_ARBITRUM, WETH } from '@mandate/portfolio/demo';
import type { Opportunity } from './agents.ts';
import { jsonOf, type Json } from './events.ts';
import { ATTACKER_RECIPIENT, QUOTE_LEAD_SECONDS } from './scenario.ts';

const NO_CLAIMS = { ticker: null, displayName: null, issuer: null, asset: null };

/**
 * A swap of `amountIn` USDC atoms for WETH through the approved router and
 * pool, quoted the way the canonical swap agent quotes (120,000 WETH atoms
 * per USDC atom ×10⁻⁶, 30 bps below for the minimum), observed just before
 * `now`, paying `recipient`.
 */
export function swapCandidate(amountIn: bigint, now: bigint, recipient: string): ActionCandidateInput {
  return {
    kind: 'SWAP_EXACT_IN',
    router: APPROVED_ROUTER,
    route: [APPROVED_POOL],
    tokenIn: FIXTURE_USDC,
    tokenOut: WETH,
    amountIn,
    quotedOut: (amountIn * 120_000_000_000n) / 1_000_000n,
    minOut: (amountIn * 119_640_000_000n) / 1_000_000n,
    quoteObservedAt: now - QUOTE_LEAD_SECONDS,
    recipient,
    claims: NO_CLAIMS,
  };
}

export function maliciousSwap(amountIn: bigint, now: bigint): Opportunity {
  return { name: 'swap/approved-route-attacker-recipient', at: (n) => swapCandidate(n, now, ATTACKER_RECIPIENT), size: amountIn, minimum: amountIn, resizable: false };
}

export function compliantSwap(amountIn: bigint, now: bigint): Opportunity {
  return { name: 'swap/approved-route', at: (n) => swapCandidate(n, now, PRINCIPAL_ON_ARBITRUM), size: amountIn, minimum: amountIn, resizable: false };
}

export interface FieldChange {
  readonly field: string;
  /** What the agent's authority permits for this field, from its signed scope. */
  readonly expected: Json;
  readonly attempted: Json;
}

/**
 * The fields in which `attempted` differs from `reference`, with what the
 * agent's authority allows for each where its scope names the field.
 */
export function changedFields(reference: ActionCandidate, attempted: ActionCandidate, agent: AgentPolicy): readonly FieldChange[] {
  const a = jsonOf(reference) as { readonly [k: string]: Json };
  const b = jsonOf(attempted) as { readonly [k: string]: Json };
  const allowed: { readonly [field: string]: Json } = {
    recipient: [...agent.scope.recipients],
    router: [...agent.scope.venues],
    representation: [...agent.scope.representations],
    product: [...agent.scope.representations],
    collection: [...agent.scope.representations],
    market: [...agent.scope.representations],
  };
  const out: FieldChange[] = [];
  for (const k of Object.keys(b)) {
    if (JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;
    out.push({ field: k, expected: allowed[k] ?? a[k] ?? null, attempted: b[k] ?? null });
  }
  return out;
}
