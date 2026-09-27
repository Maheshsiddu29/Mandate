# Phase 6R.2B — secure gas optimization

**Implemented locally, not deployed, awaiting independent security and gas
review.** The Phase 6R.2A findings are turned into production code: word-level
identifier validation (first in plain Solidity, then SWAR with narrowly scoped
assembly), word-level set ordering, a single-buffer MCE v2 / Candidate V3
encoder and a table-free address-to-hex routine. A normal BUY drops from
**401,684 to 246,963** execution gas (−38.5%) and the executable worst case from
**6,724,561 to 425,922** (−93.7%).

**Nothing observable changed.** MCE v2, Candidate V3, both EIP-712 domains, the
execution commitment, every digest and every canonical byte are unchanged; every
generated corpus regenerates identically (`npm run generated:check`); the
production gate and the pre-optimization gate give identical outcomes —
success, complete return/revert data, every log, the replay record and every
balance — on all 328 corpus attempts and on 1,200 mutated attempts, with **0
mismatches**. The gate contract source (`MandateExecutionGate.sol`), the
arithmetic, the fixture venue and adapter and the compiler settings are
byte-identical to `b2295b0`; only `MandateCodec.sol` changed in `contracts/src`.

Nothing was pushed, merged, published, tagged or deployed; no transaction was
sent and no RPC contacted.

---

## 1. Baseline

| | |
| --- | --- |
| Starting commit | `b2295b0` (as expected), branch `main`, clean tree, 41 commits ahead of `origin` |
| solc | 0.8.37 |
| Foundry | forge 1.7.1 (`4072e487`) |
| Optimizer | enabled, `optimizer_runs = 200` |
| `via_ir` | true |
| EVM target | `cancun` |
| `bytecode_hash` | none |
| Methodology | Phase 6R.2A cold transaction (`contracts/test/utils/GasBench.sol`): each gate deployed in `setUp` with its own tokens, one execution per test function, execution gas = the gate's call frame (`vm.lastCallGas`), calldata pre-encoded outside the window, intrinsic gas by EIP-2028, transaction = intrinsic + execution − refund (capped at 1/5) |

The baseline was re-measured from a pristine `git archive b2295b0` and
reproduces the 6R.2A canonical figures exactly (NORMAL_BUY 401,684, MAX_EXECUTABLE_FIXTURE
6,724,561, runtime 13,495 B).

## 2. Root cause (measured in Phase 6R.2A, not restated as speculation)

Phase 6R.2A ([report](phase-6r2a-gas-profile.md) §D, §K, §P) measured that the
gate validated every identifier byte with a byte-at-a-time Solidity loop at
**≈595 gas per byte per pass** and ordered sets with a byte-at-a-time comparison
at **≈260 gas per compared byte**; together **37% of a normal BUY, 95% of the
worst case, and 99.3% of the MAX − NORMAL difference**. Encoding (nested
`bytes.concat` of part buffers, `Strings.toHexString` per party) was 13.5% of a
normal BUY. Hashing, memory, storage, events and arithmetic together explained
under 2% of the MAX − NORMAL difference.

## 3. Word validator (step 1, `0aa496d`)

**Old algorithm.** For each byte `i` of `bytes(s)` copied to memory: read one
byte, test three alphanumeric ranges and five separator values with chained
comparisons, and test "separator at position 0 or n−1".

**New algorithm.** The calldata identifier is read a 32-byte word at a time
(`bytes32(b[i:i + len])`, a calldata slice, which is zero-padded on the right and
so never carries bytes past the slice), each of the slice's own bytes is
classified with one shift of a 256-bit charset mask, and the separator rule is
two mask lookups on the first and last byte. `compareEncoded` compares
equal-length operands a zero-padded word at a time straight from calldata
instead of copying both to memory. The accepted language is unchanged:
1..128 bytes of `A-Z a-z 0-9 . _ - : /`, neither end a separator; sets strictly
ascending by (length, bytes).

**Gas.** NORMAL_BUY 401,684 → 295,559 (−106,125); MAX_EXECUTABLE_FIXTURE
6,724,561 → 1,331,558 (−5,393,003). 6R.2A prototype B: 294,953 / 1,662,198.

**Equivalence.** The pre-optimization library is preserved verbatim (renamed) as
`contracts/test/reference/ReferenceMandateCodec.sol`; `IdentifierEquivalence.t.sol`
(`56a6999`) proves the new code equal to it (§6). The step-1 code itself is
retained as `contracts/test/reference/WordIdentifier.sol` and remains a third
implementation in every comparison.

## 4. Assembly validator and comparator (step 2, `2b0054e`)

**Strategy.** 32 bytes per step with SWAR arithmetic. Only the loads are
assembly (`calldataload` at `s.offset + i`, `mload` for the constructor's memory
variant); the classification is unchecked Solidity (`_outsideCharset`).

For each byte lane, `v` = its low 7 bits (0..0x7f) is range-tested against the
charset's four ranges `[0x2d,0x3a]` (`- . / 0-9 :`), `[0x41,0x5a]`, `[0x5f]` and
`[0x61,0x7a]`: `v + (0x80 − lo)` has bit 7 set iff `v ≥ lo`, and `v + (0x7f − hi)`
iff `v > hi`. Every addend is at most 0x53, so no lane sum exceeds 0xd2:
**nothing carries between lanes or out of the word**, and each lane's verdict
depends on that byte alone. A byte with its high bit set is outside the charset.

