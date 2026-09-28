/**
 * Receipt header and references (receipts-provenance.md §3–4).
 *
 * Structural only. The per-kind receipt bodies (`DecisionReceipt`,
 * `TransitionReceipt`, ...), their digests `H("mandate-core/v1/receipt/" ‖ kind, …)`,
 * chaining rules and persistence are Phase 7H. What is fixed here is the
 * common header the specification defines, and one reference object that
 * names, by digest, every lifecycle object a receipt must be able to point at:
 * the lineage, the principal policy, the action, the module and conforming
 * implementation, the adapter, the state bindings, the reservation generation,
 * the execution binding and the observation that reconciled it.
 *
 * Both have canonical encodings under their own tags so they round-trip and
 * are pinned by vectors. Neither is a receipt, and neither digest is a
 * `ReceiptId`.
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
  type CoreVersionId,
  type ExecutionBindingId,
  type ImplementationDigest,
  type LedgerHeadDigest,
  type LedgerVersion,
  type ObservationId,
  type PartyIdInput,
  type PrincipalId,
  type PrincipalPolicyId,
  type ReceiptId,
  type ReservationGeneration,
  type ReservationId,
  type StateBindingId,
} from './identifiers.ts';
import {
  checkArray,
  checkFields,
  parseDigest,
  parseEnum,
  parseIdentifierAs,
  parseNonZeroDigest,
  parseUnixSeconds,
  type Digest32,
  type IntegerInput,
} from './primitives.ts';
import {
  CoreTag,
  canonicalSet,
  decodeTagged,
  readCode,
  readNullable,
  taggedWriter,
  writeCode,
  writeDigest,
  writeList,
  writeNullable,
  type CoreReader,
  type WireCodes,
} from './encoding.ts';
import {
  adapterRefInputOf,
  moduleRefInputOf,
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
import { parseLedgerVersion, parseReservationGeneration, reservationIdFor } from './execution.ts';
import { MAX_LINEAGE_LENGTH, MAX_STATE_BINDINGS } from './limits.ts';

export const ReceiptKind = {
  GRANT: 'GRANT',
  POLICY: 'POLICY',
  REVOCATION: 'REVOCATION',
  DECISION: 'DECISION',
  TRANSITION: 'TRANSITION',
  CLOSE: 'CLOSE',
  DRIFT: 'DRIFT',
} as const;
export type ReceiptKind = (typeof ReceiptKind)[keyof typeof ReceiptKind];
const RECEIPT_KINDS: readonly ReceiptKind[] = Object.values(ReceiptKind);
const RECEIPT_KIND_CODE: WireCodes<ReceiptKind> = { GRANT: 1, POLICY: 2, REVOCATION: 3, DECISION: 4, TRANSITION: 5, CLOSE: 6, DRIFT: 7 };

function writeDigestItem(w: ByteWriter, d: Digest32): void {
  writeDigest(w, d);
}

function readDigestItem(r: CoreReader): string {
  return r.digest();
}

// --- LedgerRef -------------------------------------------------------------------

export interface LedgerRefInput {
  readonly version: IntegerInput;
  readonly headDigest: string;
}

/** A ledger state within one principal's ledger: `(version, headDigest)`; the principal is the header's. */
export type LedgerRef = Tagged<{ readonly version: LedgerVersion; readonly headDigest: LedgerHeadDigest }, 'LedgerRef'>;

function validateLedgerRef(input: LedgerRefInput, path: string): CoreResult<LedgerRef> {
  const shape = checkFields(input, ['version', 'headDigest'], path);
  if (!shape.ok) return shape;
  const version = parseLedgerVersion(input.version, at(path, 'version'));
  if (!version.ok) return version;
  const headDigest = parseDigest<LedgerHeadDigest>(input.headDigest, at(path, 'headDigest'));
  if (!headDigest.ok) return headDigest;
  return ok({ version: version.value, headDigest: headDigest.value } as LedgerRef);
}

function writeLedgerRef(w: ByteWriter, l: LedgerRef): void {
  w.u64(l.version);
  writeDigest(w, l.headDigest);
}

function readLedgerRefInput(r: CoreReader): LedgerRefInput {
  const version = r.u64();
  const headDigest = r.digest();
  return { version, headDigest };
}

// --- ReceiptHeader ---------------------------------------------------------------

