# C1 — browser-complete live testnet settlement

Status: specified before the browser send is wired. The settlement engine is
the existing `settleSpine`. This milestone does not add a second one, and it
does not change the gate, the verifier, or replay rules.

## 1. Current browser flow

`/demo/live` talks only to the loopback Live Lab. A wallet signs
`PortfolioMandateAuthorizationV2` (plan, session, `initialAllocationDigest`).
Agents run. A reserved Stock child can ask for a dry run. That dry run posts
`{ "mode": "DRY_RUN" }`, may collect one `MandateAuthorization`, simulates,
and stops at READY · NOT SENT. The page does not post `SEND`.

## 2. Settlement API

`GET /api/live/settlement` and `POST /api/live/sessions/:id/settle` live in
`packages/live-settlement/src/ui-settle.ts`. `npm run agents:serve` does not
mount them. `npm run agents:lab` does. The body today is `mode`
(`DRY_RUN` or `SEND`), an optional gate signature, the CLI operator phrase,
and `cancel`. Unknown fields are currently ignored. C1 will refuse them.

The browser still must not send a token, venue, adapter, recipient, amount,
calldata, candidate, gate address, or chain id. Those stay on the server:
accepted plan, verified proposal, reservation, trusted candidate, fixture
map, deployment manifest, and `reverifySpine`.

## 3. READY · NOT SENT

`SPINE_DRY_RUN_READY` is a dry run. It is not a send. C1 keeps that event
for a dry run. The judge path does not dry-run and then send, because that
asks for two gate signatures.

## 4. settleSpine

```text
reconcile journal
  → one reserved Stock child
  → reverifySpine (no demonstration-key fallback)
  → mapToFixture of that exact child
  → eligibility, including the binding digest
  → journal PREPARED, one ADMIT_ATTEMPT
  → read-only preflight
  → describeGateExecution, if the wallet is not the manifest principal
  → wallet MandateAuthorization, or the manifest key when it is that wallet
  → GateSigner.issueAuthorizedBuy
       simulate: eth_call, then eth_estimateGas, on this exact calldata
       DRY_RUN: halt, nothing broadcast
       SEND: submit that same calldata, once, if SendGate is open
  → receipt, postconditions, consume reservation
```

`SettlementGateChain.submit` refuses unless the calldata is the calldata just
simulated. A second `submit` finds the gate consumed.

## 5. Signature lifecycle

Two wallet signatures on the happy path, not three.

1. Portfolio. `PortfolioMandateAuthorizationV2`. Not a transaction. Not a
   gate signature.
2. Gate. One `MandateAuthorization(bytes32 mandateDigest)` for the artifact
   this send derives. Domain: Mandate, version 1, chain 46630, verifying
   contract = the deployed gate. The browser displays the server's typed
   data and returns the signature. It does not compute the digest.

The CLI `--send` dry-runs first, on a scratch domain ledger, then sends on
the durable domain ledger. Those two runs can differ by slot, so the CLI
asks for a second gate signature. That is why the CLI is safe, and why the
browser must not copy that two-call shape.

The browser execute is one `settleSpine` call in `SEND` mode. The signature,
the `eth_call`, the gas estimate, and the broadcast are that same artifact.
The 90-second execution deadline is not inside the principal digest; the
agent signs it. Rebuilding the same domain record, slot, and principal
yields the same mandate digest. A new run after a consumed reservation does
not rebuild one: reconciliation returns the existing attempt.

## 6. Why the CLI send is safe

`--send` still requires `AUTHORIZE ROBINHOOD TESTNET SEND`, still re-verifies,
still refuses a stub provider on the live RPC, still broadcasts at most once,
and still asks for a fresh gate signature because it builds a second digest.
C1 does not remove that command.

## 7. How the browser reuses it

The button posts `{ "mode": "SEND", "intent": "EXECUTE_ROBINHOOD_TESTNET" }`.
That exact intent opens the existing `SendGate` for one broadcast. The CLI
phrase still opens it for the CLI. Neither path lets the body name an
asset or an amount. The same `settleSpine` then asks for the gate signature,
simulates, and broadcasts that call. A rejected signature cancels the parked
run. Nothing is sent.

There is no broadcast on load, restore, model output, or reservation.

## 8. State machine

Existing events, shown in product language:

