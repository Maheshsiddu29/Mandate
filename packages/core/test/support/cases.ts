/**
 * Every canonical Core object type, with its validator, codec, digest and a
 * representative sample input. Round-trip tests, the vector generator and the
 * benchmark all iterate this one list, so a new object type added here is
 * covered by all three.
 */

import {
  actionEnvelopeInputOf,
  actionId,
  adapterRefDigest,
  adapterRefInputOf,
  authorityGrantInputOf,
  authorityId,
  decodeActionEnvelope,
  decodeAdapterRef,
  decodeAuthorityGrant,
  decodeExecutionAuthorization,
  decodeExecutionBindingRef,
  decodeModuleRef,
  decodePrincipalPolicy,
  decodeQuantity,
  decodeReceiptHeader,
  decodeReceiptReferences,
  decodeReservationRef,
  decodeStateBinding,
  decodeStateEnvelope,
  encodeActionEnvelope,
  encodeAdapterRef,
  encodeAuthorityGrant,
  encodeExecutionAuthorization,
  encodeExecutionBindingRef,
  encodeModuleRef,
  encodePrincipalPolicy,
  encodeQuantity,
  encodeReceiptHeader,
  encodeReceiptReferences,
  encodeReservationRef,
  encodeStateBinding,
  encodeStateEnvelope,
  executionAuthorizationId,
  executionAuthorizationInputOf,
  executionBindingId,
  executionBindingRefInputOf,
  moduleRefDigest,
  moduleRefInputOf,
  principalPolicyId,
  principalPolicyInputOf,
  quantityDigest,
  quantityInputOf,
  receiptHeaderInputOf,
  receiptReferencesInputOf,
  reservationIdOf,
  reservationRefDigest,
  reservationRefInputOf,
  stateBindingId,
  stateBindingIdsOf,
  stateBindingInputOf,
  stateEnvelopeInputOf,
  stateId,
  validateActionEnvelope,
  validateAdapterRef,
  validateAuthorityGrant,
  validateExecutionAuthorization,
  validateExecutionBindingRef,
  validateModuleRef,
  validatePrincipalPolicy,
  validateQuantity,
  validateReceiptHeader,
  validateReceiptReferences,
  validateReservationRef,
  validateStateBinding,
  validateStateEnvelope,
  type CoreError,
  type CoreResult,
} from '../../src/index.ts';
import {
  EVM_GATE,
  PERP_V1,
  must,
  sampleActionInput,
  sampleAuthorizationInput,
  sampleBindingInput,
  sampleExecutionBindingInput,
  sampleGrantInput,
  samplePolicyInput,
  sampleQuantityInput,
  sampleReceiptHeaderInput,
  sampleReceiptReferencesInput,
  sampleReservationInput,
  sampleStateInput,
} from './fixtures.ts';

export interface CoreObjectCase<I, T> {
  readonly type: string;
  readonly input: I;
  readonly validate: (input: I) => CoreResult<T>;
  readonly encode: (value: T) => Uint8Array;
  readonly decode: (bytes: Uint8Array) => CoreResult<T>;
  readonly digest: ((value: T) => string) | null;
  readonly inputOf: (value: T) => I;
}

/** A case with its type parameters closed over, so heterogeneous cases share one list. */
export interface ErasedCase {
  readonly type: string;
  /** The input, JSON-safe: bigints as canonical decimal strings, which every validator accepts. */
  readonly inputJson: JsonValue;
  /** Validate the input and encode it. */
  canonical(): Uint8Array;
  digest(): string | null;
  /** Validate the JSON form of the input (as a vector reader would) and encode it. */
  canonicalFromJson(): Uint8Array;
  /** decode → validate → encode. */
  reencode(bytes: Uint8Array): CoreResult<Uint8Array>;
  /** validate → inputOf → validate → encode: the object's own input form reproduces it. */
  reencodeViaInputOf(): Uint8Array;
  decodeError(bytes: Uint8Array): CoreError | null;
  /** Encode and hash the already-validated value `n` times, for the benchmark. */
  encodeOnly(): Uint8Array;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function toJson(value: object | string | number | bigint | boolean | null): JsonValue {
  if (value === null) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v: object | string | number | bigint | boolean | null) => toJson(v));
  const out: { [key: string]: JsonValue } = {};
  for (const [k, v] of Object.entries(value)) out[k] = toJson(v as object | string | number | bigint | boolean | null);
  return out;
}

