# Phase 7E.3 — the Robinhood Chain testnet demonstration

> **Status: run on Robinhood Chain TESTNET (46630) on 2026-09-29 (UTC).**
> Valueless labelled fixtures (MDEMO, MDUSD — not a Robinhood Stock Token, not
> a stablecoin), three disposable keys, testnet ETH from the faucet. No
> mainnet, no real funds, no production credential. Machine-readable:
> [robinhood-demo-receipt.json](robinhood-demo-receipt.json) and
> [deployment-manifest.json](deployment-manifest.json). How it was deployed:
> [robinhood-deployment.md](robinhood-deployment.md). How it works:
> [implementation-7e3.md](implementation-7e3.md).

What this shows, and only this: **Mandate's EVM enforcement contract is
deployed on Robinhood Chain testnet and has executed valueless testnet actions
under real Mandate authorization** — and refused, onchain or before any
transaction, the replay, mutations and over-authority action below.

Explorer: `https://explorer.testnet.chain.robinhood.com/tx/<hash>` and
`…/address/<address>`.

## 1. Deployed contracts

| Contract | Address | Deployment |
| --- | --- | --- |
| `MandateExecutionGate` (frozen Phase 6) | `0xb03c1e072192a82ba68604841a0e42f32609aa3e` | `0x81c629ca5abe37b524c02b40bddf4bb264dff6878d8d92f8d907ab87789dd024` (block 126,043,799, 4,726,133 gas) |
| `FixtureVenue` (created by the gate) | `0x850be07c638ae221c35433eaac71a8c8720de504` | same transaction |
| `FixtureVenueAdapter` (created by the gate) | `0x88c966c644208f3a0e75ef929169a7e06084e969` | same transaction |
| MDEMO — *Mandate Demo Asset (TESTNET FIXTURE)*, 18 dec. | `0x5d4c3618f996777baf0e0468884bb7a440f189e1` | `0xb691eb10193009236247fe0a546aa1c2cc283d2d8fdd23d58df10412bc5aca5a` |
| MDUSD — *Mandate Demo Dollar (TESTNET FIXTURE)*, 6 dec. | `0x53b640b9a573e33c541de5a4917bc4d28d956abf` | `0xa79ca776466382de872ad670dfbb8dec41d213a42cabdc38633d876ecbd2f8ab` |

