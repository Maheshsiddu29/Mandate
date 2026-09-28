/**
 * Reservation, authorization and execution-binding references
 * (reservations-reconciliation.md §3–4, architecture.md §9, enforcement-adapters.md §2).
 *
 * References only. There is no reservation lifecycle, no ledger and no
 * artifact here: these are the canonical objects later phases create and
 * digest-bind, fixed now so that 7C–7H implement them rather than discover
 * them.
 *
 * - `ReservationId = H("mandate-core/v1/reservation", actionId, generation)`.
 *   The generation is explicit, ≥ 1, and part of the identity, so two
 *   generations of one intent are two reservations with two ids, and an
 *   observation naming generation `g` can never be read as naming `g + 1`
 *   (the Phase 6R.1b rule, RECON-2). Nothing here defaults a generation or
 *   infers "the current one".
 * - `ReservationRef` fixes what a reservation is bound to for its whole
 *   lifecycle: action, generation, principal, lineage and principal policy,
 *   the exact module and conforming implementation, the adapter, and the
 *   ledger version it committed at.
 * - `ExecutionAuthorization` is Core's statement that one reservation
 *   generation may be executed through its adapter until an attempt ceiling,
 *   under the state bindings the decision relied on.
 * - `ExecutionBindingRef` is the adapter's binding of exact execution
 *   parameters (by digest) to that authorization, restating action,
 *   generation, module, adapter and the state bindings in force.
 */

import { ok, type ByteWriter } from '@mandate/kernel';
import type { Tagged } from './brand.ts';
import { at, fail, type CoreResult } from './errors.ts';
import {
  partyIdInputOf,
  readPartyInput,
  validatePrincipalId,
  writeParty,
  type ActionId,
  type AuthorityId,
  type ExecutionAuthorizationId,
  type ExecutionBindingId,
  type ExecutionParametersDigest,
  type ImplementationDigest,
  type LedgerVersion,
  type PartyIdInput,
  type PrincipalId,
  type PrincipalPolicyId,
  type ReservationGeneration,
  type ReservationId,
  type ReservationRefDigest,
  type StateBindingId,
} from './identifiers.ts';
import {
  checkArray,
  checkFields,
  parseDigest,
  parseNonZeroDigest,
  parseUint64,
  parseUnixSeconds,
  type Digest32,
  type IntegerInput,
} from './primitives.ts';
import {
  CoreTag,
  canonicalSet,
  decodeTagged,
  keccakDigest,
  taggedWriter,
  writeDigest,
  writeList,
  type CoreReader,
} from './encoding.ts';
import {
  adapterRefInputOf,
  adapterRefsEqual,
  moduleRefInputOf,
  moduleRefsEqual,
  readAdapterRefInput,
  readModuleRefInput,
  validateAdapterRef,
  validateModuleRef,
  writeAdapterRef,
  writeModuleRef,
  type AdapterRef,
  type AdapterRefInput,
  type ModuleRef,
  type ModuleRefInput,
} from './module.ts';
import {
  readStateBindingInput,
  stateBindingId,
  stateBindingInputOf,
  validateStateBinding,
  writeStateBinding,
  type StateBinding,
  type StateBindingInput,
} from './state.ts';
import { MAX_LINEAGE_LENGTH, MAX_STATE_BINDINGS } from './limits.ts';

// --- Generation and ReservationId ------------------------------------------------

/** A reservation generation: `u64`, ≥ 1. Generation 0 is the intent's state before its first reservation, never a reservation. */
export function parseReservationGeneration(raw: IntegerInput, path: string): CoreResult<ReservationGeneration> {
  const g = parseUint64(raw, path);
  if (!g.ok) return g;
  return g.value === 0n ? fail('GENERATION_ZERO', path) : ok(g.value as ReservationGeneration);
}

export function parseLedgerVersion(raw: IntegerInput, path: string): CoreResult<LedgerVersion> {
  const v = parseUint64(raw, path);
  return v.ok ? ok(v.value as LedgerVersion) : v;
}

