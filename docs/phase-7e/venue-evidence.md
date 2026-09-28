# Phase 7E.0 — Perp venue evidence: Lighter

> **Status: Phase 7E.0 research record. Nothing here is implemented.** No
> transaction was sent, no order placed, no key created or used, and no
> Lighter API or RPC endpoint was contacted. Every fact below comes from
> public documentation pages and public SDK source that were read, not
> exercised. Facts that only a live, recorded observation can settle are
> marked **NEEDS RECORDED EVIDENCE** and are listed in §12.

This document is the evidence base for
[perp-policy-v1.md](perp-policy-v1.md),
[signer-architecture.md](signer-architecture.md),
[attempt-lifecycle.md](attempt-lifecycle.md),
[reconciliation-evidence.md](reconciliation-evidence.md),
[threat-model.md](threat-model.md) and [venue-fit.md](venue-fit.md). Those
documents cite claims here by id (`L-…`). A claim that is not here is not a
venue fact the design may rely on.

## Contents

1. [Sources](#1-sources)
2. [Confidence scale](#2-confidence-scale)
3. [Account and credential model](#3-account-and-credential-model)
4. [Transaction envelope, signing and nonces](#4-transaction-envelope-signing-and-nonces)
5. [Order model](#5-order-model)
6. [Order lifecycle and statuses](#6-order-lifecycle-and-statuses)
7. [Sequencing and finality](#7-sequencing-and-finality)
8. [Position model](#8-position-model)
9. [Margin model](#9-margin-model)
10. [Account state, observation channels and versions](#10-account-state-observation-channels-and-versions)
11. [Withdrawal, transfer and escape paths](#11-withdrawal-transfer-and-escape-paths)
12. [Rate limits and session facts](#12-rate-limits-and-session-facts)
13. [What still needs recorded evidence](#13-what-still-needs-recorded-evidence)

---

## 1. Sources

All accessed **2026-09-28**. Documentation pages were fetched as their
published Markdown form; the `updatedAt` stamp each page carries is recorded
so a later reader can tell whether the page has changed since. SDK
repositories were cloned read-only into a scratch directory outside this
repository and pinned by commit; nothing from them is vendored here.

| Id | Source | URL / path | Type | Version |
| --- | --- | --- | --- | --- |
| S1 | Lighter API docs — API keys | https://apidocs.lighter.xyz/docs/api-keys | official documentation | updatedAt 2026-06-17 |
| S2 | Lighter API docs — Get Started | https://apidocs.lighter.xyz/docs/get-started | official documentation | updatedAt 2026-09-24 |
| S3 | Lighter API docs — Signing Transactions | https://apidocs.lighter.xyz/docs/trading | official documentation | updatedAt 2026-08-25 |
| S4 | Lighter API docs — Data Structures, Constants and Errors | https://apidocs.lighter.xyz/docs/data-structures-constants-and-errors | official documentation | updatedAt 2026-03-09 |
| S5 | Lighter API docs — Deposits, Transfers and Withdrawals | https://apidocs.lighter.xyz/docs/deposits-transfers-and-withdrawals | official documentation | updatedAt 2026-09-20 |
| S6 | Lighter API docs — Account Types | https://apidocs.lighter.xyz/docs/account-types | official documentation | updatedAt 2026-09-26 |
| S7 | Lighter API docs — Priority Transactions | https://apidocs.lighter.xyz/docs/priority-transactions | official documentation | updatedAt 2026-07-28 |
| S8 | Lighter API docs — Multi-signature and smart wallets | https://apidocs.lighter.xyz/docs/multi-signature-wallets | official documentation | updatedAt 2026-07-18 |
| S9 | Lighter API docs — Rate Limits | https://apidocs.lighter.xyz/docs/rate-limits | official documentation | updatedAt 2026-09-23 |
| S10 | Lighter API docs — WebSocket reference | https://apidocs.lighter.xyz/docs/websocket-reference | official documentation | updatedAt 2026-08-11 |
| S11 | Lighter API reference (OpenAPI) — `tx`, `sendTx`, `account`, `accountOrders`, `accountActiveOrders`, `accountInactiveOrders`, `nextNonce`, `apikeys`, `orderBookDetails` | https://apidocs.lighter.xyz/reference/{tx,sendtx,account-1,accountorders,…} | API schema | updatedAt 2026-05-29 (`accountOrders` 2026-07-15) |
| S12 | Lighter general docs (full export): Technical Architecture, Order Types & Matching, Liquidations, Fair Price Marking, Contract Specifications, Public Pools, Prelaunch Markets, API, PnL | https://docs.lighter.xyz/llms-full.txt | official documentation | fetched 2026-09-28; no page stamp |
| S13 | `elliottech/lighter-go` — signer and transaction types | https://github.com/elliottech/lighter-go @ `9d38261d1a4cc5c7211b383ba07a4d6e41604708` (2026-09-15): `types/txtypes/*.go`, `types/tx_request.go`, `client/tx_client.go`, `signer/key_manager.go`, `web-wasm/main.go` | official SDK source | commit pinned |
| S14 | `elliottech/lighter-python` — `SignerClient` and examples | https://github.com/elliottech/lighter-python @ `a38b6405f362fc14a562fe7a97df03f3ee756bc1` (2026-09-15): `lighter/signer_client.py`, `examples/system_setup.py`, `examples/margin/*.py` | official SDK source | commit pinned |
| S15 | Lighter on Robinhood Chain API docs — API keys | https://apidocs.rh.lighter.xyz/docs/api-keys | official documentation | updatedAt 2026-08-24 |

S3 and S4 link `lighter-go` constants at an older commit (`37514ad`); the
values cited below were read at the pinned commit of S13, and agree with S3/S4
where both state them.

## 2. Confidence scale

| Level | Meaning |
| --- | --- |
| **HIGH** | Stated in official documentation **and** consistent with official SDK source or API schema |
| **MEDIUM** | Stated by one official source only (documentation, or SDK source, or schema), or a direct reading of official source whose server-side behaviour is not separately documented |
| **LOW** | Inferred from official material but not stated; or undocumented |

"Confirmed by" names which kinds of source agree: **D** documentation,
**K** SDK source, **A** API schema. No claim here rests on secondary material.

---

## 3. Account and credential model

| Id | Claim | Source | Confirmed by | Confidence |
| --- | --- | --- | --- | --- |
| L-ACC-1 | A trading account is identified by an integer **account index**. One Ethereum (L1) address owns a **master account** and may own **sub-accounts**; each has its own index. Master indices are `< 2^47`, sub-account indices `≥ 2^47`. | S2; S12 "API"; S13 `constants.go` (`MaxMasterAccountIndex`, `MinSubAccountIndex`) | D, K | HIGH |
| L-ACC-2 | Orders and other L2 transactions are signed by an **API key**: a key pair bound to one account index at one **API key index** in `0…254`. Indices `0–3` are reserved for Lighter's own web and mobile front ends (S2 says `0–1`; S1, the later-updated page, says `0–3`; S15 adds `157` on the Robinhood deployment). Index `255` is a query sentinel meaning "all keys". | S1; S2; S15; S13 `MaxApiKeyIndex = 254` | D, K | HIGH (reserved-set size: MEDIUM, sources disagree) |
| L-ACC-3 | Multiple API keys may exist per account index (up to 253 usable). Each key is scoped to exactly **one** account index; a sub-account needs its own keys. | S1; S2; S7 (`changePubKey` note) | D | HIGH |
| L-ACC-4 | Generating a key pair needs no L1 key, but **registering** it at an index (`ChangePubKey`, tx type 8) requires a signature by the account's L1 (Ethereum) key, or an L1 priority transaction from that address. | S1 "How to create API keys programmatically"; S8; S13 `change_pub_key.go` (`L1Sig` field) | D, K | HIGH |
| L-ACC-5 | **Revoking** a key is `ChangePubKey` at the same index with an all-zero public key, L1-signed. There is no separate "delete key" transaction. | S13 `web-wasm/main.go` (`SignRevokePubKey`, `GetRevokePubKeyTransaction`) | K | MEDIUM — SDK source only, not documented |
| L-ACC-6 | **API keys are not permission-scoped** in general: a key can read auth-gated data, send transactions **and process withdrawals**. | S1 "Permissions"; S15 | D | HIGH |
| L-ACC-7 | The only venue-enforced key restriction is **maker-only**: on a *premium* account, up to 251 keys per index can be restricted to post-only (ALO) orders, modifications of ALO orders, cancel and cancel-all. Front-end keys `0–3` cannot be restricted; changes have a one-hour cooldown. | S1 "Maker-only API keys"; S11 `setMakerOnlyApiKeys` | D, A | HIGH |
| L-ACC-8 | **Read-only auth tokens** (`ro:…`, 1 day – 10 years) grant auth-gated reads and cannot sign or withdraw. They are revocable (`tokens/revoke`). | S1 "Read-only Authentication"; S11 `tokens_create` | D, A | HIGH |
| L-ACC-9 | Order signing is **local**: the private key is held by the client (`KeyManager`, a 40-byte scalar) and the server receives only the signed transaction. No endpoint takes a private key. | S3; S13 `signer/key_manager.go`, `types/tx_request.go` (`Construct*Tx`) | D, K | HIGH |
| L-ACC-10 | Signatures are Schnorr over the ECgFp5 curve with a Poseidon2 (Goldilocks) message hash, not ECDSA; the Python SDK wraps a compiled `lighter-go` binary. | S3; S13 `txtypes/constants.go`, `signer/key_manager.go` | D, K | HIGH |
| L-ACC-11 | Account tier (Standard / Plus / Premium) is tied to the L1 address and shared by its sub-accounts; it sets latency, fees, sub-account count (Standard: 4) and rate limits. | S6 | D | HIGH |
| L-ACC-12 | The `account` schema has an undocumented boolean `agent_enabled`. Its meaning is not published. | S11 `account` (`DetailedAccount`) | A | LOW — meaning unknown |

## 4. Transaction envelope, signing and nonces

| Id | Claim | Source | Confirmed by | Confidence |
| --- | --- | --- | --- | --- |
| L-TX-1 | Every L2 transaction carries `AccountIndex`, `ApiKeyIndex`, `ExpiredAt` (ms), `Nonce`, `Sig`, and optional `L2TxAttributes`. | S13 `create_order.go`, `withdraw.go`, `cancel_order.go` etc. | K | HIGH |
| L-TX-2 | The signed message hash of a create-order transaction commits to: chain id, tx type, nonce, `ExpiredAt`, account index, API key index, market index, client order index, base amount, price, is-ask, order type, time in force, reduce-only, trigger price, order expiry — and, when any attribute is non-nil, a hash of the attributes (integrator account and fees, skip-nonce, cancel-all market, self-trade behaviour and equality mode, order version). | S13 `create_order.go` `Hash`, `tx_attributes.go` `AggregateTxHash` | K | HIGH |
| L-TX-3 | The **transaction hash is that message hash**, computed from the fields before signing (`SignedHash = msgHash`); it does not depend on the signature. It is therefore known before the signature exists. | S13 `types/tx_request.go` (`ConstructCreateOrderTx`) | K | HIGH |
| L-TX-4 | Nonces are **per (account, API key)**. By default the server requires `new_nonce = old_nonce + 1`. | S1; S2; S3 | D | HIGH |
| L-TX-5 | With the `SkipNonce` attribute set, a transaction may skip nonces subject to `2^47 − 1 > new_nonce > old_nonce`; nonces otherwise cap at `2^48 − 1`. | S1; S2; S3; S13 `tx_attributes.go` (`AttributeTypeSkipTxNonce`) | D, K | HIGH |
| L-TX-6 | A transaction rejected at the **API** level (syntax, or, for maker orders only, some pre-checks such as insufficient margin) does **not** advance the nonce. A syntactically valid transaction (`code=200`) that the **sequencer** later rejects **does** advance it — "except for a few edge cases e.g. when the order isn't executed by the sequencer before the `ExpiredAt` timestamps". | S3 "Handle Nonces" | D | HIGH (the edge-case list is explicitly incomplete) |
| L-TX-7 | `ExpiredAt` is the **transaction** deadline for sequencer processing. The Go SDK defaults it to *now + 10 min − 1 s* and "encourages" callers to set it explicitly. | S13 `client/tx_client.go` (`DefaultExpireTime`) | K | MEDIUM |
| L-TX-8 | `sendTx` returns `code`, `message`, `tx_hash`, `predicted_execution_time_ms`, `volume_quota_remaining`. `code=200` means the API accepted the syntax; it "does not guarantee the execution of your order". | S3; S11 `sendTx` | D, A | HIGH |
| L-TX-9 | `sendTx` also accepts an **unsigned** request parameter `price_protection` (boolean, default `true`). Its semantics are not documented. | S11 `sendTx` (`ReqSendTx`) | A | LOW — semantics unknown |
| L-TX-10 | `sendTxBatch` accepts up to 50 transactions (REST; 15 over WebSocket); all must use the same account and API key. | S4 (`AppErrMaxBatchTx`, `AppErrBatchTxMultipleOwner`); S10 | D | HIGH |
| L-TX-11 | Transaction types an API key signs **without** an L1 signature include: create/cancel/modify order, cancel-all, grouped orders, **withdraw**, **create sub-account**, create/update public pool, **mint/burn public-pool shares**, stake/unstake, **update leverage**, **update (isolated) margin**, update account config, update account asset config — and **transfer to an account under the same master** (`transfer_same_master_account`) and **approve an integrator under the same master**. Transfer to another L1 owner, `ChangePubKey` and cross-master integrator approval carry an `L1Sig`. | S13 `types/txtypes/*.go` (struct fields; only `change_pub_key.go`, `transfer.go`, `approve_integrator.go` have `L1Sig`); S14 `signer_client.py` (`sign_transfer_same_master_account`, `sign_approve_integrator_same_master_account` sign without an Ethereum key) | K | MEDIUM — the SDK exposes these paths; the sequencer's acceptance of a same-master transfer without `L1Sig` is inferred from the SDK, not documented |
| L-TX-12 | Integrator attributes (account index, taker fee, maker fee) are part of the signed hash; a non-zero fee requires an integrator index. | S13 `tx_attributes.go` `Validate` | K | HIGH |

## 5. Order model

| Id | Claim | Source | Confirmed by | Confidence |
| --- | --- | --- | --- | --- |
| L-ORD-1 | User order types: `LIMIT` 0, `MARKET` 1, `STOP_LOSS` 2, `STOP_LOSS_LIMIT` 3, `TAKE_PROFIT` 4, `TAKE_PROFIT_LIMIT` 5, `TWAP` 6. Internal: `TWAPSubOrder` 7, `LiquidationOrder` 8. | S3; S13 `constants.go` | D, K | HIGH |
| L-ORD-2 | Time in force: `IMMEDIATE_OR_CANCEL` 0, `GOOD_TILL_TIME` 1, `POST_ONLY` 2. There is no good-till-cancel without expiry. | S3; S13 | D, K | HIGH |
| L-ORD-3 | A `MARKET` order must be IOC, with no order expiry and no trigger price. A `LIMIT` IOC order has no order expiry; a `LIMIT` GTT or post-only order **must** carry an order expiry. SL/TP/TWAP orders require an expiry. | S13 `create_order.go` `Validate` | K | HIGH (client-side validation; the sequencer enforces its own) |
| L-ORD-4 | Order expiry is a millisecond timestamp between **5 minutes and 30 days** in the future. | S3 "Order Expiry"; S13 (`MinOrderExpiryPeriod`, `MaxOrderExpiryPeriod`) | D, K | HIGH |
| L-ORD-5 | A GTT order whose expiry passes while active is cancelled automatically by the exchange (status `canceled-expired`). | S12 "Order Types & Matching"; S4 (`CanceledOrder_Expired`) | D | HIGH |
| L-ORD-6 | For a **taker** order, `price` is "the worst price you're willing to accept"; if it cannot be met the order is cancelled. Market orders therefore carry a signed worst price. | S2; S3 | D | HIGH |
| L-ORD-7 | `base_amount` and `price` are integers scaled by per-market `size_decimals` / `price_decimals` from `orderBookDetails`; minimum base/quote amounts apply to **maker** orders only. | S3; S11 `orderBookDetails` | D, A | HIGH |
| L-ORD-8 | **Reduce-only** is an order flag, enforced by the venue: an order that would increase the position is refused (`AppReduceOnlyIncreasesPosition` 21732) or cancelled (`canceled-reduce-only`); a reduce-only limit order partially executes up to the position and the remainder is cancelled. | S4; S12 | D | HIGH |
| L-ORD-9 | `client_order_index` is an optional caller-chosen uint48 (`1…2^48−1`, 0 = none), "a unique (across all markets) identifier". The venue refuses a duplicate with `AppErrClientOrderIndexExists` (21728). **The scope and duration of uniqueness** (active orders only, or all history) are not documented. | S2; S3; S4; S13 | D, K | HIGH for existence; LOW for uniqueness scope |
| L-ORD-10 | Cancel (`L2CancelOrder`, type 15) names an order by market and index — client order index or venue order index. Cancelling an order that is not active fails (`AppErrInactiveCancel` 21600, `AppErrInctiveOrder` 21715). | S3; S4; S13 `cancel_order.go` | D, K | HIGH |
| L-ORD-11 | Modify (`L2ModifyOrder`, type 17) changes base amount, price and trigger price of an existing order in place. An optional `order_version` attribute makes the sequencer reject a modification whose version is not strictly greater than the stored one (`AppErrInvalidOrderOrderVersion`); order events carry `order_version`. | S3 "Order Version"; S13 `modify_order.go`, `tx_attributes.go` | D, K | HIGH |
| L-ORD-12 | Cancel-all (`L2CancelAllOrders`, type 16) supports immediate, **scheduled** (a dead-man's switch between 5 minutes and 15 days ahead) and abort-scheduled modes, optionally per market. | S13 `constants.go` (`ScheduledCancelAll`, `MinOrderCancelAllPeriod`, `MaxOrderCancelAllPeriod`); S4 (`AppErrDeadMansSwitchShouldBeTriggered`) | K, D | MEDIUM |
| L-ORD-13 | Grouped orders (OTO, OCO, OTOCO) of up to 3 orders exist (`L2CreateGroupedOrders`, type 28), and SL/TP orders can be tied to a position. | S13 `constants.go` (`MaxGroupedOrderCount`); S14 examples | K | HIGH |
| L-ORD-14 | Self-trade behaviour (expire maker / expire taker / cancel both / reduce both) and equality mode (account / master account) are signed attributes; the documented default changed to *cancel maker* on 2026-05-31. | S12 "Self-Trade Prevention"; S13 `tx_attributes.go` | D, K | HIGH |
| L-ORD-15 | Price checks: limit prices outside `min(mark, bestAsk)×1.05` (bid) / `max(mark, bestBid)×0.95` (ask) are refused (fat-finger, `AppErrPriceTooFarFromMarkPrice`). | S12 "Price Checks"; S4 | D | HIGH |
| L-ORD-16 | Leverage and margin mode are **not order fields**. They are per-(account, market) settings changed by `L2UpdateLeverage` (type 20: `InitialMarginFraction`, `MarginMode`). | S13 `create_order.go`, `update_leverage.go`; S14 `sign_update_leverage` | K | HIGH |

## 6. Order lifecycle and statuses

| Id | Claim | Source | Confirmed by | Confidence |
| --- | --- | --- | --- | --- |
| L-LIFE-1 | Order status vocabulary (numeric, API string): `InProgressOrder` 0 `in-progress` ("in register"), `PendingOrder` 1 `pending` (awaiting trigger), `ActiveLimitOrder` 2 `open`, `FilledOrder` 3 `filled`, and cancellations 4–16: `canceled`, `canceled-post-only`, `canceled-reduce-only`, `canceled-position-not-allowed`, `canceled-margin-not-allowed`, `canceled-too-much-slippage`, `canceled-not-enough-liquidity`, `canceled-self-trade`, `canceled-expired`, `canceled-oco`, `canceled-child`, `canceled-liquidation`, `canceled-invalid-balance`. | S4; S10 "Order JSON" | D | HIGH |
| L-LIFE-2 | There is **no separate "partially filled" status** and no "cancel requested" or "rejected" status. Partial execution is visible as an `open` (or cancelled) order with `filled_base_amount > 0` and `remaining_base_amount < initial_base_amount`. A sequencer rejection surfaces as a cancelled status (e.g. `canceled-margin-not-allowed`) or an `AppError` on the tx event. | S4; S10 | D | HIGH |
| L-LIFE-3 | Order records carry `order_index` (venue), `client_order_index`, `initial_base_amount`, `remaining_base_amount`, `filled_base_amount`, `filled_quote_amount`, `status`, `order_expiry`, `reduce_only`, `block_height`, `timestamp`, `created_at`, `updated_at`, `transaction_time`, `nonce`, and — on the REST `accountOrders` schema — `order_version`. | S10 "Order JSON"; S11 `accountOrders` | D, A | HIGH |
| L-LIFE-4 | Fills (trades) carry a venue `trade_id`, `tx_hash`, `size`, `price`, `usd_amount`, both order ids and client ids, `taker_fee` / `maker_fee`, `block_height`, `timestamp`, and pre-trade position data. Trade `type` is `trade`, `liquidation`, `deleverage` or `market-settlement`. | S10 "Trade JSON" | D | HIGH |
| L-LIFE-5 | Tx events decode per type: `OrderExecution {Trade, MakerOrder, TakerOrder, AppError}`, `CancelOrder {AccountId, OrderIndex, ClientOrderIndex, AppError}`, `ModifyOrder {OldOrder, NewOrder, AppError}`. | S4 "Data and Event Structures" | D | HIGH |
| L-LIFE-6 | Transaction status values: `0 Failed`, `1 Pending`, `2 Executed`, `3 Pending – Final State`. The meaning of `3` is not explained. | S4 "Transaction Status Mapping" | D | HIGH for the table; LOW for the meaning of `3` |
| L-LIFE-7 | The matching engine auto-cancels an order whose trade would make a healthy account unhealthy (or not improve an unhealthy one). | S12 "Order Margin" | D | HIGH |
| L-LIFE-8 | In **partial liquidation** the liquidation engine first **cancels all open orders** of the account, then sends liquidation IOC orders on its behalf. | S12 "Liquidations" | D | HIGH |

## 7. Sequencing and finality

| Id | Claim | Source | Confirmed by | Confidence |
| --- | --- | --- | --- | --- |
| L-FIN-1 | A **sequencer** orders transactions first-in-first-out and provides **soft finality**; it executes exchange operations and feeds API servers. | S12 "Technical Architecture" | D | HIGH |
| L-FIN-2 | Batches of executed transactions are proven by a zk prover; state-update proposals and data blobs are posted to Ethereum; state is updated on Ethereum **after the proof verifies**. | S12 "Technical Architecture" | D | HIGH |
| L-FIN-3 | Each transaction record exposes `block_height`, `sequence_index`, `transaction_index`, `queued_at`, `executed_at`, `committed_at` and `verified_at`. | S11 `tx` (`EnrichedTx`, all required) | A | MEDIUM — schema only; how and when `committed_at` / `verified_at` are populated is not documented |
| L-FIN-4 | Matching is price-time priority at the maker's price; the docs claim matching is proven by SNARKs. | S12 "Order Matching" | D | HIGH (as the venue's claim) |
| L-FIN-5 | **Escape hatch:** users can submit priority requests on Ethereum (withdrawals, pool exits, reduce-only IOC orders, cancel-all); if the sequencer does not process them in time the contract freezes and users exit with proofs over posted data. | S12 "Technical Architecture"; S7 | D | HIGH |
| L-FIN-6 | No document states that an order whose cancellation has executed can never fill afterwards, or that soft-final state cannot be reverted. Both follow from FIFO sequencing (L-FIN-1) but are **not stated**. | — (absence) | — | LOW — see §13 |

## 8. Position model

| Id | Claim | Source | Confirmed by | Confidence |
| --- | --- | --- | --- | --- |
| L-POS-1 | Positions are **netted per (account, market)**: one `position` magnitude with a `sign`. There are no separate long and short legs. | S10 "Position JSON"; S12 "Liquidations" (`pos_i`) | D | HIGH |
| L-POS-2 | A position reports `avg_entry_price`, `position_value`, `unrealized_pnl`, `realized_pnl`, `liquidation_price`, `initial_margin_fraction`, `margin_mode`, `allocated_margin`, `open_order_count`, `pending_order_count`, `position_tied_order_count`, `total_funding_paid_out`. | S10; S11 `account` | D, A | HIGH |
| L-POS-3 | Account value = collateral + Σ (mark − avg entry) × position. Margin requirements are Σ \|pos\| × mark × fraction for initial (IMR), maintenance (MMR) and close-out (CMR), with CMR < MMR < IMR per market. | S12 "Liquidations" | D | HIGH |
| L-POS-4 | Mark price = median(impact price, index + EMA-clamped premium, median of CEX marks); index price from Chainlink, Stork and Pyth. | S12 "Fair Price Marking" | D | HIGH |
| L-POS-5 | Funding is periodic (currently 1 h per market) and changes collateral without an order. | S12 "Contract Specifications", "Funding" | D | HIGH |
| L-POS-6 | Liquidation, deleveraging and market settlement change positions **without** a user transaction (trade types `liquidation`, `deleverage`, `market-settlement`). | S10; S12 | D | HIGH |

## 9. Margin model

| Id | Claim | Source | Confirmed by | Confidence |
| --- | --- | --- | --- | --- |
| L-MAR-1 | **Cross** (`0`) and **isolated** (`1`) margin modes exist, set per (account, market) through `L2UpdateLeverage`. | S13 `constants.go`, `update_leverage.go`; S14 (`CROSS_MARGIN_MODE`, `ISOLATED_MARGIN_MODE`) | K | HIGH |
| L-MAR-2 | Margin mode **cannot change on a market with an open position or open order** (`AppErrMarginModeChangeOnActivePosition` 21132). | S4 | D | HIGH |
| L-MAR-3 | Leverage is expressed as an initial margin fraction; the effective IMF is `min(user fraction, market minimum)` in the docs' wording. Per-market maximum leverage and IMR/MMR/CMR are listed (e.g. BTC: 50×, IMR 2 %, MMR 1.2 %, CMR 0.8 %). | S12 "Liquidations", "Contract Specifications" | D | HIGH for the rule; MEDIUM for the table (the page is still headed "Test Network") |
| L-MAR-4 | Default mode: the SDK and schema show `margin_mode` per position and `default_initial_margin_fraction` per market; **the default margin mode for a new position is not documented.** | S11 `orderBookDetails`; S10 | A | LOW |
| L-MAR-5 | An isolated position "is treated as a separate account"; its collateral is **AllocatedMargin**, added or removed by `L2UpdateMargin` (type 29). | S12 "Isolated Liquidations", "PnL"; S13 `update_margin.go` | D, K | HIGH |
| L-MAR-6 | **Isolation leaks for fees:** "In isolated margin, fees are taken from the isolated position itself, but if needed, we automatically transfer from cross margin to keep the position healthy." | S6 "How fees are collected" | D | HIGH |
| L-MAR-7 | **Open orders do not reserve collateral.** Each limit order consumes *order margin*, which "does not affect the position margin; it is merely a checking mechanism used only when placing new orders" and does not affect liquidations. Collateral moves only on fills. | S12 "Order Margin" | D | HIGH |
| L-MAR-8 | How much collateral is moved into `allocated_margin` when an isolated position is opened or increased by a fill is **not documented**. | — (absence) | — | LOW — see §13 |
| L-MAR-9 | Perps collateral is **USDC** in a *Simple Trading Account*; only USDC deposits to the perps route. *Unified Trading Accounts* (web-only for now) add spot USDC and haircut non-USDC assets (e.g. ETH) as margin. The Robinhood Chain deployment uses USDG. | S5; S12 "Unified Trading Accounts", "Multi-Asset Margin"; S5 deposit table | D | HIGH |
| L-MAR-10 | Public pools do not support isolated positions; prelaunch and pre-IPO markets are isolated-only. | S12 "Public Pools", "Prelaunch Markets", "Pre-IPO Markets" | D | HIGH |

## 10. Account state, observation channels and versions

| Id | Claim | Source | Confirmed by | Confidence |
| --- | --- | --- | --- | --- |
| L-OBS-1 | REST `account` returns collateral, positions, assets, total and cross asset value, cross IMR/MMR, pool shares and pending-order counts. It carries **no account-level sequence or version number**. | S11 `account` | A | HIGH |
| L-OBS-2 | WebSocket channels: `account_all`, `account_market`, `account_orders` (per market, carries a `nonce`), `account_all_orders`, `account_all_trades`, `account_all_positions`, `account_tx` (transactions, with the full tx record), `user_stats` (collateral, available balance, margin usage, leverage, buying power; timestamp only), `height`, `market_stats`, `order_book` (with `nonce`/`begin_nonce` continuity and a server-local `offset`). | S10 | D | HIGH |
| L-OBS-3 | The order-book `offset` is per API server and "can change drastically on reconnection"; continuity is checked by `begin_nonce` = previous `nonce`. `account_all` resends a full snapshot on every subscription. **No document states ordering guarantees across account channels.** | S10 "Order Book", "Account All" | D | HIGH for what is stated; LOW for cross-channel ordering |
| L-OBS-4 | `accountOrders` looks up orders by client order index (≤ 20 per call) but covers only the last 10 K active orders and the **last 1 K inactive orders within 24 hours**. | S11 `accountOrders` | A | HIGH |
| L-OBS-5 | `tx` looks up a transaction by hash or sequence index; `nextNonce` returns the next nonce for (account, API key); `apikeys` lists registered public keys. | S11 | A | HIGH |
| L-OBS-6 | Every observation is from Lighter's API servers; none is signed by the venue. The only authenticated state is what is proven to Ethereum (L-FIN-2), which the API reports as `committed_at` / `verified_at`. | S10; S11; S12 | D, A | MEDIUM |

## 11. Withdrawal, transfer and escape paths

| Id | Claim | Source | Confirmed by | Confidence |
| --- | --- | --- | --- | --- |
| L-WD-1 | An API key alone can request a **secure withdrawal**, which can only pay the **L1 address that owns the account**. | S1; S5; S13 `withdraw.go` (no destination field, no `L1Sig`) | D, K | HIGH |
| L-WD-2 | **Fast withdrawals** and **transfers to other L1 owners** additionally require the L1 key's signature. | S1; S5 | D | HIGH |
| L-WD-3 | Transfers **between accounts under the same master** are signable by an API key alone (see L-TX-11). | S14 `sign_transfer_same_master_account`; S13 `transfer.go` | K | MEDIUM |
| L-WD-4 | An API key can **mint shares** in a public pool (moving collateral into the pool) and create sub-accounts and public pools. Public-pool operators are currently whitelisted. | S13 `mint_shares.go`; S14; S12 "Public Pools" | K, D | MEDIUM |
| L-WD-5 | The L1 key can, via Ethereum priority transactions, cancel all orders, submit reduce-only IOC orders, withdraw, and change API keys. | S7 | D | HIGH |
| L-WD-6 | Smart-contract (multi-sig) owners can register API keys via priority `changePubKey` but cannot sign transfers; secure withdrawal is then the only exit. | S8 | D | HIGH |

## 12. Rate limits and session facts

| Id | Claim | Source | Confirmed by | Confidence |
| --- | --- | --- | --- | --- |
| L-RL-1 | REST limits apply per **IP and L1 address**. Standard accounts: **60 requests per rolling minute** (unweighted, including `sendTx`); Plus/Premium: 24 000 weighted/min, with `sendTx` in a separate bucket (4 000–48 000/min). Authenticated requests are counted against the L1 address only. | S9 | D | HIGH |
| L-RL-2 | Endpoint weights include `sendTx`/`nextNonce` 6, order queries 100, `apikeys` 150, `trades` 200, others 300. | S9 | D | HIGH |
| L-RL-3 | Per-transaction-type limits: default 40/min; `L2Withdraw` 2/min; `L2UpdateLeverage` 40/min; `L2Transfer` 120/min; `L2ChangePubKey` 300/min. | S9 | D | HIGH |
| L-RL-4 | Active-order limits per account / market: Standard 250 / 30; Plus 750 / 250; Premium 1 500 / 1 000. Pending (untriggered) orders: 50 / 10 on Standard. | S9 | D | HIGH |
| L-RL-5 | WebSocket: keepalive at least every 2 minutes; clients that fall behind may be disconnected; zero-downtime deployments may drop connections; 200 client messages/min, 50 in flight. | S10; S9 | D | HIGH |
| L-RL-6 | Exceeding a limit yields HTTP 429 or 405, and rate limiting on REST also limits WebSocket and vice versa; firewall cooldown 60 s. | S9 | D | HIGH |
| L-RL-7 | Latency: Standard accounts have a 300 ms taker and cancel/modify speed bump and 0 ms maker latency; Premium 140 ms taker, 0 ms maker and cancel. | S6 | D | HIGH |
| L-RL-8 | Auth tokens for signed-in reads last at most 8 hours. | S1; S2 | D | HIGH |

## 13. What still needs recorded evidence

The following cannot be settled by reading. Each is a design dependency, and
each needs a **recorded, labelled, read-only or testnet observation** before
the behaviour it gates is built. Contacting Lighter's API — even read-only —
requires explicit owner authorization, which 7E.0 did not have.

| # | Question | Gates | How to evidence |
| --- | --- | --- | --- |
| E-1 | When are `committed_at` and `verified_at` populated, and what is the typical and worst-case delay from `executed_at`? | the finality level at which releases apply ([reconciliation-evidence.md §2](reconciliation-evidence.md#2-finality-ladder)) | read-only `tx` captures across a sample of recent transactions |
| E-2 | What does tx status `3 Pending – Final State` mean? | observation parsing | ask the venue; capture examples |
| E-3 | Can an order fill after its cancel transaction has executed, or after `canceled-*` is reported? (Expected: no, by FIFO; not stated.) | the cancellation finality rule | venue confirmation in writing, plus testnet capture of cancel/fill races |
| E-4 | Does a create-order tx that misses its `ExpiredAt` leave the nonce unconsumed, and does any later nonce with `SkipNonce` make it permanently invalid? | the nonce-supersession non-execution rule ([reconciliation-evidence.md §4](reconciliation-evidence.md#4-non-execution-rules)) | testnet: sign with a short `ExpiredAt`, withhold, then advance the nonce |
| E-5 | Is a same-master transfer signed only by an API key accepted by the sequencer (L-WD-3)? | the bypass analysis | testnet with a two-sub-account setup, zero-value where possible |
| E-6 | Scope and duration of `client_order_index` uniqueness (L-ORD-9). | whether it can serve as a durable attempt key | testnet: reuse after cancel, after fill, after 24 h |
| E-7 | How much collateral moves into `allocated_margin` on an isolated fill, and when fees pull from cross (L-MAR-6, L-MAR-8). | the MARGIN contribution and its settlement | testnet fills in isolated mode with state captures before and after |
| E-8 | Default margin mode of a fresh market position (L-MAR-4). | the ISOLATED_MARGIN_ONLY precondition | testnet read of a fresh sub-account |
| E-9 | Meaning of `agent_enabled` (L-ACC-12) and `price_protection` (L-TX-9). | the credential and submission model | venue confirmation |
| E-10 | Whether a maker-only key (L-ACC-7) is refused withdraw, transfer, mint-shares and update-leverage — i.e. whether "restricted to" is exhaustive. | the hardened signer-key option ([signer-architecture.md §3](signer-architecture.md#3-credential-model)) | testnet on a premium account, or venue confirmation |
| E-11 | Cross-channel ordering of `account_tx`, `account_orders` and `account_all_trades` messages, and whether `block_height` is monotone per account across channels. | observation sequencing ([reconciliation-evidence.md §5](reconciliation-evidence.md#5-observation-model-for-7f)) | long-running read-only capture with reconnects |

## 14. Phase 7E.1 updates

Appended in Phase 7E.1; the 7E.0 tables above are unchanged. Evidence ids
refer to [testnet-evidence.md](testnet-evidence.md).

| Claim | 7E.0 confidence | 7E.1 | Evidence |
| --- | --- | --- | --- |
| L-TX-3 transaction hash = pre-signature message hash | HIGH (SDK source) | **HIGH, recorded**: 4 of 4 published testnet hashes reproduced from their fields | T-2, E-O2 |
| L-ACC-9 local signing; server never needs the key | HIGH | unchanged; our locally signed transaction was parsed by the API (refused only for the unknown account) | T-3, E-P2 |
| L-TX-7 SDK default `ExpiredAt` ≈ 10 min | MEDIUM | **HIGH**: seen in use, signing time + 599 s | T-8 |
| L-TX-4 one transaction per (account, key) nonce slot | HIGH | consistent: strictly increasing per key in observed sequence order | T-10 |
| L-FIN-3 `committed_at` / `verified_at` per transaction | MEDIUM | on testnet always 0 (fields present on `tx`, absent on `txs`) | T-5 |
| L-LIFE-6 meaning of status 3 | LOW | observed on every executed transaction; still undocumented | T-5 |
| fee rates | — (new) | trades carry a charged fee rate that differs from `orderBookDetails.taker_fee` | T-7 |
| `nextNonce` for an unknown account | — (new) | `code 200, nonce 0`: not evidence that an account exists | T-4 |
| API timestamps | — (new) | `executed_at` < `queued_at` in 83/194: not an ordering | T-6 |
| testnet chain id | S2: 300 | **HIGH, recorded**: hashes reproduce only with 300 | T-1 |
| E-3 … E-8, E-10 | open | **blocked**: no funded disposable testnet account could be created | testnet-evidence.md §2 |
