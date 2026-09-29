/**
 * Resource reservation through the unchanged control engine
 * (portfolio-mandate.md §12).
 *
 * There is no portfolio ledger. A compiled portfolio is registered in the
 * principal's ordinary Core ledger; each child authorization is reserved by
 * `ControlEngine.authorizeAndReserve` — the ledger's one atomic
 * compare-and-swap, which checks every leg (the agent's own dimension and the
 * root's portfolio-wide one) against the committed state it writes to. Five
 * agents racing for one pool therefore cannot oversubscribe it, whatever the
 * room or the verifier believed.
 *
 * The reservation lifecycle is the ledger's:
 *
 * | portfolio state | evidence |
 * | --- | --- |
 * | RESERVED | an ACTIVE ledger reservation of the child's action |
 * | ADMITTED | an ADMIT_ATTEMPT for it, naming the exact artifact |
 * | CLOSED | a NEVER_ISSUED close (the only release Core has without reconciliation) |
 *
 * Settlement reconciliation (consume, release on observed outcomes) is not
 * built, as in Phase 7E.3: an executed reservation stays ACTIVE.
 *
 * `checkBeforeSign` is the portfolio's own gate in front of any principal or
 * custody key: the child is one the verifier derived, the action is exactly
 * the one it compiles to, the reservation is active with exactly the approved
 * demand, and an attempt for it is durably committed.
 */

import { err, ok, type Result } from '@mandate/kernel';
import { actionId, authorityId, validateAdapterRef, type ActionId, type ExecutionAuthorizationId, type ReservationGeneration, type ReservationId } from '@mandate/core';
import {
  InMemoryLedgerStore,
  ReferenceAdapterRegistry,
  ReferenceModuleRegistry,
  attemptsOf,
  availableOf,
  nodeTargetKey,
  type AdapterRegistry,
  type AttemptId,
  type AttemptRecord,
  type InMemoryStoreHooks,
  type LedgerSnapshot,
  type LedgerState,
  type LedgerStore,
  type ModuleRegistry,
  type ReducerRules,
  type RetryPolicy,
} from '@mandate/ledger';
import { ControlEngine, ModuleCatalog, controlRules, type AuthorizationRecord, type AuthorizationRequest, type ControlRefusal } from '@mandate/control';
import type { ResourceAvailability } from './availability.ts';
import type { ActionCandidate } from './candidate.ts';
import { checkChildAuthorization, childAuthorizationDigest, type ChildAuthorizationDigest, type ChildExecutionAuthorization } from './child.ts';
import { compileAction, type CompiledPortfolio } from './compile.ts';
import { proposalDigest } from './proposal.ts';
import { canonicalReasons, reason, type Reason } from './reasons.ts';
import { demandOf, resourceTable, vectorsEqual, type Contribution, type ResourceAmount, type ResourceVector } from './resources.ts';
import { screenProposal } from './screen.ts';
import { verifyTranscript, type VerificationTranscript, type VerifiedChild } from './verifier.ts';

export interface PortfolioCore {
  readonly compiled: CompiledPortfolio;
  readonly engine: ControlEngine;
  readonly store: LedgerStore;
  readonly registry: ModuleRegistry;
  readonly adapters: AdapterRegistry;
  readonly catalog: ModuleCatalog;
}

export interface PortfolioCoreOptions {
  /** Build the store with the catalog's reducer rules (the SQLite reference store); default in-memory. */
  readonly storeOf?: (rules: ReducerRules) => LedgerStore;
  readonly hooks?: InMemoryStoreHooks;
  /** Durable registries (a lifecycle table); default in-memory reference registries with every module and adapter ACTIVE. */
  readonly registries?: { readonly modules: ModuleRegistry; readonly adapters: AdapterRegistry };
}

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }, what: string): T {
  if (!r.ok) throw new Error(`${what} refused`);
  return r.value;
}