export function reservationIdFor(action: ActionId, generation: ReservationGeneration): ReservationId {
  const w = taggedWriter(CoreTag.RESERVATION);
  writeDigest(w, action);
  w.u64(generation);
  return keccakDigest<ReservationId>(w.finish());
}

function writeDigestItem(w: ByteWriter, d: Digest32): void {
  writeDigest(w, d);
}

function readDigestItem(r: CoreReader): string {
  return r.digest();
}

// --- ReservationRef --------------------------------------------------------------

export interface ReservationRefInput {
  readonly action: string;
  readonly generation: IntegerInput;
  readonly principal: PartyIdInput;
  readonly lineage: readonly string[];
  readonly policy: string;
  readonly module: ModuleRefInput;
  readonly implementation: string;
  readonly adapter: AdapterRefInput;
  readonly ledgerVersion: IntegerInput;
}

export type ReservationRef = Tagged<
  {
    readonly action: ActionId;
    readonly generation: ReservationGeneration;
    readonly principal: PrincipalId;
    /** Leaf to root; the last node is the root (`MandateId`). Ordered, not a set. */
    readonly lineage: readonly AuthorityId[];
    /** The principal policy in force at commit: the last node of the charging path. */
    readonly policy: PrincipalPolicyId;
    /** Fixed for the lifecycle; reconciliation settles under this module, not the newest (DOM-2). */
    readonly module: ModuleRef;
    readonly implementation: ImplementationDigest;
    readonly adapter: AdapterRef;
    /** The ledger version the decision and its reservation committed at. */
    readonly ledgerVersion: LedgerVersion;
  },
  'ReservationRef'
>;

function validateLineageList(input: readonly string[], path: string): CoreResult<readonly AuthorityId[]> {
  const arr = checkArray(input, MAX_LINEAGE_LENGTH, path);
  if (!arr.ok) return arr;
  if (input.length === 0) return fail('COLLECTION_EMPTY', path);
  const out: AuthorityId[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const id = parseDigest<AuthorityId>(input[i] as string, at(path, i));
    if (!id.ok) return id;
    if (out.includes(id.value)) return fail('LINEAGE_REPEATS_NODE', at(path, i));
    out.push(id.value);
  }
  return ok(out);
}

export function validateReservationRef(input: ReservationRefInput, path = 'reservation'): CoreResult<ReservationRef> {
  const shape = checkFields(
    input,
    ['action', 'generation', 'principal', 'lineage', 'policy', 'module', 'implementation', 'adapter', 'ledgerVersion'],
    path,
  );
  if (!shape.ok) return shape;
  const action = parseDigest<ActionId>(input.action, at(path, 'action'));
  if (!action.ok) return action;
  const generation = parseReservationGeneration(input.generation, at(path, 'generation'));
  if (!generation.ok) return generation;
  const principal = validatePrincipalId(input.principal, at(path, 'principal'));
  if (!principal.ok) return principal;
  const lineage = validateLineageList(input.lineage, at(path, 'lineage'));
  if (!lineage.ok) return lineage;
  const policy = parseDigest<PrincipalPolicyId>(input.policy, at(path, 'policy'));
  if (!policy.ok) return policy;
  const module = validateModuleRef(input.module, at(path, 'module'));
  if (!module.ok) return module;
  const implementation = parseNonZeroDigest<ImplementationDigest>(input.implementation, at(path, 'implementation'));
  if (!implementation.ok) return implementation;
  const adapter = validateAdapterRef(input.adapter, at(path, 'adapter'));
  if (!adapter.ok) return adapter;
  const ledgerVersion = parseLedgerVersion(input.ledgerVersion, at(path, 'ledgerVersion'));
  if (!ledgerVersion.ok) return ledgerVersion;
  return ok({
    action: action.value,
    generation: generation.value,
    principal: principal.value,
    lineage: lineage.value,
    policy: policy.value,
    module: module.value,
    implementation: implementation.value,
    adapter: adapter.value,
    ledgerVersion: ledgerVersion.value,
  } as ReservationRef);
}

