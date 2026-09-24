# Mandate — Design Specification

Canonical, long-term design document for Mandate. Other documents in this
repository summarize parts of this one and link back to it; this file is the
source of truth.

- **Document status:** Phase 0 (foundation). Specification only.
- **Implementation status:** none. No component described here is built.
- **Last structural revision:** Phase 0.

## How to read status labels

Because this document describes a complete system while the repository
contains none of it, every major capability carries a maturity label. The
labels describe how settled the *design* is, not how much code exists.

| Label | Meaning |
| --- | --- |
| **SPECIFIED** | Design is settled enough to implement against without another design round. Expected to change only at the margins. |
| **DRAFT** | Shape is agreed, field-level and interface-level details are still open. Implementing it will force decisions this document does not make. |
| **EXPLORATORY** | Direction only. Recorded so it is not reinvented, not because it is decided. Likely to change materially. |
| **FUTURE** | Deliberately out of scope for the buildathon and for the near-term roadmap. Written down to constrain today's abstractions, not to be built soon. |

Nothing in this document is labelled "implemented", because in Phase 0 nothing
is. Claims about what Mandate *does* should be read as what Mandate is
*specified to do*. See [Buildathon MVP scope](#20-buildathon-mvp-scope) for
what is actually being built first.

## Contents

1. [Executive summary](#1-executive-summary)
2. [Problem statement](#2-problem-statement)
3. [Product thesis](#3-product-thesis)
4. [Why tokenized assets create a new routing problem](#4-why-tokenized-assets-create-a-new-routing-problem)
5. [Canonical assets and token representations](#5-canonical-assets-and-token-representations)
6. [Representation semantics](#6-representation-semantics)
7. [Financial mandates](#7-financial-mandates)
8. [Agent authorization model](#8-agent-authorization-model)
9. [Execution lifecycle](#9-execution-lifecycle)
10. [Deterministic verification](#10-deterministic-verification)
11. [Jev's role and its limits](#11-jevs-role-and-its-limits)
12. [Routing architecture](#12-routing-architecture)
13. [Corporate actions](#13-corporate-actions)
14. [Settlement](#14-settlement)
15. [Audit and reconciliation](#15-audit-and-reconciliation)
16. [Major invariants](#16-major-invariants)
17. [Threat model overview](#17-threat-model-overview)
18. [Robinhood Chain and Arbitrum initial integration](#18-robinhood-chain-and-arbitrum-initial-integration)
19. [Stablecoin funding as a supporting layer](#19-stablecoin-funding-as-a-supporting-layer)
20. [Buildathon MVP scope](#20-buildathon-mvp-scope)
21. [Explicit non-goals for the MVP](#21-explicit-non-goals-for-the-mvp)
22. [Future architecture](#22-future-architecture)
23. [Expansion beyond equities](#23-expansion-beyond-equities)
24. [StateLatch reuse strategy](#24-statelatch-reuse-strategy)
25. [Phased engineering roadmap](#25-phased-engineering-roadmap)

---

## 1. Executive summary

Mandate is an intent-aware execution infrastructure layer for AI agents
transacting in tokenized financial assets.

An agent asked to "buy $1,000 of NVDA exposure" today has to answer a set of
questions that have nothing to do with the financial decision: which chain,
which contract address, which issuer's wrapper, which venue, which pool, which
bridge. Each of those answers is a place where the agent can be wrong, be
misled, or be attacked — and being wrong there produces a real financial loss
that looks, from the outside, like a successful transaction.

Mandate proposes a different decomposition:

```
financial intent  ->  valid representation  ->  valid route  ->  verified execution
```

rather than the decomposition crypto routers use today:

```
token address  ->  swap
```

Three ideas carry most of the weight.

**A canonical asset is not a token.** `NASDAQ:NVDA` is a financial identity.
An ERC-20 on some chain issued by some issuer is a *representation* of that
identity. Two representations of the same underlying may differ in backing,
redemption, shareholder rights, corporate-action handling, and jurisdiction.
Mandate treats "same underlying" and "economically equivalent" as separate
claims and never silently converts one into the other.

**A mandate is a bounded authorization, not a prompt.** A human or institution
expresses a machine-readable authorization: what asset, what side, what
maximum notional, which issuers are acceptable, whether synthetic exposure is
allowed, how much execution deviation is tolerable, how fresh corporate-action
state must be, when the authorization expires. The agent operates *inside* that
authorization. It does not hold unbounded custody.

**Model output is advisory; deterministic code decides.** Jev may classify,
rank, or select. Whatever Jev returns is then checked, from scratch, by a
deterministic verifier that has final authority. A model cannot relax a
constraint, cannot add a candidate, and cannot authorize an execution. If the
verifier rejects, nothing executes, regardless of what any model concluded.

The buildathon deliverable is a narrow vertical slice of this on tokenized
equities over Robinhood Chain / Arbitrum-compatible infrastructure: one
machine-readable mandate, a canonical-asset and representation registry,
multiple execution candidates, optional Jev-assisted selection, a deterministic
verifier producing stable PASS/REJECT reason codes, and deliberate failure
demonstrations showing the verifier refusing unsafe executions. Everything
beyond that slice is labelled as future architecture in this document and is
not claimed as working.

## 2. Problem statement

### 2.1 The failure mode Mandate targets

An AI agent given spending authority and a swap tool will execute a transaction
that is *mechanically valid* and *financially wrong*. The mechanical layer —
signatures, balances, gas, slippage tolerance — is well defended. The financial
layer is not defended at all.

Concretely, all of the following produce a confirmed on-chain transaction that
a block explorer reports as a success:

| Situation | What the chain sees | What actually happened |
| --- | --- | --- |
| Agent buys a token whose ticker matches `NVDA` but which is an unrelated deployment | a swap | the user bought a worthless token |
| Agent buys a synthetic perpetual-style exposure when the user required a backed instrument | a swap | the user holds counterparty risk they refused |
| Agent buys a representation from an issuer the institution has not approved | a swap | a compliance breach |
| Agent executes against a quote taken before a 4:1 split | a swap | the user paid roughly four times the intended price per share |
| Agent executes while the underlying is halted | a swap | execution at a price with no defensible reference |
| Agent is prompt-injected into using an attacker-supplied contract address | a swap | funds routed to the attacker |
| Agent's amount is mutated between decision and signature | a swap | the wrong notional was spent |

Slippage tolerance catches none of these. Slippage protects a token-amount
expectation. Every row above is a failure of *financial identity*, *instrument
semantics*, *authorization scope*, or *state freshness*.

### 2.2 Why this gets worse, not better

Three trends compound:

1. **Tokenized real-world assets are multiplying representations.** The same
   underlying share is being issued by multiple issuers, on multiple chains,
   under different legal and operational structures. "The NVDA token" is
   already not a well-defined object.
2. **Agents are being given execution authority.** The industry is moving from
   "agent suggests, human clicks" to "agent executes". The signature is
   becoming automated; the judgment behind it is becoming a model output.
3. **Model output is attackable.** Prompt injection, hostile tool responses,
   and hallucinated addresses are not edge cases; they are the expected
   operating environment for an agent reading untrusted market data.

The combination means an agent will increasingly be the party choosing a
contract address, and that choice will increasingly be influenced by text it
did not author.

### 2.3 What is missing

There is no layer today that can answer, deterministically and before
execution:

> Is this specific transaction, against this specific token, on this specific
> chain, at this specific price, right now, inside the authority a human
> actually granted?

Answering that requires: a canonical notion of the financial asset, structured
knowledge of what each tokenized representation actually *is*, a machine-
readable record of what was authorized, live market and corporate-action state,
and a decision procedure that does not involve a language model.

That layer is Mandate.

### 2.4 Who this is for

Mandate is infrastructure, not a retail trading app. The intended consumers
are:

- agent frameworks and autonomous trading agents that need bounded authority;
- wallets and custodians that need to refuse unsafe agent-initiated actions;
- institutions that need policy — approved issuers, forbidden instrument
  types, jurisdictional limits — enforced at execution time rather than in a
  compliance review afterwards;
- venues and aggregators integrating tokenized assets that need representation
  semantics rather than token addresses.

## 3. Product thesis

**Thesis.** The scarce primitive in agentic finance is not liquidity routing.
It is *verifiable bounded authority over a correctly identified financial
asset*. Mandate builds that primitive and treats routing as a consequence of
it.

Five commitments follow from the thesis.

**1. Intent is expressed in financial terms, not blockchain terms.**
The unit of authorization is "buy $1,000 of NVDA exposure, backed only,
approved issuers only". It is not "swap 1000 USDC for token 0xabc… on chain
42161". Chain, contract, venue and bridge are *resolution results*, not
inputs. An agent that never types a contract address cannot hallucinate one.

**2. Authorization is bounded, explicit, and separate from execution.**
A mandate states its own limits and its own expiry. Holding a mandate is not
holding custody. A valid agent signature proves *who asked*; it does not prove
*that the action was permitted*. Those are checked separately, and the second
check is the one that gates execution.

**3. Optimization happens only inside the valid set.**
A crypto router maximizes output. Mandate first computes the set of candidates
that satisfy every mandate constraint, and only then optimizes within it. A
candidate that violates a constraint is not a worse candidate — it is not a
candidate. No amount of price improvement promotes it.

**4. Determinism has final authority over judgment.**
Judgment — including Jev's — is used where it adds value: classification,
ranking, disambiguation, handling of messy real-world metadata. It is never
used as the last gate. The last gate is a pure function over explicit inputs,
reproducible from the audit record, with stable reason codes.

**5. Refusal is a first-class product outcome.**
A REJECT with a precise reason code is a successful result, not an error. The
system is designed to be *evaluated on what it refuses*, which is why the
buildathon deliverable includes deliberate failure demonstrations alongside
successful execution.

### 3.1 What Mandate optimizes

Mandate's objective is best execution **subject to** constraints, rather than
unconstrained output maximization:

```
maximize      execution quality
subject to    canonical financial asset identity
              representation semantics
              issuer restrictions
              backing requirements
              shareholder and economic rights
              jurisdictional constraints
              portfolio policy
              price limits
              execution deviation limits
              liquidity
              trading status
              corporate-action state
              user authorization
              agent authority
              mandate expiry
              replay protection
```

The constraint set is the product. The optimizer is comparatively ordinary.

## 4. Why tokenized assets create a new routing problem

### 4.1 Crypto-native routing assumes token identity is financial identity

For a crypto-native pair, the token *is* the asset. There is one canonical
WETH on a given chain. Routing across pools is therefore a pure execution-
quality problem: the router may pick any path because every path delivers the
same object.

That assumption is the foundation of every DEX aggregator, and it is false for
tokenized real-world assets.

### 4.2 What breaks

**One underlying, many non-equivalent representations.** Issuer A's tokenized
NVDA and issuer B's tokenized NVDA are different financial instruments that
happen to track the same underlying. They may differ in whether they are fully
backed by custodied shares, whether redemption is available and to whom,
whether the holder receives dividends or an adjusted price, how splits are
applied on-chain, which jurisdictions may hold them, and what happens in a
merger. A router that substitutes one for the other because the price is
better has made a financial decision it was never authorized to make.

**Economic state lives outside the pool.** For crypto-native pairs, everything
economically relevant is on-chain and visible in the pool. For a tokenized
equity, the economically relevant state includes the underlying's trading
status, the corporate-action calendar, the issuer's operational status, and any
pending on-chain adjustment mechanism. A pool can quote a perfectly healthy
price for a token whose underlying is halted or mid-split.

**Economic state changes discontinuously and on a schedule.** A 4:1 split does
not move price by a few basis points; it changes the meaning of one token by a
factor of four, at a scheduled instant. A quote taken before that instant and
executed after it is not "slightly stale" — it is wrong by 300%. Ordinary
slippage tolerance, which is calibrated in basis points, cannot express this.

**Token amount is not a comparable unit across representations.** If issuer A's
token represents one share and issuer B's token represents one share subject to
an on-chain multiplier, comparing raw output amounts compares nothing. Route
quality across representations has to be computed in share-equivalents or
another economically meaningful unit, with explicit arithmetic.

**Identity is attackable.** A ticker string is not an identifier. Anyone can
deploy a token called `NVDA`. Any tool response can contain an address. The
mapping from "the financial asset a human named" to "the contract a transaction
touches" is the single highest-value target in the whole pipeline, and in a
conventional agent stack that mapping is performed by a language model reading
untrusted text.

### 4.3 The consequence for architecture

Routing for tokenized assets has to be a **two-stage** problem:

1. **Admissibility** — which representations and which routes are permitted at
   all, given the authorization. Deterministic, fail-closed, and not a
   preference ordering.
2. **Quality** — among admissible candidates, which is best. Here a ranking
   function, and optionally a model, is appropriate.

Conflating the two stages is the mistake. Every unsafe outcome in §2.1 is a
case where an admissibility question was answered by a quality-optimizing
component.

## 5. Canonical assets and token representations

> **Status: SPECIFIED** for the identity model; **DRAFT** for the identifier
> encoding and registry format.

### 5.1 The separation

Mandate maintains two distinct object types and never collapses them.

```
                    CanonicalAsset
                    NASDAQ:NVDA
                    (a financial identity in the real world)
                          |
        +-----------------+-----------------+
        |                 |                 |
  Representation    Representation    Representation
  issuer A          issuer B          issuer C
  chain A           chain B           chain C
  token A           token B           token C
  backed            backed            synthetic
  rights: none      rights: economic  rights: none
```

A **CanonicalAsset** is the financial instrument as the outside world
understands it: a listed equity, a bond, a fund, a commodity. It has no chain,
no contract, and no issuer.

A **Representation** is one tokenized instance of that asset: a specific
contract, on a specific chain, issued by a specific issuer, under a specific
legal and operational structure.

The edge between them asserts exactly one thing: *this token is issued against
that underlying*. It does **not** assert that two representations of the same
underlying are fungible, interchangeable, equally safe, or equally valuable.
Substitution between representations is a financial decision that requires
explicit authorization — never a routing optimization.

### 5.2 Canonical asset identity

Identity must be stable, collision-resistant, and not derived from a display
string. A ticker is a label, not an identifier: tickers are reused across
venues, reassigned after delistings, and changed by corporate action.

Proposed identifier shape (**DRAFT**):

```
mandate:asset:<asset-class>:<scheme>:<value>

mandate:asset:equity:figi:BBG000BBJQV0        # NVIDIA Corp common stock
mandate:asset:equity:isin:US67066G1040
mandate:asset:treasury:cusip:912797GN2
```

Design rules for the identifier (**SPECIFIED**):

- The identifier is opaque to consumers. Nothing parses it to infer behaviour.
- `<scheme>` records *which external identifier system* establishes identity,
  because different asset classes have different authorities (FIGI/ISIN for
  equities, CUSIP for many US instruments, LEI for issuers, and others for
  asset classes Mandate has not yet modelled).
- `MIC:ticker` (e.g. `NASDAQ:NVDA`) is a **display alias and a lookup key**,
  never the identity. Resolution from a human-supplied ticker to a canonical
  asset is an explicit, auditable step that can fail or return an ambiguity,
  and an ambiguous resolution fails closed rather than picking a favourite.
- The identifier carries no chain, no contract, and no issuer.
- A canonical asset is versionless, but its *state* (see §13) is not: symbol
  changes, splits and mergers change the asset's corporate-action epoch, and
  in the case of a merger may map one canonical asset onto another.

The `<asset-class>` segment exists so the scheme extends beyond equities
without a redesign; see §23.

### 5.3 Representation identity

A representation is identified by chain plus contract, using a CAIP-19-style
encoding (**DRAFT**):

```
eip155:42161/erc20:0x<address>
```

Rules (**SPECIFIED**):

- Chain identity comes from a chain ID, not from an RPC URL, a hostname, or a
  human-readable network name. An RPC endpoint is a data source and can lie
  about which network it serves; the chain ID is checked against the network
  the transaction is actually submitted to.
- Contract address is the only address that matters, and it comes from the
  registry, never from a model, a tool response, or user free text.
- A representation belongs to exactly one canonical asset. A token claiming to
  represent two underlyings at once is not modelled and is rejected.
- Representations are registry entries, not discoveries. An unknown contract
  is `UNKNOWN`, and `UNKNOWN` never becomes admissible. See §16, INV-5.

### 5.4 Why "same underlying" is deliberately weak

It is tempting to make the registry assert equivalence, because equivalence is
what a router wants. Mandate refuses to, for a specific reason: the assertion
would be false, and the system would then be built on it.

The registry's membership claim is the weakest useful one. Everything stronger
— "these are interchangeable", "this one is an acceptable substitute", "this
one satisfies the user's requirement for backed exposure" — is derived at
decision time from representation metadata (§6) and mandate constraints (§7),
where it can be checked, explained, and refused.

## 6. Representation semantics

> **Status: DRAFT.** The metadata dimensions are settled; the value
> vocabularies and their sourcing are not.

### 6.1 Why metadata is the core registry asset

Once canonical identity and token identity are separated, the interesting
question becomes: *what is this token, financially?* That question is answered
by representation metadata, and the quality of Mandate's decisions is bounded
by the quality of that metadata.

### 6.2 Metadata dimensions

| Dimension | Question it answers | Example values |
| --- | --- | --- |
| Canonical underlying | What real asset is this issued against? | a `CanonicalAsset` identifier |
| Issuer | Who issues and is accountable for it? | an issuer identity, ideally LEI-anchored |
| Contract and chain | Where does it live? | `eip155:42161/erc20:0x…` |
| Instrument type | What kind of claim is it? | backed note, depositary-style receipt, fund share, synthetic exposure |
| Backing model | What stands behind it? | fully backed by custodied shares, partially backed, collateralized, unbacked/synthetic |
| Redemption model | Can it be exchanged for the underlying, by whom, on what terms? | none, qualified-holders only, open redemption |
| Economic and shareholder rights | What does the holder actually receive? | dividends passed through, price-adjusted instead of paid, no economic rights, voting (rarely) |
| Synthetic vs backed | Is there an underlying asset, or only an exposure contract? | backed, synthetic |
| Corporate-action behaviour | How are splits, dividends and mergers applied? | on-chain supply adjustment, on-chain multiplier, off-chain NAV adjustment, issuer discretion |
| Settlement model | When and how does the holder's position become final? | atomic on-chain, deferred, issuer-confirmed |
| Trading restrictions | Who may hold or trade it, and when? | transfer allowlists, lockups, venue restrictions, trading-hours limits |
| Jurisdiction constraints | Where is it permitted? | issuance jurisdiction, prohibited holder jurisdictions |
| Operational state | Is it working right now? | active, issuer-paused, in transition, deprecated, `UNKNOWN` |

### 6.3 The four dimensions that most often decide a rejection

Most real rejections in the MVP will come from four dimensions, so these get
first-class treatment:

1. **Synthetic vs backed** — the single most common hard constraint, and the
   one most likely to be silently violated by a price-optimizing router.
2. **Issuer** — institutional policy is usually expressed as an issuer
   allowlist, and it is checkable with no market data at all.
3. **Corporate-action behaviour** — determines whether a pending event makes an
   authorization stale (§13), and differs between issuers for the same
   underlying.
4. **Operational state** — an issuer pause or an `UNKNOWN` state must block
   execution regardless of how attractive the quote is.

### 6.4 Metadata sourcing and trust

**Status: DRAFT.** Metadata will be wrong sometimes; the design must survive
that.

- Every metadata field carries **provenance** (issuer documentation, on-chain
  read, third-party data, manual curation) and an **as-of** timestamp.
- Fields that gate safety decisions are preferred from on-chain reads where
  the chain actually encodes them, because on-chain state is the state
  execution will occur against. Off-chain evidence is supporting, not
  authoritative, for such fields.
- A conflict between sources is recorded as a conflict and fails closed. It is
  never reconciled by preferring the more convenient source.
- Absent metadata is `UNKNOWN`. `UNKNOWN` on a field a mandate constrains is a
  rejection, not a default-permit. This is the fail-closed rule in §16, INV-5,
  and it is the reason the registry can start small without being unsafe: an
  unmodelled representation is simply not tradeable through Mandate.

### 6.5 Representation state vs representation metadata

Two different lifetimes, deliberately separated:

- **Metadata** is slow-moving structure: issuer, backing model, rights,
  redemption. It changes on the order of months and is curated.
- **State** is fast-moving and must be observed close to execution: operational
  status, pending adjustments, trading halts, corporate-action epoch, price.

Metadata staleness is a data-quality problem. State staleness is a *safety*
problem, and the verifier enforces explicit freshness bounds on state (§10).

## 7. Financial mandates

> **Status: DRAFT.** The concept and the MVP field set are settled; the full
> schema, encoding and signature format are not.

### 7.1 What a mandate is

A mandate is a machine-readable, signed, bounded authorization to perform a
financial action on behalf of a principal. It is the authorization artifact,
and it is the input the verifier checks against.

The natural-language request:

> "Buy $1,000 of NVDA exposure, backed instruments only, approved issuers
> only, no synthetic exposure, maximum 40 bps execution deviation, current
> corporate-action state required, and never execute while trading is halted."

is not a mandate. It is what a mandate is *authored from*. Translating it is a
deliberate, reviewable step, and the translation is not what gets enforced —
the resulting structured object is.

### 7.2 Conceptual field set

Grouped by what they constrain. This is the long-term vocabulary, not a schema.

**Identity and authority**

| Field | Purpose |
| --- | --- |
| principal | Who owns the assets and grants the authority |
| agent | Which agent identity may act under this mandate |
| mandate id | Stable identifier for audit and reference |

**Financial instruction**

| Field | Purpose |
| --- | --- |
| canonical asset | What is being bought or sold, as a canonical identity |
| action | Buy, sell, or other action types added later |
| maximum notional | Upper bound on value at risk, in a stated currency |
| price limit | Absolute bound on acceptable execution price |
| maximum execution deviation | Bound on deviation from the reference price, in bps |

**Instrument constraints**

| Field | Purpose |
| --- | --- |
| permitted instrument types | Which kinds of claim are acceptable |
| synthetic exposure allowed | Whether unbacked exposure is permitted at all |
| backing requirement | Minimum backing model |
| required rights | Economic or shareholder rights that must be present |
| permitted issuers | Issuer allowlist |
| jurisdiction constraints | Where the instrument may be held or traded |

**Venue and network constraints**

| Field | Purpose |
| --- | --- |
| permitted chains | Which networks may be used |
| permitted venues | Which execution venues may be used |

**State requirements**

| Field | Purpose |
| --- | --- |
| corporate-action freshness | How current corporate-action state must be |
| trading-halt policy | What to do when the underlying is halted |
| market-data freshness | Maximum acceptable age of price and state observations |

**Validity**

| Field | Purpose |
| --- | --- |
| not-before / expiry | The window in which this authorization is valid |
| nonce | Replay protection |
| mandate version | Schema version, so verification rules are unambiguous |

### 7.3 MVP mandate versus long-term mandate

The full vocabulary is not implemented in the buildathon. This table is the
commitment about what gets built first.

| Field | MVP | Long term | Note |
| --- | --- | --- | --- |
| principal | ✅ | ✅ | |
| agent | ✅ | ✅ | Single agent identity in MVP |
| mandate id | ✅ | ✅ | |
| canonical asset | ✅ | ✅ | Equity only in MVP |
| action | ✅ buy/sell | ✅ extended | |
| maximum notional | ✅ | ✅ | Single-currency in MVP |
| maximum execution deviation (bps) | ✅ | ✅ | |
| price limit | ⬜ | ✅ | Deviation bound covers the MVP demo |
| synthetic exposure allowed | ✅ | ✅ | Headline MVP constraint |
| permitted issuers | ✅ | ✅ | Headline MVP constraint |
| permitted instrument types | ⬜ | ✅ | Backed/synthetic split covers MVP |
| backing requirement | ⬜ | ✅ | |
| required rights | ⬜ | ✅ | Metadata modelled, not constrained in MVP |
| jurisdiction constraints | ⬜ | ✅ | Metadata modelled, not enforced in MVP |
| permitted chains | ✅ | ✅ | |
| permitted venues | ⬜ | ✅ | Single venue set in MVP |
| corporate-action freshness | ✅ | ✅ | Headline MVP constraint |
| trading-halt policy | ✅ | ✅ | Headline MVP constraint |
| market-data freshness | ✅ | ✅ | |
| expiry | ✅ | ✅ | |
| nonce | ✅ | ✅ | |
| mandate version | ✅ | ✅ | |
| portfolio-level constraints | ⬜ | ✅ | §22 |
| delegation / sub-mandates | ⬜ | ✅ | §22 |

Legend: ✅ in scope, ⬜ not in scope.

### 7.4 Design rules for the mandate schema

**SPECIFIED**, because these constrain everything built later:

1. **Versioned and explicit.** A mandate states its schema version. A verifier
   that does not understand the version rejects the mandate; it never
   interprets unknown fields leniently.
2. **Constraints are closed, not open.** Permissions are allowlists.
   An unspecified issuer is not permitted; an unmodelled instrument type is not
   permitted. Adding a field to the schema must not silently widen the
   authority of mandates already issued.
3. **No free text in the enforced object.** A mandate carries no prose that a
   verifier must interpret. Prose may be carried as an audit annotation that no
   decision reads.
4. **No addresses in the mandate.** A mandate names a canonical asset, not a
   contract. If it named a contract, a compromised authoring path could
   redirect funds while producing a perfectly valid mandate.
5. **Every quantity carries its unit.** Notional carries a currency; deviation
   carries basis points; timestamps carry a source and a zone. Unit ambiguity
   is a threat (§17), not a formatting concern.
6. **Bounded validity is mandatory.** A mandate without an expiry is not
   modelled. There is no "until revoked" authorization in the MVP, because
   revocation infrastructure does not exist in the MVP.

### 7.5 Open questions

Recorded so that Phase 1 resolves them deliberately, not incidentally:

- Signature scheme. EIP-712 typed data is the obvious candidate for an
  EVM-first system, and gives wallet-legible authorization. It also anchors the
  mandate to one signature ecosystem; a chain-agnostic envelope with
  per-ecosystem signature adapters is the alternative. **Unresolved.**
- Whether the canonical mandate encoding is JSON with a canonicalization rule,
  or a binary encoding. Canonicalization matters because the digest must be
  stable and collision-resistant. **Unresolved.**
- Whether a mandate is a single-use authorization or a reusable envelope with
  per-execution nonces. The MVP assumes single-use with a nonce. **Assumed.**
- How revocation works before expiry. Not in MVP. **Deferred.**

## 8. Agent authorization model

> **Status: SPECIFIED** for the principle; **DRAFT** for the mechanism.

### 8.1 The core separation

> A valid agent signature proves **who asked**. It does not prove **that the
> action is permitted**.

These are different questions with different answers, checked by different
components:

| Question | Component | Failure means |
| --- | --- | --- |
| Is this agent who it claims to be? | authentication | unknown caller |
| Did the principal authorize this agent at all? | mandate binding | unauthorized agent |
| Is *this specific action* inside the granted authority? | deterministic verifier | out-of-scope action |
| Is the on-chain action the one that was verified? | execution gate | substituted action |

Conventional agent stacks answer the first question, sometimes the second, and
treat the third as the model's job. Mandate's position is that the third
question is the one that matters and it must be answered by deterministic code.

### 8.2 Authority is bounded, not custodial

An agent operating under a mandate has authority bounded along every dimension
the mandate constrains: asset, side, notional, issuer set, instrument type,
chain set, price deviation, state freshness, and time. Outside those bounds it
has none.

This is a different model from approving a spending allowance. An allowance
bounds *how much* can be spent and nothing else. A mandate bounds *what the
spending may be for*, which is the dimension every failure in §2.1 violates.

### 8.3 Trust levels in the pipeline

Every input carries a trust level, and the levels determine what an input may
influence.

| Level | Sources | May influence |
| --- | --- | --- |
| **Authoritative** | The signed mandate; on-chain state read at execution | Anything, including admissibility |
| **Verified** | Registry entries under change control; market state from configured providers with freshness and provenance | Admissibility, subject to freshness checks |
| **Advisory** | Jev output; heuristic rankings | Ordering within the already-admissible set only |
| **Untrusted** | Model-authored text, tool responses, external content, user free text | Nothing. May be quoted in audit records; may never supply an address, an amount, or a constraint value |

The rule that does the work: **an address, an amount, or a constraint value
never originates from an untrusted or advisory source.** Addresses come from
the registry. Amounts come from the mandate and from quoted market state.
Constraints come from the signed mandate.

### 8.4 Agent identity

**DRAFT.** The MVP uses a single agent keypair named in the mandate, which is
sufficient to demonstrate binding and to reject an unauthorized signer. The
long-term design needs agent identities that survive key rotation, support
delegation chains (institution → desk → agent → sub-agent), and allow
revocation. That is future architecture (§22), and the MVP must not paint
itself into a corner by assuming "agent identity == one public key" anywhere
outside the verifier's input struct.

### 8.5 What the agent is genuinely good for

The model is not merely tolerated in this architecture; it is doing real work
that deterministic code is bad at:

- turning an ambiguous human request into a candidate structured mandate for
  review;
- disambiguating messy real-world references ("Nvidia", "NVDA", "the GPU
  company") into canonical asset candidates;
- interpreting unstructured issuer documentation into proposed metadata;
- ranking among admissible candidates using judgment about factors that resist
  full formalization.

In every one of those, the model's output is either reviewed by a human before
becoming authoritative, or constrained afterwards by the verifier. That is the
whole design: models propose, deterministic code disposes.

## 9. Execution lifecycle

> **Status: SPECIFIED** for the stage boundaries; **DRAFT** for each stage's
> interface.

### 9.1 Six stages, deliberately separated

Most agent trading stacks collapse these into one step. Mandate separates them
because each boundary is a place where a different class of attack is caught.

```
 1 INTENT          human or institutional financial instruction
        │          authored into a signed, machine-readable mandate
        ▼
 2 RESOLUTION      canonical asset  ->  candidate representations
        │          representations filtered by mandate instrument constraints
        ▼
 3 DISCOVERY       admissible representations  ->  execution candidates
        │          venues, routes, quotes, observed market state
        ▼
 4 SELECTION       candidates ranked; optionally by Jev            [ADVISORY]
        │          output is an ordering, never an authorization
        ▼
 5 VERIFICATION    deterministic check of the selected candidate   [AUTHORITATIVE]
        │          PASS with a verdict, or REJECT with reason codes
        ▼
 6 EXECUTION       submit only what was verified; on-chain gate re-asserts
        │          the binding between verdict and transaction
        ▼
 7 SETTLEMENT      position becomes final
        │
        ▼
 8 RECONCILIATION  receipt, audit trail, and comparison of intended
                   versus realized outcome
```

The numbering above lists eight boxes for seven named lifecycle concerns
because *selection* and *verification* are drawn separately on purpose: the
single most important structural property of Mandate is that stage 5 does not
trust stage 4.

### 9.2 What each stage is responsible for

| Stage | Input | Output | Must not do |
| --- | --- | --- | --- |
| Intent | Human instruction | Signed mandate | Interpret prose at execution time |
| Resolution | Mandate, registry | Admissible representations, or a resolution failure | Guess on ambiguity; accept an address from outside the registry |
| Discovery | Representations, market state | Execution candidates with quotes and state snapshots | Filter on quality; that is stage 4's job |
| Selection | Candidates | An ordering, and a chosen candidate | Add a candidate; relax a constraint; be trusted |
| Verification | Mandate, chosen candidate, state, clock | PASS or REJECT plus reason codes | Perform I/O; call a model; have a "proceed anyway" path |
| Execution | Verified candidate | Submitted transaction | Execute anything the verifier did not see |
| Settlement | Submitted transaction | Final position | Be assumed; it is observed |
| Reconciliation | All of the above | Execution receipt | Hide a discrepancy |

### 9.3 Stage boundaries as security boundaries

| Boundary | Attack it is there to catch |
| --- | --- |
| 1 → 2 | A mandate that does not reflect what the human authorized (caught by review, not by code) |
| 2 → 3 | Hallucinated or injected contract addresses: stage 3 can only see registry-resolved representations |
| 3 → 4 | A candidate set that already excludes inadmissible representations, so selection cannot pick one |
| **4 → 5** | **Model compromise, misclassification and prompt injection: whatever stage 4 chose is re-checked from scratch** |
| 5 → 6 | Substitution between verification and submission: the execution gate re-asserts the binding |
| 6 → 7 | Assuming submission equals settlement |
| 7 → 8 | Silent divergence between intended and realized execution |

### 9.4 Resolution failure is a normal outcome

Stage 2 fails closed and loudly:

- the ticker resolves to more than one canonical asset → `AMBIGUOUS`, reject;
- the canonical asset has no registered representations → reject;
- all representations are excluded by mandate constraints → reject, and report
  *which constraint* excluded each one;
- a representation has `UNKNOWN` in a field the mandate constrains → reject.

The per-representation exclusion reasons are part of the output, not a log
line. "No route found" is a useless answer; "issuer B excluded: not in
permitted issuers; issuer C excluded: synthetic, mandate forbids synthetic" is
an actionable one, and is what the demo shows.

## 10. Deterministic verification

> **Status: SPECIFIED.** This is the component Phase 1 builds and the one with
> the least room for later change.

### 10.1 The contract

The verifier is a pure function:

```
verify(mandate, candidate, observed_state, clock) -> Verdict
```

where `Verdict` is `PASS` or `REJECT`, always accompanied by reason codes, and
always accompanied by enough information to reproduce the decision.

Properties, all **SPECIFIED** and all testable:

1. **Pure.** No network, no filesystem, no clock reads, no randomness, no
   environment. Time enters as an explicit parameter. Every input is a value.
2. **Total.** Every input produces a verdict. It does not throw to signal a
   financial decision. Malformed input is `REJECT` with a reason code, not an
   exception that a caller might catch and ignore.
3. **Deterministic and reproducible.** Same inputs, same verdict, on any
   machine, at any later date. The audit record captures the inputs, so any
   past decision can be re-run and checked.
4. **Fail-closed.** There is no path that permits execution when the verifier
   could not establish that every constraint holds. `UNKNOWN` is a value that
   causes rejection, never a value that is skipped.
5. **Model-free.** No model is called, directly or transitively. This is
   structural, not a convention: the verifier's dependency graph must not
   contain an inference client.
6. **Explaining.** A rejection names every violated constraint, not just the
   first. A caller fixing one reason should not discover a second on the next
   attempt.
7. **Order-independent.** The verdict does not depend on the order checks run
   in. Checks are evaluated for their union of violations.

### 10.2 Check families

Grouped by what they need. Cheap, dependency-free checks are listed first
because they can run before any market data is fetched.

**A. Mandate integrity** — needs only the mandate.

- schema version understood;
- signature valid over the canonical encoding;
- principal and agent well-formed;
- required fields present; no unknown fields silently accepted;
- constraint values in range and carrying units.

**B. Authorization scope** — mandate and clock.

- mandate not expired, and not used before its not-before time;
- nonce unused (replay protection);
- the acting agent is the agent named in the mandate;
- the requested action matches the authorized action.

**C. Asset identity** — mandate, candidate, registry.

- the candidate's representation maps to the mandate's canonical asset;
- the representation's contract is the registry's contract, byte-for-byte;
- the chain is a permitted chain, identified by chain ID.

**D. Representation semantics** — candidate metadata and mandate constraints.

- issuer in the permitted set;
- instrument type permitted;
- synthetic exposure permitted, if the representation is synthetic;
- backing requirement satisfied;
- required rights present;
- jurisdiction constraints satisfied;
- no constrained field is `UNKNOWN`.

**E. Economic bounds** — candidate quote and mandate limits.

- notional within maximum notional;
- execution price within the price limit;
- expected deviation within the maximum execution deviation;
- amounts and decimals internally consistent; units explicit.

**F. Market and corporate-action state** — observed state, clock, mandate.

- price observation within the mandate's freshness bound;
- corporate-action state within the mandate's freshness bound;
- no pending corporate action invalidating the authorization (§13);
- underlying not halted, or halted and the mandate's halt policy permits it;
- representation operational state is active, not paused, not `UNKNOWN`.

**G. Intent fidelity** — the candidate versus the mandate as a whole.

- the candidate does not differ materially from the principal's instruction in
  any way the individual checks above would not catch;
- venue permitted;
- the transaction the execution gate will submit is the one verified (§14.3).

### 10.3 Reason codes

**SPECIFIED as a requirement; DRAFT as a list.** Reason codes are a public
interface: they appear in receipts, in the demo, in integrator error handling,
and in audit records. Rules:

- stable and namespaced (`MND-<FAMILY>-<NNN>`);
- one code per distinct cause, never a generic `INVALID`;
- a code is never reused for a different meaning; retired codes stay retired;
- each code carries a human-readable explanation, and the explanation is data,
  not a string built at the call site.

Illustrative, to fix the shape — not the final registry:

| Code | Family | Meaning |
| --- | --- | --- |
| `MND-AUTH-001` | Authorization | Mandate expired |
| `MND-AUTH-002` | Authorization | Nonce already used (replay) |
| `MND-AUTH-003` | Authorization | Acting agent is not the mandate's agent |
| `MND-ASSET-001` | Identity | Representation does not map to the mandate's canonical asset |
| `MND-ASSET-002` | Identity | Contract address is not the registry's address |
| `MND-ASSET-003` | Identity | Ticker resolution ambiguous |
| `MND-REPR-001` | Semantics | Issuer not in permitted issuers |
| `MND-REPR-002` | Semantics | Synthetic instrument, mandate forbids synthetic exposure |
| `MND-REPR-003` | Semantics | Required economic right absent |
| `MND-REPR-004` | Semantics | Constrained metadata field is UNKNOWN |
| `MND-ECON-001` | Economics | Notional exceeds authorized maximum |
| `MND-ECON-002` | Economics | Execution deviation exceeds mandate limit |
| `MND-STATE-001` | State | Price observation older than the mandate's freshness bound |
| `MND-STATE-002` | State | Corporate-action state stale |
| `MND-STATE-003` | State | Pending corporate action invalidates this authorization |
| `MND-STATE-004` | State | Underlying is halted and the mandate forbids halted execution |
| `MND-STATE-005` | State | Representation is issuer-paused |
| `MND-NET-001` | Network | Chain not permitted |
| `MND-NET-002` | Network | Venue not permitted |

### 10.4 Why the verifier does no I/O

Purity is not stylistic. It buys four properties that matter more than
convenience:

1. **Testability.** Every rejection path can be exercised as a table-driven
   test with no mocks. The failure modes are where the value is, so they have
   to be cheap to test exhaustively.
2. **Auditability.** Because inputs are values, the audit record can contain
   them, and any decision is re-runnable years later.
3. **Attack-surface reduction.** A verifier that fetches its own data can be
   attacked through its data source. A verifier handed explicit values can only
   be attacked by lying to the caller, which the freshness and provenance
   checks then examine as data.
4. **Portability.** The same decision logic can run off-chain, in a service, in
   a wallet, and — for the subset expressible on-chain — inside the execution
   gate, without behavioural drift.

### 10.5 Differential verification

**DRAFT, high value.** The same decision existing in more than one place (an
off-chain verifier and an on-chain gate, or two independent implementations)
creates the risk of divergence, and divergence in a safety gate is a
vulnerability.

Planned mitigation, carried over as methodology from prior work (§24): a shared
corpus of decision vectors — inputs plus expected verdict and reason codes —
that every implementation is tested against, plus property tests over generated
inputs asserting that independent implementations agree on every case.

## 11. Jev's role and its limits

> **Status: DRAFT.** The role and the constraints are settled. The integration
> surface is not, and is deferred to Phase 5.

### 11.1 What Jev may do

Jev may participate in stages where judgment helps and where being wrong is
recoverable:

- **Candidate classification** — proposing a structured reading of messy
  representation metadata.
- **Candidate ranking** — ordering already-admissible candidates.
- **Candidate selection** — choosing one from the already-admissible set.
- **Disambiguation support** — proposing canonical asset candidates for an
  ambiguous human reference, for review.
- **Explanation** — rendering a deterministic verdict into readable language
  *after* the verdict exists.

### 11.2 What Jev may never do

**SPECIFIED, and enforced structurally rather than by convention:**

- Jev is never the final authorization authority.
- Jev may not add a candidate that resolution and admissibility did not
  produce.
- Jev may not relax, reinterpret, or override any mandate constraint.
- Jev may not supply a contract address, a chain ID, an amount, or a
  constraint value.
- Jev's output is never an input to the verifier's decision. The verifier
  receives the *candidate*, not Jev's reasoning about it, and does not know
  whether Jev was involved.
- Jev's absence, failure, timeout, or nonsense output must never cause an
  unsafe execution. It causes a fallback to deterministic ranking, or a
  refusal — never a relaxation.

### 11.3 The structural property

The set of executions Mandate permits is **identical** whether Jev is present,
absent, broken, or adversarial.

Jev influences *which* admissible candidate is chosen and *how fast*. It cannot
influence *whether* a candidate is permitted. A compromised Jev degrades
execution quality within the mandate's bounds; it does not produce an execution
outside them.

This is stated as invariant INV-3 in §16 and should be established by test: run
the pipeline with a deliberately adversarial Jev stub that always returns the
worst or most dangerous answer, and assert that no execution occurs that the
deterministic path would not also have permitted.

### 11.4 The integration surface

```
admissible candidates  ──▶  [ Jev ]  ──▶  selected candidate
                                              │
                                              ▼
                                      [ deterministic verifier ]
                                              │
                                    PASS ─────┴───── REJECT
```

Constraints on the interface (**DRAFT**):

- Jev receives a **closed set** and returns an **index into it**, or an
  abstention. It does not return a candidate object, because returning an
  object is an opportunity to return a modified one.
- Jev's call is bounded by a timeout and a token budget; exceeding either is an
  abstention, not an error that blocks the pipeline.
- Jev's input, output, model identity and version are recorded in the audit
  trail, so a bad selection can be attributed later.
- Jev never sees the principal's signing material, and nothing it returns is
  passed to a signer.

### 11.5 Open questions

- Jev's concrete API, latency profile, and cost per call are not yet
  characterized in this repository. Phase 5 begins with that characterization,
  not with integration. **Unresolved — do not assume capabilities.**
- Whether Jev is worth using for classification of representation metadata
  (a slow, reviewable, high-value task) or only for ranking (a fast, low-value
  task) should be decided by measurement, not assumption. **Unresolved.**

## 12. Routing architecture

> **Status: DRAFT.** Two-stage structure is settled; the ranking function and
> the venue adapter interface are not.

### 12.1 Admissibility before quality

```
canonical asset
      │
      ▼
[ registry ] ──▶ all known representations
      │
      ▼
[ admissibility filter ]          deterministic, fail-closed
      │                           mandate instrument constraints
      ▼
admissible representations
      │
      ▼
[ venue / route discovery ] ──▶ execution candidates, with quotes
      │                          and observed state snapshots
      ▼
[ admissibility filter, again ]   economic and state constraints
      │                           now that quotes exist
      ▼
admissible candidates ───▶ [ ranking ] ───▶ ordered candidates
                                                  │
                                                  ▼
                                         [ Jev, optional ] ──▶ selected
                                                  │
                                                  ▼
                                         [ verifier ] ──▶ PASS / REJECT
```

Admissibility filtering runs twice because some constraints (issuer, instrument
type) can be evaluated before quoting and should be, to avoid pointless market
data calls, while others (notional, deviation, price) need a quote.

Critically, the filter running before ranking does not make the verifier
redundant. The verifier re-checks everything, because the filter's output
passes through a ranking stage and an optional model, and the verifier's job is
to trust neither.

### 12.2 Execution candidates

**DRAFT.** A candidate is a fully specified, self-describing execution
proposal — everything the verifier needs, with nothing to look up:

| Group | Content |
| --- | --- |
| Representation | Which representation, resolved from the registry |
| Venue and route | Which venue, which path, which contracts |
| Economics | Input amount, expected output, reference price, expected deviation, fees, all with units and decimals |
| State snapshot | Observed market state, corporate-action state, operational state — each with source, provenance and observation time |
| Binding | A commitment to the exact transaction that would be submitted |

The candidate carries its own state snapshot rather than referencing shared
mutable state, so the verifier's decision is over a fixed, recordable object.

### 12.3 Ranking

**DRAFT.** Among admissible candidates, ranking considers expected execution
quality, liquidity depth relative to the notional, fees and gas, state
confidence, and settlement characteristics.

One rule is **SPECIFIED**, because it is the cross-representation version of
the amount-comparison problem in §4.2:

> Candidates on different representations are never compared by raw token
> output. Comparison happens in an economically meaningful common unit, with
> explicit arithmetic, explicit rounding, and a cost that rounds against the
> substitution rather than in favour of it.

If two candidates cannot be compared in a common unit with a defensible
computation, they are not comparable and the system does not pretend otherwise.

### 12.4 Substitution between representations

Substituting issuer B's representation for issuer A's is a financial decision,
not a routing optimization, because the two instruments differ (§5.4).

**SPECIFIED:** substitution requires explicit authorization. Either the mandate
permits a set of issuers and is indifferent among them — in which case any
member is not a substitution but an authorized choice — or a change of
representation outside what the mandate authorized requires new authorization.
There is no silent reroute, and a better price never implies consent.

### 12.5 Venue adapters

**DRAFT.** Each venue is an adapter behind a common interface: quote, build,
and report state. Design rules, carried over as lessons from prior work:

- adapters are independent and do not share assumed semantics;
- an adapter that cannot express a venue's semantics fails closed rather than
  approximating;
- an adapter reports what it observed with provenance, and does not normalize
  away a conflict;
- adding an adapter must not require changing the verifier.

## 13. Corporate actions

> **Status: SPECIFIED** as an invariant; **DRAFT** as a mechanism.

### 13.1 Why this is a correctness requirement, not a feature

A corporate action changes what one unit of an asset *means*. A 4:1 split makes
one pre-split share equal four post-split shares. An authorization written
against pre-split economics, executed against post-split economics, is wrong by
a factor of four — not by basis points.

This is why corporate-action awareness cannot be a UI nicety or an advisory
warning. It is a term in the correctness condition of execution.

### 13.2 Events in scope

| Event | Effect on authorization |
| --- | --- |
| Dividend | Depends on representation: passed through, or reflected as a price adjustment. Affects reference price and expected economics |
| Stock split | Changes unit meaning. Material |
| Reverse split | Changes unit meaning. Material |
| Merger | May map the canonical asset onto a different one, or onto cash. Material |
| Spin-off | Creates a new canonical asset and changes the original's economics. Material |
| Symbol change | Changes the display alias, not the canonical identity — and is exactly why the alias is not the identity |
| Conversion | Changes the instrument. Material |

### 13.3 The staleness invariant

> A financial authorization created under corporate-action state **S** must not
> execute under state **S'** when the change from S to S' is material to the
> authorization.

Consequences:

- a mandate binds to the corporate-action state it was authored under;
- a material change makes the mandate **stale**, and a stale mandate does not
  execute;
- recovery from staleness is **reauthorization**, not an automatic adjustment.
  Silently rescaling a notional across a split substitutes the system's
  judgment for the principal's, which is the failure mode Mandate exists to
  prevent.

### 13.4 Corporate-action epoch

**DRAFT.** Proposed mechanism: every canonical asset carries a monotonically
increasing **corporate-action epoch**, incremented on any event material to
execution economics. A mandate records the epoch it was authored under; the
verifier rejects when the observed epoch differs.

Why an epoch counter rather than comparing event lists:

- it makes the check a cheap integer comparison, suitable for an on-chain gate;
- it makes staleness explicit and auditable rather than inferred;
- it is asset-class agnostic, so it extends to bonds, funds and treasuries
  without redesign.

Open questions, to be resolved before implementation:

- who is authoritative for incrementing the epoch, and how that authority is
  itself constrained;
- how epoch data is distributed, and its own freshness bound — an epoch feed is
  itself state that can be stale;
- how a scheduled but not yet effective action is represented: an authorization
  written shortly before a known upcoming split is arguably already unsafe.
  The prior work's approach — a refusal window around a scheduled activation,
  with the phase before and after treated as part of the protected state — is
  the leading candidate. See §24.

### 13.5 Scheduled transitions and the clock

A lesson carried directly from the prior codebase and worth stating plainly:

> Economic state includes the clock. State can change meaning at a scheduled
> instant without any observable change to stored data.

A system that compares stored bytes and concludes "nothing changed" is wrong
whenever an adjustment activates on a timestamp. Therefore any Mandate state
comparison must include *which* of the stored values is effective at the
evaluation time, and time used for a safety decision must come from the chain's
clock at execution, not from a wall clock at decision time.

## 14. Settlement

> **Status: DRAFT** for the MVP; **FUTURE** for settlement abstraction.

### 14.1 Submission is not settlement

Three distinct facts, often conflated:

1. a transaction was **submitted**;
2. a transaction was **included** and did not revert;
3. the principal's **position** is final.

A Mandate receipt reports what it observed, at whichever of these it reached,
and never asserts a later stage than it verified.

### 14.2 MVP settlement model

Atomic on-chain settlement on a single chain: the execution succeeds
completely, or it reverts and nothing settles. Atomicity is what makes the
execution gate meaningful — a gate that rejects must be able to prevent
everything else in the transaction from taking effect.

### 14.3 The execution gate

**DRAFT.** Off-chain verification decides; something must then ensure the
submitted transaction is the verified one. Between a PASS and inclusion there
is a window in which the transaction can be substituted, reordered, delayed
into stale state, or partially replaced.

The intended mechanism, carried over conceptually from prior work:

- the verified candidate produces a **commitment** to the exact action —
  target contract, function, accounts/parameters, amounts, and the economic
  state asserted;
- an on-chain gate instruction accompanies the action in the same atomic unit;
- at execution time the gate re-reads the state it can read on-chain, compares
  against the commitment, and reverts on any mismatch;
- the gate verifies *its own position* relative to the action it protects, so
  ordering is not left to the transaction builder's good behaviour;
- the gate is read-only and side-effect free: adding it cannot change the
  outcome of a transaction that would otherwise have succeeded with unchanged
  state.

What the gate can enforce is bounded by what the chain can observe. It can
enforce that the action is the committed one and that on-chain economic state
matches the expectation. It cannot enforce facts that exist only off-chain,
such as whether the principal genuinely intended the notional. Those remain
off-chain checks, and the boundary must be stated rather than blurred.

### 14.4 Settlement abstraction

**FUTURE.** Deferred settlement, issuer-confirmed settlement, cross-chain
settlement, and netting all break the atomicity assumption in §14.2. They
require a settlement-state machine with pending states, timeouts and failure
recovery. Recorded here so the MVP's atomic assumption is a stated assumption
rather than an invisible one.

## 15. Audit and reconciliation

> **Status: DRAFT.**

### 15.1 The execution receipt

Every execution attempt — successful or rejected — produces a structured
receipt. Rejections produce receipts too; a refusal that leaves no record is
not auditable.

A receipt contains:

| Section | Content |
| --- | --- |
| Authorization | Mandate identifier, digest, principal, agent, expiry, nonce |
| Intent | Canonical asset, action, limits as authorized |
| Resolution | Representations considered, and why each was admitted or excluded |
| Candidates | Candidates discovered, their economics and state snapshots |
| Advisory | Whether Jev was consulted, what it received, what it returned, model identity and version |
| Verdict | PASS or REJECT, every reason code, and the inputs the verdict was computed over |
| Execution | What was submitted, where, and the observed result |
| Reconciliation | Intended versus realized economics, and any discrepancy |

### 15.2 Explainability requirement

> Every execution and every refusal must be explainable from its receipt alone,
> without re-running the pipeline and without access to a model.

This is stronger than logging. It means the receipt contains the *inputs* to
the decision, not only the outputs, so the verifier can be re-run over them and
must produce the same verdict (§10.1, property 3). A receipt whose verdict is
not reproducible from its own contents indicates either a non-deterministic
verifier or an incomplete receipt; both are defects.

### 15.3 Reconciliation

Comparison of intended versus realized: expected against actual execution
price, expected against actual quantity, assumed against observed state,
selected against executed venue. A discrepancy is surfaced, never smoothed.

**FUTURE:** portfolio-level reconciliation, cross-venue position aggregation,
and reporting exports.

### 15.4 Attestations

**FUTURE.** Signed, independently verifiable attestations that a specific
execution satisfied a specific mandate — useful for institutional reporting and
for third parties who did not observe the execution. Noted so that receipts are
designed to be attestable later: stable digests, canonical encoding, no
dependence on mutable external references.

## 16. Major invariants

These are the properties that define Mandate. A change that breaks one is a
change to the product, not an implementation detail. Each is stated so it can
be tested; none is implemented in Phase 0.

| ID | Invariant | Where it will be enforced |
| --- | --- | --- |
| **INV-1** | Human intent is authoritative. No component may widen authority beyond the signed mandate. | Verifier |
| **INV-2** | A valid agent signature alone never authorizes a financial action. Authentication and authorization are separate checks. | Verifier |
| **INV-3** | The set of permitted executions is identical whether Jev is present, absent, failed or adversarial. | Verifier; pipeline structure; adversarial-stub test |
| **INV-4** | Model output never supplies an address, an amount, or a constraint value. | Pipeline structure; type boundaries |
| **INV-5** | Fail closed. `UNKNOWN` state, unparseable data, missing metadata on a constrained field, and unrecognized schema versions all reject. There is no "proceed anyway" path. | Verifier |
| **INV-6** | Canonical financial identity is distinct from token identity, and equivalence between representations is never inferred from shared underlying. | Registry model; verifier |
| **INV-7** | Contract addresses used in execution come from the registry, never from a model, a tool response, or free text. | Resolution stage; type boundaries |
| **INV-8** | Optimization occurs only over candidates that already satisfy every mandate constraint. | Routing structure |
| **INV-9** | Corporate-action state is part of execution correctness. A materially stale authorization does not execute. | Verifier; epoch check |
| **INV-10** | Economic state includes the clock. Comparisons account for which stored value is effective at evaluation time, and safety-critical time comes from the chain at execution. | Verifier; execution gate |
| **INV-11** | Every execution and every refusal is explainable and reproducible from its receipt. | Receipt model; verifier purity |
| **INV-12** | Replay protection: an authorization is consumed, and a consumed or expired authorization never executes. | Verifier; execution gate |
| **INV-13** | The transaction submitted is the transaction verified. | Execution gate |
| **INV-14** | No silent substitution between representations. | Routing; verifier |
| **INV-15** | Cross-representation comparison is never by raw token amount, and a substitution cost is never understated. | Ranking; explicit arithmetic |
| **INV-16** | Safety decisions are never made on floating-point equality. Values that gate execution are compared in exact representations. | Verifier |
| **INV-17** | Every observed state input carries provenance and an observation time, and is subject to an explicit freshness bound. | Candidate model; verifier |
| **INV-18** | Every quantity carries its unit and its decimals. Unit-less quantities are not representable. | Type design |

INV-16 and INV-18 look like implementation hygiene and are not: both are
listed as threats in §17, both have produced real financial bugs in production
systems, and both are cheap to enforce structurally and expensive to retrofit.

## 17. Threat model overview

> **Status: DRAFT.** Phase 0 enumerates and assigns. It solves nothing — no
> component exists. Each row names the component that must address the risk and
> the phase that introduces it.

Statuses: **DESIGN** — the design addresses it and the component is planned.
**PARTIAL** — the design reduces it but cannot close it. **OPEN** — not
addressed by the current design; recorded deliberately.

### 17.1 Agent and model compromise

| Threat | Addressed by | Phase | Status |
| --- | --- | --- | --- |
| Compromised agent acts outside intent | Deterministic verifier; bounded mandate authority (INV-1, INV-2) | 1 | DESIGN |
| Hallucinated token address | Registry-only address resolution (INV-7); agent never supplies addresses | 2 | DESIGN |
| Prompt injection steers the agent | Trust levels (§8.3); untrusted input influences nothing; verifier independent of agent reasoning | 1–2 | DESIGN |
| Malicious tool response | Same as above; tool output is untrusted and cannot supply addresses, amounts or constraints | 1–2 | DESIGN |
| Jev misclassification or adversarial Jev | INV-3; verifier re-checks; adversarial-stub test | 1, 5 | DESIGN |
| Agent authored a mandate that does not reflect intent | Human review of the mandate before signing. **Not a code control** | — | PARTIAL |

### 17.2 Identity and representation

| Threat | Addressed by | Phase | Status |
| --- | --- | --- | --- |
| Ticker collision | Tickers are aliases, not identity; ambiguous resolution rejects (§5.2) | 2 | DESIGN |
| Fake or counterfeit token | Registry allowlist; `UNKNOWN` fails closed (INV-5) | 2 | DESIGN |
| Wrong issuer | Issuer allowlist in mandate; verified against registry metadata | 1–2 | DESIGN |
| Unsupported representation semantics | Unmodelled semantics reject rather than being approximated (§6.4) | 2 | DESIGN |
| Registry itself is wrong or compromised | Change control, provenance, on-chain preference for safety-critical fields. Residual risk | 2 | PARTIAL |

### 17.3 State and timing

| Threat | Addressed by | Phase | Status |
| --- | --- | --- | --- |
| Stale price | Freshness bounds with provenance (INV-17) | 1, 3 | DESIGN |
| Stale corporate-action state | Epoch binding; freshness bound (INV-9) | 1, 3 | DESIGN |
| Scheduled transition crosses during flight | Clock-aware state comparison at execution (INV-10); refusal window | 3, 6 | DESIGN |
| Market halt | Halt policy in mandate; state check | 1, 3 | DESIGN |
| Stale mandate (expired) | Expiry check (INV-12) | 1 | DESIGN |
| Replay of a mandate | Nonce consumption (INV-12) | 1, 6 | DESIGN |
| Market-data provider lies | Provenance, conflict detection, fail-closed on conflict; on-chain preferred where available | 3 | PARTIAL |

### 17.4 Execution

| Threat | Addressed by | Phase | Status |
| --- | --- | --- | --- |
| Amount mutation between decision and submission | Commitment binding; execution gate (INV-13) | 6 | DESIGN |
| Decimal or unit mistake | Units and decimals mandatory on every quantity (INV-18); exact arithmetic (INV-16) | 1 | DESIGN |
| Malicious route provider | Routes are candidates, not instructions; verifier re-checks; commitment binding | 4, 6 | DESIGN |
| Candidate differs materially from intent | Intent-fidelity checks (§10.2 family G) | 1 | DESIGN |
| Partial execution | Atomic settlement in MVP (§14.2); non-atomic settlement is FUTURE and unaddressed | 6 | PARTIAL |
| Bridge failure | Out of MVP scope; cross-chain is FUTURE | 9+ | OPEN |
| MEV, sandwiching, ordering | Deviation bounds limit economic damage; not otherwise addressed | 4, 6 | PARTIAL |
| Gate program upgraded between verification and execution | Pin deployment identity and re-check before submission; immutable or timelocked deployment needed in production | 6 | PARTIAL |

### 17.5 Surrounding system

| Threat | Addressed by | Phase | Status |
| --- | --- | --- | --- |
| Frontend compromise | Mandate signed by the principal; a compromised frontend can request a bad mandate, so the signing surface must display what is being authorized in financial terms | 8 | PARTIAL |
| Principal's key compromise | Out of scope. Mandate assumes the principal's signing key is sound | — | OPEN |
| RPC lies about the network | Chain identity from chain ID, checked against the submission target (§5.3) | 3 | DESIGN |
| Registry supply chain / dependency compromise | Standard supply-chain hygiene: pinned dependencies, lockfiles, audit in CI | 1+ | PARTIAL |
| Observability data leaking principal information | Receipt design; not yet analysed | 8 | OPEN |

### 17.6 Honest statement of limits

Recorded now so no later document overstates the system:

- Mandate constrains execution to an authorization. It cannot determine whether
  the authorization reflects what a human *meant*. Mandate protects the
  mandate, not the intention behind it.
- Mandate cannot make a bad instrument good. It can refuse one the mandate
  forbids.
- On-chain enforcement is bounded by what the chain can observe. Off-chain
  facts stay off-chain checks.
- Metadata quality bounds decision quality. A registry that misclassifies a
  synthetic instrument as backed will pass a mandate that forbids synthetics,
  and no amount of verification logic fixes that.

## 18. Robinhood Chain and Arbitrum initial integration

> **Status: EXPLORATORY** on specifics; **DRAFT** on structure.

### 18.1 Why this environment first

Tokenized equities on Robinhood Chain / Arbitrum-compatible infrastructure give
the MVP a real instance of the problem this document describes: real tokenized
equity representations, an EVM execution environment with mature tooling, and
Arbitrum-compatible semantics that keep the work portable across the broader
Arbitrum ecosystem.

### 18.2 What the integration must supply

Structural requirements, independent of the specific endpoints:

| Need | Why |
| --- | --- |
| Chain identity by chain ID | INV: never trust an RPC's claim about its network (§5.3) |
| Representation discovery and metadata | The registry's equity entries (§6) |
| Market state: price, liquidity, venue quotes | Economic-bound checks (§10.2 family E) |
| Operational state: pause, transfer restrictions | Representation state checks (§10.2 family F) |
| Corporate-action state or epoch source | The staleness invariant (§13.3) |
| Transaction construction and submission | Execution (§9, stage 6) |
| Testnet environment | Execution proof without financial risk |

### 18.3 What is not yet known

Stated plainly rather than assumed, because assuming here would produce an
architecture that does not fit reality:

- exact available endpoints, their rate limits, and their freshness guarantees;
- whether corporate-action state is available on-chain, from an issuer API,
  only from third-party data, or not at all — this materially affects §13.4;
- which venues are available and what their quoting interfaces look like;
- what the testnet environment supports;
- whether on-chain adjustment mechanisms exist for tokenized equity
  representations in this environment, and in what form.

**Phase 3 begins with answering these empirically**, and the answers may change
the corporate-action mechanism in §13.4. This document should be revised when
they are known rather than being written as if they already are.

### 18.4 Adapter boundary

Everything environment-specific lives behind an adapter (§12.5). The verifier,
the mandate types, the registry model and the receipt model must contain no
Arbitrum-specific or Robinhood-Chain-specific assumption. The test of this
design rule: adding a second chain in a later phase must not require modifying
the verifier.

## 19. Stablecoin funding as a supporting layer

> **Status: FUTURE.** Not in the MVP.

### 19.1 The problem it solves

A principal expressing "$1,000 of NVDA exposure" is expressing a fiat-
denominated intent. Execution requires a specific funding asset — some
stablecoin, on some chain, with some liquidity and some depeg risk. Making the
principal or the agent reason about *which* stablecoin reintroduces exactly the
class of blockchain detail Mandate exists to hide.

### 19.2 What a funding layer would need

- a notion of acceptable funding assets, constrained by the mandate the same way
  instruments are;
- stablecoin representation semantics — issuer, backing, redemption, depeg
  history — modelled with the same care as asset representations, because
  "a dollar" is also a claim with an issuer;
- funding-route discovery and conversion costs folded into execution economics,
  so the deviation bound covers the full path;
- failure handling when funding succeeds and execution does not.

### 19.3 MVP position

The MVP assumes funding is already in place in a single, configured asset. This
is an explicit simplification, not an oversight. What the MVP must avoid is
*assuming a single funding asset structurally* — the notional and the funding
asset are separate concepts in the type design from the beginning, so the
layer can be added without reworking the mandate.
