# Mandate

## One Authority Layer. Many Agents. Multiple Markets.

Mandate is the authorization and execution control plane for autonomous
financial agents.

Humans define bounded economic authority. Agents reason and propose actions.
Mandate deterministically verifies whether each action is permitted before
execution.

**Agents propose. Mandate authorizes. Markets settle.**

## Why Mandate

A valid agent signature proves who proposed an action. It does not prove that
the action is authorized.

Financial agents can produce mechanically valid transactions that violate the
principal's rules: the wrong asset representation, an unapproved issuer, stale
state, excessive portfolio exposure, a replayed proposal, or a route supplied
by prompt injection. Wallet authentication alone cannot answer whether the
exact economic action is permitted.

Mandate separates those questions:

```text
agent identity + signed proposal
                ↓
bounded principal authority
                ↓
deterministic verification + portfolio-global reservation
                ↓
execution gate or fail-closed refusal
```

Canonical financial identity is also separate from token representation.
`NASDAQ:NVDA` names an underlying; a token contract is one representation of
it. Mandate never assumes that two representations of the same underlying are
economically or legally equivalent.

## What is implemented

- **Portfolio Mandates** compile principal intent into typed, reviewable,
  signed portfolio authority without changing the frozen Core semantics.
- **Multiple agent domains** cover Stock, Swap, NFT, Yield, and Perps. Model
  output stays advisory and inside closed schemas; it cannot supply contracts,
  venues, calldata, or signatures.
- **Deterministic authority and control** re-check proposals against canonical
  identity, domain invariants, semantic bindings, live or admitted state, and
  principal limits. Unknown mandatory semantics fail closed.
- **Portfolio-global reservations** coordinate concurrent agents through one
  principal-wide ledger, including durable SQLite-backed live sessions.
- **Mandate Room** negotiates over remaining portfolio authority when otherwise
  admissible agents compete for shared capacity, then re-verifies the result.
- **V3 reusable bounded principal delegation** binds the portfolio mandate,
  allocation, session, principal, delegate, Stock agent, fixture market,
  cumulative debit limit, time window, generation, chain, and Gate.
- **No per-trade wallet signature on the supported V3 path** after the bounded
  mandate authorization and any required bounded fixture-token allowance.
  Agent and execution-delegate signatures remain required for each execution.
- **Robinhood Chain Testnet fixture settlement** exercises the deployed V3 Gate
  with valueless MDUSD/MDEMO assets.
- **Durable journal, crash recovery, and reconciliation** preserve submitted
  evidence without automatic resend after restart.
- **Policy Stress firewall** sends bounded adversarial proposals through the
  real authorization path and records explicit refusal reasons.
- **`@mandate/sdk`** exposes compile, review, delegated-authorization
  preparation, screening, reservation, execution preparation, and
  reconciliation as a thin facade over existing authority components.
- **Documentation and demo site** provide the authority model, autonomous
  execution flow, security boundaries, evidence, SDK, architecture, and
  reference material.

The deterministic verifier has final authority. Models may propose, rank,
negotiate, or abstain; they cannot widen the permitted execution set.

## Live proof

The current onchain evidence is a fixture settlement on **Robinhood Chain
Testnet**, not a production securities trade.

```text
Chain:       Robinhood Chain Testnet
chainId:     46630
V3 Gate:     0x5cf0621ab974d100fd5df225dab046bf35fa7519
Live tx:     0x95fae11bb545330f03365939dc87a1c39023717a0b00b81ae93ab6a4b25f0878
Block:       128655452
Gas used:    322661
Fixture:     64 MDUSD → 6.4 MDEMO
```

**Disclosure:** MDUSD and MDEMO are valueless demo assets. This was not an NVDA
trade and not a Robinhood Stock Token trade. The signed mandate authorized up
to $800 of Stock capital, but the testnet settlement consumed **64 fixture
MDUSD**; it is false to say that $800 settled.

Deployment evidence is committed in
[`contracts/deploy/robinhood-testnet-delegated-live.json`](contracts/deploy/robinhood-testnet-delegated-live.json).
The live receipt and evidence qualification are documented under
[`/docs/proof`](apps/web/app/docs/proof/page.tsx) and in
[`docs/demo/c2-3-delegated-execution.md`](docs/demo/c2-3-delegated-execution.md).

## Evidence model

Mandate labels evidence at the boundary where it was produced:

- **`LIVE_MODEL`** — a live model produced an advisory result under a closed
  schema. This does not imply blockchain execution.
- **`LIVE_TESTNET`** — a transaction or receipt was observed on a named
  testnet. It does not imply mainnet or production-market execution.
- **`FIXTURE`** — engineered, valueless assets or market state were used and
  are identified as such.
- **`SIMULATED`** — execution or state transition was simulated and was not
  broadcast.
- **`OFFCHAIN_ONLY`** — the domain action stopped at authorization,
  coordination, or reservation and did not settle onchain.

Authorization evidence is not settlement evidence. Recorded, simulated,
fixture, and live-testnet data are never presented as interchangeable.

## Architecture

```text
Principal intent
  → Portfolio Mandate review and signature
  → Domain agents (Stock / Swap / NFT / Yield / Perps)
  → Mandate Room coordination
  → Portfolio verifier + control invariants
  → Principal-wide reservation ledger
  → Domain execution preparation
  → V3 execution gate or offchain-only result
  → Receipt, journal, and reconciliation
```

