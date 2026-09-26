# Phase 6R.1a completion report — reconciliation coherence and fixture trust closure

**Verdict: READY FOR INDEPENDENT PHASE 6R.1a REVIEW.** This is not a deployment
approval. Phase 7 has not begun, no gas optimization was attempted, nothing was
deployed and no transaction was sent. The only executable market class is still
a labelled, fixed-price settlement fixture. MCE v2, Candidate V3, the Phase 6R.1
true-gross `maxNotional` rule, exact FILL_OR_KILL and the replay guarantees are
unchanged.

The independent Phase 6R.1 review confirmed M-1 closed and found two Medium
issues and two Low test gaps. This phase fixes all four.

## 1. Reconciliation model, before and after

| | Phase 6R.1 | Phase 6R.1a |
| --- | --- | --- |
| FAILED for an unconsumed mandate | only once a final block reached the **mandate's** expiry | once a final block is past the **reservation's** expiry (`ATTEMPTS_EXPIRED`), or at the mandate's expiry (`MANDATE_EXPIRED`) |
| After one reverted attempt on a 30-day mandate | `OUTCOME_UNESTABLISHED` for 30 days; the kernel refuses a retry (`MANDATE_RESERVED`, then `MANDATE_QUARANTINED`); FAILED finally restores an authorization `verify` refuses as `MANDATE_EXPIRED` | FAILED as soon as the reservation's ceiling passes; `RECONCILE` → `UNUSED`; re-reserve; retry |
| Input | attempt record with a caller-asserted `mandateExpiresAtUnixSeconds` | the mandate's signed MCE v2 bytes, the kernel replay record, and the signed attempts with their commitments |
| Signing rule | none | `admitAttemptUnderReservation` before every signature |

Kernel replay semantics are unchanged: `RECONCILE(FAILED)` still means "back to
`UNUSED`, retry permitted", which is now true again for gate executions.

## 2. Attempt-deadline semantics

- An attempt may be signed only through `admitAttemptUnderReservation`, which
  requires the kernel record for the mandate's digest to be `RESERVED`, the
  pipeline's clock to be before the reservation's expiry, and the attempt's
  deadline to be **at or before** that expiry. It returns the commitment to sign
  and the record to store.
- The reservation's expiry is therefore a single ceiling on every attempt signed
  under it, however many exist at once. At most `MAX_ATTEMPTS_PER_RESERVATION`
  (8) are recorded; a rebroadcast of an admitted attempt is not a new one.
- The gate refuses `block.timestamp > deadline`, and chain timestamps never
  decrease. A final unconsumed reading at a block past the ceiling therefore
  proves no attempt under the reservation can land. Attempts under an earlier
  reservation were already past that reservation's ceiling when it was
  reconciled FAILED.
- Mandate expiry is separate: a final unconsumed reading at or after
  `expiresAt` is FAILED with basis `MANDATE_EXPIRED`, whatever attempts exist.
- **Nothing is taken on trust.** The mandate digest and expiry are derived from
  the signed bytes (other bytes are `EVIDENCE_MISMATCH`). Each recorded attempt's
  commitment must re-derive from its fields, so its deadline is the one the gate
  enforces (`EVIDENCE_INCONSISTENT`, or `ATTEMPT_INCONSISTENT` at admission).
  The reservation must be the kernel record for that digest
  (`RESERVATION_MISMATCH`, `NOT_RESOLVABLE`).
- **Assumption:** attempts are signed only through the admission rule. An attempt
  signed outside it still cannot settle twice. If it settles, the result is
  `SETTLED` with `settledByRecordedAttempt: false`. A record carrying an attempt
  past its reservation proves the rule was broken, and is refused
  (`ATTEMPT_OUTSIDE_RESERVATION`) until the mandate expires.

## 3. Retry-after-failure demonstration

`reconciliation.test.ts`, "retries after a failed attempt while the mandate is
valid, and still settles at most once", runs a 30-day mandate through the
reference model and the kernel's own `applyTransition`:

1. RESERVE T0..T0+600. Admit attempt A, deadline T0+300. A never lands.
2. At T0+301 the gate refuses A (`ExecutionDeadlinePassed`), yet it would still
   authorize an attempt with deadline T0+600 at T0+600. So readings at T0+301
   and T0+600 are `OUTCOME_UNESTABLISHED`.
3. At T0+601: FAILED, basis `ATTEMPTS_EXPIRED`, referencing A. `RECONCILE` →
   `UNUSED`, with 30 days of validity left.
4. RESERVE again. Admit attempt B, deadline T0+1000. The gate refuses A and
   authorizes B. B's settlement reads `SETTLED`, recorded attempt, and
   `RECONCILE` → `CONSUMED`.
5. B again, and a fresh attempt C, are refused `MandateAlreadyConsumed`; RESERVE
   on the consumed record is refused.

