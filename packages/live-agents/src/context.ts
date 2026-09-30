/**
 * Trusted context construction: what each model is shown.
 *
 * Built from the active mandate and the ledger's availability — both
 * trusted — and projected into plain JSON. It contains the agent's own
 * authority and bounded portfolio figures; never a key, never another
 * agent's authority, never an address the model could return.
 */

import { agentPolicyOf, amountOf, type ResourceVector } from '@mandate/portfolio';
import { demoParty } from '@mandate/portfolio/demo';
import type { ActiveMandate } from './authoring/mandate-versioning.ts';
import { AGENT_DOMAINS, EXPOSURE_RESOURCE } from './authoring/catalog.ts';
import { availabilityAt } from './mandate/portfolio-adapter.ts';
import type { AuthorityView, PortfolioView } from './runtime/provider.ts';
import { ROLES, usdcText, type Role } from './types.ts';

export interface AmountView {
  readonly resource: string;
  readonly atoms: string;
  /** Exact decimal USDC text. */
  readonly amount: string;
}

export function amountViews(v: ResourceVector): readonly AmountView[] {
  return v.map((a) => ({ resource: a.resource, atoms: a.atoms.toString(), amount: usdcText(a.atoms) }));
}

export function enabledRoles(active: ActiveMandate): readonly Role[] {
  return ROLES.filter((r) => agentPolicyOf(active.mandate, demoParty(r)) !== null);
}

export function authorityView(active: ActiveMandate, role: Role): AuthorityView {
  const policy = agentPolicyOf(active.mandate, demoParty(role));
  const exposureResource = EXPOSURE_RESOURCE[role];
  const exposure = policy === null || exposureResource === null ? undefined : policy.hardMaxima.find((h) => h.resource === exposureResource);
  const lev = policy?.scope.maxLeverage ?? null;
  return {
    role,
    mandateVersion: active.version,
    domain: AGENT_DOMAINS[role],
    maxAllocationAtoms: (policy === null ? 0n : amountOf(policy.hardMaxima, 'portfolio-notional')).toString(),
    exposure: exposure === undefined || exposureResource === null ? null : { resource: exposureResource, atoms: exposure.atoms.toString() },
    maxLeverage: lev === null ? null : lev.scale === 0 ? `${lev.numerator}` : `${lev.numerator / 10n ** BigInt(lev.scale)}.${(lev.numerator % 10n ** BigInt(lev.scale)).toString().padStart(lev.scale, '0')}`,
    maxSlippageBps: policy?.scope.maxSlippageBps ?? null,
    maxQuoteAgeSeconds: policy?.scope.maxQuoteAgeSeconds?.toString() ?? null,
  };
}

export async function portfolioView(active: ActiveMandate, now: bigint): Promise<PortfolioView> {
  const av = await availabilityAt(active.core, now);
  return {
    deployableAtoms: amountOf(active.mandate.limits, 'portfolio-notional').toString(),
    availableAtoms: amountOf(av.portfolio, 'portfolio-notional').toString(),
    enabledAgents: enabledRoles(active),
  };
}
