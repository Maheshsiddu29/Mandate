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