export interface ReceiptHeaderInput {
  readonly kind: ReceiptKind;
  readonly coreVersion: string;
  readonly principal: PartyIdInput;
  readonly ledgerBefore: LedgerRefInput;
  readonly ledgerAfter: LedgerRefInput | null;
  readonly previousReceipt: string | null;
  readonly evaluatedAt: IntegerInput;
}

export type ReceiptHeader = Tagged<
  {
    readonly kind: ReceiptKind;
    /** The Core rules version the receipt was produced under. */
    readonly coreVersion: CoreVersionId;
    readonly principal: PrincipalId;
    readonly ledgerBefore: LedgerRef;
    /** `null` for a decision that wrote nothing. */
    readonly ledgerAfter: LedgerRef | null;
    /** Same reservation, or same node for grant events; `null` at the start of a chain. */
    readonly previousReceipt: ReceiptId | null;
    /** The decision's `t`: a parameter, never a clock read. */
    readonly evaluatedAt: bigint;
  },
  'ReceiptHeader'
>;

export function validateReceiptHeader(input: ReceiptHeaderInput, path = 'header'): CoreResult<ReceiptHeader> {
  const shape = checkFields(input, ['kind', 'coreVersion', 'principal', 'ledgerBefore', 'ledgerAfter', 'previousReceipt', 'evaluatedAt'], path);
  if (!shape.ok) return shape;
  const kind = parseEnum(input.kind, RECEIPT_KINDS, at(path, 'kind'));
  if (!kind.ok) return kind;
  const coreVersion = parseIdentifierAs<CoreVersionId>(input.coreVersion, at(path, 'coreVersion'));
  if (!coreVersion.ok) return coreVersion;
  const principal = validatePrincipalId(input.principal, at(path, 'principal'));
  if (!principal.ok) return principal;
  const ledgerBefore = validateLedgerRef(input.ledgerBefore, at(path, 'ledgerBefore'));
  if (!ledgerBefore.ok) return ledgerBefore;
  let ledgerAfter: LedgerRef | null = null;
  if (input.ledgerAfter !== null) {
    const after = validateLedgerRef(input.ledgerAfter, at(path, 'ledgerAfter'));
    if (!after.ok) return after;
    // Every committed batch increments the version (authority-ledger.md §9).
    if (after.value.version <= ledgerBefore.value.version) return fail('LEDGER_VERSION_NOT_ADVANCED', at(path, 'ledgerAfter.version'));
    ledgerAfter = after.value;
  }
  let previousReceipt: ReceiptId | null = null;
  if (input.previousReceipt !== null) {
    const prev = parseDigest<ReceiptId>(input.previousReceipt, at(path, 'previousReceipt'));
    if (!prev.ok) return prev;
    previousReceipt = prev.value;
  }
  const evaluatedAt = parseUnixSeconds(input.evaluatedAt, at(path, 'evaluatedAt'));
  if (!evaluatedAt.ok) return evaluatedAt;
  return ok({
    kind: kind.value,
    coreVersion: coreVersion.value,
    principal: principal.value,
    ledgerBefore: ledgerBefore.value,
    ledgerAfter,
    previousReceipt,
    evaluatedAt: evaluatedAt.value,
  } as ReceiptHeader);
}

export function encodeReceiptHeader(h: ReceiptHeader): Uint8Array {
  const w = taggedWriter(CoreTag.RECEIPT_HEADER);
  writeCode(w, RECEIPT_KIND_CODE, h.kind);
  w.str(h.coreVersion);
  writeParty(w, h.principal);
  writeLedgerRef(w, h.ledgerBefore);
  writeNullable(w, h.ledgerAfter, writeLedgerRef);
  writeNullable<Digest32>(w, h.previousReceipt, writeDigestItem);
  w.i64(h.evaluatedAt);
  return w.finish();
}

function readHeaderInput(r: CoreReader): ReceiptHeaderInput {
  const kind = readCode(r, RECEIPT_KIND_CODE);
  const coreVersion = r.str();
  const principal = readPartyInput(r);
  const ledgerBefore = readLedgerRefInput(r);
  const ledgerAfter = readNullable(r, readLedgerRefInput);
  const previousReceipt = readNullable(r, readDigestItem);
  const evaluatedAt = r.i64();
  return { kind, coreVersion, principal, ledgerBefore, ledgerAfter, previousReceipt, evaluatedAt };
}

export function decodeReceiptHeader(bytes: Uint8Array): CoreResult<ReceiptHeader> {
  return decodeTagged(bytes, CoreTag.RECEIPT_HEADER, readHeaderInput, (input) => validateReceiptHeader(input));
}

