/**
 * The charge plan: already-derived quantitative demand for one reservation.
 *
 * Phase 7D's domain modules will produce it from an action and admitted state
 * (`contributions(action, S)`, action-state-model.md §8). 7C tests build it
 * directly. It contains only what the ledger needs, and nothing a domain
 * module owns: no side, strike, route, health factor or outcome.
 *
 * ```text
 * ChargePlan {
 *   principal, authority (the acting leaf), actor,
 *   action, generation            → ReservationId = H(action, generation)
 *   module, implementation        the exact semantic module and the conforming implementation (DOM-2)
 *   contributions[]               { quantity: EconomicQuantity, market?, account?, required }
 * }
 * ```
 *
 * What a plan deliberately cannot say is *where* to charge. There is no
 * target, no dimension name and no node list: the ledger derives the complete
 * charging path — every matching dimension of every node on the lineage, then
 * of the principal policy — from the principal, the leaf and each
 * contribution's measure and scope (authority-ledger.md §3, §6). A caller
 * therefore cannot skip an ancestor or the policy.
 *
 * A contribution's scope attributes are its quantity's asset, the market and
 * account it names, and the domain of the plan's module. The domain is not a
 * field: it is the module's, so a contribution cannot claim a domain its
 * module does not interpret.
 *
 * 7C admits only positive, ledger-trackable magnitudes. A signed contribution
 * (a `NET` position leg) needs the `NET` sign mode, which is not implemented.
 */

import { ok, type ByteWriter } from '@mandate/kernel';
import {
  QUANTITY_KIND_RULES,
  at,
  checkArray,
  checkFields,
  moduleRefInputOf,
  parseDigest,
  parseNonZeroDigest,
  parseReservationGeneration,
  partyIdInputOf,
  quantityInputOf,
  readModuleRefInput,
  readNullable,
  readPartyInput,
  readQuantityInput,
  readResourceIdInput,
  reservationIdFor,
  resourceIdInputOf,
  validateAgentId,
  validateModuleRef,
  validatePrincipalId,
  validateQuantity,
  validateResourceId,
  writeDigest,
  writeFlag,
  writeModuleRef,
  writeNullable,
  writeParty,
  writeQuantityBody,
  writeResourceId,
  type AccountId,
  type ActionId,
  type AgentId,
  type AuthorityId,
  type CoreReader,
  type EconomicQuantity,
  type EconomicQuantityInput,
  type ImplementationDigest,
  type IntegerInput,
  type MarketId,
  type ModuleRef,
  type ModuleRefInput,
  type PartyIdInput,
  type PrincipalId,
  type ReservationGeneration,
  type ReservationId,
  type ResourceId,
  type ResourceIdInput,
  type Tagged,
} from '@mandate/core';
import { malformed, refuse, type LedgerResult } from './errors.ts';
import { MAX_PLAN_CONTRIBUTIONS } from './limits.ts';

export interface ContributionInput {
  readonly quantity: EconomicQuantityInput;
  readonly market: ResourceIdInput | null;
  readonly account: ResourceIdInput | null;
  /** Moves principal resources out of direct control: must match a lineage dimension (LEDGER-5). */
  readonly required: boolean;
}

export type Contribution = Tagged<
  {
    readonly quantity: EconomicQuantity;
    readonly market: MarketId | null;
    readonly account: AccountId | null;
    readonly required: boolean;
  },
  'Contribution'
>;

export interface ChargePlanInput {
  readonly principal: PartyIdInput;
  readonly authority: string;
  readonly actor: PartyIdInput;
  readonly action: string;
  readonly generation: IntegerInput;
  readonly module: ModuleRefInput;
  readonly implementation: string;
  readonly contributions: readonly ContributionInput[];
}

export type ChargePlan = Tagged<
  {
    readonly principal: PrincipalId;
    readonly authority: AuthorityId;
    readonly actor: AgentId;
    readonly action: ActionId;
    /** Explicit and ≥ 1; never defaulted (Phase 6R.1b, RECON-2). */
    readonly generation: ReservationGeneration;
    readonly module: ModuleRef;
    readonly implementation: ImplementationDigest;
    /** Ordered: accounting events address contributions by index. */
    readonly contributions: readonly Contribution[];
  },
  'ChargePlan'
>;

function validateContribution(input: ContributionInput, path: string): LedgerResult<Contribution> {
  const shape = checkFields(input, ['quantity', 'market', 'account', 'required'], path);
  if (!shape.ok) return malformed(shape.error, path);
  const quantity = validateQuantity(input.quantity, at(path, 'quantity'));
  if (!quantity.ok) return malformed(quantity.error, path);
  const q = quantity.value;
  // Decision 10: floating values are invariants, not counters; unrealized PnL is valued at a mark.
  if (!QUANTITY_KIND_RULES[q.kind].ledgerTrackable || (q.kind === 'PNL' && q.valuation !== null)) {
    return refuse('CONTRIBUTION_INVALID', at(path, 'quantity.kind'));
  }
  // A zero demand is not a demand, and a negative one needs the NET sign mode (not implemented).
  if (q.atoms <= 0n) return refuse('CONTRIBUTION_INVALID', at(path, 'quantity.atoms'));
  let market: MarketId | null = null;
  if (input.market !== null) {
    const m = validateResourceId(input.market, ['MARKET'] as const, at(path, 'market'));
    if (!m.ok) return malformed(m.error, path);
    market = m.value;
  }
  let account: AccountId | null = null;
  if (input.account !== null) {
    const a = validateResourceId(input.account, ['ACCOUNT'] as const, at(path, 'account'));
    if (!a.ok) return malformed(a.error, path);
    account = a.value;
  }
  if (typeof input.required !== 'boolean') return malformed({ code: 'WRONG_TYPE', path: at(path, 'required') }, path);
  return ok({ quantity: q, market, account, required: input.required } as Contribution);
}

