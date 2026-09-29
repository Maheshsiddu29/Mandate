# Phase 7F — Portfolio Mandate v1 specification

> **Status: specification for Phase 7F, opened by the repository owner on
> 2026-09-29.** A layer *above* Mandate Core. It changes nothing frozen: not
> MCE v2, not Candidate V3, not the Phase 6 gate, not Core, the ledger or the
> control engine, not the Phase 7E.3 deployment and not any canonical corpus.
> Security model: [security-model.md](security-model.md). Package decision:
> [ADR 0027](../adr/0027-portfolio-mandate-layer.md).

## Contents

1. [What a portfolio mandate is](#1-what-a-portfolio-mandate-is)
2. [Architecture](#2-architecture)
3. [Resources](#3-resources)
4. [The Portfolio Mandate v1 object](#4-the-portfolio-mandate-v1-object)
5. [Canonical encoding](#5-canonical-encoding)
6. [Allocation modes](#6-allocation-modes)
7. [Parent → child authority](#7-parent--child-authority)
8. [Action candidates and identity resolution](#8-action-candidates-and-identity-resolution)
9. [Agent proposals](#9-agent-proposals)
10. [The Mandate Room](#10-the-mandate-room)
11. [The Portfolio Verifier](#11-the-portfolio-verifier)
12. [Compilation to Core and resource reservation](#12-compilation-to-core-and-resource-reservation)
13. [The Portfolio Receipt](#13-the-portfolio-receipt)
14. [UI data contract](#14-ui-data-contract)
15. [Evidence classes and the transaction model](#15-evidence-classes-and-the-transaction-model)
16. [Reason codes](#16-reason-codes)

---

## 1. What a portfolio mandate is

One principal, several specialized agents, several markets, **one authority**.
A Portfolio Mandate is the principal's signed statement of:

- which agents may act, and for each one exactly which domains, actions,
  chains, venues, canonical assets, representations, issuers and recipients
  it may touch, with which per-action bounds (leverage, slippage, quote age);
- which **resources** exist, in which unit, and how much of each the whole
  portfolio and each agent may commit;
- how allocation between agents works (§6);
- its validity window, policy version and nonce.

It is not a spending cap. Each agent's authority is a different *shape* —
representation identity for the stock agent, venue and recipient binding for
the swap agent, contract identity for the NFT agent, issuer and quote
freshness for the yield agent, derivative exposure for the perps agent — and
the shared quantities between them are only the ones the principal declared
comparable.

A Portfolio Mandate grants nothing by itself at execution time. It is
**compiled** into Core objects — one root grant and one delegation per agent
(§12) — and every execution still passes Core's control engine, its ledger
and each domain's own enforcement point.

## 2. Architecture

```text
PortfolioMandate (principal-signed)           ─── validated: every AgentPolicy ⊆ parent (§7)
   ├── AgentPolicy[stock | swap | nft | yield | perps]
   ├── resources + portfolio-wide limits
   └── allocation mode + preferred allocations

agents ── AgentProposal[] (agent-signed, untrusted) ──►  Mandate Room  (no authority; §10)
                                                           │ screens, allocates, asks to reduce,
                                                           │ applies releases and claims
                                                           ▼
                                                  PortfolioCandidate (untrusted)
                                                           │
                                                   PortfolioVerifier (§11)  ── re-derives everything
                                                           │
                                     ChildExecutionAuthorization[]   (each ⊆ AgentPolicy ⊆ parent)
                                                           │
            compiled Core root + delegations ──► ControlEngine.authorizeAndReserve  (atomic CAS, §12)
                                                           │
                                             existing domain issuance (ADMIT_ATTEMPT before any key)
                                                           │
                                      Robinhood gate · Lighter signer · FIXTURE venues
```

Everything above the control engine is offchain and pure. The control engine,
the ledger, each domain module and each enforcement point are the existing,
frozen components, used unchanged.

## 3. Resources

A **resource** is a declared, typed quantity the portfolio accounts for:

```text
ResourceDefinition {
  resourceId   Identifier            e.g. portfolio-notional
  kind         Core QuantityKind     ledger-trackable kinds only (CAPITAL, NOTIONAL, MARGIN, ...)
  unit         Core UnitCode         e.g. USDC
  decimals     u8
  domain       DomainId | null       null: every domain; otherwise that domain only
}
```

Every amount in the portfolio layer is a `(resourceId, atoms)` pair and
takes its kind, unit and decimals from the definition. Two amounts combine
only when they name the **same resource**. There is no conversion, no
normalization and no implicit sum: spot `CAPITAL` in USDC and perp `MARGIN`
in USDC are two resources, and adding them is refused
(`RESOURCE_INCOMPARABLE`), as is adding `NOTIONAL` in USDC to `NOTIONAL` in
USD.

A shared limit exists only where the principal declared a resource that
several domains contribute to. The demonstration declares one:
**`portfolio-notional` — kind `NOTIONAL`, unit `USDC`, 6 decimals, every
domain** — the committed-notional quantity already proven shared between
Robinhood and Lighter in Phase 7E.3 (implementation-7e3.md §8). A resource
maps one-to-one onto a Core `LEDGER_DIMENSION` (`CAPACITY`, `AS_CHARGED`,
unsigned, scope `{domain}`), so the ledger charges exactly the contributions
the resource describes, by Core's own matching rule: equal kind and unit, and
equal domain when the resource names one.

The demonstration's resources:

| Resource | Kind | Unit | Scope | Portfolio limit | Why |
| --- | --- | --- | --- | ---: | --- |
| `portfolio-notional` | `NOTIONAL` | USDC, 6 | every domain | 2,000 | the one comparable shared quantity; the allocated resource |
| `derivative-notional` | `NOTIONAL` | USDC, 6 | `lighter-perp` | 400 | portfolio-wide derivative exposure |
| `illiquid-notional` | `NOTIONAL` | USDC, 6 | `nft-fixture` | 400 | portfolio-wide illiquid-asset exposure |
| `spot-capital` | `CAPITAL` | USDC, 6 | `robinhood-evm` | 800 | GateSpotPolicy requires a capital dimension |
| `perp-margin` | `MARGIN` | USDC, 6 | `lighter-perp` | 400 | perp margin is never spot capital |

## 4. The Portfolio Mandate v1 object

```text
PortfolioMandate {                          schema PORTFOLIO_MANDATE.V1
  principal        PartyId                  whose resources are at stake
  policyVersion    u64                      the principal's version of this portfolio's policy
  nonce            u64                      two otherwise identical mandates are two mandates
  notBefore        i64                      notBefore ≤ t < expiresAt
  expiresAt        i64
  allocationMode   PREALLOCATED | DYNAMIC | HYBRID
  resources        ResourceDefinition[]     unique by resourceId
  scope            AuthorityScope           the portfolio's own authority (§7)
  limits           ResourceLimit[]          portfolio-wide: resourceId → atoms
  agents           AgentPolicy[]            unique by agentId
}

AgentPolicy {
  agentId          PartyId                  authentication: proposals are signed by this key (§9)
  label            Identifier               display only; no decision reads it
  scope            AuthorityScope           ⊆ the portfolio's scope
  notBefore        i64                      ⊆ the portfolio's window
  expiresAt        i64
  hardMaxima       ResourceLimit[]          each ≤ the portfolio limit of the same resource; an
                                            unlisted resource is bounded by the portfolio limit alone
  preferred        ResourceLimit[]          PREALLOCATED: the allocation; HYBRID: preferred; DYNAMIC: empty
}

AuthorityScope {
  domains          DomainId[]               e.g. robinhood-evm, lighter-perp
  actions          ActionKind[]             STOCK_BUY, SWAP_EXACT_IN, NFT_BUY, YIELD_DEPOSIT, PERP_OPEN
  chains           Identifier[]             CAIP-2: eip155:46630, eip155:421614, lighter:300
  venues           Identifier[]             exact venue identity, e.g. eip155:421614/router:0x…
  assets           CanonicalAssetId[]       the kernel's (assetClass, idScheme, value)
  representations  Identifier[]             exact instrument identity (§8)
  issuers          Identifier[]
  recipients       Identifier[]             where settlement may land
  syntheticPolicy  FORBIDDEN | ALLOWED
  requiredRights   Identifier[]             registry right kinds that must be PRESENT
  maxLeverage      Ratio | null             null: no leveraged action is permitted
  maxSlippageBps   u32 | null               null: no slippage-bearing action is permitted
  maxQuoteAgeSecs  u64 | null               null: no quote-dependent action is permitted
}
```

Every set is **closed-world**: an empty set permits nothing, and an absent
bound permits nothing that needs it. Nothing is inferred from a label, a
ticker, a display name or a symbol.

The mandate is **principal-signed**: its digest (§5) is signed by the
principal's key under a domain-separated prefix, and the room and verifier
accept only the mandate whose signature recovers to its own `principal`
(`PORTFOLIO_MANDATE_SIGNATURE_INVALID`). Agents never supply a mandate; the
verifier is configured with the principal's mandate and refuses a proposal
or candidate that names any other digest
(`PORTFOLIO_MANDATE_DIGEST_MISMATCH`).

**Validation is total and collects every violation.** A mandate is refused
if any agent policy is not a subset of the portfolio's authority (§7), if a
resource is undeclared or a kind is not ledger-trackable, if preferred
allocations exceed hard maxima or the portfolio limit, or if the allocation
mode's rules (§6) are broken.

## 5. Canonical encoding

The repository's encoding discipline (ADR 0002, ADR 0020), unchanged:

- `str(tag) ‖ u16(schemaVersion = 1) ‖ body`, with the length-prefixed tag
  naming the object and its version. Tags: `PORTFOLIO_MANDATE.V1`,
  `PORTFOLIO_PROPOSAL.V1`, `PORTFOLIO_CHILD_AUTHORIZATION.V1`,
  `PORTFOLIO_CANDIDATE.V1`, `PORTFOLIO_RECEIPT.V1`, and the two signing
  prefixes `PORTFOLIO_MANDATE_SIGNATURE.V1`, `PORTFOLIO_PROPOSAL_SIGNATURE.V1`.
- Big-endian fixed-width integers; `u256` atoms; `u16`-prefixed ASCII
  identifiers in the ADR 0002 charset; a `u8` presence flag before every
  nullable field; explicit enum wire codes that never depend on declaration
  order. No floating point anywhere; ratios are `(numerator, scale)`.
- Every set and keyed list is written in ascending order of its elements'
  encoded bytes; duplicates are refused at construction and at decoding;
  decoding requires strictly ascending elements, bounded counts and no
  trailing bytes, so `encode(decode(b)) = b` for every accepted `b`.
- Digest: Keccak-256 of the full encoding. **No JSON is hashed anywhere.**

## 6. Allocation modes

Allocation is **coordination, not authority**. It decides which agent gets
which part of the principal's resources *inside* the principal's hard limits;
the hard limits themselves are enforced by the ledger (§12), whatever the
allocation says. The allocation book is kept per allocatable resource (the
demonstration allocates `portfolio-notional`).

| Mode | Principal specifies | Agents may | Book at start |
| --- | --- | --- | --- |
| `PREALLOCATED` | an allocation per agent (`preferred`, required, summing to ≤ the portfolio limit) | act inside their allocation; release unused allocation back to the principal | each agent holds its allocation; the rest is unallocated and **not claimable** |
| `DYNAMIC` | one pool, per-agent hard maxima | compete for the pool up to their hard maxima | pool = the portfolio limit |
| `HYBRID` | preferred allocations and hard maxima | act inside their preferred allocation; release unused allocation; claim released allocation up to their hard maxima | each agent holds its preferred allocation; the remainder is a claimable lot |

The book is a pure value with four operations, each returning the new book
or a refusal:

- `commit(agent, proposal, amount)` — `committed + amount ≤ allocated`.
- `release(agent, releaseId, amount)` — only unused allocation
  (`allocated − committed`); creates a **lot** of that amount. A release id is
  applied once (`RELEASE_ALREADY_APPLIED`); releasing more than is unused is
  `RELEASE_EXCEEDS_UNUSED`.
- `claim(agent, claimId, lot, amount)` — `DYNAMIC` and `HYBRID` only
  (`CLAIM_NOT_PERMITTED_IN_MODE`); `amount ≤ lot.remaining` (`LOT_EXHAUSTED`)
  and `allocated + amount ≤` the agent's cap — its listed hard maximum, or
  the portfolio limit where it lists none (`AGENT_LIMIT_EXCEEDED`). A claim id is
  applied once. A lot's amount can therefore be reassigned **exactly once**.
- The invariant after every operation: `Σ allocated + Σ lot.remaining =
  portfolio limit`, `committed ≤ allocated ≤ cap` per agent.

## 7. Parent → child authority

**Invariant: CHILD AUTHORITY ⊆ PARENT PORTFOLIO AUTHORITY.** It is enforced
mechanically at three levels, each by code, never by comment:

1. **Portfolio → agent** (`checkChildScope`, at mandate validation): every
   agent's scope, window and hard maxima against the portfolio's.
2. **Agent → execution** (`deriveChildAuthorization`, in the verifier): every
   `ChildExecutionAuthorization` against its agent's policy and, again,
   against the portfolio's.
3. **Core** (`registerDelegation`, at compilation): each agent's compiled
   delegation is checked by the ledger's own subset rule
   (`DELEGATION_WIDENS_SET`, `…_LIMIT`, `…_WINDOW`), and at every action the
   control engine evaluates the **meet** of the lineage — so even a widening
   grant that somehow registered could not widen anything.

| Term | Child valid iff | Refusal |
| --- | --- | --- |
| each set (domains, actions, chains, venues, assets, representations, issuers, recipients) | child ⊆ parent | `CHILD_WIDENS_<SET>` |
| `syntheticPolicy` | parent `FORBIDDEN` ⇒ child `FORBIDDEN` | `CHILD_WIDENS_SYNTHETIC_POLICY` |
| `requiredRights` | child ⊇ parent | `CHILD_DROPS_REQUIRED_RIGHT` |
| `maxLeverage`, `maxSlippageBps`, `maxQuoteAgeSecs` | parent `null` ⇒ child `null`; otherwise child ≤ parent | `CHILD_WIDENS_LEVERAGE` / `_SLIPPAGE` / `_QUOTE_AGE` |
| window | `parent.notBefore ≤ child.notBefore`, `child.expiresAt ≤ parent.expiresAt` | `CHILD_WIDENS_WINDOW` |
| resource maximum | declared resource; child ≤ parent limit of the same resource | `CHILD_RESOURCE_UNDECLARED`, `CHILD_WIDENS_RESOURCE_LIMIT` |

Portfolio limits are closed-world: a resource the portfolio does not limit
has limit zero, so no agent may hold any of it, and an undeclared resource is
refused. An agent's hard maxima are ceilings *under* those limits: a resource
the agent does not list is bounded by the portfolio limit alone. That is
exactly Core's rule for ledger dimensions — a child need not restate one,
because the parent's leg is charged regardless — and it is what lets an
agent's action be locally valid yet exceed a portfolio-wide limit such as
derivative exposure. Every violation is reported, not only the first.

An execution is represented as the **singleton scope** of its one resolved
action (§8): `{domain}`, `{kind}`, `{chain}`, `{venue}`, `{asset}`,
`{representation}`, `{issuer}`, `{recipient}`, the synthetic policy its
instrument needs, the rights it establishes, and its own leverage, slippage
and quote age as bounds. So one function, `checkChildScope`, decides every
level — portfolio ⊇ agent ⊇ execution — and `permits(scope, action)` is that
same check under action-level names (`CHILD_WIDENS_VENUES` becomes
`VENUE_NOT_ALLOWED`, and so on), plus each swap-route pool against the allowed
venues. The property tests establish, over a seeded generator:

- **subset soundness:** `checkChildScope(parent, child) = ∅ ∧ permits(child, a)
  ⇒ permits(parent, a)`;
- **monotonic tightening:** adding any restriction to a scope never makes a
  previously refused action permitted, and never removes a refusal;
- **detection:** any single widening of a scope is caught, and a child drawn
  inside its parent always checks clean;
- **limits:** a child resource limit passes exactly when it is declared and
  ≤ the parent's limit of the same resource.

## 8. Action candidates and identity resolution

An agent proposes one exact **action candidate**. v1 has five kinds:

| Kind | Domain | Exact identity it names | Economics |
| --- | --- | --- | --- |
| `STOCK_BUY` | `robinhood-evm` | registry `RepresentationId` of the token | quantity (token atoms) |
| `SWAP_EXACT_IN` | `swap-fixture` | router (venue), route pools, token in/out, recipient | amount in; quoted and minimum out |
| `NFT_BUY` | `nft-fixture` | marketplace (venue), collection contract, token id, recipient | maximum price |
| `YIELD_DEPOSIT` | `yield-fixture` | product (vault) contract, recipient | amount; quoted APY with observation time |
| `PERP_OPEN` | `lighter-perp` | Lighter market, sub-account | size, limit price, initial margin fraction |

A candidate may also carry what the agent *believes* — a display ticker, a
display name, a claimed issuer, a claimed canonical asset. **Those are never
identity.** The verifier resolves each candidate against trusted data and
derives the facts it checks:

- `STOCK_BUY` resolves through the **existing registry**: the representation
  id is evaluated with `evaluateRepresentation` against requirements derived
  from the agent's scope (canonical asset, issuers, chains, synthetic policy,
  required rights). An unregistered contract is `REPRESENTATION_UNKNOWN`
  whatever its ticker; a registered look-alike from an unapproved issuer is
  `ISSUER_NOT_ALLOWED`. The registry's reason codes are carried verbatim.
  There is no second asset-identity implementation.
- The other kinds resolve against each domain binding's **reviewed instrument
  table** — part of that domain module's digest — which states each known
  instrument's chain, venue, canonical asset and issuer. An instrument the
  table does not know resolves to `INSTRUMENT_UNKNOWN`.
- A claim the agent made that disagrees with the derived fact is
  `IDENTITY_CLAIM_MISMATCH`.

The resolved action — kind, domain, chain, venue, canonical asset, exact
representation, issuer, recipient, leverage, slippage, quote age and the
**derived** resource demand — is what `permits` (§7) reads. Resource demand
is computed from the candidate by the domain's own formula (for the stock
agent, `FixtureVenue.quoteBuy` of the reviewed gate market; for perps, size ×
limit price and the Lighter margin formula) and is never taken from the
agent's declaration.

## 9. Agent proposals

```text
AgentProposal {                               schema PORTFOLIO_PROPOSAL.V1
  portfolioMandate   digest                   binds the proposal to one mandate
  agent              PartyId
  sequence           u64                      strictly increasing per agent
  candidate          ActionCandidate
  requested          ResourceLimit[]          must equal the derived demand
  minimum            ResourceLimit[]          the smallest the agent would accept
  utilityBps         i64                      ranking metadata only; never authority
  createdAt, expiresAt  i64
  criticalExtensions Identifier[]             v1 knows none: any entry refuses
}
signature = secp256k1 over keccak(str("PORTFOLIO_PROPOSAL_SIGNATURE.V1") ‖ proposalDigest)
```

**Authentication** is the signature recovering to `agent`, and `agent` being
one of the mandate's agents. **Authorization** is everything else: the
candidate's resolved action inside the agent's scope, its demand inside the
agent's and the portfolio's limits. A valid signature authorizes nothing.

The agent's `requested` figure is untrusted. It must equal the demand the
verifier derives (`PROPOSAL_RESOURCES_MISDECLARED` otherwise), so an agent
cannot understate what an action will consume. A reduced request is a new
proposal with a resized candidate, a new sequence and a new signature — the
room never edits a candidate.

## 10. The Mandate Room

A pure, deterministic, offchain coordination function. **It has no
authority**: its output is untrusted input to the verifier.

```text
room(mandate, availability, registry, bindings, now, rounds ≤ 8):
  for each round:
    1. each agent strategy returns PROPOSE(proposal) | RELEASE(amount) | IDLE
    2. apply releases, in agent order
    3. screen proposals: authentication, freshness, replay, extensions,
       identity resolution, permits(agent scope), permits(portfolio scope),
       declared = derived demand, non-allocated resource headroom
       → REJECTED with every reason
    4. accept, in order, every proposal that fits the agent's unused allocation
    5. then, by (utilityBps desc, proposal digest asc), proposals needing more:
       claim from lots (lot order) up to the hard maximum → ACCEPTED,
       or REDUCE_REQUESTED(target) when target ≥ the agent's minimum,
       or REJECTED(ALLOCATION_INSUFFICIENT)
    6. feed every decision back to its agent
  stop when a round changes nothing
  → PortfolioCandidate { accepted proposals, allocation book, decision log }
```

The room may accept, reject, ask to reduce, apply a release and reassign a
released lot. It cannot widen a limit, add an asset, issuer, venue or
representation, fabricate trusted state, change a candidate, or skip a
representation check — none of those is an operation it has. `utilityBps`
orders claims between agents; an agent that inflates it can win a larger
share of released allocation **inside its own hard maximum and the portfolio
limit**, never more. Input order never changes the output: proposals are
processed in canonical order.

## 11. The Portfolio Verifier

`verifyPortfolio(mandate, signature, candidate, proposals, availability,
registry, bindings, now)` is pure and total and trusts nothing the room
produced. It re-derives, independently:

1. the mandate's signature, validity window and full validation (§4, §7);
2. for every accepted proposal: authentication, freshness, sequence,
   extensions, identity resolution and `permits` against the agent scope and
   the portfolio scope; declared = derived demand;
3. the allocation book, replayed from the room's decision log from the
   mandate's initial book — every commit, release and claim re-applied with
   its rules — and compared with the book the candidate claims;
4. per resource: `Σ approved ≤ agent hard maximum − agent reserved` and
   `Σ approved over all agents ≤ portfolio limit − portfolio reserved`, using
   the ledger's current reservations;
5. no proposal selected twice, no proposal the candidate does not carry.

It then derives one `ChildExecutionAuthorization` per accepted proposal, in
canonical order:

```text
ChildExecutionAuthorization {                 schema PORTFOLIO_CHILD_AUTHORIZATION.V1
  portfolioMandate, principal, agent, proposal, candidate   digests and parties
  kind, domain, chain, venue, asset, representation, issuer, recipient   the resolved action
  approved           ResourceLimit[]          = the derived demand
  notBefore, expiresAt                        ≤ proposal, agent and portfolio windows
}
```

and checks each one ⊆ its agent's policy ⊆ the portfolio (§7, level 2).

## 12. Compilation to Core and resource reservation

`compilePortfolio(mandate, bindings)` derives, from the verified mandate only:

- one **root grant** — issuer and holder the principal, `DELEGATE` depth 1,
  the portfolio window, `MODULES`, `ADAPTERS`, `ACTION_TYPES`, `MARKETS` and
  `RECIPIENTS` sets compiled from the portfolio scope through the domain
  bindings, `OPEN_RISK`, and one `LEDGER_DIMENSION` per portfolio limit;
- one **delegation per agent** — issuer the principal (the root's holder),
  holder the agent, the agent's window, its sets compiled the same way, one
  `LEDGER_DIMENSION` per hard maximum, and domain invariants the binding
  derives from the scope (the perps agent's `perp.max-leverage`);
- an empty **principal policy**: portfolio-wide limits live on the root, where
  Core's LEDGER-5 requires a granting node (implementation-7c.md §10).

They are registered through the unchanged `ControlEngine`, whose ledger
re-checks every delegation ⊆ its parent.

Each `ChildExecutionAuthorization` is mapped by its domain binding to one
Core action envelope — principal, the agent's delegation, the agent as actor,
the exact module, adapter, market and payload, a nonce derived from the child
authorization digest, its window — and reserved with
`ControlEngine.authorizeAndReserve`. Before reserving, the engine's pure
`decide` is run and its ledger demands are compared with the child's
approved resources (`RESERVATION_DEMAND_MISMATCH` otherwise). The reservation
is the ledger's single atomic compare-and-swap: five agents reserving at once
cannot together exceed any leg — the agent's hard maximum or the
portfolio-wide limit — because every leg is checked against the committed
state it is written to.

The reservation lifecycle is the ledger's, not a new one:

| Portfolio state | Evidence |
| --- | --- |
| `AVAILABLE` | ledger target headroom |
| `RESERVED` | an `ACTIVE` ledger reservation for the child's action |
| `ADMITTED` | an `ADMIT_ATTEMPT` for that reservation, naming the exact artifact |
| `SIGNED` / `SUBMITTED` | the domain signer's journal (Robinhood: `ARTIFACT_ISSUED`, `SUBMISSION_SENT`) |
| `SETTLED` / `FAILED` | domain execution evidence, with its evidence class (§15) |
| `CONSUMED` / `RELEASED` | ledger reconciliation — **not built**: executed reservations stay `ACTIVE`, as in 7E.3; the only release is `NEVER_ISSUED` |

**Before any principal or custody key signs**, `checkBeforeSign` requires:
the child authorization is one the verifier derived (allocation exists); its
action is byte-identical to the one the binding derives from it (no
mutation); an `ACTIVE` reservation of that action exists with demands equal
to the approved resources; and an `ADMIT_ATTEMPT` for that reservation is
committed. The domain signer then performs its own existing checks (for the
Robinhood gate, custody re-derives the gate artifact from the committed
attempt).

## 13. The Portfolio Receipt

A deterministic, canonically encoded record (`PORTFOLIO_RECEIPT.V1`) of one
portfolio run:

```text
PortfolioReceipt {                                    PORTFOLIO_RECEIPT.V1
  principal, portfolioMandate, policyVersion, allocationMode, rounds
  agents[]                  agent, label, final status (derived, never reported)
  proposals[]               digest, agent, round, kind, domain, exact representation, venue, requested
  decisions[]               proposal, round, outcome, reason codes, reduce target,
                            refusal = NONE | OFFCHAIN_REFUSAL (0 transactions, 0 gas)
  releases[]                digest, agent, round, applied, reasons
  allocationBefore/After    the book: entries, lots, operations
  resourcesBefore/After     the ledger: headroom and reserved per resource, per agent
  verification              VERIFIED | REFUSED, with reasons
  childAuthorizations[]     digest, agent, proposal, approved resources
  representationDecisions[] the registry's verdict and codes for every stock candidate
  reservations[]            child → reservation, authorization, execution authorization, ledger version
  executions[]              child → status, this run's evidence class, the integration and its evidence,
                            attempt, artifact, transactions
  transactions              onchain transactions the whole run sent
}
receiptDigest = keccak(encoding)
```

Every list is in canonical order. No prose, no model output and no display
text is inside the digest; a display rendering is derived from the receipt,
never the reverse. Reordering the proposals or the candidate's selections
cannot change the digest.

## 14. UI data contract

`portfolioView(run)` returns plain data a frontend can animate without
parsing logs:

- **portfolio status**: `ACTIVE`, `NEGOTIATING`, `AUTHORIZED`, `EXECUTING`,
  `COMPLETE`, with the round at which each began;
- **agent status** per round: `SEARCHING`, `PROPOSING`, `BLOCKED`,
  `RENEGOTIATING`, `RELEASING`, `AUTHORIZED`, `EXECUTING`, `SETTLED`,
  `FAILED`;
- **proposal rows**: agent, domain, asset, representation, venue, requested
  allocation, approved allocation, policy reasons, execution status, evidence
  class;
- headline counts: agents, markets (distinct domains), principals (always 1).

## 15. Evidence classes and the transaction model

Every integration and every execution result carries exactly one class:

| Class | Meaning |
| --- | --- |
| `LIVE_TESTNET` | executed on a public testnet, with a transaction hash |
| `FIXTURE` | a labelled fixture venue with no live counterpart |
| `SIMULATED` | executed offline against a reference model of the enforcement point |
| `OFFCHAIN_ONLY` | authorized and exactly specified offchain; no execution path in this phase |

| Domain | Integration | Class | Basis |
| --- | --- | --- | --- |
| Robinhood (stock) | GateSpotPolicy v1, `robinhood-gate-signer`, frozen Phase 6 gate | `LIVE_TESTNET` | Phase 7E.3 (tx `0x7144…f344`); this phase's runs are offline |
| Lighter (perps) | PerpPolicy v1 over recorded testnet market claims | `OFFCHAIN_ONLY` | no funded testnet account exists (testnet-evidence.md §2) |
| Swap | `swap-fixture` module and venue | `FIXTURE` | no live integration |
| NFT | `nft-fixture` module and marketplace | `FIXTURE` | no live integration |
| Yield | `yield-fixture` module and vault | `FIXTURE` | no live integration |

**Transactions.** Reasoning, discovery, negotiation, ranking, allocation,
verification and reservation are offchain. A proposal refused by the room or
the verifier produces **0 transactions and 0 gas** — its refusal is an
`OFFCHAIN_REFUSAL` in the receipt. Only a child authorization that is
reserved, admitted and signed reaches an enforcement point. An onchain
refusal (the gate rejecting a mutated artifact) is an `ONCHAIN_DEFENSE_TEST`,
shown in this phase only against the Phase 6 reference model, which the
frozen differential corpus proves equal to the Solidity gate.

## 16. Reason codes

The closed vocabulary, grouped by where it arises. Registry and control
refusals are carried verbatim with a `REGISTRY:` or `LEDGER:` prefix.

| Group | Codes |
| --- | --- |
| mandate | `PORTFOLIO_MANDATE_MALFORMED`, `PORTFOLIO_MANDATE_SIGNATURE_INVALID`, `PORTFOLIO_MANDATE_DIGEST_MISMATCH`, `PORTFOLIO_MANDATE_NOT_YET_VALID`, `PORTFOLIO_MANDATE_EXPIRED`, `PREFERRED_EXCEEDS_HARD_MAXIMUM`, `PREFERRED_EXCEEDS_PORTFOLIO_LIMIT`, `ALLOCATION_MODE_VIOLATION` |
| agent | `AGENT_UNKNOWN`, `AGENT_SIGNATURE_INVALID`, `AGENT_NOT_YET_VALID`, `AGENT_EXPIRED` |
| proposal | `PROPOSAL_NOT_YET_VALID`, `PROPOSAL_EXPIRED`, `PROPOSAL_REPLAYED`, `PROPOSAL_EXTENSION_UNKNOWN`, `PROPOSAL_RESOURCES_MISDECLARED`, `PROPOSAL_MINIMUM_INVALID` |
| identity | `INSTRUMENT_UNKNOWN`, `IDENTITY_CLAIM_MISMATCH`, `REGISTRY:<code>` |
| scope | `DOMAIN_NOT_ALLOWED`, `ACTION_NOT_ALLOWED`, `CHAIN_NOT_ALLOWED`, `VENUE_NOT_ALLOWED`, `ROUTE_NOT_ALLOWED`, `ASSET_NOT_ALLOWED`, `REPRESENTATION_NOT_ALLOWED`, `ISSUER_NOT_ALLOWED`, `RECIPIENT_NOT_ALLOWED`, `SYNTHETIC_NOT_ALLOWED`, `REQUIRED_RIGHT_MISSING`, `LEVERAGE_NOT_ALLOWED`, `SLIPPAGE_NOT_ALLOWED`, `QUOTE_NOT_ALLOWED`, `QUOTE_STALE` |
| resources | `RESOURCE_UNDECLARED`, `RESOURCE_INCOMPARABLE`, `AGENT_LIMIT_EXCEEDED`, `PORTFOLIO_LIMIT_EXCEEDED`, `ALLOCATION_INSUFFICIENT` |
| allocation | `RELEASE_EXCEEDS_UNUSED`, `RELEASE_ALREADY_APPLIED`, `CLAIM_NOT_PERMITTED_IN_MODE`, `CLAIM_ALREADY_APPLIED`, `LOT_UNKNOWN`, `LOT_EXHAUSTED`, `COMMIT_EXCEEDS_ALLOCATION` |
| derivation | `CHILD_WIDENS_DOMAINS`, `CHILD_WIDENS_ACTIONS`, `CHILD_WIDENS_CHAINS`, `CHILD_WIDENS_VENUES`, `CHILD_WIDENS_ASSETS`, `CHILD_WIDENS_REPRESENTATIONS`, `CHILD_WIDENS_ISSUERS`, `CHILD_WIDENS_RECIPIENTS`, `CHILD_WIDENS_SYNTHETIC_POLICY`, `CHILD_DROPS_REQUIRED_RIGHT`, `CHILD_WIDENS_LEVERAGE`, `CHILD_WIDENS_SLIPPAGE`, `CHILD_WIDENS_QUOTE_AGE`, `CHILD_WIDENS_WINDOW`, `CHILD_RESOURCE_UNDECLARED`, `CHILD_WIDENS_RESOURCE_LIMIT` |
| candidate | `CANDIDATE_PROPOSAL_UNKNOWN`, `CANDIDATE_PROPOSAL_DUPLICATED`, `CANDIDATE_BOOK_MISMATCH` |
| handoff | `CHILD_AUTHORIZATION_UNKNOWN`, `CHILD_AGENT_MISMATCH`, `CHILD_ACTION_MUTATED`, `RESERVATION_MISSING`, `RESERVATION_DEMAND_MISMATCH`, `ATTEMPT_NOT_COMMITTED`, `LEDGER:<code>/<reason>` |

A structurally malformed object — a proposal, mandate, candidate or child
that does not parse, or bytes that do not decode — is refused by its
validator with Core's structural codes (`WRONG_TYPE`, `UNKNOWN_FIELD`,
`DUPLICATE_SET_MEMBER`, `ENCODING_TRAILING_BYTES`, …), before any portfolio
rule runs. The vocabulary is provisional in the same sense as Core's (open
question 9): names may change before a freeze; meanings may not.