export function writeReservationRef(w: ByteWriter, r: ReservationRef): void {
  writeDigest(w, r.action);
  w.u64(r.generation);
  writeParty(w, r.principal);
  writeList(w, r.lineage, writeDigestItem);
  writeDigest(w, r.policy);
  writeModuleRef(w, r.module);
  writeDigest(w, r.implementation);
  writeAdapterRef(w, r.adapter);
  w.u64(r.ledgerVersion);
}

export function readReservationRefInput(r: CoreReader): ReservationRefInput {
  const action = r.digest();
  const generation = r.u64();
  const principal = readPartyInput(r);
  // Ordered leaf to root: not a set, so not required to be ascending.
  const lineage = r.list(MAX_LINEAGE_LENGTH, readDigestItem, false);
  const policy = r.digest();
  const module = readModuleRefInput(r);
  const implementation = r.digest();
  const adapter = readAdapterRefInput(r);
  const ledgerVersion = r.u64();
  return { action, generation, principal, lineage, policy, module, implementation, adapter, ledgerVersion };
}

export function reservationRefInputOf(r: ReservationRef): ReservationRefInput {
  return {
    action: r.action,
    generation: r.generation,
    principal: partyIdInputOf(r.principal),
    lineage: [...r.lineage],
    policy: r.policy,
    module: moduleRefInputOf(r.module),
    implementation: r.implementation,
    adapter: adapterRefInputOf(r.adapter),
    ledgerVersion: r.ledgerVersion,
  };
}

export function encodeReservationRef(r: ReservationRef): Uint8Array {
  const w = taggedWriter(CoreTag.RESERVATION_REF);
  writeReservationRef(w, r);
  return w.finish();
}

export function decodeReservationRef(bytes: Uint8Array): CoreResult<ReservationRef> {
  return decodeTagged(bytes, CoreTag.RESERVATION_REF, readReservationRefInput, (input) => validateReservationRef(input));
}

export function reservationRefDigest(r: ReservationRef): ReservationRefDigest {
  return keccakDigest<ReservationRefDigest>(encodeReservationRef(r));
}

/** The reservation's own identity, derived from the ref's action and generation. */
export function reservationIdOf(r: ReservationRef): ReservationId {
  return reservationIdFor(r.action, r.generation);
}

// --- ExecutionAuthorization ------------------------------------------------------

export interface ExecutionAuthorizationInput {
  readonly reservation: ReservationRefInput;
  readonly stateBindings: readonly StateBindingInput[];
  readonly attemptCeiling: IntegerInput;
}

export type ExecutionAuthorization = Tagged<
  {
    readonly reservation: ReservationRef;
    /** Every snapshot the decision relied on (STATE-4); canonical order. */
    readonly stateBindings: readonly StateBinding[];
    /** Every artifact under this authorization expires at or before this instant (EXEC-3). */
    readonly attemptCeiling: bigint;
  },
  'ExecutionAuthorization'
>;

function validateBindingList(inputs: readonly StateBindingInput[], path: string): CoreResult<readonly StateBinding[]> {
  const arr = checkArray(inputs, MAX_STATE_BINDINGS, path);
  if (!arr.ok) return arr;
  const out: StateBinding[] = [];
  for (let i = 0; i < inputs.length; i += 1) {
    const b = validateStateBinding(inputs[i] as StateBindingInput, at(path, i));
    if (!b.ok) return b;
    out.push(b.value);
  }
  return canonicalSet(out, writeStateBinding, path);
}

export function validateExecutionAuthorization(input: ExecutionAuthorizationInput, path = 'authorization'): CoreResult<ExecutionAuthorization> {
  const shape = checkFields(input, ['reservation', 'stateBindings', 'attemptCeiling'], path);
  if (!shape.ok) return shape;
  const reservation = validateReservationRef(input.reservation, at(path, 'reservation'));
  if (!reservation.ok) return reservation;
  const stateBindings = validateBindingList(input.stateBindings, at(path, 'stateBindings'));
  if (!stateBindings.ok) return stateBindings;
  const attemptCeiling = parseUnixSeconds(input.attemptCeiling, at(path, 'attemptCeiling'));
  if (!attemptCeiling.ok) return attemptCeiling;
  return ok({ reservation: reservation.value, stateBindings: stateBindings.value, attemptCeiling: attemptCeiling.value } as ExecutionAuthorization);
}