/** An engine over exactly the compiled portfolio's modules and adapters. */
export function createPortfolioCore(compiled: CompiledPortfolio, o: PortfolioCoreOptions = {}): PortfolioCore {
  const modules = compiled.modules;
  const registry = o.registries?.modules ?? must(ReferenceModuleRegistry.create(modules.map((m) => ({ module: m.ref, status: 'ACTIVE' as const, implementations: [m.implementation] }))), 'module registry');
  const adapters = o.registries?.adapters ?? must(ReferenceAdapterRegistry.create(compiled.adapters.map((a) => ({ adapter: must(validateAdapterRef(a), 'adapter'), status: 'ACTIVE' as const }))), 'adapter registry');
  const catalog = must(ModuleCatalog.create(registry, modules.map((module) => ({ module, corpus: [] }))), 'catalog');
  const rules = controlRules(catalog);
  const store = o.storeOf?.(rules) ?? new InMemoryLedgerStore(o.hooks ?? {}, rules);
  return { compiled, engine: new ControlEngine({ store, registry, catalog, adapters }), store, registry, adapters, catalog };
}

export function ledgerRefusal(r: ControlRefusal): Reason {
  return reason(`LEDGER:${r.code}/${r.reason}`, r.path);
}

const ONCE: RetryPolicy = { maxAttempts: 1 };

/** Register the principal policy, the root and every delegation. The ledger re-checks each delegation ⊆ its parent. */
export async function registerPortfolio(core: PortfolioCore, at: bigint, retry: RetryPolicy = ONCE): Promise<Result<LedgerSnapshot, readonly Reason[]>> {
  const c = core.compiled;
  const p = await core.engine.registerPolicy(c.policy, at, retry);
  if (p.status !== 'REGISTERED') return err([ledgerRefusal(p.refusal)]);
  let snapshot = p.snapshot;
  for (const g of [c.root, ...c.delegations.values()]) {
    const r = await core.engine.registerDelegation(g, at, retry);
    if (r.status !== 'REGISTERED') return err([ledgerRefusal(r.refusal)]);
    snapshot = r.snapshot;
  }
  return ok(snapshot);
}

/** What the ledger still has room for: the root's leg per portfolio limit and each agent's per listed hard maximum. */
export function availabilityFrom(c: CompiledPortfolio, snapshot: LedgerSnapshot, at: bigint): ResourceAvailability {
  const state = snapshot.state;
  const rootId = authorityId(c.root);
  const balance = (authority: string, resource: string, limit: bigint): { available: bigint; reserved: bigint } => {
    const b = state.targets.get(nodeTargetKey(authority as never, resource));
    return b === undefined ? { available: limit, reserved: 0n } : { available: availableOf(b, at), reserved: b.reserved };
  };
  const portfolio = c.mandate.limits.map((l) => ({ resource: l.resource, atoms: balance(rootId, l.resource, l.atoms).available }) as ResourceAmount);
  const reserved = c.mandate.limits.map((l) => ({ resource: l.resource, atoms: balance(rootId, l.resource, l.atoms).reserved }) as ResourceAmount);
  const agents = new Map<string, ResourceVector>();
  for (const a of c.mandate.agents) {
    const g = c.delegations.get(a.agent.value);
    if (g === undefined) continue;
    const id = authorityId(g);
    agents.set(a.agent.value, a.hardMaxima.map((h) => ({ resource: h.resource, atoms: balance(id, h.resource, h.atoms).available }) as ResourceAmount));
  }
  return { ledgerVersion: snapshot.version, portfolio, agents, reserved };
}

/** The portfolio's resources a set of Core demands charges, by the same matching rule the ledger uses. */
export function demandedResources(c: CompiledPortfolio, domain: string, demands: readonly { readonly quantity: { readonly kind: Contribution['kind']; readonly unit: string; readonly decimals: number; readonly atoms: bigint } }[]): Result<ResourceVector, Reason> {
  return demandOf(
    resourceTable(c.mandate.resources),
    demands.map((d) => ({ kind: d.quantity.kind, unit: d.quantity.unit, decimals: d.quantity.decimals, atoms: d.quantity.atoms, domain })),
  );
}

