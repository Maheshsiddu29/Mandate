/**
 * The derived ledger state of one principal (authority-ledger.md §1, §4, §7).
 *
 * `LedgerState` is the fold of the principal's event log. It is immutable and
 * structurally shared (`PMap`), so a snapshot read at version `v` stays
 * version `v` after later commits, and a commit costs O(what it touches), not
 * O(history). The event log is authoritative; this is a cache of its fold,
 * and `encodeLedgerState` gives it one canonical byte string so an
 * incrementally maintained state and a full replay can be compared exactly
 * (LEDGER-6).
 *
 * What it holds:
 *
 * - **nodes** — every registered grant, never mutated: registration version,
 *   depth, the exact semantic binding of each module-defined term (7D.3),
 *   and revocation (version and `RevocationId`) once revoked. The principal
 *   policy likewise keeps the bindings it was registered with.
 * - **targets** — one balance per charge target: every ledger dimension of
 *   every node, and every principal-global dimension the policy has had.
 *   A node target's capacity comes from its signed grant; a policy target's
 *   ceiling from the policy in force, which grants nothing (§20 of the brief:
 *   the arithmetic is alike, the source is not, so it is recorded).
 * - **reservations** — per `ReservationId` (so per generation): the plan's
 *   contributions and, for each, its legs and cumulative reserved, consumed,
 *   released and restored amounts. The legs are the charge attribution: a
 *   restoration credits exactly these legs.
 * - **actions** — per `ActionId`, the last generation reserved and the open
 *   one, so generations are strictly sequential and never overlap.
 * - **attempts** (7E.1) — every admitted issuance attempt, with the indexes
 *   that keep an artifact identity and a venue replay slot bound to at most
 *   one attempt ever, and the attempts of each reservation in order.
 *
 * Balances are cumulative: nothing consumed or restored is ever decremented
 * (§4: `C` and `Rs` are monotone). Available authority is derived, never
 * stored.
 */

import type { ByteWriter } from '@mandate/kernel';
import {
  encodeAuthorityGrant,
  encodePrincipalPolicy,
  keccakDigest,
  writeDigest,
  writeModuleRef,
  writeNullable,
  writeParty,
  writeQuantityBody,
  writeResourceId,
  type ActionId,
  type AuthorityGrant,
  type AuthorityId,
  type ImplementationDigest,
  type LedgerDimensionTerm,
  type LedgerHeadDigest,
  type LedgerVersion,
  type ModuleRef,
  type PrincipalId,
  type PrincipalPolicy,
  type PrincipalPolicyId,
  type ReservationGeneration,
  type ReservationId,
  type ResourceId,
  type Tagged,
  type Digest32,
} from '@mandate/core';
import { writeAttemptAdmission, type AttemptId, type AttemptRecord } from './attempt.ts';
import { LedgerTag, ledgerDigest, ledgerWriter, writeSegment } from './encoding.ts';
import type { Contribution } from './charge-plan.ts';
import type { TargetRef } from './errors.ts';
import { PMap } from './pmap.ts';
import type { RevocationId } from './revocation.ts';
import { writeSemanticTermBinding, type SemanticTermBinding } from './semantic.ts';

export interface NodeRecord {
  readonly id: AuthorityId;
  readonly grant: AuthorityGrant;
  /** 0 for a root. */
  readonly depth: number;
  /**
   * The exact definition each module-defined term means, as committed by the
   * registration (7D.3), in canonical order. Fixed for the node's life: no
   * later registry state reinterprets it.
   */
  readonly bindings: readonly SemanticTermBinding[];
  readonly registeredAt: LedgerVersion;
  /** The version whose batch recorded this node's own revocation. An ancestor's revocation is not copied here. */
  readonly revokedAt: LedgerVersion | null;
  readonly revocation: RevocationId | null;
}

/** Where a target's capacity comes from. Only a grant confers authority. */
export type CapacitySource = 'GRANT' | 'POLICY';

