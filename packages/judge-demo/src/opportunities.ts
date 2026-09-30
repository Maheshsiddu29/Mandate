/**
 * Scene 9's opportunity: the yield agent tops up its approved vault. The
 * same product, APY quote and recipient as its canonical approved deposit,
 * quoted just before `now`. Resizable down to the agent's own minimum.
 */

import type { ActionCandidateInput } from '@mandate/portfolio';
import { APPROVED_VAULT, PRINCIPAL_ON_ARBITRUM } from '@mandate/portfolio/demo';
import type { Opportunity } from './agents.ts';
import { QUOTE_LEAD_SECONDS } from './scenario.ts';

export function yieldDeposit(amount: bigint, now: bigint): ActionCandidateInput {
  return { kind: 'YIELD_DEPOSIT', product: APPROVED_VAULT, amount, quotedApyBps: 520, quoteObservedAt: now - QUOTE_LEAD_SECONDS, recipient: PRINCIPAL_ON_ARBITRUM, claims: { ticker: null, displayName: null, issuer: null, asset: null } };
}

export function yieldTopUp(atoms: bigint, minimum: bigint, now: bigint): Opportunity {
  return { name: 'yield/approved-5.20-top-up', at: (n) => yieldDeposit(n, now), size: atoms, minimum, resizable: true };
}
