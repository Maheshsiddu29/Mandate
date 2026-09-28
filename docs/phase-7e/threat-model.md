# Phase 7E.0 — Threat model: Lighter Venue Signer

> **Status: Phase 7E.0 analysis. Not implemented.** Assumes the deployment
> in [signer-architecture.md §3](signer-architecture.md#3-credential-model):
> a dedicated, funded sub-account; exactly one registered API key, held by
> the signer; no Lighter or L1 key held by the agent. Evidence ids refer to
> [venue-evidence.md](venue-evidence.md).

Outcome vocabulary: **prevent** — the action cannot happen; **detect** —
it can happen and is noticed before the next issue; **quarantine** — authority
stays held until evidence resolves it; **unresolved** — neither the venue nor
the design closes it, stated so.

## Threats

| # | Threat | Outcome | How | Residual |
| --- | --- | --- | --- | --- |
| T1 | **Agent has a general trading key** for the principal's accounts | **prevent** (by deployment) + **detect** | the agent is issued none; `CREDENTIAL_SCOPE` refuses every issue unless the sub-account's `apikeys` listing shows exactly the signer's key (L-OBS-5) | a key on a sibling sub-account is invisible to that check; the deployment rule forbids it, and a principal-wide `accountsByL1Address` + `apikeys` sweep is a 7E.1 option |
| T2 | **Agent has a withdrawal key** | **prevent** (by deployment) | withdrawals need an API key (secure, to the owner's L1 only) or the L1 key (fast/other destinations) (L-WD-1, L-WD-2); the agent has neither | none beyond T1 |
| T3 | **Agent calls Lighter REST directly** | **prevent** | `sendTx` needs a valid signature (L-ACC-9); the agent can read public data but cannot sign | an agent reading through the principal's L1 identity could consume the shared rate bucket (L-RL-1, L-RL-6) — mitigated by giving it no token for that identity (§8 of reconciliation-evidence) |
| T4 | **Agent uses another SDK** (Python, Go, WASM, a third-party client) | **prevent** | every SDK signs locally with a key (L-ACC-9); without one there is nothing to sign with | — |
| T5 | **Agent replays a signed artifact** | **prevent** | the agent never receives signed bytes (signer-architecture §5–6); even a leaked artifact executes at most once per nonce slot (L-TX-4) and dies at `ExpiredAt` | a leaked, not-yet-executed artifact can be submitted by whoever holds it until `ExpiredAt` — with exactly the authorized fields |
| T6 | **Agent mutates an order after authorization** | **prevent** | every economic field is inside the signed hash (L-TX-2); a change invalidates the signature; `modify` is never signed in v1 | `price_protection` is an unsigned `sendTx` flag (L-TX-9, E-9); the agent never submits, so it cannot set it |
| T7 | **Signer signs an arbitrary payload** | **prevent** (by design) | there is no sign-payload interface; the signer builds each transaction from the ledger's binding; key custody signs only a hash committed in `ADMIT_ATTEMPT` (attempt-lifecycle §3) | correctness of the signer's code is in the TCB |
| T8 | **Signer key has excessive permissions** | **unresolved at the venue**; mitigated | Lighter keys are not scopeable (L-ACC-6): the key *can* withdraw to the owner's L1, transfer to sibling sub-accounts, mint public-pool shares, approve a same-master integrator (L-TX-11). The allowlist (signer-architecture §4) refuses them in software; the funded sub-account caps what any of them can move; siblings hold no agent key, so a transfer does not reach the agent | a **compromised signer** can move the sub-account's collateral into a public pool run by someone else, or to siblings. The maker-only profile (L-ACC-7, E-10) is the only venue-enforced narrowing |
| T9 | **Agent compromises the signer's IPC** | **prevent** | the IPC carries an authorization id only; the signer re-reads the ledger and recomputes the binding under the exact module and adapter; key custody checks the committed hash (signer-architecture §6) | an attacker with **ledger write access** is a compromised Control, outside this table |
| T10 | **Duplicate submission** | **prevent** | retries resend identical bytes; the venue executes a slot at most once (L-TX-4); the ledger never binds a slot or hash twice (attempt-lifecycle §6 R3, R4) | — |
| T11 | **Duplicate artifacts for one authorization** | **prevent** | one live attempt per reservation; key custody never signs a slot twice with different content (R2, R9) | — |
| T12 | **Stale market or account state** | **prevent** (pre-trade) / stated (post-trade) | `STATE_REVALIDATION` at issue with `RECHECK`; conservative ledger-consistency rule where no sequence exists (perp-policy §6); price-dependent authority carried by the signed price bound | a GTT order can rest up to its expiry while the mark moves; marked-exposure invariants are pre-trade conditions, as Core documents (CORE-CONC-1) |
| T13 | **Signer crash after `ADMIT_ATTEMPT`** | **quarantine** | nothing is released; the attempt is resolved by its `txHash` or by nonce supersession (attempt-lifecycle §4–5) | without E-4, supersession is unavailable and the attempt stays quarantined until found — liveness, not safety |
| T14 | **Cancel acknowledged but order fills afterwards** | **quarantine** + **detect** | cancel requests release nothing; release requires a terminal status with the complete fill set at `VERIFIED` (reconciliation-evidence §3) | if the venue ever sequenced a fill after a sequenced cancel (E-3), it would be `OVERRUN` + `CONFLICT`, freezing the adapter |
| T15 | **Margin mode or leverage changed under a live order** | **prevent** (by custody) | only the signer's key can send `UpdateLeverage`; it refuses while any Mandate attempt in the market is live; the venue refuses mode changes with open positions or orders (L-MAR-2) | the principal's L1 key could register another key and change it — that is principal activity, detected as drift and by `CREDENTIAL_SCOPE` |
| T16 | **Front-end key registered on the Mandate sub-account** | **detect** | `CREDENTIAL_SCOPE` sees a second key and refuses all issuance | orders placed from the front end are foreign orders → drift, increases refused |
| T17 | **Rate-limit starvation of the signer** | **detect**; partly **unresolved** | separate IP and L1 identity for agent-side reads; WebSocket-first evidence | Lighter's limits are per L1 address too (L-RL-1); a principal using the same L1 address elsewhere shares the budget |
| T18 | **Isolated position drains cross collateral via fees** | **bounded** | dedicated sub-account caps the pool; `perp.isolatedOnly` keeps no cross positions to couple with; margin drift detected (reconciliation-evidence §7) | isolation is weaker than its name (L-MAR-6) |
| T19 | **Venue changes market decimals or multiplier between issue and execution** | **unresolved**, narrow | metadata is bound by digest at decision and re-admitted at issue | a change inside an order's life would reinterpret signed integers; no venue guarantee exists |
| T20 | **Venue misbehaves** (wrong matching, withheld proofs) | outside Mandate | the venue is trusted for custody and matching, as for every venue (enforcement-adapters §4.2); the Ethereum escape hatch is the principal's exit (L-FIN-5) | as stated |
| T21 | **Signer key compromise** | **detect** + **revoke** | `NONCE_SLOT` sees nonces it did not allocate; the principal revokes the key with the L1 key and cancels all via Ethereum (signer-architecture §8) | until revoked, the attacker has T8's capabilities over the sub-account's collateral |

## What the agent can and cannot do, in one line each

- It **can** propose `ActionIntent`s and read public market data.
- It **cannot** sign any Lighter transaction, obtain a signature, obtain
  signed bytes, submit on the principal's behalf, choose a nonce, key,
  `ExpiredAt`, client order index or integrator, cancel an order Mandate did
  not place, or change leverage while it has a live order.

## Trusted computing base for this adapter

- the signer (issuer, key custody, journal, submitter) and its allowlist;
- the ledger store and Control, for authorization and `ADMIT_ATTEMPT`;
- the principal's handling of the L1 key and the sub-account setup;
- Lighter's sequencer, prover and contracts, for everything a venue is
  trusted for.

The agent, its model, its prompts and its tools are **not** in the TCB.
