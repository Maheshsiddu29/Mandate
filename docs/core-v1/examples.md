# Mandate Core v1 — Worked examples

> **Status: Phase 7A specification, DRAFT pending review.** These are paper
> walkthroughs of the specification, not test output. Nothing here was
> executed. Venue names are placeholders: "venue L" stands for a perp venue
> such as Lighter, and no claim is made about any real venue's API, collateral
> asset, fees or finality. USDG is assumed to have 6 decimals, and the perp
> venue's collateral is assumed to be USDG. Both are assumptions of the
> examples, not evidenced facts.

Each example ends with the ambiguities it exposed and what changed in the model
because of them.

Notation: `available = limit − occupied − reserved-remaining`; limits are
inclusive (a request equal to what is available passes), matching the gate's
`maxNotional` rule.

## A. Cross-domain capital

**Setup.** Principal P, root grant R:

| Dimension | Kind | Unit | Accounting | Scope | Limit |
| --- | --- | --- | --- | --- | ---: |
| `capital` | `CAPITAL` | USDG (6) | `CAPACITY` | — (all domains) | 1,200.000000 |
| `perp-margin` | `MARGIN` | USDG (6) | `CAPACITY` | domain `perp`, collateral USDG | 1,000.000000 |
| `btc-notional` | `NOTIONAL` | USD (2) | `CAPACITY` | canonical BTC | 5,000.00 |

Per-action bound: perp order leverage ≤ 5x.

Earlier, an EVM spot BUY of the fixture fAAPL settled through the Phase 6 gate.
Its `settle` gave a `CAPITAL` contribution equal to the measured `actualDebit`:
**800.000000 USDG**. Its `NOTIONAL` contribution is scoped to canonical AAPL and
matches no dimension. Capital occupied: 800.

**Proposal.** Venue L, `BTC-PERP@L`, long 0.03 BTC at limit 100,000.00 USD/BTC,
leverage 5x, isolated margin. The `perp@1` module returns:

| Contribution | Kind | Amount | Scope | Required |
| --- | --- | ---: | --- | --- |
| margin leaving principal control | `CAPITAL` | 600.000000 USDG | — | yes |
| isolated margin | `MARGIN` | 600.000000 USDG | perp, L sub-account, USDG | yes |
| committed notional at limit | `NOTIONAL` | 3,000.00 USD | canonical BTC | no |
| position | `POSITION_SIZE` | +0.03 BTC | canonical BTC | no (no matching dimension) |

**Availability at root R:**

| Dimension | Limit | Occupied | Reserved | Requested | Available | Outcome |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `capital` | 1,200 | 800 | 0 | 600 | 400 | **fails** |
| `perp-margin` | 1,000 | 0 | 0 | 600 | 1,000 | passes |
| `btc-notional` | 5,000.00 | 0 | 0 | 3,000.00 | 5,000.00 | passes |

**Result: REJECT**, `LEDGER_LIMIT_EXCEEDED {node: R, dimension: capital,
requested: 600.000000 USDG, available: 400.000000 USDG, limit: 1,200.000000 USDG}`.
Projected capital would have been 1,400. This is the brief's
`GLOBAL_CAPITAL_LIMIT_EXCEEDED`, expressed as a Core code with the node and
dimension as data.

**Perp notional ≠ perp margin.** Same market, varying size and leverage:

| Order | Notional (`NOTIONAL`, USD) | Margin (`CAPITAL` + `MARGIN`, USDG) | Outcome |
| --- | ---: | ---: | --- |
| 0.02 BTC, 5x | 2,000.00 | 400 | PASS — capital 800 + 400 = 1,200 ≤ 1,200 |
| 0.02 BTC, 2x | 2,000.00 | 1,000 | REJECT on `capital` only: 800 + 1,000 = 1,800 > 1,200 (`perp-margin` 1,000 ≤ 1,000 passes) |
| 0.02 BTC, 10x | 2,000.00 | 200 | REJECT on the per-action leverage bound (10x > 5x), though every ledger dimension passes |

