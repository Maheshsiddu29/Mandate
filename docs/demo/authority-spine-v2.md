# Mandate authority spine V2

V2 makes the wallet the protocol principal of a Portfolio Mandate and carries
that signature through to Robinhood Chain **testnet** settlement. The
portfolio signature is not the gate signature. When the wallet is the
gitignored manifest principal, that key signs the gate mandate, because it
is the same address. When it is not, the wallet signs
`MandateAuthorization` itself, once per execution, and the manifest
principal key is not used. The wallet must hold the MDUSD and have approved
the gate; the gate debits the signer.

V1 is unchanged. A caller that does not name `V2_EIP712` still uses
`mandateSignedByPrincipal` (the raw `PORTFOLIO_MANDATE_SIGNATURE.V1` prehash).
B.5.2 (`npm run agents:live:testnet`), B.5.3 (`npm run agents:settle:testnet`)
and a wallet challenge that omits `spine` stay on that path. The Live demo
Review & authorize step requests `spine: "V2"`. The demo principal key on
that same screen still uses `POST …/authorize` and is not V2.

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
signature, it is not a transaction, and each gate execution still needs a
separate signature by this same address.

The domain has no `verifyingContract`, so this signature is not a gate
`MandateAuthorization`. The frozen gate still requires its own EIP-712, with
its own verifying contract, once per execution. V2 does not turn one
portfolio signature into many gate executions.

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

A passing check still does not turn the portfolio signature into the gate
signature. Two paths follow, and only on `npm run agents:settle:v2`. The
B.5.2 and B.5.3 commands do not opt in: a wallet that is not the manifest
principal is still `CUSTODY_PRINCIPAL_MISMATCH` there, before any key is used.

**Same address.** The wallet is the gitignored manifest principal. Settlement
uses the existing 7E.3 custody, because that key is this wallet. The gate
mandate is a second EIP-712, signed by that key, under the gate's domain.
Custody compares the addresses again and refuses
`SETTLEMENT.CUSTODY_PRINCIPAL_MISMATCH` before `signMandate` if they differ.
There is no override flag. `principalBinding` reports `SAME_PRINCIPAL`.

**Different address.** The wallet signs the gate mandate. The manifest
principal key is not loaded into custody. After the domain authorization
exists, settlement prints `eth_signTypedData_v4` data:

```text
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
  name "Mandate", version "1", chainId 46630, verifyingContract = the deployed gate

MandateAuthorization(bytes32 mandateDigest)
```

`mandateDigest` is the MCE v2 digest of the gate mandate for this one
domain authorization (principal = the wallet, recipient = the wallet, agent
= the 7E.3 agent). The 90-second execution deadline is not in that digest;
the agent signs it, when the wallet signature is already in hand. A missing
line is `GATE_EXECUTION_AUTHORITY_REQUIRED` (exit 8). A malformed signature
is `GATE_EXECUTION_SIGNATURE_INVALID`. A signature that recovers to any
other address is `GATE_EXECUTION_SIGNER_MISMATCH`. Nothing is broadcast.
`principalBinding` reports `WALLET_GATE_EIP712` /
`GATE_EIP712_PER_EXECUTION` only after that signature is accepted.

The wallet must already hold at least the fixture MDUSD debit and have
approved the gate for it. Preflight reads those balances from the wallet,
not from the manifest principal. The gate pulls MDUSD from the signer.
There is no transfer from the manifest principal to the wallet.

B.5.3 `WALLET_EIP712` versions still cannot send
(`WALLET_PRINCIPAL_NOT_DELEGATED_TO_DOMAIN`). The B.5.2 demonstration path
can still send, and only after `AUTHORIZE ROBINHOOD TESTNET SEND`. V2 does
not use that path.

## Run

The server and the session are the existing Live AI Lab. Do not paste a
private key into the API or into this command. `.robinhood-testnet/keys.json`
must already exist, mode `0600`. The script loads it with `loadKeys()` and
refuses if the addresses are not the manifest parties. Those keys still pay
gas (deployer) and still sign the execution commitment (agent). They sign
the gate mandate only when the wallet is that manifest principal.
`ROBINHOOD_TESTNET_RPC_URL` is optional. The URL is never printed. There is
no mainnet path.

