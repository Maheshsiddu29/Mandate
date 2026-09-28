/**
 * The projection record and its digest (action-state-model.md §6; PROJ-1;
 * brief §11, §51).
 *
 * ```text
 * S' = Project_d(S ⊕ Pending(L), A)
 * ```
 *
 * Each participating module projects its own domain: the state admitted to
 * it (`HELD`), the worst case of every unresolved reservation under its exact
 * `ModuleRef` (`PENDING`), and — for the acting module, when proposing — the
 * action (`PROPOSED`). Core does not interpret a module's payload; it records
 * the standardized outputs (facts, invariant facts, resources, assumptions)
 * and the payload's bytes, together with exactly which snapshots and which
 * reservations each module was given, and digests the whole.
 *
 * The digest is canonical: facts, invariant facts, resources and assumptions
 * are sets, sorted by their encodings, and participants are sorted by their
 * `ModuleRef`. The same action, authority and external state under different
 * module semantics therefore differs twice over — in the `ModuleRef` and in
 * the projection digest (brief §51).
 *
 * A projection is hypothetical. Nothing here, or anywhere a projection is
 * read, consumes, releases or restores authority (brief §53): the only ledger
 * write a decision can cause is its own `RESERVE`.
 */

import type { ByteWriter } from '@mandate/kernel';
import {
  keccakDigest,
  writeDigest,
  writeModuleRef,
  writeNullable,
  writeQuantityBody,
  writeResourceId,
  type Digest32,
  type ImplementationDigest,
  type LedgerVersion,
  type ModuleRef,
  type ReservationId,
  type ResourceId,
  type StateId,
  type Tagged,
} from '@mandate/core';
import { ControlTag, controlDigest, controlWriter, sortCanonical, writeDigestList, writeMeasure, writeStrList } from './encoding.ts';
import type { EconomicFact, InvariantFact, ModuleProjection } from './module.ts';

export type ProjectionDigest = Tagged<Digest32, 'ProjectionDigest'>;
export type StateDependencyDigest = Tagged<Digest32, 'StateDependencyDigest'>;

const COMPONENT_CODE = { HELD: 1, PENDING: 2, PROPOSED: 3 } as const;

export function writeFact(w: ByteWriter, f: EconomicFact): void {
  w.u8(COMPONENT_CODE[f.component]);
  writeQuantityBody(w, f.quantity);
  writeNullable<ResourceId>(w, f.market, writeResourceId);
  writeNullable<ResourceId>(w, f.account, writeResourceId);
  writeDigestList(w, f.states);
  writeDigestList(w, f.reservations);
}

export function writeInvariantFact(w: ByteWriter, f: InvariantFact): void {
  w.str(f.factId);
  writeNullable<ResourceId>(w, f.subject, writeResourceId);
  writeMeasure(w, f.value);
  writeDigestList(w, f.states);
  writeDigestList(w, f.reservations);
}

/** A module projection in canonical form: every list a set in encoded order, the payload as given. */
export function writeModuleProjection(w: ByteWriter, p: ModuleProjection): void {
  const facts = sortCanonical(p.facts, writeFact);
  w.u32(facts.length);
  for (const f of facts) writeFact(w, f);
  const inv = sortCanonical(p.invariantFacts, writeInvariantFact);
  w.u32(inv.length);
  for (const f of inv) writeInvariantFact(w, f);
  const resources = sortCanonical(p.resources, writeResourceId);
  w.u32(resources.length);
  for (const r of resources) writeResourceId(w, r);
  writeStrList(w, [...p.assumptions].sort());
  w.u32(p.payload.length).raw(p.payload);
}

/** One module's part of a decision's projection, with exactly what it was given. */
export interface ParticipantProjection {
  readonly module: ModuleRef;
  readonly implementation: ImplementationDigest;
  /** Whether it is the acting module (the only one given the action). */
  readonly acting: boolean;
  /** Snapshots admitted to it, by `StateId`. */
  readonly states: readonly StateId[];
  /** Unresolved reservations under its exact `ModuleRef`. */
  readonly reservations: readonly ReservationId[];
  /** Unresolved reservations in its domain under a *different* `ModuleRef`: it could not account for them. */
  readonly foreignPending: readonly ReservationId[];
  readonly projection: ModuleProjection;
}

export interface ProjectionRecord {
  /** The ledger version whose unresolved reservations were projected. */
  readonly ledgerVersion: LedgerVersion;
  readonly participants: readonly ParticipantProjection[];
}

function writeParticipant(w: ByteWriter, p: ParticipantProjection): void {
  writeModuleRef(w, p.module);
  writeDigest(w, p.implementation);
  w.u8(p.acting ? 1 : 0);
  writeDigestList(w, p.states);
  writeDigestList(w, p.reservations);
  writeDigestList(w, p.foreignPending);
  writeModuleProjection(w, p.projection);
}

export function encodeProjectionRecord(r: ProjectionRecord): Uint8Array {
  const w = controlWriter(ControlTag.PROJECTION);
  w.u64(r.ledgerVersion);
  const participants = sortCanonical(r.participants, (x, p) => writeModuleRef(x, p.module));
  w.u16(participants.length);
  for (const p of participants) writeParticipant(w, p);
  return w.finish();
}

export function projectionDigest(r: ProjectionRecord): ProjectionDigest {
  return keccakDigest<ProjectionDigest>(encodeProjectionRecord(r));
}

/** Which snapshots one module's projection depended on (brief §11, "state dependency digest"). */
export function stateDependencyDigest(module: ModuleRef, states: readonly StateId[]): StateDependencyDigest {
  const w = controlWriter(ControlTag.STATE_DEPENDENCIES);
  writeModuleRef(w, module);
  writeDigestList(w, [...states].sort());
  return controlDigest<StateDependencyDigest>(w);
}
