# Mandate — Live AI Lab

> **Status: buildathon Milestone B.5 runtime and B.6.2 product workspace,
> implemented locally, awaiting review.**
> Milestone B.6.2 is the `/demo/live` product client only. It reads the
> existing session API and `MANDATE_LIVE_AI.V1` events. It does not
> authorize, does not send transactions, and does not import
> `packages/live-settlement`.
> A second demo mode beside Protocol Replay. Model-backed agents act
> autonomously under a Portfolio Mandate the principal authors live; the
> frozen Phase 7F Portfolio Mandate decides what may settle. Additive only:
> `packages/live-agents` and a `/demo/live` route. Nothing frozen changes —
> not `contracts/`, `kernel`, `core`, `ledger`, `control`, `registry`,
> `ledger-sqlite`, `execution-gate`, `evm-robinhood`, `perp-lighter`,
> `packages/portfolio`, `packages/judge-demo`, any corpus, the Phase 7E
> evidence or `MANDATE_JUDGE_DEMO.V1`. No transaction is sent; nothing is
> deployed. The one explicit Robinhood Chain testnet settlement path for a
> reserved Stock decision (B.5.2) is a separate package and separate
> commands: [live-testnet-settlement.md](live-testnet-settlement.md).

```text
Humans define authority.  Agents operate autonomously.  Mandate decides what may settle.

Different reasoning.  Different negotiation.  Same authority boundary.

VALID AGENT != VALID ACTION
```

## 0. B.6.2 product workspace

`/demo/live` is one adaptive workspace, not a stepper. One main panel
changes shape as the transaction progresses:

```text
prompt ─▶ building the mandate ─▶ agent team ─▶ review and sign
  ─▶ agents working ─▶ Mandate review ─▶ Mandate Room ─▶ re-verifying
  ─▶ authorized ─▶ executing (when a settlement path reports) ─▶ receipt
```

The phase is presentation state (`components/demo/live/live-flow.ts`).
Before a mandate is active it follows the principal's own interaction; after,
it follows only the run's `MANDATE_LIVE_AI.V1` events and the server's task
status. It never decides authority, never advances on a timer, and never
shows an outcome before the event that carries it. Completed steps collapse
into a small trail; details open in side sheets: advanced permissions (every
draft control, grouped Capital, Risk, Markets, Execution and Agent limits,
with provenance), the trade review (Summary, Decisions, Evidence, every count
derived from the run), the Room conversation, the security demo (policy
stress, after the trade), the event log and pause.

The Room is a chat built from real Room events only: each
`ROOM_AGENT_RESPONSE` is one message (`Keep $800.`, `Reduce $600 → $400.`,
`Release $500.`, `Abstain.`) with the agent's declared rationale verbatim;
timeouts say no allocation changed; late and stale replies are shown struck
through and marked ignored; open requests show as pending replies until they
answer or time out. Nothing is generated client-side and no hidden reasoning
is read. The Room header states `AUTHORITY NONE`, and a Room proposal is
labelled not authorized until `PORTFOLIO_AUTHORIZED`.

A Mandate refusal reads words first. The verdict line is the most specific
reason, such as `Synthetic representation not approved`, or `This
opportunity is outside the approved market set.` when several market-set
checks fail at once. Each distinct reason follows in words. The exact
protocol codes sit under *Technical details*, one element per code,
deduplicated in emitted order. A registry code keeps its component
(`REGISTRY:ISSUER_NOT_ALLOWED`) and drops only its subject. The labels are
web-only; protocol codes are unchanged. The review's Evidence tab lists, per
agent, the discovered candidates: which were actionable and which stayed
discovery only, and why (§4).

The equal-timestamp grouping of B.6.1 is unchanged. The landing hero uses
React Bits Pattern Waves (Silk preset, `#6366F1` on `#120F17`), loaded on the
client only, paused offscreen and static under reduced motion. The Prompt Bar
and Lattice Loader remain the React Bits adaptations at source commit
`e1bbb696fc53f7f91e694c529e4d68c899773b6e`; the Prompt Bar gains a light
composer tone and the upstream glyph squash and tilt.

### Principal signing: what exists and what does not

**B.5.3 wired the wallet** ([wallet-settlement-boundaries.md](wallet-settlement-boundaries.md)).
The review step's *Approve in wallet* is real; the demo key stays as a
labelled fallback.

| | Wallet path | Demo principal key (fallback) |
| --- | --- | --- |
| What authorizes a version | the page sends `spine: "V2"`. The wallet signs EIP-712 `PortfolioMandateAuthorizationV2` over the exact mandate digest and canonical accepted initial-allocation digest, for this session and chain 46630; the server rebuilds and verifies it (`POST …/wallet/challenge`, `POST …/wallet/authorize`). Omitting `spine` on the API is still the B.5.3 `PortfolioMandateApproval` | `POST …/authorize` with the exact text `AUTHORIZE MANDATE V<n>` |
| Principal identity | the recovered wallet address, and on V2 that address is the protocol principal | the demonstration key's address |
| Signature the frozen Portfolio Verifier checks | current V2: the wallet's plan-bound `PortfolioMandateAuthorizationV2` signature, checked again by `reverifySpine` at settlement. Legacy V2 remains explicitly versioned and readable. B.5.3 (spine omitted): the demonstration key's prehash, made only after the wallet approval verified | the demonstration key's prehash |
| Browser wallet calls | `eth_requestAccounts`, `eth_accounts`, `eth_chainId`, `wallet_switchEthereumChain`, `wallet_addEthereumChain`, `eth_signTypedData_v4` — never a transaction | none |
| Domain execution | V2: a wallet that is not the manifest principal signs `MandateAuthorization` once per execution; the deployer pays gas and broadcasts. The portfolio signature is not that signature. B.5.3 does not delegate, and that version never sends | not delegated |

The UI says *wallet-signed mandate*, never that the wallet delegated
execution authority onchain. Copy before signing: "Your wallet will sign
this Mandate. This does not submit a blockchain transaction." No gas is
shown for signing.

