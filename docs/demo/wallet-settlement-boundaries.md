# Wallet and settlement trust boundaries (B.5.3)

Milestone B.5.3 makes the Live AI Lab's principal authorization and its
testnet settlement durable. This note starts as the Phase 0 inspection of the
repository **as of `8b71ad5`**, answering ten questions from code, not from
intent. Sections after §1 describe the B.5.3 design and are updated by the
commits that implement it.

## 1. Inspection at `8b71ad5`

### 1.1 What does the existing demo principal sign?

`LocalPrincipalSigner.signMandate` (`packages/live-agents/src/mandate/signer.ts`)
signs `mandateSigningHash(portfolioMandateDigest(m))`
(`packages/portfolio/src/mandate.ts`):

```text
digest      = keccak256(PORTFOLIO_MANDATE.V1 canonical encoding)        ← the whole mandate
signingHash = keccak256(str("PORTFOLIO_MANDATE_SIGNATURE.V1") ‖ u16(1) ‖ digest)
signature   = secp256k1 prehash signature, 65-byte r ‖ s ‖ v, low s, v ∈ {27, 28}
```

The key is the Phase 7F demonstration key `keccak("mandate-portfolio/demo-key/principal")`,
publicly derived. It signs only after `MandateVersions.authorize` receives
the exact text `AUTHORIZE MANDATE V<n>`. The mandate's `principal` party is
that key's address. Its `expiresAt` is `protocolNow + validity`, so the digest
depends on the moment it is built.

### 1.2 What does the existing gate require from a principal?

The Phase 6 `MandateExecutionGate` (`contracts/src/MandateExecutionGate.sol`,
`_authorize`) requires, **per execution**:

- an EIP-712 signature by `mandate.principal` over
  `MandateAuthorization(bytes32 mandateDigest)` under the gate's own domain
  (`name`, `version`, `chainId`, `verifyingContract = the gate`), where
  `mandateDigest` is the digest of a gate `Mandate` struct (MCE v2);
- an agent signature over the execution commitment
  `keccak(EXECUTION_AUTHORIZATION_TYPEHASH, mandateDigest, candidateDigest,
  recipient, fundingLimit, deadline, keccak(executionData))`;
- `_executions[mandateDigest] == 0`: each gate mandate executes at most once
  (`MandateAlreadyConsumed`).

In 7E.3 / B.5.2 the gate mandate's `mandateId` is derived from one domain
execution authorization (`gateMandateId`), so every settlement needs a fresh
gate mandate and a fresh principal signature, made by `LocalGateCustody`
holding the 7E.3 disposable principal key, after `ADMIT_ATTEMPT` in the
domain ledger.

### 1.3 Can one portfolio-level wallet signature authorize later child executions cryptographically?

**No.**

### 1.4 Why not?

Three independent reasons, each sufficient:

1. **Different message.** The portfolio verifier accepts only a raw prehash
   signature over `mandateSigningHash` (`mandateSignedByPrincipal`). A wallet
   cannot produce that: `eth_signTypedData_v4` signs
   `keccak(0x1901 ‖ domainSeparator ‖ structHash)` and `personal_sign` adds
   the EIP-191 prefix. The only wallet call that signs a raw 32-byte hash,
   `eth_sign`, is disabled or deprecated in mainstream wallets.
2. **Different signer.** The gate checks the signature against
   `mandate.principal` of a gate mandate. The B.5.2 gate principal is the
   7E.3 disposable testnet key — the party whose MDUSD the gate debits.
3. **Different, per-execution object.** Each gate execution needs a new gate
   mandate (`mandateId` derived from one domain authorization, consumed once
   onchain) and a new principal EIP-712 signature over its digest. Nothing on
   chain derives one from a portfolio-level approval.

### 1.5 Is there a session-key, smart-account or delegation mechanism that bridges the gap?

**No.** The repository has no ERC-4337 account, no ERC-1271 verifier, no
session keys and no onchain delegation registry. The gate verifies an EOA
signature with `ecrecover`. Bridging needs new contracts (for example a smart
account principal whose `isValidSignature` honours a session key scoped by the
portfolio mandate) and a gate that accepts ERC-1271 — a Phase 6 change, which
is frozen.

### 1.6 Does the portfolio reservation ledger persist across process restart?

