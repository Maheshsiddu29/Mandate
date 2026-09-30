# Mandate — Live AI Lab

> **Status: buildathon Milestone B.5, implemented locally, awaiting review.**
> A second demo mode beside Protocol Replay. Model-backed agents act
> autonomously under a Portfolio Mandate the principal authors live; the
> frozen Phase 7F Portfolio Mandate decides what may settle. Additive only:
> `packages/live-agents` and a `/demo/live` route. Nothing frozen changes —
> not `contracts/`, `kernel`, `core`, `ledger`, `control`, `registry`,
> `ledger-sqlite`, `execution-gate`, `evm-robinhood`, `perp-lighter`,
> `packages/portfolio`, `packages/judge-demo`, any corpus, the Phase 7E
> evidence or `MANDATE_JUDGE_DEMO.V1`. No transaction is sent; nothing is
> deployed.

```text
Humans define authority.  Agents operate autonomously.  Mandate decides what may settle.

Different reasoning.  Different negotiation.  Same authority boundary.

VALID AGENT != VALID ACTION
```

## 1. The trust model in one table

| Component | May | May never |
| --- | --- | --- |
| Principal (the user) | author a draft; review it; **explicitly** authorize a version; author and authorize an amendment | edit a live Room allocation; speak for an agent |
| Draft interpreter (a model) | map a prompt onto known fields; suggest values; flag ambiguity and conflict | sign; activate; widen; invent an asset, issuer, venue, recipient or address; fill a missing value with a permissive default |
| Domain agent (a model) | read a closed candidate set, its own authority and bounded portfolio context; choose a candidate id and an amount inside supplied bounds; abstain; negotiate KEEP / REDUCE / RELEASE / ABSTAIN | name an address, venue, recipient, calldata or contract; call a tool; read a key, file, environment variable or URL; sign; write the ledger or the mandate |
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
instruments.

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

Five domain agents, each with an objective and a closed candidate set built
by trusted local code from the Phase 7F demonstration markets (labelled
fixtures):

| Agent | Objective | Candidates (the Mandate decides which are allowed) |
| --- | --- | --- |
| Stock | useful NVDA exposure | the approved backed note at 125.00; a same-ticker token at 122.50 from another issuer |
| Swap | best execution USDC→WETH | the approved router; a router quoting 4.16 % more |
| NFT | an acceptable Genesis purchase, or abstain | a listing of the Genesis collection; a cheaper same-name listing on another contract whose seller text contains a prompt injection |
| Yield | best **advertised** APY | the approved vault at 5.20 %; an unvetted vault at 12.60 % |
| Perps | BTC exposure | a 2x long; a 5x long |

The model sees, per candidate: an id, factual fields (price, quote,
advertised APY, leverage, issuer and venue labels), an **untrusted**
description (seller/marketplace text, marked as such) and the allowed
amount bounds. It never sees an address it could return. Its whole output:

```json
{ "action": "PROPOSE" | "ABSTAIN", "candidateId": "…" | null, "requestedAtoms": "<integer>" | null, "rationale": "…" }
```

Trusted code rejects anything else (`INVALID_RESPONSE`): an extra field, an
unknown id, an amount out of bounds, a non-integer. Otherwise it looks the id
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

When the admissible demand exceeds what the portfolio can still give, the
lab opens a Room. It is autonomous; no human joins it.

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
`packages/live-agents/src/telemetry/events.ts`.

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
- keeps at most four in-memory sessions, which expire when idle;
- reports only whether the OpenAI provider is available, never the key;
  an unexpected failure is a 500 without detail;
- allows development latency chaos only when started with `--dev-chaos`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/live/status` | providers available, presets, roles, catalog, policy cases |
| `POST /api/live/sessions` | `{ provider: "openai" \| "stub", seed?, chaos? }` |
| `GET /api/live/sessions/:id` | draft, validation, guardrails, versions, last run and policy-stress summaries |
| `POST …/draft` | `{ preset }`, `{ prompt }` or `{ from: "active" }` (to amend) |
| `POST …/draft/fill`, `…/draft/field`, `…/draft/resolve` | fill unset fields from a preset; set one field; resolve one interpretation issue |
| `POST …/authorize`, `…/pause` | need the exact confirmation text |
| `POST …/run`, `…/policy-stress` | start in the background; progress is the event stream |
| `GET …/events?after=N` | Server-Sent Events, replayed from `N` then live |

## 11. Commands

```bash
npm run agents:stub        # offline: deterministic stub provider, text output
npm run agents:live        # OpenAI: requires OPENAI_API_KEY (and optionally OPENAI_MODEL)
npm run agents:live:json   # OpenAI: MANDATE_LIVE_AI.V1 events as JSON lines
npm run agents:serve       # local API for /demo/live on 127.0.0.1:8787 (OpenAI when a key is set; the stub always)
```

Runner options: `--preset=…`, `--prompt="…" [--fill=<preset>]`,
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
session within five seconds as `EVALUATION_TIME_REGRESSED`.
