# Phase 6R.2A — gas attribution and architecture benchmark

**Measurement phase. No production code changed.** `contracts/src` is
byte-identical to `ef2db81`; MCE v2, Candidate V3, both EIP-712 domains, the
execution commitment and every gate decision are unchanged, and every generated
corpus is unchanged (`npm run generated:check`). Nothing was pushed, merged,
published, tagged, deployed or sent; no RPC was contacted.

**Answer.** A normal execution costs ~400k and the worst case ~6.7M because the
gate validates every identifier byte of the signed mandate and candidate with a
byte-at-a-time Solidity loop that costs **≈595 gas per byte per pass**, and
sorted-set ordering with a byte-at-a-time comparison that costs **≈260 gas per
compared byte**. That validation is **37% of a normal BUY and 95% of the worst
case**, and it explains **99.3% of the MAX − NORMAL difference**. Hashing,
memory, encoding, storage, events and arithmetic together explain less than 2%
of that difference. The largest secure reduction is to make the same validation
word-at-a-time without changing what it accepts: measured in a scratch
prototype that passes the whole suite, a normal BUY drops from 401,684 to 273,050
(−32%) and the executable worst case from 6,724,561 to 514,118 (−92%); a
single-buffer encoder on top brings them to 241,455 (−40%) and 435,167 (−94%).
**Recommended 6R.2B path: A — micro-optimize the current architecture** (§V).

Starting point: branch `main`, HEAD `ef2db81` (as expected), clean tree.

---

## A. Environment

| | |
| --- | --- |
| Commit measured | `ef2db81` (production code); benchmarks added on top in this phase |
| solc | 0.8.37 |
| Foundry | forge 1.7.1 (`4072e487`, 2026-05-08) |
| EVM target | `cancun` (execution also under Cancun rules: no EIP-7623 floor applied) |
| Optimizer | enabled |
| `optimizer_runs` | 200 |
| `via_ir` | true |
| `bytecode_hash` | none |
| Gate runtime / initcode | 13,495 / 22,392 bytes |

## B. Canonical profiles

Defined in `contracts/test/GasProfiles.t.sol`; the method is in
`contracts/test/utils/GasBench.sol`.

| profile | what it is | identifiers | sets issuer / chain / venue | route | adapter |
| --- | --- | --- | --- | ---: | --- |
| MINIMAL | smallest valid execution | 1 byte each (chain and representation identifiers are derived and fixed) | 1 / 1 / 1 | 0 | FixtureVenueAdapter |
| NORMAL_BUY / NORMAL_SELL | the `GateTestBase` world, 10 fAAPL, the 6R.1b path | 3–18 bytes | 1 / 1 / 2 | 0 | FixtureVenueAdapter |
| DEMO / DEMO_SELL | expected Agent Marketplace demo: AAPL (`equity`/`isin`/`US0378331005`), issuer `robinhood-assets-jersey-limited` and state `mainnet-aapl-pass.state` from `corpus/mainnet-routing-v1`, venue `venue.fixture` | 3–31 bytes | 1 / 1 / 1 | 0 | FixtureVenueAdapter |
| LARGE | large but plausible: descriptive 23–44-byte issuer, venue and state identifiers, market entry mid-set | ≤ 44 bytes | 4 / 4 / 4 | 0 | FixtureVenueAdapter |
| MAX_EXECUTABLE_FIXTURE | the largest attempt that settles on the supported fixture path | every choosable identifier 128 bytes | 16 / 16 / 16 | 0 | FixtureVenueAdapter |
| MAX_SERIALIZABLE | `Profile.t.sol`'s worst case, same 18,596-byte calldata | as above | 16 / 16 / 16 | 4,096 non-zero | `LeanAdapter` etched at the gate's adapter address |

Why each MAX field is at its maximum: 128 bytes is the kernel's
`IDENTIFIER_MAX_LENGTH` for every identifier a deployment or mandate can choose
(canonical asset × 3, issuer, venue, both units, 15 non-target entries of each
set, evaluation-state identifier); 16 is the gate's `MAX_PROFILE_SET_SIZE`;
4,096 is `MAX_EXECUTION_DATA_BYTES`; every free numeric field (`mandateId`,
nonce, bounds at 0 decimals, epochs, ages, digests, deadline) is at its type's
maximum. The chain identifier (`eip155:46630`, 12 B) and representation
identifier (61 B) are derived by the gate and cannot be longer. The sets' first
entry is the market's own, so the *search* is at its minimum in MAX (§F shows
position costs at most ~9.7k).

**`MAX_SERIALIZABLE` ≠ `MAX_EXECUTABLE_FIXTURE`.** `FixtureVenueAdapter`
refuses any route data (`UnsupportedRouteData`; one byte reverts the attempt,
`test_gasProfile_fixturePathRefusesAnyRouteData`). 4,096 route bytes are accepted
by the gate and serializable, but settle only through a lean adapter etched over
the gate-created one — a test cheat, not a deployable configuration.

**Method** (`GasBench`). Each benchmark gate is deployed in `setUp` with tokens
of its own. Foundry runs each test function as a new transaction, so the
measured call starts with every account and slot cold and with the SSTORE
original values a real transaction sees; because no two gates share a token,
several measurements in one test do not warm each other. Execution gas is the
gate's call frame (`vm.lastCallGas`, identical to the `-vvvv` trace figure),
with calldata pre-encoded. Intrinsic gas is EIP-2028; transaction gas is
intrinsic + execution − refund (capped at a fifth, EIP-3529). Arbitrum's L1 data
charge is not modelled.

## C. Baseline results (canonical from 6R.2A on)

| profile | calldata B | zero | non-zero | intrinsic | EIP-7623 floor* | **execution** | refund | transaction |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MINIMAL | 4,132 | 3,656 | 476 | 43,240 | 76,600 | **324,182** | 42,600 | 324,822 |
| NORMAL_BUY | 4,228 | 3,617 | 611 | 45,244 | 81,610 | **401,684** | 42,600 | 404,328 |
| NORMAL_SELL | 4,228 | 3,617 | 611 | 45,244 | 81,610 | **399,779** | 42,600 | 402,423 |
| DEMO | 4,132 | 3,494 | 638 | 45,184 | 81,460 | **417,412** | 42,600 | 419,996 |
| DEMO_SELL | 4,132 | 3,494 | 638 | 45,184 | 81,460 | **415,036** | 42,600 | 417,620 |
| LARGE | 5,124 | 4,185 | 939 | 52,764 | 100,410 | **609,960** | 42,600 | 620,124 |
| MAX_EXECUTABLE_FIXTURE | 14,500 | 5,671 | 8,829 | 184,948 | 430,870 | **6,724,561** | 42,600 | 6,866,909 |
| MAX_SERIALIZABLE | 18,596 | 5,669 | 12,927 | 250,508 | 594,770 | **6,689,297** | 2,800 | 6,937,005 |

\* A floor only; `max(standard, floor)` would change none of these totals.

The 42,600 refund is the reentrancy flag restored (2,800) plus the adapter's
funding balance and its allowance to the venue each going 0 → x → 0 (19,900
each). The lean adapter holds no allowance, hence 2,800.

**Reproduction of 6R.1b.** `test_gasProfile_phase6r1bMethod` reproduces the old
figures: BUY **409,071** (6R.1b: 409,093) and SELL **352,070** (6R.1b: 352,190);
`Profile.t.sol` still measures **6,646,628** exactly. The differences from the
canonical figures are methodological, not material:

- the 6R.1b BUY window wrapped `gate.execute(...)`, so it included the test's
  own ABI encoding of the arguments (~7.4k);
- the 6R.1b SELL figure was a *second* execution in the same transaction, on
  slots the first had warmed and dirtied. **BUY and SELL cost the same within
  ~2k** when measured alike (401,684 / 399,779); the 57k "BUY − SELL" gap in
  6R.1b was an artifact;
- `Profile.t.sol` deploys its gate inside the measured transaction, so the
  gate's and tokens' writes are already dirty; measured cold the same attempt
  costs 6,689,297 (+42,669).

## D. Identifier scaling

`GasSweeps.t.sol`, baseline `_uniformShape(8)` (every choosable identifier 8
bytes, one-entry sets, no route data). Execution gas; every point settles.

