/**
 * The yield agent: choose among vaults by **advertised** APY — a quote,
 * never a guarantee — and the deposit capacity each has left. Labelled
 * fixtures:
 *
 * | id | issuer | advertised APY | capacity |
 * | --- | --- | ---: | ---: |
 * | `alpha-usd-vault` | Alpha vault issuer (reviewed) | 5.20 % | 800 |
 * | `beta-usd-vault` | Beta vault issuer (reviewed) | 6.10 % | 400 |
 * | `high-yield-usd` | HighYield Partners | 12.60 % | 800 |
 *
 * Alpha and Beta are both inside the reviewed scope: one takes more, the
 * other pays more. The highest figure belongs to a vault from another
 * issuer; product, issuer, representation and venue are Mandate's to check.
 */

import { APPROVED_VAULT, BETA_VAULT, PRINCIPAL_ON_ARBITRUM, UNVETTED_VAULT } from '@mandate/portfolio/demo';
import { NO_CLAIMS, USDC, type DomainAgentSpec, type TrustedCandidate } from './spec.ts';

function vault(id: string, product: string, apyBps: number, name: string, issuer: string, capacityWhole: bigint): TrustedCandidate {
  return {
    id,
    role: 'yield',
    title: `${name} deposit`,
    facts: [
      { label: 'Vault', value: name },
      { label: 'Issuer', value: issuer },
      { label: 'Advertised APY', value: `${(apyBps / 100).toFixed(2)} % (quoted, not guaranteed; fixture)` },
      { label: 'Deposit capacity', value: `${capacityWhole} USDC remaining (fixture)` },
      { label: 'Contract', value: `…${product.slice(-4)}` },
    ],
    untrustedText: null,
    marketEvidence: 'FIXTURE',
    minAtoms: USDC(100n),
    maxAtoms: USDC(capacityWhole),
    resizable: true,
    build: (size, observedAt) => ({ kind: 'YIELD_DEPOSIT', product, amount: size, quotedApyBps: apyBps, quoteObservedAt: observedAt, recipient: PRINCIPAL_ON_ARBITRUM, claims: NO_CLAIMS }),
  };
}

export const YIELD_AGENT: DomainAgentSpec = {
  role: 'yield',
  objective: 'Deposit USDC into the supplied vault that best serves the portfolio, weighing advertised return against deposit capacity, or abstain. Advertised APY is a quote, not a guarantee.',
  candidates: [
    vault('alpha-usd-vault', APPROVED_VAULT, 520, 'Alpha USD Vault', 'Alpha vault issuer', 800n),
    vault('beta-usd-vault', BETA_VAULT, 610, 'Beta USD Vault', 'Beta vault issuer', 400n),
    vault('high-yield-usd', UNVETTED_VAULT, 1_260, 'High-Yield USD', 'HighYield Partners', 800n),
  ],
};
