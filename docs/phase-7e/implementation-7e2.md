# Phase 7E.2 — Enforcement closure and the live state adapter

> **Status: implemented locally, awaiting review.** Lighter testnet only; no
> mainnet, no real funds, no production credentials, no order placed. Builds on
> the accepted 7E.1 ([implementation-7e1.md](implementation-7e1.md)).
> Reconciliation is Phase 7F and is not started. Phases 7A–7D stay frozen: 7E.2
> changes nothing in `packages/kernel`, `core`, `ledger` or `control`, no
> Solidity, and no canonical corpus.

## Contents

1. [What was built](#1-what-was-built)
2. [Custody verifies the durable `ADMIT_ATTEMPT`](#2-custody-verifies-the-durable-admit_attempt)
3. [What custody still trusts](#3-what-custody-still-trusts)
4. [The live state adapter](#4-the-live-state-adapter)
5. [Auth tokens](#5-auth-tokens)
6. [Margin actions: none added](#6-margin-actions-none-added)
7. [Release finality: unchanged](#7-release-finality-unchanged)
8. [Fixtures](#8-fixtures)
9. [Tests, mutants, benchmarks](#9-tests-mutants-benchmarks)
10. [Validation](#10-validation)
11. [Changes by package](#11-changes-by-package)
12. [Blocked evidence and open questions](#12-blocked-evidence-and-open-questions)
13. [Explicit answers](#13-explicit-answers)

---

## 1. What was built

| Gap left by 7E.1 | 7E.2 |
| --- | --- |
| custody signed any allowlisted transaction whose hash the caller *named* as committed; it did not read the ledger ([security-boundary.md §5](security-boundary.md#5-process-and-ipc-boundary), 7E.1 text) | custody takes an **attempt id**, reads the durable `ADMIT_ATTEMPT` itself from the ledger's SQLite file (read-only), recomputes the hash and signs only that attempt's committed artifact (§2) |
| PerpPolicy's state came only from test builders | a **live state adapter** reads Lighter's account, active orders and market metadata into `perp.account`, `perp.asset-price` and `perp.market` snapshots, or into `UNKNOWN`, which admits nothing (§4) |

| Path | What |
| --- | --- |
| `packages/ledger-sqlite/src/store.ts` | two derived indexes written in the commit transaction: attempt → (principal, batch version), closed reservation → (principal, version) |
| `packages/ledger-sqlite/src/lifecycle.ts` | the durable `lifecycle` table (module and adapter status) in the ledger's file, `DurableModuleRegistry` / `DurableAdapterRegistry` over it, `openLifecycle` on its own WAL connection: **one status source for Control and custody** |
| `packages/perp-lighter/custody/ledger.go` | `VerifyAdmitted`: custody's independent check |
| `packages/perp-lighter/custody/main.go` | `sign` takes `{tx, claim}`; `claim.attempt` is required; `VerifyAdmitted` runs before the slot journal and the key |
| `packages/perp-lighter/custody/custody_test.go` | Go mutants M12, M13 over a real ledger; the slot journal across restart |
| `packages/perp-lighter/src/custody.ts` | `KeyCustody.sign(tx, claim)`; `GoCustodyOptions.ledger`, `.binding` |
| `packages/perp-lighter/src/normalize.ts` | pure normalizers `accountOf`, `activeOrdersOf`, `markOf`, `marginModeOf` |
| `packages/perp-lighter/src/venue.ts` | `HttpStateClient` (testnet only; the token in the `Authorization` header) |
| `packages/perp-lighter/src/state-reader.ts` | `LighterStateReader`: bracketed read, consistency checks, provenance, envelopes |

## 2. Custody verifies the durable `ADMIT_ATTEMPT`

The signer's request is `{op: "sign", tx, claim: {attempt, reservation,
generation, action}}`. The claim is a **claim**, never proof: there is no
admission token, signed or unsigned, and no hash in the request. Custody's
own configuration fixes what it serves — `LIGHTER_CUSTODY_BINDING` (principal
key, `ModuleRef`, `AdapterRef`) and `LIGHTER_CUSTODY_LEDGER` (the ledger's
SQLite file, opened `mode=ro`).

Before the key is touched, in this order, inside one read transaction:

| # | Check | Refusal |
| --- | --- | --- |
| 1 | `claim.attempt` present and a 32-byte digest | `ATTEMPT_ID_MISSING` |
| 2 | custody builds the transaction (allowlist, account, key, chain — as in 7E.1) and computes **its own** hash | `TX_TYPE_FORBIDDEN`, `TX_BINDING_MISMATCH`, `TX_INVALID` |
| 3 | the attempt is in the attempt index | `ATTEMPT_NOT_ADMITTED` |
| 4 | … for the principal this custody serves | `ATTEMPT_OTHER_PRINCIPAL` |
| 5 | the principal's durable head is at or past that batch | `ATTEMPT_NOT_COMMITTED` |
| 6 | keccak-256 of the stored batch bytes is the recorded head of that version | `LEDGER_BATCH_CORRUPT` |
| 7 | the batch decodes (party, version, previous head) and holds exactly one event, `ADMIT_ATTEMPT` | `LEDGER_BATCH_MISMATCH`, `LEDGER_BATCH_MALFORMED` |
| 8 | its attempt id is the one claimed **and re-derives** from its own fields | `ATTEMPT_ID_MISMATCH` |
| 9 | `ModuleRef` and `AdapterRef` are the served ones | `MODULE_NOT_SERVED`, `ADAPTER_NOT_SERVED` |
| 10 | reservation, generation and action are the claimed ones | `RESERVATION_MISMATCH` |
| 11 | the venue account is `lighter:<chain>:account:<index>` of this custody | `ACCOUNT_MISMATCH` |
| 12 | the artifact is `lighter.l2-tx-hash` and **equals custody's own hash of `tx`** | `ARTIFACT_NOT_ADMITTED` |
| 13 | the slot is `lighter:<chain>:account:<i>:key:<k>` and its sequence is `tx.Nonce` | `SLOT_MISMATCH` |
| 14 | now < `validUntil`, and `tx.ExpiredAt` ≤ `validUntil` | `ATTEMPT_EXPIRED` |
| 15 | the reservation is not closed | `RESERVATION_CLOSED` |
| 16 | no issuance of the attempt is recorded (`issuance_journal`) | `ATTEMPT_ALREADY_ISSUED`, `JOURNAL_UNAVAILABLE` |
| 17 | the durable lifecycle rows of the module and adapter exist, carry the served digest and are `ACTIVE` or `RETIRING` | `MODULE_DISABLED`, `ADAPTER_DISABLED`, `…_LIFECYCLE_UNKNOWN`, `…_LIFECYCLE_OTHER_DIGEST` |

Only then: the per-slot journal (unchanged from 7E.1, now defence in depth —
the ledger already admits one artifact per slot) and the signature. The
signer still checks that the returned hash equals the committed one.

The **indexes only locate**. Everything that decides is decoded from the
batch bytes whose digest is the head. A missing, stale or forged index row
can only make custody refuse.

The fake custody used by the TypeScript suites (`test/support/signer-world.ts`)
implements the same checks over the same committed state; the real Go custody
is exercised by `npm run lighter:custody:check` (§9).

## 3. What custody still trusts

Stated plainly, because "independent" has limits:

- **The ledger writer.** Custody verifies that a committed, intact batch
  holds the `ADMIT_ATTEMPT` — it does not re-run the reducer or Control's
  admission (authorization, revalidation, pre-execution evidence). A writer
  that commits an `ADMIT_ATTEMPT` Control would never have admitted is outside
  what custody can detect. The head chain makes such a batch *permanent and
  attributable*, not impossible.
- **The closed-reservation index** is written by the same trusted store in
  the same transaction as the `CLOSE`; custody does not scan every later batch
  for a close.
- **Its own clock** for `ATTEMPT_EXPIRED`; the venue enforces `ExpiredAt`
  independently.
- **The host.** Signer, store and custody still run on one machine under one
  user (reference separation, as in 7E.1). Read-only open is a property of
  custody's code, not an OS permission; a deployment that wants the stronger
  property gives custody a read-only file handle or a read-only mount.

What changed is the attacker needed: a compromised **signer process** can no
longer obtain a signature for an unadmitted transaction; it must also be able
to write a committed, intact `ADMIT_ATTEMPT` for this principal, module,
adapter, account, key and slot into the ledger file.

## 4. The live state adapter

`LighterStateReader.read()` → `{status: 'OK', observedAt, states, book,
provenance}` or `{status: 'UNKNOWN', reason, provenance}`. `UNKNOWN` carries
**no states**; the control engine, given none, refuses (every failure test
checks this end to end).

**Reads, in order (bracketed).**

1. `GET /api/v1/account?by=index&value=<i>`
2. `GET /api/v1/orderBookDetails`
3. the read-only auth token from the `ReadOnlyTokenSource` (refused unless `ro:`)
4. `GET /api/v1/accountActiveOrders?account_index=<i>&market_id=<m>` for **every claimed market and every market the account reports**
5. `GET /api/v1/account?by=index&value=<i>` again

**Mapping.**

| Lighter | Normalized | Rule |
| --- | --- | --- |
| `collateral`, `available_balance` (USDC decimal strings) | USDC atoms, 6 decimals | exact; the lower of the two account reads is used |
| `positions[].position`, `sign` | signed size at the market's size decimals | exact; `sign` ∈ {1, −1}, or 0 only for a zero size |
| `positions[].margin_mode` | `ISOLATED` (1), `CROSS` (0) | anything else, or absent: `UNKNOWN` — **never read as isolated** |
| `positions[].initial_margin_fraction` (percent, `"5.00"`) | ticks of 1/10,000 (`500`) | exact at 2 decimals; 1…10,000 |
| `positions[].allocated_margin` | USDC atoms | exact |
| `orders[]` (`status`, `remaining_base_amount`, `price`, `is_ask`, `reduce_only`, `client_order_index`) | `OpenOrderEntry` | only status `open`; owner and market must match; amounts exact at the market's decimals |
| `orderBookDetails[]` statics | `MarketStatic` (7E.1 `marketStaticOf`) | passed through **as observed**: PerpPolicy's pinned version refuses drift |
| `mark_price`, `index_price` | canonical asset USD price, 2 decimals | both positive, within `maxMarkDivergenceBps`; the higher, rounded up |

**`UNKNOWN` when** — each tested (§9):

- any read fails (network, HTTP error, non-200 code, not JSON, missing list);
- the active-orders read fails for any required market: **a failed orders read is never "no orders"**;
- no token, a token that is not `ro:`, or the venue rejects it (`20001`, `20013`);
- a position in a market with no metadata (`UNKNOWN_MARKET_<m>`), a claimed market missing, a market not `active` or frozen;
- a missing or unknown margin mode, a missing field, a malformed amount;
- the two account reads differ in positions, settings or counts (`ACCOUNT_MOVED_DURING_READ`);
- the orders read disagree with the account's own counts, per market or in total, or any order is in flight (`pending_order_count` ≠ 0, a status other than `open`);
- mark and index diverge beyond the bound, or either is zero.

**Passed through faithfully, refused by the policy or by admission:** a `CROSS`
setting (`CROSS_MARGIN_UNSUPPORTED` on the target, `CROSS_MARGIN_IN_USE`
beside it), a flat market with no reported setting
(`MARGIN_SETTING_UNKNOWN`), drifted market metadata (pinned version), a
snapshot older than its age limit (`AGE` freshness), a foreign open order
(`FOREIGN_OPEN_ORDER`, when the grant carries an invariant).

**Provenance.** One record per read: endpoint (never the token), request and
response times in ms, HTTP status, keccak-256 of the exact body, or the error.
`observedAt` is the *request* time of the first read, so ages are counted
from the earliest moment the snapshot could describe.

**Finality and trust of the snapshots** are as 7E.1 declared them: account and
market at `lighter.state/SEQUENCED`, `VERIFIED` trust class; the asset price at
`perp.price/PUBLISHED` under the policy's configured price source. Whether
Lighter's index is an acceptable price source is a deployment decision
recorded in the principal's context (7D.1 R1); the reader does not decide it.

**Live check.** On 2026-09-29 the reader ran against testnet account 7 with
the real `HttpStateClient` and no read-only token provisioned: the account and
metadata reads succeeded and normalized (collateral 9,997.590227 USDC, ETH
−0.3715 **cross**), and the read stopped at
`AUTH_TOKEN_UNAVAILABLE` — `UNKNOWN`, no states. A complete live snapshot needs
an account with a registered key we hold (§12).

## 5. Auth tokens

| Token | Can it authorize an economic action? | The reader |
| --- | --- | --- |
| **L2 transaction signature** (per transaction, Schnorr over the tx hash) | yes — orders, cancels, withdrawals, transfers, pool and key operations all need one | never holds one; only custody signs, and only admitted artifacts |
| **standard auth token** (`<deadline>:<account>:<key>:<signature>`, made with the API key) | not an L2 transaction — it cannot place an order or move funds by itself. **But it is not read-only**: Lighter accepts it on account-configuration endpoints (account tier change, maker-only API key setting, creating further tokens) | **refused** (`AUTH_TOKEN_NOT_READ_ONLY`) and never sent |
| **read-only token** (`ro:` prefix) | no — read endpoints only | accepted |

So an auth token must be generated inside the credential boundary (it needs
the API key) and only its read-only form may leave it. 7E.2 keeps custody's
interface at exactly three operations and gives it no network access, so the
read-only token is provisioned by the operator inside that boundary and handed
to the reader through `ReadOnlyTokenSource`; the agent never sees it. Minting
it inside custody is a later step. Fixtures carry no token; the only token
ever sent in this phase was a deliberately invalid placeholder, to capture the
`20013` refusal.

## 6. Margin actions: none added

No `SET_MARGIN` or generic margin-management action exists. v1 remains
**isolated only**, with the margin setting read and checked, never changed.
Named for later phases, **not implemented**:

| Future action | Would do | Why not now |
| --- | --- | --- |
| `CONFIGURE_MARGIN_MODE` | set a flat market's margin mode and IMF (lighter-go `L2UpdateLeverageTxInfo`: `MarginMode`, `InitialMarginFraction`) | changes a setting PerpPolicy reads; needs its own action, invariants and E-8 evidence (default mode of a fresh market) |
| `ADJUST_ISOLATED_MARGIN` | add or remove collateral on an isolated position (lighter-go `L2UpdateMarginTxInfo`: `USDCAmount`, `Direction`) | moves collateral; needs E-7 (allocation per fill) and reconciliation (7F) |

The custody allowlist is unchanged: create-order and cancel-order only.

## 7. Release finality: unchanged

The release threshold stays **`VERIFIED`**.

> **LIVE TESTNET LIMITATION: full authority release cannot currently be
> demonstrated.** Lighter testnet has never been observed to set
> `committed_at` or `verified_at` (T-5); a release at `VERIFIED` is therefore
> unreachable on testnet, and nothing in 7E releases authority on venue
> evidence. This is recorded, not worked around: no lower level is accepted
> to make a demonstration possible.

## 8. Fixtures

`packages/perp-lighter/test/fixtures/live-state.json`, pinned by digest.
Each entry: endpoint, network, capture date, SDK/API version, derivation,
sanitization, HTTP status, the raw body exactly, and its normalized result.

| Fixture | Derivation | Captured | Normalized |
| --- | --- | --- | --- |
| `account-7-cross-position` | **LIVE**, `l1_address` zeroed | 2026-09-29T03:51:04Z | collateral 9,997,578,346; ETH −3,715 at 4 dp, `CROSS`, IMF 500 |
| `active-orders-no-auth` | **LIVE**, HTTP 400 | 2026-09-29T03:51:04Z | `ORDERS_AUTH_MISSING` (code 20001) |
| `active-orders-invalid-token` | **LIVE**, HTTP 401 | 2026-09-29T04:10:51Z | `ORDERS_AUTH_REJECTED` (code 20013) |
| `active-orders-one-open` | **SCHEMA_DERIVED** (lighter-python 1.1.4 `Order`/`Orders`, a38b6405) | — | one `OpenOrderEntry` |
| `active-orders-empty` | **SCHEMA_DERIVED** | — | `[]` |
| `order-book-details-marks` | **LIVE** (the pinned 7E.1 capture) | 2026-09-28T23:33:38Z | ETH 2,691.06 · BTC 83,588.90 · SOL 118.80 USD |

A successful authenticated active-orders read with a resting order could not
be captured: it needs an account whose key we hold, with funds (§12). The
schema-derived bodies are labelled as such and use every field of the SDK's
model.

## 9. Tests, mutants, benchmarks

| Suite | Covers |
| --- | --- |
| `ledger-sqlite/test/index.test.ts` | indexes written atomically with the batch; lifecycle round trip; durable registries |
| `perp-lighter/test/custody.test.ts` | wrong ledger record, missing attempt (and no id), other reservation, restart, already issued, expired, `DISABLED` module and adapter; M12, M13 |
| `perp-lighter/test/crash.test.ts` | + after SIGKILL the admission is verifiable from the reopened file; once recovery records it, custody refuses it |
| `perp-lighter/test/state-reader.test.ts` | fixtures; a consistent read authorizes; account failure; active-orders failure; auth-token failure; stale and diverged mark; metadata mismatch; unknown market; cross margin; unknown/missing mode; flat market without setting; missing position data; malformed amounts; mid-read movement, count mismatch, in-flight orders; foreign order; M14, M15 |
| `npm run lighter:custody:check` (real Go custody) | 4/4 real testnet hashes; custody refusals; against a real SQLite ledger with A admitted and unsigned: B under A's attempt → `ARTIFACT_NOT_ADMITTED`, unknown attempt → `ATTEMPT_NOT_ADMITTED`, other reservation → `RESERVATION_MISMATCH`, other slot → `ARTIFACT_NOT_ADMITTED`, `DISABLED` adapter → `ADAPTER_DISABLED`; A signs, also after restart; Go mutants; one full issuance |

**Mutants** (7E.1's eleven still killed):

| # | Mutant | Killed by |
| --- | --- | --- |
| M12 | custody trusts that the transaction is the admitted one once the attempt exists (no comparison of its own hash with the committed artifact) | it signs B under A's attempt — Go (`TestMutantM12TrustCallerKilled`, real ledger) and TypeScript (`custody.test.ts`) |
| M13 | custody signs when the attempt is absent | it signs A with no admitted attempt — Go and TypeScript |
| M14 | a failed active-orders fetch is treated as an empty list | a snapshot is produced from a failed read and the order is authorized |
| M15 | `CROSS` is read as isolated | an increase on a cross market is authorized |

Production refuses in every one of those scenarios.

**Benchmark** (`npm run lighter:benchmark`, n = 200, node v22.21.0,
darwin/arm64): decide + reserve p50 10.2 ms; revalidation 8.3 ms;
`ADMIT_ATTEMPT` 40.9 ms; **signing through the Go custody, now including its
ledger verification, 5.2 ms** (7E.1: 4.9 ms); full local issue path 28.2 ms.
Costs still grow with unresolved reservations (7E.1 §10).

## 10. Validation

| Command | Result |
| --- | --- |
| `npm run check` | passed: 1,522 + 3 + 2 tests, 0 failures; typecheck, lint, structure, credential scan (565 files), junk check |
| `npm run generated:check` | passed; the regenerated corpora are byte-identical (no 7D drift) |
| `npm run lighter:custody:build` | built with Go, pinned modules |
| `npm run lighter:custody:check` | passed: stages 1–5 incl. the Go mutants |
| `go vet`, `gofmt -l` | clean |
| perp-lighter suites | 91 tests, 0 failures (included above) |

## 11. Changes by package

| Package | Change | Frozen? |
| --- | --- | --- |
| `kernel`, `core`, `ledger`, `control` | **none** | frozen — untouched |
| `ledger-sqlite` | derived indexes, durable lifecycle table and registries (additive; schema `IF NOT EXISTS`) | no (7E.1 reference store) |
| `perp-lighter` | custody verification, claim-based `sign`, state adapter | no |
| contracts, corpora | none | — |

## 12. Blocked evidence and open questions

**E-3, E-4, E-5, E-6, E-7, E-8 and E-10 remain blocked** pending sanctioned
Lighter testnet funds and account access; E-1 remains partial (never on
testnet). The request to Lighter is drafted in
[lighter-testnet-request.md](lighter-testnet-request.md). No unofficial
funding route was attempted and no shared or public credentials were used.

Open:

- a read-only token minted inside custody (§5);
- custody reading through an OS-enforced read-only handle (§3);
- whether Lighter's index is an admissible canonical price source (Q-8);
- a live active-orders capture with a resting order (needs E-3 access).

## 13. Explicit answers

| Question | Answer |
| --- | --- |
| Does custody verify the durable `ADMIT_ATTEMPT` itself before key use? | **Yes** — from the ledger's SQLite file, read-only, against the committed batch bytes (§2) |
| Does custody accept a caller-supplied committed hash? | **No.** The request carries no hash; custody computes its own and compares it with the committed artifact |
| Can custody sign when the attempt id is absent? | **No** (`ATTEMPT_ID_MISSING`) |
| Can custody sign a transaction whose attempt is not in the durable ledger? | **No** (`ATTEMPT_NOT_ADMITTED`) |
| Can an attempt admitted for A be used to sign B? | **No** (`ARTIFACT_NOT_ADMITTED`) |
| Does custody sign under a `DISABLED` module or adapter? | **No** — it reads the same durable lifecycle table Control does |
| Is there an admission token a caller could forge? | **No** — none exists, signed or unsigned |
| Does a failed active-orders fetch count as "no orders"? | **No** — `UNKNOWN`, no snapshot, refused |
| Is `CROSS`, an unknown or a missing margin mode accepted for an isolated-only increase? | **No** |
| Can an auth token authorize economic actions? | A standard token cannot sign an L2 transaction, but it is **not** read-only (account configuration); the reader accepts only `ro:` tokens (§5) |
| Was `SET_MARGIN` (or any margin action) added? | **No**; `CONFIGURE_MARGIN_MODE`, `ADJUST_ISOLATED_MARGIN` documented as future only |
| Was release finality lowered? | **No** — `VERIFIED`; full release cannot be demonstrated on testnet |
| Were E-3…E-8 and E-10 evidenced? | **No** — blocked pending sanctioned testnet access |
| Were M12–M15 killed? | **Yes**, all four; 7E.1's M1–M11 still killed |
| Did anything contact mainnet, use real funds, place an order or send a transaction? | **No** |
| Did the agent see a raw Lighter private key? | **No** — only disposable keys generated into temporary files by the custody binary, never printed |
| Did 7D corpora or Solidity change? | **No** |
| Was 7F started? | **No** |
