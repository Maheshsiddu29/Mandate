# Mandate — Design Specification

Canonical, long-term design document for Mandate. Other documents in this
repository summarize parts of this one and link back to it; this file is the
source of truth.

- **Document status:** canonical specification.
- **Implementation status:** Phase 2 complete — the mandate core kernel
  (types, canonical encoding, EIP-712 authorization, deterministic verifier,
  receipts, replay semantics, decision-vector corpus) and the canonical asset and
  representation registry (identifier schemes, reference resolution,
  provenance-carrying representation metadata, mandate-constrained admissibility,
  deterministic snapshots, registry decision vectors). Everything else in this
  document remains unbuilt.
- **Last structural revision:** Phase 2.

## How to read status labels

Because this document describes a complete system while the repository
contains none of it, every major capability carries a maturity label. The
labels describe how settled the *design* is, not how much code exists.

| Label | Meaning |
| --- | --- |
| **IMPLEMENTED** | Built in this repository and covered by tests. |
| **SPECIFIED** | Design is settled enough to implement against without another design round. Expected to change only at the margins. |
| **DRAFT** | Shape is agreed, field-level and interface-level details are still open. Implementing it will force decisions this document does not make. |
| **EXPLORATORY** | Direction only. Recorded so it is not reinvented, not because it is decided. Likely to change materially. |
| **FUTURE** | Deliberately out of scope for the buildathon and for the near-term roadmap. Written down to constrain today's abstractions, not to be built soon. |

