/**
 * `npm run robinhood:testnet:deploy [-- --dry-run]` — deploy the Phase 7E.3
 * demonstration to Robinhood Chain TESTNET (46630). EXPLICIT ONLY: never run
 * by `npm run check`. Refuses every mainnet (chain.ts).
 *
 * 1. `forge build`; the frozen gate and the labelled demo token are deployed
 *    from their build artifacts (solc 0.8.37, via-IR, 200 runs, cancun,
 *    bytecode hash none), signed in-process by the disposable deployer key.
 * 2. MDEMO and MDUSD (MandateDemoToken, labelled fixtures), then the gate with
 *    one FIXTURE market — its constructor creates the FixtureVenue and
 *    FixtureVenueAdapter. The config is written to
 *    `contracts/deploy/robinhood-testnet.json`.
 * 3. The reviewed deployment script's read-only `verify(gate, config)` runs
 *    against the deployed gate, and the gate's runtime code is compared with
 *    the artifact, constructor-set immutables aside.
 * 4. Setup: 1,000 MDEMO inventory to the venue; 1,000 MDUSD and a little gas
 *    ETH to the principal; the principal approves the gate for 500 MDUSD —
 *    the same amount as its Mandate capital authority.
 * 5. A sanitized manifest (public addresses, hashes, settings — no key) to
 *    `docs/phase-7e/deployment-manifest.json`.
 *
 * `--dry-run` does all of it against a local anvil fork of the testnet and
 * writes nothing into the repository.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { bytesToHex, domainSeparator } from '@mandate/kernel';
import { gateDomain } from '@mandate/execution-gate';
import { TxSender, ROBINHOOD_TESTNET_CHAIN_ID, representationIdOf } from '../src/index.ts';
import {
  CONFIG_PATH,
  EXPLORER,
  MANIFEST_PATH,
  PUBLIC_RPC,
  REPO,
  artifact,
  erc20,
  forgeBuild,
  gitCommit,
  gateConstructorArgs,
  hashHex,
  json,
  loadKeys,
  log,
  mined,
  openNetwork,
  runtimeMatches,
  tokenConstructorArgs,
  type ContractRecord,
  type DemoMarketConfig,
  type Keys,
  type Manifest,
  type Network,
} from './lib.ts';

const dryRun = process.argv.includes('--dry-run');
/** 0.0005 testnet ETH: about 25M gas at the testnet's 0.01 gwei base fee, doubled — several times what the deployment uses. */
const MIN_DEPLOYER_WEI = 500_000_000_000_000n;

