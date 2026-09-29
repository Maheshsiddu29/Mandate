# Phase 7F — Multi-agent security model

> **Status: Phase 7F, implemented and tested ([implementation-7f.md](implementation-7f.md)).** Companion to
> [portfolio-mandate.md](portfolio-mandate.md). Scope: one principal, several
> agents, several markets. Authority across principals remains Phase 9.
> Phase 7F.1 hardening is specified in
> [security-fixes-7f1.md](security-fixes-7f1.md).

## 1. The two questions

| Question | Answered by | Answer grants |
| --- | --- | --- |
| **Authentication** — is this really agent X? | the proposal's secp256k1 signature recovering to an agent the principal's mandate names | nothing |
| **Authorization** — may agent X perform *this exact action*? | the Portfolio Verifier's `permits` over the resolved action, the agent's and the portfolio's limits, then Core's control engine and ledger, then the domain's enforcement point | one child execution authorization, one reservation, one attempt |

**A valid agent is not a valid action.** Every attack below is run by an
agent that authenticates correctly.

## 2. What an agent can and cannot do

| An agent may | through |
| --- | --- |
| discover, rank and propose | `AgentProposal` (signed) |
| request capital, reduce a request, release unused allocation | proposals and `RELEASE` messages to the room |
| negotiate | resubmitting smaller proposals after `REDUCE_REQUESTED` |

| An agent may not | because |
| --- | --- |
| modify the principal's policy | the mandate is principal-signed; the verifier is pinned to its digest; agents never supply one |
| raise its hard maximum | hard maxima are mandate terms, re-checked by the verifier and charged as the agent's own ledger leg |
| add an asset, representation, issuer or venue | closed-world sets in its scope; identity derived from the registry or the reviewed instrument table, never from the agent |
| raise leverage | `maxLeverage` in scope, and `perp.max-leverage` in its Core delegation |
| change the settlement recipient | `recipients` in scope, and the Core `RECIPIENTS` set (or the gate's principal-only recipient rule) |
| exceed a portfolio-wide limit | the root grant's ledger dimension is charged by every agent's reservation |
| extend expiry | child window ⊆ parent window at every level |
| create authority by consensus | no operation takes agreement as input (§4) |

## 3. Threats and the layer that stops each

| # | Threat | First refusal | Independent backstops |
| --- | --- | --- | --- |
| T1 | unknown party proposes | room/verifier `AGENT_UNKNOWN` | Core `ACTOR_NOT_HOLDER` (no delegation to it) |
| T2 | forged or replayed proposal | `AGENT_SIGNATURE_INVALID`, `PROPOSAL_REPLAYED` | ledger `RESERVATION_EXISTS` for the same action |
| T3 | authorized agent substitutes a look-alike representation | registry `REPRESENTATION_UNKNOWN` / `ISSUER_NOT_ALLOWED`; `REPRESENTATION_NOT_ALLOWED` | Core `MARKETS_NOT_PERMITTED`; GateSpotPolicy `MARKET_NOT_REVIEWED`; the gate's own market table |
| T4 | authorized agent substitutes a recipient | `RECIPIENT_NOT_ALLOWED` | Core `RECIPIENTS_NOT_PERMITTED`; the gate's `RecipientNotPrincipal` |
| T5 | authorized agent routes through an unknown venue | `VENUE_NOT_ALLOWED` | Core `MARKETS_NOT_PERMITTED` |
| T6 | authorized agent requests beyond its child authority | `AGENT_LIMIT_EXCEEDED` | ledger `LEDGER_LIMIT_EXCEEDED` at the agent's leg |
| T7 | agent understates its demand | `PROPOSAL_RESOURCES_MISDECLARED` | `RESERVATION_DEMAND_MISMATCH`; the ledger charges the module's figure |
| T8 | candidate changed after authorization | transcript re-verification / `CHILD_ACTION_MUTATED` before reservation or key use | exact child/action/attempt binding; the gate's own signature and economic checks |
| T8a | a stock reservation made around the portfolio | `createPortfolioGateSigner`: the public Portfolio factory exposes only custody guarded by `checkBeforeSign` | custody's own re-derivation of the gate artifact |
| T9 | one agent uses another's reservation | `CHILD_AGENT_MISMATCH` | Core `ACTOR_NOT_HOLDER`; the reservation is bound to its action |
| T10 | agents race for the same pool | — | the ledger's compare-and-swap: every leg checked at the committed version |
| T11 | a released lot is claimed twice | `LOT_EXHAUSTED`, `CLAIM_ALREADY_APPLIED` | the verifier replays the book |
| T12 | coalition of all agents | no coalition operation exists | every agent's own leg and the portfolio-wide leg |
| T13 | compromised Mandate Room | the verifier re-derives everything | the ledger enforces hard limits whatever the verifier admits |
| T14 | compromised verifier | — | Core: sets, meet and ledger legs; the domain enforcement point |
| T15 | stale quote or stale proposal | `QUOTE_STALE`, `PROPOSAL_EXPIRED` | domain state freshness in Core admission |
| T16 | incomparable quantities summed | `RESOURCE_INCOMPARABLE` (no API adds two resources) | the ledger matches kind and unit exactly |
| T17 | unknown required metadata | `PROPOSAL_EXTENSION_UNKNOWN` | — |
| T18 | repeated/non-monotonic release or reordered claim transcript | `RELEASE_SEQUENCE_INVALID` or `CANDIDATE_BOOK_MISMATCH` | ordered replay with unique ids and exact lot accounting |

## 4. Coalitions

"The agents can agree with each other and still be wrong." There is no
object, field or operation in which agent agreement is an input: no joint
proposal, no vote, no quorum. Five proposals signed by five valid agents are
five independent requests, each bounded by its own hard maximum, together
bounded by the portfolio limit, and each charged to its own and the root's
ledger leg. A mandate the agents write themselves has a different digest and
no principal signature. The tests run all five agents at their hard maxima
(3,100 against a 2,000 limit) through the room, through a forged candidate,
and directly against the control engine; every path stops at 2,000.

## 5. Trust boundaries

| Component | Trusted for | Not trusted for |
| --- | --- | --- |
| agent | nothing | — |
| Mandate Room | nothing (output is input to the verifier) | allocation fairness beyond the principal's limits |
| Portfolio Verifier | admitting only actions inside the signed mandate | hard limits (the ledger re-enforces them) |
| registry snapshot | representation identity for the stock agent | anything the snapshot does not establish (fails closed) |
| reviewed instrument tables | identity of FIXTURE instruments; part of each module's digest | anything else |
| control engine and ledger (frozen) | atomic reservation, lineage meet, `ADMIT_ATTEMPT` | — |
| domain signer and enforcement point (existing) | exact-artifact execution | — |

**Residual risk that stays.** The verifier and room decide *distribution*
inside the principal's limits: a compromised verifier could give one agent
more of the pool than a fair room would, but never more than that agent's
hard maximum or the portfolio limit, and never an action outside the Core
sets. A compromised ledger writer is outside this phase's model, as in
Phase 7E.
