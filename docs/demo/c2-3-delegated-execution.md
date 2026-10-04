# C2.3 — Bounded Delegated Execution Authority

> **Status: C2.3.2 local deployment-readiness proof complete; awaiting human deploy.**
> Testnet-only. Stock fixture settlement path only. The agent does **not**
> deploy or broadcast. Old V2 `MandateExecutionGate` remains frozen and available.
> C2.3.2 proves `settleSpineV3` against real `MandateDelegatedExecutionGate`
> bytecode on local Anvil (chain id 46630) — not ModelRpc passthrough.

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

Separate artifacts (do not overwrite V2 `contracts/deploy/robinhood-testnet.json`):

- `contracts/deploy/robinhood-testnet-delegated.json` — immutable fixture plan (committed)
- `contracts/script/DeployDelegatedV3.s.sol` — typed Foundry deploy (hardcoded MDEMO/MDUSD)
- `contracts/deploy/robinhood-testnet-delegated-live.json` — written only after human SEND

Commands (never under `npm run check`; refuse mainnet; chain 46630 only):

```bash
npm run robinhood:v3:testnet:deploy -- --dry-run
npm run robinhood:v3:testnet:deploy -- --send --confirm-testnet-46630
npm run robinhood:v3:testnet:verify -- --gate <V3_GATE>
```

**Agent broadcasts: 0.** The owner runs the confirmed SEND command after review.

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

## 18. Implementation status (local)

| Phase | Status |
| --- | --- |
| 0 Design doc | Done |
| 1 `MandateDelegatedExecutionGate` | Done — V2 Gate untouched |
| 2 Foundry unit/fuzz/invariant/differential | Done (52 V3 suite tests + digest vector) |
| 3 TS reference model + vectors | Done (`@mandate/execution-gate` `delegated.ts`) |
| 4 Portfolio V3 verify + ephemeral delegate | Done — Live Lab `spine: "V3"` challenge + one `DelegatedPortfolioAuthorizationV3` |
| 5 Autonomous V3 settlement orchestration | Done — `settleSpineV3` + `AutonomousSettlementGate` + browser auto-settle |
| 6 Browser one-signature UX | Done — AUTHORIZE AUTONOMOUS MANDATE; no Execute; auto SEND |
| 7 Recovery / revoke / allowance | Done — restore evidence-only; `V3_GATE_ALLOWANCE_REQUIRED`; onchain revoke in contract |
| 8 Fork dry-run / Slither / full `npm run check` | Run locally before human deploy |
| C2.3.2 Real local-EVM readiness | Done — Anvil + real V3 Gate bytecode via `settleSpineV3` |

## 18a. C2.3.2 — Real EVM deployment-readiness proof

**Residual risk closed:** V3 SEND tests previously used ModelRpc passthrough.
They now also exercise the compiled `MandateDelegatedExecutionGate` on local
Anvil (`packages/live-settlement/test/v3-local-evm.test.ts` +
`test/support/local-v3-evm.ts`).

| Proof | Result |
| --- | --- |
| Runtime | Local Anvil `--chain-id 46630` only (`127.0.0.1`) |
| Contract | Actual Foundry artifact `MandateDelegatedExecutionGate` |
| Orchestration | Real `settleSpineV3` (no hand-built bypass calldata path) |
| Principal wallet signatures | **1** for authorize; **0** per trade |
| Two successful local txs | Nonces 1 then 2; cumulative `usedDebit` = sum of measured debits |
| TS ↔ Solidity digests | `delegationDigest` via onchain view; approval struct hash via live `DELEGATED_EXECUTION_APPROVAL_TYPEHASH()` |
| Journal / reconcile | PREPARED → SUBMITTED → SETTLED/CONSUMED; second reconcile does not resend |
| Allowance | Insufficient → `V3_GATE_ALLOWANCE_REQUIRED` (zero send); sufficient → execute |
| Fixture inventory | Fresh venue at zero → exact `ERC20InsufficientBalance(venue, 0, required)`; bounded local seed → the **same calldata** simulates and executes |
| Adversarial onchain | Replay, modified execution, wrong/agent-as-delegate sig, wrong recipient, mutated delegation field, expired, revoked, drained venue rollback |
| Solidity source changed | **No** (gate treated as frozen) |
| External / Robinhood testnet / mainnet broadcasts | **0** |

