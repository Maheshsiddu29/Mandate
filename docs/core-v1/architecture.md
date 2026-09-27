# Mandate Core v1 — Architecture

> **Status: Phase 7A specification, DRAFT pending review. Nothing in this
> document is implemented.** It defines the domain-independent layer that
> future Spot, Perp, Options, Prediction, Lending, Liquidity, Payment, Treasury
> and Governance modules build on. The frozen Phase 6 execution gate is not
> modified; it becomes one enforcement adapter (§7).

Mandate Core answers one question for arbitrary execution systems:

> How is delegated economic authority represented, how is a proposed autonomous
> action checked against it and against the economic state that already exists,
> how is the authority it needs held while the action is in flight, where is the
> action actually prevented if it is not permitted, and how is what happened
> afterwards turned back into consumed and released authority and evidence?

The product invariant is

```
agent autonomy  ⊆  principal-delegated economic authority
```

and every rule in this specification exists to keep the left side inside the
right side when the left side is concurrent, asynchronous, partial, stale,
multi-agent, multi-venue and adversarial.

## Contents

1. [What Core is and is not](#1-what-core-is-and-is-not)
2. [The core equation](#2-the-core-equation)
3. [Layers](#3-layers)
4. [Deterministic Core versus adapter behaviour](#4-deterministic-core-versus-adapter-behaviour)
5. [The authorization pipeline](#5-the-authorization-pipeline)
6. [The linearization point](#6-the-linearization-point)
   - [6a. What the linearization point does not linearize](#6a-what-the-linearization-point-does-not-linearize)
7. [Relationship to frozen Phase 6](#7-relationship-to-frozen-phase-6)
8. [Phase 1–6 lessons carried into Core](#8-phase-16-lessons-carried-into-core)
9. [Concept catalogue](#9-concept-catalogue)
10. [Implementation boundary for Phase 7B](#10-implementation-boundary-for-phase-7b)

---

## 1. What Core is and is not

Core is **economic control infrastructure**: an authority graph, a ledger of
quantitative authority, typed envelopes for actions and state, a reservation
and reconciliation state machine, an enforcement-adapter contract and a receipt
model.

Core does **not** understand markets. It never computes a perp's liquidation
price, an option's delta, a lending market's health factor or a prediction
market's resolution. Those are domain facts, computed by domain modules that
Core invokes through typed interfaces (§3). What Core understands about every
action, in every domain, is:

| Core understands | Core does not understand |
| --- | --- |
| identity: who proposed it, under which authority node | what the payload's fields mean |
| authority lineage: the chain of grants back to a principal | how a market prices risk |
| domain: which module interprets it | how to value a position |
| state dependency: which admitted snapshots it was built against | how a venue matches orders |
| resource consumption: typed contributions to ledger dimensions | which contributions an action makes (the domain module says) |
| execution binding: that an artifact commits to exactly this action | how the artifact is encoded for the venue |
| lifecycle: authorized, reserved, observed, reconciled, closed | when a venue's cancel is final (the adapter says) |

A domain module that answers the right-hand column incorrectly can make Core
authorize the wrong thing. That is why domain modules are part of the trusted
computing base, are pure, and are versioned into every receipt (§3, and
[receipts-provenance.md](receipts-provenance.md)).

Explicit non-goals of Core v1: universal options pricing, trading strategies,
prediction resolution, oracle networks, a new chain, wallet, DEX or perp
exchange, ZK proofs, token economics, a DAO token, a bridge, and a universal
policy scripting language. Constraints are **typed interfaces with closed
vocabularies**, not programs.

## 2. The core equation

```
M   = effective authority of the acting node
      = meet of the terms of every grant on its lineage          (authority-model.md §4)
P   = the principal policy: principal-global dimensions,
      invariants and state policy, applying to every root         (authority-model.md §8)
d   = the exact semantic module interpreting A: ModuleRef          (action-state-model.md §8.1)
L   = the principal's ledger at version v: reconciled occupancy,
      consumption and every active reservation                    (authority-ledger.md)
S   = admitted state: snapshots whose source, trust, freshness and
      finality satisfy the state policy of M and P, plus the ledger
      view L; each admitted snapshot becomes a StateBinding        (action-state-model.md §5)
A   = the proposed action intent
S'  = Project_d(S ⊕ Pending(L), A)                                 worst case, by domain module d

Authorize(A, t) at ledger version v  ⇔
      LineageValid(M, A, t)          every grant signed, unrevoked, unexpired at t; actor = leaf holder
  ∧   AuthorityCovers(M, A)          sets, rights, per-action bounds, modules, adapters, time
  ∧   FreshEnough(S, M ∧ P, t)       every required snapshot admitted under its state policy
  ∧   InvariantsHold(M ∧ P, S')      every lineage and principal-global invariant HOLDS (UNKNOWN rejects)
  ∧   AuthorityAvailable(L, path, A) every ledger dimension on the charging path:
                                     each lineage node, then the principal policy
```

`Pending(L)` is not optional. Invariants and availability are evaluated over the
reconciled state **plus the worst-case effect of every action already reserved
and not yet reconciled**, because an order resting on a venue is exposure the
principal already carries. `S ⊕ A` alone would let the second of two pending
orders pass on state that does not yet show the first
([examples.md §B](examples.md#b-cross-venue-pending-exposure)).

If `Authorize` holds, the lifecycle is

```
Reserve ──▶ Bind exact execution ──▶ Enforce ──▶ Observe actual result
                                                        │
Receipt ◀── Consume / Release ◀── Reconcile ◀───────────┘
```

and each arrow is owned by exactly one layer (§4).

The time `t` is a parameter, never a clock read inside Core (AGENTS.md §4.2).
The ledger version `v` is part of the decision: a decision is a function of
`(A, lineage, P, state bindings, L@v, t, core version, ModuleRef)` and is
reproducible from those inputs (RECEIPT-2).

Two scope statements belong next to the equation. The ledger version `v`
orders Mandate's own authority state; it does not make external state atomic
with the decision (CORE-CONC-1, §6a). And the semantic module `d` is fixed
for the action's whole lifecycle (DOM-2): the reservation, the binding,
reconciliation and every receipt use the same `ModuleRef`.

## 3. Layers

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ AGENTS (untrusted)                                                           │
│   propose ActionIntents; sign them; never hold enforcement credentials       │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ ActionIntent (signed by actor)
┌───────────────────────────────▼──────────────────────────────────────────────┐
│ MANDATE CORE (pure, deterministic; trusted)                                  │
│   lineage verification · meet of terms · freshness policy · invariant        │
│   dispatch · ledger transition rules · reservation state machine ·           │
│   reconciliation rules · receipt construction                                │
│        │ calls, through typed interfaces                                     │
│        ▼                                                                     │
│   DOMAIN MODULES (pure, deterministic; trusted, versioned)                   │
│     payload decoding · resource refs · risk direction · projection ·         │
│     contribution rules · typed invariants · valuation formulas               │
└───────────────┬───────────────────────────────────────────▲──────────────────┘
                │ ExecutionAuthorization + ExecutionBinding  │ Observations
┌───────────────▼───────────────────────────────────────────┴──────────────────┐
│ ENFORCEMENT ADAPTERS (effectful; trusted for custody and observation rules)  │
│   EVM Execution Adapter ─▶ frozen Phase 6 MandateExecutionGate               │
│   Venue Signer (perps, 7E) · smart-account permission · API credential ·     │
│   governance · payment                                                       │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ artifacts / reads
┌───────────────▼──────────────────────────────────────────────────────────────┐
│ INFRASTRUCTURE (effectful; trusted computing base)                           │
│   ledger store with atomic compare-and-swap · state readers · clock ·        │
│   key custody for signers · receipt store                                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

| Layer | Purity | Trust | Owns |
| --- | --- | --- | --- |
| Agent | — | **untrusted** | proposing; its own signature; nothing else |
| Core | pure, total, fail-closed | trusted | every authorization decision and every ledger transition rule |
| Domain module | pure, total, fail-closed | trusted, versioned | every domain-specific fact Core needs, as typed values |
| Enforcement adapter | effectful at the edges, pure rules inside | trusted for what it signs and how it reads outcomes | turning an authorization into an artifact the enforcement point accepts; turning evidence into observations |
| Infrastructure | effectful | trusted computing base | atomicity, custody, time, storage |

**Only Core says yes** (design [§22.2](../mandate-design.md#222-the-one-structural-commitment)).
A domain module may say "this invariant is VIOLATED" or "this action contributes
600 USDG of capital"; it cannot authorize. An adapter may refuse to issue an
artifact; it cannot issue one without a Core `ExecutionAuthorization` and the
live reservation it names.

The Phase 5 model boundary carries over unchanged: an agent — or any model
behind it — proposes; nothing it supplies becomes an address, an amount, a
constraint value or a trust decision except by passing through Core's checks
([INV-3, INV-4](../mandate-design.md#16-major-invariants)).

## 4. Deterministic Core versus adapter behaviour

| Stage | Owner | Deterministic? | Inputs | Output |
| --- | --- | --- | --- | --- |
| Propose | agent | no | anything | signed `ActionIntent` |
| Parse and digest | Core | yes | intent bytes | `ActionDigest` or `MALFORMED_ACTION` |
| Resolve lineage | Core | yes | grants, revocation set (from ledger), `t` | lineage or `AUTHORITY_*` reasons |
| Decode payload, resource refs, risk direction | domain module | yes | intent, admitted state | typed domain action |
| Admit state | Core (policy) + readers (fetching) | policy yes, fetching no | snapshots, source registry, `t` | admitted `S` or `STATE_*` reasons |
| Project | domain module | yes | `S ⊕ Pending(L)`, action | `S'` (worst case) |
| Evaluate coverage and invariants | Core dispatching to domain invariants | yes | `M`, action, `S'` | `InvariantResult`s |
| Compute contributions | domain module | yes | action, `S` | typed contributions per dimension |
| Check availability and reserve | Core rule, applied atomically by the ledger store | rule yes; atomicity is infrastructure | `L@v`, contributions | `Reservation` at `v+1`, or reject |
| Bind | adapter | yes | authorization, intent, `ModuleRef` | `ExecutionBinding` |
| Issue-time state admission | Core rule, run by the adapter before issuing; revalidation committed by CAS | rule yes; fetching no | state bindings, fresh snapshots if needed, `L@v'`, `t_i` | `ADMIT_ATTEMPT`, or `REVALIDATE`, or refuse |
| Issue artifact | adapter (custody) | signing yes; custody no | binding | `EnforcementArtifact` |
| Enforce | enforcement point (gate, venue, account) | outside Mandate | artifact | executes or refuses |
| Observe | adapter reader (fetching) + adapter rule (pure) | rule yes | chain/venue evidence | `Observation` or none |
| Reconcile | Core rule, applied atomically | yes | reservation, observation | consume / release / overrun / conflict |
| Receipt | Core | yes | everything above by digest | hash-chained receipts |

Every "yes" in the Deterministic column is a pure function whose only inputs
are listed, which is what makes a decision reproducible from its receipt
([INV-11](../mandate-design.md#16-major-invariants)). Everything effectful is at
an edge and produces a typed, provenance-carrying value before it can influence
anything.

## 5. The authorization pipeline

1. **Parse.** The intent is parsed whole; unknown fields, unknown versions and
   out-of-range values reject (`MALFORMED_ACTION`). `ActionDigest` is computed
   by Core, never supplied.
2. **Verify the actor.** The actor's signature over `ActionDigest` verifies and
   the actor is the holder of the leaf authority node named by the intent. A
   valid actor signature proves who asked, never that the action is permitted
   ([INV-2](../mandate-design.md#16-major-invariants)).
3. **Resolve lineage** ([authority-model.md §5](authority-model.md#5-lineage-validity)).
   Every grant from the leaf to the root is present, signed by the right
   issuer, unrevoked and within its window at `t`. The root's issuer is the
   intent's principal, and the principal has a registered principal policy `P`.
4. **Compute effective authority** `M` as the meet of the lineage's terms. `P`
   is not part of the meet — it grants nothing — but its invariants, state
   policy and dimensions apply in steps 7, 9 and 10.
5. **Domain decode.** The domain module named by the intent's `ModuleRef` — which
   must be registered and inside `M`'s allowed modules — decodes the payload
   against its schema version, derives resource references and risk direction
   from the payload and state — the agent's own claim of "risk-reducing" is not
   read — and returns a typed domain action.
6. **Coverage.** Domain, action type, adapter, markets, assets, recipients,
   rights and per-action bounds are inside `M`.
7. **Admit state.** Every snapshot the domain module and the invariants require
   is present, from an admitted source for its state kind, within its age
   bound, at its required finality, not in conflict, and not older than the
   ledger's last reconciled sequence for the same subject (STATE-3). Each admitted
   snapshot is recorded as a `StateBinding` (STATE-4).
8. **Project** `S' = Project_d(S ⊕ Pending(L), A)`.
9. **Invariants.** Every lineage invariant and every principal-global invariant
   evaluates to `HOLDS`.
10. **Contributions and availability.** The domain module maps the action to
    typed worst-case contributions; Core checks each against every node on the
    charging path — the lineage, then the principal policy — that grants the
    matching dimension.
11. **Commit.** Steps 7–10 are committed at ledger version `v` by one atomic
    compare-and-swap that also writes the reservation (§6). If the ledger moved
    past `v`, the decision is recomputed at the new version; it is never
    committed against a version it did not read.
12. **Authorize.** Core emits an `ExecutionAuthorization` naming the reservation
    and its generation, and a `DecisionReceipt`. On rejection only the receipt
    is emitted; nothing is reserved.
13. **Issue-time admission.** Before issuing any artifact the adapter re-admits
    the reservation's state bindings at issue time and, where they no longer
    satisfy their policy or the policy demands it, revalidates on fresh state
    (§6a, [reservations-reconciliation.md §10a](reservations-reconciliation.md#10a-issue-time-state-admission-and-revalidation)).
14. **Bind, issue, enforce, observe, reconcile, close** — see
    [enforcement-adapters.md](enforcement-adapters.md) and
    [reservations-reconciliation.md](reservations-reconciliation.md).

A rejection reports **every** violated check, not the first, as the kernel does
today ([design §10](../mandate-design.md#10-deterministic-verification)). The one
exception is lineage and parse failure: without a valid lineage there is no `M`
to check coverage against, so evaluation stops there, and the receipt says so.

## 6. The linearization point

The single most important implementation obligation in Core:

> **The authorization decision and the reservation it creates are one atomic
> ledger transaction, conditioned on the ledger version the decision read.**

Two agents under one principal each read ledger version `v`, each evaluate,
each see enough authority. Without a single linearization point both reserve and
the principal is oversubscribed — exactly the double-reserve the kernel's replay
store already warns about ([replay-semantics.md §8](../replay-semantics.md#8-what-the-kernel-does-not-do)).
With it, the first commit moves the ledger to `v+1`, the second commit fails its
version check, and the second decision is recomputed against `v+1` and rejects
([examples.md §C](examples.md#c-multi-agent-shared-authority)).

This is also what makes **non-additive** invariants safe under concurrency. A
health-factor or leverage invariant is not a counter; it cannot be "reserved".
It is safe only because it is evaluated over `S ⊕ Pending(L@v)` and committed
at `v`: any concurrent reservation changes `v` and forces re-evaluation.

Consequences, frozen for 7C:

- one logical ledger per principal, linearizable; the physical store is a 7C
  decision, and a store that cannot provide compare-and-swap on the principal's
  ledger version is not a valid store;
- the version is principal-wide, not per dimension. Per-dimension versions
  would be faster and would silently break every invariant that reads more than
  one dimension. A finer scheme is an optimization that must prove it preserves
  this property, and is deferred;
- state snapshots are fetched **before** the commit and are part of the
  decision's inputs; the commit does not wait on I/O.

### 6a. What the linearization point does not linearize

> **CORE-CONC-1: Mandate serializes authority consumption, not external market
> state.** The compare-and-swap linearizes Mandate's internal authority state —
> grants, the principal policy, reservations, observations. It does not make
> venue, oracle, market or protocol state atomic with a Mandate decision.

```text
T0  reader fetches venue account (sequence 1,040) and mark price, observedAt T0
T1  Core projects S ⊕ Pending(L@v) ⊕ A over those snapshots
T2  decision + RESERVE commit by CAS at v → v+1           ledger-consistent
T3  the venue moves: new mark, sequence 1,041              Mandate is not told
T4  adapter is about to issue the artifact
      issue-time admission of the T0 bindings at t_i:
        still within policy, and the policy does not demand a recheck
            → ADMIT_ATTEMPT, issue
        stale or superseded, or the policy demands a recheck
            → fetch fresh state, REVALIDATE by CAS at the current version
                 PASS → ADMIT_ATTEMPT, issue with the new bindings
                 FAIL → refuse; with no attempt ever admitted, CLOSE (NEVER_ISSUED)
T5  the enforcement point executes the artifact
      after T4 the only state guarantees are what the enforcement point itself
      checks (a limit price, chain time, the gate's pinned price and measured
      deltas) and the artifact's own expiry
```

At T2 the decision is serializable with every other Mandate decision, and it
may already be wrong about the world. The specification therefore keeps four
properties apart, and never lets one stand in for another:

| Property | Question | Established by | Where |
| --- | --- | --- | --- |
| **Ledger consistency** | Was the decision made against every other reservation, grant and policy change, in one order? | CAS on the principal-wide version | [authority-ledger.md §9](authority-ledger.md#9-linearizability-and-what-it-does-not-cover) |
| **External-state freshness** | Was the state recent enough, from a trusted enough source, for this decision? | admission under the state policy at decision time, bound into the reservation as `StateBinding`s | [action-state-model.md §5](action-state-model.md#5-state-model) |
| **External-state finality** | Could the observed state still be reorganized or revised (unfinalized block, unacknowledged venue sequence)? | each state kind's minimum finality level | [action-state-model.md §5.5](action-state-model.md#55-state-bindings-freshness-modes-and-execution-dependence) |
| **Execution-time revalidation** | Does the state the decision depended on still hold when the artifact is created, and what holds after that? | issue-time admission and revalidation; after issue, only the enforcement point's own checks and artifact expiry | [reservations-reconciliation.md §10a](reservations-reconciliation.md#10a-issue-time-state-admission-and-revalidation) |

There is no universal freshness interval. A perp mark price is fresh for
seconds, a registry identity for hours, onchain state is fresh by block
distance and finality, venue order state by sequence. Each domain module
declares, per state kind, how freshness is measured, which finality is
required, whether a recheck at issue is mandatory, and whether the dependency
must still hold at execution — and grants and the principal policy can only
tighten that (STATE-4, STATE-5).

One consequence is stated plainly: an `EVALUATED` invariant — health factor,
marked exposure — is a **pre-trade condition** on the state bound at decision
and issue time. It is not a continuous guarantee; markets move afterwards. The
only continuous guarantees Core gives are over ledger quantities, which move
only by Mandate's own events and by drift evidence.

## 7. Relationship to frozen Phase 6

Phase 6 — MCE v2, Candidate V3, `MandateCodec`, `MandateExecutionGate`,
`GateArithmetic`, the fixture execution semantics, the replay and reservation
semantics and every canonical vector — is **frozen as of `dc98df5`** and is not
modified by Phase 7.

```
Mandate Core
     │
     └── EVM Execution Adapter          (7F; specified in enforcement-adapters.md §4.1)
             │  derives one MCE v2 mandate + Candidate V3 per reservation generation
             │  drives the kernel replay record and admitAttemptUnderReservation
             │  turns observationFromGateEvidence into Core observations
             │
             └── Phase-6 MandateExecutionGate   (unchanged bytecode, unchanged semantics)
```

| Core concept | Phase 6 counterpart |
| --- | --- |
| Authority grant (root or delegation) | none — Phase 6 has no standing authority |
| `ActionIntent` | the agent's proposal that the kernel and router turn into a candidate |
| Reservation, generation *g* | one kernel replay record `RESERVED` at `reservationGeneration` 1, for a per-generation MCE v2 mandate |
| `ExecutionAuthorization` | the adapter's decision to have the per-action MCE v2 mandate signed by the principal-side key |
| `ExecutionBinding` | the MCE v2 mandate digest, Candidate V3 digest and execution terms |
| `EnforcementArtifact` | `MandateAuthorization` signature + the agent's `ExecutionAuthorization` signature |
| Observation | `observationFromGateEvidence` result, carrying the kernel generation |
| Replay key | Core: `ActionDigest` + generation; gate: mandate digest (one per generation) |

**The Phase 6 mandate is not a Core grant.** It is a single-use, per-action
execution artifact — [replay-semantics.md §3](../replay-semantics.md#3-single-use)'s
single-use decision still holds for it. Core grants are standing, bounded
authority whose quantitative dimensions are tracked by the ledger; design §21.1
listed portfolio-level mandates and delegation as not built *for the MVP*, and
§22 recorded them as future. Core v1 is that future being specified, not a
reversal of the single-use decision.

What Core does **not** do to Phase 6:

- generalize `CanonicalMandate`, `Amount`, `Price`, `TrustClass` or any Phase 6
  type by editing it. Core defines its own types in 7B; where it reuses a kernel
  type, it reuses it unchanged;
- add a field to MCE v2, Candidate V3 or either EIP-712 struct;
- change any reason code, event, error or vector.

The Phase-6 gate's guarantees become the EVM adapter's enforcement guarantees
and are not re-proven: one settlement per mandate digest, exact FILL_OR_KILL,
measured principal deltas inside the signed bound, chain time
([execution-gate.md §1](../execution-gate.md#1-scope)). Its limits become the
adapter's documented limits: fixture markets only, `REAL_MARKET` refused, no
partial fills.

## 8. Phase 1–6 lessons carried into Core

| Lesson, and where it was learned | Core rule |
| --- | --- |
| Time never restores an authorization; only an observed outcome does ([ADR 0015](../adr/0015-replay-quarantine-and-reconciliation.md)) | A reservation past its ceiling with unestablished outcome is `QUARANTINED`, never released (TIME-1) |
| Every resolution carries validated evidence; no bare `RELEASE` ([ADR 0018](../adr/0018-observed-execution-outcomes.md)) | `RELEASE` and `CONSUME` exist only as effects of an applied `Observation` (RECON-3) |
| Observations bind to a reservation generation (Phase 6R.1b) | Every observation names `(reservationId, generation)`; others are `STALE_RESERVATION_OBSERVATION` (RECON-2) |
| The reservation's ceiling bounds every attempt signed under it (Phase 6R.1a) | Every artifact's validity ends at or before the reservation's attempt ceiling (EXEC-3) |
| Rogue attempts signed outside admission cause divergence (Phase 6R.1b residual) | Artifacts are issued only by adapter-held credentials after a live reservation; the agent holds no credential that produces one (CRED-1) |
| Binding to the whole observed world made re-verification impossible ([ADR 0017](../adr/0017-layered-candidate-state-commitments.md)) | Actions reference the specific snapshots they depend on, by state kind; not a digest of everything |
| `maxNotional` compared a rounded declared value, not the true product (M-1) | Contributions are computed by the domain module from exact inputs and rounded against the actor; declared values are cross-checked, never trusted |
| Units confused spot notional with perp margin (Phase 7 planning) | Every quantity carries a kind and a unit; cross-kind arithmetic is not representable ([action-state-model.md §3](action-state-model.md#3-economic-quantities)) |
| The replay store must be atomic ([replay-semantics.md §8](../replay-semantics.md#8-what-the-kernel-does-not-do)) | One linearizable ledger per principal (§6) |
| `UNKNOWN` is a value that rejects (INV-5) | `InvariantResult.UNKNOWN`, `ExecutionStatus.UNKNOWN` and unknown state all fail closed for risk-increasing actions (FAIL-1) |
| A parser must not accept more than its encoder writes (Phase 5R) | Every Core collection has a declared bound enforced at parse, at the encoder's count width (7B) |

## 9. Concept catalogue

Each concept is specified by meaning, owner, canonical identity, mutability,
who may create it, who may consume it, its lifecycle and its security boundary.
Identities written `H(tag, x)` are keccak-256 over a domain tag and the
canonical encoding of `x`; the encoding is fixed in 7B under the discipline of
[ADR 0002](../adr/0002-canonical-mandate-encoding.md) — flat, versioned,
length-explicit, no floating point, no free text in anything a decision reads.

### Parties and authority

**Principal** — the party whose economic resources are at stake and from whom
all authority in a tree descends.
Owner: itself. Identity: `PartyId` (scheme + key, the kernel's type). Mutable:
no. Created by: exists; registered to a ledger by its first root grant.
Consumed by: lineage verification (root issuer). Lifecycle: permanent; key
rotation is a new principal in v1 (deferred). Boundary: a compromised principal
key can issue any grant — out of scope, as in Phase 6.

**Agent** — a party that proposes actions and may hold and re-delegate
authority. Owner: its operator. Identity: `PartyId`. Mutable: no. Created by:
exists; becomes a holder when a grant names it. Consumed by: actor
verification, delegation issuance. Lifecycle: holds authority only while some
grant naming it is valid. Boundary: **untrusted** — every agent output is a
proposal; an agent never holds an enforcement credential (CRED-1).

**Authority grant**, **AuthorityId** — a signed statement by an issuer giving a
holder a set of terms under a parent node. `AuthorityId = H("mandate-core/v1/authority", grant)`.
Owner: the issuer. Mutable: no — terms never change; a different grant is a
different node. Created by: the principal (root) or the holder of the parent
node (delegation). Consumed by: lineage resolution, the ledger (dimension
grants), receipts. Lifecycle: `ACTIVE` → `REVOKED` or `EXPIRED`, both terminal.
Boundary: its signature and its parent's validity; its terms are also
re-intersected at every action (AUTH-2).

**MandateId** — the `AuthorityId` of a root grant (issuer = principal, no
parent). A *Core* mandate. Not to be confused with the Phase 6 `mandateId`
label or MCE v2 mandate digest, which are EVM-adapter artifacts (§7).

**DelegationId** — the `AuthorityId` of a non-root grant.

**Revocation** — a signed statement that a node and all its descendants may not
authorize new reservations from `effectiveAt`. Identity:
`H("mandate-core/v1/revocation", revocation)`. Owner: the issuer. Mutable: no;
revocation is irreversible. Created by: the issuer of the revoked node or of any
ancestor. Consumed by: the ledger (revocation set, read at step 3). Lifecycle:
recorded once. Boundary: effective in Core at ledger commit; effective at the
enforcement point only after the adapter's revocation path (adapter-specific
latency, [enforcement-adapters.md §3](enforcement-adapters.md#3-non-bypassability)).

**Expiry** — the `expiresAt` of a grant's validity window; exclusive, as in the
kernel. Not an object; a term. Evaluated against the decision's `t` and, at the
enforcement point, against the enforcement point's own clock where it has one
(chain time for EVM).

**PrincipalPolicy**, **PolicyId** — the principal's signed statement of
principal-global dimensions, invariants and state policy, applying to every
action under every root. `PolicyId = H("mandate-core/v1/principal-policy", policy)`.
Owner: the principal. Mutable: no; replaced by a new policy with a higher
sequence. Created by: the principal only; required before the first root.
Consumed by: every decision (as the last node of every charging path), the
ledger, receipts. Boundary: AUTH-GLOBAL-1; it grants nothing
([authority-model.md §8](authority-model.md#8-principal-policy-and-principal-global-invariants)).

### Domains and resources

**DomainId** — identifies a domain, the family of economic actions and state
a module interprets, e.g. `evm-spot`, `perp`. Owner: the Core module registry.
Identity: identifier from a closed registry. Mutable: no. Consumed by: intent
parsing, coverage, receipts.

**ModuleRef** — the exact semantic module that interprets an action and its
state: `{ domainId, moduleId, moduleVersion, moduleDigest }`, where
`moduleDigest` content-addresses the module's canonical semantics
([action-state-model.md §8.1](action-state-model.md#81-module-identity-and-binding)).
Owner: the module registry, under change control. Mutable: no; any semantic
change is a new version with a new digest. Created by: a module release.
Consumed by: the intent, grants (allowed modules), the decision, the
reservation, the binding, reconciliation and every receipt. Boundary: DOM-2 —
fixed for the action's whole lifecycle; an unregistered module, a digest
mismatch or an implementation not registered as conforming rejects.

**ResourceId** — a namespaced reference to anything an action touches:
`(domain, resourceKind, localId)`. Kinds include market, asset, account,
recipient, venue. Identity: the tuple's canonical encoding. Mutable: no.
Created by: registries (asset, market, venue) under change control. Consumed by:
coverage checks, contribution scoping. Boundary: set-membership terms compare
`ResourceId`s exactly; nothing parses an identifier to infer behaviour
([design §23.1](../mandate-design.md#231-the-design-rules)).

**MarketId** — a `ResourceId` of kind market: `(domain, venue, instrument)`.
`BTC-PERP` on two venues is two markets. Its underlying exposure asset is
registry data with provenance, not parsed from the name.

**AssetId** — a `ResourceId` of kind asset: a canonical asset (the Phase 2
registry's canonical identity) or a token representation. Canonical identity
and token identity remain distinct types
([INV-6](../mandate-design.md#16-major-invariants)).

### Actions

**ActionIntent** — an agent's signed proposal of one economic action. Owner:
the actor. Mutable: no. Created by: the actor holding the leaf node. Consumed
by: Core (one decision per submission), the reservation it creates, receipts.
Lifecycle: proposed → rejected, or authorized → reserved (generation 1…n) →
spent or expired ([reservations-reconciliation.md §3](reservations-reconciliation.md#3-intent-replay-identity)).
Boundary: untrusted input; everything in it is checked.

**ActionDigest**, **ActionId** — `H("mandate-core/v1/action", intent without signature)`.
`ActionId` **is** the digest: an intent's identity is its content, as the MCE v2
mandate's replay key is its digest
([replay-semantics.md §2](../replay-semantics.md#2-mandate-identity-nonce-and-the-replay-key)).

**Nonce / replay identity** — the intent's `nonce` lets an actor propose two
otherwise identical actions; the replay key is `ActionDigest`, which covers it.
A spent `ActionDigest` never reserves again (REPLAY-1). Grants carry a nonce for
the same reason.

### State

**StateSnapshot**, **StateDigest**, **StateBinding** — a typed,
provenance-carrying observation of domain state; a `StateBinding` is the record
of one admitted snapshot, with the policy it was admitted under, carried by the
reservation and every receipt. `StateDigest = H("mandate-core/v1/state", envelope)`, and the
envelope commits to the payload digest. Owner: the source that produced it.
Mutable: no. Created by: state readers, from a configured `StateSource`.
Consumed by: admission, projection, invariants, receipts (by digest). Lifecycle:
admitted while within the consumer's freshness and finality requirement; superseded by a later sequence
from the same source and subject. Boundary: trust class and freshness policy
([action-state-model.md §5](action-state-model.md#5-state-model)).

**StateSource** — a configured producer of snapshots of specific state kinds
with a declared trust class. Identity: `sourceId`, resolved by configuration.
Mutable: configuration changes are versioned and recorded. Created by: the
operator under change control. Boundary: a source is admitted only for the
state kinds its configuration names.

### Constraints

**Invariant** — a typed condition that must hold over projected state. Identity:
`(invariantId, version)` plus canonical parameters. Owner: the domain module
(or Core for ledger-derived invariants). Mutable: no. Created by: a module
release (definition); a grant (instance, with parameters). Consumed by: step 9.
Boundary: evaluation is pure and total; `UNKNOWN` rejects.

**InvariantResult** — `HOLDS | VIOLATED | UNKNOWN` with reason code, observed
and bound values as typed quantities, and the snapshots read. Created by: Core
dispatching to the invariant. Consumed by: the decision and its receipt.

**Budget** — a ledger dimension with `BUDGET` accounting: consumed authority
is never restored (fees paid, action count, total capital spent), except that
an `EPOCH` budget opens a fresh, pre-signed window each epoch. **Capacity** is
the other accounting mode: consumed authority can be **restored** by final
evidence of an unwind or close, at the amount originally charged or by units
(capital at cost basis, position size). In every dimension `GRANTED` is fixed
by signature, `CONSUMED` and `RESTORED` are cumulative, and
`available = granted − consumed − reserved + restored`; profit never enters it
([authority-ledger.md §4](authority-ledger.md#4-authority-vocabulary-granted-reserved-consumed-restored-available)).

**Exposure** — a *measure*, not a single concept: committed notional (ledger,
at execution price), position size (ledger, native units) or marked exposure
(invariant, at a stated mark price and time). The three are different quantity
kinds and cannot be mixed ([action-state-model.md §3.3](action-state-model.md#33-three-meanings-of-exposure)).

### Execution

**Reservation**, **ReservationId**, generation — the ledger's hold of a
worst-case contribution for one authorized intent. `ReservationId =
H("mandate-core/v1/reservation", actionDigest, generation)`. Owner: the
ledger. Mutable: yes, only by ledger transitions (consume, release, overrun,
quarantine, close). Created by: step 11. Consumed by: reconciliation.
Lifecycle: `ACTIVE` → (`QUARANTINED`) → `CLOSED`
([reservations-reconciliation.md §4](reservations-reconciliation.md#4-reservation-state-machine)).
Boundary: LEDGER-1…4, RECON-1…3.

**ExecutionAuthorization** — Core's statement that one reservation generation
may be executed through one adapter until its attempt ceiling, under one
`ModuleRef` and the reservation's state bindings. Identity:
`H("mandate-core/v1/authorization", …)`. Mutable: no. Created by: Core at
step 12. Consumed by: exactly one adapter, to bind and issue artifacts.
Boundary: an adapter refuses to issue for an authorization whose reservation is
not `ACTIVE` at its current generation.

**ExecutionBinding** — the adapter's exact, canonical execution parameters for
an authorization, and `bindingDigest` over them. Created by: the adapter (pure).
Consumed by: artifact issuance; receipts. Boundary: EXEC-1, EXEC-2.

**EnforcementArtifact** — what the enforcement point accepts: signatures,
signed orders, permissions. Created by: the adapter's custody. Consumed by: the
enforcement point. Boundary: CRED-1, EXEC-3.

**ExecutionResult (Observation)** — a typed, provenance-carrying fact about
what an attempt did: fills, terminal status, finality level. Created by: the
adapter's observation rule over read evidence. Consumed by: reconciliation.
Boundary: RECON-2, RECON-4, idempotency by `(sourceId, eventId)`.

**Reconciliation** — the application of an observation to a reservation:
consume, release, restore, overrun or conflict. Owner: Core rule, applied
atomically by the ledger store. Boundary: RECON-1…5.

**Receipt** — hash-chained, digest-referencing evidence of every decision and
every ledger transition. Owner: the receipt store. Mutable: no, append-only.
Created by: Core. Consumed by: auditors, developers, principals, future
attestations. Boundary: RECEIPT-1…3
([receipts-provenance.md](receipts-provenance.md)).

## 10. Implementation boundary for Phase 7B

Proposed, to be confirmed by an ADR in 7B rather than decided here:

- a new package for Core types and pure rules, depending on nothing but the
  kernel's pinned hashing and signature dependencies (and possibly the kernel
  itself for `PartyId`, `Amount` and the identifier parser, reused unchanged);
- the dependency direction `core → kernel` only, never the reverse;
  `execution-gate` does not depend on Core — the EVM adapter will depend on both;
- no I/O, no clock, no model client in Core or any domain module, enforced by
  structure tests as for every existing package;
- the ledger store, readers and signers in separate packages (7C, 7E), each
  confined to its own I/O module.

Phase 7B implements types, canonical encodings, parsers and the pure
authority-meet, projection and contribution interfaces — not the ledger.
