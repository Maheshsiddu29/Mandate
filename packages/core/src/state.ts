/**
 * The state model (action-state-model.md §5; CORE-CONC-1, STATE-4, STATE-5).
 *
 * Two objects, kept apart on purpose:
 *
 * - a `StateEnvelope` says *this observation exists*: which domain and state
 *   kind, which subject, from which configured source at which trust class,
 *   when, at which sequence and finality, with which payload. Its digest is
 *   the `StateId` (`StateDigest`). The payload is the domain's and is committed
 *   by digest only; there is no universal state struct.
 * - a `StateBinding` says *this authorization relied on exactly that
 *   observation, under this requirement*. It restates the provenance fields,
 *   names the envelope by `StateId`, and carries the effective
 *   `StateRequirement` it was admitted under, so a reservation and its
 *   receipts record not only what state was used but how long, and up to which
 *   lifecycle point, it may be relied on.
 *
 * Freshness is the consumer's policy, declared per state kind and never a
 * universal interval: by age, by block distance, by sequence against the
 * ledger's watermark, or by a pinned version. Finality is a level on a ladder
 * the source or adapter declares, so venue-acknowledged, venue-final and
 * chain-final are all expressible and blockchain finality is not special.
 *
 * Nothing here admits, evaluates or compares state. That is 7D.
 */

import { ok, TrustClass, type ByteWriter } from '@mandate/kernel';
import type { Tagged } from './brand.ts';
import { at, fail, type CoreResult } from './errors.ts';
import {
  RESOURCE_KINDS,
  readResourceIdInput,
  resourceIdInputOf,
  validateResourceId,
  writeResourceId,
  type ArtifactField,
  type DomainId,
  type FinalityLadderId,
  type FinalityLevel,
  type ResourceId,
  type ResourceIdInput,
  type StateBindingId,
  type StateId,
  type StateKind,
  type StatePayloadDigest,
  type StateSourceId,
} from './identifiers.ts';
import {
  UINT32_MAX,
  checkFields,
  parseDigest,
  parseEnum,
  parseIdentifierAs,
  parseIntegerInRange,
  parseUint64,
  parseUnixSeconds,
  type IntegerInput,
} from './primitives.ts';
import {
  CoreTag,
  decodeTagged,
  keccakDigest,
  readCode,
  readNullable,
  taggedWriter,
  writeCode,
  writeDigest,
  writeNullable,
  type CoreReader,
  type WireCodes,
} from './encoding.ts';

// --- Trust -----------------------------------------------------------------------

/** The kernel's four-level vocabulary, reused unchanged (action-state-model.md §5.1). */
export type { TrustClass };
const TRUST_CLASSES: readonly TrustClass[] = Object.values(TrustClass);
/** The kernel's frozen wire codes for the same vocabulary. */
const TRUST_CLASS_CODE: WireCodes<TrustClass> = { AUTHORITATIVE: 1, VERIFIED: 2, ADVISORY: 3, UNTRUSTED: 4 };

/** Only these are ever admitted for a decision, as in the kernel. */
export type AdmissibleTrustClass = 'AUTHORITATIVE' | 'VERIFIED';
const ADMISSIBLE_TRUST: readonly AdmissibleTrustClass[] = ['AUTHORITATIVE', 'VERIFIED'];

// --- Finality --------------------------------------------------------------------

export interface FinalityRefInput {
  readonly ladder: string;
  readonly level: string;
}

/**
 * A level on a declared finality ladder: `{ladder: "evm.block", level:
 * "FINALIZED"}`, `{ladder: "venue-l.order", level: "ACKNOWLEDGED"}`. The ladder
 * and its order are the source's or adapter's declaration (enforcement-adapters
 * §2 `finalityLadder`); Core names the level exactly and never infers one
 * ladder's levels from another's.
 */
export type FinalityRef = Tagged<{ readonly ladder: FinalityLadderId; readonly level: FinalityLevel }, 'FinalityRef'>;

