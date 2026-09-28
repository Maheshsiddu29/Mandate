/**
 * Semantic provenance of an invariant narrowing (Phase 7D.2).
 *
 * A delegation that restates a parent's invariant with different parameters
 * is accepted only if the invariant's definition proves the child's
 * parameters no weaker (authority-model.md §4). A policy update after
 * activity restating a principal-global invariant is accepted only if the
 * definition proves the new parameters no stronger (7D.1). Either way, the
 * decision rests on one exact semantic definition, and the ledger records
 * which one:
 *
 * ```text
 * SemanticInvariantRef {                      the security identity of an invariant definition
 *   owner        CORE | MODULE(exact ModuleRef: domainId, moduleId, moduleVersion, moduleDigest)
 *   invariantId  the definition's local identifier
 *   version      the definition's version
 * }
 * SemanticProofRef {                          one committed narrowing
 *   definition   SemanticInvariantRef          whose comparator decided it
 *   scope        the restated term's scope     which term it decided
 * }
 * ```
 *
 * The human-readable `invariantId` alone is never the identity: the same name
 * under another module digest is another `SemanticInvariantRef`, with another
 * digest (`semanticInvariantId`). A proof carries no verdict and no
 * parameters — the parent's are bound through the grant's `lineage.parent`,
 * the child's through the grant itself — only *whose semantics* decided. The
 * reducer asks the configured ordering again, at commit and at every replay,
 * under exactly that definition; the ordering resolves it by exact,
 * content-addressed identity and never through a registry's current name
 * mapping. If that artifact is unavailable the ordering cannot prove it, and
 * the history refuses to replay.
 *
 * **Structural binding.** A definition's owner must be consistent with the
 * invariant it names, so a proof cannot borrow another module's comparator:
 * `core.*` invariants are Core's, and a module owns only `<moduleId>.*` at
 * its own `moduleVersion` (the 7D.1 namespace rule, now checked by the
 * reducer too). Which *digest* of that name is current is a registry fact,
 * checked when a proof is first committed (engine.ts), never at replay.
 */

import { ok, type ByteWriter } from '@mandate/kernel';
import {
  CoreReader,
  DecodeFailure,
  bytesToHex,
  compareBytes,
  encodeWith,
  keccakDigest,
  parseIdentifierAs,
  readModuleRefInput,
  readResourceIdInput,
  resourceIdsEqual,
  validateModuleRef,
  validateResourceId,
  RESOURCE_KINDS,
  writeModuleRef,
  writeResourceId,
  type CoreResult,
  type Digest32,
  type InvariantId,
  type InvariantVersion,
  type ModuleRef,
  type ResourceId,
  type AuthorityGrant,
  type StateInvariantTerm,
  type Tagged,
  termKey,
} from '@mandate/core';
import { LedgerTag, ledgerWriter } from './encoding.ts';
import { refuse, type LedgerResult } from './errors.ts';

/** Core's own invariant namespace. */
export const CORE_INVARIANT_PREFIX = 'core.';
/** Proofs one registration may commit: one per restated invariant, bounded by the grant's own term bound. */
export const MAX_SEMANTIC_PROOFS = 64;

export type DefinitionOwner = { readonly kind: 'CORE' } | { readonly kind: 'MODULE'; readonly module: ModuleRef };

export interface SemanticInvariantRef {
  readonly owner: DefinitionOwner;
  readonly invariantId: InvariantId;
  readonly version: InvariantVersion;
}

export interface SemanticProofRef {
  readonly definition: SemanticInvariantRef;
  /** The restated term's scope, exactly as the term carries it. */
  readonly scope: readonly ResourceId[];
}

export type SemanticInvariantId = Tagged<Digest32, 'SemanticInvariantId'>;
export type SemanticProofId = Tagged<Digest32, 'SemanticProofId'>;

const OWNER_CODE = { CORE: 1, MODULE: 2 } as const;

// --- Encoding --------------------------------------------------------------------

export function writeSemanticInvariantRef(w: ByteWriter, d: SemanticInvariantRef): void {
  w.u8(OWNER_CODE[d.owner.kind]);
  if (d.owner.kind === 'MODULE') writeModuleRef(w, d.owner.module);
  w.str(d.invariantId).u32(d.version);
}

export function writeSemanticProofRef(w: ByteWriter, p: SemanticProofRef): void {
  writeSemanticInvariantRef(w, p.definition);
  w.u16(p.scope.length);
  for (const r of p.scope) writeResourceId(w, r);
}

function must<T>(r: CoreResult<T>): T {
  if (!r.ok) throw new DecodeFailure(r.error.code);
  return r.value;
}

export function readSemanticInvariantRef(r: CoreReader): SemanticInvariantRef {
  const code = r.u8();
  let owner: DefinitionOwner;
  if (code === OWNER_CODE.CORE) owner = { kind: 'CORE' };
  else if (code === OWNER_CODE.MODULE) owner = { kind: 'MODULE', module: must(validateModuleRef(readModuleRefInput(r), 'module')) };
  else throw new DecodeFailure('ENCODING_MALFORMED');
  const invariantId = must(parseIdentifierAs<InvariantId>(r.str(), 'invariantId'));
  const version = r.u32() as InvariantVersion;
  return { owner, invariantId, version };
}