**Partial-word masking and dirty tails.** The last word of an identifier is read
whole, so its lanes past the logical end hold whatever follows in calldata:
ABI padding (which the decoder does not check, so attacker-chosen), the next
argument, or zeros past `calldatasize`. Those lanes are discarded by
`_leadingLanes(n − i) = ~(max >> 8·(n − i))` *after* classification; since lanes
are independent, discarded lanes cannot influence kept ones. This is precisely
the class of bug the 6R.2A prototype had (a borrow from trailing bytes into the
last byte) and it is structurally excluded here. The comparator clears the same
lanes from both operands before comparing. The memory variant never assumes
memory past a string is zero.

**Word boundaries.** `n ≤ 128`, so at most four words; `i` never reaches `n`, so
no load starts past the identifier, and a length that is a multiple of 32 never
loads the following word.

**Fuzz count.** See §6: in the committed suite ≈31k randomized plus ≈110k
deterministic validator comparisons per run; the heavy local campaign ran
**200,000** seeded cases (each validated clean, with three kinds of dirty
calldata and with a dirty memory tail, across five implementations) plus
20,000 runs of each of six fuzz properties — over **560,000 randomized validator
comparisons and 400,000 randomized comparator comparisons, 0 mismatches**.

**Mutation results.** §10: all 10 validator and comparator mutants killed; the
prototype-bug mutant (V5) is killed only by the dirty-tail regressions.

**Gas.** NORMAL_BUY 295,559 → 270,891; MAX_EXECUTABLE_FIXTURE 1,331,558 →
481,066. 6R.2A prototype C: 273,050 / 514,118 — production is better on both.

## 5. Comparator

Kernel order is length first, then bytes (`compareIdentifierBytes`). Production
`compareEncoded(bytes calldata, bytes calldata)` returns on a length difference,
then compares 32-byte big-endian words with the lanes past the common length
cleared from both; the first differing word orders exactly as the first
differing byte, and prefix ordering is decided by length before any word is read.
Equivalence with the reference and the word implementation is proved on equal
strings at every length 0–130, prefix pairs (`ABC`/`ABCD`, 0/1, 1/2, 31/32, 32/33,
63/64, 64/65, 127/128) including a shorter string of `0xff` against a longer one
of `0x00`, single differences at the first, middle, last and every word-boundary
position (31, 32, 63, 64, 95, 96, 127 among them) with value pairs across every
edge signedness or a carry could flip (`00/01`, `7f/80`, `fe/ff`, `00/ff`, …) in
both orders, double differences where the earlier decides across a boundary,
dirty padding on both operands, arbitrary and related random pairs, and random
sets over a colliding pool.

## 6. Equivalence evidence for identifier processing

`IdentifierEquivalence.t.sol` through `utils/IdentifierHarness.sol`: every call
answers **reference, word calldata, word memory, production calldata,
production memory** side by side.

| test | coverage |
| --- | --- |
| `test_validator_everyLength` | every length 0–140 with 4 random and 6 uniform fillers, plus 255, 256, 257, 1,000 — every `length mod 32`, both limits |
| `test_validator_everyByteValueAtWordBoundaries` | all 256 byte values at first, middle, last and positions 31–33, 63–65, 95–97, 127, for lengths 1, 2, 3, 31, 32, 33, 63, 64, 65, 95, 96, 97, 127, 128, 129 |
| `test_validator_classBoundaryBytesAtEveryLength` | 27 class-boundary bytes at those positions for every length 1–130 |
| `test_validator_dirtyTailIgnored_everyRemainder` | every length 1–129 with `len mod 32 ≠ 0` × 27 final bytes × 6 tail fills, each: clean, dirty padding, dirty padding + trailing words, truncated calldata, dirty memory tail |
| `test_validator_dirtyTailIgnored_everyFinalByte` | all 256 final bytes and all 256 uniform strings at lengths 1, 31, 33, 63, 65, 95, 97, 127 × 6 fills, same five evaluations |
| `testFuzz_validator_*` (3) | arbitrary bytes; mutated identifiers (16 per run); fuzzed dirty tails |
| comparator tests (3 + 2 fuzz) | §5 |
| `testFuzz_sets_agree` | random sets over a colliding pool |
| `test_campaign_seeded` | `IDENTIFIER_CAMPAIGN_CASES` seeded cases (default 12,000), each also dirty and paired for the comparator; logs its distribution |

Heavy local run (`IDENTIFIER_CAMPAIGN_CASES=200000 FOUNDRY_FUZZ_RUNS=20000`,
2 min 33 s, 15/15 pass):

