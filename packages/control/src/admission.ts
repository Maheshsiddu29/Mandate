/**
 * State requirements, admission and state bindings (action-state-model.md
 * §5.3–5.5; STATE-1, STATE-2, STATE-3, STATE-4; brief §6–§10).
 *
 * **Effective requirement.** A module declares, per `(stateKind, subject)`,
 * its default requirement and accepted sources. Every lineage node's and the
 * principal policy's state policy for the same `(domain, stateKind)` then
 * tightens it: the smaller age or block bound, the stricter trust, the higher
 * finality on the module's own ladder, `RECHECK` over `WITHIN_POLICY`, and the
 * intersection of sources. Two requirements that cannot be combined — a
 * different freshness mode or pinned version, finality on another ladder, two
 * different execution dependencies — are a `STATE_POLICY_CONFLICT`, never
 * resolved by choosing one.
 *
 * **Admission.** For each requirement, the candidates are exactly the
 * supplied snapshots normalized under the same `ModuleRef` for the same kind
 * and subject. None is `STATE_MISSING`; two different ones are
 * `STATE_CONFLICT` — never "the newest", never "the convenient one". The one
 * candidate must then:
 *
 * 1. carry the payload its digest commits to, under this module;
 * 2. come from a source configured for its `(domain, stateKind)` at exactly
 *    the trust class it claims, in the requirement's source set, at no less
 *    than its minimum trust (`STATE_UNTRUSTED`);
 * 3. not be observed after `t`, nor used at or after its source's
 *    `validUntil`;
 * 4. be fresh by the requirement's own mode — `AGE` by seconds, `BLOCKS` by
 *    distance to the configured head, `SEQUENCE` against the reconciliation
 *    watermark, `VERSION` by the pinned digest and an age bound
 *    (`STATE_STALE`); a head or watermark the context does not give is not
 *    assumed, and refuses;
 * 5. be at or above the required finality level on the module's declared
 *    ladder (`STATE_FINALITY_INSUFFICIENT`).
 *
 * **Bindings.** Every admitted snapshot becomes a `StateBinding` (Core's
 * `bindState`): source, trust class, sequence, observation and validity
 * times, finality, the snapshot's digest — which is over its envelope, and so
 * over its exact `ModuleRef` — and the effective requirement it was admitted
 * under. The authorization commits to the set.
 *
 * **No smuggling.** A module is handed only the snapshots admitted for its
 * own requirements. Supplied snapshots nobody required are never admitted
 * and never shown to any module.
 */

import { ok } from '@mandate/kernel';
import {
  bindState,
  bytesToHex,
  encodeWith,
  moduleRefDigest,
  moduleRefsEqual,
  resourceIdsEqual,
  stateEnvelopeInputOf,
  stateId,
  stateBindingId,
  stateRequirementInputOf,
  validateStateEnvelope,
  validateStateRequirement,
  writeResourceId,
  type DomainId,
  type ExecutionDependence,
  type FinalityRef,
  type ResourceId,
  type StateBinding,
  type StateBindingId,
  type StateEnvelope,
  type StateId,
  type StateKind,
  type StatePayloadDigest,
  type StateRequirement,
  type StateSequence,
  type StateSourceId,
  type TrustClass,
} from '@mandate/core';
import type { EffectiveStatePolicy } from '@mandate/ledger';
import type { EvaluationContext } from './context.ts';
import { statePayloadDigest } from './encoding.ts';
import { refuse, type ControlCode, type ControlResult, type StateFailure } from './errors.ts';
import { MAX_REQUIREMENTS, MAX_STATE_PAYLOAD_BYTES, MAX_SUPPLIED_STATES } from './limits.ts';
import type { AdmittedState, DomainModule, FinalityLadder, StateNeed } from './module.ts';

export interface SuppliedState {
  readonly envelope: StateEnvelope;
  readonly payload: Uint8Array;
}

/** A module's state need after every lineage and policy requirement for its kind has tightened it. */
export interface EffectiveNeed {
  readonly module: DomainModule;
  readonly stateKind: StateKind;
  readonly subject: ResourceId;
  readonly admittedSources: readonly StateSourceId[];
  readonly requirement: StateRequirement;
  /** Canonical: module digest, kind, subject bytes. Needs are admitted in this order. */
  readonly key: string;
  readonly label: string;
}

