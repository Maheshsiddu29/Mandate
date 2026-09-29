# Phase 7E.1 / 7E.2 — Security boundary of the Lighter Venue Signer

> **Status: frozen deployment facts for Phase 7E.1, updated for Phase 7E.2
> (custody verifies the durable admission itself, §5; auth tokens, §8), and
> the residual risk they leave.** Read with [signer-architecture.md](signer-architecture.md) (the
> 7E.0 design) and [threat-model.md](threat-model.md). This document says
> what the implementation actually guarantees and — as plainly — what it does
> not.

## Contents

1. [The frozen credential fact](#1-the-frozen-credential-fact)
2. [What CRED-1 means here](#2-what-cred-1-means-here)
3. [Deployment profiles](#3-deployment-profiles)
4. [Where each restriction is enforced](#4-where-each-restriction-is-enforced)
5. [Process and IPC boundary](#5-process-and-ipc-boundary)
6. [If the key is stolen](#6-if-the-key-is-stolen)
7. [Residual risks](#7-residual-risks)
8. [Auth tokens (7E.2)](#8-auth-tokens-7e2)

---

## 1. The frozen credential fact

**Lighter ordinary API keys are BROAD credentials.** A registered key can
sign orders, cancels and leverage changes, request a secure withdrawal to the
owner's L1 address, transfer between sub-accounts of the same master, mint
public-pool shares and create sub-accounts (venue-evidence.md L-ACC-6,
L-TX-11). The venue offers no operation-level permission boundary except the
premium-only maker-only restriction (§3).

**Mandate software restricts what the signer will use the key for.** It does
**not** make a broad venue key cryptographically trading-only. So:

```text
signer compromise  ≠  a Mandate policy bypass with zero consequence
```

A compromise of the signer's key — or of the process that holds it — can
affect every asset available to the dedicated Lighter sub-account.

## 2. What CRED-1 means here

CRED-1 — *no credential available to the agent can bypass the Mandate
enforcement point* — holds for this deployment when all of the following are
true, and only then:

| Condition | How it is checked |
| --- | --- |
| a **dedicated sub-account** holds the perp domain's collateral and nothing else | deployment |
| exactly **one registered API key** on it, held by the signer's key custody | `CREDENTIAL_SCOPE`, before every attempt: the key listing must show exactly the signer's index with custody's public key |
| the **agent holds no Lighter credential** — no API key on the dedicated sub-account, the master or any sibling | deployment; a sibling key would receive funds a compromised signer transferred |
| the **agent holds no owner (L1) credential**, which can register keys anywhere | deployment |
| the **funded balance** of the sub-account is no more than the intended blast radius | deployment |
| the signer exposes **no generic signing operation** | structural tests: `VenueSigner` has `issueAuthorizedPerpOrder`, `issueAuthorizedCancel`, `recover`; custody has `publicKey`, `hash`, `sign(tx, attemptClaim)` — and since 7E.2 signs only what the durable ledger admitted, verified by custody itself |
| the agent never receives signed transaction material | the signer submits; `IssueOutcome` has no field for it (tested) |

What the agent holds: its actor key, used to sign `ActionIntent`s. What it
can obtain from Mandate: an attempt id, the venue transaction hash, an
issuance state. Nothing it can submit to Lighter.

## 3. Deployment profiles

| | `STANDARD_ISOLATED` (default) | `MAKER_ONLY_HARDENED` (optional) |
| --- | --- | --- |
| API key | ordinary — broad | marked maker-only on a premium account (L-ACC-7) |
| Orders | everything PerpPolicy v1 permits: market IOC; limit IOC, GTT, post-only | post-only (ALO) orders, their modification, cancel, cancel-all — as the venue allows a maker-only key |
| Venue-enforced narrowing of the key | none | the maker-only restriction, **if** it excludes withdraw, transfer, mint and leverage change — **unevidenced (E-10)** |
| Blast radius of a stolen key | the sub-account's funded balance and everything L-TX-11 lists | reduced to maker orders and cancels, if E-10 holds |
| Status in 7E.1 | implemented | **defined, not enabled**: requires a premium account and E-10 evidence; PerpPolicy is not shaped around it |

`MAKER_ONLY_HARDENED` is for maker-only strategies. It is not the default,
and nothing in PerpPolicy is contorted to fit it.

## 4. Where each restriction is enforced

| Restriction | Enforced by | Venue-enforced? |
| --- | --- | --- |
| only authorized orders are signed | Control (`ADMIT_ATTEMPT` after revalidation) + signer binding checks + custody's own read of the durable `ADMIT_ATTEMPT` (7E.2) | no — the venue accepts any valid signature |
| transaction allowlist (create-order, cancel-order) | signer `checkAllowed` and custody `build` — both, independently | no |
| one account, one key, one chain | signer config + custody config | the signature binds account and key index |
| one transaction per nonce slot | ledger (`VENUE_SLOT_REUSED`), custody journal (`SLOT_ALREADY_SIGNED`), venue nonce rule | yes, at execution: a slot executes at most once |
| exact fields | the venue's signed hash covers them (L-TX-2) | yes: a changed field invalidates the signature |
| artifact lifetime | signer sets `ExpiredAt` ≤ the authorization's ceiling; GTT expiry ≤ ceiling | yes: the venue enforces both deadlines |
| isolated margin | PerpPolicy module rule | the venue enforces the mode it is set to; not that it is isolated |
| no withdrawal, transfer, pool or key change through Mandate | allowlist | **no** — a stolen key can do all of these |

## 5. Process and IPC boundary

```text
agent ──ActionIntent──▶ Control (library, no key) ──authorization──▶ VenueSigner (TS, no key)
                                                                        │  hash(tx) / sign(tx, attemptClaim)    JSON lines over stdio
                                                                        ▼
                                                              lighter-custody (Go, holds the key)
                                                                        │  read-only: attempt, batch bytes, head,
                                                                        ▼  closures, issuance journal, lifecycle
                                                              ledger SQLite file
```

- **Key material.** Only `lighter-custody` reads the key: from a file named in
  its environment. The decoded key bytes are zeroed once the key manager holds
  them (the file's text, a Go string, is not). The key is never written to
  stdout, stderr or the journal. No TypeScript source reads a
  key file (structural test). `keygen` prints only the public key.
- **Control** never imports or holds key material; it commits `ADMIT_ATTEMPT`
  naming the hash custody computed without the key.
- **IPC trust (7E.2).** The signer→custody channel is the parent–child stdio
  pipe of one host. The signer sends a transaction and an attempt **claim**;
  it sends no hash and there is no admission token. Custody computes its own
  hash, reads the claimed attempt from the ledger's SQLite file (read-only),
  checks that the batch holding it is committed and intact (keccak of its
  bytes is the head), re-derives the attempt id, and signs only if its hash
  is that attempt's committed artifact — for its principal, module, adapter,
  account, key and nonce slot, within the attempt's validity, with the
  reservation open, no issuance recorded, and the module and adapter
  `ACTIVE`/`RETIRING` in the durable lifecycle table
  ([implementation-7e2.md §2](implementation-7e2.md#2-custody-verifies-the-durable-admit_attempt)).
  A compromised signer process can therefore no longer obtain a signature for
  an unadmitted transaction. Custody still trusts the **ledger writer**: it
  does not re-run the reducer or Control's admission, so an attacker able to
  write a committed, well-formed `ADMIT_ATTEMPT` into the file is outside what
  it detects ([implementation-7e2.md §3](implementation-7e2.md#3-what-custody-still-trusts)).
- **Reference-only separation.** In 7E.1 the signer and custody run on one
  machine under one user. That preserves the process boundary, not an OS or
  hardware one.

## 6. If the key is stolen

No software in this repository can protect a raw, exfiltrated Lighter key,
and there is deliberately no test pretending it can. An attacker holding it
can, outside the signer, do everything L-TX-11 lists for the dedicated
sub-account: trade, cancel, change leverage, request a secure withdrawal to the
owner's L1 address, transfer to sibling sub-accounts, mint public-pool shares.

The blast radius is bounded primarily by:

1. **the dedicated sub-account** — the key signs for no other account;
2. **limited funding** — the sub-account holds only the intended exposure;
3. **owner credential isolation** — the L1 key, which can register keys
   anywhere, is cold and not in the pipeline;
4. **rapid revocation** — the owner revokes the key with an L1-signed
   `ChangePubKey` to zero (L-ACC-5) and can cancel all orders through an
   Ethereum priority transaction (L-WD-5).

Detection before the next issue: `NONCE_SLOT` refuses when the venue's nonce
is ahead of every slot the ledger admitted (`NONCE_AHEAD_OF_LEDGER`), and
`CREDENTIAL_SCOPE` refuses when any other key is registered.

**This is the core `FIT WITH LIMITATIONS` condition** (venue-fit.md W1).

## 7. Residual risks

| Risk | Status |
| --- | --- |
| stolen signer key (§6) | bounded by funding and revocation; not preventable in software |
| compromised signer process asks custody to sign an allowlisted, uncommitted transaction | **closed in 7E.2**: custody reads the durable admission itself and refuses (`ATTEMPT_NOT_ADMITTED`, `ARTIFACT_NOT_ADMITTED`, …) |
| compromised ledger writer commits an `ADMIT_ATTEMPT` Control never admitted | custody verifies committed, intact batches, not Control's reasoning; the head chain makes such a batch permanent and attributable (§5) |
| read-only open of the ledger is custody's code, not an OS permission | same host, same user (reference separation); a deployment can give custody a read-only handle or mount |
| a read-only auth token leaks | it reads the account's orders and positions; it authorizes no write (§8) |
| sibling sub-accounts receive a transfer from a compromised signer | deployment rule: no agent key on any sibling; not venue-enforced (E-5 unevidenced) |
| isolated positions pay fees from cross (L-MAR-6) | margin demand includes fee headroom; the sub-account balance is the cap |
| fills after a cancel is sequenced (E-3) | cancels release nothing in 7E; release is 7F's, at `VERIFIED` |
| an unknown submission stays unresolved | quarantined as `OUTCOME_UNKNOWN`; liveness, not safety |
| `price_protection` (unsigned, undocumented) | the signer always sends the API default; the agent never submits |
| testnet cannot evidence mainnet finality | nothing is released in 7E; the release level stays `VERIFIED`. **LIVE TESTNET LIMITATION: full authority release cannot currently be demonstrated** |

## 8. Auth tokens (7E.2)

Reading active orders needs an auth token made with the account's API key.
Tokens are credentials, and not all of them are read-only:

| Credential | Authorizes | Who holds it |
| --- | --- | --- |
| L2 transaction signature (per transaction) | every economic action: orders, cancels, withdrawals, transfers, pool shares, leverage and margin, key changes | produced only by custody, only for admitted artifacts |
| standard auth token | no L2 transaction — it cannot trade or move funds by itself — but **account-configuration endpoints** (account tier, maker-only API keys, creating further tokens); **not read-only** | nobody outside the credential boundary; the state reader refuses it and never sends it (`AUTH_TOKEN_NOT_READ_ONLY`) |
| read-only token (`ro:`) | read endpoints only | the state reader, through `ReadOnlyTokenSource` |

The read-only token is generated inside the credential boundary (it needs the
API key) and only it leaves. The agent never receives any token. The reader
sends it in the `Authorization` header, never in a URL, and provenance records
endpoints without it.
