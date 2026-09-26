# ADR 0019 — The onchain execution gate

**Status:** accepted, Phase 6
**Amends:** [design §14.3](../mandate-design.md#143-the-execution-gate) (DRAFT →
implemented, with one deliberate departure recorded below)
**Relies on, unchanged:** [ADR 0001](0001-mandate-authorization-architecture.md),
[ADR 0002](0002-canonical-mandate-encoding.md),
[ADR 0014](0014-symmetric-signed-economic-authorization.md),
[ADR 0017](0017-layered-candidate-state-commitments.md),
[ADR 0018](0018-observed-execution-outcomes.md)

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

### 5. Settlement is measured, not reported

The gate transfers exactly the bound input from the principal to the adapter,
calls the adapter, and settles on the principal's measured balance deltas:
debit ≤ the agent's limit ≤ the signed bound; credit ≥ the required output. It
reads nothing the adapter returns. The gate never holds funds and never grants an
allowance.

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
- Dynamic state — price deviation, freshness, halt, corporate-action epoch,
  operational status, registry snapshot — is still decided offchain at handoff and
  is not re-asserted at execution. The window between handoff and inclusion is
  bounded only by the agent's deadline and the mandate's expiry.
- Pinned registry facts can go stale; a changed fact needs a new gate deployment.
- An executor gate is a larger contract than an assertion would have been. It is
  kept immutable and single-purpose to compensate.
