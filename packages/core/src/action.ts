/**
 * The action envelope (action-state-model.md §4.1).
 *
 * The envelope is everything Core understands about an action, in every
 * domain: who proposes it, under which authority node, whose resources, which
 * exact semantic module reads it, which adapter will enforce it, which
 * resources it touches, when it may be reserved, and the digest of its payload.
 * It carries no domain fields. A swap, a perp order, a loan, a payment and a
 * vote are the same envelope with different `module`, `actionType` and
 * payload; the payload is the module's schema and reaches Core only by digest
 * (`payloadDigest`) and, in later phases, through the module's typed interface.
 *
 * Deliberately absent, as the specification requires:
 *
 * - the `ActionId` itself. It is the digest of this envelope and is computed,
 *   never supplied;
 * - state references. The snapshots an agent looked at are not decision
 *   inputs; Core admits its own state at decision time and binds it to the
 *   reservation and the execution binding as `StateBinding`s;
 * - risk direction and contribution amounts, which the module derives.
 *
 * The actor's signature over the `ActionId` is outside the envelope, as it is
 * outside every digest it signs.
 */

import { ok } from '@mandate/kernel';
import type { Tagged } from './brand.ts';
import { at, fail, type CoreResult } from './errors.ts';
import {
  RESOURCE_KINDS,
  partyIdInputOf,
  readPartyInput,
  readResourceIdInput,
  resourceIdInputOf,
  resourceIdsEqual,
  validateAgentId,
  validatePrincipalId,
  validateResourceId,
  writeParty,
  writeResourceId,
  type ActionId,
  type ActionType,
  type AgentId,
  type AuthorityId,
  type Nonce,
  type PartyIdInput,
  type PayloadDigest,
  type PrincipalId,
  type ResourceId,
  type ResourceIdInput,
} from './identifiers.ts';
import { checkArray, checkFields, parseDigest, parseIdentifierAs, parseUint64, type IntegerInput } from './primitives.ts';
import { CoreTag, canonicalSet, decodeTagged, keccakDigest, taggedWriter, writeDigest, writeList, type CoreReader } from './encoding.ts';
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
import { validateWindow } from './terms.ts';
import { MAX_ACTION_PAYLOAD_BYTES, MAX_ACTION_RESOURCES } from './limits.ts';

export interface ActionEnvelopeInput {
  readonly principal: PartyIdInput;
  readonly authority: string;
  readonly actor: PartyIdInput;
  readonly module: ModuleRefInput;
  readonly actionType: string;
  readonly adapter: AdapterRefInput;
  readonly target: ResourceIdInput;
  readonly resources: readonly ResourceIdInput[];
  readonly payloadDigest: string;
  readonly validFrom: IntegerInput;
  readonly expiresAt: IntegerInput;
  readonly nonce: IntegerInput;
}

export type ActionEnvelope = Tagged<
  {
    /** Whose authority is spent. Checked against the lineage root's principal, never trusted. */
    readonly principal: PrincipalId;
    /** The leaf node acted under. */
    readonly authority: AuthorityId;
    /** Must be the leaf's holder; signs the `ActionId`. Authentication, never authorization. */
    readonly actor: AgentId;
    /** The exact semantic module the payload is to be read under, for the whole lifecycle (DOM-2). */
    readonly module: ModuleRef;
    /** In the module's domain's closed vocabulary. */
    readonly actionType: ActionType;
    /** Where it will be enforced, version- and digest-bound as a module is (decision 26). */
    readonly adapter: AdapterRef;
    readonly target: ResourceId;
    /** Every other resource touched; excludes `target`; canonical order. */
    readonly resources: readonly ResourceId[];
    readonly payloadDigest: PayloadDigest;
    /** Not reservable before. */
    readonly validFrom: bigint;
    /** Not reservable at or after; bounds every attempt. */
    readonly expiresAt: bigint;
    /** Lets the same action be proposed twice deliberately; the replay key is the `ActionId`, which covers it. */
    readonly nonce: Nonce;
  },
  'ActionEnvelope'
>;

const ACTION_FIELDS = [
  'principal',
  'authority',
  'actor',
  'module',
  'actionType',
  'adapter',
  'target',
  'resources',
  'payloadDigest',
  'validFrom',
  'expiresAt',
  'nonce',
] as const;

