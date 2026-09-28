# Mandate Core v1 — Phase 7D implementation: invariant and reservation engine

> **Status: Phase 7D implemented locally, awaiting review.** This document
> describes code in `packages/control` and one extension point added to
> `packages/ledger`. It does not change the frozen Phase 7A specification in
> this directory or the Phase 7B representation in `packages/core`; both
> remain normative and unmodified. Where the specification or the brief had to
> be read one way rather than another, the reading is listed in
> [§18](#18-specification-readings-for-owner-review) for review. No venue,
> network, RPC, signature, enforcement adapter, observation pipeline,
> production domain module or durable store exists.

Phase 7D turns

```text
principal authority + agent action + trusted current state + domain semantics
```

into either a refusal or an atomically reserved, state-bound, exactly
identified authorization. It is the first phase that evaluates economic
meaning, and it stays market-independent: the only domain module in the
repository is a deliberately fictional, test-only exposure market.

**Mandate serializes authority state; it does not make external market state
atomic** (CORE-CONC-1). The ledger's compare-and-swap orders reservations,
and 7D extends that order to *projected* economic state — every decision
sees every pending reservation at the version it commits at. A venue's book,
an oracle's price and a chain's next block are still outside it: they enter
only through admitted, bound, freshness-limited snapshots, and are rechecked
before anything would be issued.

## Contents

1. [What was built](#1-what-was-built)
2. [The DomainModule contract](#2-the-domainmodule-contract)
3. [Exact module resolution and conformance](#3-exact-module-resolution-and-conformance)
4. [State requirements, admission and bindings](#4-state-requirements-admission-and-bindings)
5. [Reservation facts and projection](#5-reservation-facts-and-projection)
6. [Economic facts and invariant facts](#6-economic-facts-and-invariant-facts)
7. [Invariant evaluation](#7-invariant-evaluation)
8. [Semantic noWeaker](#8-semantic-noweaker)
9. [Coverage over the meet](#9-coverage-over-the-meet)
10. [Ledger demands and dimension matching](#10-ledger-demands-and-dimension-matching)
11. [The authorization pipeline and CAS re-projection](#11-the-authorization-pipeline-and-cas-re-projection)
12. [The authorization: identity, lifetime and Core's ExecutionAuthorization](#12-the-authorization-identity-lifetime-and-cores-executionauthorization)
13. [Revalidation and NEVER_ISSUED](#13-revalidation-and-never_issued)
14. [Failure taxonomy](#14-failure-taxonomy)
15. [Trust boundaries and resource bounds](#15-trust-boundaries-and-resource-bounds)
16. [Tests and the authorization corpus](#16-tests-and-the-authorization-corpus)
17. [Benchmarks](#17-benchmarks)
18. [Specification readings for owner review](#18-specification-readings-for-owner-review)
19. [Invariants](#19-invariants)
20. [Completion answers](#20-completion-answers)
21. [Open questions and what is next](#21-open-questions-and-what-is-next)

## 1. What was built

`packages/control` (`@mandate/control`), depending only on `@mandate/ledger`,
`@mandate/core` and `@mandate/kernel`
([ADR 0025](../adr/0025-control-package-and-authorization-boundary.md)).

```text
      DomainModule implementations      (only a test-only synthetic module exists)
                   │
                   ▼
      @mandate/control   module.ts, catalog.ts, conformance.ts, outputs.ts
                         context.ts, admission.ts, facts.ts
                         projection.ts, aggregate.ts, invariants.ts, narrowing.ts
                         coverage.ts, pipeline.ts, authorization.ts, revalidation.ts, engine.ts
                   │
                   ▼
      @mandate/ledger    (+ rules.ts: a configured InvariantOrdering)
                   │
                   ▼
      @mandate/core      (unchanged)
```

| Module | Contents |
| --- | --- |
| `module.ts` | the `DomainModule` interface and every type a module exchanges with the engine |
| `errors.ts` | the provisional two-level failure taxonomy |
| `limits.ts` | bounds on attacker-controlled cardinalities |
| `encoding.ts` | control tags, the state-payload digest, canonical-set writing |
| `outputs.ts` | re-validation of everything a module returns; the module call guard |
| `freeze.ts` | deep-frozen copies handed to modules |
| `conformance.ts` | what makes an implementation conforming |
| `catalog.ts` | exact `ModuleRef` resolution, invariant ownership, the ledger ordering |
| `context.ts` | the explicit evaluation context and its digest |
| `admission.ts` | requirement tightening, admission, bindings, re-admission |
| `facts.ts` | unresolved reservations as `ReservationFact`s |
| `projection.ts` | the projection record and its digest |
| `aggregate.ts` | Core's `core.aggregate-max` invariant and comparator |
| `invariants.ts` | invariant results, their digest and the verdict |
| `narrowing.ts` | narrowing proofs for delegation |
| `coverage.ts` | coverage of the action over the 7C meet |
| `pipeline.ts` | the pure decision |
| `authorization.ts` | the authorization record over Core's `ExecutionAuthorization` |
| `revalidation.ts` | issue-time re-admission and revalidation |
| `engine.ts` | the CAS loop, `NEVER_ISSUED` closure and delegation registration |

**Ledger extension** ([ADR 0025](../adr/0025-control-package-and-authorization-boundary.md)):
`packages/ledger/src/rules.ts` adds `ReducerRules { invariantOrdering }`,
threaded as an optional parameter through the subset check, registration, the
reducer, replay, the in-memory store and the ledger engine, and the
specification's `DELEGATION_WEAKENS_INVARIANT` violation code. With the
default `CORE_RULES` the ledger behaves exactly as in 7C; every 7C test passes
unchanged, and `ordering.test.ts` covers the extension.

## 2. The DomainModule contract

[ADR 0024](../adr/0024-version-bound-domain-module-interface.md).

```text
DomainModule {
  ref: ModuleRef                        exactly one, digest included
  implementation: ImplementationDigest
  invariants: (invariantId, version)[]  definitions it owns; never core.*
  finalityLadders                       levels it declares, lowest first
  demandMeasures: (kind, unit)[]        the only measures it may demand

  validateAction(action)                   → ActionAnalysis
  stateRequirements(scope)                 → StateNeed[]
  validateStatePayload(state)              → ok
  project(scope, admitted state)           → ModuleProjection
  evaluateInvariant(invariant, projection) → InvariantEvaluation
  deriveLedgerDemands(action, projection)  → LedgerDemand[]
  noWeaker(parent, child)                  → NO_WEAKER | WEAKER | UNPROVABLE
}
ModuleScope { principal, action | null (+ PROPOSE | REVALIDATE), invariants it owns, aggregate queries, reservations under its exact ref }
```

A module is a pure function over explicit inputs. It is handed the action
(envelope, `ActionId`, and the payload whose digest the envelope commits to),
the snapshots admitted for its own requirements, and the unresolved
reservations under its exact `ModuleRef`. It is not given a clock, network,
keys, randomness, database, the ledger, another module's state, or any state
it did not declare. Inputs are deep-frozen copies: a module that mutates what
it was given throws and is refused.

A module **cannot authorize**: it returns facts, comparisons and demands, and
the engine decides after every Core requirement. It **cannot choose charge
targets**: a demand is a typed quantity with an optional market and account,
and the ledger derives every target from the lineage and the policy.

Everything a module returns is untrusted (`outputs.ts`): each quantity,
resource, requirement, measure and ratio is taken apart into its input form
and rebuilt through Core's validators, so a `NaN`, a negative unsigned
amount, an unknown resource kind or a mark relabelled as a limit becomes
`MODULE_NOT_CONFORMING` naming the module. A throw is `MODULE_FAULT`. Its
reasons are identifiers in its own namespace, reported with its `ModuleRef`.

## 3. Exact module resolution and conformance

**Resolution** (`catalog.ts`). An action's `ModuleRef` resolves to exactly
one loaded implementation, or the decision refuses before anything else is
evaluated:

| Case | Refusal |
| --- | --- |
| name not registered | `MODULE_NOT_FOUND / MODULE_UNREGISTERED` |
| registered under another digest (a patched v1 is not v1) | `MODULE_NOT_FOUND / MODULE_DIGEST_MISMATCH` |
| `RETIRING` — no new decisions | `MODULE_NOT_FOUND / MODULE_RETIRING` |
| registered but no conforming implementation loaded | `MODULE_NOT_FOUND / NO_CONFORMING_IMPLEMENTATION` |
| loaded implementation no longer registered | `MODULE_NOT_CONFORMING / MODULE_IMPLEMENTATION_UNREGISTERED` |

There is no fallback to a latest version and no upgrade. A retiring module
still projects held and pending state and revalidates its own reservations,
because the reservation's module is fixed for its lifecycle (DOM-2).

**Conformance** (`conformance.ts`). An implementation enters a catalog only
if (1) its declared `ModuleRef` is exactly the registered one and its
implementation digest is registered as conforming; (2) every interface
function is present, its invariant ids are unique and outside `core.*`, its
ladders and demand measures are well formed, and every demand measure is
ledger-trackable; (3) on every vector of its corpus every output passes the
engine's own re-validation; (4) each vector run twice on frozen copies is
byte-identical and leaves its inputs unchanged; (5) outcomes equal the
corpus's expectations. No prohibited dependency is checked structurally, as
for every package. One implementation per `ModuleRef` may be loaded, and each
invariant definition has exactly one owner.

**Digest discipline.** The synthetic module's digest is keccak-256 over a
manifest of every semantic constant and its corpus identity, so a semantic
change changes the digest even when nobody changes the version. Tested: an
honest second implementation under the same `(domain, id, version)` is
refused as another digest; one that *claims* the registered ref and
implementation digest while counting pending reservations at half fails the
corpus. A corpus proves only what it exercises (action-state-model.md §8.1).

## 4. State requirements, admission and bindings

**Requirements.** A module declares a `StateNeed` per `(stateKind, subject)`
— accepted sources and its default `StateRequirement` (freshness, minimum
trust, minimum finality, at-issue and at-execution rules) — typed Core
values, no string maps. Every lineage node's and the principal policy's state
policy for the same `(domain, stateKind)` then tightens it: smaller age or
block bound, stricter trust, higher finality on the module's own ladder,
`RECHECK` over `WITHIN_POLICY`, an execution dependence over `NOT_REQUIRED`,
and the intersection of sources. Requirements that cannot be combined — a
different freshness mode or pinned version, another ladder, two different
execution dependencies — are `STATE_POLICY_CONFLICT`.

**Context** (`context.ts`). No hidden values: the decision's time, the
configured sources (each with its configured trust class and the
`(domain, stateKind)` pairs it may report), block heads and reconciliation
watermarks are an explicit `EvaluationContext`, validated (duplicates are
ambiguous and refused) and digested canonically. The same context reproduces
the same decision.

**Admission** (`admission.ts`), per requirement, in canonical order:

| Rule | Refusal |
| --- | --- |
| no snapshot under this `ModuleRef` for this kind and subject | `STATE_MISSING`, or `STATE_INVALID / MODULE_MISMATCH` if one exists under another ref |
| two different snapshots | `STATE_CONFLICT / AMBIGUOUS_SNAPSHOTS` — never "the newest" |
| payload not what the envelope's digest commits to | `STATE_INVALID / PAYLOAD_DIGEST_MISMATCH` |
| source unconfigured, not configured for the kind, trust class ≠ configured, not in the sources, trust below minimum | `STATE_UNTRUSTED / …` |
| observed after `t` | `STATE_INVALID / OBSERVED_IN_FUTURE` |
| `t ≥ validUntil` | `STATE_STALE / SOURCE_VALIDITY_ENDED` |
| `AGE`: `t − observedAt > maxAge` | `STATE_STALE / AGE_EXCEEDED` |
| `BLOCKS`: no head configured / block above head / too far behind | `STATE_STALE / BLOCK_HEAD_UNKNOWN`, `STATE_INVALID / BLOCK_AHEAD_OF_HEAD`, `STATE_STALE / BLOCKS_BEHIND_EXCEEDED` |
| `SEQUENCE`: no watermark / below the watermark / no sequence | `STATE_STALE / WATERMARK_UNKNOWN`, `BEHIND_WATERMARK`, `STATE_INVALID / SEQUENCE_KIND_MISMATCH` |
| `VERSION`: not the pinned digest / too old | `STATE_STALE / PINNED_VERSION_MISMATCH`, `AGE_EXCEEDED` |
| finality on another ladder / undeclared level / below required | `STATE_FINALITY_INSUFFICIENT / …` |
| the module cannot read the payload as this subject's | `STATE_INVALID` (module reason) |

All failures are collected; the refusal names the first and lists every one.
A head or watermark the context does not give is never assumed.

**Bindings.** Every admitted snapshot becomes Core's `StateBinding` through
`bindState`: source, trust class, sequence, observation and validity times,
finality, the snapshot's digest and the effective requirement. The digest is
over the envelope, and so over its exact `ModuleRef`; the authorization
record additionally lists the module each binding was admitted under.
Changing any required snapshot changes the authorization's identity.

**No smuggling.** A module is handed only the snapshots admitted for its own
requirements. Supplied state nobody required is never admitted, bound or
shown to any module (tested: an unrelated account's 99,000 position never
reaches the projection). A fact that cites state not admitted to its module
is refused.

## 5. Reservation facts and projection

[ADR 0026](../adr/0026-worst-case-projection-over-pending-reservations.md).

```text
S' = Project_d(S ⊕ Pending(L@v), A)
```

`Pending(L@v)` is every `ACTIVE` reservation of the principal — every agent,
every root, every domain — at the snapshot version the decision will commit
at, normalized into `ReservationFact { reservation, generation, action,
module, implementation, lineage, status, committedAt, effects }`, with each
effect the reserved quantity, its market and account, and what was consumed.
A module never reads the ledger; it receives only the facts under its exact
`ModuleRef`. Reservations in its domain under another ref are recorded as
`foreignPending`, and make its own invariants `UNKNOWN`.

**Worst case (PROJ-1).** A pending reservation counts at its whole reserved
contribution, and no pending reduction is credited. Tested (brief §12): held
2,000 + pending 2,000 + proposed 2,000 = 6,000 > 5,000 refuses although held
alone would pass; an open close order does not lower exposure.

**Participants.** The acting module, the owner of every applicable
module-owned invariant, and every contributor to every Core aggregate. Each
is asked for its requirements over its own scope, each projects its own
domain, and only the acting module is given the action (`PROPOSE`; in
revalidation `REVALIDATE`, where it adds nothing because its own reservation
is already pending).

**Projection record and digest.** Per participant: its `ModuleRef` and
implementation, whether it acts, the snapshots admitted to it, its pending
reservations, its foreign pending, and its projection — facts, invariant
facts, resources, assumptions and its opaque payload bytes. Every list is a
set in canonical encoded order, so the digest does not depend on emission
order. The same action, authority and external state under different module
semantics differs in `ModuleRef` and in projection digest.

**A projection is hypothetical.** The only ledger write a decision can cause
is its own `RESERVE`; nothing a projection computes consumes, releases or
restores authority.

## 6. Economic facts and invariant facts

**Economic facts** are a small typed vocabulary shared by every module:

```text
EconomicFact { component: HELD | PENDING | PROPOSED, quantity: EconomicQuantity, market?, account?,
               states: StateId[] (provenance), reservations: ReservationId[] (provenance) }
```

The quantity is a Core `EconomicQuantity`, so kind, unit, decimals, asset and
valuation are typed and validated — capital, position size, committed
notional, gross and net exposure, margin, collateral, debt. There is no
floating risk score. Facts are components, never totals; `HELD` must cite a
snapshot, `PENDING` a reservation; a `MARK` valuation must price from an
admitted snapshot and a `LIMIT` valuation from an action in scope; no fill
price exists before execution.

**Invariant facts** are module-owned typed values whose meaning is bound by
the module's `ModuleRef` — account leverage as a `Ratio`, an account's gross
exposure as an unvalued `TOTAL`, a flag. Core never compares two modules'
invariant facts. `Measure = QUANTITY | RATIO | TOTAL | FLAG`, all exact.

## 7. Invariant evaluation

Every applicable invariant is evaluated: the union over the lineage (7C's
meet) with origin `LINEAGE`, and every principal-policy invariant with origin
`POLICY`, whichever root the action uses. Each resolves to Core's aggregate,
to the one module owning its definition, or to nothing (`UNKNOWN /
INVARIANT_DEFINITION_UNRESOLVED`). Every result is kept — not only the first
failure — as

```text
InvariantResult { origin, term (parameters included), evaluator: CORE | ModuleRef | NONE,
                  outcome: HOLDS | VIOLATED | UNKNOWN, reason, observed, bound,
                  states, reservations, projection digest, ledger version }
```

and the decision passes only if every result `HOLDS`. Any `VIOLATED` refuses
`INVARIANT_FAILED`; otherwise any `UNKNOWN` refuses `INVARIANT_UNKNOWN`
(FAIL-1). The results are digested canonically into the authorization.

**`core.aggregate-max` v1** — Core's principal-global state invariant:

```text
scope   exactly one CANONICAL_ASSET, plus the ACCOUNTs whose held state counts
params  str(tag) ‖ u16(1) ‖ kind ‖ str(unit) ‖ u8(decimals) ‖ u256(limit) ‖ u16(n) ‖ ModuleRef₁ … ModuleRefₙ
```

Each contributor is asked for its part (kind, unit, canonical asset, its
domain's scoped accounts) and projects its own held and pending state; Core
sums every matching `HELD`, `PENDING` and `PROPOSED` fact — equal kind and
unit, asset *exactly* the scoped canonical asset — with exact decimal
alignment, and compares with the limit. Nothing is matched by name: a module
counts a position only if it maps that market to that canonical `AssetId`
itself, so `BTC-PERP`, a WBTC-like token and a BTC-linked stock token are one
exposure only where a module says so (tested: a WBTC-like market mapped to
another canonical asset, and ETH, are not counted). A consulted module the
policy does not list that emits a matching fact makes the aggregate `UNKNOWN
/ UNDECLARED_CONTRIBUTOR`; an unavailable contributor, `UNKNOWN /
CONTRIBUTOR_UNAVAILABLE`.

Tested across roots (brief §22, §41, §65): spot 4,000 + perp 3,000 + 1,000
= 8,000 > 6,000 refuses; each root permitting its own action locally, the
principal-global projection refuses the second; 1,500 held + 2,500 pending +
2,000 proposed = 6,000 > 5,000 refuses while the ledger budget had room, 1,000
reserves, and after the pending reservation is released 2,000 reserves.

**State invariant versus ledger dimension** (Phase 7B.1 ruling 2, brief §24).
Marked exposure is evaluated here and never stored; committed notional is a
ledger counter reserved at the order's limit. Tested: with limit 101,000 and
mark 100,000 the notional leg holds 2,020.00, not 2,000.00; after the mark
moves to 106,000 the projection changes and no counter moves. A marked
quantity demanded as a counter is refused (`DEMAND_NOT_LEDGER_TRACKABLE`).

## 8. Semantic noWeaker

7C accepted a restated invariant only byte-identically. 7D proves "parameters
no weaker" with the owning definition's comparator:

| Parent | Child | Verdict | Registration |
| --- | --- | --- | --- |
| account leverage ≤ 4x | ≤ 3x | `NO_WEAKER` by the owning module | registered (Example D's good D2) |
| ≤ 4x | ≤ 5x | `WEAKER` | `DELEGATION_REFUSED / DELEGATION_WEAKENS_INVARIANT` |
| opaque invariant A | B, no owner | `UNPROVABLE` | `SEMANTIC_NARROWING_UNPROVABLE` |
| aggregate ≤ 6,000 over {perp} | ≤ 5,000 over {perp, spot} | `NO_WEAKER` by Core | registered |
| same | ≤ 7,000, or over {spot} only | `WEAKER` | refused |

**Trust boundary.** No caller supplies a verdict: `registerDelegation(grant,
at, retry)` takes a grant. The catalog resolves the one module owning the
invariant by exact `ModuleRef` (an active one, for a new registration) and
calls its comparator — or Core's, for Core's aggregate — and records the
proof with the comparator's `ModuleRef`. The ledger then re-derives the same
verdict at commit, and at every replay, from the `InvariantOrdering` its store
is configured with (`controlRules(catalog)`); nothing in the registration
event carries it. A catalog with a different digest for the owner is a
different ordering, resolved afresh: tested, a lenient comparator's history
registers under its own catalog and does not replay under the reference one.
A store not configured with the ordering refuses the narrowing at commit
(`LEDGER_CONFLICT`). At action time both the parent's and the child's
invariant apply (tested: 3.5x passes the parent's 4x and fails the child's
3x).

The aggregate comparator requires, for a signed kind, equal contributor
sets, because an extra contributor can only raise a non-negative sum.

## 9. Coverage over the meet

Over 7C's effective authority, never the leaf alone: the exact `ModuleRef`
(DOM-2), the exact `AdapterRef`, `(domain, actionType)`, every target and
resource against `MARKETS`, `ASSETS`, `VENUES` or `RECIPIENTS` (closed world:
an absent vocabulary grants nothing), every right the module says the action
exercises (`OPEN_RISK` for increasing, `REDUCE_RISK` for reducing), every
effective per-action bound against the module's value for it (a bound it
reports no value for refuses `BOUND_NOT_EVALUATED`), and the domain's time
window. `ACCOUNT` resources are the principal's own enforcement accounts and
are scoped by state and demand, not by a set. The action's own window,
payload digest and module-recomputed resources are checked first
(`ACTION_INVALID`).

Risk direction is derived by the module, recorded, and used only to require
the matching right. **There is no risk-reducing exception**: a reducing
action passes through the same admission, projection and invariants, and is
refused on stale or missing state like any other.

## 10. Ledger demands and dimension matching

The acting module converts its projected action into `LedgerDemand`s — e.g.
`CAPITAL 1,000.00 USDG` (required), `NOTIONAL 2,000.00 USD` at the limit,
`POSITION_SIZE 0.0200`, `COUNT 1` — each checked: ledger-trackable, strictly
positive, in a measure the module declared, and valued, if at all, only at
this action's own limit price. They become a 7C `ChargePlan`, which has no
field for targets.

**Matching** is the ledger's, unchanged and canonical: a demand matches a
dimension iff kind and unit are equal and every scope attribute the dimension
names — asset (exact `AssetId`), market, domain (the plan's module's),
account — is present and equal. Dimension identifiers and human-readable
names play no part; incompatible kinds or units simply match nothing, and a
required demand that matches no lineage dimension refuses
`AUTHORITY_UNAVAILABLE / UNBOUNDED_CONTRIBUTION` (LEDGER-5). The ledger
derives every leg — each matching dimension of each lineage node, then of the
policy — and a caller cannot skip an ancestor or the policy.

## 11. The authorization pipeline and CAS re-projection

```text
 1. resolve the exact module                         8. project S ⊕ Pending(L@v) per participant
 2. payload digest, validFrom ≤ t < expiresAt         9. evaluate every applicable invariant
 3. principal, lineage valid at t, actor = holder    10. derive demands → ChargePlan
 4. module analysis; coverage over the meet          11. ledger: derive legs, check availability (same snapshot)
 5. applicable invariants → participants             12. lifetime
 6. requirements, tightened; admission               13. CAS(v, head(v), [RESERVE])
 7. bindings; reservation facts at v                 14. AuthorizationRecord bound to the committed version
```

Steps 1–12 are one pure function (`decide`) of a snapshot and a request. On a
lost compare-and-swap **nothing computed from the old snapshot is reused** —
not the plan and not the projection — because a concurrent reservation
changes the pending set as well as capacity. Retries are bounded by 7C's
explicit `RetryPolicy` (1..32, no default); exhaustion is `CONFLICT /
RETRY_EXHAUSTED`, never an authority failure. A decision that fails writes
nothing, and a module fault never reaches the ledger.

Tested (brief §42): two agents read one snapshot; each action passes alone,
together they exceed a principal-global limit. Exactly one reserves; the
loser loses the CAS, recomputes, sees the winner's reservation at the
winner's committed version, and is refused `INVARIANT_FAILED` — the ledger
budgets were generous. Over 40 randomized interleavings the count is always
one and both orders occur. With 100 agents under three roots and two modules
(brief §43), every global constraint holds at the end, every active
reservation has its authorization and vice versa, and every authorized
decision was read at the version immediately before its commit and projected
exactly the reservations active there.

## 12. The authorization: identity, lifetime and Core's ExecutionAuthorization

On commit the engine builds Core's `ExecutionAuthorization` — its
`ReservationRef` names the action, explicit generation, principal, lineage,
policy, exact module and implementation, adapter and the **committed** ledger
version; its bindings are the admitted set; its attempt ceiling is the
lifetime — and an `AuthorizationRecord` whose identity is keccak-256 over:

```text
ExecutionAuthorizationId, ActionId, principal, ModuleRef, implementation, AdapterRef, lineage,
PrincipalPolicyId, ReservationId, generation, StateBindingIds, binding modules,
projection digest, invariant-results digest, charge-plan digest, context digest,
ledger version and head read, ledger version and head committed, evaluatedAt, validUntil,
the bindings that must be rechecked before issue
```

Tested: the action, module digest, lineage, policy, one binding, the pending
set, invariant results, the plan and the ledger version each change the
identity; the same inputs in a fresh world reproduce it byte for byte. A
record is refused if its commit is not at the version immediately after the
one the decision read.

**Lifetime** (brief §33) is the earliest of the action's `expiresAt`, every
lineage node's, the module's own cap, and — for every binding whose
dependency must hold at execution by expiring with its state
(`BOUNDED_BY_FRESHNESS`) — `min(observedAt + maxAge, validUntil)`. Each is
tested as the binding boundary in turn; with nothing left the decision
refuses `AUTHORIZATION_EXPIRED / LIFETIME_EMPTY`. No signature or venue
artifact exists: those are 7E and later.

## 13. Revalidation and NEVER_ISSUED

**Revalidation** (`revalidate(record, {payload, states, context})`) is pure and
changes nothing. It requires the reservation to be `ACTIVE` at exactly the
record's generation and module (`RESERVATION_NOT_ACTIVE` otherwise) and the
record's lifetime not to have ended; checks the lineage at `t_i` at the
current version; then, if every binding is `WITHIN_POLICY`, re-admits each
from the binding alone (freshness, finality, watermark) — `PASSED`, not
refreshed — and otherwise admits fresh state and re-runs projection and every
lineage and principal-global invariant over `S_fresh ⊕ Pending(L@v')`, where
the reservation's own worst case is already pending and is not added again.
Coverage, availability and demands are not re-run. A `PASSED` result gives
the bindings to issue under and a lifetime never beyond the record's; the
authorization itself is never edited.

**NEVER_ISSUED** (`closeNeverIssued`) is the only release this package can
cause. The engine re-reads the ledger, requires the reservation active at the
record's generation with **nothing consumed**, runs revalidation **itself**
and requires it to fail, and commits a `CLOSE` releasing every remaining leg
by CAS. Its evidence is internal: `H("mandate-core/v1/control/never-issued",
reservation, generation, authorization, revalidation)` in the ledger's
observation slot, under a tag no observation can take. It is idempotent: a
closed, unconsumed reservation returns `ALREADY_CLOSED` and writes nothing.
In 7D no artifact can exist — there is no `ADMIT_ATTEMPT` — so the ledger is
the evidence that none was issued; 7E must add "no attempt admitted" to the
preconditions before any issuance exists.

Tested (examples.md §F, brief §35): reserved at T1 on a 100,000 mark; the mark
moves to 106,000; revalidation at T3 fails (`0.19 × 106,000 = 20,140 >
20,000`, the reservation counted once); nothing was written; the reservation
closes `NEVER_ISSUED` releasing every leg; the `CLOSE` names the evidence
built from the authorization and the failed revalidation; closing again is a
no-op. At 104,000 revalidation passes on fresh bindings and closure is
refused (`REVALIDATION_PASSED`); recorded consumption blocks it
(`EXECUTION_EVIDENCE_EXISTS`); an ancestor's revocation fails revalidation.
A generation-1 record never sees, revalidates or closes generation 2.

**Raw settlement stays infrastructure-only.** The package exports no
`settle`, consume, release or restore; its engine has exactly
`authorizeAndReserve`, `decide`, `read`, `revalidate`, `closeNeverIssued` and
`registerDelegation`, and never calls `AuthorityLedger.settle`. The
structural test asserts all of it.

## 14. Failure taxonomy

Provisional (open question 9). `code` is the family; `reason` the rule;
`origin` is `CONTROL`, `CORE`, `LEDGER` or `MODULE`, and a module reason is
namespaced by the module's `ModuleRef`.

| Code | Meaning |
| --- | --- |
| `REQUEST_INVALID`, `CONTEXT_INVALID`, `RESOURCE_BOUND_EXCEEDED` | malformed request or context; a cardinality over its bound |
| `MODULE_NOT_FOUND`, `MODULE_NOT_CONFORMING` | resolution (§3); module output or behaviour |
| `ACTION_INVALID`, `ACTION_NOT_COVERED` | the action itself; coverage over the meet |
| `AUTHORITY_INVALID`, `AUTHORITY_UNAVAILABLE` | lineage, actor, principal; the charging path cannot hold the demand |
| `DELEGATION_REFUSED`, `SEMANTIC_NARROWING_UNPROVABLE` | registration |
| `STATE_MISSING`, `STATE_STALE`, `STATE_UNTRUSTED`, `STATE_CONFLICT`, `STATE_FINALITY_INSUFFICIENT`, `STATE_INVALID`, `STATE_POLICY_CONFLICT` | admission (§4) |
| `INVARIANT_FAILED`, `INVARIANT_UNKNOWN`, `DEMAND_INVALID` | projection, invariants, demand |
| `LEDGER_CONFLICT`, `RETRY_EXHAUSTED` | the store refused what the decision validated; every CAS lost |
| `AUTHORIZATION_EXPIRED`, `RESERVATION_NOT_ACTIVE`, `REVALIDATION_FAILED`, `REVALIDATION_PASSED`, `EXECUTION_EVIDENCE_EXISTS` | lifecycle |

Every code is produced by at least one test; `taxonomy.test.ts` asserts it.

## 15. Trust boundaries and resource bounds

| Boundary | Trusted | Not trusted |
| --- | --- | --- |
| Agent → engine | nothing it asserts | the action, payload, supplied state, generation — all validated |
| Operator → engine | the evaluation context (source configuration, heads, watermarks) and the catalog | — (they are configuration, and are digested into the decision) |
| Module → engine | the module's *semantics*, bound by its digest | every output value, re-validated; its throws and mutations |
| Engine → ledger | the store's CAS and reducer | the engine's own validation is re-done by the reducer at commit |
| Ledger reducer | the configured `InvariantOrdering` | any verdict in an input — none can be expressed |

Bounds (`limits.ts`), each a refusal, never a truncation:

| Collection | Bound | Why |
| --- | ---: | --- |
| admitted requirements | 64 | Core's `MAX_STATE_BINDINGS`: every admission becomes a binding |
| supplied snapshots | 128 | extras are never admitted but cost a digest each |
| state payload | 1 MiB | Core's action payload bound |
| applicable invariants | 1,152 | Core's own maximum (8 × 128 + 128), stated |
| unresolved reservations considered | 4,096 | linear cost (§17); above it new authority refuses — liveness, not safety |
| participants | 32 | acting module + owners + contributors |
| facts per projection | 16,384 | four per considered reservation |
| invariant facts / assumptions / resources | 1,024 / 64 / 1,024 | |
| demands | 64 | the ledger's contributions per plan |
| context entries | 4,096 | |

## 16. Tests and the authorization corpus

`packages/control/test`, 99 tests, offline and deterministic:

| File | Covers |
| --- | --- |
| `structure.test.ts` | dependencies, imports, no I/O/clock/randomness/env (control and the synthetic module), no `any`/`unknown`/`Record`/floats, no venue or production module, no raw accounting export, the engine's exact methods, nothing below depends on control |
| `catalog.test.ts` | every resolution refusal; catalog admission refusals; digest discipline; wrong ref; missing function |
| `conformance.test.ts` | the corpus; purity across instances; a lying implementation; each hostile variant rejected by conformance and refused at run time with the ledger untouched |
| `admission-rules.test.ts`, `admission.test.ts` | every admission refusal with both sides of each boundary; tightening; incompatible policies; bindings; no smuggling; re-admission |
| `projection.test.ts` | brief §12; no pending-reduction credit; canonical projection digest; foreign pending; the 7B.1 notional/mark regression |
| `global.test.ts` | cross-root aggregates, name-independence, undeclared/unavailable contributors, unresolved invariants, complete diagnostics, the brief §65 end-to-end scenario |
| `narrowing.test.ts` | 4x→3x, 4x→5x, opaque, enforcement of both, digest change, unconfigured store, retiring owner, no verdict parameter, Core's aggregate comparator |
| `engine.test.ts` | resolution at decision time, identity, lifetime, Example F, NEVER_ISSUED, revocation, consumption, generations, bounded retry, refusals write nothing |
| `concurrency.test.ts` | brief §42 with a barrier and 40 random interleavings; brief §43 with 100 agents |
| `mutation.test.ts` | the eight brief §58 mutants, each killed |
| `model.test.ts` | an independent reference model agrees on 600 randomized steps |
| `determinism.test.ts` | byte-identical outcomes across fresh worlds and supplied-state orders |
| `taxonomy.test.ts` | the remaining refusals, and every code produced somewhere |
| `corpus.test.ts` | the committed corpus equals the generator's |

**Mutants killed** (brief §58): drop the position binding; ignore one
pending reservation; skip the principal-global invariants; bind state without
admission checks (stale state authorizes); reuse the pre-CAS plan after a
conflict (both racers reserve); resolve modules by name (a patched digest
runs); value committed notional at the mark; a comparator calling 5x no
weaker than 4x. Each is built from the production stages with one change and
fails a probe production passes.

**Corpus.** `corpus/control-v1/vectors.json`
([README](../../corpus/control-v1/README.md)): nine vectors — valid,
missing-state, stale-state, global-invariant, pending-reservation, narrowing
pass, widening refusal, CAS re-projection, NEVER_ISSUED — each with its exact
`ModuleRef` and outcome digests. `npm run control-corpus:generate`, included
in `generated:check`. No existing corpus changed.

The ledger gains `ordering.test.ts` (8 tests). Core is unchanged.

## 17. Benchmarks

`npm run control:benchmark`: pure functions over an immutable snapshot,
median of 7 rounds, Node v22.21.0 on the development machine.
Machine-dependent; reported, not asserted.

| Case | Invariants | Bindings | Legs | Lineage | Pending | Admission (µs) | Module projection (µs) | Admission + projection + invariants (µs) | Ledger reservation (µs) | Total decision + reservation (µs) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 invariant, 1 dimension | 1 | 3 | 2 | 2 | 0 | 178 | 9 | 403 | 83 | 829 |
| 5 invariants, 4 dimensions | 5 | 4 | 8 | 2 | 0 | 202 | 11 | 757 | 130 | 1,355 |
| 5-deep lineage | 1 | 3 | 5 | 5 | 0 | 167 | 7 | 373 | 134 | 885 |
| 20 pending reservations | 1 | 3 | 2 | 2 | 20 | 175 | 47 | 1,473 | 82 | 2,170 |
| 100 pending reservations | 1 | 3 | 2 | 2 | 100 | 176 | 199 | 6,105 | 79 | 7,588 |
| 1,000 pending reservations | 1 | 3 | 2 | 2 | 1,000 | 169 | 2,019 | 63,250 | 82 | 73,848 |

The synthetic action always needs three snapshots (mark, position book,
instruments), so the brief's "2 states" case is measured with three; the
five-invariant case adds a second account's book.

Admission, the ledger's reservation and lineage depth are flat. Cost grows
**linearly** with open reservations, at roughly 70 µs per reservation:
not the module's projection (about 2 µs per reservation) but the engine's
guarantees around it — deep-frozen copies of scope and projection for the
module, re-validation of every returned fact, and above all the canonical
encoding of the projection record, because the frozen kernel `ByteWriter`
writes every integer byte by byte through `bigint`. Encoding each fact once
instead of twice (to sort and then to write) took the 1,000-reservation
decision from about 92 ms to 74 ms with byte-identical output; nothing else
was optimized. Nothing is super-linear. At the 4,096-reservation bound a
decision costs a few hundred milliseconds, which is why the bound exists; if
it matters, the projection encoding and the freezing are the places to
start.

## 18. Specification readings for owner review

Every choice is the fail-closed one; none changes a frozen decision.

| # | Where | Issue | Reading taken |
| --- | --- | --- | --- |
| 1 | brief §9 vs Core `StateBinding` | The binding must bind the `ModuleRef`; Core's frozen `StateBinding` has no module field | Bound transitively: `stateDigest` is over the envelope, which carries the full `ModuleRef`. The authorization record also lists each binding's module |
| 2 | action-state-model.md §5.2 | Source configuration must come from somewhere trusted | The operator's explicit evaluation context; digested into the authorization. No `trustedVersionPins`: a pin is part of the effective requirement |
| 3 | action-state-model.md §6 "values the sum at one admitted mark" vs brief §22 | Cross-domain aggregation of marked facts | Each contributor values its own facts at its own admitted mark; Core sums like with like as an unvalued `TOTAL`. Requiring one shared mark is an open question |
| 4 | action-state-model.md §6 "every domain" | Which modules an aggregate covers | Its contributor list, stated in its parameters; a consulted non-contributor emitting a matching fact makes it `UNKNOWN`. Pending reservations under a non-contributor predating the policy are not counted (AUTH-GLOBAL-2 territory) |
| 5 | action-state-model.md §8.1 `lotCompatibility` | A module seeing reservations of another version | Only its exact ref's; others in its domain make its own invariants `UNKNOWN` |
| 6 | PROJ-1 | Consumption recorded on a pending reservation | Not subtracted: the whole reservation counts, possibly double-counting a reflected fill (conservative) until reconciliation |
| 7 | brief §33 vs action-state-model.md §5.5 | Which state bounds lifetime | `BOUNDED_BY_FRESHNESS` bindings (as specified); other bindings are re-admitted or rechecked at issue |
| 8 | reservations-reconciliation.md §4 `REVALIDATE` | A revalidation that passes | Returned as a value; committing `REVALIDATE` / `ADMIT_ATTEMPT` is the issuance phase's (7E) |
| 9 | reservations-reconciliation.md §4 `NEVER_ISSUED` | "No attempt was ever admitted" with no `ADMIT_ATTEMPT` event | Holds vacuously in 7D; also required: no consumption. Anyone able to make revalidation fail (e.g. by withholding fresh state) can close an unissued reservation — safe only because nothing can be issued yet. 7E must add the attempt precondition |
| 10 | brief §18 | How the ledger accepts a comparator result without a forgeable input | Reducer configuration (`ReducerRules`), not event data; replay needs the same ordering |
| 11 | authority-model.md §3 coverage | Accounts in coverage | `ACCOUNT` resources are not set-checked; every present vocabulary is closed-world |
| 12 | (not specified) | The state payload digest | `H("mandate-core/v1/state-payload/" ‖ moduleDigest, payload)`, the state analogue of Core's action payload digest |
| 13 | roadmap §7D exit criteria | RECON-1…5, TIME-1, REPLAY-1 via observations | Not in this brief (venue-driven transitions are excluded) and not built; they move with observation reconciliation |
| 14 | 7C §14 item 2 (second half) | Finality ordering in delegated state policies | Unchanged: a different finality level is still `DELEGATION_NARROWING_UNPROVEN` |
| 15 | reservations-reconciliation.md §10a | Demands during revalidation | Not re-derived, as specified ("the reservation already holds its authority"); a module whose demand depends on state would need this revisited |

## 19. Invariants

| Invariant | Status after 7D | Evidence |
| --- | --- | --- |
| **STATE-1** | **Established** for decisions: source, configured trust class, freshness by its own mode and finality, under the tightest requirement | `admission*.test.ts` |
| **STATE-2** | **Established**: conflicting snapshots of one subject refuse | `admission.test.ts` |
| **STATE-3** | **Partly**: `SEQUENCE` state below the context's watermark refuses; the watermark comes from the context until reconciliation maintains it | `admission.test.ts`, `mutation.test.ts` |
| **STATE-4** | **Established**: bindings of exactly the admitted snapshots under their effective requirements, bound into the authorization's identity | `admission.test.ts`, `engine.test.ts` |
| **STATE-5** | **Partly**: lifetime bounded by `BOUNDED_BY_FRESHNESS` bindings; pure issue-time re-admission and revalidation; no artifact exists to be issued | `engine.test.ts` |
| **FAIL-1** | **Established** for decisions: missing or untrusted state, an unevaluable invariant, an unresolvable definition, an undeclared contributor all refuse | `global.test.ts`, `taxonomy.test.ts`, `model.test.ts` |
| **PROJ-1** | **Established** for the synthetic module: pending increases in full, no pending reduction credited | `projection.test.ts`, `model.test.ts` |
| **AUTH-2** (semantic half) | **Established**: invariant parameters narrowed only when the owning definition proves it; widening refused; both enforced at action time | `narrowing.test.ts`, `ordering.test.ts`, `mutation.test.ts` |
| **AUTH-GLOBAL-1** (state invariants) | **Established**: principal-global invariants evaluated on every action over every root's pending state | `global.test.ts`, `concurrency.test.ts`, `mutation.test.ts` |
| **AUTH-1** | **Partly**: lineage validity plus coverage over the meet at every decision; signatures still absent | `taxonomy.test.ts`, `engine.test.ts` |
| **CONC-1** (projected state) | **Established**: a lost CAS forces full re-projection; of two actions valid alone and invalid together at most one reserves | `concurrency.test.ts`, `mutation.test.ts` |
| **CORE-CONC-1** | **Not regressed**: nothing argues market state from CAS; state is bound and rechecked | — |
| **DOM-1** | **Partly**: modules are pure (structure, conformance), cannot authorize or choose targets, and their outputs are re-validated; the only module is test-only | `structure.test.ts`, `conformance.test.ts` |
| **DOM-2** | **Established** at decision and revalidation: exact `ModuleRef` resolution, no fallback, the module fixed on the reservation and the authorization | `catalog.test.ts`, `engine.test.ts`, `mutation.test.ts` |
| **SCOPE-1** | **Partly**: facts and demands carry typed canonical assets and scopes; aggregates match assets exactly | `global.test.ts` |
| **EXEC-3/EXEC-6** foundations | the attempt ceiling is the lifetime, bounded by every dependency | `engine.test.ts` |
| **RECON-2** | **Partly**: facts and closure are generation-exact | `engine.test.ts` |
| **LEDGER-1…6**, **AUTH-4**, **AUTH-5** | Unchanged from 7C; every 7C test passes | ledger suite |
| **AUTH-GLOBAL-2** | **Not established**: `POLICY_UPDATE_REQUIRES_BASELINE` still stands; no baseline economic state is modelled | — |
| **RECON-1/3/4/5**, **TIME-1** (observations), **REPLAY-1** (`SPENT`), **LEDGER-RESTORE-1** by evidence, **DRIFT-\***, **EXEC-1/2/4/5**, **CRED-1**, **RECEIPT-\*** | **Not established**: observation reconciliation, issuance, adapters and receipts are later phases | — |
| **PHASE6-1** | Holds: no Phase 6 file, Solidity source or existing corpus changed | `generated:check` |

## 20. Completion answers

| Question | Answer |
| --- | --- |
| Can a module authorize an action by itself? | **No** — it returns facts and demands; the engine decides and the ledger commits |
| Can an action omit required state? | **No** — `STATE_MISSING` |
| Can stale state pass because the ledger had capacity? | **No** — admission precedes the ledger, and the mutant that skips it is killed |
| Can a pending reservation be ignored when projection says it matters? | **No** — every active reservation is a fact at the decision's version |
| Can a child use 5x when its parent allows 4x? | **No** — `DELEGATION_WEAKENS_INVARIANT`, and the parent's invariant still applies at action time |
| Can a child use 3x when the registered module proves it narrower than 4x? | **Yes** |
| Can a domain module choose which ancestors get charged? | **No** — a plan has no targets; the ledger derives the path |
| Can a CAS retry reuse the old economic projection? | **No** — the whole decision is recomputed; the reuse mutant is killed |
| Can projection release authority? | **No** — a decision's only write is its own `RESERVE` |
| Can an agent invoke raw settlement to free its budget? | **No** — nothing in `@mandate/control` exposes it |
| Does this phase contact an external market? | **No** |

## 21. Open questions and what is next

1. **One mark for marked aggregates** (§18 item 3).
2. **Aggregate coverage of pre-existing pending reservations** under a
   non-contributor module (§18 item 4) — with AUTH-GLOBAL-2.
3. **`lotCompatibility`** for reservations under earlier module versions
   (§18 item 5).
4. **Issuance** (7E): commit `REVALIDATE` and `ADMIT_ATTEMPT`, add the attempt
   precondition to `NEVER_ISSUED`, and bind artifacts to the lifetime.
5. **Observation reconciliation**: consumption, release, restoration and
   watermarks from validated evidence (RECON-*, TIME-1, REPLAY-1), replacing
   the raw `settle` still available to infrastructure.
6. **Registry governance** (open question 16) now also decides which
   comparators order delegated invariants, and must keep retired ones for
   replay.
7. **Hot-path cost** at many open reservations (§17).
8. **Finality ordering** for delegated state policies (7C open question 2,
   second half).

**Next (on approval): Phase 7E**, the first real domain module and its
enforcement adapter. Not started.