export function validateFinalityRef(input: FinalityRefInput, path: string): CoreResult<FinalityRef> {
  const shape = checkFields(input, ['ladder', 'level'], path);
  if (!shape.ok) return shape;
  const ladder = parseIdentifierAs<FinalityLadderId>(input.ladder, at(path, 'ladder'));
  if (!ladder.ok) return ladder;
  const level = parseIdentifierAs<FinalityLevel>(input.level, at(path, 'level'));
  if (!level.ok) return level;
  return ok({ ladder: ladder.value, level: level.value } as FinalityRef);
}

function writeFinality(w: ByteWriter, f: FinalityRef): void {
  w.str(f.ladder).str(f.level);
}

function readFinalityInput(r: CoreReader): FinalityRefInput {
  const ladder = r.str();
  const level = r.str();
  return { ladder, level };
}

// --- Freshness -------------------------------------------------------------------

export type FreshnessPolicyInput =
  | { readonly kind: 'AGE'; readonly maxAgeSeconds: IntegerInput }
  | { readonly kind: 'BLOCKS'; readonly maxBlocksBehind: IntegerInput }
  | { readonly kind: 'SEQUENCE' }
  | { readonly kind: 'VERSION'; readonly pinnedDigest: string; readonly maxAgeSeconds: IntegerInput };

/**
 * action-state-model.md §5.5:
 * `AGE(maxAgeSeconds) | BLOCKS(maxBehind) | SEQUENCE(≥ ledger watermark) | VERSION(pinned digest, with maxAgeSeconds)`.
 * `SEQUENCE` has no parameter: its bound is the ledger's reconciliation
 * watermark for the subject, read at decision time.
 */
export type FreshnessPolicy =
  | { readonly kind: 'AGE'; readonly maxAgeSeconds: bigint }
  | { readonly kind: 'BLOCKS'; readonly maxBlocksBehind: bigint }
  | { readonly kind: 'SEQUENCE' }
  | { readonly kind: 'VERSION'; readonly pinnedDigest: StatePayloadDigest; readonly maxAgeSeconds: bigint };

const FRESHNESS_KINDS: readonly FreshnessPolicy['kind'][] = ['AGE', 'BLOCKS', 'SEQUENCE', 'VERSION'];
const FRESHNESS_CODE: WireCodes<FreshnessPolicy['kind']> = { AGE: 1, BLOCKS: 2, SEQUENCE: 3, VERSION: 4 };

function parseSeconds32(raw: IntegerInput, path: string): CoreResult<bigint> {
  return parseIntegerInRange(raw, 0n, BigInt(UINT32_MAX), path);
}

export function validateFreshnessPolicy(input: FreshnessPolicyInput, path: string): CoreResult<FreshnessPolicy> {
  if (typeof input !== 'object' || input === null) return fail('WRONG_TYPE', path);
  const kind = parseEnum(input.kind, FRESHNESS_KINDS, at(path, 'kind'));
  if (!kind.ok) return kind;
  switch (input.kind) {
    case 'AGE': {
      const shape = checkFields(input, ['kind', 'maxAgeSeconds'], path);
      if (!shape.ok) return shape;
      const maxAge = parseSeconds32(input.maxAgeSeconds, at(path, 'maxAgeSeconds'));
      return maxAge.ok ? ok({ kind: 'AGE', maxAgeSeconds: maxAge.value }) : maxAge;
    }
    case 'BLOCKS': {
      const shape = checkFields(input, ['kind', 'maxBlocksBehind'], path);
      if (!shape.ok) return shape;
      const blocks = parseUint64(input.maxBlocksBehind, at(path, 'maxBlocksBehind'));
      return blocks.ok ? ok({ kind: 'BLOCKS', maxBlocksBehind: blocks.value }) : blocks;
    }
    case 'SEQUENCE': {
      const shape = checkFields(input, ['kind'], path);
      return shape.ok ? ok({ kind: 'SEQUENCE' }) : shape;
    }
    case 'VERSION': {
      const shape = checkFields(input, ['kind', 'pinnedDigest', 'maxAgeSeconds'], path);
      if (!shape.ok) return shape;
      const pinned = parseDigest<StatePayloadDigest>(input.pinnedDigest, at(path, 'pinnedDigest'));
      if (!pinned.ok) return pinned;
      const maxAge = parseSeconds32(input.maxAgeSeconds, at(path, 'maxAgeSeconds'));
      return maxAge.ok ? ok({ kind: 'VERSION', pinnedDigest: pinned.value, maxAgeSeconds: maxAge.value }) : maxAge;
    }
  }
}