export function validateActionEnvelope(input: ActionEnvelopeInput, path = 'action'): CoreResult<ActionEnvelope> {
  const shape = checkFields(input, ACTION_FIELDS, path);
  if (!shape.ok) return shape;
  const principal = validatePrincipalId(input.principal, at(path, 'principal'));
  if (!principal.ok) return principal;
  const authority = parseDigest<AuthorityId>(input.authority, at(path, 'authority'));
  if (!authority.ok) return authority;
  const actor = validateAgentId(input.actor, at(path, 'actor'));
  if (!actor.ok) return actor;
  const module = validateModuleRef(input.module, at(path, 'module'));
  if (!module.ok) return module;
  const actionType = parseIdentifierAs<ActionType>(input.actionType, at(path, 'actionType'));
  if (!actionType.ok) return actionType;
  const adapter = validateAdapterRef(input.adapter, at(path, 'adapter'));
  if (!adapter.ok) return adapter;
  const target = validateResourceId(input.target, RESOURCE_KINDS, at(path, 'target'));
  if (!target.ok) return target;
  const rp = at(path, 'resources');
  const arr = checkArray(input.resources, MAX_ACTION_RESOURCES, rp);
  if (!arr.ok) return arr;
  const resources: ResourceId[] = [];
  for (let i = 0; i < input.resources.length; i += 1) {
    const r = validateResourceId(input.resources[i] as ResourceIdInput, RESOURCE_KINDS, at(rp, i));
    if (!r.ok) return r;
    if (resourceIdsEqual(r.value, target.value)) return fail('TARGET_REPEATED_IN_RESOURCES', at(rp, i));
    resources.push(r.value);
  }
  const canonicalResources = canonicalSet(resources, writeResourceId, rp);
  if (!canonicalResources.ok) return canonicalResources;
  const payloadDigest = parseDigest<PayloadDigest>(input.payloadDigest, at(path, 'payloadDigest'));
  if (!payloadDigest.ok) return payloadDigest;
  const window = validateWindow(input.validFrom, input.expiresAt, path, 'validFrom');
  if (!window.ok) return window;
  const nonce = parseUint64(input.nonce, at(path, 'nonce'));
  if (!nonce.ok) return nonce;
  return ok({
    principal: principal.value,
    authority: authority.value,
    actor: actor.value,
    module: module.value,
    actionType: actionType.value,
    adapter: adapter.value,
    target: target.value,
    resources: canonicalResources.value,
    payloadDigest: payloadDigest.value,
    validFrom: window.value.notBefore,
    expiresAt: window.value.expiresAt,
    nonce: nonce.value as Nonce,
  } as ActionEnvelope);
}

export function encodeActionEnvelope(a: ActionEnvelope): Uint8Array {
  const w = taggedWriter(CoreTag.ACTION);
  writeParty(w, a.principal);
  writeDigest(w, a.authority);
  writeParty(w, a.actor);
  writeModuleRef(w, a.module);
  w.str(a.actionType);
  writeAdapterRef(w, a.adapter);
  writeResourceId(w, a.target);
  writeList(w, a.resources, writeResourceId);
  writeDigest(w, a.payloadDigest);
  w.i64(a.validFrom).i64(a.expiresAt).u64(a.nonce);
  return w.finish();
}

function readActionInput(r: CoreReader): ActionEnvelopeInput {
  const principal = readPartyInput(r);
  const authority = r.digest();
  const actor = readPartyInput(r);
  const module = readModuleRefInput(r);
  const actionType = r.str();
  const adapter = readAdapterRefInput(r);
  const target = readResourceIdInput(r);
  const resources = r.list(MAX_ACTION_RESOURCES, readResourceIdInput, true);
  const payloadDigest = r.digest();
  const validFrom = r.i64();
  const expiresAt = r.i64();
  const nonce = r.u64();
  return { principal, authority, actor, module, actionType, adapter, target, resources, payloadDigest, validFrom, expiresAt, nonce };
}

export function decodeActionEnvelope(bytes: Uint8Array): CoreResult<ActionEnvelope> {
  return decodeTagged(bytes, CoreTag.ACTION, readActionInput, (input) => validateActionEnvelope(input));
}

/** The `ActionDigest`: the intent's identity and replay key. */
export function actionId(a: ActionEnvelope): ActionId {
  return keccakDigest<ActionId>(encodeActionEnvelope(a));
}

export function actionEnvelopeInputOf(a: ActionEnvelope): ActionEnvelopeInput {
  return {
    principal: partyIdInputOf(a.principal),
    authority: a.authority,
    actor: partyIdInputOf(a.actor),
    module: moduleRefInputOf(a.module),
    actionType: a.actionType,
    adapter: adapterRefInputOf(a.adapter),
    target: resourceIdInputOf(a.target),
    resources: a.resources.map((r) => resourceIdInputOf(r)),
    payloadDigest: a.payloadDigest,
    validFrom: a.validFrom,
    expiresAt: a.expiresAt,
    nonce: a.nonce,
  };
}

/**
 * `payloadDigest = H("mandate-core/v1/payload/" ‖ moduleDigest, payload)`.
 *
 * The module digest is inside the hashed bytes, so one payload read under two
 * modules has two digests: a payload cannot be lifted from one module's action
 * into another's. Encoded as `str(tag) ‖ u16(1) ‖ moduleDigest ‖ u32(length) ‖
 * payload`. Core hashes the payload and never parses it.
 */
export function actionPayloadDigest(module: ModuleRef, payload: Uint8Array): CoreResult<PayloadDigest> {
  if (!(payload instanceof Uint8Array)) return fail('WRONG_TYPE', 'payload');
  if (payload.length > MAX_ACTION_PAYLOAD_BYTES) return fail('COLLECTION_TOO_LARGE', 'payload');
  const w = taggedWriter(CoreTag.ACTION_PAYLOAD);
  writeDigest(w, module.moduleDigest);
  w.u32(payload.length).raw(payload);
  return ok(keccakDigest<PayloadDigest>(w.finish()));
}