| | |
| --- | --- |
| seeded cases | 200,000 (57,945 valid, 142,055 invalid; 25,992 over the 128-byte limit) |
| length distribution | 60% uniform over 0–130, 30% exactly on a boundary length, 10% 129–328; every `length mod 32` bucket ≥ 4,154 cases; 74,744 with `length mod 32 ∈ {31, 0, 1}` |
| mutations | 0–3 per case, a third at a boundary position (0, n−1, 31–33, 63–65, 95–97, 127) |
| dirty-tail evaluations | 800,000 (each case: dirty padding, dirty padding + 2 garbage words, truncated calldata, dirty memory tail) |
| comparisons | 200,000 related pairs (49,889 equal), each also with both operands' padding dirtied |
| fuzz properties | 6 × 20,000 runs (mutated identifiers: 320,000 cases; comparator related pairs: 160,000) |
| mismatches | **0** |

At the real entry point, `CalldataPadding.t.sol` overwrites the ABI padding
after every identifier of a signed `execute` call: honest BUY and SELL settle
identically, and an identifier whose final byte is outside the charset (every
class edge, lengths 12/31/33/63, mandate and candidate) stays refused as
`MalformedMandate`/`MalformedCandidate` whatever follows it.

## 7. Encoder (step 3, `d8bb898`)

**Old.** `encodeMandate` built `head`, `parties` (each party through
`Strings.toHexString` and two `abi.encodePacked`), `asset`, `economics` (with two
amount buffers), three sets (each an accumulating `bytes.concat`, O(n) copies of
earlier entries) and `tail`, then one final `bytes.concat`: every byte copied two
or three times; `encodeCandidate` likewise with three part buffers;
`assetHash` re-encoded the asset.

**New.** Each encoder computes its exact output length (fixed bytes documented
field by field in `MANDATE_FIXED_BYTES = 295`, `CANDIDATE_FIXED_BYTES = 307`, plus
the identifier bytes), allocates **one** buffer (`_alloc`) and writes every field
in encoder order through `_putUint`, `_putString`, `_putParty`, `_putAsset`,
`_putAmount`, `_putSet`, each taking and returning the write pointer; strings are
copied once, straight from calldata. `_seal` requires the final pointer to equal
the buffer's end (`assert`, never input-dependent), so a length computation and a
writer can never silently disagree, and zeroes the spare word after the data.
Field order, widths, the `u16` framing (its low 16 bits, as the previous
`uint16` cast), two's complement for the `int64` fields and the party encoding
are unchanged.

**Byte-for-byte equivalence** (`1b29368`): the 139 mandate and 188 candidate
corpus encodings and the mandate and candidate of all 308 execution and 20
authority attempts are encoded by both encoders and compared as bytes (valid and
malformed alike); `EncodingEquivalence.t.sol` adds random mandates and
candidates at every accepted size and past the identifier limit, full-width
numerics, negative times, the extreme shapes, string framing at every length
0–300 and past 65,535 bytes, random sets, and memory hygiene (a neighbouring
allocation untouched, zero padding, an aligned free-memory pointer). Digest and
asset-hash equality are secondary assertions. **No canonical vector changed.**

**Gas.** NORMAL_BUY 270,891 → 246,963 (−23,928); MAX_EXECUTABLE_FIXTURE 481,066 →
425,922. Isolated stage cost for the NORMAL shape (scratch harness, reference →
production): validation 148,005 → 21,591; mandate + candidate encode and hash
50,696 → 23,199; one party 9,192 → 596; the two asset hashes 3,249 → 3,681.

**Difference from the 6R.2A prototype D (241,455 / 435,167).** Production is
5.5k above D on NORMAL and 9.2k *below* it on MAX. The 6R.2A plan folded three
duplicate computations into D — the `assetHash` re-encoding, the second
`economicLimit.unit` hash and the second `_executions` slot hash — which
production deliberately keeps: the two asset hashes alone cost 3.7k here, and
removing them means threading hashes through the gate's `Plan`, a structural
change to `MandateExecutionGate.sol` for ~1%. Production also pays for exact
length precomputation and the `_seal` agreement check, which D did not have.
The MAX advantage comes from the SWAR loop being tighter than prototype C's.

## 8. Address encoding

`_hexDigits` spreads 16 address bytes to one nibble per byte with five
shift-and-mask steps (`(x | x << s) & mask` for s = 64, 32, 16, 8, 4 — each moves
the upper half of every lane into the next lane up, preserving order) and turns
nibble `n` into `n + 0x30 + 0x27·[n > 9]`, where `(n + 6) >> 4` is exactly the
`n > 9` bit; lanes hold at most 0x66, so nothing carries. The high 16 bytes fill
one word, the low 4 bytes the top 8 lanes of another. After the fixed 20-byte
head `u16 14 ‖ "eip155-address" ‖ u16 42 ‖ "0x"`: 40 lowercase digits, leading
zeros kept — exactly `Strings.toHexString(addr)`.

Compared byte for byte with the reference (`Strings.toHexString`) for `address(0)`,
`0xff…ff`, `1 << k`, `max >> k`, `max << k` for every nibble shift k, alternating
and digit-edge patterns, **every byte value at every one of the 20 positions over
zero, ones and mixed backgrounds** (15,360 addresses: every high and low nibble
0–f in every position, including the separately converted low 4 bytes), 1,024
fuzzed addresses per run, plus the exact spelling of two addresses.

## 9. Gas progression

