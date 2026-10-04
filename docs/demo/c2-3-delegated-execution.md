# C2.3 — Bounded Delegated Execution Authority

> **Status: design + local implementation in progress.** Testnet-only.
> Stock fixture settlement path only. The agent does **not** deploy or
> broadcast. Old V2 `MandateExecutionGate` remains frozen and available.

**Judge sentence.** *"I didn't approve that trade. I approved the rules.
Mandate approved the trade because it satisfied those rules."*

## 1. Problem

The proven V2 browser path still requires a human wallet signature for every
executable Stock settlement:

```text
Connect wallet
→ sign PortfolioMandateAuthorizationV2
→ agent proposes → Mandate verifies
→ wallet signs MandateAuthorization (exact Gate execution)
→ one transaction broadcasts
```

That is authorization of the *action*, not of a *boundary*. Autonomy under a
signed mandate is incomplete until ordinary in-policy Stock settlements need
**zero** further wallet prompts.

## 2. V2 vs V3

| | V2 (frozen fallback) | V3 (this milestone) |
| --- | --- | --- |
| Contract | `MandateExecutionGate` | `MandateDelegatedExecutionGate` |
| Human EIP-712 | Portfolio V2 + per-execution `MandateAuthorization` | **One** `DelegatedPortfolioAuthorizationV3` |
| Exact execution signer | Principal (wallet) | Mandate execution **delegate** (ephemeral server key) |
| Agent signature | Required (`ExecutionAuthorization`) | Required (unchanged role) |
| Replay key | `mandateDigest` consumed once | `(delegationDigest, executionNonce)` |
| Cumulative spend | N/A (one-shot mandate) | Onchain `used + debit ≤ cumulativeDebitLimit` |
| Browser SEND | SendGate + human Execute | Autonomous settlement under signed V3 bounds |
| Restored session | Evidence-only | Evidence-only; **delegate key never restores** |

V2 is not rewritten. Deployed Gate semantics stay principal-signature-required.
V3 is a separate path and a separate deployment artifact.

## 3. Inspection findings (pre-implementation)

| Surface | Finding |
| --- | --- |
| HEAD | `688e9f6c59216c008523e202836caec1630f837a` (clean) |
| Branch created | `cursor/c2-3-delegated-execution` from that HEAD |
| `MandateExecutionGate` | Frozen Phase 6 path: principal `MandateAuthorization` + agent `ExecutionAuthorization`; consumes `mandateDigest` |
| Libraries | `MandateCodec`, `GateArithmetic`, `FixtureVenue` / `FixtureVenueAdapter` — reusable without mutating the old Gate |
| V2 portfolio typed data | `PortfolioMandateAuthorizationV2` under domain `{Mandate, "2", chainId}` **without** `verifyingContract` |
| Browser wallet | Exactly **2** `eth_signTypedData_v4` on happy SEND (portfolio + gate) |
| `settleSpine` | Re-verifies V2 spine, maps fixture, reserves, dry-run/SEND through `SendGate` |
| `SendGate` | Explicit per-execution human/browser intent; must remain for V2 |
| Journal | C1 recovery: PREPARED → …; restart = reconcile-only; no key material |
| Fixture economics | Quantity-preserving: semantic note qty → MDEMO qty; debit = 10 MDUSD/MDEMO (not semantic USDC) |
| Allowance | Deploy scripts approve **manifest principal → V2 gate**; wallet must hold MDUSD and approve the Gate it settles through |
| Delegated / session-key work | **None** prior to C2.3 |
| Live domains | Only Stock has `LIVE_TESTNET`; Yield/Swap/NFT/Perps remain `OFFCHAIN_ONLY` |

## 4. Authority model

Three distinct identities:

1. **PRINCIPAL** — human wallet. Signs the boundary once.
2. **AGENT** — existing Stock agent identity. Signs the exact candidate /
   execution authorization (proves who proposed).
3. **MANDATE EXECUTION DELEGATE** — ephemeral secp256k1 key, server memory
   only. Signs exact execution **after** deterministic verification +
   reservation. Never the Stock agent key.

```text
Agents propose. Mandate authorizes. The human signed the rules once.
```

A compromised agent must not be able to sign as the delegate.

## 5. Human signature (one EIP-712)

Domain (binds chain + Gate; no cross-chain / cross-Gate replay):