export function validateChargePlan(input: ChargePlanInput, path = 'plan'): LedgerResult<ChargePlan> {
  const shape = checkFields(input, ['principal', 'authority', 'actor', 'action', 'generation', 'module', 'implementation', 'contributions'], path);
  if (!shape.ok) return malformed(shape.error, path);
  const principal = validatePrincipalId(input.principal, at(path, 'principal'));
  if (!principal.ok) return malformed(principal.error, path);
  const authority = parseDigest<AuthorityId>(input.authority, at(path, 'authority'));
  if (!authority.ok) return malformed(authority.error, path);
  const actor = validateAgentId(input.actor, at(path, 'actor'));
  if (!actor.ok) return malformed(actor.error, path);
  const action = parseDigest<ActionId>(input.action, at(path, 'action'));
  if (!action.ok) return malformed(action.error, path);
  const generation = parseReservationGeneration(input.generation, at(path, 'generation'));
  if (!generation.ok) return malformed(generation.error, path);
  const module = validateModuleRef(input.module, at(path, 'module'));
  if (!module.ok) return malformed(module.error, path);
  const implementation = parseNonZeroDigest<ImplementationDigest>(input.implementation, at(path, 'implementation'));
  if (!implementation.ok) return malformed(implementation.error, path);
  const cp = at(path, 'contributions');
  const arr = checkArray(input.contributions, MAX_PLAN_CONTRIBUTIONS, cp);
  if (!arr.ok) return malformed(arr.error, path);
  if (input.contributions.length === 0) return malformed({ code: 'COLLECTION_EMPTY', path: cp }, path);
  const contributions: Contribution[] = [];
  for (let i = 0; i < input.contributions.length; i += 1) {
    const c = validateContribution(input.contributions[i] as ContributionInput, at(cp, i));
    if (!c.ok) return c;
    contributions.push(c.value);
  }
  return ok({
    principal: principal.value,
    authority: authority.value,
    actor: actor.value,
    action: action.value,
    generation: generation.value,
    module: module.value,
    implementation: implementation.value,
    contributions: contributions as readonly Contribution[],
  } as ChargePlan);
}

export function planReservationId(p: ChargePlan): ReservationId {
  return reservationIdFor(p.action, p.generation);
}

function writeContribution(w: ByteWriter, c: Contribution): void {
  writeQuantityBody(w, c.quantity);
  writeNullable<ResourceId>(w, c.market, writeResourceId);
  writeNullable<ResourceId>(w, c.account, writeResourceId);
  writeFlag(w, c.required);
}

function readContributionInput(r: CoreReader): ContributionInput {
  const quantity = readQuantityInput(r);
  const market = readNullable(r, readResourceIdInput);
  const account = readNullable(r, readResourceIdInput);
  const required = r.flag();
  return { quantity, market, account, required };
}

export function writeChargePlan(w: ByteWriter, p: ChargePlan): void {
  writeParty(w, p.principal);
  writeDigest(w, p.authority);
  writeParty(w, p.actor);
  writeDigest(w, p.action);
  w.u64(p.generation);
  writeModuleRef(w, p.module);
  writeDigest(w, p.implementation);
  w.u16(p.contributions.length);
  for (const c of p.contributions) writeContribution(w, c);
}

export function readChargePlanInput(r: CoreReader): ChargePlanInput {
  const principal = readPartyInput(r);
  const authority = r.digest();
  const actor = readPartyInput(r);
  const action = r.digest();
  const generation = r.u64();
  const module = readModuleRefInput(r);
  const implementation = r.digest();
  // Ordered, not a set: contributions are addressed by index.
  const contributions = r.list(MAX_PLAN_CONTRIBUTIONS, readContributionInput, false);
  return { principal, authority, actor, action, generation, module, implementation, contributions };
}

export function contributionInputOf(c: Contribution): ContributionInput {
  return {
    quantity: quantityInputOf(c.quantity),
    market: c.market === null ? null : resourceIdInputOf(c.market),
    account: c.account === null ? null : resourceIdInputOf(c.account),
    required: c.required,
  };
}

export function chargePlanInputOf(p: ChargePlan): ChargePlanInput {
  return {
    principal: partyIdInputOf(p.principal),
    authority: p.authority,
    actor: partyIdInputOf(p.actor),
    action: p.action,
    generation: p.generation,
    module: moduleRefInputOf(p.module),
    implementation: p.implementation,
    contributions: p.contributions.map(contributionInputOf),
  };
}