export interface Admission {
  readonly need: EffectiveNeed;
  readonly state: AdmittedState;
  readonly binding: StateBinding;
  readonly bindingId: StateBindingId;
}

// --- Tightening ------------------------------------------------------------------

const TRUST_RANK: { readonly [K in TrustClass]: number } = { AUTHORITATIVE: 2, VERIFIED: 1, ADVISORY: 0, UNTRUSTED: 0 };

function levelIndex(ladders: readonly FinalityLadder[], f: FinalityRef): number {
  const ladder = ladders.find((l) => l.ladder === f.ladder);
  return ladder === undefined ? -1 : ladder.levels.indexOf(f.level);
}

function sameDependence(a: ExecutionDependence, b: ExecutionDependence): boolean {
  return a.kind === b.kind && (a.kind !== 'ENFORCED_BY_ARTIFACT' || (b.kind === 'ENFORCED_BY_ARTIFACT' && a.field === b.field));
}

/** The tighter of two requirements for one state kind, or why they cannot be combined. */
export function tightenRequirement(ladders: readonly FinalityLadder[], a: StateRequirement, b: StateRequirement): { ok: true; value: StateRequirement } | { ok: false; reason: string } {
  const fa = a.freshness;
  const fb = b.freshness;
  let freshness: StateRequirement['freshness'];
  if (fa.kind === 'AGE' && fb.kind === 'AGE') freshness = { kind: 'AGE', maxAgeSeconds: fa.maxAgeSeconds < fb.maxAgeSeconds ? fa.maxAgeSeconds : fb.maxAgeSeconds };
  else if (fa.kind === 'BLOCKS' && fb.kind === 'BLOCKS') freshness = { kind: 'BLOCKS', maxBlocksBehind: fa.maxBlocksBehind < fb.maxBlocksBehind ? fa.maxBlocksBehind : fb.maxBlocksBehind };
  else if (fa.kind === 'SEQUENCE' && fb.kind === 'SEQUENCE') freshness = { kind: 'SEQUENCE' };
  else if (fa.kind === 'VERSION' && fb.kind === 'VERSION' && fa.pinnedDigest === fb.pinnedDigest) {
    freshness = { kind: 'VERSION', pinnedDigest: fa.pinnedDigest, maxAgeSeconds: fa.maxAgeSeconds < fb.maxAgeSeconds ? fa.maxAgeSeconds : fb.maxAgeSeconds };
  } else return { ok: false, reason: 'FRESHNESS_INCOMPARABLE' };

  if (a.minFinality.ladder !== b.minFinality.ladder) return { ok: false, reason: 'FINALITY_LADDER_INCOMPARABLE' };
  const ia = levelIndex(ladders, a.minFinality);
  const ib = levelIndex(ladders, b.minFinality);
  if (ia < 0 || ib < 0) return { ok: false, reason: 'FINALITY_LEVEL_UNDECLARED' };
  const minFinality = ia >= ib ? a.minFinality : b.minFinality;

  let atExecution: ExecutionDependence;
  if (sameDependence(a.atExecution, b.atExecution)) atExecution = a.atExecution;
  else if (a.atExecution.kind === 'NOT_REQUIRED') atExecution = b.atExecution;
  else if (b.atExecution.kind === 'NOT_REQUIRED') atExecution = a.atExecution;
  else return { ok: false, reason: 'EXECUTION_DEPENDENCE_INCOMPARABLE' };

  const combined = validateStateRequirement(
    stateRequirementInputOf({
      freshness,
      minTrust: TRUST_RANK[a.minTrust] >= TRUST_RANK[b.minTrust] ? a.minTrust : b.minTrust,
      minFinality,
      atIssue: a.atIssue === 'RECHECK' || b.atIssue === 'RECHECK' ? 'RECHECK' : 'WITHIN_POLICY',
      atExecution,
    } as StateRequirement),
    'requirement',
  );
  return combined.ok ? { ok: true, value: combined.value } : { ok: false, reason: combined.error.code };
}

function needKey(module: DomainModule, stateKind: StateKind, subject: ResourceId): string {
  return `${moduleRefDigest(module.ref)}/${stateKind}/${bytesToHex(encodeWith(writeResourceId, subject))}`;
}