export function erase<I extends object, T>(c: CoreObjectCase<I, T>): ErasedCase {
  const value = must(c.validate(c.input));
  const json = toJson(c.input);
  return {
    type: c.type,
    inputJson: json,
    canonical: () => c.encode(must(c.validate(c.input))),
    digest: () => (c.digest === null ? null : c.digest(value)),
    canonicalFromJson: () => c.encode(must(c.validate(JSON.parse(JSON.stringify(json)) as I))),
    reencode: (bytes) => {
      const decoded = c.decode(bytes);
      return decoded.ok ? { ok: true, value: c.encode(decoded.value) } : decoded;
    },
    reencodeViaInputOf: () => c.encode(must(c.validate(c.inputOf(value)))),
    decodeError: (bytes) => {
      const decoded = c.decode(bytes);
      return decoded.ok ? null : decoded.error;
    },
    encodeOnly: () => c.encode(value),
  };
}

export function coreCases(): ErasedCase[] {
  const action = must(validateActionEnvelope(sampleActionInput()));
  const aId = actionId(action);
  const state = must(validateStateEnvelope(sampleStateInput()));
  const binding = must(validateStateBinding(sampleBindingInput(stateId(state))));
  const authorization = must(validateExecutionAuthorization(sampleAuthorizationInput(aId, [stateBindingInputOf(binding)])));
  const authorizationId = executionAuthorizationId(authorization);
  const bindingIds = [...stateBindingIdsOf(authorization)];
  const executionBinding = must(validateExecutionBindingRef(sampleExecutionBindingInput(authorizationId, aId, bindingIds)));
  const reservationId = reservationIdOf(authorization.reservation);

  return [
    erase({ type: 'ModuleRef', input: PERP_V1, validate: (i) => validateModuleRef(i), encode: encodeModuleRef, decode: decodeModuleRef, digest: moduleRefDigest, inputOf: moduleRefInputOf }),
    erase({ type: 'AdapterRef', input: EVM_GATE, validate: (i) => validateAdapterRef(i), encode: encodeAdapterRef, decode: decodeAdapterRef, digest: adapterRefDigest, inputOf: adapterRefInputOf }),
    erase({ type: 'EconomicQuantity', input: sampleQuantityInput(), validate: (i) => validateQuantity(i), encode: encodeQuantity, decode: decodeQuantity, digest: quantityDigest, inputOf: quantityInputOf }),
    erase({ type: 'PrincipalPolicy', input: samplePolicyInput(), validate: (i) => validatePrincipalPolicy(i), encode: encodePrincipalPolicy, decode: decodePrincipalPolicy, digest: principalPolicyId, inputOf: principalPolicyInputOf }),
    erase({ type: 'AuthorityGrant', input: sampleGrantInput(), validate: (i) => validateAuthorityGrant(i), encode: encodeAuthorityGrant, decode: decodeAuthorityGrant, digest: authorityId, inputOf: authorityGrantInputOf }),
    erase({ type: 'ActionEnvelope', input: sampleActionInput(), validate: (i) => validateActionEnvelope(i), encode: encodeActionEnvelope, decode: decodeActionEnvelope, digest: actionId, inputOf: actionEnvelopeInputOf }),
    erase({ type: 'StateEnvelope', input: sampleStateInput(), validate: (i) => validateStateEnvelope(i), encode: encodeStateEnvelope, decode: decodeStateEnvelope, digest: stateId, inputOf: stateEnvelopeInputOf }),
    erase({ type: 'StateBinding', input: sampleBindingInput(stateId(state)), validate: (i) => validateStateBinding(i), encode: encodeStateBinding, decode: decodeStateBinding, digest: stateBindingId, inputOf: stateBindingInputOf }),
    erase({ type: 'ReservationRef', input: sampleReservationInput(aId), validate: (i) => validateReservationRef(i), encode: encodeReservationRef, decode: decodeReservationRef, digest: reservationRefDigest, inputOf: reservationRefInputOf }),
    erase({
      type: 'ExecutionAuthorization',
      input: sampleAuthorizationInput(aId, [stateBindingInputOf(binding)]),
      validate: (i) => validateExecutionAuthorization(i),
      encode: encodeExecutionAuthorization,
      decode: decodeExecutionAuthorization,
      digest: executionAuthorizationId,
      inputOf: executionAuthorizationInputOf,
    }),
    erase({
      type: 'ExecutionBindingRef',
      input: executionBindingRefInputOf(executionBinding),
      validate: (i) => validateExecutionBindingRef(i),
      encode: encodeExecutionBindingRef,
      decode: decodeExecutionBindingRef,
      digest: executionBindingId,
      inputOf: executionBindingRefInputOf,
    }),
    erase({ type: 'ReceiptHeader', input: sampleReceiptHeaderInput(), validate: (i) => validateReceiptHeader(i), encode: encodeReceiptHeader, decode: decodeReceiptHeader, digest: null, inputOf: receiptHeaderInputOf }),
    erase({
      type: 'ReceiptReferences',
      input: sampleReceiptReferencesInput(aId, reservationId, bindingIds, executionBindingId(executionBinding)),
      validate: (i) => validateReceiptReferences(i),
      encode: encodeReceiptReferences,
      decode: decodeReceiptReferences,
      digest: null,
      inputOf: receiptReferencesInputOf,
    }),
  ];
}

