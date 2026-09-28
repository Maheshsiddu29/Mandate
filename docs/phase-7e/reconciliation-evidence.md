# Phase 7E.0 — Reconciliation evidence for Lighter

> **Status: Phase 7E.0 specification. Reconciliation is 7F and is not
> implemented.** This defines what the 7F reconciliation engine will need
> from Lighter: the finality ladder, what proves an order can no longer
> execute, the non-execution rules, and the observation vocabulary. It uses
> Lighter's own terms; Core's `ExecutionStatus` is reached through an explicit
> mapping, never by string-matching a venue status.

## Contents

1. [Principles](#1-principles)
2. [Finality ladder](#2-finality-ladder)
3. [Cancellation finality](#3-cancellation-finality)
4. [Non-execution rules](#4-non-execution-rules)
5. [Observation model for 7F](#5-observation-model-for-7f)
6. [Sequence, versions and out-of-order delivery](#6-sequence-versions-and-out-of-order-delivery)
7. [Drift sources](#7-drift-sources)
8. [Read budget](#8-read-budget)

---

## 1. Principles

- **Final is a property of evidence, not of a status name**
  ([reservations-reconciliation.md §2](../core-v1/reservations-reconciliation.md#2-execution-is-not-atomic)).
  Lighter's `canceled` string is an input to a rule, not a verdict.
- **Every observation names its object and its finality level.** An order's
  status at `SEQUENCED` and the same status at `VERIFIED` are two
  observations with two event ids (§5), so a finality upgrade is new
  evidence, not a conflicting duplicate.
- **Fills are applied by `trade_id`, exactly once, whatever order they
  arrive in**; statuses are applied only above the attempt's watermark.
- **Absence is not evidence.** "Order not found", an order missing from
  `accountActiveOrders`, an empty channel, or elapsed time proves nothing
  (L-OBS-4 shows `accountOrders` forgets inactive orders after 24 h or 1,000
  orders).

## 2. Finality ladder

| Level | Rank | Lighter evidence | What it establishes |
| --- | --- | --- | --- |
| `ACKED` | 0 | `sendTx` `code = 200` with the expected `tx_hash` (L-TX-8) | the API accepted the syntax; **nothing** about execution |
| `SEQUENCED` | 1 | the tx record by hash has `status = 2 Executed` with `executed_at`, `block_height`, `sequence_index` (L-FIN-3, L-LIFE-6); or order/trade events carrying its `tx_hash` and `block_height` | the sequencer processed it — Lighter's **soft finality** (L-FIN-1) |
| `COMMITTED` | 2 | the tx record's `committed_at` is set | the containing state update was posted to Ethereum (L-FIN-2) |
| `VERIFIED` | 3 | the tx record's `verified_at` is set | the proof covering it verified on Ethereum and the contract's state root moved (L-FIN-2) |

Where each Core status may be applied:

| Core status | Minimum level | Why |
| --- | --- | --- |
| `SUBMITTED` | `ACKED` | informational |
| `PARTIALLY_EXECUTED` (consume fills) | `SEQUENCED` | consuming early only ever holds **more** authority; a fill later contradicted is a `CONFLICT`, not an under-count |
| `EXECUTED`, `CANCELLED`, `EXPIRED`, `FAILED` (anything that **releases**) | **`VERIFIED`** by default | a release frees authority other actions may then spend; it should rest on the strongest evidence the venue offers |

**The release level is `VERIFIED` until evidence justifies less.** Lowering
it to `SEQUENCED` — trusting soft finality — would roughly remove the
Ethereum proving delay from every release. It requires (a) E-1: the observed
delay between `executed_at` and `verified_at`, to know what is being traded
away; (b) E-3: written venue confirmation that a sequenced cancellation or
terminal status is never reverted and no fill follows it; and (c) an ADR
accepting the sequencer as trusted for this purpose, as it already is for
matching and custody. Until then, liveness is spent to keep safety.

If `verified_at` turns out not to be populated reliably (E-1), the ladder has
no usable top level, `VERIFIED` is unreachable, and every release waits
indefinitely — a liveness failure that would force the ADR above. It is not
a reason to release on less evidence silently.

## 3. Cancellation finality

**What evidence proves a Lighter order can no longer execute?** All of the
following, for the order identified by the attempt's `client_order_index`
and venue `order_index`, at the release finality level:

1. **A terminal order status**: `filled`, or one of the thirteen `canceled*`
   statuses (L-LIFE-1) — including `canceled-expired` for a GTT order past
   its `OrderExpiry` and `canceled-liquidation`. `in-progress`, `pending` and
   `open` are never terminal.
2. **Carried by the sequenced transaction that caused it**: the cancel
   transaction the signer bound (by `txHash`) executed with a `CancelOrder`
   event naming the order and no `AppError` (L-LIFE-5); or the order's own
   create transaction whose `OrderExecution` event leaves it terminal (IOC,
   market, sequencer rejection); or the event that expired or
   liquidation-cancelled it.
3. **With the complete fill set**: `filled_base_amount` equals the sum of the
   sizes of the trades attributed to the order, each known by `trade_id`
   (L-LIFE-3, L-LIFE-4), and `filled + remaining = initial`.

What is **not** evidence that an order cannot execute:

| Not evidence | Why |
| --- | --- |
| HTTP 200 / `code = 200` on the cancel | the API accepted syntax only (L-TX-8) |
| the cancel tx is `SEQUENCED` but carries `AppErrInactiveCancel` / `AppErrInctiveOrder` | the order was *already* inactive — terminal by some other event, which must itself be observed with its fill set |
| the order is absent from active orders, or `accountOrders` returns nothing | retention limits (L-OBS-4); channel gaps (L-OBS-3) |
| `OrderExpiry` has passed | the exchange cancels expired orders (L-ORD-5), but the terminal `canceled-expired` status is what proves it |
| the attempt ceiling has passed | time never decides an outcome (TIME-1) |
| a liquidation is known to have occurred | liquidation cancels open orders (L-LIFE-8); each order's terminal status is still required |

Two further facts matter and are **not yet evidenced** (E-3): that no fill
can be sequenced after a sequenced cancellation of the same order, and that
soft-final state is never reverted. Both follow from FIFO sequencing
(L-FIN-1) but are not stated by the venue. The default `VERIFIED` release
level does not depend on the second; the first is what makes the rule above
correct at all, and a violation would surface as a late fill after `CLOSED`
— booked as `OVERRUN` with a `CONFLICT` that freezes the adapter
([reservations-reconciliation.md §8](../core-v1/reservations-reconciliation.md#8-late-conflicting-and-duplicate-observations)).

## 4. Non-execution rules

The adapter's `nonExecutionRule` — evidence that an attempt did not and
cannot execute, allowing `FAILED` with zero consumption:

| Rule | Evidence at the release level | Proves | Depends on |
| --- | --- | --- | --- |
| **NX-1 Sequencer rejection** | the attempt's own `txHash` is `SEQUENCED`, and its event carries an `AppError`, or the created order is terminal (`canceled-margin-not-allowed`, `canceled-too-much-slippage`, `canceled-post-only`, …) with `filled_base_amount = 0` | the transaction consumed its slot and created nothing that can fill | L-TX-6, L-LIFE-2 |
| **NX-2 Slot supersession** | a **different** known transaction (the signer's nonce-advance) is `SEQUENCED` at the same `(account, apiKeyIndex, nonce)` | the attempt's transaction never executed and never can ([attempt-lifecycle.md §5](attempt-lifecycle.md#5-resolving-an-unknown-attempt)) | L-TX-4; E-4 |
| **NX-3 IOC terminal** | for `MARKET_IOC` / `LIMIT_IOC`: the create tx is `SEQUENCED` and the order is terminal | an IOC order never rests (L-ORD-3); its fills are final with the tx | L-ORD-3 |

`ExpiredAt` passing is **not** by itself a non-execution rule. The venue says
a transaction not executed before `ExpiredAt` is an edge case in which the
nonce is not consumed (L-TX-6); it does not say the sequencer can never
process it afterwards. NX-2 turns the expiry into proof.

Without E-4, NX-2 is unavailable and an attempt whose submission is unknown
has no path to `FAILED`: it stays `QUARANTINED` until its transaction is
found. That is the frozen fallback, not a new one.

## 5. Observation model for 7F

Every observation carries `(reservationId, generation, attemptId)` —
resolved by the signer's own records from `txHash` or `client_order_index`,
never from a venue string — plus the fields below. `eventId` is unique per
`(sourceId, object, level)`.

| Observation | Lighter source | Identity (`eventId`) | Sequence | Final? | Economic effect it proves |
| --- | --- | --- | --- | --- | --- |
| `TX_ACKED` | `sendTx` response | `ack:<txHash>` | — | no | none |
| `TX_SEQUENCED` | `tx` by hash; `account_tx` channel | `tx:<txHash>:<level>` | `sequence_index` | only as the carrier of a final order status | the attempt's slot is consumed by this transaction |
| `TX_REJECTED` | `tx` record with `AppError`; order `canceled-*` from its own create tx | `tx:<txHash>:<level>` | `sequence_index` | yes at release level, if zero fills (NX-1) | nothing can fill under this attempt |
| `ORDER_OPEN` | `account_orders` / `accountOrders` (`open`, `pending`) | `order:<order_index>:v<order_version>:<level>` | `order_version`, then `block_height` | no | the order can still fill `remaining_base_amount` |
| `ORDER_FILL` | `account_all_trades`, tx `OrderExecution` events | `trade:<trade_id>` (fills are level-independent) | `block_height` | no | consume `size × price` and fee; applied once per `trade_id` |
| `CANCEL_SEQUENCED` | the bound cancel `txHash`, `CancelOrder` event without `AppError` | `tx:<cancelTxHash>:<level>` | `sequence_index` | yes at release level **with** the order's complete fill set | the order is dead from that sequence point; remainder releasable |
| `CANCEL_REJECTED_INACTIVE` | bound cancel tx with `AppErrInactiveCancel` | `tx:<cancelTxHash>:<level>` | `sequence_index` | no | the order is terminal for another reason, which must be observed |
| `ORDER_FILLED` | order `filled` | `order:<order_index>:terminal:<level>` | `order_version` | yes at release level with the complete fill set | `EXECUTED`; price improvement releasable |
| `ORDER_CANCELED(reason)` | order `canceled*` other than `-expired` | `order:<order_index>:terminal:<level>` | `order_version` | yes at release level with the complete fill set | `CANCELLED`; consume fills, release remainder |
| `ORDER_EXPIRED` | order `canceled-expired` | `order:<order_index>:terminal:<level>` | `order_version` | yes at release level with the complete fill set | `EXPIRED`; as cancelled |
| `NONCE_SUPERSEDED` | nonce-advance `txHash` sequenced at the attempt's slot | `slot:<account>:<key>:<nonce>:<level>` | `sequence_index` | yes at release level (NX-2) | `FAILED`, zero fills |
| `LEDGER_FOREIGN` | a trade or order on the sub-account that maps to no attempt (`liquidation`, `deleverage`, `market-settlement`, foreign orders) | `trade:<trade_id>` / `order:<order_index>` | `block_height` | — | **drift**, not an attempt outcome (§7) |

Mapping to Core's vocabulary is by this table only. There is no path from a
status string to a release that bypasses the "complete fill set at the
release level" condition.

## 6. Sequence, versions and out-of-order delivery

| Field | Scope | Usable as | Caveat |
| --- | --- | --- | --- |
| tx `sequence_index` | per transaction, from the sequencer | status watermark per attempt | global monotonicity across accounts assumed, not documented |
| `block_height` | on txs, orders, trades | coarse ordering; the ledger-consistency check for account snapshots ([perp-policy-v1.md §6](perp-policy-v1.md#6-state-requirements)) | cross-channel monotonicity per account is E-11 |
| `order_version` | per order | ordering of one order's states | present on REST `accountOrders`, and on order events per S3 |
| order-book `nonce` / `begin_nonce` | per market book | continuity of market data | not account state |
| WebSocket `offset` | per API server | nothing | changes arbitrarily on reconnect (L-OBS-3) |
| per-(account, key) nonce | the signer's own transactions | slot identity and supersession | only for transactions the signer made |

Out-of-order and duplicate delivery is expected: separate channels
(`account_tx`, `account_orders`, `account_all_trades`) have no documented
mutual ordering, `account_all` resends whole snapshots on resubscription, and
deployments drop connections (L-RL-5). Core's `APPLY` order already absorbs
this: fills commute by `trade_id`; a status below the watermark is ignored;
the same event twice is `DUPLICATE`; the same `eventId` with different content
is `CONFLICT`.

## 7. Drift sources

Changes to the sub-account that no attempt explains:

| Source | Lighter evidence | Handling |
| --- | --- | --- |
| funding payments | `PositionFunding`, `total_funding_paid_out` (L-POS-5) | collateral drift; within the module's declared tolerance |
| liquidation, deleveraging, market settlement | trade types `liquidation`, `deleverage`, `market-settlement`; order `canceled-liquidation` (L-POS-6, L-LIFE-8) | position drift; freezes increases on the affected dimensions until acknowledged |
| fees pulled from cross into an isolated position | `allocated_margin` and cross collateral changes without a trade (L-MAR-6) | margin drift |
| principal's own activity with the L1 key | orders or transfers not bound to any attempt | drift; foreign open orders refuse increases ([perp-policy-v1.md §6](perp-policy-v1.md#6-state-requirements)) |
| another key signing | `nextNonce` ahead of the allocator; unknown `api_key_index` on txs | `NONCE_SLOT` / `CREDENTIAL_SCOPE` fail; possible compromise |

## 8. Read budget

A Standard account has 60 REST requests per minute across everything,
including `sendTx`, counted per IP and per L1 address (L-RL-1). That is too
little to poll per attempt. The reader should therefore:

- take evidence primarily from authenticated WebSocket channels
  (`account_tx`, `account_all_orders`, `account_all_trades`,
  `account_all_positions`), which do not consume REST quota;
- use REST (`tx` by hash, `accountOrders` by client order index,
  `nextNonce`, `apikeys`) for recovery after reconnects and for the checks in
  [signer-architecture.md §7](signer-architecture.md#7-pre-execution-requirements);
- not share the principal's L1 address rate bucket with any agent-side reader
  (REST and WebSocket limits are coupled, L-RL-6), so an agent cannot starve
  the signer's ability to cancel or reconcile;
- consider the Plus tier (24,000 weighted requests per minute, L-RL-1) for
  production; its cost is higher fees and a 300 ms taker bump (S6).

Verified-finality lookups multiply reads: each release needs a tx record at
`VERIFIED`. How many depends on E-1.