export interface TargetBalance {
  readonly ref: TargetRef;
  readonly source: CapacitySource;
  /** The dimension as currently in force. For a policy target, the latest policy that keeps it. */
  readonly dimension: LedgerDimensionTerm;
  /** Whether the current policy still has this dimension. Node targets are always current. */
  readonly current: boolean;
  /** Σ remaining of ACTIVE legs. */
  readonly reserved: bigint;
  /** Cumulative; never decremented. */
  readonly consumed: bigint;
  /** Cumulative; `CAPACITY` only; never above `consumed`. */
  readonly restored: bigint;
  /**
   * `EPOCH` only: consumption attributed to the latest epoch any consumption
   * was attributed to. Evaluation time never regresses on a ledger, so no
   * decision can need an earlier epoch's figure.
   */
  readonly epochConsumed: { readonly epoch: bigint; readonly atoms: bigint } | null;
}

export interface LegRecord {
  readonly key: string;
  readonly ref: TargetRef;
  /** The target dimension's decimals; leg amounts are the contribution's rescaled exactly to it. */
  readonly decimals: number;
  readonly capacity: boolean;
  /** `EPOCH` legs: the window the reservation was committed in. */
  readonly epoch: bigint | null;
}

export interface DemandRecord {
  readonly contribution: Contribution;
  readonly legs: readonly LegRecord[];
  /** At the contribution's decimals. Every leg of the demand moves by the same amounts. */
  readonly reserved: bigint;
  readonly consumed: bigint;
  readonly released: bigint;
  readonly restored: bigint;
}

export type ReservationStatus = 'ACTIVE' | 'CLOSED';

export interface ReservationRecord {
  readonly id: ReservationId;
  readonly action: ActionId;
  readonly generation: ReservationGeneration;
  readonly authority: AuthorityId;
  /** Leaf to root. */
  readonly lineage: readonly AuthorityId[];
  readonly policy: PrincipalPolicyId;
  readonly module: ModuleRef;
  readonly implementation: ImplementationDigest;
  readonly committedAt: LedgerVersion;
  readonly reservedAt: bigint;
  readonly status: ReservationStatus;
  readonly demands: readonly DemandRecord[];
}

export interface ActionRecord {
  readonly lastGeneration: ReservationGeneration;
  readonly open: ReservationId | null;
}

export interface PolicyRecord {
  readonly id: PrincipalPolicyId;
  readonly policy: PrincipalPolicy;
  /** The exact definition each module-defined principal-global term means (7D.3), in canonical order. */
  readonly bindings: readonly SemanticTermBinding[];
  readonly registeredAt: LedgerVersion;
}

export interface LedgerState {
  readonly principal: PrincipalId;
  readonly version: LedgerVersion;
  readonly head: LedgerHeadDigest;
  /** The latest evaluation time any committed event carried. */
  readonly lastAt: bigint | null;
  readonly policy: PolicyRecord | null;
  /** Whether any reservation was ever committed: the only baseline 7C can prove is the empty one. */
  readonly everReserved: boolean;
  readonly nodes: PMap<NodeRecord>;
  readonly targets: PMap<TargetBalance>;
  readonly reservations: PMap<ReservationRecord>;
  readonly actions: PMap<ActionRecord>;
  /** 7E.1: by `AttemptId`. */
  readonly attempts: PMap<AttemptRecord>;
  /** 7E.1: artifact identity key → the one attempt that bound it. */
  readonly attemptArtifacts: PMap<AttemptId>;
  /** 7E.1: venue slot key → the one attempt that bound it. */
  readonly attemptSlots: PMap<AttemptId>;
  /** 7E.1: reservation → its attempts, in admission order. */
  readonly reservationAttempts: PMap<readonly AttemptId[]>;
}

// --- Genesis -------------------------------------------------------------------

/** `H("mandate-core/v1/ledger-genesis", principal)`: the head of version 0. Distinct per principal. */
export function genesisHead(principal: PrincipalId): LedgerHeadDigest {
  const w = ledgerWriter(LedgerTag.LEDGER_GENESIS);
  writeParty(w, principal);
  return ledgerDigest<LedgerHeadDigest>(w);
}