| identifier grown | 8 B | 16 B | 32 B | 64 B | 96 B | 128 B | gas / byte, 32→128 | validation passes | gas / byte / pass |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| canonical asset `value` only | 395,498 | 405,800 | 424,438 | 462,470 | 501,446 | 538,889 | 1,192 | 2 | 596 |
| canonical asset, all three components | 395,498 | 424,879 | 481,840 | 596,412 | 711,935 | 825,929 | 3,584 | 6 | 597 |
| issuer | 395,498 | 405,763 | 424,394 | 462,410 | 501,371 | 538,798 | 1,192 | 2 | 596 |
| venue | 395,498 | 405,763 | 424,394 | 462,410 | 501,371 | 538,798 | 1,192 | 2 | 596 |
| quantity unit | 395,498 | 405,760 | 424,409 | 462,433 | 501,402 | 538,837 | 1,192 | 2 | 596 |
| settlement unit | 395,498 | 420,083 | 467,414 | 562,844 | 659,222 | 754,070 | 2,986 | 5 | 597 |
| evaluation-state identifier | 395,498 | 400,985 | 410,064 | 428,936 | 448,753 | 467,036 | 593 | 1 | 593 |
| one non-target entry in each set | 422,734 | 432,737 | 460,949 | 518,087 | 576,171 | 632,723 | 1,789 | 3 | 596 |
| all of the above together | 422,734 | 527,184 | 735,729 | 1,153,704 | 1,572,689 | 1,990,206 | 13,067 | ≈21 + comparisons | — |

All identifiers together:

| identifier bytes | calldata B | intrinsic | execution | transaction | Δexecution / Δbyte |
|---:|---:|---:|---:|---:|---:|
| 8 | 4,420 | 46,300 | 422,734 | 426,434 | |
| 16 | 4,420 | 48,304 | 527,184 | 532,888 | 13,056 |
| 32 | 4,420 | 52,348 | 735,729 | 745,477 | 13,034 |
| 64 | 5,092 | 63,124 | 1,153,704 | 1,174,228 | 13,062 |
| 96 | 5,764 | 73,864 | 1,572,689 | 1,603,953 | 13,093 |
| 128 | 6,436 | 84,640 | 1,990,206 | 2,032,246 | 13,047 |

**Relationship: O(n), linear, with a constant slope** (±2% across every
interval). It is not quadratic: the one quadratic pattern in the code
(`encodeIdentifierSet` re-concatenating its accumulating buffer) is real but
small, because MCOPY is 3 gas per word (§I). Every field's slope is **≈595 gas
per byte times the number of times that identifier is validated**. The
representation and chain identifiers cannot be swept (derived, fixed length).

Two content effects are real and measured (`GasAttribution.t.sol`): a 64-byte
identifier costs 31,087 to validate if all digits, 34,863 uppercase, 38,639
lowercase (the character test short-circuits, digits first); so the same
attempt differs by a few hundred gas between tokens whose hex addresses differ
(the 1–16-market execution spread of 708 gas in §R, and the route sweep's
−356 at 512 bytes in §E).

### Per-byte work (§6 of the brief)

From the code, confirmed by the opcode trace (§H) and the isolated operations
below. "Scan" = the `isIdentifierBytes` loop, "cmp" = `compareEncoded`.

| identifier | scans | comparisons | calldata→memory copies | encodings | standalone hashes | inside digest hash |
| --- | ---: | --- | --- | --- | --- | --- |
| mandate canonical asset (×3 strings) | 1 each | — | 1 (scan) + 1 (re-encode for `assetHash`) | 2 (MCE, `assetHash`) | 1 (`assetHash`) | mandate digest |
| candidate canonical asset (×3) | 1 each | — | 2 | 2 (Candidate V3, `assetHash`) | 1 | candidate digest |
| `maxNotional.unit` | 1 | — | 2 | 1 | 1 (`equal`) | mandate digest |
| `economicLimit.unit` | 1 | — | 3 | 1 | **2** (`equal`, settlement check) | mandate digest |
| set entry *i* | 1 | up to 2 (with entries *i*−1 and *i*+1), each copying both operands | 1 + 2 per comparison + 1 if searched | 1, then re-copied by every later `bytes.concat` of its set (O(n)) | 1 per search step until match | mandate digest |
| candidate issuer / chain / venue | 1 | — | 2 | 1 | 1 | candidate digest |
| candidate units (quantity, price ×2, notional, fee) | 1 each | — | 2 | 1 | 1 each | candidate digest |
| representation identifier | 1 | — | 2 | 1 | 1 (market key) | candidate digest |
| evaluation-state identifier | 1 | — | 1 | 1 | 0 | candidate digest |
| route data | 0 | — | 3 (hash, `ExecutionOrder`, adapter call) | 1 (adapter calldata) | 1 | commitment |

Isolated cost of each pass (`CodecBenchHarness`, operation frame − no-op frame):

| identifier bytes | scan | equal-length comparison | calldata→memory copy | keccak | `encodeString` |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 8 | 5,021 | 2,768 | 249 | 121 | 322 |
| 16 | 9,789 | 4,816 | 249 | 121 | 322 |
| 32 | 19,325 | 8,912 | 249 | 121 | 325 |
| 64 | 38,403 | 17,116 | 255 | 133 | 331 |
| 128 | 76,559 | 33,524 | 267 | 157 | 343 |
| **per byte** | **≈596** | **≈256** | ≈0.1 | ≈0.3 | ≈0.2 |

Only the scan and the comparison grow meaningfully with length. Copying,
hashing and encoding are flat at 120–350 gas per identifier.

## E. Route scaling

`RouteDataSweep` (lean adapter for every point, so only the route changes):

| route bytes | calldata B | intrinsic | execution | transaction | Δexecution / Δbyte | Δintrinsic / Δbyte |
|---:|---:|---:|---:|---:|---:|---:|
| 0 | 4,132 | 44,752 | 352,021 | 393,973 | | |
| 32 | 4,164 | 45,288 | 352,286 | 394,774 | 8.28 | 16.8 |
| 64 | 4,196 | 45,800 | 352,433 | 395,433 | 4.59 | 16.0 |
| 128 | 4,260 | 46,800 | 352,845 | 396,845 | 6.44 | 15.6 |
| 256 | 4,388 | 48,872 | 352,961 | 399,033 | 0.91 | 16.2 |
| 512 | 4,644 | 52,968 | 352,605 | 402,773 | −1.39 | 16.0 |
| 1,024 | 5,156 | 61,160 | 353,316 | 411,676 | 1.39 | 16.0 |
| 2,048 | 6,180 | 77,532 | 354,528 | 429,260 | 1.18 | 16.0 |
| 4,096 | 8,228 | 110,300 | 357,061 | 464,561 | 1.24 | 16.0 |

- **Serialization/validation path:** receiving, bounding, hashing and forwarding
  4,096 route bytes costs **+5,040 execution gas (≈1.2 gas/byte)**; the calldata
  costs **16 gas/byte intrinsic (+65,548)**. The sub-256-byte slopes and the
  −356 at 512 are character-class noise from the per-point token addresses (§D),
  not route cost.
- **Executable fixture path:** **0 bytes.** One byte is refused.
- **Route data does not explain MAX:** 5,040 of the 6.29M execution delta
  (0.08%). It matters only for intrinsic gas.

## F. Allowlists

`AllowlistSweep{Issuers,Chains,Venues}`: every entry of a set the same length
(16 B for issuers and venues, 12 B CAIP-2 for chains), market entry first,
middle or last. Execution gas:

| issuers | first | middle | last | last − first | per added entry |
|---:|---:|---:|---:|---:|---:|
| 1 | 414,599 | — | — | — | — |
| 2 | 429,422 | 429,595 | 429,359 | −63 | 14,823 |
| 4 | 462,282 | 460,443 | 463,747 | 1,465 | 15,894 |
| 8 | 527,330 | 527,964 | 532,324 | 4,994 | 16,104 |
| 16 | 659,229 | 662,456 | 668,937 | 9,708 | 16,309 |

