# Phase 6R completion report

**Verdict: READY FOR INDEPENDENT PHASE 6R REVIEW.** This is not a deployment
approval. Phase 7 has not begun. The only executable market class remains a
labelled, fixed-price settlement fixture.

## 1. Original High finding and remediation

The Phase 6 gate authenticated the authorized agent but did not independently
enforce signed `maxNotional` or the candidate's declared economic arithmetic.
A malicious holder of the legitimate agent key could sign a kernel-rejected
Candidate V3 and, in some cases, settle it. Authentication had been mistaken for
authorization.

Phase 6R adds an independent Solidity authority layer:

- candidate price must equal the immutable typed fixture price by exact scaled
  comparison;
- quantity × price must bracket declared notional using the kernel's exact
  floor/ceil rule;
- declared notional must not exceed principal-signed `maxNotional`;
- BUY notional + fees and SELL notional − fees must satisfy the separately
  signed economic limit;
- measured BUY credit and SELL debit must equal Candidate V3 quantity exactly;
  and
- measured BUY debit / SELL credit must satisfy the side-specific signed bound.

The [principal-authority matrix](phase-6r-principal-authority.md) is the complete
field-by-field statement of what is and is not enforced.

## 2. Signature and commitment analysis

Principal and agent still sign different EIP-712 structs under the same domain
`{name: Mandate, version: 1, chainId, verifyingContract}`. Tests reconfirm both
directions of role substitution fail, the wrong agent fails, an old execution
authorization fails against a new mandate, same-address principal/agent still
requires two typed signatures, cross-gate and cross-chain replay fail, and
high-s/non-65-byte signatures fail. EOAs are the only supported signer kind;
ERC-1271 is not implied.

The agent commitment still covers both digests, recipient, funding limit,
deadline and route-data hash. Trailing ABI bytes are accepted only as a
semantically equivalent representation of the same decoded arguments; malformed
offsets, truncated lengths, route mutation, candidate mutation and version
mutation cannot preserve a successful materially different action.

## 3. Immutable market table and dependency policy

The table remains constructor-only and keyed by a representation identifier
derived from the representation token address. It pins representation, funding
token, adapter, canonical asset, issuer, venue, units, decimals, synthetic
status, market classification and typed fixture price. Construction rejects an
empty or oversized table, zero/code-less dependencies, same input/output token,
duplicate representation and malformed/inconsistent price/unit configuration.

Immutable addresses do not imply immutable behavior. Fixture deployment policy
therefore prohibits upgradeable tokens, adapters and venue targets. A future
deployment review must record chain, address, runtime codehash, proxy status,
implementation and implementation codehash. Phase 6R does not add a weak
constructor-time codehash check that a proxy could bypass.

## 4. Nonce, replay, relay and reorg result

The mandate digest remains the replay key. Consume-before-call plus EVM rollback
means a successful canonical transaction consumes once and every revert consumes
nothing. A copied permissionless-relay transaction may settle first, but it has
the identical signed recipient and economics; the intended relayer's later copy
reverts safely. A state-snapshot test models a reorg: removal of the block removes
both settlement and consumption, after which the authorization may settle once
on the canonical chain.

Reconciliation must wait for configured safe/finalized evidence. A caller string
`FINALIZED` is not proof: the chain reader is trusted to establish chain/gate,
transaction and log identity, canonical block status, mandate digest, execution
commitment and actual amounts before the pure evidence parser runs.

## 5. Settlement-delta and adapter result

BUY requires exact representation credit and bounded funding debit. SELL requires
exact representation debit and minimum funding credit. Underfill and overfill
both revert under ADR 0011 FILL_OR_KILL. An unsolicited balance change can cause
denial of service under strict equality but cannot create an unauthorized
successful quantity.