/** Deploy and set up the demonstration on `net`; write the config and manifest only when `write`. */
export async function deployDemo(net: Network, keys: Keys, write: boolean): Promise<Manifest> {
  {
    const chain = net.chain;
    const deployer = new TxSender(keys.deployer.privateKey, ROBINHOOD_TESTNET_CHAIN_ID);
    const principal = new TxSender(keys.principal.privateKey, ROBINHOOD_TESTNET_CHAIN_ID);
    const balance = await chain.balance(deployer.address);
    if (!balance.ok) throw new Error(`deployer balance unreadable: ${balance.error}`);
    log(`deployer ${deployer.address} balance ${balance.value} wei`);
    if (balance.value < MIN_DEPLOYER_WEI) throw new Error(`deployer is not funded; send testnet ETH to ${deployer.address}`);
    const arbOs = await chain.call('0x0000000000000000000000000000000000000064', '0x051038f2');
    const arbOsVersion = arbOs.ok ? Number(BigInt(arbOs.returnData)) - 55 : null;

    const token = artifact('MandateDemoToken.sol', 'MandateDemoToken');
    const gateArt = artifact('MandateExecutionGate.sol', 'MandateExecutionGate');
    const supply = { mdemo: 1_000_000n * 10n ** 18n, mdusd: 1_000_000n * 10n ** 6n };
    const names = { mdemo: ['Mandate Demo Asset (TESTNET FIXTURE)', 'MDEMO', 18] as const, mdusd: ['Mandate Demo Dollar (TESTNET FIXTURE)', 'MDUSD', 6] as const };

    log('deploying demo tokens');
    const mdemoTx = await mined(chain, deployer, null, token.creation + tokenConstructorArgs(names.mdemo[0], names.mdemo[1], names.mdemo[2], deployer.address, supply.mdemo).slice(2), 'MDEMO');
    const mdusdTx = await mined(chain, deployer, null, token.creation + tokenConstructorArgs(names.mdusd[0], names.mdusd[1], names.mdusd[2], deployer.address, supply.mdusd).slice(2), 'MDUSD');
    const mdemo = mdemoTx.receipt.contractAddress as string;
    const mdusd = mdusdTx.receipt.contractAddress as string;

    const market: DemoMarketConfig = {
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
    const config = {
      label: 'ROBINHOOD CHAIN TESTNET (46630) — Phase 7E.3 demonstration. One labelled FIXTURE market: MDEMO (Mandate demo asset, not a Robinhood Stock Token) against MDUSD (Mandate demo dollar, not a stablecoin) at an immutable 10 MDUSD per MDEMO, no fee. Settlement fixture, not a market; no liquidity; valueless.',
      chainId: 46630,
      markets: [{ ...market, classification: 'FIXTURE' }],
    };

    log('deploying MandateExecutionGate (frozen Phase 6)');
    const gateTx = await mined(chain, deployer, null, gateArt.creation + gateConstructorArgs([market]).slice(2), 'MandateExecutionGate');
    const gate = gateTx.receipt.contractAddress as string;
    const snap = await chain.gateMarket(gate, representationIdOf(ROBINHOOD_TESTNET_CHAIN_ID, mdemo), gateTx.receipt.blockNumber);
    if (!snap.ok) throw new Error(`gate market unreadable: ${snap.error}`);
    const venue = snap.value.venue;
    const adapter = snap.value.adapter;

    const configJson = `${JSON.stringify(config, null, 2)}\n`;
    if (write) writeFileSync(CONFIG_PATH, configJson);
    log('running the reviewed deployment script’s read-only verify(gate, config)');
    execFileSync('forge', ['script', 'contracts/script/DeployMandateGate.s.sol', '--sig', 'verify(address,string)', gate, configJson, '--rpc-url', net.rpcUrl], { cwd: REPO, stdio: 'ignore' });
    log('  verify: PASS');

    const code = async (a: string) => {
      const c = await chain.code(a);
      if (!c.ok || c.value === '0x') throw new Error(`no code at ${a}`);
      return c.value.toLowerCase();
    };
    const gateCode = await code(gate);
    const matches = runtimeMatches(gateCode, gateArt);
    if (!matches) throw new Error('deployed gate runtime code is not the artifact’s');
    const domain = await chain.domainSeparator(gate);
    if (!domain.ok || domain.value !== bytesToHex(domainSeparator(gateDomain(ROBINHOOD_TESTNET_CHAIN_ID, gate)))) throw new Error('gate domain separator unexpected');

    log('setup');
    const setup: { step: string; tx: string; gasUsed: string }[] = [];
    const step = async (label: string, sender: TxSender, to: string, data: string, value?: bigint) => {
      const r = await mined(chain, sender, to, data, label, value === undefined ? {} : { value });
      if (r.receipt.status !== 'SUCCESS') throw new Error(`${label} reverted`);
      setup.push({ step: label, tx: r.txHash, gasUsed: r.receipt.gasUsed.toString() });
    };
    await step('stock venue with 1,000 MDEMO', deployer, mdemo, erc20.transfer(venue, 1_000n * 10n ** 18n));
    await step('fund principal with 1,000 MDUSD', deployer, mdusd, erc20.transfer(keys.principal.address, 1_000n * 10n ** 6n));
    await step('fund principal with 0.00005 ETH for its approve', deployer, keys.principal.address, '0x', 50_000_000_000_000n);
    await step('principal approves the gate for 500 MDUSD (= its capital authority)', principal, mdusd, erc20.approve(gate, 500n * 10n ** 6n));

    const rec = async (a: string, tx: typeof mdemoTx | null, creation: string | null): Promise<ContractRecord> => {
      const c = await code(a);
      return {
        address: a,
        deploymentTx: tx?.txHash ?? null,
        block: tx?.receipt.blockNumber.toString() ?? gateTx.receipt.blockNumber.toString(),
        createdBy: tx === null ? gate : deployer.address,
        runtimeCodeHash: hashHex(c),
        runtimeSizeBytes: (c.length - 2) / 2,
        creationCodeHash: creation === null ? null : hashHex(creation),
        deploymentGasUsed: tx?.receipt.gasUsed.toString() ?? null,
      };
    };
    const manifest: Manifest = {
      label: 'SANITIZED. Robinhood Chain TESTNET only. Public addresses, hashes and settings; no private key, mnemonic or RPC credential. Valueless demo fixtures.',
      network: { name: 'Robinhood Chain Testnet', chainId: 46630, rpc: PUBLIC_RPC, explorer: EXPLORER, nativeGasToken: 'ETH', arbOsVersion, source: 'https://docs.robinhood.com/chain/connecting/ (accessed 2026-09-28)' },
      deployer: deployer.address,
      principal: keys.principal.address,
      agent: keys.agent.address,
      compiler: { solc: gateArt.compiler, optimizer: gateArt.settings.optimizer.enabled, optimizerRuns: gateArt.settings.optimizer.runs, viaIr: gateArt.settings.viaIR, evmVersion: gateArt.settings.evmVersion, bytecodeHash: gateArt.settings.bytecodeHash },
      gitCommit: gitCommit(),
      frozenPhase6Source: 'dc98df5 (MandateExecutionGate, MandateCodec, GateArithmetic, FixtureVenue, FixtureVenueAdapter unchanged)',
      timestamp: new Date().toISOString(),
      contracts: {
        mandateExecutionGate: { ...(await rec(gate, gateTx, gateArt.creation)), domainSeparator: domain.value, runtimeMatchesArtifactExceptImmutables: matches },
        fixtureVenue: await rec(venue, null, null),
        fixtureVenueAdapter: await rec(adapter, null, null),
        mdemo: { ...(await rec(mdemo, mdemoTx, token.creation)), name: names.mdemo[0], symbol: 'MDEMO', decimals: 18, supply: supply.mdemo.toString() },
        mdusd: { ...(await rec(mdusd, mdusdTx, token.creation)), name: names.mdusd[0], symbol: 'MDUSD', decimals: 6, supply: supply.mdusd.toString() },
      },
      market,
      setup,
      verification: { deployScriptVerify: 'PASS: DeployMandateGate.verify(gate, contracts/deploy/robinhood-testnet.json) against the deployed gate', explorerSourceVerification: 'NOT YET ATTEMPTED' },
    };
    if (write) {
      writeFileSync(MANIFEST_PATH, `${json(manifest)}\n`);
      log(`manifest written: ${MANIFEST_PATH}`);
      log(`gate: ${EXPLORER}/address/${gate}`);
    } else {
      log(json({ dryRun: true, gate, venue, adapter, mdemo, mdusd, gateRuntimeBytes: manifest.contracts.mandateExecutionGate.runtimeSizeBytes, gateDeployGas: gateTx.receipt.gasUsed }));
    }
    return manifest;
  }
}

async function main(): Promise<void> {
  const keys = loadKeys();
  log(`Phase 7E.3 deploy → Robinhood Chain testnet (46630)${dryRun ? ' [DRY RUN: local anvil fork, nothing broadcast]' : ''}`);
  forgeBuild();
  const net = await openNetwork(dryRun, [keys.deployer.address]);
  try {
    await deployDemo(net, keys, !dryRun);
  } finally {
    net.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: Error) => {
    process.stderr.write(`deploy failed: ${e.message}\n`);
    process.exitCode = 1;
  });
}
