# Phase 6R.1b completion report — final pre-optimization cleanup

**This is a final pre-optimization cleanup, not a new architecture phase.**
Verdict: **READY FOR INDEPENDENT PHASE 6R.1b REVIEW.** Not a deployment
approval. Phase 6R.2 has not begun; no gas optimization was attempted; nothing
was pushed, deployed or sent. MCE v2, Candidate V3, both EIP-712 domains, the
execution commitment and every gate authority decision are unchanged; every
generated corpus is byte-identical to `96f7c75`.

## Reconciliation — reservation generations

- **Old problem.** `RECONCILE` checked only that an observation's timestamp fit
  the record's reservation timeline. An observation derived from reservation 1
  (delivered late, or re-derived from an out-of-date copy of its record) was
  accepted against reservation 2 of the same mandate, returning it to `UNUSED`
  while an attempt admitted under it was still live. Double settlement stayed
  impossible; the offchain record was wrong.
- **Model.** `ReplayRecord.reservationGeneration` (bigint, uint64 range): 0
  initially, +1 on every `RESERVE`, preserved by `QUARANTINE` and `RECONCILE`,
  never reset, `RESERVE` refused at the maximum rather than wrapping.
  `ExecutionObservation.reservationGeneration` (≥ 1) is copied from the record
  it was derived from; `observationFromGateEvidence` takes it from the kernel
  record it is given, never from the caller separately. `RECONCILE` refuses any
  other generation with the new `ReplayError.STALE_RESERVATION_OBSERVATION`,
  before its timeline checks, without touching the record.
- **Why not timestamps.** A reservation can start in the same second the
  previous one was reconciled, and a re-derived stale observation carries a
  current timestamp; neither the start time nor the digest is unique per
  reservation. A counter is.
- **Retry** after a legitimate failure is unchanged (`UNUSED` → `RESERVE`).
- **Tests.** Kernel: lifecycle, stale refusal (same-second and future
  generations, SETTLED and FAILED), no-wrap, stored-shape rules. Gate package:
  the reviewer's timeline (O1 and a re-derived O1' refused against R2, B still
  settles, R2's own SETTLED and FAILED observations apply) and a randomized
  pipeline/kernel/reference-gate state machine, 200 runs × 48 steps, fixed
  seeds: 346 stale deliveries (68 of them FAILED while a current attempt was
  live), 102 settlements, 101 retries, 46 quarantines, 131 attempts-expired and
  24 mandate-expired failures, 213 overlapping admissions, 131 dead-attempt
  landings refused. Checked after every step: stale observations never move
  the record; FAILED never precedes a live attempt of its reservation; ≤ 1
  settlement; CONSUMED terminal; a settlement always belongs to the store's
  current generation. No randomized reconciliation test existed before; this
  one is new.
- **Mutation.** Removing the equality check, or applying it to SETTLED only,
  fails the deterministic regression and the randomized property.

**Rogue-attempt assumption (not redesigned).** Agents must create execution
authorizations through `admitAttemptUnderReservation` for reconciliation
guarantees to hold. Against an attempt signed outside it: double settlement and
a premature `MANDATE_EXPIRED` remain impossible; temporary kernel/chain
divergence, including FAILED followed by that attempt's settlement, remains
possible. Fixing it would need a reservation input in the signed
authorization, which this phase deliberately does not add.

## Arithmetic — the M4 boundary

- **Vector.** 38-decimal token, fixture price 52 USD at 0 decimals, fee 0,
  `maxNotional` = uint256 max at 37 decimals. The only quantity with floor max
  and a remainder: q = 22267709468714652966071343270901520741013458589546262315280304616906371084603,
  where 52 q = 10 (2^256 − 1) + 6. Floor = 2^256 − 1, remainder 6 (0.6 atom),
  mathematical ceil = 2^256. Declared notional = its floor at 36 decimals
  (11579208923731619542357098500868790785326998466564056403945758400791312963993),
  within the bound. Production decision: `MaxNotionalExceeded`, both sides.
- **Positive control:** q − 1 (floor max − 5, ceil max − 4), same declared
  notional and every other field, settles on both sides.
- `MaxNotional.t.sol` runs it on its own single-market gate (shared world
  untouched); `ExactMath.t.sol` confirms the oracle calls it unrepresentable.
- **Mutation** (out of tree, cache cleared) `floor == max → return (true, floor,
  floor)`: HEAD passes; mutant fails both new tests (190/192). The invariant
  suite does **not** kill it on its own — the boundary is a single point.
  Earlier mutants remain killed: scaled-product overflow and "accept any
  unrepresentable product" by `INV-ONCHAIN-AUTH-1` and the WIDE regression;
  raw-product overflow by the decimal-triple test; quotient-too-large by the
  decimal-triple, differential and authority tests.

