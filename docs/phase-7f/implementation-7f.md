# Phase 7F — Implementation notes

> **Status: implemented locally, offline, awaiting review.** No deployment,
> no transaction, no key beyond publicly derived demonstration keys. Nothing
> frozen changed: kernel (MCE v2, Candidate V3), Core, the ledger, the
> control engine, the registry, the execution gate and its contracts, the
> Phase 7E packages and the 7E.3 deployment artifacts are byte-identical, and
> every earlier corpus regenerates without drift. One new package
> (`packages/portfolio`) and one new corpus (`corpus/portfolio-demo-v1`).
> Specification: [portfolio-mandate.md](portfolio-mandate.md); security
> model: [security-model.md](security-model.md); the run:
> [demo.md](demo.md); decision: [ADR 0027](../adr/0027-portfolio-mandate-layer.md).
>
> **Phase 7F.1:** the security hardening in
> [security-fixes-7f1.md](security-fixes-7f1.md) supersedes the original
> handoff, custody and receipt details below. The mandate stays v1; receipts
> produced after hardening are `PORTFOLIO_RECEIPT.V2`.
>
> **Phase 7F.2:** [security-fixes-7f2.md](security-fixes-7f2.md) makes one
> signed proposal one authorization identity: the child commits the static
> quote-age bound and a window ending at the quote's expiry instead of the
> quote's age at verification, and the Core action nonce is the signed
> proposal's digest. Encodings and versions are unchanged.
>
> **Phase 7F.3:** [security-fixes-7f3.md](security-fixes-7f3.md) pins
> signing and fixture settlement to reservation generation 1
> (`RESERVATION_GENERATION_INVALID`) and refuses future-dated quotes
> explicitly. Encodings and versions are unchanged.

## Contents