function writeFreshness(w: ByteWriter, f: FreshnessPolicy): void {
  writeCode(w, FRESHNESS_CODE, f.kind);
  switch (f.kind) {
    case 'AGE':
      w.u32(f.maxAgeSeconds);
      break;
    case 'BLOCKS':
      w.u64(f.maxBlocksBehind);
      break;
    case 'SEQUENCE':
      break;
    case 'VERSION':
      writeDigest(w, f.pinnedDigest);
      w.u32(f.maxAgeSeconds);
      break;
  }
}

function readFreshnessInput(r: CoreReader): FreshnessPolicyInput {
  const kind = readCode(r, FRESHNESS_CODE);
  switch (kind) {
    case 'AGE':
      return { kind, maxAgeSeconds: BigInt(r.u32()) };
    case 'BLOCKS':
      return { kind, maxBlocksBehind: r.u64() };
    case 'SEQUENCE':
      return { kind };
    case 'VERSION': {
      const pinnedDigest = r.digest();
      return { kind, pinnedDigest, maxAgeSeconds: BigInt(r.u32()) };
    }
  }
}

function freshnessInputOf(f: FreshnessPolicy): FreshnessPolicyInput {
  switch (f.kind) {
    case 'AGE':
      return { kind: 'AGE', maxAgeSeconds: f.maxAgeSeconds };
    case 'BLOCKS':
      return { kind: 'BLOCKS', maxBlocksBehind: f.maxBlocksBehind };
    case 'SEQUENCE':
      return { kind: 'SEQUENCE' };
    case 'VERSION':
      return { kind: 'VERSION', pinnedDigest: f.pinnedDigest, maxAgeSeconds: f.maxAgeSeconds };
  }
}

// --- Execution dependence and the state requirement ------------------------------

export type ExecutionDependenceInput =
  | { readonly kind: 'NOT_REQUIRED' }
  | { readonly kind: 'ENFORCED_BY_ARTIFACT'; readonly field: string }
  | { readonly kind: 'BOUNDED_BY_FRESHNESS' };

/** Whether, and how, a state dependency must still hold when the enforcement point executes. */
export type ExecutionDependence =
  | { readonly kind: 'NOT_REQUIRED' }
  | { readonly kind: 'ENFORCED_BY_ARTIFACT'; readonly field: ArtifactField }
  | { readonly kind: 'BOUNDED_BY_FRESHNESS' };

const DEPENDENCE_KINDS: readonly ExecutionDependence['kind'][] = ['NOT_REQUIRED', 'ENFORCED_BY_ARTIFACT', 'BOUNDED_BY_FRESHNESS'];
const DEPENDENCE_CODE: WireCodes<ExecutionDependence['kind']> = { NOT_REQUIRED: 1, ENFORCED_BY_ARTIFACT: 2, BOUNDED_BY_FRESHNESS: 3 };

export const AtIssue = { WITHIN_POLICY: 'WITHIN_POLICY', RECHECK: 'RECHECK' } as const;
export type AtIssue = (typeof AtIssue)[keyof typeof AtIssue];
const AT_ISSUE_VALUES: readonly AtIssue[] = Object.values(AtIssue);
const AT_ISSUE_CODE: WireCodes<AtIssue> = { WITHIN_POLICY: 1, RECHECK: 2 };

export interface StateRequirementInput {
  readonly freshness: FreshnessPolicyInput;
  readonly minTrust: AdmissibleTrustClass;
  readonly minFinality: FinalityRefInput;
  readonly atIssue: AtIssue;
  readonly atExecution: ExecutionDependenceInput;
}

/**
 * The requirement for one state kind (action-state-model.md §5.5). The state
 * kind itself is carried by whatever holds the requirement (a state-policy
 * term, a binding), so it is written once.
 */