export function encodeExecutionAuthorization(a: ExecutionAuthorization): Uint8Array {
  const w = taggedWriter(CoreTag.AUTHORIZATION);
  writeReservationRef(w, a.reservation);
  writeList(w, a.stateBindings, writeStateBinding);
  w.i64(a.attemptCeiling);
  return w.finish();
}

function readAuthorizationInput(r: CoreReader): ExecutionAuthorizationInput {
  const reservation = readReservationRefInput(r);
  const stateBindings = r.list(MAX_STATE_BINDINGS, readStateBindingInput, true);
  const attemptCeiling = r.i64();
  return { reservation, stateBindings, attemptCeiling };
}

export function decodeExecutionAuthorization(bytes: Uint8Array): CoreResult<ExecutionAuthorization> {
  return decodeTagged(bytes, CoreTag.AUTHORIZATION, readAuthorizationInput, (input) => validateExecutionAuthorization(input));
}

export function executionAuthorizationId(a: ExecutionAuthorization): ExecutionAuthorizationId {
  return keccakDigest<ExecutionAuthorizationId>(encodeExecutionAuthorization(a));
}

export function executionAuthorizationInputOf(a: ExecutionAuthorization): ExecutionAuthorizationInput {
  return {
    reservation: reservationRefInputOf(a.reservation),
    stateBindings: a.stateBindings.map(stateBindingInputOf),
    attemptCeiling: a.attemptCeiling,
  };
}

// --- ExecutionBindingRef ---------------------------------------------------------

export interface ExecutionBindingRefInput {
  readonly authorization: string;
  readonly action: string;
  readonly generation: IntegerInput;
  readonly module: ModuleRefInput;
  readonly adapter: AdapterRefInput;
  readonly stateBindings: readonly string[];
  readonly parameters: string;
}

export type ExecutionBindingRef = Tagged<
  {
    readonly authorization: ExecutionAuthorizationId;
    readonly action: ActionId;
    readonly generation: ReservationGeneration;
    readonly module: ModuleRef;
    readonly adapter: AdapterRef;
    /** The bindings in force when the attempt is admitted: the authorization's, or those of a committed `REVALIDATE`. */
    readonly stateBindings: readonly StateBindingId[];
    /** The adapter's digest of its exact canonical execution parameters. */
    readonly parameters: ExecutionParametersDigest;
  },
  'ExecutionBindingRef'
>;

export function validateExecutionBindingRef(input: ExecutionBindingRefInput, path = 'executionBinding'): CoreResult<ExecutionBindingRef> {
  const shape = checkFields(input, ['authorization', 'action', 'generation', 'module', 'adapter', 'stateBindings', 'parameters'], path);
  if (!shape.ok) return shape;
  const authorization = parseDigest<ExecutionAuthorizationId>(input.authorization, at(path, 'authorization'));
  if (!authorization.ok) return authorization;
  const action = parseDigest<ActionId>(input.action, at(path, 'action'));
  if (!action.ok) return action;
  const generation = parseReservationGeneration(input.generation, at(path, 'generation'));
  if (!generation.ok) return generation;
  const module = validateModuleRef(input.module, at(path, 'module'));
  if (!module.ok) return module;
  const adapter = validateAdapterRef(input.adapter, at(path, 'adapter'));
  if (!adapter.ok) return adapter;
  const bp = at(path, 'stateBindings');
  const arr = checkArray(input.stateBindings, MAX_STATE_BINDINGS, bp);
  if (!arr.ok) return arr;
  const ids: StateBindingId[] = [];
  for (let i = 0; i < input.stateBindings.length; i += 1) {
    const id = parseDigest<StateBindingId>(input.stateBindings[i] as string, at(bp, i));
    if (!id.ok) return id;
    ids.push(id.value);
  }
  const stateBindings = canonicalSet<StateBindingId>(ids, writeDigestItem, bp);
  if (!stateBindings.ok) return stateBindings;
  const parameters = parseDigest<ExecutionParametersDigest>(input.parameters, at(path, 'parameters'));
  if (!parameters.ok) return parameters;
  return ok({
    authorization: authorization.value,
    action: action.value,
    generation: generation.value,
    module: module.value,
    adapter: adapter.value,
    stateBindings: stateBindings.value,
    parameters: parameters.value,
  } as ExecutionBindingRef);
}