export type ReserveOutcome =
  | { readonly status: 'RESERVED'; readonly record: AuthorizationRecord; readonly request: AuthorizationRequest; readonly snapshot: LedgerSnapshot; readonly verified: VerifiedChild }
  | { readonly status: 'REFUSED'; readonly reasons: readonly Reason[] };

/** The authorization request for a child at `at`: its compiled action, fresh state and the binding's sources. */
export function requestFor(core: PortfolioCore, child: ChildExecutionAuthorization, candidate: ActionCandidate, at: bigint): Result<AuthorizationRequest, Reason> {
  const a = compileAction(core.compiled, child, candidate);
  if (!a.ok) return a;
  return ok({ action: a.value.envelope, payload: a.value.payload, generation: 1n, states: a.value.binding.states(candidate, at), context: { evaluationTime: at, sources: [...a.value.binding.sources()], blockHeads: [], sequenceWatermarks: [] } });
}

/**
 * Reserve one child. Refuses before touching the ledger when the child fails
 * its own check or its candidate is not the one it binds; runs the engine's
 * pure decision first and refuses when the module would reserve anything
 * other than exactly the approved resources; then reserves atomically.
 */
function verifiedAtBoundary(core: PortfolioCore, transcript: VerificationTranscript, digest: ChildAuthorizationDigest, at: bigint): Result<VerifiedChild, readonly Reason[]> {
  const verification = verifyTranscript(core.compiled.mandate, core.compiled.bindings, transcript);
  if (verification.status === 'REFUSED') return err(verification.reasons);
  const verified = verification.children.find((x) => x.digest === digest);
  if (verified === undefined) return err([reason('CHILD_AUTHORIZATION_UNKNOWN', digest)]);
  const signed = transcript.proposals.find((x) => proposalDigest(x.proposal) === verified.proposal);
  if (signed === undefined) return err([reason('CANDIDATE_PROPOSAL_UNKNOWN', verified.proposal)]);
  const current = screenProposal(core.compiled.mandate, core.compiled.bindings, signed, at);
  if (current.child === null) return err(current.reasons);
  if (
    current.child.portfolioMandate !== verified.child.portfolioMandate ||
    current.child.agent.kind !== verified.child.agent.kind ||
    current.child.agent.value !== verified.child.agent.value ||
    current.child.proposal !== verified.child.proposal ||
    current.child.candidate !== verified.child.candidate ||
    !vectorsEqual(current.child.approved, verified.child.approved)
  ) return err([reason('CHILD_ACTION_MUTATED', digest)]);
  return ok(verified);
}

export async function reserveChild(core: PortfolioCore, transcript: VerificationTranscript, digest: ChildAuthorizationDigest, at: bigint, retry: RetryPolicy = { maxAttempts: 8 }): Promise<ReserveOutcome> {
  const proof = verifiedAtBoundary(core, transcript, digest, at);
  if (!proof.ok) return { status: 'REFUSED', reasons: proof.error };
  const { child, candidate } = proof.value;
  const invalid = checkChildAuthorization(core.compiled.mandate, child);
  if (invalid.length > 0) return { status: 'REFUSED', reasons: invalid };
  const request = requestFor(core, child, candidate, at);
  if (!request.ok) return { status: 'REFUSED', reasons: [request.error] };
  const decision = await core.engine.decide(request.value);
  if (!decision.ok) return { status: 'REFUSED', reasons: [ledgerRefusal(decision.error)] };
  const charged = demandedResources(core.compiled, decision.value.module.domainId, decision.value.demands);
  if (!charged.ok) return { status: 'REFUSED', reasons: [charged.error] };
  if (!vectorsEqual(charged.value, child.approved)) return { status: 'REFUSED', reasons: [reason('RESERVATION_DEMAND_MISMATCH', childAuthorizationDigest(child))] };
  const out = await core.engine.authorizeAndReserve(request.value, retry);
  if (out.status === 'AUTHORIZED') return { status: 'RESERVED', record: out.authorization, request: request.value, snapshot: out.snapshot, verified: proof.value };
  return { status: 'REFUSED', reasons: [ledgerRefusal(out.refusal)] };
}

