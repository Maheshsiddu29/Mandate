# Phase 7E.1 — Lighter testnet evidence

> **Status: record of every network interaction in Phase 7E.1.** Lighter
> **testnet** only (`https://testnet.zklighter.elliot.ai`, L2 chain id 300).
> No mainnet endpoint, no Robinhood endpoint, no real funds, no user
> credential. One write was made (E-P2): an order signed by a disposable key
> for an account that does not exist. Everything else was read-only. Raw
> captures used by tests are committed under
> `packages/perp-lighter/test/fixtures/`, pinned by digest; working captures
> live in the ignored `.lighter-testnet/`.
>
> **Phase 7E.2** added read-only captures only; they are recorded in
> [§8](#8-phase-7e2-captures). No write was made in 7E.2.

## Contents

1. [Headline](#1-headline)
2. [Why no funded testnet account](#2-why-no-funded-testnet-account)
3. [Experiment log](#3-experiment-log)
4. [Findings](#4-findings)
5. [Status of E-1 … E-11](#5-status-of-e-1--e-11)
6. [What this changes in the implementation](#6-what-this-changes-in-the-implementation)
7. [Reproducing](#7-reproducing)
8. [Phase 7E.2 captures](#8-phase-7e2-captures)

---

## 1. Headline

- **The exact-artifact premise holds.** From the published fields of four
  real testnet orders, the official SDK's hash — computed *without* a key —
  reproduced the hash Lighter published, byte for byte (T-2). So
  `ADMIT_ATTEMPT` can commit the venue's exact transaction identity before
  anything is signed.
- **`VERIFIED` finality is unreachable on testnet.** No transaction or block
  observed carried a commitment or a verification (T-5). The release
  threshold stays `VERIFIED`; on testnet, nothing could ever be released.
- **Order, cancel, fill and nonce behaviour for *our own* account could not
  be tested.** A funded disposable testnet account could not be created (§2).
  E-3 … E-8 and E-10 remain unevidenced; the implementation fails closed on
  each (§6).
- **No 7E.0 assumption was contradicted.** Three facts were sharpened: a nonce
  read does not prove an account exists (T-4), published fee rates are not
  charged rates (T-7), and API timestamps cannot order events (T-6).

## 2. Why no funded testnet account

An account exists on Lighter only after an L1 deposit (S2, S7). On testnet:

| Evidence | Observation (2026-09-28, read-only) |
| --- | --- |
| `GET /api/v1/layer1BasicInfo` | the testnet's L1 is chain **123456**, latest L1 block **0**; contracts `ZkLighterContract`, `USDCContract` and a `FaucetContract` on that chain — no RPC URL is published |
| `GET /api/v1/deposit/networks` | lists Arbitrum One (42161), Avalanche C-Chain (43114), Base (8453): **mainnet** chains, forbidden in this phase |
| `lighter-python` `openapi.json` endpoint list | no faucet or account-creation endpoint |
| `/status`, `/info` | `404` |
| `/fastbridge/info`, `/withdrawalDelay`, `/tokenlist` | `29500 internal server error` |

Reaching the private L1 would need an RPC and faucet access Lighter does not
publish; the SDK's example testnet key is a shared public account whose nonces
and keys other people change concurrently, so experiments on it would prove
nothing about Mandate's single-key deployment — and it is not a disposable
credential this phase generated. It was **not used**.

## 3. Experiment log

Times are UTC on 2026-09-28. "Scratch" captures were read into the session's
scratch directory; "evidence" captures are what `npm run
lighter:testnet:evidence` wrote to `.lighter-testnet/evidence/`.

| Id | Time | Endpoint | Experiment | Inputs (no secrets) | Observation | Conclusion | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E-R1 | ≈22:58–23:03 (not individually timed) | `/status`, `/info`, `/layer1BasicInfo`, `/systemConfig`, `/deposit/networks`, `/currentHeight`, `/fastbridge/info`, `/withdrawalDelay`, `/tokenlist` | can a disposable account be funded? | none | §2; height 53 at first read | no public path to fund a testnet account | HIGH |
| E-R2 | 23:04:03 | `/orderBookDetails` | market metadata for claims | none | 3 perps: ETH 4095, **BTC 4096**, SOL 4097; BTC size decimals 5, price decimals 1; IMF ticks 500 default / 200 min; multiplier 1; `taker_fee` `"0.0000"` | claims built from it (`market.ts`) | HIGH |
| E-R3 | 23:04–23:06 | `/txs?index=0,100,200,300&limit=100`, `/tx?by=hash`, `/block?by=height&value=53` | statuses, nonces, finality timestamps | none | 138 txs, all status 3; block 53 `committed_at 0`, `verified_at 0`, status 3 | first sight of T-5 | HIGH |
| E-O1 | 23:09 (offline) | — | reproduce published hashes with lighter-go v1.0.10 | fields of txs `1cf44012…`, `f25b19df…` | both hashes reproduced for chain id 300 | T-1, T-2 | HIGH |
| E-R4 | 23:33:38–23:33:48 | `/orderBookDetails`, `/txs` (10 pages), `/tx?by=hash`, `/blocks?limit=5&sort=desc`, `/nextNonce?account_index=281474976700001&api_key_index=5`, `/currentHeight` ×2 | the evidence script | none | 194 distinct txs (sequence 1–446, heights 4–175); every one status 3; 0 with a commitment or verification; `blocks` returned an empty page with `total 272`; nonexistent account's nonce `{"code":200,"nonce":0}`; height 274 → 275 in 9.5 s | T-3 … T-8 | HIGH |
| E-W1 | 23:33:40–23:33:48 | `wss://…/stream?readonly=true`: `height`, `order_book/4096` | ordering sample, 8 s | none | a connection message, an order-book snapshot (`nonce 38`, `begin_nonce 0`, `offset 4`), a height message | too short for E-11 | LOW |
| **E-P2** | **23:33:48.951** | `POST /sendTx` | **the only write**: a create-order signed by a disposable key registered nowhere, for account index 281474976700001 (does not exist); 0.0002 BTC at 0.1 USD, IOC, nonce 0 | tx hash `0b2f7c981fc94aa9c72086835913423b956a61ad101294005f4fc4dc04b1459a97f6402d16c77891` | `{"code":21100,"message":"account not found"}` | our `tx_info` serialization is accepted by the API's parser; an unknown account is refused before execution | HIGH |
| E-O2 | 23:37 and after (offline) | — | `npm run lighter:custody:check` | the pinned fixture | 4 of 4 published create-order hashes reproduced, including a market order and one with a self-trade attribute | T-2 across order types and attributes | HIGH |

## 4. Findings

| Id | Finding | Evidence | Confidence | Affects |
| --- | --- | --- | --- | --- |
| T-1 | Lighter testnet's L2 chain id is **300**: hashing with it reproduces published hashes | E-O1, E-O2 | HIGH | adapter descriptor |
| T-2 | The transaction hash is the **pre-signature message hash** over the fields, as lighter-go computes it; custody reproduces it for limit and market IOC orders, with and without a self-trade attribute | E-O1, E-O2 | HIGH — upgrades L-TX-3 from source reading to recorded evidence | `ADMIT_ATTEMPT` commits the exact artifact |
| T-3 | A correctly signed order for a nonexistent account is refused at the API with `21100 account not found` | E-P2 | HIGH | our serialization reaches the venue's account check |
| T-4 | `nextNonce` returns `{"code":200,"nonce":0}` for an account that does not exist | E-R4 | HIGH | `NONCE_SLOT` alone proves nothing about the account; `CREDENTIAL_SCOPE` must pass too, and its rule refuses an account whose key listing is empty or unreadable (the listing of a nonexistent account was not queried) |
| T-5 | No observed transaction (194) or block carried a non-zero `committed_at` / `verified_at`; every executed transaction and the block read had status **3**; the testnet L1's latest block is 0 | E-R3, E-R4 | HIGH for testnet; says nothing about mainnet | `VERIFIED` unreachable on testnet (E-1) |
| T-6 | `executed_at < queued_at` in 83 of 194 transactions | E-R4 | HIGH | API timestamps cannot order events; `sequence_index` and `block_height` only |
| T-7 | Trades carry `tf` = a fee **rate** in 1/1,000,000 (observed 280 = 0.028 %, and 0), while `orderBookDetails.taker_fee` reads `"0.0000"` | E-R2, E-R4 | MEDIUM (unit inferred from lighter-go `FeeTick`) | margin fee headroom comes from policy (0.1 %), never from published metadata |
| T-8 | Orders built by the SDK carry `ExpiredAt` ≈ signing time + 599 s (598.8 s after queueing in the pinned record) | E-R4 | HIGH | L-TX-7 seen in use; the signer sets `ExpiredAt` itself, bounded by the authorization |
| T-9 | IOC orders observed filled in their own transaction (taker status 3, remaining 0); cancellations by the system appear as internal type-22 transactions naming the order and client order index | E-R4 | MEDIUM | the observation shapes 7F will consume (`normalize.ts`) |
| T-10 | Per (account, key), observed nonces were strictly increasing in sequence order with no duplicates (three keys, 11–48 transactions each); gaps exist but the listing is known to be partial | E-R4 | MEDIUM | consistent with L-TX-4; says nothing about unexecuted or expired transactions (E-4) |
| T-11 | Other accounts sign self-trade mode 2 and integrator fee attributes, and the venue accepts them | E-R4 | HIGH | integrator attributes must stay pinned to nil in every Mandate artifact (they are) |

## 5. Status of E-1 … E-11

| Item | 7E.0 question | 7E.1 status | Consequence in the implementation |
| --- | --- | --- | --- |
| E-1 | when `committed_at` / `verified_at` are set | **Partial**: never, on testnet (T-5). Mainnet not observable in this phase | release threshold stays `VERIFIED`; on testnet no release can be justified |
| E-2 | meaning of status 3 | **Observed, not documented**: every executed transaction, filled order and internal cancel is status 3 — it reads as "executed; final at the sequencer; not committed to L1" | nothing depends on it: statuses are never mapped to outcomes by string in 7E |
| E-3 | fill after a sequenced cancel | **Blocked** (no account) | cancel issuance releases nothing; release waits for 7F evidence at `VERIFIED` |
| E-4 | nonce behaviour of unexecuted / expired transactions | **Blocked** for our key; T-10 is consistent with strict per-key ordering | no resubmission, no nonce advance, unknown submission → `OUTCOME_UNKNOWN`, one serialized lane per key (`LANE_BUSY`) |
| E-5 | same-master transfer by API key | **Blocked** | the signer never builds a transfer; the residual is stated in [security-boundary.md](security-boundary.md) |
| E-6 | `client_order_index` uniqueness scope | **Blocked** | used only as a lookup key derived from the reservation; never for deduplication |
| E-7 | isolated margin allocation per fill | **Blocked** | margin reserved by the documented formula plus fee headroom; compared at reconciliation (7F) |
| E-8 | default margin mode of a fresh market | **Blocked** | an unknown setting refuses (`MARGIN_SETTING_UNKNOWN`) |
| E-9 | `agent_enabled`, `price_protection` | **Unresolved** | the signer sends the API default for `price_protection`; nothing reads `agent_enabled` |
| E-10 | maker-only restriction is exhaustive | **Blocked** (needs a premium account) | `MAKER_ONLY_HARDENED` is defined but not enabled ([security-boundary.md §3](security-boundary.md#3-deployment-profiles)) |
| E-11 | cross-channel ordering | **Open**: an 8-second sample only | nothing in 7E depends on it |

## 6. What this changes in the implementation

- The signer admits and signs the **exact** venue transaction (T-2); the
  adapter descriptor pins chain id 300 (T-1).
- `NONCE_SLOT` and `CREDENTIAL_SCOPE` are both required; a nonce read alone
  is not evidence of an account (T-4).
- The adapter declares **no non-execution rule** (`non-execution:none` in its
  digest) and **no resubmission** (`resubmission:none`): with E-4 unevidenced,
  an unknown or rejected submission stays `OUTCOME_UNKNOWN` /
  `SUBMISSION_REJECTED`, its reservation held, until 7F evidence.
- PerpPolicy's margin demand uses the policy's fee headroom, not the published
  fee (T-7).
- `normalize.ts` exposes the transaction record shape 7F will consume, with
  timestamps carried but never used for ordering (T-6).

## 7. Reproducing

```bash
npm run lighter:custody:build                      # Go ≥ 1.23; fetches the pinned modules
npm run lighter:custody:check                      # offline once built: E-O2
npm run lighter:testnet:evidence                   # LIVE, testnet only, read-only
```

The 7E.1 `--probe-send` option (E-P2) was retired in Phase 7E.2: custody now
signs only a transaction whose durable `ADMIT_ATTEMPT` it has verified itself,
so the unadmitted probe signature E-P2 used can no longer be produced. E-P2's
result above stands as captured on the date recorded.

## 8. Phase 7E.2 captures

All read-only, testnet only, for the live state adapter
([implementation-7e2.md §4](implementation-7e2.md#4-the-live-state-adapter)).
Account 7 is an existing public testnet account; we hold no key for it.

| # | UTC | Request | Result | Used as |
| --- | --- | --- | --- | --- |
| E-S1 | 2026-09-29 03:51:04 | `GET /account?by=index&value=7` | 200; one ETH position, −0.3715, `margin_mode` 0 (**cross**), IMF `"5.00"`, `total_order_count` 0 | fixture `account-7-cross-position` (`l1_address` zeroed) |
| E-S2 | 2026-09-29 03:51:04 | `GET /accountActiveOrders?account_index=7&market_id=4095`, no auth | HTTP 400, code 20001 "auth query param and Authorization header are empty" | fixture `active-orders-no-auth` |
| E-S3 | 2026-09-29 03:51:13 | `GET /apikeys?account_index=7&api_key_index=255` | 200; keys 4–12 registered (nine keys), per-key nonces | context only: a public account with several keys is not a CRED-1 deployment |
| E-S4 | 2026-09-29 04:10:51 | `GET /accountActiveOrders?…`, `Authorization: ro:<invalid placeholder>` | HTTP 401, code 20013 "invalid auth string" | fixture `active-orders-invalid-token` |
| E-S5 | 2026-09-29 | `LighterStateReader` over `HttpStateClient`, account 7, no read-only token | account and metadata normalized; `UNKNOWN` at `AUTH_TOKEN_UNAVAILABLE`, no states | the live path fails closed |

Findings:

- **T-12.** `accountActiveOrders` refuses without auth (20001) and with an
  invalid token (20013), with HTTP 400 and 401: a monitor cannot read orders
  without a credential derived from the account's API key. HIGH.
- **T-13.** The account endpoint reports `margin_mode` per position entry,
  IMF as a percent string, and account- and market-level open and pending
  order counts, which the reader cross-checks against the orders it reads.
  Whether a flat market with no setting ever appears in `positions` is
  unobserved (E-8); the reader never invents one. MEDIUM.

**Still blocked:** E-3, E-4, E-5, E-6, E-7, E-8 and E-10, pending sanctioned
testnet funds and account access — requested in
[lighter-testnet-request.md](lighter-testnet-request.md). E-1 stays partial.

> **LIVE TESTNET LIMITATION: full authority release cannot currently be
> demonstrated.** The release threshold stays `VERIFIED`, which testnet has
> never been observed to reach (T-5).
