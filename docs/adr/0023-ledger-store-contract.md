# ADR 0023: Ledger store contract and the in-memory reference store

- **Status:** Proposed (Phase 7C, awaiting review)
- **Date:** 2026-09-27
- **Relates to:** [authority-ledger.md §9, §13](../core-v1/authority-ledger.md),
  [architecture.md §6](../core-v1/architecture.md#6-the-linearization-point),
  [ADR 0022](0022-principal-event-log-and-derived-state.md);
  open question 8 (the ledger's physical store)

## Context

The specification makes compare-and-swap on a principal-wide version the
linearization point of every authorization (CONC-1) and says a store without
it is not a conforming store. It leaves the physical store to 7C. Choosing a
database now would bind the engine to infrastructure before there is a
deployment, and would make the safety argument depend on that database's
isolation semantics rather than on a contract that can be tested.

## Decision

The engine depends on a three-method interface:

```ts
interface LedgerStore {
  read(principal): Promise<LedgerSnapshot>;                       // { principal, version, head, state }
  compareAndAppend(principal, expectedVersion, expectedHead, events): Promise<CommitResult>;
  history(principal): Promise<readonly CommittedBatch[]>;
}
```

with these required semantics:

1. **Consistent read.** A snapshot is one committed version: version, head and
   folded state from the same commit, immutable afterwards.
2. **Compare-and-append.** Commit iff the current version *and* head equal the
   expected ones *and* the pure reducer accepts the whole batch against the
   current state. Otherwise write nothing and report `CONFLICT` (with the
   current version and head) or `REFUSED` (with the reducer's refusal).
3. **Atomic batches.** A batch advances the version exactly once or not at
   all; a partial batch is impossible.
4. **Per-principal linearization, and nothing wider.** Every registration,
   revocation and charge of one principal shares its version; principals never
   contend.

The store applies the reducer at commit. That makes the ledger's own rules
hold against the state actually committed to, even for a caller that bypasses
the engine; CAS is what additionally makes anything *else* a decision read at
version `v` — in 7D, invariants over projected state — safe.

The engine reads, plans against that one snapshot, refuses without writing if
any rule or capacity fails, and commits with the snapshot's version and head.
On `CONFLICT` it re-reads and recomputes from the new snapshot; nothing
computed from the old one is reused. It retries at most the caller's
`maxAttempts` (1–32, no default), then returns `CONFLICT`. It never loops
unboundedly and holds no state, so any number of engines may share a store.

### The reference store

`InMemoryLedgerStore` pins these semantics for tests. A commit is one
synchronous critical section — version and head check, reducer, publish —
with no `await` inside, so in a single-threaded runtime nothing interleaves
with it: per-principal mutual exclusion without a lock, and no lock or shared
counter across principals. Test hooks can delay a read or a commit (to widen
the race window or run a competitor inside it) and inject a thrown failure at
each point of the critical section; the publish is a single step after the
last fault point.

It is not durable and does not model crashes or fsync. **Durable atomicity is
the production store's responsibility.** A durable store must provide the four
properties above with real durability — for example, one transaction per batch
with a conditional write on `(principal, version, head)` — and must be tested
against the same contract suite.

## Consequences

**Gained.** The safety argument (no oversubscription under concurrency, no
partial commit) is stated against a small contract and tested with
interleaving and failure injection; the engine is independent of any
database; independent principals scale out by construction.

**Accepted costs.**

- The ledger is a liveness single point per principal (open question 8): a
  principal's authorizations serialize on its version. Finer-grained
  versioning is a deferred optimization that must preserve CONC-1.
- The store is in the trusted computing base: a store that skips the version
  check or the reducer breaks every guarantee above.
- No fairness or priority between contending agents (open question 6): the
  first to commit wins, and a loser learns only that it lost.
