# Phase 7F.3 — Final Portfolio freeze hardening

> **Status: implemented locally, offline, awaiting review.** This phase
> changes only `packages/portfolio` (its signing boundary, fixture execution,
> quote-freshness predicate, reason vocabulary and tests) and Phase 7F
> documentation. Core, the ledger, the control engine, the registry, Phase 6,
> Solidity and Phase 7E paths are byte-identical; so is every committed
> corpus, `portfolio-demo-v1` included. No transaction was sent. No replay
> store, table or ledger was added.

The final narrow audit of Phase 7F.2 closed F7F1-01 and classified the phase
**B — pass with LOW/INFO findings**: one LOW finding to fix before freeze,
one INFO correctness cleanup, and two INFO residuals to document. Each fix
was reproduced before it was made.

## 1. LOW-1 — a Core generation 2 reached the Portfolio signing boundary

**The invariant.**

```text
one signed proposal → one proposal identity → one child → one Core action → at most one reservation, ever
```

**Reproduced** (`generation-pin.test.ts`, first commit of this phase,
recording the pre-fix behavior). Portfolio reserves only generation 1
(`requestFor`), and a replay of the same signed proposal through Portfolio
stays `RESERVATION_EXISTS`. Core itself grants generation 2 of an action
once generation 1 is closed — a Core feature for callers that retry an
action. A party with direct access to the control engine could therefore:

1. let Portfolio reserve a signed yield (or stock) proposal at generation 1;
2. close it `NEVER_ISSUED`;
3. call `core.engine.authorizeAndReserve` with the child's exact action at
   generation 2 — `AUTHORIZED` by Core;
4. hand generation 2 to Portfolio: `executeFixtureChild` admitted an attempt
   and its `checkBeforeSign` passed; through the real guarded Robinhood
   custody (with an integrator mapping that reservation to the verified
   child), the principal key signed once and the gate executed once.

`checkBeforeSign` compared the claimed generation with the reservation's,
but neither with the one generation Portfolio ever uses.

**Fix.** Generation 1 is a named Portfolio policy, `PORTFOLIO_GENERATION`,
enforced where Portfolio reserves and, independently, wherever a key or a
settlement could follow:

| boundary | rule |
| --- | --- |
| `requestFor` | reserves `PORTFOLIO_GENERATION` only (unchanged behavior, now named) |
| `checkBeforeSign` | the claimed generation **and** the reservation's generation must both be `PORTFOLIO_GENERATION`; otherwise `RESERVATION_GENERATION_INVALID` (`claim:<g>` / `reservation:<g>`), alongside every other reason |
| `executeFixtureChild` | refuses a record of any other generation with `RESERVATION_GENERATION_INVALID` **before** admitting an attempt |
| guarded Robinhood custody | runs `checkBeforeSign` in front of the key, so the rule above applies before any signature |

`RESERVATION_GENERATION_INVALID` is added to the handoff group of the
provisional reason vocabulary (portfolio-mandate.md §16).

**Core is unchanged.** Core still refuses generation 2 while generation 1
is open (`PREVIOUS_GENERATION_OPEN`) and still grants it after a close, to
any caller; the regression asserts both. Portfolio simply never signs,
admits or settles it.

**After the fix**, with the same inputs: the direct generation 2 is still
`AUTHORIZED` by Core, but the yield child admits no attempt, the default
executor reports `FAILED` with zero transactions and no attempt, and the
stock child through the real custody uses the principal key **zero** times
and sends **no** transaction. The unchanged Phase 7E.3 `GateSigner` admits
its own `ADMIT_ATTEMPT` before asking custody, so that one attempt exists
for the generation-2 reservation; with that exact attempt the only reasons
`checkBeforeSign` returns are the two generation refusals.

## 2. INFO-2 — a future-dated quote under a maximum quote-age bound

**Reproduced** (the new `proposal-replay.test.ts` case, before the fix).
`quoteAge` gave a quote observed after `now` the sentinel age `UINT64_MAX`,
"older than any bound". `maxQuoteAgeSeconds` is validated up to
`UINT64_MAX`, and the subset rule refuses only an age strictly greater than
the bound, so under a `UINT64_MAX` agent and portfolio bound a quote dated
one second in the future was fresh and derived a child. Only the principal
can configure such a bound; the refusal should not depend on it.

**Fix.** A future quote has no age: `quoteAge` returns `null` for it, and
`permits` refuses `quoteObservedAt > now` explicitly, by exact bigint
comparison, before and independently of any bound — `QUOTE_STALE`, or
`QUOTE_NOT_ALLOWED` where the scope permits no quote. These are the codes
every other bound already produced, so no other outcome changes.

| quote | normal bound (60 s) | `UINT64_MAX` bound | no bound |
| --- | --- | --- | --- |
| observed at `now + 1` | `QUOTE_STALE` | `QUOTE_STALE` (was: child derived) | `QUOTE_NOT_ALLOWED` |
| observed at `now` | fresh, age 0 | fresh, age 0 | `QUOTE_NOT_ALLOWED` |
| age = bound | fresh | fresh | — |
| age = bound + 1 | `QUOTE_STALE` | unreachable | — |