Execution gas, cold transaction; calldata, intrinsic gas and refunds are
unchanged by this phase (MINIMAL 4,132 B / 43,240; NORMAL 4,228 B / 45,244; DEMO
4,132 B / 45,184; LARGE 5,124 B / 52,764; MAX_EXECUTABLE_FIXTURE 14,500 B /
184,948; MAX_SERIALIZABLE 18,596 B / 250,508; refund 42,600, MAX_SERIALIZABLE
2,800).

| profile | baseline | word (Solidity) | SWAR (assembly) | single-buffer encoder | final (via-IR, 200) | Δ execution | Δ % | transaction before → after | Δ tx % |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MINIMAL | 324,182 | 280,279 | 268,469 | 244,609 | **244,609** | −79,573 | −24.5% | 324,822 → 245,249 | −24.5% |
| NORMAL_BUY | 401,684 | 295,559 | 270,891 | 246,963 | **246,963** | −154,721 | −38.5% | 404,328 → 249,607 | −38.3% |
| NORMAL_SELL | 399,779 | 293,654 | 268,986 | 245,051 | **245,051** | −154,728 | −38.7% | 402,423 → 247,695 | −38.4% |
| DEMO | 417,412 | 295,943 | 268,581 | 244,657 | **244,657** | −172,755 | −41.4% | 419,996 → 247,241 | −41.1% |
| DEMO_SELL | 415,036 | 294,038 | 266,676 | 242,744 | **242,744** | −172,292 | −41.5% | 417,620 → 245,328 | −41.3% |
| LARGE | 609,960 | 350,804 | 295,260 | 270,738 | **270,738** | −339,222 | −55.6% | 620,124 → 280,902 | −54.7% |
| MAX_EXECUTABLE_FIXTURE | 6,724,561 | 1,331,558 | 481,066 | 425,922 | **425,922** | −6,298,639 | −93.7% | 6,866,909 → 568,270 | −91.7% |
| MAX_SERIALIZABLE | 6,689,297 | 1,295,967 | 445,475 | 386,555 | **386,555** | −6,302,742 | −94.2% | 6,937,005 → 634,263 | −90.9% |

Share of each step in the total reduction:

| profile | step 1 word | step 2 SWAR | step 3 encoder |
| --- | ---: | ---: | ---: |
| MINIMAL | −43,903 (55%) | −11,810 (15%) | −23,860 (30%) |
| NORMAL_BUY | −106,125 (69%) | −24,668 (16%) | −23,928 (15%) |
| DEMO | −121,469 (70%) | −27,362 (16%) | −23,924 (14%) |
| LARGE | −259,156 (76%) | −55,544 (16%) | −24,522 (7%) |
| MAX_EXECUTABLE_FIXTURE | −5,393,003 (86%) | −850,492 (14%) | −55,144 (1%) |
| MAX_SERIALIZABLE | −5,393,330 (86%) | −850,492 (13%) | −58,920 (1%) |

The compiler step changes nothing (§12). Directional expectations from the brief
(NORMAL_BUY ~270k after validation, ~241k after encoding; MAX ~500k / ~435k) are
met: 270,891 / 246,963 and 481,066 / 425,922.

After optimization a normal BUY is roughly half settlement floor: token movement
and measurement ≈113k, the market record's 10 cold slots 21k, replay 22k,
signatures 9k, event 4.5k (6R.2A §L, unchanged here); identifier validation is
≈22k and encoding ≈23k.

## 10. Mutation testing

Scratch mutants, applied one at a time to a copy of the tree and run against the
**whole** Foundry suite (invariants included, failure cache cleared per mutant).
None was committed.

Validator and comparator (against the tree at `2b0054e` plus its equivalence suite):

| mutant | result | killing tests |
| --- | --- | --- |
| V1 ignore the invalid final byte (mask one lane short) | killed | 7 (every-length, every-byte-value, class-boundary, both dirty-tail sweeps, campaign, `test_identifier_refusesEverythingElse`) |
| V2 final-word mask one lane too wide | killed | 118 (every clean identifier now sees a zero padding byte) |
| V3 accept an invalid byte at position 31 | killed | 3 |
| V4 accept an invalid byte at position 32 | killed | 5 |
| V5 **trailing garbage carries into the last byte** (the 6R.2A prototype bug class: lanes not reduced to 7 bits, so a tail byte ≥ 0xad carries +1 into the last logical byte, turning `,` into `-`) | killed | 3 — `test_validator_dirtyTailIgnored_everyRemainder`, `…_everyFinalByte`, `test_campaign_seeded`; no clean-input test catches it |
| V6 memory variant: final word unmasked | killed | 16 (constructor refuses every market, plus the equivalence sweeps) |
| C1 prefix (length) ordering reversed | killed | 106 |
| C2 equal strings order as less (duplicates accepted) | killed | 5 |
| C3 last-word comparison ignores the final byte | killed | 11 |
| C4 comparator inspects trailing garbage (no mask) | killed | 2 — `test_comparator_equalAndPrefixOrdering`, campaign (dirty padding) |

Security, arithmetic and encoder (against the final tree):

