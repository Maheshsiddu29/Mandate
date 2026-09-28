/**
 * The explicit evaluation context (brief §8; action-state-model.md §5.2–5.3).
 *
 * Nothing the engine decides reads a wall clock, the environment or a
 * network. Everything admission needs that is not in a snapshot is here, as a
 * value the caller supplies and the decision commits to by digest:
 *
 * - `evaluationTime` — the decision's `t`;
 * - `sources` — the configured state sources: for each, the trust class it is
 *   configured at and the `(domain, stateKind)` pairs it may report. A
 *   snapshot's self-declared trust class is checked against this, never
 *   believed (§5.1: "must equal the source's configured class");
 * - `blockHeads` — the current block per source, for `BLOCKS` freshness;
 * - `sequenceWatermarks` — the reconciliation watermark per
 *   `(source, stateKind, subject)`, for `SEQUENCE` freshness (STATE-3).
 *
 * Every lookup is exact, and a duplicate key is refused rather than resolved
 * by preference: two configurations of one source are ambiguous.
 *
 * Replaying a decision with the same context reproduces it byte for byte
 * (brief §46); a different context is a different decision.
 */

import { ok } from '@mandate/kernel';
import {
  RESOURCE_KINDS,
  bytesToHex,
  encodeWith,
  parseEnum,
  parseIdentifierAs,
  parseUint64,
  parseUnixSeconds,
  validateResourceId,
  writeResourceId,
  type Digest32,
  type DomainId,
  type IntegerInput,
  type ResourceId,
  type ResourceIdInput,
  type StateKind,
  type StateSourceId,
  type Tagged,
  type TrustClass,
} from '@mandate/core';
import { refuse, type ControlResult } from './errors.ts';
import { ControlTag, controlDigest, controlWriter } from './encoding.ts';
import { MAX_CONTEXT_ENTRIES } from './limits.ts';

const TRUST_CLASSES: readonly TrustClass[] = ['AUTHORITATIVE', 'VERIFIED', 'ADVISORY', 'UNTRUSTED'];
const TRUST_CODE = { AUTHORITATIVE: 1, VERIFIED: 2, ADVISORY: 3, UNTRUSTED: 4 } as const;

export interface StateSourceConfigInput {
  readonly sourceId: string;
  readonly trustClass: TrustClass;
  readonly kinds: readonly { readonly domain: string; readonly stateKind: string }[];
}

export interface EvaluationContextInput {
  readonly evaluationTime: IntegerInput;
  readonly sources: readonly StateSourceConfigInput[];
  readonly blockHeads: readonly { readonly sourceId: string; readonly block: IntegerInput }[];
  readonly sequenceWatermarks: readonly { readonly sourceId: string; readonly stateKind: string; readonly subject: ResourceIdInput; readonly sequence: IntegerInput }[];
}

export interface StateSourceConfig {
  readonly sourceId: StateSourceId;
  readonly trustClass: TrustClass;
  readonly kinds: readonly { readonly domain: DomainId; readonly stateKind: StateKind }[];
}

export type ContextDigest = Tagged<Digest32, 'ContextDigest'>;

export interface EvaluationContext {
  readonly evaluationTime: bigint;
  readonly digest: ContextDigest;
  source(sourceId: StateSourceId): StateSourceConfig | null;
  blockHead(sourceId: StateSourceId): bigint | null;
  watermark(sourceId: StateSourceId, stateKind: StateKind, subject: ResourceId): bigint | null;
}

function watermarkKey(sourceId: string, stateKind: string, subject: ResourceId): string {
  return JSON.stringify([sourceId, stateKind, bytesToHex(encodeWith(writeResourceId, subject))]);
}

function invalid(reason: string, path: string): ControlResult<never> {
  return refuse('CONTEXT_INVALID', reason, path);
}

function isList(x: readonly object[]): boolean {
  return Array.isArray(x);
}