The dependency direction is deliberately one-way. Core, ledger, and control
remain deterministic and model-free. Network, filesystem, clock, randomness,
wallet, and transaction capabilities live only at explicit outer boundaries,
with structural tests enforcing those boundaries.

The canonical long-term specification is
[`docs/mandate-design.md`](docs/mandate-design.md). Frozen Core v1 and phase
records remain as design and audit history; current release entry points are
the docs site, SDK, Live AI Lab, and committed evidence documents.

## SDK

`@mandate/sdk` does not hold the principal private key and has no public
surprise-broadcast method. The wallet signs prepared V3 typed data; the SDK
then uses the existing verifier, control, ledger, and settlement preparation
paths.

```ts
import { createMandateClient, liveLabDomainBindings } from '@mandate/sdk';

const client = createMandateClient({
  principal,
  chainId: 46630,
  now: () => protocolNow,
  bindings: liveLabDomainBindings(),
  session,
});

const draft = await client.compile({
  instruction: 'Let the Stock agent manage $800',
});
const review = client.review(draft);
if (!review.signable) return review.issues;

const prepared = await client.prepareDelegatedAuthorization(review);
if (!prepared.ok) return prepared;

// The application wallet signs prepared.prepared.typedData.
// The SDK neither signs nor stores the principal key.
await client.acceptAuthorization({
  prepared: prepared.prepared,
  signature,
  draft: review.draft,
});
client.attachAuthority({ mandate, signature, core, bindings });

const decision = await client.screen({ proposal: agentProposal });
if (!decision.authorized) return decision.reasons;

const reservation = await client.reserve(decision);
if (!reservation.ok) return reservation.reasons;
```

See [`packages/sdk/README.md`](packages/sdk/README.md) for delegated
authorization preparation, wallet-signing, execution-preparation, and
reconciliation examples.

## Running locally

Prerequisites are Node.js 22 and, for Solidity validation, Foundry 1.7.1 with
solc 0.8.37.

```bash
npm install
npm run check
```

Run the deterministic agent lab without a model credential:

```bash
npm run agents:stub
```

Run the canonical offline judge transcript:

```bash
npm run demo:judge
npm run demo:judge:json
```

Run the web experience and docs:

```bash
cd apps/web
npm run dev
```

Then open `http://localhost:3000/`, `/demo/live`, or `/docs`. Inspecting the
site and docs requires no wallet private key and no RPC secret. Live model mode
is opt-in and requires `OPENAI_API_KEY`; normal tests use stub and scripted
providers only.

Testnet deployment and send commands are intentionally absent from this quick
start. They require explicit human authorization and interactive safeguards.

## Validation

The principal release checks are commands, not marketing claims:

```bash
npm run typecheck
npm test
npm run check
npm run generated:check
npm run credentials:scan
npm run repository:junk
npm run audit:security
npm run contracts:fmt
npm run contracts:build
npm run contracts:lint
npm run contracts:test
npm run contracts:slither

cd apps/web
npm run lint
npm run typecheck
npm test
npm run build
```

The test corpus includes deterministic refusal paths, canonical encodings,
portfolio-global invariants, replay and reconciliation, cross-implementation
gate vectors, fuzzing, and invariant suites.

## Limitations

- The live Stock proof settles a labelled, valueless fixture mapping, not a
  stock, an NVDA token, or a Robinhood Stock Token.
- No mainnet deployment or production-market execution is claimed.
- Non-Stock agent domains may end as `OFFCHAIN_ONLY`; authorization support is
  not the same as a live settlement adapter.
- Mandatory natural-language semantics that cannot be compiled into supported
  typed constraints fail closed.
- V3 delegation is bounded by scope, cumulative debit, time, generation,
  chain, and Gate. It is not one approval forever.
- Mandate is not investment advice, a broker, a custody product, or a claim of
  brokerage, regulatory, or best-execution compliance.

## Docs

The web documentation routes are:

- `/docs` — overview
- `/docs/concepts` — authority model
- `/docs/execution` — autonomous execution and V3 boundaries
- `/docs/security` — threat model and Policy Stress
- `/docs/proof` — evidence classes and live-testnet proof
- `/docs/sdk` — developer integration
- `/docs/architecture` — package and trust boundaries
- `/docs/reference` — terms, reason codes, and evidence references

Repository documents include:

- [`docs/mandate-design.md`](docs/mandate-design.md) — canonical specification
- [`docs/demo/live-ai-lab.md`](docs/demo/live-ai-lab.md) — Live AI Lab and
  Mandate Room
- [`docs/demo/authority-spine-v2.md`](docs/demo/authority-spine-v2.md) — wallet
  and settlement authority spine
- [`docs/demo/c2-3-delegated-execution.md`](docs/demo/c2-3-delegated-execution.md)
  — V3 delegated execution chronology and evidence
- [`docs/demo/sdk.md`](docs/demo/sdk.md) — SDK boundaries
- [`docs/security-review.md`](docs/security-review.md) — security review record
- [`docs/adr/`](docs/adr/) — accepted architecture decisions

## Repository safety

Read [`AGENTS.md`](AGENTS.md) before contributing. Agents may create focused
local commits, but they must not push, merge, open pull requests, publish,
deploy, broadcast, or modify remote Git state. The repository owner reviews
local commits and performs all remote operations.