The gate ignores adapter return values. Tests cover fake favourable return data,
64 KiB return/revert data, under-delivery, redirection, over-pull through a stray
allowance, partial input consumption, post-transfer revert, gas burn and re-entry.
Reverts roll back balances and replay consumption. Balance deltas prove the
principal's observed economic outcome, not venue provenance; directly minted
scripted-adapter inventory can satisfy a delta and is documented as such.

## 6. ERC-20, approvals and residual funds

Standard boolean and empty-return tokens are supported. Malformed return data and
fee-on-transfer output fail closed. Fee-on-transfer input remains debit-bounded
but needs explicit deployment review. Callback re-entry is blocked. Rebasing,
lying-balance, in-call mint/burn and upgradeable tokens are deployment-prohibited.

The gate never grants an allowance. The fixture adapter grants an exact venue
allowance and resets it to zero. Success, ordinary revert and a deliberately
failed reset are tested; the latter reverts every transfer and consumption
atomically. The supported path retains no execution-derived funds. Direct token
donations to the gate are unrelated balances and are neither impossible nor
swept.

## 7. Executable profile and target compatibility

The gate profile is 16 issuers, 16 chains, 16 venues, 4,096 route bytes and 32
constructor markets. Solidity checks it independently and the TypeScript package
exports a pre-signing `validateExecutionProfile` check. Below/exact/above
boundaries are tested.