| venues | first | middle | last | last − first | per added entry |
|---:|---:|---:|---:|---:|---:|
| 1 | 414,599 | — | — | — | — |
| 2 | 429,166 | 429,339 | 429,103 | −63 | 14,567 |
| 4 | 462,026 | 459,931 | 463,491 | 1,465 | 15,809 |
| 8 | 527,074 | 527,452 | 532,068 | 4,994 | 16,068 |
| 16 | 658,973 | 661,944 | 668,681 | 9,708 | 16,292 |

| chains | first | middle | last | last − first | per added entry |
|---:|---:|---:|---:|---:|---:|
| 1 | 414,599 | — | — | — | — |
| 2 | 426,600 | 426,773 | 426,537 | −63 | 12,001 |
| 4 | 451,254 | 450,695 | 452,719 | 1,465 | 12,218 |
| 8 | 499,901 | 501,815 | 504,895 | 4,994 | 12,186 |
| 16 | 598,915 | 603,421 | 608,620 | 9,705 | 12,288 |

- **Count:** each added 16-byte issuer or venue costs ≈16.1k (≈9.5k scan, the
  rest per-entry copy, comparison, encoding and loop overhead); each added
  12-byte chain ≈12.2k. Linear.
- **Position:** first → last in a 16-entry set adds **≈9.7k** (15 more
  copy-and-hash steps in `contains`, ≈650 each): ≤ 1.5% of a 16-entry
  execution, **≤ 0.15% of MAX**. Middle can be cheaper than first by ~2k: the
  entries around the target differ in characters (§D), not a search effect.
- **Share of MAX:** set validation (`isIdentifierSet`) is 5,120,105 gas, **76%
  of MAX_EXECUTABLE_FIXTURE**, about a quarter per set: 16 × 128-byte entries
  cost 1,741,895 to validate in isolation. Of the MAX − NORMAL delta, set
  processing is 80.9% (§P).

## G. Dynamic arrays

MCE v2 carries three dynamic arrays (`allowedIssuers`, `allowedChains`,
`allowedVenues`, all `string[]`); Candidate V3 carries none. The other dynamic
calldata are `bytes` (two 65-byte signatures, route data) and strings.

Where a set's cost goes (isolated, `test_codec_setOperations`; ABI head
decoding is the no-op baseline and is excluded):

| set | validate (scan + order) | encode | encode + hash | search to last entry |
| --- | ---: | ---: | ---: | ---: |
| 1 × 16 B | 10,034 | 970 | 952 | 1,232 |
| 4 × 16 B | 56,649 | 3,536 | 3,530 | 3,158 |
| 16 × 16 B | 242,866 | 14,130 | 14,166 | 10,864 |
| 1 × 128 B | 76,804 | 1,015 | 1,021 | 1,304 |
| 4 × 128 B | 409,857 | 3,853 | 3,931 | 3,339 |
| 16 × 128 B | 1,741,895 | 18,211 | 18,583 | 11,489 |

(Encode and encode+hash differ by less than their noise: hashing a 2 KB set is
~400 gas.) **Validation is 97–98% of every array's cost; encoding ≈1%, search
≤ 1%, hashing ≈0%.** ABI decoding costs nothing per element (calldata structs
are not decoded ahead of use). The route `bytes` costs ≈1.2 gas/byte (§E).

## H. Hashing

