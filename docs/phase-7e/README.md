# Phase 7E.0 — Real perp venue evidence and enforcement contract

> **Status: Phase 7E.0 (research and specification) ACCEPTED; Phase 7E.1
> (implementation) ACCEPTED as the base. Phase 7E.2 (enforcement closure and
> the live state adapter) complete locally and awaiting review** —
> [implementation-7e2.md](implementation-7e2.md),
> [implementation-7e1.md](implementation-7e1.md),
> [testnet-evidence.md](testnet-evidence.md),
> [security-boundary.md](security-boundary.md),
> [lighter-testnet-request.md](lighter-testnet-request.md). Lighter testnet only; no
> mainnet, no real funds, no production credentials; reconciliation is Phase
> 7F and not built. The 7E.0 documents below are kept as written; 7E.1's
> changes to their assumptions are recorded in venue-evidence.md §14.

Phase 7E will be Mandate's first real external-market integration: a real
`PerpPolicy`, a venue-native enforcement boundary, the `ADMIT_ATTEMPT`
issuance state machine, exact action signing and execution replay
protection. 7E.0 establishes the venue facts first and specifies against them.

**Verdict: Lighter is FIT WITH LIMITATIONS** ([venue-fit.md](venue-fit.md)).

## Reading order

| Document | What it establishes |
| --- | --- |
| [venue-evidence.md](venue-evidence.md) | every Lighter fact the design relies on, each with source, type, access date, confirming sources and confidence; the evidence still to be recorded (E-1…E-11) |
| [perp-policy-v1.md](perp-policy-v1.md) | scope, the four perp quantities, the isolated-only decision, typed actions, contributions, state requirements, invariants, canonical identity, pending projection, the cancel/replace scenario, customer value |
| [signer-architecture.md](signer-architecture.md) | the enforcement point, credential and no-bypass model, the signing allowlist, the artifact, process isolation, pre-execution requirements, rotation and revocation, `RETIRING` vs `DISABLED`, the adapter descriptor, durability |
| [attempt-lifecycle.md](attempt-lifecycle.md) | the `ADMIT_ATTEMPT` protocol, the crash matrix, resolving unknown attempts, execution REPLAY-1, exactly-once vs at-most-once, validity windows, nonce ordering, ledger additions |
| [reconciliation-evidence.md](reconciliation-evidence.md) | the finality ladder, cancellation finality, non-execution rules, the 7F observation vocabulary, sequencing, drift, read budget |
| [threat-model.md](threat-model.md) | 21 threats with prevent / detect / quarantine / unresolved |
| [venue-fit.md](venue-fit.md) | the verdict, the nine weaker guarantees, alternatives (Hyperliquid, dYdX v4), conditions to proceed |
| [implementation-7e1.md](implementation-7e1.md) | **7E.1**: the durable store, `ADMIT_ATTEMPT`, `DISABLED`, pre-execution requirements, PerpPolicy v1, the Venue Signer, crash, concurrency and mutation results, benchmarks, changes to frozen packages |
| [testnet-evidence.md](testnet-evidence.md) | **7E.1**: every testnet interaction, findings T-1 … T-11, status of E-1 … E-11 |
| [security-boundary.md](security-boundary.md) | **7E.1/7E.2**: the broad-credential fact, CRED-1 conditions, deployment profiles, custody's durable verification, auth tokens, key-theft blast radius, residual risks |
| [implementation-7e2.md](implementation-7e2.md) | **7E.2**: custody verifies the durable `ADMIT_ATTEMPT` itself; the live Lighter state adapter; auth tokens; mutants M12–M15; LIVE TESTNET LIMITATION |
| [lighter-testnet-request.md](lighter-testnet-request.md) | **7E.2**: draft request to Lighter for sanctioned testnet funds and access (E-3…E-8, E-10) |

## Summary

**Credential model.** A trading account is an integer index under an L1
(Ethereum) owner; orders are signed locally by per-account API keys
registered and revoked only with the L1 key. Ordinary API keys are **not
scopeable**: they can trade, request secure withdrawals to the owner's L1
address, transfer to sibling sub-accounts and mint public-pool shares. The
deployment: a dedicated funded sub-account, exactly one registered key held
by the Venue Signer, and no Lighter or L1 key held by the agent.

**Order lifecycle.** `in-progress`, `pending`, `open`, `filled` and thirteen
`canceled*` statuses; no separate partial-fill, cancel-requested or rejected
state. Order types limit and market (plus triggered types excluded in v1);
TIF IOC, GTT (5 min – 30 days, auto-expiring) and post-only. Every economic
field is inside the signed hash, which is known before signing.

**Cancel finality.** A terminal order status, carried by the sequenced
transaction that caused it, with the complete fill set, at the release
finality level (`VERIFIED` by default). Never HTTP 200, an absent order, or
elapsed time.

**Margin model.** Cross and isolated per (account, market); mode locked while
a position or order exists; open orders reserve no collateral; isolated
positions can draw fees from cross. **v1 is isolated-only**, on a dedicated
sub-account whose funded balance is the hard cap.

**State and versions.** API observations only (`VERIFIED`), no account-level
sequence; transactions carry `sequence_index`, `block_height`,
`committed_at` and `verified_at`; orders carry `order_version`.

**PerpPolicy v1.** `perp.placeOrder`, `perp.cancelOrder` (own orders only),
`perp.setMarketMargin` (flat markets only). Invariants: allowed markets,
isolated-only, max leverage, position size, committed notional, margin
commitment (shared sub-accounts only), `core.markedExposure`, allowed
direction.

**Signer and issuance.** Enforcement sits at the signature. `ADMIT_ATTEMPT`
commits the exact transaction hash and venue nonce slot before key custody
signs; after it, nothing is released on a crash, timeout or error. Unknown
attempts resolve only by a different known transaction executing in the same
slot (pending E-4).