> **Superseded in Phase 6R.1.** The figures below were understated (short
> identifiers, all-zero route data, signing inside the gas window). The
> reproduced worst case is 18,596 bytes, 250,508 intrinsic calldata gas and
> 6,646,656 execution gas; see [execution-gate.md §13](execution-gate.md#13-deployment-policy)
>.

Worst-case encoded `execute` calldata is **17,156 bytes** and its intrinsic
calldata gas is **172,784**. A local exact-profile settlement measured
**1,673,113 execution gas**. Offchain Labs' Nitro configuration documents a
default `execution.sequencer.max-tx-data-size` of 95,000 bytes, leaving more than
80% calldata headroom. Robinhood documents testnet chain ID 46630, Arbitrum
Nitro, and currently ArbOS 61. The build uses Cancun/MCOPY; current compatibility
is supported by those facts, but ArbOS/version confirmation remains mandatory
at any future deployment review.

## 8. Dynamic-state inclusion gap

The unresolved window is real: reference price movement, halt activation,
operational-state change, corporate-action epoch change, multiplier change or
registry change after handoff but before inclusion can invalidate a real-market
decision. The agent deadline and mandate expiry bound time but do not authenticate
state.

Disposition:

- **Fixture path:** acceptable and not High. The path is explicitly engineered,
  fixed-price and labelled; its price is immutable and checked. It claims no
  live halt, corporate-action, multiplier or registry freshness guarantee.
- **Any real-market path:** **High / release-blocking.** Construction rejects
  `REAL_MARKET` with `RealMarketStateSourceRequired`. A future path needs an
  onchain authoritative source or attestation binding gate, chain,
  representation, registry snapshot, halt and operational status, epoch,
  multiplier, reference price, observation time and expiry, checked fresh at
  inclusion.

No fake oracle or signer was introduced.

## 9. Differential, fuzz, invariant and static-analysis evidence

The differential corpus has separate encoding and authority layers. Encoding
continues to compare MCE v2, Candidate V3 and execution commitments. Authority
vectors are selected only after the actual TypeScript kernel returns REJECT,
then receive valid principal and correct-agent signatures and are submitted to
Solidity. The corpus records the kernel reason codes and gate responsibility.

The final generated corpus contains **233 vectors / 240 attempts**: **65
settlements**, **175 reverts**, **139 mandate encodings**, **188 candidate
encodings**, and **16 actual-kernel malicious-agent rejections**. Every one of
those 16 mutations is first rejected by the real TypeScript kernel, then signed
by the correct agent and rejected by Solidity.

Foundry ran **153/153 tests** across seven suites: 74 gate unit/profile tests, 32
adversarial settlement tests, 15 fuzz properties at 1,024 runs each, 13
invariant/non-vacuity tests, 12 codec tests, four differential tests and three
deployment-script refusal tests. Each of the 12 stateful invariants ran 256
sequences × 64 calls (16,384 calls); the handler distribution included all five
actions (`execute`, `executeMalicious`, `executeTampered`, `executeUnsupported`,
`replayLast`) with no discards. The deterministic non-vacuity test settled all
24 honest pool authorizations on BUY and SELL before exercising every hostile
action.

Fresh Slither initially surfaced three new arithmetic-library diagnostics. Two
zero-initialized memory structs are now explicit; the intentionally unused low
limb of a 512-bit product is narrowly suppressed because the high limb alone is
the overflow criterion and the following `mulDiv`/`mulmod` consume the full
product. The final normal run analyzed **20 contracts with 101 detectors and 0
results**. `--show-ignored-findings` exposed **11 reviewed results**: one
authority-scoped `transferFrom`, two intentional balance-delta/reentrancy
reports, four intentionally ignored return components or fixture return values,
two bounded constructor metadata calls, one deliberate timestamp authorization,
and one flat binding predicate's complexity. None is an unresolved finding.

## 10. Versions, CI and reproducibility

- Foundry 1.7.1; solc 0.8.37; EVM target Cancun; optimizer 200; via-IR; bytecode
  metadata hash disabled; fixed fuzz seed.
- Slither 0.11.6.
- OpenZeppelin Contracts 5.6.1; TypeScript 5.9.3; Node ≥22.18.0;
  `@noble/curves` and `@noble/hashes` 2.4.0.
- forge-std submodule commit
  `bf647bd6046f2f7da30d0c2bf435e5c76a780c1b` (reported tag v1.16.2).
- `package-lock.json`, exact npm specs, `foundry.toml` and the submodule commit
  pin the build inputs.

The final build reports a **13,287-byte runtime** (11,289-byte EIP-170 margin)
and **17,201-byte initcode** (31,951-byte EIP-3860 margin) for
`MandateExecutionGate`.

CI already runs TypeScript checks, generated-artifact checks, the repository
security audit, formatting, build, lint, unit/fuzz/differential tests, invariants
and Slither. It contains no deployment step; no CI workflow expansion was
required.

## 11. Remaining risk and deferral

No Critical or High issue remains in the fixture-supported path. Remaining risks
are denial of service from hostile dependencies or unsolicited balance changes,
the declared funding-token/unit assumption, sequencer timestamp bounds, trusted
chain-reader correctness, reorgs before finality, and the fact that balance
deltas do not prove venue provenance. Principal-key compromise and allowances
granted directly to third parties remain outside the gate.

Deferred to a separately reviewed real-market integration: authenticated
inclusion-time state, a real venue and liquidity evidence, proxy/codehash policy
for any intentionally upgradeable dependency, real funding/conversion, ERC-1271,
and any deployment. Phase 7 was not started.

## 12. Validation handoff

The final local validation set passed:

- `npm run check`: 723/723 TypeScript tests, recorded fixture and replay
  validation, cross-surface checks, credential scan and repository-junk check;
- `npm run generated:check`: committed MCE, registry and gate corpora and reason
  code documents match their generators;
- `npm run audit:security`: registry-backed audit, 0 vulnerabilities;
- `npm run contracts:fmt`, `contracts:build`, `contracts:lint`: pass;
- `npm run contracts:test`: 153/153 tests pass with the fuzz, invariant and
  differential counts above; and
- `npm run contracts:slither`: 0 unsuppressed results, with all 11 suppressions
  independently exposed and dispositioned above and in
  [execution-gate.md](execution-gate.md#14-slither-findings).

Foundry emitted a non-test-affecting warning that the sandbox could not write
its global signature-name cache under `~/.foundry`; compilation and every test
completed successfully. No deployment, transaction, push, merge, pull request,
tag, release or remote mutation was performed.