**No.** `createPortfolioCore` defaults to `InMemoryLedgerStore`
(`packages/portfolio/src/reservation.ts`); the Live AI session never passes a
durable `storeOf`. Sessions, versions, reserved executions and events live in
`LiveSession` / `LiveLab` memory and expire when idle. The durable SQLite store
(`@mandate/ledger-sqlite`) is used only by the 7E.1/7E.3 domain ledgers.

### 1.7 What is persisted before the B.5.2 broadcast?

In `npm run agents:live:testnet` (send mode), before `eth_sendRawTransaction`:

- the **domain** ledger (`.robinhood-testnet/runs/live-ai-<time>/ledger.db`,
  SQLite, `synchronous = FULL`): the one-settlement policy and grant, the
  `RESERVE`, the `ADMIT_ATTEMPT`, and the issuance journal row
  `ARTIFACT_ISSUED` then `SUBMISSION_SENT` (with the gate artifact bytes);
- `settlement.json` in the same directory: a `SUBMISSION_STARTED` record with
  the signed transaction's hash, chain id, gate, reservation, proposal and
  binding digest — written with `writeFileSync`, **without `fsync`**.

Nothing about the portfolio side is persisted: the portfolio ledger, the
mandate versions, the reserved execution and the session events are in
memory. The raw signed transaction is never persisted.

### 1.8 What happens today if the process crashes after broadcast but before receipt persistence?