27 `KECCAK256` in the gate frame for every profile (the opcode trace; the count
does not grow with size because the market's entry is first in each set). Bytes
hashed: 1,695 (NORMAL_BUY), 1,456 (MINIMAL), 11,878 (MAX_EXECUTABLE_FIXTURE),
15,974 (MAX_SERIALIZABLE).

| logical value | computed | bytes (NORMAL / MAX) | note |
| --- | --- | --- | --- |
| mandate digest | **1×** | 394 / 7,071 | reused for the principal struct, commitment, replay key, event |
| candidate digest | **1×** | 470 / 1,794 | |
| `MandateAuthorization` struct hash | 1× | 64 | |
| execution commitment | 1× | 224 | plus `keccak(executionData)` 1× (0 / 4,096) |
| EIP-712 digests | 2× | 66 each | principal and agent: distinct, both needed |
| EIP-712 domain separator | 0× | — | immutable |
| representation identifier (market key) | 1× | 61 | plus its mapping slot, 1× |
| `_executions` slot | **2×** | 64 | read and write compute the same slot — **duplicate** |
| mandate / candidate asset hash | 1× each | 28 / 390 | **re-encodes** asset bytes already inside both digests |
| `economicLimit.unit` | **2×** | 3 / 128 | `validateMandate`'s `equal` and `_checkBinding` — **duplicate** |
| other identifier hashes | 1× each | | `maxNotional.unit`; candidate chain, venue, issuer, 5 units; allowlist entries until match |

The settlement unit's string is hashed six times across six fields in NORMAL
(two of them the same field). All 27 hashes together cost roughly 1.2k (NORMAL)
to 3k (MAX) of word gas plus their copies: **hashing is < 0.5% of NORMAL and <
0.1% of MAX.** Removing every post-validation identifier comparison outright
(an invalid ablation, §S) saves at most 10.7k–14.6k.

## I. Encoding

| encoding | input | dynamic | already encoded elsewhere? | feeds only a hash? | survives? |
| --- | --- | --- | --- | --- | --- |
| `encodeMandate` (MCE v2) | whole mandate | yes | no | yes | no |
| `encodeCandidate` (V3) | whole candidate | yes | no | yes | no |
| `encodeParty` ×3 | principal, agent, candidate agent | hex string | candidate agent = mandate agent (checked later): same hex twice | yes | no |
| `assetHash` ×2 | mandate, candidate asset | yes | **yes, inside both digests** | yes | no |
| `abi.encode` struct hashes | 64 B, 224 B | no | no | yes | no |
| `abi.encodePacked(0x1901, …)` ×2 | 66 B | no | no | yes | no |
| `ExecutionOrder` → adapter calldata | order + route | route | route copied into the struct, then into the call | no | into the adapter call |
| `MandateExecuted` data | 8 words | no | no | no | log |

How the MCE bytes are built: `head`, two parties, asset, `economics` (with two
amount buffers), three sets (each an accumulating `bytes.concat`), `tail`, then
one final `bytes.concat` — every byte copied two or three times, set entries
O(n) times; the candidate is similar with three part buffers. Each party costs
a `Strings.toHexString` (≈3.1k in the gate; 9,455 isolated with its concat).

Measured: the digest stages are 36.6k (mandate) + 24.6k (candidate) in a
NORMAL attempt and 109.8k + 29.3k in MAX (instrumented build, §K). A prototype
single-buffer writer with a table-free hex conversion, producing byte-identical
encodings (the codec and differential suites pass), saves **31.6k on NORMAL and
79k on MAX** (§S, D − C). Encoding is **13.5% of NORMAL** (reconciled, §P) and
**1% of the MAX − NORMAL delta**.

## J. Memory

Everything enters as calldata; the gate never copies a whole `Mandate` or
`Candidate` struct to memory. The copies are per string and per value:

| copy | where | count per attempt |
| --- | --- | --- |
| identifier calldata → memory | `isIdentifier(s)` → `isIdentifierBytes(bytes(s))` | once per validation pass (≈21 + 1 per set entry) |
| both operands → memory | `compareEncoded(bytes(a), bytes(b))` | once per adjacent set pair |
| entry → memory for keccak | `contains`, `equal`, every identifier comparison | ~20 in NORMAL |
| identifier → packed buffer → concat buffers | encoders | 2–3× per identifier; set entries O(n) |
| `Market` storage → memory | `plan.market = _markets[key]` | 1 (10 SLOADs), then passed by pointer |
| route → memory ×2 | commitment hash, `ExecutionOrder` | 2 + the call encoding |

Opcode trace of the gate frame:

| | NORMAL_BUY | MINIMAL | MAX_EXECUTABLE_FIXTURE | MAX_SERIALIZABLE |
| --- | ---: | ---: | ---: | ---: |
| opcodes executed | 65,270 | 44,023 | 1,796,405 | 1,796,167 |
| `CALLDATACOPY` ops / bytes | 74 / 1,028 | 70 / 631 | 250 / 30,413 | 250 / 38,605 |
| `MCOPY` ops / bytes | 78 / 2,412 | 76 / 2,011 | 166 / 71,569 | 166 / 75,665 |
| memory high-water (bytes) | 13,540 | 12,964 | 121,124 | 133,412 |
| memory expansion gas | 1,623 | 1,539 | 39,353 | 46,472 |

Memory expansion is **0.4% of NORMAL and 0.6% of MAX**; the 71.6 KB of MCOPY
in MAX is the quadratic set concatenation, ≈6.7k of copy gas. Moving validation
to calldata without changing its loop (variant A, §S) saves 12.9k on NORMAL and
267k on MAX — the copy *and* memory-indexing overhead of the byte loop, not
expansion. The rest of MAX is interpretation: **96.7% of MAX's 6.72M is cheap
stack, jump and compare opcodes** (`PUSH` 24%, `DUP` 16%, `JUMPDEST` 11%,
`JUMPI` 8%, `ISZERO` 8%, `JUMP` 6% by count; 2.57M gas in jumps alone), ≈109
opcodes per validated byte.

## K. Stage attribution

Two instruments, because neither alone is exact everywhere:

1. **`forge test --flamegraph`** on the unmodified build (the production
   bytecode). Exact for every internal function the via-IR source map still
   delimits; inlined code is reported as the caller's "self".
2. **A scratch instrumented copy** of the gate with 40 checkpoints (each a view
   cheatcode write of `gasleft()`, overhead calibrated on warm calls and
   subtracted). **Instrumenting changes the compiled code:** even 5 checkpoints
   make the gate ≈8% more expensive on NORMAL and ≈17% on MAX, almost all of it
   inside the validation loops (via-IR inlining around them shifts). Stage
   figures from this build are therefore used only to split the flamegraph's
   inlined "self"; storage, calls and events are opcode-fixed and not affected.

Real build, function level (execution gas):

| component | NORMAL_BUY | MAX_EXECUTABLE_FIXTURE | MAX_SERIALIZABLE |
| --- | ---: | ---: | ---: |
| mandate validation: set byte scan | 29,716 | 3,582,676 | 3,582,676 |
| mandate validation: set ordering comparison | 0 | 1,451,591 | 1,451,591 |
| mandate validation: set loop/copy overhead | 4,018 | 85,838 | 85,838 |
| mandate validation: asset + units | 18,312 | 383,218 | 383,218 |
| mandate validation: other | 2,819 | 2,919 | 2,919 |
| candidate validation | 94,129 | 884,573 | 883,747 |
| encoding frames (sets, parties, asset, amounts) | 16,882 | 78,378 | 77,223 |
| allowlist search (`contains`) | 1,342 | 1,473 | 1,477 |
| signatures (`_signedBy`: EIP-712 + 2 × ecrecover) | 8,274 | 8,572 | 8,579 |
| economic arithmetic (`GateArithmetic`, scaling, `mulDiv`) | 3,563 | 4,295 | 4,307 |
| `transferFrom` principal → adapter | 29,892 | 29,892 | 29,892 |
| adapter + venue | 58,589 | 58,589 | 15,112 |
| balance reads ×4 | 6,148 | 6,148 | 6,148 |
| `decimals()` ×2 | 4,700 | 4,700 | 4,700 |
| inlined gate code (storage, event, hashing, digest glue, binding, dispatch) | 123,300 | 141,699 | 151,870 |
| **total** | **401,684** | **6,724,561** | **6,689,297** |

Instrumented build, every stage (raw, before reconciliation; sums exceed the
real build by the inflation above):

| stage | MINIMAL | NORMAL_BUY | NORMAL_SELL | DEMO | LARGE | MAX_EXEC | MAX_SER |
|---|---:|---:|---:|---:|---:|---:|---:|
| entry: dispatch, ABI offsets, reentrancy enter | 5,478 | 5,478 | 5,478 | 5,478 | 5,478 | 5,478 | 5,478 |
| mandate validation | 20,973 | 61,480 | 61,599 | 62,807 | 243,044 | 6,523,318 | 6,523,318 |
| profile set-size bound | 652 | 652 | 652 | 652 | 652 | 660 | 660 |
| mandate digest (encode MCE v2 + keccak) | 35,661 | 36,602 | 36,602 | 35,707 | 44,146 | 109,785 | 109,785 |
| principal signature | 4,540 | 4,541 | 4,541 | 4,540 | 4,547 | 4,709 | 4,709 |
| candidate validation | 60,495 | 106,456 | 106,575 | 123,772 | 147,864 | 992,439 | 991,613 |
| route length bound | 204 | 205 | 205 | 204 | 206 | 241 | 241 |
| candidate digest (encode V3 + keccak) | 24,611 | 24,644 | 24,644 | 24,672 | 24,769 | 29,339 | 29,339 |
| market lookup (key hash + 10 cold SLOAD) | 22,413 | 22,414 | 22,414 | 22,414 | 22,422 | 22,618 | 22,618 |
| execution commitment | 1,162 | 1,163 | 1,163 | 1,162 | 1,168 | 1,278 | 4,650 |
| agent signature | 4,308 | 4,309 | 4,309 | 4,309 | 4,315 | 4,462 | 4,468 |
| time window | 338 | 338 | 338 | 338 | 338 | 338 | 338 |
| replay read | 2,204 | 2,204 | 2,204 | 2,204 | 2,204 | 2,204 | 2,204 |
| binding: agent, side | 489 | 489 | 489 | 489 | 489 | 489 | 489 |
| binding: asset hashes | 3,831 | 3,832 | 3,832 | 3,832 | 3,839 | 5,098 | 5,128 |
| binding: chain + allowlist | 1,487 | 1,487 | 1,487 | 1,487 | 3,517 | 1,538 | 1,541 |
| binding: venue + allowlist | 1,504 | 1,504 | 1,504 | 1,504 | 2,859 | 1,716 | 1,720 |
| binding: issuer + allowlist | 1,505 | 1,505 | 1,505 | 1,505 | 2,183 | 1,715 | 1,721 |
| binding: synthetic | 61 | 62 | 62 | 61 | 63 | 101 | 102 |
| binding: quantity / settlement units | 1,699 | 1,699 | 1,699 | 1,700 | 1,700 | 1,871 | 1,875 |
| economics: unit hashes | 2,734 | 2,734 | 2,734 | 2,734 | 2,738 | 3,157 | 3,167 |
| economics: fixture price compare | 1,440 | 1,441 | 1,441 | 1,440 | 1,444 | 1,506 | 1,508 |
| economics: notional bounds | 1,806 | 1,806 | 1,806 | 1,806 | 1,808 | 1,859 | 1,861 |
| economics: true-product maxNotional | 2,240 | 2,240 | 2,240 | 2,240 | 2,240 | 3,151 | 3,152 |
| economics: BUY / SELL economic limit | 2,375 | 2,375 | 3,499 | 2,375 | 2,377 | 3,468 | 3,474 |
| plan: funding bound conversion | 1,447 | 1,447 | 1,562 | 1,447 | 1,449 | 1,534 | 1,536 |
| plan: `decimals()` ×2 (incl. cold access) | 11,051 | 11,051 | 11,051 | 11,051 | 11,051 | 11,051 | 11,051 |
| replay write (SSTORE) | 20,100 | 20,100 | 20,100 | 20,100 | 20,100 | 20,100 | 20,100 |
| pre-balance reads ×2 | 6,036 | 6,036 | 6,036 | 6,036 | 6,036 | 6,036 | 6,036 |
| `transferFrom` principal → adapter | 30,281 | 30,281 | 30,281 | 30,281 | 30,283 | 30,307 | 30,308 |
| adapter execute (incl. venue) | 63,231 | 63,233 | 59,982 | 63,233 | 63,243 | 63,482 | 25,592 |
| post-balance reads ×2 | 2,059 | 2,059 | 2,059 | 2,059 | 2,059 | 2,059 | 2,059 |
| delta validation | 316 | 316 | 334 | 316 | 316 | 316 | 316 |
| `MandateExecuted` event | 4,477 | 4,477 | 4,477 | 4,477 | 4,477 | 4,477 | 4,477 |
| small glue (chain check, internal calls and returns, reentrancy exit) | 1,275 | 1,275 | 1,275 | 1,275 | 1,276 | 1,302 | 1,303 |
| **sum (instrumented build)** | 344,483 | 431,935 | 430,179 | 449,707 | 666,700 | 7,863,202 | 7,827,937 |
| real build (§C) | 324,182 | 401,684 | 399,779 | 417,412 | 609,960 | 6,724,561 | 6,689,297 |

## L. External calls

Callee frames of NORMAL_BUY (`-vvvv`); the caller additionally pays 2,600 for
each first touch of an account and 100 after:

| call | gas | nature |
| --- | ---: | --- |
| `ecrecover` principal | 3,000 | security — principal authority |
| `ecrecover` agent | 3,000 | security — agent authorization |
| `decimals()` representation, funding | 2,350 + 2,350 | security — pinned-units check (plus 2 × 2,600 cold) |
| `balanceOf` before (principal input, recipient output) | 2,537 + 2,537 | settlement — measured deltas |
| `transferFrom` principal → adapter | 29,892 | settlement |
| adapter `execute` | 58,589 (SELL 55,338) | settlement |
| · venue `REPRESENTATION` / `FUNDING` | 240 / 306 | fixture adapter pair check |
| · `balanceOf` adapter | 537 ×2 | adapter self-measurement |
| · `approve` venue, then reset | 24,325 + 2,325 | fixture adapter: no standing allowance |
| · venue `buy` (`transferFrom` 8,323 + `transfer` 10,552) | 20,467 | fixture trade |
| · refund `transfer` | 2,952 | unspent input (BUY only) |
| `balanceOf` after ×2 | 537 + 537 | settlement — measured deltas |

**Necessary settlement and security cost (the floor any design keeps):**
token movement and measurement 112,976 (transfer, adapter, venue, balances,
pins, with their call and access overhead), signatures 8,850, replay 22,304,
reentrancy flag ≈5,000, market record 22,414 (10 cold slots at HEAD), event
4,477, dispatch and bounds 2,948: **178,969 of the 401,684 NORMAL execution**
(§P), plus 21,000 base transaction gas. Everything else — **222,715 at HEAD** —
is mandate-policy processing: validation, encoding, binding and economic checks.
Of the floor, the fixture adapter's approve/reset and self-measurement (~28k)
and the market record's 10 cold slots (~21k) are design choices, not
irreducible.

## M. Arithmetic

| | NORMAL_BUY | % | MAX_EXEC | % |
| --- | ---: | ---: | ---: | ---: |
| `GateArithmetic` + scaling + `mulDiv` frames (real build) | 3,563 | 0.89% | 4,295 | 0.064% |
| all economics stages incl. unit hashes and funding bound (instrumented) | 12,043 | 2.8% | 14,675 | 0.19% |

True product × authoritative price, decimal normalization, the 512-bit
`mulDiv`, floor and ceil, the maxNotional comparison and the BUY and SELL limits
together cost ~3.6k in the real build. **Correctness-critical arithmetic is not
worth touching.**

## N. Replay and storage

Gate storage in one execution (opcode trace and `vm.accesses`):

| access | count | cold/warm | gas |
| --- | ---: | --- | ---: |
| `SLOAD` market record | 10 | cold | 21,000 |
| `SLOAD` replay key `_executions[digest]` | 1 | cold | 2,100 |
| `SLOAD` reentrancy flag | 1 | cold | 2,100 |
| `SSTORE` reentrancy 1 → 2 | 1 | warm, clean | 2,900 |
| `SSTORE` replay 0 → commitment | 1 | warm (read first), new | 20,000 |
| `SSTORE` reentrancy 2 → 1 | 1 | dirty, restored | 100 (refund 2,800) |

12 SLOADs (12 distinct slots), 3 SSTOREs. Replay handling costs 22,304 in total
(read + write; the slot's keccak is computed twice). Reservation generations are
an offchain kernel concept: the gate's replay record is the single
`_executions` slot, and 6R.1b semantics are untouched. Token-side storage in the
same execution: the funding token is read 22 times and written 9 times over 6
distinct slots, the representation 7 / 2 over 3.

## O. Events

`MandateExecuted`: `LOG4` — signature topic plus 3 indexed (`mandateDigest`,
`executionCommitment`, `principal`); 8 data words = 256 bytes (`candidateDigest`,
`agent`, `adapter`, `inputToken`, `outputToken`, `side`, `actualDebit`,
`actualCredit`). Static cost 375 + 4 × 375 + 8 × 256 = 3,923; measured stage
4,477 with its encoding. **1.1% of NORMAL, 0.07% of MAX: not worth changing**
(it is also the reconciliation evidence, docs/execution-gate.md §9).

## P. MAX vs NORMAL

### Cost decomposition (brief §24)

Function-level figures are exact (flamegraph, real build). The inlined code the
flamegraph cannot split is divided by the instrumented stages: storage, calls,
event and dispatch at their stage values (opcode-fixed), and the remaining
budget between digest glue, binding glue and economics glue in proportion to
their stage values (scaled by 0.82 for NORMAL and 0.84 for MAX to remove the
instrumentation inflation). Rows therefore sum exactly to the real build.

| NORMAL_BUY | execution gas | share |
| --- | ---: | ---: |
| token settlement / external calls | 112,976 | 28.1% |
| signature verification | 8,850 | 2.2% |
| economic arithmetic + limit checks | 10,527 | 2.6% |
| replay / storage (market record 22,414, replay 22,304, reentrancy ≈5,000) | 49,718 | 12.4% |
| events | 4,477 | 1.1% |
| policy / identifier processing (validation 148,994, search, binding) | 157,920 | 39.3% |
| encoding / hashing (digests, commitment) | 54,268 | 13.5% |
| other (dispatch, bounds, time, internal calls) | 2,948 | 0.7% |
| **total execution** | **401,684** | 100% |
| + intrinsic | 45,244 | |
| − refund | 42,600 | |
| **transaction** | **404,328** | |

| MAX_SERIALIZABLE | execution gas | share |
| --- | ---: | ---: |
| baseline settlement (token calls 75,362, storage 49,922, signatures 9,177, event 4,477, other 3,020) | 141,958 | 2.1% |
| non-array identifiers: validation (mandate asset and units 383,218, candidate 883,747, other 2,919) | 1,269,884 | 19.0% |
| arrays: set validation (scan 3,582,676, ordering 1,451,591, loop 85,838) | 5,120,105 | 76.5% |
| search + binding | 10,849 | 0.2% |
| economic arithmetic + limit checks | 13,081 | 0.2% |
| encoding + hashing, incl. route commitment | 133,420 | 2.0% |
| **total execution** | **6,689,297** | 100% |
| + intrinsic | 250,508 | |
| − refund | 2,800 | |
| **transaction** | **6,937,005** | |

Included in the rows above rather than separate: memory expansion 46,472 (MAX)
/ 1,623 (NORMAL); route data ≈5,040 of execution; keccak word gas ≈3k / ≈1.2k.

### The delta

MAX_SERIALIZABLE − NORMAL_BUY = **6,287,613 execution gas** (+205,264 intrinsic).
Real build, flamegraph:

| component | NORMAL_BUY | MAX_SERIALIZABLE | delta | share of delta |
|---|---:|---:|---:|---:|
| mandate sets: identifier byte scan | 29,716 | 3,582,676 | 3,552,960 | **56.51%** |
| mandate sets: ordering comparison | 0 | 1,451,591 | 1,451,591 | **23.09%** |
| candidate validation | 94,129 | 883,747 | 789,618 | **12.56%** |
| mandate asset + unit validation | 18,312 | 383,218 | 364,906 | **5.80%** |
| mandate sets: loop/copy overhead | 4,018 | 85,838 | 81,820 | 1.30% |
| mandate validation: other | 2,819 | 2,919 | 100 | 0.00% |
| encoding frames | 16,882 | 77,223 | 60,341 | 0.96% |
| inlined gate code (incl. memory, route hash, glue) | 123,300 | 151,870 | 28,570 | 0.45% |
| economic arithmetic | 3,563 | 4,307 | 744 | 0.01% |
| signatures | 8,274 | 8,579 | 305 | 0.00% |
| allowlist search | 1,342 | 1,477 | 135 | 0.00% |
| token calls (transfer, balances, decimals) | 40,740 | 40,740 | 0 | 0.00% |
| adapter + venue (lean adapter in MAX) | 58,589 | 15,112 | −43,477 | −0.69% |
| **total** | **401,684** | **6,689,297** | **6,287,613** | **100%** |

- **Identifier validation: 6,240,995 gas, 99.26% of the delta** — of which the
  three arrays' entries 5,086,371 (80.9%) and the non-array identifiers
  1,154,624 (18.4%).
- Encoding 0.96%; route data (inside "inlined"): 5,040 (0.08%); memory
  expansion (spread over validation and encoding): +44,849 (0.71%, included
  above); extra hashing ≈ +2.7k of word gas (0.04%).
- Against MAX_EXECUTABLE_FIXTURE (fixture adapter, no route) the delta is
  6,322,877, of which validation is 99.02%.

## Q. Compiler matrix

Scratch builds of the same sources with `FOUNDRY_OPTIMIZER`,
`FOUNDRY_OPTIMIZER_RUNS` and `FOUNDRY_VIA_IR` overrides; the current
configuration stays the canonical baseline and nothing was committed. With
`via_ir = false` the production contracts compile but existing test contracts
(`GateHandler`, among others) are stack-too-deep, so those rows were measured in
a copy holding only the benchmark tests (the same copy with the current
settings reproduces the baseline exactly).

| configuration | MINIMAL | NORMAL_BUY | NORMAL_SELL | DEMO | LARGE | MAX_EXEC | MAX_SER | deploy, 1 market | gate runtime / initcode B | venue / adapter runtime B |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **via-IR, runs 200 (current)** | 324,182 | 401,684 | 399,779 | 417,412 | 609,960 | 6,724,561 | 6,689,297 | 4,283,720 | 13,495 / 22,392 | 1,777 / 2,076 |
| via-IR, runs 1,000 | 320,222 | 397,589 | 395,694 | 413,452 | 604,569 | 6,714,454 | 6,679,273 | 4,633,893 | 14,913 / 24,112 | 1,893 / 2,262 |
| via-IR, runs 10,000 | 317,664 | 395,004 | 393,157 | 410,894 | 601,270 | 6,541,811 | 6,507,020 | 5,103,770 | 16,291 / 26,353 | 2,052 / 2,965 |
| via-IR, runs 100,000 | 316,636 | 393,928 | 392,082 | 409,844 | 599,806 | 6,539,117 | 6,504,350 | 5,431,751 | 17,506 / 27,868 | 2,352 / 2,965 |
| via-IR, runs 1,000,000 | 316,636 | 393,928 | 392,082 | 409,844 | 599,806 | 6,539,117 | 6,504,350 | 5,431,751 | 17,506 / 27,868 | 2,352 / 2,965 |
| via-IR, optimizer off | 762,168 | 1,102,511 | 1,098,602 | 1,183,731 | 1,968,739 | 26,818,740 | 26,755,451 | 8,406,674 | **27,450** / 47,626 | 4,037 / 3,465 |
| legacy, runs 200 | 335,372 | 408,970 | 406,952 | 424,387 | 604,601 | 6,187,861 | 6,146,780 | 5,099,912 | 16,564 / 27,658 | 2,153 / 2,286 |
| legacy, runs 1,000 | 334,314 | 407,909 | 405,919 | 423,329 | 603,516 | 6,186,668 | 6,145,553 | 5,460,075 | 17,998 / 29,421 | 2,283 / 2,484 |
| legacy, runs 10,000 | 329,743 | 403,311 | 401,465 | 418,758 | 598,252 | 6,028,899 | 5,988,453 | 5,978,284 | 19,692 / 31,894 | 2,594 / 2,952 |
| legacy, runs ≥ 100,000 | 329,421 | 402,984 | 401,136 | 418,436 | 597,885 | 6,028,342 | 5,987,896 | 6,162,814 | 20,545 / 32,747 | 2,594 / 2,952 |
| legacy, optimizer off | 408,340 | 486,290 | 484,499 | 501,821 | 701,431 | 6,450,469 | 6,403,787 | 7,410,229 | **24,631** / 42,056 | 3,341 / 3,493 |

Bold runtime sizes exceed EIP-170's 24,576 bytes: not deployable on a chain
enforcing the default limit.

- **Best normal execution:** via-IR, runs ≥ 100,000 — 393,928, **−1.9%**, for
  +27% deployment gas and +30% runtime size.
- **Best MAX:** legacy, runs ≥ 10,000 — 6,028,342, **−10.3%**, but NORMAL is
  worse than today, deployment +40–44%, and the test suite does not compile.
- **Best deployment:** the current configuration.
- **Trade-off:** compiler settings are worth at most ~2% on a normal execution.
  Any setting must be re-chosen after 6R.2B's code changes (the matrix is
  cheap to re-run), and the final choice fixes the provenance gate's inputs.

## R. Market count and deployment scaling

**Execution does not depend on the market count** (`MarketCountExecutionBench`,
the same target market spelled like the NORMAL profile, on gates of 1–16
markets):

| markets | 1 | 2 | 4 | 8 | 16 |
| --- | ---: | ---: | ---: | ---: | ---: |
| execution gas | 401,684 | 402,392 | 402,038 | 402,274 | 402,392 |

Lookup is one mapping read; the ≤ 708 spread is the target token's hex address
inside the representation identifier (validation cost depends on character
class, §D). 32 markets were not executed: deployment above 25 markets exceeds a
32M transaction, and nothing in execution depends on the count.


`DeploymentBench`: CREATE frame (CREATE, initcode words, constructor, code
deposit) + 21,000 + EIP-2028 calldata for initcode and arguments — the 6R.1b
model, with the initcode assembled outside the window and tokens cooled.

| markets | initcode + args B | CREATE frame | intrinsic | **total** | per added market | 6R.1b local model |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 23,640 | 3,909,704 | 374,016 | **4,283,720** | — | 4,281,711 |
| 2 | 24,824 | 5,052,522 | 380,384 | **5,432,906** | 1,149,186 | — |
| 4 | 27,192 | 7,343,261 | 393,084 | **7,736,345** | 1,151,719 | 7,726,336 |
| 8 | 31,928 | 11,925,155 | 418,532 | **12,343,687** | 1,151,835 | 12,325,702 |
| 12 | 36,664 | 16,507,601 | 444,004 | **16,951,605** | 1,151,979 | 16,925,584 |
| 16 | 41,400 | 21,090,599 | 469,440 | **21,560,039** | 1,152,108 | 21,526,042 |
| 24 | 50,872 | 30,258,252 | 520,348 | **30,778,600** | 1,152,320 | 30,728,591 |
| 25 | 52,056 | 31,404,364 | 526,848 | **31,931,212** | 1,152,612 | 31,883,667 |
| 26 | 53,240 | 32,550,510 | 533,228 | **33,083,738** | 1,152,526 | 33,029,717 |
| 32 | 60,344 | 39,428,114 | 571,232 | **39,999,346** | 1,152,601 | 39,933,349 |

The 0.05–0.2% above 6R.1b's local model is the cold `decimals()` reads (6R.1b's
tokens were warm). 24 markets fit under a 32M limit; 25 fits with 69k to spare.

