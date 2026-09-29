# Phase 7E.3 — Robinhood Chain testnet deployment

> **Status: Phase 7E.3, testnet only.** The frozen Phase 6
> `MandateExecutionGate` and two labelled demo fixture tokens on Robinhood
> Chain **testnet** (chain id 46630). Valueless. No mainnet interaction, no
> real funds, no production credential. What was deployed, from what, and how
> to check it is recorded here and, machine-readably, in
> [deployment-manifest.json](deployment-manifest.json). The live run itself is
> in [robinhood-demo.md](robinhood-demo.md); the implementation in
> [implementation-7e3.md](implementation-7e3.md).

## Contents

1. [Network configuration](#1-network-configuration)
2. [What is deployed](#2-what-is-deployed)
3. [Why fixture tokens](#3-why-fixture-tokens)
4. [Testnet tokens examined](#4-testnet-tokens-examined)
5. [USDG](#5-usdg)
6. [Procedure](#6-procedure)
7. [Provenance and verification](#7-provenance-and-verification)
8. [Gas and size](#8-gas-and-size)
9. [Keys](#9-keys)
10. [Limits](#10-limits)

## 1. Network configuration

Every value below was taken from Robinhood's current documentation on
2026-09-28 and then observed on the chain, not copied from earlier notes.

| Fact | Value | Source | Observed |
| --- | --- | --- | --- |
| Chain id | **46630** | [docs.robinhood.com/chain/connecting](https://docs.robinhood.com/chain/connecting/) | `eth_chainId` = `0xb626` (46630) |
| Public RPC | `https://rpc.testnet.chain.robinhood.com` (rate-limited, "not recommended for production") | same | served every read and write of this phase |
| Alchemy RPC | `https://robinhood-testnet.g.alchemy.com/v2/{API_KEY}` | same | not used: needs a credential |
| Explorer | `https://explorer.testnet.chain.robinhood.com` (Blockscout) | same | Blockscout backend `v10.2.6` |
| Sequencer | `https://sequencer.testnet.chain.robinhood.com`, feed `wss://feed.testnet.chain.robinhood.com` | same | not used |
| Native gas token | ETH | same | base fee 0.01 gwei (`baseFeePerGas` = 10,000,000 wei) |
| Faucet | `https://faucet.testnet.chain.robinhood.com` (behind a browser checkpoint; not listed on the docs pages read) | host observed; third-party listings name it the official faucet | the repository owner funded the deployer with 0.01 testnet ETH, by hand |
| Stack | Arbitrum Nitro | [docs.robinhood.com/chain/run-a-full-node](https://docs.robinhood.com/chain/run-a-full-node/) | `web3_clientVersion` = `nitro/v3.12.0-rc.3+ebe9e83` |
| ArbOS | 61 | — | `ArbSys(0x64).arbOSVersion()` = 116 = 55 + 61 |
| Contract deployment | supported, Foundry and Hardhat, Blockscout verification | [docs.robinhood.com/chain/deploy-smart-contracts](https://docs.robinhood.com/chain/deploy-smart-contracts/) | this phase's deployments |
| EVM target | `cancun` (OpenZeppelin 5.6 needs `MCOPY`) | Nitro supports Cancun opcodes from ArbOS 20 | the gate deployed and executed |

The package refuses every host but the documented public testnet RPC
(`chain.ts`, `TESTNET_RPC_HOSTS`), refuses a chain id other than 46630, and
refuses Ethereum (1), Arbitrum One (42161), Arbitrum Nova (42170) and Robinhood
Chain mainnet (4663) outright, whatever an endpoint answers.

## 2. What is deployed

Addresses, transactions, blocks, code hashes and sizes are in
[deployment-manifest.json](deployment-manifest.json), written by the deploy
command from the chain itself.

| Contract | What it is | Source |
| --- | --- | --- |
| `MandateExecutionGate` | the frozen Phase 6 gate, byte-for-byte the reviewed source | `contracts/src/MandateExecutionGate.sol` at `dc98df5` semantics, unchanged |
| `FixtureVenue` | **settlement fixture, not a market**: sells MDEMO for MDUSD at an immutable price out of the inventory it was given | created by the gate's constructor |
| `FixtureVenueAdapter` | the gate's only call target for the market | created by the gate's constructor |
| `MandateDemoToken` "MDEMO" | *Mandate Demo Asset (TESTNET FIXTURE)*, 18 decimals, 1,000,000 minted once to the deployer | `contracts/src/demo/MandateDemoToken.sol` (new in 7E.3) |
| `MandateDemoToken` "MDUSD" | *Mandate Demo Dollar (TESTNET FIXTURE)*, 6 decimals, 1,000,000 minted once to the deployer | same |

The one market (`contracts/deploy/robinhood-testnet.json`):

| Field | Value |
| --- | --- |
| representation / funding | MDEMO / MDUSD |
| canonical asset | `fixture` / `mandate-demo` / `MDEMO` — a fixture, and named as one |
| issuer, venue | `issuer.mandate-demo`, `venue.mandate-fixture` |
| units | quantity `TOKEN`, settlement `MDUSD` |
| fixture price, fee | 10.000000 MDUSD per MDEMO, 0 bps |
| classification | `FIXTURE` (the frozen gate refuses anything else) |

**MDEMO is not a Robinhood Stock Token. MDUSD is not a stablecoin and not
USDG.** Neither has value; the venue is not a market. The demonstration is of
Mandate's authorization boundary, not of trading.

## 3. Why fixture tokens

The phase brief ranked (A) an official testnet Stock Token, (B) an official
Robinhood-relevant ERC-20, (C) a labelled Mandate fixture. A and B were
examined (§4, §5) and ruled out by a frozen rule rather than by preference:
the gate's vetted-token policy classifies **upgradeable tokens as
UNSUPPORTED / DEPLOYMENT-PROHIBITED** ([execution-gate.md
§13](../execution-gate.md#vetted-token-policy)) — an immutable address does not
pin behaviour, and the gate's measured-balance settlement trusts the token's
`balanceOf`. Every candidate token found is a proxy. Changing that rule would
change frozen Phase 6 semantics, so 7E.3 uses C.

`MandateDemoToken` is the smallest thing that satisfies the policy: a plain
OpenZeppelin ERC-20, boolean returns, no owner, no mint after construction, no
burn, pause, fee, rebase, hook or proxy.

## 4. Testnet tokens examined

Observed through the testnet explorer's API and the RPC on 2026-09-28:

| Token | Address | Observation | Usable by the gate? |
| --- | --- | --- | --- |
| "Tesla" `TSLA`, "Amazon" `AMZN`, `AMD`, `PLTR`, `NFLX` (18 decimals, 200k+ holders each) | e.g. `0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E` (TSLA), `0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02` (AMZN) | `BeaconProxy` → implementation "Stock" (`0xBd14…57DA`), creator `0x2DD5…E5Da`; `uiMultiplier()` answers 1e18, `uid()` does not decode as a string | **No**: upgradeable (beacon proxy). Also: Robinhood's docs list **no** testnet Stock Token addresses, so these cannot be identified as canonical Robinhood Stock Tokens by an authoritative source |
| Several `USDC` tokens (18 and 6 decimals) | e.g. `0xbf4479C0…F4fd1`, `0xAc80194d…290fe0` | third-party deployments; no issuer documentation found | **No**: no authoritative provenance |

The repository's rule for Stock Token identity (Phase 3,
[robinhood-integration.md](../robinhood-integration.md)) is that an address is
a Robinhood Stock Token only when Robinhood's own asset source names it. On
testnet nothing does.

## 5. USDG

| Question | Answer |
| --- | --- |
| Is official USDG deployed on Robinhood Chain testnet? | **Yes.** Paxos documents it ([docs.paxos.com — USDG testnet](https://docs.paxos.com/guides/stablecoin/usdg/testnet)). |
| Which address? | Token `0x7E955252E15c84f5768B83c41a71F9eba181802F` ("Global Dollar", `USDG`, 6 decimals); supply control `0x4549bb98c667aAb626627C118102c28065E8f54C`. (Mainnet USDG is `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` per [docs.robinhood.com/chain/contracts](https://docs.robinhood.com/chain/contracts/); it has no code on testnet.) |
| Is it valueless / testable? | Valueless ("Testnet tokens have no value", Paxos). Obtainable through Paxos's faucet (`faucet.paxos.com`), by hand. Two other tokens named USDG exist on testnet (`0x915E…03ec`, unverified; `0x4339…b907` "Mock USDG"); neither is Paxos's. |
| Can it naturally participate in the demo? | **Not through the frozen gate.** It is an `ERC1967Proxy` (implementation `0xF086…78DF`): upgradeable, so deployment-prohibited as a gate funding token by the frozen vetted-token policy. Admitting it needs either a reviewed policy change (upgradeable tokens with a pinned implementation and an admin-change watch) or a gate version, both outside 7E.3. |
| Does it add genuine economic meaning? | **Yes, if admitted.** It would replace MDUSD's declared settlement assumption with a real, issuer-documented dollar token, and — being a USD stablecoin both on Robinhood Chain and as Lighter's Robinhood-deployment collateral (venue-fit S15) — it is the natural candidate for a *live* shared cross-domain unit, which MDUSD deliberately is not. It still would not be USD: Q-8 (how a stablecoin relates to a USD budget) stays open. |
| Decision | **Deferred to 7E.4.** Not trivial, so not integrated. |

## 6. Procedure

```bash
# once, by hand: fund the disposable deployer from the testnet faucet
npm run robinhood:testnet:deploy -- --dry-run   # the whole flow on a local anvil fork of the testnet
npm run robinhood:testnet:deploy                # testnet: deploy, verify, set up, write the manifest
npm run robinhood:testnet:demo  -- --dry-run    # deploy + demo on a fork
npm run robinhood:testnet:demo                  # testnet: the demonstration against the manifest's gate
```

`deploy`:

1. `forge build`, then deploys MDEMO, MDUSD and the gate from their build
   artifacts, each transaction signed in-process by the deployer key (no key
   on a command line);
2. writes `contracts/deploy/robinhood-testnet.json`;
3. runs the reviewed deployment script's read-only
   `DeployMandateGate.verify(gate, config)` against the deployed gate;
4. compares the gate's runtime code with the artifact, constructor-set
   immutables aside, and checks its domain separator;
5. setup: 1,000 MDEMO to the venue; 1,000 MDUSD and 0.00005 ETH to the
   principal; the principal approves the gate for **500 MDUSD — the same amount
   as its Mandate capital authority**;
6. writes the manifest.

Neither command is part of `npm run check` or `npm test`. The dry runs start a
local anvil **fork** of the testnet with chain id 46630 on loopback; nothing is
broadcast to the network and nothing is written into the repository.

## 7. Provenance and verification

| Check | Status |
| --- | --- |
| `DeployMandateGate.verify(gate, config)` — market table and the created venue/adapter code equal to reference instances | **PASS** against the live gate |
| Gate runtime code = artifact runtime code except the constructor-set immutables | **PASS** (`runtimeMatchesArtifactExceptImmutables: true`) |
| Domain separator = `{Mandate, 1, 46630, gate}` | **PASS** (`0xf329d090…17d3`) |
| Explorer source verification (Blockscout) | **unavailable**: the testnet explorer offers solc up to 0.8.36 (`/api/v2/smart-contracts/verification/config`, checked 2026-09-29); the frozen build pins 0.8.37, and recompiling with another compiler would change the deployed bytecode. A first attempt reported success because `forge verify-contract --watch` exits 0 on Blockscout's `Fail - Unable to verify`; the command now reads Blockscout's status and checks compiler support first |
| **Final deployment provenance gate** (execution-gate.md §13: initcode, constructor arguments, complete market set, `MarketSupported` event set, domain separator) | **not built.** The checks above cover part of it; the deployment is *not* described as provenance-verified in that sense |

Compiler: solc `0.8.37`, optimizer on, 200 runs, `via_ir`, EVM `cancun`,
`bytecode_hash = "none"` — so the runtime code is reproducible from the source
without metadata noise.

## 8. Gas and size

| Item | Testnet (gas used) | Anvil fork (dry run) |
| --- | ---: | ---: |
| Gate deployment (one market; creates venue and adapter) | 4,726,133 | 4,323,885 |
| Demo token deployment (MDEMO / MDUSD) | 605,756 / 605,531 | 541,101 / 541,077 |
| Authorized `execute` (BUY 30 MDEMO) | 309,663 | 277,575 |
| Reverted replay, mined | 164,767 | 132,645 |
| Reverted amount mutation, mined | 162,190 | 130,169 |
| Principal's `approve` | 51,975 | 45,921 |

| Size | Bytes |
| --- | ---: |
| Gate runtime / initcode (EIP-170 limit 24,576) | 13,815 / 22,959 |
| Venue / adapter / demo token runtime | 1,777 / 2,076 / 1,536 |

The testnet figures are the receipts' `gasUsed`; on an Arbitrum chain that
includes the L1 data component, which a local fork does not charge — hence the
difference of roughly 30,000–400,000 gas, growing with calldata and code size.
Phase 6R.2B's canonical cold-transaction profiles (BUY 246,963; worst case
425,922) are unchanged; the demo's figure includes the fixture venue's two
token transfers, the approval and refund, and the Arbitrum-family gas
accounting of the chain it ran on.

## 9. Keys

Three disposable keys, generated for this phase with `cast wallet new`, used
nowhere else, holding testnet ETH and fixture tokens only:

| Role | Holds | Can |
| --- | --- | --- |
| deployer | testnet ETH, the fixtures' remaining supply | deploy, fund, and submit `execute` as a gas payer — it holds **no authority**: the gate accepts `execute` from anyone, and a submission without the principal's signature settles nothing |
| principal | 1,000 MDUSD, a 500 MDUSD allowance to the gate | sign gate mandates — **only through Mandate custody**, after custody has read the committed `ADMIT_ATTEMPT` |
| agent | nothing | sign execution commitments; alone, it moves nothing |

They live in `.robinhood-testnet/keys.json` (gitignored; the scripts refuse
the file if it is group- or world-readable). `npm run credentials:scan`
forbids that path in the index and searches every tracked file for the three
private keys' actual values.

## 10. Limits

- **Fixture, not market.** No liquidity, price discovery or venue failure
  beyond revert. Nothing here is a trade of a real asset.
- **Upgradeable real tokens are not admitted** (§3–§5), so no Robinhood Stock
  Token and no USDG is used.
- **The principal key is an EOA.** Whoever holds it can move the principal's
  tokens directly. In 7E.3 only Mandate custody holds it, in the signer's
  process (reference separation, like 7E.1's before 7E.2's custody process);
  that is a deployment property, not a chain-enforced one. A smart-account
  principal would make the gate the only spender; that is later work.
- **The public RPC is rate-limited** and unauthenticated; reads are trusted as
  that endpoint's answer. Finality is `LATEST` for the immutable market table
  and nothing is released on any confirmation level (7F).
