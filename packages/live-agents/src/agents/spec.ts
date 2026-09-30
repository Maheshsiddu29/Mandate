/**
 * What a domain agent is: an objective and a closed set of trusted
 * candidates.
 *
 * A `TrustedCandidate` is built by local code from the Phase 7F
 * demonstration markets (labelled fixtures). Its `build` is the only way a
 * model's choice becomes an action candidate: the router, the contract, the
 * recipient and the quote time all come from these local tables, never from
 * the model. The model sees `view()` — an id, facts, untrusted seller text
 * and bounds — and returns an id and an amount.
 *
 * Nothing here says which candidates Mandate will allow. Some are outside
 * the principal's authority on purpose, because real agents meet such
 * opportunities; Mandate decides, independently.
 */

import type { ActionCandidateInput } from '@mandate/portfolio';
import type { CandidateView, FactView } from '../runtime/provider.ts';
import type { Role } from '../types.ts';

export interface TrustedCandidate {
  readonly id: string;
  readonly role: Role;
  readonly title: string;
  readonly facts: readonly FactView[];
  /** Third-party text shown to the model as untrusted data. Never read by trusted code. */
  readonly untrustedText: string | null;
  readonly minAtoms: bigint;
  readonly maxAtoms: bigint;
  readonly resizable: boolean;
  /** The exact candidate at `sizeAtoms` of USDC notional, quoted at `observedAt`. */
  build(sizeAtoms: bigint, observedAt: bigint): ActionCandidateInput;
}

export interface DomainAgentSpec {
  readonly role: Role;
  readonly objective: string;
  readonly candidates: readonly TrustedCandidate[];
}

export const NO_CLAIMS = { ticker: null, displayName: null, issuer: null, asset: null } as const;
export const USDC = (whole: bigint): bigint => whole * 1_000_000n;

export function viewOf(c: TrustedCandidate, advisoryRank: number | null = null): CandidateView {
  return { id: c.id, title: c.title, facts: c.facts, untrustedText: c.untrustedText, minAtoms: c.minAtoms.toString(), maxAtoms: c.maxAtoms.toString(), resizable: c.resizable, advisoryRank };
}

/** Exact lookup: the only way a returned id becomes a candidate. */
export function candidateById(spec: DomainAgentSpec, id: string): TrustedCandidate | null {
  return spec.candidates.find((c) => c.id === id) ?? null;
}
