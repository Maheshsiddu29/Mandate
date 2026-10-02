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

The same property in a live OpenAI run, when the Stock Agent selects the
cheaper lookalike `nvda-token-b` and Mandate blocks it
(`REGISTRY:ISSUER_NOT_ALLOWED` or `REGISTRY:SYNTHETIC_NOT_ALLOWED`):
[Live Demo — Stock Agent Blocked by Mandate](live-ai-lab.md#stock-agent-blocked-by-mandate).
Choosing the approved `nvda-note-a` on another run is authorized. Both
outcomes are intentional.

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

## 6. How to run

```bash
npm run demo:judge        # human-readable: one line per event, scene by scene
npm run demo:judge:json   # the complete MANDATE_JUDGE_DEMO.V1 transcript, for a UI
```

Both are offline and deterministic: no network, no RPC, no key file, no
environment variable, no transaction. They run the real Mandate code once
against a fresh in-memory ledger and read the two committed Phase 7E.3
records. The output is byte-identical on every run (asserted in
`determinism.test.ts`).

## 7. The run

Every value below is what the current code produces; the tests assert it.

| Scene | What the protocol returned |
| ---: | --- |
| 1 | Principal `0x51f0…5904`, HYBRID, `portfolio-notional` 2,000 USDC (plus `derivative-notional` 400, `illiquid-notional` 400, `spot-capital` 800, `perp-margin` 400); five agents; mandate digest `0x489a…da3c` |
| 2 | The agents first ask for **2,550**. Blocked (security invalid): stock's same-ticker look-alike (`REGISTRY:ISSUER_NOT_ALLOWED`, `REGISTRY:SYNTHETIC_NOT_ALLOWED`); swap's unknown router quoting 4.16 % more (`VENUE_NOT_ALLOWED`); NFT's same-name impostor (`ASSET_NOT_ALLOWED`, `REPRESENTATION_NOT_ALLOWED`); yield's 12.60 % advertised APY vault (`ASSET_NOT_ALLOWED`, `ISSUER_NOT_ALLOWED`, `REPRESENTATION_NOT_ALLOWED`, `VENUE_NOT_ALLOWED`). Admissible: stock 600, swap 300, yield 700. Locally valid, in conflict: perps 600 (`PORTFOLIO_LIMIT_EXCEEDED` on `derivative-notional`). NFT: no compliant opportunity |
| 3 | Admissible demand 2,200 > 2,000 `portfolio-notional`; 600 > 400 `derivative-notional` |
| 4 | Round 1: perps asked to reduce. Round 2: NFT releases 250 (+400 illiquid); stock claims 100 of it, swap 50; perps resubmits 400 (claims 400 `derivative-notional` from the unallocated remainder); yield asked to reduce to 600 (`ALLOCATION_INSUFFICIENT`). Round 3: yield resubmits 600, claims the last 100. Proposed: 1,900 — not authorized |
| 5 | 17 of 17 verifier checks pass; a forged Room output also accepting the look-alike is refused (`REGISTRY:*`); four children reserved; **1,900 of 2,000 reserved, 100 available**; swap and yield settle `SIMULATED`, stock and perps `AWAITING_DOMAIN_SIGNER`; every child presented again is refused `LEDGER:REQUEST_INVALID/RESERVATION_EXISTS`, ledger version unchanged |
| 6 | The swap agent, same key, signs the approved swap with `recipient` → `eip155:421614/account:0x9999…9999`. Signature valid, identity valid, capability active; **`RECIPIENT_NOT_ALLOWED`**; a Room accepting it anyway is refused by the verifier. 0 reservations, 0 attempts, 0 executor calls, 0 transactions; ledger version unchanged |
| 7 | All four reservations still live (swap, yield `ADMITTED`; stock, perps `RESERVED`), 1,900 reserved, every agent's headroom unchanged |
| 8 | The same key signs the swap paying the principal (50 USDC): verified, reserved, `SIMULATED`; **1,950 of 2,000** |
| 9 | Yield asks to add 200 — screening passes, its own headroom is 200 — but 50 is left: `REDUCE_REQUESTED` / `ALLOCATION_INSUFFICIENT`, target 50; it resubmits 50; verified and reserved: **2,000 of 2,000** |
| 10 | Receipt V2 digests — initial `0x6d47bd67…41e1ad` (the committed `portfolio-demo-v1` receipt), attack `0x57726245…b11ab8`, compliant `0x03d3b1dc…709950`, conflict `0xfbba37ba…8d9bc4`; the 7E.3 BUY `0x7144f09f…dff344`; **0 transactions** |

89 events in all (scene 1: 1, 2: 22, 3: 1, 4: 15, 5: 17, 6: 3, 7: 1, 8: 11, 9: 12, 10: 6).

### Sources

- Scenes 1–5: `runDemo()` from `@mandate/portfolio/demo` — the canonical Phase
  7F mandate, markets and agents (`packages/portfolio/src/demo/*`), whose
  receipt is `corpus/portfolio-demo-v1/receipt.json`.
- Scenes 6–9: `runPortfolio` against the same ledger with the inputs in
  `packages/judge-demo/src/scenario.ts` (when, what the compromised agent
  tries, what it then does, the top-up) — inputs only, no outcomes.
- Scene 10: every run's own receipt; `docs/phase-7e/deployment-manifest.json`
  and `docs/phase-7e/robinhood-demo-receipt.json`.

## 8. Continuation semantics and limits

- **Scenes 6, 8 and 9 are new Portfolio runs on the same ledger.** That is the
  frozen API's own model for a portfolio over time: each run reads the
  ledger's availability, and the ledger alone enforces the hard limits. No
  replay store or allocation ledger is added.
- **The allocation book starts from the mandate each run.** Allocation is
  coordination, not ledger state (implementation-7f.md §3.2). A later run's
  Room therefore sees each agent's preferred allocation again, capped by
  what the ledger says is left; a continuation can give an agent more than
  its preferred share, never more than its hard maximum or the portfolio
  limit. Durable allocation would need allocation events in Core.
- **Agent sequences continue** across runs (the swap agent signs 3, then 4;
  yield 4, then 5), but the verifier enforces monotonicity only within one
  transcript; replay of the *same* signed proposal is refused by the ledger
  (security-fixes-7f2.md §4–§5).
- **A refused action revokes nothing.** The compromised agent's earlier
  legitimate reservation stays live; a principal emergency stop is out of
  scope.
- **A Core bypass is not narrated.** Going around the Portfolio straight to
  the control engine is covered by `packages/portfolio/test/malicious.test.ts`;
  at the attack's time Core refuses the forged child because its window has
  ended, which is true but would not show the recipient rule.
- Nothing is executed on a live venue: stock and perps children are handed
  to their domains' signers; swap, NFT and yield venues are fixtures.

## 9. UI integration contract

The UI consumes `npm run demo:judge:json` (or `runJudgeDemo(...).transcript`)
and plays it back. It never re-runs the protocol per frame.

```text
protocol run  →  deterministic event transcript  →  UI playback
```

**Transcript.** `{ schema: "MANDATE_JUDGE_DEMO.V1", version: 1,
presentationOnly: true, events, presentationDigest }`.

**Event.** Every event has every field:

| Field | Meaning |
| --- | --- |
| `sequence` | 0, 1, 2, … — the logical tick and the only order |
| `scene` | 1–10 (`SCENES` gives titles) |
| `kind` | one of `EVENT_KINDS` |
| `run` | `initial`, `attack`, `compliant`, `conflict`, or `null` |
| `round` | the Mandate Room round, for events the Room produced |
| `protocolTime` | the decision time passed to the protocol (unix seconds, decimal text) — a parameter, not a clock |
| `agent` | `{ id, label }` — `id` is the agent's address; key animations by it |
| `domain` | `robinhood-evm`, `swap-fixture`, `nft-fixture`, `yield-fixture`, `lighter-perp` |
| `proposal`, `candidate` | the signed proposal's and its candidate's digests — stable identities |
| `requested`, `approved` | `AmountView[]`: `{ resource, unit, decimals, atoms, amount }`, exact decimal text |
| `status` | one of `EVENT_STATUSES`, for colour |
| `reasons` | `{ code, subject }[]` — real protocol reason codes |
| `evidence` | an evidence class where the event is about evidence or an execution |
| `artifacts` | `{ name, value }[]` — digests, reservation ids, transaction hashes |
| `message` | one presentation line; the values are in `data` |
| `data` | kind-specific detail (checklists, changed fields, per-agent states, receipt summaries) |

**The breakout room.** `MANDATE_ROOM_OPENED.data.participants` lists who
enters; `AGENT_RELEASED_AUTHORITY`, `AGENT_REDUCTION_REQUESTED`,
`AGENT_PROPOSAL_REDUCED`, `AUTHORITY_REALLOCATED` (with `data.from` and
`data.lot`) and `PROPOSAL_ACCEPTED` follow in the Room's own order, grouped
by `round`; `MANDATE_ROOM_PROPOSED_PORTFOLIO` closes it, still unauthorized.
Blocked proposals are listed in `data.excludedAtScreening` and must not be
drawn inside the room.

**Controls.** `new DemoPlayback(events)` gives `start`, `pause`, `resume`,
`next`, `restart`, `state`, `position` and `shown`. It is a cursor with no
timer: the UI decides when to call `next()`.

**The UI must not** treat any event, summary or digest as authority; compute
amounts with floats (use `atoms`); present `presentationDigest` as a protocol
commitment (it is keccak over canonical JSON, for detecting drift between a
UI build and the protocol; the commitments are the receipt digests); or
label anything LIVE_TESTNET except the `LIVE_TESTNET_EVIDENCE` event and the
Robinhood integration it backs.

## 10. Package and tests

`packages/judge-demo` (`@mandate/judge-demo`) depends on `@mandate/portfolio`,
`@mandate/core`, `@mandate/kernel` and `@noble/hashes`; nothing depends on
it. Its source reads no clock, randomness or environment and makes no
network call; `evidence-files.ts` is its only filesystem access, and
`agents.ts` its only key holder. There is no model in it.

| Module | Role |
| --- | --- |
| `protocol.ts` | runs the real protocol once, in order, and the probes; snapshots the ledger |
| `scenario.ts` | continuation inputs and decision times |
| `agents.ts` | `AgentIdentity` (the key, private, counted) and `ContinuationAgent` |
| `malicious-agent.ts`, `opportunities.ts` | the attack, the compliant swap, the top-up |
| `proposals.ts`, `explain.ts` | real screening beside each Room decision; plain language over real codes |
| `portfolio-scenes.ts`, `room.ts`, `verification.ts`, `attack-scenes.ts`, `continuation-scenes.ts`, `receipt.ts` | scenes 1–10 |
| `evidence.ts`, `evidence-files.ts` | the Phase 7E.3 evidence parser and its loader |
| `events.ts`, `playback.ts`, `render.ts`, `orchestrator.ts` | the contract, controls, text output, and `runJudgeDemo` |

Tests (`packages/judge-demo/test`): `structure`, `events`, `playback`,
`scenario` (scenes 1–3), `room` (4–5), `malicious-agent` (6),
`continuation` (7–9), `receipt` and `evidence` (10), `adversarial` (the
end-to-end security test through the public API, reproducing the demo's
receipts), `determinism`.