The notional is the same in all three rows and the margin is not. Leverage moves
one without the other, so they need separate limits and neither can stand in
for the other.

**The category error is unrepresentable.** "Spot notional + perp margin = risk"
would add a `NOTIONAL` in USD to a `MARGIN` in USDG. No operation adds two
quantities of different kind or unit (UNIT-1). No dimension accepts two kinds,
so no grant can declare a dimension that does. A `risk` dimension of kind
`NOTIONAL` in USD legitimately sums the spot and perp notionals. Margin never
enters it.

**Ambiguities exposed.**

1. *Is a perp's capital its order margin or the venue deposit?* Under isolated
   margin the order's margin leaves the principal's control, so it is `CAPITAL`.
   Under cross margin the whole deposit is at risk, and charging `CAPITAL` per
   order would either undercount (margin only) or double-count (deposit, then
   margin again). **Resolution:** this is a domain rule. Under cross margin,
   `CAPITAL` is charged by the deposit action, and orders charge `MARGIN` against
   a dimension scoped to the venue account and bounded by deposited collateral.
   A module never charges both for the same funds. Which mode 7E supports first
   is an open question.
2. *USDG or USD?* Capital here is USDG and no conversion is needed. A principal
   who states capital in USD needs a declared settlement assumption (UNIT-3).
   Without one the grant is refused as incomparable.
3. *Does selling the AAPL restore 800 of capital?* Under `CAPACITY` it restores
   the sold portion's cost basis, never the proceeds. A principal who wants
   "never more than 1,200 in total, ever" grants a `BUDGET`.

## B. Cross-venue pending exposure

**Setup.** Root R: `btc-notional`, `NOTIONAL` in USD (2), `CAPACITY`, scope
canonical BTC, limit **5,000.00 USD** (capital is ample and never binds here).
The registry maps both `BTC-PERP@L` and `BTC-PERP@M` (a second venue M) to
canonical BTC.

| t | Event | Reserved (remaining) | Consumed | Available | Decision |
| --- | --- | ---: | ---: | ---: | --- |
| t0 | O1 on L: buy 0.04 @ 100,000.00 → worst case 4,000.00; reservation R1 g=1 | 4,000.00 | 0 | 1,000.00 | PASS |
| t1 | L fill f1: 0.015 BTC @ 100,000.00 | 2,500.00 | 1,500.00 | 1,000.00 | — |
| t2 | agent requests cancel of O1; L acknowledges, **not final** | 2,500.00 | 1,500.00 | 1,000.00 | — |
| t3 | O2 on M: buy 0.03 @ 100,000.00 → 3,000.00 | 2,500.00 | 1,500.00 | 1,000.00 | **REJECT** |
| t4 | L: O1 `CANCELLED` at final level, executed 0.015, fills {f1} → R1 closes, releases 2,500.00 | 0 | 1,500.00 | 3,500.00 | — |
| t5 | O2 resubmitted, the same signed intent | 3,000.00 | 1,500.00 | 500.00 | PASS |
| t6 | M fills O2 fully @ 99,900.00 → `settle` 2,997.00; closes, releases 3.00 | 0 | 4,497.00 | 503.00 | — |

At t3: `1,500.00 + 2,500.00 + 3,000.00 = 7,000.00 > 5,000.00` →
`LEDGER_LIMIT_EXCEEDED {node: R, dimension: btc-notional, requested: 3,000.00,
available: 1,000.00}`.

**What the reservation prevented.** Two counterfactuals:

- *Counting only fills:* at t3 the check would be `1,500 + 3,000 = 4,500 ≤ 5,000`
  and O2 would pass. If L's cancel then lost the race and O1 filled in full, the
  principal would hold `4,000 + 3,000 = 7,000` USD of BTC notional, 2,000 over
  the limit. Neither venue could have seen the other's order.