The child's committed scope (the static bound), its window (ending at
`quoteExpiresAt`) and every identity from Phase 7F.2 are unchanged.

## 3. INFO-1 — the 64-bit Core nonce (accepted residual)

The Core action nonce is the first eight bytes of the signed proposal's
digest. The action ID is not the nonce: it is keccak over the complete
action envelope — principal, authority (the agent's delegation), actor (the
agent), module, action type, adapter, target, resources, payload digest,
window and nonce.

- **Swap, yield, NFT (FIXTURE).** The payload commits the child digest,
  which commits the full 32-byte proposal digest. Two different proposals
  have different action IDs even with equal nonces.
- **Stock, perps.** The payload is the candidate's. Two proposals by the
  **same** agent with the same payload and window differ only in the nonce.
  That agent — the only party able to sign them — could grind about 2³²
  proposals to make two of its own collide. The result is that its second
  proposal is refused (`RESERVATION_EXISTS` / `PREVIOUS_GENERATION_OPEN`);
  the shared reservation covers an identical payload and demand, and stock
  issuance is idempotent. It cannot increase authority, and it cannot
  collide across agents (actor and authority are committed) or be caused by
  the Mandate Room (which signs nothing and cannot choose the nonce).

Accepted as a low-impact, self-inflicted availability residual. No larger
nonce is introduced; the Core envelope is frozen.

## 4. INFO-3 — stock child and registry claim freshness (accepted residual)

A stock child's required rights, issuer and backing are resolved through the
registry, whose claim freshness is evaluated at `now`. A stock child could
therefore, in principle, differ between two verification times. That cannot
multiply a proposal:

- the proposal identity is the signed proposal's digest, unchanged;
- the compiled action identity is unchanged — its payload is the
  candidate's, its window the proposal's, its nonce the proposal's;
- a drifted child is not the verifier's and is refused at reservation
  (`CHILD_AUTHORIZATION_UNKNOWN`), and a child that drifts between
  verification and reservation or signing is `CHILD_ACTION_MUTATED`;
- the ledger refuses a second reservation of the same action.

The stock registry semantics are not redesigned.

## 5. Tests

`generation-pin.test.ts` (4) and one case in `proposal-replay.test.ts`:

- the audit reproduction, flipped: Portfolio replay `RESERVATION_EXISTS`;
  direct Core generation 2 `AUTHORIZED` by Core; yield refused before any
  attempt, `FAILED` through the default executor with zero transactions;
  stock through the real custody with zero key uses and zero transactions;
- claim 2 against reservation 2 (only the generation reasons remain), claim
  1 against reservation 2, claim 2 against reservation 1 — all refused;
- the exact generation-1 path executes and passes `checkBeforeSign`; its
  replay is `RESERVATION_EXISTS`;
- Core outside Portfolio: generation 2 while generation 1 is open is
  `PREVIOUS_GENERATION_OPEN`, after a close it is granted — unchanged;
- a quote observed at `now + 1` refused under the normal and the
  `UINT64_MAX` bound, through screening and `permits` at both levels; at
  `now`, fresh under both; with no bound, `QUOTE_NOT_ALLOWED`.

## 6. Validation

Run on 2026-09-29 at the phase's final code commit:

| Command | Result |
| --- | --- |
| `npm run check` | **pass** — 1,774 TypeScript tests in 340 suites (1,769 / 338 after 7F.2; +5 tests, +2 suites), fixtures, replays, cross-surface (60 checks: 54 match, 5 not comparable, 1 unavailable, 0 mismatch), credential scan and junk check (678 tracked files) |
| `npm run generated:check` | **pass** — every corpus and generated document regenerates without drift; `portfolio-demo-v1` is unchanged |
| `npm run portfolio:demo` | **pass** — `VERIFIED`, 0 transactions, receipt `0x6d47bd67ee0431991a9c4412ad3215421455f9882fa0793a2f6365fb2641e1ad` (unchanged from 7F.2) |
| `npm audit --audit-level=high` | **pass** — 0 vulnerabilities |
| portfolio suites, 3 consecutive runs | 198/198 each time |
| `proposal-replay.test.ts` / `generation-pin.test.ts`, 5 runs each | 19/19 and 4/4 each time |
| `git diff de18bf2 -- contracts packages/{kernel,core,ledger,control,registry,ledger-sqlite,execution-gate,evm-robinhood,perp-lighter} docs/phase-7e docs/core-v1 corpus` | **empty** — every corpus, `portfolio-demo-v1` included |
| Foundry, Slither | **not run**: no Solidity, script or Solidity dependency changed |

## 7. Residual risks

Unchanged from Phase 7F.2 (security-fixes-7f2.md §10), plus the two accepted
INFO residuals above:

- different, unexpired signed proposals from one agent are each reservable
  once; there is no durable proposal high-water mark;
- a retry after a pre-execution failure needs a new signed proposal;
- the 64-bit nonce permits only a self-inflicted collision between one
  agent's own stock or perps proposals (§3);
- a stock child may drift with registry claim freshness but never becomes a
  second action (§4);
- quote freshness remains a policy over the agent's stated observation time;
- allocation and release replay across runs remain offchain and bounded by
  every agent's hard maxima, the portfolio limits and the ledger.