/** Tighten a module's need with every state policy for its `(domain, stateKind)`. */
export function effectiveNeed(module: DomainModule, need: StateNeed, policies: readonly EffectiveStatePolicy[], path: string): ControlResult<EffectiveNeed> {
  let requirement = need.requirement;
  let sources = [...need.admittedSources];
  for (const p of policies) {
    if (p.domain !== module.ref.domainId || p.stateKind !== need.stateKind) continue;
    sources = sources.filter((s) => p.admittedSources.includes(s));
    for (const r of p.requirements) {
      const t = tightenRequirement(module.finalityLadders, requirement, r);
      if (!t.ok) return refuse('STATE_POLICY_CONFLICT', t.reason, path, { module: module.ref });
      requirement = t.value;
    }
  }
  return ok({
    module,
    stateKind: need.stateKind,
    subject: need.subject,
    admittedSources: sources,
    requirement,
    key: needKey(module, need.stateKind, need.subject),
    label: `${module.ref.moduleId}@${module.ref.moduleVersion}/${need.stateKind}/${need.subject.domain}:${need.subject.kind}:${need.subject.localId}`,
  });
}

/** One need per `(module, kind, subject)`: a module asking twice gets the tighter of both, and the intersection of sources. */
export function mergeNeeds(needs: readonly EffectiveNeed[], path: string): ControlResult<readonly EffectiveNeed[]> {
  const byKey = new Map<string, EffectiveNeed>();
  for (const n of needs) {
    const prev = byKey.get(n.key);
    if (prev === undefined) {
      byKey.set(n.key, n);
      continue;
    }
    const t = tightenRequirement(n.module.finalityLadders, prev.requirement, n.requirement);
    if (!t.ok) return refuse('STATE_POLICY_CONFLICT', t.reason, path, { module: n.module.ref });
    byKey.set(n.key, { ...prev, requirement: t.value, admittedSources: prev.admittedSources.filter((s) => n.admittedSources.includes(s)) });
  }
  if (byKey.size > MAX_REQUIREMENTS) return refuse('RESOURCE_BOUND_EXCEEDED', 'TOO_MANY_REQUIREMENTS', path);
  return ok([...byKey.keys()].sort().map((k) => byKey.get(k) as EffectiveNeed));
}

// --- Supplied state --------------------------------------------------------------

export interface PreparedState {
  readonly envelope: StateEnvelope;
  readonly stateId: StateId;
  readonly payload: Uint8Array;
  readonly payloadMatches: boolean;
}

/** Re-validate every supplied envelope, compute its identity and check its payload digest. */
export function prepareStates(supplied: readonly SuppliedState[], path: string): ControlResult<readonly PreparedState[]> {
  if (!Array.isArray(supplied)) return refuse('REQUEST_INVALID', 'WRONG_TYPE', path);
  if (supplied.length > MAX_SUPPLIED_STATES) return refuse('RESOURCE_BOUND_EXCEEDED', 'TOO_MANY_STATES', path);
  const out: PreparedState[] = [];
  for (let i = 0; i < supplied.length; i += 1) {
    const s = supplied[i] as SuppliedState;
    const sp = `${path}[${i}]`;
    if (typeof s !== 'object' || s === null || !(s.payload instanceof Uint8Array)) return refuse('REQUEST_INVALID', 'WRONG_TYPE', sp);
    if (s.payload.length > MAX_STATE_PAYLOAD_BYTES) return refuse('RESOURCE_BOUND_EXCEEDED', 'STATE_PAYLOAD_TOO_LARGE', `${sp}.payload`);
    let envelope: StateEnvelope;
    try {
      const v = validateStateEnvelope(stateEnvelopeInputOf(s.envelope), `${sp}.envelope`);
      if (!v.ok) return refuse('REQUEST_INVALID', v.error.code, v.error.path);
      envelope = v.value;
    } catch {
      return refuse('REQUEST_INVALID', 'WRONG_TYPE', `${sp}.envelope`);
    }
    const payload = new Uint8Array(s.payload);
    out.push({ envelope, stateId: stateId(envelope), payload, payloadMatches: statePayloadDigest(envelope.module, payload) === envelope.payloadDigest });
  }
  return ok(out);
}

// --- Admission -------------------------------------------------------------------

/** The provenance fields admission reads: an envelope's, or — for re-admission at issue time — a binding's. */
export interface Observed {
  readonly domain: DomainId;
  readonly stateKind: StateKind;
  readonly subject: ResourceId;
  readonly sourceId: StateSourceId;
  readonly trustClass: TrustClass;
  readonly observedAt: bigint;
  readonly validUntil: bigint | null;
  readonly sequence: StateSequence;
  readonly finality: FinalityRef;
  /** `null` when re-admitting a binding: its pinned version was checked when it was first admitted, and its digest cannot change. */
  readonly payloadDigest: StatePayloadDigest | null;
}