- *Treating the acknowledgement as final:* 2,500 released at t2, O2 passes at
  t3. If O1's remainder then filled, the late fill would be an `OVERRUN` of
  2,500.00 plus a `CONFLICT`, and the dimension would be `BREACHED`
  ([reservations-reconciliation.md §8](reservations-reconciliation.md#8-late-conflicting-and-duplicate-observations)).
  This is why finality belongs to the adapter's declared evidence and not to a
  status name.

**Partial fill reconciled.** At t4 the 1,500.00 stays consumed and 2,500.00 is
released. O1's intent is `SPENT`; buying the remaining 0.025 BTC on L would be
a new intent. At t6, price improvement of 3.00 is released at close.

**Resubmission.** The t3 rejection reserved nothing, so the intent's record is
still `UNUSED`. Resubmitting the same signed intent at t5 is a new decision on
freshly admitted state, allowed while the intent's window is open.

**Ambiguities exposed.**

1. *What if the registry did not map M's instrument to canonical BTC?* The
   contribution would carry no exposure asset and would match no
   BTC-scoped dimension. O2 would pass with no BTC limit at all. **Fixed in the
   model:** SCOPE-1 requires every scope attribute to be resolved, or the action
   rejects with `EXPOSURE_ASSET_UNRESOLVED`
   ([authority-ledger.md §3](authority-ledger.md#3-dimensions)).
2. *Which "exposure"?* This example is committed notional. If the grant also
   carried a marked-exposure invariant, t3 would additionally need a fresh BTC
   mark from an admitted source. Without one, the result is `UNKNOWN` and the
   action rejects whatever the ledger says.

## C. Multi-agent shared authority

**Setup.** Principal P, root R: `capital` 1,200.000000 USDG (`CAPACITY`).
Two delegations under R, each with its own ceiling:

```text
R  capital 1,200
├── S1  SpotAgent   capital 1,000
└── Q1  PerpAgent   capital 1,000
```

The sibling ceilings sum to 2,000 > 1,200. This is permitted, because a child
limit is a ceiling and not a partition.

**Concurrent proposals, both read at ledger version 41** (everything at zero):

| Agent | Action | Legs at v41 | Local view |
| --- | --- | --- | --- |
| SpotAgent | spot BUY, worst-case debit 800 | S1: 800 ≤ 1,000 ✓; R: 800 ≤ 1,200 ✓ | "0 of my 1,000 used" |
| PerpAgent | perp isolated margin 600 | Q1: 600 ≤ 1,000 ✓; R: 600 ≤ 1,200 ✓ | "0 of my 1,000 used" |

Both decisions are PASS at v41. Then:

1. SpotAgent's commit `CAS(expected 41)` succeeds. Ledger is at v42, and R has
   800 reserved.
2. PerpAgent's commit `CAS(expected 41)` fails, because the current version is 42.
   Nothing is written.
3. PerpAgent's decision is recomputed at v42. R is now at
   `1,200 − 0 − 800 = 400 < 600`. **REJECT** `LEDGER_LIMIT_EXCEEDED {node: R,
   dimension: capital, requested: 600, available: 400}`. Q1's own availability
   is still 1,000. The receipt names R as the binding node, so PerpAgent learns
   that its parent, not its own ceiling, stopped it.

PerpAgent's local counter ("0 of 1,000 used") was true and irrelevant. No
agent can determine global availability from its own state.

**Without the linearization point** (a read-then-write store), both commits
land. R then has 1,400 reserved against 1,200, and LEDGER-1 is violated. That is
the mutation CONC-1's test must catch.

**Continuation.** SpotAgent's buy settles at an actual debit of 790.000000.
790 is consumed, 10 is released, and R has 410 available. PerpAgent proposes
margin 400 (0.02 BTC at 5x), which passes and leaves R with 10.

**Ambiguities exposed.**

1. *Overbooked siblings:* decided. Ceilings, with path charging, rather than
   partitions ([authority-model.md §4](authority-model.md#4-the-meet-how-a-childs-authority-is-bounded-by-its-parents)).
2. *Fairness and starvation:* the first committer wins. A long-resting order
   with a long attempt ceiling can hold root capacity that its siblings cannot
   use. v1 has no priority or queueing. The mitigations are per-node ceilings
   and per-domain bounds on attempt-ceiling length. Whether a principal needs
   priority between agents is an open question.

## D. Hierarchical delegation

**Root R0** — Institution I (the principal):

| Term | Value |
| --- | --- |
| window | 2026-10-01T00:00Z → 2027-01-01T00:00Z |
| domains / adapters | `perp@1`, `evm-spot@1` / `venue-signer-L@1`, `evm-gate@1` |
| markets | `BTC-PERP@L`, `ETH-PERP@L`, `fAAPL@evm` |
| recipients | I's EVM account, I's venue-L sub-account |
| rights | `OPEN_RISK`, `REDUCE_RISK`, `DELEGATE`, depth 2 |
| bound | perp order leverage ≤ 5x |
| invariant | `perp.accountLeverage ≤ 4x` |
| state policy | `perp.markPrice` max age 10 s |
| `capital` | 10,000 USDG |

**D1: R0 → TradingAgent T.** It restates every bound, invariant and
state-policy term and narrows: window ends 2026-12-15; depth 1; leverage bound
5x; `accountLeverage ≤ 4x`. It adds `core.markedExposure(canonical BTC, gross)
≤ 20,000 USD` and sets `capital` 6,000. Registered.

**D2 (bad): T → PerpAgent P**, refused at registration with every violation
reported:

| Attempted term | Rejection |
| --- | --- |
| window ends 2027-01-31 | `DELEGATION_WIDENS_WINDOW` |
| markets add `SOL-PERP@L` | `DELEGATION_WIDENS_SET` (market) |
| recipients add external address X | `DELEGATION_WIDENS_SET` (recipient) |
| rights add `TRANSFER_OUT` | `DELEGATION_WIDENS_RIGHT` |
| `DELEGATE` with depth 1 (T's depth is 1, so a child's must be 0) | `DELEGATION_DEPTH_EXCEEDED` |
| leverage bound 10x | `DELEGATION_WIDENS_BOUND` |
| `accountLeverage ≤ 6x` | `DELEGATION_WEAKENS_INVARIANT` |
| omits `markedExposure` | `DELEGATION_DROPS_INVARIANT` |
| `capital` 8,000 | `DELEGATION_WIDENS_LIMIT` |

**D2 (good): T → P.** Window ends 2026-12-01; domain `perp@1`; adapter
`venue-signer-L@1`; market `BTC-PERP@L`; recipient I's L sub-account; rights
`OPEN_RISK`, `REDUCE_RISK`; depth 0; leverage bound 3x; `accountLeverage ≤ 3x`;
`markedExposure ≤ 20,000 USD` restated; `markPrice` max age 5 s; `capital`
4,000. Registered.

**Actions by P.**

1. *Sibling consumption binds at the parent.* T's other child, a SpotAgent, has
   5,500 capital occupied under T. P proposes `BTC-PERP@L` long, 3x, isolated
   margin 900 (notional 2,700.00). Legs: P `900 ≤ 4,000` ✓; T
   `6,000 − 5,500 = 500 < 900` ✗; R0 `10,000 − 5,500 = 4,500` ✓.
   **REJECT** `LEDGER_LIMIT_EXCEEDED {node: T, dimension: capital}`. At margin
   450 (notional 1,350.00) it passes, with legs at P, T and R0.
2. *Coverage by the meet.* An `ETH-PERP@L` order is refused
   (`ACTION_NOT_COVERED`, market): the meet of R0 ∩ T ∩ P's markets is
   `{BTC-PERP@L}`.
3. *Defence in depth.* Suppose a faulty registration had admitted P with a 10x
   leverage bound. An 8x order still rejects (`BOUND_EXCEEDED`, leverage), because
   the effective bound is `min(5x, 5x, 10x) = 5x`. AUTH-2 does not rest on
   registration alone.
4. *Revocation of an ancestor.* I revokes D1 at ledger version 90. P's own grant
   was never revoked, but its lineage contains T, so every P action from v90 is
   `AUTHORITY_REVOKED` (node T). P's resting 450-margin order keeps its
   reservation. Its fills after v90 are consumed normally, because the
   reservation is still `ACTIVE`, not overrun. The adapter is asked to cancel
   all orders in T's subtree, and it closes on the final cancel.
5. *Expiry.* From 2026-12-01 P's node is expired, even though T's runs to
   2026-12-15.

**Ambiguities exposed.**

1. *Inherited or refused?* `authority-model.md` said both that a parent term
   absent from a child is "inherited" and that a child dropping an invariant is
   refused. **Fixed in the model:** a delegation must restate every parent bound,
   invariant and state-policy term, and is refused if it omits one. Sets and
   rights are closed-world, so absence already narrows. Ledger dimensions are
   charged along the path and need no restatement. The action-time meet is an
   independent second defence
   ([authority-model.md §4](authority-model.md#4-the-meet-how-a-childs-authority-is-bounded-by-its-parents)).
2. *Who closes P's position after T is revoked?* Not P or T. In v1 a revoked
   node authorizes nothing, including reductions. The institution acts under
   R0. Whether a narrow reduce-only exception should exist is an open question.
3. *Same instrument name, different venue:* `BTC-PERP@L` and `BTC-PERP@M` are
   different `MarketId`s. A market allowlist never matches by name.

## E. EVM retry, and a stale observation (Phase 6 reused)

**Setup.** Intent I1: spot BUY of fixture fAAPL through the EVM adapter. The
worst-case capital contribution is 2,010.000000 USDG.

| Step | Core | Kernel / gate (unchanged) |
| --- | --- | --- |
| 1 | reserve I1, g=1, ceiling c1 | adapter derives fresh `M_1` (`expiresAt ≤ c1`); kernel `RESERVE` on `M_1`; attempt A1 admitted and signed |
| 2 | — | A1 is never included |
| 3 | final block past c1, `M_1` unconsumed → observation `FAILED` (g=1) → `CLOSE`, 2,010 released, I1 `UNUSED` | `observationFromGateEvidence`: `FAILED`, basis `MANDATE_EXPIRED` |
| 4 | reserve I1, g=2, ceiling c2 | fresh `M_2`, new nonce; attempt A2 admitted |
| 5 | an observer holding a stale copy re-derives `FAILED` for g=1 → `STALE_RESERVATION_OBSERVATION`; nothing moves | — |
| 6 | A2 settles; observation `EXECUTED` (g=2), one fill with `actualDebit` 2,006.000000 → consume 2,006, release 4; I1 `SPENT` | `MandateExecuted` at `FINALIZED` |
| 7 | — | A1 resubmitted: `MandateExpired`. A2 resubmitted: `MandateAlreadyConsumed` |

Step 5 is the Phase 6R.1b failure, one level up. The Core generation check
refuses it before anything else is looked at. Step 7 needs no Core logic, because
the gate already guarantees it.

**Ambiguity exposed.** Should a Core retry re-reserve the old `M_1` (kernel
generation 2) or derive a new `M_2`? A new `M_2`. The kernel record for `M_1`
then only ever sees one reservation. `M_1`'s own `expiresAt` makes it provably
dead at a final block. Nothing depends on the kernel and Core counters agreeing
([reservations-reconciliation.md §11](reservations-reconciliation.md#11-correspondence-with-the-phase-6-replay-machine)).
