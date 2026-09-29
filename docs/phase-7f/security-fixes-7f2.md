# Phase 7F.2 — Stable proposal identity and replay hardening

> **Status: implemented locally, offline, awaiting independent review.** This
> phase changes only `packages/portfolio`, its tests, its demonstration
> corpus and Phase 7F documentation. Frozen Core, ledger, control, registry,
> Phase 6, Solidity and Phase 7E paths are byte-identical. No transaction was
> sent. No new ledger, table or replay store was added.

The final audit of Phase 7F + 7F.1 closed F7F-01 to F7F-04 and reported one
new finding. The reproduction was committed before the fix
(`proposal-replay.test.ts`, first commit of this phase) and then flipped into
the fail-closed property with the same inputs.

## 1. F7F1-01 — one signed proposal could become many actions (MEDIUM)

**Reproduced.** One valid signed 100 USDC swap proposal (and, identically, a
100 USDC yield deposit) was verified at `T` and again at `T+1`. The mandate,
the principal's signature, the proposal bytes, the agent's signature and the
candidate were byte-identical; only `verifiedAt` changed. Each run went
through the real path — room → verifier → child derivation → Core
compilation → `ControlEngine.authorizeAndReserve` — and both reserved: two
children, two Core action IDs, two ledger reservations.

**Root cause.** `deriveChildAuthorization` built the child's singleton scope
with `actionScope(action, now)`, which stored

```text
maxQuoteAgeSeconds = now − quoteObservedAt
```

in the child. The child digest committed that runtime value; the Core
action nonce was the first eight bytes of the child digest; the ledger's
reservation ID is `H(action, generation)` with generation always 1. Each
verification time therefore minted a new action the ledger had never seen.
The portfolio-wide and per-agent ledger limits still held (this was never a
global oversubscription), but one agent intent could be executed repeatedly
up to those limits.

## 2. The invariant

For a fixed Portfolio Mandate, agent, signed proposal, candidate and
proposal sequence, regardless of verification time:

```text
derive(proposal, T₁).proposalId  == derive(proposal, T₂).proposalId
childDigest(T₁)                  == childDigest(T₂)     while both are admissible
actionId(T₁)                     == actionId(T₂)        while both are admissible
```

Time decides only whether the proposal is currently admissible. It never
mints another authorization identity.

## 3. Identities, before and after

**Proposal identity (unchanged, reused).** `proposalDigest` — keccak over
the canonical binary `PORTFOLIO_PROPOSAL.V1` encoding under the portfolio
domain tag: mandate digest, agent, sequence, exact candidate (all its
fields, including `quoteObservedAt`, amount, minimum out, venue, route,
recipient), requested and minimum resources, utility, window, critical
extensions. It is the signed *message's* digest: the agent signs
`keccak("PORTFOLIO_PROPOSAL_SIGNATURE.V1" ‖ proposalDigest)`. It depends on
no signature encoding, `verifiedAt`, availability, room output, ledger state,
quote age or caller-supplied hash. No JSON is hashed.

**Quote freshness.**

| | Before | After |
| --- | --- | --- |
| freshness check | `permits`: `now − quoteObservedAt ≤ bound` | unchanged — `permits(scope, action, now)` still compares the age at `now` (a predicate) |
| child scope's `maxQuoteAgeSeconds` | the age at derivation: `now − quoteObservedAt` | the static policy bound: the tightest of the agent's and the portfolio's `maxQuoteAgeSeconds` (`quoteAgeBound`) |
| quote observation time | via the candidate digest | unchanged — via the candidate digest |
| child `expiresAt` | min(proposal, agent, portfolio) | min(proposal, agent, portfolio, `quoteExpiresAt`) |

```text
quoteExpiresAt(observedAt, bound) = observedAt + bound + 1     (exclusive, like every expiresAt)
now − observedAt ≤ bound   ⇔   now < quoteExpiresAt
```

`quoteExpiresAt` is a function of the signed observation time and static
policy only. Exact bigint arithmetic cannot overflow; the result is narrowed
by windows that are themselves valid `i64` seconds. A quote observed after
`now` is still `QUOTE_STALE` (Phase 7F.3 made that refusal explicit rather
than a sentinel age a `UINT64_MAX` bound could admit —
[security-fixes-7f3.md](security-fixes-7f3.md) §2); a missing bound still permits
no quote (`QUOTE_NOT_ALLOWED`); `deriveChildAuthorization` additionally
refuses rather than ever emitting an empty window.

**Child identity.** Encoding unchanged (`PORTFOLIO_CHILD_AUTHORIZATION.V1`).
Before: its scope carried a time-derived value. After: every field is a
function of the mandate, the signed proposal and the resolved action; the
child is therefore the same whenever it is derived. Reservation and
pre-sign re-derive the child at their own time and now require it to equal
the verified child **byte for byte** (`CHILD_ACTION_MUTATED` otherwise)
instead of comparing selected fields.