1. [What was built](#1-what-was-built)
2. [How it maps onto what already existed](#2-how-it-maps-onto-what-already-existed)
3. [Decisions made while building](#3-decisions-made-while-building)
4. [Tests](#4-tests)
5. [Validation](#5-validation)
6. [Performance](#6-performance)
7. [Limits and residual risks](#7-limits-and-residual-risks)
8. [Explicit answers](#8-explicit-answers)

---

## 1. What was built

`packages/portfolio` (`@mandate/portfolio`, ~6,450 lines of source):

| Layer | Module | What |
| --- | --- | --- |
| representation | `encoding.ts`, `reasons.ts`, `resources.ts`, `scope.ts`, `mandate.ts`, `candidate.ts`, `proposal.ts`, `release.ts` | `PORTFOLIO_MANDATE.V1`, typed resources, closed-world authority scopes, five action-candidate kinds with agent claims kept apart from identity, signed proposals and releases; canonical encodings and digests |
| derivation | `authority.ts`, `child.ts` | child ⊆ parent at every level by one function (`checkChildScope`); `permits`; `ChildExecutionAuthorization` (`PORTFOLIO_CHILD_AUTHORIZATION.V1`) |
| allocation | `allocation.ts`, `availability.ts` | the allocation book (three modes, releases as lots, exactly-once reassignment, replayable log); ledger headroom |
| coordination | `screen.ts`, `room.ts` | one screening rule shared by room and verifier; the deterministic, authority-free Mandate Room |
| verification | `verifier.ts` | the Portfolio Verifier: re-derives everything the room produced |
| Core binding | `binding.ts`, `compile.ts`, `reservation.ts` | the `DomainBinding` interface; compilation into Core grants; reservation through `ControlEngine`; `checkBeforeSign` |
| output | `receipt.ts`, `status.ts`, `run.ts`, `view.ts` | `PORTFOLIO_RECEIPT.V2`; complete ordered transcript commitments; derived agent statuses; the end-to-end run; the UI data contract |
| domains | `domains/stock.ts`, `domains/perps.ts`, `domains/fixture.ts`, `domains/fixture-execution.ts`, `domains/executors.ts`, `domains/stock-custody.ts` | registry-resolved stock over GateSpotPolicy v1; PerpPolicy v1 perps; the FIXTURE module for swap, NFT and yield; fixture issuance; the default executor; the custody guard |
| demonstration | `demo/*` (exported as `@mandate/portfolio/demo`) | labelled markets, the demo mandate, publicly derived keys, five deterministic agents, `runDemo` |
| scripts | `scripts/demo.ts`, `scripts/benchmark.ts` | `npm run portfolio:demo`, `npm run portfolio:benchmark` |

## 2. How it maps onto what already existed

Nothing existing was redesigned; the portfolio layer compiles into it.

| Phase 7F need | Existing component used, unchanged |
| --- | --- |
| parent → child authority, enforced independently | Core `AuthorityGrant` delegation; the ledger's `checkDelegationSubset` at registration (`DELEGATION_WIDENS_*`) and the lineage meet at every action |
| portfolio-wide limits | `LEDGER_DIMENSION` (`CAPACITY`) on the root grant, charged by every agent's reservation |
| per-agent hard maxima | `LEDGER_DIMENSION` on each agent's delegation |
| atomic, concurrency-safe reservation | `ControlEngine.authorizeAndReserve` — the ledger's compare-and-swap |
| exact attempt durably committed before any key | `ControlEngine.admitAttempt` (`ADMIT_ATTEMPT`) |
| canonical asset and representation identity | `@mandate/registry`'s `evaluateRepresentation`, `deriveRequirements`, `narrowRequirements`, claims and provenance |
| Robinhood execution and post-signing mutation defense | GateSpotPolicy v1, `GateSigner`, `LocalGateCustody`, the frozen Phase 6 gate (reference model offline) |
| perps authorization and leverage | PerpPolicy v1 and its own `perp.max-leverage` invariant |
| signature recovery | `@mandate/execution-gate`'s `recoverSigner` (the kernel's acceptance rule) |
| shared committed notional across domains | the `NOTIONAL`/`USDC` quantity the 7E.3 cross-domain test proved shared |

## 3. Decisions made while building

Each is recorded where the code makes it; these need the owner's approval.

1. **An agent's absent hard maximum is bounded by the portfolio limit
   alone**, exactly Core's rule that a child need not restate a ledger
   dimension. Portfolio limits stay closed-world. This is what lets the perps
   agent's 600 be "locally valid" yet exceed the portfolio's 400 derivative
   exposure. (First implemented as closed-world at both levels; changed when
   the demonstration's own requirement exposed the mismatch with Core.)
2. **Allocation is coordination, not ledger state.** Preferred allocations,
   releases and reassignment live in the replayable allocation book; the
   ledger enforces the principal's hard limits. Making allocation durable
   would need new ledger events — a Core change this phase does not make.
3. **Portfolio-wide limits live on the root grant**, with an empty principal
   policy: Core's LEDGER-5 requires a granting node for a required
   contribution, and a principal-policy dimension grants nothing.
4. **The stock agent's registry requirements come from a projected kernel
   mandate.** The registry derives requirements only from a kernel mandate
   (deliberately: "no exported way to build a requirements object from
   nothing"). The binding projects one from the agent's scope; it is never
   signed, digested or executed, and the registry reads only its canonical
   asset, issuers, chains and synthetic policy.
5. **Execution is the domain's own signer's.** The default executor admits
   and simulates FIXTURE children only; stock and perps children are
   recorded `AWAITING_DOMAIN_SIGNER`. For stock, the portfolio's
   `checkBeforeSign` is placed in front of the principal key by wrapping the
   unchanged custody through the mandatory `createPortfolioGateSigner` factory.
6. **Releases are signed**, like proposals, because an unauthenticated
   release strips an agent of allocation.
7. **Fixture modules are named after their domain**: module names are
   registry-wide, which the reference registry enforced.
8. **Tags follow the kernel's spelling** (`PORTFOLIO_MANDATE.V1`, …), in their
   own namespace, as suggested; the room's `PortfolioCandidate` has no tag
   because it is never hashed or signed.
9. **Roadmap numbering.** The roadmap had planned 7F as cross-domain
   reconciliation; the owner opened 7F as this phase. Reconciliation is
   recorded as deferred and unscheduled; its number is the owner's to assign.

## 4. Tests

198 tests in 20 files, all offline and deterministic after Phase 7F.3
(193 in 19 after Phase 7F.2, 172 in 18 after Phase 7F.1).

| File | Tests | What |
| --- | ---: | --- |
| `encoding.test.ts` | 14 | canonical round trips; authoring order never reaches a digest; duplicates, malformed input, wrong tag and version, truncation, trailing bytes, non-canonical sets refused; domain-separated principal and agent signatures |
| `resources.test.ts` | 7 | capital and margin in USDC never summed; USDC vs USD notional distinct; Core's matching rule; exact rescale or refusal; closed-world portfolio limits |
| `authority.test.ts` | 19 | every `CHILD_WIDENS_*`; the {Arbitrum, Robinhood} ⊇ {Robinhood} ⊉ {Solana} and 600 ≤ 2,000 < 2,500 examples; windows; allocation rules; `permits` by name; child derivation and every tampered child refused |
| `properties.test.ts` | 5 | seeded: childAuthority ≤ parentAuthority; every single widening caught; subset soundness (thousands of permitted actions exercised); monotonic tightening (refusals only grow); exact resource limits |
| `allocation.test.ts` | 10 | three modes; release → lot → reassignment exactly once; double release/claim/commit; over-release/commit/claim; 8,000 seeded random operations with conservation and exact replay after each |
| `bindings.test.ts` | 21 | stock through the registry (look-alike excluded, counterfeit unknown, claims never identity); swap venue/route/recipient/slippage/quote; NFT contract identity; yield product/issuer/quote; perps leverage and derivative exposure; an agent outside its domain |
| `reservation.test.ts` | 14 | compilation; the ledger's own refusal of a wider limit, market or window; all five domains reserved through their real modules; the ledger's 2,000; mutation; understated demand; replay; the nonce is the signed proposal's; a drifted child is never a second action; `checkBeforeSign`; fixture issuance; one child cannot use another's reservation; SQLite store |
| `room.test.ts` | 16 | mandate refusal; accept/reduce/reject; release and reassignment by utility (and reversed); double/forged/over-release; outsider, wrong key, relayed proposal, replay, stale, extension, misdeclared, minimum, other mandate; order invariance; round bound; five-agent coalition |
| `verifier.test.ts` | 11 | honest room verified; forged signature, expired mandate; the room cannot create authority (accepted refusal, duplicate, unknown proposal, over-claim, altered commit, unsigned release, dropped commit, forged coalition, stale availability); receipt determinism and order-independence |
| `demo.test.ts` | 9 | the demonstration step by step, and its determinism |
| `malicious.test.ts` | 11 | the stock hero case in the room and around it; malicious authorized agents A–D; hostile five-agent boundary; ONCHAIN_DEFENSE_TEST against the gate's reference model: exact execution, mutation, compromised-key re-signing, replay, an unverified reservation never signed |
| `hardening-regressions.test.ts` | 8 | independent reproductions; full swap-field mutation matrix; stale quote at the reservation boundary; caller-forged verifier membership; repeated release sequence; Receipt V2 field and event-order commitments; 7F.2: decreasing/equal/doubled release sequences at the verifier; freshly signed hostile proposals refused by screening |
| `proposal-replay.test.ts` | 19 | F7F1-01: one signed proposal at many verification times is one proposal ID, one child, one action; exact freshness boundary and Core's own expiry; identity mutations; replay in every ledger state; hostile replay end to end, across two runs and through the real stock custody; 7F.3: a future-dated quote refused under the normal and the `UINT64_MAX` bound |
| `generation-pin.test.ts` | 4 | 7F.3 LOW-1: a generation 2 reserved directly through Core after a close is never admitted, signed (zero key uses) or settled; claim/reservation generation matrix; generation 1 unaffected; Core's own generation rules unchanged |
| `concurrency.test.ts` | 4 | five agents at their hard maxima under forced interleavings; twelve seeded interleavings; one child reserved ten times; two claims on one lot |
| `adversarial.test.ts` | 8 | 8,000 decoder mutations and 1,000 random byte strings — total and canonical; malformed candidates; unknown required metadata; the screen is total |
| `view.test.ts` | 4 | the UI contract: headline, timeline, rows, evidence classes |
| `corpus.test.ts` | 3 | the committed corpus is the generator's output and says what it must |
| `taxonomy.test.ts` | 4 | the codes not produced elsewhere; every reason code produced somewhere |
| `structure.test.ts` | 7 | exact dependencies; no I/O, clock, randomness or environment in source; no `any`; no signing outside the demonstration; mandatory guarded signer factory; bindings are the only domain-aware modules; nothing below depends on the package |

The security checklist of the phase brief maps onto them as follows:
unknown agent (room, vectors); malicious authorized agent (malicious A–D,
tampered children); one child vs another's reservation (reservation);
concurrent global limit and oversubscription (concurrency); release
reassigned once, double release, double reservation (allocation, room,
reservation, concurrency); stale proposal, expired mandate (room, verifier,
taxonomy); child expiry, chain, venue, asset, representation, resource
maximum (authority, properties, and Core's own refusal in reservation);
same-ticker fake, unapproved issuer (bindings, malicious, vectors); unknown
venue, unauthorized recipient (bindings, malicious); mutation after approval
(malicious, reservation, gate model); replay (room, reservation, gate model);
candidate ordering and the receipt digest (verifier); the room cannot create
authority (verifier); coalition (room, verifier, concurrency); incomparable
units (resources); malformed proposals, unknown required metadata
(adversarial, room).

## 5. Validation

Run on 2026-09-29 at the phase's final commits:

| Command | Result |
| --- | --- |
| `npm run check` | **pass** — 1,748 TypeScript tests in 332 suites across all packages, fixtures, replays, cross-surface (60 checks: 54 match, 5 not comparable, 1 unavailable, 0 mismatch), credential scan (675 tracked files; the 3 disposable testnet keys checked by value), junk check |
| `npm run generated:check` | **pass** — every earlier corpus and generated document regenerates without drift (including frozen `core-v1`, `control-v1`, `gate-v1`); the new `portfolio-demo-v1` is reproduced byte for byte |
| `npm run portfolio:demo` | **pass** — verification `VERIFIED`, four children reserved, exact Receipt V2 digest `0x4ab95270652f56891dc0bddedf2d90fb953c48db31e9053cfc839f23fa91a615`, 0 transactions |
| `npm audit --audit-level=high` | **pass** — 0 vulnerabilities |
| `git diff <phase start> -- packages/{kernel,core,ledger,control,registry,execution-gate,evm-robinhood,perp-lighter,ledger-sqlite,…} contracts docs/phase-7e docs/core-v1 corpus/<existing>` | **empty**: nothing frozen or deployed changed |
| `forge fmt`, `forge build`, `forge test`, fuzz, invariants, `slither .` | **not run**: no contract, script or Solidity dependency was touched in this phase (the gate's behaviour here is exercised through the Phase 6 reference model the frozen differential corpus proves equal to it) |

(The suite count was first recorded here as 714; the TAP output said 332 —
corrected in Phase 7F.2, audit INFO-4. The Phase 7F.2 validation — 1,769
tests in 338 suites, receipt `0x6d47bd67…41e1ad` — is recorded in
[security-fixes-7f2.md](security-fixes-7f2.md) §9.)

## 6. Performance

`npm run portfolio:benchmark`, 20 runs per scenario, Node v22.21.0,
darwin/arm64, one developer laptop; offline; measurement only (no number here
is a claim about another machine):

| Scenario | Proposals | Offchain refusals | Verified children | Room | Verifier | End to end | Receipt | Transactions | Live onchain actions needed |
| --- | ---: | ---: | ---: | --- | --- | --- | --- | ---: | ---: |
| 5 agents / 10 proposals (the demonstration) | 10 | 6 | 4 | 25.8 ms | 10.2 ms | 49.6 ms | 0.9 ms | 0 | 2 |
| 5 agents / 50 proposals | 50 | 0 | 50 | 87.0 ms | 95.4 ms | 372.8 ms | 3.5 ms | 0 | 20 |
| malicious-heavy, 80 % hostile | 50 | 40 | 10 | 71.7 ms | 20.4 ms | 127.0 ms | 2.0 ms | 0 | 5 |

(Medians. End to end: room, verifier, ledger reservation of every verified
child and fixture issuance. "Live onchain actions" counts stock and perps
children — a gate `execute` and a Lighter L2 order respectively; the fixture
domains have no live counterpart.) Reasoning, negotiation and verification
cost milliseconds and no gas; a refused proposal costs no transaction.

## 7. Limits and residual risks

- **Allocation is offchain.** A compromised room *and* verifier could
  distribute the pool unfairly between agents — never beyond an agent's hard
  maximum or the portfolio limit, and never an action outside the compiled
  Core sets. Durable allocation would need allocation events in Core.
- **No settlement reconciliation**, as in 7E.3: executed reservations stay
  `ACTIVE`, so reserved capacity is not returned after settlement or failure.
  `CONSUMED`/`RELEASED` are specified but not built.
- **Signatures are verified offchain only.** Core does not yet implement
  signatures on grants; the principal's mandate signature is checked by the
  room and the verifier, and the ledger writer is trusted to register only the
  principal's compiled grants (as the ledger writer is trusted in 7E).
- **Quote freshness is a policy over the agent's stated observation time.**
  A lying agent can claim a fresh quote; quotes never authorize anything, and
  a fixture venue's state is pinned by digest in Core, but a live yield venue
  would need its quote admitted as trusted state.
- **The stock market is an offline, engineered fixture**: USDC settlement on
  an offline gate configuration. The deployed testnet market settles `MDUSD`;
  a live shared USDC limit needs a genuinely equal unit (USDG, deferred to
  7E.4).
- **Perps are OFFCHAIN_ONLY**: no funded Lighter testnet account exists. The
  binding trusts the candidate's margin fraction offchain; Core compares with
  the admitted account state and refuses a mismatch
  (`RESERVATION_DEMAND_MISMATCH`), and PerpPolicy refuses orders below its
  minimum size.
- **Swap, NFT and yield are FIXTURE** domains with no live venue.
- **EOA agents and principal only** (`eip155-address`, secp256k1); no key
  rotation, no ERC-1271.
- **Utility is agent-supplied**: it can win an agent a larger share of
  released allocation within its cap.
- **Registry snapshot and reviewed catalogs are trusted inputs**; their
  curation is out of scope.
- **Demonstration keys are published by construction.**

## 8. Explicit answers

| Question | Answer |
| --- | --- |
| Was MCE v2, Candidate V3, the Phase 6 gate, Core, the ledger or the control engine changed? | **No** |
| Was the Phase 7E.3 deployment or any existing corpus changed? | **No**; one new corpus |
| Is child authority ⊆ parent enforced mechanically? | **Yes**, at three levels: mandate validation, child derivation, and the ledger's own delegation check; property-tested |
| Can agents exceed the portfolio limit by racing? | **No**: the ledger's compare-and-swap checks every leg; tested under forced interleavings |
| Can a coalition of all agents exceed the principal's policy? | **No**: 2,000 held in the room, the verifier and the ledger |
| Is the ticker ever identity? | **No**: the registry resolves the exact representation; a same-ticker look-alike is refused |
| Does a refused proposal cost gas? | **No**: 0 transactions |
| Were any transactions sent, contracts deployed, keys used beyond published demonstration keys? | **No** |
| Are five live integrations claimed? | **No**: Robinhood LIVE_TESTNET (7E.3), Lighter OFFCHAIN_ONLY, swap/NFT/yield FIXTURE |