- `settlement.json` holds `SUBMISSION_STARTED` (or `SUBMITTED`) and a hash;
  the next `agents:live:testnet` send refuses ("an earlier testnet submission
  is unresolved"), but **nothing ever resolves it**: there is no command that
  reads the hash's receipt and moves the record on.
- The domain journal row stays `SUBMISSION_SENT` until a `GateSigner.recover()`
  marks it `OUTCOME_UNKNOWN`; B.5.2 never calls `recover()`.
- The portfolio session is gone: its reservation, the evidence linking the
  transaction to it, and its events are lost. The reservation was never going
  to be consumed anyway (no reconciliation in Core/7F).
- The onchain gate still guarantees at most one execution of that gate
  mandate, and the dead process cannot resend.

### 1.9 Authoritative replay prevention

| Level | Mechanism today |
| --- | --- |
| Portfolio | **None on the B.5.2 path.** The portfolio ledger's own `ADMIT_ATTEMPT` ("one live attempt per reservation", `ATTEMPT_UNRESOLVED`) is never used for the Stock child; eligibility condition 6 even requires that no attempt exists. One settlement per session is a process-local flag (`LiveSettlement.#submitted`) plus the `settlement.json` scan. A restarted process, or a deleted run directory, removes both. |
| Robinhood domain | The domain ledger's `ADMIT_ATTEMPT` for the one-settlement grant (its `CAPITAL` limit is exactly the fixture debit, so nothing else fits) and, authoritatively, the gate's `_executions[mandateDigest]` (`MandateAlreadyConsumed`). Each B.5.2 attempt opens a **fresh** domain ledger, so the domain ledger alone does not stop a second attempt for the same portfolio reservation. |

### 1.10 How can a browser session be durably identified and linked to a settlement?

Today it cannot. `LiveLab` names a session `lab-<counter>-<monotonic ms>`
(`packages/live-agents/src/server/app.ts`), unique only within one server
process; the CLI names its own `live-<wall time>`. Nothing is written to disk,
and the settlement CLI creates its own session rather than loading one. The
server already streams events over Server-Sent Events with `?after=<sequence>`
replay, which is the natural transport to extend once events are durable.

## 2. Consequences for B.5.3

| Question | B.5.3 decision |
| --- | --- |
| Wallet signature as domain delegation | **Not claimed.** The wallet signs an EIP-712 *portfolio mandate approval*, verified by the server as the runtime activation boundary. The portfolio protocol signature remains the demonstration principal key's, made only after the wallet approval verifies; the domain settlement principal remains the 7E.3 testnet custody. Wallet-approved sessions do not settle. |
| Durability | Sessions, versions, wallet approvals, reserved executions, events and the portfolio ledger itself (SQLite reference store) persist under a gitignored state directory. |
| Portfolio replay prevention | The settlement admits an attempt on the **portfolio** reservation through the control engine's existing `ADMIT_ATTEMPT` before any domain key is used, so the portfolio ledger — not a process flag or a journal — refuses a second attempt. |
| Settlement journal | Lifecycle and evidence only; zero authority. |
| Consumption | After verified receipt evidence, the portfolio reservation is consumed and closed in the portfolio ledger, durably. |

## 3. Wallet-signed mandate approval

**Status: implemented (`packages/live-agents/src/wallet/`).**

### 3.1 Trust boundary

The principal's wallet signs an EIP-712 **portfolio mandate approval** of one
exact mandate digest. The local server verifies it against state it holds and
only then activates the version. This is a *runtime* authorization boundary:

| | Wallet path | Demo principal key path |
| --- | --- | --- |
| Who authorizes | the wallet address recovered from the signature | the exact text `AUTHORIZE MANDATE V<n>` |
| What the frozen Portfolio Verifier checks | the demonstration principal key's prehash signature, made only after the wallet approval verified | the same signature |
| Record | `authorization.method = WALLET_EIP712`, `principal = 0x…wallet`, `protocolSigner = demo key` | `DEMO_PRINCIPAL_KEY`, `principal = protocolSigner = demo key` |
| Domain execution | **not delegated** (`domainDelegation: NOT_DELEGATED`) | not delegated |

The protocol signature stays the demonstration key's because the frozen
verifier accepts only a raw prehash signature (§1.4); changing that is a
Phase 7F change this milestone does not make. The UI may say *wallet-signed
mandate*; it never says the wallet delegated execution authority onchain.

### 3.2 Domain and type

```text
EIP712Domain(string name,string version,uint256 chainId)
  name "Mandate", version "1", chainId 46630 (Robinhood Chain testnet)
```

There is no `verifyingContract`: no contract verifies this signature, and
naming one (the gate, say) would claim it does. The chain id binds the
approval to the testnet environment; a signature made for any other chain id
recovers to a different address and is refused (`WALLET_SIGNER_MISMATCH`).

```text
PortfolioMandateApproval(string statement,string environment,bytes32 mandateDigest,uint64 mandateVersion,
  address principal,address protocolSigner,uint64 validAfter,uint64 validUntil,bytes32 sessionDigest,bytes32 challenge)
```

| Field | Value, always rebuilt by the server |
| --- | --- |
| `statement` | a fixed-form summary of the mandate's limits, agents and expiry, ending "This signature is not a blockchain transaction, moves no funds and does not delegate onchain execution authority." |
| `environment` | `robinhood-chain-testnet` |
| `mandateDigest` | `portfolioMandateDigest(m)` — the canonical `PORTFOLIO_MANDATE.V1` digest; no second serialization of the mandate |
| `mandateVersion` | V<n> in the session |
| `principal` | the address the browser said it would sign with; it must be what recovers |
| `protocolSigner` | the demonstration principal key's address |
| `validAfter`, `validUntil` | wall-clock unix seconds; 300 s apart |
| `sessionDigest` | `keccak256("mandate-live-session/v1:" ‖ sessionId)` |
| `challenge` | 32 random bytes from the server |

The encoder (`wallet/eip712.ts`) handles flat structs of atomic types and is
tested to reproduce the kernel's `eip712SigningHash`, which the frozen gate
corpus proves equal to the Solidity gate's.

### 3.3 Challenge and replay protection

```text
POST /sessions/:id/wallet/challenge {address}
  → server prepares the exact mandate the current draft compiles to (digest fixed), draws 32 random bytes,
    stores {mandate, version, session, address, draft, validity} and returns the typed data
wallet: eth_signTypedData_v4
POST /sessions/:id/wallet/authorize {challenge, signature}
  → challenge known in this session · not consumed · not locked · within validity
  → still the next version · the session's draft unchanged since issue
  → rebuild the message from server state · recover · recovered == stored address
  → consume the challenge · commit exactly the prepared mandate · ACTIVE
```

The browser sends only the challenge id and the signature. Refusals:
`WALLET_CHALLENGE_UNKNOWN` (also a challenge from another session),
`WALLET_CHALLENGE_REUSED`, `WALLET_CHALLENGE_EXPIRED`,
`WALLET_CHALLENGE_STALE` (a V1 challenge after V1 exists),
`WALLET_CHALLENGE_LOCKED` (five bad signatures), `WALLET_DRAFT_CHANGED`,
`WALLET_SIGNATURE_MALFORMED` (including high-`s`), `WALLET_SIGNER_MISMATCH`
(any change to any field, another chain, another key, a claimed address that
does not recover), and the version rules as before (`MANDATE_PAUSED`,
`AMENDMENT_AFTER_RESERVATION`, `BUSY`).

A challenge is consumed before the version is committed, so it authorizes at
most once even if the commit fails. The signature is kept as evidence
server-side; events and API views carry only its keccak digest.

## 4. Durable sessions

**Status: implemented (`packages/live-agents/src/persistence/`).**

`npm run agents:serve` keeps every session under `LIVE_STATE_DIR`
(default `.live/`, gitignored):

```text
.live/sessions/<sessionId>/          0700
  session.db                         0600  SQLite, WAL, synchronous = FULL, schema mandate-live-session/v1
  portfolio-ledger.db                0600  the session's portfolio ledger (@mandate/ledger-sqlite reference store)
```

`session.db` holds the session meta (start time, protocol anchor, provider),
the event log, each version (canonical mandate encoding, protocol signature,
draft, record), wallet approvals (message and signature — evidence, never
sent to the browser), challenge summaries, reserved executions, the paused
and reserved flags and the server's current draft. No key, no OpenAI key, no
RPC URL is stored.

**Session id.** `lab-` + 128 random bits (`runtime/entropy.ts`), never a
timestamp; unique across restarts and processes.

**The ledger is the authority.** `persistence/restore.ts` rebuilds each
version from its canonical encoding and checks that it re-encodes to the
recorded digest, carries a valid protocol signature, and that its root is in
the ledger. Where records and ledger disagree, the ledger wins and nothing is
re-activated:

| Crash between | Restored as |
| --- | --- |
| ledger `REVOKE` and the version record | the version `REVOKED`, the session paused |
| ledger registration and the version record | an unused root in the ledger; no version references it, nothing can reserve under it |
| ledger `RESERVE` and the reserved-execution record | an **orphaned reservation**: reported, quarantined, never settled (there is nothing to verify it against) |
| any ledger reservation and the `reserved` flag | `reserved` (amendment stays refused) |

An unknown schema, an undecodable record (the tagged-JSON codec refuses any
tag it does not know), a gap in the event sequence or a version whose root
is missing fails closed (`SessionStoreCorruption`); nothing is silently
discarded.

**Restored sessions are evidence.** A session restored after a restart runs
no agents and authorizes nothing new (`SESSION_RESTORED`); pause still works,
through the ledger. Its protocol clock continues from the recorded anchor by
wall-clock time — downtime ages proposals and authorizations as much as it
lasted — and never runs below the latest protocol time in the ledger or the
event log. Restoring restores evidence, never authority.

**One event sequence across processes.** Events take their sequence inside
one `BEGIN IMMEDIATE` transaction, so the local server and a settlement
command append to one dense, strictly increasing sequence. An event with a
dedupe key is appended at most once. The server picks up events other
processes appended every 400 ms and streams them over the existing SSE
endpoint, which replays from `?after=` or `Last-Event-ID`.

## 5. The durable settlement lifecycle

**Status: implemented (`packages/live-settlement/src/journal.ts`,
`portfolio-ledger.ts`, `settlement.ts`).**

### 5.1 Who decides what

| Store | Authority | Writes |
| --- | --- | --- |
| Portfolio ledger (`portfolio-ledger.db`) | **the Live AI reservation**: whether it may be attempted, and whether it is consumed or released | `ADMIT_ATTEMPT` (artifact = the settlement binding digest), then `CONSUME` + `CLOSE`, or `CLOSE` |
| Gate (onchain) | **whether a gate mandate executed**: `_executions[mandateDigest]` | the transaction |
| Robinhood domain ledger (per attempt) | the one-settlement grant and the domain `ADMIT_ATTEMPT` (7E.3, unchanged) | as in B.5.2 |
| Settlement journal (`settlement.db`) | **none** — lifecycle and evidence only | every state below, write-ahead |
| Session events (`session.db`) | none — what the browser is told | lifecycle events, each at most once |

The portfolio `ADMIT_ATTEMPT` is new in B.5.3 and is what makes "one
reservation → at most one economic attempt" a ledger fact: the control
engine admits one attempt per reservation and returns the existing one
forever after; eligibility accepts an admitted reservation only if its
attempt names this settlement's binding; and a send whose journal has no
record of an attempt the ledger holds is refused
(`PORTFOLIO_ATTEMPT_WITHOUT_JOURNAL_RECORD`) — whoever made it may have
signed.

### 5.2 States

```text
PREPARED ─▶ SUBMISSION_STARTED ─▶ SUBMITTED ─▶ CONFIRMED_SUCCESS ─▶ SETTLED ─▶ CONSUMED
   │               │                  │      └▶ CONFIRMED_REVERT ──────────────▶ RELEASED
   │               └──────────────────┴──▶ RECONCILIATION_REQUIRED ─▶ (evidence) …
   ├─▶ PREPARATION_FAILED
   └─▶ RELEASED (send leg opened, died before its hash was journaled; every artifact dead)
CONFIRMED_SUCCESS ─▶ RECONCILIATION_REQUIRED (POSTCONDITION_ANOMALY) — quarantined, terminal
```

`RECONCILIATION_REQUIRED` carries a reason: `AMBIGUOUS_BROADCAST`,
`BROADCAST_REJECTED` and `AWAITING_DEADLINE` resolve on evidence;
`POSTCONDITION_ANOMALY` and `EXECUTED_OUTSIDE_ATTEMPT` are terminal
quarantine. Terminal states accept no transition.

### 5.3 Write-ahead order

```text
journal PREPARED                                   (binding: session, reservation, proposal, candidate, child,
                                                    action, agent, version, principal, method, chain, gate, binding)
portfolio ADMIT_ATTEMPT                            (before any domain key is used)
journal send leg opened  (send)                    (chain time, and the time after which any artifact is dead)
domain ledger: grant, RESERVE, ADMIT_ATTEMPT, custody signs, agent signs   (7E.3)
journal artifact         (mandate digest, commitment, deadline)            ← before eth_call carries it out
eth_call, estimateGas                              DRY RUN stops here
journal SUBMISSION_STARTED (hash, from, to, nonce, calldata digest, value, gas limit, fees, balances before)
eth_sendRawTransaction   (once, primary endpoint only)
journal SUBMITTED  |  RECONCILIATION_REQUIRED (ambiguous or rejected)
receipt → journal CONFIRMED_SUCCESS | CONFIRMED_REVERT
postconditions → journal SETTLED | RECONCILIATION_REQUIRED (POSTCONDITION_ANOMALY)
portfolio CONSUME + CLOSE  (observation = the receipt evidence digest)
journal CONSUMED
session events (each with a dedupe key)
```

Every journal write is one `BEGIN IMMEDIATE` transaction with
`synchronous = FULL`: when it returns, it is on disk. The databases cannot
commit together and do not pretend to: each step is idempotent and a
restart resumes from the last durable one (§5.4).

**The signed transaction is never persisted.** Its hash and full envelope
are, before the broadcast; that is enough to find it, and nothing is ever
resent, so the raw bytes — a bearer broadcast artifact until mined — are
never written. Re-signing is not relied on either.

**Gate artifacts leave the process before any send.** An `eth_call`
carries the principal's and agent's signatures to the RPC node, which could
broadcast them. So every artifact — dry runs included — is journaled first
with its gate deadline, and nothing about a reservation is released until
every one of its artifacts is past that deadline with no commitment on
chain.

**Wallet-approved versions never send** (`WALLET_PRINCIPAL_NOT_DELEGATED_TO_DOMAIN`):
the domain settlement would be signed by the 7E.3 testnet custody, not the
wallet. Their dry runs run, and every settlement event names both:
`principals.portfolio` (method and address) and
`principals.domainSettlement` (`TESTNET_FIXTURE_CUSTODY`, address), with
`delegation: NOT_DELEGATED`. A send also requires a durable journal
(`DURABLE_JOURNAL_REQUIRED_FOR_SEND`).

### 5.4 Restart reconciliation

**Status: implemented (`packages/live-settlement/src/reconcile.ts`).**

On start, the settlement command restores the durable session and runs
`reconcileAttempts` over every journaled attempt before anything else. It
holds a `ChainReader` only — it cannot send — and involves no model, no Room
and no browser.

| Evidence | Outcome | Next |
| --- | --- | --- |
| receipt, status 1 | `CONFIRMED_SUCCESS` | postconditions at the receipt block from the journaled balances → `SETTLED` → portfolio `CONSUME` + `CLOSE` → `CONSUMED`; or `POSTCONDITION_ANOMALY` |
| receipt, status 0 | `CONFIRMED_REVERT` | held until every artifact of the attempt is past its gate deadline with no commitment, then portfolio `CLOSE` → `RELEASED` |
| no receipt, the node knows the hash | `STILL_PENDING` | nothing changes ("checking settlement status") |
| no receipt, hash unknown or never sent; a commitment exists for one of its artifacts | `AMBIGUOUS` | `EXECUTED_OUTSIDE_ATTEMPT` quarantine, terminal |
| … and every artifact is past its gate deadline with no commitment | `NEVER_SUBMITTED` | portfolio `CLOSE` → `RELEASED` |
| … otherwise | `AMBIGUOUS` | `AWAITING_DEADLINE`: held |
| anything unreadable | `AMBIGUOUS` | nothing changes |

The release rule rests on the gate: `terms.deadline` is checked onchain, so
an artifact past it can never execute, by anyone; the commitment read at a
block past every deadline proves none did. Time alone never releases —
the chain's evidence does. `NEVER_SUBMITTED` never leads to a fresh send:
exact same-attempt resubmission is not implemented (the raw transaction is
not kept), so the reservation is released instead and a new trade needs a
new session.

A `PREPARED` attempt with no send leg (a dry run, or a crash before the
send leg opened) is left as it is: it may still be sent once. After
`CONSUMED` or `RELEASED` the reconciler re-emits the browser-facing events
with their dedupe keys, so a crash between the ledger write and the
notification is repaired and a repeat changes nothing.

**Crash points** (`FAULT_POINTS`), each just after the named durable write:
`AFTER_PREPARED`, `AFTER_PORTFOLIO_ATTEMPT`, `AFTER_DOMAIN_BOUND`,
`AFTER_ARTIFACT_JOURNALED`, `AFTER_TX_HASH_PERSISTED`,
`AFTER_BROADCAST_ACCEPTED`, `AFTER_SUBMITTED`, `AFTER_RECEIPT`,
`AFTER_CONFIRMED`, `AFTER_SETTLED`, `AFTER_CONSUMED`. Each is covered by a
unit simulation (`test/reconcile.test.ts`), and the B.5.3 list by real
SIGKILL tests (`test/crash.test.ts`, §8).

## 6. RPC: QuickNode as infrastructure

**Status: implemented (`packages/live-settlement/src/rpc.ts`,
`scripts/rpc-config.ts`; the 7E.3 `JsonRpcClient` gains an opt-in
`operatorEndpoint: 'QUICKNODE'`).**

| Capability | Who holds it | What it can do |
| --- | --- | --- |
| `ChainReader` | the settlement path, reconciliation, the smoke check | chain id, blocks, code hash, balances, allowance, the gate's commitment and markets, `eth_call`/`estimateGas` of the gate's `execute` (the manifest gate only), one-shot transaction and receipt lookups, the sender's nonce at `latest`/`pending` |
| `TransactionBroadcaster` | the settlement boundary only (`SettlementGateChain.submit`) | send one already-signed gate `execute`, exactly as signed, to the primary endpoint |

Nothing else gets a provider object. The browser, the model providers, the
Room and the local API cannot import this package (structure tests).

**Configuration** — environment only, read by `scripts/rpc-config.ts`, never
pasted anywhere:

| Variable | Meaning |
| --- | --- |
| `ROBINHOOD_TESTNET_RPC_URL` | optional QuickNode Robinhood Chain testnet endpoint, `https://<name>.quiknode.pro/<token>/`; absent → the public RPC |
| `ROBINHOOD_TESTNET_RPC_FALLBACK` | `public` (default) or `none` |
| `ROBINHOOD_MAINNET_RPC_URL` | ignored: there is no mainnet path |

The URL carries its credential in the path. `JsonRpcClient` keeps it in a
private field and refuses other hosts naming the host only; the reader
reports a provenance label (`quicknode`, `public`, `public-fallback`,
`mock`), which is what events carry. A refusal never echoes the URL.

**Fallback.** Reads fall back to the public RPC only on a *transport*
failure (network error, HTTP 5xx/429, unparseable body). Each endpoint
proves `eth_chainId = 46630` before its first answer is used and refuses
every known mainnet (1, 42161, 42170, 4663), so a fallback can never cross
from testnet to anything else. An answer — a wrong chain, a revert, an RPC
error — is never retried elsewhere. A send never falls back.

**RPC response ≠ authorization.** Provider choice changes which node
answers, never what Mandate authorized, the portfolio limits, the
reservation identity or which key may sign.

**Smoke check.** `npm run agents:rpc:smoke [-- --tx 0x…]` is read-only:
`eth_chainId`, `eth_blockNumber`, the gate's code hash against the
manifest, and optionally one historical receipt. No key is loaded.

## 7. The browser evidence bridge

**Status: implemented (`packages/live-settlement/src/session-settlement.ts`,
`scripts/settle.ts`; the server's SSE stream from §4).**

```text
browser: POST /sessions → lab-<128 random bits>  (durable under .live/sessions/<id>/)
         authorize (wallet or demo key) → run → the Stock child is reserved in the durable ledger
operator: npm run agents:settle:testnet -- --session lab-<id>
         restore that exact session (no new model run, no rebuilt proposal)
         reconcile every journaled attempt
         verify the version's principal authorization (a wallet approval is re-verified from its stored evidence)
         dry run: SETTLEMENT_ATTEMPT_PREPARED, TESTNET_PREFLIGHT_*, DOMAIN_EXECUTION_READY, TESTNET_SIMULATION_*
         TESTNET_READY_FOR_SEND { broadcast: "DISABLED_IN_B.5.3", principals, wouldSend }   — and stop
server:  picks the appended events up from session.db (every 400 ms) and streams them
browser: sees them in the same session; after a reload or a server restart, replays them from sequence 0
```

The command writes every event into the session's own log — one dense
sequence shared with the server — so there is no second evidence world.
`GET /sessions/:id` also reports each reserved execution's status as the
ledger holds it now (`RESERVED`, `ADMITTED`, `CONSUMED`, `RELEASED`,
`ORPHANED`).

**Transport.** The existing Server-Sent Events endpoint
`GET /api/live/sessions/:id/events?after=<sequence>`: `id:` is the sequence,
the browser's `EventSource` resumes with `Last-Event-ID`, the server replays
everything after it, and the browser drops any sequence it already holds. No
WebSocket was added.

**Safe payloads.** Settlement events carry public facts only: session id,
reservation, proposal and binding digests, chain id, public addresses, the
gate mandate digest and execution commitment, transaction hash, block,
receipt status, gas, token deltas, evidence class, explorer URL, failure or
reconciliation codes, and the RPC provenance label. Never a key, a seed, a
signature, the raw transaction, calldata, an RPC URL, an API key or the
environment (tested).

**No send.** `agents:settle:testnet` has no send path at all; the reconciler
holds a reader only (structure tests). `agents:live:testnet` (B.5.2) is kept
as the regression path; its send now needs the journal too.

## 8. Crash tests

| Crash point | REAL PROCESS CRASH (SIGKILL, `test/crash.test.ts`) | UNIT SIMULATION (`test/reconcile.test.ts`) | After restart |
| --- | --- | --- | --- |
| 1. after reservation, before preparation | ✓ | — | reservation `RESERVED`, no attempt; one later send settles it once |
| 2. after `PREPARED` | ✓ | ✓ | `PREPARED`, nothing signed for broadcast; a fresh process may send once → `CONSUMED` |
| — after the portfolio attempt | — | ✓ | `PREPARED` + ledger `ADMITTED`; resumable once |
| — after the send leg opened / after an artifact was journaled | — | ✓ | send refused; released once every artifact is dead |
| 3. after the hash was persisted, before the broadcast | ✓ | ✓ | `RECONCILIATION_REQUIRED (AWAITING_DEADLINE)`, ledger `ADMITTED` — held; then `RELEASED`, 0 executions |
| 4. after the node accepted it, before `SUBMITTED` | ✓ | ✓ | receipt found by hash → `CONSUMED`, 1 execution |
| 5. after `SUBMITTED` | ✓ | ✓ | `CONSUMED`, 1 execution |
| 6. after the receipt was observed, before it was recorded (and just after) | ✓ (both) | ✓ (both) | `CONSUMED`, 1 execution |
| 7. after `SETTLED`, before `CONSUMED` | ✓ | ✓ | `CONSUMED` (the ledger write is idempotent) |
| 8. after `CONSUMED`, before the browser was told | ✓ | ✓ | events re-emitted once (dedupe keys) |

Every real case runs three processes — the killed one, a reconciliation
before any deadline, a fresh send attempt, a reconciliation past every
deadline, and one more — over a durable session, journal, domain ledger and
a reference-model chain that persists what it accepted (fsync, then
rename). Each asserts at most one transaction ever mined, the ledger and the
journal agreeing, a fresh send refused for anything past `PREPARED`, and the
browser-facing outcome event exactly once. The suite was run four times in a
row without a failure. The chain is the Phase 6 reference model, not a
network: **no testnet transaction was sent in B.5.3.**
