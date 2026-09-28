# Phase 7E.0 — Venue fit decision

> **Status: Phase 7E.0 decision, for owner review.** The decision is made on
> the evidence in [venue-evidence.md](venue-evidence.md), not on Lighter
> having been the planned venue.

## Verdict

**FIT WITH LIMITATIONS.** Lighter provides the properties the Mandate Venue
Signer and PerpPolicy v1 depend on, with nine guarantees weaker than an ideal
venue would give. Each is listed below with what it costs. Proceeding to 7E.1
(offline implementation against fixtures) is recommended; any use against
Lighter's testnet or mainnet is gated on the evidence items named in
"Conditions".

## What Lighter provides — the reasons it fits

| Mandate need | Lighter property | Evidence |
| --- | --- | --- |
| an enforcement point that refuses unsigned actions | sequencer checks a signature against the key registered at `(account, index)` | L-ACC-2, L-ACC-9 |
| the agent can be left with no credential | keys are per account and registered only with the L1 key; signing is local | L-ACC-3, L-ACC-4, L-ACC-9 |
| **exact artifact binding** (EXEC-1) | the signed hash covers every economic field of an order, including fee and self-trade attributes | L-TX-2, L-TX-12 |
| **`ADMIT_ATTEMPT` can name the exact artifact before it exists** | the tx hash is the message hash, computable before signing | L-TX-3 |
| at-most-once execution per artifact | per-(account, key) nonce slots | L-TX-4 |
| artifacts expire (EXEC-3) | tx `ExpiredAt`; GTT `OrderExpiry` 5 min – 30 days with automatic `canceled-expired` | L-TX-7, L-ORD-4, L-ORD-5 |
| orders that cannot rest when that is wanted | IOC and market orders | L-ORD-3 |
| terminal statuses with fill quantities | 13 `canceled*` statuses and `filled`, with filled/remaining amounts and per-fill `trade_id` | L-LIFE-1, L-LIFE-3, L-LIFE-4 |
| a finality ladder with a strong top | sequenced → committed → verified on Ethereum, per transaction | L-FIN-2, L-FIN-3 |
| isolated margin | per (account, market), locked while a position or order exists | L-MAR-1, L-MAR-2, L-MAR-5 |
| segregation and a hard capital cap | sub-accounts under one L1 owner | L-ACC-1 |
| revocation that does not depend on the signer | L1-signed key revocation; Ethereum priority cancel-all | L-ACC-5, L-WD-5, L-FIN-5 |
| withdrawal destination bounded even for a leaked key | API-key withdrawals pay only the owner's L1 address | L-WD-1 |

## The weaker guarantees, exactly