export type StateRequirement = Tagged<
  {
    readonly freshness: FreshnessPolicy;
    readonly minTrust: AdmissibleTrustClass;
    readonly minFinality: FinalityRef;
    readonly atIssue: AtIssue;
    readonly atExecution: ExecutionDependence;
  },
  'StateRequirement'
>;

function validateExecutionDependence(input: ExecutionDependenceInput, path: string): CoreResult<ExecutionDependence> {
  if (typeof input !== 'object' || input === null) return fail('WRONG_TYPE', path);
  const kind = parseEnum(input.kind, DEPENDENCE_KINDS, at(path, 'kind'));
  if (!kind.ok) return kind;
  if (input.kind === 'ENFORCED_BY_ARTIFACT') {
    const shape = checkFields(input, ['kind', 'field'], path);
    if (!shape.ok) return shape;
    const field = parseIdentifierAs<ArtifactField>(input.field, at(path, 'field'));
    return field.ok ? ok({ kind: 'ENFORCED_BY_ARTIFACT', field: field.value }) : field;
  }
  const shape = checkFields(input, ['kind'], path);
  return shape.ok ? ok({ kind: input.kind }) : shape;
}

export function validateStateRequirement(input: StateRequirementInput, path: string): CoreResult<StateRequirement> {
  const shape = checkFields(input, ['freshness', 'minTrust', 'minFinality', 'atIssue', 'atExecution'], path);
  if (!shape.ok) return shape;
  const freshness = validateFreshnessPolicy(input.freshness, at(path, 'freshness'));
  if (!freshness.ok) return freshness;
  const trust = parseEnum(input.minTrust, TRUST_CLASSES, at(path, 'minTrust'));
  if (!trust.ok) return trust;
  const minTrust = ADMISSIBLE_TRUST.find((t) => t === trust.value);
  if (minTrust === undefined) return fail('MIN_TRUST_NOT_ADMISSIBLE', at(path, 'minTrust'));
  const minFinality = validateFinalityRef(input.minFinality, at(path, 'minFinality'));
  if (!minFinality.ok) return minFinality;
  const atIssue = parseEnum(input.atIssue, AT_ISSUE_VALUES, at(path, 'atIssue'));
  if (!atIssue.ok) return atIssue;
  const atExecution = validateExecutionDependence(input.atExecution, at(path, 'atExecution'));
  if (!atExecution.ok) return atExecution;
  // Block and sequence distance have no fixed mapping to time, so an artifact
  // cannot be made to expire with them (action-state-model.md §5.5).
  if (
    atExecution.value.kind === 'BOUNDED_BY_FRESHNESS' &&
    freshness.value.kind !== 'AGE' &&
    freshness.value.kind !== 'VERSION'
  ) {
    return fail('EXECUTION_DEPENDENCE_INCOMPATIBLE', at(path, 'atExecution'));
  }
  return ok({
    freshness: freshness.value,
    minTrust,
    minFinality: minFinality.value,
    atIssue: atIssue.value,
    atExecution: atExecution.value,
  } as StateRequirement);
}

export function writeStateRequirement(w: ByteWriter, s: StateRequirement): void {
  writeFreshness(w, s.freshness);
  writeCode(w, TRUST_CLASS_CODE, s.minTrust);
  writeFinality(w, s.minFinality);
  writeCode(w, AT_ISSUE_CODE, s.atIssue);
  writeCode(w, DEPENDENCE_CODE, s.atExecution.kind);
  if (s.atExecution.kind === 'ENFORCED_BY_ARTIFACT') w.str(s.atExecution.field);
}

export function readStateRequirementInput(r: CoreReader): StateRequirementInput {
  const freshness = readFreshnessInput(r);
  // Any trust code decodes; the validator then refuses the two inadmissible ones by name.
  const minTrust = readCode(r, TRUST_CLASS_CODE) as AdmissibleTrustClass;
  const minFinality = readFinalityInput(r);
  const atIssue = readCode(r, AT_ISSUE_CODE);
  const dependence = readCode(r, DEPENDENCE_CODE);
  const atExecution: ExecutionDependenceInput =
    dependence === 'ENFORCED_BY_ARTIFACT' ? { kind: dependence, field: r.str() } : { kind: dependence };
  return { freshness, minTrust, minFinality, atIssue, atExecution };
}