ModelRpc V3 tests remain for fast offline refusal paths; they are not the
deployment-readiness proof.

## 19. Operator runbook (human only)

### 19.1 Deploy MandateDelegatedExecutionGate (testnet 46630)

Double chain guard: the Node wrapper queries `eth_chainId` and requires `46630`;
the Solidity script independently `require`s `block.chainid == 46630`. Known
mainnets and unknown chain IDs refuse. Signer is Foundry `--interactive` (or a
keystore via `--account`); the script never reads `PRIVATE_KEY`.

1. Verify clean commit on `cursor/c2-3-delegated-execution`.
2. Run full local validation (`npm run check`, `forge test`, web, audit/credentials/junk).
3. Dry-run (simulation against Robinhood testnet RPC — **never broadcasts**):

```bash
npm run robinhood:v3:testnet:deploy -- --dry-run
```

Expect: `DRY_RUN`, `NO BROADCAST`, chainId `46630`, one FIXTURE market
(MDEMO / MDUSD @ 10 MDUSD per MDEMO). Optional RPC override:
`ROBINHOOD_TESTNET_RPC_URL` (public default or QuickNode; URL never printed).

4. Fund the deployment signer if necessary (human wallet / Foundry keystore —
   never commit keys; never pass a raw private key to the wrapper).
5. Live deploy (**only** this exact command broadcasts; agent must not run it):

```bash
npm run robinhood:v3:testnet:deploy -- \
  --send \
  --confirm-testnet-46630
```

`--send` without `--confirm-testnet-46630` is **REFUSED**. Foundry prompts
for the interactive signer. Capture from the output / live manifest:

- V3 Gate address
- deployment tx hash
- chainId `46630`
- block number (when present)
- runtime code hash (via verify)

Live evidence file (never overwrites V2):
`contracts/deploy/robinhood-testnet-delegated-live.json`.

