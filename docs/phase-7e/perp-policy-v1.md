# Phase 7E.0 — PerpPolicy v1 specification

> **Status: Phase 7E.0 specification. Not implemented.** This fixes what
> PerpPolicy v1 means economically, over Lighter's actual semantics
> ([venue-evidence.md](venue-evidence.md)), so that 7E.1 can implement it as a
> `DomainModule` under the frozen 7D contract
> ([implementation-7d.md §2](../core-v1/implementation-7d.md#2-the-domainmodule-contract)).
> Nothing here changes Core, the ledger or the control engine. Where a venue
> fact is not yet evidenced, the rule that depends on it says so.

## Contents

1. [Scope](#1-scope)
2. [Four economic quantities, never one "risk"](#2-four-economic-quantities-never-one-risk)
3. [Margin mode decision: isolated only](#3-margin-mode-decision-isolated-only)
4. [Typed actions](#4-typed-actions)
5. [Worst-case contributions and settlement](#5-worst-case-contributions-and-settlement)
6. [State requirements](#6-state-requirements)
7. [Invariants](#7-invariants)
8. [Cross-domain facts and canonical identity](#8-cross-domain-facts-and-canonical-identity)
9. [Pending-order projection](#9-pending-order-projection)
10. [Worked scenario: cancel/replace across domains](#10-worked-scenario-cancelreplace-across-domains)
11. [Customer value, feature by feature](#11-customer-value-feature-by-feature)

---

## 1. Scope

PerpPolicy v1 is the smallest perp policy that is safe on a real venue and
still useful to someone running a trading agent.

**In scope — three action types:**

| Action type | What it does on Lighter | Why it is in v1 |
| --- | --- | --- |
| `perp.placeOrder` | one `L2CreateOrder` (tx type 14): a `MARKET` IOC order, or a `LIMIT` order with IOC, GTT or post-only | the reason the module exists. Whether it opens, increases, reduces or flips a position is **derived** by the module from the order and admitted state, never declared by the agent ([action-state-model.md §4.1](../core-v1/action-state-model.md#41-the-envelope)) |
| `perp.cancelOrder` | one `L2CancelOrder` (type 15) for an order that Mandate itself placed | an agent that cannot cancel its own orders is unusable, and the agent holds no key that could (see [signer-architecture.md](signer-architecture.md)) |
| `perp.setMarketMargin` | one `L2UpdateLeverage` (type 20) setting `ISOLATED` mode and an initial margin fraction on a market where the account is **flat** | leverage and margin mode are account settings, not order fields (L-ORD-16), and only the signer's key can change them. Restricting it to flat markets matches what the venue itself allows for mode changes (L-MAR-2) and keeps a live position's margin from being re-levered under a reservation |

**Out of scope for v1**, each for a stated reason:

| Excluded | Reason |
| --- | --- |
| `L2ModifyOrder` | a modify changes the economics of an order already under a reservation — a residual-intent semantics Core v1 deliberately does not define ([reservations-reconciliation.md §3](../core-v1/reservations-reconciliation.md#3-intent-replay-identity)). A replace is a cancel plus a new intent |
| SL/TP, TWAP, grouped (OTO/OCO) and position-tied orders | their fills are triggered later by mark price or schedule, and TWAP spawns child orders (L-ORD-1, L-ORD-13). Bounding them is possible but multiplies the lifecycle cases; nothing in v1 needs them |
| `L2UpdateMargin` (add/remove isolated collateral) | removing margin raises liquidation risk without an order; adding it is a capital movement. v1 allocates margin only through fills |
| withdraw, transfer, public-pool mint/burn, stake, sub-account creation, integrator approval, account config | none is a trading action; each is a way to move collateral or change fee flows (L-TX-11). The signer refuses to sign them at all ([signer-architecture.md §4](signer-architecture.md#4-what-the-signer-will-and-will-not-sign)) |
| cross margin, unified trading accounts, non-USDC collateral | §3 |
| cancelling orders Mandate did not place | they are drift (§6) — the principal's own activity. The principal can cancel them with the L1 key (L-WD-5) |

## 2. Four economic quantities, never one "risk"

Core already refuses to add unlike quantities (UNIT-1, UNIT-2,
[action-state-model.md §3](../core-v1/action-state-model.md#3-economic-quantities)).
PerpPolicy v1 names exactly four perp quantities. None of them is called
"risk", and no rule adds one to another.

| Quantity | Core kind | Unit | Meaning on Lighter | Ledger-trackable |
| --- | --- | --- | --- | --- |
| **Position size** | `POSITION_SIZE` | the market's base unit × its contract multiplier, resolved to the canonical exposure asset (§8) | the signed netted position (L-POS-1) plus pending worst case | yes |
| **Committed notional** | `NOTIONAL`, basis `LIMIT` when reserved, `EXECUTION` when settled | the market's quote asset (USDC on Lighter mainnet) | Σ size × price paid, plus pending orders at their signed limit or worst price | yes |
| **Margin commitment** | `MARGIN` | the collateral asset (USDC), **per venue account** | collateral that becomes the isolated position's `allocated_margin` when fills occur (L-MAR-5), plus fees | yes, per venue account |
| **Marked exposure** | `GROSS_EXPOSURE` / `NET_EXPOSURE`, basis `MARK` | a declared numeraire (USD) | held plus pending position valued at one admitted mark | **no** — evaluated only |

What these are **not**:

- Committed notional is not marked exposure. A 0.04 BTC buy reserved at a
  100,000 limit commits 4,000 USDC of notional whatever the mark does
  afterwards; its marked exposure at a 90,000 mark is 3,600 USD.
- Margin commitment is not notional. At an initial margin fraction of 10 %
  the same order commits about 400 USDC of margin. Margin is capital at risk
  of liquidation; notional is the size of the bet.
- **Spot notional and perp margin are never added.** A principal-global
  capital budget that wants to count both must name two dimensions, one
  `NOTIONAL` or `CAPITAL` and one `MARGIN`, each with its own limit. Core
  makes the sum unrepresentable (a dimension accepts one kind and unit,
  [authority-ledger.md §3](../core-v1/authority-ledger.md#3-dimensions)); v1
  adds no converter.
- USDC is not USD. A global USD marked-exposure invariant spanning Lighter
  (USDC-quoted) and an EVM USDG-quoted market needs each quote unit either
  valued with provenance or declared as a settlement assumption in the grant
  (UNIT-3). PerpPolicy v1 declares nothing implicitly.

## 3. Margin mode decision: isolated only

**Decision: PerpPolicy v1 supports `ISOLATED` margin only. Cross margin is not
supported.**

Evidence:

- Lighter supports isolated margin per (account, market) (L-MAR-1), treats
  an isolated position "as a separate account" for liquidation (L-MAR-5), and
  forbids switching mode while the market has a position or open order
  (L-MAR-2). A real isolated model exists; nothing is faked.
- Cross margin would couple every position through shared collateral,
  unrealized PnL and liquidation ordering (L-POS-3, L-LIFE-8). Its margin
  consumption depends on every other position's mark, which v1 has no
  ledger-trackable way to express.

Two venue facts make the isolation **weaker than its name**, and v1 states
the consequence rather than hiding it:

1. **Fees can leak from cross.** "If needed, we automatically transfer from
   cross margin to keep the position healthy" (L-MAR-6). An isolated position
   can therefore draw on the account's cross balance.
2. **Open orders reserve no collateral** (L-MAR-7). Margin is committed only
   at fill, in an amount the documentation does not state (L-MAR-8, E-7).

Consequence and mitigation — **one dedicated sub-account per Mandate perp
domain**:

- The principal creates a sub-account (L-ACC-1) used for nothing else, funds
  it with no more collateral than the perp domain may use, and registers only
  the signer's key on it ([signer-architecture.md §3](signer-architecture.md#3-credential-model)).
- The sub-account's collateral is then the hard cap on what even a leaking
  isolated position, or a compromised signer trading within its allowlist, can
  put at risk — the same role the funded account balance plays for the EVM
  adapter's option B
  ([enforcement-adapters.md §4.1](../core-v1/enforcement-adapters.md#41-evm-execution-adapter--the-frozen-phase-6-gate)).
- `perp.isolatedOnly` (§7) refuses any increase while **any** market in the
  sub-account holds a cross position or cross open order, so there is no
  cross exposure for the leak to be coupled with.

What remains weaker: an isolated position's loss is bounded by the
sub-account's collateral, not by its own `allocated_margin`. The margin
dimension (§7) bounds what Mandate *authorizes*; the funded balance bounds
what the venue can *take*.

## 4. Typed actions

The payloads normalize Lighter's economics into Mandate's types. They do not
mirror Lighter's JSON: venue integers are converted to typed quantities using
admitted market metadata, and every signer-owned field is absent.

```text
PerpVenueAccount {
  venue          LIGHTER                         closed vocabulary; v1 has one venue
  chainId        uint32                          Lighter L2 chain id (304 mainnet, 300 testnet — L-ACC facts, S2)
  accountIndex   uint48                          the dedicated sub-account
}

PerpMarketRef {
  marketIndex    uint16                          Lighter market_index
  instrument     InstrumentId                    registry id; resolves to canonical exposure asset (§8)
  metadataDigest bytes32                         the admitted orderBookDetails snapshot it was built against
}

PerpOrderAction {                                action type perp.placeOrder
  account        PerpVenueAccount
  market         PerpMarketRef
  side           BUY | SELL
  size           POSITION_SIZE                   > 0; exact multiple of the market's size step
  priceBound     Price (quote per base)          LIMIT: limit price; MARKET: signed worst acceptable price (L-ORD-6)
  execution      MARKET_IOC | LIMIT_IOC | LIMIT_GTT | LIMIT_POST_ONLY
  reduceOnly     bool                            venue-enforced (L-ORD-8); never relied on by Core for authority
  orderExpiry    UnixMillis | NONE               required iff LIMIT_GTT or LIMIT_POST_ONLY; 5 min … 30 days ahead (L-ORD-4)
  marginMode     ISOLATED                        v1's only value; checked against state, not signed (L-ORD-16)
  maxInitialMarginFraction  Ratio                the agent's stated leverage floor; checked against the market setting
}

PerpCancelAction {                               action type perp.cancelOrder
  account        PerpVenueAccount
  market         PerpMarketRef
  order          ReservationRef                  the Mandate reservation whose live order is to be cancelled
}

PerpSetMarketMarginAction {                      action type perp.setMarketMargin
  account        PerpVenueAccount
  market         PerpMarketRef
  marginMode     ISOLATED
  initialMarginFraction  Ratio                   ≥ the market's minimum fraction (L-MAR-3)
}
```

**Deliberately not in any payload** — the signer assigns and binds them at
`ADMIT_ATTEMPT` ([attempt-lifecycle.md](attempt-lifecycle.md)), because an agent
that chose them could collide, replay or redirect:

| Field | Assigned by | Why not the agent |
| --- | --- | --- |
| `ApiKeyIndex`, `Nonce`, `SkipNonce` | signer's nonce allocator | the nonce slot is the replay and non-execution primitive (L-TX-4, L-TX-5) |
| `ExpiredAt` | signer: `≤ min(attemptCeiling, now + policy)` | it bounds when the tx can execute (L-TX-7, EXEC-3) |
| `ClientOrderIndex` | signer: derived from the attempt id | uniqueness scope is unknown (L-ORD-9, E-6); it is a lookup key, not an idempotency guarantee |
| integrator account and fees | fixed nil | a non-nil integrator diverts fees (L-TX-12) |
| self-trade behaviour and equality mode | fixed explicit value per module version | the venue default changed once already (L-ORD-14); an implicit default would let the venue change the order's semantics |
| `order_version` attribute | not used in v1 | modify is out of scope |

`PerpCancelAction` names the Mandate reservation, not a venue order index.
The signer resolves it to the `client_order_index` it bound, so an agent
cannot use a cancel to probe or cancel orders Mandate did not place.

## 5. Worst-case contributions and settlement

`contributions(action, S)` at reservation — rounded against the actor
(UNIT-4). Let `q` be `size` in canonical base units and `p` the `priceBound`.

| Dimension | BUY increasing long, or SELL increasing short | Order that only reduces (derived from admitted position and pending set) |
| --- | --- | --- |
| `POSITION_SIZE` | `+q` on the side it increases | none reserved; `RESTORE` by units at final close |
| `NOTIONAL` (committed) | `ceil(q × p)` | none reserved |
| `MARGIN` | `ceil(q × p × imf) + ceil(q × p × maxTakerFeeRate)`, `imf` = the market's admitted initial margin fraction, fee rate from admitted metadata | none reserved |
| `COUNT` (optional budget) | 1 | 1 |

- **Flip.** An order larger than the opposite position is split by the
  module into its reducing part (nothing reserved) and its increasing part
  (reserved in full). The agent's `reduceOnly` claim is not what decides this;
  the admitted position is.
- **Market orders.** A `MARKET_IOC` order is bounded by its signed worst price
  (L-ORD-6); it is reserved exactly as a limit order at that price.
- **Price-dependent venue checks are not credit.** The fat-finger band
  (L-ORD-15) and order-margin check (L-MAR-7) may refuse an order; Core never
  reserves less because they might.

`settle(action, fills, S)` at each observation, monotone in the fill set
(SETTLE-MONO):

- `POSITION_SIZE` = Σ fill sizes on the increasing side;
- `NOTIONAL` = Σ `ceil(fill size × fill price)`;
- `MARGIN` = Σ `ceil(fill size × fill price × imf)` + Σ actual fees.

The margin rule is the documented relation (L-POS-3, L-MAR-3) but **how much
Lighter actually moves into `allocated_margin` per fill is not documented**
(L-MAR-8, E-7). Until E-7 is evidenced, reconciliation compares the observed
`allocated_margin` change against `settle`'s value, and any excess is drift
([authority-ledger.md §11](../core-v1/authority-ledger.md#11-drift)) that
freezes increases on the dimension. Consumption above the reservation is
overrun, never a refusal ([reservations-reconciliation.md §6](../core-v1/reservations-reconciliation.md#6-consumption-arithmetic)).

## 6. State requirements

Each requirement is declared by the module and tightenable only
([action-state-model.md §5.5](../core-v1/action-state-model.md#55-state-bindings-freshness-modes-and-execution-dependence)).
**No freshness number is fixed here**: the module declares a default, and the
grant and principal policy tighten it. What the venue facts *do* fix is which
freshness **mode** is possible and which `atExecution` mode is honest.

| State kind | Source (Lighter) | Trust | Freshness mode | Sequence / version available? | Finality | At issue | At execution |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `perp.marketMetadata` — size/price decimals, min amounts, min IMF, fees, status, market type, base/quote asset ids, multipliers | `orderBookDetails` (L-ORD-7), pinned by digest in the registry | `VERIFIED` | `VERSION(digest)` with an age cap | only the digest Mandate pins | change-controlled registry entry | `WITHIN_POLICY` | `ENFORCED_BY_ARTIFACT` for price and size integers — with the residual that a venue change of decimals between issue and execution would change what a signed integer means |
| `perp.markPrice` | `market_stats` channel / `orderBookDetails.mark_price` (L-POS-4) | `VERIFIED` | `AGE` | **none** — timestamp only | as published | `RECHECK` | `NOT_REQUIRED` for GTT and post-only orders (see below); IOC may use `BOUNDED_BY_FRESHNESS` when the policy's max age exceeds the tx `ExpiredAt` window |
| `perp.accountPositions` — per market: signed position, entry, margin mode, IMF, allocated margin | `account` REST or `account_all` WS (L-POS-2) | `VERIFIED` | `AGE` + ledger-consistency (below) | **no account-level sequence** (L-OBS-1); trades and orders carry `block_height` | soft-final (sequencer) | `RECHECK` | `NOT_REQUIRED` at Core level — see "custody-held settings" |
| `perp.openOrders` | `accountActiveOrders` / `account_all_orders` (L-OBS-2) | `VERIFIED` | `AGE` + every open order maps to a Mandate reservation | per-order `block_height`, `order_version` | soft-final | `RECHECK` | `NOT_REQUIRED` — pending orders are held by the ledger |
| `perp.accountCollateral` — collateral, available balance, cross/isolated split | `user_stats` / `account` (L-OBS-1, L-OBS-2) | `VERIFIED` | `AGE` | none | soft-final | `RECHECK` | `NOT_REQUIRED` |
| `perp.orderState` (reconciliation only) | `tx` by hash, `account_tx`, `account_orders`, `accountOrders` | `VERIFIED` (`AUTHORITATIVE` only at `VERIFIED` finality, if E-1 holds) | by finality level, not age | tx `sequence_index`, `block_height`; order `order_version` | see [reconciliation-evidence.md §2](reconciliation-evidence.md#2-finality-ladder) | — | — |

Why these modes:

- **No `SEQUENCE` freshness for account state.** Lighter publishes no
  account version (L-OBS-1), so STATE-3 ("not older than the ledger's
  watermark") cannot be established by comparing sequence numbers. v1
  replaces it with a **ledger-consistency check**: an account snapshot is
  admitted only if every fill the ledger has applied for that account is
  provably included in it — by fill id in the same `account_all` message, or by
  `block_height` at or below the snapshot's highest included trade (which
  depends on E-11). A snapshot that cannot be shown to include an applied fill
  is **not rejected but counted conservatively**: the fill is treated as still
  pending (§9), which can only over-count.
- **Mark price cannot bound a GTT artifact.** Lighter's minimum order expiry is
  5 minutes (L-ORD-4); a mark price policy of seconds cannot expire a resting
  order with its state (`BOUNDED_BY_FRESHNESS` would force every GTT to be
  refused). The price dependency that matters for authority is carried by the
  signed limit price (`ENFORCED_BY_ARTIFACT(priceBound)` for committed
  notional and margin). Marked-exposure invariants over a GTT order are
  therefore **pre-trade conditions** (`NOT_REQUIRED`), re-established at issue
  by `RECHECK`, and stated as such in the receipt — exactly the case
  [examples.md §F](../core-v1/examples.md#f-external-state-changes-after-the-ledger-cas)
  already documents.
- **Custody-held settings.** The market's margin mode and IMF matter at
  execution, but nothing in the order artifact checks them (L-ORD-16) and they
  cannot expire with a freshness bound. They hold because the only key that
  can change them is the signer's, and the signer refuses `setMarketMargin`
  while any Mandate order in that market is live
  ([signer-architecture.md §4](signer-architecture.md#4-what-the-signer-will-and-will-not-sign)).
  Core's `atExecution` vocabulary has no mode for "held by exclusive custody
  of the only credential that can change it". v1 records `NOT_REQUIRED` — what
  *Core* guarantees — and the adapter descriptor records the stronger
  adapter-level guarantee and its assumption (no other key on the
  sub-account). Whether Core v2 should name this mode is open question Q-7 in
  [README.md](README.md#open-questions). No frozen semantics change.
- **Foreign open orders are drift.** An open order in the sub-account that no
  `ACTIVE` or `QUARANTINED` reservation accounts for was placed outside
  Mandate (by the principal's L1 key, or a key that should not exist). Its
  worst case is unknown to the ledger, so every increase refuses until it is
  resolved.

## 7. Invariants

Every invariant answers three questions. An invariant that could not was
dropped (bottom of the table).

| Invariant | Mechanism | Real failure it prevents | Can the venue or a wallet already guarantee it? | Why Mandate owns it |
| --- | --- | --- | --- | --- |
| **Allowed markets** (coverage over `target`/`resources`, not a new invariant) | Core coverage | an agent trading a market the principal never approved — a prelaunch, RWA or futures-rolled market (L-MAR-10) with different economics | no — Lighter keys are not market-scoped (L-ACC-6) | only Mandate sees the action before the key signs |
| `perp.isolatedOnly` | `EVALUATED` over `accountPositions` + `openOrders` | a new position joining a cross-margined book, coupling its liquidation to every other position (L-POS-3, L-LIFE-8) | no — the venue offers modes, not a lock | a mode is an account setting any key-holder can change |
| `perp.maxLeverage` | per-action bound on `setMarketMargin` and `EVALUATED` over the market's admitted IMF | an agent running a position at the venue's maximum (50× on BTC, L-MAR-3), where a 1–2 % move liquidates | only the market cap, not the principal's | the principal's appetite differs from the venue's ceiling |
| `perp.positionSize` per canonical asset | `LEDGER_BACKED` `POSITION_SIZE`, `CAPACITY`, restored by units | size accumulating across agents and orders regardless of price | no | the only price-free bound; cross-agent |
| **Committed notional** per canonical asset | `LEDGER_BACKED` `NOTIONAL`, `CAPACITY`, restored as charged | pending plus filled dollars exceeding a budget during cancel/replace races (§10) | no — Lighter's order margin is a placement check, not a reservation (L-MAR-7) | needs the pending set across agents and domains |
| **Margin commitment** per venue account | `LEDGER_BACKED` `MARGIN`, `CAPACITY` | several agents sharing one funded sub-account together committing more collateral than the principal allotted to each | **partly** — the sub-account's funded balance caps the total (§3) | only needed when the funded balance is shared; for one agent on one sub-account it is redundant and may be omitted |
| `core.markedExposure` (existing Core invariant) | `EVALUATED`, principal-global | held plus pending BTC exposure across Lighter and an EVM spot domain exceeding a USD budget at the current mark | no single venue sees the other | cross-domain by construction |
| `perp.allowedExposureDirection` (`LONG_ONLY` / `SHORT_ONLY` / `BOTH`) | `EVALUATED` over the derived post-fill position side | a hedging agent that must only short BTC-PERP flipping the book long | no | direction is derived from state, which only the module sees |

Considered and **not** in v1:

| Candidate | Why not |
| --- | --- |
| daily realized-loss stop | realized PnL is only known after reconciliation (7F); a stop that reads unreconciled PnL is a guess |
| liquidation-distance floor | depends on Lighter's liquidation price model and all positions' marks; the leverage bound plus isolated mode captures most of it without re-implementing the venue |
| max slippage | already enforced by the signed `priceBound` (L-ORD-6) |
| max open orders | the venue enforces its own caps (L-RL-4); Mandate's count budget covers the rest |
| funding-cost cap | funding is not caused by an action (L-POS-5); it belongs to drift and reporting |

## 8. Cross-domain facts and canonical identity

PerpPolicy exposes, per canonical exposure asset, the quantities Core's
cross-domain invariants read
([action-state-model.md §6](../core-v1/action-state-model.md#6-projection)):

| Fact | Kind | Source |
| --- | --- | --- |
| held position | `POSITION_SIZE`, signed | admitted `accountPositions`, scaled by the instrument multiplier |
| pending worst-case position | `POSITION_SIZE` | the ledger's `ACTIVE` and `QUARANTINED` reservations under this module |
| committed notional | `NOTIONAL` | ledger dimension |
| margin allocated | `MARGIN`, per venue account | ledger dimension; never summed with spot capital |

**A market resolves to its economic asset through the registry, never by
symbol.** Lighter's own metadata shows why a ticker cannot be trusted:

- `KSHIB`, `KBONK`, `KPEPE` are markets whose unit is **1,000** of the token
  (the contract `multiplier` in `orderBookDetails`, L-ORD-7) — one contract
  is not one SHIB;
- RWA markets can track a futures price with a documented roll mechanism
  (S12, "Futures Contract Price Rolling Mechanism") — their underlying is a
  futures contract, not spot;
- market ids no longer partition perps from spot; the SDK warns that deriving
  the type from the id "is broken" (S13 `create_order.go` comment), so the type
  comes from admitted metadata;
- the same symbol exists on Lighter mainnet and on the Robinhood Chain
  deployment (S15), with different collateral (L-MAR-9).

So v1 adds, through the registry's change-controlled claims
([ADR 0005](../adr/0005-canonical-asset-identity-and-resolution.md),
[ADR 0006](../adr/0006-representation-claims-and-conflict-policy.md)), a claim
per supported market:

```text
PerpInstrumentClaim {
  instrument        InstrumentId
  venue             LIGHTER, chainId, marketIndex
  kind              LINEAR_PERP
  underlying        canonical AssetId            e.g. canonical BTC — not the string "BTC"
  quote / collateral canonical AssetId           USDC on mainnet
  contractMultiplier  exact decimal              base units of underlying per contract unit
  sizeDecimals, priceDecimals
  metadataDigest    digest of the admitted orderBookDetails entry
  evidence          source, observedAt, reviewer
}
```

A market without a reviewed claim is not authorizable: its exposure asset is
`UNKNOWN`, and every invariant that reads it refuses (FAIL-1).

## 9. Pending-order projection

For canonical asset `a`, the conservative projection (PROJ-1,
[ADR 0026](../adr/0026-worst-case-projection-over-pending-reservations.md)) of
long exposure for a proposed increasing BUY is:

```text
projectedLong(a) =   max(0, heldPosition(a))                           admitted snapshot, all venues
                   + Σ reserved − consumed over ACTIVE and QUARANTINED   every domain, every agent
                     reservations that increase long a
                   + Σ consumed fills not provably in the snapshot       §6 ledger-consistency rule
                   + q(new order)
```

and symmetrically for short. Nothing reduces it:

- **pending reducing orders are not credited** — a resting SELL may never
  fill;
- **a cancel request credits nothing.** A `perp.cancelOrder` that has been
  signed, submitted or even acknowledged leaves the target reservation
  `ACTIVE` with its remaining worst case pending. Only a final observation at
  the adapter's finality level
  ([reconciliation-evidence.md §3](reconciliation-evidence.md#3-cancellation-finality))
  releases it;
- **`QUARANTINED` reservations stay pending** — an attempt whose outcome is
  unknown is counted as if it may still fill in full.

Committed notional uses the same pending set at the reserved prices;
marked exposure values the projected position at one admitted mark
(`core.markedExposure`).

## 10. Worked scenario: cancel/replace across domains

**Setup.** Principal policy: `core.markedExposure`, scope canonical BTC, all
domains, `GROSS_EXPOSURE ≤ 5,000.00 USD`. Admitted mark 100,000.00 USD/BTC,
USDC declared to settle USD in the grant (UNIT-3). No BTC held anywhere.

| t | Event | Lighter reservation R1 | Pending BTC (all domains) | Marked projection for next proposal |
| --- | --- | --- | --- | --- |
| t0 | Agent A: `perp.placeOrder` BUY 0.04 BTC-PERP, LIMIT GTT at 100,000 | reserved: 0.04 BTC, 4,000 USDC notional | 0.04 | — |
| t1 | order acknowledged, resting (`open`) | `ACTIVE`, `SUBMITTED` | 0.04 | — |
| t2 | Agent A: `perp.cancelOrder` for R1 — signed and submitted, HTTP 200 | **unchanged** | 0.04 | — |
| t3 | Agent B (or A through the EVM spot adapter) proposes BUY 0.04 BTC spot | — | 0.04 | `(0.04 + 0.04) × 100,000 = 8,000 > 5,000` → **VIOLATED, refused** |
| t3′ | the same agent proposes BUY 0.01 BTC instead | — | 0.04 | `(0.04 + 0.01) × 100,000 = 5,000 ≤ 5,000` → holds |
| t4 | Lighter: fill f1, 0.015 BTC at 100,000 (trade id, soft-final) | fills applied: consumed 0.015 BTC, 1,500 USDC | 0.04 (0.015 held + 0.025 still pending) | unchanged — a fill moves pending to held |
| t5 | Lighter: cancel tx executed; order `canceled`, filled 0.015, remaining 0.025 | still `ACTIVE` until the finality level | 0.04 | unchanged |
| t6 | cancel and fill observations reach the release finality level, with the complete fill set {f1} | `CLOSED`, `CANCELLED`: **consume** 0.015 BTC / 1,500 USDC; **release** 0.025 BTC / 2,500 USDC | 0.015 (held) | `0.015 × mark` + new |

The second action at t3 is refused because the first order is **unresolved**,
not because it filled: after the cancel request and even after HTTP 200 the
order could still execute in full. Remaining authority at t3 is exactly
1,000 USD of marked exposure (t3′).

At t6 the committed-notional ledger consumes 1,500 and releases 2,500.
Marked exposure has nothing to "consume": it is not a ledger counter. The
0.015 BTC now held enters every later evaluation through the admitted
position snapshot, valued at that decision's mark.

**Evidence required to reach t6** (reconciliation itself is 7F):

1. the fill: `trade_id` of f1, its `size`, `price`, fee and `tx_hash`, and its
   order id and client order index matching the attempt;
2. the cancellation: the cancel transaction by the hash the signer bound,
   `status` executed, no `AppError`, event `CancelOrder` naming the order
   (L-LIFE-5) — **or** an order record with a `canceled*` status;
3. the order's final quantities: `filled_base_amount = 0.015` and
   `remaining_base_amount = 0.025` (L-LIFE-3), equal to the sum of the fill set;
4. all of it at the finality level the adapter declares for `CANCELLED`
   ([reconciliation-evidence.md §2](reconciliation-evidence.md#2-finality-ladder)).

HTTP 200 on the cancel, the order's absence from `accountActiveOrders`, and a
`not found` from `accountOrders` (which forgets inactive orders after 24 h or
1,000 orders, L-OBS-4) are **none** of these.

## 11. Customer value, feature by feature

This is the test each feature had to pass. "Workaround" is what builders of
perp trading agents do today with Lighter's SDK: the key goes into the bot's
process (S14 examples construct `SignerClient` from a private key in the same
script that decides trades).

| Feature | Real problem | Common workaround | Why prompts do not solve it | Why a local wallet/key limit does not fully solve it | What Mandate adds |
| --- | --- | --- | --- | --- | --- |
| **Credential isolation** | the bot holds a key that can place any order, withdraw to the owner (L-WD-1), move collateral to sibling sub-accounts (L-WD-3) and put it in public pools (L-WD-4) | trust the bot; hope it is not prompt-injected | a prompt is advice to the component that holds the key | Lighter has no trading-only scope for ordinary keys (L-ACC-6) | the agent holds no key; the signer signs only allowlisted, authorized order types |
| **Cross-agent pending exposure** | two strategies on one account each assume the budget is theirs | one sub-account per strategy with a static split — idle capital | agents do not see each other's in-flight orders | a per-key or per-account cap does not see orders in flight elsewhere | one ledger counts every agent's pending worst case |
| **Cancel/replace race** | "cancel then place" assumes the cancel freed the budget; on a Standard account cancels carry a 300 ms speed bump (L-RL-7) during which both can fill | sleep-and-hope, or over-provision | timing is not a reasoning problem | the venue refuses nothing — open orders reserve no collateral (L-MAR-7) | the old order stays pending until final evidence (§9, §10) |
| **Cross-venue aggregate exposure** | a BTC basis or hedge across EVM spot and Lighter perps must stay within one BTC budget | spreadsheet or after-the-fact monitoring | an agent can misreport its own positions | each venue sees only itself | `core.markedExposure` over every domain's held and pending positions |
| **Partial fills** | budgets drift when "filled some, cancelled the rest" is booked by hand | end-of-day reconciliation | — | — | exact consumption per fill and release of only the proven-dead remainder (7F) |
| **Audit and provenance** | after a loss, nobody can say which agent, under which authority and which state, placed which order | logs | logs are written by the component under audit | venue history shows orders, not authority | receipts binding authority, state, module, adapter and artifact hash (7H) |
| Margin-commitment dimension | several agents sharing one funded sub-account | separate sub-accounts | — | the funded balance caps the total but not each agent's share | per-agent share of one funded account — **useful only in the shared case** |
| Allowed direction | a hedging agent must not go net long | code review of the bot | — | — | a derived-direction invariant; **narrow, but cheap and real for hedgers** |