## 4. No-premature-FAILED demonstration

"never reports FAILED while any attempt under the reservation can still land":

- Attempts A (deadline T0+300) and A2 (T0+550, a different funding limit) are
  live under one reservation to T0+600.
- The gate authorizes A2 at T0+400 and T0+550 (inclusive), and refuses it at
  T0+551.
- Readings at T0+301, 400, 550, 551 and 600 are all `OUTCOME_UNESTABLISHED`.
  FAILED arrives only at T0+601 and names A2.
- An A2 settlement read at any later block is `SETTLED`, not FAILED.

Also covered: admission at the ceiling is accepted and one second past it is
refused; admission after lapse, or under a `QUARANTINED`, `UNUSED` or foreign
record, is refused; the attempt limit and rebroadcasts; tampered deadlines;
foreign mandate bytes; mandate expiry reported as its own basis.

## 5. Fixture adapter identity enforcement

`MarketConfig` no longer contains an adapter; it carries the fixture fee.
For each market the constructor creates
`new FixtureVenueAdapter(address(this), venue)` from code compiled into the gate.
No constructor input can name any other adapter.

- Tests check that the adapter is the gate's CREATE 2i+2, that `GATE()` is the
  gate and `VENUE()` is the gate-created venue, and that its runtime code equals
  a reference `FixtureVenueAdapter(gate, venue)`.
- Immutables are part of runtime code, so equal code means equal implementation
  and equal wiring.

## 6. Fixture venue identity enforcement

The constructor likewise creates `new FixtureVenue(representation, funding,
price, fee)`, returned by `fixtureVenueOf(key)` and logged by `MarketSupported`.

- Tests check the venue's CREATE address, tokens, price, unit and fee, and that
  its runtime code equals a reference instance.
- The venue has no setter; every parameter is immutable.
- A call to a `setPrice` selector reverts, and the price is unchanged.

**The gate's runtime code alone proves nothing about its markets**: other
initcode could return identical runtime code with a different table. So
`DeployMandateGate.verify(gate, config)` compares the deployed adapter and venue
runtime code with reference instances built in the script's own unbroadcast
execution. `deploy` runs it after deploying, and it can be run read-only
against any deployment. It refuses:

- adapter code substituted at the address (`FixtureAdapterNotReviewedCode`);
- venue code substituted at the address (`FixtureVenueNotReviewedCode`);
- a config the gate was not built from (`MarketNotAsConfigured`);
- the gate's runtime code without its market table (`MarketNotAsConfigured`).

## 7. Token and price wiring verification

| Relationship | Established by |
| --- | --- |
| gate market config → adapter | the gate creates it; no input names one |
| adapter → reviewed implementation | embedded creation code; checked by runtime-code equality |
| adapter → venue, adapter → gate | constructor arguments the gate supplies |
| venue → reviewed implementation | embedded creation code; checked by runtime-code equality |
| venue → representation, funding token | the market's configured tokens |
| venue price = gate fixture price | one typed price, converted exactly by the gate |

The conversion is `atoms × 10^(fundingDecimals − priceDecimals)`, or exact
division when the price is finer than the funding token. It refuses
`FixturePriceNotRepresentable` for a remainder or an overflow; this replaces
`FixtureSettlementInconsistent`. Tested at price scales 0, 6, 7, 18 and 38, with
18-decimal funding, a price finer than the funding token, an overflowing
conversion, and another funding token. `IFixtureSettlement` is removed in its own
commit.

## 8. Malicious-adapter PoC, before and after

- **Before** (the Phase 6R.1 review, on `665ca73`): a directly constructed gate
  with an adapter that reports 200 USD/token and keeps whatever it is given.
  BUY 0.5 token (100 USD at the fixture price) under a 100 USD `maxNotional` and
  a 1,000 USD `MAX_TOTAL_DEBIT` settled with a **500 fUSDC** debit.
- **After:** the review's test no longer compiles against this tree; there is no
  `adapter` field and no `IFixtureSettlement`. `FixtureTrust.t.sol` keeps the
  same `LyingAdapter` deployed and stocked, constructs the gate directly, and
  shows the gate's adapter is not it. The same BUY, with 1,000 fUSDC made
  available, debits exactly `quoteBuy` = **100.3 fUSDC** (100 USD plus 30 bps).
  SELL credits exactly 99.7.

## 9. Look-alike venue PoC, before and after

- **Before:** the genuine `FixtureVenueAdapter` wired to a venue with identical
  views and a `buy` that takes the whole allowance: the same BUY settled with a
  **1,000 fUSDC** debit. A mutable-price look-alike could also change its price
  after the constructor's one-time read.
- **After:** the adapter's venue is the gate-created `FixtureVenue`.
  `LookAlikeVenue` stays deployed, stocked and repriced to 2,000 USD, and is
  unreachable. The BUY pays 100.3 fUSDC, and `verify` refuses a look-alike's code
  at the venue address.

