/**
 * The yield agent: choose among vaults by **advertised** APY — a quote,
 * never a guarantee. The higher figure belongs to a vault from another
 * issuer; product, issuer, representation and venue are Mandate's to check.
 */

import { APPROVED_VAULT, PRINCIPAL_ON_ARBITRUM, UNVETTED_VAULT } from '@mandate/portfolio/demo';
import { NO_CLAIMS, USDC, type DomainAgentSpec, type TrustedCandidate } from './spec.ts';

function vault(id: string, product: string, apyBps: number, name: string, issuer: string): TrustedCandidate {
  return {
    id,
    role: 'yield',
    title: `${name} deposit`,
    facts: [
      { label: 'Vault', value: name },
      { label: 'Issuer', value: issuer },
      { label: 'Advertised APY', value: `${(apyBps / 100).toFixed(2)} % (quoted, not guaranteed)` },
      { label: 'Contract', value: `…${product.slice(-4)}` },
    ],
    untrustedText: null,
    minAtoms: USDC(100n),
    maxAtoms: USDC(800n),
    resizable: true,
    build: (size, observedAt) => ({ kind: 'YIELD_DEPOSIT', product, amount: size, quotedApyBps: apyBps, quoteObservedAt: observedAt, recipient: PRINCIPAL_ON_ARBITRUM, claims: NO_CLAIMS }),
  };
}

export const YIELD_AGENT: DomainAgentSpec = {
  role: 'yield',
  objective: 'Deposit USDC into the yield opportunity with the best advertised return among the supplied vaults, or abstain. Advertised APY is a quote, not a guarantee.',
  candidates: [vault('alpha-usd-vault', APPROVED_VAULT, 520, 'Alpha USD Vault', 'Alpha vault issuer'), vault('high-yield-usd', UNVETTED_VAULT, 1_260, 'High-Yield USD', 'HighYield Partners')],
};