**Core action identity.** Envelope unchanged (Core's `ActionEnvelope`).

| | Before | After |
| --- | --- | --- |
| nonce | first 8 bytes of the child digest (`childNonce`) | first 8 bytes of the signed proposal's digest (`actionNonce`) |
| window | the child's | the child's (now ending at the quote's expiry) |
| payload | binding's: FIXTURE commits the child digest; stock and perps are the candidate's | unchanged |
| generation | 1 | 1 |

Taking the nonce from the proposal is defence in depth. The stock binding
resolves rights, issuer and backing through the registry, whose claim
freshness is evaluated at `now`; had a claim's freshness changed between two
verifications, the child could differ. For stock and perps the action ID is
now fixed by the signed proposal alone (payload from the candidate, window
and nonce from the proposal), so such a drift cannot mint a second action; a
drifted child is anyway not the verifier's and is refused
(`CHILD_AUTHORIZATION_UNKNOWN`). A FIXTURE payload still commits the child
digest — the action-commitment semantics are unchanged — and FIXTURE
resolution has no time input other than the quote, now removed. The nonce is
never random and never chosen by the Mandate Room.

## 4. Replay is enforced by the existing ledger

No second replay database. The ledger's reservation ID is
`H(actionId, generation)` and Portfolio reserves only generation 1, so the
same signed proposal is refused whatever state its reservation reached:

| Ledger state of the first reservation | Second reservation of the same proposal |
| --- | --- |
| `ACTIVE` (RESERVED) | `RESERVATION_EXISTS` |
| `ACTIVE` with an `ADMIT_ATTEMPT` (ADMITTED) | `RESERVATION_EXISTS`; no second attempt is written (`admitAttempt` on that reservation returns the existing one) |
| `CLOSED` by `closeNeverIssued` | `RESERVATION_EXISTS` |
| consumed and `CLOSED` (settled) | `RESERVATION_EXISTS` |
| stale quote | `QUOTE_STALE` before the ledger (room, verifier, reservation, pre-sign), and Core's own `ACTION_EXPIRED` for the compiled action |

(The control engine surfaces the ledger rule as
`REQUEST_INVALID/RESERVATION_EXISTS`.)

**Retry semantics.** A signed proposal has exactly one authorization
identity and at most one reservation, ever. A pre-execution failure that
closes the reservation (`closeNeverIssued`) spends the proposal: retrying
the same logical action means the agent signs a **new** proposal (a new
sequence, hence a new identity), which is screened, verified and bounded
afresh. Core's ledger could admit generation 2 of the same action after a
close; Portfolio deliberately does not use it — a ledger-controlled retry of
the same `proposalId`/`actionId` at the next generation would be the only
acceptable form, and it is not built. Once settled, replay stays refused
permanently. (Phase 7F.3 enforces generation 1 at the signing boundary too:
a generation 2 reserved directly through Core is never signed, admitted or
settled as a Portfolio child — [security-fixes-7f3.md](security-fixes-7f3.md)
§1.)

## 5. Proposal sequence

The verifier enforces strictly increasing per-agent proposal sequences
within one transcript (`PROPOSAL_REPLAYED`). Its role is transcript ordering
and part of each proposal's identity; it is not durable. Durable replay of
the *same* signed proposal is enforced by the stable action identity and the
ledger (§4) and needs no high-water mark, so none was added.

What sequence does **not** do: an agent that signed several *different*
proposals may have any unreserved one presented in a later run, until its
own `expiresAt` or, for a quote-bearing one, its quote's expiry. Each such
proposal is still the agent's genuine signed intent, is still re-screened in
full, can be reserved at most once, and is bounded by the agent's hard
maxima, the portfolio limits and Core. Agents that need an older, superseded
proposal to die sooner must sign short windows. A durable per-agent
high-water mark would be new persistent state in or beside Core — an
architecture change this phase does not make.

## 6. Versioning

- `PORTFOLIO_MANDATE.V1`: unchanged; no principal-signed semantics changed.
- `PORTFOLIO_PROPOSAL.V1`: unchanged.
- `PORTFOLIO_CHILD_AUTHORIZATION.V1`: encoding unchanged, and so is the
  meaning of its bytes (a scope bound and a window). Only the derivation rule
  selects different values: the policy bound instead of the observed age, and
  a window ending at the quote's expiry. A child derived under the old rule
  is not re-derived by the current verifier, so it fails closed at
  reservation (`CHILD_AUTHORIZATION_UNKNOWN`) and is never reinterpreted.
- `PORTFOLIO_RECEIPT.V2`: encoding unchanged. The demonstration receipt's
  digest changes because its content changed (swap and yield child scope and
  window; every action and reservation ID through the nonce):
  `0x6d47bd67ee0431991a9c4412ad3215421455f9882fa0793a2f6365fb2641e1ad`.
- Core action envelope, Candidate V3, MCE v2: unchanged.

## 7. Tests

`proposal-replay.test.ts` (18) and additions to `reservation.test.ts` (+1)
and `hardening-regressions.test.ts` (+2):

- the reproduction, flipped: swap and yield at `T` and `T+1` — one proposal
  ID, one child, one action ID, second reservation `RESERVATION_EXISTS`;
- every still-fresh time from `T` to the last fresh second derives the same
  identities, through screening and through room + verifier;
- the exact boundary: age = bound fresh, age = bound + 1 `QUOTE_STALE` with
  no child; child and Core envelope `expiresAt` = `quoteExpiresAt`; Core's
  `decide` refuses the action as `ACTION_EXPIRED` at that instant;
- a future quote or a missing bound derives no child;
- quote time, amount, minimum out, venue and recipient each change the
  proposal and candidate identity (child and action too, where admissible);
  time alone changes nothing;
- replay in every ledger state (§4 table);
- hostile end to end: reservation, `ADMIT_ATTEMPT`, pre-sign pass, then a
  malicious room replays the exact signed swap while fresh and after expiry —
  one reservation, one attempt, one pre-sign pass, and verifier, reservation
  and pre-sign all `QUOTE_STALE` late; swap and yield across two Portfolio
  runs settle once with one executor call; the stock child through the real
  guarded custody uses the principal key once and sends one
  (reference-model, simulated) transaction;
- the nonce is the proposal's; a drifted stock child compiles to the same
  action and is never reserved;
- audit INFO-2 and INFO-3 (§8).

## 8. Audit INFO items

- **INFO-1.** [security-fixes-7f1.md](security-fixes-7f1.md) §4 overstated
  that a replayed release "can only reduce" allocation. Corrected: it can
  create an offchain lot another agent may claim, bounded by that agent's
  hard maxima, the portfolio limits and the Core ledger.
- **INFO-2.** The verifier's release-sequence rule is now covered directly:
  strictly decreasing and equal sequences are `RELEASE_SEQUENCE_INVALID`; a
  doubly applied release is refused by the book's own replay
  (`CANDIDATE_BOOK_MISMATCH`) first. The logic was not rewritten.
- **INFO-3.** Freshly **signed** hostile proposals — minimum out 0,
  slippage one basis point over the agent's bound, a quote one second stale
  — are refused by real screening (`SLIPPAGE_NOT_ALLOWED`, `QUOTE_STALE`) in
  the room, and by the verifier when a malicious room commits them anyway;
  nothing is reserved.
- **INFO-4.** [implementation-7f.md](implementation-7f.md) said 714 suites;
  the TAP output at that commit said 332. Corrected.

## 9. Validation

Run on 2026-09-29 at the phase's final code commit:

| Command | Result |
| --- | --- |
| `npm run check` | **pass** — 1,769 TypeScript tests in 338 suites (1,748 / 332 before; +21 tests, +6 suites), fixtures, replays, cross-surface (60 checks: 54 match, 5 not comparable, 1 unavailable, 0 mismatch), credential scan and junk check (676 tracked files) |
| `npm run generated:check` | **pass** — every corpus and generated document regenerates without drift; `portfolio-demo-v1` is the committed regeneration |
| `npm run portfolio:demo` | **pass** — `VERIFIED`, 0 transactions, receipt `0x6d47bd67…41e1ad` |
| `npm audit --audit-level=high` | **pass** — 0 vulnerabilities |
| portfolio suites, 5 consecutive runs | 193/193 each time (replay suite also 3 further runs) |
| `git diff 529c381 -- contracts packages/{kernel,core,ledger,control,registry,ledger-sqlite,execution-gate,evm-robinhood,perp-lighter} docs/phase-7e docs/core-v1 corpus/<every corpus but portfolio-demo-v1>` | **empty** |
| Foundry, Slither | **not run**: no Solidity, script or Solidity dependency changed |

## 10. Residual risks

- Different, unexpired signed proposals from one agent remain individually
  reservable once each (§5); there is no durable proposal high-water mark.
- A retry after a pre-execution failure needs a new signed proposal (§4).
- Stock children can still, in principle, be re-derived differently if the
  registry's claim freshness changes between verification and reservation;
  that is refused at the boundary (`CHILD_ACTION_MUTATED`) and can never mint
  a second action (the action ID is the proposal's).
- Quote freshness is still a policy over the agent's stated observation time
  (implementation-7f.md §7): a lying agent can claim a fresh quote; it cannot
  make one signed proposal fresh twice.
- Allocation and release replay across runs are unchanged from 7F.1: offchain,
  bounded by every agent's hard maxima, the portfolio limits and the ledger.