Gate runtime code hash `0x67b48d04…5d07` (13,815 bytes), domain separator
`0xf329d090…17d3`. The reviewed `DeployMandateGate.verify(gate, config)`
passed against the live gate, and its runtime code equals the build artifact's
except for the constructor-set immutables. **Explorer source verification was
not possible**: the testnet Blockscout offers solc up to 0.8.36 and the frozen
build pins 0.8.37 (details in the manifest and
[robinhood-deployment.md §7](robinhood-deployment.md#7-provenance-and-verification)).

Parties (public addresses): deployer and gas-paying submitter
`0x8b7cdd2e3f9d2102eccb018969cfb4589fac0ff2`; principal
`0x396205c987a71bb75d87db5d604ec485e33e11ad`; agent
`0xf2b2639d91da04eb5a42bdc1d4df5bd76ebbfdac`.

## 2. The run

`npm run robinhood:testnet:demo`. Every step goes through the real Mandate
path — control engine, SQLite ledger, GateSpotPolicy, state read from the live
gate, `ADMIT_ATTEMPT`, custody's own check — and the deployed gate.

| # | Step | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Principal policy and root grant to the agent: **500 MDUSD** of `CAPITAL`, the demo market, the `robinhood-gate-signer` adapter | registered; root grant `0x4636b7db…3b94d` | receipt `mandate` |
| 2 | Agent proposes **BUY 30 MDEMO** (300 MDUSD): state admission from the gate, projection, reservation | **AUTHORIZED**, 300 MDUSD reserved | action `0x79ba4249…4110`, reservation `0x8dfd59d8…f8db` (generation 1), execution authorization `0x28ce3a40…8d9b`, record `0x217e2147…3559` |
| 3 | Issuance: `ADMIT_ATTEMPT` (slot 1 of this gate and principal), custody signs the mandate, the agent signs the commitment, preflight, `execute` | **SUCCESS** — 30 MDEMO to the principal, exactly 300 MDUSD from it (1,000 → 700); the gate records the commitment | tx **`0x7144f09fc4e8a5c4b74b77b4c9d0fc748501e404ab3249151f576ba6e9dff344`** (block 126,043,962, 309,663 gas); gate mandate `0x575840cf…c3c4`; commitment `0xc3ac92a7…c62a` = `executionCommitmentOf(mandate)` |
| 4 | **Replay**: the byte-identical call, re-broadcast | mined, **REVERTED** `MandateAlreadyConsumed`; nothing moved | tx `0x540fe679794dab855d93bcc7a55102a7952fc29647a72080a0dd754364cd9773` (164,767 gas) |
| 5a | **Amount mutation**: quantity 30 → 30 + 1 atom, original signatures | mined, **REVERTED** `AgentSignatureInvalid` | tx `0xe8346c4d35801356903c0d6c77b80ee774aa8b959a25ab313c9242dfbaba4ef3` (162,190 gas) |
| 5b | **Recipient mutation**: recipient → the agent | `AgentSignatureInvalid` | `eth_call` |
| 5c | **Target mutation**: the candidate names another token | `UnsupportedRepresentation` | `eth_call` |
| 6 | Agent proposes **BUY 25 MDEMO** (250 MDUSD): 300 reserved + 250 = **550 > 500** | **REFUSED by Mandate** `AUTHORITY_UNAVAILABLE/LEDGER_LIMIT_EXCEEDED` — no artifact, no signature, **no transaction** | receipt `refusedBeforeTransaction` |
| 7 | The agent's direct path: `transferFrom(principal → agent)` as the agent | `ERC20InsufficientAllowance` — the agent has no allowance | `eth_call` |
| 8 | **Expiry**: the executed call after its 90 s deadline | `ExecutionDeadlinePassed` | `eth_call` |

Deployment setup transactions (venue inventory, principal funding, the
principal's 500 MDUSD approval of the gate — the same amount as its Mandate
capital authority) are listed in the manifest.

## 3. The receipt (§23 fields)

| Field | Value |
| --- | --- |
| principal | `0x396205c987a71bb75d87db5d604ec485e33e11ad` |
| mandate / authority id | root grant `0x4636b7dba8e6f1cc64b840db88eddc252daabef177974e42665f97c1b1e3b94d` |
| reservation id | `0x8dfd59d8fa0f3d271be832b4af372f89756025651860e8d5a45021e49255f8db` (generation 1) |
| action digest | action `0x79ba4249ad349e6f5e53da675701a41c8c8d22a571d54cebb82e4db0a4614110`; payload `0xc9e489ae8a8c5f04bd45a5a1b73083248b531172b37eaec57101b771a6e3852f` |
| adapter | `robinhood-gate-signer` v1, digest `0x917a5abe10cf5db2f79250ac459e72141eb5e9c5ade76372bd615b51136bde14` |
| module | `robinhood-evm/gate-spot` v1, digest `0xb279605993e7146b090f1b222f150936d055a4116a61f70cd5db9d4f0a875926` |
| chain id | 46630 |
| contract | `0xb03c1e072192a82ba68604841a0e42f32609aa3e` |
| transaction hash | `0x7144f09fc4e8a5c4b74b77b4c9d0fc748501e404ab3249151f576ba6e9dff344` |
| result | SUCCESS |
| authority before | 500 MDUSD limit, 0 reserved |
| authority reserved | 300 MDUSD |
| authority after | 300 of 500 MDUSD reserved (200 remaining) — the executed reservation stays reserved until reconciliation (7F), which is not built |

This is a development receipt, not the 7H receipt architecture.

## 4. Offline scenarios (not live)

| Scenario | Where | Result |
| --- | --- | --- |
| **Cross-domain**: principal-wide committed notional (`NOTIONAL`, USDC, 6 dec.) ≤ 10,000; Robinhood gate BUY 6,000 reserved; Lighter BUY 5,000 proposed | `packages/evm-robinhood/test/cross-domain.test.ts` | 11,000 > 10,000 → **REFUSED** `LEDGER_LIMIT_EXCEEDED`; 4,000 fits exactly; the reverse order refuses too; without the shared dimension both fit |
| Every §24 enforcement case, including compromised-agent re-signing (`MaxNotionalExceeded`, `FundingLimitExceedsMandate`, `RecipientNotPrincipal`), adapter mismatch, wrong principal, wrong generation, 100 concurrent issuances | `enforcement.test.ts` (reference model), `RobinhoodDemo.t.sol` (Solidity gate) | all refused as stated |

The cross-domain scenario is offline and engineered: its gate market is
declared to settle USDC so that it shares Lighter's unit. The live market
settles MDUSD, which is not USDC and does not share that dimension. It shows
structurally that Robinhood EVM reservations and Lighter PerpPolicy
reservations enter the same principal-wide ledger under one policy; it is not
a live cross-venue limit, and no Lighter order was placed.

## 5. What is not claimed

- not a production deployment, and not audited production readiness;
- not universal non-bypassability: the principal is an EOA whose key Mandate
  custody holds in-process; whoever holds that key can move its tokens outside
  the gate ([implementation-7e3.md §12](implementation-7e3.md#12-limits-and-open-questions));
- not a trade of a real asset: MDEMO is a fixture, the venue is a settlement
  fixture with no liquidity or price discovery;
- not live Lighter funded execution;
- not reconciliation: nothing is consumed or released after execution;
- not explorer-verified source (unavailable for solc 0.8.37 on this explorer).

## 6. Reproduce

```bash
npm run robinhood:testnet:demo -- --dry-run   # the same run on a local anvil fork: deploys, then demonstrates
npm run robinhood:testnet:demo                # against the manifest's gate (needs the disposable keys)
```

Re-running on testnet reuses the deployed gate, resets the principal's gate
allowance to exactly 500 MDUSD and starts a fresh ledger under
`.robinhood-testnet/runs/`; it overwrites the receipt with the new run's
identifiers.

## 7. Explicit answers

| Question | Answer |
| --- | --- |
| Are Mandate contracts deployed on an Arbitrum chain? | **YES** |
| Which chain? | **ROBINHOOD CHAIN TESTNET** (46630; Arbitrum Nitro, ArbOS 61) |
| Did a real valueless testnet action execute through Mandate? | **YES** — tx `0x7144f09f…f344` |
| Can the same execution authorization be replayed? | **NO** — `EXISTING` offchain; `MandateAlreadyConsumed` onchain (tx `0x540fe679…9773`) |
| Can the authorized amount/recipient/target be changed? | **NO** — `AgentSignatureInvalid` onchain (tx `0xe8346c4d…4ef3`) and by `eth_call`; `UnsupportedRepresentation` for another token |
| Was a production/mainnet wallet used? | **NO** |
| Were real funds used? | **NO** |
| Is Lighter funded execution required for this milestone? | **NO** |
| Is full reconciliation implemented? | **NO** |
