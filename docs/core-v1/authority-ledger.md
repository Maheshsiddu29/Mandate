# Mandate Core v1 — Global Authority Ledger

> **Status: Phase 7A specification, DRAFT pending review. Not implemented.**
> This document fixes the ledger's semantics so that Phase 7C implements them
> rather than discovers them. Storage technology is a 7C decision; the
> properties a store must provide are fixed here.

## Contents

1. [Purpose and scope](#1-purpose-and-scope)
2. [Constraint taxonomy](#2-constraint-taxonomy)
3. [Dimensions](#3-dimensions)
4. [Authority vocabulary: granted, reserved, consumed, restored, available](#4-authority-vocabulary-granted-reserved-consumed-restored-available)
5. [Events](#5-events)
6. [Charging paths](#6-charging-paths)
7. [Balance equations](#7-balance-equations)
8. [The availability check](#8-the-availability-check)
9. [Linearizability, and what it does not cover](#9-linearizability-and-what-it-does-not-cover)
10. [Overrun](#10-overrun)
11. [Drift](#11-drift)
12. [Revocation and expiry](#12-revocation-and-expiry)
13. [Storage and trust](#13-storage-and-trust)
14. [What the ledger does not do](#14-what-the-ledger-does-not-do)

---

## 1. Purpose and scope

The ledger is the single place where quantitative authority is accounted for:
what has been granted, what is held by in-flight actions, what has been
consumed, what has been restored. It exists because **no agent can determine
global availability from its own counters**: an agent sees what it did, not what
its siblings, its parent, another authority root or the same principal's
actions in another domain did.

- **One logical ledger per principal.** It holds the principal's
  `PrincipalPolicy`, every authority tree of that principal, their grants,
  their revocations, every reservation, every position lot and every applied
  observation.
- **Cross-domain by construction.** A dimension is scoped by economic attributes
  (asset, market, account, domain), not by enforcement adapter, so an EVM spot
  buy and a perp margin posting can charge the same `capital` dimension.
- **Cross-root through the principal policy.** Two authority roots never charge
  each other's dimensions, and both are charged by the principal policy's
  principal-global dimensions
  ([authority-model.md §8](authority-model.md#8-principal-policy-and-principal-global-invariants)).
- **Accounting, not valuation.** The ledger stores exact quantities in stated
  kinds and units. It does not mark positions to market
  ([action-state-model.md §3.3](action-state-model.md#33-three-meanings-of-exposure)).
- **Internal, not external.** The ledger linearizes Mandate's authority state.
  It does not make venue, oracle, market or protocol state atomic with it (§9).

## 2. Constraint taxonomy

Only one of the seven kinds of authority term is a ledger counter. Forcing the
others into counters loses their meaning:

| Term kind | Example | Additive? | Where enforced | Ledger role |
| --- | --- | --- | --- | --- |
| Quantity | capital 1,200 USDG; 50 actions | yes | availability check against charging-path legs | **counter** |
| State invariant | health factor ≥ 1.5; marked exposure ≤ 20,000 USD | no | evaluated over `S ⊕ Pending(L@v)` | supplies `Pending(L)` and the version |
| Set membership | allowed markets, recipients | no | coverage | none |
| Boolean right | `OPEN_RISK`, `TRANSFER_OUT` | no | coverage | none |
| Per-action bound | max order leverage 3x | no | coverage against the action's parameters | none |
| Temporal | validity window | no | lineage validity | none |
| Revocation state | node revoked | no | lineage validity | **record** — the revocation set lives in the ledger so it is read at the same version as reservations |

Which authority dimensions are additive and how:

| Dimension | Nature | Mechanism |
| --- | --- | --- |
| capital | additive; capacity returns at the amount charged (cost basis) | `CAPACITY`, restoration `AS_CHARGED` |
| committed notional | additive; returns at the notional committed | `CAPACITY`, restoration `AS_CHARGED` |
| position size | signed; returns by units closed | `CAPACITY`, `NET`, restoration `UNITS` |
| marked exposure | floats with price | invariant, not a counter |
| number of actions | additive, never restored | `BUDGET`, restoration `NONE` |
| daily spend | additive, new window each epoch | `BUDGET`, restoration `EPOCH` |
| allowed markets | set membership | coverage |
| max leverage | bound | per-action bound and/or invariant |
| expiry | temporal | lineage validity |
| recipient | identity constraint | set membership |

## 3. Dimensions

A ledger dimension is granted inside an authority grant, or inside the
principal policy as a principal-global dimension:

```text
DimensionGrant {
  dimensionId   identifier, unique within its grant or policy   "capital", "btc-notional"
  kind          QuantityKind                                     exactly one
  unit          UnitCode                                         exactly one
  accounting    BUDGET | CAPACITY
  restoration   NONE | EPOCH (BUDGET);  AS_CHARGED | UNITS (CAPACITY)
  epoch         { anchor, length } | NONE                       required iff restoration = EPOCH
  sign          UNSIGNED | NET                                   NET only for signed kinds
  scope         { asset?, market?, domain?, account? }           which contributions it receives
  limit         EconomicQuantity                                 same kind and unit; for NET an absolute bound
}
```

**Accounting and restoration.** Consumption is cumulative in every dimension
(§4). What distinguishes dimensions is whether, and how, consumed capacity can
come back — and there is deliberately no universal restoration algorithm:

| Restoration | Family | What returns, and when | Examples |
| --- | --- | --- | --- |
| `NONE` | `BUDGET` | nothing, ever | action count, fees paid, realized loss, total capital ever spent |
| `EPOCH` | `BUDGET` | nothing is restored; each epoch is a fresh window of the same signed limit (§7) | daily or weekly spend |
| `AS_CHARGED` | `CAPACITY` | exactly the amount this dimension was charged for the units finally closed, pro rata by units | capital (cost basis), margin posted, committed notional |
| `UNITS` | `CAPACITY` | the units finally closed | position size in native units |

**Sign modes.**

- **`UNSIGNED`** — contributions are non-negative; the limit is a ceiling.
- **`NET`** — for signed kinds (`POSITION_SIZE`): occupancy is signed and the
  limit `L` bounds it on both sides, `−L ≤ occupancy ≤ L`. Pending increases are
  held separately per side (§7), because a resting buy and a resting sell do not
  cancel until they fill.

**Matching.** A contribution matches a dimension iff their `kind` and `unit`
are equal and every scope attribute the dimension names is present in the
contribution with an equal `ResourceId`. A dimension with an empty scope
receives every contribution of its kind and unit — this is how a root node's
`capital` dimension is global across domains within its tree, and how a
principal-policy dimension is global across trees. A dimension scoped to
canonical BTC receives contributions whose exposure asset the registry states
is canonical BTC
([action-state-model.md §2](action-state-model.md#2-identifiers)).

**Scope attributes are resolved or the action rejects (SCOPE-1).** A
contribution must carry every scope attribute its kind defines — an exposure
asset for `NOTIONAL` and `POSITION_SIZE`, a collateral asset for `MARGIN` — as a
resolved `ResourceId`. If the registry cannot state an instrument's exposure
asset, the domain module rejects with `EXPOSURE_ASSET_UNRESOLVED`; it never
emits the contribution without the attribute. Otherwise an order on a venue
whose instrument the registry does not map would match no asset-scoped
dimension and escape the BTC limit entirely
([examples.md §B](examples.md#b-cross-venue-pending-exposure)).

**No unbounded consumption (LEDGER-5).** A domain module marks a contribution
`required` when the action moves principal resources out of the principal's
direct control — capital deployed, collateral posted, debt drawn. A required
contribution that matches **no** dimension anywhere on the charging path
rejects the action with `UNBOUNDED_CONTRIBUTION`. Closed-world applies to
quantities too: a grant that says nothing about capital grants none, rather
than unlimited. Optional contributions (such as `COUNT`) are charged only where
a matching dimension exists.

## 4. Authority vocabulary: granted, reserved, consumed, restored, available

For every quantitative dimension of every node (and of the principal policy):

| Term | Meaning | Changes by | Never changes by |
| --- | --- | --- | --- |
| **GRANTED** `G` | the maximum authority explicitly created by the principal or a delegation: the dimension's signed `limit` | nothing — a different limit is a different signed grant or policy, with a different identity | profit, proceeds, price moves, yield, restoration, drift, time |
| **RESERVED** `R` | authority temporarily unavailable because an unresolved action may still consume it | `RESERVE` (up); `CONSUME` and `CLOSE` (down) | time, revocation |
| **CONSUMED** `C` | authority actually committed or used, in the dimension's own economic semantics; cumulative | `CONSUME`, `OVERRUN`, `DRIFT_ADVERSE` (all up only) | anything that would lower it |
| **RESTORED** `Rs` | previously consumed capacity returned by final evidence of an unwind, close or release; cumulative; `CAPACITY` only | `RESTORE`, `DRIFT_CORRECT` (up only) | time, profit, favorable non-final evidence |
| **AVAILABLE** `A` | derived: what a new reservation may use | — | — |

```text
A = G − C − R + Rs            with  0 ≤ Rs ≤ C  always          (LEDGER-RESTORE-1)
occupancy O = C − Rs          what is currently deployed, for CAPACITY dimensions
```

Three consequences are frozen:

- **Economic gains do not increase delegated authority implicitly
  (LEDGER-GRANT-1).** `G` changes only by a new signed grant or principal
  policy. Proceeds, profit, appreciation and yield never enter `G` or `Rs`.
  `AS_CHARGED` restores what was charged for the closed units — for capital,
  their cost basis — never what they sold for. A principal who wants profits to
  compound into authority must sign that authority; Core v1 has no mechanism
  that does it for them.
- **Restoration is not a grant.** `Rs` can never exceed `C`, so `A` can never
  exceed `G`. Restored capacity is authority that was already granted coming
  back, not new authority.
- **Restoration requires final evidence.** `RESTORE` is the effect of a final
  observation of a settled decreasing action (or of a `DRIFT_CORRECT` meeting
  the domain's reconciliation policy, §11), attributed to specific position
  lots. Nothing else restores.

Worked example ([examples.md §H](examples.md#h-profit-does-not-mint-authority)):
`capital` G = 10,000; a buy with cost basis 4,000 makes C = 4,000 and A = 6,000;
selling it all for proceeds of 5,200 restores Rs = 4,000, so A = 10,000 — not
11,200. The 1,200 is profit, reported as `PNL`, not authority. Selling it for
3,000 instead also restores 4,000: capacity is about deployment, and a loss
limit is a separate `BUDGET` of realized `PNL` loss.

### 4.1 Position lots and restoration attribution

`AS_CHARGED` and `UNITS` need to know what was charged for which units. The
ledger therefore keeps, per `(account, instrument)`, **position lots**:

```text
Lot {
  openingReservation   ReservationId, or the DRIFT_ADVERSE event for an unattributed lot
  units                open units, native
  contributions        the settled typed contributions for those units
  charged              map (node, dimension) → amount
}
```

A settled increase opens or grows a lot with its settled contributions and what
each leg was charged. The contributions are kept so that a principal-global
dimension introduced later can be initialized from what is already held
([authority-model.md §8.2](authority-model.md#82-rules)). A
settled decrease of `u` units closes lots first-in-first-out and restores, to
**the legs the lot was charged to**, `charged × u / lotUnits` rounded down; the
final unit of a lot restores its exact remainder, so no dust is lost or created.
Restoration therefore goes to the nodes that paid, never to the closing actor's
lineage: an agent cannot launder capacity into its own path by closing a
sibling's position.

### 4.2 Epoch windows

For `restoration = EPOCH`, the signed `epoch { anchor, length }` divides time
into windows, each with the full limit `G`. It is not an exception to TIME-1:
the principal signed every future window in advance, and nothing that was
reserved or consumed is released by a boundary.

- consumption is attributed to the epoch in which its reservation was committed;
- a reservation still `ACTIVE` or `QUARANTINED` at a boundary also counts as
  reserved in the new epoch until it closes (conservative in both);
- epoch boundaries are evaluated at the decision's `t`, with the same boundary
  convention as grant validity.

## 5. Events

The ledger is an append-only log of events; every balance is a fold over it.

| Event | Effect | Allowed only |
| --- | --- | --- |
| `REGISTER_POLICY` | the principal policy is set or replaced | signed by the principal ([authority-model.md §8](authority-model.md#8-principal-policy-and-principal-global-invariants)) |
| `REGISTER_GRANT` | node **GRANTED** with its dimensions | after delegation validity ([authority-model.md §6](authority-model.md#6-delegation-validity)) |
| `REVOKE` | node and subtree **REVOKED** | signed by an eligible issuer |
| `RESERVE` | reservation `ACTIVE`; amounts **RESERVED** on every leg | as the commit of a PASS decision (§9) |
| `REVALIDATE` | a reservation's state bindings replaced by fresher ones | as the commit of a PASS revalidation before issue ([reservations-reconciliation.md §10a](reservations-reconciliation.md#10a-issue-time-state-admission-and-revalidation)) |
| `ADMIT_ATTEMPT` | attempt recorded; the adapter may issue it | reservation `ACTIVE`, issue-time state admissible |
| `CONSUME` | reserved → **CONSUMED** on a leg | as the effect of an applied observation |
| `OVERRUN` | consumption beyond the leg's reserved amount | as the effect of an applied observation (§10) |
| `RESTORE` | **RESTORED** increases on the legs a lot was charged to | as the effect of a final observation of a settled decreasing contribution |
| `QUARANTINE` | reservation `QUARANTINED` | attempt ceiling passed, outcome unestablished |
| `CLOSE` | remaining reserved released; reservation `CLOSED` | as the effect of a final observation, or of a revalidation failure before any attempt was admitted |
| `CONFLICT` | reservation flagged; adapter frozen for increases | contradictory observations |
| `DRIFT_ADVERSE` | **CONSUMED** increases; drift recorded | trusted evidence of more consumption than recorded (§11) |
| `DRIFT_PENDING` | favorable discrepancy recorded; **no balance effect** | trusted but non-final evidence of less consumption than recorded (§11) |
| `DRIFT_CORRECT` | **RESTORED** increases | final evidence meeting the domain's reconciliation policy (§11) |

**EXPIRED** is not an event: a node is expired at every version evaluated at or
after its `expiresAt`. It may be recorded as a marker for operators; no rule
depends on the marker.

There is no free-standing `RELEASE`, `CONSUME` or `RESTORE` command and no
generic adjustment. Each exists only as the effect of an applied observation or
of trusted drift evidence under the rules of §11 — the lesson of
[ADR 0018](../adr/0018-observed-execution-outcomes.md), which removed `COMMIT`
and `RELEASE` from the kernel because a bare command could restore authority.
**Core v1 has no privileged function that can create authority to "fix" the
ledger.** A future manual correction path would itself need explicit signed
authority, evidence, a receipt and audit, and is deferred.

Per-leg amount states:

```text
leg.reserved   fixed at RESERVE
leg.consumed   0 → reserved, by CONSUME          (monotone)
leg.overrun    0 → …, by OVERRUN                 (monotone)
leg.remaining  = reserved − consumed             while ACTIVE / QUARANTINED
leg.released   = reserved − consumed             set once, at CLOSE; remaining becomes 0
```

## 6. Charging paths

The **charging path** of an action under leaf node `N` is `N`'s lineage
`N → … → root` followed by the principal policy. A reservation has one **leg**
for every pair `(node, dimension)` on the charging path whose dimension matches
one of the action's contributions, where the principal policy counts as the
path's last node. Legs are created, consumed, overrun, released and restored
together:

- `RESERVE` succeeds only if every leg passes the availability check; otherwise
  nothing is written;
- every `CONSUME`, `OVERRUN` and `CLOSE` applies the same amounts to every leg
  of the reservation that matches the contribution; `RESTORE` applies to the
  legs recorded on the lots being closed (§4.1).

This is what makes a child limit a ceiling rather than a partition: siblings may
be granted limits that sum to more than their parent's, and the parent's legs
stop them consuming more than the parent has. It is what makes consumption by a
grandchild visible to the institution at the root. And because every charging
path ends at the same principal policy, it is what stops an action escaping a
principal-global limit by using a different root (AUTH-GLOBAL-1).

## 7. Balance equations

For a node `n` (or the principal policy) and a dimension `d` of it, over the
events at ledger version `v`:

```text
G   = d.limit
C   = Σ consumed + Σ overrun + Σ drift_adverse        over all legs at (n, d); cumulative
Rs  = Σ restored + Σ drift_correct                     CAPACITY only; 0 for BUDGET; 0 ≤ Rs ≤ C
R   = Σ remaining of legs whose reservation is ACTIVE or QUARANTINED

UNSIGNED:        A(n, d) = G − C − R + Rs

EPOCH (BUDGET):  C_e = consumption attributed to the current epoch e
                 R_e = remaining of reservations committed in e, or still open from an earlier epoch
                 A(n, d) = G − C_e − R_e

NET:             occupancy O = C − Rs, signed
                 R⁺ = pending increases in the positive direction, R⁻ in the negative (both ≥ 0)
                 headroom⁺ = L − (O + R⁺)
                 headroom⁻ = L + (O − R⁻)
```

`A` is defined for `GRANTED` nodes and the current principal policy. A revoked
or expired node has no availability for new reservations; its `C`, `R` and `Rs`
still evolve as its outstanding reservations and lots reconcile.

Two properties the equations are chosen to have:

- **Quarantine holds authority.** `R` includes `QUARANTINED` reservations. An
  attempt whose outcome is unknown keeps its authority held — the replay
  quarantine rule of [ADR 0015](../adr/0015-replay-quarantine-and-reconciliation.md),
  generalized from one mandate to every quantity.
- **Pending reductions are not credited.** A resting sell under a `NET`
  position dimension adds to `R⁻`, not to `R⁺`; it does not free long-side
  headroom until it fills, and a decreasing action restores nothing until its
  close is final. This is PROJ-1 applied to the ledger.

## 8. The availability check

```text
AuthorityAvailable(L@v, chargingPath, contributions) ⇔
  ∀ c ∈ contributions with c.required:  ∃ (n, d) on chargingPath matching c        (LEDGER-5)
  ∧ ∀ c ∈ contributions, ∀ (n, d) on chargingPath matching c, with a = rescale_up(c.amount, d):
        UNSIGNED / EPOCH:  a ≤ A(n, d)
        NET, a > 0:        a ≤ headroom⁺(n, d)
        NET, a < 0:        |a| ≤ headroom⁻(n, d)
  ∧ no matched (n, d) is BREACHED (§10) for an INCREASE contribution
```

A rejection names every failing `(node, dimension)` with the typed `requested`,
`available` and `limit`. The reason code is `LEDGER_LIMIT_EXCEEDED`; the node
(an `AuthorityId`, or the `PolicyId` for a principal-global dimension) and the
dimension are details, not part of the code, because dimensions are grant data
rather than Core vocabulary. "Global capital limit exceeded" in the Phase 7
brief is `LEDGER_LIMIT_EXCEEDED` at a root's or the principal policy's
`capital` dimension ([examples.md §A](examples.md#a-cross-domain-capital),
[§G](examples.md#g-multiple-roots-one-principal-global-invariant)).

## 9. Linearizability, and what it does not cover

The ledger store must provide, per principal:

1. **A version.** A monotonically increasing integer; every committed event
   batch increments it by one.
2. **Compare-and-swap commit.** `commit(expectedVersion, events)` appends the
   events and increments the version iff the current version equals
   `expectedVersion`; otherwise it writes nothing and reports the current
   version.
3. **Atomic batches.** A decision's `RESERVE` with all its legs, or an
   observation's `CONSUME` + `OVERRUN` + `RESTORE` + `CLOSE`, commits entirely or
   not at all.
4. **Read-your-version.** A decision reads a consistent snapshot at one version.

The authorization decision is computed at version `v` and committed with
`expectedVersion = v`. A conflicting commit forces recomputation. This is
CONC-1, and it is the property that makes additive dimensions, principal-global
dimensions and non-additive `EVALUATED` invariants safe under concurrent agents
and concurrent roots
([architecture.md §6](architecture.md#6-the-linearization-point)).

The version is principal-wide. A store that versions per dimension, per node or
per root does not meet this specification, because an invariant can read
several dimensions, nodes and roots. Throughput is a later optimization that
must preserve CONC-1.

**What CAS does not do (CORE-CONC-1).** Mandate serializes authority
consumption, not external market state. The compare-and-swap orders Mandate's
own events — grants, reservations, observations — against each other. It does
not make a venue's order book, an oracle's price, a lending pool's utilization
or a chain's next block atomic with a Mandate decision. External state is read
before the commit, can change after it, and is bound into the decision by
provenance and freshness rather than by the ledger version
([architecture.md §6a](architecture.md#6a-what-the-linearization-point-does-not-linearize)).

Every reservation records the version it was committed at, and every receipt
names the versions it read and wrote.

## 10. Overrun

The ledger records what Core authorized and what was observed. The world can
disagree with both, and the ledger must record the truth rather than its own
expectation.

If `settle` over observed fills yields more than a leg's reserved amount — a fee
above the worst case, a venue filling beyond the order, a late fill after a
cancel was believed final — the excess is recorded as `OVERRUN`. It is not
refused: the venue already did it. Consequences:

- the leg's `C` includes the overrun, so `A` may go negative;
- the `(node, dimension)` becomes **BREACHED**: no `INCREASE` contribution can
  reserve against it or any descendant sharing the leg until `A ≥ 0` again, by
  final restoration or a new signed grant;
- the reservation's receipt carries the overrun and its evidence;
- an overrun caused by a violated adapter guarantee (fill after a "final"
  cancel) also raises `CONFLICT` and freezes the adapter for increases
  ([reservations-reconciliation.md §8](reservations-reconciliation.md#8-late-conflicting-and-duplicate-observations)).

**LEDGER-1 is stated accordingly:** everything Core *authorizes* keeps
`C + R ≤ G + Rs`. Only observed overrun or adverse drift can take a dimension
past its grant; both are always recorded, and both block further increases.

## 11. Drift

**Drift** is a difference between trusted observed economic state and
Mandate's reconciled state for the same subject and measure: an admitted
snapshot of an account (per the domain's drift-evidence policy: source, trust
class, freshness, finality) shows positions, collateral or debt that the
ledger's lots and balances do not. Activity outside Mandate causes it — the
principal trading by hand, a liquidation, funding payments, an airdrop — and so
do a wrong observation rule, a missed event, or a compromised credential.

Drift has a direction, and Core v1 treats the two directions asymmetrically.

**Adverse drift** — trusted evidence shows *more* consumption or risk than the
ledger records (ledger BTC notional 5,000; venue shows 6,000):

- `DRIFT_ADVERSE` records the difference as consumption, immediately, on every
  dimension on every charging path that could act on the subject — every node
  whose dimension scope matches the drifted subject and measure, and the
  principal policy — and opens an unattributed lot carrying those charges, so
  that a later final close of that position restores to the same legs;
- available authority can only fall (DRIFT-1); if it goes below zero the
  dimension is **BREACHED**;
- the account is flagged `DRIFTED`. The domain's drift policy states whether
  the flag also blocks risk-increasing actions on the account. For an account
  declared Mandate-exclusive (only adapter custody can act on it), it blocks by
  default: unexplained activity there is evidence that CRED-1 may be broken.

**Favorable drift** — trusted evidence shows *less* consumption or risk than the
ledger records (ledger 5,000; venue shows 3,000):

- `DRIFT_PENDING` records the discrepancy and its evidence. **No balance
  changes**; available authority does not increase (DRIFT-2);
- the discrepancy is corrected by `DRIFT_CORRECT` only when evidence meets the
  domain's declared **final reconciliation policy** — the same finality ladder
  its adapter uses for final statuses (a `FINALIZED` block for onchain state; a
  venue-final sequence for venue state), identifying which positions closed
  and at which lots — and then restores according to each dimension's
  restoration rule, within `Rs ≤ C`;
- a snapshot that merely *looks* smaller — stale, from a lagging replica, or
  wrong — can therefore never manufacture capacity. Time never resolves a
  pending discrepancy; only final evidence does (TIME-1).

In short:

```text
adverse drift    →  conservative tighten, immediately
favorable drift  →  pending correction → final evidence required → then restore
```

`BUDGET` dimensions never restore, so favorable drift never changes them;
adverse drift raises them like any consumption. No drift event changes `G`, and
none touches a reservation.

Detection tolerance per measure (zero for native quantities; a declared
rounding tolerance where a venue reports rounded values) and the drift-evidence
policy per state kind are part of each domain module, versioned with it
([action-state-model.md §8](action-state-model.md#8-the-domain-module-interface)).

## 12. Revocation and expiry

| Node status | New reservations | Outstanding reservations | Balances |
| --- | --- | --- | --- |
| `GRANTED`, in window | permitted, subject to §8 | reconcile normally | evolve |
| `REVOKED` (self or ancestor) | refused (`AUTHORITY_REVOKED`) | reconcile normally; never released by the revocation itself | evolve by observations and drift only |
| expired (self or ancestor) | refused (`AUTHORITY_EXPIRED`) | reconcile normally | evolve by observations and drift only |

Revocation writes `REVOKE` and emits an enforcement-side revocation request to
every adapter holding live artifacts under the subtree. Its latency at the
enforcement point is adapter-specific and documented per adapter.

## 13. Storage and trust

- The ledger store, and whatever applies observations and drift evidence to it,
  is in the trusted computing base, as the kernel's replay store is today
  ([replay-semantics.md §9](../replay-semantics.md#9-what-an-operator-has-to-do)).
  What it applies is decided by pure rules over evidence; it has no discretion.
- Events are hash-chained: each event batch carries the digest of the previous
  batch and the new version. A ledger state is identified by
  `(principal, version, headDigest)`, and receipts reference that triple.
- State is derivable by folding the log; any cached balance must equal the
  fold, and 7C must test that equality.
- The transition rules are pure functions over `(state, events)`, exactly as
  the kernel's `applyTransition` is over a replay record. The store's only job
  is atomicity and durability.

## 14. What the ledger does not do

- It does not value positions. Marked exposure is an invariant.
- It does not make external state atomic with its own (CORE-CONC-1).
- It does not decide what happened on a venue or chain. Adapters' observation
  rules do; the ledger applies their observations.
- It does not know domain economics. Contributions arrive typed from domain
  modules.
- It does not enforce anything at a venue. It stops Core authorizing; the
  enforcement point stops execution.
- It does not share authority across principals. Across the trees of one
  principal it shares only the principal policy's dimensions and invariants.
- It does not mint authority: not from profit, not from favorable non-final
  evidence, not by operator command.