export function stateRequirementInputOf(s: StateRequirement): StateRequirementInput {
  return {
    freshness: freshnessInputOf(s.freshness),
    minTrust: s.minTrust,
    minFinality: { ladder: s.minFinality.ladder, level: s.minFinality.level },
    atIssue: s.atIssue,
    atExecution: s.atExecution.kind === 'ENFORCED_BY_ARTIFACT' ? { kind: 'ENFORCED_BY_ARTIFACT', field: s.atExecution.field } : { kind: s.atExecution.kind },
  };
}

// --- Sequence --------------------------------------------------------------------

export type StateSequenceInput =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'BLOCK' | 'VENUE_SEQUENCE' | 'VERSION'; readonly value: IntegerInput };

export type StateSequence =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'BLOCK' | 'VENUE_SEQUENCE' | 'VERSION'; readonly value: bigint };

const SEQUENCE_KINDS: readonly StateSequence['kind'][] = ['NONE', 'BLOCK', 'VENUE_SEQUENCE', 'VERSION'];
const SEQUENCE_CODE: WireCodes<StateSequence['kind']> = { NONE: 1, BLOCK: 2, VENUE_SEQUENCE: 3, VERSION: 4 };

function validateSequence(input: StateSequenceInput, path: string): CoreResult<StateSequence> {
  if (typeof input !== 'object' || input === null) return fail('WRONG_TYPE', path);
  const kind = parseEnum(input.kind, SEQUENCE_KINDS, at(path, 'kind'));
  if (!kind.ok) return kind;
  if (input.kind === 'NONE') {
    const shape = checkFields(input, ['kind'], path);
    return shape.ok ? ok({ kind: 'NONE' }) : shape;
  }
  const shape = checkFields(input, ['kind', 'value'], path);
  if (!shape.ok) return shape;
  const value = parseUint64(input.value, at(path, 'value'));
  return value.ok ? ok({ kind: input.kind, value: value.value }) : value;
}

function writeSequence(w: ByteWriter, s: StateSequence): void {
  writeCode(w, SEQUENCE_CODE, s.kind);
  if (s.kind !== 'NONE') w.u64(s.value);
}

function readSequenceInput(r: CoreReader): StateSequenceInput {
  const kind = readCode(r, SEQUENCE_CODE);
  return kind === 'NONE' ? { kind } : { kind, value: r.u64() };
}

function sequenceInputOf(s: StateSequence): StateSequenceInput {
  return s.kind === 'NONE' ? { kind: 'NONE' } : { kind: s.kind, value: s.value };
}

function validateValidity(observedAt: bigint, validUntil: IntegerInput | null, path: string): CoreResult<bigint | null> {
  if (validUntil === null) return ok(null);
  const v = parseUnixSeconds(validUntil, path);
  if (!v.ok) return v;
  // A source-declared bound at or before the observation admits nothing, ever.
  return v.value > observedAt ? v : fail('STATE_VALIDITY_INVALID', path);
}

// --- StateEnvelope ---------------------------------------------------------------

export interface StateEnvelopeInput {
  readonly domain: string;
  readonly stateKind: string;
  readonly subject: ResourceIdInput;
  readonly sourceId: string;
  readonly trustClass: TrustClass;
  readonly observedAt: IntegerInput;
  readonly sequence: StateSequenceInput;
  readonly validUntil: IntegerInput | null;
  readonly finality: FinalityRefInput;
  readonly payloadDigest: string;
}

