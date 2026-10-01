# Mandate authority spine V2

V2 makes the wallet the protocol principal of a Portfolio Mandate and carries
that signature through to Robinhood Chain **testnet** settlement, when — and
only when — that wallet is the address the deployed gate already debits.

V1 is unchanged. A caller that does not name `V2_EIP712` still uses
`mandateSignedByPrincipal` (the raw `PORTFOLIO_MANDATE_SIGNATURE.V1` prehash).
B.5.2 (`npm run agents:live:testnet`), B.5.3 (`npm run agents:settle:testnet`)
and the B.6.2 playback client stay on that path. The browser does not offer
V2; an operator asks for it on the API.

**Status.** Implemented locally. The happy path below is what the command
does. This repository run did not broadcast a transaction and did not create
keys. A reference-model test sends one transaction on the Phase 6 model and
labels the evidence `REFERENCE_MODEL`, not `LIVE_TESTNET`.

## What the wallet signs

```text
EIP712Domain(string name,string version,uint256 chainId)
  name "Mandate", version "2", chainId 46630
  — no verifyingContract

PortfolioMandateV2(string statement,bytes32 mandateDigest,address principal,bytes32 sessionDigest)
```

`mandateDigest` is `portfolioMandateDigest` (canonical `PORTFOLIO_MANDATE.V1`).
`principal` is the wallet, and it is `mandate.principal`. `sessionDigest` is
the existing `keccak256("mandate-live-session/v1:" ‖ sessionId)`. The
statement is rebuilt from the mandate (policy version, principal, limits in
atoms, agent labels, expiry) plus fixed text: this signature is the protocol
signature, it is not a transaction, and domain execution may proceed only
when the signer is this same address.

The domain has no `verifyingContract`, so this signature is not a gate
`MandateAuthorization`. The frozen gate still requires its own EIP-712, with
its own verifying contract, once per execution.

Authorization method: `WALLET_PRINCIPAL_V2`. `protocolSigner`, `principal`
and `mandate.principal` are the same address. `domainDelegation` is
`SAME_PRINCIPAL`. The stored protocol signature is the wallet signature. The
demonstration `LocalPrincipalSigner` is not called. The room and the verifier
accept the signature only when the caller passes
`{ scheme: 'V2_EIP712', chainId, sessionDigest }`. Omitting it, or passing
`V1_PREHASH`, stays on V1. There is no fallback from one scheme to the other.

## What settlement will do

`reverifySpine` runs again at settlement, from the stored mandate and
signature. It refuses, before any key is used:

| Reason | When |
| --- | --- |
| `SPINE_METHOD_REQUIRED` | the version is not `WALLET_PRINCIPAL_V2` (including the demonstration key and a B.5.3 wallet approval) |
| `SPINE_CHAIN_MISMATCH` | the deployment chain is not 46630 |
| `SPINE_SIGNER_SPLIT` | `protocolSigner` is not `principal` |
| `SPINE_DELEGATION_MISSTATED` | `domainDelegation` is not `SAME_PRINCIPAL` |
| `SPINE_MANDATE_PRINCIPAL_MISMATCH` | `mandate.principal` is not that address |
| `SPINE_SIGNATURE_INVALID` | the signature does not recover, the session digest differs, or the wallet facts are not chain 46630 |
| `SPINE_EXPIRED` | protocol time is at or past `mandate.expiresAt` |
| `CUSTODY_PRINCIPAL_MISMATCH` | the deployment principal is a different address |

A passing check still does not turn the portfolio signature into the gate
signature. Settlement may use the existing 7E.3 custody only because that
custody's address is this same wallet, which is the gitignored manifest
principal. The gate mandate is a second EIP-712, signed by that key, under
the gate's domain. Custody compares the addresses again and refuses
`SETTLEMENT.CUSTODY_PRINCIPAL_MISMATCH` before `signMandate` if they differ.
There is no override flag.

`principalBinding` reports `SAME_PRINCIPAL` only in that matched case. A
mismatch stays `TESTNET_FIXTURE_CUSTODY` / `NOT_DELEGATED`.

B.5.3 `WALLET_EIP712` versions still cannot send
(`WALLET_PRINCIPAL_NOT_DELEGATED_TO_DOMAIN`). The B.5.2 demonstration path
can still send, and only after `AUTHORIZE ROBINHOOD TESTNET SEND`. V2 does
not use that path.

## Run

The server and the session are the existing Live AI Lab. The wallet address
must be the manifest principal (the address in the gitignored 7E.3
`keys.json`, imported into a wallet). Do not paste a private key into the
API. `.robinhood-testnet/keys.json` must already exist, mode `0600`. The
script loads it with `loadKeys()` and refuses if the addresses are not the
manifest parties. `ROBINHOOD_TESTNET_RPC_URL` is optional. The URL is never
printed. There is no mainnet path.

```text
npm run agents:serve   # 127.0.0.1:8787, durable .live/
# session + draft via the existing API or UI
POST /api/live/sessions/:id/wallet/challenge
  { "address": "<manifest principal, lowercase 0x>", "spine": "V2" }
# sign the returned typedData with that wallet (cast or the wallet). Do not paste a key.
POST /api/live/sessions/:id/wallet/authorize
  { "challenge": "<id>", "signature": "<0x…>" }
POST /api/live/sessions/:id/run
npm run agents:settle:v2 -- --session <id>          # re-verify, then one dry run
npm run agents:settle:v2 -- --session <id> --send   # the phrase AUTHORIZE ROBINHOOD TESTNET SEND, then one broadcast
```

`--send` re-verifies, dry-runs, prints READY, then reads the phrase, then
sends once on the same settlement journal. It does not ask the wallet to
sign again. It does not broadcast without the phrase. A real RPC send still
requires a live model (`provider.kind === 'LIVE'`); a stub or script is
refused. The command does not emit `TESTNET_READY_FOR_SEND` (the B.6.2
client still hardcodes that event as "broadcast disabled").

Exit codes: `0` ready, reconciled only, or a confirmed `LIVE_TESTNET` send;
`1` usage or configuration; `3` the session cannot be restored; `4` not
eligible; `5` the dry run did not reach READY; `6` the phrase was refused;
`7` a transaction was submitted but is not a confirmed live-testnet
settlement.

## Remaining technical debt

- The frozen Phase 6 gate has no ERC-1271 and no session keys. A browser
  wallet that is not the funded manifest principal cannot settle. Closing
  that requires a new gate. This change does not modify the gate, MCE v2, or
  Candidate V3.
- The portfolio V2 signature is not the gate signature. Same-address custody
  still produces a fresh gate EIP-712 per execution.
- Agent proposal keys stay demonstration keys. The gate agent key stays the
  7E.3 agent key.
- The B.5.2 demonstration-principal path remains. It is not used by V2. It
  still sends only after the operator phrase.
- Exact resubmission is still absent: the raw transaction is not stored.
- The domain ledger is still per attempt and is not fully reconciled.
- The B.6.2 client still describes `TESTNET_READY_FOR_SEND` as broadcast
  disabled. V2 avoids that event. The client does not offer `spine: "V2"`;
  the API does. Labels for `WALLET_PRINCIPAL_V2` and `SAME_PRINCIPAL` are
  the only UI change.
- Session, portfolio, and settlement state are local SQLite.
- The settled leg is the MDEMO/MDUSD fixture, not an NVDA trade.
- A dry run still reveals a signed gate artifact to the RPC through
  `eth_call`, executable until its 90-second deadline. It is journaled.
