# Phase 7E.0 — Venue Signer architecture

> **Status: Phase 7E.0 design. Not implemented.** No key is generated,
> stored or used by anything in this repository. Real custody is out of scope
> for 7E.0; this fixes the boundary a 7E.1 implementation must respect. The
> issuance protocol itself is in [attempt-lifecycle.md](attempt-lifecycle.md).

## Contents

1. [The last point of prevention](#1-the-last-point-of-prevention)
2. [Topology](#2-topology)
3. [Credential model](#3-credential-model)
4. [What the signer will and will not sign](#4-what-the-signer-will-and-will-not-sign)
5. [The enforcement artifact](#5-the-enforcement-artifact)
6. [Process isolation and who touches what](#6-process-isolation-and-who-touches-what)
7. [Pre-execution requirements](#7-pre-execution-requirements)
8. [Rotation and revocation](#8-rotation-and-revocation)
9. [Module and adapter lifecycle: retiring is not disabled](#9-module-and-adapter-lifecycle-retiring-is-not-disabled)
10. [Draft adapter descriptor](#10-draft-adapter-descriptor)
11. [Durability is now a real requirement](#11-durability-is-now-a-real-requirement)

---

## 1. The last point of prevention

On Lighter an order executes when the sequencer accepts a transaction whose
Schnorr signature verifies against the public key registered at
`(accountIndex, apiKeyIndex)` and whose nonce is the next one for that key
(L-ACC-2, L-TX-4). `sendTx` takes nothing else: no session, no account login.
**Whoever holds a validly signed transaction can submit it** until its
`ExpiredAt` passes or its nonce slot is consumed (L-TX-7).

So the chain of control is:

```text
decide ──▶ sign ──▶ (signed bytes exist) ──▶ submit ──▶ sequencer verifies ──▶ match
             ▲
             └── last point Mandate controls
```

The sequencer's signature check is the **enforcement point**: it refuses
anything not signed by a registered key. The **last point at which an
unauthorized order can still be prevented by Mandate** is the signing
operation itself. After it, only the venue's own checks, the signed
`ExpiredAt`, the signed limit price and the nonce slot constrain the order.

Therefore:

- Mandate's enforcement sits **at signing**, inside the Venue Signer;
- the signing key is registered at an index no one else can sign for;
- an `ADMIT_ATTEMPT` naming the exact transaction hash commits **before** the
  signature exists ([attempt-lifecycle.md §3](attempt-lifecycle.md#3-the-issuance-protocol));
- signed bytes never leave the signer's trust boundary except to the venue.

## 2. Topology

```text
   Agent  (holds: its actor key for ActionIntent signatures; NO Lighter key, NO L1 key)
     │   ActionIntent (perp.placeOrder / cancelOrder / setMarketMargin), signed by actor key
     ▼
   Mandate Control  (packages/control: decide, reserve — pure over admitted state)
     │   ExecutionAuthorization + reservation (ledger CAS)
     ▼
 ┌───────────────────────────── Venue Signer trust boundary ─────────────────────────────┐
 │  Issuer        re-reads the reservation from the ledger; evaluates pre-execution      │
 │                requirements; allocates a nonce slot; builds the unsigned tx;           │
 │                computes its hash; commits ADMIT_ATTEMPT by CAS                          │
 │  Key custody   signs exactly the committed hash; holds the only private key             │
 │  Journal       durably stores the signed bytes against the attempt                       │
 │  Submitter     sends the stored bytes to Lighter; records ACK / UNKNOWN                  │
 │  Reader        reads tx / order / trade evidence (7F turns it into observations)        │
 └────────────────────────────────────────────────────────────────────────────────────────┘
     │   signed L2 transaction (sendTx)
     ▼
   Lighter sequencer  (enforcement point: signature at (account, apiKeyIndex), nonce, ExpiredAt)

   Principal  (holds: the L1 key — cold, outside the pipeline)
     └── registers the signer's public key; revokes it; emergency cancel-all via Ethereum
```

The signer takes **no instruction from the agent**. What it receives from
Control is an authorization *identifier*; it re-reads the reservation and
recomputes the binding itself (§6).

## 3. Credential model

| Credential | Who holds it | What it can do on Lighter | Used by the pipeline? |
| --- | --- | --- | --- |
| **Principal L1 key** (Ethereum) | the principal, cold | register and revoke API keys on every account it owns (L-ACC-4, L-ACC-5); withdraw to any address; transfer to other owners; Ethereum priority cancel-all and reduce-only IOC (L-WD-5) | **no** — used only for setup, rotation, revocation and emergencies |
| **Signer API key** | the Venue Signer's key custody, only | everything any Lighter API key can do on its one account (L-TX-11) | yes — and the signer's allowlist (§4) is what narrows it |
| **Agent credentials** | the agent | **none on Lighter.** No API key on the dedicated sub-account, the master, or any sibling sub-account; no L1 key | — |
| Read-only token (optional) | a Mandate state reader | auth-gated reads only; cannot sign (L-ACC-8) | yes, for state and evidence |

**CRED-1 on Lighter** ([enforcement-adapters.md §3](../core-v1/enforcement-adapters.md#3-non-bypassability)):
no credential available to the agent can produce a transaction Lighter
accepts for the principal's accounts. Concretely, a correct deployment is:

1. **A dedicated sub-account** for the Mandate perp domain (§3 of
   [perp-policy-v1.md](perp-policy-v1.md#3-margin-mode-decision-isolated-only)),
   funded with no more than that domain may use.
2. **Exactly one registered API key on it — the signer's.** Indices 0–3 are
   the front end's (L-ACC-2); the principal must not connect the web or mobile
   app to this sub-account, because doing so registers a key the signer does
   not control. The pre-execution requirement `CREDENTIAL_SCOPE` (§7) checks
   the `apikeys` listing (index 255, L-OBS-5) before every issue and refuses
   if any other index holds a key.
3. **The agent holds no Lighter key under the principal's L1 address at all.**
   Not on the master and not on a sibling sub-account: although a sibling's
   key cannot sign for the dedicated sub-account (keys are per account,
   L-ACC-3), the dedicated sub-account's signer key can transfer *to* siblings
   (L-WD-3), and a sibling key in the agent's hands would turn any such
   transfer — by a signer bug or compromise — into agent-controlled funds.
4. **The agent never receives the principal's L1 key**, which could register
   a new key anywhere.
5. The signer key is generated **inside** the signer boundary; only its
   public key leaves, for the principal to register with an L1 signature.

**What CRED-1 cannot make true on Lighter.** Lighter has no permission scope
for an ordinary API key (L-ACC-6). The signer key *can* request a secure
withdrawal (to the principal's own L1 address, L-WD-1), transfer to sibling
sub-accounts (L-WD-3), mint public-pool shares (L-WD-4), create sub-accounts,
change leverage and approve a same-master integrator (L-TX-11). None of these
reach the agent, so none is an *agent bypass*; all of them are what a
**compromised signer** could do. The signer's refusal to sign them (§4) is a
software control, not a venue control. That is the central limitation recorded
in [venue-fit.md](venue-fit.md).

**Hardening option — maker-only key.** On a premium account the signer key
can be marked maker-only, which the venue restricts to post-only orders,
their modification, cancel and cancel-all (L-ACC-7). If E-10 confirms the
restriction is exhaustive (no withdraw, transfer, mint or leverage change),
a v1 deployment limited to `LIMIT_POST_ONLY` orders would move the allowlist
from software into the venue. It costs taker access, `setMarketMargin` (which
would need a second, normally-unregistered key) and a premium tier. It is
offered as a deployment profile, not the default.

## 4. What the signer will and will not sign

The signer has no "sign this payload" interface. It has three issue
operations, one per v1 action type, each of which builds the transaction
itself from the reservation's `ExecutionBinding` and admitted state.

| Lighter tx type | Signed? | Conditions (all must hold, checked by the signer at issue) |
| --- | --- | --- |
| `L2CreateOrder` (14) | **yes** | `perp.placeOrder` reservation `ACTIVE` at the authorization's generation; order type `LIMIT` or `MARKET`; TIF per the action; every field equal to the binding (§5); `TriggerPrice = 0`; integrator attributes nil; self-trade attributes set to the module's fixed values; `AccountIndex` = the dedicated sub-account; market's margin mode `ISOLATED` and IMF as admitted |
| `L2CancelOrder` (15) | **yes** | `perp.cancelOrder` authorized; the target reservation's order was placed by this signer; `Index` = the client order index the signer bound to it |
| `L2UpdateLeverage` (20) | **yes** | `perp.setMarketMargin` authorized; `MarginMode = ISOLATED`; the market is flat for the account — no position, no open order, and **no live Mandate attempt in that market** |
| `L2CancelAllOrders` (16) | only as the signer's own safety action | immediate cancel-all on halt or revocation (§8); scheduled cancel-all as an optional dead-man's switch (L-ORD-12); never issued for an agent |
| nonce advance ([attempt-lifecycle.md §5](attempt-lifecycle.md#5-resolving-an-unknown-attempt)) | only to resolve an unknown attempt | exact tx type to be chosen once E-4 is evidenced |
| `L2ModifyOrder`, `L2CreateGroupedOrders`, SL/TP/TWAP | **never** in v1 | out of scope ([perp-policy-v1.md §1](perp-policy-v1.md#1-scope)) |
| `L2Withdraw`, `L2Transfer` (any destination), `L2MintShares`, `L2BurnShares`, `L2StakeAssets`, `L2UnstakeAssets`, `L2CreateSubAccount`, `L2CreatePublicPool`, `L2UpdatePublicPool`, `L2ApproveIntegrator`, `L2UpdateMargin`, `L2UpdateAccountConfig`, `L2UpdateAccountAssetConfig` | **never** | collateral movement or configuration; no v1 action produces them |
| `L2ChangePubKey` | cannot | requires the L1 key (L-ACC-4) |
| anything for another `AccountIndex` or `ApiKeyIndex` | **never** | the signer is bound to one (account, key) |

The allowlist is part of the adapter's reviewed descriptor and of its
`adapterDigest` (DOM-2). Changing it is a new adapter version.

## 5. The enforcement artifact

**Artifact:** one signed Lighter L2 transaction.

```text
LighterArtifact {
  txType        14 | 15 | 20 | 16
  txInfo        canonical JSON of the tx fields, including Sig             what sendTx takes
  txHash        the tx's message hash (L-TX-3)                              committed in ADMIT_ATTEMPT before signing
  venueSlot     { chainId, accountIndex, apiKeyIndex, nonce }               at most one executed tx per slot (L-TX-4)
}
```

**EXEC-1 — every authorized field is committed by the artifact.** For
`L2CreateOrder` the venue's signed hash covers every field that carries
economic meaning (L-TX-2):

| `ExecutionBinding` field | Lighter tx field | Committed by |
| --- | --- | --- |
| venue, chain | chain id (hash input) | signature |
| account | `AccountIndex` | signature |
| signer key | `ApiKeyIndex` | signature + registered key |
| market | `MarketIndex` | signature |
| side | `IsAsk` | signature |
| size | `BaseAmount` (at admitted `size_decimals`) | signature |
| price bound | `Price` (at admitted `price_decimals`) | signature |
| execution | `Type`, `TimeInForce` | signature |
| reduce-only | `ReduceOnly` | signature |
| order expiry | `OrderExpiry` (ms, ≤ attempt ceiling) | signature |
| attempt lookup key | `ClientOrderIndex` (derived from the attempt id) | signature |
| attempt validity | `ExpiredAt` (ms, ≤ attempt ceiling and ≤ any `BOUNDED_BY_FRESHNESS` expiry) | signature |
| replay slot | `Nonce` | signature + sequencer nonce rule |
| fees / routing | integrator attributes nil; self-trade attributes fixed | signature (attributes hash) |
| margin mode, IMF | **not in the order** (L-ORD-16) | custody: only the signer can change them, and refuses while an order is live (§4) |

The field-by-field mutation test EXEC-1 requires
([enforcement-adapters.md §5](../core-v1/enforcement-adapters.md#5-binding-rules))
is, for Lighter, a test that mutating any bound field changes `txHash` and
so invalidates the signature. It can run offline against `lighter-go`'s hash
function in 7E.1.

**What the agent can never obtain from Mandate:** a signature over a hash it
chose; a signed transaction (the agent never receives the bytes); the key or
any derivative; a transaction without an `ExpiredAt`; an order without a
price bound; a cancel for an order Mandate did not place; a signature for any
tx type outside §4. One `ExecutionAuthorization` yields at most one live
artifact at a time ([attempt-lifecycle.md §6](attempt-lifecycle.md#6-replay-1-for-execution)).

**The unsigned `price_protection` flag** on `sendTx` (L-TX-9) is not in the
signature. The submitter always sends the venue default (`true`). Because the
agent never holds the bytes, it cannot resubmit with a different flag; the
flag's meaning is open (E-9).

## 6. Process isolation and who touches what

| Component | Process / boundary | Reads private key? | Holds signed bytes? | Talks to Lighter? |
| --- | --- | --- | --- | --- |
| Agent | its own process, its own host or sandbox | no | **no** | no (at most read-only market data, not through the principal's L1 identity — L-RL-1) |
| Mandate Control | library in the control service | no | no | no |
| Ledger store | durable store (§11) | no | no | no |
| Signer: issuer | signer process | no | no | reads `apikeys`, `nextNonce` |
| Signer: key custody | a separate process or enclave inside the signer boundary, OS-level isolation from everything else; the key is loaded from an encrypted store and never serialized out | **yes — the only component that does** | produces them | no |
| Signer: journal | signer-local durable store | no | yes | no |
| Signer: submitter | signer process | no | yes | `sendTx` |
| Signer: reader | signer process (or a separate evidence service) | no | no | read-only account, tx, order and trade endpoints |

- **IPC.** Control → signer is mutually authenticated and carries only an
  `ExecutionAuthorizationId`. The signer treats the message as a hint: it
  reads the reservation from the ledger, recomputes the `ExecutionBinding`
  under the reservation's exact `ModuleRef` and `AdapterRef`, and refuses on
  any mismatch. A forged or replayed IPC message therefore cannot produce an
  artifact that the ledger did not authorize.
- **Key custody's interface** is "sign this hash for attempt A". It re-reads
  the `ADMIT_ATTEMPT` for A and refuses unless the committed `txHash` equals
  the hash it is asked to sign. Even a compromised issuer cannot obtain a
  signature over an uncommitted hash — unless it can also write the ledger,
  which is why ledger write access belongs to the signer and Control only.
- **Nothing reusable crosses to the agent.** The agent learns an attempt's
  outcome as observations and receipts, never as signed material.

This is a design boundary, not an implementation. 7E.1 builds a local
fixture signer with a test key to exercise the protocol; real custody is a
separate, later decision.

## 7. Pre-execution requirements

Revalidation of market state is one requirement among several that must hold
immediately before a signature exists. The signer evaluates a list of
**pre-execution requirements**, all before `ADMIT_ATTEMPT`, and binds their
results into the attempt:

```text
PreExecutionRequirement {
  kind       STATE_REVALIDATION | CREDENTIAL_SCOPE | NONCE_SLOT | MODULE_TRUST
             | RUNTIME_PROVENANCE | RUNTIME_CERTIFICATION | HARNESS_ATTESTATION     closed, versioned vocabulary
  subject    what it is about: the reservation, the venue account, the key, the module, the agent runtime
  evaluator  CORE (pure, Core-defined) | ADAPTER (pure rule over evidence the adapter read)
}

PreExecutionResult {
  kind, subject
  outcome    PASS | FAIL | UNKNOWN                   UNKNOWN refuses, as everywhere in Core
  evidence   digest references to what was read
  evaluatedAt
}

ADMIT_ATTEMPT carries H(ordered PreExecutionResults)
```

| Kind | 7E status | What it checks |
| --- | --- | --- |
| `STATE_REVALIDATION` | **specified, 7E.1** | Core's issue-time admission and revalidation ([reservations-reconciliation.md §10a](../core-v1/reservations-reconciliation.md#10a-issue-time-state-admission-and-revalidation)), unchanged |
| `CREDENTIAL_SCOPE` | **specified, 7E.1** | the dedicated sub-account has exactly one registered API key, at the signer's index, with the signer's public key (`apikeys`, L-OBS-5); the sub-account's master is the principal's |
| `NONCE_SLOT` | **specified, 7E.1** | the venue's `nextNonce` for the signer key equals the signer's allocator (L-TX-4); a mismatch means something else signed with the key and is treated as drift and possible compromise |
| `MODULE_TRUST` | **specified, 7E.1** | the reservation's `ModuleRef` and `AdapterRef` are not `DISABLED` (§9) |
| `RUNTIME_PROVENANCE` | reserved | which agent runtime, model and harness produced the intent — the runtime-provenance need identified in user interviews |
| `RUNTIME_CERTIFICATION` | reserved | that runtime's certification status |
| `HARNESS_ATTESTATION` | reserved | a signed attestation from the harness |

The reserved kinds exist in the vocabulary so that adding them later is a new
evaluator, not a new signer contract. A grant or policy that *requires* a
reserved kind before 7E has an evaluator for it refuses every issuance
(`UNKNOWN`), so the vocabulary cannot be used to claim a check that does not
run.

## 8. Rotation and revocation

**Rotation** (conceptual; no key is handled in 7E.0):

1. The signer generates a new key pair inside custody and exports the public
   key.
2. The principal registers it at a **new** index with an L1 signature
   (L-ACC-4). Two keys are now registered, so `CREDENTIAL_SCOPE` refuses all
   new issuance — deliberately.
3. The signer stops admitting attempts under the old key and waits until
   every attempt bound to the old `(apiKeyIndex, nonce)` slots is resolved.
4. The principal revokes the old index (zero public key, L-ACC-5).
5. `CREDENTIAL_SCOPE` passes again with the new key; issuance resumes on it.
   Old slots stay in the ledger's attempt history, so no old attempt's
   identity is reusable.

**Revocation**, by increasing force:

| Path | Who | Effect | Latency |
| --- | --- | --- | --- |
| Core revocation of a lineage node | principal, through Core | no new reservations or `ADMIT_ATTEMPT` under it; issued attempts reconcile normally | immediate at the ledger |
| Signer halt | operator | no new attempts; immediate `L2CancelAllOrders` signed by the signer | one sequencer round trip; orders already executing may fill |
| Key revocation | principal, L1 key | `ChangePubKey` to a zero key: nothing signed with the old key is accepted afterwards, including any artifact already signed but not yet executed | one L2 transaction |
| Ethereum priority cancel-all | principal, L1 key | cancels all orders even if the signer and the API are unavailable (L-WD-5, L-FIN-5) | Ethereum inclusion plus the sequencer's priority deadline |

Revoking the key does not release anything in the ledger. Attempts issued
before revocation still resolve only on evidence (TIME-1).

## 9. Module and adapter lifecycle: retiring is not disabled

Two different states must not be confused:

| State | Meaning | New decisions | New `ADMIT_ATTEMPT` | Existing terms bound to it | Reconciliation of existing reservations |
| --- | --- | --- | --- | --- | --- |
| `RETIRING` (exists, 7D.1/7D.3) | trusted semantics, retired for new use | refused (`MODULE_RETIRING`) | allowed for existing reservations, which keep their exact module (DOM-2) | still evaluated under exactly that module (7D.3: evaluating a constraint can only refuse more) | normal |
| `DISABLED` (**new, required for 7E**) | no longer trusted — found unsafe | refused | **refused** (`MODULE_TRUST`, §7) | evaluated as `UNKNOWN` — a term whose definition is untrusted cannot be relied on to refuse, so every risk-increasing action under it refuses | observations are still applied and fills consumed (consumption only ever holds more authority); a **final release is held** until the owner reviews, because the untrusted `settle` computes how much is released |

A disabled module's artifact stays in the archive **for historical replay
only**, so the history it decided can still be reproduced byte for byte
(7D.2). "Old grants reference it" is never a reason to keep using it for new
economic authority.

The same distinction applies to an **adapter**: Core already freezes an
adapter for increases on a finality `CONFLICT`
([reservations-reconciliation.md §8](../core-v1/reservations-reconciliation.md#8-late-conflicting-and-duplicate-observations));
`DISABLED` is the durable, owner-set form of that freeze.

**The current registry cannot represent this.** `ModuleStatus` is
`'ACTIVE' | 'RETIRING'` (`packages/ledger/src/registry.ts:31`) and there is no
adapter status at all. Adding `DISABLED` is a **7E implementation item that
extends the frozen ledger registry**; it is recorded in
[README.md](README.md#7e-implementation-items-that-touch-frozen-packages) for
owner approval, not implemented here. No frozen semantics of `RETIRING`
change.

## 10. Draft adapter descriptor

The answers [enforcement-adapters.md §2](../core-v1/enforcement-adapters.md#2-the-adapter-contract)
requires, for the Lighter Venue Signer:

| Field | Lighter answer | Evidence |
| --- | --- | --- |
| `enforcementPoint` | the sequencer's signature, nonce and `ExpiredAt` checks for `(accountIndex, apiKeyIndex)` | L-ACC-2, L-TX-4, L-TX-7 |
| `credential` | one API key on a dedicated sub-account, held by the signer's key custody | L-ACC-3 |
| `agentCredentials` | none | §3 |
| `finalityLadder` | `ACKED < SEQUENCED < COMMITTED < VERIFIED` | [reconciliation-evidence.md §2](reconciliation-evidence.md#2-finality-ladder) |
| `nonExecutionRule` | nonce-slot supersession; sequencer rejection with zero fills; order terminal status with the complete fill set | [reconciliation-evidence.md §4](reconciliation-evidence.md#4-non-execution-rules) |
| `partialExecution` | yes — `open` with partial fills; `canceled*` with fills | L-LIFE-2 |
| `attemptDedup` | one live attempt per reservation; one tx per `(account, key, nonce)` slot; slot uniqueness enforced by the venue and by the ledger | L-TX-4; [attempt-lifecycle.md §6](attempt-lifecycle.md#6-replay-1-for-execution) |
| `revocationPath` | Core revocation; signer cancel-all; L1 key revocation; Ethereum priority cancel-all | §8 |
| reduce-only | venue-enforced flag; never relied on by any Core exception (`degradedStatePolicy = NONE`) | L-ORD-8 |
| observation trust | `VERIFIED` (API); no venue signature | L-OBS-6 |

## 11. Durability is now a real requirement

Until now the ledger has an in-memory reference store only (7C), and AGENTS.md
forbids building a database before a real persistence requirement appears.
**`ADMIT_ATTEMPT` is that requirement.** Its whole purpose is that after a
crash the system still knows an artifact may exist. An `ADMIT_ATTEMPT` held
only in memory is lost exactly when it matters, and `NEVER_ISSUED` could then
be concluded wrongly.

So 7E.1 needs, before any artifact is signed even with a test key:

- a durable implementation of the ledger store contract
  ([ADR 0023](../adr/0023-ledger-store-contract.md)) — or, at minimum, a
  durable attempt journal whose commit the ledger's `ADMIT_ATTEMPT` depends on;
- fsync-before-sign ordering: the signature is requested only after the
  attempt's commit is durable.

This is a scope decision for the owner and is listed with the other frozen-
package items in [README.md](README.md#7e-implementation-items-that-touch-frozen-packages).
