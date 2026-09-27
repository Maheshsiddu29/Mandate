# Mandate Core v1 — Global Authority Ledger

> **Status: Phase 7A specification, DRAFT pending review. Not implemented.**
> This document fixes the ledger's semantics so that Phase 7C implements them
> rather than discovers them. Storage technology is a 7C decision; the
> properties a store must provide are fixed here.

## Contents

1. [Purpose and scope](#1-purpose-and-scope)
2. [Constraint taxonomy](#2-constraint-taxonomy)
3. [Dimensions](#3-dimensions)
4. [Events and statuses](#4-events-and-statuses)
5. [Path charging](#5-path-charging)
6. [Balance equations](#6-balance-equations)
7. [The availability check](#7-the-availability-check)
8. [Linearizability](#8-linearizability)
9. [Overrun, drift and adjustment](#9-overrun-drift-and-adjustment)
10. [Revocation and expiry](#10-revocation-and-expiry)
11. [Storage and trust](#11-storage-and-trust)
12. [What the ledger does not do](#12-what-the-ledger-does-not-do)

---

## 1. Purpose and scope

The ledger is the single place where quantitative authority is accounted for:
what has been granted, what is held by in-flight actions, what has been
consumed, what has been released. It exists because **no agent can determine
global availability from its own counters**: an agent sees what it did, not what
its siblings, its parent, or the same principal's actions in another domain did.

- **One logical ledger per principal.** It holds every authority tree of that
  principal, their grants, their revocations, every reservation and every
  applied observation.
- **Cross-domain by construction.** A dimension is scoped by economic attributes
  (asset, market, account, domain), not by enforcement adapter, so an EVM spot
  buy and a perp margin posting can charge the same `capital` dimension.
- **Accounting, not valuation.** The ledger stores exact quantities in stated
  kinds and units. It does not mark positions to market (§3,
  [action-state-model.md §3.3](action-state-model.md#33-three-meanings-of-exposure)).

## 2. Constraint taxonomy

Only one of the seven kinds of authority term is a ledger counter. Forcing the
others into counters loses their meaning:

| Term kind | Example | Additive? | Where enforced | Ledger role |
| --- | --- | --- | --- | --- |
| Quantity / budget | capital 1,200 USDG; 50 actions | yes | availability check against path legs | **counter** |
| State invariant | health factor ≥ 1.5; marked exposure ≤ 20,000 USD | no | evaluated over `S ⊕ Pending(L@v)` | supplies `Pending(L)` and the version |
| Set membership | allowed markets, recipients | no | coverage | none |
| Boolean right | `OPEN_RISK`, `TRANSFER_OUT` | no | coverage | none |
| Per-action bound | max order leverage 3x | no | coverage against the action's parameters | none |
| Temporal | validity window | no | lineage validity | none |
| Revocation state | node revoked | no | lineage validity | **record** — the revocation set lives in the ledger so it is read at the same version as reservations |

Which authority dimensions are additive and how:

| Dimension | Nature | Mechanism |
| --- | --- | --- |
| capital | additive, restorable when capital returns | `CAPACITY` dimension, `CAPITAL` |
| notional exposure | signed/net or gross, and valued | committed notional: `CAPACITY` of `NOTIONAL`; position: `NET` `POSITION_SIZE`; marked: invariant |
| number of actions | additive, never restored | `BUDGET` of `COUNT` |
| allowed markets | set membership | coverage |
| max leverage | bound | per-action bound and/or invariant |
| expiry | temporal | lineage validity |
| recipient | identity constraint | set membership |

## 3. Dimensions

A ledger dimension is granted inside an authority grant:

```text
DimensionGrant {
  dimensionId   identifier, unique within the grant       "capital", "btc-notional"
  kind          QuantityKind                               exactly one
  unit          UnitCode                                   exactly one
  accounting    BUDGET | CAPACITY
  sign          UNSIGNED | NET                             NET only for signed kinds
  scope         { asset?, market?, domain?, account? }     which contributions it receives
  limit         EconomicQuantity                           same kind and unit; for NET an absolute bound
}
```

**Accounting modes.**

- **`BUDGET`** — cumulative. Consumption only ever grows. Fees paid, actions
  taken, realized loss, total capital ever spent. `RESTORE` is never applied.
- **`CAPACITY`** — occupancy of a standing quantity. Consumption grows when an
  increasing action settles and shrinks when a decreasing action settles and is
  reconciled (`RESTORE`). Capital deployed, committed notional, position size.

**Sign modes.**

- **`UNSIGNED`** — contributions are non-negative; the limit is a ceiling.
- **`NET`** — for signed kinds (`POSITION_SIZE`): occupancy is signed and the
  limit `L` bounds it on both sides, `−L ≤ occupancy ≤ L`. Pending increases are
  held separately per side (§6), because a resting buy and a resting sell do not
  cancel until they fill.

**Matching.** A contribution matches a dimension iff their `kind` and `unit`
are equal and every scope attribute the dimension names is present in the
contribution with an equal `ResourceId`. A dimension with an empty scope
receives every contribution of its kind and unit — this is how a root node's
`capital` dimension is global across domains. A dimension scoped to canonical
BTC receives contributions whose exposure asset the registry states is
canonical BTC
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
contribution that matches **no** dimension anywhere on the lineage rejects the
action with `UNBOUNDED_CONTRIBUTION`. Closed-world applies to quantities too: a
grant that says nothing about capital grants none, rather than unlimited.
Optional contributions (such as `COUNT`) are charged only where a matching
dimension exists.

**Capital restore is at cost, never at proceeds.** A spot sell restores the
cost basis of the portion closed to a `CAPACITY` capital dimension, computed by
the domain's `settle` rule; it never restores the sale proceeds. Otherwise a
profitable trade would create negative occupancy and a losing one would leave
occupancy stuck. Loss is a different constraint, expressed as a `BUDGET` of
realized `PNL` loss.

## 4. Events and statuses

The ledger is an append-only log of events; every balance is a fold over it.

| Event | Effect | Allowed only |
| --- | --- | --- |
| `REGISTER_GRANT` | node becomes **GRANTED** with its dimensions | after delegation validity ([authority-model.md §6](authority-model.md#6-delegation-validity)) |
| `REVOKE` | node and subtree **REVOKED** | signed by an eligible issuer |
| `RESERVE` | reservation `ACTIVE`; amounts **RESERVED** on every leg | as the commit of a PASS decision (§8) |
| `CONSUME` | reserved → **CONSUMED** on a leg | as the effect of an applied observation |
| `OVERRUN` | consumption beyond the leg's reserved amount | as the effect of an applied observation (§9) |
| `RESTORE` | `CAPACITY` occupancy decreases | as the effect of an applied observation of a settled decreasing contribution |
| `QUARANTINE` | reservation `QUARANTINED` | attempt ceiling passed, outcome unestablished |
| `CLOSE` | remaining reserved → **RELEASED**; reservation `CLOSED` | as the effect of a final observation |
| `CONFLICT` | reservation flagged; adapter frozen for increases | contradictory observations (§9) |
| `ADJUST` | evidence-backed occupancy correction | reconciler, with evidence (§9) |

**EXPIRED** is not an event: a node is expired at every version evaluated at or
after its `expiresAt`. It may be recorded as a marker for operators; no rule
depends on the marker.

There is no free-standing `RELEASE` or `CONSUME` command. Each exists only as
the effect of an applied observation — the lesson of
[ADR 0018](../adr/0018-observed-execution-outcomes.md), which removed `COMMIT`
and `RELEASE` from the kernel because a bare command could restore authority.

Per-leg amount states:

```text
leg.reserved   fixed at RESERVE
leg.consumed   0 → reserved, by CONSUME          (monotone)
leg.overrun    0 → …, by OVERRUN                 (monotone)
leg.remaining  = reserved − consumed             while ACTIVE / QUARANTINED
leg.released   = reserved − consumed             set once, at CLOSE; remaining becomes 0
```

## 5. Path charging

A reservation for an action under leaf node `N` has one **leg** for every pair
`(node, dimension)` such that the node is on `N`'s lineage and the dimension
matches one of the action's contributions. Legs are created, consumed,
overrun and released together:

- `RESERVE` succeeds only if every leg passes the availability check; otherwise
  nothing is written;
- every `CONSUME`, `OVERRUN`, `RESTORE` and `CLOSE` applies the same amounts to
  every leg of the reservation that matches the contribution.

This is what makes a child limit a ceiling rather than a partition. Siblings may
be granted limits that sum to more than their parent's; the parent's legs stop
them consuming more than the parent has. It is also what makes consumption by a
grandchild visible to the institution at the root.

## 6. Balance equations

For a node `n` and a dimension `d` of `n`, over the events at ledger version `v`:

```text
G  = d.limit
C  = Σ consumed + Σ overrun                         over all legs at (n, d)
     − Σ restored                                    CAPACITY only; never below 0
R  = Σ remaining of legs whose reservation is ACTIVE or QUARANTINED

UNSIGNED:   available(n, d) = G − C − R

NET:        C signed;  R⁺ = pending increases in the positive direction,
                        R⁻ = pending increases in the negative direction (both ≥ 0)
            headroom⁺  = L − (C + R⁺)
            headroom⁻  = L + (C − R⁻)
```

`available` is defined for `GRANTED` nodes. A revoked or expired node has no
availability for new reservations; its `C` and `R` still evolve as its
outstanding reservations reconcile.

Two properties the equations are chosen to have:

- **Quarantine holds authority.** `R` includes `QUARANTINED` reservations. An
  attempt whose outcome is unknown keeps its authority held — the replay
  quarantine rule of [ADR 0015](../adr/0015-replay-quarantine-and-reconciliation.md),
  generalized from one mandate to every quantity.
- **Pending reductions are not credited.** A resting sell under a `NET`
  position dimension adds to `R⁻`, not to `R⁺`; it does not free long-side
  headroom until it fills. This is PROJ-1 applied to the ledger.

## 7. The availability check

```text
AuthorityAvailable(L@v, lineage, contributions) ⇔
  ∀ c ∈ contributions with c.required:  ∃ (n, d) on lineage matching c           (LEDGER-5)
  ∧ ∀ c ∈ contributions, ∀ (n, d) on lineage matching c, with a = rescale_up(c.amount, d):
        UNSIGNED:        a ≤ available(n, d)
        NET, a > 0:      a ≤ headroom⁺(n, d)
        NET, a < 0:      |a| ≤ headroom⁻(n, d)
  ∧ no matched (n, d) is BREACHED (§9) for an INCREASE contribution
```

A rejection names every failing `(node, dimension)` with the typed `requested`,
`available` and `limit`. The reason code is `LEDGER_LIMIT_EXCEEDED`; the node
and dimension are details, not part of the code, because dimensions are grant
data rather than Core vocabulary. "Global capital limit exceeded" in the Phase 7
brief is `LEDGER_LIMIT_EXCEEDED` at the root node's `capital` dimension
([examples.md §A](examples.md#a-cross-domain-capital)).

## 8. Linearizability

The ledger store must provide, per principal:

1. **A version.** A monotonically increasing integer; every committed event
   batch increments it by one.
2. **Compare-and-swap commit.** `commit(expectedVersion, events)` appends the
   events and increments the version iff the current version equals
   `expectedVersion`; otherwise it writes nothing and reports the current
   version.
3. **Atomic batches.** A decision's `RESERVE` with all its legs, or an
   observation's `CONSUME` + `OVERRUN` + `CLOSE`, commits entirely or not at all.
4. **Read-your-version.** A decision reads a consistent snapshot at one version.

The authorization decision is computed at version `v` and committed with
`expectedVersion = v`. A conflicting commit forces recomputation. This is
CONC-1, and it is the property that makes both additive dimensions and
non-additive `EVALUATED` invariants safe under concurrent agents
([architecture.md §6](architecture.md#6-the-linearization-point)).

The version is principal-wide. A store that versions per dimension or per node
does not meet this specification, because an invariant can read several
dimensions and several nodes. Throughput is a later optimization that must
preserve CONC-1.

Every reservation records the version it was committed at, and every receipt
names the versions it read and wrote.

## 9. Overrun, drift and adjustment

The ledger records what Core authorized and what was observed. The world can
disagree with both, and the ledger must record the truth rather than its own
expectation.

**Overrun.** If `settle` over observed fills yields more than a leg's reserved
amount — a fee above the worst case, a venue filling beyond the order, a late
fill after a cancel was believed final — the excess is recorded as `OVERRUN`.
It is not refused: the venue already did it. Consequences:

- the leg's `C` includes the overrun, so `available` may go negative;
- the `(node, dimension)` becomes **BREACHED**: no `INCREASE` contribution can
  reserve against it or any descendant sharing the leg until `available ≥ 0`
  again, by `RESTORE`, `ADJUST` or a new grant;
- the reservation's receipt carries the overrun and its evidence;
- an overrun caused by a violated adapter guarantee (fill after a "final"
  cancel) also raises `CONFLICT` and freezes the adapter for increases
  ([reservations-reconciliation.md §8](reservations-reconciliation.md#8-late-conflicting-and-duplicate-observations)).

**LEDGER-1 is stated accordingly:** everything Core *authorizes* keeps
`C + R ≤ G`. Only an observed overrun can take a dimension past its grant, it is
always recorded, and it always blocks further increases.

**Drift.** Activity outside Mandate changes the principal's real state without
touching the ledger: the principal trading by hand, a liquidation, funding
payments, an airdrop. When an admitted account snapshot disagrees with the
ledger's positions for the same subject, beyond a domain-declared tolerance
that is zero for native quantities, the ledger records `DRIFT_DETECTED` for
that account, and risk-increasing actions against it reject until an `ADJUST`
resolves it.

**Adjustment.** `ADJUST` is the only way occupancy changes without an
authorized action behind it. It carries the evidence (snapshot digests,
venue event ids), it is receipted, and it is constrained:

- for `CAPACITY` dimensions it may raise or lower occupancy to match evidence;
- for `BUDGET` dimensions it may only raise consumption, never lower it;
- it never touches a reservation.

Who may perform `ADJUST`, and under which evidence rules per domain, is an open
question for 7C/7F. The default until it is answered is fail-closed: drift
blocks increases on the affected account.

## 10. Revocation and expiry

| Node status | New reservations | Outstanding reservations | Balances |
| --- | --- | --- | --- |
| `GRANTED`, in window | permitted, subject to §7 | reconcile normally | evolve |
| `REVOKED` (self or ancestor) | refused (`AUTHORITY_REVOKED`) | reconcile normally; never released by the revocation itself | evolve by observations only |
| expired (self or ancestor) | refused (`AUTHORITY_EXPIRED`) | reconcile normally | evolve by observations only |

Revocation writes `REVOKE` and emits an enforcement-side revocation request to
every adapter holding live artifacts under the subtree. Its latency at the
enforcement point is adapter-specific and documented per adapter.

## 11. Storage and trust

- The ledger store, and whatever applies observations to it, is in the trusted
  computing base, as the kernel's replay store is today
  ([replay-semantics.md §9](../replay-semantics.md#9-what-an-operator-has-to-do)).
- Events are hash-chained: each event batch carries the digest of the previous
  batch and the new version. A ledger state is identified by
  `(principal, version, headDigest)`, and receipts reference that triple.
- State is derivable by folding the log; any cached balance must equal the
  fold, and 7C must test that equality.
- The transition rules are pure functions over `(state, events)`, exactly as
  the kernel's `applyTransition` is over a replay record. The store's only job
  is atomicity and durability.

## 12. What the ledger does not do

- It does not value positions. Marked exposure is an invariant.
- It does not decide what happened on a venue or chain. Adapters' observation
  rules do; the ledger applies their observations.
- It does not know domain economics. Contributions arrive typed from domain
  modules.
- It does not enforce anything at a venue. It stops Core authorizing; the
  enforcement point stops execution.
- It does not share authority across principals, or across trees of one
  principal.