/** A codec driven by a vector's JSON input, for the committed corpus. */
export interface JsonCodec {
  encodeJson(input: JsonValue): CoreResult<Uint8Array>;
  digestJson(input: JsonValue): string | null;
  reencode(bytes: Uint8Array): CoreResult<Uint8Array>;
  decodeError(bytes: Uint8Array): CoreError | null;
}

function jsonCodec<I, T>(
  validate: (input: I) => CoreResult<T>,
  encode: (value: T) => Uint8Array,
  decode: (bytes: Uint8Array) => CoreResult<T>,
  digest: ((value: T) => string) | null,
): JsonCodec {
  // JSON inputs carry bigints as canonical decimal strings, which every validator accepts.
  const fromJson = (json: JsonValue): CoreResult<T> => validate(json as unknown as I);
  return {
    encodeJson: (json) => {
      const v = fromJson(json);
      return v.ok ? { ok: true, value: encode(v.value) } : v;
    },
    digestJson: (json) => (digest === null ? null : digest(must(fromJson(json)))),
    reencode: (bytes) => {
      const d = decode(bytes);
      return d.ok ? { ok: true, value: encode(d.value) } : d;
    },
    decodeError: (bytes) => {
      const d = decode(bytes);
      return d.ok ? null : d.error;
    },
  };
}

export const JSON_CODECS: { readonly [type: string]: JsonCodec } = {
  ModuleRef: jsonCodec((i: Parameters<typeof validateModuleRef>[0]) => validateModuleRef(i), encodeModuleRef, decodeModuleRef, moduleRefDigest),
  AdapterRef: jsonCodec((i: Parameters<typeof validateAdapterRef>[0]) => validateAdapterRef(i), encodeAdapterRef, decodeAdapterRef, adapterRefDigest),
  EconomicQuantity: jsonCodec((i: Parameters<typeof validateQuantity>[0]) => validateQuantity(i), encodeQuantity, decodeQuantity, quantityDigest),
  PrincipalPolicy: jsonCodec((i: Parameters<typeof validatePrincipalPolicy>[0]) => validatePrincipalPolicy(i), encodePrincipalPolicy, decodePrincipalPolicy, principalPolicyId),
  AuthorityGrant: jsonCodec((i: Parameters<typeof validateAuthorityGrant>[0]) => validateAuthorityGrant(i), encodeAuthorityGrant, decodeAuthorityGrant, authorityId),
  ActionEnvelope: jsonCodec((i: Parameters<typeof validateActionEnvelope>[0]) => validateActionEnvelope(i), encodeActionEnvelope, decodeActionEnvelope, actionId),
  StateEnvelope: jsonCodec((i: Parameters<typeof validateStateEnvelope>[0]) => validateStateEnvelope(i), encodeStateEnvelope, decodeStateEnvelope, stateId),
  StateBinding: jsonCodec((i: Parameters<typeof validateStateBinding>[0]) => validateStateBinding(i), encodeStateBinding, decodeStateBinding, stateBindingId),
  ReservationRef: jsonCodec((i: Parameters<typeof validateReservationRef>[0]) => validateReservationRef(i), encodeReservationRef, decodeReservationRef, reservationRefDigest),
  ExecutionAuthorization: jsonCodec(
    (i: Parameters<typeof validateExecutionAuthorization>[0]) => validateExecutionAuthorization(i),
    encodeExecutionAuthorization,
    decodeExecutionAuthorization,
    executionAuthorizationId,
  ),
  ExecutionBindingRef: jsonCodec(
    (i: Parameters<typeof validateExecutionBindingRef>[0]) => validateExecutionBindingRef(i),
    encodeExecutionBindingRef,
    decodeExecutionBindingRef,
    executionBindingId,
  ),
  ReceiptHeader: jsonCodec((i: Parameters<typeof validateReceiptHeader>[0]) => validateReceiptHeader(i), encodeReceiptHeader, decodeReceiptHeader, null),
  ReceiptReferences: jsonCodec((i: Parameters<typeof validateReceiptReferences>[0]) => validateReceiptReferences(i), encodeReceiptReferences, decodeReceiptReferences, null),
};