export function emptyLedgerState(principal: PrincipalId): LedgerState {
  return {
    principal,
    version: 0n as LedgerVersion,
    head: genesisHead(principal),
    lastAt: null,
    policy: null,
    everReserved: false,
    nodes: PMap.empty(),
    targets: PMap.empty(),
    reservations: PMap.empty(),
    actions: PMap.empty(),
    attempts: PMap.empty(),
    attemptArtifacts: PMap.empty(),
    attemptSlots: PMap.empty(),
    reservationAttempts: PMap.empty(),
  };
}

// --- Target keys ---------------------------------------------------------------

export type PolicyDimensionIdentity = Tagged<Digest32, 'PolicyDimensionIdentity'>;

/**
 * A principal-global dimension's identity: everything but its limit. A
 * replacement policy that keeps a dimension — same identifier, measure,
 * accounting, restoration, epoch, sign and scope — keeps its target and its
 * consumption history (authority-model.md §8.2); changing any of those is a
 * new dimension.
 */
export function policyDimensionIdentity(d: LedgerDimensionTerm): PolicyDimensionIdentity {
  const w = ledgerWriter(LedgerTag.POLICY_DIMENSION);
  w.str(d.dimensionId).str(d.limit.kind).str(d.limit.unit).u8(d.limit.decimals).str(d.accounting).str(d.restoration);
  writeNullable(w, d.epoch, (x, e) => x.i64(e.anchor).u64(e.lengthSeconds));
  w.str(d.sign);
  writeNullable<ResourceId>(w, d.scope.asset, writeResourceId);
  writeNullable<ResourceId>(w, d.scope.market, writeResourceId);
  writeNullable(w, d.scope.domain, (x, s) => x.str(s));
  writeNullable<ResourceId>(w, d.scope.account, writeResourceId);
  return ledgerDigest<PolicyDimensionIdentity>(w);
}

export function nodeTargetKey(authority: AuthorityId, dimensionId: string): string {
  return JSON.stringify(['N', authority, dimensionId]);
}

export function policyTargetKey(identity: PolicyDimensionIdentity): string {
  return JSON.stringify(['P', identity]);
}

// --- Available authority -------------------------------------------------------

export function epochIndex(d: LedgerDimensionTerm, at: bigint): bigint | null {
  if (d.epoch === null || at < d.epoch.anchor) return null;
  return (at - d.epoch.anchor) / d.epoch.lengthSeconds;
}

/**
 * `A` at time `at` (authority-ledger.md §7), for an `UNSIGNED` dimension:
 *
 * - `BUDGET NONE`:  `G − C − R`
 * - `BUDGET EPOCH`: `G − C_e − R`, `C_e` the consumption attributed to `at`'s
 *   epoch. `R` is every open reservation: with time never regressing, an open
 *   reservation is from this epoch or an earlier one, which is exactly `R_e`.
 * - `CAPACITY`:     `G − C − R + Rs`, with `0 ≤ Rs ≤ C`.
 *
 * May be negative only when a replaced policy tightened a limit below
 * occupancy; then nothing positive fits.
 */
export function availableOf(b: TargetBalance, at: bigint): bigint {
  const g = b.dimension.limit.atoms;
  switch (b.dimension.restoration) {
    case 'NONE':
      return g - b.consumed - b.reserved;
    case 'EPOCH': {
      const e = epochIndex(b.dimension, at);
      const ce = e !== null && b.epochConsumed !== null && b.epochConsumed.epoch === e ? b.epochConsumed.atoms : 0n;
      return g - ce - b.reserved;
    }
    case 'AS_CHARGED':
    case 'UNITS':
      return g - b.consumed - b.reserved + b.restored;
  }
}

// --- Canonical state encoding --------------------------------------------------

export function writeTargetRef(w: ByteWriter, ref: TargetRef): void {
  if (ref.kind === 'NODE') {
    w.u8(1);
    writeDigest(w, ref.authority);
  } else {
    w.u8(2);
    writeDigest(w, ref.policy);
  }
  w.str(ref.dimensionId);
}


function writeBindings(w: ByteWriter, bindings: readonly SemanticTermBinding[]): void {
  w.u16(bindings.length);
  for (const b of bindings) writeSemanticTermBinding(w, b);
}

/**
 * One canonical byte string for a whole ledger state: every map in ascending
 * key order, every field written. Two states are the same logical state iff
 * their encodings are equal. Used to check that incremental application and
 * full replay agree (LEDGER-6); not a wire format.
 */