export function readSemanticProofRef(r: CoreReader): SemanticProofRef {
  const definition = readSemanticInvariantRef(r);
  const n = r.u16();
  const scope: ResourceId[] = [];
  for (let i = 0; i < n; i += 1) scope.push(must(validateResourceId(readResourceIdInput(r), RESOURCE_KINDS, 'scope')));
  return { definition, scope };
}

/** The content identity of an invariant definition: exact owner + local identifier + version. */
export function semanticInvariantId(d: SemanticInvariantRef): SemanticInvariantId {
  const w = ledgerWriter(LedgerTag.SEMANTIC_INVARIANT);
  writeSemanticInvariantRef(w, d);
  return keccakDigest<SemanticInvariantId>(w.finish());
}

/** The content identity of one committed narrowing. */
export function semanticProofId(p: SemanticProofRef): SemanticProofId {
  const w = ledgerWriter(LedgerTag.SEMANTIC_PROOF);
  writeSemanticProofRef(w, p);
  return keccakDigest<SemanticProofId>(w.finish());
}

function proofKey(p: SemanticProofRef): string {
  return bytesToHex(encodeWith(writeSemanticProofRef, p));
}

/** Which term a proof is for, whatever definition it names. */
function termKeyOf(p: SemanticProofRef): string {
  return JSON.stringify([p.definition.invariantId, p.definition.version, p.scope.map((r) => [r.domain, r.kind, r.localId])]);
}

/** Proofs in canonical order: ascending by encoding. */
export function canonicalProofs(proofs: readonly SemanticProofRef[]): SemanticProofRef[] {
  return [...proofs].sort((a, b) => compareBytes(encodeWith(writeSemanticProofRef, a), encodeWith(writeSemanticProofRef, b)));
}

// --- Rules -----------------------------------------------------------------------

/** Whether the owner may define this invariant at all: Core's namespace, or the module's own name at its version. */
export function ownerConsistent(d: SemanticInvariantRef): boolean {
  const core = d.invariantId.startsWith(CORE_INVARIANT_PREFIX);
  if (d.owner.kind === 'CORE') return core;
  const m = d.owner.module;
  return !core && d.invariantId.startsWith(`${m.moduleId}.`) && (d.version as number) === (m.moduleVersion as number);
}

/** Whether `p` is the proof for term `t`: same definition name and version, same scope. */
export function proofMatches(p: SemanticProofRef, t: StateInvariantTerm): boolean {
  const d = p.definition;
  return d.invariantId === t.invariantId && d.version === t.version && p.scope.length === t.scope.length && p.scope.every((r, i) => resourceIdsEqual(r, t.scope[i] as ResourceId));
}

/**
 * The proofs of one registration, checked against the terms that need one:
 * canonical order, no duplicate, every owner structurally consistent, and
 * each proof for exactly one term in `needed`. A needed term without a proof
 * is not refused here — the ordering reads it as unproven.
 */
export function checkProofSet(proofs: readonly SemanticProofRef[], needed: readonly StateInvariantTerm[], path: string): LedgerResult<true> {
  if (proofs.length > MAX_SEMANTIC_PROOFS) return refuse('SEMANTIC_PROOF_INVALID', path);
  const canonical = canonicalProofs(proofs);
  const terms = new Set<string>();
  for (let i = 0; i < proofs.length; i += 1) {
    const p = proofs[i] as SemanticProofRef;
    // Canonical order, and at most one proof per term: the registration's bytes are unique.
    if (proofKey(p) !== proofKey(canonical[i] as SemanticProofRef)) return refuse('SEMANTIC_PROOF_INVALID', `${path}[${i}]`);
    if (terms.has(termKeyOf(p))) return refuse('SEMANTIC_PROOF_INVALID', `${path}[${i}]`);
    terms.add(termKeyOf(p));
    if (!ownerConsistent(p.definition)) return refuse('SEMANTIC_PROOF_INVALID', `${path}[${i}].definition`);
    if (!needed.some((t) => proofMatches(p, t))) return refuse('SEMANTIC_PROOF_UNEXPECTED', `${path}[${i}]`);
  }
  return ok(true);
}

/** The invariants `next` restates from `previous` — same `(invariantId, version, scope)` — with different parameters. */
export function restatedInvariants(previous: readonly StateInvariantTerm[], next: readonly StateInvariantTerm[]): StateInvariantTerm[] {
  const before = new Map(previous.map((t) => [termKey(t), t]));
  return next.filter((t) => {
    const p = before.get(termKey(t));
    return p !== undefined && p.params !== t.params;
  });
}

/** The invariant terms of a grant. */
export function grantInvariants(g: AuthorityGrant): StateInvariantTerm[] {
  return g.terms.filter((t): t is StateInvariantTerm => t.kind === 'STATE_INVARIANT');
}