Per added market, ≈1,152,600:

| part | gas | share | source |
| --- | ---: | ---: | --- |
| `FixtureVenueAdapter` creation (2,076 B runtime → 415,200 deposit) | 448,238 | 38.9% | created alone |
| `FixtureVenue` creation (1,777 B → 355,400 deposit) | 389,137 | 33.8% | created alone |
| market storage: 11 slots × 22,100 (+100 for a packed slot written twice) | 243,200 | 21.1% | `vm.accesses` |
| constructor identifier validation | 36,240 | 3.1% | flamegraph |
| arguments' calldata | 6,368 | 0.6% | intrinsic difference |
| `decimals()` ×2 | 4,700 | 0.4% | flamegraph |
| event, representation identifier, keccaks, ABI decoding, price, cold access | 24,717 | 2.1% | remainder |

**Bytecode deployment (venue + adapter) is 72.7%, of which code deposit alone
is 66.9%; market storage 21.1%; validation 3.1%.** The gate base (≈3.13M) is
mostly its own code deposit (13,495 B × 200 = 2.70M) and initcode calldata
(≈0.35M).

## S. Compact prototype results

All scratch-only, outside the repository, never committed and **not
production-ready**. Each variant keeps the gate's ABI; each was checked by
running this repository's **whole** Foundry suite against it (differential
corpus of 301 vectors, codec and injectivity tests, all fuzz and invariants).

