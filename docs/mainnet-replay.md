# Mainnet replay methodology

Phase 3's replay corpus is a deterministic compatibility artifact built from the
recorded Robinhood mainnet capture described in
[Robinhood integration findings](robinhood-integration.md). It is not a trading
simulation and it does not assert that synthetic mutations occurred on mainnet.

## Decision path

Every vector uses the production decision path:

```
recorded HTTP/RPC response
  -> strict Robinhood adapter
  -> RegistrySnapshot (OBSERVED unless explicitly synthetic)
  -> registry admissibility + registry-to-kernel bridge
  -> unchanged Phase 1 kernel verifier
  -> receipt
```

There is no replay-specific verifier. Each vector carries its canonical mapping,
registry snapshot, market and corporate-action state, evaluation clock,
candidate, mandate, authorization, expected registry result, snapshot digest,
and expected kernel receipt. Re-running a vector must reproduce both digests and
the receipt exactly.

## Recorded and synthetic cases

The six unmodified AAPL, NVDA, TSLA, QQQ, CRWD, and MSFT snapshots pass. Five
failure cases establish the safety seams:

- an AAPL quote evaluated beyond `generatedAt + maxPriceAgeSeconds`;
- a clearly labelled synthetic NVDA trading halt;
- a clearly labelled synthetic inactive TSLA representation;
- a CRWD mandate authorized at epoch zero and evaluated after the captured
  multiplier event advanced its epoch;
- an adversarial same-symbol NVDA contract absent from the registry.

Synthetic and adversarial vectors carry
`RECORDED_MAINNET_WITH_SYNTHETIC_MUTATION`. The `dataClass` field remains outside
both decision engines, so the label cannot select a different decision path.

## Generated artifacts

- `corpus/mainnet-v1/vectors.json` is the self-contained replay corpus.
- `corpus/mainnet-v1/report.json` is the machine-readable validation summary.
- `npm run mainnet-replay:generate` deliberately rewrites both from the pinned
  capture and implementation.
- `npm run mainnet-replay:validate` fails when either committed artifact drifts
  or a registry/verifier result differs.

The initial report contains 195 captured assets, seven curated canonical
mappings, six onchain-verified representations, six market snapshots, 52
corporate-action rows, and 11 verification runs. The expected outcome is six
passes and five rejections, one each for stale price, trading halt, inactive
representation, changed corporate-action state, and unknown representation.

## Phase 4 candidate-set extension

`corpus/mainnet-routing-v1` extends the six passing recorded snapshots into
candidate-set worlds. Each preserves the real representation, price,
multiplier, contract and corporate-action epoch while clearly labelling route
fees and alternate venue choices as synthetic. The ordinary router excludes a
cheaper issuer-substitution proposal, ranks two valid routes and invokes the
unchanged kernel again before producing its receipt.

## Limits

The capture is a point-in-time observation, not continuing proof of issuer or
market state. Five captured oracle rounds were too far in source time from their
REST quotes for price equality; the report counts them as time-incomparable.
CRWD had no feed in the captured official catalog. These are recorded as limits,
not converted into matches. Live checks remain opt-in and cannot make offline CI
pass or fail.