export function validateEvaluationContext(input: EvaluationContextInput, path = 'context'): ControlResult<EvaluationContext> {
  if (typeof input !== 'object' || input === null) return invalid('WRONG_TYPE', path);
  const t = parseUnixSeconds(input.evaluationTime, `${path}.evaluationTime`);
  if (!t.ok) return invalid(t.error.code, t.error.path);
  for (const k of ['sources', 'blockHeads', 'sequenceWatermarks'] as const) {
    if (!isList(input[k])) return invalid('WRONG_TYPE', `${path}.${k}`);
    if (input[k].length > MAX_CONTEXT_ENTRIES) return refuse('RESOURCE_BOUND_EXCEEDED', 'CONTEXT_TOO_LARGE', `${path}.${k}`);
  }

  const sources = new Map<string, StateSourceConfig>();
  for (let i = 0; i < input.sources.length; i += 1) {
    const s = input.sources[i] as StateSourceConfigInput;
    const sp = `${path}.sources[${i}]`;
    const id = parseIdentifierAs<StateSourceId>(s.sourceId, `${sp}.sourceId`);
    if (!id.ok) return invalid(id.error.code, id.error.path);
    if (sources.has(id.value)) return invalid('SOURCE_CONFIGURED_TWICE', sp);
    const trust = parseEnum(s.trustClass, TRUST_CLASSES, `${sp}.trustClass`);
    if (!trust.ok) return invalid(trust.error.code, trust.error.path);
    if (!isList(s.kinds) || s.kinds.length > MAX_CONTEXT_ENTRIES) return invalid('WRONG_TYPE', `${sp}.kinds`);
    const kinds: { domain: DomainId; stateKind: StateKind }[] = [];
    for (let j = 0; j < s.kinds.length; j += 1) {
      const k = s.kinds[j] as { domain: string; stateKind: string };
      const domain = parseIdentifierAs<DomainId>(k.domain, `${sp}.kinds[${j}].domain`);
      if (!domain.ok) return invalid(domain.error.code, domain.error.path);
      const stateKind = parseIdentifierAs<StateKind>(k.stateKind, `${sp}.kinds[${j}].stateKind`);
      if (!stateKind.ok) return invalid(stateKind.error.code, stateKind.error.path);
      if (kinds.some((x) => x.domain === domain.value && x.stateKind === stateKind.value)) return invalid('SOURCE_KIND_LISTED_TWICE', `${sp}.kinds[${j}]`);
      kinds.push({ domain: domain.value, stateKind: stateKind.value });
    }
    kinds.sort((a, b) => (a.domain === b.domain ? (a.stateKind < b.stateKind ? -1 : 1) : a.domain < b.domain ? -1 : 1));
    sources.set(id.value, { sourceId: id.value, trustClass: trust.value, kinds });
  }

  const heads = new Map<string, bigint>();
  for (let i = 0; i < input.blockHeads.length; i += 1) {
    const h = input.blockHeads[i] as { sourceId: string; block: IntegerInput };
    const hp = `${path}.blockHeads[${i}]`;
    const id = parseIdentifierAs<StateSourceId>(h.sourceId, `${hp}.sourceId`);
    if (!id.ok) return invalid(id.error.code, id.error.path);
    if (heads.has(id.value)) return invalid('BLOCK_HEAD_GIVEN_TWICE', hp);
    const block = parseUint64(h.block, `${hp}.block`);
    if (!block.ok) return invalid(block.error.code, block.error.path);
    heads.set(id.value, block.value);
  }

  const marks = new Map<string, { sourceId: string; stateKind: string; subject: ResourceId; sequence: bigint }>();
  for (let i = 0; i < input.sequenceWatermarks.length; i += 1) {
    const m = input.sequenceWatermarks[i] as EvaluationContextInput['sequenceWatermarks'][number];
    const mp = `${path}.sequenceWatermarks[${i}]`;
    const id = parseIdentifierAs<StateSourceId>(m.sourceId, `${mp}.sourceId`);
    if (!id.ok) return invalid(id.error.code, id.error.path);
    const stateKind = parseIdentifierAs<StateKind>(m.stateKind, `${mp}.stateKind`);
    if (!stateKind.ok) return invalid(stateKind.error.code, stateKind.error.path);
    const subject = validateResourceId(m.subject, RESOURCE_KINDS, `${mp}.subject`);
    if (!subject.ok) return invalid(subject.error.code, subject.error.path);
    const sequence = parseUint64(m.sequence, `${mp}.sequence`);
    if (!sequence.ok) return invalid(sequence.error.code, sequence.error.path);
    const key = watermarkKey(id.value, stateKind.value, subject.value);
    if (marks.has(key)) return invalid('WATERMARK_GIVEN_TWICE', mp);
    marks.set(key, { sourceId: id.value, stateKind: stateKind.value, subject: subject.value, sequence: sequence.value });
  }

  // The context's own canonical digest, independent of the order entries were given in.
  const w = controlWriter(ControlTag.CONTEXT);
  w.i64(t.value);
  const sourceIds = [...sources.keys()].sort();
  w.u32(sourceIds.length);
  for (const id of sourceIds) {
    const s = sources.get(id) as StateSourceConfig;
    w.str(s.sourceId).u8(TRUST_CODE[s.trustClass]).u32(s.kinds.length);
    for (const k of s.kinds) w.str(k.domain).str(k.stateKind);
  }
  const headIds = [...heads.keys()].sort();
  w.u32(headIds.length);
  for (const id of headIds) w.str(id).u64(heads.get(id) as bigint);
  const markKeys = [...marks.keys()].sort();
  w.u32(markKeys.length);
  for (const k of markKeys) {
    const m = marks.get(k) as { sourceId: string; stateKind: string; subject: ResourceId; sequence: bigint };
    w.str(m.sourceId).str(m.stateKind);
    writeResourceId(w, m.subject);
    w.u64(m.sequence);
  }
  const digest = controlDigest<ContextDigest>(w);

  return ok({
    evaluationTime: t.value,
    digest,
    source: (id) => sources.get(id) ?? null,
    blockHead: (id) => heads.get(id) ?? null,
    watermark: (id, stateKind, subject) => marks.get(watermarkKey(id, stateKind, subject))?.sequence ?? null,
  });
}