| # | Weaker guarantee | Consequence for Mandate | Where handled |
| --- | --- | --- | --- |
| W1 | **No trading-only scope for an ordinary API key.** The signer's key can withdraw to the owner, transfer to sibling sub-accounts, mint public-pool shares, change leverage (L-ACC-6, L-TX-11) | the signing allowlist is a **software** control; a compromised signer can move the sub-account's collateral within the principal's own addresses and into public pools. This is not an agent bypass under the prescribed deployment | [signer-architecture.md §3–4](signer-architecture.md#3-credential-model), T8 |
| W2 | **Isolated margin is not fully isolated**: fees can pull from cross; open orders reserve no collateral; how much a fill allocates is undocumented (L-MAR-6, L-MAR-7, L-MAR-8) | a dedicated funded sub-account is mandatory; the margin dimension is checked against observed allocation | [perp-policy-v1.md §3, §5](perp-policy-v1.md#3-margin-mode-decision-isolated-only) |
| W3 | **No account-level sequence or version** (L-OBS-1) | STATE-3 cannot be checked by sequence; replaced by a conservative ledger-consistency rule that over-counts when inclusion is unproven | [perp-policy-v1.md §6](perp-policy-v1.md#6-state-requirements) |
| W4 | **Observations are API-reported, not venue-signed** (L-OBS-6) | everything is `VERIFIED`-class; even `verified_at` is the API's report of an Ethereum fact Mandate does not check itself | [reconciliation-evidence.md §2](reconciliation-evidence.md#2-finality-ladder) |
| W5 | **Non-execution of an unknown submission depends on undocumented nonce behaviour** (L-TX-6's edge case) | until E-4 is evidenced, such attempts stay quarantined | [attempt-lifecycle.md §5](attempt-lifecycle.md#5-resolving-an-unknown-attempt) |
| W6 | **"No fill after a sequenced cancel" is implied, not stated** (L-FIN-6) | releases wait for `VERIFIED`, whose delay is unmeasured (E-1) — a liveness cost of unknown size | [reconciliation-evidence.md §3](reconciliation-evidence.md#3-cancellation-finality) |
| W7 | **Leverage and margin mode are account settings, not order fields** (L-ORD-16) | they hold at execution only by the signer's exclusive custody of the key, which Core's `atExecution` vocabulary cannot name | [perp-policy-v1.md §6](perp-policy-v1.md#6-state-requirements), Q-7 |
| W8 | **Standard-tier limits are tight**: 60 REST requests per minute in total, per IP and per L1 address (L-RL-1) | WebSocket-first evidence; production likely needs a higher tier | [reconciliation-evidence.md §8](reconciliation-evidence.md#8-read-budget) |
| W9 | **`client_order_index` uniqueness scope is undocumented** (L-ORD-9) | not used for deduplication; the nonce slot and tx hash are | [attempt-lifecycle.md §6](attempt-lifecycle.md#6-replay-1-for-execution) |

None of W1–W9 lets the **agent** execute an order without passing Mandate.
W1 is the one that matters most: it moves part of the protection from the
venue into the signer's code.

## Alternatives compared

Evaluated only far enough to know whether either is clearly better for the
first adapter. These facts come from official documentation read through a
summarizing fetch on 2026-09-28; **they were not verified against SDK source
and carry MEDIUM confidence at best**, unlike the Lighter facts.

| Property | Lighter | Hyperliquid | dYdX v4 |
| --- | --- | --- | --- |
| Trading key that cannot withdraw | **no** (maker-only keys on premium only) | **yes** — API ("agent") wallets cannot sign `withdraw3`, `usdSend`, `spotSend` ([exchange endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint)); the same page says agents can sign vault transfers | **yes** — permissioned keys with message-type, subaccount and market filters, including "limit withdrawals/transfers entirely" ([authenticators](https://docs.dydx.xyz/concepts/trading/authenticators)) |
| Key limits beyond type | none | agent approval up to 180 days | cannot limit position or order size (same page) |
| Replay primitive | sequential nonce per key | 100 highest nonces per signer, time window; **previously signed actions may replay after an agent is deregistered and its nonce state pruned** ([nonces and API wallets](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets)) | order id; short-term orders by block |
| Order expiry | tx `ExpiredAt`; GTT 5 min–30 days | action `expiresAfter`; resting GTC orders have no expiry of their own ([order types](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-types)) | short-term orders expire by `GoodTilBlock` ≤ current + 20 blocks; stateful orders by `GoodTilBlockTime` ([short-term vs stateful](https://docs.dydx.exchange/api_integration-trading/short_term_vs_stateful)) |
| Non-execution evidence | slot supersession (pending E-4); terminal status | expiry of the action; cancel status | a short-term order past its block is provably dead — the strongest of the three |
| Finality | sequencer + zk proof verified on Ethereum | own chain consensus (not researched here) | Cosmos chain finality (not researched here) |

Reading:

- **dYdX v4** has the strongest fit on paper for CRED-1 and non-execution:
  venue-enforced key scoping (it would close W1 at the venue) and orders
  whose death is provable by block height. It is the first alternative to
  evaluate properly if Lighter's evidence items fail.
- **Hyperliquid** closes W1's withdrawal half, but agents can still move
  funds into vaults, and its nonce-pruning replay warning is a sharper hazard
  for Mandate's replay model than anything found on Lighter.
- Neither is clearly better **overall** on the evidence gathered: Lighter's
  pre-signature transaction hash, per-slot nonces, bounded-life GTT orders and
  Ethereum-verified finality line up directly with `ADMIT_ATTEMPT` and the
  finality ladder. Switching would trade W1 for a venue whose facts have not
  yet been established to Lighter's depth.

## Conditions

Before 7E.1 starts (owner decisions):

1. approve the frozen-package extensions listed in
   [README.md](README.md#7e-implementation-items-that-touch-frozen-packages);
2. decide the durable-store scope (Q-3).

Before any artifact is submitted to Lighter testnet:

3. explicit authorization to contact Lighter's API and use testnet keys;
4. recorded evidence for E-4 (nonce behaviour), E-5 (same-master transfer),
   E-6 (client order index), E-7 (isolated allocation), E-8 (default mode).

Before any mainnet use:

5. E-1 (verification delay) and E-3 (no fill after sequenced cancel) — the
   release level depends on them;
6. a decision on W1: accept the software allowlist with the funded-sub-account
   cap, or adopt the maker-only profile (E-10), or re-evaluate dYdX v4.