export type StateEnvelope = Tagged<
  {
    /** The interpreting module's manifest fixes the payload schema for `(domain, stateKind)`. */
    readonly domain: DomainId;
    readonly stateKind: StateKind;
    readonly subject: ResourceId;
    readonly sourceId: StateSourceId;
    /** The configured class of the source; admission checks it, the envelope only records it. */
    readonly trustClass: TrustClass;
    readonly observedAt: bigint;
    readonly sequence: StateSequence;
    readonly validUntil: bigint | null;
    /** The level on the source's ladder at which this was observed. */
    readonly finality: FinalityRef;
    readonly payloadDigest: StatePayloadDigest;
  },
  'StateEnvelope'
>;

const STATE_ENVELOPE_FIELDS = [
  'domain',
  'stateKind',
  'subject',
  'sourceId',
  'trustClass',
  'observedAt',
  'sequence',
  'validUntil',
  'finality',
  'payloadDigest',
] as const;

export function validateStateEnvelope(input: StateEnvelopeInput, path = 'state'): CoreResult<StateEnvelope> {
  const shape = checkFields(input, STATE_ENVELOPE_FIELDS, path);
  if (!shape.ok) return shape;
  const domain = parseIdentifierAs<DomainId>(input.domain, at(path, 'domain'));
  if (!domain.ok) return domain;
  const stateKind = parseIdentifierAs<StateKind>(input.stateKind, at(path, 'stateKind'));
  if (!stateKind.ok) return stateKind;
  const subject = validateResourceId(input.subject, RESOURCE_KINDS, at(path, 'subject'));
  if (!subject.ok) return subject;
  const sourceId = parseIdentifierAs<StateSourceId>(input.sourceId, at(path, 'sourceId'));
  if (!sourceId.ok) return sourceId;
  const trustClass = parseEnum(input.trustClass, TRUST_CLASSES, at(path, 'trustClass'));
  if (!trustClass.ok) return trustClass;
  const observedAt = parseUnixSeconds(input.observedAt, at(path, 'observedAt'));
  if (!observedAt.ok) return observedAt;
  const sequence = validateSequence(input.sequence, at(path, 'sequence'));
  if (!sequence.ok) return sequence;
  const validUntil = validateValidity(observedAt.value, input.validUntil, at(path, 'validUntil'));
  if (!validUntil.ok) return validUntil;
  const finality = validateFinalityRef(input.finality, at(path, 'finality'));
  if (!finality.ok) return finality;
  const payloadDigest = parseDigest<StatePayloadDigest>(input.payloadDigest, at(path, 'payloadDigest'));
  if (!payloadDigest.ok) return payloadDigest;
  return ok({
    domain: domain.value,
    stateKind: stateKind.value,
    subject: subject.value,
    sourceId: sourceId.value,
    trustClass: trustClass.value,
    observedAt: observedAt.value,
    sequence: sequence.value,
    validUntil: validUntil.value,
    finality: finality.value,
    payloadDigest: payloadDigest.value,
  } as StateEnvelope);
}

function writeI64(w: ByteWriter, v: bigint): void {
  w.i64(v);
}

function readI64(r: CoreReader): bigint {
  return r.i64();
}

export function encodeStateEnvelope(s: StateEnvelope): Uint8Array {
  const w = taggedWriter(CoreTag.STATE);
  w.str(s.domain).str(s.stateKind);
  writeResourceId(w, s.subject);
  w.str(s.sourceId);
  writeCode(w, TRUST_CLASS_CODE, s.trustClass);
  w.i64(s.observedAt);
  writeSequence(w, s.sequence);
  writeNullable(w, s.validUntil, writeI64);
  writeFinality(w, s.finality);
  writeDigest(w, s.payloadDigest);
  return w.finish();
}

function readStateEnvelopeInput(r: CoreReader): StateEnvelopeInput {
  const domain = r.str();
  const stateKind = r.str();
  const subject = readResourceIdInput(r);
  const sourceId = r.str();
  const trustClass = readCode(r, TRUST_CLASS_CODE);
  const observedAt = r.i64();
  const sequence = readSequenceInput(r);
  const validUntil = readNullable(r, readI64);
  const finality = readFinalityInput(r);
  const payloadDigest = r.digest();
  return { domain, stateKind, subject, sourceId, trustClass, observedAt, sequence, validUntil, finality, payloadDigest };
}