| variant | change | NORMAL_BUY | NORMAL_SELL | DEMO | LARGE | MAX_EXEC | MAX_SER | suite |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| HEAD | — | 401,684 | 399,779 | 417,412 | 609,960 | 6,724,561 | 6,689,297 | 225/225 |
| A | validation read straight from calldata, same loop | 388,773 | 386,868 | 405,160 | 586,432 | 6,457,257 | 6,420,840 | 225/225 |
| B | A + 256-bit character mask, unchecked loop, 32-byte word comparison (Solidity) | 294,953 | 293,048 | 297,417 | 360,382 | 1,662,198 | 1,626,607 | 225/225 |
| C | SWAR validation 32 bytes per step + word comparison (assembly) | 273,050 | 271,145 | 270,651 | 298,773 | 514,118 | 478,527 | 225/225 |
| D | C + single-buffer MCE/Candidate writer + nibble-spread address hex | 241,455 | 239,548 | 239,424 | 263,671 | 435,167 | 395,756 | 225/225 |
| D + E | D + market record stored as contract code (one pointer SLOAD + `EXTCODECOPY`) | 226,322 | 224,416 | 224,291 | 248,541 | 420,068 | 380,701 | 220/222 † |
| F — **INVALID** | D with every post-validation identifier comparison removed (upper bound for fixed-size internal IDs) | 230,748 | 228,841 | 228,716 | 249,102 | 423,823 | 384,332 | not run: removes checks |

