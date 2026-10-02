/**
 * Execution capability: whether the **active settlement profile** can carry
 * a candidate all the way to settlement.
 *
 * Two different questions, kept apart on purpose:
 *
 * | question | answered by | meaning |
 * | --- | --- | --- |
 * | policy: is the principal's agent allowed to do this? | eligibility.ts, then `screenProposal`, the Room, the verifier, the ledger | authority |
 * | capability: can the configured connector execute this? | this module | none — a fact about the connector |
 *
 * ```text
 * discovered ─▶ mandate-actionable (policy) ─▶ connector-capable (capability) ─▶ live executable ─▶ model
 * ```
 *
 * A candidate can be policy-valid and still unsupported by the connector
 * the lab is configured with. Before this module that was discovered only
 * after authorization, when settlement refused the reservation. Now it is
 * known before the model is asked, and an unsupported candidate is never
 * offered as an executable choice.
 *
 * **Capability is not authorization.** It never adds a candidate, never
 * changes one, and never relaxes a check: a capable candidate is screened,
 * negotiated, verified and reserved in full exactly as before. And it is
 * not the last word: settlement re-derives its own mapping from the reserved
 * candidate (`@mandate/live-settlement`, fixture-mapping.ts) and still
 * refuses anything it does not define with `FIXTURE_UNDEFINED_FOR_CANDIDATE`.
 *
 * The Live Lab profile settles one domain, Stock, through the Robinhood
 * Chain testnet fixture: the reviewed semantic NVDA notes are exercised as
 * a quantity-preserving BUY of the valueless MDEMO fixture for MDUSD. The
 * table below is the only list of candidates it supports, each named by
 * its exact candidate id **and** the exact representation its trusted
 * build produces; both must match one entry. Other domains are outside the
 * profile: their execution is the portfolio's offline fixture executors,
 * unchanged, and nothing presents them as testnet-settleable.
 */

import { validateActionCandidate } from '@mandate/portfolio';
import { STOCK_APPROVED, STOCK_SERIES_C } from '@mandate/portfolio/demo';
import type { Role } from '../types.ts';
import type { TrustedCandidate } from './spec.ts';

export type CapabilityStatus =
  /** The profile's connector for this domain can settle this exact candidate. */
  | 'SETTLEMENT_CAPABLE'
  /** The profile settles this domain, but not this candidate: never offered as executable. */
  | 'SETTLEMENT_UNSUPPORTED'
  /** The profile settles nothing in this domain; execution stays offline, as before. */
  | 'OUTSIDE_PROFILE';

export interface ExecutionCapability {
  readonly candidateId: string;
  readonly status: CapabilityStatus;
  readonly profile: string;
  /** The connector that settles this domain under the profile; null outside it. */
  readonly connector: string | null;
  /** Why it is not capable; null when it is. */
  readonly reason: string | null;
}

/** One semantic Stock candidate the Robinhood testnet fixture connector settles. */
export interface StockFixtureDefinition {
  readonly candidateId: string;
  /** The exact representation the candidate's trusted build produces. */
  readonly representation: string;
  /** What the model chose and Mandate reserved, in words. */
  readonly semantic: string;
}

export const ROBINHOOD_TESTNET_CONNECTOR = 'robinhood-testnet-fixture';

/** Every Stock candidate the testnet fixture connector supports. Nothing else settles. */
export const ROBINHOOD_TESTNET_STOCK_FIXTURES: readonly StockFixtureDefinition[] = [
  { candidateId: 'nvda-note-a', representation: STOCK_APPROVED as string, semantic: 'nvda-note-a — Fixture Backed NVIDIA Note (qualified-holder redemption)' },
  { candidateId: 'nvda-note-c', representation: STOCK_SERIES_C as string, semantic: 'nvda-note-c — Fixture Backed NVIDIA Note Series C (open redemption)' },
];

/** The definition naming exactly this candidate id and this representation, or null. Exact match only. */
export function stockFixtureFor(candidateId: string, representation: string): StockFixtureDefinition | null {
  return ROBINHOOD_TESTNET_STOCK_FIXTURES.find((d) => d.candidateId === candidateId && d.representation === representation) ?? null;
}

export interface SettlementProfile {
  readonly id: string;
  readonly description: string;
  /** The connector per domain; a domain without one is outside the profile. */
  readonly connectors: { readonly [R in Role]?: string };
  capabilityOf(role: Role, candidate: TrustedCandidate, now: bigint): ExecutionCapability;
}

const LIVE_LAB_PROFILE_ID = 'live-lab.robinhood-testnet-fixture.v1';
const LIVE_LAB_CONNECTORS: { readonly [R in Role]?: string } = { stock: ROBINHOOD_TESTNET_CONNECTOR };

export const LIVE_LAB_SETTLEMENT_PROFILE: SettlementProfile = {
  id: LIVE_LAB_PROFILE_ID,
  description: 'Stock settles on Robinhood Chain testnet through the valueless MDUSD → MDEMO fixture; other domains execute offline, unchanged.',
  connectors: LIVE_LAB_CONNECTORS,
  capabilityOf: (role, candidate, now) => {
    const at = (status: CapabilityStatus, connector: string | null, reason: string | null): ExecutionCapability => ({ candidateId: candidate.id, status, profile: LIVE_LAB_PROFILE_ID, connector, reason });
    const connector = LIVE_LAB_CONNECTORS[role];
    if (connector === undefined) return at('OUTSIDE_PROFILE', null, 'NO_SETTLEMENT_CONNECTOR_FOR_DOMAIN');
    // The representation is read off the candidate's own trusted build, never off its id or title. Fails closed.
    let built;
    try {
      built = validateActionCandidate(candidate.build(candidate.minAtoms, now));
    } catch {
      return at('SETTLEMENT_UNSUPPORTED', connector, 'CANDIDATE_NOT_BUILDABLE');
    }
    if (!built.ok || built.value.kind !== 'STOCK_BUY') return at('SETTLEMENT_UNSUPPORTED', connector, 'NOT_A_STOCK_BUY');
    return stockFixtureFor(candidate.id, built.value.representation) === null ? at('SETTLEMENT_UNSUPPORTED', connector, 'FIXTURE_UNDEFINED_FOR_CANDIDATE') : at('SETTLEMENT_CAPABLE', connector, null);
  },
};

export interface ExecutableUniverse {
  /** Mandate-actionable and not unsupported by the profile: what the model is offered, in the original order. */
  readonly executable: readonly TrustedCandidate[];
  /** The profile's verdict on every actionable candidate. */
  readonly capability: readonly ExecutionCapability[];
}

/**
 * Narrows mandate-actionable candidates to live-executable ones. `null`:
 * no settlement profile is active — a session that never settles — so
 * nothing is filtered and nothing is reported as settlement-capable.
 */
export function executableCandidates(profile: SettlementProfile | null, role: Role, actionable: readonly TrustedCandidate[], now: bigint): ExecutableUniverse {
  if (profile === null) return { executable: actionable, capability: [] };
  const capability = actionable.map((c) => profile.capabilityOf(role, c, now));
  return { executable: actionable.filter((_, i) => capability[i]?.status !== 'SETTLEMENT_UNSUPPORTED'), capability };
}