export interface AdmissionFailure {
  readonly code: ControlCode;
  readonly reason: string;
}

function failure(code: ControlCode, reason: string): AdmissionFailure {
  return { code, reason };
}

/** Rules 2–5 for one observation under one requirement at the context's `t`. `null` means admissible. */
export function assessObservation(o: Observed, requirement: StateRequirement, sources: readonly StateSourceId[], ladders: readonly FinalityLadder[], ctx: EvaluationContext): AdmissionFailure | null {
  const t = ctx.evaluationTime;
  const source = ctx.source(o.sourceId);
  if (source === null) return failure('STATE_UNTRUSTED', 'SOURCE_NOT_CONFIGURED');
  if (!source.kinds.some((k) => k.domain === o.domain && k.stateKind === o.stateKind)) return failure('STATE_UNTRUSTED', 'SOURCE_NOT_CONFIGURED_FOR_KIND');
  // A snapshot's trust class is its source's configured class, never its own claim.
  if (o.trustClass !== source.trustClass) return failure('STATE_UNTRUSTED', 'TRUST_CLASS_MISMATCH');
  if (!sources.includes(o.sourceId)) return failure('STATE_UNTRUSTED', 'SOURCE_NOT_ADMITTED');
  if (TRUST_RANK[o.trustClass] === 0 || TRUST_RANK[o.trustClass] < TRUST_RANK[requirement.minTrust]) return failure('STATE_UNTRUSTED', 'TRUST_INSUFFICIENT');
  if (o.observedAt > t) return failure('STATE_INVALID', 'OBSERVED_IN_FUTURE');
  if (o.validUntil !== null && t >= o.validUntil) return failure('STATE_STALE', 'SOURCE_VALIDITY_ENDED');

  const f = requirement.freshness;
  switch (f.kind) {
    case 'AGE':
      if (t - o.observedAt > f.maxAgeSeconds) return failure('STATE_STALE', 'AGE_EXCEEDED');
      break;
    case 'BLOCKS': {
      if (o.sequence.kind !== 'BLOCK') return failure('STATE_INVALID', 'SEQUENCE_KIND_MISMATCH');
      const head = ctx.blockHead(o.sourceId);
      if (head === null) return failure('STATE_STALE', 'BLOCK_HEAD_UNKNOWN');
      if (o.sequence.value > head) return failure('STATE_INVALID', 'BLOCK_AHEAD_OF_HEAD');
      if (head - o.sequence.value > f.maxBlocksBehind) return failure('STATE_STALE', 'BLOCKS_BEHIND_EXCEEDED');
      break;
    }
    case 'SEQUENCE': {
      if (o.sequence.kind === 'NONE') return failure('STATE_INVALID', 'SEQUENCE_KIND_MISMATCH');
      const watermark = ctx.watermark(o.sourceId, o.stateKind, o.subject);
      if (watermark === null) return failure('STATE_STALE', 'WATERMARK_UNKNOWN');
      // Older than what the ledger has already reconciled: combining it would count a fill zero times or twice (STATE-3).
      if (o.sequence.value < watermark) return failure('STATE_STALE', 'BEHIND_WATERMARK');
      break;
    }
    case 'VERSION':
      if (o.payloadDigest !== null && o.payloadDigest !== f.pinnedDigest) return failure('STATE_STALE', 'PINNED_VERSION_MISMATCH');
      if (t - o.observedAt > f.maxAgeSeconds) return failure('STATE_STALE', 'AGE_EXCEEDED');
      break;
  }

  if (o.finality.ladder !== requirement.minFinality.ladder) return failure('STATE_FINALITY_INSUFFICIENT', 'FINALITY_LADDER_MISMATCH');
  const have = levelIndex(ladders, o.finality);
  const need = levelIndex(ladders, requirement.minFinality);
  if (have < 0) return failure('STATE_FINALITY_INSUFFICIENT', 'FINALITY_LEVEL_UNDECLARED');
  if (have < need) return failure('STATE_FINALITY_INSUFFICIENT', 'FINALITY_BELOW_REQUIRED');
  return null;
}