export function encodeExecutionBindingRef(b: ExecutionBindingRef): Uint8Array {
  const w = taggedWriter(CoreTag.EXECUTION_BINDING);
  writeDigest(w, b.authorization);
  writeDigest(w, b.action);
  w.u64(b.generation);
  writeModuleRef(w, b.module);
  writeAdapterRef(w, b.adapter);
  writeList(w, b.stateBindings, writeDigestItem);
  writeDigest(w, b.parameters);
  return w.finish();
}

function readBindingRefInput(r: CoreReader): ExecutionBindingRefInput {
  const authorization = r.digest();
  const action = r.digest();
  const generation = r.u64();
  const module = readModuleRefInput(r);
  const adapter = readAdapterRefInput(r);
  const stateBindings = r.list(MAX_STATE_BINDINGS, readDigestItem, true);
  const parameters = r.digest();
  return { authorization, action, generation, module, adapter, stateBindings, parameters };
}

export function decodeExecutionBindingRef(bytes: Uint8Array): CoreResult<ExecutionBindingRef> {
  return decodeTagged(bytes, CoreTag.EXECUTION_BINDING, readBindingRefInput, (input) => validateExecutionBindingRef(input));
}

/** The `bindingDigest`. */
export function executionBindingId(b: ExecutionBindingRef): ExecutionBindingId {
  return keccakDigest<ExecutionBindingId>(encodeExecutionBindingRef(b));
}

export function executionBindingRefInputOf(b: ExecutionBindingRef): ExecutionBindingRefInput {
  return {
    authorization: b.authorization,
    action: b.action,
    generation: b.generation,
    module: moduleRefInputOf(b.module),
    adapter: adapterRefInputOf(b.adapter),
    stateBindings: [...b.stateBindings],
    parameters: b.parameters,
  };
}

/**
 * Structural agreement between a binding and the authorization it names: the
 * digest, action, generation, module and adapter must all match. A binding for
 * generation 2 cannot claim an authorization of generation 1.
 *
 * State bindings are not compared. A committed `REVALIDATE` legitimately
 * replaces them between authorization and issue; whether the binding's set is
 * the authorization's or a committed revalidation's is a ledger fact (7D).
 */
export function checkBindingMatchesAuthorization(binding: ExecutionBindingRef, authorization: ExecutionAuthorization): CoreResult<true> {
  const r = authorization.reservation;
  if (binding.authorization !== executionAuthorizationId(authorization)) return fail('EXECUTION_BINDING_INCONSISTENT', 'executionBinding.authorization');
  if (binding.action !== r.action) return fail('EXECUTION_BINDING_INCONSISTENT', 'executionBinding.action');
  if (binding.generation !== r.generation) return fail('EXECUTION_BINDING_INCONSISTENT', 'executionBinding.generation');
  if (!moduleRefsEqual(binding.module, r.module)) return fail('EXECUTION_BINDING_INCONSISTENT', 'executionBinding.module');
  if (!adapterRefsEqual(binding.adapter, r.adapter)) return fail('EXECUTION_BINDING_INCONSISTENT', 'executionBinding.adapter');
  return ok(true);
}

/** The binding ids of an authorization's state bindings, for an `ExecutionBindingRef` issued without revalidation. */
export function stateBindingIdsOf(a: ExecutionAuthorization): readonly StateBindingId[] {
  return a.stateBindings.map(stateBindingId);
}
