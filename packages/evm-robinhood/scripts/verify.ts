/**
 * `npm run robinhood:testnet:verify` — submit the deployed contracts' source to
 * the Robinhood Chain testnet explorer (Blockscout) for verification, with
 * the repository's compiler settings (foundry.toml), and record the outcome in
 * the manifest. EXPLICIT ONLY. It publishes the five contracts' Solidity source
 * (and the OpenZeppelin sources they import) to the explorer, and nothing else;
 * it reads no key.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { encodeArguments } from '../src/index.ts';
import { address, toHex, uint } from '../src/abi.ts';
import { CONFIG_PATH, EXPLORER, MANIFEST_PATH, REPO, gateConstructorArgs, json, log, tokenConstructorArgs, type DemoMarketConfig, type Manifest } from './lib.ts';

/**
 * Blockscout's own verdict. `forge verify-contract --watch` exits 0 even when
 * Blockscout answers `Fail - Unable to verify`, so the exit code proves nothing:
 * only a `Pass` (or "already verified") status counts.
 */
function verify(addr: string, target: string, args: string): string {
  let out: string;
  try {
    out = execFileSync(
      'forge',
      ['verify-contract', addr, target, '--verifier', 'blockscout', '--verifier-url', `${EXPLORER}/api/`, '--chain-id', '46630', '--constructor-args', args, '--watch'],
      { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 240_000 },
    );
  } catch (e) {
    out = e instanceof Error && 'stdout' in e ? String((e as { stdout: string }).stdout) + String((e as { stderr?: string }).stderr ?? '') : String(e);
  }
  if (/already verified/i.test(out)) return 'VERIFIED (already)';
  if (/Details: `Pass/.test(out)) return 'VERIFIED';
  const details = [...out.matchAll(/Details: `([^`]*)`/g)].map((m) => m[1]).pop();
  return `NOT VERIFIED: ${details ?? out.split('\n').filter((l) => l.trim() !== '').slice(-1).join('').slice(0, 200)}`;
}

/** The explorer's supported solc versions: verification of a build it cannot reproduce is not attempted. */
async function supportedSolc(): Promise<readonly string[]> {
  const r = await fetch(`${EXPLORER}/api/v2/smart-contracts/verification/config`, { signal: AbortSignal.timeout(20_000) });
  const body = (await r.json()) as { solidity_compiler_versions?: string[] };
  return body.solidity_compiler_versions ?? [];
}

async function main(): Promise<void> {
  const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { markets: DemoMarketConfig[] };
  const c = m.contracts;
  const solc = `v${m.compiler.solc}`;
  const supported = await supportedSolc();
  if (!supported.includes(solc)) {
    const newest = supported.find((v) => /^v\d+\.\d+\.\d+\+commit/.test(v)) ?? 'none';
    const note = `UNAVAILABLE: ${EXPLORER} (Blockscout) does not offer solc ${solc} (newest release it lists: ${newest}); the frozen Phase 6 build pins 0.8.37 and recompiling would change the deployed bytecode. Runtime code hashes and deployment metadata are recorded instead; the gate's runtime code was checked against the build artifact (runtimeMatchesArtifactExceptImmutables). Checked ${new Date().toISOString()}.`;
    log(note);
    writeFileSync(MANIFEST_PATH, `${json({ ...m, verification: { ...m.verification, explorerSourceVerification: note } })}\n`);
    return;
  }
  const market = config.markets[0] as DemoMarketConfig;
  const venuePrice = BigInt(market.fixturePrice) * 10n ** BigInt(c.mdusd.decimals - market.fixturePriceDecimals);
  const results = {
    mandateExecutionGate: verify(c.mandateExecutionGate.address, 'contracts/src/MandateExecutionGate.sol:MandateExecutionGate', gateConstructorArgs(config.markets)),
    mdemo: verify(c.mdemo.address, 'contracts/src/demo/MandateDemoToken.sol:MandateDemoToken', tokenConstructorArgs(c.mdemo.name, c.mdemo.symbol, c.mdemo.decimals, m.deployer, BigInt(c.mdemo.supply))),
    mdusd: verify(c.mdusd.address, 'contracts/src/demo/MandateDemoToken.sol:MandateDemoToken', tokenConstructorArgs(c.mdusd.name, c.mdusd.symbol, c.mdusd.decimals, m.deployer, BigInt(c.mdusd.supply))),
    fixtureVenue: verify(c.fixtureVenue.address, 'contracts/src/fixture/FixtureVenue.sol:FixtureVenue', toHex(encodeArguments([address, address, uint(8), uint(8), uint(256), uint(16)], [c.mdemo.address, c.mdusd.address, BigInt(c.mdemo.decimals), BigInt(c.mdusd.decimals), venuePrice, BigInt(market.fixtureFeeBps)]))),
    fixtureVenueAdapter: verify(c.fixtureVenueAdapter.address, 'contracts/src/fixture/FixtureVenueAdapter.sol:FixtureVenueAdapter', toHex(encodeArguments([address, address], [c.mandateExecutionGate.address, c.fixtureVenue.address]))),
  };
  log(json(results));
  const summary = Object.entries(results).map(([k, v]) => `${k}: ${v}`).join('; ');
  writeFileSync(MANIFEST_PATH, `${json({ ...m, verification: { ...m.verification, explorerSourceVerification: `Blockscout ${EXPLORER} — ${summary}` } })}\n`);
}

main().catch((e: Error) => {
  process.stderr.write(`verify failed: ${e.message}\n`);
  process.exitCode = 1;
});