## 10. Overflow-only regression

`test_m1_unrepresentableProductIsTheOnlyRefusal` runs on a new WIDE market:
wAAPL with 1 decimal against fUSD0 with 0 decimals, at 1 USD, no fee.

- The bound is uint256 max at 38 decimals, V ≈ 1.1579 × 10^39 USD.
- Buying or selling V's integer part plus 0.7 of a token makes quantity × price
  at 38 decimals exceed 2^256. The exact oracle confirms the product is
  unrepresentable and the declared notional (the floor at 0 decimals) is within
  the bound.
- The gate refuses `MaxNotionalExceeded`. A control one tenth of a token lower
  is representable and within the bound, and settles.

The invariant handler gains `executeWideOverflow`: the same shape at any bound
precision 10..38, on either side, with controls. Mutating the branch to accept
in an out-of-tree copy (failure cache cleared):

- **`INV-ONCHAIN-AUTH-1` fails on its own**, shrunk to one
  `executeWideOverflow` call;
- the regression fails ("settled with a true gross beyond every uint256 bound");
- the non-vacuity test fails.

Before this phase no invariant or test assertion caught that mutant. Removing
the product check, using its floor, or an off-by-one bound also break the
invariant alone.

## 11. Fuzz-oracle repair

The committed fuzz oracle computed `declared * 10**md` in plain uint256. It
panicked for valid inputs, for example the review's
`(1e30, 37, 233, 254, false, true)`, and a second input the fuzzer reached once
this phase changed the gate's bytecode.

`contracts/test/utils/ExactMath.sol` replaces it:

- It reduces both sides by their common power of ten and compares 512-bit
  products. It never divides, and cannot overflow for any uint256 operand at any
  decimal 0..38. Its floor and ceiling come from binary search on that exact
  comparison.
- `ExactMath.t.sol` checks it against plain arithmetic where that cannot
  overflow, against hand-computed extremes, and for the floor/ceiling definition
  at full width.

New tests on top of the oracle:

- both panicking inputs, as permanent replays;
- all 39 × 39 declared × principal precision pairs on each side through the real
  venue (1,521 signed attempts per side);
- the product rule against the oracle at full operand width (fuzz) and at all
  39³ decimal triples;
- the invariant's true-gross check now uses `ExactMath` as well.

## 12. Full test totals

| Command | Result |
| --- | --- |
| `npm run check` | pass — **741/741** TypeScript tests, plus fixture/replay/routing/cross-surface/Jev validation, credential scan, junk check |
| `npm run generated:check` | pass — every committed corpus and reason-code document matches its generator |
| `npm run audit:security` | **0 vulnerabilities** (read-only npm registry query; see §20) |
| `npm run contracts:fmt` / `contracts:build` / `contracts:lint` | pass |
| `npm run contracts:test` | **189/189** across 11 suites |

The 189 break down as 78 unit, 33 adversarial, 12 codec, 16 maxNotional (14 + 2
fuzz), 15 fuzz, 4 differential, 10 deployment, 4 fixture trust, 3 `ExactMath`
(1 + 2 fuzz), 1 profile and 13 invariant (12 + a deterministic non-vacuity test).

M-1 remains closed. The kernel's M-1 tests (`max-notional.test.ts`) pass in the
TypeScript suite. The three audit PoCs, precision 0–38, every precision pair and
the overflow-only case are refused in the gate, and the invariant discriminates
every tested mutant of the rule.

## 13. Fuzz and invariant totals

- 22 fuzz properties at 1,024 runs each.
- 12 invariants at 256 runs × depth 64 = 16,384 calls each, with 0 reverts.
- Seven handler actions, all exercised; about 2,300 WIDE calls per invariant run.

## 14. Differential results

**Committed corpus:**

- 301 vectors / 308 attempts agreed (91 settled, 217 reverted);
- 20 actual-kernel REJECT authority attempts refused;
- 139 mandate and 188 candidate encodings agreed;
- 64 seeded precision vectors where kernel and gate agree (38 rejected by both,
  26 admitted by both, 27 declared-within/true-above).

Only the corpus `world` header changed: one shared adapter became four
gate-created adapters. The world's adapter addresses come from RLP-keccak in
`world.ts`, and the harness asserts them against both `vm.computeCreateAddress`
and the gate. No vector expectation changed.

**Widened, out of tree:** the precision family was re-seeded and raised to 400
vectors, with 1-atom and tiny quantities:

- 400/400 kernel↔model agreement (260 rejected by both, 140 admitted by both,
  205 declared-within/true-above);
- Solidity agreed on all 637 vectors / 644 attempts (198 settled, 446 reverted),
  with zero mismatches.

## 15. Slither

