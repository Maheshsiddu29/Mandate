/**
 * C2.3.2 local Anvil world: real MandateDelegatedExecutionGate bytecode on
 * chain id 46630. No Robinhood testnet RPC, no external broadcast.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import {
  ChainClient,
  JsonRpcClient,
  TxSender,
  calldata,
  representationIdOf,
  type Address,
  type ReviewedGate,
  type ReviewedMarket,
} from '@mandate/evm-robinhood';
import { delegatedDomainSeparator, type DelegationFields } from '@mandate/execution-gate';
import {
  artifact,
  erc20,
  forgeBuild,
  gateConstructorArgs,
  hashHex,
  mined,
  tokenConstructorArgs,
  type DemoMarketConfig,
} from '../../../evm-robinhood/scripts/lib.ts';
import { RobinhoodTestnetRpc, type Endpoint } from '../../src/rpc.ts';
import type { TestnetDeployment } from '../../src/deployment.ts';
import { AGENT, AGENT_KEY, PRINCIPAL, PRINCIPAL_KEY, SUBMITTER, SUBMITTER_KEY } from './world.ts';

const CHAIN = 46_630n;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (addr === null || typeof addr === 'string') {
        s.close();
        reject(new Error('no port'));
        return;
      }
      const port = addr.port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export interface LocalV3Evm {
  readonly url: string;
  readonly chain: ChainClient;
  readonly rpc: RobinhoodTestnetRpc;
  readonly deployment: TestnetDeployment;
  readonly v3Gate: { readonly address: string; readonly domainSeparator: string; readonly runtimeCodeHash: string };
  readonly keys: { readonly principal: string; readonly agent: string; readonly submitter: string };
  warpTo(timestamp: bigint): Promise<void>;
  mine(): Promise<void>;
  usedDebitOf(delegationDigest: string): Promise<bigint>;
  nonceUsed(delegationDigest: string, nonce: bigint): Promise<boolean>;
  isRevoked(delegationDigest: string): Promise<boolean>;
  onchainDelegationDigest(fields: DelegationFields): Promise<string>;
  revokeDelegation(fields: DelegationFields): Promise<string>;
  drainVenueInventory(): Promise<void>;
  setAllowance(amount: bigint): Promise<void>;
  tokenBalance(token: string, owner: string): Promise<bigint>;
  ethCall(to: string, data: string, from?: string): Promise<{ ok: true; data: string } | { ok: false; revert: string }>;
  sendRaw(to: string, data: string, key: string): Promise<{ txHash: string; status: 'SUCCESS' | 'REVERTED' }>;
  /** Live contract `DELEGATED_EXECUTION_APPROVAL_TYPEHASH()` — Solidity-derived. */
  approvalTypehash(): Promise<string>;
  receiptLogs(txHash: string): Promise<readonly { readonly address: string; readonly topics: readonly string[] }[]>;
  close(): void;
}

let built = false;