| Event | Page |
| --- | --- |
| preflight | Checking mandate… |
| `GATE_EXECUTION_SIGNATURE_REQUIRED` | Waiting for wallet signature… |
| simulation | Simulating exact execution… |
| submission | Submitting to Robinhood Chain Testnet… |
| `TESTNET_TX_SUBMITTED` | Transaction submitted. A hash is not settlement. |
| receipt pending | Confirming… |
| `DOMAIN_EXECUTION_SETTLED` with `LIVE_TESTNET` | Settled |
| ineligible / simulation failed | Nothing was sent |

## 9. Persistence

The session event log, the settlement journal, and the portfolio ledger are
already durable. A reload replays events. A settled receipt comes from those
events, not from a new model call. Restarting `agents:lab` does not rerun
the Room or the Stock model unless the user starts a run.

## 10. Replay

An attempt past `PREPARED` is reconciliation only. `CONSUMED` stays
`CONSUMED`. The page does not ask for typed data and does not show Execute.
Nothing is resent.

## 11. Trust boundary

The browser holds no key, no RPC URL, and no settlement package. It posts a
session id, an intent, and a signature. The server constructs the
transaction. The deployer key pays gas. The wallet is the principal and the
recipient when it is not the manifest principal.

## 12. Wallet prompts

1. Authorize the portfolio mandate.
2. On Execute, sign `MandateAuthorization` once.

No third prompt on this path. Wrong chain: stop, do not sign.

## 13. Failures

Expired mandate, missing signature, rejected signature, simulation revert,
consumed reservation, wrong wallet, wrong candidate, and an unread chain
all stop before broadcast. Copy stays short. The reason code sits under
details. A demo principal cannot settle (`SPINE_METHOD_REQUIRED`). There is
no fallback to `LocalPrincipalSigner`.

## 14. Candidate and fixture

The primary object stays the semantic Stock candidate (`nvda-note-a` or
`nvda-note-c`, shown as NVDA, fixture-backed note). The chain proof is
MDUSD → MDEMO, valueless, not an NVDA trade and not a Robinhood Stock Token.
The direction is not reversed. The authorized capital is the reserved USDC
amount from the session. The fixture amounts come from the settlement event.
Neither is hardcoded.

## 15. Phases

Document. Then the settle body (intent, unknown fields refused). Then the
page: one Execute action, one signature, live status, semantic receipt,
restore, replay. Tests use the injected spine. They do not broadcast.

## 16. Test plan

Eligibility and intent, unknown execution fields refused, phrase still
required when intent is absent, signature cancel sends nothing, consumed
attempt does not ask for typed data, receipt keeps the candidate id in
front of MDUSD → MDEMO, settled state hides Execute, demo method is not a
V2 send. `npm test` broadcast count stays 0.

## 17. Non-goals

No session keys, no smart-account redesign, no protocol rewrite, no new
agents, no SDK, no mainnet, no claim that MDEMO is NVDA. The human runs the
one live browser broadcast after automated checks are green. This milestone
does not broadcast it.

## Manual acceptance

Automated tests do not broadcast. After they are green, one person can run
this once. Use a wallet that already holds MDUSD and has approved the
deployed gate. Do not fund or approve from this repository's scripts unless
that is a separate, explicit choice. A stub session cannot send
(`LIVE_MODEL_REQUIRED_FOR_TESTNET_SEND`).

1. From the repository root, `npm run agents:lab`.
2. In `apps/web`, `npm run dev`, and open `http://localhost:3000/demo/live`.
3. Connect the wallet on Robinhood Chain testnet (chain 46630).
4. Compose a mandate that leaves Stock reserved, and approve it in the
   wallet (`PortfolioMandateAuthorizationV2`).
5. Run the agents with the live model. Wait until Stock is reserved.
6. Choose **Execute on Robinhood Testnet**.
7. Sign the one `MandateAuthorization` prompt. Rejecting it sends nothing.
8. The server re-verifies, runs `eth_call`, then `eth_estimateGas`, then
   broadcasts that same call once. The deployer pays gas.
9. The page shows the transaction hash while it is confirming, and
   **Settled** only after `LIVE_TESTNET`.
10. The receipt leads with the Stock candidate. MDUSD → MDEMO is the
    testnet proof, not a second trade.
11. Refresh. Restart `agents:lab`. Open the same session. The receipt is
    the same. Execute is gone. Nothing is resent.

Wallet signatures on this path: two. The portfolio mandate, then one gate
signature. The CLI `--send` command is different: it dry-runs first and
asks again.
