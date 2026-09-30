# Live AI Lab — Robinhood Chain testnet settlement (B.5.2)

> **Status: buildathon Milestone B.5.2, implemented locally, awaiting
> review.** One explicit path from a Live AI Stock decision to a Robinhood
> Chain **testnet** transaction: `packages/live-settlement`. Dry run passed
> against the deployed Phase 7E.3 gate on 2026-09-30 (stub decision, `eth_call`
> and `estimateGas` only). **No settlement transaction has been sent by this
> milestone yet**: a send needs a live model decision (`OPENAI_API_KEY`) and
> the operator's exact authorization phrase. Testnet (46630) only; valueless
> labelled fixture assets; no mainnet, no real funds, no production
> credential. Nothing frozen changes. Swap, NFT, Yield and Perps are not
> settled and never labelled `LIVE_TESTNET`.

```text
real model (OpenAI) chooses a Stock action      — closed-set candidate id + amount, nothing else
  → real Mandate screening, Room, Portfolio Verifier, ledger reservation   (unchanged B.5 path)
  → settlement eligibility, re-derived from the frozen protocol and the committed ledger
  → the declared testnet settlement fixture (quantity-preserving; MDUSD → MDEMO)
  → preflight: chain id 46630 asked of the RPC; code hashes = manifest; balance, allowance, gas
  → domain leg: GateSpotPolicy v1 authorization of exactly this BUY in the 7E.3 domain ledger
  → existing robinhood-gate-signer: ADMIT_ATTEMPT → guarded custody → agent signature
  → exact-call check → eth_call → estimateGas
  → DRY RUN stops here.  SEND: only after "AUTHORIZE ROBINHOOD TESTNET SEND" → one broadcast
  → receipt (status 1) → postconditions on chain → LIVE_TESTNET
```

## 1. What is reused, unchanged

| Phase 7E.3 component | Role here |
| --- | --- |
| `docs/phase-7e/deployment-manifest.json` | the only source of addresses, code hashes, domain separator, explorer, parties (`parseDeployment`) |
| `MandateExecutionGate` `0xb03c…aa3e`, `FixtureVenue`, `FixtureVenueAdapter`, MDEMO, MDUSD | the deployed stack; nothing is redeployed |
| GateSpotPolicy v1, `robinhood-gate-signer` v1 | the domain module and adapter of the domain leg |
| `ControlEngine`, `SqliteLedgerStore`, lifecycle table, `IssuanceJournal` | the Robinhood domain's own ledger and issuance journal |
| `GateSigner` (`ADMIT_ATTEMPT` before any key, preflight, `resubmission:none`) | issuance, unchanged |
| `LocalGateCustody` (re-derives the artifact from the committed attempt), `LocalAgentSigner` | the principal and agent keys |
| `ChainClient`, `JsonRpcClient` (testnet host only, mainnets refused), `TxSender` | RPC and the gas payer |
| `.robinhood-testnet/keys.json` via `evm-robinhood/scripts/lib.ts` `loadKeys` | the three disposable 7E.3 testnet keys (gitignored, 0600) |

`packages/live-settlement` adds: the authorized-execution selection,
eligibility, the fixture mapping, preflight, a custody guard, a `GateChain`
with the send gate, the evidence rule, and the runner.

## 2. The asset mapping, and why the label is truthful

The Live AI Stock agent decides over the Phase 7F demonstration market:
`nvda-note-a`, a fictional *Fixture Backed NVIDIA Note* on an **offline**
reviewed gate configuration that settles an engineered USDC
(`packages/portfolio/src/demo/markets.ts`). The repository defines no mapping
from it to the deployed gate, whose only market is MDEMO against MDUSD. So
B.5.2 adds one, explicitly (`src/fixture-mapping.ts`,
`TESTNET_SETTLEMENT_FIXTURE`):