6. Verify the deployed gate (read-only, `"latest"` state — no historical fork
   pin; safe on Robinhood's non-archive public RPC):

```bash
npm run robinhood:v3:testnet:verify -- --gate <V3_GATE>
```

Checks: `eth_chainId == 46630`, code present at latest, `CHAIN_ID() == 46630`,
nonzero `domainSeparator()`, fixture market MDEMO/MDUSD, `MARKET_FIXTURE`,
fixture price `10_000_000` @ 6 decimals, fee `0`, runtime code hash.
Does not broadcast. Does not invoke `forge script` against the public RPC
(Foundry's numeric fork fails on non-archive endpoints); Solidity
`DeployDelegatedV3.verify` remains for archive/local nodes only.

7. Check the existing Gate's created fixture venue and inventory (**read only**):

```bash
npm run robinhood:v3:testnet:inventory -- --gate <V3_GATE>
```

The command derives `FixtureVenueAdapter` and `FixtureVenue` from the Gate's
onchain market getters; it does not infer CREATE addresses or trust a copied
venue address. It prints both token balances, the immutable fixture price and
the canonical 6.4 MDEMO requirement, sends nothing, and exits nonzero with
`INSUFFICIENT_FIXTURE_INVENTORY` when the venue cannot deliver that amount.

8. If inventory is insufficient, the **human fixture operator**, not the
   principal, may top up the already-deployed venue to a fixed 64 MDEMO target:

```bash
npm run robinhood:v3:testnet:seed-inventory -- \
  --gate <V3_GATE> \
  --send \
  --confirm-testnet-46630
```

Without both SEND flags the command is plan-only and broadcasts zero
transactions. It rechecks `eth_chainId == 46630`, resolves the venue from the
Gate, computes only the deficit to the fixed target, verifies the original
fixture deployer owns it, and invokes `cast send --interactive` from that
deployer. No raw private key is accepted on the command line or persisted by
the tool. Mainnets and unknown chains refuse.

The 64 MDEMO target is deliberate: ten canonical 6.4 MDEMO fixture settlements.
It is bounded, valueless testnet fixture inventory. It is neither user
authority nor a market/liquidity claim. `MandateDemoToken` cannot mint after
construction, so this uses the same normal ERC-20 transfer mechanism as V2's
original 1,000 MDEMO venue setup. Re-run the read-only command after the human
transaction and require `FIXTURE_INVENTORY_READY` before recording a demo.

9. Start lab: `npm run agents:lab` (loads V3 Gate from
   `contracts/deploy/robinhood-testnet-delegated-live.json`).
10. Open the Live Lab browser UI.
11. Start a **new** V3 session (not a restored one; do not resume a session that
   already failed with `V3_GATE_ALLOWANCE_REQUIRED`).
12. Connect wallet on Robinhood Chain testnet — that address is the principal.
13. On Review, complete **Settlement setup** if shown:
    - Browser reads `MDUSD.allowance(principal, V3Gate)` at latest.
    - If insufficient: **Enable settlement** → wallet sends one bounded
      `MDUSD.approve(V3Gate, amount)` where `amount` is the derived fixture
      debit cap (same path as `deriveV3StockFixtureCap` / settleSpineV3).
    - Never unlimited. Never a Mandate signature. Not counted as a Mandate sig.
14. Sign **one** V3 mandate authorization (`DelegatedPortfolioAuthorizationV3`).
15. Allow the Stock agent to run; observe **zero** further wallet signatures.
16. Observe **one** settlement transaction submitted by the existing submitter.
17. Inspect receipt: wallet approval for this trade = None; bounded V3 delegation.
18. Optionally prove a second trade locally (same delegation, next nonce) — not required live.

**Allowance setup (V3 Gate).** Wallet-native on Review: connected EVM address is
the principal; Gate and MDUSD come from trusted lab/deployment state; amount is
the deterministic V3 fixture cap. Rejected/reverted approvals leave setup NOT
READY. Complete setup **before** the Mandate signature and before recording a
judge/video flow.

**These are two different setup concepts.** Principal allowance is a bounded
`MDUSD.approve(V3Gate, amount)` authorizing the Gate to pull the principal's
fixture MDUSD. Venue inventory is a fixture-operator MDEMO transfer that lets
the venue deliver output. The principal is never asked to fund the venue, and
venue inventory is never described as user authorization.

## 20. Manual live acceptance plan (do not run in agent work)

A. Wallet connected on Robinhood Chain testnet.  
B. New V3 session.  
C. Prompt: Let the Stock agent manage $800.  
D. Review: V3 autonomous execution disclosure visible.  
E. Authorize: exactly **one** wallet EIP-712 signature.  
F. Agent run: no wallet prompt.  
G. Mandate authorizes Stock action: no wallet prompt.  
H. Automatic testnet settlement: one blockchain transaction.  
I. Receipt: wallet approval for this trade = None; execution authority = bounded V3 delegation; LIVE_TESTNET.  
J. Optional second action (local/fork): still no new principal signature.

Agent broadcasts during this milestone: **0**.

## 21. C2.3 live inventory diagnosis (2026-10-04)

The first live V3 acceptance after fixing the Gate target reached the real Gate
simulation and failed closed. Durable session evidence contains the complete
revert:

```text
0xe450d38c
000000000000000000000000fb6d93beb3e800f44d4253a0805af257ca0e9855
0000000000000000000000000000000000000000000000000000000000000000
00000000000000000000000000000000000000000000000058d15e1762800000
```

Decoded as `ERC20InsufficientBalance(address,uint256,uint256)`:

- sender: `0xfb6d93beb3e800f44d4253a0805af257ca0e9855`
- balance: `0`
- needed: `6_400_000_000_000_000_000` atoms = 6.4 MDEMO

Read-only Gate getters independently identify that sender as the V3-created
`FixtureVenue`; `marketOf` identifies adapter
`0xa805946d9dede44a5d3c9e7c5427aeed8e0e3037`. Live `balanceOf` reads confirm
the venue holds zero MDEMO and zero MDUSD. The 6.4 MDEMO requirement is exactly
the canonical $800 fixture quantity: 64 MDUSD at 10 MDUSD/MDEMO.

**Verdict:** deployment/operator setup omitted venue inventory. The deployed V3
Gate is valid and must not be redeployed. Production Solidity and V2 are
unchanged. Settlement now checks this operational readiness before simulation
and returns `V3_FIXTURE_INVENTORY_REQUIRED`; if inventory changes after the
check, authoritative simulation still runs and decodes the raw ERC-6093 revert
as `V3_FIXTURE_INVENTORY_INSUFFICIENT`, preserving sender, balance, needed and
the raw bytes in technical event data.

Status at this entry: live V3 venue remains unfunded; agent broadcasts **0**;
the bounded human-only seed is awaiting owner review and execution. C3 has not
started.