/** Where a reservation is in the ledger's own lifecycle. */
export type ReservationPhase = 'RESERVED' | 'ADMITTED' | 'CLOSED' | 'UNKNOWN';

export function reservationPhase(state: LedgerState, reservation: ReservationId): ReservationPhase {
  const r = state.reservations.get(reservation);
  if (r === undefined) return 'UNKNOWN';
  if (r.status === 'CLOSED') return 'CLOSED';
  return attemptsOf(state, reservation).length > 0 ? 'ADMITTED' : 'RESERVED';
}

export interface SignClaim {
  /** The party asking for a signature on the child's behalf. */
  readonly agent: { readonly kind: string; readonly value: string };
  readonly child: ChildExecutionAuthorization;
  readonly candidate: ActionCandidate;
  readonly reservation: ReservationId;
  readonly action: ActionId;
  readonly generation: ReservationGeneration;
  readonly authorization: ExecutionAuthorizationId;
  readonly attempt: AttemptId;
  readonly at: bigint;
}

/**
 * The portfolio's precondition for any principal or custody key: every
 * reason the key must not be used, empty when it may.
 *
 * 1. the child is one the verifier derived for this portfolio (allocation exists);
 * 2. the party asking is the child's own agent;
 * 3. the action is byte-for-byte the one the child compiles to (no mutation);
 * 4. the reservation is ACTIVE, is that action's, and holds exactly the approved demand;
 * 5. an ADMIT_ATTEMPT for it is durably committed.
 *
 * The domain signer then runs its own checks (Robinhood custody re-derives
 * the gate artifact from the committed attempt).
 */
export function checkBeforeSign(core: PortfolioCore, transcript: VerificationTranscript, claim: SignClaim, state: LedgerState): readonly Reason[] {
  const found: Reason[] = [];
  const digest = childAuthorizationDigest(claim.child);
  const proof = verifiedAtBoundary(core, transcript, digest, claim.at);
  if (!proof.ok) found.push(...proof.error);
  else if (proof.value.child.candidate !== claim.child.candidate || proof.value.proposal !== claim.child.proposal) found.push(reason('CHILD_ACTION_MUTATED', digest));
  if (claim.agent.kind !== claim.child.agent.kind || claim.agent.value !== claim.child.agent.value) found.push(reason('CHILD_AGENT_MISMATCH', claim.agent.value));
  const compiled = compileAction(core.compiled, claim.child, claim.candidate);
  if (!compiled.ok) found.push(compiled.error);
  else if (actionId(compiled.value.envelope) !== claim.action) found.push(reason('CHILD_ACTION_MUTATED', 'action'));
  const r = state.reservations.get(claim.reservation);
  if (r === undefined || r.status !== 'ACTIVE' || r.action !== claim.action || r.generation !== claim.generation) found.push(reason('RESERVATION_MISSING', claim.reservation));
  else {
    const held = demandedResources(core.compiled, r.module.domainId, r.demands.map((d) => ({ quantity: { ...d.contribution.quantity, atoms: d.reserved - d.consumed - d.released } })));
    if (!held.ok || !vectorsEqual(held.value, claim.child.approved)) found.push(reason('RESERVATION_DEMAND_MISMATCH', claim.reservation));
  }
  const attempt: AttemptRecord | undefined = state.attempts.get(claim.attempt);
  if (
    attempt === undefined ||
    attempt.reservation !== claim.reservation ||
    attempt.generation !== claim.generation ||
    attempt.action !== claim.action ||
    attempt.authorization !== claim.authorization
  ) found.push(reason('ATTEMPT_NOT_COMMITTED', claim.attempt));
  return canonicalReasons(found);
}