† The two failing tests predict gate-created venue/adapter addresses from the
creation nonce, which E's extra CREATE per market shifts (and a `setUp` doing
the same). No semantic test fails. E also lowers deployment to ≈1,077,000 per
market (−75k): a code blob is cheaper than 10 storage slots.

- **Validation algorithm (C):** −128.6k NORMAL (−32%), −6.21M MAX (−92.4%).
  Pure Solidity (B) already gets −106.7k / −5.06M. The draft SWAR had a real bug —
  bytes after the string in the last word could borrow into the string's last
  byte — caught in review before running; that class of bug is why C needs a
  dedicated equivalence fuzz (every byte value × lengths 0–129 against the
  reference scanner) before it can replace B.
- **Encoding (D − C):** −31.6k NORMAL, −79k MAX.
- **Fixed-size internal identity (§23):** keeping the signed schemas, the most
  any fixed-ID scheme can save is what F removes: **≤ 10.7k NORMAL, ≤ 14.6k
  LARGE, ≤ 11.3k MAX** — the comparisons are already hashes of short strings.
  A valid design still compares something, so less.
- **Raw canonical bytes (§21).** A benchmark-only `RawBench` walks MCE v2 and
  Candidate V3 bytes from calldata, validates every identifier with C's
  validator (decoder equivalence kept), extracts the fields the gate reads and
  hashes the bytes directly; its digests equal the kernel's. Against the
  structured path with the same validator (validate + encode + hash):

  | | structured (D codec) | raw bytes | structured calldata gas | raw calldata gas | MCE / candidate bytes |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | NORMAL_BUY | 41,353 | 71,040 | 20,228 | 10,796 | 394 / 470 |
  | DEMO | 39,369 | 69,794 | 20,168 | 11,260 | 397 / 494 |
  | LARGE | 59,319 | 83,154 | 27,724 | 15,844 | 652 / 534 |
  | MAX | 230,643 | 228,590 | 159,884 | 140,284 | 7,071 / 1,794 |

  Once validation and encoding are efficient, **parsing raw bytes is not
  cheaper than re-encoding structs** (hex-address parsing and bounds-checked
  slicing cost what the writer saved); only calldata shrinks, by 9–20k. MCE v2
  semantics did not need to change for the prototype; a production parser would
  also need total refusal instead of reverts. Not worth a new wire format.

## T. Lifecycle comparison (registered authority, §22)

Prototype: `register(mandate, principalSignature)` performs the full mandate
validation, digest and principal signature check once, computes a bitmap of the
gate's markets the mandate permits (asset, chain, venue, issuer, synthetic
policy, settlement unit) and stores 5 slots (principal, agent, side, both bounds
with decimals, validity window, bitmap). `executeRegistered(digest, candidate,
terms, agentSignature)` keeps every other check — candidate validation and
digest, market lookup, agent signature over the same commitment, time, replay
through the same `_executions` slot (one settlement across both paths, tested),
binding, true-product maxNotional, economic limits, pinned decimals, measured
settlement. Transaction gas (intrinsic + execution − refund); a failed attempt
is modelled at full E or C cost (an upper bound).

HEAD codec:

| profile | R | E | C (current) | R+E | R+2E | R+4E | 1× C | 2× C | 4× C | break-even |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| NORMAL_BUY | 299,946 | 309,135 | 403,647 | 609,081 | 918,216 | 1,536,486 | 403,647 | 807,294 | 1,614,588 | 4 attempts |
| DEMO | 256,195 | 324,952 | 419,316 | 581,147 | 906,099 | 1,556,003 | 419,316 | 838,632 | 1,677,264 | 3 attempts |
| LARGE | 434,557 | 346,542 | 619,442 | 781,099 | 1,127,641 | 1,820,725 | 619,442 | 1,238,884 | 2,477,768 | 2 attempts |
| MAX_EXEC | 5,898,376 | 1,123,453 | 6,866,215 | 7,021,829 | 8,145,282 | 10,392,188 | 6,866,215 | 13,732,430 | 27,464,860 | 2 attempts |

With the optimized codec (D):

| profile | R | E | C (D) | R+E | R+2E | R+4E | 1× C | 2× C | 4× C | break-even |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| NORMAL_BUY | 235,400 | 213,562 | 243,400 | 448,962 | 662,524 | 1,089,648 | 243,400 | 486,800 | 973,600 | 8 attempts |
| DEMO | 189,407 | 213,860 | 241,309 | 403,267 | 617,127 | 1,044,847 | 241,309 | 482,618 | 965,236 | 7 attempts |
| LARGE | 220,175 | 214,885 | 273,136 | 435,060 | 649,945 | 1,079,715 | 273,136 | 546,272 | 1,092,544 | 4 attempts |
| MAX_EXEC | 488,206 | 250,377 | 576,815 | 738,583 | 988,960 | 1,489,714 | 576,815 | 1,153,630 | 2,307,260 | 2 attempts |

(In the prototype build the unmodified `execute` costs 401,003 on NORMAL_BUY,
−681 against HEAD: adding functions shifted the optimizer.) Registration makes
**single-shot mandates more expensive in every profile** (NORMAL_BUY: +51%
with the HEAD codec, +84% with the optimized one), pays for itself only for retry-heavy or large-policy mandates, and
the case for it shrinks from 4 to 8 attempts at normal size once validation is
efficient. It is a fit for future *standing* mandates (many executions under one
authority), which the current single-settlement model does not have.

## U. Optimization ranking

Savings are measured execution gas against HEAD (§S, §Q), not estimates, except
where marked.

