# Phase 6R.1 completion report — exact principal notional enforcement

> **Phase 6R.1a follow-up.** The independent review of this phase confirmed M-1
> closed and found two further issues. §5's reconciliation rule made a retry
> after any failed attempt impossible until mandate expiry; FAILED now follows
> the reservation that bounds every attempt's deadline. §3's constructor check
> relied on what a supplied adapter reported through `IFixtureSettlement`; the
> gate now creates each fixture venue and adapter itself, and the interface is
> removed. See [phase-6r1a-report.md](phase-6r1a-report.md).

**Verdict: READY FOR INDEPENDENT PHASE 6R.1 REVIEW.** This is not a deployment
approval. Phase 7 has not begun. Nothing was deployed and no transaction was
sent. The only executable market class is still a labelled, fixed-price
settlement fixture. MCE v2, Candidate V3 and every Phase 1–5 schema are
unchanged.

## 1. M-1: the finding

A candidate declares its notional at a precision it chooses, and the
consistency check (kernel `checkNotionalConsistency`, gate `notionalBounds`)
accepts either adjacent value at that precision. Both the kernel's
`checkMaxNotional` and the gate compared only that *declared* value with the
principal's signed `maxNotional`. At `decimals: 0` a declared notional can sit
almost a whole unit below `quantity × price`, so a correctly signing malicious
agent could exceed the principal's bound by up to one unit of its own chosen
precision. Reproduced before the fix, through the real fixture venue and with
every signature valid:

| PoC | True gross | Signed `maxNotional` | Declared notional | Pre-6R.1 |
| --- | --- | --- | --- | --- |
| BUY 0.00995 fAAPL | 1.99 USD | 1 USD | `1` at 0 decimals | settled |
| SELL 0.50495 fAAPL | 100.99 USD | 100 USD | `100` at 0 decimals | settled |
| BUY 0.002 fAAPL | 0.40 USD | 0 USD | `0` at 0 decimals | settled |

## 2. The rule, in both implementations

> If the true gross notional exceeds the principal's signed `maxNotional`,
> settlement fails, whatever `candidate.notional.decimals` is.

`quantity × price` is rendered exactly at the principal's own
`maxNotional.decimals` and rounded up; the check refuses when that ceiling
exceeds the signed atoms. Because the bound is an integer at its own scale, the
ceiling exceeds it **exactly** when the true product does. A product that
cannot be rendered in `uint256` at that scale exceeds every `uint256` bound and
is the same refusal, never a wrap or an arithmetic error. The declared
comparison still runs first, so the new rule can only add rejections.

- **Kernel** (`checkMaxNotional`, verifier invariant V-16a): against the
  candidate's execution price. Every pre-existing corpus receipt is unchanged
  except `unit-002`, whose price/quantity unit mismatch is now also reported by
  the max-notional check; its reason codes are unchanged.
- **Gate** (`_checkMaxNotional`): against the **immutable fixture price**, using
  the existing 512-bit `notionalBounds`; the candidate price was already proven
  equal to it by exact scaled comparison.
- **TypeScript reference model**: the kernel's identical arithmetic against the
  pinned price, so the differential compares like with like.

## 3. Deployment consistency

A fixture market had two unconnected prices: the typed `fixturePrice` the gate
checks and the integer `FixtureVenue.PRICE` the venue charges. The deployment
script passed the raw typed atoms to the venue as funding atoms, so any config
with price decimals ≠ funding decimals deployed a venue at a different economic
price.

- The **gate constructor** now reads each adapter's `IFixtureSettlement` terms
  and refuses `FixtureSettlementInconsistent` unless the venue settles against
  the configured funding token at exactly the pinned price, in funding atoms per
  whole token. A price finer than the funding token can express has no equal
  integer venue price and is refused by the same comparison. Because the
  constructor enforces it, direct deployment cannot bypass it.
- The **script** converts the typed price exactly and refuses
  `FixturePriceNotRepresentable` before deploying anything.
- Tests: the same price at scales 6/7/18/38 accepted; off-by-one, raw-atom and
  wrong-scale prices refused; 7-decimal price against a 6-decimal token refused
  for both neighbouring venue prices; wrong funding token, wrong-representation
  adapter and an adapter without the view refused; script conversion at 18
  decimals, script refusal at 7, and the old script's raw pairing refused by the
  constructor directly.

## 4. Evidence

**Malicious authorized agent, precision only** (`MaxNotional.t.sol`, real
`FixtureVenue` path, every signature valid): the three PoCs (with honest-bound
controls that settle); declared precision 0–38 on BUY and SELL above the bound;
the same sweep at the bound; one atom below/equal/above at principal precisions
1 and 38; decimal-conversion boundaries 0–38 for a 2e-16 USD product; 1,000,000.5
tokens at 1e-6 USD and 1.000000001e-9 tokens at 1e9 USD; a `quantity × price`
needing ~290 bits, refused one atom below its exact ceiling, admitted at it, and
refused at 38 decimals where no `uint256` bound can hold it; and a 1,024-run fuzz
over quantity, declared precision, rounding, principal precision, bound shape and
side against an independent cross-multiplication oracle.

**Kernel** (`max-notional.test.ts`): the PoCs, precision 0–38 at three bounds,
exactness at every principal precision, extreme magnitudes in the bypass shape,
and a 1,500-case seeded oracle sweep that must generate ≥50 bypass shapes.

**Kernel ↔ gate authority differential.** `authority-017…020` (the PoCs and a
6-decimal declaration that rounds an 18-decimal excess away) are first rejected
by the actual kernel (`MAX_NOTIONAL_EXCEEDED`), then correctly signed and refused
by Solidity. A seeded family of 64 precision combinations — 27 of them the
declared-within/true-above shape — makes the generator refuse to write the
corpus if the kernel and the gate ever disagree; all 64 agree (38 rejected by
both, 26 admitted by both). No pre-existing vector changed.