export function receiptHeaderInputOf(h: ReceiptHeader): ReceiptHeaderInput {
  return {
    kind: h.kind,
    coreVersion: h.coreVersion,
    principal: partyIdInputOf(h.principal),
    ledgerBefore: { version: h.ledgerBefore.version, headDigest: h.ledgerBefore.headDigest },
    ledgerAfter: h.ledgerAfter === null ? null : { version: h.ledgerAfter.version, headDigest: h.ledgerAfter.headDigest },
    previousReceipt: h.previousReceipt,
    evaluatedAt: h.evaluatedAt,
  };
}

// --- ReceiptReferences -----------------------------------------------------------

export interface ReservationPointerInput {
  readonly reservationId: string;
  readonly generation: IntegerInput;
}

/** A reservation named by id with its generation stated, checked against the action. */
export type ReservationPointer = Tagged<{ readonly reservationId: ReservationId; readonly generation: ReservationGeneration }, 'ReservationPointer'>;

export interface ReceiptReferencesInput {
  readonly lineage: readonly string[];
  readonly policy: string;
  readonly action: string;
  readonly module: ModuleRefInput;
  readonly implementation: string;
  readonly adapter: AdapterRefInput;
  readonly stateBindings: readonly string[];
  readonly reservation: ReservationPointerInput | null;
  readonly executionBinding: string | null;
  readonly observation: string | null;
}

export type ReceiptReferences = Tagged<
  {
    /** Leaf to root: who authorized, under which mandate and delegations. */
    readonly lineage: readonly AuthorityId[];
    readonly policy: PrincipalPolicyId;
    readonly action: ActionId;
    /** Identical on every receipt of a reservation (DOM-2). */
    readonly module: ModuleRef;
    readonly implementation: ImplementationDigest;
    readonly adapter: AdapterRef;
    readonly stateBindings: readonly StateBindingId[];
    /** `null` for a refused decision, which reserved nothing. */
    readonly reservation: ReservationPointer | null;
    readonly executionBinding: ExecutionBindingId | null;
    /** The observation a transition or close applied. */
    readonly observation: ObservationId | null;
  },
  'ReceiptReferences'
>;

const REFERENCE_FIELDS = [
  'lineage',
  'policy',
  'action',
  'module',
  'implementation',
  'adapter',
  'stateBindings',
  'reservation',
  'executionBinding',
  'observation',
] as const;

export function validateReceiptReferences(input: ReceiptReferencesInput, path = 'references'): CoreResult<ReceiptReferences> {
  const shape = checkFields(input, REFERENCE_FIELDS, path);
  if (!shape.ok) return shape;
  const lp = at(path, 'lineage');
  const larr = checkArray(input.lineage, MAX_LINEAGE_LENGTH, lp);
  if (!larr.ok) return larr;
  if (input.lineage.length === 0) return fail('COLLECTION_EMPTY', lp);
  const lineage: AuthorityId[] = [];
  for (let i = 0; i < input.lineage.length; i += 1) {
    const id = parseDigest<AuthorityId>(input.lineage[i] as string, at(lp, i));
    if (!id.ok) return id;
    if (lineage.includes(id.value)) return fail('LINEAGE_REPEATS_NODE', at(lp, i));
    lineage.push(id.value);
  }
  const policy = parseDigest<PrincipalPolicyId>(input.policy, at(path, 'policy'));
  if (!policy.ok) return policy;
  const action = parseDigest<ActionId>(input.action, at(path, 'action'));
  if (!action.ok) return action;
  const module = validateModuleRef(input.module, at(path, 'module'));
  if (!module.ok) return module;
  const implementation = parseNonZeroDigest<ImplementationDigest>(input.implementation, at(path, 'implementation'));
  if (!implementation.ok) return implementation;
  const adapter = validateAdapterRef(input.adapter, at(path, 'adapter'));
  if (!adapter.ok) return adapter;
  const bp = at(path, 'stateBindings');
  const barr = checkArray(input.stateBindings, MAX_STATE_BINDINGS, bp);
  if (!barr.ok) return barr;
  const bindings: StateBindingId[] = [];
  for (let i = 0; i < input.stateBindings.length; i += 1) {
    const id = parseDigest<StateBindingId>(input.stateBindings[i] as string, at(bp, i));
    if (!id.ok) return id;
    bindings.push(id.value);
  }
  const stateBindings = canonicalSet<StateBindingId>(bindings, writeDigestItem, bp);
  if (!stateBindings.ok) return stateBindings;
  let reservation: ReservationPointer | null = null;
  if (input.reservation !== null) {
    const rp = at(path, 'reservation');
    const rs = checkFields(input.reservation, ['reservationId', 'generation'], rp);
    if (!rs.ok) return rs;
    const reservationId = parseDigest<ReservationId>(input.reservation.reservationId, at(rp, 'reservationId'));
    if (!reservationId.ok) return reservationId;
    const generation = parseReservationGeneration(input.reservation.generation, at(rp, 'generation'));
    if (!generation.ok) return generation;
    // The id is derived from (action, generation); a pointer that disagrees names some other reservation.
    if (reservationIdFor(action.value, generation.value) !== reservationId.value) return fail('RESERVATION_ID_MISMATCH', at(rp, 'reservationId'));
    reservation = { reservationId: reservationId.value, generation: generation.value } as ReservationPointer;
  }
  let executionBinding: ExecutionBindingId | null = null;
  if (input.executionBinding !== null) {
    const eb = parseDigest<ExecutionBindingId>(input.executionBinding, at(path, 'executionBinding'));
    if (!eb.ok) return eb;
    executionBinding = eb.value;
  }
  let observation: ObservationId | null = null;
  if (input.observation !== null) {
    const ob = parseDigest<ObservationId>(input.observation, at(path, 'observation'));
    if (!ob.ok) return ob;
    observation = ob.value;
  }
  return ok({
    lineage: lineage as readonly AuthorityId[],
    policy: policy.value,
    action: action.value,
    module: module.value,
    implementation: implementation.value,
    adapter: adapter.value,
    stateBindings: stateBindings.value,
    reservation,
    executionBinding,
    observation,
  } as ReceiptReferences);
}