```text
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
  name = "Mandate"
  version = "3"
  chainId = 46630 (testnet)
  verifyingContract = MandateDelegatedExecutionGate
```

Message:

```text
DelegatedPortfolioAuthorizationV3(
  bytes32 portfolioMandateDigest,
  bytes32 initialAllocationDigest,
  bytes32 sessionDigest,
  address principal,
  address delegate,
  address agent,
  bytes32 representationIdHash,
  address fundingToken,
  uint256 cumulativeDebitLimit,
  uint64 validAfter,
  uint64 validUntil,
  uint64 generation
)
```

This single signature is both portfolio authority and execution delegation.
There is **no** second wallet prompt for a separate delegation type.

Semantic bindings (all present):

| Binding | Field / derivation |
| --- | --- |
| Reviewed portfolio mandate | `portfolioMandateDigest` |
| Accepted initial allocation | `initialAllocationDigest` |
| Session | `sessionDigest` |
| Principal | `principal` (= wallet = `mandate.principal`) |
| Delegate | `delegate` (ephemeral address) |
| Stock agent | `agent` |
| Exact fixture market | `representationIdHash` |
| Funding token | `fundingToken` (MDUSD) |
| Recipient policy | onchain: `recipient == principal` only |
| Cumulative fixture debit cap | `cumulativeDebitLimit` (MDUSD atoms) |
| Validity | `validAfter` / `validUntil` (no forever; no uint-max bypass) |
| Generation | `generation` (session mandate generation) |
| Chain + Gate | EIP-712 domain |

## 6. Exact per-execution approval

After verifier + reservation succeed, the delegate signs:

```text
DelegatedExecutionApproval(
  bytes32 delegationDigest,
  bytes32 mandateDigest,
  bytes32 candidateDigest,
  address recipient,
  uint256 fundingLimit,
  uint64 deadline,
  bytes32 executionDataHash,
  uint64 executionNonce
)
```

The agent still signs `ExecutionAuthorization` over the same economic choices
(same typehash shape as V2). The Gate requires **both** agent and delegate
signatures. The principal delegation signature is verified but **not consumed**.

## 7. Cumulative accounting (onchain)

```text
used[delegationDigest] + measuredDebit <= cumulativeDebitLimit
```

- One funding-token dimension only (MDUSD atoms). Fail closed otherwise.
- Checks-effects-interactions: validate remaining capacity → consume nonce and
  tentative capacity → settle → require measured debit matches expected BUY
  semantics → EVM revert unwinds on any failure.
- Offchain portfolio ledger remains an additional layer, not the only one.

**Cap derivation (C2.2.1 semantics).** The executable cumulative MDUSD cap is
derived from existing portfolio rules and the fixture mapping — not invented:

- If automatic reallocation is disabled: Stock delegated fixture cap must not
  exceed what the accepted plan permits for Stock (mapped quantity → MDUSD).
- If automatic reallocation is enabled: cap may use authority already permitted
  by the signed maximum and existing portfolio rules.
- Fixture MDUSD ≠ semantic USDC. Technical details show the actual MDUSD bound.

## 8. Replay, expiry, revocation

| Mechanism | Rule |
| --- | --- |
| Replay | `usedNonce[delegationDigest][executionNonce]`; same nonce twice → revert; mutated execution with same nonce → signature fail / revert |
| Expiry | `validAfter <= block.timestamp < validUntil`; client clock irrelevant; `0` forever forbidden |
| Revoke | `revokeDelegation(delegation)` — `msg.sender == principal` only; no owner/admin |
| Pause | Local Mandate pause stops new delegate signatures immediately; hard revoke is onchain and may require a wallet **transaction** (not counted against the zero-prompt trading rule) |
| Amendment | **Rule A:** an active V3 mandate cannot be amended in place; revoke / start a new mandate (avoids two live reusable delegations) |

## 9. Key lifecycle

| Item | Policy |
| --- | --- |
| Generation | Cryptographically random secp256k1, per fresh V3 session |
| Storage | **Memory only** private key |
| Persist | Delegate **address**, public auth metadata, principal signature, digests |
| Never | Browser, model prompt, OpenAI, Jev, logs, telemetry, API JSON, errors, git, env |
| Restart | Private key lost → session evidence-only; no regenerated key pretending to be the old delegate |
| Agent key | Distinct; structure tests / runtime asserts `delegate ≠ agent` |