A capability labelled **IMPLEMENTED** exists in this repository and is covered
by tests. Everything else should be read as what Mandate is *specified to do*,
not what it does. See [Buildathon MVP scope](#20-buildathon-mvp-scope) for what
is being built first, and [roadmap.md](roadmap.md) for current phase status.

As of Phase 2 the implemented surface adds the canonical asset and representation
registry (§5, §6) on top of Phase 1's kernel: the mandate type and its canonical
encoding, the EIP-712 authorization adapter, the deterministic verifier, the
reason-code registry, verification receipts, and replay semantics — all in
`packages/kernel`, with a cross-implementation decision-vector corpus in
`corpus/v1`.

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

> **Status: IMPLEMENTED.** The identity model, the identifier scheme vocabulary
> and the registry format are built in `packages/registry`
> ([registry-semantics.md](registry-semantics.md),
> [ADR 0005](adr/0005-canonical-asset-identity-and-resolution.md)).

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

Identifier shape (**IMPLEMENTED**):

```
mandate:asset:<asset-class>:<scheme>:<value>

mandate:asset:equity:figi:BBG000BBJQV0        # NVIDIA Corp common stock
mandate:asset:equity:isin:US67066G1040
mandate:asset:treasury:cusip:912797GN1
```

Design rules for the identifier (**IMPLEMENTED**):

- The identifier is opaque to consumers. Nothing parses it to infer behaviour.
- `<scheme>` is a **closed vocabulary** — `figi`, `isin`, `cusip` — and a scheme
  value is **check-digit validated** rather than stored as supplied, so a
  single-character typo cannot become a different canonical asset. `<asset-class>`
  is closed for the same reason: it is part of identity, and a free-form identity
  field is how a phantom asset gets created.
- `<scheme>` records *which external identifier system* establishes identity,
  because different asset classes have different authorities (FIGI/ISIN for
  equities, CUSIP for many US instruments, LEI for issuers, and others for
  asset classes Mandate has not yet modelled).
- `MIC:ticker` (e.g. `XNAS:NVDA`) is a **display alias and a lookup key**,
  never the identity. Resolution from a human-supplied ticker to a canonical
  asset is an explicit, auditable step that can fail or return an ambiguity,
  and an ambiguous resolution fails closed rather than picking a favourite.
  The market identifier is an ISO 10383 **MIC** (`XNAS`), not an exchange name
  (`NASDAQ`); an exchange-name form resolves only where a curator registered it
  as an alias
  ([ADR 0005](adr/0005-canonical-asset-identity-and-resolution.md)).
- The identifier carries no chain, no contract, and no issuer.
- A canonical asset is versionless, but its *state* (see §13) is not: symbol
  changes, splits and mergers change the asset's corporate-action epoch, and
  in the case of a merger may map one canonical asset onto another.

The `<asset-class>` segment exists so the scheme extends beyond equities
without a redesign; see §23.

### 5.3 Representation identity

A representation is identified by chain plus contract, using a CAIP-19-style
encoding (**IMPLEMENTED**):

```
eip155:42161/erc20:0x<address>
```

Rules (**IMPLEMENTED**):

- Chain identity comes from a chain ID, not from an RPC URL, a hostname, or a
  human-readable network name. An RPC endpoint is a data source and can lie
  about which network it serves; the chain ID is checked against the network
  the transaction is actually submitted to.
- Contract address is the only address that matters, and it comes from the
  registry, never from a model, a tool response, or user free text. It is
  validated and canonicalized: a mixed-case address is accepted only if its
  EIP-55 checksum verifies, and a broken checksum is a rejection rather than a
  repair.
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

> **Status: IMPLEMENTED.** The metadata dimensions, the value vocabularies and
> the trust and conflict rules for sourcing them are built in
> `packages/registry` ([registry-semantics.md](registry-semantics.md) §6,
> [ADR 0006](adr/0006-representation-claims-and-conflict-policy.md)). The
> vocabularies are expected to grow as Phase 3 learns what real issuers publish;
> growing one is a registry schema-version change and cannot affect a mandate
> digest.

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

**Status: IMPLEMENTED.** Metadata will be wrong sometimes; the design must
survive that. Each dimension is a *set of claims*, each carrying provenance and an
observation time, resolved against a `VERIFIED` trust floor. The rule that took
the most care: a claim **below** the floor can neither establish a value **nor
create a conflict** — otherwise anyone able to inject an advisory claim could make
any representation inadmissible
([ADR 0006](adr/0006-representation-claims-and-conflict-policy.md)).

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

### 7.5 Resolved questions

Phase 1 settled the three questions this section previously left open. Each has
an ADR; the reasoning is not repeated here.

- **Signature scheme — RESOLVED.** The canonical mandate stays chain-agnostic;
  an authorization envelope binds a signer to its digest. One scheme is
  implemented, `eip712-secp256k1`, behind a scheme registry. EIP-712 domain
  fields never enter the mandate digest, so `allowedChains` remains the only
  chain constraint. See
  [ADR 0001](adr/0001-mandate-authorization-architecture.md).
- **Canonical encoding — RESOLVED.** MCE v1: a flat, versioned, length-explicit
  binary encoding digested with keccak-256. JSON canonicalization was rejected
  because it formats numbers through IEEE-754, cannot reasonably be reproduced
  in Solidity for the execution gate, and admits byte-distinct equivalent
  strings. See [ADR 0002](adr/0002-canonical-mandate-encoding.md).
- **Single-use versus reusable — RESOLVED.** Single-use, keyed on the mandate
  digest. Reusable envelopes need per-execution accounting and turn a bounded
  authorization into a standing one. See
  [replay-semantics.md](replay-semantics.md).
- **Revocation before expiry — still deferred.** Not in the MVP, because there
  is no revocation infrastructure to make it safe. Expiry bounds exposure.

Phase 1 also added one field this section did not anticipate:
`maxCorporateActionAgeSeconds`. A corporate-action epoch feed is itself state
that can go stale, so a current-looking epoch observed an hour ago does not
establish the epoch now. §7.3 already listed corporate-action freshness as an
MVP field; Phase 1 made it a separate bound from market-data freshness because
the two have genuinely different tolerances.

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

**IMPLEMENTED** in `packages/kernel`. Per-property evidence is in
[verifier-invariants.md](verifier-invariants.md).

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

**IMPLEMENTED.** The registry is `packages/kernel/src/reason-codes.ts`, and
[reason-codes.md](reason-codes.md) is generated from it — 43 codes across eight
families, each with an enforcement point and a test that produces it. The table
below is the original illustrative sketch, kept because several ids were
reassigned during implementation and the difference is worth seeing; the
generated document is authoritative.

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

**Partially implemented.** The corpus exists: `corpus/v1`, 57 vectors across 24
families, with a format specification and a test asserting the committed file
matches what the kernel generates. What does not exist yet is a *second*
implementation to run it against — the mechanism is built, the differential
comparison begins when the on-chain gate lands in Phase 6.

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

**IMPLEMENTED for the comparison; the epoch source remains DRAFT.** The verifier
compares an authorized epoch against an observed one, rejects a mismatch in
either direction with distinct codes, and enforces a separate freshness bound on
the observation. Who is authoritative for incrementing the epoch, and how that
authority is constrained, is still open and belongs to Phase 3.

Mechanism: every canonical asset carries a monotonically
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
change to the product, not an implementation detail.

**Phase 2 status.** INV-1, INV-2, INV-5, INV-9, INV-11, INV-12, INV-16, INV-17
and INV-18 are established in the kernel. **INV-6 is now established**: canonical
identity and token identity are distinct types, and equivalence is a function of
the current mandate rather than a stored field — enforced structurally, not by
comment. **INV-7 is established through the registry**: an execution address
originates only from a registry entry, and an unregistered contract is never
admissible. INV-4 holds for both packages' own boundaries — no model or untrusted
source can supply a value either reads — but the pipeline that would carry such a
value does not exist yet. INV-3 has its structural half (no inference client is
reachable from the verifier or the registry); the adversarial end-to-end half
needs Phase 5. INV-8, INV-14 and INV-15 need the routing of Phase 4. INV-10 and
INV-13 need the execution gate of Phase 6. Per-property evidence is in
[verifier-invariants.md](verifier-invariants.md) and
[registry-semantics.md §12](registry-semantics.md#12-registry-invariants-and-their-evidence).

| ID | Invariant | Where it will be enforced |
| --- | --- | --- |
| **INV-1** | Human intent is authoritative. No component may widen authority beyond the signed mandate. | Verifier |
| **INV-2** | A valid agent signature alone never authorizes a financial action. Authentication and authorization are separate checks. | Verifier |
| **INV-3** | The set of permitted executions is identical whether Jev is present, absent, failed or adversarial. | Verifier; pipeline structure; adversarial-stub test |
| **INV-4** | Model output never supplies an address, an amount, or a constraint value. | Pipeline structure; type boundaries |
| **INV-5** | Fail closed. `UNKNOWN` state, unparseable data, missing metadata on a constrained field, and unrecognized schema versions all reject. There is no "proceed anyway" path. | Verifier |
| **INV-6** | Canonical financial identity is distinct from token identity, and equivalence between representations is never inferred from shared underlying. | Registry model; verifier — **established Phase 2** |
| **INV-7** | Contract addresses used in execution come from the registry, never from a model, a tool response, or free text. | Resolution stage; type boundaries — **established Phase 2** |
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

## 20. Buildathon MVP scope

> **Status: SPECIFIED.** This is the commitment about what gets built. Anything
> not listed here is not in the MVP, whatever else this document describes.

### 20.1 Shape of the deliverable

A narrow, production-quality **vertical slice**: the complete path from a
signed financial mandate to a verified execution, on one asset class, one
chain environment, a small number of representations, and a small number of
venues — with every stage real rather than mocked.

Narrow and deep, not broad and shallow. A system that handles one mandate
correctly end-to-end, and refuses the unsafe variants of it for the right
reasons, demonstrates the thesis. One that handles many assets shallowly
demonstrates nothing, because the thesis is about correctness under
constraint, not coverage.

### 20.2 In scope

| # | Capability | What "done" means |
| --- | --- | --- |
| 1 | Machine-readable financial mandate | A signed, versioned, expiring mandate with the MVP field set from [§7.3](#73-mvp-mandate-versus-long-term-mandate) |
| 2 | Canonical tokenized-equity identity | A canonical asset identifier resolvable from a human reference, with ambiguity rejecting |
| 3 | Representation metadata | Registry entries with issuer, instrument type, backing model, synthetic flag, rights, operational state and provenance |
| 4 | Robinhood Chain / Arbitrum market-state integration | Real price, liquidity, operational and — where available — corporate-action state, each with provenance and observation time |
| 5 | Multiple execution candidates | At least two genuinely different candidates for one mandate, so selection and rejection are meaningful |
| 6 | Jev-assisted candidate selection | Optional. Selection over a closed admissible set, bounded and abstention-safe |
| 7 | Deterministic mandate verification | The verifier of [§10](#10-deterministic-verification): pure, total, fail-closed, model-free |
| 8 | Execution protection | An on-chain gate binding the submitted transaction to the verified one |
| 9 | Clear PASS / REJECT reason codes | Stable, namespaced, one per distinct cause, with a failure-mode test per code |
| 10 | Testnet execution | A real signed transaction landing on a testnet, where the environment supports it |
| 11 | Deliberate failure demonstrations | See [§20.3](#203-the-failure-demonstrations) |

### 20.3 The failure demonstrations

These are the centre of the deliverable, not an appendix. Each is a real
mandate and a real candidate, refused by the deterministic verifier with a
named reason code — not a mock, not a screenshot, not a description.

| # | Demonstration | Expected reason family |
| --- | --- | --- |
| 1 | Synthetic representation offered against a mandate forbidding synthetic exposure — **at a better price than the compliant candidate** | `MND-REPR-002` |
| 2 | Representation from an issuer outside the permitted set | `MND-REPR-001` |
| 3 | Notional exceeding the authorized maximum | `MND-ECON-001` |
| 4 | Execution deviation beyond the mandate's limit | `MND-ECON-002` |
| 5 | Stale corporate-action state, or a pending action invalidating the authorization | `MND-STATE-002` / `MND-STATE-003` |
| 6 | Execution attempted while the underlying is halted | `MND-STATE-004` |
| 7 | Expired mandate | `MND-AUTH-001` |
| 8 | Replayed mandate (nonce already consumed) | `MND-AUTH-002` |
| 9 | Correct ticker, wrong token — a lookalike contract not in the registry | `MND-ASSET-002` |
| 10 | Transaction mutated after verification, rejected by the on-chain gate | gate rejection |
| 11 | **Adversarial Jev**: a stub that always returns the most dangerous available answer, with no unsafe execution resulting | establishes INV-3 |

Demonstration 1 is the one that best distinguishes Mandate from a router: a
price-maximizing router picks the cheaper synthetic. Demonstration 11 is the
one that best distinguishes it from an agent framework.

### 20.4 Quality bar

"Production-quality vertical slice" means, concretely:

- every reason code has a test that produces it;
- the verifier has no I/O and no model dependency, checked structurally;
- no mocked stage in the demonstrated path — real registry, real state, real
  candidates, real verification, real submission;
- live data and engineered demo data are visibly separated, with the seam
  disclosed;
- what was actually demonstrated is stated precisely, with no overclaiming
  (see [AGENTS.md §5](../AGENTS.md#5-honesty-requirements)).

### 20.5 Dependencies and risks

| Risk | Impact | Response |
| --- | --- | --- |
| Corporate-action state unavailable in the target environment | Weakens capabilities 4 and 5 and demonstration 5 | Phase 3 establishes availability empirically first. If unavailable on-chain, demonstrate with a documented state source and disclose the seam — never present engineered state as live |
| Too few real representations of one underlying to produce genuinely different candidates | Weakens capability 5 and demonstration 1 | Candidates may differ by venue rather than by issuer; demonstration 1 may need a documented test representation, clearly labelled |
| Jev's API or latency unsuitable | Removes capability 6 | Capability 6 is explicitly optional. INV-3 guarantees the system is complete without it |
| Testnet unsuitable for real execution | Weakens capability 10 | Report honestly as blocked. Off-chain verification and the gate's unit-level behaviour are still demonstrable |

## 21. Explicit non-goals for the MVP

Stated as commitments, so that scope creep is visible when it happens.

### 21.1 Not built

| Not built | Why not |
| --- | --- |
| Cross-chain routing and bridging | Adds bridge failure modes and settlement complexity orthogonal to the thesis |
| Many issuers, many chains, many venues | Breadth does not demonstrate correctness under constraint |
| Portfolio-level mandates | Single-action mandates demonstrate the primitive |
| Delegated institutional policy and sub-mandates | Requires agent identity infrastructure that does not exist |
| Agent identity beyond a single keypair | Same |
| Revocation before expiry | Requires revocation infrastructure; expiry bounds exposure in the MVP |
| Automated reauthorization workflows | Staleness must be *detected* first; recovering from it automatically is a later, riskier problem |
| Stablecoin funding abstraction | [§19](#19-stablecoin-funding-as-a-supporting-layer). MVP assumes funded in one configured asset |
| Deferred, netted or cross-chain settlement | MVP assumes atomic single-chain settlement |
| Execution attestations | Receipts are designed to be attestable later, but attestation is not built |
| Asset equivalence and substitution policies | Substitution requires explicit authorization in the MVP; policy-driven substitution is later |
| Asset classes beyond equities | [§23](#23-expansion-beyond-equities). The abstractions must extend; the MVP does not |
| SDKs, MCP/tool interfaces, institutional APIs | Premature before the core primitives are stable |
| A policy engine or compliance adapter framework | The mandate *is* the policy expression in the MVP |
| Persistence beyond what execution requires | No database until a real persistence requirement appears |

### 21.2 Not claimed

Distinct from "not built", and more important. Even for what is built, the MVP
does **not** claim:

- that it determines whether an authorization reflects what a human *meant* —
  it enforces the mandate, not the intention behind it;
- that a testnet execution against engineered state proves behaviour under a
  real corporate action;
- that any two representations of the same underlying are economically or
  legally equivalent;
- that the registry's metadata is complete or authoritative for any issuer;
- that the threat model is closed — [§17](#17-threat-model-overview) lists
  what remains PARTIAL and OPEN;
- that on-chain enforcement covers off-chain facts;
- that Mandate makes a bad instrument good. It refuses one the mandate forbids.

### 21.3 Deliberately deferred decisions

Recorded so they are made on purpose later, not by accident now:

- mandate signature scheme and canonical encoding ([§7.5](#75-resolved-questions));
- whether mandates are single-use or reusable envelopes;
- the authority for incrementing corporate-action epochs
  ([§13.4](#134-corporate-action-epoch));
- whether Jev is worth using for metadata classification or only for ranking
  ([§11.5](#115-open-questions));
- the final reason-code registry ([§10.3](#103-reason-codes)).

## 22. Future architecture

> **Status: FUTURE.** None of this is built, planned for the buildathon, or
> claimed. It is recorded for one reason: to constrain today's abstractions so
> that these become additions rather than rewrites.

### 22.1 Mandate Network

The long-term shape is a network rather than a library: many issuers, many
chains, many venues, and many agents operating under many principals' policies.

| Area | Capability | Constrains today |
| --- | --- | --- |
| Breadth | Many tokenized-asset issuers, chains and execution venues | Adapter boundaries must be real from Phase 3, and the verifier must not know about any chain |
| Routing | Cross-chain routing; liquidity routing; asset equivalence and substitution policies | Substitution must remain explicitly authorized, never a routing optimization |
| Funding | Stablecoin funding abstraction | Notional and funding asset are separate concepts from the start ([§19.3](#193-mvp-position)) |
| Policy | Portfolio-level mandates; delegated institutional policies; programmable compliance adapters; policy engines | Mandate constraints must compose, so the schema must not assume a single flat constraint set |
| Identity | Agent identity; delegation chains; revocation; key rotation | Nothing outside the verifier's input struct may assume "agent identity == one public key" ([§8.4](#84-agent-identity)) |
| Corporate actions | Corporate-action synchronization across issuers; automated reauthorization workflows | Epochs must be comparable across issuers, which means the epoch source's authority must be modelled ([§13.4](#134-corporate-action-epoch)) |
| Settlement | Settlement abstraction; deferred and netted settlement; reconciliation across venues | The MVP's atomic assumption is stated explicitly rather than assumed ([§14.4](#144-settlement-abstraction)) |
| Provenance | Payment and trade provenance; execution attestations | Receipts use canonical encoding and stable digests so they are attestable later ([§15.4](#154-attestations)) |
| Interfaces | SDKs, MCP and tool interfaces, institutional APIs | Reason codes are a public interface from Phase 1, so they are designed as one ([§10.3](#103-reason-codes)) |

### 22.2 The one structural commitment

Everything above is optional except this: **the verifier must remain the sole
authorization authority as the system grows.**

The failure mode for a system like this is that convenience features
accumulate the ability to permit things — a policy engine with an override, a
routing optimization that relaxes a bound, a "trusted" integrator path that
skips a check. Each is individually reasonable and collectively fatal, because
the property that makes Mandate worth using is that *there is exactly one thing
that can say yes*.

Any future capability that would let something other than the verifier permit
an execution is a change to the product, and belongs in this document before it
belongs in code.

## 23. Expansion beyond equities

> **Status: FUTURE** for implementation; **SPECIFIED** for the design rules
> that keep it possible.

### 23.1 The design rules

Three rules, applied from Phase 1, keep asset-class expansion an addition
rather than a rewrite:

1. **Canonical asset identity carries an asset-class segment and an explicit
   identifier scheme** ([§5.2](#52-canonical-asset-identity)), because
   different asset classes have different identifier authorities.
2. **Nothing parses an identifier to infer behaviour.** Behaviour comes from
   metadata, so a new asset class adds metadata rather than changing parsing
   logic.
3. **No verifier check assumes equity semantics.** Checks are over metadata
   fields and mandate constraints, not over "the ticker" or "the share count".

The test of whether these hold: adding a second asset class must not require
changing the mandate schema's structure or the verifier's check families — only
the vocabularies those checks range over.

### 23.2 What each asset class would add

| Asset class | New concepts | Existing concepts that carry over |
| --- | --- | --- |
| **Equities** (MVP) | Splits, dividends, mergers, halts, shareholder rights | — |
| **ETFs and funds** | NAV, creation and redemption mechanics, holdings transparency, tracking error | Issuer, backing, corporate actions, halts |
| **Bonds** | Coupons, maturity, accrued interest, credit rating, callability, day-count conventions | Issuer, backing, rights, jurisdiction |
| **U.S. Treasuries** | Auction cycles, yield conventions, settlement conventions | Bond concepts; a strong backing model |
| **Private credit** | Illiquidity, lockups, drawdown schedules, valuation frequency, transfer restrictions | Transfer restrictions, jurisdiction, redemption model |
| **Commodities** | Physical delivery, storage and carry, contract expiry and roll, quality grades | Backing model, redemption model |
| **Tokenized funds** | Subscription and redemption windows, gating, fee structures | Fund concepts, operational state |

### 23.3 Where the model is likely to strain

Honest about the limits of the current abstraction:

- **Corporate-action epochs** ([§13.4](#134-corporate-action-epoch)) are
  modelled on discrete, dated equity events. A bond's continuous accrual and a
  fund's periodic NAV are not events in the same sense. The epoch concept
  probably generalizes to "a marker of material economic-state change", but
  the per-class definition of *material* is real work.
- **Execution deviation in basis points** assumes a continuously quoted
  reference price. Illiquid or periodically valued instruments may have no such
  reference, so deviation may need a per-class definition.
- **Atomic settlement** ([§14.2](#142-mvp-settlement-model)) is unrealistic for
  instruments with subscription windows or scheduled settlement, which is why
  settlement abstraction ([§14.4](#144-settlement-abstraction)) is the
  prerequisite for several of these classes.
- **"Buy $1,000 of exposure"** assumes divisibility and continuous pricing.
  Minimum denominations and lot sizes break it.

These are recorded now so the MVP's equity-shaped assumptions are visible as
assumptions. None of them requires solving today; all of them would be
expensive to discover after three more asset classes had been added on top of
them.

## 24. StateLatch reuse strategy

> **Status: assessment complete.** The prior repository was located locally and
> inspected in Phase 0. Full findings are in
> [statelatch-reuse.md](statelatch-reuse.md); this section is the summary and
> the policy.

### 24.1 What the prior project was

A Solana system — renamed across its life from StateLatch to EquityGuard to
StateGuard — solving one problem thoroughly: a tokenized equity's on-chain
economic state can change between quote and settlement, so move the check to
execution time and fail atomically if it changed. Roughly 10,600 lines of
product source against roughly 24,000 lines of tests, plus a Next.js site with
a complete design-token system.

It is not a foundation Mandate builds on. It is **one component of Mandate's
execution gate and state model, built well, on a different chain.**

### 24.2 Reuse policy

**SPECIFIED:**

1. **Ideas and methodology reuse freely.** They are chain-independent and they
   are the expensive part.
2. **Chain-specific code does not reuse.** Solana's account model, Token-2022
   extensions, the Instructions sysvar and Jupiter's route grammar have no EVM
   equivalents worth translating. Re-derive from EVM semantics.
3. **Web, design and test methodology reuse most.** They are the least
   chain-specific and the largest volume.
4. **No prior naming.** StateLatch, EquityGuard, StateGuard, `equity_guard`,
   `--eg-` prefixes and `EQUITYGUARD_*` identifiers do not enter this
   repository.
5. **No imported claims or metrics.** Compute-unit baselines, test-vector
   counts, deployment addresses and milestone identifiers describe that
   project, not this one. Importing any would be a false claim.
6. **No compatibility layers.** Nothing consumes the prior codebase. Reuse
   means re-deriving a design, not maintaining an interface.

### 24.3 The ideas worth carrying

| Idea | Where it lands in Mandate |
| --- | --- |
| Verification happens at execution time, not quote time | [§14.3](#143-the-execution-gate), INV-13 |
| Economic state includes the clock; stored bytes can be unchanged while meaning changes | [§13.5](#135-scheduled-transitions-and-the-clock), INV-10 |
| Refusal window around a scheduled transition, with phase as protected state | [§13.4](#134-corporate-action-epoch) |
| `UNKNOWN` is a value, not an exception | INV-5 |
| Fail closed on unparseable, unsupported or unmodelled input | INV-5, [§6.4](#64-metadata-sourcing-and-trust) |
| No floating-point equality in a safety decision | INV-16 |
| Cross-representation comparison in a common unit, with cost rounded against substitution | [§12.3](#123-ranking), INV-15 |
| No silent rerouting between issuers | [§12.4](#124-substitution-between-representations), INV-14 |
| Commitment binding over every security-relevant field of the protected action | [§14.3](#143-the-execution-gate), INV-13 |
| The gate verifies its own position relative to what it protects | [§14.3](#143-the-execution-gate) |
| Consent as an opaque, single-use, expiring capability bound to one disclosure | [§7.4](#74-design-rules-for-the-mandate-schema), INV-12 |
| Provenance required on every observation; conflicts fail closed, never reconciled | INV-17 |
| Invariants enumerated with enforcement level and evidence | [§16](#16-major-invariants) |
| Differential corpora, property tests, adversarial stubs, mutation matrices | [§10.5](#105-differential-verification), INV-3 |

### 24.4 The one counter-intuitive finding

The prior project's hardest and most novel engineering — the on-chain guard
program, with its ~2,800 lines of source and ~6,800 lines of tests — is its
**least** reusable artifact, because it is Solana-native down to the account
model. Its ideas transfer completely; its code transfers not at all.

Conversely, the web and design work, which took less engineering judgment,
transfers almost entirely. Reuse planning should be weighted accordingly, and
the temptation to "port the program" should be resisted: re-deriving the gate
for EVM from the documented ideas is cheaper and safer than translating it.

## 25. Phased engineering roadmap

> **Status: SPECIFIED** for phase ordering and exit criteria; **DRAFT** for
> contents beyond Phase 3. Detail and current state are in
> [roadmap.md](roadmap.md).

Ordering principle: **build the gate before the thing it gates.** The verifier
comes first, because everything else is defined by what the verifier requires,
and because a routing engine built before its constraints exist will encode
the wrong shape.

| Phase | Deliverable | Exit criterion |
| --- | --- | --- |
| **0** | Product thesis, architecture, domain model, engineering rules, roadmap, reuse assessment | This document. No implementation |
| **1** | Mandate core types and the deterministic verifier | The verifier rejects every enumerated unsafe condition, with a stable reason code and a failure-mode test per code. Pure, total, model-free |
| **2** | Canonical asset and representation registry | A canonical asset resolves to admissible representations, with per-representation exclusion reasons. Ambiguity and `UNKNOWN` reject |
| **3** | Robinhood Chain / Arbitrum market-state and chain adapters | Real market, operational and corporate-action state, each observation carrying provenance and an observation time, behind an adapter boundary the verifier does not know about |
| **4** | Execution-candidate and route engine | Multiple real candidates for one mandate, admissibility-filtered, ranked in a common economic unit |
| **5** | Jev integration for candidate classification and selection | Jev selects among admissible candidates, and an adversarial-Jev test establishes INV-3 |
| **6** | On-chain execution gate and settlement integration | Verified execution lands on testnet; a mutated transaction is rejected by the gate; deliberate failure demonstrations pass |
| **7** | Stablecoin funding and routing adapters | Fiat-denominated intent executes without the mandate naming a funding asset |
| **8** | Demo product and web experience | Public demonstration showing PASS and, prominently, REJECT with reasons; live and engineered data visibly separated |
| **9+** | Cross-chain network and broader asset classes | Out of buildathon scope. See [§22](#22-future-architecture) and [§23](#23-expansion-beyond-equities) |

### 25.1 Rules that apply to every phase

**SPECIFIED, and enforced by [AGENTS.md](../AGENTS.md):**

- Every phase lands as **multiple meaningful commits**. Never one giant commit
  per phase; never fake granularity from meaningless one-line commits.
- A phase is not complete until its **failure modes are tested**. In this
  system the rejections are the product, so a check without a test that
  produces its rejection is not done.
- Documentation changes in the **same commit** as the code it describes.
- Each phase ends with a **report and a human approval gate** before the next
  begins.
- No phase may weaken an invariant in [§16](#16-major-invariants). If one needs
  to change, that is a product decision made here first, not an implementation
  detail discovered later.

### 25.2 What determines the order

- **1 before everything** — the verifier defines the shape of every input, so
  building it first prevents the rest of the system from encoding the wrong
  assumptions.
- **2 before 3** — registry structure determines what adapters must supply.
- **3 before 4** — candidates cannot be constructed without real state, and
  candidates built against fake state encode fake assumptions.
- **4 before 5** — Jev needs a real candidate set to select from. Integrating
  it earlier would mean building the advisory layer before the thing it
  advises on.
- **5 before 6, but not blocking it** — the execution gate must not depend on
  Jev in any way. If Phase 5 is delayed or abandoned, Phase 6 proceeds
  unchanged. This is INV-3 expressed as a scheduling property.
- **6 before 8** — the demo demonstrates real execution and real refusals, not
  a mock.
- **7 whenever funding becomes the blocker** — it is a supporting layer and its
  position is flexible.