| mutant | result | tests failing |
| --- | --- | ---: |
| S1 true-product maxNotional check removed | killed | 13 |
| S2a declared BUY debit bound (economic limit) removed | killed | 4 |
| S2b funding limit vs signed economic limit removed | killed | 3 |
| S3 exact fill relaxed to at-least | killed | 4 |
| S4 representation binding removed | killed | 4 |
| S5 venue binding removed | killed | 5 |
| S6 recipient binding removed | killed | 4 |
| S7 signature domain drops `verifyingContract` | killed | 5 |
| S8a replay consumption write removed | killed | 11 |
| S8b replay check removed | killed | 7 |
| S9a balance delta: BUY debit bound removed | killed | 3 |
| S9b balance delta: SELL credit minimum removed | killed | 4 |
| S10 fixture price binding removed | killed | 6 |
| A1 maxNotional uses the product floor | killed | 9 |
| A2 unrepresentable product accepted | killed | 3 (incl. the invariant non-vacuity test and `test_m1_unrepresentableProductIsTheOnlyRefusal`) |
| A3 maxNotional off by one atom | killed | 11 |
| A4 M4: ceiling saturates at uint256 max | killed | 2 (`test_m4_ceilingPastUint256IsTheOnlyRefusal`, `test_m4_theBoundaryIsFloorMaxWithARemainder`) |
| E1 uppercase hex digits | killed | 10 |
| E2 one-byte string length prefix | killed | 95 |
| E3 two tail fields swapped | killed | 6 |
| E4 party low word from the wrong bytes | killed | 10 |
| E5 no spare word reserved after the buffer | killed | 2 — the encoder memory-hygiene fuzz and a gate-level fuzz whose revert data changed: without the spare word the spill corrupts live memory, so the reservation is load-bearing |
| E6 set count off by one | killed | 6 |

The new differential suites (`GateEquivalence`, the byte-level corpus
comparisons) appear among the killers of every security mutant: they are not
vacuous, and the existing suites still kill everything they killed before.

## 11. Market record as code — evaluated and rejected

| | |
| --- | --- |
| Runtime saving | ≈15.1k per execution (6R.2A prototype D+E vs D; the 10 cold market slots are still 21,000 gas here, replaced by one pointer `SLOAD` 2,100 + cold `EXTCODECOPY` ≈2,600 + copy and decode) — ≈6% of the new NORMAL_BUY |
| Deployment | ≈ −75k per market (a code blob is cheaper than 10 storage slots), ≈1.7% of a one-market deployment |
| Extra contract per market | one more CREATE per market (three instead of two) |
| CREATE behaviour / address derivation | the extra CREATE shifts every gate-created venue and adapter address; `world.ts`, the shared corpus's adapter addresses, `DeployScript.t.sol`'s predicted addresses and `verify` would all change — the corpus would have to be regenerated for an optimization, which this phase forbids |
| Test complexity | two tests failed in the prototype for exactly that reason; the corpus world would need re-deriving |
| Code-read assumptions | the gate would trust bytes read with `EXTCODECOPY`: the blob must be unexecutable (leading `STOP`), its length and layout checked on every read, and its immutability relied on (no `SELFDESTRUCT` path post-Cancun, but a new assumption to review) |
| Audit surface | a new data-contract format and decoder on the authorization path |
| Indexer/debugger ergonomics | `marketOf` would decode code instead of reading storage; storage-diff tooling no longer shows market facts |

The measured benefit (~6% of a normal execution) does not justify a new
code-as-data format on the authorization path, a corpus regeneration and a
provenance rebuild. **Rejected.** Recorded as a possible later optimization if
execution volume makes 15k per execution material.

## 12. Compiler decision

Post-optimization matrix (scratch copy holding only the benchmark tests, as in
6R.2A, because the invariant handler is stack-too-deep without via-IR; the same
copy at the current settings reproduces the in-repo figures exactly). Execution
gas; deployment is the one-market transaction by the 6R.2A model.

| configuration | MINIMAL | NORMAL_BUY | NORMAL_SELL | DEMO | LARGE | MAX_EXEC | MAX_SER | deploy, 1 market | runtime / initcode B |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **via-IR, 200 (current)** | 244,609 | 246,963 | 245,051 | 244,657 | 270,738 | 425,922 | 386,555 | 4,325,376 | 13,815 / 22,959 |
| via-IR, 1,000 | 241,962 | 244,256 | 242,354 | 242,010 | 267,335 | 420,503 | 381,219 | 4,669,696 | 15,209 / 24,655 |
| via-IR, 10,000 | 239,575 | 241,854 | 240,000 | 239,623 | 264,765 | 417,969 | 379,075 | 5,211,236 | 16,915 / 27,224 |
| via-IR, 100,000 | 239,410 | 241,681 | 239,828 | 239,458 | 264,516 | 416,704 | 377,834 | 5,487,750 | 17,892 / 28,501 |
| via-IR, 1,000,000 | 239,410 | 241,681 | 239,828 | 239,458 | 264,516 | 416,704 | 377,834 | 5,487,750 | 17,892 / 28,501 |
| legacy, 200 | 263,143 | 265,628 | 263,608 | 263,191 | 289,222 | 451,178 | 407,755 | 4,994,550 | 16,197 / 27,526 |
| legacy, 1,000 | 261,362 | 263,787 | 261,795 | 261,410 | 286,829 | 446,697 | 403,240 | 5,320,572 | 17,465 / 29,123 |
| legacy, 10,000 | 258,900 | 261,310 | 259,462 | 258,948 | 284,214 | 443,560 | 400,772 | 5,771,088 | 18,820 / 31,257 |
| legacy, 100,000 | 258,762 | 261,166 | 259,316 | 258,810 | 284,010 | 442,412 | 399,624 | 5,898,488 | 19,409 / 31,846 |
| legacy, 1,000,000 | 258,762 | 261,166 | 259,316 | 258,810 | 284,010 | 442,412 | 399,624 | 5,898,488 | 19,409 / 31,846 |

