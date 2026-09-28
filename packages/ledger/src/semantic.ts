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
 *
 * **Term bindings (7D.3).** A proof records whose semantics decided one
 * narrowing. A binding records whose semantics a registered term *means*,
 * for as long as the grant or policy exists — whether or not any narrowing
 * was ever proven for it:
 *
 * ```text
 * SemanticTermBinding {                       the meaning of one registered term
 *   definition   SemanticInvariantRef          always MODULE(exact ModuleRef): the definition it is interpreted under
 *   scope        the term's scope              with definition.invariantId and version: which term it binds
 * }
 * ```
 *
 * A term is **module-defined** when its invariant is outside Core's `core.*`
 * namespace: its interpretation, evaluation, state requirements and ordering
 * are a domain module's. Every module-defined term of a registered grant or
 * policy carries exactly one binding, committed in its registration event
 * (`checkBindingSet`); a Core term carries none. Future authorization
 * evaluates the term under exactly that definition, resolved by exact
 * identity — never by the invariant's name through whichever module is
 * current. A registry change can therefore never redefine an existing grant
 * or policy: only a new registration, bound to the then-current definition,
 * can carry new semantics. Two consequences are checked here:
 *
 * - a delegation restating a parent's term restates its semantics: the child
 *   term's binding must be the parent term's (`checkRestatedBindings`);
 * - a committed proof for a module-defined term must name exactly that term's
 *   binding (`checkProofsBound`): a comparator never orders parameters whose
 *   meaning is another definition's.
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
  MAX_GRANT_TERMS,
  termKey,
} from '@mandate/core';
import { LedgerTag, ledgerWriter } from './encoding.ts';
import { refuse, type LedgerResult } from './errors.ts';

/** Core's own invariant namespace. */
export const CORE_INVARIANT_PREFIX = 'core.';
/** Proofs one registration may commit: one per restated invariant, bounded by the grant's own term bound. */
export const MAX_SEMANTIC_PROOFS = 64;
/** Bindings one registration may commit: one per module-defined invariant, at most one per term. */
export const MAX_SEMANTIC_BINDINGS = MAX_GRANT_TERMS;

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

/** The exact definition one registered, module-defined term is interpreted under (7D.3). */
export interface SemanticTermBinding {
  /** Always a `MODULE` owner: Core's own terms need no binding. */
  readonly definition: SemanticInvariantRef;
  /** The bound term's scope, exactly as the term carries it. */
  readonly scope: readonly ResourceId[];
}

export type SemanticInvariantId = Tagged<Digest32, 'SemanticInvariantId'>;
export type SemanticProofId = Tagged<Digest32, 'SemanticProofId'>;
export type SemanticBindingId = Tagged<Digest32, 'SemanticBindingId'>;

/** A definition applied to one term: the shared shape of a proof and a binding. */
interface ScopedDefinition {
  readonly definition: SemanticInvariantRef;
  readonly scope: readonly ResourceId[];
}

const OWNER_CODE = { CORE: 1, MODULE: 2 } as const;

// --- Encoding --------------------------------------------------------------------

export function writeSemanticInvariantRef(w: ByteWriter, d: SemanticInvariantRef): void {
  w.u8(OWNER_CODE[d.owner.kind]);
  if (d.owner.kind === 'MODULE') writeModuleRef(w, d.owner.module);
  w.str(d.invariantId).u32(d.version);
}

function writeScoped(w: ByteWriter, p: ScopedDefinition): void {
  writeSemanticInvariantRef(w, p.definition);
  w.u16(p.scope.length);
  for (const r of p.scope) writeResourceId(w, r);
}

/** `SemanticInvariantRef ‖ u16(n) ‖ ResourceId₁ … ₙ` */
export function writeSemanticProofRef(w: ByteWriter, p: SemanticProofRef): void {
  writeScoped(w, p);
}

