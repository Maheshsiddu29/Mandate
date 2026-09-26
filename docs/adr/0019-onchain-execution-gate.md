# ADR 0019 — The onchain execution gate

**Status:** accepted, Phase 6
**Amends:** [design §14.3](../mandate-design.md#143-the-execution-gate) (DRAFT →
implemented, with one deliberate departure recorded below)
**Relies on, unchanged:** [ADR 0001](0001-mandate-authorization-architecture.md),
[ADR 0002](0002-canonical-mandate-encoding.md),
[ADR 0014](0014-symmetric-signed-economic-authorization.md),
[ADR 0017](0017-layered-candidate-state-commitments.md),
[ADR 0018](0018-observed-execution-outcomes.md)

## Phase 6R security amendment

The independent Phase 6 audit found that the accepted design authenticated an
authorized agent but did not independently prove that the agent's candidate was
within all static principal authority the gate claimed to enforce. Phase 6R
closes that gap without changing MCE v2, Candidate V3, or Phases 1–5:

- the gate independently verifies exact quantity × price notional arithmetic,
  signed `maxNotional`, and declared BUY/SELL fee-inclusive economics;
- the only supported `FIXTURE` market pins its engineered price immutably, so an
  agent cannot choose a zero or distorted price to evade `maxNotional`;
- *(Phase 6R.1)* `maxNotional` bounds the true quantity × fixture price at the
  principal's signed precision, so the agent's choice of declared-notional
  precision cannot widen it (audit M-1), and the constructor proves each
  fixture venue settles at exactly the pinned price;
- representation quantity is strict FILL_OR_KILL on both sides;
- real-market configurations are rejected until they have an authenticated,
  inclusion-time state source;
- the executable profile is bounded independently onchain; and
- actual-kernel REJECT vectors signed by the correct agent must not settle.

The complete authority classification is
[phase-6r-principal-authority.md](../phase-6r-principal-authority.md). This is an
amendment to the implementation decision, not a rewrite of the historical audit.

## Context

Phases 1–5R.3 decide offchain whether an execution is permitted. Nothing
prevented a different transaction from being submitted after that decision:
INV-10 (chain-sourced time), INV-12's final replay authority and INV-13 (the
transaction submitted is the transaction verified) were all owned by Phase 6.

The DRAFT in design §14.3 imagined the gate as a *read-only, side-effect-free
assertion* placed beside the action in one atomic unit, verifying its own
position relative to the action. That shape comes from the prior Solana work,
where a program can introspect the other instructions in its transaction. The
EVM has no such introspection: a contract cannot see or constrain the other
calls a transaction makes. A read-only gate beside an action would bind nothing.

The brief for this phase also fixed the offchain protocol: MCE v2, Candidate V3,
the ADR 0001 EIP-712 domain and the kernel's replay key. The gate had to bind to
those, not to a new schema.

## Decision

### 1. The gate is the executor, not an assertion beside one

`MandateExecutionGate.execute` performs the action itself, through one adapter
call per supported market. Because the gate *is* the action, its position
relative to the action is structural, and nothing else in the transaction can
move the principal's funds under its authority. This departs from §14.3's
"read-only and side-effect free" wording deliberately; the property that wording
was protecting — adding the gate cannot let anything unverified settle — is
preserved and strengthened.

### 2. Two signatures, one domain

- The **principal** signs the existing kernel struct
  `MandateAuthorization(bytes32 mandateDigest)` under
  `{name: "Mandate", version: "1", chainId, verifyingContract: gate}`. The same
  signature the offchain verifier accepts is what the gate accepts. Nothing about
  the mandate or its digest changes.
- The **agent** named in the mandate signs
  `ExecutionAuthorization(bytes32 mandateDigest, bytes32 candidateDigest, address
  recipient, uint256 fundingLimit, uint64 deadline, bytes executionData)` under
  the same domain, after offchain handoff verification.

Both are checked with the kernel's acceptance rule (65 bytes, `v ∈ {27, 28}`, low
`s`). Different type hashes make the two unsubstitutable for each other; the
domain makes both unusable on another chain or at another gate.

### 3. The gate re-encodes, it does not trust

The gate takes the mandate and candidate as structs, re-encodes them to MCE v2
and Candidate V3 bytes and hashes those. It validates exactly what the kernel's
*decoder* validates — including strictly ascending identifier sets — so a
signature authenticates every field the gate reads, and one mandate has one
digest and therefore one replay key.

### 4. Registry facts the chain needs are pinned at construction

