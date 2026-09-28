# Mandate Core v1 — Phase 7C implementation: authority graph and global authority ledger

> **Status: Phase 7C implemented locally, awaiting review.** This document
> describes code in `packages/ledger`. It does not change the frozen Phase 7A
> specification in this directory, or the Phase 7B representation in
> `packages/core`; both remain normative and unmodified. Where the
> specification had to be read one way rather than another, the reading is
> listed in [§14](#14-specification-readings-for-owner-review) for review. No
> domain module, projection, state admission, invariant evaluation,
> reservation lifecycle, reconciliation, venue, network access or durable store
> exists.

Phase 7C establishes one property under concurrency:

> Multiple autonomous agents operating through different authority roots and
> different economic domains cannot collectively consume more authority than
> the principal granted or globally permitted.

**Ledger linearizability governs Mandate authority state only. It still does
not make external market state atomic** (CORE-CONC-1). The compare-and-swap
orders grants, revocations, policy changes and charges against each other. A
venue's book, an oracle's price and a chain's next block are not inside it;
7D binds them by provenance and freshness, not by the ledger version.

## Contents

1. [What was built](#1-what-was-built)
2. [The authority graph](#2-the-authority-graph)
3. [Subset and meet semantics (AUTH-2)](#3-subset-and-meet-semantics-auth-2)
4. [Charge plans and charge-path derivation](#4-charge-plans-and-charge-path-derivation)
5. [Accounting](#5-accounting)
6. [The principal policy](#6-the-principal-policy)
7. [Events, versions and the hash chain](#7-events-versions-and-the-hash-chain)
8. [The store boundary and compare-and-swap](#8-the-store-boundary-and-compare-and-swap)
9. [Concurrency guarantees](#9-concurrency-guarantees)
10. [Revocation, expiry and time](#10-revocation-expiry-and-time)
11. [The module registry boundary](#11-the-module-registry-boundary)
12. [Tests](#12-tests)
13. [Benchmarks](#13-benchmarks)
14. [Specification readings for owner review](#14-specification-readings-for-owner-review)
15. [Invariants](#15-invariants)
16. [Open questions and what is next](#16-open-questions-and-what-is-next)

## 1. What was built

`packages/ledger` (`@mandate/ledger`), depending only on `@mandate/core` and
`@mandate/kernel` ([ADR 0021](../adr/0021-authority-ledger-package-boundary.md)).

```text
             @mandate/core            (frozen: objects, encodings, validators)
                   │
                   ▼
      authority graph  — graph.ts, subset.ts, meet.ts
                   │
                   ▼
      authority ledger — charging.ts, events.ts, reducer.ts, engine.ts
                   │
                   ▼
      LedgerStore      — store.ts (contract), memory-store.ts (reference)
```

| Module | Contents |
| --- | --- |
| `pmap.ts` | a persistent hash array mapped trie: immutable, structurally shared state |
| `errors.ts` | provisional refusal codes and structured detail |
| `limits.ts` | the ledger's bounds |
| `encoding.ts` | ledger tags, tagged writer/decoder, exact rescale and comparison |
| `revocation.ts` | the `Revocation` object under the tag 7B reserved for it |
| `charge-plan.ts` | `ChargePlan`: already-derived quantitative demand |
| `state.ts` | `LedgerState`: nodes, targets, reservations, actions; availability; canonical state encoding |
| `subset.ts` | child ⊆ parent at registration |
| `graph.ts` | lineage resolution, lineage validity, registration and revocation checks |
| `meet.ts` | effective authority: the meet over a lineage |
| `charging.ts` | charge-path derivation and the availability check |
| `events.ts` | the closed event union, batch encoding and decoding, the head |
| `reducer.ts` | the pure transition rules, batch application and replay |
| `registry.ts` | read-only module-registry conformance lookup |
| `store.ts`, `memory-store.ts` | the store contract and the in-memory reference store |
| `engine.ts` | decide against one snapshot, commit by CAS, bounded retry |

Domain modules sit *above* this, in 7D. The ledger knows typed quantities,
dimensions and scopes, and nothing about spot, perps, options, lending,
predictions, NFTs or governance.

## 2. The authority graph

Per principal: a forest of grants under one principal policy.

```text
PrincipalPolicy                  (grants nothing; last leg of every path)
   ├── Root A ── Child A1, Child A2
   └── Root B ── Child B1
```

The graph is the `nodes` of the ledger state, written only by
`REGISTER_GRANT` and `REVOKE` events, so which nodes exist and which are
revoked is read at exactly the version a reservation is decided at. A node
record keeps the grant (and so its `AuthorityId`, principal, issuer, holder,
parent, terms, `ModuleRef` restrictions and validity), its depth, the version
that registered it, and — once revoked — the revoking version and
`RevocationId`. Nothing is edited in place or deleted.

**Registration** (`checkGrantRegistration`, authority-model.md §6), all before
anything is written:

| Check | Refusal |
| --- | --- |
| the grant names this ledger's principal | `PRINCIPAL_MISMATCH` |
| a principal policy is registered (also for roots) | `PRINCIPAL_POLICY_MISSING` |
| not already registered | `AUTHORITY_ALREADY_REGISTERED` |
| not already expired at registration | `AUTHORITY_EXPIRED` |
| delegation: parent registered | `AUTHORITY_UNKNOWN` (node: the parent) |
| parent's lineage valid now | `AUTHORITY_REVOKED` / `_EXPIRED` / `_NOT_YET_VALID` (node: the failing ancestor) |
| issuer is the parent's holder | `AUTHORITY_ISSUER_MISMATCH` |
| every subset rule (§3) | `DELEGATION_REFUSED` with every violation |

**Lineage validity** at decision time (`checkLineageValid`, authority-model.md
§5) walks root first, so the node reported is the highest one that fails:
principal restated at every level, issuer = parent's holder, not revoked (self
or ancestor), `notBefore ≤ t < expiresAt`, and each delegation step permitted
by its parent's effective depth. Resolution is bounded by
`MAX_LINEAGE_LENGTH` (8).

**Cycles are impossible.** An `AuthorityId` is the digest of a grant that
names its parent's `AuthorityId`, and a parent must be registered strictly
before its child. A cyclic state that no history can produce is still bounded
and refused (`AUTHORITY_DEPTH_EXCEEDED`), which a test builds directly.

Signature verification (lineage rule 2) is not implemented, as in 7B: the
ledger checks issuer *identity*, and assumes the caller authenticated it.

## 3. Subset and meet semantics (AUTH-2)

Child ⊆ parent is enforced twice (authority-model.md §4). Each term kind has
its own rule; none is "the encodings are equal".

| Kind | Registration (`subset.ts`) | Action-time meet (`meet.ts`) |
| --- | --- | --- |
| `SET` per vocabulary | parent has the vocabulary, child members ⊆ parent's, by exact ref (a `ModuleRef` by all four fields) | intersection; a vocabulary any node lacks is absent (grants nothing) |
| `RIGHT` | parent has the right | conjunction |
| `DELEGATE` | parent's effective depth ≥ 1; child depth ≤ that − 1 | `min(parent − 1, child)`, floored at 0 |
| `BOUND` `MAX` / `MIN` | restated; comparable (same value type, kind, unit); child ≤ / ≥ parent, exact across scales | tightest across every node, restated or not |
| validity | child window ⊆ parent's | intersection |
| `TIME_WINDOW` per domain | where both constrain it, child ⊆ parent | intersection |
| `LEDGER_DIMENSION` | same id ⇒ same kind, unit, accounting, restoration, epoch, sign and scope, and limit ≤ parent's | **not merged**: every node's dimensions are legs of the path (§4) |
| `STATE_INVARIANT` | restated with *byte-identical* parameters | union; the policy's kept separately |
| `STATE_POLICY` | restated; sources ⊆; freshness mode equal and bound ≤; trust and recheck no weaker; finality equal; execution dependence equal or parent `NOT_REQUIRED` | per `(domain, kind)`: intersection of sources, every requirement held |

Absence means different things per kind, and the rules encode it: an omitted
set or right is narrower (closed world); an omitted bound, invariant or state
policy is refused because every grant must be self-describing; an omitted
dimension is still charged at the parent's leg; an omitted per-domain window
is still intersected at action time.

**Where Core cannot decide an ordering, it refuses.** An invariant's
parameters are opaque module bytes, and a finality ladder is ordered only by
its declarer. A child that restates either with different content is refused
as `DELEGATION_NARROWING_UNPROVEN` — neither weaker nor stricter is provable.
Exact restatement is accepted. So Example D's good D2 (`accountLeverage ≤ 3x`
under a parent's `≤ 4x`) is refused in 7C: proving that 3x is no weaker needs
the invariant definition's `noWeaker`, which arrives with domain modules (7D).
A different measure under the same identifier is
`DELEGATION_TERM_INCOMPARABLE`, never converted.

At action time, only the module set is *enforced* by the ledger (DOM-2,
`MODULE_NOT_PERMITTED`); the other coverage checks need the action's own
parameters and are 7D's, over the effective authority 7C computes. If the
meet cannot be formed — two nodes bound one parameter in different measures,
which registration refuses — the lineage has no effective authority
(`LINEAGE_TERMS_INCOMPARABLE`).

## 4. Charge plans and charge-path derivation

```text
ChargePlan {
  principal, authority (the leaf), actor,
  action, generation                    ReservationId = H(action, generation); generation explicit, ≥ 1
  module: ModuleRef, implementation     DOM-2
  contributions[] { quantity: EconomicQuantity, market?, account?, required }
}
```

A plan carries what the ledger needs and nothing a domain module owns — no
side, strike, route, health factor or outcome. It deliberately has **no field
for targets**: a caller cannot say "charge only Child A" or "skip the root"
(a `targets` field is `UNKNOWN_FIELD`). 7D's modules will produce plans; 7C
tests build them directly.

**The charging path** (authority-ledger.md §6) is derived by the ledger from
the principal, the leaf's lineage and each contribution's measure and scope:
every matching dimension of every node, leaf to root, then every matching
dimension of the principal policy. A contribution matches a dimension iff kind
and unit are equal and every scope attribute the dimension names — asset,
market, domain, account — is present and equal. The domain is the plan's
module's, not a caller field. An empty scope receives every contribution of its
kind and unit, which is how one root's capital is shared by spot and perp
agents and one policy dimension by every root.

Example: root 100,000, child 60,000; a 40,000 reservation through the child
charges root +40,000 *and* child +40,000. The child's limit is a ceiling, not a
carve-out.

Rules the derivation enforces, each a refusal and never a skipped leg:

- **LEDGER-5**: a required contribution must match a dimension *on the
  lineage*; a principal-global dimension alone does not satisfy it
  (`UNBOUNDED_CONTRIBUTION`; see §14 item 1). An optional contribution (an
  action count) is charged wherever a dimension matches, including only at the
  policy.
- **Exact scale**: each leg's amount is the contribution rescaled exactly to
  the dimension's decimals, or `INEXACT_RESCALE`. No rounding exists yet.
- **Sign**: a `NET` dimension refuses (`NET_DIMENSION_UNSUPPORTED`); 7C admits
  only positive magnitudes (`CONTRIBUTION_INVALID` for zero, negative, marked
  or unrealized-PnL demand).
- **Epoch**: an `EPOCH` leg records the window of the evaluation time; before
  the anchor, `EPOCH_NOT_STARTED`.

**Availability** is checked per target on the aggregate of every leg of the
plan at that target (two contributions reaching one target add up). It is
all-or-nothing: if any target fails, nothing is reserved, and
`LEDGER_LIMIT_EXCEEDED` names *every* failing `(node or policy, dimension)`
with requested, available and limit. `previewCharge` returns the same path
with each leg's headroom, read-only — the view an agent's local counters
cannot give it.

A recorded `RESERVE` event carries its lineage, policy and legs as
provenance. The reducer re-derives all three from the state and refuses any
difference (`CHARGE_PATH_MISMATCH`): an event with the root's leg, the policy's
leg or an amount removed is refused, so recorded legs are evidence, never
input.

## 5. Accounting

For every target — each dimension of each node, and each principal-global
dimension — the ledger keeps cumulative `reserved`, `consumed` and `restored`
at the dimension's decimals, in exact `bigint`. Available authority is derived,
never stored (authority-ledger.md §4, §7):

| Restoration | Available |
| --- | --- |
| `BUDGET NONE` | `G − C − R` |
| `BUDGET EPOCH` | `G − C_e − R`, `C_e` the consumption attributed to the current window; `R` every open reservation (with time never regressing, exactly the specification's `R_e`) |
| `CAPACITY AS_CHARGED`, `UNITS` | `G − C − R + Rs` |

`C` and `Rs` are never decremented. The invariants `reserved ≥ 0`,
`consumed ≥ 0`, `restored ≥ 0`, `restored ≤ consumed`,
`consumed + reserved ≤ granted + restored` hold for every target after every
committed batch; the model test checks them at every step. `A` goes below zero
only when a replaced policy tightens a kept dimension below occupancy, and
then nothing positive fits. The two capacity sources are recorded: a node
target's is `GRANT`, a policy target's `POLICY` — alike in arithmetic, and only
the first confers authority.

**Charge attribution.** A reservation records, for each contribution, its
legs: which targets it was charged at. `CONSUME`, `CLOSE` and `RESTORE` move
the same amount on every leg of the contribution. `RESTORE` names a reservation
(the original charge) and is bounded by what *that* reservation consumed and
has not had restored; it credits only that reservation's capacity legs.
Example (tested): root 100, siblings A and B at 60; A consumes 40 and unwinds;
the restoration lands on root, A and the policy, never on B, and B cannot
restore through its own reservation what it never consumed — whoever closed
the position.

**Restoration modes** are enforced structurally only: `BUDGET` legs never
restore (`RESTORE_NOT_PERMITTED` when nothing else could), and a demand with
both kinds restores only its capacity legs. *How much* is legitimately
restored — units closed, cost basis, FIFO lots, proceeds never — is decided by
7D and later reconciliation, which 7C does not implement.

**The 7C/7D boundary.** `CONSUME`, `CLOSE` and `RESTORE` exist as accounting
effects so the arithmetic is complete and tested. Each names the
`ObservationId` it would be the effect of. 7C does **not** validate
observations or decide when an effect is legal (partial fill, cancel, expiry,
finality). `AuthorityLedger.settle` therefore folds whatever effects its caller
supplies within the arithmetic bounds, and **must not be exposed to agents**
until 7D puts the observation rules in front of it: an unvalidated `CLOSE`
releases authority an order still resting could consume, and an unvalidated
`RESTORE` frees capacity for a position still open. `available ≤ granted`
holds regardless.

## 6. The principal policy

- **Required before the first root**, and may be explicitly empty. An empty
  policy infers no aggregate limit; each root is still bounded by its own grant
  (tested: two 5,000 roots under an empty policy each reserve 5,000, and 5,001
  is refused at the root).
- **Grants nothing.** It is not a node: nothing can be reserved "under" it, and
  its dimensions never satisfy a required contribution alone (§4).
- **Last leg of every path**, whichever root the action uses (AUTH-GLOBAL-1).
  Its `STATE_INVARIANT` and `STATE_POLICY` terms are stored and surfaced in
  the effective authority as data; nothing evaluates them in 7C, and no
  invariant is treated as satisfied because it exists.
- **Replacement** needs a strictly higher sequence
  (`POLICY_SEQUENCE_NOT_INCREASING`). A *kept* dimension — same identity:
  identifier, kind, unit, decimals, accounting, restoration, epoch, sign and
  scope — keeps its target and entire history; only its ceiling follows the new
  policy, so loosening adds headroom and tightening below occupancy blocks
  increases without releasing anything. A dimension *new* to the policy is
  accepted only if no reservation was ever committed, because the empty
  baseline is the only one 7C can prove; otherwise
  `POLICY_UPDATE_REQUIRES_BASELINE`. No zero baseline is fabricated. A removed
  dimension stops being charged; re-adding it later is an introduction.
  Initializing a new dimension from open lots (AUTH-GLOBAL-2) is not
  implemented.

## 7. Events, versions and the hash chain

[ADR 0022](../adr/0022-principal-event-log-and-derived-state.md). A closed
union — `REGISTER_POLICY`, `REGISTER_GRANT`, `REVOKE`, `RESERVE`, `CONSUME`,
`CLOSE`, `RESTORE` — each with its evaluation time and exactly its own typed
fields; no generic payload, no adjustment.

```text
batch  = str("mandate-core/v1/ledger-batch") ‖ u16(1) ‖ principal ‖ u64(version) ‖ bytes32(previousHead) ‖ u16(n) ‖ event₁ … eventₙ
head   = keccak-256(batch)                       head₀ = keccak-256(str("mandate-core/v1/ledger-genesis") ‖ u16(1) ‖ principal)
```

One principal, one linearization domain: every registration, revocation,
policy change and charge advances the same version, one per batch. A batch
of any number of events is applied entirely or not at all. The state is a
pure fold, `Sₙ = reduce(Sₙ₋₁, batchₙ)`, applied by the store at commit and by
replay, and stored immutably with structural sharing so a decision reads the
current state instead of replaying the log.

**Provenance.** A `RESERVE` names the principal, the plan (leaf, actor,
action, generation, `ModuleRef`, implementation, typed contributions), the
lineage, the policy in force and every leg with its target, amount and epoch.
An accounting event names the reservation, its generation, the observation and
the amounts; its lineage and module are the reservation's. Every event is in a
batch that names the version and the previous head. No domain payload enters
an event; everything is a reference or a typed quantity.

Tested: the same history gives the same head and byte-identical state;
reordering events, changing any payload, removing or inserting an event, or
moving a batch boundary changes the head; every event kind round-trips through
its canonical encoding; replay from stored bytes refuses a batch that does not
extend the chain, belongs to another principal or skips a version, and a
one-bit change at any byte of a stored batch never replays as the original
history.

## 8. The store boundary and compare-and-swap

[ADR 0023](../adr/0023-ledger-store-contract.md).

```ts
interface LedgerStore {
  read(principal): Promise<LedgerSnapshot>;          // { principal, version, head, state }, immutable
  compareAndAppend(principal, expectedVersion, expectedHead, events): Promise<CommitResult>;
  history(principal): Promise<readonly CommittedBatch[]>;
}
```

A commit happens iff the current version **and** head equal the expected ones
**and** the reducer accepts the whole batch against the current state;
otherwise nothing is written and the result says `CONFLICT` (with the current
version and head) or `REFUSED` (with the reducer's refusal). The engine:

```text
1. read snapshot V          4. compareAndAppend(V, head(V), batch)
2. plan against V only      5. on CONFLICT: re-read and recompute everything from the new
3. refuse, writing nothing,    snapshot — nothing computed from V is reused — at most
   if any rule fails           maxAttempts times (1..32, no default), then return CONFLICT
```

The in-memory reference store's commit is one synchronous critical section
(check, reducer, publish) with no `await` inside, which in a single-threaded
runtime is per-principal mutual exclusion without a lock; there is no lock or
counter shared across principals. It is not durable and does not model
crashes or fsync. **Durable atomicity is the production store's
responsibility**; it must meet the same contract, for example with one
transaction per batch and a conditional write on `(principal, version, head)`.
Which database is open question 8.

## 9. Concurrency guarantees

Established by the concurrency, model and failure suites (§12), for Mandate's
authority state:

- Two siblings cannot together reserve more than their parent: parent 100,
  children 80/80, each asking 70 — on every one of 150 randomized
  interleavings exactly one commits and the parent's leg refuses the other.
  Both linearizations occur, and CAS conflicts occur.
- Two roots cannot together exceed a principal-global dimension: global 100,
  roots 80/80, each asking 60 — exactly one commits; the policy is the only
  failing leg.
- Domains do not get independent budgets: three spot and three perp agents,
  under different modules and roots, share one global 100 and never get more
  than three 30s.
- A multi-dimension request that loses its CAS to a change in one dimension
  recomputes both on the retry: it is refused if the changed one no longer
  fits (charging neither), and otherwise commits at the new version.
- A reservation is never committed at or after the version that revoked its
  lineage.
- Independent principals never conflict with each other.
- The same races against a read-then-write store (each batch valid against
  the snapshot its writer read, published without a version check) **do**
  oversubscribe — 140 authorized under a parent of 100, and more than a global
  limit across two roots. That is CONC-1's required mutation: without
  compare-and-swap these tests fail.

Outside the ledger nothing is linearized (CORE-CONC-1). No fairness or
priority between agents exists (open question 6): the first committer wins.

## 10. Revocation, expiry and time

- **Revocation** is an event, irreversible and subtree-wide for new use: from
  the version that records it, no node below it passes lineage validity, and
  no child may be registered under it. Nodes are marked, not removed; a
  revoked grant cannot be re-registered. The issuer must be the issuer of the
  target or of any ancestor — the principal may revoke anything, a holder its
  descendants but never its own node or an ancestor. It is not scheduled:
  `effectiveAt` after the registration time is refused.
- **Revocation does not release.** Outstanding reservations under a revoked
  node stay `ACTIVE`, keep their legs and still reconcile. Revocation stops
  future authorization; it is not evidence that an issued attempt cannot
  execute.
- **The revocation race** has two safe outcomes: the reservation commits first
  and stays held while new ones are refused, or the revocation commits first
  and the racing reservation's retry is refused `AUTHORITY_REVOKED`.
- **Expiry** refuses new use at `t ≥ expiresAt` of any lineage node and
  releases nothing already reserved.
- **No hidden time effects.** Reading state never changes it. Every event
  carries its evaluation time, and time never regresses on a ledger
  (`EVALUATION_TIME_REGRESSED`), so a skewed evaluator cannot backdate past a
  committed expiry. The only time-dependent figure is an `EPOCH` budget's
  window, which the principal signed in advance and which releases nothing
  still reserved.

**Generations.** Every reservation names its generation explicitly; nothing
defaults one. The first is 1; the next is allowed only once the previous is
closed (`PREVIOUS_GENERATION_OPEN`, `GENERATION_OUT_OF_SEQUENCE`,
`RESERVATION_EXISTS`). An effect names both the `ReservationId` and the
generation, and a mismatch is `RESERVATION_ID_MISMATCH`: an effect for
generation *n* never mutates generation *n + 1*. Whether a retry is allowed at
all (only after a zero-consumption final close, REPLAY-1) is the intent state
machine's, 7D.

## 11. The module registry boundary

`ModuleRegistry.lookup(moduleId, moduleVersion)` and
`checkModuleConformance(registry, module, implementation)` answer: is the name
registered (`MODULE_UNREGISTERED`); is this exact ref the one digest for it
(`MODULE_DIGEST_MISMATCH` — a patched v1 under the same version is not v1); is
the implementation registered as conforming (`MODULE_IMPLEMENTATION_UNREGISTERED`);
is it retiring (`MODULE_RETIRING`, no new decisions). The engine checks this
before planning any reservation. Conformance is not permission: a registered
module outside the grant's effective module set is still `MODULE_NOT_PERMITTED`.

`ReferenceModuleRegistry` is seeded once, validated (one digest per name) and
frozen; it has no method to add or mark anything. Governance — who registers a
module or an implementation, how builds are verified — stays open question 16.
The reducer does not consult the registry, so retiring a module later does
not make a committed history unreplayable.

## 12. Tests

`packages/ledger/test`, 138 tests, all offline, deterministic seeds:

| File | Tests | Covers |
| --- | ---: | --- |
| `primitives.test.ts` | 6 | persistent map against a mutable one over random operations, old versions unchanged, full hash collisions; revocation encoding and identity; exact rescale |
| `structure.test.ts` | 8 | dependencies, imports, kernel symbols, no I/O, clock, randomness, network, `any`/`unknown`/`Record`, floats, venue names or domain-module functions; nothing depends on the ledger |
| `subset.test.ts` | 10 | each subset rule; the registration half as a property (400 parents, every narrowing accepted, every single widening refused with its code, 11 mutation families); the meet half as a property with widening nodes injected past registration (150 lineages), shown non-vacuous; the unformable meet |
| `graph.test.ts` | 25 | every registration refusal, the Example D bad delegation with all nine violations, module widening by version and by digest, depth bound, hostile cyclic and forged states, revocation scope, irreversibility, issuer eligibility, independent principals; registration half end to end |
| `ledger.test.ts` | 32 | path charging, the policy leg, domain-independent dimensions, matching, LEDGER-5, the empty policy, recorded-path tampering, atomic multi-dimension charging, arithmetic boundaries (exact fill, one over, zero, 2²⁵⁶−1, overflow, rescale, NET), consume/release/restore bounds, attribution, generations, expiry, epochs, time |
| `policy.test.ts` | 10 | registration, grants nothing, cross-root limit, sequence, baseline rule, kept history across loosen/tighten, removal |
| `hashchain.test.ts` | 10 | head determinism and sensitivity, genesis per principal, batch layout, replay from bytes, tamper and chain breaks, atomic batch refusal |
| `registry.test.ts` | 4 | the conformance questions, no mutation, checked before any reservation, conformance ≠ permission |
| `store.test.ts` | 10 | the store contract, immutable snapshots, independent principals, bounded retry, recomputation after conflict, atomic settlement and registration |
| `concurrency.test.ts` | 12 | §9, including the read-then-write mutation |
| `model.test.ts` | 1 | 40 seeds × 120 operations against an independent reference model: every outcome and every balance agree, plus invariants at every step. During development it was mutated by hand (dropping the root's leg; bounding restoration by consumed alone) and failed both times; that check is not automated |
| `replay.test.ts` | 1 | 30 randomized histories: incremental state = replay from events = replay from bytes, at every tenth version; cached balances = recomputation from reservation records |
| `failure.test.ts` | 7 | a thrown failure at each of four points of the critical section for a reservation, registrations and a settlement leaves the whole old state; racing agents with random faults; a lost outcome recovered as `RESERVATION_EXISTS` |
| `demo.test.ts` | 2 | the thesis fixtures below |

**The thesis fixtures** (`demo.test.ts`), with principal-global
`GLOBAL_CAPITAL = 10,000`:

- *One tree.* Trading 8,000 → SpotAgent 6,000, PerpAgent 5,000. SpotAgent
  reserves 6,000 while PerpAgent's 5,000 is in flight. PerpAgent's own leg has
  5,000; the root has 2,000 left and the principal 4,000. PerpAgent loses the
  CAS, recomputes, and is refused naming both `Trading/capital (5000 vs 2000)`
  and `PrincipalPolicy/GLOBAL_CAPITAL (5000 vs 4000)`. 2,000 then passes.
- *Two roots.* Spot root 8,000 and Perp root 5,000; the policy is the only
  shared constraint. After Spot's 6,000, Perp's 5,000 passes its root and is
  refused by the policy alone; 4,000 passes and fills the principal to 10,000.
  Under an empty policy the same two roots are independent.

## 13. Benchmarks

`npm run ledger:benchmark`: pure plan-plus-commit functions over immutable
state, median of 7 rounds, Node v22.21.0 on the development machine.
Machine-dependent; reported, not asserted.

| Case | Median (µs) | Notes |
| --- | ---: | --- |
| resolve 1-deep lineage (+ validity + meet) | 0.4 | 1 node |
| resolve 5-deep lineage (+ validity + meet) | 7.4 | 5 nodes |
| single-dimension reservation | 43.6 | 1 leg |
| four-dimension reservation | 74.9 | 3 contributions, 4 legs |
| two-root global reservation | 67.6 | root leg + policy leg |
| 5-deep reservation with global | 106.8 | 6 legs |
| reservation after 1,002 events | 80.7 | 249 reservations in state |
| reservation after 10,002 events | 78.4 | 2,499 reservations in state |
| replay 1,002 events (in memory) | 28,413 | log 388 KiB encoded; state 245 KiB canonical encoding |
| replay 1,002 events (from stored bytes) | 40,318 | 998 batches, decode + verify chain |
| replay 10,002 events (in memory) | 287,601 | log 3,864 KiB; state 2,418 KiB |
| replay 10,002 events (from stored bytes) | 395,919 | 9,998 batches |

A reservation costs the same after 10,000 events as after 1,000: the
authorization path reads derived state and never replays. Replay is linear
(~28 µs per event). Reservation cost is dominated by keccak-256 over the batch
and over policy-dimension identities, both of which could be cached; no
optimization was attempted.

**Bounds** (`limits.ts`): contributions per plan 64, events per batch 256,
embedded object 4 MiB, retry attempts 32; legs per contribution are derived
from Core's bounds (8 × 128 + 128). The specification fixes none of the chosen
values; they are generous 7C schema constants, and whether any should change is
recorded as an open question.

## 14. Specification readings for owner review

Each is a place where the frozen specification or the brief could be read more
than one way. Every choice is the fail-closed one, and none changes a frozen
decision. They need an owner ruling.

| # | Where | Issue | Reading taken |
| --- | --- | --- | --- |
| 1 | authority-ledger.md §3, §8 vs security-invariants.md LEDGER-5, decision 24 | LEDGER-5 is worded "no dimension anywhere on the charging path" in the ledger document (the path includes the policy) and "on the lineage" in the invariant; decision 24 says the policy grants nothing | A required contribution must match a **lineage** dimension. Otherwise a policy's global capital ceiling would act as a capital grant to a root that grants none — the policy becoming a super-root |
| 2 | authority-model.md §4 ("no weaker") vs Core's opaque parameters | "Parameters no weaker" needs the invariant definition's `noWeaker`, which is 7D's | Only byte-identical restatement is accepted (`DELEGATION_NARROWING_UNPROVEN`); Example D's good D2 is refused until 7D. The same for finality levels, whose order is the ladder declarer's |
| 3 | brief §9 vs authority-model.md §8.2 | Policy replacement "keeps the consumption history of every dimension it keeps"; a new dimension must start from open lots | Kept dimensions keep history (implemented). New dimensions only while nothing was ever reserved; otherwise `POLICY_UPDATE_REQUIRES_BASELINE`. AUTH-GLOBAL-2 not claimed |
| 4 | authority-ledger.md §5 vs brief §25 | The specification has no free-standing `CONSUME`/`RELEASE`/`RESTORE` commands; the brief asks 7C to fold them | They are events that name an `ObservationId`, and `settle` is documented as TCB-only until 7D validates observations (§5). RECON-3 not claimed |
| 5 | brief §17 vs authority-ledger.md §3 | The brief suggests a plan naming a "dimension key"; the specification matches contributions to dimensions by measure and scope | Followed the specification: a plan names only typed contributions and scope attributes; no dimension or target at all |
| 6 | authority-ledger.md §4.2 | `EPOCH` windows are defined relative to an anchor; nothing says what happens before it | A charge before the anchor refuses (`EPOCH_NOT_STARTED`) |
| 7 | not specified | Whether evaluation time may go backwards between commits | It may not (`EVALUATION_TIME_REGRESSED`): monotone log time, exact `R_e` for epochs, no backdating past an expiry |
| 8 | authority-model.md §4 "Restatement" | Per-domain `TIME_WINDOW` terms are not in the restatement list | Followed the specification: omission is allowed at registration and the window is intersected at action time |
| 9 | authority-model.md §7 | Revoking a node already revoked through an ancestor | Refused `AUTHORITY_REVOKED`, naming the revoked ancestor; it would change nothing |
| 10 | brief §24 vs reservations-reconciliation.md §3 | Generations: how much of the intent state machine is 7C's | Sequence and non-overlap only (next generation after the previous closed). The zero-consumption retry rule and `SPENT` are 7D's |

Also recorded, not a reading: the frozen `docs/core-v1/README.md` gains only a
one-line implementation pointer to this document, as it did for 7B; its
specification text is unchanged.

## 15. Invariants

Established means: the mechanism exists and the named tests exercise it,
including its failure modes. "Partly" states exactly which part.

| Invariant | Status after 7C | Evidence |
| --- | --- | --- |
| **AUTH-2** | **Established**, both halves separately: registration refuses every widening; the meet bounds any node by every ancestor even if registration were bypassed | `subset.test.ts`, `graph.test.ts` |
| **AUTH-4** | **Established**: irreversible, subtree-wide, blocks every reservation at or after its version | `graph.test.ts`, `concurrency.test.ts` |
| **AUTH-5** | **Established** for the ledger: per-principal logs and versions; no tree charges another's dimensions; trees share only the policy | `store.test.ts`, `concurrency.test.ts`, `ledger.test.ts` |
| **AUTH-GLOBAL-1** | **Established** for ledger dimensions: the policy is the last leg of every path; no policy ⇒ nothing is authorized; an empty policy infers nothing. Principal-global *invariants* are stored, not evaluated (7D) | `ledger.test.ts`, `policy.test.ts`, `concurrency.test.ts`, `demo.test.ts` |
| **AUTH-1** | **Partly**: lineage validity at every decision and reservations only from committed decisions; signature verification and 7D's coverage checks are not implemented | `graph.test.ts`, `model.test.ts` |
| **AUTH-GLOBAL-2** | **Not established**: kept dimensions keep history; introducing one refuses unless nothing was ever reserved | `policy.test.ts` |
| **LEDGER-1** | **Established** for what Core authorizes: `C + R ≤ G + Rs` on every target after every step. Overrun and adverse drift (the only permitted exceptions) are not implemented | `model.test.ts`, `concurrency.test.ts` |
| **LEDGER-4** | **Established**: legs reserve, consume, release and restore together; batches are atomic under injected failures | `ledger.test.ts`, `failure.test.ts` |
| **LEDGER-5** | **Established** (reading §14 item 1) | `ledger.test.ts`, `model.test.ts` |
| **LEDGER-6** | **Established**: incremental state = replay from events = replay from bytes; cached balances = reservation records | `replay.test.ts`, `hashchain.test.ts` |
| **LEDGER-GRANT-1** | **Established** for the ledger: no event writes `G`; restoration is bounded by consumption, so `A ≤ G` | `ledger.test.ts`, `model.test.ts` |
| **LEDGER-RESTORE-1** | **Partly**: `0 ≤ Rs ≤ C` per target and per charge, credited only to the charged legs, `BUDGET` never restores. "Only by final evidence" and the lot rules are 7D | `ledger.test.ts`, `model.test.ts` |
| **LEDGER-2**, **LEDGER-3** | **Partly**: consumption never exceeds a reservation, and a closed reservation accepts nothing. Fill idempotency, overrun and conflict need observations (7D) | `ledger.test.ts` |
| **CONC-1** | **Established**, including the mutation: a read-then-write store oversubscribes | `concurrency.test.ts`, `store.test.ts` |
| **CORE-CONC-1** | **Not regressed**: stated here and in ADR 0023; nothing argues external-state properties from CAS | — |
| **RECON-2** | **Partly**: an effect naming another generation mutates nothing. The observation pipeline that applies it is 7D | `ledger.test.ts`, `model.test.ts` |
| **TIME-1** | **Partly**: nothing in the ledger releases, restores or extends on time; reads do not mutate; expiry releases nothing. Quarantine is 7D | `ledger.test.ts` |
| **REPLAY-1** foundations | generations explicit, sequential, never repeated; the retry rule is 7D | `ledger.test.ts` |
| **DOM-2** | **Partly**: the exact `ModuleRef` and implementation are checked against the registry and the effective module set, and fixed on the reservation. Registry governance and reconciliation under the reservation's module are later | `registry.test.ts`, `graph.test.ts` |
| **SCOPE-1**, **UNIT-1**, **UNIT-5** foundations | contributions carry Core-validated quantities; matching uses exact kind, unit and scope; no unsigned balance goes negative; no floating point | `ledger.test.ts` |
| **UNIT-4** | Not yet: no rounding exists; rescale is exact-or-refuse | — |
| **RECON-3**, **DRIFT-3** | **Not established**: the accounting effects are folded without observation validation (§5, §14 item 4) | — |
| **PHASE6-1** | Holds: no Phase 6 file changed; `generated:check` reproduces every artifact | — |
| STATE-\*, EXEC-\*, CRED-1, RECON-1/4/5, DRIFT-1/2, PROJ-1, SETTLE-MONO, FAIL-1, RECEIPT-\*, DOM-1, CORE-1, AUTH-3 | **Not established.** Their mechanisms are later phases; nothing here claims continuous financial safety or reconciliation finality | — |

## 16. Open questions and what is next

Discovered or sharpened in 7C:

1. **LEDGER-5 wording** (§14 item 1): confirm "on the lineage".
2. **Invariant `noWeaker` and finality ordering** (§14 item 2): until 7D
   delivers them, a tightened invariant or a stricter finality cannot be
   delegated. Should 7D's module interface be the only source of both?
3. **AUTH-GLOBAL-2 initialization** (§14 item 3): needs position lots, which
   need 7D's settlement semantics.
4. **Exposure of `settle`** (§5): an engine API for accounting effects exists
   before the rules that make them legal. 7D should either wrap it or replace
   it with an observation-applying entry point.
5. **Ledger bounds** (§13): contributions per plan 64 and events per batch
   256 are 7C choices, not specification values.
6. **Durable store** (open question 8, ADR 0023): which store, and the
   contract suite it must pass.
7. **Fairness between agents** (open question 6): first committer wins; a
   long-resting reservation can hold root capacity.
8. **Registry governance** (open question 16).
9. **NET dimensions and rounding** (UNIT-4): signed position legs and a
   rounding direction are both unimplemented and both refuse.
10. **Hash costs on the hot path** (§13): if they matter, cache policy
    dimension identities per policy version.

**Next (on approval): Phase 7D, Invariant + Reservation Engine** — the
`DomainModule` interface producing `ChargePlan`s, projection, invariant
evaluation, the reservation state machine and observation rules in front of the
accounting effects. Not started.