/** `SemanticInvariantRef ‖ u16(n) ‖ ResourceId₁ … ₙ`, the same layout as a proof; distinguished by its position and identity tag. */
export function writeSemanticTermBinding(w: ByteWriter, b: SemanticTermBinding): void {
  writeScoped(w, b);
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

function readScoped(r: CoreReader): ScopedDefinition {
  const definition = readSemanticInvariantRef(r);
  const n = r.u16();
  const scope: ResourceId[] = [];
  for (let i = 0; i < n; i += 1) scope.push(must(validateResourceId(readResourceIdInput(r), RESOURCE_KINDS, 'scope')));
  return { definition, scope };
}

export function readSemanticProofRef(r: CoreReader): SemanticProofRef {
  return readScoped(r);
}

export function readSemanticTermBinding(r: CoreReader): SemanticTermBinding {
  return readScoped(r);
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

/** The content identity of one term's binding. */
export function semanticBindingId(b: SemanticTermBinding): SemanticBindingId {
  const w = ledgerWriter(LedgerTag.SEMANTIC_BINDING);
  writeSemanticTermBinding(w, b);
  return keccakDigest<SemanticBindingId>(w.finish());
}

function scopedKey(p: ScopedDefinition): string {
  return bytesToHex(encodeWith(writeScoped, p));
}

/** Which term a proof or binding is for, whatever definition it names. */
function termKeyOf(p: ScopedDefinition): string {
  return JSON.stringify([p.definition.invariantId, p.definition.version, p.scope.map((r) => [r.domain, r.kind, r.localId])]);
}

function canonicalScoped<T extends ScopedDefinition>(xs: readonly T[]): T[] {
  return [...xs].sort((a, b) => compareBytes(encodeWith(writeScoped, a), encodeWith(writeScoped, b)));
}

/** Proofs in canonical order: ascending by encoding. */
export function canonicalProofs(proofs: readonly SemanticProofRef[]): SemanticProofRef[] {
  return canonicalScoped(proofs);
}

/** Bindings in canonical order: ascending by encoding. */
export function canonicalBindings(bindings: readonly SemanticTermBinding[]): SemanticTermBinding[] {
  return canonicalScoped(bindings);
}

/** Whether two definitions are the same exact identity: owner (digest included), identifier and version. */
export function sameDefinition(a: SemanticInvariantRef, b: SemanticInvariantRef): boolean {
  return bytesToHex(encodeWith(writeSemanticInvariantRef, a)) === bytesToHex(encodeWith(writeSemanticInvariantRef, b));
}

// --- Rules -----------------------------------------------------------------------

/** Whether the owner may define this invariant at all: Core's namespace, or the module's own name at its version. */
export function ownerConsistent(d: SemanticInvariantRef): boolean {
  const core = d.invariantId.startsWith(CORE_INVARIANT_PREFIX);
  if (d.owner.kind === 'CORE') return core;
  const m = d.owner.module;
  return !core && d.invariantId.startsWith(`${m.moduleId}.`) && (d.version as number) === (m.moduleVersion as number);
}

function scopedMatches(p: ScopedDefinition, t: StateInvariantTerm): boolean {
  const d = p.definition;
  return d.invariantId === t.invariantId && d.version === t.version && p.scope.length === t.scope.length && p.scope.every((r, i) => resourceIdsEqual(r, t.scope[i] as ResourceId));
}

/** Whether `p` is the proof for term `t`: same definition name and version, same scope. */
export function proofMatches(p: SemanticProofRef, t: StateInvariantTerm): boolean {
  return scopedMatches(p, t);
}

/** Whether `b` is the binding of term `t`: same definition name and version, same scope. */
export function bindingMatches(b: SemanticTermBinding, t: StateInvariantTerm): boolean {
  return scopedMatches(b, t);
}

/** A term outside Core's namespace: its meaning is a domain module's, so it must be bound (7D.3). */
export function isModuleDefined(t: StateInvariantTerm): boolean {
  return !t.invariantId.startsWith(CORE_INVARIANT_PREFIX);
}

/** The committed binding of `t` among `bindings`, or `null` (a Core term, or an unbound one). */
export function bindingOf(bindings: readonly SemanticTermBinding[], t: StateInvariantTerm): SemanticTermBinding | null {
  return bindings.find((b) => bindingMatches(b, t)) ?? null;
}

function sameBinding(a: SemanticTermBinding | null, b: SemanticTermBinding | null): boolean {
  return a === null || b === null ? a === b : sameDefinition(a.definition, b.definition);
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
    if (scopedKey(p) !== scopedKey(canonical[i] as SemanticProofRef)) return refuse('SEMANTIC_PROOF_INVALID', `${path}[${i}]`);
    if (terms.has(termKeyOf(p))) return refuse('SEMANTIC_PROOF_INVALID', `${path}[${i}]`);
    terms.add(termKeyOf(p));
    if (!ownerConsistent(p.definition)) return refuse('SEMANTIC_PROOF_INVALID', `${path}[${i}].definition`);
    if (!needed.some((t) => proofMatches(p, t))) return refuse('SEMANTIC_PROOF_UNEXPECTED', `${path}[${i}]`);
  }
  return ok(true);
}

/**
 * The bindings of one registration, checked against its invariant terms
 * (7D.3): canonical order, at most one per term, every owner an exact
 * `ModuleRef` structurally able to define its invariant, each for exactly
 * one module-defined term, and every module-defined term bound. A Core term
 * is never bound: its meaning is Core's, not a module's.
 */
export function checkBindingSet(bindings: readonly SemanticTermBinding[], terms: readonly StateInvariantTerm[], path: string, termsPath: string): LedgerResult<true> {
  if (bindings.length > MAX_SEMANTIC_BINDINGS) return refuse('SEMANTIC_BINDING_INVALID', path);
  const canonical = canonicalBindings(bindings);
  const seen = new Set<string>();
  for (let i = 0; i < bindings.length; i += 1) {
    const b = bindings[i] as SemanticTermBinding;
    if (scopedKey(b) !== scopedKey(canonical[i] as SemanticTermBinding)) return refuse('SEMANTIC_BINDING_INVALID', `${path}[${i}]`);
    if (seen.has(termKeyOf(b))) return refuse('SEMANTIC_BINDING_INVALID', `${path}[${i}]`);
    seen.add(termKeyOf(b));
    if (b.definition.owner.kind !== 'MODULE' || !ownerConsistent(b.definition)) return refuse('SEMANTIC_BINDING_INVALID', `${path}[${i}].definition`);
    if (!terms.some((t) => isModuleDefined(t) && bindingMatches(b, t))) return refuse('SEMANTIC_BINDING_UNEXPECTED', `${path}[${i}]`);
  }
  for (let j = 0; j < terms.length; j += 1) {
    const t = terms[j] as StateInvariantTerm;
    // No registry inference, no default module, no "latest": an unbound module-defined term has no meaning.
    if (isModuleDefined(t) && bindingOf(bindings, t) === null) return refuse('SEMANTIC_BINDING_MISSING', `${termsPath}.invariant[${j}]`);
  }
  return ok(true);
}

/**
 * A proof for a module-defined term names exactly that term's binding: a
 * comparator never orders parameters whose meaning is another definition's
 * (7D.3). A Core proof concerns a Core term, which has no binding.
 */
export function checkProofsBound(proofs: readonly SemanticProofRef[], bindings: readonly SemanticTermBinding[], path: string): LedgerResult<true> {
  for (let i = 0; i < proofs.length; i += 1) {
    const p = proofs[i] as SemanticProofRef;
    if (p.definition.owner.kind !== 'MODULE') continue;
    const b = bindings.find((x) => termKeyOf(x) === termKeyOf(p));
    if (b === undefined || !sameDefinition(b.definition, p.definition)) return refuse('SEMANTIC_BINDING_MISMATCH', `${path}[${i}].definition`);
  }
  return ok(true);
}

/**
 * A child restating a parent's term restates its semantics: the same
 * binding, or — for a Core term — none (7D.3). Otherwise one name would carry
 * two meanings down one lineage; new semantics need new authority.
 */
export function checkRestatedBindings(
  parent: readonly StateInvariantTerm[],
  parentBindings: readonly SemanticTermBinding[],
  child: readonly StateInvariantTerm[],
  childBindings: readonly SemanticTermBinding[],
  termsPath: string,
): LedgerResult<true> {
  const before = new Map(parent.map((t) => [termKey(t), t]));
  for (let j = 0; j < child.length; j += 1) {
    const t = child[j] as StateInvariantTerm;
    const p = before.get(termKey(t));
    if (p !== undefined && !sameBinding(bindingOf(parentBindings, p), bindingOf(childBindings, t))) return refuse('SEMANTIC_BINDING_MISMATCH', `${termsPath}.invariant[${j}]`);
  }
  return ok(true);
}

/** Whether `next`, restating `previous`, keeps its exact semantics: the same binding, or none for a Core term. */
export function keepsSemantics(previous: StateInvariantTerm, previousBindings: readonly SemanticTermBinding[], next: StateInvariantTerm, nextBindings: readonly SemanticTermBinding[]): boolean {
  return sameBinding(bindingOf(previousBindings, previous), bindingOf(nextBindings, next));
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