Sessions are durable (`.live/`, §4 of the boundaries document): a reload
or a server restart returns to the same session (`?session=lab-…`) and
replays its events. The structured Planning Room proposal, principal edits,
accepted allocation and commitment are stored in the same session database;
restore never calls a model to recreate them. Expired unsigned proposals are
shown as `PLAN_STALE`. Successful post-sign reallocations append durable
previous/next-digest lineage from the immutable initial commitment. Settlement events now reach the browser session they
belong to: the operator runs `npm run agents:settle:testnet -- --session
<id>`, whose events land in that session's log. In B.5.3 that command is a
dry run ending at *Ready for testnet send · nothing was sent*.

V2 ([authority-spine-v2.md](authority-spine-v2.md)) is what **Approve in
wallet** asks for: `POST …/wallet/challenge` with `{ "address", "spine": "V2" }`.
The wallet becomes the protocol principal. After the run, the receipt can
dry-run and send through `POST …/settle` when the server is
`npm run agents:lab`. That is the same `settleSpine` and the same re-verify
as `npm run agents:settle:v2`. The wallet signs typed data only. The deployer
pays gas and broadcasts. The demo principal key remains a labelled fallback
and cannot settle on V2. `npm run agents:serve` does not settle. B.5.2 and
B.5.3 are unchanged.

## 1. The trust model in one table