| | |
| --- | --- |
| Decision semantics | `nvda-note-a` — what the model chose and Mandate screened, verified and reserved. Its canonical asset stays NVIDIA. |
| Execution fixture | a BUY of MDEMO for MDUSD through the deployed gate: valueless assets that exist only to exercise the Robinhood Chain testnet settlement path |
| Rule | **quantity-preserving**: gate BUY quantity = the reserved `STOCK_BUY` quantity, atom for atom (both 18 decimals); debit = the fixture venue's quote for it (10 MDUSD per MDEMO, no fee), which the gate enforces; recipient = the manifest principal |
| Example | 400 USDC authorized for the 125-USDC note = 3.2 notes → 3.2 MDEMO for 32 MDUSD |
| Ceiling | 100 MDUSD (the Stock agent's own maximum, 800 USDC, maps to 64) |

Every event says: *Robinhood Chain testnet fixture settlement — valueless
demo assets (MDUSD → MDEMO); not an NVDA trade, not a Robinhood Stock
Token.* MDEMO is not NVDA; MDUSD is not a stablecoin. A settlement is never
reported as an NVDA trade.

## 3. Keys and the custody boundary

| Key | Holder | Used for |
| --- | --- | --- |
| Live AI demonstration keys (principal, five agents) | `live-agents/src/mandate/signer.ts` | the Portfolio Mandate and proposals, as in B.5 |
| 7E.3 principal (disposable) | `LocalGateCustody`, constructed only in `live-settlement/src/domain-leg.ts` | the gate mandate, after its own checks and the settlement's guard |
| 7E.3 agent (disposable) | `LocalAgentSigner`, same | the execution commitment |
| 7E.3 deployer (disposable, gas payer, no authority) | `TxSender` in `live-settlement/src/rpc.ts` | signing the one `execute` transaction |

No key reaches a model, a prompt, OpenAI, the browser, the local API, an
event or a log. `@mandate/live-agents` — the model providers, the Room, the
policy-stress agent, the local server — cannot import this package, any RPC
client or any transaction signer (structure tests in both packages). The
browser app imports neither.

The settlement RPC client can address exactly one function on exactly one
contract: `execute` on the manifest gate. It has no generic call, no
arbitrary calldata and no other destination.

## 4. Eligibility (all twelve, or zero submission)

Re-derived before the domain leg and again inside custody just before the
principal key signs (`src/eligibility.ts`, `src/custody-guard.ts`):

| # | Condition | How |
| --- | --- | --- |
| 1 | model answer passed local schema validation | candidate id in the Stock agent's closed set |
| 2 | trusted local code built the proposal | candidate = that id's trusted `build` (representation, account) |
| 3 | Stock agent identity signed it | agent = the Stock party; signature recovers |
| 4 | screening accepts the exact candidate | `screenProposal` now derives the same child digest |
| 5 | Portfolio Verifier accepts it | `verifyTranscript` re-derives the run and lists this child |
| 6 | valid current reservation | ledger reservation ACTIVE, this action, generation 1, no attempt |
| 7 | version active; not superseded, revoked, paused | session's active version; no node of the lineage revoked |
| 8 | exactly the reserved proposal | proposal, candidate, child and action digests equal the reserved ones |
| 9 | freshness | proposal and Core authorization unexpired (protocol time); quote age by (4) |
| 10 | chain id 46630 | `eth_chainId` at preflight, at simulation, and again immediately before the broadcast |
| 11 | contracts = manifest | runtime code hash of gate, venue, adapter, MDEMO, MDUSD; gate domain separator |
| 12 | send gate open | the exact phrase, once; consumed by the one broadcast |

## 5. Exact binding

`VERIFIED == COMPILED == RESERVED == ADMITTED == SIGNED == SUBMITTED`:

- the settlement acts on the `ReservedExecution` object the Live AI session
  returned (signed proposal, verified child, authorization record,
  transcript) — never a reconstruction; eligibility re-derives every digest;
- the fixture mapping is a pure function of it; `run` re-derives it and
  refuses any settlement whose binding digest differs
  (`SETTLEMENT_NOT_DERIVED_FROM_EXECUTION`);
- the **one unavoidable transformation** is the fixture itself (NVDA note →
  MDEMO, demo principal → manifest principal, USDC notional → the venue's
  MDUSD quote). Every field that reaches the chain — chain, gate, tokens,
  quantity, debit, gross, recipient, agent — plus the Live AI proposal,
  candidate, child, reservation, execution authorization, action and receipt
  digests is in the settlement **binding digest**; its first eight bytes are
  the domain action's nonce, so the gate mandate id (derived from that
  action's execution authorization, and signed by the principal) commits to
  it;
- the domain leg's grant has a `CAPITAL` limit of exactly the fixture debit
  and one market, so nothing else can be authorized under it;
- custody signs only an artifact whose recipient, agent, tokens, quantity,
  debit and gate are the settlement's; the chain wrapper sends only the call
  it simulated, after checking selector, calldata re-encoding, recipient,
  tokens, amounts, empty execution data, deadline and mandate id.

## 6. Commands

```bash
npm run agents:live                    # unchanged: offchain, 0 transactions
npm run agents:live:json               # unchanged
npm run agents:live:testnet:dry-run    # live model → full path to eth_call + estimateGas; nothing broadcast
npm run agents:live:testnet            # the same, then waits for the phrase on stdin; one broadcast at most
node packages/live-settlement/scripts/testnet.ts --provider=stub --dry-run   # offline decision, testnet dry run
```

`--provider` chooses the model; it never grants send permission. A stub
decision is never sent. A send writes a public, write-ahead record to
`.robinhood-testnet/runs/live-ai-<time>/settlement.json` (gitignored) before
the broadcast; a later send refuses while any earlier record is unresolved.

## 7. Lifecycle and evidence

The Live AI ledger's reservation stays `RESERVED` (Core has no
reconciliation; 7F). The domain leg uses the existing vocabulary:
reservation → `ADMIT_ATTEMPT` → journal `ARTIFACT_ISSUED` →
`SUBMISSION_SENT` → `SUBMISSION_ACKNOWLEDGED` / `SUBMISSION_REJECTED` /
`OUTCOME_UNKNOWN`. The settlement reports
`RESERVED → SUBMISSION_STARTED → SUBMITTED → SETTLED` or `… → FAILED`.

