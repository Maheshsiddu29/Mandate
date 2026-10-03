# Real V2 browser execution spine

Status: specified, then implemented on the existing V2 path. This milestone
stops at **READY · NOT SENT**. It does not broadcast, deploy, or change the
frozen gate.

Room V2 allocation semantics are unchanged. This document records the path
that already existed at `bf7893f` and the one gap this milestone closes:
the browser was still willing to post a send after a successful dry run.

## What already existed

The Live Lab (`npm run agents:lab`) and `npm run agents:settle:v2` share
`settleSpine` (`packages/live-settlement/src/spine-settlement.ts`).

```text
prompt
  → allocation intent (FIXED / DYNAMIC / HYBRID / NEEDS_AGENT_SELECTION)
  → Planning Room or a fixed split
  → accepted initial allocation
  → initialAllocationDigest
  → wallet EIP-712 PortfolioMandateAuthorizationV2
  → session authorization (WALLET_PRINCIPAL_V2_PLAN)
  → discovery: discovered → actionable → executable
  → Stock model, closed-set candidate id
  → trusted buildProposal → screenProposal → runPortfolio
  → durable reservation
  → reverifySpine (no demonstration-key fallback)
  → fixture mapping of that exact reservation
  → Gate MandateAuthorization, a second EIP-712
  → read-only preflight → eth_call / estimateGas
  → SPINE_DRY_RUN_READY
```

V1 (`PORTFOLIO_MANDATE_SIGNATURE.V1`, the demonstration
`LocalPrincipalSigner`, B.5.2 and B.5.3) is a different method.
`reverifySpine` refuses it with `SPINE_METHOD_REQUIRED`. There is no
fallback from a missing or invalid V2 signature onto that key.

## Two signatures

**Portfolio.** The wallet signs `PortfolioMandateAuthorizationV2` (name
Mandate, version 2, chain 46630, no verifying contract). The message binds
the mandate digest, the wallet as `mandate.principal`, the session digest,
and `initialAllocationDigest`. That signature is not a transaction and is
not a gate authorization.

**Gate.** The same wallet signs `MandateAuthorization(bytes32 mandateDigest)`
under the deployed gate's domain (name Mandate, version 1, chain 46630,
`verifyingContract` = that gate). The digest is derived on the server from
the verified child, the durable reservation, the reviewed fixture mapping,
and the deployment manifest. The browser cannot supply a token, venue,
adapter, recipient, calldata, or amount.

The portfolio signature is never reused as the gate signature. A gate
signature that recovers to any other address is
`GATE_EXECUTION_SIGNER_MISMATCH`.

## Candidate continuity

The selected candidate must be the same object at every stage:

```text
MODEL_SELECTED_CANDIDATE
  == TRUSTED_BUILT_CANDIDATE
  == SCREENED_CANDIDATE
  == VERIFIED_CANDIDATE
  == RESERVED_CANDIDATE
  == ADMITTED_CANDIDATE
  == GATE_EXECUTION_CANDIDATE
  == DRY_RUN_CANDIDATE
```

The model returns a candidate id. The server resolves it by exact lookup
into the candidates it offered. `selectStockExecution` reads the reserved
object. `mapToFixture` accepts that object only when `stockFixtureFor`
matches both the candidate id and the representation. A mismatch is
`FIXTURE_UNDEFINED_FOR_CANDIDATE`. Nothing substitutes another note.

Both reviewed Stock candidates are executable on the current Live Lab
profile (`ROBINHOOD_TESTNET_STOCK_FIXTURES`):

| Candidate | Representation | Fixture |
| --- | --- | --- |
| `nvda-note-a` | approved note | quantity-preserving MDUSD → MDEMO |
| `nvda-note-c` | series C | the same fixture market, a different binding digest |

The chain sees MDEMO and MDUSD either way. The binding digest, committed
into the gate action nonce, is what says which note was reserved. The chain
transaction is a Robinhood Chain testnet fixture. It is not an NVDA trade,
not a Robinhood Stock Token, and not customer capital.

Capability is not authority. The profile says whether this connector can
prepare the candidate. Mandate says whether the principal authorized it.
Both must hold before the page offers a dry run. An authorized candidate
the connector does not define fails closed. It is not replaced.

## Principal and recipient

`wallet address == mandate.principal == protocol signer`. Domain delegation
is `SAME_PRINCIPAL`.

When that wallet is not the gitignored manifest principal, the gate
recipient is the wallet, and preflight reads that wallet's MDUSD balance
and allowance. The manifest principal does not receive the proceeds and its
key is not loaded to sign the gate mandate. When the wallet is the manifest
principal, the same address is the recipient; the local custody key may
sign only because it is that address.

The gate debits the signer. The deployer key pays gas on a future broadcast.
This milestone does not broadcast, so that key is not asked to send.

## Settlement state

The journal (`PREPARED` through `CONSUMED` / `RELEASED`) is the durable
attempt record. It does not store a raw signed transaction. A dry run
journals the attempt and the gate artifact (mandate digest, commitment,
deadline) and stops. `ADMIT_ATTEMPT` is once per reservation, so a restart
cannot open a second attempt.

The browser reads `MANDATE_LIVE_AI.V1`. `SPINE_DRY_RUN_READY` is
**READY · NOT SENT**. The event carries the candidate id, proposal, child,
reservation, gate mandate digest, wallet principal, chain, gate, gas
estimate, simulation deadline, allocation lineage, evidence class `DRY_RUN`,
and `broadcast: false`. It does not carry a signature or a signed
transaction.

After the simulation deadline, the page marks that result stale and offers
another dry run. It does not present the expired simulation as current.
Another dry run re-verifies; it does not re-run the model or the Room and
does not create a reservation.

## Browser

The page talks only to the loopback Live Lab. It signs two EIP-712 payloads
through the injected wallet (`eth_signTypedData_v4` only):

1. **Authorize Mandate** — the plan-bound portfolio signature.
2. **Sign execution authorization** — the gate signature, and only after
   the wallet is on chain 46630. A wrong or rejected chain stops. Nothing
   is signed for another chain.

Dry-run posts `{ "mode": "DRY_RUN" }`. This milestone's page does not post
`SEND`, does not collect the operator phrase, and does not show a send
button. `npm run agents:settle:v2 -- --send` and the server send route stay
in the repository for a later, explicit broadcast decision. They are not
reachable from this page.

## Preflight and dry run

Preflight is read-only: chain id, gate code, fixture mapping, wallet MDUSD
balance, gate allowance, deadline, and replay state the deployment exposes.
It does not fund, approve, or submit.

The dry run builds the same `MandateExecutionGate.execute` transaction a
later send would build, then `eth_call` and `estimateGas`. It does not
consume the reservation. A revert (signature, recipient, amount, candidate,
replay, balance, allowance, deadline, wrong gate, wrong chain) is a
refusal, not a settlement.

## What this milestone does not do

- No transaction broadcast, on testnet or mainnet.
- No new contracts, no new deployment, no gate change.
- No Swap, Yield, NFT, or Perps settlement.
- No Room V2 redesign.
- No Jev expansion.
- No wallet funding and no approval transaction.
- No use of the demonstration principal as a V2 signer.
- No persistence of a raw signed transaction.
- No claim that MDEMO/MDUSD is an NVDA trade.

A later milestone can decide whether one testnet broadcast is worth doing.
Until then the honest end state is READY · NOT SENT.
