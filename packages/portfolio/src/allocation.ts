/**
 * The allocation book (portfolio-mandate.md §6).
 *
 * Allocation is **coordination, not authority**: it decides which agent gets
 * which part of the principal's resources *inside* the principal's hard
 * limits. The hard limits themselves are the ledger's (compile.ts); nothing
 * here can widen them, and a bug here can only mis-distribute inside them or
 * refuse.
 *
 * Every portfolio-limited resource is allocated. The book is a pure value:
 * each operation returns a new book or a refusal, and the book keeps the log
 * of every operation it applied, so the verifier can replay it from the
 * mandate's initial book and compare.
 *
 * ```text
 * initial   PREALLOCATED, HYBRID: allocated = preferred; the remainder of each limit is one lot
 *           DYNAMIC:              allocated = 0; the whole limit is one lot
 * COMMIT    committed + x ≤ allocated                       one commit per proposal
 * RELEASE   x ≤ allocated − committed; allocated −= x; x becomes a new lot    one per release id
 * CLAIM     DYNAMIC and HYBRID only; x ≤ lot.remaining; allocated + x ≤ the agent's cap    one per claim id
 *           (its listed hard maximum, or the portfolio limit where it lists none)
 * invariant Σ allocated + Σ lot.remaining = portfolio limit; committed ≤ allocated
 * ```
 *
 * A lot's amount can be claimed once in total — the sum of its claims never
 * exceeds it — which is what "released authority is reallocated exactly
 * once" means.
 */

import { err, ok, type ByteWriter, type Identifier, type Result } from '@mandate/kernel';
import { partyIdsEqual, writeParty, type AgentId } from '@mandate/core';
import { agentPolicyOf, type AllocationMode, type PortfolioMandate } from './mandate.ts';
import { reason, type Reason } from './reasons.ts';
import { amountOf, compareResourceIds, type PortfolioResourceId, type ResourceVector } from './resources.ts';

/** What an agent may hold of a resource: its listed hard maximum, or the portfolio limit where it lists none. */
export function agentCap(m: PortfolioMandate, agent: AgentId, resource: string): bigint {
  const policy = agentPolicyOf(m, agent);
  if (policy === null) return 0n;
  const listed = policy.hardMaxima.find((h) => h.resource === resource);
  return listed === undefined ? amountOf(m.limits, resource) : listed.atoms;
}

export interface AllocationEntry {
  readonly agent: AgentId;
  readonly resource: PortfolioResourceId;
  readonly allocated: bigint;
  readonly committed: bigint;
}

export interface Lot {
  readonly id: Identifier;
  readonly resource: PortfolioResourceId;
  /** The releasing agent, or `null` for the unallocated remainder of the portfolio limit. */
  readonly from: AgentId | null;
  readonly amount: bigint;
  readonly remaining: bigint;
}

export type AllocationOp =
  | { readonly kind: 'COMMIT'; readonly agent: AgentId; readonly id: Identifier; readonly amounts: ResourceVector }
  | { readonly kind: 'RELEASE'; readonly agent: AgentId; readonly id: Identifier; readonly amounts: ResourceVector }
  | { readonly kind: 'CLAIM'; readonly agent: AgentId; readonly id: Identifier; readonly lot: Identifier; readonly amount: bigint };

export interface AllocationBook {
  readonly mode: AllocationMode;
  /** One entry per (agent, limited resource), agents in mandate order, resources in canonical order. */
  readonly entries: readonly AllocationEntry[];
  /** In creation order: the unallocated remainders first, then each release. Claims draw in this order. */
  readonly lots: readonly Lot[];
  /** Every operation applied, in order. */
  readonly log: readonly AllocationOp[];
}

/** The resources the book allocates: every resource with a portfolio limit, in canonical order. */
export function allocatedResources(m: PortfolioMandate): readonly PortfolioResourceId[] {
  return m.limits.map((l) => l.resource).sort(compareResourceIds);
}

export function lotId(kind: 'unallocated' | 'release', ref: string, resource: string): Identifier {
  return `lot/${kind}/${ref}/${resource}` as Identifier;
}

