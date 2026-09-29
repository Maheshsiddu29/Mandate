# Lighter testnet access request (draft for outreach)

> **Status: draft, not sent.** Phase 7E.2. The Mandate team sends it through
> Lighter's official support or developer channel. It asks only for
> sanctioned testnet access. No unofficial funding route (bridging mainnet
> funds, third-party faucets, shared or public credentials) has been or will
> be attempted.

## Why we are asking

Mandate places a policy-enforcement point in front of a Lighter API key: an
agent's order is signed only after a durable ledger has admitted exactly that
transaction (the 40-byte L2 transaction hash, the account, API key and nonce
slot). The implementation runs on Lighter testnet (L2 chain id 300) with
read-only evidence ([testnet-evidence.md](testnet-evidence.md)). What it
cannot yet show needs a **funded testnet account whose API key we hold**:

| Evidence | What we need to observe |
| --- | --- |
| E-3 | whether an order can fill after its cancel is sequenced |
| E-4 | nonce behaviour of transactions that never execute or expire |
| E-5 | whether an API key can transfer between sub-accounts of one master |
| E-6 | the uniqueness scope of `client_order_index` |
| E-7 | how isolated margin is allocated per fill |
| E-8 | the default margin mode of a market the account has never traded |
| E-10 | whether the maker-only key restriction excludes withdraw, transfer, mint and leverage changes (premium account) |

We would place small limit and IOC orders, cancels and at most one
leverage/margin-mode change per market, on testnet only.

## Questions

1. **Account creation.** What is the supported way to create a testnet
   account (and sub-account) for integration testing, and to register an API
   key on it? Is the L1 owner on testnet a normal Ethereum key on a specific
   test network?
2. **Funding.** Is there an official testnet faucet, or can Lighter provide
   a pre-funded testnet account (a few thousand test USDC is ample)? If
   neither, what is the sanctioned funding route?
3. **Finality on testnet.** Across 194 observed testnet transactions no
   `committed_at` or `verified_at` was ever set and every executed
   transaction had status 3. Is it intentional that testnet does not commit
   or verify batches on L1? Is there any environment where the
   `SEQUENCED → COMMITTED → VERIFIED` progression can be observed?
4. **A suitable environment.** Is there a testnet (or staging) environment
   where cancel, fill and finality behaviour matches mainnet closely enough to
   test the questions above — including matching counterparties for fills?
5. **Premium features on testnet.** Can a testnet account be given the
   premium tier needed for maker-only API keys (E-10)?
6. **Read-only auth tokens.** Is the `ro:` read-only token the recommended way
   for a monitoring process to read `accountActiveOrders`, and does a
   read-only token ever authorize any write endpoint?

## What we will not do

- use mainnet, real funds or production credentials;
- move mainnet funds to testnet or use unofficial faucets;
- use public or shared credentials for any write;
- expose the account's private key to the agent under test.

## Contact details

To be filled in by the sender: name, organisation, contact address, the
testnet account index (once created) and the L1 address that owns it.
