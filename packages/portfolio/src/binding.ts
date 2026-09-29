/**
 * Domain bindings (portfolio-mandate.md §8, §12).
 *
 * The portfolio layer is domain-agnostic. A `DomainBinding` is how one domain
 * joins it: it resolves a candidate against that domain's trusted identity
 * data, maps a scope onto Core coverage terms, and maps a child authorization
 * onto one Core action for that domain's existing `DomainModule` and
 * enforcement adapter. A binding decides nothing: resolution produces facts
 * (or refusals when identity cannot be established), and every decision is
 * `permits`, the verifier's limits and then Core's.
 *
 * A new domain joins a portfolio by supplying a binding — no change to the
 * portfolio layer, Core or the Phase 6 gate.
 */

import type { Identifier } from '@mandate/kernel';
import type { AdapterRefInput, AuthorityTermInput, Digest32, DomainId, ResourceIdInput } from '@mandate/core';
import type { DomainModule, StateSourceConfigInput, SuppliedState } from '@mandate/control';
import type { ResolvedAction } from './authority.ts';
import type { ActionCandidate } from './candidate.ts';
import type { AgentPolicy, PortfolioMandate } from './mandate.ts';
import { reason, type Reason } from './reasons.ts';
import { resourceTable, type ResourceTable } from './resources.ts';
import type { ActionKind, AuthorityScope } from './scope.ts';

/** What kind of evidence stands behind an integration or an execution result (portfolio-mandate.md §15). */
export const EvidenceClass = { LIVE_TESTNET: 'LIVE_TESTNET', FIXTURE: 'FIXTURE', SIMULATED: 'SIMULATED', OFFCHAIN_ONLY: 'OFFCHAIN_ONLY' } as const;
export type EvidenceClass = (typeof EvidenceClass)[keyof typeof EvidenceClass];
export const EVIDENCE_CLASSES: readonly EvidenceClass[] = Object.values(EvidenceClass);

export interface ResolveContext {
  readonly mandate: PortfolioMandate;
  /** The proposing agent's policy: the registry evaluates representation admissibility against its scope. */
  readonly agent: AgentPolicy;
  readonly table: ResourceTable;
  readonly now: bigint;
}

/** The registry's verdict on one stock representation, carried into the receipt verbatim. */
export interface RepresentationDecisionRecord {
  readonly representation: Identifier;
  readonly status: 'ADMISSIBLE' | 'EXCLUDED';
  /** Registry reason codes, sorted, deduplicated. */
  readonly codes: readonly string[];
}

export type Resolution =
  | { readonly ok: true; readonly action: ResolvedAction; readonly registry: RepresentationDecisionRecord | null }
  | { readonly ok: false; readonly reasons: readonly Reason[]; readonly registry: RepresentationDecisionRecord | null };

/** The domain-specific part of one Core action; the envelope around it is built identically for every domain (compile.ts). */
export interface CoreAction {
  readonly actionType: string;
  readonly target: ResourceIdInput;
  readonly resources: readonly ResourceIdInput[];
  readonly payload: Uint8Array;
}

/** Core set members compiled from a scope: only instruments, venues and recipients the binding itself reviews. */
export interface CoreCoverage {
  readonly markets: readonly ResourceIdInput[];
  readonly venues: readonly ResourceIdInput[];
  readonly recipients: readonly ResourceIdInput[];
}

export interface DomainBinding {
  readonly domain: DomainId;
  readonly kind: ActionKind;
  readonly module: DomainModule;
  readonly adapter: AdapterRefInput;
  /** Every Core action type the binding emits, for `ACTION_TYPES` coverage. */
  readonly actionTypes: readonly string[];
  /** What evidence stands behind this integration. */
  readonly evidence: EvidenceClass;
  /** The integration, as an identifier for receipts and display. */
  readonly integration: Identifier;

  resolve(candidate: ActionCandidate, ctx: ResolveContext): Resolution;
  coverage(scope: AuthorityScope): CoreCoverage;
  /** Domain terms a delegation carries for this scope (the perps agent's `perp.max-leverage`). */
  delegationTerms(scope: AuthorityScope): readonly AuthorityTermInput[];
  /** The Core action for a candidate this binding resolved; `null` for one it cannot express. */
  coreAction(candidate: ActionCandidate, childDigest: Digest32): CoreAction | null;
  /** The trusted state a decision for this candidate reads, observed at `at`. */
  states(candidate: ActionCandidate, at: bigint): readonly SuppliedState[];
  sources(): readonly StateSourceConfigInput[];
}

/** The binding that serves a candidate kind, or a refusal: an action kind no binding serves cannot be resolved. */
export function bindingFor(bindings: readonly DomainBinding[], kind: ActionKind): DomainBinding | { readonly refused: Reason } {
  const matching = bindings.filter((b) => b.kind === kind);
  if (matching.length !== 1) return { refused: reason('INSTRUMENT_UNKNOWN', `binding:${kind}`) };
  return matching[0] as DomainBinding;
}

/** Resolve one candidate through the binding for its kind, against the proposing agent's policy. */
export function resolveCandidate(bindings: readonly DomainBinding[], m: PortfolioMandate, agent: AgentPolicy, candidate: ActionCandidate, now: bigint): Resolution {
  const b = bindingFor(bindings, candidate.kind);
  if ('refused' in b) return { ok: false, reasons: [b.refused], registry: null };
  return b.resolve(candidate, { mandate: m, agent, table: resourceTable(m.resources), now });
}