function writeReservationPointer(w: ByteWriter, p: ReservationPointer): void {
  writeDigest(w, p.reservationId);
  w.u64(p.generation);
}

function readReservationPointerInput(r: CoreReader): ReservationPointerInput {
  const reservationId = r.digest();
  const generation = r.u64();
  return { reservationId, generation };
}

export function encodeReceiptReferences(x: ReceiptReferences): Uint8Array {
  const w = taggedWriter(CoreTag.RECEIPT_REFERENCES);
  writeList(w, x.lineage, writeDigestItem);
  writeDigest(w, x.policy);
  writeDigest(w, x.action);
  writeModuleRef(w, x.module);
  writeDigest(w, x.implementation);
  writeAdapterRef(w, x.adapter);
  writeList(w, x.stateBindings, writeDigestItem);
  writeNullable(w, x.reservation, writeReservationPointer);
  writeNullable<Digest32>(w, x.executionBinding, writeDigestItem);
  writeNullable<Digest32>(w, x.observation, writeDigestItem);
  return w.finish();
}

function readReferencesInput(r: CoreReader): ReceiptReferencesInput {
  const lineage = r.list(MAX_LINEAGE_LENGTH, readDigestItem, false);
  const policy = r.digest();
  const action = r.digest();
  const module = readModuleRefInput(r);
  const implementation = r.digest();
  const adapter = readAdapterRefInput(r);
  const stateBindings = r.list(MAX_STATE_BINDINGS, readDigestItem, true);
  const reservation = readNullable(r, readReservationPointerInput);
  const executionBinding = readNullable(r, readDigestItem);
  const observation = readNullable(r, readDigestItem);
  return { lineage, policy, action, module, implementation, adapter, stateBindings, reservation, executionBinding, observation };
}

export function decodeReceiptReferences(bytes: Uint8Array): CoreResult<ReceiptReferences> {
  return decodeTagged(bytes, CoreTag.RECEIPT_REFERENCES, readReferencesInput, (input) => validateReceiptReferences(input));
}

export function receiptReferencesInputOf(x: ReceiptReferences): ReceiptReferencesInput {
  return {
    lineage: [...x.lineage],
    policy: x.policy,
    action: x.action,
    module: moduleRefInputOf(x.module),
    implementation: x.implementation,
    adapter: adapterRefInputOf(x.adapter),
    stateBindings: [...x.stateBindings],
    reservation: x.reservation === null ? null : { reservationId: x.reservation.reservationId, generation: x.reservation.generation },
    executionBinding: x.executionBinding,
    observation: x.observation,
  };
}