**Invariants.** `INV-ONCHAIN-AUTH-1` is now defined on the true gross — quantity
× the venue's own settlement price against the signed bound at its signed
precision, by the handler's plain cross-multiplication — instead of declared
atoms. A new action trades through the real `FixtureVenue`/`FixtureVenueAdapter`
on both sides, placing the bound at the agent's coarse declared value half the
time. The deterministic non-vacuity test asserts the three PoC shapes are
attempted and refused and that BUY and SELL settle on the real path.

**Discrimination.** With only the gate's new comparison removed:
`INV-ONCHAIN-AUTH-1` failed on its own (the fuzzer shrank the counterexample to
one `executeFixturePrecision` call); the non-vacuity test failed; both authority
differentials failed at `authority-017`; nine of ten `MaxNotional.t.sol` tests
failed (the tenth is a positive control). With the kernel fix reverted, six of
seven kernel M-1 tests failed; the seventh was then tightened and fails too.

## 5. Other items

- **Reconciliation** (`observationFromGateEvidence`). FAILED previously followed
  one attempt's deadline, but the gate's replay key is the mandate digest: until
  the mandate expires the agent can sign another attempt and it will settle,
  while the kernel's `RECONCILE` would have returned the authorization to
  `UNUSED`. FAILED now requires a final unconsumed reading at a block whose
  timestamp has reached the **mandate's expiry**; the attempt record carries
  `mandateExpiresAtUnixSeconds` instead of `deadline`. This is a breaking change
  to that public boundary's input shape. A two-attempt test drives it through the
  reference model and the kernel.
- **Fee-on-transfer SELL proceeds.** Corrected: a fee-on-transfer funding token
  paid out on a SELL is safe when the principal's *measured* credit, after the
  fee, still meets the signed minimum; otherwise it refuses. Only the
  representation leg must be exact. Pinned by a new adversarial test.
- **Executable profile.** Reproduced independently in Solidity and TypeScript with
  maximal 128-byte identifiers everywhere a deployment or mandate chooses them,
  4,096 non-zero route bytes and a settling attempt: **18,596 calldata bytes**,
  **250,508** intrinsic calldata gas (EIP-2028), **6,646,656** execution gas for
  the gate call. The Phase 6R figures (17,156 / 172,784 / 1,673,113) were
  understated. Gas is linear in identifier length (≈1.13M at 16 bytes).
- **Slither.** S-1 rewritten per side against the code: on BUY the transfer is
  bounded by the signed economic limit, not `maxNotional`; on SELL by the exact
  true product (only since 6R.1). New S-11 (suppressed, reasoned) and S-12
  (fixed by extracting `_checkMaxNotional`). Final: 21 contracts, 101 detectors,
  **0 results**; **13 reviewed** with ignored findings shown; removing a
  suppression makes the run exit 255.

## 6. Validation (final local run)

| Command | Result |
| --- | --- |
| `npm run check` | pass — 734/734 TypeScript tests, fixture/replay/routing/cross-surface/Jev validation, credential scan, junk check |
| `npm run generated:check` | pass — every committed corpus and reason-code document matches its generator |
| `npm run audit:security` | 0 vulnerabilities |
| `npm run contracts:fmt` / `contracts:build` / `contracts:lint` | pass; gate runtime 13,436 B (11,140 B EIP-170 margin), initcode 17,859 B |
| `npm run contracts:test` | **174/174** across 9 suites: 80 unit, 33 adversarial, 12 codec, 10 M-1 (incl. 1 fuzz), 15 fuzz, 4 differential, 6 deployment, 1 profile, 13 invariant; every fuzz property at 1,024 runs; each of 12 invariants 256 runs × 64 calls = 16,384 calls, 0 reverts, all six handler actions exercised |
| Differential | 301 vectors / 308 attempts agreed (91 settled, 217 reverted); 20 actual-kernel REJECT authority vectors refused; 139 mandate and 188 candidate encodings agreed |
| `npm run contracts:slither` | 0 results; 13 reviewed with `--show-ignored-findings` |

Foundry may warn that the sandbox cannot write its signature cache under
`~/.foundry`; it did not affect compilation or tests.

## 7. Status of findings

- **M-1: closed.** True gross notional cannot exceed signed `maxNotional` on the
  supported path, and candidate precision cannot move that bound, in the kernel
  and the gate alike, with the invariant suite able to detect a regression on its
  own.
- No Critical or High finding is known to remain unresolved on the fixture path.
  This is the implementer's assessment, not a substitute for the independent
  review this phase stops for.

## 8. Residual risk and review notes

- The worst-case execution gas (≈6.6M) is well inside current Arbitrum limits
  but is paid by whoever submits; shortening the gate's identifier
  validation/re-encoding is an optimization for a later phase, not a safety fix.
- `IFixtureSettlement` is a constructor-time declaration by the adapter. For
  `FixtureVenueAdapter` it is read from immutables, so it is the price every
  trade settles at; a hostile adapter could declare one price and settle another,
  which remains bounded by the measured-delta checks and by the curated,
  deployer-chosen market table.
- The venue rounds its own cost up and proceeds down in funding atoms; that
  sub-atom difference is outside `maxNotional` (a gross bound) and inside the
  signed economic limit, which the measured deltas enforce.
- Everything in the Phase 6R report's §8 and §11 still applies, including the
  real-market inclusion-time state gap that keeps `REAL_MARKET` refused.
