# Mandate Core v1 — Enforcement adapters

> **Status: Phase 7A specification, DRAFT pending review. Not implemented.**
> §4.1 describes how the frozen Phase 6 gate becomes the EVM adapter's
> enforcement point without modification. §4.2 states what Phase 7E must
> establish about a perp venue before its adapter is specified. §4.3–4.6 are
> sketches that keep the contract general, not designs.

## Contents

1. [Why adapters exist](#1-why-adapters-exist)
2. [The adapter contract](#2-the-adapter-contract)
3. [Non-bypassability](#3-non-bypassability)
4. [Adapter catalogue](#4-adapter-catalogue)
5. [Binding rules](#5-binding-rules)
6. [Summary](#6-summary)

---

## 1. Why adapters exist

Core decides. Deciding prevents nothing on its own: an agent that can act
without Core's decision is not governed by it. The thing that actually stops an
unauthorized action is an **enforcement point** — a contract that reverts, a
venue that rejects an unsigned order, an account that refuses an unpermitted
call — and whoever holds the **credential** it accepts.

Enforcement does not mean Solidity. The Phase 6 gate is one enforcement point;
a venue's order-signature check is another; a smart account's validation
module, a scoped API key, a governance delegate and a payment signer are
others. Each has different guarantees, and the difference must be written down
per adapter rather than assumed.

```text
ExecutionAuthorization ──bind──▶ ExecutionBinding ──issue──▶ EnforcementArtifact ──▶ enforcement point
        (Core)                     (adapter, pure)          (adapter custody)          (outside Mandate)
                                                                                            │
Observation ◀──── observation rule (adapter, pure) ◀──── reader (adapter, effectful) ◀─────┘
```

## 2. The adapter contract

Conceptual interface; the typed form is Phase 7B/7F:

```text
EnforcementAdapter {
  descriptor() → {
    ref                     AdapterRef { adapterId, version, adapterDigest }: adapterDigest content-addresses
                            the descriptor and the observation rule's semantics, bound into every
                            reservation and receipt under the same rule as a domain module (DOM-2)
    domains
    enforcementPoint        what refuses an unauthorized action
    credential              what credential it accepts, and who holds it
    agentCredentials        what the agent holds (must not produce artifacts: CRED-1)
    finalityLadder          ordered levels; the level at which each final status may be applied
    nonExecutionRule        the evidence proving no attempt under a lapsed reservation can execute, or NONE
    partialExecution        whether PARTIALLY_EXECUTED / CANCELLED-with-fills can occur
    attemptDedup            how several attempts under one reservation are kept within its worst case (EXEC-4)
    revocationPath          how Core revocation reaches the enforcement point, and its latency
  }
  bind(authorization, intent, admitted state)  → ExecutionBinding          pure; carries the reservation's
                                                                            ModuleRef and AdapterRef
  issue(binding)                                → EnforcementArtifact     custody; refuses unless ADMIT_ATTEMPT
                                                                            committed: reservation ACTIVE at this
                                                                            generation, t < attemptCeiling, lineage
                                                                            valid, issue-time state admission passed
                                                                            (reservations-reconciliation §10a)
  observe(evidence)                             → Observation | NONE      pure rule over read evidence
  revoke(scope)                                 → enforcement-side revocation request
}
```

Every adapter must answer, in its descriptor and its documentation:

| Question | Descriptor field |
| --- | --- |
| What exact action is authorized? | `bind` output: every execution parameter, canonical, and `bindingDigest` |
| What credential or enforcement point controls it? | `enforcementPoint`, `credential` |
| Can the agent bypass this enforcement point? | `agentCredentials` and the bypass analysis (§3) |
| How is successful execution observed? | `observe` rule, evidence types, `finalityLadder` |
| How is failure or cancellation observed? | `observe` rule, `nonExecutionRule` |
| Can it execute partially? | `partialExecution` |
| Can several attempts exceed the reservation? | `attemptDedup` |
| How fast does revocation bite? | `revocationPath` |

An adapter whose answers are not written down is not an adapter Core may
authorize through: a grant's set of allowed adapters names only adapters with a
reviewed descriptor.

## 3. Non-bypassability

**CRED-1: the agent holds no credential that can move principal resources, or
produce an artifact the enforcement point accepts, except through Core.**

Concretely, for an adapter to be non-bypassable:

1. every credential the enforcement point accepts for the principal's
   resources is held by the principal (and unused by the pipeline) or by the
   adapter's custody — never by the agent;
2. the adapter's custody produces artifacts only from a Core
   `ExecutionAuthorization` whose reservation is `ACTIVE` at the named
   generation (§2 `issue`);
3. no standing permission outside the enforcement point lets the credential
   holder act — no stray token allowance, no withdrawal right on a venue key, no
   second API key with trading scope;
4. revocation reaches the enforcement point (`revocationPath`).

What non-bypassability does **not** cover, stated per adapter below:

- a compromised custody key is a compromised principal for the resources it
  controls, as a compromised principal key is in Phase 6
  ([execution-gate.md §16](../execution-gate.md#16-residual-risks));
- a venue that misbehaves can do anything its custody of collateral allows;
- activity by the principal outside Mandate is not governed by it (it appears as
  ledger drift, [authority-ledger.md §11](authority-ledger.md#11-drift)).

## 4. Adapter catalogue

### 4.1 EVM Execution Adapter — the frozen Phase 6 gate

**Status: enforcement point implemented and frozen (Phase 6); adapter not built
(Phase 7F).**

| Question | Answer |
| --- | --- |
| Exact action | One `FIXTURE` market BUY or SELL: Candidate V3 (representation, side, exact quantity, price, notional, fee), under a per-generation MCE v2 mandate `M_g`, with `recipient` = principal, `fundingLimit`, chain-time `deadline`, `executionData` digest ([execution-gate.md §3](../execution-gate.md#3-commitment-hierarchy)) |
| Enforcement point | `MandateExecutionGate.execute`: principal signature over `M_g`, agent signature over the execution commitment, chain time, one settlement per `M_g` digest, candidate/mandate/market binding, measured deltas inside the signed bound |
| Credential | (a) the principal-side key whose signature over `M_g` the gate requires and whose balance and allowance the gate spends; (b) the agent key named in `M_g` |
| Agent holds | the agent key only |
| Success observed | `observationFromGateEvidence` at `FINALIZED`: consumed digest with its `MandateExecuted` log → `EXECUTED`, one fill of the candidate's quantity at the measured `actualDebit`/`actualCredit` |
| Failure observed | the same rule: unconsumed at a final block past the attempt ceiling or `M_g`'s `expiresAt` → `FAILED` |
| Non-execution rule | exists: `ATTEMPTS_EXPIRED` / `MANDATE_EXPIRED` bases |
| Partial execution | none — `FILL_OR_KILL` |
| Attempt dedup | the gate consumes `M_g`'s digest at most once, however many attempts are signed |
| Revocation path | Core stops deriving `M_g`; live `M_g` die at their `expiresAt` (≤ ceiling); **immediate** stop is revoking the principal account's allowance to the gate ([execution-gate.md §8](../execution-gate.md#8-approvals)) |

**Per-generation derivation.** For Core reservation `(actionDigest, g)` the
adapter derives a fresh `M_g`:

- `principal` = the principal's EVM account for this domain; `agent` = the
  actor's EVM key;
- asset, side, allowlists = the action's values, which Core has already checked
  are inside the effective authority's sets;
- `maxNotional` and the side's `economicLimit` = no more than the reserved
  worst-case contributions (rounded against the agent, UNIT-4);
- `notBefore` = now; `expiresAt` ≤ the reservation's attempt ceiling;
- a fresh `nonce`, so `M_g`'s digest is new for every generation.

The candidate is built and verified exactly as today (router, kernel `verify` on
fresh handoff state); the kernel's replay record for `M_g` is `RESERVE`d; the
attempt is admitted with `admitAttemptUnderReservation`; the agent signs the
commitment it returns. Nothing in MCE v2, Candidate V3, the gate or the kernel
changes.

**Issue-time state on this adapter.** The kernel's mandatory fresh handoff
verification ([ADR 0016](../adr/0016-pipeline-time-and-handoff-freshness.md)) is
already an issue-time revalidation of the kernel's state inputs, and it runs
before any artifact exists. The dependencies that must hold at execution are
enforced by the gate itself, so they are `ENFORCED_BY_ARTIFACT`: the pinned
fixture price and market table, chain time, and the measured balance deltas.
Real-market price, halt and epoch state would not be, which is why
`REAL_MARKET` remains refused.

**Custody of the principal-side key is the adapter's central open question**,
because the gate requires `ECDSA recover == mandate.principal` and spends that
account's tokens, and does not support ERC-1271:

| Option | Autonomy | Trust | Status |
| --- | --- | --- | --- |
| A. The principal signs each `M_g` | none — a human per action | minimal: the principal's own key | possible today |
| B. A dedicated funded EOA whose key is held by the adapter's signer, used for nothing but `M_g` signatures and one allowance to the gate | full | the signer is in the TCB; its compromise is principal compromise for that account's balance. The account's balance is an onchain hard cap on capital the signer can ever deploy | possible today; recommended for 7F, pending review |
| C. A contract principal (smart account, ERC-1271) | full | the account's validation logic | **requires a new gate version**; not Phase 6 |

Under B, the principal funds the account with no more than the capital the
EVM domain may use. The ledger bounds what Core authorizes; the balance bounds
what even a compromised signer can spend.

**EXEC-2 on this adapter, stated precisely.** The agent signs execution terms
(candidate, recipient, `fundingLimit`, deadline, route data) itself. An attempt
signed through admission is exactly the bound one. An attempt the agent signs
outside admission under a live `M_g` is still bounded by `M_g` — principal-side
limits the adapter derived from the reservation — and still settles at most
once; this is the Phase 6R.1b rogue-attempt residual, now bounded by a
reservation-derived `M_g` rather than a standing mandate.

**Limits inherited from Phase 6.** Only labelled fixture markets; `REAL_MARKET`
refused until inclusion-time state is authenticated; no partial fills;
recipients other than the principal refused.

### 4.2 Venue Signer — perps (Phase 7E)

**Status: requirements only.** Nothing in this repository evidences the API,
order types, key model, expiry semantics or finality of any perp venue,
including Lighter. Phase 7E must establish each of the following from the
venue's authoritative documentation and recorded behaviour before the adapter
is specified; where the venue cannot supply one, the consequence is stated.

| Question | Requirement | If the venue cannot meet it |
| --- | --- | --- |
| Exact action | one order: market, side, size, limit price, leverage/margin mode, reduce-only flag, time in force, client order id or nonce, order expiry ≤ attempt ceiling | fields the venue cannot bind are not authorizable |
| Enforcement point | the venue's order-signature check, plus the Venue Signer that holds the account's trading key and signs only Core-bound orders | — |
| Credential | a trading-scoped key for the principal's venue account, held by the Venue Signer | — |
| Agent holds | nothing that can sign orders or move collateral on the account | if the venue has no trading-only key scope, withdrawal rights must be demonstrably absent from the signer's key, or the adapter is not non-bypassable |
| Success observed | fills with venue fill ids and cumulative executed quantity, ordered by a venue sequence, from the API (`VERIFIED`) or signed attestations | API-only observation is `VERIFIED`, not trustless, and is labelled so |
| Failure / cancel observed | terminal order status at a venue-defined final level | without a final level, `CANCELLED` is never applied and cancelled orders stay reserved until expiry evidence |
| Non-execution rule | order expiry or nonce invalidation that makes an order provably dead after a known time | reservations the adapter cannot resolve stay quarantined |
| Partial execution | yes | — |
| Attempt dedup | one live order per reservation, or venue-enforced client-order-id uniqueness | multiple live orders under one reservation are forbidden |
| Revocation path | cancel-all for the account; rotate or disable the trading key | latency is the venue's |
| Reduce-only | venue-enforced flag | reduce-only must not be relied on by any exception (reservations-reconciliation §12) |

The venue itself remains trusted for custody of posted collateral and for the
correctness of its matching; Mandate bounds what is sent, not what the venue
does with it.

### 4.3 Smart-account permission (future)

Enforcement point: the account's validation logic (a permission or session-key
module). Artifact: a single-use permission bound to exact call data and a
validity window ≤ the ceiling. Non-bypassable to the extent the module is
correct and the agent holds no other key for the account. Observation: onchain,
authoritative at a finality level. This is the natural home for contract
principals (option C above) and needs its own gate or module; not v1.

### 4.4 API credential operation (future; weakest)

Enforcement point: the venue's API key check. The venue trusts the key
entirely, so the only control is that the Mandate-held key is scoped
(no withdrawal) by a venue-enforced permission and that the agent holds no
other key. Observation is API-only. Drift is likely and must be detected.
Documented so that its weakness is explicit when it is used.

### 4.5 Governance authorization (future)

Exact action: proposal id, choice, voting-power source. Enforcement point: the
voting key or delegation contract held by custody. Observation: the onchain
vote record. Quantities: a `COUNT` budget of votes cast; voting power is not an
economic quantity in v1.

### 4.6 Payment authorization (future)

Exact action: recipient, token, amount, reference. Enforcement point: a
custody-held signer or smart-account permission. Observation: the transfer at a
finality level. Contributions: `TOKEN_AMOUNT` / `CAPITAL`, required; the
recipient set is the authority term that matters most.

## 5. Binding rules

- **EXEC-1 — the artifact is bound to the authorized action.** Every parameter
  in `ExecutionBinding` is committed by the artifact, cryptographically or by
  exact equality the enforcement point checks. Each adapter needs a
  field-by-field mutation test: mutating any bound field makes the enforcement
  point refuse — as `bind-*` vectors do for the gate.
- **EXEC-2 — the agent cannot alter authorized parameters after approval.**
  Either the agent does not sign the artifact at all (Venue Signer, payment),
  or every parameter it signs is bounded at the enforcement point by values
  derived from the reservation (EVM: `M_g`).
- **EXEC-3 — every artifact expires by the attempt ceiling.** Its validity
  window closes at or before the reservation's `attemptCeiling`, which is at or
  before the intent's and every lineage node's expiry.
- **EXEC-4 — attempts under one reservation cannot together exceed its worst
  case.** By enforcement-point deduplication (the gate's digest, a venue's
  client-order-id uniqueness), or by one live attempt at a time with the
  previous attempt's non-execution proven before the next is issued.
- **EXEC-5 — issuance is conditional on the ledger.** `issue` refuses unless
  `ADMIT_ATTEMPT` has committed: the reservation is `ACTIVE` at the
  authorization's generation, `t < attemptCeiling`, the lineage is still valid
  and issue-time state admission passed. A quarantined, closed or superseded
  reservation, or a revoked lineage, issues nothing.
- **EXEC-6 — no artifact outlives the state it depends on.** An artifact's
  validity ends no later than the expiry of every `BOUNDED_BY_FRESHNESS` state
  binding of its reservation. Every other execution-time dependency is either
  enforced by a named artifact field the enforcement point checks, or declared
  pre-trade only ([action-state-model.md §5.5](action-state-model.md#55-state-bindings-freshness-modes-and-execution-dependence)).

## 6. Summary

| Adapter | Enforcement point | Agent can bypass? | Partial | Non-execution rule | Status |
| --- | --- | --- | --- | --- | --- |
| EVM (Phase 6 gate) | gate contract | no, if principal-side key is custody-held (B) or the principal's own (A) | no | yes | enforcement point frozen; adapter 7F |
| Venue Signer (perps) | venue signature check + signer | no, if the venue offers trading-only keys and the agent holds none | yes | venue-dependent | requirements; 7E |
| Smart-account permission | account validation | no, if the module is correct | call-dependent | yes (onchain) | future |
| API credential | venue API key | no, if key scope is venue-enforced | yes | venue-dependent | future, weakest |
| Governance | voting key / delegation | no, if custody-held | no | yes (onchain) | future |
| Payment | signer / account permission | no, if custody-held | no | yes (onchain) | future |