| Component | May | May never |
| --- | --- | --- |
| Principal (the user) | author a draft; review it; **explicitly** authorize a version; author and authorize an amendment | edit a live Room allocation; speak for an agent |
| Draft interpreter (a model) | map a prompt onto known fields; suggest values; flag ambiguity and conflict | sign; activate; widen; invent an asset, issuer, venue, recipient or address; fill a missing value with a permissive default |
| Domain agent (a model) | read a closed set of **actionable** candidates, its own authority and bounded portfolio context; choose a candidate id and an amount inside supplied bounds; abstain; negotiate KEEP / REDUCE / RELEASE / ABSTAIN | name an address, venue, recipient, calldata or contract; call a tool; read a key, file, environment variable or URL; sign; write the ledger or the mandate |
| Candidate eligibility (trusted local code, advisory) | decide which discovered candidates a model is offered, from the active mandate through the domain bindings and `permits` (§4) | authorize, reserve, replace a model's choice, or stand in for Mandate's screening |
| Policy-stress agent (a model, under the swap agent's identity) | select one preconstructed test-case identifier from a closed list; see the high-level result; select another, up to a bound | anything a domain agent may never do; supply any value (address, amount, venue, calldata, chain, signature); any capability at all beyond choosing an identifier |
| JEV advisor (optional) | rank candidate ids already in the set | authorize, sign, reserve, add or alter a candidate, widen |
| Trusted local code | look up the chosen id in its own table; build the exact candidate; sign it with the agent's local key; hand it to Mandate | decide whether an action is permitted |
| Mandate (frozen Phase 7F code) | screen, run the Room, re-verify, reserve through the ledger | — |

**AI never authorizes.** Every model output is a *request*, validated
against a strict local schema, resolved by exact lookup into a local table,
and then decided by the unchanged Portfolio Mandate path.

## 2. Authoring: a prompt is never authority

```text
prompt ─▶ interpreter (model or local parser) ─▶ DRAFT ─▶ deterministic validation
      ─▶ canonical guardrails (what will be enforced) ─▶ USER REVIEW
      ─▶ explicit "AUTHORIZE MANDATE V<n>" ─▶ principal signature ─▶ ACTIVE VERSION
```

- The draft is plain data. No code path turns a draft into a signed mandate
  except `MandateVersions.authorize(draft, confirmation)`, which refuses
  unless `confirmation` is exactly `AUTHORIZE MANDATE V<n>` for the next
  version and the draft validates with no blocking issue.
- A value the prompt does not state stays **unset** and blocks
  authorization. The user fills it or explicitly applies a preset to unset
  fields.
- Ambiguous (`"safe stocks"`), contradictory (`"deploy everything but keep
  $500 free"`) and unsupported instructions become **unresolved issues**,
  never guesses.
- The interpreter can only name members of the reviewed catalog (enums in
  its schema, re-checked locally); anything else is dropped as
  `UNSUPPORTED`.
- Validation runs the real protocol checks — `validatePortfolioMandate`,
  `checkPortfolioMandate` (e.g. `CHILD_WIDENS_RESOURCE_LIMIT` when an agent's
  derivative exposure exceeds the portfolio's) and `compilePortfolio` — in
  addition to the draft's own conflict rules. **CHILD AUTHORITY ⊆ PARENT
  PORTFOLIO AUTHORITY** is the protocol's rule, not the lab's.
- **The principal signature is a demonstration key.** It is the Phase 7F
  demonstration principal key, derived from a public label, held by the local
  server. It is not a wallet signature and secures nothing; the UI says so.

### Guardrails and the Mandate terms behind them

| Level | Guardrail | Mandate term |
| --- | --- | --- |
| Portfolio | total capital, minimum unallocated, maximum deployed | `portfolio-notional` limit = min(maximum deployed, total − minimum unallocated). Total capital itself is not a Mandate term |
| Portfolio | maximum derivative exposure | `derivative-notional` limit (and `perp-margin`, derived equal) |
| Portfolio | maximum illiquid exposure | `illiquid-notional` limit |
| Portfolio | validity period | mandate `expiresAt` |
| Agent | enabled | an agent entry with a delegation; **disabled = no entry = no authority** |
| Agent | maximum allocation | the agent's `portfolio-notional` hard maximum |
| Agent | exposure (stock spot, NFT illiquid, perps derivative) | the agent's hard maximum in that resource; unset = bounded by the portfolio limit alone (Phase 7F decision 1) |
| Market | approved assets, issuers, representations, venues, chains | the scope sets — a subset of the reviewed catalog, intersected into every agent's scope |
| Market | synthetic exposure, leverage, slippage, quote freshness | `syntheticPolicy`, `maxLeverage`, `maxSlippageBps`, `maxQuoteAgeSeconds` — never above the reviewed bound |
| Execution | allowed recipients | `recipients` |
| Execution | maximum spend, minimum receive, deadline, adapter/venue identity, replay | enforced by existing terms (hard maximum; slippage bound over `minOut`; child window ending at quote expiry; compiled `MODULES`/`ADAPTERS`/`VENUES`; one signed proposal = one Core action). Shown, not separately editable: there is no separate Mandate term for them |

The reviewed catalog is the upper bound: the lab lets the principal narrow
it, never extend it, because the domain bindings only recognise reviewed
instruments. It is the Live Lab market set V2's scope (§4): the Phase 7F
demonstration scope plus the reviewed Series C note, the second swap pool,
and the Beta vault with its issuer and protocol.

## 3. Versioning and optional human intervention

A signed version is never mutated. An amendment is a new draft, reviewed and
explicitly authorized as `V<n+1>`:

```text
V1 ACTIVE ─▶ draft amendment ─▶ review ─▶ "AUTHORIZE MANDATE V2" ─▶
   revoke V1's root in the ledger (Core REVOKE) ─▶ register V2 ─▶ V2 ACTIVE, V1 SUPERSEDED
```

Each record keeps its version, digest, `policyVersion`, signature, the
changed fields, activation time, and `supersedes` / `supersededBy`.

- **No grandfathering.** Every proposal binds its mandate's digest. A
  proposal created under V1 and screened under V2 is refused
  (`PORTFOLIO_MANDATE_DIGEST_MISMATCH`) and marked `REAUTHORIZE_REQUIRED`; a
  V1 child presented to Core after the revocation is refused by the ledger
  (`AUTHORITY_REVOKED`).
- **Human intervention changes authority, not the negotiation.** "Adjust
  Mandate" never edits a Room allocation. Activating V2 invalidates every
  in-flight proposal, finalizes the current Room generation as `SUPERSEDED`
  (late replies are ignored), and re-runs discovery under V2 through the
  normal rules.
- **Amendments stop at the first reservation.** Core has no settlement
  reconciliation (Phase 7F §7); reservations under a revoked root stay live
  and a new root would not see them. The lab therefore refuses an amendment
  once anything was reserved in the session, rather than double-counting
  authority.
- **Pause** revokes the active root without a successor: every later
  authorization is refused.

The default flow needs no human after authorization.

## 4. Agents and the candidate boundary

Five domain agents, each with an objective and a closed set of discovered
candidates built by trusted local code from the **Live Lab market set V2**
(`@mandate/portfolio/demo` `live-markets.ts`; labelled fixtures). V2 is the
Phase 7F demonstration markets plus one more reviewed, approved alternative
in stock, swap and yield. With only one approved instrument per domain, a
model offered the actionable set had nothing to compare. V2 gives it a
real economic choice among opportunities that can be authorized.
`markets.ts` and `mandate.ts` are untouched, so the judge demo and the
generated corpus keep the V1 world.

| Agent | Objective | Discovered candidates |
| --- | --- | --- |
| Stock | useful NVDA exposure | two approved backed notes; a cheaper same-ticker synthetic token from another issuer |
| Swap | best execution USDC→WETH | two routes through reviewed pools under the reviewed router; a router quoting 4.17 % more |
| NFT | an acceptable Genesis purchase, or abstain | a listing of the Genesis collection; a cheaper same-name listing on another contract whose seller text contains a prompt injection |
| Yield | the vault that best serves the portfolio, weighing **advertised** APY against capacity | two reviewed vaults; an unvetted vault at 12.60 % |
| Perps | BTC exposure | a 2x long; a 5x long |

### Candidate evidence (balanced preset; the same sets under every preset)

Every price, fee, quote, APY, depth and capacity below is **FIXTURE**
data: constants in the repository, not live market quotes. The decision
is **LIVE_MODEL** only when the OpenAI provider makes it. The stub's
decisions are `STUB` and test scripts' are `SCRIPTED`. Events carry both
labels (`marketEvidence`, `modelEvidence`). On-chain settlement evidence
(`LIVE_TESTNET`) is a separate question (§0, live-testnet-settlement.md).

| Domain | Actionable (choose among) | Discovery only (reason) | Model evidence | Market evidence |
| --- | --- | --- | --- | --- |
| Stock | `nvda-note-a`, `nvda-note-c` | `nvda-token-b` (`REGISTRY:ISSUER_NOT_ALLOWED`, `REGISTRY:SYNTHETIC_NOT_ALLOWED`) | LIVE_MODEL with the OpenAI provider | FIXTURE |
| Swap | `route-a`, `route-c` | `route-b` (`VENUE_NOT_ALLOWED`) | LIVE_MODEL with the OpenAI provider | FIXTURE |
| Yield | `alpha-usd-vault`, `beta-usd-vault` | `high-yield-usd` (asset, issuer, representation, venue) | LIVE_MODEL with the OpenAI provider | FIXTURE |
| NFT | `genesis-11` | `genesis-7` (`ASSET_NOT_ALLOWED`, `REPRESENTATION_NOT_ALLOWED`) | LIVE_MODEL with the OpenAI provider | FIXTURE |
| Perps | `btc-long-2x` | `btc-long-5x` (`LEVERAGE_NOT_ALLOWED`) | LIVE_MODEL with the OpenAI provider | FIXTURE |

The approved alternatives, and what makes each pair a real tradeoff. The
model sees every fact listed here; neither option dominates on all of them:

| Candidate | Identity (reviewed) | Economics (fixture) | Limit enforced by the bounds |
| --- | --- | --- | --- |
| `nvda-note-a` | fully backed NVDA note, approved issuer, qualified-holder redemption | 125.00 per token, no gate fee: 125.00 all-in | up to 800 USDC |
| `nvda-note-c` | fully backed NVDA note Series C, the same approved issuer, **open redemption** (the registry's own second backed record) | 124.75 per token plus a 0.25 % gate fee: ≈125.06 all-in | up to 600 USDC |
| `route-a` | reviewed router, reviewed pool (0.30 % fee tier, deep) | 0.000012 WETH per 100 USDC, minimum out quote − 0.30 % | up to 500 USDC |
| `route-c` | the same router, a second reviewed pool (0.05 % fee tier, shallow) | +0.20 % output, minimum out quote − 0.30 % | up to 250 USDC |
| `alpha-usd-vault` | Alpha vault, Alpha vault issuer, its protocol | 5.20 % advertised APY | up to 800 USDC capacity |
| `beta-usd-vault` | Beta vault, Beta vault issuer, its protocol | 6.10 % advertised APY | up to 400 USDC capacity |

Stock quantity is fee-aware: the all-in cost stays within the requested
amount (two atoms are left for the gate's separate round-ups).

**Not added, on purpose.** *Perps:* the fixture Lighter sub-account is
configured isolated at 2x (an initial margin fraction of 50 %), and Core
re-derives the margin demand from that admitted setting. A 3x long passes
scope, but its reservation is refused with `RESERVATION_DEMAND_MISMATCH`,
so offering it would offer something that cannot execute. Perps keeps one
strategy, and its real choice is its size, which is also what decides
whether the shared derivative cap is exceeded. *NFT:* a listing is one
fixed-price token, and a second Genesis listing would differ only in
price, which is not a tradeoff. Neither domain got a new market.

**Settlement.** Both approved notes settle on Robinhood Chain testnet
through the one deployed fixture market: a quantity-preserving BUY of the
valueless MDEMO for MDUSD, each bound to its own exact candidate (see
*Actionable ≠ executable* below and live-testnet-settlement.md §2). Anything
else that reaches settlement is still refused before any RPC call with
`FIXTURE_UNDEFINED_FOR_CANDIDATE`, fail-closed.

### Discovered, actionable, authorized

```text
discovery universe        every candidate the agent meets (broad; evidence)
  ─▶ eligibility          deterministic, advisory: identity and static scope under the ACTIVE mandate
actionable universe       the only candidates the model is offered
  ─▶ model decision       ranks and chooses among them, or abstains
  ─▶ trusted builder      exact lookup of the chosen id; never another candidate
  ─▶ Mandate              the full screenProposal, Room, verifier and ledger, unchanged
```

A capable model optimizes the universe it is given. Offered the reviewed
NVDA note *and* a cheaper look-alike, a live model kept choosing the
look-alike on price. Mandate then correctly blocked it, so no Stock
reservation existed, and settlement correctly refused with
`NO_STOCK_RESERVATION`. The model and Mandate both behaved correctly; the
candidate universe was wrong. A production agent should not spend its
choice on actions that can never be authorized, so the model now optimizes
only among actions that could become authorized proposals.

**Eligibility comes from the policy itself, not a copy of it.**
`agents/eligibility.ts` builds each discovered candidate at its minimum
size, then resolves it with the domain binding's `resolveCandidate` (for
the stock agent, the registry's `evaluateRepresentation`). It then applies
`permits` under the agent's scope and the portfolio's. These are the same
functions `screenProposal` runs. No candidate is named anywhere. Whatever
the active mandate and registry admit is actionable, so two approved NVDA
representations would both be offered and compared on price. A candidate
is excluded only for a reason that is a fact of the candidate itself, the
same at every size and moment:

| Pre-model (eligibility) | Post-model only (screening, Room, verifier, ledger) |
| --- | --- |
| unresolvable identity (`INSTRUMENT_UNKNOWN`, every `REGISTRY:*`), `IDENTITY_CLAIM_MISMATCH`; domain, action, chain, venue, route, asset, representation, issuer, recipient, synthetic policy, required rights, leverage | amount against agent and portfolio limits; shared portfolio resources and conflicts; quote age and slippage; mandate, agent and proposal windows; signatures, replay, the final recipient as built; execution-time state |

Eligibility fails closed: a candidate that cannot be built, validated or
resolved is not actionable. It is evaluated against the version active
when the agent is asked, so an amendment changes what the next decision is
offered. Filtering never copies or rebuilds a candidate. The model selects
the original object, so candidate and proposal digests, asset identity and
the registry commitment are untouched.

**Eligibility is not authorization.** The filter improves agent quality;
Mandate provides security. The proposal the model makes is built, signed
and screened in full, exactly as before: asset, issuer, representation,
venue, recipient, amount, agent authority, freshness and portfolio
resources. If the model is compromised, the filter has a bug, a stale
client replays an old candidate, or an agent fabricates an id, Mandate
still refuses anything unauthorized. **Capability ≠ authority.** Tests
replace the filter with one that offers everything and show the forbidden
NVDA token, router, vault, NFT listing and leverage still blocked, with
zero reservations (`test/eligibility.test.ts`, `test/discovery.test.ts`).

What it means at runtime:

- The decision schema's candidate enum is built from the actionable set. An
  id outside it, including a discovery-only one, is `INVALID_RESPONSE`.
  Trusted code never substitutes another candidate for the one the model
  chose.
- With no actionable candidate, the agent **abstains without a model
  call**: `AGENT_ABSTAINED` with `cause: NO_ACTIONABLE_CANDIDATES`,
  `modelCalled: false` and the rationale `No eligible opportunities under
  this mandate.` There is no placeholder, proposal, reservation or
  transaction.
- `AGENT_CANDIDATES_EVALUATED` (`basis: ADVISORY`) records `discovered`,
  `actionable` and each `excluded` candidate with its reason codes, before
  any model call.
- An agent with no authority under the mandate is not asked at all.

Under every preset, the reviewed instruments, now two per stock, swap and
yield, are actionable, and the look-alikes are discovery only. The registry excludes `nvda-token-b` with
`REGISTRY:ISSUER_NOT_ALLOWED` and `REGISTRY:SYNTHETIC_NOT_ALLOWED`.
`route-b` fails `VENUE_NOT_ALLOWED`. `genesis-7` fails `ASSET_NOT_ALLOWED`
and `REPRESENTATION_NOT_ALLOWED`, so its prompt-injecting seller text no
longer reaches a model in a normal run. `high-yield-usd` fails
`ASSET_NOT_ALLOWED`, `ISSUER_NOT_ALLOWED`, `REPRESENTATION_NOT_ALLOWED` and
`VENUE_NOT_ALLOWED`. `btc-long-5x` fails `LEVERAGE_NOT_ALLOWED`.

**Two flows, on purpose.** In the *normal product flow*, models rank
executable candidates. A good action is authorized. A proposal that is
valid alone but conflicts at portfolio level goes to the Mandate Room. A
hard violation that still reaches Mandate is blocked. A run need not show
all three, and none is staged. The *security flow* (policy stress, §7, and
the adversarial tests) challenges Mandate directly with forbidden actions.
VALID AGENT ≠ VALID ACTION is shown there, not by filling the normal run
with candidates that can never pass.

### Actionable ≠ executable: settlement capability

A candidate can be allowed by the mandate and still be something the
configured connector cannot execute. Until now that surfaced only after
authorization: a live model chose the valid `nvda-note-c`, Mandate
reserved it, and settlement refused it with
`FIXTURE_UNDEFINED_FOR_CANDIDATE`. Capability is now a separate, explicit
question, answered before the model is asked
(`src/agents/capability.ts`):

```text
discovered ─▶ mandate-actionable ─▶ connector-capable ─▶ live executable ─▶ model
              (policy: eligibility)   (capability: the active settlement profile)
```

| Question | Answered by | Meaning |
| --- | --- | --- |
| Is the principal's agent allowed to do this? | eligibility, then `screenProposal`, the Room, the verifier, the ledger | authority |
| Can the configured connector execute this? | the active `SettlementProfile` | a fact about the connector; no authority |

The Live Lab profile (`live-lab.robinhood-testnet-fixture.v1`) settles one
domain, Stock, through the Robinhood testnet fixture connector. Its table
(`ROBINHOOD_TESTNET_STOCK_FIXTURES`) names each supported candidate by its
exact id **and** the exact representation its trusted build produces; both
must match one entry. A relabelled candidate, a swapped id, an unknown id or
a build that fails is `SETTLEMENT_UNSUPPORTED`. Swap, NFT, yield and perps
are `OUTSIDE_PROFILE`: the profile settles nothing there, they are still
offered, their execution stays the offline fixture executors, and nothing
presents them as testnet-settleable.

| Candidate | Policy | Capability | Offered to the model |
| --- | --- | --- | --- |
| `nvda-note-a` | actionable | `SETTLEMENT_CAPABLE` | yes |
| `nvda-note-c` | actionable | `SETTLEMENT_CAPABLE` | yes |
| `nvda-token-b` | discovery only (`REGISTRY:*`) | `SETTLEMENT_UNSUPPORTED` | no |

- An actionable candidate the profile cannot settle is never offered. If
  every actionable candidate is unsupported, the agent abstains without a
  model call (`cause: NO_EXECUTABLE_CANDIDATES`).
- `AGENT_CANDIDATES_EVALUATED` reports `actionable` (policy), `executable`
  (what the model is offered), `settlementProfile` and a per-candidate
  `capability` list, separately. The Evidence tab shows *POLICY ELIGIBLE*
  and *SETTLEMENT CAPABLE* (or *NOT SETTLEABLE · NOT OFFERED*, or *NO
  TESTNET SETTLEMENT*) as different labels.
- **Capability is not authorization.** A capable candidate is screened,
  negotiated, verified and reserved in full. A profile that calls the
  look-alike capable changes nothing: eligibility still excludes it and,
  bypassed, Mandate still blocks it (`test/capability.test.ts`).
- **Settlement still decides for itself.** The fixture mapping looks the
  reserved candidate up in the same table again, by id and representation,
  and refuses anything it does not name with
  `FIXTURE_UNDEFINED_FOR_CANDIDATE`. Nothing ever substitutes note A for
  note C, or the reverse.

The candidate the model selected is the one proposed, screened, reserved
and settled — `MODEL_SELECTED == SCREENED == RESERVED == SETTLED_SEMANTIC` —
including when the Room reduces its amount (the Room changes size, never
identity) (`live-settlement/test/stock-binding.test.ts`). If the Room
releases Stock, there is no Stock reservation and nothing settles.

### What the model sees

The model sees, per actionable candidate, in a fixed order that implies no
ranking: an id, factual fields (price, fee, all-in cost, quote, depth,
advertised APY, capacity, redemption terms, leverage, issuer and venue
labels), `marketEvidence: FIXTURE`, an **untrusted** description
(seller/marketplace text, marked as such) and the allowed amount bounds. It
never sees an address it could return. It also sees `principalIntent`: the
principal's own words, which are the prompt the mandate was drafted from or
an explicit preference (`SessionOptions.intent`, `npm run agents:live --
--intent="…"`). They are ranking guidance only ("prefer liquidity over
yield") and grant nothing, because every limit is already fixed by the
mandate. Its whole output:

```json
{ "action": "PROPOSE" | "ABSTAIN", "candidateId": "…" | null, "requestedAtoms": "<integer>" | null, "rationale": "…" }
```

Its instructions frame the task as ranking: compare the supplied candidates
on their facts (price, output, advertised return, exposure, slippage, fit)
in light of the principal's intent, and choose the best, or abstain. When
more than one candidate is offered, the rationale should say why the
choice beats the alternatives. The rationale is the model's own; nothing
is generated client-side. The instructions say eligibility is not
approval. Nothing in them is a control. Choice is never randomized,
alternated or seeded. If real runs converge on one candidate, that is
reported as it is.

The stub provider is deterministic infrastructure, not a model. It picks
the first offered id in a fixed preference list, at a fixed size clamped
to the candidate's bounds, and never reads a fact or the intent. Seed 1
prefers the best headline number among what it is offered (`nvda-note-c`,
`route-c`, `beta-usd-vault`). Its picks are never evidence of economic
reasoning.

Trusted code rejects anything else (`INVALID_RESPONSE`): an extra field, an
id that was not offered, an amount out of bounds, a non-integer. Otherwise it looks the id
up, builds the exact candidate (recipient, router, contract and quote time
all from local tables), prices the demand with the portfolio's public
binding code, and signs it with the agent's **local** demonstration key.
The key never reaches a prompt, a provider, the browser, a log or an event.

No reasoning trace is requested or stored — only a declared rationale of at
most 280 characters.

## 5. Runtime

- **Concurrent discovery.** Every enabled agent is asked at once; none waits
  for another. Each records `requestStartedAt`, `firstResponseAt`,
  `responseCompletedAt`, `decisionValidatedAt`, `proposalSignedAt`,
  `mandateScreenedAt` (wall clock) and derives provider, first-response,
  validation, signing, Mandate and end-to-end latency from a monotonic clock.
- **Runtime states** `PENDING`, `RESPONDING`, `RESPONDED`, `ABSTAINED`,
  `TIMED_OUT`, `FAILED`, `INVALID_RESPONSE`, `STALE`, `SIGNED`, `BLOCKED`,
  `ADMISSIBLE` — a runtime failure is never an authorization refusal.
- **Screening** is the frozen `screenProposal`. A proposal with any
  non-quantity reason is **blocked** and never enters the Room. One whose
  only reasons are `AGENT_LIMIT_EXCEEDED` / `PORTFOLIO_LIMIT_EXCEEDED` is
  **individually valid, portfolio invalid** and admissible to negotiation.
- **Protocol time.** The frozen code takes time as a parameter. The lab maps
  the session's monotonic clock onto the fixture epoch: `protocolNow =
  DEMO_NOW + ⌊elapsed / 1 s⌋`. Quotes are observed when an agent's context is
  built; real latency therefore ages them.
- **Latency chaos** (development only) wraps a provider with an explicit
  `injectedLatencyMs` (0, 250, 1000, 3000, 8000), a forced timeout or a forced
  failure. It is reported separately from `providerLatencyMs` and labelled
  artificial.

## 6. The live Mandate Room

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

**Room V2** ([docs/v2/mandate-room-v2.md](../v2/mandate-room-v2.md)) replaced
the old trigger (`!fit.feasible → Room`). A Room now opens for exactly four
reasons, and every Room event carries its `roomPurpose`:

| purpose | when | stage |
| --- | --- | --- |
| `INITIAL_ALLOCATION` | the principal gave a total and enabled agents but no split (`DYNAMIC`) | before signing: `POST /plan` |
| `HYBRID_ALLOCATION` | some budgets fixed, the rest left to the other agents | before signing |
| `REALLOCATION` | an agent reserved nothing, its budget is free in the ledger, and the signed mandate allows reallocation | after the first authorization |
| `SHARED_RESOURCE_COORDINATION` | two or more valid agents demand the same over-limit resource and the signed mandate allows coordination | after screening |

A single agent over its own limit — or the only agent demanding a resource
that is over, such as perps on derivative notional — is never a Room: it
gets one bounded re-plan (`AGENT_LOCAL_REPLAN_REQUESTED`, its own candidate
bounded to the largest size that fits) and is screened again, or is
refused (`AGENT_LOCAL_REFUSED`). Exact budgets (`FIXED`) never meet a
Planning Room; without reallocation they are the signed maxima. A prompt
that names no agent asks "Which agents may use this capital?" — Fill never
enables an agent. Dollars are split by a deterministic allocator over
structured OpportunityCards; Jev (TypeSafe Score, when configured) only
scales a card's weight. The rest of this section describes the mechanics a
coordination Room shares with the old one.

A hard violation — asset, issuer, representation, synthetic, venue,
recipient or leverage outside scope, an unknown instrument, a bad
signature, expired or missing authority, a malformed proposal — is
`BLOCKED` at screening. It never counts toward a conflict, never enters a
Room, is never reserved and never settles, even when its size would have
caused a conflict (`test/conditional-room.test.ts`). When everything
admissible fits, there is no `PORTFOLIO_CONFLICT`, no Room event and no
negotiation call: the proposals go straight to the Portfolio Verifier and
the ledger.

### Why every default run used to open a Room

The old balanced preset deployed 2,000 USDC across agents whose maxima
summed to 3,100, and gave perps a 600 allocation against a 400 derivative
limit. Live models size near their maxima. Ten gpt runs on that preset
(2026-10-02; four with no stated intent, three preferring capital
preservation, three maximizing return) asked for 2,650 to 3,000 of 2,000
and perps 500 to 600 of 400 derivative: all seven unconstrained runs opened
a Room on **capital and derivative together**. Only the three
capital-preservation runs sized small and went direct; all three chose
`nvda-note-c`, which then could not settle.

| Balanced | Old | New |
| --- | ---: | ---: |
| Deployable (`portfolio-notional`, `spot-capital`) | 2,000 | 2,500 |
| Derivative (`derivative-notional`, `perp-margin`) | 400 | 400 |
| Illiquid | 400 | 400 |
| Agents: stock / swap / NFT / yield / perps | 800 / 500 / 400 / 800 / **600** | 800 / 500 / 400 / 800 / **400** |
| Sum of agent maxima | 3,100 (155 %) | 2,900 (116 %) |

2,500 sits between conservative (1,500 deployable) and aggressive
(3,000). The perps allocation now equals the derivative limit: an agent
whose own maximum exceeds the only resource its domain can use collides
with that limit on every request above it. Nothing is clamped: the perps
market still goes to 1,000, and a request above 400 is screened at that
size and is a real derivative (and domain) conflict. Conservative and
aggressive are unchanged. Typed demand per candidate under balanced:

| Domain | Candidate request range (USDC) | Capital | Derivative | Domain resource |
| --- | --- | --- | --- | --- |
| Stock | 100–800 (note A), 100–600 (note C) | = request (note C: the request less its 25 bps gate fee) | — | `spot-capital` = request |
| Swap | 100–500 (route A), 100–250 (route C) | = request | — | — |
| NFT | 300 (fixed) | 300 | — | `illiquid-notional` 300 |
| Yield | 100–800 (Alpha), 100–400 (Beta) | = request | — | — |
| Perps | 100–1,000 (2x) | = request | = request; margin ≈ request / 2 | — |

Thirteen gpt runs on the new preset (no broadcast; the same three
objectives): seven opened a Room, every one on **capital only** (2,550 of
2,500, reduce 50); six were authorized directly (two with no stated intent
at 2,400, four capital-preservation runs at 849 to 1,099). No run had a
derivative conflict, because every perps request was at most 400. Nine
chose `nvda-note-a`, four `nvda-note-c`, and every Stock reservation was
settlement-capable: it mapped onto the real manifest's fixture market and
an offline dry run against the reference chain reached `READY`. In one
Room the Stock agent itself reduced 800 → 750; the reservation and the
settlement stayed `nvda-note-a`. Choice was never seeded or alternated.

### Room mechanics

The Room is autonomous; no human joins it.

```text
generation g (roomId, g):
  every participant is asked at once, with: portfolio authority, admissible demand,
  required reduction, its current request, its minimum valid request, permitted actions
  replies are validated as they arrive:
    KEEP     unchanged
    REDUCE   minimum ≤ new < current (resizable candidates only)
    RELEASE  new = 0 (the request is withdrawn)
    ABSTAIN  no change this generation
  close generation g as soon as the requests (replies so far; everyone else unchanged) fit
  every portfolio limit and every agent's own limit — or when all replied or the round timed out
  fits        → proposed portfolio
  no fit      → generation g+1 with the new requests, up to the generation bound
  still none  → NO_FEASIBLE_PORTFOLIO: nothing executes
```

- **Pending and timed-out agents are unchanged, never forced.** A timeout is
  not consent, not a release and not new authority: the agent's own signed
  request stands as it was. It blocks nothing if the others' offers suffice.
- **Generations.** A reply tagged with an earlier generation, or arriving
  after the Room finalized, is recorded `STALE` / `IGNORED` and changes
  nothing: no allocation, reservation, receipt or reopening.
- **No forced success.** If the offers do not cover the need, the result is
  `NO_FEASIBLE_PORTFOLIO` and nothing executes.
- **The live Room has no authority either.** Its proposed portfolio becomes
  freshly built, locally signed proposals (at the negotiated sizes, the
  original quote time, a new sequence) handed to the frozen `runPortfolio`:
  the real Mandate Room screens them again, the Portfolio Verifier re-derives
  everything, and the ledger reserves. Agreement between models is never an
  input: five agents agreeing to exceed the limit are refused by the same
  code as one.
- **Allocation mode.** Live mandates are `DYNAMIC`: nothing is preallocated,
  so a live `RELEASE` withdraws a request; no signed allocation release is
  needed (the frozen book would refuse one as `RELEASE_EXCEEDS_UNUSED`).

### Freshness

Negotiation takes real time. A quote older than the scope's
`maxQuoteAgeSeconds` at re-verification is refused by the frozen code
(`QUOTE_STALE`); the lab marks the proposal `STALE` and `REFRESH_REQUIRED`.
The only way back is a new quote and a new decision from the agent — a
fresh candidate cycle with a new observation time and a new sequence. A
stale proposal is never re-stamped.

## 7. The policy-stress agent

VALID AGENT != VALID ACTION, shown with a real model. The policy-stress
agent runs under the **same** Swap Agent identity and the **same** local
swap signer as the normal swap agent. Its task is policy testing: select one
of the supplied proposal variants to check whether the active authorization
policy correctly accepts or refuses it. It is never asked to bypass, evade
or maximize anything.

This is the security flow. Its cases are fixed proposals handed to Mandate
directly, never filtered by candidate eligibility, so forbidden actions
keep reaching Mandate here while the normal run offers agents only
actionable candidates (§4).

The model sees the swap agent's own authority, a closed list of case
identifiers with neutral descriptions, and — after each evaluation — the
case it selected and the high-level result (outcome and reason codes; no
addresses). Its whole output:

```json
{ "caseId": "<one of the supplied identifiers>", "rationale": "<= 280 characters" }
```

Trusted local code maps the identifier onto a fixed proposal built from
existing Phase 7F fixtures; nothing in it comes from the model:

| Case | Trusted construction (a variant of the reviewed swap) |
| --- | --- |
| `RECIPIENT_MISMATCH` | recipient is the judge demo's fictional attacker fixture account `eip155:421614/account:0x9999…9999` |
| `UNAPPROVED_VENUE` | router is the existing unreviewed fixture router `…bad0` |
| `OVER_LIMIT` | amount is the swap agent's current headroom under the active mandate (read from the ledger) plus 1 USDC |
| `REPRESENTATION_MISMATCH` | output token is the Alpha vault share — an existing fixture representation of the portfolio, not the one the swap agent is authorized to acquire |
| `COMPLIANT_CONTROL` | the reviewed router, pool, tokens and the principal's recipient |
| `ABSTAIN` | nothing is submitted; the run ends |

Every submitted case is built at the current protocol time, signed by the
swap signer and handed to the full frozen path — `screenProposal`, then
`runPortfolio` (Mandate Room → Portfolio Verifier → ledger reservation).
The result shown is what that path returned; the lab hardcodes no verdict.
A quantity-only refusal (`OVER_LIMIT`) passes screening as negotiable and is
refused by the Room and verifier, because a fixed proposal does not resize.

The run is bounded (`maxAttempts`, at most and by default 5 — every case
once) and each case can be selected once; ABSTAIN is always offered. A refusal revokes nothing: the swap
agent's delegation and any earlier reservation stay as they were, and the
ledger version before and after a refused case is reported. When
`COMPLIANT_CONTROL` is authorized afterwards, it is the same agent identity
evaluated again under the same authorization system.

The model has no shell, file, environment, HTTP, RPC, wallet, signing,
ledger, database, calldata or code-execution capability, because none
exists in its interface: a strict schema with an enum of identifiers is the
whole surface. Security comes from that closed interface, not from the
prompt. Output with any other field or value is `INVALID_RESPONSE` and
nothing is built.

## 8. JEV

`JevAdvisor.rank(...)` may return an ordering of candidate ids already in the
set, or nothing. The lab ships `NoopJevAdvisor`. The existing `@mandate/jev`
ranks router routes over the Phase 5 closed-set projection; mapping portfolio
candidates onto it would require behaviour it does not document, so it is
not wired in. A recommendation naming an id not in the set is ignored.

## 9. The event stream `MANDATE_LIVE_AI.V1`

A separate stream from `MANDATE_JUDGE_DEMO.V1`, which is untouched. Every
event: `schema`, `sessionId`, `sequence`, `kind`, `at` (wall clock, ISO),
`elapsedMs` (monotonic), `protocolTime`, `mandateVersion`, `agent`, `roomId`,
`generation`, `data`. Only explicit, safe fields: no key, no prompt, no raw
model output, no reasoning trace. Kinds are listed in
`packages/live-agents/src/telemetry/events.ts`. The `TESTNET_*` and
`DOMAIN_EXECUTION_*` kinds (B.5.2) are emitted only by
`@mandate/live-settlement` in its explicit testnet modes
([live-testnet-settlement.md §7](live-testnet-settlement.md#7-lifecycle-and-evidence));
the runs below never emit them.

`AGENT_CANDIDATES_EVALUATED` is advisory evidence (§4). It authorizes
nothing. Reasons in every event are protocol codes with their subject
(`code:subject`), and the browser keeps them as separate values.

Resource conflicts are typed and never summed. `PORTFOLIO_CONFLICT`,
`ROOM_OPENED`, `ROOM_GENERATION_STARTED`, `ROOM_PROPOSAL_CREATED` and
`ROOM_NO_FEASIBLE_PORTFOLIO` carry `conflicts`: one entry per resource over
its limit (`resource`, `authority`, `demand`, `requiredReduction`), taken from
the `constraints` lines. The last two add `demandAfter`, `remainingReduction`
and `status` (`SATISFIED` or `UNRESOLVED`). `authority`, `admissibleDemand`
and `portfolioNotionalRequiredReduction` describe portfolio notional alone:
it can be `0` while derivative notional still needs a reduction.

## 10. Server and browser

`apps/web` stays a static export. `/demo` is Protocol Replay, unchanged;
`/demo/live` is the Live AI Lab client. It talks to a separate local server
(`npm run agents:serve`) that holds `OPENAI_API_KEY`, calls the OpenAI
Responses API server-side and streams `MANDATE_LIVE_AI.V1` events. The
browser bundle contains no key and no OpenAI endpoint, and the client
refuses a server URL that is not loopback. A future deployment would put
the server in a Cloudflare Worker with the key as a secret; nothing is
deployed in this milestone.

The server (`packages/live-agents/src/server/`):

- binds `127.0.0.1` only; refuses a `Host` other than its loopback address
  (DNS rebinding) and an `Origin` not in `LIVE_ALLOWED_ORIGINS` (default
  `http://localhost:3000,http://127.0.0.1:3000`);
- accepts `application/json` POST bodies of at most 32 KiB, parsed field by
  field; a draft changes only through the typed field table (set fields
  take only ids of their reviewed catalog set);
- keeps at most four sessions in memory, which leave memory when idle; with
  `LIVE_STATE_DIR` (default `.live/`) every session is durable and is
  restored from disk on first use after a restart — as evidence only (B.5.3);
- reports only whether the OpenAI provider is available, never the key;
  an unexpected failure is a 500 without detail;
- allows development latency chaos only when started with `--dev-chaos`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/live/status` | providers available, presets, roles, catalog, policy cases |
| `POST /api/live/sessions` | `{ provider: "openai" \| "stub", seed?, chaos? }` |
| `GET /api/live/sessions/:id` | draft, validation, guardrails, versions (with how each was authorized), the durable planning record and restored proposal, last run and policy-stress summaries, each reservation's ledger status, `durable`, `restored` |
| `POST …/draft` | `{ preset }`, `{ prompt }` or `{ from: "active" }` (to amend) |
| `POST …/draft/fill`, `…/draft/field`, `…/draft/resolve` | fill unset fields from a preset; set one field; resolve one interpretation issue |
| `POST …/wallet/challenge` | `{ address, spine?: "V2" }` → a one-time EIP-712 approval. Omitted spine is the B.5.3 `PortfolioMandateApproval`. `"V2"` is the plan-bound `PortfolioMandateAuthorizationV2` and returns `initialAllocationDigest` |
| `GET /api/live/settlement` | on `agents:lab` only: spine V2 is available, the operator phrase, gas payer `DEPLOYER`. `agents:serve` answers 404. A missing manifest or key answers 503 |
| `POST …/settle` | on `agents:lab` only: `{ mode: "DRY_RUN" \| "SEND", intent?: "EXECUTE_ROBINHOOD_TESTNET", gateSignature?, sendAuthorization?, cancel? }` — the same spine as `agents:settle:v2`. The page's Execute action is one `SEND` with that intent. The wallet does not broadcast |
| `POST …/wallet/authorize` | `{ challenge, signature }` — the server rebuilds the message and verifies the recovered signer (B.5.3) |
| `POST …/authorize`, `…/pause` | need the exact confirmation text (the demo key path; pause) |
| `POST …/run`, `…/policy-stress` | start in the background; progress is the event stream |
| `GET …/events?after=N` | Server-Sent Events, replayed from `N` (or `Last-Event-ID` on a reconnect) then live, including events a settlement command appended |

## 11. Commands

```bash
npm run agents:stub        # offline: deterministic stub provider, text output
npm run agents:live        # OpenAI: requires OPENAI_API_KEY (and optionally OPENAI_MODEL)
npm run agents:live:json   # OpenAI: MANDATE_LIVE_AI.V1 events as JSON lines
npm run agents:serve       # local API for /demo/live on 127.0.0.1:8787 (OpenAI when a key is set; the stub always). Does not settle.
npm run agents:lab         # the same API, plus V2 dry-run and send for /demo/live. The deployer key broadcasts. Explicit only.
```

These are offchain: every one of them reports 0 transactions. The testnet
settlement commands (`agents:live:testnet:dry-run`, `agents:live:testnet`)
are separate; see [live-testnet-settlement.md](live-testnet-settlement.md).

Runner options: `--preset=…`, `--prompt="…" [--fill=<preset>]`,
`--intent="…"` (the principal's ranking preference; no authority),
`--policy-attempts=N`, `--no-policy-stress`, `--seed=N` (stub) and
`--chaos=<spec>` (development only). A draft with blocking issues exits 3
and is never authorized; the OpenAI modes exit 2 without a key. The
principal's confirmation in a command-line run is supplied by the runner
and printed as such.

`OPENAI_API_KEY` (and optionally `OPENAI_MODEL`, `AGENT_TIMEOUT_MS`,
`ROOM_ROUND_TIMEOUT_MS`, `LIVE_AGENTS_PORT`, `LIVE_ALLOWED_ORIGINS`) may
also be put in a gitignored `.env` at the repository root, which the
`agents:live*` and `agents:serve` scripts load. CI and `npm test` use only
stub and scripted providers.

Live runs pass `executeAfter = 0` to `runPortfolio`: the protocol clock
follows real time and the executor runs immediately, so execution is
stamped when it happens. The default (now + 5 s) would put a ledger event
in the future and make the ledger refuse any later reservation in the
session within five seconds as `EVALUATION_TIME_REGRESSED`. No protocol
security property needs a positive delay (re-examined in B.5.2:
[live-testnet-settlement.md §8](live-testnet-settlement.md#8-executeafter-0n),
`test/execute-after.test.ts`).