function observedOf(e: StateEnvelope): Observed {
  return {
    domain: e.module.domainId,
    stateKind: e.stateKind,
    subject: e.subject,
    sourceId: e.sourceId,
    trustClass: e.trustClass,
    observedAt: e.observedAt,
    validUntil: e.validUntil,
    sequence: e.sequence,
    finality: e.finality,
    payloadDigest: e.payloadDigest,
  };
}

function admitOne(need: EffectiveNeed, prepared: readonly PreparedState[], ctx: EvaluationContext): { ok: true; value: Admission } | { ok: false; error: AdmissionFailure } {
  const sameKind = prepared.filter((p) => p.envelope.stateKind === need.stateKind && resourceIdsEqual(p.envelope.subject, need.subject));
  const candidates = sameKind.filter((p) => moduleRefsEqual(p.envelope.module, need.module.ref));
  // The same observation supplied twice is one snapshot; two different ones are a conflict, whichever looks newer.
  const distinct = [...new Map(candidates.map((c) => [c.stateId, c])).values()];
  if (distinct.length === 0) {
    return { ok: false, error: sameKind.length > 0 ? failure('STATE_INVALID', 'MODULE_MISMATCH') : failure('STATE_MISSING', 'STATE_NOT_SUPPLIED') };
  }
  if (distinct.length > 1) return { ok: false, error: failure('STATE_CONFLICT', 'AMBIGUOUS_SNAPSHOTS') };
  const p = distinct[0] as PreparedState;
  if (!p.payloadMatches) return { ok: false, error: failure('STATE_INVALID', 'PAYLOAD_DIGEST_MISMATCH') };
  const assessed = assessObservation(observedOf(p.envelope), need.requirement, need.admittedSources, need.module.finalityLadders, ctx);
  if (assessed !== null) return { ok: false, error: assessed };
  const binding = bindState(p.envelope, stateRequirementInputOf(need.requirement));
  if (!binding.ok) return { ok: false, error: failure('STATE_UNTRUSTED', binding.error.code) };
  return {
    ok: true,
    value: { need, state: { envelope: p.envelope, stateId: p.stateId, payload: p.payload }, binding: binding.value, bindingId: stateBindingId(binding.value) },
  };
}

/**
 * Admit every need, in canonical order. All failures are collected; the
 * refusal's code and reason are the first's, and every one is in the detail.
 */
export function admitNeeds(needs: readonly EffectiveNeed[], prepared: readonly PreparedState[], ctx: EvaluationContext, path: string): ControlResult<readonly Admission[]> {
  const admitted: Admission[] = [];
  const failures: StateFailure[] = [];
  for (const need of needs) {
    const r = admitOne(need, prepared, ctx);
    if (r.ok) admitted.push(r.value);
    else failures.push({ code: r.error.code, reason: r.error.reason, requirement: need.label });
  }
  if (failures.length > 0) {
    const first = failures[0] as StateFailure;
    const need = needs.find((n) => n.label === first.requirement) as EffectiveNeed;
    return refuse(first.code, first.reason, `${path}.${first.requirement}`, { module: need.module.ref, detail: { kind: 'STATE', failures } });
  }
  return ok(admitted);
}

/**
 * Re-admission of a binding at issue time from the binding alone
 * (reservations-reconciliation.md §10a step 2): still configured and trusted,
 * still fresh under the requirement it was admitted under, still final
 * enough, not superseded past the watermark. `null` means still admissible.
 */
export function readmitBinding(binding: StateBinding, domain: DomainId, ladders: readonly FinalityLadder[], ctx: EvaluationContext): AdmissionFailure | null {
  return assessObservation(
    {
      domain,
      stateKind: binding.stateKind,
      subject: binding.subject,
      sourceId: binding.sourceId,
      trustClass: binding.trustClass,
      observedAt: binding.observedAt,
      validUntil: binding.validUntil,
      sequence: binding.sequence,
      finality: binding.finality,
      payloadDigest: null,
    },
    binding.requirement,
    [binding.sourceId],
    ladders,
    ctx,
  );
}

/** Bounds a supplied admission set and hands each module only its own admitted snapshots. */
export function statesFor(module: DomainModule, admissions: readonly Admission[]): readonly AdmittedState[] {
  return admissions.filter((a) => moduleRefsEqual(a.need.module.ref, module.ref)).map((a) => a.state);
}