A mandate names a canonical asset, never a contract (design §7.4 rule 4), so the
principal's signature cannot bind a token. The gate's constructor therefore pins,
per supported market, the minimum registry facts it needs: representation token,
funding token, adapter, canonical asset, issuer, venue, quantity unit,
settlement unit and synthetic status. The market is keyed by the registry's
CAIP-19 representation identifier, *derived* from the token address, so a market
cannot be registered under an identifier naming another contract. There is no
owner, setter or upgrade path.

This is not registry resolution: nothing is looked up, ranked or interpreted. It
is the onchain analogue of "addresses come from the registry" (INV-7) for a gate
that has no registry.

**Amended in Phase 6R.1a.** For the only supported class, a labelled fixture, the
adapter is no longer a supplied fact. The constructor creates each market's
`FixtureVenue` and `FixtureVenueAdapter` itself from code compiled into the gate,
at the market's typed fixture price converted exactly into funding atoms, so
implementation, wiring and price follow from the gate's bytecode and constructor
arguments rather than from anything a deployed contract reports. Phase 6R.1 had
asked a supplied adapter for its venue's price, which a hostile adapter or a
look-alike venue could answer falsely. A real-market adapter, when one exists,
will need its own equally mechanical identity rule; that belongs to the phase
that introduces it. This holds for a gate genuinely created from the reviewed
initcode; proving that a deployed gate was is the final deployment-provenance
check ([execution-gate.md §13](../execution-gate.md#13-deployment-policy)), which
is not built (Phase 6R.1b).

### 5. Principal authority and settlement are independently established

Before transferring anything, the gate establishes that the candidate price is
the immutable fixture price, quantity × price brackets the declared notional by
the kernel's exact integer rule, the true quantity × fixture price rendered at
the principal's signed precision (and the declared notional) is within signed
`maxNotional`, and fees preserve the side-specific signed economic limit. It
then transfers the bound input, calls the adapter, and settles on measured
balance deltas: BUY representation credit and SELL representation debit equal
the exact candidate quantity, while funding debit/credit respects the signed
bound. It reads nothing the adapter returns. The supported path intentionally
leaves no funds or allowance in the gate.

### 6. Replay is keyed on the mandate digest and consumed atomically

`executionCommitmentOf[mandateDigest]` is written before any external call and
unwound by any revert. Only a transaction that fully settles leaves it set. The
key is the kernel's replay key, so the offchain state machine and the chain agree
on what "this authorization" means.

### 7. Recipient is the principal

The mandate authorizes no other recipient, so none is accepted. The field is
kept in the signed struct so a later phase can widen it only by a new signed
authorization, never by default.

### 8. Settlement unit is a declared funding assumption

The mandate's economic bound is in a unit (`USD`); the chain moves a token. Each
market declares which unit its funding token settles, and the gate converts the
signed bound into token atoms with rounding that never favours the agent. This is
a stated, per-deployment funding assumption — not a claim that a stablecoin *is*
the currency — and Phase 7 owns funding properly.

### 9. The offchain half is a new package

`@mandate/execution-gate` holds the wire form, the execution commitment, a
reference model of `execute` built on the kernel's decoder and signature rule,
and the chain-evidence → `ExecutionObservation` rule. Its runtime dependencies are
exactly `@mandate/kernel`, `@noble/curves` and `@noble/hashes` at the versions the
kernel already pins (ADR 0003's rationale for those two carries over). The
dependency points one way; no earlier package imports it.

## Consequences

**Gained.** INV-10, INV-12 and INV-13 hold onchain for the supported path. A
mutated transaction cannot settle through the gate; a reverted one consumes
nothing; one authorization settles at most once; and the principal's cash flow
is bounded by what they signed, measured on chain.

**Accepted costs.**

- The gate re-implements the kernel's MCE encoder and decoder rules in Solidity.
  Divergence is the risk design §10.5 names; `corpus/gate-v1` and a
  mutation-tested differential harness exist to catch it.
- Dynamic real-market state — reference-price freshness/deviation, halt,
  corporate-action epoch, multiplier, operational status and registry snapshot
  — is still decided offchain at handoff and is not re-asserted at execution.
  Therefore Phase 6R rejects every `REAL_MARKET` configuration. A later path
  needs an authoritative onchain source or narrowly scoped fresh attestation.
- Pinned registry facts can go stale; a changed fact needs a new gate deployment.
- An executor gate is a larger contract than an assertion would have been. It is
  kept immutable and single-purpose to compensate.
