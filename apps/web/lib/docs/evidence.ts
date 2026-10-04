/**
 * Canonical public LIVE_TESTNET V3 evidence for documentation.
 *
 * Values are derived from the durable session
 * `lab-4606481af6d3ef1af6250673fb07ec58` and the committed V3 Gate manifest
 * `contracts/deploy/robinhood-testnet-delegated-live.json`.
 *
 * The delegation digest is the EIP-712 struct hash of the signed
 * DelegatedPortfolioAuthorizationV3 fields from that session — recomputed via
 * `@mandate/execution-gate` `delegationStructHash`.
 *
 * This is public evidence only. No private keys or raw signatures.
 */

export const LIVE_V3_EVIDENCE = {
  label: "LIVE_TESTNET",
  chain: "Robinhood Chain Testnet",
  chainId: 46630,
  sessionId: "lab-4606481af6d3ef1af6250673fb07ec58",
  gate: "0x5cf0621ab974d100fd5df225dab046bf35fa7519",
  gateKind: "MandateDelegatedExecutionGate",
  principal: "0xdea526b6c506e612a4177ad3a88c3dcc6d524fe1",
  executionDelegate: "0x8aedbb6f531fc595836d9a630a1bb99885023629",
  transaction: "0x95fae11bb545330f03365939dc87a1c39023717a0b00b81ae93ab6a4b25f0878",
  block: "128655452",
  gasUsed: "322661",
  executionNonce: "1",
  delegationDigest:
    "0x46bcaa9574e5d12c03af56fa0f4b980624078b2d4df71b9fd7486afa6a4ff194",
  reservation:
    "0x82d5a8bdbc661e92d62c09d2d404051daa424c7de4f448f83e61e3b786f32e7c",
  receiptDigest:
    "0x93ba1158b1aadb16daf8ede52a95ef6b4ed51bf35bb11c7610776aeda1ad9ebe",
  consumedCapacity: "64 MDUSD",
  remainingCapacity: "0",
  remainingCapacityNote: "Remaining capacity is 0 for this live authorization.",
  authorizedStockCapital: "$800",
  fixtureIn: "64 MDUSD",
  fixtureOut: "6.4 MDEMO",
  fixturePair: "MDUSD → MDEMO",
  explorerTx: (tx: string = "0x95fae11bb545330f03365939dc87a1c39023717a0b00b81ae93ab6a4b25f0878") =>
    `https://explorer.testnet.chain.robinhood.com/tx/${tx}`,
  qualification:
    "Valueless demo assets. Not an NVDA trade. Not a Robinhood Stock Token.",
  manifestPath: "contracts/deploy/robinhood-testnet-delegated-live.json",
} as const;

export const EVIDENCE_CLASSES = [
  {
    id: "LIVE_MODEL",
    meaning:
      "A model produced the result under a live provider. Does not imply a blockchain transaction.",
  },
  {
    id: "LIVE_TESTNET",
    meaning:
      "A confirmed transaction on Robinhood Chain Testnet (chain id 46630).",
  },
  {
    id: "FIXTURE",
    meaning:
      "Scripted demonstration market or asset path. Not a live venue fill.",
  },
  {
    id: "SIMULATED",
    meaning:
      "Local or dry-run execution against real bytecode or an eth_call path. Not a broadcast settlement.",
  },
  {
    id: "OFFCHAIN_ONLY",
    meaning:
      "Authorization or domain outcome without a LIVE_TESTNET settlement connector in this build.",
  },
] as const;
