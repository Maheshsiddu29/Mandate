# Mandate Core v1 — Action, state, quantity and invariant model

> **Status: Phase 7A specification, DRAFT pending review. Not implemented.**
> Field lists here are conceptual: they fix what each envelope must carry and
> why. Canonical encodings, bounds and parsers are Phase 7B.

## Contents

1. [Design rule: a Core envelope plus typed domain payloads](#1-design-rule-a-core-envelope-plus-typed-domain-payloads)
2. [Identifiers](#2-identifiers)
3. [Economic quantities](#3-economic-quantities)
4. [Action model](#4-action-model)
5. [State model](#5-state-model)
6. [Projection](#6-projection)
7. [Invariant model](#7-invariant-model)
8. [The domain module interface](#8-the-domain-module-interface)

---

## 1. Design rule: a Core envelope plus typed domain payloads

There is no universal economic state struct and no universal action struct. A
struct with a field for every market's economics — spot position, perp
position, option Greeks, lending LTV, prediction probability, governance votes —
would couple every domain to every other, would have to be changed for every new
market, and would invite exactly the category error this phase exists to
prevent: treating two numbers as comparable because they sit side by side.

Instead every action and every observation is

```
Core envelope   — identity, lineage, domain, provenance, lifecycle; understood by Core
     +
typed payload   — the domain's own schema; understood only by its domain module
                  and committed to by digest in the envelope
```

Core reads the envelope. It reaches into a payload only by calling the domain
module that owns it, through the typed interface in §8, and gets typed values
back.

## 2. Identifiers

| Identifier | Form | Notes |
| --- | --- | --- |
| `DomainId` | closed-registry identifier + module version | `evm-spot@1`, `perp@1`. An intent or snapshot naming an unknown domain or version rejects |
| `ResourceId` | `(domain, kind, localId)` | kinds: `market`, `asset`, `account`, `venue`, `recipient`, `proposal`. Compared by exact canonical bytes |
| `MarketId` | `ResourceId` of kind `market`: `(domain, venue, instrument)` | `BTC-PERP` on two venues is two markets |
| `AssetId` | `ResourceId` of kind `asset` | either a canonical asset (Phase 2 registry identity) or a token representation; the two are distinct types ([INV-6](../mandate-design.md#16-major-invariants)) |
| `AccountId` | `ResourceId` of kind `account` | the principal's account at an enforcement point: an EVM address, a venue sub-account |
| `EnforcementAdapterId` | closed-registry identifier + version | `evm-gate@1` |

**Exposure asset is registry data.** A market's or a representation's
underlying exposure asset (that `BTC-PERP` on venue X is exposure to canonical
BTC; that a wrapped-BTC token is exposure to canonical BTC) is a registry fact
with provenance, not something parsed from a name. It follows Phase 2's rule:
membership in an underlying is not equivalence between representations
([design §5.4](../mandate-design.md#54-why-same-underlying-is-deliberately-weak)).
An exposure dimension scoped to canonical BTC counts a position only if the
registry states that position's exposure asset is canonical BTC.

## 3. Economic quantities

### 3.1 The quantity type

There is no Core `uint256 amount`. Every economic value that Core stores,
reserves, compares or reports is an `EconomicQuantity`:

```text
EconomicQuantity {
  kind        QuantityKind      what economic concept this is (§3.2)
  unit        UnitCode          what it is counted in: USD, USDG, BTC, CONTRACT, COUNT
  decimals    0..38             part of the value's identity, as in the kernel's Amount
  atoms       integer           signed only for signed kinds
  asset       AssetId | NONE    what it is a quantity of, or exposure to, where the kind requires one
  valuation   ValuationRef | NONE   required exactly for valued kinds
}

ValuationRef {
  price       Price             the kernel's Price: numeratorUnit per denominatorUnit, exact
  basis       EXECUTION | LIMIT | MARK
  source      StateDigest | ObservationId    the snapshot or fill the price came from
  observedAt  UnixSeconds
}
```

`unit`, `decimals` and `atoms` are the kernel's `Amount` (INV-18), reused
unchanged. `kind`, `asset` and `valuation` are what the kernel's single-trade
world did not need and a multi-domain ledger cannot do without.

Ratios — basis points, leverage multiples, health factors, probabilities — are
**not** economic quantities. They are exact `Ratio` values (integer numerator,
power-of-ten scale) used by per-action bounds and invariants. A leverage of 3x
cannot be added to 600 USDG because they are different types, not because a
check remembers to refuse it.

### 3.2 Kinds

| Kind | Unit | Signed | `asset` | Valued | Ledger-trackable | Example |
| --- | --- | --- | --- | --- | --- | --- |
| `TOKEN_AMOUNT` | a token representation | no | the representation | no | yes | 800 USDG transferred |
| `CAPITAL` | the grant's funding unit | no | funding asset | no | yes | 800 USDG deployed |
| `POSITION_SIZE` | instrument's native unit | yes | exposure asset | no | yes | +0.05 BTC |
| `NOTIONAL` | numeraire | no | exposure asset | yes: `EXECUTION` or `LIMIT` | yes, as committed notional | 4,000 USD committed |
| `GROSS_EXPOSURE` | numeraire | no | exposure asset or NONE | yes: `MARK` | **no** — invariant only | 3,100 USD marked |
| `NET_EXPOSURE` | numeraire | yes | exposure asset | yes: `MARK` | **no** — invariant only | −1,200 USD marked |
| `MARGIN` | collateral unit | no | collateral asset | no | yes, per venue account | 600 USDG isolated margin |
| `COLLATERAL` | collateral unit | no | collateral asset | no | yes | 2,000 USDG deposited |
| `DEBT` | borrowed unit | no | borrowed asset | no | yes | 500 USDC borrowed |
| `PNL` | settlement unit | yes | NONE | realized: no; unrealized: `MARK` | realized only | −35 USDG realized |
| `COUNT` | `COUNT` | no | NONE | no | yes | 3 actions |

**A valued quantity is not ledger-trackable if its value floats.** A ledger
counter must mean the same thing tomorrow as today. Committed notional
(quantity × the execution price actually paid) does; marked exposure (quantity
× today's mark) does not. Marked quantities are therefore computed at decision
time from ledger-tracked native quantities and an admitted price, inside an
invariant (§7), never stored as a counter.

### 3.3 Three meanings of exposure

"BTC exposure ≤ 5,000 USD" is ambiguous, and each reading is a different, valid
constraint:

| Measure | Kind | What it bounds | Mechanism |
| --- | --- | --- | --- |
| Position size | `POSITION_SIZE` in BTC | how much BTC-linked quantity is held or pending, in native units | ledger dimension; exact; no price needed |
| Committed notional | `NOTIONAL`, basis `EXECUTION` (reserved at `LIMIT`) | how many dollars were committed at the prices actually paid, plus the worst case of pending orders | ledger dimension; exact once filled |
| Marked exposure | `GROSS_EXPOSURE` / `NET_EXPOSURE`, basis `MARK` | what held and pending positions are worth now | invariant over ledger positions + pending, valued at an admitted, fresh mark |

A grant must say which it means. The brief's "unresolved + filled BTC exposure
≤ 5,000 USD" is committed notional; "BTC gross exposure ≤ 20,000 USD" is marked
exposure, and it needs a fresh price to evaluate — without one it is `UNKNOWN`
and a risk-increasing action rejects.

### 3.4 Rules

- **UNIT-1 — no silent mixing.** Addition, subtraction and comparison are
  defined only between quantities of equal `kind`, `unit` and, where the kind
  carries one, `asset`, after an exact decimal rescale. Anything else is not a
  representable operation: in 7B it is a type error where the type system can
  catch it and a `QUANTITY_KIND_MISMATCH` / `QUANTITY_UNIT_MISMATCH` refusal at
  every runtime boundary where it cannot (the kernel's model: the brand catches
  mistakes early, the runtime check is the boundary).
- **UNIT-2 — cross-kind relations are named domain rules.** Margin is not
  notional ÷ leverage "by convention"; it is `perp.initialMargin(order, S)`, a
  named, versioned, pure domain function whose inputs are typed and whose
  version is recorded in the receipt. Capital deployed by a spot buy is
  `spot.capitalForBuy(maxDebit)`. There is no generic converter.
- **UNIT-3 — cross-unit relations are declared or valued.** USDG to USD is
  either a **settlement assumption** declared in the grant (as the Phase 6 gate
  declares that a funding token settles its settlement unit —
  [execution-gate.md §6](../execution-gate.md#6-economic-enforcement)) or a
  valuation with provenance and freshness. Never an implicit 1:1.
- **UNIT-4 — rounding is against the actor.** Worst-case contributions and
  reservations round up; floors round up and ceilings round down when rescaled;
  consumption computed from a valuation rounds up; release is exact
  (`reserved − consumed`). As in the kernel, nothing that bounds risk rounds in
  the caller's favour.
- **UNIT-5 — unsigned kinds do not go negative.** A subtraction that would is a
  refusal, never a wrap or a saturation, except where a rule defines
  saturation explicitly (the gate's `uint256` maximum-debit saturation is such a
  rule, and belongs to the EVM adapter, not Core).

The spot-notional + perp-margin mistake is now unrepresentable twice over: the
two have different kinds (`NOTIONAL` and `MARGIN`), and a dimension accepts
contributions of exactly one kind and unit
([authority-ledger.md §3](authority-ledger.md#3-dimensions)).

## 4. Action model

### 4.1 The envelope

```text
ActionIntent {
  version
  principal     PartyId               whose authority is spent; checked = lineage root principal
  authority     AuthorityId           the leaf node acted under
  actor         PartyId               = leaf holder; signs ActionDigest
  domain        DomainId              module + version that interprets the payload
  actionType    identifier            closed vocabulary of the domain
  adapter       EnforcementAdapterId  where it will be enforced
  target        ResourceId            the primary resource: market, recipient, proposal
  resources     set<ResourceId>       every other resource touched; bounded
  payload       bytes                 the domain payload
  validFrom     UnixSeconds           not reservable before
  expiresAt     UnixSeconds           not reservable at or after; bounds every attempt
  nonce         uint64                distinguishes otherwise identical intents
}
payloadDigest = H("mandate-core/v1/payload/" ‖ domain, payload)
ActionDigest  = H("mandate-core/v1/action", envelope with payloadDigest in place of payload)
signature     = actor's signature over ActionDigest
```

| Field | Needed because |
| --- | --- |
| `principal` | the actor's signature commits to whose authority it spends; checked, not trusted |
| `authority` | an agent may hold several nodes; it must say which it spends, and that node's lineage is what is checked |
| `actor` | authentication of who asked; never authorization ([INV-2](../mandate-design.md#16-major-invariants)) |
| `domain` | selects the module; its version is part of the decision's inputs |
| `actionType` | coverage (allowed action types) and dispatch |
| `adapter` | coverage (grants restrict enforcement adapters) and binding |
| `target`, `resources` | coverage and contribution scoping without decoding the payload in the receipt. The domain module **recomputes** them from the payload; a mismatch is `ACTION_RESOURCES_MISMATCH` |
| `payload` | the action itself, in its domain's schema |
| `validFrom`, `expiresAt` | bound the window in which a signed intent can be reserved; `expiresAt − validFrom` is bounded per domain so a leaked signed intent is dangerous for a bounded time |
| `nonce` | the replay key is `ActionDigest`; the nonce lets the same action be proposed twice deliberately |

Fields deliberately **not** in the envelope:

- **Risk direction.** Whether an action increases or reduces risk is derived by
  the domain module from the payload and admitted state. An agent's claim that
  an order "only reduces" is not read; an order that would flip a position is
  increasing.
- **State references.** The snapshots the agent looked at are not decision
  inputs. Core admits its own current state at decision time. Binding an action
  to the agent's view of the world is the mistake
  [ADR 0017](../adr/0017-layered-candidate-state-commitments.md) corrected; the
  domain module declares which *kinds* of state the action depends on (§8) and
  Core fetches and admits them.
- **Amounts in Core's vocabulary.** The contribution an action makes to each
  ledger dimension is computed by the domain module, never declared by the
  agent.

### 4.2 Domain payloads

Illustrative shapes, each owned and versioned by its module (7B/7E define
them):

```text
SpotAction       { side, representation: AssetId, quantity: TOKEN_AMOUNT,
                   limit: BUY max debit | SELL min credit (TOKEN_AMOUNT),
                   maxDeviationBps: Ratio }
PerpOrderAction  { market: MarketId, side, size: POSITION_SIZE, limitPrice: Price,
                   leverage: Ratio, marginMode: ISOLATED | CROSS, reduceOnly: bool,
                   timeInForce, orderExpiry: UnixSeconds }
LendingAction    { market: MarketId, op: SUPPLY | WITHDRAW | BORROW | REPAY,
                   amount: TOKEN_AMOUNT }
PaymentAction    { recipient: ResourceId, amount: TOKEN_AMOUNT, reference: bytes32 }
```

Core does not read any of these fields. It reads what the domain module returns
about them.

## 5. State model

### 5.1 The envelope

```text
StateSnapshot {
  version
  domain        DomainId
  stateKind     identifier      e.g. evm.balance, perp.account, perp.markPrice, lending.position
  subject       ResourceId      the account, market or asset it describes
  sourceId      Identifier      a configured StateSource
  trustClass    TrustClass      must equal the source's configured class; not self-declared
  observedAt    UnixSeconds
  sequence      { kind: BLOCK | VENUE_SEQUENCE | VERSION | NONE, value }
  validUntil    UnixSeconds | NONE   source-declared upper bound (e.g. an oracle heartbeat)
  payloadDigest bytes32
  payload       typed per stateKind
  attestation   signature | NONE     for sources that sign what they report
}
StateDigest = H("mandate-core/v1/state", envelope)
```

`TrustClass` is the kernel's four-level vocabulary, reused unchanged:
`AUTHORITATIVE`, `VERIFIED`, `ADVISORY`, `UNTRUSTED`. Only the first two are
ever admitted for a decision, as in the kernel.

### 5.2 Sources

State is not uniformly trustless, and Core does not pretend it is.

| Source | Typical class | What it can and cannot establish |
| --- | --- | --- |
| Onchain state read at a stated block and finality level | `AUTHORITATIVE` for that block | the chain's state at that block — through an RPC that is itself a trust boundary |
| Signed venue attestation | `VERIFIED` | what the venue signed; not that the venue is honest |
| Venue API (REST/WebSocket) | `VERIFIED` | what the venue's API returned to this reader; no signature binds it |
| Oracle | `VERIFIED` | a price within the oracle's own freshness and deviation guarantees |
| Registry under change control | `VERIFIED` | curated identity and representation facts (Phase 2) |
| Local reconciled ledger | `AUTHORITATIVE` **for Core's own quantities only** | what has been reserved, consumed, released; nothing about the market |
| Model output, tool responses, agent-supplied values | `ADVISORY` / `UNTRUSTED` | nothing a decision reads |

A `StateSource` is configured with the domains and state kinds it may report
and its trust class. A snapshot from a source not configured for its
`(domain, stateKind)` is not admitted, whatever it claims.

### 5.3 Admission

A snapshot is admitted for a decision at time `t` iff:

1. its source is configured for its `(domain, stateKind)` and its `trustClass`
   equals the configured class;
2. the class satisfies the effective state policy for that state kind;
3. `observedAt ≤ t` and `t − observedAt ≤ maxAge` for that state kind under the
   effective state policy (the tighter of every lineage node's bound);
4. `t < validUntil` when present;
5. its `sequence` is not lower than the highest sequence already admitted from
   the same source for the same subject and state kind (no rollback);
6. **it is not older than the ledger's reconciliation watermark for its
   subject** (STATE-3). If the ledger has already applied a fill observed at
   venue sequence 1,042, an account snapshot at sequence 1,040 does not contain
   that fill, and combining it with the ledger would count the fill zero times
   or twice depending on how it is combined;
7. it is not in conflict: two admitted snapshots of the same `(stateKind,
   subject)` from different sources that disagree on a compared field are
   `STATE_CONFLICT` and neither is admitted
   ([ADR 0006](../adr/0006-representation-claims-and-conflict-policy.md): a
   conflict is recorded and fails closed, never resolved by preference).

Rejections are distinct because the fixes are distinct: `STATE_MISSING`,
`STATE_SOURCE_NOT_ADMITTED` (fresh but untrusted), `STATE_STALE` (trusted but
too old), `STATE_FROM_FUTURE`, `STATE_SEQUENCE_REGRESSED`,
`STATE_BEHIND_LEDGER`, `STATE_CONFLICT`.

### 5.4 Freshness is the consumer's policy

A snapshot carries when it was observed, not how fresh it must be. The maximum
age is set by the grant's state policy per state kind, tightened along the
lineage, because different decisions tolerate different staleness — the same
lesson that split corporate-action freshness from market-data freshness in
Phase 1. A source's `validUntil` can only shorten the window.

## 6. Projection

```
S' = Project_d(S ⊕ Pending(L), A)
```

- `S` is the admitted snapshots plus the ledger view.
- `Pending(L)` is the worst-case effect of every `ACTIVE` or `QUARANTINED`
  reservation under the principal, **in every domain**, as recorded by the
  ledger at the version the decision reads.
- `Project_d` is the domain module's pure function.

**PROJ-1 — conservative projection.** A projection credits no pending
risk-reducing effect and applies every pending risk-increasing effect in full
(full fill at the reserved worst-case price). A pending sell that would lower
BTC exposure is not counted until reconciled, because it may never fill; a
pending buy is counted in full, because it may. Evaluating every subset of
pending fills is exponential; this bound is linear and never optimistic.

**Cross-domain projection.** An invariant that spans domains — marked BTC
exposure across EVM spot and perps — is a Core invariant over quantities each
domain module exposes in a common kind: each module returns its held and
pending `POSITION_SIZE` per exposure asset; Core sums like with like and values
the sum at one admitted mark for the canonical asset. No domain module ever
reads another's state.

## 7. Invariant model

An invariant is a condition that must remain true for the projected economic
state. Invariants are **typed interfaces with closed parameter schemas**, not
expressions. There is no scripting language.

```text
InvariantDefinition (shipped in a module release) {
  invariantId       namespaced identifier: core.*, perp.*, lending.*
  version
  paramsSchema      typed parameters
  scope             which resources an instance may be scoped to
  requiredState     (params, scope) → state kinds and subjects it reads
  mode              LEDGER_BACKED | EVALUATED
  evaluate          (params, S') → InvariantResult           pure, total
  noWeaker          (childParams, parentParams) → bool       for delegation (authority-model §4)
}

InvariantRef (inside a grant) { invariantId, version, scope, params }

InvariantResult {
  invariantId, version, scope
  outcome           HOLDS | VIOLATED | UNKNOWN
  reasonCode        stable identifier; UNKNOWN always carries the missing input
  observed          typed value (EconomicQuantity or Ratio)
  bound             typed value, same type as observed
  stateRead         list<StateDigest>
  ledgerVersion     the version whose pending set was projected
}
```

- **`UNKNOWN` rejects** a risk-increasing action (FAIL-1). An invariant that
  cannot be evaluated has not held.
- **`LEDGER_BACKED`** invariants are ledger dimensions: additive, reservable,
  checked by `AuthorityAvailable`. **`EVALUATED`** invariants are non-additive
  and are safe under concurrency only because they are evaluated over
  `S ⊕ Pending(L@v)` and committed at `v`
  ([architecture.md §6](architecture.md#6-the-linearization-point)).
- **Every result names its inputs** so the receipt can reproduce it.

The brief's examples, placed:

| Condition | Mechanism | Measure |
| --- | --- | --- |
| capital allocated ≤ 100,000 USDG | ledger dimension, `CAPACITY` | `CAPITAL` in USDG |
| BTC gross exposure ≤ 20,000 USD | `EVALUATED` `core.markedExposure` | `GROSS_EXPOSURE` at `MARK`, scope canonical BTC, all domains |
| perp leverage ≤ 3x | per-action bound on the order **and/or** `EVALUATED` `perp.accountLeverage` | `Ratio` |
| lending health factor ≥ 1.5 | `EVALUATED` `lending.healthFactor` | `Ratio` |
| unresolved + filled BTC exposure ≤ 5,000 USD | ledger dimension, `CAPACITY` | `NOTIONAL` committed, scope canonical BTC |
| authorized representation(asset) | set membership + `EVALUATED` `registry.representationAdmissible` over the admitted registry snapshot | boolean |

## 8. The domain module interface

Every domain module implements the same pure, total interface. This is the
whole of what Core knows about a domain.

```text
DomainModule {
  id, version
  decode(intent)                  → DomainAction | reject(reason)
  resources(action)               → target + set<ResourceId>          (must equal the envelope's)
  requiredState(action)           → list<{stateKind, subject}>
  riskDirection(action, S)        → INCREASING | REDUCING | NEUTRAL   (MIXED is INCREASING)
  project(S ⊕ Pending, action)    → S'                                 (PROJ-1)
  contributions(action, S)        → list<Contribution>                 worst case, at authorization
  settle(action, fills, S)        → list<Contribution>                 actual, at reconciliation
  positions(S_d)                  → list<POSITION_SIZE by exposure asset>   for cross-domain invariants
  invariants                      → set<InvariantDefinition>
}

Contribution {
  selector    { kind, unit, scope: { asset?, market?, domain?, account? } }
  amount      EconomicQuantity           kind and unit equal the selector's
  direction   INCREASE | DECREASE        DECREASE only from settle(), for CAPACITY restore
}
```

- `contributions` is evaluated once, at authorization, and its result is what
  is reserved. `settle` is evaluated at reconciliation over observed fills and
  their actual prices and fees; the difference between the two is released or,
  if `settle` exceeds `contributions`, recorded as an overrun
  ([reservations-reconciliation.md §6](reservations-reconciliation.md#6-consumption-arithmetic)).
- A module is a trusted, versioned component. A bug in `contributions` that
  understates a worst case is a bug in authority, which is why the module
  version enters every receipt and why each module needs its own failure-mode
  tests and differential corpus when it is built.
- A module never performs I/O, never reads a clock and never calls a model, and
  is enforced structurally as every existing package is.