- Best execution: via-IR ≥ 100,000 runs, **−2.1% on NORMAL_BUY (−5,282), −2.2%
  on MAX (−9,218)**, for **+26.9% one-market deployment (+1.16M)** and +30%
  runtime size.
- via-IR 1,000: −2,707 per execution for +344k deployment — pays back only after
  ~127 executions of one gate; 10,000: −5,109 for +886k, ~173 executions.
- Legacy pipeline: worse than the current setting in every column (+7.6%
  NORMAL, +15.5% deployment).

**Decision: keep via-IR, `optimizer_runs = 200`.** A ≤ 2.2% execution gain does
not justify 8–27% more deployment gas for a one-market MVP, and unchanged
settings keep the pending provenance gate's inputs stable. Revisit only if a
deployment is expected to execute hundreds of times.

## 13. Semantic differential

| | |
| --- | --- |
| Corpus replay against TypeScript expectations, production gate | 301 vectors / 308 attempts (91 settled, 217 reverted with exact revert data) + 20 authority vectors (20 refused) |
| The same, pre-optimization gate (`ReferenceGateDifferentialTest`) | identical: all expectations met |
| Direct production vs pre-optimization (`test_equivalence_everyCorpusAttempt`) | 321 vectors, **328 attempts, 91 settled on both, 237 reverted identically, 0 mismatches** in success, complete return/revert data (selector and arguments), every log (the gate's `MandateExecuted` with both digests, commitment, agent, adapter, tokens, side, debit and credit; every token `Transfer`/`Approval`), replay record and balances |
| Mutated attempts (`test_equivalence_mutationCampaign`, 400 cases) | **1,200 attempts, 412 settled on both, 27 distinct revert selectors on both, 0 mismatches**; plus `testFuzz_equivalence_mutatedAttempts`, 1,024 runs |
| Canonical encodings | 139 mandate + 188 candidate vectors and all 328 attempts' mandates and candidates: identical bytes |

Reason ordering is therefore unchanged for every existing rejection vector:
`validateMandate` and `isValidCandidate` keep their check order and return the
same booleans, and the gate source is unchanged.

## 14. Security

| check | result |
| --- | --- |
| Fuzz | 35 properties × 1,024 runs (22 before; +13 in the new suites) |
| Invariants | 12 × 256 runs × depth 64 = 16,384 calls each, **0 reverts**, including `INV-ONCHAIN-AUTH-1` (true-product maxNotional) |
| Arithmetic | `GateArithmetic` and `_checkMaxNotional` unchanged; M-1 regressions (`MaxNotional.t.sol`, 18 tests) and M4 (`test_m4_*`) pass; all four 6R.1a arithmetic mutants and the 6R.1b M4 mutant still killed (A1–A4) |
| Fixture trust | `FixtureTrust.t.sol` 5/5; gate-created venue and adapter, pinned decimals, immutable price and the `REAL_MARKET` refusal untouched (source identical to `b2295b0`) |
| Mutation | 10/10 validator and comparator mutants, 23/23 security, arithmetic and encoder mutants killed |
| Stop conditions | none triggered: no canonical vector, digest or reason order changed; no mismatch; M-1 closed; exact fill and single settlement unchanged; no Critical or High finding |

### Assembly review

Every assembly block (`contracts/src/libraries/MandateCodec.sol`), reviewed for
the brief's eight hazards:

| block | reads / writes | review |
| --- | --- | --- |
| `isIdentifier`: `calldataload(start)`, `calldataload(start + n − 1)`, `calldataload(start + i)` | reads calldata | `start = s.offset` and `n` are the ABI decoder's bounds-checked range; `n ≥ 1` so `n − 1` cannot underflow; every load starts inside `[start, start + n)`; bytes a load covers past `calldatasize` read as zero and past `n` are masked; `byte(0, …)` yields a clean 0–255 value; no memory touched |
| `isIdentifierBytes`: `mload(b + 32 + i)` | reads memory | `i < n = b.length`, so each load starts inside `b`'s data; up to 31 following bytes (another allocation or unallocated memory, never assumed zero) are masked; a read cannot corrupt memory |
| `compareEncoded`: two `calldataload` per word | reads calldata | as `isIdentifier`, both operands decoder-bounded, lanes past the common length cleared from both before comparing |
| `_alloc` | writes the length word and the free-memory pointer | takes the current free pointer, reserves `32 + len` plus one spare word rounded up (`and(p + len + 0x3f, ~0x1f)`, correct even for an unaligned pointer); `len` is a sum of calldata lengths, far from overflow |
| `_putUint` | one `mstore` | `size` is a constant 1–32 at every call site; `shl(256 − 8·size, value)` drops any high bits exactly as `uintN(value)` would (dirty upper bits cannot leak); the store ends ≤ 31 bytes past the data's end, inside the reservation |
| `_putString` | one `mstore`, one `calldatacopy` | `shl(240, len)` keeps the low 16 bits (= `uint16(len)`); the copy is exactly `len` bytes from the decoder-checked range into `[p + 2, p + 2 + len)` |
| `_putParty` | three `mstore` | increasing addresses, each overwriting the previous one's zero tail; `bytes20` head is left-aligned and clean; the last store ends 24 bytes past `p + 60`, inside the reservation, then overwritten |
| `_seal` | one `mstore` | zeroes the spare word inside the reservation; `assert(p == end)` ties the writers to the precomputed length |

Calldata/memory confusion is excluded by type (`.offset` exists only on calldata
variables); integer truncation happens only where the previous encoder truncated
identically (`u16` length and count, `int64 → uint64` two's complement); no code
relies on zeroed memory — every data byte is written before `_seal`, and the
`p == end` assertion proves the writers cover the buffer exactly. All blocks are
`memory-safe`: memory is written only inside a reservation made by moving the
free-memory pointer. Mutants E5 (reservation without the spare word) and
V2/V6/C4 (masking) show the tests detect a violation of each assumption.

## 15. Tooling

| command | result |
| --- | --- |
| `npm run check` | pass — **746/746** TypeScript tests (65 suites), fixture, replay, routing, cross-surface and Jev validators, credential scan, junk check |
| `npm run generated:check` | pass — no generated artifact changed |
| `npm run audit:security` | 0 vulnerabilities (read-only registry query) |
| `npm run contracts:fmt` | pass |
| `npm run contracts:build` | pass |
| `npm run contracts:lint` | pass |
| `npm run contracts:test` | **261/261**, 33 suites (225/225 in 28 before) |
| Fuzz | 35 properties × 1,024 runs |
| Invariants | 12 × 16,384 calls, 0 reverts |
| Differential | 301 vectors / 308 attempts (91 settled, 217 reverted), 20 authority attempts refused; encodings agree byte for byte |
| Before/after gate differential | 328 attempts + 1,200 mutated, 0 mismatches |
| Heavy validator campaign | 200,000 cases + 6 × 20,000 fuzz runs, 0 mismatches (local, §6) |
| `npm run contracts:slither` | 20 contracts, 101 detectors, **0 results**; `--show-ignored-findings` 20 reviewed (12 before + 8 `assembly`) |

Slither on the optimized codec first reported 13 results: `divide-before-multiply`
×2 (Medium) on the constant `LANES = type(uint256).max / 0xff` — an exact,
constant-folded division, rewritten as the literal; `too-many-digits` ×3 on mask
literals — rewritten as the separator's five bits and as products, same values,
same bytecode size and gas; `assembly` ×8 (Informational) — the intended change,
one inline `slither-disable-next-line assembly` per function beside a reason
pointing at §14. No suppression covers a Low, Medium or High detector
([execution-gate.md §14](execution-gate.md#14-slither-findings), S-13–S-15).

## 16. Runtime and deployment

| | runtime B | initcode B | one-market deployment gas |
| --- | ---: | ---: | ---: |
| baseline `b2295b0` | 13,495 | 22,392 | 4,283,720 |
| word validation `0aa496d` | 13,463 | 22,269 | 4,251,555 |
| SWAR `2b0054e` | 13,657 | 22,808 | 4,291,816 |
| encoder `d8bb898` = final | **13,815** | 22,959 | **4,325,376** |

Final: +320 B runtime (+2.4%, 10,761 B below EIP-170), +41,656 deployment gas
(+1.0%; the code deposit of the larger runtime, partly offset by cheaper
constructor validation). The per-market cost is unchanged in structure (venue
389k and adapter 448k creation). The one-market gate stays practical to deploy.

## 17. Gas regression guards

`GasProfiles.t.sol` asserts ceilings, not values: 300,000 for MINIMAL,
NORMAL_BUY/SELL, DEMO/DEMO_SELL; 330,000 for LARGE; 1,000,000 for both MAX
profiles — about 20% above the measurements. The compiler matrix moves a normal
execution by ≤ 2.2%, so the headroom absorbs toolchain drift. Verified against
earlier trees: the pre-optimization gate fails all eight guards (NORMAL_BUY
401,684; MAX 6,724,561); the step-1 plain word validator fails LARGE (350,804)
and both MAX guards (1,331,558 / 1,295,967). The MAX guard is the important one:
validation is linear in identifier bytes, so a slower validator shows there
first. A regression of only the encoder (≈ +24k NORMAL, +55k MAX) is inside the
headroom by design; the byte-level encoding tests catch any change to what it
produces.

## 18. Not done, by instruction

- **Registered mandates** (`registerMandate`, persistent authority, standing
  mandates): not implemented. 6R.2A measured single-shot mandates 51–84% more
  expensive with registration and break-even at 4–8 attempts. Future work for
  standing or portfolio mandates.
- **Raw canonical-byte execution API:** not introduced (6R.2A: ~9–20k calldata
  only, no execution saving once validation is efficient).
- **Fixed-size internal identities:** not introduced (bounded at ≤ ~11k).
- **Deployment architecture** (lazy markets, singleton manager, clones, shards,
  shared venue or adapter): unchanged.
- **Compiler settings:** unchanged (§12).

## 19. Files changed

Production:

- `contracts/src/libraries/MandateCodec.sol` — word/SWAR identifier validation,
  word comparison, single-buffer encoder, table-free address hex, Slither
  cleanups. `MandateExecutionGate.sol`, `GateArithmetic.sol`, `MandateTypes.sol`,
  the fixture contracts and interfaces: unchanged.

Test references (never deployed):

- `contracts/test/reference/ReferenceMandateCodec.sol` — new: the pre-optimization codec, verbatim
- `contracts/test/reference/WordIdentifier.sol` — new: the step-1 plain word implementation
- `contracts/test/reference/ReferenceMandateExecutionGate.sol` — new: the pre-optimization gate, verbatim

Tests and harnesses:

- `contracts/test/IdentifierEquivalence.t.sol`, `contracts/test/utils/IdentifierHarness.sol` — new
- `contracts/test/EncodingEquivalence.t.sol`, `contracts/test/utils/EncodingHarness.sol` — new
- `contracts/test/GateEquivalence.t.sol` — new
- `contracts/test/CalldataPadding.t.sol` — new
- `contracts/test/Differential.t.sol` — split into `CorpusWorld` + `DifferentialTest`; byte-level encoding comparison
- `contracts/test/GasProfiles.t.sol` — regression ceilings

Documentation:

- `docs/phase-6r2b-report.md` — this report
- `docs/execution-gate.md` — §10 suite rows, §13 current gas and superseded figures, §14 Slither S-13–S-15
- `docs/roadmap.md`, `README.md`, `AGENTS.md` — phase status

Scratch only, not committed: the pristine baseline and per-step trees, the
compiler-matrix copy, the mutation runner and its mutants, the stage-cost harness.

## 20. Local commits

| hash | subject | purpose |
| --- | --- | --- |
| `0aa496d` | perf: validate canonical identifiers by word | step 1; preserves the pre-optimization codec as the test reference |
| `56a6999` | test: prove word validator equivalence | permanent differential suite, dirty-tail regression, seeded campaign |
| `2b0054e` | perf: optimize identifier validation and ordering | SWAR validator and word comparator; step-1 code kept as `WordIdentifier` |
| `d8bb898` | perf: encode canonical values in one buffer | single-buffer encoder, table-free address hex |
| `1b29368` | test: prove canonical encoding equivalence | byte-level encoder comparison, corpus and fuzz |
| `9780735` | test: differential against the pre-optimization gate | reference gate, direct before/after comparison, mutation campaign |
| `b92e2da` | test: fuzz assembly identifier processing at the entry point | dirty ABI padding at `execute` |
| `e2b1f3b` | test: add optimized gate gas regression guards | ceilings on every canonical profile |
| `e74b8a0` | refactor: resolve Slither findings in the optimized codec | literals rewritten, justified `assembly` suppressions |
| this commit | docs: report phase 6r2b optimization | this report and status |

(The §10 suite rows for `GateEquivalence.t.sol` and `CalldataPadding.t.sol`
landed together in `9780735`, one commit before the padding suite itself.)

## 21. Residual risks

- **Assembly audit surface.** Nine small assembly blocks now sit on the
  authorization path (identifier validation, ordering, canonical encoding).
  They are differentially tested against two independent implementations and
  mutation-tested, but they need the independent review this phase ends with.
- **Rogue-attempt orchestration assumption** (unchanged,
  [6R.1b report](phase-6r1b-report.md)): reconciliation guarantees hold only if
  agents create execution authorizations through `admitAttemptUnderReservation`.
  Against an attempt signed outside it, double settlement and a premature
  `MANDATE_EXPIRED` remain impossible, but temporary kernel/chain divergence
  (FAILED followed by that attempt's settlement) remains possible.
- **Two encoder implementations** (execution-gate.md §16, item 9) — now three
  Solidity ones in the repository counting the test references; the kernel and
  the production codec are still tied only by the shared corpus, which the
  byte-level comparisons in this phase extend but do not replace.
- **Deployment provenance** still pending its final release gate
  (execution-gate.md §13): compiler settings are now final for this phase, so the
  gate can be built against them.
- **`REAL_MARKET` freshness gap** (unchanged): real markets are refused until an
  authenticated inclusion-time state source exists.
- **Target-chain limits not yet verified:** transaction and block gas limits,
  calldata limits and ArbOS/Cancun support of the target chain remain
  deployment-time checks; Arbitrum's L1 data charge is not modelled here.
- The gas ceilings deliberately tolerate a pure encoder regression (§17).

## 22. Git state

- working tree clean after the report commit
- nothing pushed; nothing merged; no pull request
- nothing published; nothing tagged
- nothing deployed; no transaction sent
- no RPC contacted; the only network access was the read-only `npm audit`
  registry query
- remotes unchanged

**Stop.** Phase 6R.2B ends here. Agent Marketplace, SettlementVault, Phase 7,
deployment and real venue integration are not started; the optimized gate first
needs independent security and gas review before Phase 6 is frozen.