export function initialBook(m: PortfolioMandate): AllocationBook {
  const resources = allocatedResources(m);
  const preferred = m.allocationMode === 'DYNAMIC' ? () => 0n : (a: (typeof m.agents)[number], r: string) => amountOf(a.preferred, r);
  const entries: AllocationEntry[] = [];
  for (const a of m.agents) for (const r of resources) entries.push({ agent: a.agent, resource: r, allocated: preferred(a, r), committed: 0n });
  const lots: Lot[] = [];
  for (const r of resources) {
    const limit = amountOf(m.limits, r);
    const taken = entries.filter((e) => e.resource === r).reduce((s, e) => s + e.allocated, 0n);
    // A mandate whose preferred allocations exceed a limit is invalid (checkPortfolioMandate); never a negative lot.
    const remainder = limit > taken ? limit - taken : 0n;
    if (remainder > 0n) lots.push({ id: lotId('unallocated', 'portfolio', r), resource: r, from: null, amount: remainder, remaining: remainder });
  }
  return { mode: m.allocationMode, entries, lots, log: [] };
}

function entryIndex(book: AllocationBook, agent: AgentId, resource: string): number {
  return book.entries.findIndex((e) => partyIdsEqual(e.agent, agent) && e.resource === resource);
}

function applied(book: AllocationBook, kind: AllocationOp['kind'], id: string): boolean {
  return book.log.some((op) => op.kind === kind && op.id === id);
}

/** Apply one operation: the new book, or the reason nothing changed. */
export function applyAllocation(m: PortfolioMandate, book: AllocationBook, op: AllocationOp): Result<AllocationBook, Reason> {
  const policy = agentPolicyOf(m, op.agent);
  if (policy === null) return err(reason('AGENT_UNKNOWN', op.agent.value));
  const entries = [...book.entries];
  const lots = [...book.lots];
  switch (op.kind) {
    case 'COMMIT': {
      if (applied(book, 'COMMIT', op.id)) return err(reason('COMMIT_ALREADY_APPLIED', op.id));
      for (const a of op.amounts) {
        const i = entryIndex(book, op.agent, a.resource);
        if (i < 0) return err(reason('RESOURCE_UNDECLARED', a.resource));
        const e = entries[i] as AllocationEntry;
        if (e.committed + a.atoms > e.allocated) return err(reason('COMMIT_EXCEEDS_ALLOCATION', `${op.agent.value}/${a.resource}`));
        entries[i] = { ...e, committed: e.committed + a.atoms };
      }
      break;
    }
    case 'RELEASE': {
      if (applied(book, 'RELEASE', op.id)) return err(reason('RELEASE_ALREADY_APPLIED', op.id));
      for (const a of op.amounts) {
        const i = entryIndex(book, op.agent, a.resource);
        if (i < 0) return err(reason('RESOURCE_UNDECLARED', a.resource));
        const e = entries[i] as AllocationEntry;
        if (a.atoms > e.allocated - e.committed) return err(reason('RELEASE_EXCEEDS_UNUSED', `${op.agent.value}/${a.resource}`));
        if (a.atoms === 0n) continue;
        entries[i] = { ...e, allocated: e.allocated - a.atoms };
        lots.push({ id: lotId('release', op.id, a.resource), resource: a.resource, from: op.agent, amount: a.atoms, remaining: a.atoms });
      }
      break;
    }
    case 'CLAIM': {
      if (book.mode === 'PREALLOCATED') return err(reason('CLAIM_NOT_PERMITTED_IN_MODE', op.id));
      if (applied(book, 'CLAIM', op.id)) return err(reason('CLAIM_ALREADY_APPLIED', op.id));
      const li = lots.findIndex((l) => l.id === op.lot);
      if (li < 0) return err(reason('LOT_UNKNOWN', op.lot));
      const lot = lots[li] as Lot;
      if (op.amount <= 0n || op.amount > lot.remaining) return err(reason('LOT_EXHAUSTED', op.lot));
      const i = entryIndex(book, op.agent, lot.resource);
      if (i < 0) return err(reason('RESOURCE_UNDECLARED', lot.resource));
      const e = entries[i] as AllocationEntry;
      if (e.allocated + op.amount > agentCap(m, op.agent, lot.resource)) return err(reason('AGENT_LIMIT_EXCEEDED', `${op.agent.value}/${lot.resource}`));
      entries[i] = { ...e, allocated: e.allocated + op.amount };
      lots[li] = { ...lot, remaining: lot.remaining - op.amount };
      break;
    }
  }
  return ok({ mode: book.mode, entries, lots, log: [...book.log, op] });
}