| Evidence | When |
| --- | --- |
| `LIVE_TESTNET` | public testnet RPC, chain id 46630 verified, **live model** decision, broadcast, receipt status 1, postconditions (commitment recorded, principal −debit MDUSD, +quantity MDEMO, agent unchanged) |
| `SUBMITTED_UNCONFIRMED` | a hash without a receipt — never settlement |
| `FAILED` | reverted receipt, failed postconditions |
| `DRY_RUN` / `NOT_SUBMITTED` | nothing broadcast |
| `REFERENCE_MODEL` | tests over the Phase 6 reference model |

An ambiguous broadcast is resolved by asking the chain about the same
hash; nothing is re-signed or resent.

Events (additive to `MANDATE_LIVE_AI.V1`; `MANDATE_JUDGE_DEMO.V1`
untouched): `TESTNET_PREFLIGHT_STARTED|PASSED|FAILED`,
`DOMAIN_EXECUTION_INELIGIBLE`, `DOMAIN_EXECUTION_READY`,
`TESTNET_SIMULATION_STARTED|PASSED|FAILED`,
`TESTNET_SEND_AUTHORIZATION_REQUIRED|REFUSED`,
`TESTNET_TX_SUBMISSION_STARTED`, `TESTNET_TX_SUBMITTED`,
`TESTNET_TX_CONFIRMED`, `TESTNET_TX_FAILED`, `DOMAIN_EXECUTION_SETTLED`,
`DOMAIN_EXECUTION_FAILED`. They carry public facts only (chain id, hash,
block, target, public addresses, gas, amounts, digests, evidence, explorer
link from the manifest) — never a key, a signature, the raw transaction or
calldata. The `/demo/live` client is unchanged and ignores kinds it does not
render; the local API never runs a settlement.

## 8. `executeAfter: 0n`

**Does any protocol security property require `executeAfter > now`? No.**
`executeAfter` is `runPortfolio`'s scheduling offset for the domain
executor. At that point the protocol's time rules are: the ledger never
accepts an event earlier than its latest (`EVALUATION_TIME_REGRESSED`; equal
is accepted), and an attempt must precede the authorization's ceiling
(`AUTHORIZATION_EXPIRED`). Neither has a lower bound. The judge demo's 5 s is
a narrative gap in a scripted timeline. The Stock child is not executed by
the portfolio executor at all (`AWAITING_DOMAIN_SIGNER`); the domain leg
takes its time from the chain, and the gate enforces `notBefore`, deadline
and expiry itself. Regression: `packages/live-agents/test/execute-after.test.ts`.

## 9. USDG

Unchanged: Paxos USDG on testnet is an `ERC1967Proxy` (upgradeable), which
the frozen token policy prohibits as a gate funding token
([robinhood-deployment.md §5](../phase-7e/robinhood-deployment.md#5-usdg)).
Not used; no policy was relaxed.

## 10. Validation

| Check | Result |
| --- | --- |
| `packages/live-settlement` tests (offline, reference model) | 46 pass |
| `packages/live-agents` tests | 129 pass (incl. default runs: 0 transactions, no settlement event) |
| testnet dry run, stub decision, 2026-09-30 | preflight PASS (chain 46630, all five code hashes = manifest, domain separator = manifest); 400 USDC → 3.2 MDEMO for 32 MDUSD; `eth_call` passed; `estimateGas` 337,458; **nothing broadcast** |

## 11. Limits

- Fixture settlement, not an NVDA trade; MDEMO/MDUSD are valueless.
- The Live AI reservation is not consumed after settlement (no
  reconciliation; 7F), and its ledger records no attempt for the fixture:
  one settlement per session is enforced by the settlement path itself.
- The 7E.3 principal is an EOA whose key custody holds in-process
  (reference separation, as in 7E.3).
- Custody's eligibility check reads the Live AI ledger as of the last
  refresh before issuance and the session's version state live; the runner
  is a single process with no concurrent writer.
- One lane: slot allocation assumes one signer per principal and gate.
- Browser-wallet signing is not built.