export function decodeStateEnvelope(bytes: Uint8Array): CoreResult<StateEnvelope> {
  return decodeTagged(bytes, CoreTag.STATE, readStateEnvelopeInput, (input) => validateStateEnvelope(input));
}

/** The `StateDigest`. */
export function stateId(s: StateEnvelope): StateId {
  return keccakDigest<StateId>(encodeStateEnvelope(s));
}

export function stateEnvelopeInputOf(s: StateEnvelope): StateEnvelopeInput {
  return {
    domain: s.domain,
    stateKind: s.stateKind,
    subject: resourceIdInputOf(s.subject),
    sourceId: s.sourceId,
    trustClass: s.trustClass,
    observedAt: s.observedAt,
    sequence: sequenceInputOf(s.sequence),
    validUntil: s.validUntil,
    finality: { ladder: s.finality.ladder, level: s.finality.level },
    payloadDigest: s.payloadDigest,
  };
}

// --- StateBinding ----------------------------------------------------------------

export interface StateBindingInput {
  readonly stateKind: string;
  readonly subject: ResourceIdInput;
  readonly sourceId: string;
  readonly trustClass: AdmissibleTrustClass;
  readonly sequence: StateSequenceInput;
  readonly observedAt: IntegerInput;
  readonly validUntil: IntegerInput | null;
  readonly finality: FinalityRefInput;
  readonly stateDigest: string;
  readonly requirement: StateRequirementInput;
}

/**
 * One admitted snapshot as an authorization relied on it (STATE-4). Every
 * field is mandatory: provenance cannot be omitted from a binding, and a
 * binding names its snapshot only by digest, so it cannot silently refer to a
 * different observation of the same subject.
 */
export type StateBinding = Tagged<
  {
    readonly stateKind: StateKind;
    readonly subject: ResourceId;
    readonly sourceId: StateSourceId;
    /** An admitted snapshot is always `AUTHORITATIVE` or `VERIFIED`. */
    readonly trustClass: AdmissibleTrustClass;
    readonly sequence: StateSequence;
    readonly observedAt: bigint;
    readonly validUntil: bigint | null;
    readonly finality: FinalityRef;
    readonly stateDigest: StateId;
    /** The effective requirement it was admitted under: the tightest of module, lineage and principal policy. */
    readonly requirement: StateRequirement;
  },
  'StateBinding'
>;

const STATE_BINDING_FIELDS = [
  'stateKind',
  'subject',
  'sourceId',
  'trustClass',
  'sequence',
  'observedAt',
  'validUntil',
  'finality',
  'stateDigest',
  'requirement',
] as const;

export function validateStateBinding(input: StateBindingInput, path = 'binding'): CoreResult<StateBinding> {
  const shape = checkFields(input, STATE_BINDING_FIELDS, path);
  if (!shape.ok) return shape;
  const stateKind = parseIdentifierAs<StateKind>(input.stateKind, at(path, 'stateKind'));
  if (!stateKind.ok) return stateKind;
  const subject = validateResourceId(input.subject, RESOURCE_KINDS, at(path, 'subject'));
  if (!subject.ok) return subject;
  const sourceId = parseIdentifierAs<StateSourceId>(input.sourceId, at(path, 'sourceId'));
  if (!sourceId.ok) return sourceId;
  const trust = parseEnum(input.trustClass, TRUST_CLASSES, at(path, 'trustClass'));
  if (!trust.ok) return trust;
  const trustClass = ADMISSIBLE_TRUST.find((t) => t === trust.value);
  if (trustClass === undefined) return fail('TRUST_CLASS_NOT_ADMISSIBLE', at(path, 'trustClass'));
  const sequence = validateSequence(input.sequence, at(path, 'sequence'));
  if (!sequence.ok) return sequence;
  const observedAt = parseUnixSeconds(input.observedAt, at(path, 'observedAt'));
  if (!observedAt.ok) return observedAt;
  const validUntil = validateValidity(observedAt.value, input.validUntil, at(path, 'validUntil'));
  if (!validUntil.ok) return validUntil;
  const finality = validateFinalityRef(input.finality, at(path, 'finality'));
  if (!finality.ok) return finality;
  const stateDigest = parseDigest<StateId>(input.stateDigest, at(path, 'stateDigest'));
  if (!stateDigest.ok) return stateDigest;
  const requirement = validateStateRequirement(input.requirement, at(path, 'requirement'));
  if (!requirement.ok) return requirement;
  return ok({
    stateKind: stateKind.value,
    subject: subject.value,
    sourceId: sourceId.value,
    trustClass,
    sequence: sequence.value,
    observedAt: observedAt.value,
    validUntil: validUntil.value,
    finality: finality.value,
    stateDigest: stateDigest.value,
    requirement: requirement.value,
  } as StateBinding);
}