export function encodeLedgerState(s: LedgerState): Uint8Array {
  const w = ledgerWriter(LedgerTag.LEDGER_STATE);
  writeParty(w, s.principal);
  w.u64(s.version);
  writeDigest(w, s.head);
  writeNullable(w, s.lastAt, (x, t) => x.i64(t));
  writeNullable(w, s.policy, (x, p) => {
    writeSegment(x, encodePrincipalPolicy(p.policy));
    writeBindings(x, p.bindings);
    x.u64(p.registeredAt);
  });
  w.u8(s.everReserved ? 1 : 0);

  const nodes = s.nodes.sortedKeys();
  w.u32(nodes.length);
  for (const k of nodes) {
    const n = s.nodes.get(k) as NodeRecord;
    writeSegment(w, encodeAuthorityGrant(n.grant));
    writeBindings(w, n.bindings);
    w.u8(n.depth).u64(n.registeredAt);
    writeNullable(w, n.revokedAt, (x, v) => x.u64(v));
    writeNullable(w, n.revocation, (x, r) => writeDigest(x, r));
  }

  const targets = s.targets.sortedKeys();
  w.u32(targets.length);
  for (const k of targets) {
    const t = s.targets.get(k) as TargetBalance;
    w.str(k);
    writeTargetRef(w, t.ref);
    w.str(t.source).u8(t.current ? 1 : 0).u256(t.dimension.limit.atoms).u256(t.reserved).u256(t.consumed).u256(t.restored);
    writeNullable(w, t.epochConsumed, (x, e) => x.u64(e.epoch).u256(e.atoms));
  }

  const reservations = s.reservations.sortedKeys();
  w.u32(reservations.length);
  for (const k of reservations) {
    const r = s.reservations.get(k) as ReservationRecord;
    writeDigest(w, r.id);
    writeDigest(w, r.action);
    w.u64(r.generation);
    writeDigest(w, r.authority);
    w.u16(r.lineage.length);
    for (const id of r.lineage) writeDigest(w, id);
    writeDigest(w, r.policy);
    writeModuleRef(w, r.module);
    writeDigest(w, r.implementation);
    w.u64(r.committedAt).i64(r.reservedAt).str(r.status);
    w.u16(r.demands.length);
    for (const d of r.demands) {
      writeQuantityBody(w, d.contribution.quantity);
      writeNullable<ResourceId>(w, d.contribution.market, writeResourceId);
      writeNullable<ResourceId>(w, d.contribution.account, writeResourceId);
      w.u8(d.contribution.required ? 1 : 0);
      w.u256(d.reserved).u256(d.consumed).u256(d.released).u256(d.restored);
      w.u16(d.legs.length);
      for (const l of d.legs) {
        w.str(l.key);
        writeTargetRef(w, l.ref);
        w.u8(l.decimals).u8(l.capacity ? 1 : 0);
        writeNullable(w, l.epoch, (x, e) => x.u64(e));
      }
    }
  }

  const actions = s.actions.sortedKeys();
  w.u32(actions.length);
  for (const k of actions) {
    const a = s.actions.get(k) as ActionRecord;
    w.str(k).u64(a.lastGeneration);
    writeNullable(w, a.open, (x, id) => writeDigest(x, id));
  }

  // 7E.1: written only when an attempt exists, so every earlier state keeps its exact encoding.
  // The artifact, slot and reservation indexes are functions of the attempts, so the attempts alone are canonical.
  const attempts = s.attempts.sortedKeys();
  if (attempts.length > 0) {
    w.str('attempts').u32(attempts.length);
    for (const k of attempts) {
      const a = s.attempts.get(k) as AttemptRecord;
      writeAttemptAdmission(w, a);
      w.u64(a.admittedAt).i64(a.admittedTime).str(a.status);
    }
  }
  return w.finish();
}

export type LedgerStateDigest = Tagged<Digest32, 'LedgerStateDigest'>;

export function ledgerStateDigest(s: LedgerState): LedgerStateDigest {
  return keccakDigest<LedgerStateDigest>(encodeLedgerState(s));
}
