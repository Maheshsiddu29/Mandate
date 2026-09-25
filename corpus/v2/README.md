# Decision-vector corpus, v2

A cross-implementation compatibility contract for the Mandate verifier.

> **Status: Phase 5R.** Generated from `@mandate/kernel`. `vectors.json` is
> committed and the kernel's `corpus.test.ts` fails if it drifts from what the
> generator produces.
>
> **This corpus replaces `corpus/v1`.** MCE schema v2
> ([ADR 0014](../../docs/adr/0014-symmetric-signed-economic-authorization.md))
> added the signed economic limit, the candidate fee total and the content-
> addressed state binding, and moved the object domain tags to `.V2`. A v2
> kernel rejects a v1 mandate with `UNSUPPORTED_MANDATE_VERSION` by design, so
> it cannot replay v1 vectors and keeping them under a `v1` directory alongside
> v2 content would have been misleading. The directory was renamed and
> regenerated; no v1 vector was silently reinterpreted.

## What this is for

The same authorization decision will eventually exist in more than one place —
the off-chain verifier, the on-chain execution gate, and any SDK that
re-implements it. Divergence between two implementations of a safety gate is a
vulnerability, not a bug
([design §10.5](../../docs/mandate-design.md#105-differential-verification)).

This corpus is how they are kept in step. **Any implementation claiming to
verify Mandate v2 must reproduce every field of `expected` for every vector.**

## Format

```jsonc
{
  "corpusVersion": 2,
  "verifierVersion": "mandate-kernel/2",
  "encoding": "MCE v2, keccak-256",
  "vectorCount": 67,
  "vectors": [
    {
      "id": "synthetic-001",
      "family": "synthetic-violation",
      "description": "Synthetic exposure offered against a mandate that forbids it.",
      "input": {
        "mandate": { ... },
        "authorization": { ... },
        "candidate": { ... },
        "trustedState": { ... },
        "clock": { "nowUnixSeconds": "1800000000" },
        "expectedDomain": { ... }
      },
      "expected": {
        "decision": "REJECT",
        "reasonCodes": ["SYNTHETIC_NOT_ALLOWED"],
        "mandateDigest": "0x…",
        "candidateDigest": "0x…",
        "trustedStateDigest": "0x…",
        "receiptDigest": "0x…"
      }
    }
  ]
}
```

### Rules

- **Integers are decimal strings.** JSON has no integer type wide enough for a
  `uint256`, and using a JSON number would reintroduce IEEE-754 into the one
  place ADR 0002 exists to keep it out of. Every kernel parser accepts a decimal
  string and a native big integer, and nothing else — a JSON number is
  deliberately refused.
- **`reasonCodes` is sorted** and deduplicated. A `PASS` has an empty array.
- **Digests are null** when the corresponding input did not parse and therefore
  has no canonical encoding.
- **Object keys are sorted** throughout, so the file has a stable diff.
- **Vectors are self-contained.** Each `input` is a complete verification
  request. Nothing is inherited from another vector or from a fixture file.

### Reproducing `expected`

1. Parse each `input` member with your implementation's strict parsers.
2. Compute `mandateDigest` as `keccak256(MCE(mandate))` per ADR 0002.
3. Run verification with `clock` as the evaluation instant and `expectedDomain`
   as the accepted EIP-712 domain.
4. Compare decision, sorted reason codes and all four digests.

A mismatch in `receiptDigest` alone, with matching decision and reason codes,
means the receipt encoding differs — usually violation `detail` keys or their
ordering. That still counts as a failure: the receipt digest is what an audit
record is anchored to.

## Families

27 families, 67 vectors, covering the twenty required cases, the pairs that
distinguish codes which are easy to conflate, and the four families Phase 5R
added when it corrected the economic, chain and state-binding findings.

| Family | Vectors | What it pins |
| --- | --- | --- |
| `valid` | 3 | The permitted path, including explicitly-allowed synthetic exposure and an explicitly-allowed halt |
| `wrong-canonical-asset` | 2 | Candidate names another asset; representation is issued against another underlying |
| `wrong-representation` | 2 | Unregistered representation; candidate misdescribing the one it names |
| `issuer-violation` | 1 | Issuer outside the allowlist |
| `chain-violation` | 1 | Chain outside the allowlist |
| `venue-violation` | 1 | Venue outside the allowlist |
| `synthetic-violation` | 2 | Forbidden synthetic; unknown synthetic status |
| `notional-overrun` | 2 | Ten-times error; one atom over |
| `notional-boundary` | 1 | Exactly at the maximum |
| `notional-inconsistent` | 1 | Quantity × price disagrees with declared notional, while still inside the limit |
| `price-deviation-boundary` | 2 | Exactly 40 bps; one atom beyond |
| `stale-price` | 2 | One second past the bound; an observation from the future |
| `trading-halt` | 2 | Halted with a forbidding mandate; unknown halt status |
| `inactive-representation` | 2 | Paused; deprecated |
| `corporate-action-changed` | 5 | Epoch ahead, behind, unknown, stale, and a candidate built against another epoch |
| `expired-mandate` | 2 | Exactly at expiry (rejects); one second before (passes) |
| `not-yet-active-mandate` | 2 | One second before not-before; exactly at it |
| `invalid-signature` | 5 | Forged signer; honest wrong party; foreign domain; unsupported scheme; wrong agent |
| `replay` | 5 | Consumed; reserved; unknown; a record about another mandate; quarantined after a lapsed reservation |
| `unit-mismatch` | 3 | Wrong currency; wrong price denominator; a different but explicit decimal scale that passes |
| `malformed-identifier` | 5 | Bad charset; trailing separator; unknown version; structurally wrong state; negative quantity |
| `untrusted-state` | 3 | Advisory provenance; untrusted provenance; absent |
| `maximum-size-values` | 3 | `uint64` and `uint16` maxima; 38 decimal places; one past the `uint256` maximum |
| `multiple-violations` | 1 | Four independent violations reported together |
| `economic-limit` | 6 | BUY at and one atom past the signed maximum total debit; SELL at and one atom below the signed minimum total credit; fees equal to the notional; a fee in the wrong currency |
| `representation-chain` | 2 | A contract on a forbidden chain carrying an allowed chain field; a candidate disagreeing with the chain inside its own identifier |
| `state-binding` | 1 | A candidate committing to a state digest that is not the digest of the state supplied |

## Extending it

Add a spec to `SPECS` in `packages/kernel/test/support/generate-corpus.ts` and
run `npm run corpus:generate`. Vector ids are permanent: a vector may be added,
and may be removed with a note, but an id is never reassigned to a different
case.

Because vectors are self-contained verification requests, a Phase 2+ synthetic
execution world generator emits more of this same shape with no change to the
kernel and no separate simulation verifier
([design §19](../../docs/mandate-design.md#19-stablecoin-funding-as-a-supporting-layer)
is unrelated; the relevant commitment is that live execution and replay share
one verifier).

## What this corpus does not cover

- Anything needing network or chain access. The kernel has none.
- Routing, ranking or candidate discovery. Those are Phase 4.
- The on-chain gate's own checks. Phase 6 adds gate vectors alongside these.
- Performance. These are correctness vectors only.