export async function openLocalV3Evm(): Promise<LocalV3Evm> {
  if (!built) {
    forgeBuild();
    built = true;
  }
  const port = await freePort();
  const anvil: ChildProcess = spawn(
    'anvil',
    ['--chain-id', '46630', '--port', String(port), '--silent', '--base-fee', '10'],
    { stdio: 'ignore' },
  );
  const url = `http://127.0.0.1:${port}`;
  const jsonRpc = new JsonRpcClient(url, { allowLoopback: true });
  for (let i = 0; i < 80; i += 1) {
    const id = await jsonRpc.request<string>('eth_chainId', []);
    if (id.ok && BigInt(id.value) === CHAIN) break;
    await new Promise((r) => setTimeout(r, 100));
    if (i === 79) {
      anvil.kill();
      throw new Error('local anvil (chain 46630) did not become ready');
    }
  }

  const fund = async (a: string) => {
    await jsonRpc.request('anvil_setBalance', [a, '0x56BC75E2D63100000']); // 100 ETH
  };
  await fund(SUBMITTER);
  await fund(PRINCIPAL);
  await fund(AGENT);

  const chain = new ChainClient(jsonRpc, CHAIN);
  const ok = await chain.ensureChain();
  if (!ok.ok) {
    anvil.kill();
    throw new Error(`anvil chain refused: ${ok.error}`);
  }

  const deployer = new TxSender(SUBMITTER_KEY, CHAIN);
  const principal = new TxSender(PRINCIPAL_KEY, CHAIN);
  const token = artifact('MandateDemoToken.sol', 'MandateDemoToken');
  const gateArt = artifact('MandateDelegatedExecutionGate.sol', 'MandateDelegatedExecutionGate');
  const supply = { mdemo: 1_000_000n * 10n ** 18n, mdusd: 1_000_000n * 10n ** 6n };

  const mdemoTx = await mined(
    chain,
    deployer,
    null,
    token.creation + tokenConstructorArgs('Mandate Demo Asset (TESTNET FIXTURE)', 'MDEMO', 18, SUBMITTER, supply.mdemo).slice(2),
    'MDEMO',
  );
  const mdusdTx = await mined(
    chain,
    deployer,
    null,
    token.creation + tokenConstructorArgs('Mandate Demo Dollar (TESTNET FIXTURE)', 'MDUSD', 6, SUBMITTER, supply.mdusd).slice(2),
    'MDUSD',
  );
  const mdemo = mdemoTx.receipt.contractAddress as string;
  const mdusd = mdusdTx.receipt.contractAddress as string;

  const marketCfg: DemoMarketConfig = {
    representation: mdemo,
    fundingToken: mdusd,
    canonicalAsset: { assetClass: 'fixture', idScheme: 'mandate-demo', value: 'MDEMO' },
    issuer: 'issuer.mandate-demo',
    venue: 'venue.mandate-fixture',
    quantityUnit: 'TOKEN',
    settlementUnit: 'MDUSD',
    synthetic: false,
    fixturePriceDecimals: 6,
    fixturePrice: '10000000',
    fixtureFeeBps: 0,
  };

  const gateTx = await mined(
    chain,
    deployer,
    null,
    gateArt.creation + gateConstructorArgs([marketCfg]).slice(2),
    'MandateDelegatedExecutionGate',
  );
  const gate = gateTx.receipt.contractAddress as string;
  const repId = representationIdOf(CHAIN, mdemo as Address);
  const snap = await chain.gateMarket(gate as Address, repId, gateTx.receipt.blockNumber);
  if (!snap.ok) {
    anvil.kill();
    throw new Error(`gate market unreadable: ${snap.error}`);
  }
  const venue = snap.value.venue;
  const adapter = snap.value.adapter;

  const codeOf = async (a: string): Promise<string> => {
    const c = await chain.code(a as Address);
    if (!c.ok || c.value === '0x') throw new Error(`no code at ${a}`);
    return c.value.toLowerCase();
  };
  const gateCode = await codeOf(gate);
  const domain = await chain.domainSeparator(gate as Address);
  const expectedDomain = delegatedDomainSeparator(CHAIN, gate as never);
  if (!domain.ok || domain.value !== expectedDomain) {
    anvil.kill();
    throw new Error(`V3 domain separator mismatch: ${domain.ok ? domain.value : domain.error} vs ${expectedDomain}`);
  }

  await mined(chain, deployer, mdemo, erc20.transfer(venue, 1_000n * 10n ** 18n), 'stock venue');
  await mined(chain, deployer, mdusd, erc20.transfer(PRINCIPAL, 1_000n * 10n ** 6n), 'fund principal MDUSD');
  await mined(chain, principal, mdusd, erc20.approve(gate, 500n * 10n ** 6n), 'principal approve V3 gate');

  const runtimeCodeHash = hashHex(gateCode);
  const v3Gate = { address: gate, domainSeparator: domain.value, runtimeCodeHash };
  const reviewedMarket: ReviewedMarket = {
    representation: mdemo as Address,
    fundingToken: mdusd as Address,
    adapter: adapter as Address,
    venue: venue as Address,
    representationDecimals: 18,
    fundingDecimals: 6,
    canonicalAsset: { assetClass: 'fixture', idScheme: 'mandate-demo', value: 'MDEMO' },
    issuer: 'issuer.mandate-demo',
    venueId: 'venue.mandate-fixture',
    quantityUnit: 'TOKEN',
    settlementUnit: 'MDUSD',
    synthetic: false,
    fixturePrice: { decimals: 6, atoms: 10_000_000n },
    feeBps: 0,
  };
  const reviewed: ReviewedGate = {
    chainId: CHAIN,
    gate: gate as Address,
    markets: [reviewedMarket],
  };
  const deployment: TestnetDeployment = {
    chainId: CHAIN,
    networkName: 'Local Anvil (Robinhood testnet chain id)',
    explorer: 'http://127.0.0.1',
    gate: { address: gate as Address, runtimeCodeHash, domainSeparator: domain.value },
    venue: { address: venue as Address, runtimeCodeHash: hashHex(await codeOf(venue)) },
    adapter: { address: adapter as Address, runtimeCodeHash: hashHex(await codeOf(adapter)) },
    mdemo: {
      address: mdemo as Address,
      runtimeCodeHash: hashHex(await codeOf(mdemo)),
      symbol: 'MDEMO',
      name: 'Mandate Demo Asset (TESTNET FIXTURE)',
      decimals: 18,
    },
    mdusd: {
      address: mdusd as Address,
      runtimeCodeHash: hashHex(await codeOf(mdusd)),
      symbol: 'MDUSD',
      name: 'Mandate Demo Dollar (TESTNET FIXTURE)',
      decimals: 6,
    },
    principal: PRINCIPAL as Address,
    agent: AGENT as Address,
    submitter: SUBMITTER as Address,
    reviewed,
    market: reviewedMarket,
  };

  const primary: Endpoint = { chain, label: 'mock' };
  const rpc = new RobinhoodTestnetRpc(SUBMITTER_KEY, gate as Address, { primary, fallback: null });

  const wordCall = async (data: string): Promise<string> => {
    const r = await chain.call(gate as Address, data, 'latest');
    if (!r.ok) throw new Error(r.revert);
    return r.returnData;
  };

  return {
    url,
    chain,
    rpc,
    deployment,
    v3Gate,
    keys: { principal: PRINCIPAL_KEY, agent: AGENT_KEY, submitter: SUBMITTER_KEY },
    async warpTo(timestamp: bigint) {
      await jsonRpc.request('evm_setNextBlockTimestamp', [`0x${timestamp.toString(16)}`]);
      await jsonRpc.request('evm_mine', []);
    },
    async mine() {
      await jsonRpc.request('evm_mine', []);
    },
    async usedDebitOf(delegationDigest: string) {
      const data = calldata('usedDebitOf(bytes32)', [{ kind: 'bytes32' }], [delegationDigest]);
      return BigInt(await wordCall(data));
    },
    async nonceUsed(delegationDigest: string, nonce: bigint) {
      const data = calldata('nonceUsed(bytes32,uint64)', [{ kind: 'bytes32' }, { kind: 'uint', bits: 64 }], [delegationDigest, nonce]);
      return BigInt(await wordCall(data)) !== 0n;
    },
    async isRevoked(delegationDigest: string) {
      const data = calldata('isRevoked(bytes32)', [{ kind: 'bytes32' }], [delegationDigest]);
      return BigInt(await wordCall(data)) !== 0n;
    },
    async onchainDelegationDigest(fields: DelegationFields) {
      const DELEGATION = {
        kind: 'tuple' as const,
        fields: [
          ['portfolioMandateDigest', { kind: 'bytes32' as const }],
          ['initialAllocationDigest', { kind: 'bytes32' as const }],
          ['sessionDigest', { kind: 'bytes32' as const }],
          ['principal', { kind: 'address' as const }],
          ['delegate', { kind: 'address' as const }],
          ['agent', { kind: 'address' as const }],
          ['representationIdHash', { kind: 'bytes32' as const }],
          ['fundingToken', { kind: 'address' as const }],
          ['cumulativeDebitLimit', { kind: 'uint' as const, bits: 256 }],
          ['validAfter', { kind: 'uint' as const, bits: 64 }],
          ['validUntil', { kind: 'uint' as const, bits: 64 }],
          ['generation', { kind: 'uint' as const, bits: 64 }],
        ] as const,
      };
      const data = calldata('delegationDigest((bytes32,bytes32,bytes32,address,address,address,bytes32,address,uint256,uint64,uint64,uint64))', [DELEGATION], [{
        portfolioMandateDigest: fields.portfolioMandateDigest,
        initialAllocationDigest: fields.initialAllocationDigest,
        sessionDigest: fields.sessionDigest,
        principal: fields.principal,
        delegate: fields.delegate,
        agent: fields.agent,
        representationIdHash: fields.representationIdHash,
        fundingToken: fields.fundingToken,
        cumulativeDebitLimit: fields.cumulativeDebitLimit,
        validAfter: fields.validAfter,
        validUntil: fields.validUntil,
        generation: fields.generation,
      }]);
      return (await wordCall(data)).toLowerCase();
    },
    async revokeDelegation(fields: DelegationFields) {
      const DELEGATION = {
        kind: 'tuple' as const,
        fields: [
          ['portfolioMandateDigest', { kind: 'bytes32' as const }],
          ['initialAllocationDigest', { kind: 'bytes32' as const }],
          ['sessionDigest', { kind: 'bytes32' as const }],
          ['principal', { kind: 'address' as const }],
          ['delegate', { kind: 'address' as const }],
          ['agent', { kind: 'address' as const }],
          ['representationIdHash', { kind: 'bytes32' as const }],
          ['fundingToken', { kind: 'address' as const }],
          ['cumulativeDebitLimit', { kind: 'uint' as const, bits: 256 }],
          ['validAfter', { kind: 'uint' as const, bits: 64 }],
          ['validUntil', { kind: 'uint' as const, bits: 64 }],
          ['generation', { kind: 'uint' as const, bits: 64 }],
        ] as const,
      };
      const data = calldata('revokeDelegation((bytes32,bytes32,bytes32,address,address,address,bytes32,address,uint256,uint64,uint64,uint64))', [DELEGATION], [{
        portfolioMandateDigest: fields.portfolioMandateDigest,
        initialAllocationDigest: fields.initialAllocationDigest,
        sessionDigest: fields.sessionDigest,
        principal: fields.principal,
        delegate: fields.delegate,
        agent: fields.agent,
        representationIdHash: fields.representationIdHash,
        fundingToken: fields.fundingToken,
        cumulativeDebitLimit: fields.cumulativeDebitLimit,
        validAfter: fields.validAfter,
        validUntil: fields.validUntil,
        generation: fields.generation,
      }]);
      const r = await mined(chain, principal, gate, data, 'revokeDelegation');
      if (r.receipt.status !== 'SUCCESS') throw new Error('revoke failed');
      return r.txHash;
    },
    async drainVenueInventory() {
      // Transfer all MDEMO out of the venue via anvil storage is fragile; mint 0 path:
      // move inventory to deployer by pranking as venue is impossible. Use deal:
      await jsonRpc.request('anvil_setStorageAt', [
        mdemo,
        // slot for ERC20 balances is implementation-dependent; use deal cheat if available
        '0x0',
        '0x0',
      ]);
      // Prefer Foundry-style deal via anvil_setBalance is ETH only. Use token transfer from venue
      // by impersonating the venue.
      await jsonRpc.request('anvil_impersonateAccount', [venue]);
      await jsonRpc.request('anvil_setBalance', [venue, '0x56BC75E2D63100000']);
      const bal = await chain.erc20Balance(mdemo as Address, venue as Address);
      if (!bal.ok) throw new Error(bal.error);
      if (bal.value > 0n) {
        const venueSender = {
          address: venue,
          // Impersonated sends need eth_sendTransaction from anvil, not TxSender.
        };
        void venueSender;
        const transfer = erc20.transfer(SUBMITTER, bal.value);
        const sent = await jsonRpc.request<string>('eth_sendTransaction', [{ from: venue, to: mdemo, data: transfer, gas: '0x100000' }]);
        if (!sent.ok) throw new Error(`drain venue: ${sent.error}`);
        await jsonRpc.request('evm_mine', []);
      }
      await jsonRpc.request('anvil_stopImpersonatingAccount', [venue]);
    },
    async setAllowance(amount: bigint) {
      await mined(chain, principal, mdusd, erc20.approve(gate, amount), 'setAllowance');
    },
    async tokenBalance(token: string, owner: string) {
      const b = await chain.erc20Balance(token as Address, owner as Address);
      if (!b.ok) throw new Error(b.error);
      return b.value;
    },
    async ethCall(to: string, data: string, from?: string) {
      const r = await chain.call(to as Address, data, 'latest', from as Address | undefined);
      return r.ok ? { ok: true as const, data: r.returnData } : { ok: false as const, revert: r.revert };
    },
    async sendRaw(to: string, data: string, key: string) {
      const sender = new TxSender(key, CHAIN);
      const r = await mined(chain, sender, to, data, 'sendRaw');
      return { txHash: r.txHash, status: r.receipt.status };
    },
    async approvalTypehash() {
      const data = calldata('DELEGATED_EXECUTION_APPROVAL_TYPEHASH()', []);
      return (await wordCall(data)).toLowerCase();
    },
    async receiptLogs(txHash: string) {
      const r = await rpc.receipt(txHash);
      if (!r.ok || r.value === null) throw new Error('receipt missing');
      // ChainClient receipt may not expose raw logs; fetch via JSON-RPC.
      const raw = await jsonRpc.request<{
        readonly logs: readonly { readonly address: string; readonly topics: readonly string[] }[];
      } | null>('eth_getTransactionReceipt', [txHash]);
      if (!raw.ok || raw.value === null) throw new Error('raw receipt missing');
      return raw.value.logs.map((l) => ({ address: l.address.toLowerCase(), topics: l.topics.map((t) => t.toLowerCase()) }));
    },
    close() {
      anvil.kill();
    },
  };
}

/** Sanity: local runtime is not the V2 gate placeholder path. */
export function assertRealGate(gate: string): void {
  if (gate === '0xa0cb889707d426a7a386870a03bc70d1b0697598') throw new Error('placeholder gate');
  if (!/^0x[0-9a-f]{40}$/.test(gate)) throw new Error('bad gate');
}