The wallet that will be debited must hold MDUSD and must have approved the
deployed gate for at least the fixture debit. For a wallet that is not the
manifest principal, that is the wallet's own balance and allowance, not the
manifest principal's.

```text
npm run agents:serve   # 127.0.0.1:8787, durable .live/
# session + draft via the existing API or UI
POST /api/live/sessions/:id/wallet/challenge
  { "address": "<wallet, lowercase 0x>", "spine": "V2" }
# sign the returned PortfolioMandateV2 typedData with that wallet. Do not paste a key.
POST /api/live/sessions/:id/wallet/authorize
  { "challenge": "<id>", "signature": "<0x…>" }
POST /api/live/sessions/:id/run
npm run agents:settle:v2 -- --session <id>
```

If the wallet is the manifest principal, that command re-verifies and dry-runs
with the local custody key. It does not ask for another signature.

If the wallet is not the manifest principal, the command re-verifies, builds
the gate mandate, and prints `typedData` for `MandateAuthorization`. Sign
that typed data with the same wallet (`eth_signTypedData_v4`). Paste the
65-byte signature (`0x` and 130 hex characters) on stdin. Do not paste a
private key. The process is waiting; a signature produced for an earlier
run will not match, because the mandate digest includes this run's domain
authorization. EOF or a blank line is exit 8
(`GATE_EXECUTION_AUTHORITY_REQUIRED`). A bad signature is exit 4 and nothing
is broadcast.

```text
npm run agents:settle:v2 -- --session <id> --send
```

`--send` does the dry run first (including the gate signature, when one is
required), prints READY, then reads exactly `AUTHORIZE ROBINHOOD TESTNET SEND`,
then builds a new gate mandate and, when the wallet is not the manifest
principal, asks for a second gate signature. It does not broadcast without
the phrase, and it does not reuse the dry run's signature. A real RPC send
still requires a live model (`provider.kind === 'LIVE'`); a stub or script
is refused. The command does not emit `TESTNET_READY_FOR_SEND` (the B.6.2
client still hardcodes that event as "broadcast disabled").

Exit codes: `0` ready, reconciled only, or a confirmed `LIVE_TESTNET` send;
`1` usage or configuration; `3` the session cannot be restored; `4` not
eligible (including a gate signature that does not recover to the wallet);
`5` the dry run did not reach READY; `6` the phrase was refused; `7` a
transaction was submitted but is not a confirmed live-testnet settlement;
`8` the wallet must sign the gate mandate and no signature was provided.

## Remaining technical debt

- The frozen Phase 6 gate has no ERC-1271 and no session keys. This change
  does not modify the gate, MCE v2, or Candidate V3. A wallet that is not
  the manifest principal settles only by signing `MandateAuthorization`
  itself, and only if that address holds the MDUSD and the allowance.
- The portfolio V2 signature is not the gate signature. Each execution needs
  its own gate EIP-712. `--send` asks for a new one because it builds a new
  mandate digest.
- Agent proposal keys stay demonstration keys. The gate agent key stays the
  7E.3 agent key. It is not the wallet, and it still signs the execution
  commitment. The deployer key still pays gas. Neither is delegated.
- The B.5.2 demonstration-principal path remains. It is not used by V2. It
  still sends only after the operator phrase.
- Exact resubmission is still absent: the raw transaction is not stored.
- The domain ledger is still per attempt and is not fully reconciled.
- The B.6.2 client still describes `TESTNET_READY_FOR_SEND` as broadcast
  disabled. V2 avoids that event. The Live demo wallet path requests
  `spine: "V2"` and signs `PortfolioMandateV2`. Callers that omit `spine`
  stay on the B.5.3 approval. The playback client labels `SAME_PRINCIPAL` and
  `WALLET_GATE_EIP712` when a settlement event carries them. It does not
  collect the gate signature.
- Session, portfolio, and settlement state are local SQLite.
- The settled leg is the MDEMO/MDUSD fixture, not an NVDA trade.
- A dry run still reveals a signed gate artifact to the RPC through
  `eth_call`, executable until its 90-second deadline. It is journaled.