**Performance and API constraints.** One serialized signer lane in v1;
Standard tier allows 60 REST requests per minute in total and 40
default-type transactions per minute; evidence is WebSocket-first; releases
wait for Ethereum verification of unmeasured delay (E-1); resting orders need
an attempt ceiling of at least 5 minutes.

## Explicit answers

| Question | Answer |
| --- | --- |
| Can the agent execute a perp order without passing Mandate? | **No**, if deployed as specified: the agent holds no key Lighter accepts for the principal's accounts, and the signer signs only ledger-bound attempts (T1–T7) |
| Does the agent possess the venue trading credential? | **No** |
| Does the signer issue an artifact before `ADMIT_ATTEMPT` is committed? | **No.** The hash is committed first; key custody signs only a committed hash ([attempt-lifecycle.md §3](attempt-lifecycle.md#3-the-issuance-protocol)) |
| Can `NEVER_ISSUED` be used after `ADMIT_ATTEMPT`? | **No** |
| Does cancel acknowledgement automatically release reservation? | **No.** Only a terminal status with the complete fill set at the release finality level does; Lighter's evidence does not make an acknowledgement final |
| Can pending orders be ignored in projected exposure? | **No.** Pending, cancel-requested and quarantined orders count in full; reductions are not credited |
| Can PerpPolicy equate instruments merely by ticker? | **No.** Markets resolve through reviewed registry claims (e.g. `KSHIB` is 1,000 SHIB per unit) |
| Are spot notional and perp margin treated as the same economic quantity? | **No.** Different kinds and units; no converter; a global budget names both separately |
| Is cross margin supported in PerpPolicy v1? | **No.** Lighter offers a real isolated mode; cross couples liquidation and collateral across positions |
| Does 7E.0 place any real order? | **No** |
| Does 7E.0 sign with a real venue credential? | **No** |

## Open questions

| # | Question | Blocks |
| --- | --- | --- |
| Q-1 | Release finality level: keep `VERIFIED`, or accept `SEQUENCED` by ADR once E-1 and E-3 are evidenced? | mainnet liveness |
| Q-2 | Which transaction type advances a stuck nonce slot harmlessly? | NX-2; needs E-4 |
| Q-3 | Durable store scope: a full durable ledger store, or a durable attempt journal the ledger's `ADMIT_ATTEMPT` depends on? | 7E.1 |
| Q-4 | `DISABLED` modules: who reviews held releases, and how is the review recorded? | 7E.1 |
| Q-5 | Adopt the maker-only key profile (venue-enforced narrowing, post-only only)? | W1; needs E-10 |
| Q-6 | Should `CREDENTIAL_SCOPE` sweep every account under the principal's L1 address for keys, not only the dedicated sub-account? | T1 residual |
| Q-7 | Should a later Core version name an `atExecution` mode for settings held by exclusive credential custody (margin mode, IMF)? v1 uses `NOT_REQUIRED` with the stronger guarantee in the adapter descriptor | none for v1 |
| Q-8 | How is USDC-quoted notional related to USD budgets: declared settlement assumption or valued with provenance? | global USD invariants |
| Q-9 | Authorization to capture read-only evidence (E-1, E-2, E-9, E-11) and to run testnet experiments (E-3…E-8, E-10) | venue conditions |
| Q-10 | Lighter's Robinhood Chain deployment uses the same key model with USDG collateral (S15). Is it a later venue for this repository's Robinhood work? | none for v1 |

## 7E implementation items that touch frozen packages

No contradiction with frozen Core, ledger or control semantics was found.
7E.1 does, however, need **additive** extensions to frozen packages, each
anticipated by the 7D freeze and each requiring owner approval:

| # | Item | Package | Anticipated by |
| --- | --- | --- | --- |
| F-1 | `ADMIT_ATTEMPT` event, per-reservation attempt records, global venue-slot and tx-hash uniqueness, and the `closeNeverIssued` precondition "no attempt admitted" | `packages/ledger`, `packages/control` | [implementation-7d.md §22.6](../core-v1/implementation-7d.md#226-never_issued-and-the-frozen-7e-issuance-precondition-r5): "the transition is 7E's" |
| F-2 | `DISABLED` module status (and an adapter status) distinct from `RETIRING` | `packages/ledger` registry (`ModuleStatus` is `'ACTIVE' \| 'RETIRING'`) | [signer-architecture.md §9](signer-architecture.md#9-module-and-adapter-lifecycle-retiring-is-not-disabled) |
| F-3 | a durable store implementation of the ledger store contract, or a durable attempt journal | `packages/ledger` store ([ADR 0023](../adr/0023-ledger-store-contract.md)) | [signer-architecture.md §11](signer-architecture.md#11-durability-is-now-a-real-requirement) |
| F-4 | the pre-execution requirement vocabulary and its evaluators | a new signer/adapter package; Core types only if the owner wants them in Core | [signer-architecture.md §7](signer-architecture.md#7-pre-execution-requirements) |

Readings recorded rather than changed: the illustrative `PerpOrderAction` in
[action-state-model.md §4.2](../core-v1/action-state-model.md#42-domain-payloads)
puts leverage and margin mode on the order; on Lighter they are account
settings, so v1 checks them against state and adds `perp.setMarketMargin`.
The frozen document marks those shapes as illustrative ("7B/7E define them"),
so this is a specification choice, not a contradiction.

## Stop

7E.0 ended with the specification. 7E.1 implemented it (see
[implementation-7e1.md](implementation-7e1.md)); 7E.2 closed custody's
verification gap and added the live state adapter
([implementation-7e2.md](implementation-7e2.md)). 7E stops before 7F.
