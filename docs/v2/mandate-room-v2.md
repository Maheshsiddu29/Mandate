# Mandate Room V2 — intentional capital allocation and market-aware reallocation

Status: design, written before implementation (2026-10-02). It redefines
the Live AI Lab's Mandate Room (`packages/live-agents`). It changes no
frozen protocol: the Portfolio Mandate, its Room, verifier, ledger and every
canonical vector stay exactly as they are. Everything below is coordination
*above* them.

> If you tell Mandate exactly how much each agent may use, the Room stays
> out of the way.
>
> If you give several agents a shared pool and let them decide, they analyze
> the opportunities and propose a split.
>
> You can edit that split before signing.
>
> After authorization, unused capital may be reallocated only if the mandate
> explicitly permits it.

Unused capital stays in the wallet. Mandate does not force deployment.

### Signed initial allocation commitment

Every accepted FIXED, DYNAMIC or HYBRID plan has one canonical
`PORTFOLIO_INITIAL_ALLOCATION.V1` object. It binds the canonical portfolio
mandate digest, deployable capital, allocation intent, reallocation permission,
one FIXED/PLANNED entry for every enabled agent (including zero allocations),
and the capital kept unallocated. Entries are ordered by canonical agent
encoding; amounts are unsigned fixed-width atoms; duplicates, disabled agents,
incoherent totals, non-canonical integers and trailing bytes are refused. Its
identity is Keccak-256 of the tagged canonical encoding. Model rationale,
presentation copy and UI labels are deliberately excluded.

The wallet path uses the distinct EIP-712 primary type
`PortfolioMandateAuthorizationV2`, which adds `initialAllocationDigest` to the
existing statement, mandate digest, principal and session digest. The legacy
`PortfolioMandateV2` type remains valid only when explicitly selected as that
older scheme: neither signature can be interpreted as the other.

---

## 1. Current behaviour (audit of the local code at `8fd923a`)

The path a Live Lab run takes today:

```text
Compose (web)            apps/web/components/demo/live/live-lab.tsx  buildMandate()
  ─▶ prompt interpretation  POST /draft {prompt} ─▶ LiveSession.interpret ─▶ interpretPrompt (model or local parser)
  ─▶ mandate draft          authoring/draft-types.ts; "Fill" = applyPreset(draft, 'balanced', onlyUnset = true)
  ─▶ authorization          wallet EIP-712 (V1 approval or V2 principal) or AUTHORIZE MANDATE V<n>
  ─▶ LiveSession.run()      session.ts
       discover()           discovery.ts: per agent, concurrently
         candidate discovery   DOMAIN_AGENTS[role].candidates (labelled fixtures)
         actionable eligibility agents/eligibility.ts (resolveCandidate + permits, static scope codes)
         execution capability   agents/capability.ts (settlement profile)
         model proposal         provider.decide over the executable candidates only
         screenProposal         mandate/verifier-adapter.ts screen() ─▶ BLOCKED | ADMISSIBLE | STALE
       assess(...)          room/negotiation.ts  ─▶ Fit { feasible, lines, agentExcess }
       if (!fit.feasible)   PORTFOLIO_CONFLICT ─▶ ROOM_OPENED ─▶ runLiveRoom (room/coordinator.ts)
       #authorizeFinal      freshly signed proposals ─▶ runPortfolio (frozen Room, verifier, ledger reservation)
  ─▶ settlement presentation  live-model.ts deriveSettlement + stage-outcome.tsx ReceiptStage / SettlementProof
```

### 1.1 The exact current Room trigger

`session.ts` (`run`, around line 628):

```ts
const fit = assess(participants, requests, av, demandAt);
if (!fit.feasible) { emit PORTFOLIO_CONFLICT; room = await runLiveRoom(...) }
```

`fit.feasible` is produced by `assess` in `room/negotiation.ts`. It is
`false` when **either**

1. a *portfolio* resource line is over its availability — the sum of every
   participant's typed demand on `portfolio-notional`, `derivative-notional`,
   `illiquid-notional`, `spot-capital` or `perp-margin` exceeds what the
   ledger says is left of the portfolio limit; **or**
2. any single participant's demand on any resource exceeds its *own*
   headroom (`agentExcess`: its hard maximum, or the portfolio limit where it
   lists none).