/** Replay a log from the mandate's initial book: the book it produces, or the first operation refused and why. */
export function replayAllocation(m: PortfolioMandate, log: readonly AllocationOp[]): Result<AllocationBook, { readonly index: number; readonly reason: Reason }> {
  let book = initialBook(m);
  for (let i = 0; i < log.length; i += 1) {
    const next = applyAllocation(m, book, log[i] as AllocationOp);
    if (!next.ok) return err({ index: i, reason: next.error });
    book = next.value;
  }
  return ok(book);
}

/** Every broken book invariant. Empty for any book `applyAllocation` produced from `initialBook`. */
export function checkBookInvariant(m: PortfolioMandate, book: AllocationBook): readonly Reason[] {
  const found: Reason[] = [];
  for (const r of allocatedResources(m)) {
    const allocated = book.entries.filter((e) => e.resource === r).reduce((s, e) => s + e.allocated, 0n);
    const pooled = book.lots.filter((l) => l.resource === r).reduce((s, l) => s + l.remaining, 0n);
    if (allocated + pooled !== amountOf(m.limits, r)) found.push(reason('CANDIDATE_BOOK_MISMATCH', `conservation/${r}`));
  }
  for (const e of book.entries) {
    const policy = agentPolicyOf(m, e.agent);
    const cap = policy === null ? 0n : book.mode === 'PREALLOCATED' ? amountOf(policy.preferred, e.resource) : agentCap(m, e.agent, e.resource);
    if (e.committed > e.allocated || e.allocated > cap) found.push(reason('CANDIDATE_BOOK_MISMATCH', `${e.agent.value}/${e.resource}`));
  }
  for (const l of book.lots) if (l.remaining < 0n || l.remaining > l.amount) found.push(reason('CANDIDATE_BOOK_MISMATCH', l.id));
  return found;
}

export function entryOf(book: AllocationBook, agent: AgentId, resource: string): AllocationEntry | null {
  const i = entryIndex(book, agent, resource);
  return i < 0 ? null : (book.entries[i] as AllocationEntry);
}

/** What `agent` could commit of `resource` now: its unused allocation plus, where claims are permitted, what it may still claim. */
export function obtainable(m: PortfolioMandate, book: AllocationBook, agent: AgentId, resource: string): bigint {
  const e = entryOf(book, agent, resource);
  const policy = agentPolicyOf(m, agent);
  if (e === null || policy === null) return 0n;
  const unused = e.allocated - e.committed;
  if (book.mode === 'PREALLOCATED') return unused;
  const pooled = book.lots.filter((l) => l.resource === resource).reduce((s, l) => s + l.remaining, 0n);
  const headroom = agentCap(m, agent, resource) - e.allocated;
  return unused + (headroom < pooled ? (headroom > 0n ? headroom : 0n) : pooled);
}

/**
 * The claims that would take `amount` of `resource` for `agent`, drawn from
 * lots in creation order, each named `${prefix}/${n}`. `null` when the lots
 * cannot supply it. Pure planning: nothing is applied.
 */
export function planClaims(book: AllocationBook, agent: AgentId, resource: string, amount: bigint, prefix: string): readonly AllocationOp[] | null {
  const ops: AllocationOp[] = [];
  let need = amount;
  for (const l of book.lots) {
    if (need === 0n) break;
    if (l.resource !== resource || l.remaining === 0n) continue;
    const take = l.remaining < need ? l.remaining : need;
    ops.push({ kind: 'CLAIM', agent, id: `${prefix}/${ops.length}` as Identifier, lot: l.id, amount: take });
    need -= take;
  }
  return need === 0n ? ops : null;
}

// --- Canonical encoding, for receipts ---------------------------------------------------------

export function writeAllocationBook(w: ByteWriter, book: AllocationBook): void {
  w.u16(book.entries.length);
  for (const e of book.entries) {
    writeParty(w, e.agent);
    w.str(e.resource).u256(e.allocated).u256(e.committed);
  }
  w.u16(book.lots.length);
  for (const l of book.lots) {
    w.str(l.id).str(l.resource).u8(l.from === null ? 0 : 1);
    if (l.from !== null) writeParty(w, l.from);
    w.u256(l.amount).u256(l.remaining);
  }
}

export function writeAllocationOp(w: ByteWriter, op: AllocationOp): void {
  w.u8(op.kind === 'COMMIT' ? 1 : op.kind === 'RELEASE' ? 2 : 3);
  writeParty(w, op.agent);
  w.str(op.id);
  if (op.kind === 'CLAIM') {
    w.str(op.lot).u256(op.amount);
    return;
  }
  w.u16(op.amounts.length);
  for (const a of op.amounts) w.str(a.resource).u256(a.atoms);
}