`npm run contracts:slither`: **20 contracts, 101 detectors, 0 results** (was 21
contracts; the interface is gone). `--show-ignored-findings` reports **12
reviewed** (was 13). `calls-loop` drops from 3 to 2 because the constructor no
longer calls any adapter. The two `new` expressions per market are not flagged.
S-1 is unchanged and still accurate.

## 16. Files changed

**Solidity sources:**

- `contracts/src/MandateExecutionGate.sol`
- `contracts/src/MandateTypes.sol`
- `contracts/src/fixture/FixtureVenueAdapter.sol`
- `contracts/src/interfaces/IFixtureSettlement.sol` (deleted)

**Deployment script:** `contracts/script/DeployMandateGate.s.sol`

**Solidity tests:**

- new: `FixtureTrust.t.sol`, `ExactMath.t.sol`, `utils/ExactMath.sol`,
  `mocks/LookAlikeFixture.sol`
- changed: `Adversarial.t.sol`, `DeployScript.t.sol`, `Differential.t.sol`,
  `Fuzz.t.sol`, `MandateExecutionGate.t.sol`, `MaxNotional.t.sol`,
  `Profile.t.sol`, `invariant/GateHandler.sol`, `invariant/GateInvariants.t.sol`,
  `mocks/ScriptedAdapter.sol`, `utils/GateTestBase.sol`

**TypeScript source:** `packages/execution-gate/src/reconciliation.ts`, `errors.ts`,
`model.ts`

**TypeScript tests:** `packages/execution-gate/test/reconciliation.test.ts`,
`public-boundaries.test.ts`, `corpus.test.ts`,
`support/generate-gate-corpus.ts`, `support/world.ts`

**Corpus:** `corpus/gate-v1/vectors.json`

**Docs:**

- `docs/execution-gate.md`, `docs/replay-semantics.md`,
  `docs/public-trust-boundaries.md`, `docs/adr/0019-onchain-execution-gate.md`
- this report
- status lines in `AGENTS.md`, `README.md`, `docs/roadmap.md`, and a pointer in
  `docs/phase-6r1-report.md`

## 17. Local commits

1. `fix(reconciliation): fail attempts at the reservation's ceiling, not the mandate's expiry`
2. `test: replace the maxNotional fuzz oracle with exact 512-bit arithmetic`
3. `fix(gate): create each fixture market's venue and adapter in the constructor`
4. `refactor: remove IFixtureSettlement, which nothing may ask any more`
5. `test(invariants): reach the unrepresentable-product refusal on the real path`
6. `docs: report Phase 6R.1a and mark it awaiting independent review`

The oracle repair lands before the gate change: changing the gate's bytecode
moved the fuzzer's inputs onto the old oracle's overflow, and every commit
should pass on its own.

## 18. Residual risks

- **Signing discipline** is the reconciliation's one assumption (§2). The
  offchain record cannot constrain a key that signs outside the admission rule;
  the gate still limits it to one settlement, and reconciliation surfaces it.
- **Gate runtime-code verification** from source is still required, as before.
  `verify` covers the adapter and venue; it does not replace verifying the gate
  itself.
- **Deployment size.** Creating two contracts per market costs about 1.2M gas
  per market. `MAX_MARKETS` = 32 measures about 38.6M gas, above a 32M
  per-transaction cap such as Arbitrum's. The committed config has one market;
  a larger deployment must be checked against the target chain.
- **Hostile-adapter tests now use `vm.etch`** over the gate-created adapter. This
  models misbehaving code at that address, which production can no longer
  install. The measured-settlement defence is still exercised, but through a
  test cheat.
- **Profile.** The worst-case profile measures the gate with 4,096 route bytes
  through a lean adapter etched at the gate's adapter address, because the
  fixture adapter refuses route data. It is an upper bound on the gate's cost for
  maximal calldata: 18,596 bytes, 250,508 intrinsic gas, **6,646,628** execution
  gas (was 6,646,656). Gas optimization is deferred to 6R.2.
- Gate runtime is 13,495 B (was 13,436) and initcode 22,289 B (was 17,859), both
  inside EIP-170 / EIP-3860. `forge build --sizes` no longer lists the gate in its
  table; these figures are from `forge inspect`.
- Everything in the Phase 6R report's §8 and §11 still applies, including the
  real-market inclusion-time state gap that keeps `REAL_MARKET` refused. A future
  real-market adapter needs its own mechanical identity rule.

## 19. Git status

Working tree clean after the final commit. All commits are local; `main` is
ahead of `origin/main` and nothing was pushed.

## 20. No remote or onchain operations

No push, merge, pull request, publish, tag, deployment or transaction was
performed, and no RPC endpoint was contacted. The only network access was
`npm audit`, required by this phase's validation list. It is a read-only query
of the npm registry advisory database with the dependency lockfile, and it
changes no state anywhere.