## 10. Settlement orchestration

Order (fail closed):

```text
candidate discovery → eligibility → model decision → trusted proposal
→ agent signature → screening → portfolio verifier → durable reservation
→ V3 delegation scope re-check → chain preflight → exact artifact
→ Mandate delegate signature → simulate → broadcast once
```

- V2 `SendGate` unchanged; not bypassed for V2.
- V3 uses a separate autonomous-settlement gate whose authority is the signed
  reusable delegation (still: one artifact, simulate-before-send, journal,
  reconciliation, no resend).
- Auto-settlement starts only because the human-signed V3 delegation authorized
  autonomous settlement inside those bounds — not because a model proposed.

### Crash / journal (C1 preserved)

| Case | Behavior |
| --- | --- |
| Pre-send crash | Nothing auto-resent; restored evidence-only |
| Post-submit crash | Reconciliation discovers tx; no duplicate send |
| Held | No auto-retry after restart; reconcile only |
| Delegate key | Never persisted across restart |

## 11. Allowance caveat

The new Gate address will **not** inherit the V2 MDUSD allowance.

- One-time testnet environment setup: principal `approve(delegatedGate, amount)`.
- Separate from Mandate signatures; never called a Mandate signature.
- Not auto-sent by agent tests.
- Prefer existing fixture MDUSD / MDEMO; do not redesign tokens to fake
  signature counts.

## 12. Live scope tonight

**Supported for LIVE_TESTNET settlement:** Stock fixture path only
(MDUSD → MDEMO through the delegated Gate on chain 46630).

**Not claimed:** Yield / Swap / NFT / Perps live connectors; mainnet; P2P;
cross-chain; account abstraction; session-key frameworks; arbitrary markets.

## 13. Residual risks (honest)

- Software bugs remain possible; mitigation is isolated path + frozen V2 fallback
  + fail-closed checks + onchain bounds + adversarial/fuzz/invariant/Slither.
- Sequencer timestamp skew within chain bounds (same class as V2 INV-10).
- Gas payer (deployer) is still a separate operational key.
- Fixture assets are valueless; not NVDA; not Robinhood Stock Tokens.
- Local pause ≠ onchain revoke; UI must not claim hard revoke for pause alone.
- Backend compromise of a live delegate key can authorize within the signed
  cumulative cap until expiry or revoke — hence ephemeral keys, short TTL,
  onchain cap, and principal revoke.

## 14. Security invariants (target)

See Foundry suite INV-V3-1 … INV-V3-10 (cumulative cap, dual signatures,
recipient=principal, nonce uniqueness, revoke/expiry, unsupported market,
failed-execution rollback, V2 unaffected).

## 15. Acceptance evidence (definition of done)

Automated tests must prove:

| Step | Wallet Mandate sigs | Settlement txs |
| --- | ---: | ---: |
| Fresh V3 authorize | **1** | 0 |
| Trade #1 in-policy Stock | **0** | **1** |
| Trade #2 same delegation | **0** | **1** |

Plus: agent-as-delegate fails; over-cap fails; replay fails; expired/revoked
fail; restored session cannot sign; V2 Gate byte/semantics unchanged;
no agent live broadcast during implementation.

## 16. Deployment plan (human only)

Separate artifacts (do not overwrite V2):

- `contracts/deploy/robinhood-testnet-delegated.json`
- `docs/demo/v3-deployment-manifest.json` (after human deploy)

Commands (never under `npm run check`; refuse mainnet; chain 46630 only):

```bash
npm run robinhood:v3:testnet:deploy -- --dry-run
npm run robinhood:v3:testnet:verify
npm run robinhood:v3:testnet:demo -- --dry-run
```

**Agent broadcasts: 0.** User reviews this report, then manually deploys and
runs one controlled acceptance execution.

## 17. Phase order

0. Threat model + design (this document)
1. Solidity delegated Gate + typed data
2. Unit / fuzz / invariant / differential tests
3. TS reference model + digest vectors
4. V3 portfolio authorization + ephemeral delegate
5. V3 settlement orchestration
6. Browser one-signature UX
7. Recovery / revoke / allowance handling
8. Fork dry-run + full validation → **STOP** (no live deploy)