## Fixture decimals

- **Old:** the gate pinned decimals, then `FixtureVenue`'s constructor read the
  representation's `decimals()` again. A caller-dependent token gave gate 18,
  venue 6.
- **New:** `FixtureVenue(representation, funding, representationDecimals,
  fundingDecimals, price, feeBps)`; the venue never calls `decimals()` and
  exposes `REPRESENTATION_DECIMALS`, `FUNDING_DECIMALS`. Price conversion,
  `FixturePriceNotRepresentable`, range checks and `TokenDecimalsChanged` are
  unchanged; `verify`'s reference venue uses the gate's pinned decimals.
- **Regression:** `CallerDependentDecimalsToken` on both legs; the venue's units
  equal the gate's, its code equals a reference built from them, and a BUY
  settles at exactly 2,006 funding units. Restoring the venue's read (both
  fields, or the unit alone) fails it. `verify` refuses reviewed venue code
  with other units.

## Deployment verification

`verify(gate, config)` verifies the configured fixture venue/adapter wiring
visible through the supplied gate. It does not authenticate the gate's
creation transaction, prove the gate was built from the reviewed initcode and
constructor arguments, or prove the config is the gate's complete market set.
Overclaims are removed from the script NatSpec, execution-gate.md, ADR 0019,
roadmap and README; the 6R.1a report has correction notes. The **final
deployment provenance gate** (execution-gate.md §13) is recorded and
deliberately deferred until Phase 6R.2 has fixed the bytecode.

## Deployment gas

Full-transaction gas (review) is ~1.12M per market: 1 → 4,256,913; 25 → —;
26 → 32,410,844; 32 → 39,171,406. Local model after 6R.1b: ~1.15M per market;
1 → 4,281,711; 25 → 31,883,667; 26 → 33,029,717; 32 → 39,933,349 (full table
in execution-gate.md §13). `MAX_MARKETS` = 32 is the configuration maximum; at
most ~25 markets fit under a 32M limit (24 conservatively); the one-market MVP
is well within. No target-chain limit is verified.

## Execution gas baseline for 6R.2

| | 6R.1a | 6R.1b |
| --- | ---: | ---: |
| BUY 10 fAAPL `execute` (4,228 B calldata) | 409,027 | 409,093 |
| SELL 10 fAAPL `execute` | 352,102 | 352,190 |
| Worst case (18,596 B; 250,496 intrinsic) | 6,646,628 | 6,646,628 |
| Gate runtime / initcode | 13,495 / 22,289 B | 13,495 / 22,392 B |

(The 6R.1a report's 250,508 intrinsic / 5,669 zero bytes did not reproduce on
the 6R.1a tree either: 250,496 / 5,670.)

## Validation

| Command | Result |
| --- | --- |
| `npm run check` | pass, **746/746** TS tests (was 741) plus all validators |
| `npm run generated:check` | pass, no artifact changed |
| `npm run audit:security` | 0 vulnerabilities (read-only registry query) |
| `contracts:fmt` / `build` / `lint` | pass |
| `npm run contracts:test` | **194/194**, 11 suites (was 189) |
| Fuzz | 22 properties × 1,024 runs |
| Invariants | 12 × 256 runs × depth 64 = 16,384 calls, 0 reverts, incl. `INV-ONCHAIN-AUTH-1` |
| Differential | 301 vectors / 308 attempts (91 settled, 217 reverted), 20 kernel-reject authority attempts refused, 139 mandate + 188 candidate encodings agree |
| Widened precision harness | **not run** — it existed only in reviewer scratch |
| Slither | 20 contracts, 101 detectors, 0 results; 12 reviewed ignored (unchanged; no new suppression) |

## Residual risks

- Rogue/unadmitted attempt orchestration assumption (above).
- Full gate deployment provenance is not implemented.
- `REAL_MARKET` inclusion-time freshness remains unsolved; `REAL_MARKET` is refused.
- Target-chain gas and deployment limits are unverified; 25 markets has ~0.1M margin in the local model.
- Hostile-adapter tests still use `vm.etch` over the gate-created adapter.
- The M4 boundary is covered by deterministic tests, not by the invariant handler.

## Commits

1. `88eec44` fix: bind reconciliation to reservation generation
2. `8465acb` test: cover max-value ceil overflow boundary
3. `e9ffb80` fix: pin fixture token decimals once
4. `a7649bd` docs: correct deployment verification and gas limits
5. this report

No push, merge, PR, publish, tag, deployment, RPC call or transaction; only
the read-only npm audit query touched the network.