Both collapse into one boolean. Nothing distinguishes:

| | meaning | who can fix it |
| --- | --- | --- |
| **shared-resource excess** | several agents together ask more of one resource than the portfolio has | the agents, between them |
| **agent-local excess** | one agent asks more than its own ceiling, or is the only agent demanding a resource that is over | that agent alone |

### 1.2 How Room participants are selected

Every ADMISSIBLE outcome becomes a participant (`admissible.map(...)`),
whether or not it demands the resource in conflict. BLOCKED proposals are
excluded (correctly). There is no minimum participant count.

### 1.3 Why a single Perps excess opened the Room

Under the balanced preset the perps agent's own maximum (400) equals the
portfolio derivative limit (400), and its exposure is unlisted, so its
derivative headroom is the portfolio's. A perps request of 600 (or 250 against
150 of remaining derivative headroom after earlier reservations) makes the
`derivative-notional` line infeasible. Only perps demands derivative
notional — no other domain can — so the "conflict" has one party. With Stock,
Swap and Yield blocked at screening and NFT silent, the participants list is
`[perps]`, `!fit.feasible` is true, and `runLiveRoom` opens a Room in which
the perps agent negotiates with itself (`REDUCE 250 → 150`). In the
reproduction with the stub (seed 1) a perps derivative excess also made the
*Stock* agent reduce 600 → 400 in the Room, although Stock demands no
derivative notional — the stub's proportional share of the portfolio-notional
line, which was not even over.

### 1.4 How Compose represents capital

`PortfolioDraft.totalCapital`, `minUnallocated`, `maxDeployed` (→ the signed
`portfolio-notional` limit) and per agent `maxAllocation` (→ the agent's
signed `hardMaxima[portfolio-notional]`). There is **no per-agent budget**
distinct from the maximum, and no notion of who decides the split. The
compiled mandate is always `allocationMode: 'DYNAMIC'`: nothing preallocated,
every agent claims from one pool inside its maximum. The balanced preset's
agent maxima sum to 2,900 against 2,500 deployable — by design, so live
requests can collide.

Two consequences:

- "Fill" (`applyPreset(..., onlyUnset = true)`) sets every unset field,
  **including `agents.*.enabled`**. A prompt that named no agents ("Manage
  $2,000") therefore had all five agents enabled by a preset — agent
  selection, which is authority, granted by a fill button.
- A prompt's total is replaced by the preset when the local parser cannot
  read it: `"$2,000 across Stock, Swap, Yield and Perps"` has no
  deploy/invest verb, so `totalCapital` stays unset and Fill sets 2,500.

### 1.5 The web candidate path

The current local server path is `discover → deterministic eligibility →
actionable → capability → executable → model`. Reproduced through
`LiveLab.handle` (the exact HTTP handler the browser calls) with the stub at
seeds 0–2: every agent's `AGENT_CANDIDATES_EVALUATED` lists the look-alike
(`nvda-token-b`), the bad venue (`route-b`) and the unapproved fund
(`high-yield-usd`) as **excluded**, and the model is never offered them. The
only production override is `SessionOptions.eligibility` / `settlement:
null`, which `LiveLab` never passes.

So the screen the owner saw (Stock BLOCKED on the synthetic token, Swap on
the bad venue, Yield on the bad market) is what a server **started before
`444444d`** produces: the browser talked to a long-running `agents:serve` /
`agents:lab` process from older code. Nothing in the browser can tell. Fix:
the server advertises its candidate pipeline in `GET /api/live/status`
(`candidatePipeline`), and the page refuses to start a run against a server
that does not, with a "restart the local server" notice. Security / Policy
Stress continues to submit forbidden candidates directly.

### 1.6 Why a BLOCKED Stock could appear as "Trade decision"

`stage-outcome.tsx` `SettlementProof` renders

```tsx
<p className="mw-proof__main">{stock.candidate !== "—" ? stock.candidate : "Stock"}</p>
```

`stock.candidate` is the **model-selected** candidate from
`AGENT_DECISION_COMPLETED`, whatever Mandate decided. `SettleActions` then
offers "Dry-run testnet settlement" whenever the server advertises
settlement and no settlement has started — again regardless of whether a
Stock reservation exists. The receipt is shown after any
`PORTFOLIO_AUTHORIZED` (another agent's reservation is enough). Settlement
itself refuses without a reservation (`NO_STOCK_RESERVATION`), so nothing
unsafe could happen, but the UI implied authority that did not exist.

Fix: the settlement panel is derived only from the authorized, **reserved**
Stock action (`PORTFOLIO_AUTHORIZED.data.proposals[role=stock].outcome ===
'RESERVED'`, plus the reservation list the server returns). No Stock
reservation → "No authorized Stock trade", no dry-run or send control.

---

## 2. Why the old semantics are wrong

`!fit.feasible → ROOM_OPENED` treats every resource-limit violation as a
negotiation. A negotiation needs at least two parties competing for the same
thing, and a principal who left them that discretion. The old trigger opened
a Room with one party, with parties who demand none of the resource in
conflict, and with no regard for whether the principal had already decided
the split. Room V2 opens only for a reason the principal gave it.

---

## 3. Product model

**Human defines authority. Agents may decide allocation only inside
authority, and only when the human explicitly delegates that discretion.**

The Room has zero authority. It never enables an agent, raises total capital,
raises a per-agent maximum, raises derivative exposure, adds an asset, venue,
recipient or representation, repairs a security-invalid action, or turns a
forbidden action into an allowed one. Every Room output is a set of numbers
that re-enters the deterministic path: draft validation (before signing), or
`screen → runPortfolio verifier → ledger reservation` (after).

### 3.1 Allocation intent

Classified deterministically from the draft (`allocation/intent.ts`):

| intent | the draft says | Room |
| --- | --- | --- |
| `NEEDS_AGENT_SELECTION` | some agent's `enabled` is unset | none: the principal is asked "Which agents may use this capital?" |
| `FIXED` | every enabled agent has a budget the principal set | none |
| `DYNAMIC` | enabled agents, total capital, no budgets | Planning Room (`INITIAL_ALLOCATION`) |
| `HYBRID` | some budgets set by the principal, others not | Planning Room (`HYBRID_ALLOCATION`) over the remainder only |

"Set by the principal" means a budget whose provenance is `INTERPRETED` (from
the prompt) or `USER` (typed). A budget the Planning Room proposed and the
principal accepted has provenance `PLANNED`. Editing a planned budget makes it
`USER`: the human decision wins, without another Room.

Agent selection is authority. The interpreter enables only agents the
principal named; Fill never sets `agents.*.enabled` or `autoReallocate`; the
UI asks with explicit buttons, including "All approved agents".

### 3.2 Budget semantics

`agents.<role>.budget` is the **maximum capital available to this agent** in
this plan — never an obligation. An agent with a budget of 800 may use 700,
400 or nothing. Unused budget stays in the wallet; it is never called a
refund (nothing was taken).

### 3.3 What is signed

`portfolio.autoReallocate` (the brief's `allowAutomaticReallocation`) is
`false` unless the principal turns it on. It changes what the signed mandate
says, so its effect is enforced by the frozen verifier, not by trust:

| `autoReallocate` | signed `hardMaxima[portfolio-notional]` per agent | meaning |
| --- | --- | --- |
| `false` (default) | the agent's **budget** | the split is the authority. No agent can exceed its budget; nothing can be reassigned. |
| `true` | the agent's **ceiling** (`maxAllocation`) | the principal signs an envelope. Budgets are the starting plan; released capital may move between agents up to each signed ceiling and the signed total. |

The portfolio-notional limit is the deployable total either way. Derivative
and illiquid caps are signed as before. The compiled mandate stays
`allocationMode: 'DYNAMIC'` (the frozen HYBRID mode lets the protocol Room
claim the unallocated remainder automatically, which would not express the
plan).

With `autoReallocate = true` and no budgets at all (an explicit preset), the
agents coordinate live inside the signed maxima: that is the only mode in
which an operational shared-resource Room can open on the first run.

### 3.4 Validation (before signing)

Deterministic, in `draft-validator.ts`, immediately on every edit:

- budgets of disabled agents → `ALLOCATION_AGENT_DISABLED`;
- Σ budgets > deployable total → `ALLOCATION_EXCEEDS_TOTAL`;
- a budget above the agent's ceiling (when one is set) or its own exposure
  cap → `ALLOCATION_EXCEEDS_AGENT_MAX`;
- a perps budget above the derivative cap, an NFT budget above the illiquid
  cap → `ALLOCATION_EXCEEDS_DOMAIN_CAP`;
- malformed amounts → `INVALID_VALUE`;
- `DYNAMIC`/`HYBRID` with `autoReallocate = false` and a delegated agent with
  no budget → `ALLOCATION_PLAN_REQUIRED` (the split is what will be signed).

---

## 4. Trust boundaries

| component | may | may not |
| --- | --- | --- |
| principal | enable agents, set total, budgets, ceilings, auto-reallocation; edit any plan | — |
| interpreter (model or local parser) | suggest draft fields, flag issues | enable an agent not named, set auto-reallocation without the words, sign |
| domain agent model | return an OpportunityCard or a proposal over offered candidate ids | name an address, venue, amount outside bounds, raise a limit |
| Jev (TypeSafe Score) | return a bounded score for one card | become dollars, authorize, override a cap |
| deterministic allocator | turn validated cards and scores into budgets inside caps | exceed pool, caps, useful capacity; allocate to an abstainer |
| Planning Room | propose budgets for the principal to review | sign, enable, edit fixed budgets |
| Operational / Reallocation Room | propose sizes for re-verification | reserve, change candidate identity, venue, recipient, representation |
| frozen Mandate path | decide | — |

Market data in this lab is `FIXTURE`. Model inference is `LIVE_MODEL` only
when a real model ran. Jev is `LIVE_JEV` only when TypeSafe answered.
Settlement is `LIVE_TESTNET` only with a confirmed receipt. `LIVE_MODEL`
never implies live prices.

---

## 5. Planning flow (pre-authorization)

```text
"$2,000 across Stock, Swap, Yield and Perps. Prefer balanced risk-adjusted opportunities."
   ─▶ deterministic interpretation: total 2,000; enabled stock, swap, yield, perps; nft disabled; no budgets
   ─▶ intent DYNAMIC, pool 2,000 over 4 agents
   ─▶ POST /sessions/:id/plan   (no signature, no ledger write)
        provisional mandate: the draft compiled with each pool agent at its ceiling (advisory only)
        per pool agent, concurrently:
          discovered ─▶ actionable ─▶ executable  (the same deterministic filters as a run)
          model: OPPORTUNITY request ─▶ OpportunityCard (PROPOSE | ABSTAIN), strictly parsed
          Jev Score (optional, advisory) ─▶ validated score or UNAVAILABLE
        deterministic allocator ─▶ budgets, leftover unallocated
        events: ROOM_OPENED{roomPurpose: INITIAL_ALLOCATION} … ALLOCATION_PLAN_PROPOSED … ROOM_FINALIZED
   ─▶ UI: "Agents propose this split" [Edit allocation] [Use this plan]
   ─▶ POST /draft/allocation {budgets}  (validated; provenance PLANNED, or USER where edited)
   ─▶ review ─▶ ONE wallet signature over the final budgets
```

The plan is advisory. Using it writes draft fields; only the signature
authorizes. A plan built against a draft that has since changed (or whose
cards are past `freshUntil`) is refused when applied: `PLAN_STALE`.

A pool of one agent needs no Room: its card alone sets its budget
(`min(pool, maximumUseful, ceiling)`, or 0 on ABSTAIN).

### 5.1 OpportunityCard

```ts
interface OpportunityCard {
  role: Role;
  candidateId: string | null;        // an offered executable candidate id, or null
  action: 'PROPOSE' | 'ABSTAIN';
  requestedAtoms: bigint;            // 0 on ABSTAIN
  minimumUsefulAtoms: bigint;        // ≥ candidate minimum
  maximumUsefulAtoms: bigint;        // ≤ candidate maximum and the agent's ceiling
  metrics: {                         // ordinal 0–4, judged from the supplied facts
    opportunityQuality, liquidity, executionQuality, downsideRisk, dataConfidence
  };
  marketRegime: 'CONSTRUCTIVE' | 'NEUTRAL' | 'STRESSED' | 'UNKNOWN';
  rationale: string;                 // declared, short; never chain-of-thought
  observedAt: bigint;                // protocol time the candidate facts were observed
  freshUntil: bigint;                // observedAt + the mandate's quote-age bound
  evidence: { kind: 'FIXTURE_MARKET' | 'LIVE_MODEL' | 'STUB' | 'SCRIPTED'; source: string }[];
  modelEvidence, marketEvidence      // as on every live event
}
```

The model supplies only the candidate id, the three amounts (bounded by the
candidate and checked), five ordinals, a regime word and a rationale. Every
other field is set by trusted code. Metrics that the fixture facts cannot
support are reported by the model as `dataConfidence` 0–1; the allocator
gives a card with `dataConfidence = 0` no capital.

### 5.2 Domain evidence

| domain | evidence the card is built from (this lab) | not available, so never claimed |
| --- | --- | --- |
| Stock | fixture price, gate fee, all-in cost, redemption terms, max order depth | fundamentals, news, sentiment, technicals (→ `MarketResearchProvider`, §9) |
| Swap | fixture quote, expected output, fee tier, slippage bound, route | live depth, volatility |
| Yield | advertised APY, capacity, issuer, withdrawal terms | protocol risk feeds |
| Perps | price, leverage, margin, funding (fixture) | open interest, basis |
| NFT | floor/listing facts in the fixture | any market intelligence |

### 5.3 Point-in-time integrity

Every card records `observedAt` and `freshUntil`. The allocator refuses to
compare cards whose observation windows do not overlap
(`PLAN_OBSERVATIONS_INCOHERENT`): a stale Stock card is never weighed against
a fresh Perps card. A card past `freshUntil` when the plan is applied fails
closed (`PLAN_STALE`); the principal re-plans.

---

## 6. Jev — advisory scoring

`@mandate/jev` gains the TypeSafe **Score** primitive (the current
primitive; the routing integration's Choice semantics are untouched). One
question per card, levels 0–4:

> How strongly does the evidence in `card` support allocating incremental
> capital to this opportunity under the principal's stated objective
> `objective`?

State is a whitelisted projection of the card (role, candidate title, the
offered facts, metrics, regime, amounts as decimal text) and the principal's
intent. No address, key or identifier that means anything outside the
process.

- The answer is parsed strictly: `type: 'score'`, finite `score` within
  `[0, 4]`, finite `confidence` within `[0, 1]`, probabilities over exactly
  the five levels. Anything else → `UNAVAILABLE{reason}`.
- No key → `UNAVAILABLE{MISSING_CREDENTIAL}`; no score is fabricated.
- A valid score becomes an integer `jevBps` (0–10,000) and only scales a
  card's weight between 0.5× and 1.5× (§7). It cannot make an abstaining
  card positive, lift a cap, or move a dollar outside the allocator.
- The live-agents source holds only the `OpportunityScorer` interface; the
  TypeSafe client is attached by the server scripts (the composition root).
  The key is read by `@mandate/jev` only and never printed.

---

## 7. Deterministic allocator

`allocation/allocator.ts`, pure, bigint, no clock, no randomness.

```text
input   pool atoms; per agent: card, optional jevBps, hardCap (ceiling, domain cap, candidate depth)
weight  0 if ABSTAIN, dataConfidence = 0, or modelUtility < MIN_UTILITY
        modelUtility = opportunityQuality + liquidity + executionQuality + (4 − downsideRisk) + dataConfidence   (0–20)
        weight = modelUtility × (jevBps === null ? 10,000 : 5,000 + jevBps / 2)
cap_i   min(maximumUseful_i, hardCap_i), whole USDC
loop    share_i = floor(remaining × w_i / Σw) over the active set, in role order
        any share ≥ cap → fix it at cap, remove, redistribute the rest       (water-filling)
        any share < minimumUseful → drop the lowest-weight such agent (ties: later role order), restart
result  budgets (whole USDC, rounded down); leftover = pool − Σ budgets stays unallocated
```

Input order cannot change the result (agents are processed in canonical role
order and ties break on role order). Identical inputs give identical output.
Leftover is never forced into a weak card.

---

## 8. Post-authorization semantics

### 8.1 Classification after screening

`room/classify.ts` replaces `!fit.feasible`:

| class | condition | handling |
| --- | --- | --- |
| `HARD_POLICY_FAILURE` | screening BLOCKED it | blocked; never counted, never in a Room |
| `VALID_AND_FITS` | `fit.feasible` | direct to the verifier |
| `AGENT_LOCAL_EXCESS` | the agent exceeds its own headroom, **or** it is the only demander of an over-limit resource | one bounded local re-plan, then re-screen; still invalid → REFUSED (no Room) |
| `SHARED_CONFLICT` | ≥ 2 admissible agents demand the same over-limit resource | `autoReallocate` (coordination authorized): operational Room `SHARED_RESOURCE_COORDINATION`; otherwise submitted as-is and the frozen verifier refuses deterministically |

The local re-plan offers the agent its own candidate bounded to the largest
size whose typed demand fits its own headroom (found by exact search over
the binding's demand function), with a `localConstraint` in the request.
The agent may REDUCE (propose again) or ABSTAIN. There is no Room, no
"shared authority conflict" text and no other participant.

### 8.2 Budgets bound every run

Each agent is offered its candidates bounded to its budget (`maxAtoms =
min(candidate max, budget)`); a candidate whose minimum exceeds the budget is
not offered. With `autoReallocate = false` the signed maximum enforces the
same bound independently.

### 8.3 Reallocation Room

Only with `autoReallocate = true`, after the first authorization:

```text
released  = Σ budget of agents that reserved nothing (ABSTAINED, BLOCKED, refused, timed out)
available = the ledger's current portfolio-notional availability   (excludes RESERVED / SUBMITTED / SETTLED)
pool      = min(released, available)
recipients: agents holding a reservation, below their signed ceiling, with remaining candidate depth
  ─▶ fresh OpportunityCard each, bounded to min(ceiling − reserved, ledger headroom, depth)
  ─▶ Jev (optional) ─▶ allocator ─▶ increments
  ─▶ new signed proposals ─▶ screen ─▶ runPortfolio verifier ─▶ ledger reservation   (phase REALLOCATION)
remainder stays unallocated, in the wallet
```

Capital is counted as available only from the ledger: a reservation that is
RESERVED, SUBMITTED or SETTLED is not available, and a reservation that could
be released is available only after the durable lifecycle released it. With
`autoReallocate = false` the unused budgets are reported (`CAPITAL_UNUSED`)
and nothing else happens.

### 8.4 Room purposes and copy

Every Room event carries `roomPurpose`:

| purpose | copy |
| --- | --- |
| `INITIAL_ALLOCATION` | Agents are proposing how to allocate your capital. |
| `HYBRID_ALLOCATION` | Agents are proposing how to allocate the capital you left to them. |
| `REALLOCATION` | Agents are deciding how released capital should be reassigned. |
| `SHARED_RESOURCE_COORDINATION` | Valid proposals are competing for shared authority. |

### 8.5 Room may open only for

A. planning (`DYNAMIC`); B. hybrid planning; C. reallocation of
ledger-released capital with `autoReallocate`; D. a shared conflict between
≥ 2 valid agents with `autoReallocate`. Never for a single agent's excess, an
invalid asset, issuer, representation, venue, recipient or leverage, an
expired or absent authority, a malformed proposal or an invalid signature.

---

## 9. Market research architecture (TradingAgents reference)

[TradingAgents](https://github.com/TauricResearch/TradingAgents) (Apache-2.0;
Xiao et al., arXiv:2412.20138) was studied as an architectural reference. No
code was copied. Patterns adopted:

| TradingAgents | Mandate Room V2 |
| --- | --- |
| parallel specialist analysts | every pool agent analyzes concurrently, each with domain evidence only |
| bull / bear challenge, risk viewpoints | the card's separate `opportunityQuality` and `downsideRisk`, and Jev's independent score |
| trader synthesis | the agent's own card (one candidate, useful size range) |
| portfolio manager with holdings and cash | the deterministic allocator over the pool, ledger availability and signed caps |
| point-in-time data; withheld when unavailable | `observedAt` / `freshUntil`; `DATA_UNAVAILABLE` evidence or ABSTAIN instead of invented analysis |

`MarketResearchProvider` (`allocation/research.ts`) is the seam: given a
role and the offered candidates at a time, it returns evidence items with a
source, an observation time and an evidence class. The shipped provider
returns the labelled fixture facts as `FIXTURE` evidence and, for every
research kind it cannot supply (fundamentals, news, sentiment), an explicit
`DATA_UNAVAILABLE` item. A live adapter (TradingAgents-style analysts over
EDGAR, market data and news) is the next intelligence phase; it is not built
here.

---

## 10. Failure modes

| failure | behaviour |
| --- | --- |
| model times out / invalid card in planning | that agent's card is `ABSTAIN` (`runtime: TIMED_OUT …`); budget 0; plan still proposed |
| every agent abstains | plan proposes 0 for all; the whole pool stays unallocated |
| Jev unavailable / malformed | `UNAVAILABLE{reason}`; allocator uses the model utility alone |
| draft changed after planning | applying the plan is refused (`PLAN_STALE`); re-plan |
| local re-plan still over | the agent is REFUSED; others proceed |
| shared conflict, no coordination authority | submitted as-is; the verifier refuses what does not fit |
| reallocation pool 0 or no recipient | `REALLOCATION_SKIPPED`; capital stays unallocated |
| mandate superseded mid-run | unchanged from before: epoch aborted, proposals marked REAUTHORIZE_REQUIRED |

---

## 11. Evidence classes

`FIXTURE` (market and candidate data), `LIVE_MARKET_DATA` (never claimed in
this milestone), `LIVE_MODEL` / `STUB` / `SCRIPTED` (inference), `LIVE_JEV`
(only when TypeSafe answered), `JEV_UNAVAILABLE`, `LIVE_TESTNET` (a confirmed
receipt only), `DATA_UNAVAILABLE` (a research kind that was not available).

---

## 12. Future work

- A live `MarketResearchProvider` (Stock fundamentals/news/sentiment with
  point-in-time correctness), and live quote adapters for Swap/Yield/Perps.
- Market re-plan before execution: when a card or quote passes
  `freshUntil`, a fresh card and, with `autoReallocate`, a revised plan.
- Releasing a RESERVED-but-unsubmitted reservation through the ledger
  lifecycle so it becomes reallocatable before its deadline.
- Expressing the plan in the signed protocol object itself (a future
  allocation mode whose preferred allocation is a bound, not a precedence).

---

## 13. As built (2026-10-02)

| concern | module |
| --- | --- |
| intent, planning state | `packages/live-agents/src/allocation/intent.ts` |
| budgets, `autoReallocate`, what is signed | `authoring/draft-types.ts`, `authoring/draft-validator.ts` (`ALLOCATION_*` codes) |
| interpreter (budgets, "$X across …", reallocation words; never enables an unnamed agent) | `authoring/prompt-to-draft.ts`, `runtime/prompts.ts` |
| OpportunityCard, research seam | `allocation/card.ts`, `allocation/research.ts`, `runtime/schemas.ts` (`OPPORTUNITY`) |
| allocator | `allocation/allocator.ts` |
| Planning Room | `allocation/planning.ts`, `LiveSession.plan` / `applyPlan`, `POST /plan`, `POST /draft/allocation` |
| never-signed planning compilation | `MandateVersions.provisional` |
| post-screen classification, local re-plan | `room/classify.ts`, `LiveSession.#localReplans` |
| coordination Room | `room/coordinator.ts` (`roomPurpose`, `askable`) |
| reallocation | `LiveSession.#afterAuthorization` |
| Jev Score | `packages/jev/src/score.ts`; interface `live-agents/src/jev/scorer.ts`; attached in `live-agents/scripts/jev.ts` |
| browser | `apps/web/components/demo/live/allocation-model.ts`, `stage-planning.tsx`, the `PLANNING` phase |

Event kinds added to `MANDATE_LIVE_AI.V1`: `OPPORTUNITY_CARD_CREATED`,
`JEV_SCORE_RECORDED`, `ALLOCATION_PLAN_PROPOSED`, `ALLOCATION_PLAN_APPLIED`,
`AGENT_LOCAL_REPLAN_REQUESTED`, `AGENT_LOCAL_REFUSED`, `CAPITAL_UNUSED`,
`REALLOCATION_SKIPPED`. `ROOM_OPENED`, `ROOM_PROPOSAL_CREATED` and
`ROOM_FINALIZED` carry `roomPurpose`; `PORTFOLIO_CONFLICT` carries
`classification`, `handling` and `roomPurpose`.

Decisions worth reviewing:

- **Explicit presets** set `autoReallocate = true` and no budgets: they are
  a live-coordination envelope (`planning: OPTIONAL`), which keeps the
  operational Room reachable for a real capital conflict among several
  agents. A prompt's Fill never sets `autoReallocate` or `enabled`.
- **The plan is not in the signed protocol object** beyond what it changes
  there: without reallocation, the budgets *are* the signed maxima; with it,
  the ceilings are, and the budgets are the session's plan (persisted with
  the version's draft). The frozen HYBRID mode was not used because its
  Room claims the unallocated remainder automatically.
- **Sole demander = local.** A portfolio limit only one agent's request
  uses (derivative for perps, illiquid for NFT) is treated like that
  agent's own limit.
- **Reallocation recipients** are agents that already hold a reservation;
  they are asked for a fresh card over their own candidate, bounded by its
  remaining depth (as discovered, not as budget-bounded), their signed
  ceiling and every typed limit.

## 14. Live validation (gpt-5.5, 2026-10-02, no broadcast)

Run from a scratch script outside the repository, against the real OpenAI
interpreter and agents; the key came from the gitignored `.env` and was
never printed. `TYPESAFE_API_KEY` was not configured: every Jev result was
`UNAVAILABLE (JEV_NOT_CONFIGURED)` and no score was invented. Market data
was `FIXTURE` throughout; inference was `LIVE_MODEL`. Interpreter notes
("balanced risk-adjusted" is not a mandate term) were marked resolved, as
the principal does in the UI. Authorization used the demonstration
principal key (no wallet). `live-agents` has no chain path: every run
reported 0 transactions.

| prompt | intent | Room | result |
| --- | --- | --- | --- |
| A. "$2,000 across Stock, Swap, Yield and Perps. Prefer balanced risk-adjusted opportunities." | DYNAMIC | `INITIAL_ALLOCATION` | cards: Stock note C 100–600, Swap route C 100–250, Yield beta 100–400, Perps **ABSTAIN** (fixture-only, no open-interest evidence). Plan: Stock 600, Swap 250, Yield 400, Perps 0; **750 kept in wallet**. "Stock, Swap and Yield each received the most they said they can usefully take." Applied: valid. |
| B. "$2,000. Stock $800, Swap $400, Yield $500, Perps $300." | FIXED | none | `NOTHING_TO_PLAN`; valid; signed maxima = the budgets |
| C. "$2,000 across approved agents." | NEEDS_AGENT_SELECTION | none | every agent unset; "Choose which agents may use this capital first." |
| D. "Deploy $2,000 across … rebalance automatically if an agent passes." | DYNAMIC (reallocation allowed) | `INITIAL_ALLOCATION` | Perps abstained in planning (budget 0). Signed and run: 1,648.50 reserved (stock note C 598.50 after its fee, swap 250, yield 800); nothing released, so `REALLOCATION_SKIPPED (NOTHING_RELEASED)`. |
| D3. "$2,000. Stock $700, Swap $250, Yield $450, Perps $300. Very low risk … Rebalance automatically if an agent passes." | FIXED (reallocation allowed) | `REALLOCATION` | the interpreter read "no leveraged position" into the leverage bound, so perps had no actionable candidate and reserved nothing; its 300 entered a Reallocation Room. Only Stock had remaining depth; its live card **abstained** (fixture-only evidence). Nothing reassigned; 350 stays in the wallet (`CAPITAL_UNUSED`). |

Two defects were found by these runs and fixed (`13adbb8`): a plan with an
abstaining agent could not be signed (a warning treated as fatal), and
Fill set a maximum deployed above the stated capital.

## 15. Limitations

- All market and candidate data is labelled fixture data; no live market
  research adapter exists (`DATA_UNAVAILABLE` for fundamentals, news,
  sentiment, technicals, volatility, protocol risk, open interest, NFT
  market intelligence).
- Jev Score was exercised offline only (injected transport); no live
  TypeSafe call was made in this milestone.
- Plans are held in memory per session; a restored session re-plans.
- Releasing a RESERVED-but-unsubmitted reservation early, and market
  re-planning on staleness before execution, are not built (§12).