/**
 * The binding of an envelope under a requirement, with every provenance field
 * copied from the envelope and its digest computed here rather than supplied.
 * The only way to get a binding that disagrees with its snapshot is to build
 * one by hand, which `validateStateBinding` still checks structurally.
 */
export function bindState(envelope: StateEnvelope, requirement: StateRequirementInput, path = 'binding'): CoreResult<StateBinding> {
  if (envelope.trustClass !== 'AUTHORITATIVE' && envelope.trustClass !== 'VERIFIED') {
    return fail('TRUST_CLASS_NOT_ADMISSIBLE', at(path, 'trustClass'));
  }
  const e = stateEnvelopeInputOf(envelope);
  return validateStateBinding(
    {
      stateKind: e.stateKind,
      subject: e.subject,
      sourceId: e.sourceId,
      trustClass: envelope.trustClass,
      sequence: e.sequence,
      observedAt: e.observedAt,
      validUntil: e.validUntil,
      finality: e.finality,
      stateDigest: stateId(envelope),
      requirement,
    },
    path,
  );
}

export function writeStateBinding(w: ByteWriter, b: StateBinding): void {
  w.str(b.stateKind);
  writeResourceId(w, b.subject);
  w.str(b.sourceId);
  writeCode(w, TRUST_CLASS_CODE, b.trustClass);
  writeSequence(w, b.sequence);
  w.i64(b.observedAt);
  writeNullable(w, b.validUntil, writeI64);
  writeFinality(w, b.finality);
  writeDigest(w, b.stateDigest);
  writeStateRequirement(w, b.requirement);
}

export function readStateBindingInput(r: CoreReader): StateBindingInput {
  const stateKind = r.str();
  const subject = readResourceIdInput(r);
  const sourceId = r.str();
  const trustClass = readCode(r, TRUST_CLASS_CODE) as AdmissibleTrustClass;
  const sequence = readSequenceInput(r);
  const observedAt = r.i64();
  const validUntil = readNullable(r, readI64);
  const finality = readFinalityInput(r);
  const stateDigest = r.digest();
  const requirement = readStateRequirementInput(r);
  return { stateKind, subject, sourceId, trustClass, sequence, observedAt, validUntil, finality, stateDigest, requirement };
}

export function stateBindingInputOf(b: StateBinding): StateBindingInput {
  return {
    stateKind: b.stateKind,
    subject: resourceIdInputOf(b.subject),
    sourceId: b.sourceId,
    trustClass: b.trustClass,
    sequence: sequenceInputOf(b.sequence),
    observedAt: b.observedAt,
    validUntil: b.validUntil,
    finality: { ladder: b.finality.ladder, level: b.finality.level },
    stateDigest: b.stateDigest,
    requirement: stateRequirementInputOf(b.requirement),
  };
}

export function encodeStateBinding(b: StateBinding): Uint8Array {
  const w = taggedWriter(CoreTag.STATE_BINDING);
  writeStateBinding(w, b);
  return w.finish();
}

export function decodeStateBinding(bytes: Uint8Array): CoreResult<StateBinding> {
  return decodeTagged(bytes, CoreTag.STATE_BINDING, readStateBindingInput, (input) => validateStateBinding(input));
}

export function stateBindingId(b: StateBinding): StateBindingId {
  return keccakDigest<StateBindingId>(encodeStateBinding(b));
}
