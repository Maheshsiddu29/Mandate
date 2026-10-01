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
