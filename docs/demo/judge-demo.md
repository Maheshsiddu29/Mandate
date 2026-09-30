# Mandate — the judge demo

> **Status: buildathon Milestone A, implemented locally, offline, awaiting
> review.** A thin, additive orchestration layer (`packages/judge-demo`) over
> the frozen Phase 7F–7F.3 Portfolio Mandate. It changes no protocol
> semantics: nothing under `contracts/`, `kernel`, `core`, `ledger`,
> `control`, `registry`, `ledger-sqlite`, `execution-gate`, `evm-robinhood`,
> `perp-lighter` or `packages/portfolio`, no Phase 7E artifact and no
> existing corpus is modified. No transaction is sent, no contract is
> deployed, no network is contacted.

```text
Agents propose.  Agents negotiate.  Mandate authorizes.  Markets settle.

VALID AGENT != VALID ACTION
```

## 1. What the judge sees

One principal, one signed Portfolio Mandate, five deterministic agents, ten
scenes. Every scene is produced by the real Mandate code; the demo only
narrates what that code returned.

| Scene | What happens | Real code that decides it |
| ---: | --- | --- |
| 1 | The Portfolio Mandate is created: HYBRID allocation, five typed resources, five agents | `demoMandate`, `compilePortfolio`, `registerPortfolio` (ledger), principal signature |
| 2 | Five agents search and sign proposals; security-invalid ones are **blocked** | agent keys, `proposalSignedByAgent`, `screenProposal` (registry, scopes, limits) |
| 3 | The admissible demand exceeds the portfolio's authority: **resource conflict** | the room's decisions and derived demands vs the mandate's limits |
| 4 | The Mandate Room negotiates: release, reduce, reassign | `runMandateRoom` (allocation book: RELEASE, CLAIM, COMMIT) |
| 5 | The Room's output is independently re-verified and reserved | `verifyPortfolio`, `checkChildAuthorization`, `reserveChild` (control engine + ledger), replay probe |
| 6 | The swap agent is compromised: with its real key it signs a swap to an attacker; it is **blocked** | `screenProposal` → `RECIPIENT_NOT_ALLOWED`; `verifyPortfolio` refuses a Room that accepts it anyway |
| 7 | Only the bad action was blocked: healthy agents and the portfolio stay active | ledger state read after the attack: every reservation, version, headroom |
| 8 | The **same** agent key signs the compliant swap; it is authorized | the full path again: room, verifier, reservation, fixture execution |
| 9 | A locally valid top-up exceeds what the portfolio still has: negotiated down, then authorized | `runMandateRoom` (`REDUCE_REQUESTED`, `ALLOCATION_INSUFFICIENT`), verifier, ledger |
| 10 | Every run's `PORTFOLIO_RECEIPT.V2` and the recorded Phase 7E.3 testnet evidence | `receiptDigest`, the read-only evidence adapter |

## 2. Why invalid actions are blocked, not negotiated

A proposal is **security invalid** when the action itself is outside the
principal's authority — the wrong representation, issuer, venue, recipient,
asset. No amount of negotiation can make it valid, because the Room has no
operation that widens a scope. Such a proposal is refused at screening and
never enters negotiation; its refusal costs 0 transactions and 0 gas.

A proposal is **locally valid but in resource conflict** when the action is
inside the agent's authority and only its *size* does not fit what the
portfolio can still give. That is a question of distribution inside the
principal's limits, which is exactly what the Mandate Room is for.

| Scenario | Agent authenticated? | Action individually valid? | Portfolio valid? | Response |
| --- | :---: | :---: | :---: | --- |
| Wrong representation (same-ticker look-alike) | yes | no | n/a | **BLOCK** |
| Unapproved venue (better quote, unknown router) | yes | no | n/a | **BLOCK** |
| Unapproved product/issuer (higher advertised APY) | yes | no | n/a | **BLOCK** |
| Wrong recipient (compromised agent) | yes | no | n/a | **BLOCK** |
| Valid proposal but Portfolio over limit | yes | yes | no | **NEGOTIATE** |
| Valid final portfolio | yes | yes | yes | **AUTHORIZE** |

"Authenticated" is the agent's signature recovering to an agent the mandate
names. It grants nothing (security-model.md §1).

## 3. Why the Room's output is untrusted

The Mandate Room is a deterministic coordination function with **zero
authorization power**. It can accept, reject, ask to reduce, apply a signed
release and reassign a released lot — nothing else. Its output, a
`PortfolioCandidate`, is input to the Portfolio Verifier, which re-derives
everything from the principal's signed mandate and the agents' signed
messages; the ledger then re-checks every limit at reservation. Scene 5
shows the verifier refusing a forged Room output that also accepts the
blocked look-alike; scene 6 shows it refusing a Room that accepts the
attacker's swap.

## 4. Why one compromised agent does not stop healthy agents

Authorization is per action. A refusal is a decision about one signed
proposal; it writes nothing to the ledger, releases nothing and revokes
nothing. Scene 7 reads the ledger after the attack and shows it byte-for-byte
where it was: same version, same reservations, same headroom. **Block the bad
action, not the healthy portfolio.** (A principal emergency stop is not part
of this milestone.)

## 5. What is real, what is fixture, what is simulated

| | Class | What it means here |
| --- | --- | --- |
| Portfolio Mandate, agents' signatures, screening, registry, Room, verifier, child derivation, control engine, ledger, reservations, `ADMIT_ATTEMPT`, `checkBeforeSign`, Receipt V2 | real code | the frozen implementation, called through its public API |
| Agent keys | demonstration | `@mandate/portfolio/demo` keys, derived from public labels: they secure nothing, are never printed and must never hold value |
| Stock (Robinhood Chain) | integration `LIVE_TESTNET` (Phase 7E.3); this run `OFFCHAIN_ONLY` | the child is reserved and handed to `robinhood-gate-signer`; no new testnet execution happens in this demo |
| Perps (Lighter) | `OFFCHAIN_ONLY` | authorized and exactly specified offchain; no funded testnet account |
| Swap, NFT, yield | integration `FIXTURE`; executed children `SIMULATED` | labelled fixture venues; `ADMIT_ATTEMPT` and `checkBeforeSign` are real, settlement is simulated |
| Addresses, prices, quotes, account books | fixture | the Phase 7F demonstration markets |

The Phase 7E.3 LIVE_TESTNET evidence is **historical**: it is read, never
re-executed, from `docs/phase-7e/deployment-manifest.json` and
`docs/phase-7e/robinhood-demo-receipt.json`. Its market is the deployed
MDEMO/MDUSD fixture market; the stock market in this demo is the offline
Phase 7F gate configuration engineered to settle USDC. That seam is part of
the evidence event.

Never claimed: five live integrations, five live executions, any real asset
traded, any guaranteed return.