| optimization | NORMAL_BUY saving | MAX_EXEC saving | security risk | complexity | schema impact | audit burden | recommend |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| Word-level identifier validation + word comparison, Solidity (B) | −106.7k (−26.6%) | −5.06M (−75.3%) | Low: same acceptance set, suite passes | Low | none | Low | **Yes — first** |
| SWAR validation in assembly (C, incl. B's comparison) | −128.6k (−32.0%) | −6.21M (−92.4%) | Medium: hand-written assembly on the decoder-equivalence path; needs an exhaustive equivalence fuzz | Medium | none | Medium | **Yes, after B, with the fuzz** |
| Single-buffer encoder + table-free address hex (D − C) | −31.6k (−7.9%) | −79.0k (−1.2%) | Low–Medium: byte equality is pinned by the corpus | Medium | none | Medium | **Yes** |
| Calldata-native validation, same loop (A) | −12.9k (−3.2%) | −267k (−4.0%) | Low | Low | none | Low | Subsumed by B |
| Market record as code (E, on D) | −15.1k (−3.8%) | −15.1k | Medium: storage layout, creation nonces, `verify` and address-predicting tests change | Medium | constructor internals | Medium | Optional in 6R.2B; also −75k per deployed market |
| Remove duplicate hashing (`economicLimit.unit`, `_executions` slot, asset re-encoding) | within F's ≤ 10.7k; ~1–2k from the keccak costs (§H) | ≈ same | Low | Low | none | Low | Yes, folded into D |
| Fixed-size internal IDs | ≤ 10.7k (bound F, invalid ablation) | ≤ 11.3k | Medium | Medium | none | Medium | No: bounded gain |
| Compiler: via-IR, runs ≥ 100k | −7.8k (−1.9%) | −185k (−2.8%) | Low | Low | none | Low (provenance re-pin) | Re-measure after code changes |
| Compiler: legacy pipeline | +1.3k (worse) | −696k (−10.3%) | Low | Medium: tests don't compile | none | Low | No |
| Registered mandate | single-shot +205k (HEAD) / +205k (D) per lifecycle; E vs C −94.5k | break-even at 2 attempts | Medium: new entrypoint, cached authority, second execution path | High | new state, same signed schemas | High | No for 6R.2B; revisit for standing mandates |
| Raw canonical-byte parser | +29.7k execution (worse); −9.4k calldata | −2.1k execution; −19.6k calldata | High: new parser, totality | High | new wire format | High | No |
| Event trimming | ≤ ~1k (event total 4.5k) | — | Low | Low | reconciliation evidence | Low | No |
| Shared or cloned fixture venue/adapter (deployment only) | — | — | Medium | Medium | constructor | Medium | Not measured here; the target is 837k of each market's 1.15M (§R) |

Nothing ranked removes principal authority verification, agent authorization,
domain separation, true-product maxNotional, economic limits, exact fill,
representation binding, issuer/chain/venue restrictions, recipient binding,
replay, single settlement, measured balance deltas, fixture price integrity or
the `REAL_MARKET` refusal. Only F removes checks; it is labelled invalid and used
only as a bound.

## V. Recommended Phase 6R.2B path

**PATH A — micro-optimize the current architecture.** The profile is decisive:
the cost is ordinary Solidity inefficiency in two places — a byte-at-a-time
validation loop (~595 gas/byte/pass, ~109 opcodes per byte) and a
many-buffer encoder — inside an architecture whose remaining parts are already
near their floor. Dynamic identifiers do dominate MAX, but through *validation*,
which a compact internal representation (PATH B) cannot remove without dropping
decoder equivalence (fixed IDs are bounded at ≤ 10.7k); registration (PATH C)
makes single-shot mandates dearer and is justified only by standing mandates the
product does not yet have.

Scope for 6R.2B, in order, each behind the full suite plus the differential
corpus:

1. Word-level validation and comparison in Solidity (variant B), acceptance set
   byte-identical to the kernel's `parseIdentifier` and `readIdentifierSet`.
2. Only with a new exhaustive equivalence fuzz (all 256 byte values, lengths
   0–129, every position; reference scanner kept in `test/utils`): the SWAR
   validator (C).
3. Single-buffer encoding of MCE v2 and Candidate V3 and table-free address hex
   (D), with the duplicate `economicLimit.unit` hash, the double `_executions`
   slot computation and the `assetHash` re-encoding removed.
4. Optional: the market record as code (E), with `verify` and the
   address-predicting tests updated.
5. Re-run the compiler matrix on the result; pick the setting that feeds the
   final deployment provenance gate.

Expected, from the prototypes: NORMAL_BUY 401,684 → ~241k (1–3) or ~226k (1–4);
DEMO 417,412 → ~239k / ~224k; MAX_EXECUTABLE_FIXTURE 6,724,561 → ~435k / ~420k.
The benchmark suite added here is the acceptance instrument: profiles and
sweeps re-run unchanged, and they record rather than assert the current
byte-loop behaviour so they will not block the change.

**Stop.** 6R.2B is not started; nothing in this phase is an implementation of
the recommendation.

## W. Validation

| command | result |
| --- | --- |
| `npm run check` | pass — **746/746** TypeScript tests (65 suites), fixture, replay, routing, cross-surface and Jev validators, credential scan, junk check |
| `npm run generated:check` | pass — no generated artifact changed |
| `npm run audit:security` | 0 vulnerabilities (read-only registry query) |
| `npm run contracts:fmt` | pass |
| `npm run contracts:build` | pass |
| `npm run contracts:lint` | pass |
| `npm run contracts:test` | **225/225**, 28 suites (was 194/194 in 11; +31 benchmark tests in 17 new suite contracts) |
| Fuzz | 22 properties × 1,024 runs |
| Invariants | 12 × 256 runs × depth 64 = 16,384 calls each, 0 reverts, incl. `INV-ONCHAIN-AUTH-1` |
| Differential | 301 vectors / 308 attempts (91 settled, 217 reverted), 20 kernel-reject authority attempts refused, mandate and candidate encodings agree |
| `npm run contracts:slither` | 20 contracts, 101 detectors, **0 results** (no new suppression) |

MCE v2 and Candidate V3 digests are unchanged: the corpora regenerate
identically and the differential encoding tests pass. Prototype suites (scratch,
not part of this validation): B, C, D 225/225; D+E 220/222 (§S).

## X. Files changed

Benchmark infrastructure (test-only):

- `contracts/test/utils/GasBench.sol` — new: measurement method, profile worlds, reporting
- `contracts/test/GasProfiles.t.sol` — new: canonical profiles, fixture route refusal, 6R.1b method
- `contracts/test/GasSweeps.t.sol` — new: identifier, route and allowlist sweeps
- `contracts/test/GasAttribution.t.sol` — new: codec operations, market count, storage, deployment
- `contracts/test/utils/CodecBenchHarness.sol` — new: isolated codec operations
- `contracts/test/mocks/LeanAdapter.sol` — moved out of `Profile.t.sol`
- `contracts/test/Profile.t.sol` — imports `LeanAdapter` instead of defining it

Documentation:

- `docs/phase-6r2a-gas-profile.md` — this report
- `docs/execution-gate.md` — §10 suite rows; §13 canonical baseline pointer
- `docs/roadmap.md`, `README.md`, `AGENTS.md` — phase status

Production (`contracts/src`), scripts, packages and corpora: **unchanged**.
Scratch only, not committed: the instrumented gate, the compiler-matrix builds,
prototypes A–F, the registered-authority and raw-bytes prototypes, flamegraphs
and traces.

Reproduce: `forge test --match-path 'contracts/test/Gas*.t.sol' -vv | grep BENCH`
for every table; `forge test --match-test 'test_gasProfile_<PROFILE>\(' --flamegraph`
for §K/§P; the compiler matrix by `FOUNDRY_OPTIMIZER`, `FOUNDRY_OPTIMIZER_RUNS`,
`FOUNDRY_VIA_IR` with a separate `FOUNDRY_OUT`/`FOUNDRY_CACHE_PATH`; the opcode
counts with `vm.startDebugTraceRecording` under `-vvv`, a raised
`FOUNDRY_GAS_LIMIT` and `FOUNDRY_MEMORY_LIMIT`.

## Y. Local commits

1. `8e0f0ec` test: add deterministic gas benchmark profiles
2. `f42ced2` test: profile dynamic execution inputs
3. `985a37c` test: attribute gate execution gas
4. this report — docs: report phase 6r2a gas attribution

No commit for the compiler matrix or the prototypes: neither belongs in the
repository (§X).

## Z. Git and remote state

- working tree clean after the report commit
- nothing pushed; nothing merged; no pull request
- nothing published; nothing tagged
- nothing deployed; no transaction sent
- no RPC contacted; the only network access was the read-only `npm audit`
  registry query
- remotes unchanged
